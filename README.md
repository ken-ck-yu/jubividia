# jubividia

Self-hosted [LTX-2.5](https://docs.ltx.video) video generation (text / image / video → video with audio) on RunPod Serverless, with a phone-friendly front end on Cloudflare.

- **Spec:** [`SPEC.md`](SPEC.md)
- **How Claude Code works on this repo:** [`CLAUDE.md`](CLAUDE.md) — Anthropic's official `/feature-dev` workflow, vendored in `.claude/`
- **Feature summaries:** `docs/decisions/`

Setup, usage, measured timings and cost will be filled in as features land.

## Models (network volume)

The weights live on a RunPod network volume, never in the image. `scripts/download-models.sh` fills it from the gated Hugging Face repo `Lightricks/LTX-2.5`, pinned to commit `49b093a39c19169a8a81721dcc541e07e945232f` (2026-10-11), and `scripts/models.lock` records the exact files, sizes and sha256.

### Volume layout (contract with the worker and `workflows`)

```
<volume>/models/{diffusion_models,text_encoders,vae,latent_upscale_models,loras,model_patches}/<file>
<volume>/models/.manifest-rev        # commit + lock hash of the last successful run
<volume>/workflows/{t2v,i2v,v2v}.json
```

The folder and file names are the Hugging Face repo names, unchanged. The volume is mounted at `/runpod-volume` on serverless workers and normally at `/workspace` on a pod; the relative tree is identical. Only models and workflow templates go on the volume. ComfyUI `temp/`, `output/` and `input/` never go on the volume (they stay on container disk or R2), so the free space stays predictable.

Default set: five required files plus the conv VAE, temporal upscaler and duration head, 41.43 GB (38.6 GiB). The 8.9 GB distilled LoRA is optional (`--with-lora`) and not downloaded by default.

**Filenames for workflows:** `scripts/models.lock` is the single source. Columns: `sha256 size repo_path set`; the folder is the first path segment. `scripts/download-models.sh --list` prints it tab-separated (`category`, `filename`, `repo_path`, `set`). Workflows should reference filenames only, never paths.

### One-time setup from zero

1. **Hugging Face:** accept the LTX-2.x Community License at https://huggingface.co/Lightricks/LTX-2.5 with your account (done), and create a **read-only** token.
2. **Create the network volume** in the RunPod console: **80 GB**, datacenter **US-WA-1**, standard (not high-performance; revisit after a measured cold start). 80 GB leaves room for a transformer swap with overlap (see "Updating models").
3. **Create a temporary pod** in **US-WA-1** (the volume can only attach there; volumes force Secure Cloud) with the volume attached, the cheapest CPU pod (or cheapest GPU pod if CPU stock is zero), container disk 10 GB. Set the pod env var `HF_TOKEN` to the token. The token reaches the pod only as this env var; the script reads it from the environment only and never prints or logs it.
4. **On the pod** (the repo is public, so no credentials are needed):
   ```
   git clone https://github.com/ken-ck-yu/jubividia
   cd jubividia
   scripts/download-models.sh
   scripts/download-models.sh --verify    # optional: full re-hash afterwards
   ```
   The script finds the volume at `/runpod-volume` or `/workspace` (or use `--volume-root DIR` / env `VOLUME_ROOT`), refuses to run if that path is not a mount point (so it can never fill container disk), checks free space, downloads two files at a time into `*.partial`, verifies size and sha256, then renames atomically. Expect roughly 3-7 minutes for 41 GB. A second run downloads nothing.
5. **Terminate** the pod (do not just stop it; a stopped pod keeps billing disk), and **rotate/revoke the HF token**.

If the mount-point check wrongly fails on a pod (a bind mount, say), confirm with `df` that the path really is the volume, then re-run with `SKIP_MOUNT_CHECK=1`.

### The sha256 lock (trust on first use)

`scripts/models.lock` is committed with all sha256 fields `null` (pending) because the hashes can only be fetched with a token. While any hash is pending, the script **refuses to download or verify**. Generate them once, from any machine with a token and network (needs `python3`):

```
HF_TOKEN=... scripts/download-models.sh --update-lock
git diff scripts/models.lock   # review, then commit
```

The hashes come from the Hugging Face API (`lfs.oid`) at the pinned commit, so they guard against later drift or corruption, not against a bad first fetch. Optionally cross-check the 21.5 GB transformer hash against a second source before committing. `--update-lock` records the commit and its date in the lock header; `--rev <commit>` pins a different commit.

### Commands

| Command | What it does |
|---|---|
| `scripts/download-models.sh` | Download the default set, verify, sync workflows. Idempotent and resumable (`.partial` + `curl -C -`). |
| `--verify` | Read-only: re-hash everything on the volume against the lock. No token or network needed. |
| `--prune [--dry-run]` | Delete files under `models/` that are not in the lock, and stray `.partial` files. |
| `--update-lock [--rev C]` | Refresh sizes and sha256 in the lock from the HF API. |
| `--workflows-only` | Copy only `workflows/*.json` to `<volume>/workflows/` (validated as JSON first). |
| `--with-lora` | Include the optional LoRA. |
| `--list` | Print the lock as tab-separated rows. |

401 means the token is invalid; 403 means the license has not been accepted by the account that owns the token (the message names the model page).

### Updating models (model bump)

Filenames contain the version, so a bump leaves the old files behind and needs the old and new file on the volume at once unless you prune first.

1. Edit `scripts/models.lock` (new paths) or run `--update-lock --rev <commit>`; review and commit.
2. Set the endpoint's **max workers to 0** so nothing reads the volume during the swap.
3. On a temporary pod in US-WA-1: `scripts/download-models.sh --prune --dry-run`, then `--prune`, then `scripts/download-models.sh`.
4. `scripts/download-models.sh --verify`.
5. Restore the endpoint's max workers. Update the filenames in the workflows.

With 80 GB there is room for a transformer swap with overlap (41.43 + 21.5 = 62.9 GB), so pruning first is only needed for larger changes.

### Cost note (corrects SPEC §7)

SPEC §7 and §2 assume a ~100 GB volume at ~$7/mo. The volume is **80 GB at $0.07/GB/month, about $5.60/mo** (volumes can be grown but not shrunk). The temporary pod costs cents per run.

### Tests

```
make -f scripts/models.mk test-models
```

Plain bash plus a stdlib Python mock Hugging Face server and a fake volume directory; no network, GPU or token. (`make -f scripts/models.mk lint-models` runs `bash -n` and `shellcheck` when installed.)

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
   time scripts/download-models.sh
   time scripts/download-models.sh --verify    # required: full re-hash of all 41 GB
   ```
   Before the download starts the script prints `df -hT` for the volume: check that the size is about 80 GB and the filesystem is the network volume's, not the pod's local disk. The script finds the volume at `/runpod-volume` or `/workspace` (or use `--volume-root DIR` / env `VOLUME_ROOT`), refuses to run if that path is not a mount point (so it can never fill container disk), checks free space, downloads two files at a time into `*.partial`, verifies size and sha256, then renames atomically. Expect roughly 3-7 minutes for 41 GB plus a few minutes of hashing (unmeasured). A second run downloads nothing. Only one run per volume at a time (a `flock` lock file on the volume); a second run exits with a message. If the volume filesystem does not support `flock`, the script says so (not "another run") and you can re-run with `--no-lock` (or `NO_LOCK=1`). **Warning:** `--no-lock` removes the protection against two runs corrupting each other's `.partial` files; use it only for a supervised single run with no other pod attached. The script needs bash 5.0+ (Ubuntu 22.04 pod images have 5.1) and fails early on older bash. Normal runs trust file size for files already present, so the full `--verify` after the first download is what confirms every byte.
5. **Record the first real run** in "Measured" below, then **terminate** the pod (do not just stop it; a stopped pod keeps billing disk), and **rotate/revoke the HF token**.

If the mount-point check wrongly fails on a pod (a bind mount, say), confirm with `df` that the path really is the volume, then re-run with `SKIP_MOUNT_CHECK=1`.

### The sha256 lock (trust on first use)

`scripts/models.lock` is committed with the real sha256 of every file, generated on 2026-10-29 from the Hugging Face API (`lfs.oid`) at the pinned commit, trust on first use. They guard against later drift and corruption, not against a bad first fetch. Optionally cross-check the 21.5 GB transformer hash against a second source (for example the SHA256 shown on the file's page on huggingface.co while logged in). The script still refuses to download or verify if any hash is `null`.

`--update-lock` is only needed for a **pin bump** (a new commit or new files in the lock). Needs `python3`, a token and network, from any machine:

```
HF_TOKEN=... scripts/download-models.sh --update-lock [--rev <commit>]
git diff scripts/models.lock   # review, then commit
```

It records the commit and its date in the lock header and leaves the lock untouched if anything fails.

### Commands

| Command | What it does |
|---|---|
| `scripts/download-models.sh` | Download the default set, verify, sync workflows. Idempotent and resumable (`.partial` + `curl -C -`). |
| `--verify` | Read-only: re-hash everything on the volume against the lock. No token or network needed. |
| `--prune [--dry-run]` | Delete files under `models/` that are not in the lock, and stray `.partial` files. **Always run `--prune --dry-run` first and read the list**: the lock is the truth, so a damaged or half-edited lock would make prune delete good files. |
| `--update-lock [--rev C]` | Refresh sizes and sha256 in the lock from the HF API. |
| `--workflows-only` | Copy only `workflows/*.json` to `<volume>/workflows/` (validated as JSON first). |
| `--with-lora` | Include the optional LoRA. |
| `--no-lock` | Skip the run lock (see the warning in setup step 4). |
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

### Measured (fill in after the first real run)

| Item | Value |
|---|---|
| Date, pod type, datacenter | _to fill_ |
| Download wall time (`time scripts/download-models.sh`) | _to fill_ |
| Average download speed (41.43 GB / time) | _to fill_ |
| Full `--verify` wall time | _to fill_ |
| `df -hT` of the volume (size, filesystem) | _to fill_ |
| Cold start reading the volume (from the `endpoint` feature) | _to fill_ |

### Environment variables

`HF_TOKEN` (read-only token, env only) and the optional `VOLUME_ROOT` are used by the script. `HF_TOKEN` is documented in `config.env.example` once the worker branch (which owns that file) is merged; this branch does not create it.

### Cost note (corrects SPEC §7)

SPEC §7 and §2 assume a ~100 GB volume at ~$7/mo. The volume is **80 GB at $0.07/GB/month, about $5.60/mo** (volumes can be grown but not shrunk). The temporary pod costs cents per run.

### Tests

```
make -f scripts/models.mk test-models
```

Plain bash plus a stdlib Python mock Hugging Face server and a fake volume directory; no network, GPU or token. (`make -f scripts/models.mk lint-models` runs `bash -n` and `shellcheck` when installed.)
## Worker image (`worker/`)

A thin layer on `runpod/worker-comfyui` (pinned by tag and digest in `worker/Dockerfile`): adds ComfyUI-LTXVideo (pinned commit), our `handler.py` and `extra_model_paths.yaml`. No model weights are inside; models and workflow templates are read from the network volume at `/runpod-volume`.

```
make test    # handler unit tests, no GPU or network (creates .venv)
make lint    # ruff + YAML parse
make build   # docker build -> ghcr.io/ken-ck-yu/ltx25-worker:dev  (image is ~25 GB uncompressed)
make smoke   # checks inside the built image: torch unchanged, triton, boto3, ffmpeg, model-path mapping, native LTX nodes
```

CI (`.github/workflows/build-worker.yml`) builds and pushes `ghcr.io/ken-ck-yu/ltx25-worker` with tags `latest` and `sha-<short>` on pushes to `main` that touch `worker/`. The endpoint must reference the `sha-` tag (or digest), never `latest`. After the first push, set the GHCR package visibility to public (GitHub → Packages → Package settings).

### Job contract (v1)

Input: `mode` (`t2v`/`i2v`/`v2v`), `prompt`, optional `negative`, `input_key` (an R2 key under `inputs/`, required for i2v/v2v; no URLs are accepted), `width`/`height` (default 1280x720; 256 to 2048, rounded down to a multiple of 64 because the two-stage graph halves the size, so 720 becomes 704 and the effective size is returned), `duration` seconds (default 5) with `fps` (default 24) or an explicit `num_frames` (8k+1, default 121). For v2v the resulting frame count must be at least 33 (the guide uses the last 25 frames of the input), otherwise `bad_input`. `duration` x `fps` and `num_frames` share one maximum of 481 frames. `seed` is optional.

Output: `{v, key, thumb_key, meta_key, duration_s, gen_time_s, seed, width, height, num_frames, fps, cold}`. R2 keys are `outputs/<YYYY-MM-DD>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json`; the `.json` sidecar holds the prompt and parameters. The timestamp is taken when the job starts, so a retried job gets new keys: the UI must not assume a retry overwrites the earlier result.

Failure: `{error, error_code}`; the text is prefixed with the code, e.g. `[upload_failed] ...`, as a fallback in case RunPod drops `error_code`. Codes: `bad_input`, `config_error` (missing R2 env), `input_fetch`, `workflow_mismatch`, `model_missing`, `oom`, `timeout`, `comfy_unavailable` (ComfyUI unreachable or its process is dead), `comfy_bad_response` (non-JSON reply or no prompt_id), `comfy_error`, `output_missing`, `upload_failed` (after 3 tries). Whether RunPod's `/status` exposes `error_code` for a FAILED job is unverified.

Workflow templates (`/runpod-volume/workflows/<mode>.json`) must be ComfyUI **API format** (not the UI export). They are filled by node `_meta.title`; the first listed input name present on the node is set:

| Title | Input field(s) tried, in order |
|---|---|
| `PROMPT` | `text` |
| `NEGATIVE` (optional unless a negative prompt is sent) | `text` |
| `WIDTH`, `HEIGHT`, `FRAMES`, `FPS` | `value` |
| `SEED` | `value`, `noise_seed`, `seed` |
| `INPUT` (i2v) | `image` (core `LoadImage`), `file` |
| `INPUT` (v2v) | `file` (core `LoadVideo`), `video` |

The output is the single video the graph saves: use exactly one `SaveVideo`, or title the saving node `OUTPUT` (it then wins). Two or more videos without an `OUTPUT` node fail with `workflow_mismatch`; temp/preview files are ignored.

Uploads use boto3 with `request_checksum_calculation` / `response_checksum_validation` set to `when_required` for R2 compatibility, 5 s connect / 30 s read timeouts, boto retries off and the handler's own 3 bounded tries (each try is capped at 45 s by a thread join and all uploads must finish by 885 s after job start, so a stalled R2 can never push the job past the 900 s platform limit; generation gets 780 s by default). A failed job is not retried by the worker: fail and resubmit. **The first real upload to R2 is a gating check**: it has not been exercised against real R2 yet.

`worker/constraints.txt` is a `pip freeze` of the built image, used as a pip constraints file so rebuilds resolve to the same versions (no torch-family changes).

Environment variables are documented in [`config.env.example`](config.env.example). The LTX-2.x Community License (free under $10M revenue) applies to the model weights.

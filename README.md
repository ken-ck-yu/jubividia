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

Output: `{v, key, thumb_key, meta_key, duration_s, gen_time_s, seed, width, height, num_frames, fps, cold, peak_vram_mb}` (`peak_vram_mb` is the peak `nvidia-smi` memory.used in MiB sampled once a second during generation, `null` if `nvidia-smi` is unavailable; it includes PyTorch's allocator reserve, so treat it as report-only). R2 keys are `outputs/<YYYY-MM-DD>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json`; the `.json` sidecar holds the prompt and parameters. The timestamp is taken when the job starts, so a retried job gets new keys: the UI must not assume a retry overwrites the earlier result.

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

Uploads use boto3 with `request_checksum_calculation` / `response_checksum_validation` set to `when_required` for R2 compatibility, 5 s connect / 30 s read timeouts, boto retries off and the handler's own 3 bounded tries (each try is capped at 45 s by a thread join and all uploads must finish by 885 s after job start, so a stalled R2 can never push the job past the 900 s endpoint execution timeout (our spend-safety choice, not a RunPod limit; the handler reads it from `EXEC_TIMEOUT_S`, which `infra/runpod/apply.sh` sets from `RUNPOD_EXEC_TIMEOUT_MS`); generation gets 780 s by default). A failed job is not retried by the worker: fail and resubmit. **The first real upload to R2 is a gating check**: it has not been exercised against real R2 yet.

`worker/constraints.txt` is a `pip freeze` of the built image, used as a pip constraints file so rebuilds resolve to the same versions (no torch-family changes).

Environment variables are documented in [`config.env.example`](config.env.example). The LTX-2.x Community License (free under $10M revenue) applies to the model weights.

## Endpoint (`infra/runpod/`)

`infra/runpod/apply.sh` creates and verifies the RunPod resources from `config.env`: the network volume, the two R2 secrets, the serverless endpoint and the temporary model-download pod. It is a bash script over the RunPod REST API (no maintained Terraform provider covers endpoints, volumes and secrets). It is idempotent (re-running makes no create calls), supports `--dry-run` (reads only), writes the ids back to `config.env`, never prints secret values, refuses to run under `bash -x`, and has **no code path that deletes the volume or the two R2 secrets**. A read-back mismatch is fixed by patching the one differing field; the script never deletes an endpoint on its own (only `teardown-endpoint --yes` does).

> **Unverified without a real call:** the REST base URL (`RUNPOD_API_BASE`, default `https://rest.runpod.io/v1`) and the exact route and field names (`/network-volumes`, `/secrets`, `/endpoints`, `/pods`, `cmd`, `mounts`, ...) follow the design note, not a live check. Run `apply.sh preflight` first (read-only); fix any 4xx from it before anything billable. The routes are plain string literals in `infra/runpod/apply.sh`.

### Setup from zero (endpoint)

1. `cp config.env.example config.env`, `chmod 600 config.env`, fill `RUNPOD_API_KEY`, `HF_TOKEN` (read-only), `R2_*` (token scoped to the one bucket, Object Read & Write), `RUNPOD_POD_IMAGE`. Set `IMAGE_TAG` to the `sha-<short>` tag of the CI build **of the merge that contains the `peak_vram_mb` worker change** (read it from the `build-worker` run; the GHCR package must be public). `latest` and anything not matching `^sha-[0-9a-f]{7,}$` is rejected. `GIT_REF` is the full commit sha the temp pod checks out.
2. Add a payment method and fund about $15 in the RunPod console, and enable a low-balance notification (a volume can be removed by the platform at $0 balance; the REST API cannot read the balance).
3. `infra/runpod/apply.sh preflight`, then `--dry-run` of each command you are about to run.

### Billable steps, in order (prices from the design note, 2026-10-29 reads)

| # | Command | Bills | Expected |
|---|---|---|---|
| 1 | `apply.sh volume` (80 GB STANDARD, US-WA-1) | $0.07/GB/month, accrues hourly until deleted in the console | $5.60/month standing cost |
| 2 | `apply.sh secrets` | free | $0 |
| 3 | `apply.sh pod-up`, wait for `MODELS DONE` in `pod-logs`, then **`apply.sh pod-down`** | CPU pod cpu3c 2 vCPU secure about $0.06/hr plus a small container disk; 41 GB download + verify, 20-40 min | $0.02-0.04, cap about $0.08 (1 h) |
| 4 | `apply.sh endpoint --max-workers 1` (gate runs with one worker) | $0 idle; $1.75/hr per running RTX 6000 Ada worker | $0 |
| 5 | `scripts/smoke-job.sh` (the gate, below) | $1.75/hr while a worker runs | about $1-2 expected, about $5-6 worst case |
| 6 | `apply.sh endpoint` (restores max workers 2) | $0 | $0 |

**`pod-up` leaves a pod running until you terminate it** (it ends with `sleep infinity` so it stays inspectable). It prints a banner; `pod-down` terminates it (not stop), reads back that it is gone, and deletes the temporary `hf_token_tmp` secret. That secret is the one deliberate exception to "never auto-delete secrets": it is deleted by exact name and nothing else is. Afterwards **rotate the Hugging Face token**. The token reaches the pod only as `{{ RUNPOD_SECRET_hf_token_tmp }}`, the clone is pinned to `GIT_REF`.

Commands: `preflight`, `volume`, `secrets [--rotate]`, `endpoint [--max-workers N]`, `pod-up`, `pod-logs`, `pod-down`, `status`, `teardown-endpoint --yes`; all accept `--dry-run`. R2 secret values are write-only on RunPod: keep your own copy. Rotating (`secrets --rotate`) reaches workers at their next boot.

### What the endpoint is set to

RTX 6000 Ada only (`NVIDIA RTX 6000 Ada Generation`: pool `ADA_48_PRO` minus `NVIDIA L40`, `NVIDIA L40S` and the `MIG 2g.48gb` type, always sent together), `dataCenterIds` US-WA-1 with the volume mounted, `minCudaVersion` 12.8, workers min 0 / max 2, idle timeout 60 s, `QUEUE_DELAY` scaling, FlashBoot sent explicitly (REST default is OFF), execution timeout 900000 ms (**our own spend-safety choice, not a RunPod limit**; RunPod allows 5 s to 7 days; the script reads it back and the worker learns it as `EXEC_TIMEOUT_S`), R2 key id and secret as `{{ RUNPOD_SECRET_ltx_r2_access_key_id }}` / `{{ RUNPOD_SECRET_ltx_r2_secret_access_key }}`. Changing `IMAGE_TAG` or env creates a new release and replaces workers.

### Running the gate

`scripts/smoke-job.sh` (add `--no-r2-check` if `aws`/`ffprobe` are not installed; the audio and R2 checks are then unverified). It uses `/run` + `/status` + `/health` only. Order: (1) canary: a missing-input i2v job, which needs good R2 secrets but never loads models (a "could not fetch input" error means the secrets did not resolve); (2) cold tiny t2v; (3) warm tiny; (4) warm default 1280x704x121; (5) second warm default; (6) wait for scale to zero, (7) cold default clip (the real first-after-idle path). **Pass** = no OOM, no offload, the second warm default job within 10% of the first, audio present, the three R2 objects exist. 46 GB peak VRAM is report-only. Offload cannot be seen from job data: read the worker logs. **Cold start** = `delayTime + executionTime` of a job minus its `gen_time_s`; the first-ever cold start can include a billed 24.75 GB image pull, so judge the second. Each job is appended to `docs/validation/endpoint-timings.csv`. It **stops and asks Ken** (exit 3) when a worker goes Unhealthy, a job stays IN_PROGRESS past 15 min (a cancel is sent), a job sits in the queue throttled past 5 min, cold start exceeds 600 s, cold-tiny start plus warm default gen time exceeds 700 s, or warm default gen time exceeds 300 s. Do not work around a stop.

### Teardown and recovery

- `apply.sh teardown-endpoint --yes`: sets max workers 0, deletes the endpoint (config only); the volume and secrets stay. Re-create with `apply.sh endpoint`. The volume can only be deleted in the console, and that loses the 41 GB of models.
- **Idle auto-scale-down:** RunPod lowers an endpoint's max workers after 3 days without requests (to 2) and sets it to 0 after 7. Jobs then fail or queue (a 409 paused endpoint). `apply.sh status` warns when max workers differs from `RUNPOD_WORKERS_MAX`; **`apply.sh endpoint` restores it**.
- Stale pod: `apply.sh status` warns if `jubividia-models-tmp` exists; `apply.sh pod-down` terminates it.

### Measured (fill in after the gate)

| Item | Value |
|---|---|
| Cold start, first ever / second (delay + exec - gen) | _to fill_ |
| Warm default clip `gen_time_s` (1280x704x121) | _to fill_ |
| Cold + default clip total (user path) | _to fill_ |
| Peak VRAM (`peak_vram_mb`) | _to fill_ |
| Cost per clip, measured | _to fill (SPEC §7's 3-minute example assumes cold+gen about 3 min)_ |

### Tests

```
make -f infra/runpod/infra.mk test-infra
```

Plain bash plus a stdlib Python fake of the RunPod REST API, serverless runtime and GHCR, all on 127.0.0.1. It covers idempotency, `--dry-run`, the three REST traps, kill between create and write-back, tag rejection, secret hygiene (output, `bash -x`, curl argv, temp files), the no-delete grep, read-back mismatch handling and the gate runner. `make -f infra/runpod/infra.mk lint-infra` runs `bash -n` and `shellcheck` when installed.

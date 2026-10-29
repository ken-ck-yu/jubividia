# jubividia

Self-hosted [LTX-2.5](https://docs.ltx.video) video generation (text / image / video → video with audio) on RunPod Serverless, with a phone-friendly front end on Cloudflare.

- **Spec:** [`SPEC.md`](SPEC.md)
- **How Claude Code works on this repo:** [`CLAUDE.md`](CLAUDE.md) — Anthropic's official `/feature-dev` workflow, vendored in `.claude/`
- **Feature summaries:** `docs/decisions/`

Setup, usage, measured timings and cost will be filled in as features land.

## Documentation

- [`docs/setup-from-scratch.md`](docs/setup-from-scratch.md): the one working path to rebuild the whole system on empty accounts, with exact commands, dashboard clicks, expected results, costs and the pitfalls we hit.
- [`docs/configuration.md`](docs/configuration.md): reference for every `config.env` key, the Worker secrets and variables, endpoint settings, bucket and volume layout, the handler contract, credential scopes, spend limits and the cost table.
- [`docs/architecture.md`](docs/architecture.md): the architecture with diagrams, why each part was chosen, the measured numbers, known limitations and the operations runbook (park and unpark, rotate keys, deploy an image, add or remove a user, teardown).

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
   Before the download starts the script prints `df -hT` for the volume: check that the filesystem is the network volume's, not the pod's local disk. **On RunPod `df` does not show 80 GB**: the volume is a slice of a shared FUSE cluster filesystem (the first run showed `mfs#us-wa-1.runpod.net:9421 fuse 615T 366T 249T 60% /runpod-volume`), and the 80 GB quota is enforced by the platform, not by `df`. The free-space guard therefore compares the integer free bytes against what is still needed, prints a note when it sees a network filesystem far larger than any volume, still refuses if even that number is too small, and exits with a clear error (never silently skipping the check) if `df` output can not be parsed. The script finds the volume at `/runpod-volume` or `/workspace` (or use `--volume-root DIR` / env `VOLUME_ROOT`), refuses to run if that path is not a mount point (so it can never fill container disk), checks free space, downloads two files at a time into `*.partial`, verifies size and sha256, then renames atomically. The first real run (cpu3c, 2 vCPU, US-WA-1) took 3 min 39 s to download 41.4 GB and about 2 min 21 s for the full `--verify` (see the Measured table). A second run downloads nothing. Only one run per volume at a time (a `flock` lock file on the volume); a second run exits with a message. If the volume filesystem does not support `flock`, the script says so (not "another run") and you can re-run with `--no-lock` (or `NO_LOCK=1`). **Warning:** `--no-lock` removes the protection against two runs corrupting each other's `.partial` files; use it only for a supervised single run with no other pod attached. The script needs bash 5.0+ (Ubuntu 22.04 pod images have 5.1) and fails early on older bash. Normal runs trust file size for files already present, so the full `--verify` after the first download is what confirms every byte.
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

### Measured (first real run)

| Item | Value |
|---|---|
| Date, pod type, datacenter | 2026-10-29; pod `cpu3c` 2 vCPU, image `ubuntu:22.04`, US-WA-1 |
| Download wall time (`time scripts/download-models.sh`) | 3 min 39 s (13:03:44 to 13:07:23 UTC): 41,427,929,848 bytes in 8 files |
| Average download speed (41.43 GB / time) | about 189 MB/s (about 1.5 Gbit/s) |
| Full `--verify` wall time | about 2 min 21 s (13:07:23 to 13:09:44 UTC) |
| `df -hT` of the volume (size, filesystem) | `mfs#us-wa-1.runpod.net:9421 fuse 615T 366T 249T 60% /runpod-volume`: the shared cluster, not the 80 GB quota |
| Mount checks | the `mountpoint` check passed on the FUSE mount; `flock` printed no error (two concurrent runs were not tested) |
| Bug found | the free-space guard crashed with `((: 2.73413e+14: syntax error` (awk printed 249T in scientific notation) and the script carried on without the check; fixed, see above |
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

> **API contract:** the tool follows RunPod's public v2 OpenAPI document: server `https://api.runpod.io`, every route under `/v2` (`RUNPOD_API_BASE`, default `https://api.runpod.io/v2`), bearer auth. Routes used: `/account/secrets`, `/network-volumes`, `/serverless`, `/pods` (+ `/{id}`, `/pods/{id}/logs`). Not checkable without a real call: live behaviour, quotas and balance. Run `apply.sh preflight` first (read-only).

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

**If CPU pod stock is gone, stop and ask Ken first.** The only fallback is a RTX 6000 Ada GPU pod at about $0.99/hr (secure, low stock); do not create one without his OK.

Commands: `preflight`, `volume`, `secrets [--rotate]`, `endpoint [--max-workers N]`, `pod-up`, `pod-logs`, `pod-down`, `status`, `teardown-endpoint --yes`; all accept `--dry-run`. R2 secret values are write-only on RunPod: keep your own copy. Rotating (`secrets --rotate`) reaches workers at their next boot. `volume` checks that a configured volume id is in `RUNPOD_DC` and STANDARD, and growing an existing volume (billable, one-way) needs `--yes`. `endpoint`, `preflight` and the gate refuse to run with `IMAGE_TAG` empty.

### What the endpoint is set to

RTX 6000 Ada only (`NVIDIA RTX 6000 Ada Generation`: pool `ADA_48_PRO` minus `NVIDIA L40`, `NVIDIA L40S` and the `MIG 2g.48gb` type, always sent together), `dataCenterIds` US-WA-1 with the volume mounted, `minCudaVersion` 12.8, workers min 0 / max 2, idle timeout 60 s, `QUEUE_DELAY` scaling, FlashBoot sent explicitly (REST default is OFF), execution timeout 900000 ms (**our own spend-safety choice, not a RunPod limit**; RunPod allows 5 s to 7 days; the script reads it back and the worker learns it as `EXEC_TIMEOUT_S`), R2 key id and secret as `{{ RUNPOD_SECRET_ltx_r2_access_key_id }}` / `{{ RUNPOD_SECRET_ltx_r2_secret_access_key }}`. Changing `IMAGE_TAG` or env creates a new release and replaces workers.

### Running the gate

`scripts/smoke-job.sh` (add `--no-r2-check` if `aws`/`ffprobe` are not installed; the audio and R2 checks are then unverified). It uses `/run` + `/status` + `/health` + `/cancel` only, against the run URL in the endpoint's `requestUrls` (fallback `https://api.runpod.ai/v2/<id>`). **`--max-spend USD` (default 3.00 for the full gate)** is an overall guard: estimated worker time times $1.75/hr, conservatively adding a 60 s idle tail and one poll interval per job; when reached it cancels the running job and exits 3. The run URL must be https on `*.runpod.ai` or `*.runpod.io` (otherwise exit 4). Every job also has a wall-clock cap (execution timeout plus 600 s, `SMOKE_JOB_WALL_S`) that cancels it and exits 3, and `/health` failing 5 polls in a row (`SMOKE_HEALTH_FAIL_LIMIT`) does the same, so a bad health route can not leave a job queued unwatched. Order: (1) canary: a missing-input i2v job, which needs good R2 secrets but never loads models. It passes when the error is `[input_fetch] input not found` (a missing key failing inside input_fetch proves the R2 credentials resolved), with a recorded note if `/status` has no separate `error_code` field; any other error (`could not fetch input`, `config_error`, auth, no prefix) stops the gate before any model job; (2) cold tiny t2v; (3) warm tiny (a new seed; every job uses a different seed so none is a ComfyUI cache hit); (3b) `repeat-same`: the exact same request as warm-tiny again, which must complete with a NEW output key (it checks the unique per-run OUTPUT prefix on the real worker); (4) warm default 1280x704x121; (5) second warm default; (6) wait for scale to zero, (7) cold default clip (the real first-after-idle path). **Pass** = no OOM, no offload, the second warm default job within 10% of the first, audio present, the three R2 objects exist. 46 GB peak VRAM is report-only. Offload cannot be seen from job data: read the worker logs. **Cold start** = worker start + model-load overhead, where worker start = `delayTime + executionTime - gen_time_s` and model-load overhead = `gen_time_s` of the cold job minus `gen_time_s` of the matching warm job (cold-tiny vs warm-tiny, cold-def vs warm-def). The model load runs inside the first job, so it is part of `gen_time_s`; the first real run printed 2.4 s for a load of about 120 s with the old formula. The 180 s flag and 600 s hard stop apply to this sum. The first-ever cold start can include a billed 24.75 GB image pull, so judge the second. Each job is appended to `docs/validation/endpoint-timings.csv`. It **stops and asks Ken** (exit 3) when a worker goes Unhealthy, a job stays IN_PROGRESS past 15 min (a cancel is sent), a job sits in the queue throttled past 5 min, cold start exceeds 600 s, cold-tiny start plus warm default gen time exceeds 700 s, or warm default gen time exceeds 300 s. It also stops (cancelling the job) if `/status` fails 5 polls in a row (401, 500, not JSON); the in-progress, unhealthy and queue checks keep running while polls fail. Do not work around a stop.

#### Interpreting a run

A passing run shows all of these in the output (and the CSV):
- `canary OK`, then every model job `COMPLETED`.
- `repeat-same completed with a new output key`, plus (with R2 checks on) `repeat-same mp4 exists: <n> bytes` and `repeat-same sidecar: same prompt and seed ..., job_id ... differs`. Without `aws` the sidecar and size checks are reported as NOT verified.
- `audio stream: present` for every completed job.
- Cold start printed as `worker start X s + model-load overhead Y s = Z s`. If a timing value is missing, null, empty or not a number the job is a FAIL ("timing metric unavailable"), never a silent pass.
- `peak_vram_mb` per job (report-only) and `estimated spend` under the cap.
- The worker scales to zero before the final cold job (`--- waiting for the worker to scale to zero` ends on its own).

Every `aws` and `ffprobe` call has a ceiling (`SMOKE_TOOL_TIMEOUT_S`, default 30 s); a timeout is a FAIL with a message, not a hang.

**Two things are still UNEXPLAINED** (first real run, seen twice): workers stayed IDLE/INITIALIZING well past the 60 s idle timeout, so the endpoint was parked by hand with max workers 0. On the next run watch the worker system logs live (console or `GET /serverless/{id}/workers`), and if it happens again on an otherwise clean run, repeat the gate with FlashBoot off (`flashboot: OFF`) to see whether it is a FlashBoot snapshot/restore effect.

### Teardown and recovery

- `apply.sh teardown-endpoint --yes`: sets max workers 0, deletes the endpoint (config only); the volume and secrets stay. Re-create with `apply.sh endpoint`. The volume can only be deleted in the console, and that loses the 41 GB of models.
- **Idle auto-scale-down:** RunPod lowers an endpoint's max workers after 3 days without requests (to 2) and sets it to 0 after 7. Jobs then fail or queue (a 409 paused endpoint). `apply.sh status` warns when max workers differs from `RUNPOD_WORKERS_MAX`; **`apply.sh endpoint` restores it**.
- Stale pod: `apply.sh status` warns if `jubividia-models-tmp` exists; `apply.sh pod-down` terminates it.

### Measured (second real gate run, 2026-10-29: PASSED)

Endpoint on image `sha-f9bc90a`, RTX 6000 Ada, US-WA-1, workers max 1 for the gate.

| Item | Value |
|---|---|
| Cold start, tiny clip (worker start + model-load overhead) | worker start 3.9 s + overhead 103.9 s (cold gen 117.99 s - warm gen 14.07 s) = 107.8 s. The canary's own worker start was about 58 s |
| Warm default clip `gen_time_s` (1280x704x121 @24 fps, 5.04 s) | 68.21 s (execution 70.9 s); the second warm run 66.40 s, 2.7% from the first |
| Cold + default clip after scale-to-zero (the user path) | delay 98.1 s + execution 193.4 s (gen 186.84 s): cold start = worker start 104.6 s + model-load overhead 118.6 s = **223.2 s** (above the 180 s flag, below the 600 s hard stop); 291.5 s from submit to done |
| Peak VRAM (`peak_vram_mb`, report-only) | tiny 39,409 / 39,889 MiB; default clip 43,473 MiB (42.5 GiB), second warm 41,521 MiB, cold 43,761 MiB. No OOM; the 46 GiB (47,104 MiB) line was never reached |
| Repeat of an identical request | completes in 1.02 s gen with a new output key (the per-run OUTPUT prefix fix works on the real worker); mp4 48,866 bytes, sidecar has the same prompt and seed and a different job_id |
| Audio and outputs | every completed job's mp4 has an AAC 48 kHz stereo track; the default clip is h264 1280x704, 121 frames, 24 fps, 5.04 s video, 5.01 s audio, 917,019 bytes; mp4, jpg and json reached R2 every time |
| Offload | not checked (not detectable from job data, and the worker logs were gone) |
| Cost per clip (estimate at $1.75/hr) | warm default clip about $0.034 (70.9 s); first clip after idle about $0.09 to $0.14, depending on whether the worker start is billed. The runner's own estimate for the whole second run was $0.62 |
| Scale-down | the worker took about 6 minutes after its last job (finished 15:19:14; the runner saw 0 workers and submitted the cold job at about 15:25:19) to reach zero, although the idle timeout is 60 s |

Billing read back from RunPod for the first run: the 14:00-15:00 bucket totalled $0.104 for a worker that was alive about 8 minutes, and the first worker, which never ran a job, left no billing record. That suggests idle time is not charged, but it is inferred from one bucket (the 15:00 bucket had not posted yet): treat it as an observation, not a fact, and confirm on the next billing read.

#### Cold-start mitigations (proposals only; SPEC says to ask Ken before changing the idle timeout)

The first clip after idle takes about 3.7 to 4.9 minutes end to end (223 s cold start plus generation), well above SPEC §7's 3-minute example. Options, cheapest first:
1. Accept it and make the UI show a "cold starting" state with the elapsed time.
2. A longer idle timeout so a burst of use stays warm. This looks cheap if idle time really is unbilled (see above); confirm on the billing read before asking Ken.
3. Only if measured to help: a faster volume tier (the model load from the network volume is about 104 to 119 s of the cold start).
Nothing here is applied; `idleTimeout` stays 60 s.

#### First real gate run (2026-10-29, image before the fixes below)

- The canary passed: the R2 secrets resolve on the worker, and `/status` exposes `error_code`.
- A cold 256x256x25 t2v job on the RTX 6000 Ada completed in 125 s total (`gen_time_s` 123 s, which includes about 100+ s of model loading from the network volume; ComfyUI logged `Prompt executed in 122.33 seconds`).
- Peak VRAM was 39,473 MiB (report-only). The mp4 has an AAC 48 kHz stereo audio stream, and the three objects reached R2.
- Three bugs found and fixed afterwards: (1) `smoke-job.sh` reported "audio stream: MISSING" on a clip that has audio, because `ffprobe | grep -q` under `set -o pipefail` dies of SIGPIPE (the offline stubs wrote instantly, so tests missed it); (2) an identical repeated request (same prompt, seed, size) was served entirely from ComfyUI's cache (`Prompt executed in 0.01 seconds`) and failed with `[output_missing] node OUTPUT produced no mp4`; the worker now makes the OUTPUT `filename_prefix` unique per run; (3) the cold-start number was wrong because the model load sits inside `gen_time_s` (see the definition above).
- Two observations are unexplained: workers stayed IDLE/INITIALIZING well past the 60 s idle timeout, twice. The endpoint was parked by hand with max workers 0.
- The second run (above, on `sha-f9bc90a`) passed with all three bugs fixed. The scale-down delay (about 6 minutes after the last job) was seen again, so it is now three observations of the same behaviour; the cause is still unknown. Next steps stay as in "Interpreting a run".

### Tests

```
make -f infra/runpod/infra.mk test-infra
```

Plain bash plus a stdlib Python fake of the RunPod REST API, serverless runtime and GHCR, all on 127.0.0.1. It covers idempotency, `--dry-run`, the three REST traps, kill between create and write-back, tag rejection, secret hygiene (output, `bash -x`, curl argv, temp files), the no-delete grep, read-back mismatch handling and the gate runner. `make -f infra/runpod/infra.mk lint-infra` runs `bash -n` and `shellcheck` when installed.

## UI (`ui/`, `infra/cloudflare/`)

One Cloudflare Worker named `jubividia` on `workers.dev`: a mobile-first page (Text / Image / Video continue, camera-roll picker, prompt, Advanced, progress with elapsed time, inline player with sound, shared gallery with gen time, peak VRAM and estimated cost) plus a small API in front of the RunPod endpoint and the R2 bucket `jubividia-ltx-eu`. Design and decisions: `docs/decisions/ui.md`.

### Who can use it

Two people (Ken and a second person). Cloudflare Access (one-time PIN, 24 h session) is the front door; the Worker also verifies the `Cf-Access-Jwt-Assertion` JWT on every request (issuer, audience, `email` claim, small clock tolerance) and fails closed (503 with no secrets, 403 for anyone not listed). The login method is not checked, only the JWT. The gallery, the daily cap and the one-active-job lock are shared; each person sees "Signed in as ..." in the header. Private galleries would be a later change (needs an owner field from the worker).

### Setup from zero

1. Local: `cd ui && npm ci && npm test` (no Cloudflare, no RunPod: everything is faked), `npm run dev` for `wrangler dev --local` (R2 is simulated in `.wrangler/`; it answers 503 until `.dev.vars` has the five names below and a reachable JWKS, because there is no auth bypass).
2. Ken creates a short-lived Cloudflare API token (dashboard) with exactly: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read. No Zero Trust scope. Put it in `config.env` as `CLOUDFLARE_API_TOKEN` (the account id is `R2_ACCOUNT_ID`). Also add `UI_RUNPOD_API_KEY` (a RunPod key restricted to the `jubividia-ltx25` endpoint; it must differ from `RUNPOD_API_KEY`), `RUNPOD_ENDPOINT_ID`, and, for the last step only, `ALLOWED_EMAILS`, `TEAM_DOMAIN`, `POLICY_AUD`. See `config.env.example`.
3. `infra/cloudflare/apply.sh preflight` (read-only; records the baseline `modified_on` of the other Workers in `.scratch/cloudflare/`). Stops if the account has no workers.dev subdomain (it is account-wide; it is never created or renamed here).
4. `infra/cloudflare/apply.sh lifecycle` adds `inputs-expire-7d`, `state-expire-40d`, `abort-multipart-1d` (reads the existing rules and writes them back unchanged plus ours).
5. `infra/cloudflare/apply.sh deploy` deploys the Worker with no secrets (fails closed, 503), then asserts the Worker identity, `workers_dev` on, preview URLs off, other Workers unchanged.
6. **Ken, in the dashboard:** Workers & Pages > `jubividia` > Settings > "Protect this Worker behind Access" (all traffic). If the Zero Trust organisation is new, create it (Free plan: 50 users; payment details are asked, nothing is charged) and add the One-time PIN login method. In the application's policy, Allow, Include: Emails: **both** addresses. Session duration 24 h. Note the application's Audience (AUD) tag and the team domain `https://<team>.cloudflareaccess.com`.
7. `infra/cloudflare/apply.sh verify-access`: an unauthenticated request to `https://jubividia.<subdomain>.workers.dev/` (and `/api/state`, and one carrying a forged `Cf-Access-Jwt-Assertion`) must be redirected to the Access login. Anything else fails and `secrets` refuses to run.
8. Ken adds `ALLOWED_EMAILS` (comma-separated), `TEAM_DOMAIN`, `POLICY_AUD` to `config.env`, then `infra/cloudflare/apply.sh secrets --i-confirmed-access` sets the five Worker secrets (`RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `ALLOWED_EMAILS`, `TEAM_DOMAIN`, `POLICY_AUD`) through the API; values are never printed.
9. `infra/cloudflare/apply.sh postcheck`; then Ken revokes the API token. Later Worker updates need a new short-lived token (`preflight`, `deploy`, `postcheck`).

All subcommands accept `--dry-run` (no Cloudflare write). `teardown` prints the undo steps. Offline tests: `bash tests/cloudflare/run.sh` (fake Cloudflare API on 127.0.0.1; test mode refuses any other host).

### Deleting clips

Every gallery card and the result card has a Delete button. It asks for confirmation in a dialog, then calls `DELETE /api/outputs/<key>`. The Worker accepts only keys of the exact form `outputs/<YYYY-MM-DD>/<YYYYMMDDTHHMMSS>-<jobid>.(mp4|jpg|json)` (job id `[A-Za-z0-9_-]`, at most 80 characters, timestamp date equal to the folder date); anything else, including everything under `inputs/` and `state/`, is a 400 and nothing is touched. It deletes the sidecar `.json` first (the gallery lists clips by sidecar, so the clip disappears at once), then the `.mp4` and `.jpg`. Repeating a delete returns 204; a partial failure returns a retryable 500. It needs the Access JWT and the `X-Jubividia` header like every other mutating route. **Known limitation:** the gallery is shared, so either allowed user can delete any clip, and a delete is permanent.

### Prompt guide

Under the prompt box a collapsible "Prompt guide for beginners" explains the five-part prompt structure (action, motion, who and where, camera and light, sound), rules of thumb for a 5 second clip, ready-made examples with a "Use this prompt" button (current mode first), and five reading links. It opens on a first visit only (remembered in `localStorage`, which may be unavailable; no cookies). The only external URLs the page may contain are those five links, enforced by `ui/scripts/static-rules.mjs` (run by `npm test`).

### Personalising the page

The masthead shows the name "JubiVidia", a tagline and, optionally, a small round photo. The photo is **optional and never committed**: the repository is public, so `ui/static/brand.jpg` is in `.gitignore`, and `ui/scripts/check-static.mjs` (run by `npm test`) fails if any image file is tracked. Without the file (a fresh clone) the page simply shows the text brand.

To use your own photo, put it at `ui/static/brand.jpg` **before** `infra/cloudflare/apply.sh deploy` (the file is uploaded with the other static files and, like them, served only after the Access check). Make it square, small and free of metadata (EXIF, GPS). With ffmpeg (for example in the worker image: `docker run --rm -v "$PWD":/w --entrypoint ffmpeg <worker-image> ...`):

```
ffmpeg -i original.jpg -vf "crop=min(iw\,ih):min(iw\,ih),scale=480:480" -q:v 6 -map_metadata -1 -an -frames:v 1 ui/static/brand.jpg
```

(Adjust the crop, for example `crop=1080:1080:0:60`, to pick the part of a portrait photo you want.) About 15 to 40 KB is plenty; the page shows it at 60 px.

### Limits and cost

- One active job at a time (compare-and-swap reservation in R2 `state/active.json`; also refused while RunPod `/health` shows jobs in flight; a timed-out submit keeps the lock; Cancel keeps it until RunPod reports a terminal state).
- `DAILY_CAP` clips per UTC day, default 30, shared, failed attempts count (var in `ui/wrangler.toml`; the page shows the reset time in the viewer's local time).
- Job policy on every submit: `ttl` 35 min, `executionTimeout` 900000 ms. A run is capped at 15 minutes. Realistic worst case per job at $1.75/hr: up to about $0.65 (15 min run cap + GPU boot ~105 s + 180 s idle tail + scale-down lag margin), from one constant in `ui/static/calc.js`.
- Sizes are free within the handler's bounds (256..2048 per side, multiples of 64, up to 481 frames). Beyond the measured 1280x704x121 the page warns (untested, may fail or run out of memory, a failed run still bills) and shows the worst case. Every finished clip shows `gen_time_s`, peak VRAM and an estimated cost.
- Uploads: 95 MB for video, 20 MB for images (the page shrinks photos to 2048 px JPEG first). JPEG, PNG, WebP, MP4, MOV only; WebM and HEIC are refused. Chunked upload is a later change.
- The four "Quick sizes" buttons (landscape, portrait, square, fast) are conveniences that fill width and height. They are not limits.
- Known limitation: either allowed user can cancel the other's running job (two trusted users; the lock only records a hash of who started it).
- Local dev: `npm run dev` answers 503 locally (no secrets, no reachable Access JWKS) by design; no bypass exists. Local behaviour is covered by the Vitest suite (`cd ui && npm test`), which mints its own JWTs against a fake JWKS.
- A warm clip is about 1 to 1.5 minutes; the first clip after idle about 4 to 5 minutes (see the endpoint section).

### Tests

`cd ui && npm test` runs a source guard (no `innerHTML`, no inline script, no secret names in static files, wrangler settings pinned) and the Vitest suite inside workerd (JWT matrix with a fake JWKS, two-user list, CSRF, upload and magic bytes, validation, races, caps, rollback, status mapping, cancel, Range/206/416, gallery pagination, XSS data handling, secrets never logged).

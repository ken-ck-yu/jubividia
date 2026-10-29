# Configuration reference

Every value that controls jubividia, where it comes from, who reads it, and what happens if it is wrong. For the step-by-step setup see [setup-from-scratch.md](setup-from-scratch.md); for how the pieces fit together see [architecture.md](architecture.md).

All example values are placeholders: `<account-id>`, `<endpoint-id>`, `<volume-id>`, `<team-name>`, `<aud-tag>`, `<your-email>`, `<her-email>`. The repository is public: never commit real values.

Contents:

1. [How config.env is read](#how-configenv-is-read)
2. [config.env keys](#configenv-keys)
3. [Environment-only settings of the tools](#environment-only-settings-of-the-tools)
4. [Cloudflare Worker secrets and variables](#cloudflare-worker-secrets-and-variables)
5. [Limits compiled into the Worker](#limits-compiled-into-the-worker)
6. [RunPod endpoint settings](#runpod-endpoint-settings)
7. [R2 bucket layout and lifecycle rules](#r2-bucket-layout-and-lifecycle-rules)
8. [Network volume layout](#network-volume-layout)
9. [Handler contract: input, output, error codes](#handler-contract-input-output-error-codes)
10. [Credentials, scopes, least privilege and rotation](#credentials-scopes-least-privilege-and-rotation)
11. [Spend limits](#spend-limits)
12. [Cost table](#cost-table)

## How config.env is read

`config.env` lives in the repository root and is git-ignored. Three readers use it:

- `infra/runpod/lib.sh` (used by `infra/runpod/apply.sh` and `scripts/smoke-job.sh`) accepts a fixed list of keys.
- `infra/cloudflare/lib.sh` (used by `infra/cloudflare/apply.sh`) accepts a different fixed list.
- The `Makefile` does `-include config.env` for `IMAGE` and `TAG`. Make reads it with Make syntax, not shell syntax (edge cases such as quoted values: not verified).

Rules of the two bash readers (identical in both files):

- Only lines matching `KEY=value` with an upper-case key are read; everything else (comments, blank lines, unknown keys) is ignored.
- The file is **never `source`d**, so nothing in it can run as a command.
- **The last matching line wins** when a key appears twice.
- One pair of matching surrounding quotes is removed. A trailing `# comment` after an unquoted value is removed. A trailing carriage return (CRLF, from Windows editors) is removed.
- Values are never printed; messages go through a redaction function.
- Location: `CONFIG_ENV` environment variable, default `<repo root>/config.env`.
- The RunPod tool writes five ids back (`RUNPOD_NETWORK_VOLUME_ID`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_POD_ID`, `RUNPOD_SECRET_ID_R2_KEY_ID`, `RUNPOD_SECRET_ID_R2_KEY_SECRET`). It replaces the first matching line, keeps the file mode and all other lines, and only accepts values of letters, digits, `_` and `-`.
- Keep the file at mode 600 (`chmod 600 config.env`).

## config.env keys

Legend. **Secret**: yes = never share or commit; no = harmless identifier. **Read by**: `rp` = `infra/runpod/apply.sh`, `smoke` = `scripts/smoke-job.sh`, `cf` = `infra/cloudflare/apply.sh`, `make` = `Makefile`, `worker` = the container on RunPod (reaches it through the endpoint, see column text).

### R2 access (used by the RunPod worker, the smoke test and the Cloudflare tool)

| Key | What it is | Where the value comes from | Secret | Read by | Example | If wrong |
|---|---|---|---|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id; also builds the S3 endpoint `https://<account-id>.r2.cloudflarestorage.com` | Cloudflare dashboard (account id, 32 hex characters) | no | rp (endpoint env), smoke, cf (also used as the account id for every Cloudflare API call) | `<account-id>` (32 hex characters) | `cf` stops: "R2_ACCOUNT_ID must be the 32-hex Cloudflare account id". On the worker, R2 calls fail (`input_fetch` / `upload_failed`) |
| `R2_ACCESS_KEY_ID` | S3 access key id of the R2 token | R2 token page when the token is created (section 6.2 of the setup guide) | yes | rp (`secrets` copies it into the RunPod secret `ltx_r2_access_key_id`), smoke (aws checks) | `<r2-access-key-id>` | Canary fails with `could not fetch input` / `config_error`; or all uploads fail |
| `R2_SECRET_ACCESS_KEY` | S3 secret of the R2 token | Same token page, shown once | yes | rp (`secrets` copies it into `ltx_r2_secret_access_key`), smoke | `<r2-secret>` | As above |
| `R2_BUCKET` | Bucket name | Fixed: `jubividia-ltx-eu` | no | rp (endpoint env), smoke, cf (refuses any other name) | `jubividia-ltx-eu` | `cf` stops "R2_BUCKET in config.env is not jubividia-ltx-eu"; on the worker uploads go to the wrong bucket or fail |

### Build and CI

| Key | What it is | Where from | Secret | Read by | Example | If wrong |
|---|---|---|---|---|---|---|
| `IMAGE` | Worker image repository without tag | Default `ghcr.io/ken-ck-yu/ltx25-worker` (your fork's path if you fork) | no | make (local build name); rp (repository part of the endpoint image; default is the same value) | `ghcr.io/ken-ck-yu/ltx25-worker` | rp: "IMAGE must be a repository without a tag or digest"; a wrong repository makes the endpoint pull fail |
| `TAG` | Tag for a local `make build` | Free text | no | make only | `dev` | Only affects the local image name |
| `IMAGE_TAG` | The CI build tag the endpoint runs | `sha-` plus the first 7 characters of the built commit (GitHub Actions run) | no | rp (`endpoint`, `preflight`), smoke | `sha-f9bc90a` | Must match `^sha-[0-9a-f]{7,}$`. `latest` and anything else are rejected. Empty on purpose by default: `rp endpoint`, `rp preflight` and `smoke` refuse to run with it empty. A tag that does not exist makes the endpoint unable to start workers |

### RunPod infrastructure

| Key | What it is | Where from | Secret | Read by | Example | If wrong |
|---|---|---|---|---|---|---|
| `RUNPOD_API_KEY` | **Admin** RunPod API key: manages volumes, secrets, endpoint, pods | RunPod console, API keys (full access) | yes | rp, smoke | `<runpod-admin-key>` | rp: HTTP 401 at `preflight`. Also read by `cf` only for a safety comparison with `UI_RUNPOD_API_KEY` |
| `HF_TOKEN` | Hugging Face **read-only** token for the gated model repo | huggingface.co settings | yes | rp (`pod-up` hands it to the pod as the temporary RunPod secret `hf_token_tmp`; `pod-down` deletes it) | `<hf-read-token>` | Download HTTP 401 (invalid) or 403 (license not accepted by that account). Remove or rotate after use |
| `GIT_REF` | Full 40-hex commit the temporary pod checks out and runs | `git rev-parse HEAD` of a commit pushed to the public repo | no | rp (`pod-up`) | `<40-hex-commit>` | Branch names and `HEAD` are refused. A commit not on GitHub makes the pod fail at checkout. An old commit copies old workflow files to the volume |
| `RUNPOD_POD_IMAGE` | Image of the temporary CPU pod (bash 5, curl 7.71+, git) | You choose; the first real run used `ubuntu:22.04` | no | rp (`pod-up`) | `ubuntu:22.04` | Needs an explicit non-`latest` tag. A too-old image fails the script's pre-checks loudly |
| `RUNPOD_POD_CPU_ID` | CPU flavour of the temporary pod | Default `cpu3c` | no | rp | `cpu3c` | Unavailable flavour: pod create fails |
| `RUNPOD_POD_VCPU` | vCPU count of the temporary pod | Default `2` (minimum for these flavours) | no | rp | `2` | Create fails or costs more |
| `SKIP_MOUNT_CHECK` | Set to `1` to skip the "is the volume really mounted" check in the download script | Only after `df -hT` proved the path is the volume | no | rp (passes it to the pod) | `1` | Skipping it wrongly could fill the pod's container disk instead of the volume |
| `RUNPOD_DC` | Data center of volume, endpoint and pod | Default `US-WA-1` (see [architecture.md](architecture.md) for why) | no | rp | `US-WA-1` | `volume` refuses an existing volume that is not in this data center and STANDARD |
| `RUNPOD_VOLUME_NAME` | Volume name | Default `jubividia-ltx-us-wa1` | no | rp | `jubividia-ltx-us-wa1` | A different name creates or adopts a different volume |
| `RUNPOD_VOLUME_GB` | Volume size in GB (10 to 4096) | Default `80` | no | rp | `80` | Grow-only: a smaller number than the existing volume is refused; a bigger one needs `--yes` and is billable and one-way |
| `RUNPOD_ENDPOINT_NAME` | Endpoint name | Default `jubividia-ltx25` | no | rp | `jubividia-ltx25` | A different name creates a new endpoint. The restricted key and Worker secrets refer to the endpoint id, not the name |
| `RUNPOD_WORKERS_MIN` | Minimum workers (kept warm) | Default `0` | no | rp | `0` | A value above 0 bills continuously |
| `RUNPOD_WORKERS_MAX` | Maximum workers | Default `2`. `apply.sh endpoint --max-workers N` overrides it for one run | no | rp (`endpoint`, `status` warning) | `2` | Must be at least 1 and at least the minimum (the tool refuses 0). RunPod lowers it itself after idle days |
| `RUNPOD_IDLE_TIMEOUT_S` | Seconds a worker stays alive after its last job | Default `60` in the tool; Ken uses `180`. Allowed range 1 to 3600 | no | rp | `180` | Shorter = cheaper but more cold starts (about 4 to 5 minutes each). Longer = a burst of use stays warm. The worst-case cost shown on the page assumes 180 s |
| `RUNPOD_EXEC_TIMEOUT_MS` | Per-request execution timeout, **milliseconds** | Default `900000` (15 minutes), our own spend-safety choice, not a RunPod limit (RunPod allows 5 s to 7 days). Must be 5000 to 604800000 | no | rp; smoke (wall-clock cap = this plus 600 s); also forwarded to the worker as `EXEC_TIMEOUT_S` | `900000` | `JOB_TIMEOUT_S` plus 15 s must stay below it or `endpoint` refuses. The tool reads the value back after every change and fails if the unit was misread |
| `RUNPOD_QUEUE_DELAY_S` | Queue-delay scaler: seconds a request waits before another worker is started | Default `4`, minimum `0.5` | no | rp | `4` | Only matters with more than one worker allowed |
| `RUNPOD_DISK_GB` | Container disk per worker in GB | Default `20` | no | rp | `20` | The design note warned that a disk too small for the image plus handler temporary files would make workers fail; the image is about 25 GB uncompressed. The default 20 GB was used in all working runs, so it is known to work; the design note said to confirm it from the first worker's logs |
| `RUNPOD_NETWORK_VOLUME_ID` | Volume id | **Written by `apply.sh volume`** | no | rp | `<volume-id>` | Leave empty before the first run. Do not delete while the volume exists. An id that does not exist stops the tool |
| `RUNPOD_ENDPOINT_ID` | Endpoint id | **Written by `apply.sh endpoint`** | no | rp, smoke, cf (copied into the Worker secret `RUNPOD_ENDPOINT_ID`) | `<endpoint-id>` | Wrong id: the tools stop; the Worker shows "The GPU endpoint was not found (misconfigured)" |
| `RUNPOD_POD_ID` | Id of the temporary pod | **Written by `pod-up`, cleared by `pod-down`** | no | rp | `<pod-id>` | Cleared automatically |
| `RUNPOD_SECRET_ID_R2_KEY_ID` | RunPod secret id of `ltx_r2_access_key_id` | Written by `apply.sh secrets` | no | rp | `<secret-id>` | Informational |
| `RUNPOD_SECRET_ID_R2_KEY_SECRET` | RunPod secret id of `ltx_r2_secret_access_key` | Written by `apply.sh secrets` | no | rp | `<secret-id>` | Informational |

### Worker tuning forwarded to the endpoint environment

Only these five are forwarded by `apply.sh` (when set, as numbers). They are written commented out in the example and have defaults in `worker/handler.py`.

| Key | What it is | Default | Secret | Read by | If wrong |
|---|---|---|---|---|---|
| `JOB_TIMEOUT_S` | Generation budget in seconds; the job fails with `timeout` after it | `780` | no | rp -> worker | Must satisfy `JOB_TIMEOUT_S + 15 < execution timeout in seconds` or `endpoint` refuses. Keep at most about 800 |
| `COMFY_READY_TIMEOUT_S` | Seconds to wait for ComfyUI to accept requests after container start | `300` | no | rp -> worker | Too small fails the first job with `comfy_unavailable` |
| `INPUT_MAX_BYTES` | Maximum size of an input fetched from R2 | `524288000` (500 MiB) | no | rp -> worker | Larger inputs fail with `input_fetch` "input file too large" |
| `POLL_INTERVAL_S` | Seconds between ComfyUI `/history` polls | `1.0` | no | rp -> worker | Tiny values waste CPU |
| `VRAM_SAMPLE_S` | Seconds between `nvidia-smi` samples for `peak_vram_mb` | `1.0`, minimum `0.2` (the tool refuses lower) | no | rp -> worker | Below 0.2 would fork `nvidia-smi` in a tight loop |

Worker knobs that are **not** forwarded and only apply to local runs: `COMFY_HOST` (`127.0.0.1:8188`), `COMFY_ROOT` (`/comfyui`), `COMFY_PID_FILE` (`/tmp/comfyui.pid`), `WORKFLOWS_DIR` (`/runpod-volume/workflows`). The base image also reads `NETWORK_VOLUME_DEBUG=true` (prints volume diagnostics) and `COMFY_LOG_LEVEL` (for example `INFO`); setting them on the endpoint is not wired into `apply.sh` (not verified how to set them).

### Cloudflare front end (read by `infra/cloudflare/apply.sh`)

| Key | What it is | Where from | Secret | Example | If wrong |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Short-lived deploy token: Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read. No Zero Trust scope | Cloudflare dashboard, API tokens | yes | `<cf-token>` | `preflight` fails token verification. Revoke after `postcheck` and remove it from the file |
| `UI_RUNPOD_API_KEY` | **Restricted** RunPod key (only this endpoint, Read/Write). Becomes the Worker secret named `RUNPOD_API_KEY` | RunPod console (setup guide section 7.9) | yes | `<runpod-restricted-key>` | `secrets` refuses if equal to `RUNPOD_API_KEY`. A key that is too narrow shows as "The GPU service rejected the server's credentials" |
| `ALLOWED_EMAILS` | Comma-separated list of addresses allowed to use the page | You | no (kept out of the repo for privacy) | `<your-email>,<her-email>` | `secrets` refuses a malformed list. Anyone not listed gets HTTP 403 even after Access login |
| `TEAM_DOMAIN` | `https://<team-name>.cloudflareaccess.com`, **no trailing slash** | Your Zero Trust team name | no | `https://<team-name>.cloudflareaccess.com` | `secrets` refuses a different shape; a wrong team makes JWT checks fail (403) |
| `POLICY_AUD` | The Access application's Audience (AUD) tag | Zero Trust, Access controls, Applications, the Worker's application | no (an identifier; kept out of the repo) | `<aud-tag>` | Worker answers 403 to every logged-in user |

Set `ALLOWED_EMAILS`, `TEAM_DOMAIN` and `POLICY_AUD` only after `verify-access` passes. The Cloudflare tool reads exactly these keys: `CLOUDFLARE_API_TOKEN R2_ACCOUNT_ID R2_BUCKET RUNPOD_API_KEY UI_RUNPOD_API_KEY RUNPOD_ENDPOINT_ID ALLOWED_EMAILS TEAM_DOMAIN POLICY_AUD`.

## Environment-only settings of the tools

These are not read from `config.env`; set them in the shell for a single command.

| Variable | Used by | Meaning | Default |
|---|---|---|---|
| `CONFIG_ENV` | all tools | Path to the config file | `<repo root>/config.env` |
| `RUNPOD_API_BASE` | rp, smoke | RunPod management API base | `https://api.runpod.io/v2` (routes `/account/secrets`, `/network-volumes`, `/serverless`, `/pods`) |
| `RUNPOD_RUN_BASE` | smoke | Runtime API base, used when the endpoint has no `requestUrls` | `https://api.runpod.ai/v2` |
| `RUNPOD_TEST_MODE`, `CF_TEST_MODE` | tests | `1` makes the tools refuse any URL that is not `http://127.0.0.1:*`. Only 0 or 1 accepted for the Cloudflare tool | `0` |
| `HF_TOKEN`, `HF_ENDPOINT`, `VOLUME_ROOT`, `SKIP_MOUNT_CHECK`, `NO_LOCK`, `JOBS`, `FREE_SLACK_BYTES`, `LOCK_FILE`, `WORKFLOWS_SRC` | `scripts/download-models.sh` | Token (env only), Hugging Face base URL, volume mount, mount-check escape hatch, skip run lock, parallel downloads (2), free-space slack (5,000,000,000 bytes), lock file, workflow source folder | see script |
| `SMOKE_CSV`, `SMOKE_POLL_S` (5), `SMOKE_POLL_FAIL_LIMIT` (5), `SMOKE_MAX_INPROGRESS_S` (900), `SMOKE_QUEUE_STOP_S` (300), `SMOKE_IDLE_WAIT_S` (600), `SMOKE_JOB_WALL_S` (execution timeout + 600), `SMOKE_HEALTH_FAIL_LIMIT` (5), `SMOKE_IDLE_TAIL_S` (60), `SMOKE_SEED_BASE` (1000), `SMOKE_TOOL_TIMEOUT_S` (30) | `scripts/smoke-job.sh` | Gate timings and stop thresholds | defaults in brackets |
| `CF_STATE_DIR` | cf | Where the baseline and Worker identity files are kept | `<repo root>/.scratch/cloudflare` |

`scripts/download-models.sh` actions and options (from `--help`): `--verify`, `--prune [--dry-run]`, `--update-lock [--rev REV]`, `--workflows-only`, `--list`, `--with-lora`, `--volume-root DIR`, `--no-lock`.

## Cloudflare Worker secrets and variables

The Worker is named `jubividia` and configured in `ui/wrangler.toml`.

**Secrets** (set by `infra/cloudflare/apply.sh --i-confirmed-access secrets`; values never printed; until all exist every request gets HTTP 503):

| Worker secret | Filled from config key | Meaning | If wrong |
|---|---|---|---|
| `RUNPOD_API_KEY` | `UI_RUNPOD_API_KEY` | Restricted RunPod key used for `/run`, `/status`, `/health`, `/cancel` | `gpu_auth` (HTTP 502) |
| `RUNPOD_ENDPOINT_ID` | `RUNPOD_ENDPOINT_ID` | Endpoint to call (4 to 64 characters of letters, digits, `_`, `-`) | `gpu_missing` (HTTP 502) or "not configured" |
| `ALLOWED_EMAILS` | `ALLOWED_EMAILS` | Comma-separated allowed addresses, compared lower-case | 403 for the user |
| `TEAM_DOMAIN` | `TEAM_DOMAIN` | JWT issuer and JWKS location (`<TEAM_DOMAIN>/cdn-cgi/access/certs`); must be `https://` plus host characters, no trailing slash (a trailing slash is stripped by the Worker, the tool refuses it) | Every request 403 or 503 |
| `POLICY_AUD` | `POLICY_AUD` | JWT audience the Worker requires | 403 |

**Plain variables** in `ui/wrangler.toml` (committed; change and redeploy):

| Variable | Value | Meaning |
|---|---|---|
| `GPU_USD_PER_HR` | `"1.75"` | Rate used for cost estimates on the page. Invalid values fall back to 1.75 |
| `DAILY_CAP` | `"30"` | Attempts (failed ones included) per UTC day, shared by all users. An invalid value falls back to 30 |

**Bindings and fixed settings** (`ui/wrangler.toml`): R2 binding `BUCKET` -> bucket `jubividia-ltx-eu`; static assets binding `ASSETS` from `./static` with `run_worker_first = true` (every request, static files included, passes the Worker so the JWT is checked); `workers_dev = true`; `preview_urls = false`; `compatibility_date = "2026-08-01"`; observability enabled. `infra/cloudflare/apply.sh deploy` refuses to deploy if name, `workers_dev`, `preview_urls` or `run_worker_first` differ.

## Limits compiled into the Worker

From `ui/static/calc.js`, `ui/src/runpod.js`, `ui/src/upload.js`, `ui/src/auth.js`, `ui/src/outputs.js`. Changing any of them needs a code change and a redeploy.

| Limit | Value |
|---|---|
| Width and height | 256 to 2048, multiples of 64, default 1280x704 |
| Frames | 9 to 481, form 8k+1, default from duration 5 s at 24 fps = 121 |
| Duration | 0.3 to 20 s (and duration x fps within 481 frames) |
| Frames per second | 1 to 60, default 24 |
| Seed | 0 to 4294967295 (optional) |
| Video continuation (v2v) | at least 33 frames |
| Prompt | 1 to 2000 characters |
| Measured size ("envelope") | 1280 x 704 x 121; beyond it the page warns "untested" |
| Uploads | image 20 MB, video 95 MB (decimal megabytes). Types: JPEG, PNG, WebP, MP4, MOV. WebM, HEIC, HEIF, AVIF refused. First bytes are checked |
| Job policy on every submit | `ttl` 2,100,000 ms (35 min), `executionTimeout` 900,000 ms (15 min) |
| Stale reservation | 35 min + 2 min |
| Unknown-outcome lock release | after 120 s if `/health` shows nothing in flight |
| RunPod call timeout | 15 s each |
| Access JWT | algorithm RS256, issuer = `TEAM_DOMAIN`, audience = `POLICY_AUD`, `exp` required, clock tolerance 30 s, email must be in `ALLOWED_EMAILS` |
| Gallery page | default 12, maximum 24 items |
| Worst-case cost per job | 900 s run cap + 105 s boot + 180 s idle tail + 150 s scale-down margin = 1335 s, about $0.65 at $1.75/h (one constant, `calc.js`) |

## RunPod endpoint settings

Applied by `infra/runpod/apply.sh endpoint` (body built in `infra/runpod/rpjson.py`). After each create or patch the tool reads the endpoint back and fixes any differing field with a PATCH of only that field. It never deletes an endpoint on its own.

| Setting | Value | Notes |
|---|---|---|
| name | `jubividia-ltx25` (`RUNPOD_ENDPOINT_NAME`) | |
| type | `QUEUE` | Immutable. Required by the handler (`/run` + `/status`). Load-balancing endpoints were rejected (5.5 minute processing cap, 30 MB payload) |
| image | `<IMAGE>:<IMAGE_TAG>` | Pin a `sha-` tag. Changing image or env creates a new release and replaces workers |
| GPU | pool `ADA_48_PRO` minus excluded types `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`; count 1; `minCudaVersion` 12.8 | Leaves only `NVIDIA RTX 6000 Ada Generation`. `pools` and `excludedTypes` must always be sent together (updating `pools` alone clears the exclusions). Hosts with CUDA 13.2 satisfy the 12.8 floor |
| data center | `dataCenterIds: ["US-WA-1"]` (`RUNPOD_DC`) | The volume mount is what actually binds the endpoint to that data center |
| volume | `mounts.network: [{volumeId: <volume-id>}]` | Appears at `/runpod-volume` |
| workers | min 0, max 2, idle timeout 60 s by default (`RUNPOD_WORKERS_MIN`, `RUNPOD_WORKERS_MAX`, `RUNPOD_IDLE_TIMEOUT_S`); Ken: idle 180 s | `--max-workers N` overrides the maximum for one run. The tool refuses maximum 0. Idle timeout range 1 to 3600 |
| scaling | `QUEUE_DELAY`, `queueDelay` 4 (`RUNPOD_QUEUE_DELAY_S`, minimum 0.5) | |
| FlashBoot | `FLASHBOOT` | REST default is OFF, so it is always sent. Whether it helps here is unproven (the model loads inside the first job) |
| execution timeout | `timeout: 900000` ms (`RUNPOD_EXEC_TIMEOUT_MS`) | Milliseconds. Each job also carries its own `executionTimeout` from the Worker |
| container disk | 20 GB (`RUNPOD_DISK_GB`) | |
| env | `R2_ACCOUNT_ID`, `R2_BUCKET` (plain); `R2_ACCESS_KEY_ID = {{ RUNPOD_SECRET_ltx_r2_access_key_id }}`; `R2_SECRET_ACCESS_KEY = {{ RUNPOD_SECRET_ltx_r2_secret_access_key }}`; `EXEC_TIMEOUT_S` = timeout / 1000; plus any of the five tuning keys that are set | The `{{ RUNPOD_SECRET_<name> }}` text is replaced by RunPod when a worker boots. The endpoint configuration holds only the reference |
| registry | none (public image) | |

RunPod secrets used: `ltx_r2_access_key_id`, `ltx_r2_secret_access_key` (permanent, names immutable, values write-only, a secret's own name must not start with `RUNPOD`), and `hf_token_tmp` (temporary, created by `pod-up`, deleted by `pod-down`). Rotating a secret reaches workers at their next boot.

RunPod's own behaviours worth knowing: after 3 days without requests it lowers the endpoint's maximum workers to 2, after 7 days to 0; jobs then answer HTTP 409 (paused) until `apply.sh endpoint` restores the maximum. A worker whose cold start exceeds 7 minutes is marked unhealthy (from the design review; not triggered so far).

## R2 bucket layout and lifecycle rules

Bucket `jubividia-ltx-eu` (Western Europe location hint, Standard, default jurisdiction).

```
inputs/<uuid>.<ext>                            uploads written by the Worker (jpg, png, webp, mp4, mov)
outputs/<YYYY-MM-DD UTC>/<YYYYMMDDTHHMMSS>-<job_id>.mp4    finished clip (h264 video + AAC audio)
outputs/<YYYY-MM-DD UTC>/<YYYYMMDDTHHMMSS>-<job_id>.jpg    thumbnail (first frame)
outputs/<YYYY-MM-DD UTC>/<YYYYMMDDTHHMMSS>-<job_id>.json   sidecar: written LAST, marks a completed clip
state/active.json                              the one-job reservation lock
state/usage/<YYYY-MM-DD>.json                  attempts counted for that UTC day
state/last.json                                the most recent finished job (so a reload can resolve it)
```

- The `.mp4` and `.jpg` are uploaded first and the `.json` sidecar last; if the sidecar fails the earlier files are deleted. The gallery lists sidecars only, so changing this order in `worker/handler.py` would break the gallery.
- The timestamp is taken when the job starts; a retried job gets new keys.
- The sidecar holds `v`, `job_id`, `created_at`, `mode`, `prompt`, `negative`, `input_key`, `seed`, `width`, `height`, `num_frames`, `fps`, `gen_time_s`, `cold`, `peak_vram_mb`.
- The Worker serves only keys matching `outputs/<date>/<timestamp>-<id>.(mp4|jpg|json)`. It never serves `inputs/` or `state/`.

Lifecycle rules (added by `infra/cloudflare/apply.sh lifecycle`, existing rules are kept):

| Rule id | Prefix | Action |
|---|---|---|
| `inputs-expire-7d` | `inputs/` | delete objects 7 days after creation |
| `state-expire-40d` | `state/` | delete objects 40 days after creation |
| `abort-multipart-1d` | (whole bucket) | abort unfinished multipart uploads after 1 day |

Outputs are never expired (about 1 MB per clip; the free tier is 10 GB). R2 applies expiry asynchronously, so rules can act up to about a day late.

## Network volume layout

Volume `jubividia-ltx-us-wa1`, 80 GB, standard, US-WA-1. Mounted at `/runpod-volume` on serverless workers (and on the temporary pod, where the tool sets the same path).

```
/runpod-volume/models/diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors
/runpod-volume/models/text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors
/runpod-volume/models/vae/ltx-2.5-video-vae-bf16.safetensors
/runpod-volume/models/vae/ltx-2.5-audio-vae-bf16.safetensors
/runpod-volume/models/vae/ltx-2.5-video-vae-conv-bf16.safetensors
/runpod-volume/models/latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors
/runpod-volume/models/latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors
/runpod-volume/models/model_patches/ltx-2.5-duration-head-bf16.safetensors
/runpod-volume/models/loras/            (optional distilled LoRA, only with --with-lora; not downloaded by default)
/runpod-volume/models/.manifest-rev     commit + lock hash of the last successful run
/runpod-volume/workflows/{t2v,i2v,v2v}.json
```

- The default set is 41.43 GB (38.6 GiB), pinned to Hugging Face commit `49b093a39c19169a8a81721dcc541e07e945232f` with sha256 values in `scripts/models.lock`. The two-stage workflows use five of the files; the temporal upscaler, duration head and conv VAE are reserved and unused.
- ComfyUI finds the model folders through `/comfyui/extra_model_paths.yaml` (baked into the image), which maps `diffusion_models`, `text_encoders`, `vae`, `latent_upscale_models`, `loras`, `checkpoints` and `model_patches` below `/runpod-volume/models`. Workflows refer to filenames only, never paths.
- Workflow templates are ComfyUI **API format** and are filled by node title (`PROMPT`, `NEGATIVE`, `WIDTH`, `HEIGHT`, `FRAMES`, `FPS`, `SEED`, `INPUT`, `OUTPUT`); see `workflows/README.md`. The default files are two-stage distilled; `workflows/single-stage/*.json` is an unmeasured fallback.
- Only models and workflow templates go on the volume. ComfyUI `temp/`, `output/` and `input/` stay on container disk or in R2.

## Handler contract: input, output, error codes

`worker/handler.py`, contract version 1. The Worker validates tighter than the handler (see "Limits compiled into the Worker"); the handler is the last line of defence.

**Input** (`job["input"]`):

| Field | Rule |
|---|---|
| `mode` | `t2v`, `i2v` or `v2v` (required) |
| `prompt` | non-empty string, at most 8000 characters (required) |
| `negative` | optional string, at most 8000 characters. The page does not send one (CFG is 1) |
| `input_key` | R2 key under `inputs/` (at most 512 characters, no empty, `.` or `..` parts, no backslash or control characters). Required for `i2v` and `v2v`, refused for `t2v`. URLs are not accepted |
| `width`, `height` | 256 to 2048, default 1280 x 720; rounded **down** to a multiple of 64 (720 becomes 704); the effective size is returned |
| `fps` | 1 to 60, default 24 |
| `num_frames` | 9 to 481 and 8k+1; overrides `duration` |
| `duration` | 0.3 to 20 seconds, default 5; converted to the nearest 8k+1 frames at `fps`; must not exceed 481 frames |
| `seed` | integer 0 to 2^53; random if absent |
| v2v minimum | at least 33 frames (the guide uses the last 25 frames of the input) |

**Output on success**: `{v, key, thumb_key, meta_key, duration_s, gen_time_s, seed, width, height, num_frames, fps, cold, peak_vram_mb}`. `key`, `thumb_key`, `meta_key` are the three R2 keys. `gen_time_s` includes the model load for the first job after a cold start. `cold` is true for the first job that reached ComfyUI in that worker process. `peak_vram_mb` is the peak `nvidia-smi` memory used in MiB sampled during generation (includes PyTorch's allocator reserve; report-only), `null` if `nvidia-smi` is unavailable.

**Output on failure**: `{error: "[code] message", error_code: code}`. The code is also prefixed into the text in case RunPod drops the field; the first real run confirmed that `/status` exposes `error_code`.

| Code | Meaning |
|---|---|
| `bad_input` | Input failed validation (message is readable) |
| `config_error` | A required R2 variable is not set on the worker |
| `input_fetch` | Input could not be read from R2 ("input not found", too large, or a read error, which also happens when the R2 credentials did not resolve) |
| `workflow_mismatch` | Workflow template missing, unreadable, not API format, a required titled node missing, or ComfyUI rejected the workflow, or more than one saved video without an `OUTPUT` node |
| `model_missing` | A model file is missing or misnamed on the volume |
| `oom` | GPU ran out of memory |
| `timeout` | Generation exceeded `JOB_TIMEOUT_S`; the run is interrupted |
| `comfy_unavailable` | ComfyUI not reachable, not ready in time, or its process is dead |
| `comfy_bad_response` | ComfyUI reply not JSON, or no prompt id |
| `comfy_error` | Any other ComfyUI error, or an unexpected worker error |
| `output_missing` | ComfyUI finished but produced no mp4, or the thumbnail could not be made |
| `upload_failed` | Upload to R2 failed after 3 tries |

Timing inside a job: uploads use boto3 with 5 s connect and 30 s read timeouts, boto retries off, and 3 bounded tries of at most 45 s each; all uploads must finish by 885 s after job start (execution timeout minus 15 s). A failed job is not retried by the worker. The page shows readable text for each code (see `ui/src/status.js`).

## Credentials, scopes, least privilege and rotation

Principle of least privilege: each credential can do only what its holder needs, and holders are as few as possible.

| Credential | Scope to give | Held by | Never |
|---|---|---|---|
| **RunPod admin key** (`RUNPOD_API_KEY`) | Full access (manages volumes, secrets, endpoint, pods) | Your machine only (`config.env`) | In the Worker, the repository, chat, CI |
| **RunPod restricted key** (`UI_RUNPOD_API_KEY`, stored in the Worker as `RUNPOD_API_KEY`) | `api.runpod.io/graphql` (management API): **None**. `api.runpod.ai` (runtime API): **Restricted** to the one endpoint, **Read/Write** | The Cloudflare Worker (as a secret) and your `config.env` | Reusing the admin key. The tool refuses equal values |
| **Cloudflare deploy token** (`CLOUDFLARE_API_TOKEN`) | Workers Scripts Edit, Workers R2 Storage Edit, Account Settings Read. **No Zero Trust scope** | Your machine, briefly | Keeping it after `postcheck` |
| **R2 S3 token** (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) | Object Read & Write, **scoped to the one bucket** `jubividia-ltx-eu` | RunPod account secrets (read by workers at boot) and your `config.env` | An account-wide token. Putting it in the Worker (the Worker uses a binding instead) |
| **Hugging Face token** (`HF_TOKEN`) | **Read-only** | Your `config.env` and, for the duration of `pod-up`, the temporary RunPod secret `hf_token_tmp` | Keeping it after the download |
| **Access login** | One-time PIN code to an allowed address, or a Cloudflare account login (if that provider is enabled) | The people in `ALLOWED_EMAILS` | Allowing a whole email domain |
| **GitHub Actions** | The built-in `GITHUB_TOKEN` with `packages: write` (workflow permissions) | GitHub | Any other secret: the workflow needs none |

What a leaked credential could do:

- **Admin RunPod key**: create and delete endpoints, pods, secrets and volumes, and spend your RunPod balance. Revoke immediately in the RunPod console.
- **Restricted RunPod key**: submit, read and cancel jobs on the one endpoint, and so spend GPU money up to the endpoint's limits (one active job is enforced by the Worker, not by RunPod; `workers.max` caps real concurrency). It cannot manage resources.
- **Cloudflare deploy token**: deploy or alter Workers on the account (Cloudflare tokens cannot be restricted to one Worker) and edit R2. Short-lived by design.
- **R2 S3 token**: read, overwrite or delete every object in that one bucket (uploads, outputs, state files).
- **Hugging Face read token**: download gated models as you.
- **A forged Access header**: useless: the Worker verifies the JWT signature, issuer, audience, expiry and email itself.
- **A stolen browser session**: full use of the page until it expires (the chosen session length), within the daily cap of 30 clips and one job at a time.
- **Your email inbox** is the root of trust for One-time PIN logins: protect it with MFA. The Cloudflare identity provider (with its own MFA) would be an alternative for people with a Cloudflare account.

Rotation advice (not an enforced schedule; the repository sets none):

| Credential | How to rotate |
|---|---|
| RunPod admin key | Create a new key in the console, put it in `config.env`, check with `infra/runpod/apply.sh status`, then delete the old key. Only your machine holds it, so nothing else changes |
| RunPod restricted key | Create a new restricted key (same scopes), set `UI_RUNPOD_API_KEY`, run `infra/cloudflare/apply.sh --i-confirmed-access secrets` (needs a fresh Cloudflare token), then delete the old key |
| Cloudflare deploy token | Do not keep it. Create a new short-lived token for each deploy; revoke after `postcheck` |
| R2 S3 token | Create a new token (same bucket scope), update `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, run `infra/runpod/apply.sh secrets --rotate` (values reach workers at their next boot; a warm worker keeps the old value until it restarts), run `scripts/smoke-job.sh` or one clip to check, then delete the old token |
| Hugging Face token | Revoke right after each download; create a fresh read-only token only when you need to download again |
| Allowed users / Access | See the runbook in [architecture.md](architecture.md#add-or-remove-an-allowed-user) |

## Spend limits

Layered, none relies on keeping the URL secret.

| Guard | Where | Value |
|---|---|---|
| Login | Cloudflare Access plus Worker JWT check | Only listed addresses; unauthenticated requests never reach RunPod |
| One job at a time | Worker, R2 object `state/active.json` (create-if-absent / compare-and-swap), also refused while RunPod `/health` shows jobs in flight | A timed-out submit keeps the lock (the job may exist); Cancel keeps it until RunPod reports a terminal state; a stale lock frees itself after 35 + 2 minutes |
| Daily cap | Worker, R2 `state/usage/<UTC date>.json` | `DAILY_CAP` = 30 attempts per UTC day, shared; failed attempts count; a definitively rejected submit is rolled back |
| Size and length | Worker validation and handler | Measured envelope 1280 x 704 x 121; larger is allowed but warned as untested |
| Per-job timing | Worker policy and endpoint | `ttl` 35 min; `executionTimeout` 15 min; handler `JOB_TIMEOUT_S` 780 s |
| Worker count | Endpoint | `workers.max` (default 2; the Worker's lock means one is used); `min` 0 |
| Gate spend guard | `scripts/smoke-job.sh` | `--max-spend` default 3.00 USD; cancels and exits 3 when reached |
| Balance | RunPod | The final backstop. Add credit in small amounts; set a low-balance alert |
| Standing cost | RunPod volume | $5.60 per month |

Theoretical bound at the daily cap: 30 jobs x about $0.65 worst case = about $19.50 (arithmetic from the numbers above; practically unreachable because one job runs at a time and most jobs are far shorter).

## Cost table

Prices read on 2026-10-29. Rates and the measured numbers are from the README, `docs/decisions/endpoint.md` and `docs/decisions/ui.md`; derived rows are arithmetic, marked "derived".

| Item | Price or amount | Notes |
|---|---|---|
| Serverless GPU, RTX 6000 Ada | $1.75 per hour (about $0.000486 per second) per running worker | Idle workers: billing for idle time is unconfirmed |
| Warm 5.04 s clip (1280x704, 121 frames) | about $0.034 | 70.9 s execution; generation 66 to 68 s |
| First clip after idle | about $0.09 to $0.14 | depends on whether worker start is billed; measured 291.5 s submit to done |
| Idle tail per job at 180 s (derived) | about $0.0875 if billed | 180 s x $1.75 / 3600 |
| Worst case per job (page figure) | up to about $0.65 | 15 min run cap + boot + idle + margin |
| Cost per day at the cap, realistic (derived) | 30 warm clips about $1.02; 30 cold clips about $4.20 | |
| Network volume | $0.07 per GB per month = **$5.60 per month** for 80 GB | Accrues hourly until deleted. Grow-only |
| Temporary CPU pod (cpu3c, 2 vCPU, secure) | about $0.06 per hour plus a small disk | The measured download took 3 min 39 s plus 2 min 21 s verify |
| GPU pod fallback for the download | about $0.99 per hour | Only with an explicit decision |
| Container disk (serverless) | about $0.10 per GB per month | Design-note figure (5-minute billing) |
| Full gate run | estimate $0.62 for the second real run; quote $1 to $2 expected, $5 to $6 worst case | `--max-spend` default 3.00 |
| Model download (one time) | cents | |
| R2 | free tier 10 GB storage, 1M Class A and 10M Class B operations per month, free egress | Above it: $0.015 per GB-month, $4.50 per million Class A, $0.36 per million Class B |
| Cloudflare Workers (Free plan) | $0 | 100,000 requests per day, 10 ms CPU per request |
| Cloudflare Zero Trust Free plan | $0 for up to 50 seats | |
| GitHub Actions / GHCR | $0 for a public repository (not verified for your plan) | |
| Observed total at the time of the first passing gate | about $0.46 of a $10 credit | |

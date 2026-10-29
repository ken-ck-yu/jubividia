# endpoint - design note

## Summary
`infra/runpod/` creates, from this repo and idempotently, the RunPod network volume (80 GB standard, US-WA-1), two account secrets (R2 key id and secret), the serverless QUEUE endpoint (RTX 6000 Ada pinned, min 0 / max 2, FlashBoot on, image pinned by `sha-<short>`), and the temporary CPU pod that runs `scripts/download-models.sh`. There is **no maintained Terraform provider**, so the tool is a bash script, `infra/runpod/apply.sh`, against the RunPod REST v2 API (the same surface the MCP tools wrap), with `--dry-run`, ID write-back to `config.env`, and a teardown that terminates the pod and has no code path that deletes the volume. `scripts/smoke-job.sh` submits a tiny t2v job and records cold vs warm timing. A gating plan covers the first real RTX 6000 Ada generation (Ken's decision 8). Everything billable is listed with prices in "Billable steps"; the coordinator makes those calls, this note makes none.

Read-only calls only were made for this note (list/get/describe, docs search). Nothing was created on RunPod or Cloudflare.

## Premise problems found (read first)
1. **The worktree is not off a merged main.** `main` and `origin/main` are both at `933671c` (seed). `feat/worker`, `feat/models`, `feat/workflows`, `docs/spec-reconcile` are unmerged. I read the worker, models, workflows notes, `handler.py`, `Dockerfile`, `download-models.sh`, `models.lock`, `config.env.example`, and the reconciled SPEC from those branches with `git show`. Nothing in this note depends on code that is absent from those branches, but `infra/runpod/` must be implemented after they merge.
2. **No image tag exists yet.** `build-worker.yml` only runs on push to `main` touching `worker/**`, and `main` has no worker. So there is no `sha-<short>` tag to pin. The endpoint cannot be created until the worker is merged, CI is green, the GHCR package is public, and the tag is read from the run. `apply.sh` will refuse `latest` and any tag not matching `^sha-[0-9a-f]{7,}$`. (Handler also needs the workflows branch: `workflows/*.json` must exist before `download-models.sh` can copy them.)
3. **Stock is LOW, not MEDIUM.** Live reads today: RTX 6000 Ada serverless availability `LOW` overall and `LOW` at US-WA-1 (the SPEC says MEDIUM). Only US-WA-1 and US-CA-2 list it; US-CA-2 has only HIGH_PERFORMANCE volumes, so US-WA-1 is the only place it works with a standard volume.
4. **Unmerged SPEC.md in this worktree still says A6000/A40.** Ken's reconciled text is on `docs/spec-reconcile`. Not touched here.

## Verified facts (live reads, 2026-10-29)
| Fact | Value | Read |
|---|---|---|
| GPU id string (pods, `excludedTypes`) | `NVIDIA RTX 6000 Ada Generation` | list-gpu-types |
| Serverless pool id (`gpu.pools`) | `ADA_48_PRO` (shared with `NVIDIA L40`, `NVIDIA L40S`, `NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb`) | list-gpu-types |
| Serverless price | $1.75/hr (same pool price for all four) | list-gpu-types |
| Pod price (secure) / community | $0.99/hr / $0.74/hr; volumes need Secure | list-gpu-types |
| RTX 6000 Ada stock | LOW, data centers US-CA-2 (LOW), US-WA-1 (LOW) | get-gpu-type, list-data-centers |
| Host CUDA with capacity | only `13.2` available (12.4, 13.0 unavailable). `gpu.minCudaVersion: "12.8"` is a numeric floor, so 13.2 satisfies it; the base image is CUDA 12.8 | get-gpu-type |
| US-WA-1 volume tiers | `STANDARD` only | get-data-center |
| CPU pod stock at US-WA-1 | cpu3c, cpu3g, cpu3m all `HIGH` | list-data-centers include CPU_AVAILABILITY |
| CPU pod price (secure, per vCPU/hr) | cpu3c $0.03, cpu3g $0.04, cpu3m $0.055; min 2 vCPU | list-cpu-types |
| Network volume | $0.07/GB/month (<1 TB), 10-4096 GB, grow-only, `dataCenter` and `type` immutable, no status field, Secure Cloud only, serverless mount `/runpod-volume` | create-network-volume schema, lookup-concept, docs |
| Account state | 0 volumes, 0 endpoints, 0 pods, 0 secrets, billing history all 0 | list-* , list-billing |

`create-endpoint` (REST v2) schema supports everything the spec asks for:
- `type` (`QUEUE`, immutable, required), `scaling` (`QUEUE_DELAY` with `queueDelay` >= 0.5, or `REQUEST_COUNT`), `image`, `env` (map), `disk`, `registry` (not needed, public image).
- `gpu.pools` (pool ids), `gpu.excludedTypes`, `gpu.count`, `gpu.minCudaVersion` / `allowedCudaVersions`.
- `dataCenterIds`, `mounts.network[{volumeId}]` (always mounted at `/runpod-volume`; `networkVolumes` is deprecated).
- `workers.min/max/idleTimeout` (idleTimeout 1-3600 s), `flashboot` (`OFF|FLASHBOOT|PRIORITY_FLASHBOOT`; REST default is OFF, so it must be set), `timeout` (integer, default 300000: **milliseconds** by the default, while the docs prose says 300 s; verify by read-back before relying on it).
- Secrets: `create-secret` (name unique, immutable, must not start with `RUNPOD`, value write-only) and an env value of `{{ RUNPOD_SECRET_<name> }}` on the endpoint. Rotation reaches workers at next boot.
- Env or image change creates a new release rolled out by replacing workers; `workers`, `scaling`, `timeout` apply promptly.
- Account `workers.max` sum is capped by a balance-tiered quota (5 to start); 2 is fine.
- Idle endpoint rule: 3 days without requests reduces max workers to 2, 7 days sets it to 0. The script must be able to restore it (a `status` check that warns when max != 2).

`create-pod` supports `cpu: {id, vcpuCount}`, `cloud: SECURE`, `dataCenterIds`, `mounts.network[{volumeId, path}]` (mount path must be given: use `/runpod-volume` so the tree matches the serverless layout), `env`, `args`/`cmd`, `image`, `disk`, `ports`. A network volume cannot be attached after creation or swapped.

**Terraform:** a web search found only `runpod/terraform-provider-runpod`, described as dev-override based (no Registry listing found), scoped to pods and machines, with a handful of open issues; it does not cover endpoints, volumes or secrets. A Pulumi provider exists but is a separate stack. Conclusion: not a maintained basis for reproducibility; use a REST v2 script. (Sources: awesome.ecosyste.ms entry for runpod/terraform-provider-runpod; Pulumi registry page for runpod.)

## Design

### Layout
```
infra/runpod/
  apply.sh              # the only mutating tool; subcommands below
  lib.sh                # api(), read_cfg(), write_id(), redact(), json helpers
  endpoint.json.tmpl    # request body with ${PLACEHOLDERS}; contains no secret values
  pod.json.tmpl         # temp CPU pod body
  README.md             # (short) how to run, what bills
scripts/smoke-job.sh    # submit, wait, timings, R2 keys, cold vs warm log
```
Dependencies: bash 5, curl, jq (fall back to python3 -I -c for JSON if jq is absent), awk. Base URL `https://api.runpod.io/v2`, bearer key from `RUNPOD_API_KEY`.

### config.env contract (documented in `config.env.example`, values never in repo)
```
RUNPOD_API_KEY=            # REST v2 key (never printed)
HF_TOKEN=                  # read-only; passed to the pod as an env var only
R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET=jubividia-ltx-eu
# --- written back by apply.sh (not secret) ---
RUNPOD_NETWORK_VOLUME_ID=
RUNPOD_ENDPOINT_ID=
# --- inputs with defaults ---
RUNPOD_DC=US-WA-1  RUNPOD_VOLUME_NAME=jubividia-ltx-us-wa1  RUNPOD_VOLUME_GB=80
RUNPOD_ENDPOINT_NAME=jubividia-ltx25
WORKER_IMAGE=ghcr.io/ken-ck-yu/ltx25-worker:sha-XXXXXXX   # must match ^sha-[0-9a-f]{7,}$
RUNPOD_IDLE_TIMEOUT_S=60  RUNPOD_WORKERS_MIN=0  RUNPOD_WORKERS_MAX=2
RUNPOD_EXEC_TIMEOUT_MS=900000   # platform limit; handler JOB_TIMEOUT_S=780 stays inside it
RUNPOD_POD_IMAGE=          # pinned tag chosen at pod-up time from a template/image read (no :latest)
```
`apply.sh` parses `config.env` with a fixed-key allowlist reader (`KEY=value` lines only, never `source`, so a stray line cannot execute) and never echoes values. Debug output goes through `redact()` which masks the values of every `*_KEY`, `*_SECRET*`, `*_TOKEN` variable. `set +x` is forced; the script refuses to run under `bash -x`. Request bodies containing secret values are sent with `curl --data @-` fed from a here-string inside the script (never argv, never a temp file, never logged); API error bodies are printed only after redaction.

### apply.sh subcommands (all idempotent, all honour `--dry-run`)
| Command | Does | Idempotency rule |
|---|---|---|
| `preflight` | reads only: key valid, `STANDARD` tier at DC, RTX 6000 Ada stock at DC, CPU stock at DC, image tag format, anonymous GHCR manifest fetch for the tag (proves the package is public), `list-network-volumes` / endpoints / secrets for name clashes | no writes |
| `volume` | create 80 GB STANDARD volume | use `RUNPOD_NETWORK_VOLUME_ID` if set and GET succeeds; else list and match exact name+DC+type; 0 matches: create and write the id back; >1: stop. If size < wanted: PATCH grow (never shrink; refuses a smaller value) |
| `secrets` | create `ltx_r2_access_key_id`, `ltx_r2_secret_access_key` | exists by name: skip; `--rotate` PATCHes the value (value only, separate call from description). Names are immutable |
| `endpoint` | create or update the endpoint from the template | by id, else exact name; create if absent; else compute a field-level diff of the keys the template owns and PATCH only changes. Container changes (image, env) are announced as "creates a new release, replaces workers". Reads back and asserts every owned field. Restores `workers.max` if the idle auto-scale-down reduced it |
| `pod-up` | create the temp CPU pod, volume mounted at `/runpod-volume`, `HF_TOKEN` and the clone/run command | refuses if a pod named `jubividia-models-tmp` already exists (prints its id) |
| `pod-logs` | tails pod logs (read) | - |
| `pod-down` | terminate (DELETE) the temp pod and read back that it is gone | only the pod named `jubividia-models-tmp` whose id is recorded in `.runpod-state` or matched by exact name; never anything else |
| `status` | reads everything back and prints a table with prices | read only |
| `teardown-endpoint` | set `workers.max=0`, then delete the endpoint; keeps secrets and volume | requires `--yes` |

There is deliberately **no `volume-delete` subcommand**. Deleting the volume is console-only and documented as irreversible. Secrets are also never auto-deleted.

### Endpoint body (what the template renders)
```
name: jubividia-ltx25   type: QUEUE
image: ghcr.io/ken-ck-yu/ltx25-worker:sha-<short>
gpu: { pools: ["ADA_48_PRO"],
       excludedTypes: ["NVIDIA L40","NVIDIA L40S",
         "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"],
       count: 1, minCudaVersion: "12.8" }
dataCenterIds: ["US-WA-1"]
mounts: { network: [ { volumeId: <id> } ] }
workers: { min: 0, max: 2, idleTimeout: 60 }
scaling: { type: QUEUE_DELAY, queueDelay: 4 }
flashboot: FLASHBOOT
timeout: 900000
disk: 20          # container disk GB; confirm against the 24.75 GB image / handler tmp needs (see risks)
env: { R2_ACCOUNT_ID, R2_BUCKET,
       R2_ACCESS_KEY_ID: "{{ RUNPOD_SECRET_ltx_r2_access_key_id }}",
       R2_SECRET_ACCESS_KEY: "{{ RUNPOD_SECRET_ltx_r2_secret_access_key }}",
       + any tuning knob that is set in config.env (JOB_TIMEOUT_S=780 etc.) }
```
Pinning: pools take pool ids, so the four-type pool is narrowed by `excludedTypes`. With the exclusions and `dataCenterIds: US-WA-1`, only RTX 6000 Ada can be scheduled. This removes the PRO 6000 MIG 48 GB slice, which has the same price and is also stocked at US-WA-1, because MIG on Blackwell with CUDA 13.2 hosts is untested for int8-convrot/triton (Question 3). Execution `timeout` is 900 000 ms (the platform limit); the handler's `JOB_TIMEOUT_S=780` is what returns a readable `[timeout]` error first. The `{{ RUNPOD_SECRET_... }}` indirection keeps R2 secrets out of the endpoint config and out of `get-endpoint` reads.

### Temp pod (model download)
- CPU pod, `cpu3c` 2 vCPU (secure $0.06/hr; use `cpu3g` 2 vCPU $0.08/hr if the image needs more RAM: 2 vCPU cpu3c is 4 GB RAM, enough for curl + sha256sum), `dataCenterIds: ["US-WA-1"]`, `cloud: SECURE`, `mounts.network: [{volumeId, path:"/runpod-volume"}]`, container disk 10-20 GB, no exposed ports, no SSH.
- Env: `HF_TOKEN`, `VOLUME_ROOT=/runpod-volume`. Command (single string, in the template): install `git curl ca-certificates python3 util-linux` if missing, `git clone --depth 1 https://github.com/ken-ck-yu/jubividia /tmp/j`, then `/tmp/j/scripts/download-models.sh`, then `--verify`, print the table, then `sleep infinity` so the pod stays inspectable. Pod image must give bash 5, curl 7.71+, flock, git: the script's pre-checks fail loudly otherwise. Image tag is chosen at run time from a template/image read and pinned in `RUNPOD_POD_IMAGE`.
- The download script requires `mountpoint -q`; if the check wrongly fails on a RunPod mount, the documented escape is `SKIP_MOUNT_CHECK=1` in the pod env, only after `df -hT` confirms ~80 GB network FS.
- Success signal: the logs show the table with all `OK/downloaded/skipped` and `.manifest-rev` written. `pod-down` is run immediately after. Terminate, not stop (a stopped pod keeps billing disk; a CPU pod's container disk has no value). `HF_TOKEN` is rotated by Ken afterwards.
- Fallback if CPU stock vanishes: cheapest GPU pod at US-WA-1 (RTX 6000 Ada pod $0.99/hr, LOW stock) - needs Ken's ask.

### Account secrets vs plain env
R2 key id and secret as RunPod secrets (supported, see facts). `R2_ACCOUNT_ID` and `R2_BUCKET` are not sensitive: plain env. Tuning knobs (`JOB_TIMEOUT_S` etc.) are plain env, only rendered if set in `config.env`.

### scripts/smoke-job.sh
`scripts/smoke-job.sh [--mode t2v] [--prompt "..."] [--width 256 --height 256 --num-frames 25] [--expect-fail] [--no-r2-check]`
1. Reads `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` from `config.env` (same safe reader). `GET /health` first and prints worker counts.
2. `POST /run` with a tiny valid t2v input (defaults: 256x256 rounded to /64, 25 frames, 24 fps, fixed seed), prints the job id.
3. Polls `/status/<id>` every 5 s (server-side holds are an MCP feature; the script polls) up to 25 min, printing state transitions IN_QUEUE -> IN_PROGRESS -> COMPLETED/FAILED with elapsed wall time.
4. On COMPLETED prints: `delayTime` (queue + cold start), `executionTime`, handler `gen_time_s`, `cold`, `width/height/num_frames/fps/seed`, `key/thumb_key/meta_key`. Writes one line to `docs/validation/endpoint-timings.csv` (UTC time, job id, cold flag, delay, exec, gen_time, params) so cold vs warm is recorded and the README table can be filled from it.
5. R2 check (default on when `aws` CLI present, using `--endpoint-url https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com --region auto`): `head-object` for the three keys, download the mp4 to a temp dir, `ffprobe -show_streams` and report whether an audio stream exists and its duration, then delete the temp file. R2 credentials stay in the environment of that process only.
6. On FAILED prints the full raw `/status` JSON keys present (names only plus the `error` string) and states explicitly whether a separate `error_code` field is present or only the `[code]` prefix inside `error`. `--expect-fail` returns exit 0 when the job fails with the expected code.
It never prints the API key; the Authorization header is passed via `curl --config` on stdin.

### Real-GPU gating plan (Ken's decision 8)
Run order, each step ends with a stop-and-ask check. Endpoint `workers.max` is temporarily 1 for the gate (limits worst-case spend and avoids two cold workers); restore to 2 afterwards.

0. Preconditions (no cost): worker merged, CI green, GHCR package confirmed public (anonymous manifest fetch), tag pinned; `workflows/*.json` merged; volume populated and `download-models.sh --verify` OK; balance funded.
1. **Cold job, tiny t2v** (256x256, 25 frames). Record: queue delay + start (`delayTime`), wall time, `executionTime`, `cold:true`, worker logs (see below). Also record image pull/start time from the worker system logs.
2. **Model-load path evidence** (from worker logs `source=system` and app logs, read-only): int8-convrot transformer loaded through `UNETLoader` `default` with no "Unknown quantization format" error; `CLIPLoader` type `ltxv` accepted for the Gemma 4 int8-convrot encoder; the comfy-kitchen warning (if it appears) captured verbatim and classified (cosmetic vs fallback to a slow path); triton import worked; the 5.10.0 base's ComfyUI version recorded (0.34.0 expected) and whether LTX nodes resolve from core or from the node pack.
3. **Warm job, same tiny input** inside the idle window: record `gen_time_s`, `cold:false`, delay near zero.
4. **Default job: 1280x704, 121 frames, 24 fps, two-stage.** Record warm `gen_time_s`, peak VRAM (see Question 4), whether the encoder is evicted (a second warm default job shows whether reload cost reappears), output file size.
5. **Audio check:** `ffprobe` shows an audio stream with non-trivial duration (and a quick `volumedetect` mean/max to rule out silence).
6. **Real R2 upload:** the three objects exist, content types are `video/mp4`, `image/jpeg`, `application/json`, sidecar JSON parses and matches the returned fields.
7. **Real FAILED job:** `mode: i2v` with a non-existent `input_key` (`inputs/__smoke_missing__.png`) expecting `[input_fetch]`. Run it on the warm worker so it costs seconds, and record the exact `/status` JSON to settle whether `error_code` is exposed. Optional second failure (OOM at 2048x2048, ~481 frames) only if Ken asks, since it can run for minutes.
8. **Idle check:** after idle timeout confirm 0 running workers (`/health`), 5 minutes later no billing growth other than the volume.

**Stop-and-ask conditions** (do not work around; report evidence and ask, per decision 8 and SPEC 1a). Thresholds are proposals for Ken to set (Question 5):
- int8-convrot fails to load, produces a load error, or silently falls back to a path that is not int8 (bf16/GGUF fallbacks are forbidden).
- OOM or offload loop at the default clip (1280x704x121); peak VRAM > 46 GB.
- Cold start (delay + load) > 3 min (SPEC criterion 2: flag and propose mitigations, change nothing) or > 10 min (hard stop).
- Warm default-clip `gen_time_s` > 5 min (proposal).
- No audio stream, or silent audio.
- `/status` hides both `error_code` and the `[code]` prefix (contract assumption broken).
- The RTX 6000 Ada cannot be acquired (job IN_QUEUE with `throttled > 0` or `total: 0` for > 5 min): ask before widening the pool (MIG 48 GB) or moving to the L40S/EU-NL-1 fallback (which needs a new volume and a new 41 GB download).
- Any spend run past the worst-case figures in "Billable steps".

### Missing balance / payment method
No payment is linked and the account has $0 history. What the docs and reads say, and what is **unverified**:
- A pod create needs at least one hour of credit for that configuration: expect a create-time rejection (4xx with an insufficient-balance style message) on `pod-up`. A volume create is documented as refused for low balance. Both surface synchronously as an HTTP error from `apply.sh`, which will print the status and the redacted body and stop.
- Serverless: endpoint creation may succeed with no balance; the symptom would then be jobs staying `IN_QUEUE` with `workers` never becoming ready (`/health` shows no running workers) rather than an error on submit. This is my inference, not verified. `apply.sh preflight` therefore asks Ken to confirm the balance in the console first (REST v2 has no balance route).
- At $0 running pods stop; pods with a network volume keep their data; volumes keep accruing and can be deleted if unpaid. Recommendation: fund at least ~$15, set a low-balance notification, and do not leave a volume on an unfunded account.

## Decisions

### One-way doors
1. **Network volume: US-WA-1, STANDARD tier, 80 GB.** Data center and tier are immutable; size can only grow; deleting loses 41 GB and costs a re-download plus Ken's HF token again. Already decided by Ken; flagged because US-WA-1 stock for the pinned GPU is LOW (see risks). Moving later = new volume + new pod run + endpoint repoint.
2. **Endpoint type = QUEUE** (immutable). The handler contract (`/run`, `/status`) requires it. Low regret.
3. **Secret names `ltx_r2_access_key_id` / `ltx_r2_secret_access_key`** (immutable names; referenced from the endpoint). Changing = new secrets plus endpoint env update. Low cost, but treat as fixed.
4. **Volume mounted at `/runpod-volume` on the temp pod** so the layout is identical to the worker's view (the models note's `VOLUME_ROOT` default). The path can change later per pod, but the layout on the volume is the contract.
5. **Never auto-delete the volume or secrets** (design rule, enforced by having no code for it). Deletion is irreversible.
6. **Reproducibility mechanism = bash + REST v2** instead of Terraform. Reversible in principle (state is only the two IDs in `config.env`), classified one-way only because the rest of the repo (README, Makefile targets, ui) will call `apply.sh`.
7. **GPU choice and DC (decision 9)**: carried over, with the evidence that stock is LOW.

### Two-way doors
- Endpoint pinned by `excludedTypes` (can be loosened with an update; the update must resend `pools` and `excludedTypes` together or the exclusions are cleared).
- `idleTimeout` 60 s, `workers.max` 2, scaler `QUEUE_DELAY` 4 s, FlashBoot on, container disk size: all `PATCH`able. Idle timeout above 60 s needs Ken's ask.
- Image tag: `sha-<short>` only; bumping is a new release (workers replaced), instant to revert by setting the previous tag.
- Execution `timeout` 900 000 ms: two-way, verify unit by read-back.
- Pod type (cpu3c 2 vCPU) and the pod image tag.
- Plain env vs secret for `R2_ACCOUNT_ID` / `R2_BUCKET` (plain).
- Polling interval, CSV log format of the smoke runner.

## Questions for Ken
1. **Image pin blocker.** `main` has no worker and no CI run, so there is no `sha-<short>` tag. May the coordinator merge `feat/worker` (and `feat/workflows`, `feat/models`, `docs/spec-reconcile`) first, wait for the build-worker run, then confirm the GHCR package is public before any endpoint is created? Recommendation: yes; nothing billable beyond the volume needs the image.
2. **Stock is LOW, not MEDIUM.** RTX 6000 Ada at US-WA-1 is `LOW` today (one GPU type, one data center). Options: (a) proceed and accept possible waits/throttling on cold starts (recommended for the gate; costs nothing extra); (b) also allow the `PRO 6000 MIG 2g.48gb` slice (same $1.75/hr, `MEDIUM` overall, `LOW` at US-WA-1) but it is untested for int8-convrot on Blackwell/CUDA 13.2; (c) move to the L40S / EU-NL-1 fallback now (needs a new volume and a download; L40S there is not currently listed with availability in EU-NL-1 in this read). Which?
3. **Pin to RTX 6000 Ada only** by excluding `NVIDIA L40`, `NVIDIA L40S` and the `MIG 2g.48gb` type from the shared `ADA_48_PRO` pool (L40/L40S are not at US-WA-1 anyway). OK to exclude the MIG type as well? Recommendation: yes for the gate.
4. **Peak VRAM measurement.** Serverless gives no shell, and the handler does not report VRAM. Options: (a) a small worker change: sample `nvidia-smi --query-gpu=memory.used` in a thread during the run and return/log `peak_vram_mb` (rebuilds the image, new sha tag, ~minutes of review); (b) run the same image on a RTX 6000 Ada pod at US-WA-1 ($0.99/hr) and watch with `nvidia-smi` through logs (also no shell via MCP); (c) read ComfyUI's own log lines only (approximate). Recommendation: (a), because it also lands `peak_vram_mb` in the sidecar JSON for the UI cost features.
5. **Gate thresholds (decision 8 says "pass/fail thresholds not yet set").** Proposed: pass if int8-convrot loads on the 5.10.0 base, default 1280x704x121 clip completes without OOM with peak VRAM <= 46 GB, warm `gen_time_s` <= 300 s, cold start <= 180 s (flag only) / 600 s (hard stop), audio present. OK, or what numbers?
6. **Payment and balance.** No payment method is linked. Please add one and fund about $15, enable a low-balance notification, and confirm the balance in the console before the coordinator starts (REST v2 cannot read it). Is $15 OK as the first-run ceiling (worst case below ~$14)?
7. **Idle timeout** stays 60 s per your decision; the cold/warm numbers from the gate will be the evidence if you later want to raise it (I will not raise it without asking).
8. **Execution timeout unit.** The v2 schema defaults `timeout` to 300000 (ms) while docs prose says seconds. I will set 900000 and verify by read-back; if it reads as 900000 seconds, a lower real value will be applied. No action needed unless you want a shorter cap than 900 s (e.g. 800 s).
9. **Model-download pod:** CPU `cpu3c` 2 vCPU at US-WA-1 (HIGH stock, ~$0.06/hr). If it is unavailable at create time, may the coordinator use the RTX 6000 Ada pod ($0.99/hr, LOW stock) or should it stop and ask? Recommendation: stop and ask.

## Concerns / risks
- **Stock LOW** at the only viable DC for the standard-volume + RTX 6000 Ada combination: cold-start queueing and `throttled` workers are plausible; FlashBoot snapshots are host-scoped and traffic is bursty, so expect misses.
- **Image size 24.75 GB** (worker validation note): first pull on a new host is long; RunPod docs say image pull is not billed, worker start (model load) is. Container disk (20 GB default in the template) must cover handler temp files; if the image layer plus temp exceeds it the worker fails: confirm disk requirement from the first worker's logs, and raise `disk` if needed.
- **Crash loop billing:** a flapping worker bills while it starts. Mitigation: gate with `workers.max=1`, check `/health` and worker system logs after each submit, do not wait past 3 holds.
- **`error_code` visibility** unverified; contract encodes `[code]` in `error` as a safeguard.
- **Idle endpoint rule** reduces `workers.max` after 3 and 7 days without requests (to 2, then 0). `status` warns; the ui feature should surface a hint if jobs return `ENDPOINT_PAUSED`-like 409s.
- **Secret rotation** only reaches workers at next boot; `apply.sh secrets --rotate` prints that.
- **`set max workers to 0` pauses the endpoint** (`/run` returns 409 ENDPOINT_PAUSED); do not use it as a "drain" while jobs are being submitted. Model-bump procedure from the models note (max workers 0, prune, download, verify, restore) therefore needs the UI to be idle.
- **Pod CUDA / mount quirks:** `mountpoint -q` on a RunPod network mount is untested; `SKIP_MOUNT_CHECK=1` is the escape after `df -hT`.
- **Token exposure:** `HF_TOKEN` is a pod env var visible in that pod's console; read-only token, rotate after. The R2 values pass through the script's stdin to `create-secret` once and are never stored by the script.
- **GHCR public check** is anonymous and cheap, but visibility of a package is a manual step in GitHub settings.
- Terraform provider status inferred from limited search results (no Registry listing found); revisit only if a maintained provider with endpoint and volume resources appears.

## How the validator should test this
No-cost tests (no RunPod writes):
- `shellcheck` and `bash -n` on `apply.sh`, `lib.sh`, `scripts/smoke-job.sh`.
- Run `apply.sh --dry-run` for every subcommand with a fake `curl` shim (PATH override) that records requests to a fixture directory and returns canned JSON: assert exact method, path and body for create/patch; assert no write is issued under `--dry-run` or `preflight`/`status`.
- Idempotency: second run with the fake API returning the resources created by the first produces zero writes; diff of a changed image tag produces exactly one PATCH containing only `image`; shrink request for the volume is refused.
- Secrets hygiene: set sentinel values for `RUNPOD_API_KEY`, `HF_TOKEN`, `R2_SECRET_ACCESS_KEY`, run with `bash -x` and with normal output and with forced API errors; grep stdout, stderr, any log or temp file, and the shim's recorded argv for the sentinels: none may appear in argv or output (they may appear in the recorded request bodies sent over stdin). Script refuses to run under `-x`.
- `config.env` reader: malformed line, `$(...)`, backticks, quotes and spaces in values do not execute or leak; unknown keys ignored; ID write-back changes only the two ID lines and preserves file mode (0600) and other lines.
- Template checks: rendered endpoint body contains `{{ RUNPOD_SECRET_ltx_r2_access_key_id }}` literals and no secret values; `image` rejects `latest`, a bare tag, and a digest-less non-`sha-` tag; `gpu.excludedTypes` and `pools` are always sent together; `mounts.network` uses the volume id from config.
- Teardown: `pod-down` with two pods in the fake API deletes only the exact-named one; there is no `volume-delete` code path (grep).
- `smoke-job.sh` against a mock HTTP server that plays IN_QUEUE -> IN_PROGRESS -> COMPLETED and FAILED variants (with and without `error_code`): output lists timings and keys, CSV row appended, FAILED prints whether `error_code` exists, exit codes correct, API key never printed.
- Tool-schema conformance: validate rendered bodies against the `create-endpoint` and `create-pod` input schemas read via `describe-tool` (field names, enums, `timeout` integer, `idleTimeout` 1-3600).

Billable, run only by the coordinator after Ken's approval and the quote below: the live sequence in "Billable steps" with the read-back assertions after each step, then the gate in this note.

## Billable steps
Prices are from today's reads: serverless RTX 6000 Ada $1.75/hr ($0.000486/s); network volume $0.07/GB/month; CPU pod cpu3c secure $0.03 per vCPU-hr (2 vCPU = $0.06/hr); RTX 6000 Ada pod secure $0.99/hr; container disk ~$0.10/GB/month (serverless, 5-minute billing). Image pull is not billed; worker start (model load), execution and the idle timeout are.

| # | Action (in order) | Rate | Expected | Worst case |
|---|---|---|---|---|
| 0 | Ken adds a payment method and funds balance (~$15) | - | - | - |
| 1 | Create network volume, 80 GB STANDARD, US-WA-1 | $0.07/GB/mo = **$5.60/mo** ($0.0078/hr), accrues until deleted | $5.60 for the first month | $5.60 |
| 2 | Create 2 account secrets | free | $0 | $0 |
| 3 | Create temp CPU pod cpu3c 2 vCPU at US-WA-1, run download (41.43 GB) + verify, terminate | **$0.06/hr** (cpu3g $0.08/hr) + small container disk | 20-40 min = $0.02-$0.04 | 1 h cap = $0.08 (CPU) or $0.99 (GPU pod fallback, only with Ken's ask) |
| 4 | Create serverless endpoint (min 0, max 1 for the gate) | **$0 idle**, $1.75/hr per running worker | $0 | $0 |
| 5 | Gate job 1: cold tiny t2v | $1.75/hr | ~6-10 min of billed worker time (start + run + 60 s idle) = $0.17-$0.29 | 10 min start + 13 min run + 1 min idle = 24 min = **$0.70** |
| 6 | Gate job 2: warm tiny t2v | $1.75/hr | ~3 min = $0.09 | 14 min = $0.41 |
| 7 | Gate job 3: warm default 1280x704x121 | $1.75/hr | ~5-8 min = $0.15-$0.23 | 14 min = $0.41 |
| 8 | Gate job 4: second default job (encoder reload / audio re-check) | $1.75/hr | ~$0.20 | $0.41 |
| 9 | Gate job 5: forced FAILED job (missing input key) | $1.75/hr | seconds, within the warm worker | $0.05 (cold worker: up to $0.70) |
| 10 | Raise max workers to 2, leave endpoint idle | $0 idle | $0 | $0 |
| 11 | Standing cost after the run | volume only | **$5.60/mo** | - |

Gate subtotal: expected about $0.8-$1.2; worst case about $2.4 with one worker (steps 5-9 at their worst), $4.7 if a second worker is allowed to cold start in parallel (max 2) or a crash loop doubles the start time.

**Worst-case spend for the whole first run:** volume $5.60 (one month) + GPU pod fallback $0.99 + gate with two workers $4.67 + one full repeat of the gate after a worker fix $2.33 = about **$13.6**. Expected: about **$7** ($5.60 volume + roughly $1 gate + pennies for the pod). The endpoint's `workers.max` and the per-step caps above are the guardrails; the coordinator should stop at the first stop-and-ask condition rather than retry.

## Ken's decisions and corrections (2026-10-29, after the architect pass)

Where this section conflicts with the text above, this section wins.

- **Q1 image pin is resolved; the "no image tag" problem was a stale-base artefact.** All four PRs (#1-#4) are merged on `main` and the `build-worker` run 40860444812 succeeded. The image to pin is **`ghcr.io/ken-ck-yu/ltx25-worker:sha-f637c09`** (digest `sha256:b027d845f84cde4504357bfd8241351c71fab9bc46ef26c56819e2668e2f83f0`, same as `latest`, checked anonymously, so the package is public). `apply.sh` must still reject `latest` and anything not matching `^sha-[0-9a-f]{7,}$`. This branch is rebased on the merged `main`.
- **Q2:** proceed with the RTX 6000 Ada only and accept the LOW stock for the gate (option a). No L40S / EU-NL-1 move now.
- **Q3:** exclude `NVIDIA L40`, `NVIDIA L40S` and the `MIG 2g.48gb` type from the pool for the gate.
- **Q4:** option (a): add `peak_vram_mb` to the handler output and sidecar JSON by sampling `nvidia-smi --query-gpu=memory.used` in a thread during the run (small worker change with a unit test; rebuilds the image, so the endpoint must then pin the NEW `sha-<short>` tag from the build of the merge of this change; the engineer states this in the README and apply.sh reads the tag from config.env, never hardcoded).
- **Q5 thresholds** (provisional, they only trigger "stop and ask Ken", never an automatic spend): pass if int8-convrot loads on the 5.10.0 base, the default 1280x704x121 clip completes without OOM with peak VRAM <= 46 GB, warm `gen_time_s` <= 300 s, cold start <= 180 s (flag only) / 600 s (hard stop), audio present.
- **Q6 (balance): still pending from Ken.** No payment method was linked and no balance confirmed as of this note. The coordinator makes NO billable call until Ken confirms a payment method and funding (about $15 is the proposed first-run ceiling; worst case about $13.6).
- **Q7, Q8** as the architect proposed (idle 60 s; set timeout 900000 and verify by read-back, the handler's own JOB_TIMEOUT_S 780 s stays inside it). **Q9:** if the CPU pod is unavailable, stop and ask.
- The FP8 comparison and the model-download of any extra files are NOT part of this feature unless Ken asks.
- Stock fluctuates (US-WA-1 RTX 6000 Ada read as MEDIUM earlier today and LOW in the architect's read); the coordinator re-reads capacity immediately before each billable step and states it.

## Reviewer

Independent review, 2026-10-29, read-only. Calls made: `describe-tool` (create-endpoint, create-pod), `get-gpu-type` (RTX 6000 Ada with serverless availability; the MIG 48 GB type), `list-data-centers` (STANDARD volume DCs in North America), `lookup-concept` (network volume), `search-docs` (endpoint settings, worker lifecycle, FlashBoot, secrets, global volumes, troubleshooting, pod mount paths), one web search (Terraform provider; found nothing, so the architect's conclusion is neither confirmed nor contradicted by me). Nothing was created or changed on RunPod or Cloudflare. Ken's decisions section is treated as binding.

### Summary
The design is sound and the doors are mostly correctly classified. I found six things the architect missed or got wrong, three of which change the plan: (1) **the 900 s "platform limit" is not a platform limit** (docs: execution timeout range 5 s to 7 days; 900 s is our own choice), so `PLATFORM_LIMIT_S` in the handler and the SPEC wording are assumptions, not facts; (2) **the handler cannot tell an unresolved `{{ RUNPOD_SECRET_... }}` literal from a real key** (`check_r2_env` only tests non-empty), so a mis-substituted secret would be discovered only after a full generation, at upload; the fix is free: run the missing-input failure job FIRST as a canary; (3) **the model load happens inside the first job**, so the cold-start cost counts against the 780 s `JOB_TIMEOUT_S` and the 900 s execution timeout, and a real first-after-idle job at the default clip may time out, which the gate does not test. Also: the architect's "only US-WA-1 works with a standard volume" is stale (live read shows RTX 6000 Ada serverless stock at US-CA-2, US-IL-1, US-KS-2 and US-WA-1, all LOW; US-IL-1 and US-KS-2 offer STANDARD volumes); the worst-case arithmetic has an internal inconsistency; and `git clone` of the repo HEAD on the temp pod is not pinned.

### Facts verified (and corrections)
| Item | Finding |
|---|---|
| Execution timeout unit | REST v2 create response schema says "Per-request execution timeout in milliseconds"; the concept doc prose says "timeout 300 seconds" for the same default (300000), so it is ms and the prose is loose. The docs give the allowed range as 5 s to 7 days (console default 600 s). 900000 read as seconds would be ~10.4 days, beyond 7 days, so a wrong unit would most likely be rejected rather than silently accepted, but read-back remains mandatory. **900 s is not a platform limit.** A per-request `executionTimeout` in the job policy can also override it. |
| `pools` + `excludedTypes` | Schema confirms: workers run on every type in `pools` except `excludedTypes`; a value outside `pools` is rejected; on update `pools` and `excludedTypes` are replaced together (sending `pools` alone clears the exclusions). Pool of RTX 6000 Ada and the MIG type is `ADA_48_PRO` (both re-read). Matches the architect. `dataCenterIds` is documented as "preferred data centers for placement"; the volume mount is what actually binds the endpoint to US-WA-1. |
| Secret substitution | Docs concept: set an env value to `{{ RUNPOD_SECRET_<name> }}` on a pod, endpoint or template; value substituted at boot; never returned by API or console. Documented, not live-verified. No free way to verify before a worker boots; see canary below. |
| Mount paths | `create-pod` network mount `path` is required and has no default; custom paths are honoured on GPU and CPU pods. `/workspace` is the console/convention default on pods; serverless always `/runpod-volume`. Architect correct. The model script falls back to `/workspace` if `/runpod-volume` is absent, and its `mountpoint -q` check guards against writing to container disk. The mount is a FUSE network mount (MooseFS) per a RunPod golden path, so `mountpoint` should work and `flock` may not (the script has `--no-lock`). |
| FlashBoot | Snapshot is host-scoped and image-scoped; low-volume bursty endpoints often miss; it only preserves state present in the worker process at scale-down. Here ComfyUI is a separate process that loads models on first `/prompt`, so treat FlashBoot as a possible bonus only. REST default is OFF so it must be set (architect right). No extra cost. |
| Network volume and availability | Docs: a network volume restricts the endpoint to the volume's data center; blog notes that this can raise queueing at constrained capacity. Throttled workers are not billed (state table: Throttled, not billed); the job just waits IN_QUEUE. Async job TTL default 24 h; async results retained 30 min after completion. |
| Billing | Billed from when the handler starts loading until scale-down, including idle timeout. Image pull normally happens while scaled down, unbilled, but a pull during cold start is billed. Unhealthy workers are not billed; repeated unhealthy workers make RunPod scale the endpoint down automatically with an email. Init timeout: a worker whose cold start exceeds 7 min is marked unhealthy (`RUNPOD_INIT_TIMEOUT`); in this design the handler registers early and models load later, so this should not trigger, but a slow ComfyUI boot is the one thing it would catch. |
| Queue vs load balancing | LB endpoints: 5.5 min processing timeout, 30 MB payload, worker must run its own HTTP server. The handler uses `runpod.serverless.start`, so QUEUE is the only fit. |
| Global volume (new option) | Beta. No data center, mounts at `/runpod-volume` on serverless, one per endpoint, mutually exclusive with a network volume, object-storage backed, "not a replacement for high-performance regional storage". Price not read by me. |
| Stock | Re-read now: RTX 6000 Ada serverless LOW overall and LOW at US-CA-2, US-IL-1, US-KS-2, US-WA-1. CUDA 13.2 only. The architect listed two DCs; four are listed now. |

### Door 1: Network volume, US-WA-1, STANDARD, 80 GB. **AGREE WITH CHANGES**
Restated: DC and tier immutable, size grow-only, delete irreversible, $5.60/mo.
Alternatives steelmanned:
- *Global volume* removes the DC pin and so the LOW-stock coupling (every DC with the GPU becomes usable). Against: beta, object-storage backed, unknown price, and the bottleneck here is a 37 GB sequential read on every cold start, which object storage may serve more slowly or less predictably than the regional FUSE volume. It is also exclusive with a network volume, and the models would have to be re-downloaded. Not recommended now; worth one timed experiment later if cold start or stock hurts (a two-way door as long as the 41 GB download script stays reusable).
- *Second STANDARD volume at US-IL-1 or US-KS-2* (serverless supports at most one volume per DC, each worker gets the one in its DC). Widens the pool across more LOW-stock DCs. Cost +$5.60/mo and another 41 GB download; violates priority 2 for an unproven benefit. Defer until the gate shows throttling is real.
- *HIGH_PERFORMANCE tier* (up to 3x throughput): not offered at US-WA-1; US-CA-2 has it but RTX 6000 Ada there is LOW as well. Throughput would help the cold read, but I cannot price it from the reads I made. Not a reason to change the DC.
- *Smaller size* (about 64 GB covers 41.43 GB plus slack and the 8.9 GB LoRA marginally; saves about $1.1/mo). Size can grow later but never shrink, so 80 GB is the irreversible direction. SPEC §2 fixes 80 GB and the saving is small; I do not dissent, but the note should say "80 GB is the one-way direction on size".
Changes: (a) drop the claim that US-WA-1 is the only place that works; record the four-DC read. The DC choice stands because all four read LOW and US-WA-1 is already Ken's decision with a known fallback. (b) The architect's "volume create is documented as refused for low balance" and balance-zero deletion mean the volume can be removed by the platform if the balance sits at $0 (concept rule `network-volume.low-balance-deletion`), so "never auto-delete" is not fully in our control: the low-balance notification and funding are part of this door, not an optional extra. (c) Size the first-run ceiling against hourly accrual, not a prepaid month (see arithmetic).

### Door 2: Endpoint type QUEUE. **AGREE**
LB steelmanned and rejected on evidence above (5.5 min processing cap, 30 MB payload, would require rewriting the handler as an HTTP server). Add one operational rule: the UI and smoke script must use `/run` + `/status` only; `/runsync` sits behind an edge timeout (~100 s per a RunPod golden path) and a cold start would 524.

### Door 3: Secret names `ltx_r2_access_key_id` / `ltx_r2_secret_access_key`. **AGREE WITH CHANGES**
Alternative: plain env on the endpoint (visible in `get-endpoint` and the console, so strictly worse), or one secret holding both values (not supported; one value per secret). Secret refs are right. Changes:
1. **Canary job first.** `handler.check_r2_env` accepts any non-empty string, so an unresolved `{{ RUNPOD_SECRET_... }}` passes and the failure appears at upload after a full generation (and `upload_failed` after paying for it). In `run_job` the input fetch happens before `wait_for_comfy`, so a missing-input i2v job never loads models. Run the planned `[input_fetch]` failure job as the FIRST gate job on the fresh cold worker. Expected with good secrets: `[input_fetch] input not found: inputs/__smoke_missing__.png`. If secrets did not resolve: `could not fetch input: <403/InvalidAccessKeyId/...>`. Cost is worker boot plus idle only (about $0.05 to $0.15), it settles the `error_code` question, measures real worker boot, and proves R2 read. The write permission is still proven only later, so create the R2 API token with Object Read & Write scoped to the single bucket `jubividia-ltx-eu`, not account-wide.
2. Secret values are write-only: Ken keeps his own copy; rotating means `update-secret` then a worker restart (new boot). Say so in the README.
3. Visibility: the endpoint config holds only the literal; the substituted value lives in the worker process environment. I found no handler path that logs env. The coordinator should still grep the first worker's system and app logs for the key id prefix and for the string `R2_SECRET` before declaring clean. I could not verify the base image's `start.sh` does not dump env (it was not in my reads).
4. The `{{ RUNPOD_SECRET_ltx_r2_access_key_id }}` name has no leading `RUNPOD` problem (the restriction is on the secret's own name, which is fine).

### Door 4: Temp CPU pod, volume at `/runpod-volume`. **AGREE WITH CHANGES**
Mount-path facts confirmed (explicit path required; custom path honoured). Alternative: mount at `/workspace` (RunPod convention, the script's own fallback). Using `/runpod-volume` is the safer contract because the same tree is then visible exactly as the worker will see it, and a typo would fail the `mountpoint` check rather than silently write to container disk. Agreed. Changes:
1. **Pin the clone.** `git clone --depth 1 https://github.com/ken-ck-yu/jubividia` takes whatever `main` is at pod time; the script and `models.lock` then differ run to run. Clone and `git checkout <sha>` (a config value, recorded in `.runpod-state`), or pass the commit through an env var. This is a reproducibility hole against SPEC priority 4 and also a supply-chain exposure for a pod that holds an HF token.
2. **HF_TOKEN exposure.** A literal `HF_TOKEN` in the create-pod body is part of the pod's configuration and is likely returned by `get-pod` / shown in the console (not verified; the coordinator should check with one redacted `get-pod` read). Safer: store it as a temporary RunPod secret and pass `{{ RUNPOD_SECRET_hf_token_tmp }}`, then delete that temporary secret after pod-down. That is a deliberate exception to "never auto-delete secrets" (which should be scoped to the two R2 secrets and the volume). The token is read-only, which limits the damage; Ken rotates it afterwards, as planned.
3. The `sleep infinity` tail keeps billing at about $0.06/h if the coordinator forgets `pod-down`. Cheap, but make `pod-up` print a prominent "terminate me" line and have the coordinator read `list-pods` after.
4. cpu3c 2 vCPU 4 GB RAM: adequate. `flock` on the FUSE mount may fail; `--no-lock` escape exists. Estimated 41.43 GB at the observed hosts' throughput is plausibly 10 to 25 minutes; the $0.08 cap (1 h) is sound.

### Door 5: Never auto-delete volume or secrets. **AGREE**
Correct as a code rule. Note two limits: platform-side deletion at $0 balance (above), and `teardown-endpoint` is two-way (endpoint is config only), fine. Scope the rule as in Door 4 item 2. A grep test for "no delete of volume" is good; extend it to "no `DELETE` against `/network-volumes` or `/secrets` paths in `apply.sh` or `lib.sh`".

### Door 6: Bash + REST v2 instead of Terraform. **AGREE WITH CHANGES**
Alternatives: official `runpodctl` scripts (maintained, but its create paths still go through GraphQL for some fields, and v2-only fields like `excludedTypes` and `mounts` may lag); a documented MCP runbook with no code (lowest effort, weakest reproducibility); the Flash/SDK (`rp flash`) code-first route, which creates its own resources and conflicts with an explicit Dockerfile image; a third-party Pulumi provider (separate stack). I could not confirm or refute the architect's Terraform finding with my search. Given SPEC §4.4 says "prefer Terraform if a maintained provider exists; otherwise a script", the script is within the spec. Changes:
1. Make `apply.sh` fail closed on the three REST surprises that cost money: `flashboot` defaults to OFF (must be sent), `idleTimeout` is rejected with `REQUEST_COUNT` scaling, and a PATCH that sends `pools` without `excludedTypes` clears the exclusions. The architect names two of these; add tests for all three.
2. **Idempotency and half-created resources.** Volume names are not unique (`network-volume` field note), so name matching can pick the wrong one or the wrong number; require DC+type+name and stop on more than one (architect already says this). If the volume create succeeds but the config.env write-back fails (disk, permission), the next run must re-find it by exact name and then write back; add a test that kills the script between create and write-back. Same for the endpoint: create is not idempotent (not `idempotentHint`), so look up by name first, and write the id to a state file BEFORE any follow-up PATCH.
3. **Rollback if create succeeds but read-back differs.** Do not auto-delete. Because the endpoint is at min 0 it costs $0 idle, so the safe action is: leave it, set `workers.max=0` only if a worker is actually running, print the diff, and PATCH the single differing field. `type` and the volume mount are the only things that force delete-and-recreate; an endpoint delete is two-way (config only), so that manual step is acceptable, but it must be Ken's or the coordinator's explicit call and never in `apply.sh`.
4. Classify the door as one-way only for README/Makefile coupling, as the architect did; I agree.

### Door 7: GPU / DC carried over from decision 9. **AGREE (nothing to decide)**
Carried over as Ken's decision. Evidence refreshed above: four DCs list the GPU, all LOW; MIG 48 GB is $1.75/h serverless in the same pool, so excluding it costs nothing now and loses one fallback; fine for the gate since it was Ken's call (Q3).

### Two-way doors that are really one-way (or behave like it)
- **`type: QUEUE`, `dataCenterIds` effect, volume mount on the endpoint** are create-time facts. A mount change on an existing endpoint is allowed per schema (a present list replaces the old one), but treat the DC and type as fixed.
- **Image tag** is two-way, but the *secret environment* is not instant: env or image change creates a new release and replaces workers, so a bad tag can mean a billed crash loop before anyone notices. Keep the gate habit "check `/health` and worker system logs after every release".
- **The 900 s execution timeout** is two-way, but the handler's `PLATFORM_LIMIT_S = 900` is hardcoded. If Ken ever raises the endpoint timeout, the handler silently keeps its 885 s upload deadline. Either read it from an env var or document it next to `RUNPOD_EXEC_TIMEOUT_MS`.
- **`workers.max=0` as a drain** pauses the endpoint (409) and the 3-day/7-day idle rules also reduce max workers; with a once-a-week personal usage pattern the endpoint WILL hit the 3-day reduction to 2 and, after a quiet week, the 7-day set to 0. The UI feature needs a clear error and the `status` command must be the documented recovery. This is an expected state for this project, not an edge case.

### Failures the architect missed
1. **Cold start is inside the job.** Models load on the first `/prompt`, inside `wait_for_result`, so the load counts against `JOB_TIMEOUT_S` (780 s) and the execution timeout. If a 37 GB read from the FUSE volume plus ComfyUI quantised-model init takes N minutes, a first-after-idle default clip needs N + generation time under 780 s. The gate measures cold with a tiny clip and warm with a default clip and never the user's real path (cold + default). Add one cold default-clip job (scale to zero by waiting out the idle window; about $0.4 to $0.7). Stop and ask if cold-tiny delay + exec + warm-default gen_time exceeds about 700 s.
2. **`cold` flag semantics.** `_first_job` is a per-process flag. After a FlashBoot restore or if the handler process survives and ComfyUI evicts the models, `cold:false` can coexist with a multi-minute reload. Judge cold vs warm by `delayTime` and `gen_time_s` comparison, not by the flag alone; the CSV should record both.
3. **Idle workers and billing.** Idle timeout 60 s means every job with a gap over 60 s is cold, and with expected 40 clips/month, almost all are. Cost per clip is therefore cold-dominated: if cold is 5 min and generation 5 min, that is about 10 min = $0.29/clip versus SPEC's 3-minute example ($0.09). This does not break priority 1 or 2 but breaks the SPEC §7 estimate; the README cost table must use measured numbers. Raising `idleTimeout` is Ken's call, as decided.
4. **LOW stock queueing with no worker.** Throttled workers are free but the job waits; async results expire 30 min after completion and the default TTL is 24 h, so a user closing the phone tab loses the result pointer only after completion. The UI feature should submit with an explicit `ttl` and store job ids. For the gate, "IN_QUEUE with `throttled>0` for >5 min" is a good stop rule; keep it.
5. **Worker crash loops.** Unhealthy workers are not billed, but a worker that starts and fails inside the handler (e.g. ComfyUI dies, `comfy_unavailable`) is billed while running; and repeated failures trigger an automatic scale-down with an email, which would present as `workers.max` unexpectedly reduced. Add to stop conditions: any worker listed Unhealthy, or two worker restarts, or an IN_PROGRESS job past 15 min.
6. **CUDA 13.2 only.** The only host CUDA with capacity is 13.2 and the image is built on 12.8 (`minCudaVersion: "12.8"` is a floor, so 13.2 qualifies). The architect saw this; I add that PyTorch cu128 wheels do run on newer drivers (forward compatible), but triton/int8 kernel behaviour on a 13.2 host driver is part of what the gate must record (driver and CUDA version from worker logs).
7. **First-job image pull billing.** If a worker starts before its image is on the host, the 24.75 GB pull happens during cold start and is billed. For the very first job the first worker likely pays this (the architect's $0.70 worst case covers it); expect the first cold number to be an outlier and do not use it alone for the 180 s criterion. Record the second cold start (after idle) separately.
8. **Unpinned pod clone and literal HF token**: see Door 4.
9. **Secret canary**: see Door 3.

### Gate thresholds
- int8 loads / no OOM / audio present: agree.
- **Peak VRAM <= 46 GB**: `nvidia-smi memory.used` includes PyTorch's caching allocator reserve, so it tends toward the card's capacity even when the model would fit (the card is 48 GB, about 49,140 MiB). A reading above 46 GB is therefore a weak signal. Keep it as a "report and ask" number but do not treat it as a pass/fail on its own. The decisive signals are: no OOM; no offload; and the second warm default job's `gen_time_s` within about 10% of the first (no eviction reload). Sample peak with the thread at 1 s intervals and record it.
- **Warm gen_time <= 300 s**: acceptable as the stop line. For cost-model honesty, flag (not stop) above 180 s, since SPEC §7 assumes about 3 min total per clip including cold.
- **Cold <= 180 s flag / 600 s hard**: agree on 180 s as SPEC 6.2. Define it concretely as `delayTime + executionTime` of the first tiny job minus its generation time, from a worker that is not on its first-ever image pull. For the 600 s hard stop, apply it to the sum in item 1 above rather than the tiny job alone, because the user path is cold + default.
- Add: any worker enters Unhealthy; IN_PROGRESS past 15 min; `error_code` missing (already there).
- Order change: canary failure job first (cheap), then cold tiny, warm tiny, warm default, second default, cold default (new), audio/R2 checks on the ones already run. Moves the cheapest checks earlier and gives an early abort for a bad secret, bad image or dead ComfyUI.

### Worst-case spend arithmetic
- 24 min at $1.75/h = $0.70 (correct). 14 min = $0.41 (correct). Steps 5 to 9 one worker worst: 0.70 + 0.41 + 0.41 + 0.41 + 0.05 = **$1.98**, not "about $2.4"; with the failure job on a cold worker at $0.70 it is $2.63. The note's $2.4 matches neither. The later figures ($4.67, $2.33) are consistent with each other (2 x 2.33 and 80 min x $0.0292) but not with the table above; they are therefore a loose upper bound, not a derived one. Total 5.60 + 0.99 + 4.67 + 2.33 = $13.59, arithmetically correct as stated, though conservative.
- **The volume line is overstated and mis-framed**: storage is billed hourly from creation (about $0.0078/h), not $5.60 prepaid; the first-run balance need is the hours elapsed (pennies to a few dollars over days), while the *monthly standing cost* is $5.60. This inflates the "worst case" by about $5 and hides the fact that the balance must stay funded afterwards or the volume is at risk.
- **Missing from the worst case**: the cold default job I recommend (about $0.7 worst); a tolerated first-ever image pull billed (inside the 24 min figure); ~$0.10 per cold worker boot per aborted job; container disk (20 GB, a few cents); the endpoint's possible auto-restart; and the unit risk on `timeout` (if somehow read as seconds a hung job could run for days, which is why read-back right after create and before any job is mandatory). With these, a safe quote is: expected about $2 variable for the gate, worst case about $5 to $6 variable with a single worker and one rebuild-and-repeat, plus volume accrual. A $15 ceiling is adequate; I would not go below it, since a pod create needs about one hour of credit and a funded margin matters for the volume.

### New questions for Ken
1. **Gate order**: OK to run the cheap missing-input failure job FIRST as the secret/R2 canary (recommended), and to add one cold default-clip job at the end (about $0.4 to $0.7)?
2. **Timeout**: the 900 s execution timeout is a choice, not a platform cap (docs: up to 7 days). Keep 900 s (recommended for spend safety) and treat the SPEC wording as wrong, or do you want a higher cap if the cold default job needs it?
3. **HF token on the pod**: OK to pass it as a temporary RunPod secret and delete that one secret afterwards (exception to "never delete secrets", scoped to the temp one), or keep a plain literal env and rotate after?
4. **Clone pin**: OK to pin the pod's clone to an explicit commit sha from `config.env` (recommended)?
5. **Stock hedge**: record US-IL-1 and US-KS-2 as other STANDARD-volume DCs that list the GPU (all LOW now). Do you want a second volume only after the gate shows real throttling (recommended), and is a global-volume timing experiment of interest later?
6. **VRAM pass line**: accept "no OOM, no offload, second warm default job within 10% of the first" as the pass test, with 46 GB as a report-only number?

## Ken's decisions, round 2 (2026-10-29, answers to the reviewer's questions)

These win over everything above, including the earlier "Ken's decisions and corrections" section.

1. **Gate order:** yes. The cheap missing-input failure job runs FIRST as the secret/R2 canary, and one cold default-size clip job is added at the end of the gate (about $0.4-0.7).
2. **Timeout:** keep 900 s execution timeout as a spend-safety choice. RunPod's real range is 5 s to 7 days; the `timeout` field is in milliseconds; read-back is mandatory. SPEC and README wording that calls 900 s a platform limit is corrected (SPEC edit limited to that wording). `handler.PLATFORM_LIMIT_S` becomes a documented constant tied to the chosen execution timeout.
3. **HF token on the temp pod:** passed as a temporary RunPod SECRET reference (`{{ RUNPOD_SECRET_hf_token_tmp }}`) that `pod-down` deletes. This is a deliberate, documented exception to "never auto-delete secrets", scoped to that one secret name. The volume and the two R2 secrets are never auto-deleted. The token stays read-only and is rotated afterwards.
4. **Clone pin:** the temp pod's git clone is pinned to an explicit commit from `config.env` (`GIT_REF`; a default is set explicitly in `config.env.example`, never `HEAD`).
5. **Second volume** at US-IL-1 or US-KS-2 waits until the gate shows real throttling.
6. **Gate pass test:** no OOM, no offload, and a second warm default job within 10% of the first. 46 GB peak VRAM is report-only. Cold start is defined as `delayTime + executionTime` of the first job minus its generation time (`gen_time_s`). Added stop conditions: a worker goes Unhealthy, or a job stays IN_PROGRESS past 15 min.

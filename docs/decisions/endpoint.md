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

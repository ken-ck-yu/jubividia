# endpoint - independent validation

Validator: independent, did not write the code. Branch `feat/endpoint` at `23829e3` (commits 40549ee, e8e909e, 64bc24f, 3ea2582, 6820935, 08eddfc, 3c3b5b1, 786187f, 259c7c8, 23829e3). Date 2026-10-29.

Hard limits kept: no RunPod or Cloudflare call, no MCP tool, no `config.env`/`.env` read. Every execution ran against the engineer's fake server (or my own 20-line mock) on 127.0.0.1 only, with `RUNPOD_TEST_MODE=1`. The public v2 OpenAPI file (`runpod-v2-openapi.json`) was read from disk, not fetched.

## Verdict: ACCEPT WITH FIXES

Nothing found that can touch the real volume or the R2 secrets, leak a secret, or write under `--dry-run`. The management-API surface matches the v2 spec. Two issues must be fixed before the gate runs (they cost money or produce a false failure), the rest are small.

Who fixes: engineer for everything below. Item W1 changes `worker/handler.py`, which is not yet built into any image tag, so fix it now to avoid a second rebuild.

| # | Severity | Issue | Owner |
|---|---|---|---|
| F1 | must fix | `smoke-job.sh` polls `/status` forever when it keeps returning non-2xx (401, 500, 000). | engineer |
| F2 | must fix | An absent `error_code` field on the canary is recorded as FAIL but the gate carries on spending through all 7 jobs, then reports `GATE: FAIL`. The design says `[code]` in `error` is the accepted safeguard. | engineer (decision: Ken) |
| F3 | should fix | With shellcheck installed, `test-infra` fails (1 failure). The engineer never saw it because shellcheck was absent. | engineer |
| F4 | should fix | Test-mode loopback guard is defeated by userinfo URLs. | engineer |
| W1 | should fix | `VRAM_SAMPLE_S=0` (or negative) turns the sampler into a tight `nvidia-smi` fork loop. | engineer |
| L1-L8 | low | See "Low-severity findings". | engineer |

## 1. What I ran

| Command | Result |
|---|---|
| `make -f infra/runpod/infra.mk test-infra` (shellcheck absent) | 274 passed, 0 failed |
| `make test` | 116 passed |
| `make lint` | ruff clean, YAML loads |
| scratch venv `pip install shellcheck-py` (0.11.0), `env PATH=<venv>/bin:... make -f infra/runpod/infra.mk test-infra` | **274 passed, 1 failed** (`shellcheck`). Exit 2. |
| `shellcheck -x -e SC1091 infra/runpod/apply.sh infra/runpod/lib.sh scripts/smoke-job.sh` (the exact line in `infra.mk`/`tests/infra/run.sh`) | exit 1: 5x SC2015 (info), 1x SC2155 (apply.sh:328), 4x SC2034 on lib.sh variables used only by sourcing scripts, SC2034 `TOOL_NAME` and `COLD_TINY_START` (smoke-job.sh:22, 228; the latter is genuinely unused) |
| `shellcheck -x scripts/download-models.sh scripts/validate-workflows.sh scripts/wf-in-container.sh tests/models/run.sh` | clean |
| `shellcheck -x tests/infra/run.sh` | 20+ SC1087 *errors* (false positives: `$E['image']` inside a string handed to Python) plus SC2016/SC2034 info. The engineer's shellcheck step does not cover this file. |
| Own harnesses (`brk1-4.sh`, `urlcheck.sh`, `mock_rt.py` in the job scratch dir, not committed) | see sections 3 to 4 |

## 2. Conformance of the tooling to the real v2 spec

Source of truth: `/home/ken/.claude/jobs/b427e11f/tmp/runpod-v2-openapi.json` (server `https://api.runpod.io`, paths under `/v2`). Method: I dumped each operation and schema and compared by hand against what `apply.sh`, `lib.sh`, `rpjson.py`, `fake_runpod.py` send and read.

| Area | Spec | Tool | Match |
|---|---|---|---|
| Base | `https://api.runpod.io` + `/v2/...`, bearer | `API_BASE=https://api.runpod.io/v2`, `Authorization: Bearer` via `curl -K` | yes |
| Volume create `POST /network-volumes` | required `name,size(10-4096),dataCenter`; optional `type` STANDARD/HIGH_PERFORMANCE; additionalProperties false; 201 | `{name,size,dataCenter,type:"STANDARD"}` | yes |
| Volume PATCH | `{name?,size?}`, size grow only | `{size}`; shrink refused client side | yes |
| Volume list/get | `{networkVolumes:[{id,name,size,dataCenter,type}],pagination}`; names not unique | filter name+dataCenter+type, stop on >1, refuse if `hasNextPage` | yes |
| Volume DELETE | exists | never called (choke point, section 3) | yes |
| Secret create `POST /account/secrets` | `{name (pattern ^[a-zA-Z_]..., not RUNPOD*), value (min 1), description?}`; 201; 409 duplicate | `{name,value}`; names `ltx_r2_access_key_id`, `ltx_r2_secret_access_key`, `hf_token_tmp` | yes |
| Secret PATCH | `{value?,description?}`, at least one | `{value}` only (separate from description, as the spec advises) | yes |
| Secret list | `{secrets:[...]}`, no pagination, optional `?name=` | lists all, filters client side | yes (the `?name=` filter is unused, harmless) |
| Secret DELETE | 204 | only via `api_delete secret_hf` | yes |
| Secret reference | `{{ RUNPOD_SECRET_<name> }}` in env, substituted at boot | exactly that, with the spaces | yes (live substitution unverified) |
| Endpoint create `POST /serverless` | required `name,type,scaling`, `image` unless templateId, exactly one of `gpu`/`cpu`; `gpu.pools` required, `excludedTypes`, `count`, `minCudaVersion` (`^\d+\.\d+$`); `dataCenterIds`; `mounts.network[{volumeId}]` only; `workers{min,max,idleTimeout 1-3600}`; `scaling{type QUEUE_DELAY,queueDelay>=0.5}`; `flashboot` enum (default OFF); `timeout` integer, default 300000; `disk`; `env` map; unevaluatedProperties false | body has exactly these keys, `flashboot:"FLASHBOOT"`, `timeout:900000`, `type:"QUEUE"`, `disk:20`, `minCudaVersion:"12.8"`, no `networkVolumes`, no extra keys | yes |
| Endpoint timeout unit | response schema: "Per-request execution timeout in milliseconds" | ms, range 5000 to 604800000 enforced, read-back | yes |
| Endpoint PATCH | all fields optional; `excludedTypes` requires `pools` (dependentRequired); pools replaced with exclusions; `gpu.count/minCudaVersion` allowed; `idleTimeout` rejected with REQUEST_COUNT; `mounts.network` replaces list; env replaces env | per-group patch (`image env gpu dataCenterIds mounts scaling workers flashboot timeout disk`), `gpu` always sends pools+excludedTypes+count+minCudaVersion together, `scaling` patched before `workers`, `type` never patched | yes |
| Endpoint GET | `requestUrls`, `gpu` may be null, `disk/image/env` NOT in the response's required list, `workers.idleTimeout` omitted for REQUEST_COUNT | diff compares `disk`, `image`, `env` subset, treats a missing key as a difference | **risk R1**: if the live response omits `disk` the tool patches then dies on pass 2 (no delete, safe) |
| Endpoint DELETE | 204, also deletes the bound template | `teardown-endpoint --yes` only; PATCH workers to 0, DELETE, GET expects 404 | yes |
| Pod create `POST /pods` | required `name`; exactly one of gpu/cpu; `cpu{id,vcpuCount>=2, power of two}`; `cloud` default SECURE; `mounts.network[{volumeId,path}]` path required, maxItems 1; `entrypoint`/`cmd` string arrays; `ports` string array; `env`; `disk`; 201 | `{name,image,cloud:SECURE,cpu{id:cpu3c,vcpuCount:2},dataCenterIds,mounts.network[{volumeId,path:/runpod-volume}],disk:20,ports:[],env,entrypoint:["bash","-c"],cmd:[script]}` | yes |
| Pod list | `{pods,pagination}` cursor | refuse on `hasNextPage` (generic `ids` op, proven with a crafted page) | yes |
| Pod logs | `GET /pods/{id}/logs?tail<=5000&source=container|system`, `text/event-stream` | `tail=300`, 15 s curl cap, prints what arrived | yes |
| Pod DELETE | 204 (404/409 possible) | 204 accepted; read-back accepts 404 or `status==TERMINATED`, otherwise dies loudly (fail-safe) | yes |
| Pod status enum | PROVISIONING STARTING RUNNING EXITED ERROR TERMINATED | only TERMINATED used | yes |
| Runtime `/<id>/run`, `/status/<job>`, `/health`, `/cancel/<job>` | **not in this OpenAPI file**; the endpoint response carries `requestUrls.{run,runSync,status,cancel,health}` | hardcoded `https://api.runpod.ai/v2/<id>/...` (`RUN_BASE`) | **unverifiable offline (R2)**: the tool ignores `requestUrls` |

Mismatches and risks found:
- R1: diff treats optional response fields (`disk`, `image`, `env`) as required. Safe (no delete) but could block `apply.sh endpoint` on a live shape difference. Coordinator reads one real `GET /serverless/{id}` right after create and compares before anything else.
- R2: runtime base and `/health`, `/status` field names (`workers.idle|running|initializing|throttled|unhealthy`, `delayTime`, `executionTime`, states `IN_QUEUE|IN_PROGRESS|COMPLETED|FAILED|CANCELLED|TIMED_OUT`) come from RunPod runtime docs, not this spec. `requestUrls` from the created endpoint is the authoritative source and the tool does not use it.
- R3: `RUNPOD_QUEUE_DELAY_S` is parsed with Python `int()`; the spec allows floats >= 0.5. A value like `0.5` crashes with a Python traceback instead of a message. Cosmetic.
- No use of any removed or old route (`/v1`, `/secrets`, `/endpoints`): the suite greps for it and I confirmed no hit.

## 3. Conformance against the design and reviewer requirements

| Requirement (source) | Evidence | Result |
|---|---|---|
| Tag must be `sha-<7+ hex>`; `latest`/bad rejected (Ken Q1) | brk1: `latest`, `sha-abc12`, `sha-ABCDEF1`, `sha-x;touch x`, `sha-$(id)` all die with no writes; `IMAGE=...:latest` and `...@sha256:..` die; env var `IMAGE_TAG=latest` ignored (config only) | pass |
| `GIT_REF` 40-hex (round 2 #4) | 39 hex, 41 hex, UPPERCASE, `HEAD`, `main`, empty: all die, 0 writes (checked with volume id set so the ref check is reached) | pass (uppercase is refused; git would accept it; acceptable, stricter) |
| Delete choke point (reviewer Door 5) | `api_delete` accepts only `pod`, `endpoint`, `secret_hf`; kinds `volume`, `network-volumes`, `secret`, `secret_r2`, empty all rc 1; ids with `/`, `..`, space rc 1; the only call sites are `pod`, `endpoint`, `secret_hf`; suite greps confirm one `api DELETE` | pass |
| No delete for volume or the two R2 secrets | no code path; `teardown-endpoint` deletes only the endpoint; pod-down deletes only `hf_token_tmp` found by exact name | pass |
| Volume adopt by name+dataCenter+type, no duplicate | brk1: fake seeded with the real-looking volume `jubividia-ltx-us-wa1` (80, STANDARD, US-WA-1) plus three decoys (other DC and tier, `-old` name, other tier): `apply.sh volume` adopted `vol-real`, **0 writes**, id written back. With a second exact match it refuses (`2 volumes named ...`), 0 writes. Size 80 equals wanted, so no PATCH. | pass |
| Idempotent re-runs | volume, secrets, endpoint re-run on a complete fake: 0 writes | pass |
| `--dry-run` makes no writes | all 8 subcommands plus `--rotate secrets` and `--yes teardown-endpoint`: 0 non-GET calls, config.env checksum unchanged, resource counts unchanged | pass |
| Half-created after a kill (hook `APPLY_TEST_KILL_AFTER_CREATE`) | volume: killed (rc 137), id line empty, rerun re-finds by name, 1 volume. secret: killed after first create, rerun creates only the other, id written. endpoint: killed, rerun adopts `ep-3`, 1 endpoint. pod: killed, `pod-up` again refuses ("already exists"), `pod-down` terminates it and deletes the temp HF secret. No duplicates anywhere. | pass |
| Read-back mismatch patches only the differing field, never deletes (reviewer Door 6) | tampered `timeout` to 900 (wrong unit) and `flashboot` to OFF: exactly two PATCH calls, each with one group, then "matches"; no DELETE. Second-pass failure path is `die` with "NOT deleted" (code read; suite covers) | pass |
| Three REST traps (flashboot default OFF, idleTimeout vs REQUEST_COUNT, pools without excludedTypes) | code: flashboot always sent, scaling patched before workers, gpu group always carries pools+excludedTypes; the suite has a test for each against a spec-faithful fake | pass |
| Pagination | volume/secret/endpoint lookups via `ids=$(find_ids ...)` abort on `hasNextPage`; a crafted page proves exit 1 with the message. Caveats L5. | pass with caveat |
| Temp HF token as RunPod secret, deleted by `pod-down` (round 2 #3) | `body-pod` env `HF_TOKEN={{ RUNPOD_SECRET_hf_token_tmp }}`; pod-down deleted the secret by id found via exact name | pass |
| Pod pinned to `GIT_REF` (round 2 #4) | script does `git checkout --detach "$GIT_REF"`, prints the resolved sha | pass |
| Canary first, cold default job at the end, `/run`+`/status` only, never `/runsync` (round 2 #1) | order canary, cold-tiny, warm-tiny, warm-def, warm-def2, wait idle, cold-def. Endpoints hit in all runs: `GET /health`, `GET /status`, `POST /run`, `POST /cancel` only. `runsync` has 0 non-comment hits. | pass |
| Stop-and-ask conditions (round 2 #6) | stuck IN_PROGRESS (cancel sent, exit 3), unhealthy worker (exit 3), canary with unresolved secrets (exit 3), warm default 320 s (exit 3), second warm default drift 20% (exit 1), happy path (exit 0). Throttled-queue and cold>600 are covered by the suite. | pass; see F1, F2 |
| 900 s is our choice, not a platform limit (round 2 #2) | SPEC diff is exactly the two wording edits (line 72 and 108); README, handler comment, `config.env.example` consistent. Leftover: `handler.py:306` message text "platform limit"; `smoke-job.sh:270` prints a hard-coded `900 s`. | pass (L7) |
| `PLATFORM_LIMIT_S` tied to endpoint timeout | env `EXEC_TIMEOUT_S` = timeout_ms//1000 set by `apply.sh`; handler reads it; verified `EXEC_TIMEOUT_S=1200` gives limit 1200 and deadline 1185 | pass |
| `peak_vram_mb` (Ken Q4) | in handler output and sidecar; unit tests for parse, missing nvidia-smi, garbage, peak tracking, null | pass; see W1 |
| config.env never sourced; atomic and mode-preserving | `read_config` is a regex line reader; `$(...)`, backticks, quotes, unknown keys inert (suite plus code). `write_id` writes `config.env.tmp.$$` (umask 077), `chmod --reference`, `mv -f`; mode 640 preserved (suite), 600 stayed 600 in my flow; only the five id keys writable | pass; see L3 |

## 4. Attempts to break it

| Attempt | Outcome |
|---|---|
| `bash -x apply.sh status` | refused, rc 2, message only, 0 sentinel leaks |
| `SHELLOPTS=xtrace`, `BASH_XTRACEFD=2`, `BASH_ENV` file containing `set -x`, `bash -x smoke-job.sh` | all refused rc 2, 0 leaks |
| Full flow (preflight, volume, secrets, endpoint, status, pod-up, pod-logs, pod-down) with sentinel values for API key, HF token, R2 id and secret, curl argv recorded by a shim | 0 sentinels in stdout/stderr, 0 in curl argv, TMPDIR empty afterwards. Bodies carrying values go via stdin pipe; the bearer header via `-K <(printf ...)`. |
| Secret value in a request body printed by `--dry-run` | secret bodies are never passed `show`; endpoint/pod bodies hold only `{{ }}` references |
| Try to delete the volume or R2 secrets through `api_delete` | refused for every kind other than three; path-traversal ids refused |
| Two pods, one named `jubividia-models-tmp-2` and one unrelated | `pod-down` deleted only the exact-named pod and only `hf_token_tmp` |
| Defeat test-mode loopback guard (`RUNPOD_TEST_MODE=1`, `assert_url_allowed`) | **defeated** by userinfo: `http://127.0.0.1:80@evil.invalid/v2`, `http://127.0.0.1:x@host/`, `http://127.0.0.1:9#@host/`, `http://127.0.0.1:9@api.runpod.io/v2` and `http://127.0.0.1:9\@host/` are all ALLOWED because the check is a glob `http://127.0.0.1:*`. curl takes the part after `@` as the host. Refused: `127.0.0.1.evil.invalid`, `localhost`, `[::1]`, `127.0.0.2`, uppercase scheme. I did not make any request to confirm the connection (hard limit); the glob result alone is the evidence. Redirects are not followed (no `-L`), so that vector is closed. See F4. |
| `smoke-job.sh` when `/status` keeps returning 500 or 401 (own mock server) | **never exits**: prints `WARNING: status HTTP 500` every poll until killed (timeout 124 in my run). The in-progress cap and unhealthy/queue checks sit after the `continue`, so none can fire. See F1. |
| `smoke-job.sh` when the canary FAILED text has the `[input_fetch]` prefix but no `error_code` | prints FAIL, **continues through all 7 jobs** (7 CSV rows), ends `GATE: FAIL`, exit 1. See F2. |
| Sampler with interval 0 | 480,000 `read_vram_mb` calls in 0.2 s (in production each is a `nvidia-smi` fork). `stop()` while a sample takes 3 s returns after 3 s, thread ends, no leak. See W1. |
| Config line injection (`$(touch x)`, backticks, spaces) | inert (suite section 1 plus my reading) |

## 5. Worker change review

- `read_vram_mb`: `nvidia-smi --query-gpu=memory.used`, 5 s subprocess timeout, returns max over GPUs, `None` on missing binary, non-zero exit, non-digit output. Good.
- `VramSampler`: daemon thread, event-based stop, `join(10)`. Missing `nvidia-smi` ends the thread on the first sample, `peak_mb` stays `None`, so a missing binary costs one failed exec per job. Stop is in a `finally`, so it also stops on timeout/OOM/error paths; the thread is gone afterwards (checked). A transient first-sample failure disables sampling for that job (acceptable, documented as report-only). It samples only between `submit` and result, which covers the model load that happens inside the first job.
- Cost: one fork per second per job; negligible at the default. W1: no lower bound on `VRAM_SAMPLE_S` (handler) and `tune_json` accepts any number (including 0), so a typo spawns processes at full speed and burns the worker's CPU during generation. Fix: clamp to >= 0.2 in the handler and validate in `tune_json`.
- Tests: parse, missing, garbage, peak and stop, absent, output, sidecar, null. Missing tests: stop on the error path (finally), and `EXEC_TIMEOUT_S` override (only the default 900 is asserted).
- Arithmetic: generation deadline `t0 + JOB_TIMEOUT_S` = 780 s; upload hard deadline `t0 + PLATFORM_LIMIT_S - 15` = 885 s; each upload try capped at 45 s, 3 tries. `apply.sh` refuses a config where `JOB_TIMEOUT_S + 15 >= timeout/1000`, so 780 + 15 = 795 < 900. Margin for uploads is 105 s. The sampler join (<= 10 s) happens before the deadline accounting of uploads, inside the margin. Consistent. Note the platform clock for the execution timeout starts before the handler's `t0`; the 15 s `SAFETY_S` covers that.
- The image has not been rebuilt: `IMAGE_TAG=sha-f637c09` (in the example) predates this change. The coordinator must pin the tag of the merge that contains `e8e909e`.

## 6. Hygiene

- No secrets in tree or history: grep for `rpa_`, `hf_...`, `AKIA`, 64-hex (excluding the lock file and constraints) finds only the base image digest in the Dockerfile and the GHCR digest in the design note. `git log -S"rpa_"` empty.
- Executable bits: `apply.sh`, `rpjson.py`, `smoke-job.sh`, `fake_runpod.py` are 755; `lib.sh` (sourced), `infra.mk`, `tests/infra/run.sh` (run via `bash`) are 644. Fine.
- Root `Makefile`, `.gitignore`, `.github` are unchanged versus main (`bb869c5`). `infra.mk` is separate, used with `make -f`. `make test`/`make lint` unaffected.
- SPEC edits: exactly two lines (72 and 108), only the 900 s wording.
- README: billable order matches the design (volume, secrets, pod, endpoint, gate, restore). Prices: $1.75/hr serverless, $0.06/hr CPU pod, $5.60/month volume, all correct and present. **The $0.99/hr RTX 6000 Ada pod fallback is not in the README or any tool message** (only in the design note); the "stop and ask if CPU stock is gone" rule is only implicit.
- `config.env.example`: contains every key `ALLOWED_KEYS` reads except `VRAM_SAMPLE_S` (L6). It lists optional worker tuning vars (`WORKFLOWS_DIR`, `COMFY_HOST`, `COMFY_ROOT`, `COMFY_PID_FILE`) that the endpoint will NOT receive: `tune_json` forwards only `JOB_TIMEOUT_S COMFY_READY_TIMEOUT_S INPUT_MAX_BYTES POLL_INTERVAL_S VRAM_SAMPLE_S`. `GIT_REF` default `bb869c5...` is the PR #4 merge commit and is a valid pin; `IMAGE_TAG=sha-f637c09` is pre-filled with the old image.

## Low-severity findings

- L1: `APPLY_TEST_KILL_AFTER_CREATE` (`kill -9 $$`) is live in production code. If it is ever exported in a shell, a billable create is followed by a self-kill. Gate it on `RUNPOD_TEST_MODE=1`.
- L2: `.gitignore` lacks `config.env.tmp.*`. A kill during `write_id` (millisecond window) leaves a full copy of the secrets file, untracked but `git add -A`-able.
- L3: `write_id` replaces a symlinked `config.env` with a regular file (mv) and does not preserve ownership. Only matters if the file is a symlink.
- L4: `volume` with `RUNPOD_NETWORK_VOLUME_ID` set only checks existence, not that `dataCenter` is `US-WA-1` and `type` is STANDARD. Adopting a smaller matching volume would grow it (billable, one-way) with only a `say` line first.
- L5: In `preflight` and `status`, `find_ids ... | grep -c . || true` swallows the pagination refusal (shown on stderr but the count reads 0 and `status` could say "none"). The mutating commands use `ids=$(find_ids ...)` and do abort. Unrealistic with default limit 1000.
- L6: `config.env.example` omits `VRAM_SAMPLE_S` and lists worker vars the endpoint will not receive.
- L7: `handler.py:306` text and `smoke-job.sh:270` still say "platform limit"/hard-code 900 s.
- L8: a pod-up failure after the HF secret is created leaves the secret (and the token) on the account until `pod-down` runs; the error message does not say so. `pod-down` handles it.

## Cannot be verified without real RunPod calls

1. Secret substitution `{{ RUNPOD_SECRET_<name> }}` at worker boot (the canary is the only test).
2. The real `GET /serverless/{id}` shape: whether `disk`, `image`, `env`, `gpu.minCudaVersion` come back as the tool expects (R1), and `requestUrls`.
3. Runtime URLs, `/health` and `/status` field names and `error_code` visibility (R2).
4. That `NVIDIA RTX 6000 Ada Generation` and `ADA_48_PRO` are the live ids (the API 400s on a bad exclusion; creation is free, so this fails safe).
5. CPU flavor id `cpu3c` with vcpuCount 2 at US-WA-1, CPU stock, GPU stock.
6. `mountpoint -q` and `flock` on the FUSE mount; whether `ubuntu:22.04` (or whatever `RUNPOD_POD_IMAGE` is) has what the pod script needs.
7. Balance and payment method (no REST route).
8. Whether pod DELETE is synchronous (the read-back dies loudly if it is not).
9. Whether FlashBoot, queueDelay 4 and idle 60 behave as configured (read-back confirms values, not behavior).
10. Whether `http_proxy` in the environment would route the loopback test traffic (including the sentinel key) to a proxy: the tests do not pass `--noproxy`.

Read-only checks for the coordinator before each billable step (REST GET or MCP list/get only):
- Before the volume: `GET /network-volumes` shows `jubividia-ltx-us-wa1` 80 GB STANDARD US-WA-1 exactly once; run `apply.sh --dry-run volume` and expect "adopting existing volume" and no create.
- Before secrets: `GET /account/secrets` for the two names; confirm balance by the console; confirm the R2 token is scoped to `jubividia-ltx-eu` Object Read & Write.
- Before the pod: re-read CPU stock and the `cpu3c` id at US-WA-1 (catalog cpus and datacenters), confirm `RUNPOD_POD_IMAGE` and `GIT_REF` (40 hex, contains `download-models.sh` and the lock), `GET /pods` shows none named `jubividia-models-tmp`. Right after `pod-up` read `GET /pods/{id}` once and check the env HF_TOKEN is the reference and not the value. Afterwards `GET /pods` is empty and the `hf_token_tmp` secret is gone.
- Before the endpoint: image tag built from the merge containing `e8e909e`, anonymous GHCR manifest (preflight does this), RTX 6000 Ada serverless stock at US-WA-1, catalog gpus: pool and type ids, `apply.sh --dry-run endpoint` body review. Right after create, `GET /serverless/{id}` once and compare `timeout`, `flashboot`, `gpu`, `mounts`, `requestUrls`; set `--max-workers 1` for the gate.
- Before the gate: `/health` shows 0 workers; confirm F1 and F2 are fixed; read the Unhealthy/IN_PROGRESS stop rules in the README; note that there is no overall spend cap, only per-job caps (worst case about $0.44 per stuck job at 15 min).

## Numbered questions

1. F1: Add a consecutive-failure limit (for example 12 polls or 60 s) to the `/status` loop; on reaching it send `cancel` and exit 3. OK to do before the gate? (Needed; without it a bad key/route can leave a job running and the script spinning.)
2. F2: Ken, if `/status` carries `[input_fetch]` in `error` but no separate `error_code`, should the gate (a) continue and record a note (matches the design: the prefix is the safeguard), or (b) stop right after the canary? Either way it should not run seven jobs and then print FAIL.
3. F3: Fix the six shellcheck findings (or add a `# shellcheck disable=` with a reason), drop the unused `COLD_TINY_START`, and either add `tests/infra/run.sh` to the shellcheck call with `SC1087` disabled or leave it out on purpose. The CI/dev shellcheck should be installed so the suite's own check actually runs.
4. F4: Replace the glob with an anchored regex such as `^http://127\.0\.0\.1:[0-9]+(/|$)` (no `@`, no `#`, no backslash). Also consider `NO_PROXY`/`--noproxy '*'` for test traffic.
5. W1: Clamp `VRAM_SAMPLE_S` to a minimum (suggest 0.2 s) in the handler and reject smaller values in `tune_json`. This is a worker change, so do it before the merge and before the image tag is pinned. Add a test that `stop()` is called when `wait_for_result` raises, and one for `EXEC_TIMEOUT_S`.
6. Should `smoke-job.sh` read the run URLs from `requestUrls` of `GET /serverless/{id}` instead of the hard-coded `https://api.runpod.ai/v2/<id>` (R2)? That removes the one hardcoded host not covered by the spec.
7. L4: Should `volume` assert `dataCenter == RUNPOD_DC` and `type == STANDARD` on the id-from-config path, and refuse to grow an adopted volume without `--yes`?
8. Does Ken want the $0.99/hr RTX 6000 Ada pod fallback stated in the README next to "stop and ask if CPU stock is gone"?
9. The example config pre-fills `IMAGE_TAG=sha-f637c09`, an image without `peak_vram_mb`/`EXEC_TIMEOUT_S`. Leave it empty in the example so nobody runs the gate on the old image by copy-paste?
10. An overall spend guard for the gate (for example a total wall-clock cap, or a required `--yes-i-have-seen-the-quote` flag) does not exist; `smoke-job.sh` bills as soon as it runs. Is the per-job cap plus coordinator discipline enough?

---

# Re-check of the fix round (commits 2246825, 83c6636, aed20d4, a9408e7)

Same rules as before: no RunPod or Cloudflare call, fake server and my own mock servers on 127.0.0.1 only, `config.env` never read. I checked behaviour myself with new harnesses (`brk5-7.sh`, `urlcheck2.sh`, `mock2.py` in the job scratch dir, not committed).

## Re-check verdict: ACCEPT WITH FIXES (one small must-fix, rest optional)

F1 to F4 and W1 are fixed and I could not break the fixes in the ways I tried. I found one remaining way for `smoke-job.sh` to hang (N1) and a few cosmetic or low items. N1 should be fixed before the gate because the gate is billable; the rest can wait.

## Test runs

| Command | Result |
|---|---|
| `make -f infra/runpod/infra.mk test-infra` (no shellcheck) | 330 passed, 0 failed |
| same with shellcheck 0.11 on PATH (scratch venv) | 331 passed, 0 failed |
| `make test` | 123 passed |
| `make lint` | clean |
| `shellcheck -x -e SC1091` on `apply.sh lib.sh smoke-job.sh tests/infra/run.sh download-models.sh validate-workflows.sh wf-in-container.sh tests/models/run.sh` | no output, exit 0 |

## Fix by fix

| Item | Result | Evidence |
|---|---|---|
| F1 `/status` failing | **fixed** | Mock servers returning 500, 401, HTML 200 and `{}` 200 forever: exit 3 after 5 polls (1-2 s), one cancel sent, no hang. A cancel that also returns 500: same, exit 3 (cancel is best effort and cannot abort the script). IN_PROGRESS then 500 with a 1 s in-progress cap: the cap still fires while polls fail. Unhealthy worker with `/status` failing: stops on the unhealthy check. Throttled queue: stops after the queue limit. `--max-spend abc` rejected. |
| F2 canary | **fixed** | `[input_fetch] input not found` passes with or without `error_code` (a missing field becomes a note, gate continues). Any other text (`could not fetch input`, unknown prefix, other `error_code`) is `stop` with exit 3 before any model job; a non-FAILED canary goes to the summary (exit 1) before any model job. |
| F3 shellcheck | **fixed** | Zero findings including `tests/infra/run.sh`; `infra.mk` lint covers it; the suite's shellcheck test passes when shellcheck is present. |
| F4 loopback guard | **fixed** | Anchored regex `^http://127\.0\.0\.1:[0-9]{1,5}(/...)?(\?...)?$`. Refused: `@` userinfo in all earlier forms, `#`, backslash, `@` in path or query, newline-embedded second URL, trailing newline, space, 6-digit port, empty, uppercase scheme, `https`, hex/decimal/IPv6-mapped loopback, `;`. Allowed: only real loopback URLs (including harmless paths like `//evil.invalid/` that stay on 127.0.0.1). No redirect following (no `-L`). Test mode now adds `--noproxy '*'` to every curl, so a proxy variable cannot take loopback traffic. `RUNPOD_TEST_MODE=0` still disables the guard by design. |
| `aws`/`ffprobe` on this machine (real `/usr/local/bin/aws`) | **safe in test mode** | In test mode `r2_check` skips unless `SMOKE_ALLOW_STUB_AWS=1`; the suite sets that only with a stub `aws`/`ffprobe` first in PATH. All other suite smoke runs use `--no-r2-check`. Residual: `SMOKE_ALLOW_STUB_AWS=1` plus test mode with no stub would run the real aws against R2 (explicit opt-in). In normal mode `r2_check` runs the real aws against R2 by design. |
| W1 VRAM clamp | **fixed** | Handler clamps `VRAM_SAMPLE_S` to >= 0.2 (parametrised test: 0, -3, 0.05, 0.5, 2); `tune_json` rejects < 0.2 (0, 0.1 die; 0.2, 1 pass; `abc` dies). New tests: `EXEC_TIMEOUT_S=1200` override in a subprocess, sampler stopped and thread dead when generation raises. Thread semantics unchanged (daemon, event stop, join 10 s): no leak, at most one fork per 0.2 s. `VramSampler(interval=x)` called directly is not clamped, only the env path. |
| Q6 requestUrls | **done** | `smoke-job.sh` GETs `/serverless/<id>` and uses `requestUrls.run` minus `/run` when it matches `^https?://[^ @#]+/run$`, else `RUNPOD_RUN_BASE`. Every request still passes the test-mode guard. In real mode the key goes to whatever host that field names (trusted RunPod response); consider pinning to `*.runpod.ai` (N3). |
| Q7 volume | **done** | Adopting a volume named `jubividia-ltx-us-wa1`, 80 GB, STANDARD, US-WA-1: **0 writes** (also on the second run with the id in config). Id in config pointing at a US-CA-2 HIGH_PERFORMANCE volume: refused, 0 writes. Config wants 100 GB: refuses without `--yes` (also under `--dry-run`, which writes nothing), one PATCH with `--yes`; 40 GB: refuses to shrink. |
| Q9 empty IMAGE_TAG | **done** | `endpoint` and `preflight` die on an empty tag (endpoint reports a missing volume id first if that is also unset), `smoke-job.sh` dies on empty and on `latest`; 0 writes. |
| Q10 `--max-spend` (default 1.50, 1.75/hr) | **works, with limits** | `--max-spend 0.01` on a stuck job: stopped at $0.0101 with a cancel sent. Counting is wall time while the job is IN_PROGRESS or `/health` shows idle+running+initializing workers, plus the wait-for-scale-to-zero period. A stuck or unhealthy worker cannot bypass it when `/health` works. Not conservative: the 60 s idle tail after each job, the last poll interval of each job and time before the first poll are not counted (cents). It counts nothing when neither `/status` nor `/health` can be read (see N1); the 5-poll limit covers the `/status` case. $1.50 is close to the design's expected gate cost ($1-2) and may stop a legitimate slow run; it is a flag. |
| L1 | **fixed** | The kill hook is only honoured when `RUNPOD_TEST_MODE=1`; verified a real-mode run with the variable set ignores it. |
| L2 | **fixed** | `.gitignore` has `config.env.tmp.*`. |
| L5 | **mostly fixed** | `count_ids` makes `preflight` abort on a second page. In `status` the call sits inside a `say` command substitution and the pod count is still `| grep -c . || true`, so a paged list would print an empty count after the stderr message instead of aborting (N5, unrealistic at limit 1000). |
| L7 | **fixed** | handler message and the smoke timeout line (reads `RUNPOD_EXEC_TIMEOUT_MS`). |
| L8 | **fixed** | `pod-up` prints a note right after creating the temporary secret saying to run `pod-down` if pod creation fails. |
| R3 | **fixed** | `RUNPOD_QUEUE_DELAY_S` 0.5 and 4 accepted, 0.2 and `abc` rejected with a clear message. |

## Regression checks

- Full `pod-up`, `pod-logs`, `pod-down` flow with sentinel HF token, API key and R2 values and a decoy pod `jubividia-models-tmp-2`: no sentinel in output or curl argv; exactly two deletes, `DELETE /v2/pods/<exact-named pod>` and `DELETE /v2/account/secrets/<hf_token_tmp id>`; the decoy pod and both R2 secrets remain.
- `git grep` of delete call sites: `api_delete pod|secret_hf|endpoint` and the single `api DELETE` in `api_delete`; no path for volumes or the R2 secrets.
- `--dry-run` on all 8 subcommands: 0 writes.
- No secrets in tree (grep for `rpa_`, `hf_...`, `AKIA` empty); the four new commits add no keys; the earlier history check stands. Worktree was clean before this section.
- Handler: 123 tests pass; deadline arithmetic unchanged (780 s generation, 885 s uploads).

## Remaining findings

- **N1 (fix before the gate):** `smoke-job.sh` still hangs if `/status` answers `IN_QUEUE` forever while `/health` fails (HTTP 500). The queue-stop check needs `/health`, the spend counter sees no billing, and failed health calls are not counted. Reproduced: killed by my 40 s timeout after 172 polls, no stop, no cancel. The same happens if both `/status` and `/health` fail and `SMOKE_POLL_FAIL_LIMIT` is raised. Fix: count consecutive `/health` failures, or add a per-job wall-clock cap (execution timeout plus queue limit), and stop with exit 3 and a cancel.
- N2 (cosmetic): the stop message "last HTTP N" shows the cancel call's status (for example 200) instead of the failing poll's status, because the cancel runs before the message is built.
- N3 (low): `requestUrls.run` host is not restricted to RunPod.
- N4 (low): the spend estimate undercounts the idle tail (cents).
- N5: `status` pagination handling (L5 above).

## What cannot be verified without real calls (unchanged)

Secret substitution at boot; the live GET shape of an endpoint (`disk`, `image`, `env`, `gpu.minCudaVersion`, and `requestUrls.run` as the new code expects); runtime `/health` and `/status` field names, the `cancel` route and `error_code` visibility; live GPU pool and type ids; the `cpu3c` id and CPU/GPU stock; `mountpoint` and `flock` on the mount; balance; whether pod DELETE is synchronous; real FlashBoot and scaling behaviour.

## Read-only checks for the coordinator before each billable step

- **Volume:** `GET /network-volumes` lists `jubividia-ltx-us-wa1` (80 GB, STANDARD, US-WA-1) exactly once; `apply.sh --dry-run volume` says "adopting existing volume" and makes no create; with a config id, the dc/type assertion confirms it.
- **Secrets:** list the two names; confirm balance and payment in the console; confirm the R2 token is scoped to `jubividia-ltx-eu`, Object Read & Write.
- **Temp pod:** re-read CPU stock and the `cpu3c` id at US-WA-1; `RUNPOD_POD_IMAGE` and a 40-hex `GIT_REF` set; no pod named `jubividia-models-tmp`; right after `pod-up` read `GET /pods/{id}` once to confirm `HF_TOKEN` is the secret reference; afterwards `GET /pods` is empty and `hf_token_tmp` is gone.
- **Endpoint:** `IMAGE_TAG` is the build of the merge containing `e8e909e` and `2246825` (set explicitly; empty or `latest` is refused); anonymous GHCR manifest (preflight); RTX 6000 Ada stock at US-WA-1; catalog pool and type ids; review the `--dry-run endpoint` body; right after create `GET /serverless/{id}` and compare `timeout`, `flashboot`, `gpu`, `mounts`, `requestUrls`; use `--max-workers 1` for the gate.
- **Gate:** N1 fixed first; `/health` shows 0 workers; decide `--max-spend` with Ken (default $1.50); keep the console open on Workers; after any exit 3 read `/health` and cancel the job by hand if the script could not.

## Numbered questions (re-check)

1. N1: may the engineer add a consecutive `/health`-failure limit or a per-job wall-clock cap to `smoke-job.sh` before the gate?
2. Does Ken accept `--max-spend` 1.50 as the default, or should it be set explicitly per run (for example 3.00 for the full gate including the cold default job)?
3. Should the run URL taken from `requestUrls` be pinned to a RunPod host (N3)?
4. Should `status` abort on a second page like the other commands (N5)?
5. Should the stop message report the failing poll's HTTP status rather than the cancel's (N2)?

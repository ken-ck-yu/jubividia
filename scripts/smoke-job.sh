#!/usr/bin/env bash
# Real-GPU gate runner for the jubividia endpoint (docs/decisions/endpoint.md, "Real-GPU gating plan").
# BILLABLE: every job runs on a RunPod RTX 6000 Ada ($1.75/hr). Run only after Ken has seen the quote.
#
#   scripts/smoke-job.sh [--max-spend USD] [--no-r2-check] [--skip-final-cold] [--csv PATH]
#
# Order (cheapest checks first):
#   1 canary     missing-input i2v job. Needs good R2 secrets, never loads models.
#   2 cold-tiny  256x256x25 t2v on a cold worker
#   3 warm-tiny  same job again
#   4 warm-def   1280x704x121 @24 fps
#   5 warm-def2  same again: must be within 10% of #4 (no encoder eviction / reload)
#   6 wait for scale to zero, then 7 cold-def: the user's real "first job after idle" path
# Uses /run + /status + /health + /cancel only (never /runsync: it sits behind a ~100 s edge timeout).
# The run URL comes from the endpoint's `requestUrls` (GET /serverless/<id>) when present, else RUNPOD_RUN_BASE.
# Cold start = delayTime + executionTime of a job, minus its gen_time_s.
# Canary: passes when the error is "[input_fetch] input not found" (a missing key failing inside input_fetch
# proves the R2 credentials resolved), with or without a separate error_code field (a missing field is noted).
# Anything else at the canary stops the gate right there, before any model job runs.
# Stops (exit 3) and asks Ken when: the canary shows unresolved secrets or another error; a worker goes
# Unhealthy; a job stays IN_PROGRESS past 15 min (a cancel is sent); a job waits in the queue with no
# usable worker (throttled) past 5 min; /status fails 5 polls in a row (cancel sent); estimated spend
# (worker time x $1.75/hr) reaches --max-spend (default 3.00 USD; each job also counts a 60 s idle tail; cancel sent); cold start > 600 s;
# cold-tiny start + warm default gen_time > 700 s; warm gen_time > 300 s.
# Exit codes: 0 gate passed, 1 gate failed, 2 usage/config, 3 stop-and-ask.
# Output never contains the API key or R2 secrets (lib.sh redact()).
set -euo pipefail
# shellcheck disable=SC2034  # read by die() in lib.sh
TOOL_NAME=smoke-job
export LC_ALL=C   # awk/EPOCHREALTIME decimal point
# shellcheck source=../infra/runpod/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/../infra/runpod/lib.sh"

R2_CHECK=1
FINAL_COLD=1
CSV=${SMOKE_CSV:-$ROOT/docs/validation/endpoint-timings.csv}
POLL_S=${SMOKE_POLL_S:-5}
POLL_FAIL_LIMIT=${SMOKE_POLL_FAIL_LIMIT:-5}
MAX_INPROGRESS_S=${SMOKE_MAX_INPROGRESS_S:-900}
QUEUE_STOP_S=${SMOKE_QUEUE_STOP_S:-300}
IDLE_WAIT_S=${SMOKE_IDLE_WAIT_S:-600}
MAX_SPEND=3.00
WORKER_USD_PER_HR=1.75
COLD_FLAG_S=180
COLD_HARD_S=600
SUM_STOP_S=700
WARM_STOP_S=300
VRAM_REPORT_MB=47104   # 46 GiB: report-only, never a pass/fail

while (($#)); do
  case $1 in
    --no-r2-check) R2_CHECK=0 ;;
    --skip-final-cold) FINAL_COLD=0 ;;
    --csv) (($# >= 2)) || die "--csv needs a path"; CSV=$2; shift ;;
    --max-spend)
      (($# >= 2)) || die "--max-spend needs a value"
      [[ $2 =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "--max-spend needs a number of US dollars"
      MAX_SPEND=$2; shift ;;
    -h | --help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done

read_config
need_cfg RUNPOD_API_KEY RUNPOD_ENDPOINT_ID IMAGE_TAG
valid_image_tag "$(cfg IMAGE_TAG)" || die "IMAGE_TAG must match ^sha-[0-9a-f]{7,}\$ (refusing to run the gate without a pinned image tag)"
EP=$(cfg RUNPOD_ENDPOINT_ID)
EXEC_S=$(($(cfg RUNPOD_EXEC_TIMEOUT_MS 900000) / 1000))
# per-job wall-clock cap: execution timeout plus a margin for queueing and a cold start (cold start hard stop is 600 s)
JOB_WALL_S=${SMOKE_JOB_WALL_S:-$((EXEC_S + 600))}
HEALTH_FAIL_LIMIT=${SMOKE_HEALTH_FAIL_LIMIT:-5}
IDLE_TAIL_S=${SMOKE_IDLE_TAIL_S:-60}   # a worker keeps billing for its idle timeout after each job
FAILS=()
NOTES=()
SPEND_S=0
BILLING=0
LAST_TICK=$EPOCHREALTIME
CUR_JOB=

# Runtime base for this endpoint: requestUrls.run from the endpoint (minus the trailing /run), else the default.
EP_URL="$RUN_BASE/$EP"
http GET "$API_BASE/serverless/$EP"
if api_ok; then
  run_url=$(json_get requestUrls.run)
  if [[ -n $run_url ]]; then
    # Pin the host: https and a *.runpod.ai / *.runpod.io name only (loopback http in test mode).
    if [[ $run_url =~ $RUNPOD_URL_RE ]] || { [[ $RUNPOD_TEST_MODE == 1 ]] && [[ $run_url =~ $LOOPBACK_RE ]]; }; then
      EP_URL=${run_url%/run}
    else
      printf '%s: refusing requestUrls.run %s: not a RunPod domain (https *.runpod.ai or *.runpod.io)\n' "$TOOL_NAME" "${run_url%%\?*}" >&2
      exit 4
    fi
  fi
fi
unset run_url

stop() { # stop REASON  -> exit 3
  say ""
  say "STOP AND ASK KEN: $1"
  say "Estimated spend so far: \$$(spend_usd) of the \$${MAX_SPEND} cap."
  say "Do not work around it and do not retry blindly. Check /health and the worker logs, then report the evidence."
  exit 3
}

awkf() { awk "$@"; }
spend_usd() { awkf -v s="$SPEND_S" -v r="$WORKER_USD_PER_HR" 'BEGIN{printf "%.4f", s*r/3600}'; }

cancel_job() { # best effort, stops the spend on a job we are giving up on
  if [[ -n $CUR_JOB ]]; then http POST "$EP_URL/cancel/$CUR_JOB"; fi
}

spend_check() {
  if awkf -v c="$(spend_usd)" -v m="$MAX_SPEND" 'BEGIN{exit !(c>=m)}'; then
    cancel_job
    stop "estimated spend \$$(spend_usd) reached --max-spend \$${MAX_SPEND}."
  fi
}

tick() { # accumulate worker time while something is billing, then enforce the spend cap
  local n=$EPOCHREALTIME
  if ((BILLING)); then
    SPEND_S=$(awkf -v s="$SPEND_S" -v a="$LAST_TICK" -v b="$n" 'BEGIN{printf "%.4f", s+(b-a)}')
  fi
  LAST_TICK=$n
  spend_check
}

job_finished_spend() { # conservative: every job also pays the idle tail and up to one more poll interval
  SPEND_S=$(awkf -v s="$SPEND_S" -v t="$IDLE_TAIL_S" -v p="$POLL_S" 'BEGIN{printf "%.4f", s+t+p}')
  spend_check
}

health() { # sets H_UNHEALTHY H_THROTTLED H_IDLE H_RUNNING H_INIT
  http GET "$EP_URL/health"
  H_UNHEALTHY=0 H_THROTTLED=0 H_IDLE=0 H_RUNNING=0 H_INIT=0
  api_ok || return 1
  [[ -n $(json_get workers) ]] || return 1   # 200 with a non-JSON body is a failure too
  H_UNHEALTHY=$(json_get workers.unhealthy); H_UNHEALTHY=${H_UNHEALTHY:-0}
  H_THROTTLED=$(json_get workers.throttled); H_THROTTLED=${H_THROTTLED:-0}
  H_IDLE=$(json_get workers.idle); H_IDLE=${H_IDLE:-0}
  H_RUNNING=$(json_get workers.running); H_RUNNING=${H_RUNNING:-0}
  H_INIT=$(json_get workers.initializing); H_INIT=${H_INIT:-0}
}

# run_job LABEL INPUT_JSON -> J_STATUS J_ID J_DELAY J_EXEC J_GEN J_COLD J_KEY J_THUMB J_META J_VRAM J_START
# J_ERR (error text) J_ERRCODE J_FIELDS (names of the /status fields)
run_job() {
  local label=$1 input=$2 t0 st last="" now in_progress_since=-1 waiting fails=0 hfails=0 code
  say ""
  say "--- $label: submitting"
  if health; then say "    health: idle=$H_IDLE running=$H_RUNNING initializing=$H_INIT throttled=$H_THROTTLED unhealthy=$H_UNHEALTHY"
  else say "    (health unavailable: HTTP $API_STATUS)"; fi
  http POST "$EP_URL/run" "{\"input\":$input}"
  api_ok || die "$label: POST /run failed: HTTP $API_STATUS ${API_BODY:0:300}"
  J_ID=$(json_get id)
  [[ -n $J_ID ]] || die "$label: /run returned no job id"
  CUR_JOB=$J_ID
  say "    job $J_ID"
  t0=$SECONDS
  LAST_TICK=$EPOCHREALTIME
  while :; do
    sleep "$POLL_S"
    http GET "$EP_URL/status/$J_ID"
    now=$((SECONDS - t0))
    st=
    if api_ok; then st=$(json_get status); fi
    if [[ -z $st ]]; then
      # 401/500/000 or a non-JSON body: count it, but keep enforcing every other check below
      fails=$((fails + 1))
      warn "status poll failed ($fails/$POLL_FAIL_LIMIT): HTTP $API_STATUS"
      if ((fails >= POLL_FAIL_LIMIT)); then
        code=$API_STATUS   # the failing poll's status, before the cancel call overwrites it
        cancel_job
        stop "$label: /status failed $fails polls in a row (last HTTP $code). Job $J_ID may still be running; a cancel was sent."
      fi
    else
      fails=0
      if [[ $st != "$last" ]]; then say "    [${now}s] $st"; last=$st; fi
      case $st in
        COMPLETED | FAILED | CANCELLED | TIMED_OUT) break ;;
        IN_PROGRESS) if ((in_progress_since < 0)); then in_progress_since=$now; fi ;;
      esac
    fi
    BILLING=0
    if [[ $last == IN_PROGRESS ]]; then BILLING=1; fi
    if ! health; then
      hfails=$((hfails + 1))
      warn "health poll failed ($hfails/$HEALTH_FAIL_LIMIT): HTTP $API_STATUS"
      if ((hfails >= HEALTH_FAIL_LIMIT)); then
        code=$API_STATUS
        cancel_job
        stop "$label: /health failed $hfails polls in a row (last HTTP $code), so worker state and the queue can not be watched. Job $J_ID may still be running; a cancel was sent."
      fi
    else
      hfails=0
      ((H_UNHEALTHY == 0)) || stop "$label: a worker is Unhealthy (unhealthy=$H_UNHEALTHY). Job $J_ID may still be billing; cancel it only after Ken agrees."
      waiting=$((H_IDLE + H_RUNNING + H_INIT))
      if ((waiting > 0)); then BILLING=1; fi
      if [[ $last == IN_QUEUE ]] && ((now > QUEUE_STOP_S)) && ((H_THROTTLED > 0 || waiting == 0)); then
        stop "$label: IN_QUEUE for ${now}s with throttled=$H_THROTTLED and no usable worker: the RTX 6000 Ada cannot be acquired (stock). Ask before widening the pool or moving DC."
      fi
    fi
    if ((in_progress_since >= 0 && now - in_progress_since > MAX_INPROGRESS_S)); then
      cancel_job
      stop "$label: job $J_ID stayed IN_PROGRESS for more than ${MAX_INPROGRESS_S}s; a cancel was sent to stop the spend."
    fi
    if ((now > JOB_WALL_S)); then
      cancel_job
      stop "$label: job $J_ID did not finish within ${JOB_WALL_S}s of wall-clock time (last state '${last:-unknown}'); a cancel was sent."
    fi
    tick
  done
  CUR_JOB=
  J_STATUS=$st
  J_DELAY=$(json_get delayTime); J_EXEC=$(json_get executionTime)
  J_GEN=$(json_get output.gen_time_s); J_COLD=$(json_get output.cold)
  J_KEY=$(json_get output.key); J_THUMB=$(json_get output.thumb_key); J_META=$(json_get output.meta_key)
  J_VRAM=$(json_get output.peak_vram_mb)
  J_ERR=$(json_get error); [[ -n $J_ERR ]] || J_ERR=$(json_get output.error)
  J_ERRCODE=$(json_get error_code); [[ -n $J_ERRCODE ]] || J_ERRCODE=$(json_get output.error_code)
  J_FIELDS=$(printf '%s' "$API_BODY" | "${PYTHON:-python3}" -I -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin))))')
  J_START=
  if [[ $J_STATUS == COMPLETED && -n $J_DELAY && -n $J_EXEC && -n $J_GEN ]]; then
    J_START=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" -v g="$J_GEN" 'BEGIN{printf "%.1f",(d+e)/1000-g}')
  fi
  J_AUDIO=
  say "    status=$J_STATUS delayTime=${J_DELAY:-?}ms executionTime=${J_EXEC:-?}ms gen_time_s=${J_GEN:-?} cold=${J_COLD:-?} peak_vram_mb=${J_VRAM:-null}"
  if [[ $J_STATUS == COMPLETED ]]; then
    say "    cold start (delayTime + executionTime - gen_time) = ${J_START:-?} s"
    say "    keys: $J_KEY $J_THUMB $J_META"
    if ((R2_CHECK)); then r2_check "$label"; fi
  else
    say "    /status fields: $J_FIELDS"
    say "    error: ${J_ERR:-?}"
    say "    error_code field: ${J_ERRCODE:-ABSENT (only the [code] prefix in the error text, if any)}"
  fi
  record_csv "$label"
  job_finished_spend
}

record_csv() {
  mkdir -p "$(dirname "$CSV")"
  [[ -f $CSV ]] || echo "utc,label,job_id,status,cold_flag,delay_ms,exec_ms,gen_time_s,cold_start_s,peak_vram_mb,key,audio" >"$CSV"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$J_ID" "$J_STATUS" \
    "${J_COLD:-}" "${J_DELAY:-}" "${J_EXEC:-}" "${J_GEN:-}" "${J_START:-}" "${J_VRAM:-}" "${J_KEY:-}" "${J_AUDIO:-}" >>"$CSV"
}

# r2_check LABEL: head the three objects, download the mp4, ffprobe for an audio stream.
r2_check() {
  need_cfg R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  if ! command -v aws >/dev/null; then J_AUDIO=unchecked; NOTES+=("$1: R2 check skipped (aws CLI missing)"); say "    R2 check SKIPPED: aws CLI not installed"; return 0; fi
  if [[ $RUNPOD_TEST_MODE == 1 && ${SMOKE_ALLOW_STUB_AWS:-0} != 1 ]]; then
    J_AUDIO=unchecked; NOTES+=("$1: R2 check skipped (test mode, no stub aws)"); say "    R2 check SKIPPED: test mode refuses a real aws/Cloudflare call"; return 0
  fi
  local k tmp ctype ep=https://${CFG[R2_ACCOUNT_ID]}.r2.cloudflarestorage.com
  tmp=$(mktemp -d)
  for k in "$J_KEY" "$J_THUMB" "$J_META"; do
    ctype=$(AWS_ACCESS_KEY_ID=${CFG[R2_ACCESS_KEY_ID]} AWS_SECRET_ACCESS_KEY=${CFG[R2_SECRET_ACCESS_KEY]} AWS_DEFAULT_REGION=auto \
      aws --endpoint-url "$ep" s3api head-object --bucket "${CFG[R2_BUCKET]}" --key "$k" --query ContentType --output text 2>/dev/null) \
      || { FAILS+=("$1: R2 object missing: $k"); say "    R2 MISSING: $k"; continue; }
    say "    R2 ok: $k ($ctype)"
  done
  if AWS_ACCESS_KEY_ID=${CFG[R2_ACCESS_KEY_ID]} AWS_SECRET_ACCESS_KEY=${CFG[R2_SECRET_ACCESS_KEY]} AWS_DEFAULT_REGION=auto \
    aws --endpoint-url "$ep" s3 cp "s3://${CFG[R2_BUCKET]}/$J_KEY" "$tmp/out.mp4" >/dev/null 2>&1; then
    if command -v ffprobe >/dev/null; then
      if ffprobe -v error -show_entries stream=codec_type,duration -of json "$tmp/out.mp4" 2>/dev/null | grep -q '"codec_type": *"audio"'; then
        J_AUDIO=yes; say "    audio stream: present"
      else
        J_AUDIO=NO; FAILS+=("$1: no audio stream in the mp4"); say "    audio stream: MISSING"
      fi
    else J_AUDIO=unchecked; NOTES+=("$1: ffprobe missing, audio unchecked"); say "    audio check SKIPPED: ffprobe not installed"; fi
  else FAILS+=("$1: could not download the mp4 from R2"); say "    R2 download failed"; fi
  rm -rf "$tmp"
}

num_gt() { awkf -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'; }

check_cold() { # LABEL: flag > 180 s, stop > 600 s
  [[ -n $J_START ]] || return 0
  if num_gt "$J_START" "$COLD_HARD_S"; then stop "$1: cold start ${J_START}s exceeds the ${COLD_HARD_S}s hard limit."; fi
  if num_gt "$J_START" "$COLD_FLAG_S"; then NOTES+=("$1: cold start ${J_START}s > ${COLD_FLAG_S}s (flag; propose mitigations, change nothing)"); fi
}

require_completed() { # LABEL
  if [[ $J_STATUS != COMPLETED ]]; then
    FAILS+=("$1: job ended $J_STATUS (${J_ERR:-no error text})")
    if [[ $J_ERR == *oom* || $J_ERRCODE == oom ]]; then FAILS+=("$1: OOM"); fi
    summary
  fi
}

summary() {
  local f n
  say ""
  say "================ GATE SUMMARY ================"
  say "csv: $CSV"
  say "estimated spend: \$$(spend_usd) (worker time x \$${WORKER_USD_PER_HR}/hr, cap \$${MAX_SPEND})"
  say "peak VRAM is report-only (nvidia-smi includes the allocator reserve; 46 GiB = ${VRAM_REPORT_MB} MiB): cold-tiny=${V_COLD_TINY:-n/a} warm-def=${V_WARM_DEF:-n/a} warm-def2=${V_WARM_DEF2:-n/a} cold-def=${V_COLD_DEF:-n/a} MiB"
  say "offload: NOT detectable from job data; grep the worker logs for offload/lowvram messages and report them."
  for n in "${NOTES[@]-}"; do if [[ -n $n ]]; then say "note: $n"; fi; done
  if ((${#FAILS[@]})); then
    for f in "${FAILS[@]}"; do say "FAIL: $f"; done
    say "GATE: FAIL"
    exit 1
  fi
  say "GATE: PASS (no OOM, second warm default job within 10% of the first)"
  exit 0
}

# ---------------------------------------------------------------- the gate
TINY='{"mode":"t2v","prompt":"a red ball rolls across a wooden table, soft ambient sound","width":256,"height":256,"num_frames":25,"fps":24,"seed":1234}'
DEF='{"mode":"t2v","prompt":"a red ball rolls across a wooden table in a sunlit room, soft ambient sound","width":1280,"height":704,"num_frames":121,"fps":24,"seed":1234}'
CANARY='{"mode":"i2v","prompt":"smoke canary","input_key":"inputs/__smoke_missing__.png","width":256,"height":256,"num_frames":25}'

say "gate against endpoint $EP ($EP_URL). Billable: RTX 6000 Ada \$1.75/hr, spend cap \$${MAX_SPEND}."

# 1 canary
run_job canary "$CANARY"
if [[ $J_STATUS != FAILED ]]; then
  FAILS+=("canary: expected FAILED, got $J_STATUS"); summary
fi
if [[ $J_ERR == "[input_fetch] input not found"* && ( -z $J_ERRCODE || $J_ERRCODE == input_fetch ) ]]; then
  say "    canary OK: R2 credentials resolved and R2 read works (input_fetch / input not found)"
  if [[ -z $J_ERRCODE ]]; then
    NOTES+=("canary: /status has no separate error_code field; the [input_fetch] prefix in the error text is the accepted safeguard")
  fi
else
  stop "canary: unexpected failure '${J_ERR:-?}' (error_code '${J_ERRCODE:-none}'). 'could not fetch input', config_error, an auth error or any other prefix means the R2 secrets did not resolve or lack read access. Fix before any model load."
fi

# 2 cold tiny
run_job cold-tiny "$TINY"; require_completed cold-tiny
V_COLD_TINY=$J_VRAM
COLD_TINY_TOTAL=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" 'BEGIN{printf "%.1f",(d+e)/1000}')
check_cold cold-tiny
[[ $J_COLD == true ]] || NOTES+=("cold-tiny: cold flag was '$J_COLD' (judge cold by delayTime, not by the flag)")

# 3 warm tiny
run_job warm-tiny "$TINY"; require_completed warm-tiny

# 4 warm default
run_job warm-def "$DEF"; require_completed warm-def
V_WARM_DEF=$J_VRAM
GEN1=$J_GEN
if num_gt "$GEN1" "$WARM_STOP_S"; then stop "warm-def: gen_time_s ${GEN1}s exceeds ${WARM_STOP_S}s."; fi
if num_gt "$GEN1" 180; then NOTES+=("warm-def: gen_time_s ${GEN1}s > 180 s (flag: SPEC 7 cost example assumes ~3 min per clip)"); fi
if num_gt "$(awkf -v a="$COLD_TINY_TOTAL" -v b="$GEN1" 'BEGIN{print a+b}')" "$SUM_STOP_S"; then
  stop "cold-tiny delay+exec (${COLD_TINY_TOTAL}s) + warm default gen_time (${GEN1}s) exceeds ${SUM_STOP_S}s: a first-after-idle default clip would not fit the 780 s job budget."
fi

# 5 second warm default: pass test is within 10%
run_job warm-def2 "$DEF"; require_completed warm-def2
V_WARM_DEF2=$J_VRAM
if awkf -v a="$GEN1" -v b="$J_GEN" 'BEGIN{d=(b>a)?b-a:a-b; exit !(d<=0.10*a)}'; then
  say "    second warm default job gen_time ${J_GEN}s is within 10% of the first (${GEN1}s)"
else
  FAILS+=("warm-def2: gen_time_s ${J_GEN}s differs from the first warm default job (${GEN1}s) by more than 10% (reload / eviction suspected)")
fi

# 6/7 final cold default clip
if ((FINAL_COLD)); then
  say ""
  say "--- waiting for the worker to scale to zero (idle timeout 60 s), up to ${IDLE_WAIT_S}s"
  w0=$SECONDS
  LAST_TICK=$EPOCHREALTIME
  while :; do
    BILLING=1
    if health; then
      if ((H_IDLE + H_RUNNING + H_INIT == 0)); then BILLING=0; fi
    fi
    tick
    if ((BILLING == 0)); then break; fi
    ((SECONDS - w0 < IDLE_WAIT_S)) || stop "worker did not scale to zero within ${IDLE_WAIT_S}s: idle timeout may not be 60 s; check the endpoint (it is billing)."
    sleep "$POLL_S"
  done
  run_job cold-def "$DEF"; require_completed cold-def
  V_COLD_DEF=$J_VRAM
  check_cold cold-def
  [[ $J_COLD == true ]] || NOTES+=("cold-def: cold flag was '$J_COLD' (FlashBoot restore or surviving process?); judge by delayTime")
  TOTAL=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" 'BEGIN{printf "%.1f",(d+e)/1000}')
  say "    user path (cold + default clip): ${TOTAL}s of the 780 s generation budget / ${EXEC_S} s execution timeout"
  if num_gt "$TOTAL" 780; then FAILS+=("cold-def: delay+exec ${TOTAL}s exceeds the 780 s job budget"); fi
fi
summary

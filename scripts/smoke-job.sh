#!/usr/bin/env bash
# Real-GPU gate runner for the jubividia endpoint (docs/decisions/endpoint.md, "Real-GPU gating plan").
# BILLABLE: every job runs on a RunPod RTX 6000 Ada ($1.75/hr). Run only after Ken has seen the quote.
#
#   scripts/smoke-job.sh [--max-spend USD] [--no-r2-check] [--skip-final-cold] [--csv PATH]
#
# Order (cheapest checks first):
#   1 canary     missing-input i2v job. Needs good R2 secrets, never loads models.
#   2 cold-tiny  256x256x25 t2v on a cold worker
#   3 warm-tiny  another tiny job (new seed); its gen_time_s is the no-model-load baseline
#   3b repeat-same  the exact same request as warm-tiny again: must COMPLETE with a NEW output key
#      (ComfyUI caches everything; the worker uses a unique OUTPUT prefix per run so the save node re-runs)
#   4 warm-def   1280x704x121 @24 fps
# Every job uses a different seed (SMOKE_SEED_BASE, +1 per job) so none is a cache hit, except repeat-same.
#   5 warm-def2  same again: must be within 10% of #4 (no encoder eviction / reload)
#   6 wait for scale to zero, then 7 cold-def: the user's real "first job after idle" path
# Uses /run + /status + /health + /cancel only (never /runsync: it sits behind a ~100 s edge timeout).
# The run URL comes from the endpoint's `requestUrls` (GET /serverless/<id>) when present, else RUNPOD_RUN_BASE.
# Cold start = worker start + model-load overhead, where
#   worker start        = delayTime + executionTime - gen_time_s  (queue, worker boot, handler overhead)
#   model-load overhead = gen_time_s of the cold job - gen_time_s of the matching warm job
# (the model load runs inside the first job, so it is part of gen_time_s). The 180 s flag and the
# 600 s hard stop apply to this sum; cold-tiny is compared with warm-tiny, cold-def with warm-def.
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
NUM_RE='^[0-9]+(\.[0-9]+)?$'
TOOL_TIMEOUT_S=${SMOKE_TOOL_TIMEOUT_S:-30}   # ceiling for each aws / ffprobe call

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
  local label=$1 input=$2 t0 st last="" now in_progress_since=-1 waiting fails=0 hfails=0 code m
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
  # A missing, null, empty or non-numeric timing value must never read as 0 (awk would): the 180 s flag
  # and 600 s hard stop could then pass silently. Mark the metrics unavailable; require_completed fails the job.
  J_METRICS=1
  J_BADMETRICS=
  if [[ $J_STATUS == COMPLETED ]]; then
    for m in delayTime:"$J_DELAY" executionTime:"$J_EXEC" gen_time_s:"$J_GEN"; do
      if ! [[ ${m#*:} =~ $NUM_RE ]]; then J_METRICS=0; J_BADMETRICS+=" ${m%%:*}='${m#*:}'"; fi
    done
    if ((J_METRICS)); then
      J_START=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" -v g="$J_GEN" 'BEGIN{printf "%.1f",(d+e)/1000-g}')
    else
      say "    TIMING METRIC UNAVAILABLE:${J_BADMETRICS} (cold start and the 600 s hard stop can not be evaluated)"
    fi
  fi
  J_AUDIO=
  say "    status=$J_STATUS delayTime=${J_DELAY:-?}ms executionTime=${J_EXEC:-?}ms gen_time_s=${J_GEN:-?} cold=${J_COLD:-?} peak_vram_mb=${J_VRAM:-null}"
  if [[ $J_STATUS == COMPLETED ]]; then
    say "    worker start (delayTime + executionTime - gen_time; model load is inside gen_time) = ${J_START:-unavailable} s"
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
  [[ -f $CSV ]] || echo "utc,label,job_id,status,cold_flag,delay_ms,exec_ms,gen_time_s,worker_start_s,peak_vram_mb,key,audio" >"$CSV"
  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$J_ID" "$J_STATUS" \
    "${J_COLD:-}" "${J_DELAY:-}" "${J_EXEC:-}" "${J_GEN:-}" "${J_START:-}" "${J_VRAM:-}" "${J_KEY:-}" "${J_AUDIO:-}" >>"$CSV"
}

# aws against R2 with a ceiling on each call, so a hung tool can not hang the gate. rc 124 = timed out.
aws_r2() {
  AWS_ACCESS_KEY_ID=${CFG[R2_ACCESS_KEY_ID]} AWS_SECRET_ACCESS_KEY=${CFG[R2_SECRET_ACCESS_KEY]} AWS_DEFAULT_REGION=auto \
    timeout "$TOOL_TIMEOUT_S" aws --endpoint-url "https://${CFG[R2_ACCOUNT_ID]}.r2.cloudflarestorage.com" "$@"
}

r2_usable() { # LABEL -> 0 when an R2 check may run (else notes why)
  need_cfg R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  if ! command -v aws >/dev/null; then NOTES+=("$1: R2 check skipped (aws CLI missing)"); say "    R2 check SKIPPED: aws CLI not installed"; return 1; fi
  if [[ $RUNPOD_TEST_MODE == 1 && ${SMOKE_ALLOW_STUB_AWS:-0} != 1 ]]; then
    NOTES+=("$1: R2 check skipped (test mode, no stub aws)"); say "    R2 check SKIPPED: test mode refuses a real aws/Cloudflare call"; return 1
  fi
  return 0
}

# r2_check LABEL: head the three objects, download the mp4, ffprobe for an audio stream.
r2_check() {
  local k tmp ctype probe rc
  if ! r2_usable "$1"; then J_AUDIO=unchecked; return 0; fi
  tmp=$(mktemp -d)
  for k in "$J_KEY" "$J_THUMB" "$J_META"; do
    rc=0
    ctype=$(aws_r2 s3api head-object --bucket "${CFG[R2_BUCKET]}" --key "$k" --query ContentType --output text 2>/dev/null) || rc=$?
    if ((rc == 124)); then
      FAILS+=("$1: aws head-object timed out after ${TOOL_TIMEOUT_S}s for $k"); say "    aws head-object TIMED OUT (${TOOL_TIMEOUT_S}s): $k"; J_AUDIO=unchecked; rm -rf "$tmp"; return 0
    elif ((rc != 0)); then
      FAILS+=("$1: R2 object missing: $k"); say "    R2 MISSING: $k"; continue
    fi
    say "    R2 ok: $k ($ctype)"
  done
  rc=0
  aws_r2 s3 cp "s3://${CFG[R2_BUCKET]}/$J_KEY" "$tmp/out.mp4" >/dev/null 2>&1 || rc=$?
  if ((rc == 124)); then
    FAILS+=("$1: aws download of the mp4 timed out after ${TOOL_TIMEOUT_S}s"); say "    aws download TIMED OUT (${TOOL_TIMEOUT_S}s)"; J_AUDIO=unchecked
  elif ((rc != 0)); then
    FAILS+=("$1: could not download the mp4 from R2"); say "    R2 download failed"
  elif ! command -v ffprobe >/dev/null; then
    J_AUDIO=unchecked; NOTES+=("$1: ffprobe missing, audio unchecked"); say "    audio check SKIPPED: ffprobe not installed"
  else
    # Capture first, then match in bash. `ffprobe | grep -q` made grep exit at the first match,
    # ffprobe got SIGPIPE (141) and pipefail turned a clip WITH audio into "MISSING".
    rc=0
    probe=$(timeout "$TOOL_TIMEOUT_S" ffprobe -v error -show_entries stream=codec_type,duration -of json "$tmp/out.mp4" 2>/dev/null) || rc=$?
    if ((rc == 124)); then
      J_AUDIO=unchecked; FAILS+=("$1: ffprobe timed out after ${TOOL_TIMEOUT_S}s"); say "    ffprobe TIMED OUT (${TOOL_TIMEOUT_S}s)"
    elif [[ $probe =~ \"codec_type\":[[:space:]]*\"audio\" ]]; then
      J_AUDIO=yes; say "    audio stream: present"
    else
      J_AUDIO=NO; FAILS+=("$1: no audio stream in the mp4"); say "    audio stream: MISSING"
    fi
  fi
  rm -rf "$tmp"
}

# repeat_same_checks NEW_KEY NEW_META OLD_META: the repeated request must have produced a real object and a
# sidecar that carries the same prompt and seed but a different job_id.
repeat_same_checks() {
  local new_key=$1 new_meta=$2 old_meta=$3 tmp rc size np ns nj op os oj
  if ((R2_CHECK == 0)) || ! r2_usable repeat-same; then
    NOTES+=("repeat-same: object size and sidecar comparison NOT verified (R2 check off or unavailable)")
    return 0
  fi
  tmp=$(mktemp -d)
  rc=0
  size=$(aws_r2 s3api head-object --bucket "${CFG[R2_BUCKET]}" --key "$new_key" --query ContentLength --output text 2>/dev/null) || rc=$?
  if ((rc == 124)); then FAILS+=("repeat-same: aws head-object timed out after ${TOOL_TIMEOUT_S}s"); rm -rf "$tmp"; return 0; fi
  if ! [[ $size =~ ^[0-9]+$ ]] || ((size == 0)); then
    FAILS+=("repeat-same: the new mp4 $new_key is missing or empty (content length '${size:-none}')")
  else
    say "    repeat-same mp4 exists: $size bytes"
  fi
  rc=0
  aws_r2 s3 cp "s3://${CFG[R2_BUCKET]}/$new_meta" "$tmp/new.json" >/dev/null 2>&1 || rc=$?
  if ((rc == 0)); then aws_r2 s3 cp "s3://${CFG[R2_BUCKET]}/$old_meta" "$tmp/old.json" >/dev/null 2>&1 || rc=$?; fi
  if ((rc != 0)); then
    FAILS+=("repeat-same: could not download the sidecar JSON files (rc $rc)")
  else
    np=$(pyj get prompt <"$tmp/new.json"); op=$(pyj get prompt <"$tmp/old.json")
    ns=$(pyj get seed <"$tmp/new.json"); os=$(pyj get seed <"$tmp/old.json")
    nj=$(pyj get job_id <"$tmp/new.json"); oj=$(pyj get job_id <"$tmp/old.json")
    if [[ -z $np || $np != "$op" || -z $ns || $ns != "$os" ]]; then
      FAILS+=("repeat-same: sidecar prompt/seed differ from the first run (prompt '$np' vs '$op', seed '$ns' vs '$os')")
    elif [[ -z $nj || $nj == "$oj" ]]; then
      FAILS+=("repeat-same: sidecar job_id is not different from the first run ('$nj' vs '$oj')")
    else
      say "    repeat-same sidecar: same prompt and seed ($ns), job_id $nj differs from $oj"
    fi
  fi
  rm -rf "$tmp"
}

# strict: a non-numeric operand is never "greater" (awk would read it as 0); the job that produced it
# is already failed by require_completed, so nothing passes silently
num_gt() {
  [[ $1 =~ $NUM_RE && $2 =~ $NUM_RE ]] || return 1
  awkf -v a="$1" -v b="$2" 'BEGIN{exit !(a>b)}'
}

# Cold start = worker start + model-load overhead.
#   worker start       = delayTime + executionTime - gen_time_s   (queue + worker boot + handler overhead)
#   model-load overhead = gen_time_s of the cold job - gen_time_s of the matching warm job
# The model load happens INSIDE the first job (ComfyUI loads on the first /prompt), so it is part of
# gen_time_s; subtracting gen_time_s from delay+exec alone hides it (a real run showed 2.4 s for a ~120 s load).
cold_report() { # LABEL WORKER_START COLD_GEN WARM_GEN -> COLD_START, notes, flag > 180 s, stop > 600 s
  local label=$1 start=$2 cgen=$3 wgen=$4 overhead v
  for v in "$start" "$cgen" "$wgen"; do
    if ! [[ $v =~ $NUM_RE ]]; then
      say "    $label cold start UNAVAILABLE (worker start '${start}', cold gen '${cgen}', warm gen '${wgen}'): the 180 s flag and 600 s hard stop were NOT evaluated"
      NOTES+=("$label: cold start unavailable, metrics missing or not numeric")
      FAILS+=("$label: cold start could not be computed (worker start '${start}', cold gen '${cgen}', warm gen '${wgen}')")
      COLD_START=
      return 0
    fi
  done
  overhead=$(awkf -v c="$cgen" -v w="$wgen" 'BEGIN{o=c-w; if (o<0) o=0; printf "%.1f", o}')
  COLD_START=$(awkf -v s="$start" -v o="$overhead" 'BEGIN{printf "%.1f", s+o}')
  say "    $label cold start = worker start ${start} s + model-load overhead ${overhead} s (cold gen ${cgen} s - warm gen ${wgen} s) = ${COLD_START} s"
  NOTES+=("$label: cold start ${COLD_START} s = worker start ${start} s + model-load overhead ${overhead} s")
  if num_gt "$COLD_START" "$COLD_HARD_S"; then stop "$label: cold start ${COLD_START}s exceeds the ${COLD_HARD_S}s hard limit."; fi
  if num_gt "$COLD_START" "$COLD_FLAG_S"; then NOTES+=("$label: cold start ${COLD_START}s > ${COLD_FLAG_S}s (flag; propose mitigations, change nothing)"); fi
}

check_worker_start() { # LABEL: even before the overhead is known, a worker start alone above the hard limit stops the gate
  [[ -n $J_START ]] || return 0
  if num_gt "$J_START" "$COLD_HARD_S"; then stop "$1: worker start ${J_START}s exceeds the ${COLD_HARD_S}s hard limit."; fi
}

require_completed() { # LABEL
  if [[ $J_STATUS == COMPLETED && $J_METRICS == 0 ]]; then
    FAILS+=("$1: timing metric unavailable (missing, null, empty or not a number:${J_BADMETRICS}); the cold-start flag and hard stop can not be evaluated")
    summary
  fi
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
# A different seed per job (SEED_BASE, SEED_BASE+1, ...) so no job is a ComfyUI cache hit,
# except the deliberate repeat-same job below.
SEED_NEXT=${SMOKE_SEED_BASE:-1000}
TINY_T='{"mode":"t2v","prompt":"a red ball rolls across a wooden table, soft ambient sound","width":256,"height":256,"num_frames":25,"fps":24,"seed":@@SEED@@}'
DEF_T='{"mode":"t2v","prompt":"a red ball rolls across a wooden table in a sunlit room, soft ambient sound","width":1280,"height":704,"num_frames":121,"fps":24,"seed":@@SEED@@}'
next_input() { # next_input TEMPLATE -> NEXT_INPUT with a fresh seed
  NEXT_INPUT=${1//@@SEED@@/$SEED_NEXT}
  SEED_NEXT=$((SEED_NEXT + 1))
}
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
next_input "$TINY_T"; TINY_COLD=$NEXT_INPUT
run_job cold-tiny "$TINY_COLD"; require_completed cold-tiny
V_COLD_TINY=$J_VRAM
COLD_TINY_GEN=$J_GEN
COLD_TINY_START=$J_START
COLD_TINY_TOTAL=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" 'BEGIN{printf "%.1f",(d+e)/1000}')
check_worker_start cold-tiny
[[ $J_COLD == true ]] || NOTES+=("cold-tiny: cold flag was '$J_COLD' (judge cold by delayTime, not by the flag)")

# 3 warm tiny (a new seed: not a cache hit); its gen_time_s is the no-model-load baseline
next_input "$TINY_T"; TINY_WARM=$NEXT_INPUT
run_job warm-tiny "$TINY_WARM"; require_completed warm-tiny
WARM_TINY_KEY=$J_KEY
WARM_TINY_META=$J_META
cold_report cold-tiny "$COLD_TINY_START" "$COLD_TINY_GEN" "$J_GEN"

# 3b repeat-same: the exact same request again. ComfyUI serves everything from cache; the
# worker must still produce a NEW output file (unique OUTPUT prefix per run).
run_job repeat-same "$TINY_WARM"; require_completed repeat-same
if [[ $J_KEY == "$WARM_TINY_KEY" ]]; then
  FAILS+=("repeat-same: the repeated request returned the SAME output key as warm-tiny ($J_KEY); expected a new one")
else
  say "    repeat-same completed with a new output key ($J_KEY)"
fi
repeat_same_checks "$J_KEY" "$J_META" "$WARM_TINY_META"

# 4 warm default
next_input "$DEF_T"; DEF_WARM=$NEXT_INPUT
run_job warm-def "$DEF_WARM"; require_completed warm-def
V_WARM_DEF=$J_VRAM
GEN1=$J_GEN
if num_gt "$GEN1" "$WARM_STOP_S"; then stop "warm-def: gen_time_s ${GEN1}s exceeds ${WARM_STOP_S}s."; fi
if num_gt "$GEN1" 180; then NOTES+=("warm-def: gen_time_s ${GEN1}s > 180 s (flag: SPEC 7 cost example assumes ~3 min per clip)"); fi
if num_gt "$(awkf -v a="$COLD_TINY_TOTAL" -v b="$GEN1" 'BEGIN{print a+b}')" "$SUM_STOP_S"; then
  stop "cold-tiny delay+exec (${COLD_TINY_TOTAL}s) + warm default gen_time (${GEN1}s) exceeds ${SUM_STOP_S}s: a first-after-idle default clip would not fit the 780 s job budget."
fi

# 5 second warm default: pass test is within 10%
next_input "$DEF_T"; DEF_WARM2=$NEXT_INPUT
run_job warm-def2 "$DEF_WARM2"; require_completed warm-def2
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
  next_input "$DEF_T"; DEF_COLD=$NEXT_INPUT
  run_job cold-def "$DEF_COLD"; require_completed cold-def
  V_COLD_DEF=$J_VRAM
  check_worker_start cold-def
  cold_report cold-def "$J_START" "$J_GEN" "$GEN1"
  [[ $J_COLD == true ]] || NOTES+=("cold-def: cold flag was '$J_COLD' (FlashBoot restore or surviving process?); judge by delayTime")
  TOTAL=$(awkf -v d="$J_DELAY" -v e="$J_EXEC" 'BEGIN{printf "%.1f",(d+e)/1000}')
  say "    user path (cold + default clip): ${TOTAL}s of the 780 s generation budget / ${EXEC_S} s execution timeout"
  if num_gt "$TOTAL" 780; then FAILS+=("cold-def: delay+exec ${TOTAL}s exceeds the 780 s job budget"); fi
fi
summary

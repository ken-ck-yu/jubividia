#!/usr/bin/env bash
# Shared helpers for infra/runpod/apply.sh and scripts/smoke-job.sh. Source it, do not run it.
#
# Rules this file enforces:
#  - config.env is never `source`d: a fixed-key reader parses KEY=value lines only.
#  - secret values never reach argv, stdout, stderr or a temp file. The bearer header
#    goes to curl through a process-substitution config, request bodies through a pipe,
#    and every message goes through redact().
#  - refuses to run under `bash -x` (a trace would print secret values).
#  - every non-GET call goes through api(); under --dry-run it is skipped there, so a
#    dry run can not write.
#  - DELETE exists in exactly one place, api_delete(), which accepts only the kinds
#    pod | endpoint | secret_hf. There is no way to delete a network volume or the two R2
#    secrets from this code (tests/infra/run.sh greps for that).

case $- in *x*) echo "refusing to run under bash -x: a trace would print secret values" >&2; exit 2 ;; esac
if [[ ${SHELLOPTS:-} == *xtrace* || -n ${BASH_XTRACEFD:-} ]]; then
  echo "refusing to run with xtrace enabled (SHELLOPTS/BASH_XTRACEFD): it would print secret values" >&2
  exit 2
fi
set +x

LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$LIB_DIR/../.." && pwd)
CONFIG_ENV=${CONFIG_ENV:-$ROOT/config.env}
DRY_RUN=${DRY_RUN:-0}

# Base URL of the RunPod management REST API: server https://api.runpod.io, all routes
# under /v2 (RunPod's public v2 OpenAPI document). Override with RUNPOD_API_BASE.
API_BASE=${RUNPOD_API_BASE:-https://api.runpod.io/v2}
# Serverless runtime base (/<endpoint>/run, /status/<job>, /health); used by smoke-job.sh.
RUN_BASE=${RUNPOD_RUN_BASE:-https://api.runpod.ai/v2}
# Test mode (set by tests/infra/run.sh): every URL this code requests must be on 127.0.0.1,
# so a test can never reach a real host. Checked again right before each curl.
RUNPOD_TEST_MODE=${RUNPOD_TEST_MODE:-0}
assert_url_allowed() {
  if [[ $RUNPOD_TEST_MODE == 1 && $1 != http://127.0.0.1:* ]]; then
    printf '%s: TEST MODE refuses non-loopback URL %s\n' "${TOOL_NAME:-apply}" "${1%%\?*}" >&2
    exit 4
  fi
}
assert_url_allowed "$API_BASE"
assert_url_allowed "$RUN_BASE"
assert_url_allowed "${GHCR_BASE:-http://127.0.0.1:9}"

# Names fixed by the design note (secret names are immutable on RunPod).
SECRET_R2_KEY_ID=ltx_r2_access_key_id
SECRET_R2_KEY_SECRET=ltx_r2_secret_access_key
SECRET_HF=hf_token_tmp   # the ONLY secret pod-down may delete
POD_NAME=jubividia-models-tmp

# Fixed allowlist of keys read from config.env; anything else is ignored.
ALLOWED_KEYS=(
  RUNPOD_API_KEY HF_TOKEN R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
  IMAGE IMAGE_TAG GIT_REF
  RUNPOD_NETWORK_VOLUME_ID RUNPOD_ENDPOINT_ID RUNPOD_POD_ID
  RUNPOD_SECRET_ID_R2_KEY_ID RUNPOD_SECRET_ID_R2_KEY_SECRET
  RUNPOD_DC RUNPOD_VOLUME_NAME RUNPOD_VOLUME_GB RUNPOD_ENDPOINT_NAME
  RUNPOD_IDLE_TIMEOUT_S RUNPOD_WORKERS_MIN RUNPOD_WORKERS_MAX RUNPOD_EXEC_TIMEOUT_MS
  RUNPOD_QUEUE_DELAY_S RUNPOD_DISK_GB
  RUNPOD_POD_IMAGE RUNPOD_POD_CPU_ID RUNPOD_POD_VCPU SKIP_MOUNT_CHECK
  JOB_TIMEOUT_S COMFY_READY_TIMEOUT_S INPUT_MAX_BYTES POLL_INTERVAL_S VRAM_SAMPLE_S
)
SECRET_KEYS=(RUNPOD_API_KEY HF_TOKEN R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY)
# Keys write_id() may change (ids written back by the tool).
ID_KEYS=(RUNPOD_NETWORK_VOLUME_ID RUNPOD_ENDPOINT_ID RUNPOD_POD_ID
  RUNPOD_SECRET_ID_R2_KEY_ID RUNPOD_SECRET_ID_R2_KEY_SECRET)

declare -gA CFG=()

# ---------------------------------------------------------------- output
redact() {
  local s=$* k v
  for k in "${SECRET_KEYS[@]}"; do
    v=${CFG[$k]-}
    [[ -n $v ]] && s=${s//"$v"/***}
  done
  printf '%s' "$s"
}
say() { printf '%s\n' "$(redact "$*")"; }
warn() { printf 'WARNING: %s\n' "$(redact "$*")" >&2; }
die() { printf '%s: %s\n' "${TOOL_NAME:-apply}" "$(redact "$*")" >&2; exit 1; }

# ---------------------------------------------------------------- config.env
read_config() {
  CFG=()
  [[ -f $CONFIG_ENV ]] || return 0
  local line key val allowed a
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*([A-Z][A-Z0-9_]*)=(.*)$ ]] || continue
    key=${BASH_REMATCH[1]}
    val=${BASH_REMATCH[2]}
    allowed=0
    for a in "${ALLOWED_KEYS[@]}"; do [[ $a == "$key" ]] && { allowed=1; break; }; done
    ((allowed)) || continue
    # one pair of matching quotes is stripped; nothing is expanded or executed
    if [[ $val =~ ^\"([^\"]*)\"[[:space:]]*(#.*)?$ ]]; then val=${BASH_REMATCH[1]}
    elif [[ $val =~ ^\'([^\']*)\'[[:space:]]*(#.*)?$ ]]; then val=${BASH_REMATCH[1]}
    else val=${val%%[[:space:]]#*}; val=${val%"${val##*[![:space:]]}"}; fi
    CFG[$key]=$val
  done <"$CONFIG_ENV"
}

cfg() { # cfg KEY [default]
  local v=${CFG[$1]-}
  if [[ -n $v ]]; then printf '%s' "$v"; else printf '%s' "${2-}"; fi
}

need_cfg() { # need_cfg KEY...  (dies naming the key, never the value)
  local k
  for k in "$@"; do [[ -n ${CFG[$k]-} ]] || die "$k is not set in $CONFIG_ENV"; done
}

write_id() { # write_id KEY VALUE  -- only the id keys; atomic; keeps mode and other lines
  local key=$1 val=${2-} ok=0 k
  for k in "${ID_KEYS[@]}"; do [[ $k == "$key" ]] && ok=1; done
  ((ok)) || die "internal error: write_id refused for $key"
  [[ $val =~ ^[A-Za-z0-9_-]*$ ]] || die "refusing to write an unexpected id value for $key"
  if ((DRY_RUN)); then say "DRY-RUN would write $key=$val to config.env"; return 0; fi
  local tmp="$CONFIG_ENV.tmp.$$" line done_=0
  (
    umask 077
    : >"$tmp"
  ) || die "cannot write next to $CONFIG_ENV. The id is $key=$val: add it to config.env by hand, then re-run."
  if [[ -f $CONFIG_ENV ]]; then
    chmod --reference="$CONFIG_ENV" "$tmp" 2>/dev/null || true
    while IFS= read -r line || [[ -n $line ]]; do
      if ((!done_)) && [[ $line =~ ^[[:space:]]*$key= ]]; then
        printf '%s=%s\n' "$key" "$val" >>"$tmp"
        done_=1
      else
        printf '%s\n' "$line" >>"$tmp"
      fi
    done <"$CONFIG_ENV"
  fi
  ((done_)) || printf '%s=%s\n' "$key" "$val" >>"$tmp"
  mv -f "$tmp" "$CONFIG_ENV" || { rm -f "$tmp"; die "cannot update $CONFIG_ENV. The id is $key=$val: add it by hand, then re-run."; }
  CFG[$key]=$val
}

# ---------------------------------------------------------------- JSON
pyj() { "${PYTHON:-python3}" -I "$LIB_DIR/rpjson.py" "$@"; }

# ---------------------------------------------------------------- HTTP
API_STATUS=0
API_BODY=

# http METHOD URL [BODY]  -> API_STATUS, API_BODY. Key from RUNPOD_API_KEY (config).
http() {
  local method=$1 url=$2 body=${3-} out
  [[ -n ${CFG[RUNPOD_API_KEY]-} ]] || die "RUNPOD_API_KEY is not set in $CONFIG_ENV"
  assert_url_allowed "$url"
  if [[ -n $body ]]; then
    out=$(printf '%s' "$body" | curl -sS --max-time "${HTTP_MAX_TIME:-60}" -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "${CFG[RUNPOD_API_KEY]}") \
      -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "$url" 2>/dev/null) || true
  else
    out=$(curl -sS --max-time "${HTTP_MAX_TIME:-60}" -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "${CFG[RUNPOD_API_KEY]}") \
      -w '\n%{http_code}' "$url" </dev/null 2>/dev/null) || true
  fi
  API_STATUS=${out##*$'\n'}
  [[ $API_STATUS =~ ^[0-9]{3}$ ]] || API_STATUS=000
  API_BODY=${out%$'\n'*}
  [[ $out == *$'\n'* ]] || API_BODY=
}

api() { # api METHOD PATH [BODY] [show]   (non-GET calls are skipped under --dry-run)
  local method=$1 path=$2 body=${3-} show=${4-}
  if [[ $method != GET ]] && ((DRY_RUN)); then
    say "DRY-RUN would $method $path"
    [[ -n $show && -n $body ]] && say "DRY-RUN body: $body"
    API_STATUS=200
    API_BODY='{"id":"dry-run"}'
    return 0
  fi
  http "$method" "$API_BASE$path" "$body"
}

api_ok() { [[ $API_STATUS =~ ^2 ]]; }
api_must() { # api_must WHAT  (dies with the redacted error body on non-2xx)
  api_ok && return 0
  local detail=${API_BODY:0:400}
  die "$1 failed: HTTP $API_STATUS ${detail:-(no body; is $API_BASE reachable?)}"
}

# The only DELETE in this tool. kind is a closed set; volumes and the R2 secrets are not in it.
api_delete() { # api_delete pod|endpoint|secret_hf ID
  local kind=$1 id=$2 path
  [[ $id =~ ^[A-Za-z0-9_-]+$ ]] || die "internal error: bad id for delete"
  case $kind in
    pod) path=/pods/$id ;;
    endpoint) path=/serverless/$id ;;
    secret_hf) path=/account/secrets/$id ;;
    *) die "internal error: delete of '$kind' is not supported by design" ;;
  esac
  api DELETE "$path"
}

find_ids() { # find_ids PATH key=val...  -> ids, one per line (dies on API error)
  local path=$1
  shift
  api GET "$path"
  api_must "GET $path"
  printf '%s' "$API_BODY" | pyj ids "$@"
}

json_get() { printf '%s' "$API_BODY" | pyj get "$1"; }

# ---------------------------------------------------------------- validation
valid_image_tag() { [[ ${1-} =~ ^sha-[0-9a-f]{7,}$ ]]; }
valid_git_ref() { [[ ${1-} =~ ^[0-9a-f]{40}$ ]]; }
valid_uint() { [[ ${1-} =~ ^[0-9]+$ ]]; }

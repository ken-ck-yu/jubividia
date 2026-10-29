#!/usr/bin/env bash
# Shared helpers for infra/cloudflare/apply.sh. Source it, do not run it.
#
# Rules this file enforces (same spirit as infra/runpod/lib.sh):
#  - config.env is never `source`d: a fixed-key reader parses KEY=value lines only.
#  - secret values never reach argv, stdout, stderr or a temp file. The bearer header goes to
#    curl through a process-substitution config, request bodies through a pipe, and every
#    message goes through redact().
#  - refuses to run under `bash -x` (a trace would print secret values).
#  - every Cloudflare call goes through cf(), which checks the method and path against a fixed
#    allowlist for the names this feature owns (Worker jubividia, bucket jubividia-ltx-eu).
#    There is no DELETE, and no code path for Zero Trust / Access or the account workers.dev
#    subdomain (tests/cloudflare/run.sh greps for that).
#  - non-GET calls are skipped under --dry-run.

# shellcheck disable=SC2034  # shared settings are read by apply.sh
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
STATE_DIR=${CF_STATE_DIR:-$ROOT/.scratch/cloudflare}

# Names fixed by the design. Nothing else is ever touched.
WORKER_NAME=jubividia
BUCKET_NAME=jubividia-ltx-eu
OTHER_WORKER_BASELINE=jubilab-website   # read-only: its modified_on is recorded and re-checked
SECRET_NAMES=(RUNPOD_API_KEY RUNPOD_ENDPOINT_ID ALLOWED_EMAILS TEAM_DOMAIN POLICY_AUD)

API_BASE=${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}
# Test mode (set by tests/cloudflare/run.sh): every URL this code requests must be on 127.0.0.1,
# so a test can never reach a real host. Checked again right before each curl.
CF_TEST_MODE=${CF_TEST_MODE:-0}
LOOPBACK_RE='^http://127\.0\.0\.1:[0-9]{1,5}(/[A-Za-z0-9._~/%:+=,-]*)?(\?[A-Za-z0-9._~/%:+=,&-]*)?$'
CURL_NOPROXY=()
if [[ $CF_TEST_MODE == 1 ]]; then CURL_NOPROXY=(--noproxy '*'); fi
assert_url_allowed() {
  if [[ $CF_TEST_MODE == 1 && ! $1 =~ $LOOPBACK_RE ]]; then
    printf '%s: TEST MODE refuses non-loopback URL %s\n' "${TOOL_NAME:-apply}" "${1%%\?*}" >&2
    exit 4
  fi
}
assert_url_allowed "$API_BASE"

# Fixed allowlist of keys read from config.env; anything else is ignored.
ALLOWED_KEYS=(CLOUDFLARE_API_TOKEN R2_ACCOUNT_ID R2_BUCKET RUNPOD_API_KEY UI_RUNPOD_API_KEY RUNPOD_ENDPOINT_ID
  ALLOWED_EMAILS TEAM_DOMAIN POLICY_AUD)
# Values that must never be printed.
SECRET_KEYS=(CLOUDFLARE_API_TOKEN RUNPOD_API_KEY UI_RUNPOD_API_KEY ALLOWED_EMAILS TEAM_DOMAIN POLICY_AUD)

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

# ---------------------------------------------------------------- JSON
pyj() { "${PYTHON:-python3}" -I "$LIB_DIR/cfjson.py" "$@"; }

# ---------------------------------------------------------------- HTTP
API_STATUS=0
API_BODY=

ACCOUNT=
init_account() {
  need_cfg CLOUDFLARE_API_TOKEN R2_ACCOUNT_ID
  [[ ${CFG[R2_ACCOUNT_ID]} =~ ^[0-9a-f]{32}$ ]] || die "R2_ACCOUNT_ID must be the 32-hex Cloudflare account id"
  ACCOUNT=${CFG[R2_ACCOUNT_ID]}
  if [[ -n ${CFG[R2_BUCKET]-} && ${CFG[R2_BUCKET]} != "$BUCKET_NAME" ]]; then
    die "R2_BUCKET in config.env is not $BUCKET_NAME: this tool only ever touches $BUCKET_NAME"
  fi
}

# The only calls this tool may make. Anything else is an internal error.
call_allowed() { # call_allowed METHOD PATH
  local m=$1 p=$2 a=$ACCOUNT w=$WORKER_NAME b=$BUCKET_NAME
  case "$m $p" in
    "GET /user/tokens/verify" | "GET /accounts/$a/tokens/verify") return 0 ;;
    "GET /accounts/$a/workers/subdomain") return 0 ;;
    "GET /accounts/$a/workers/scripts") return 0 ;;
    "GET /accounts/$a/workers/scripts/$w/subdomain" | "POST /accounts/$a/workers/scripts/$w/subdomain") return 0 ;;
    "GET /accounts/$a/workers/scripts/$w/secrets" | "PUT /accounts/$a/workers/scripts/$w/secrets") return 0 ;;
    "GET /accounts/$a/r2/buckets/$b" | "GET /accounts/$a/r2/buckets/$b/lock") return 0 ;;
    "GET /accounts/$a/r2/buckets/$b/lifecycle" | "PUT /accounts/$a/r2/buckets/$b/lifecycle") return 0 ;;
  esac
  return 1
}

# http METHOD URL [BODY]  -> API_STATUS, API_BODY. Bearer token from CLOUDFLARE_API_TOKEN.
http() {
  local method=$1 url=$2 body=${3-} out
  [[ -n ${CFG[CLOUDFLARE_API_TOKEN]-} ]] || die "CLOUDFLARE_API_TOKEN is not set in $CONFIG_ENV"
  assert_url_allowed "$url"
  if [[ -n $body ]]; then
    out=$(printf '%s' "$body" | curl -sS "${CURL_NOPROXY[@]}" --max-time "${HTTP_MAX_TIME:-60}" -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "${CFG[CLOUDFLARE_API_TOKEN]}") \
      -H 'Content-Type: application/json' --data-binary @- -w '\n%{http_code}' "$url" 2>/dev/null) || true
  else
    out=$(curl -sS "${CURL_NOPROXY[@]}" --max-time "${HTTP_MAX_TIME:-60}" -X "$method" -K <(printf 'header = "Authorization: Bearer %s"\n' "${CFG[CLOUDFLARE_API_TOKEN]}") \
      -w '\n%{http_code}' "$url" </dev/null 2>/dev/null) || true
  fi
  API_STATUS=${out##*$'\n'}
  [[ $API_STATUS =~ ^[0-9]{3}$ ]] || API_STATUS=000
  API_BODY=${out%$'\n'*}
  [[ $out == *$'\n'* ]] || API_BODY=
}

cf() { # cf METHOD PATH [BODY] [show]   (non-GET calls are skipped under --dry-run)
  local method=$1 path=$2 body=${3-} show=${4-}
  call_allowed "$method" "$path" || die "internal error: $method $path is not an allowed call (this tool only touches the Worker $WORKER_NAME and the bucket $BUCKET_NAME)"
  if [[ $method != GET ]] && ((DRY_RUN)); then
    say "DRY-RUN would $method $path"
    [[ -n $show && -n $body ]] && say "DRY-RUN body: $body"
    API_STATUS=200
    API_BODY='{"success":true,"result":{}}'
    return 0
  fi
  http "$method" "$API_BASE$path" "$body"
}

api_ok() { [[ $API_STATUS =~ ^2 ]] && printf '%s' "$API_BODY" | pyj ok; }
api_must() { # api_must WHAT  (dies with the redacted error codes on failure)
  api_ok && return 0
  local detail
  detail=$(printf '%s' "$API_BODY" | pyj errors 2>/dev/null || true)
  die "$1 failed: HTTP $API_STATUS ${detail:-(no error body; is $API_BASE reachable and the token valid?)}"
}

json_get() { printf '%s' "$API_BODY" | pyj get "$1"; }

# ---------------------------------------------------------------- unauthenticated probe
PROBE_STATUS=000
PROBE_LOCATION=
# probe URL [extra header]: GET without cookies or credentials, never following redirects.
probe() {
  local url=$1 extra=${2-} out line
  assert_url_allowed "$url"
  local args=(-sS "${CURL_NOPROXY[@]}" --max-time 30 -o /dev/null -D - -w '\n%{http_code}')
  [[ -n $extra ]] && args+=(-H "$extra")
  out=$(curl "${args[@]}" "$url" </dev/null 2>/dev/null) || true
  PROBE_STATUS=${out##*$'\n'}
  [[ $PROBE_STATUS =~ ^[0-9]{3}$ ]] || PROBE_STATUS=000
  PROBE_LOCATION=
  while IFS= read -r line; do
    line=${line%$'\r'}
    if [[ ${line,,} == location:* ]]; then PROBE_LOCATION=${line#*:}; PROBE_LOCATION=${PROBE_LOCATION# }; fi
  done <<<"$out"
}

#!/usr/bin/env bash
# Deploy and verify the jubividia front-end Worker on Cloudflare, idempotently, from config.env.
# Usage: infra/cloudflare/apply.sh [--dry-run] [--refresh-baseline] [--i-confirmed-access] <command>
#   preflight      read-only: token, workers.dev subdomain, baseline of the other Workers, R2 lifecycle
#   lifecycle      add the three R2 lifecycle rules (read, merge, write back; existing rules kept)
#   deploy         deploy the Worker WITHOUT secrets (fails closed), assert the Worker id and settings
#   verify-access  an unauthenticated request must be redirected to the Access login
#   secrets        set the five Worker secrets; only with --i-confirmed-access (and verify-access passing)
#   postcheck      the other Workers are unchanged, ours is as expected
#   teardown       prints the undo steps (makes no call)
# Names are hard-coded: Worker jubividia, bucket jubividia-ltx-eu. The Access application is created by
# Ken in the dashboard; this tool has no Zero Trust scope and no code path for Access.
# See README.md ("UI") and docs/decisions/ui.md. --dry-run makes no Cloudflare write.
# shellcheck disable=SC2015  # "A && B || die ..." is deliberate validation: die exits
set -euo pipefail
# shellcheck disable=SC2034  # read by die() in lib.sh
TOOL_NAME=cloudflare-apply
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CMD=
CONFIRMED_ACCESS=0
REFRESH_BASELINE=0
BASELINE=$STATE_DIR/baseline.json
WORKER_STATE=$STATE_DIR/worker.json

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------- shared reads
SUBDOMAIN=
read_subdomain() {
  cf GET "/accounts/$ACCOUNT/workers/subdomain"
  if [[ $API_STATUS == 404 ]]; then
    die "the account has no workers.dev subdomain. STOP and ask Ken: it is account-wide and this tool never creates or renames it."
  fi
  api_must "read the workers.dev subdomain"
  SUBDOMAIN=$(json_get result.subdomain)
  [[ $SUBDOMAIN =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
    || die "the account has no workers.dev subdomain. STOP and ask Ken: it is account-wide and this tool never creates or renames it."
}

SCRIPTS_JSON='{}'
read_scripts() {
  cf GET "/accounts/$ACCOUNT/workers/scripts"
  api_must "list Workers"
  SCRIPTS_JSON=$(printf '%s' "$API_BODY" | pyj scripts)
}
script_field() { printf '%s' "$SCRIPTS_JSON" | pyj script "$1" "$2"; }

LC_RULES='[]'
read_lifecycle() {
  cf GET "/accounts/$ACCOUNT/r2/buckets/$BUCKET_NAME/lifecycle"
  if [[ $API_STATUS == 404 ]]; then LC_RULES='[]'; return 0; fi
  api_must "read the R2 lifecycle rules"
  LC_RULES=$(printf '%s' "$API_BODY" | pyj lifecycle-rules)
}

need_baseline() {
  [[ -f $BASELINE ]] || { ((DRY_RUN)) && return 0; die "no baseline yet: run '$0 preflight' first"; }
  return 0
}

check_others_unchanged() { # dies when any Worker other than ours differs from the baseline
  local diff
  [[ -f $BASELINE ]] || return 0
  diff=$(printf '%s' "$SCRIPTS_JSON" | pyj snapshot-compare "$BASELINE" "$WORKER_NAME")
  if [[ -n $diff ]]; then
    say "$diff"
    die "a Worker other than $WORKER_NAME changed since the baseline. Stop and tell Ken; nothing here touches it."
  fi
}

# ---------------------------------------------------------------- preflight
cmd_preflight() {
  init_account
  cf GET /user/tokens/verify
  if ! api_ok; then
    cf GET "/accounts/$ACCOUNT/tokens/verify"
    api_must "verify the API token"
  fi
  say "token: valid"
  read_subdomain
  say "workers.dev subdomain: present ($WORKER_NAME will be https://$WORKER_NAME.<subdomain>.workers.dev)"
  read_scripts
  local base_mod mine
  base_mod=$(script_field "$OTHER_WORKER_BASELINE" modified_on)
  [[ -n $base_mod ]] || die "$OTHER_WORKER_BASELINE is not in this account's Worker list: wrong account? Nothing was changed."
  say "baseline: $OTHER_WORKER_BASELINE modified_on=$base_mod (read-only; re-checked by 'postcheck')"
  mine=$(script_field "$WORKER_NAME" created_on)
  if [[ -n $mine ]]; then say "Worker $WORKER_NAME already exists (created_on=$mine)"; else say "Worker $WORKER_NAME does not exist yet"; fi
  cf GET "/accounts/$ACCOUNT/r2/buckets/$BUCKET_NAME"
  api_must "read the bucket $BUCKET_NAME"
  say "bucket: $BUCKET_NAME exists"
  cf GET "/accounts/$ACCOUNT/r2/buckets/$BUCKET_NAME/lock"
  if api_ok && [[ $(json_get result.rules) != "" && $(json_get result.rules) != "[]" ]]; then
    warn "the bucket has lock rules; they override lifecycle expiry. Tell Ken before relying on the lifecycle rules."
  fi
  read_lifecycle
  say "R2 lifecycle: $(printf '%s' "$LC_RULES" | "${PYTHON:-python3}" -I -c 'import json,sys; print(len(json.load(sys.stdin)))') existing rule(s) (kept as they are)"
  printf '%s' "$LC_RULES" | pyj lifecycle-plan | while read -r action id; do say "  lifecycle $action $id"; done

  if [[ -f $BASELINE && $REFRESH_BASELINE == 0 ]]; then
    local diff
    diff=$(printf '%s' "$SCRIPTS_JSON" | pyj snapshot-compare "$BASELINE" "$WORKER_NAME")
    if [[ -n $diff ]]; then
      warn "other Workers differ from the saved baseline (someone edited them since): $diff"
      warn "if that is expected, re-run with --refresh-baseline"
    else
      say "baseline kept: other Workers are unchanged since $(pyj get taken_at <"$BASELINE")"
    fi
    return 0
  fi
  if ((DRY_RUN)); then say "DRY-RUN would write the baseline to $BASELINE"; return 0; fi
  mkdir -p "$STATE_DIR"
  (
    umask 077
    CF_NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ) CF_SUB=$SUBDOMAIN CF_SCRIPTS=$SCRIPTS_JSON CF_RULES=$LC_RULES pyj baseline >"$BASELINE.tmp"
  )
  mv -f "$BASELINE.tmp" "$BASELINE"
  say "baseline written: $BASELINE"
}

# ---------------------------------------------------------------- lifecycle
cmd_lifecycle() {
  init_account
  need_baseline
  read_lifecycle
  local plan
  plan=$(printf '%s' "$LC_RULES" | pyj lifecycle-plan)
  if grep -q '^conflict' <<<"$plan"; then
    say "$plan"
    die "a rule with one of our ids exists with different settings. Not modifying it; tell Ken."
  fi
  if ! grep -q '^add' <<<"$plan"; then
    say "lifecycle: all three rules already in place (no write)"
    return 0
  fi
  say "$plan"
  local body
  body=$(printf '%s' "$LC_RULES" | pyj lifecycle-body)
  cf PUT "/accounts/$ACCOUNT/r2/buckets/$BUCKET_NAME/lifecycle" "$body" show
  api_must "write the lifecycle rules"
  ((DRY_RUN)) && return 0
  read_lifecycle
  if [[ -f $BASELINE ]]; then
    local problems
    problems=$(printf '%s' "$LC_RULES" | pyj lifecycle-check "$BASELINE") || { say "$problems"; die "lifecycle read-back check failed (existing rules must be unchanged and ours present)"; }
  fi
  say "lifecycle: rules added and read back; existing rules unchanged"
}

# ---------------------------------------------------------------- deploy
wrangler_bin() {
  if [[ $CF_TEST_MODE == 1 && -n ${WRANGLER_BIN-} ]]; then printf '%s' "$WRANGLER_BIN"; else printf '%s' "$ROOT/ui/node_modules/.bin/wrangler"; fi
}

assert_worker_state() { # after a deploy: id, creation time, subdomain settings
  read_scripts
  local id created recorded
  id=$(script_field "$WORKER_NAME" id)
  created=$(script_field "$WORKER_NAME" created_on)
  [[ $id == "$WORKER_NAME" ]] || die "the Worker $WORKER_NAME was not found after the deploy (id '$id')"
  if [[ -f $WORKER_STATE ]]; then
    recorded=$(pyj get created_on <"$WORKER_STATE")
    if [[ $recorded != "$created" ]]; then
      die "the Worker was deleted and recreated (created_on $recorded -> $created). The Access application is bound to the Worker id and no longer protects it: re-create the Access app in the dashboard before anything else, and do not set secrets."
    fi
  else
    [[ $created =~ ^[0-9A-Za-z:.+-]+$ ]] || die "unexpected created_on value for the Worker"
    mkdir -p "$STATE_DIR"
    printf '{"id":"%s","created_on":"%s"}\n' "$id" "$created" >"$WORKER_STATE"
    say "recorded Worker identity in $WORKER_STATE (created_on=$created)"
  fi
  say "Worker id: $id (created_on=$created) as recorded"
  local path="/accounts/$ACCOUNT/workers/scripts/$WORKER_NAME/subdomain" enabled previews
  cf GET "$path"
  api_must "read the Worker's workers.dev settings"
  enabled=$(json_get result.enabled)
  previews=$(json_get result.previews_enabled)
  if [[ $enabled != true || $previews != false ]]; then
    warn "workers.dev settings are enabled=$enabled previews_enabled=$previews; setting enabled=true previews_enabled=false"
    cf POST "$path" '{"enabled":true,"previews_enabled":false}' show
    api_must "set the Worker's workers.dev settings"
    cf GET "$path"
    api_must "re-read the Worker's workers.dev settings"
    enabled=$(json_get result.enabled)
    previews=$(json_get result.previews_enabled)
    [[ $enabled == true && $previews == false ]] || die "workers.dev settings did not stick (enabled=$enabled previews_enabled=$previews)"
  fi
  say "workers.dev: enabled, preview URLs off (read back)"
  check_others_unchanged
  say "other Workers unchanged since the baseline"
}

cmd_deploy() {
  init_account
  need_baseline
  local toml=$ROOT/ui/wrangler.toml
  grep -qE '^name[[:space:]]*=[[:space:]]*"jubividia"[[:space:]]*$' "$toml" || die "ui/wrangler.toml name is not \"$WORKER_NAME\""
  grep -qE '^preview_urls[[:space:]]*=[[:space:]]*false[[:space:]]*$' "$toml" || die "ui/wrangler.toml must set preview_urls = false"
  grep -qE '^workers_dev[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$toml" || die "ui/wrangler.toml must set workers_dev = true"
  grep -qE '^run_worker_first[[:space:]]*=[[:space:]]*true[[:space:]]*$' "$toml" || die "ui/wrangler.toml must set run_worker_first = true"
  local wr
  wr=$(wrangler_bin)
  [[ -x $wr ]] || die "wrangler not installed: run 'npm ci' in ui/ first"
  if ((DRY_RUN)); then
    say "DRY-RUN would run: wrangler deploy --name $WORKER_NAME --config ui/wrangler.toml (no secrets are set by a deploy)"
    return 0
  fi
  say "deploying $WORKER_NAME (no secrets: every request answers 503 until 'secrets' runs)"
  (
    cd "$ROOT/ui"
    export CLOUDFLARE_API_TOKEN="${CFG[CLOUDFLARE_API_TOKEN]}" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" WRANGLER_SEND_METRICS=false CI=1
    "$wr" deploy --name "$WORKER_NAME" --config wrangler.toml 2>&1
  ) | while IFS= read -r line || [[ -n $line ]]; do say "  $line"; done || die "wrangler deploy failed (see the output above)"
  assert_worker_state
}

# ---------------------------------------------------------------- verify-access
worker_url() {
  if [[ $CF_TEST_MODE == 1 && -n ${CF_WORKER_URL-} ]]; then printf '%s' "$CF_WORKER_URL"; return 0; fi
  read_subdomain
  printf 'https://%s.%s.workers.dev' "$WORKER_NAME" "$SUBDOMAIN"
}

access_redirect_ok() { # access_redirect_ok LABEL URL [header] -> 0 when it redirects to the Access login
  local label=$1 url=$2 extra=${3-} want
  probe "$url" "$extra"
  case $PROBE_STATUS in
    301 | 302 | 303 | 307 | 308) ;;
    200) say "FAIL $label: HTTP 200, the app is served without a login"; return 1 ;;
    *) say "FAIL $label: HTTP $PROBE_STATUS, expected a redirect to the Access login (503/403 means the Worker answered itself: the Access app is missing or not attached to this Worker)"; return 1 ;;
  esac
  [[ $PROBE_LOCATION =~ ^https://[A-Za-z0-9-]+\.cloudflareaccess\.com/ ]] \
    || { say "FAIL $label: redirected, but not to a cloudflareaccess.com login"; return 1; }
  want=${CFG[TEAM_DOMAIN]-}
  if [[ -n $want && $PROBE_LOCATION != "${want%/}/"* ]]; then
    say "FAIL $label: redirected to a different team than TEAM_DOMAIN"
    return 1
  fi
  say "ok   $label: HTTP $PROBE_STATUS to the Access login"
  return 0
}

verify_access() {
  local base failed=0
  base=$(worker_url)
  access_redirect_ok "GET /" "$base/" || failed=1
  access_redirect_ok "GET /api/state" "$base/api/state" || failed=1
  access_redirect_ok "forged Cf-Access-Jwt-Assertion" "$base/" "Cf-Access-Jwt-Assertion: forged.invalid.token" || failed=1
  return $failed
}

cmd_verify_access() {
  init_account
  if verify_access; then
    say "verify-access: PASS (unauthenticated requests are redirected to the Access login; the app is never served)"
  else
    die "verify-access: FAIL. Do not set secrets. Create or fix the Access application (README, UI section), then re-run."
  fi
}

# ---------------------------------------------------------------- secrets
cmd_secrets() {
  ((CONFIRMED_ACCESS)) || die "refusing to set secrets without --i-confirmed-access (Ken must first confirm the Access app works on his phone)"
  init_account
  need_cfg UI_RUNPOD_API_KEY RUNPOD_ENDPOINT_ID ALLOWED_EMAILS TEAM_DOMAIN POLICY_AUD
  [[ ${CFG[UI_RUNPOD_API_KEY]} != "$(cfg RUNPOD_API_KEY)" ]] \
    || die "UI_RUNPOD_API_KEY equals RUNPOD_API_KEY: the Worker needs its own key restricted to the endpoint"
  [[ ${CFG[RUNPOD_ENDPOINT_ID]} =~ ^[A-Za-z0-9_-]{4,64}$ ]] || die "RUNPOD_ENDPOINT_ID looks malformed"
  local em
  while IFS= read -r em; do
    em=${em//[[:space:]]/}
    [[ -z $em ]] && continue
    [[ $em =~ ^[^@,]+@[^@,]+\.[^@,]+$ ]] || die "ALLOWED_EMAILS must be a comma-separated list of email addresses"
  done < <(printf '%s\n' "${CFG[ALLOWED_EMAILS]//,/$'\n'}")
  [[ ${CFG[TEAM_DOMAIN]} =~ ^https://[A-Za-z0-9-]+\.cloudflareaccess\.com$ ]] || die "TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com (no trailing slash)"
  [[ ${CFG[POLICY_AUD]} =~ ^[A-Za-z0-9]{16,128}$ ]] || die "POLICY_AUD must be the Access application's AUD tag"
  say "re-checking the Access redirect before any secret is set"
  verify_access || die "verify-access failed; not setting secrets"
  local name value
  for name in "${SECRET_NAMES[@]}"; do
    case $name in
      RUNPOD_API_KEY) value=${CFG[UI_RUNPOD_API_KEY]} ;;
      *) value=${CFG[$name]} ;;
    esac
    cf PUT "/accounts/$ACCOUNT/workers/scripts/$WORKER_NAME/secrets" "$(S_NAME=$name S_VALUE=$value pyj body-secret)"
    api_must "set secret $name"
    say "secret set: $name"
  done
  if ((DRY_RUN)); then return 0; fi
  cf GET "/accounts/$ACCOUNT/workers/scripts/$WORKER_NAME/secrets"
  api_must "list the Worker's secrets"
  local names
  names=$(printf '%s' "$API_BODY" | pyj secret-names | sort | tr '\n' ' ')
  for name in "${SECRET_NAMES[@]}"; do
    [[ " $names" == *" $name "* ]] || die "secret $name is missing after the write"
  done
  say "secrets present (names only): $names"
}

# ---------------------------------------------------------------- postcheck
cmd_postcheck() {
  init_account
  [[ -f $BASELINE ]] || die "no baseline: run preflight first"
  read_scripts
  check_others_unchanged
  say "other Workers: unchanged since the baseline (including $OTHER_WORKER_BASELINE)"
  local id
  id=$(script_field "$WORKER_NAME" id)
  [[ $id == "$WORKER_NAME" ]] || die "Worker $WORKER_NAME not found"
  assert_worker_state
  read_lifecycle
  local problems
  problems=$(printf '%s' "$LC_RULES" | pyj lifecycle-check "$BASELINE") || { say "$problems"; die "lifecycle check failed"; }
  say "lifecycle: our three rules present, existing rules unchanged"
  cf GET "/accounts/$ACCOUNT/workers/scripts/$WORKER_NAME/secrets"
  api_must "list the Worker's secrets"
  say "secrets (names only): $(printf '%s' "$API_BODY" | pyj secret-names | sort | tr '\n' ' ')"
  say "postcheck: PASS"
}

cmd_teardown() {
  cat <<EOF
Teardown notes (this tool makes no delete call; run the steps yourself, in this order):
  1. Remove the Access application for the Worker in the dashboard (Zero Trust > Access > Applications), or
     leave it: without secrets the Worker answers 503 to everyone.
  2. Remove the Worker's secrets so nothing can spend: dashboard (Workers > $WORKER_NAME > Settings >
     Variables and Secrets) or: (cd ui && npx wrangler secret delete <NAME> --name $WORKER_NAME) for each of
     ${SECRET_NAMES[*]}. Deleting RUNPOD_API_KEY alone stops all spend.
  3. Delete the Worker: (cd ui && npx wrangler delete --name $WORKER_NAME). Never any other name.
     Note: deleting and recreating the Worker orphans an Access app bound to the old Worker id.
  4. R2 lifecycle rules (inputs-expire-7d, state-expire-40d, abort-multipart-1d) can stay; remove one with
     'npx wrangler r2 bucket lifecycle remove $BUCKET_NAME --name <rule>'. Objects already expired are gone.
  5. Revoke the Cloudflare API token in the dashboard and delete CLOUDFLARE_API_TOKEN from config.env.
EOF
}

# ---------------------------------------------------------------- main
while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --refresh-baseline) REFRESH_BASELINE=1 ;;
    --i-confirmed-access) CONFIRMED_ACCESS=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [[ -z $CMD ]] || die "one command at a time (got '$CMD' and '$1')"; CMD=$1 ;;
  esac
  shift
done
[[ -n $CMD ]] || { usage >&2; exit 2; }

read_config
case $CMD in
  preflight) cmd_preflight ;;
  lifecycle) cmd_lifecycle ;;
  deploy) cmd_deploy ;;
  verify-access) cmd_verify_access ;;
  secrets) cmd_secrets ;;
  postcheck) cmd_postcheck ;;
  teardown) cmd_teardown ;;
  *) die "unknown command '$CMD'" ;;
esac

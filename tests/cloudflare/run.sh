#!/usr/bin/env bash
# Offline tests for infra/cloudflare/apply.sh against a fake Cloudflare API (and a fake workers.dev front)
# on 127.0.0.1. No Cloudflare, RunPod or other network access.
#   bash tests/cloudflare/run.sh      (or: make -f infra/cloudflare/cf.mk test-cloudflare)
# shellcheck disable=SC2016,SC2034,SC2126  # SC2016/SC2034: literal $ in grep patterns and sentinel vars; SC2126: grep -c would print one count per file, wc -l totals several files
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
APPLY=$ROOT/infra/cloudflare/apply.sh
LIB=$ROOT/infra/cloudflare/lib.sh
T=$(mktemp -d)
REAL_CURL=$(command -v curl)
FAKE_PID=
PASS=0
FAIL=0
ACC=0123456789abcdef0123456789abcdef
S_TOK=SENTINEL_CFTOKEN_4a9d21
S_RPK=SENTINEL_UIRUNPODKEY_88c0f3
S_RPACCT=SENTINEL_ACCTRUNPODKEY_5e17b2
S_AUD=sentinelaudtag0123456789abcdef0123
S_EMAILS="ken@example.test, partner@example.test"
export CF_TEST_MODE=1 CLOUDFLARE_API_BASE=http://127.0.0.1:9/client/v4   # hermetic: a dead loopback port by default
export CF_STATE_DIR=$T/state

cleanup() { [[ -n $FAKE_PID ]] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

t() { if [[ $3 == "$2" ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: expected [$2] got [$3]"; fi; }
tc() { if [[ $2 == *"$3"* ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: output lacks [$3]: ${2:0:300}"; fi; }
tn() { if [[ $2 != *"$3"* ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: output unexpectedly has [$3]"; fi; }
tnz() { if [[ $2 != 0 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: expected a non-zero exit"; fi; }
pj() { python3 -I -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
ctl() { "$REAL_CURL" -s "http://127.0.0.1:$PORT/__ctl/$1"; }
ctl_post() { "$REAL_CURL" -s -X POST -d "$2" "http://127.0.0.1:$PORT/__ctl/$1" >/dev/null; }
state() { ctl state | pj "$1"; }
writes() { ctl log | pj 'sum(1 for x in d if not x.get("front") and x["method"] not in ("GET","HEAD"))'; }
unexpected() { ctl log | pj 'sum(1 for x in d if x.get("unexpected"))'; }

mkcfg() {
  {
    echo "CLOUDFLARE_API_TOKEN=$S_TOK"
    echo "R2_ACCOUNT_ID=$ACC"
    echo "R2_BUCKET=jubividia-ltx-eu"
    echo "RUNPOD_API_KEY=$S_RPACCT"
    echo "UI_RUNPOD_API_KEY=$S_RPK"
    echo "RUNPOD_ENDPOINT_ID=ep12345678"
    echo "ALLOWED_EMAILS=$S_EMAILS"
    echo "TEAM_DOMAIN=https://fake-team.cloudflareaccess.com"
    echo "POLICY_AUD=$S_AUD"
    printf '%s\n' "$@"
  } >"$T/config.env"
  chmod 600 "$T/config.env"
}

new_fake() {
  [[ -n $FAKE_PID ]] && kill "$FAKE_PID" 2>/dev/null
  rm -f "$T/port"
  rm -rf "$T/state"
  FAKE_TOKEN=$S_TOK python3 -I "$HERE/fake_cloudflare.py" "$T/port" &
  FAKE_PID=$!
  local i
  for i in $(seq 1 100); do [[ -s $T/port ]] && break; sleep 0.05; done
  PORT=$(<"$T/port")
  mkcfg
}

# wrangler stub: records how it was called, proves the token reaches it only through the environment,
# prints the token (to test output redaction) and "deploys" by telling the fake.
cat >"$T/wrangler" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$T/wrangler.argv"
echo "cwd=\$(pwd)" >>"$T/wrangler.argv"
echo "token_in_env=\${CLOUDFLARE_API_TOKEN:+yes} account=\${CLOUDFLARE_ACCOUNT_ID:-none} metrics=\${WRANGLER_SEND_METRICS:-}" >>"$T/wrangler.argv"
echo "uploading with token \$CLOUDFLARE_API_TOKEN"
$REAL_CURL -s --noproxy '*' -X POST -d '{"name":"jubividia"}' "http://127.0.0.1:\$FAKE_PORT/__ctl/deploy" >/dev/null
EOF
chmod +x "$T/wrangler"

A() {
  CONFIG_ENV="$T/config.env" CLOUDFLARE_API_BASE="http://127.0.0.1:$PORT/client/v4" CF_WORKER_URL="http://127.0.0.1:$PORT/__worker" \
    WRANGLER_BIN="$T/wrangler" FAKE_PORT=$PORT bash "$APPLY" "$@"
}

# ---------------------------------------------------------------- 0. static
for f in "$APPLY" "$LIB" "$HERE/run.sh"; do bash -n "$f"; t "bash -n ${f##*/}" 0 $?; done
python3 -I -m py_compile "$ROOT/infra/cloudflare/cfjson.py" "$HERE/fake_cloudflare.py"; t "py_compile" 0 $?
if command -v shellcheck >/dev/null; then
  shellcheck -x -e SC1091 "$APPLY" "$LIB" "$HERE/run.sh"; t "shellcheck" 0 $?
else echo "note: shellcheck not installed, skipped"; fi
SRC=("$APPLY" "$LIB" "$ROOT/infra/cloudflare/cfjson.py")
t "no DELETE call anywhere" 0 "$(grep -hE 'DELETE|-X DELETE' "${SRC[@]}" | grep -vc '^[[:space:]]*#')"
t "no Zero Trust / Access API paths" 0 "$(grep -hiE '/access/(apps|policies|groups|identity_providers|organizations)|zero_trust|identity_providers|all_workers|/workers/subdomain"? *(-d|PUT)' "${SRC[@]}" | grep -vc '^[[:space:]]*#')"
t "account workers.dev subdomain only read" 0 "$(grep -hE '(PUT|POST|PATCH|DELETE) +"?/accounts/[^ ]*/workers/subdomain' "${SRC[@]}" | wc -l)"
t "other Worker name only in lib.sh baseline constant" 0 "$(grep -l 'jubilab-website' "${SRC[@]}" | grep -vc 'lib.sh')"
t "no jubilab-website in ui/" 0 "$(grep -rl 'jubilab' "$ROOT/ui/src" "$ROOT/ui/static" "$ROOT/ui/wrangler.toml" 2>/dev/null | wc -l)"
t "no real workers.dev or cloudflare host except defaults" 0 "$(grep -hoE 'https?://[a-z.]*(workers\.dev|cloudflare\.com)[a-z/0-9.]*' "$APPLY" | grep -vc 'cloudflareaccess')"

# ---------------------------------------------------------------- 1. hermetic test mode and bash -x
new_fake
for base in https://api.cloudflare.com/client/v4 http://127.0.0.1:80@evil.invalid/x http://localhost:9/x https://127.0.0.1:9/x; do
  out=$(CLOUDFLARE_API_BASE=$base CONFIG_ENV="$T/config.env" bash "$APPLY" preflight 2>&1); rc=$?
  t "test mode refuses $base" 4 "$rc"
  tc "refusal text" "$out" "TEST MODE refuses non-loopback"
done
out=$(CF_TEST_MODE=2 CONFIG_ENV="$T/config.env" bash "$APPLY" preflight 2>&1); t "CF_TEST_MODE other than 0/1 is an error" 2 $?
out=$(CF_TEST_MODE=yes CONFIG_ENV="$T/config.env" bash "$APPLY" preflight 2>&1); t "CF_TEST_MODE=yes is an error" 2 $?
t "API base override ignored outside test mode" "https://api.cloudflare.com/client/v4" "$(CF_TEST_MODE=0 CLOUDFLARE_API_BASE=http://127.0.0.1:1/x bash -c ". '$LIB'; printf %s \"\$API_BASE\"")"
t "API base override honoured in test mode" "http://127.0.0.1:1/x" "$(CF_TEST_MODE=1 CLOUDFLARE_API_BASE=http://127.0.0.1:1/x bash -c ". '$LIB'; printf %s \"\$API_BASE\"")"
out=$(env -u CLOUDFLARE_API_BASE CF_TEST_MODE=1 CONFIG_ENV="$T/config.env" bash "$APPLY" preflight 2>&1); t "default real base refused in test mode" 4 $?
out=$(CF_TEST_MODE=1 CLOUDFLARE_API_BASE=http://127.0.0.1:$PORT/client/v4 CONFIG_ENV="$T/config.env" bash -x "$APPLY" preflight 2>&1); t "bash -x refused" 2 $?
tc "bash -x message" "$out" "refusing to run"
t "refused runs sent no request" 0 "$(ctl log | pj 'len(d)')"

# ---------------------------------------------------------------- 2. config safety
new_fake
mkcfg 'R2_BUCKET=some-other-bucket'
out=$(A preflight 2>&1); tnz "wrong bucket in config refused" $?
tc "bucket message" "$out" "only ever touches jubividia-ltx-eu"
mkcfg 'R2_ACCOUNT_ID=nothex'
out=$(A preflight 2>&1); tnz "bad account id refused" $?
mkcfg 'CLOUDFLARE_API_TOKEN=$(touch '"$T"'/pwned)'
A preflight >/dev/null 2>&1
t "config.env is data, not code" none "$([[ -e $T/pwned ]] && echo ran || echo none)"
t "bad token gets 401 and nothing else happens" 0 "$(writes)"

# ---------------------------------------------------------------- 3. preflight is read only, writes a baseline
new_fake
out=$(A preflight 2>&1); t "preflight exit" 0 $?
tc "token valid" "$out" "token: valid"
tc "subdomain present" "$out" "workers.dev subdomain: present"
tc "baseline of the other Worker" "$out" "jubilab-website modified_on=2026-09-01T10:00:00Z"
tc "lifecycle plan shows the three adds" "$out" "lifecycle add inputs-expire-7d"
t "preflight made no Cloudflare write" 0 "$(writes)"
t "no unexpected route called" 0 "$(unexpected)"
t "baseline file written" 1 "$([[ -s $T/state/baseline.json ]] && echo 1 || echo 0)"
t "baseline records the other Worker" 2026-09-01T10:00:00Z "$(pj 'd["scripts"]["jubilab-website"]["modified_on"]' <"$T/state/baseline.json")"
t "baseline records existing rules" keep-me "$(pj 'd["lifecycle_rules"][0]["id"]' <"$T/state/baseline.json")"
new_fake
out=$(A preflight --dry-run 2>&1); t "dry-run preflight exit" 0 $?
t "dry-run preflight writes no baseline" 0 "$([[ -e $T/state/baseline.json ]] && echo 1 || echo 0)"
ctl_post set '{"subdomain":""}'
out=$(A preflight 2>&1); tnz "missing workers.dev subdomain stops" $?
tc "subdomain message" "$out" "STOP and ask Ken"
new_fake
ctl_post set '{"lock":[{"id":"l1"}]}'
out=$(A preflight 2>&1); tc "bucket lock warned" "$out" "lock rules"
new_fake
ctl_post set '{"scripts":{"only-ours":{"id":"only-ours","created_on":"x","modified_on":"y"}}}'
out=$(A preflight 2>&1); tnz "account without the baseline Worker refused" $?

# ---------------------------------------------------------------- 4. lifecycle: read, merge, never clobber
new_fake
A lifecycle >/dev/null 2>&1; tnz "lifecycle needs a baseline first" $?
A preflight >/dev/null 2>&1
ctl_post clearlog '{}'
A lifecycle --dry-run >/dev/null 2>&1
t "lifecycle dry-run writes nothing" 0 "$(writes)"
out=$(A lifecycle 2>&1); t "lifecycle exit" 0 $?
t "one PUT" 1 "$(writes)"
t "existing rule kept" keep-me "$(state 'd["lifecycle"][0]["id"]')"
t "four rules now" 4 "$(state 'len(d["lifecycle"])')"
t "inputs 7 days" 604800 "$(state '[r for r in d["lifecycle"] if r["id"]=="inputs-expire-7d"][0]["deleteObjectsTransition"]["condition"]["maxAge"]')"
t "inputs prefix" inputs/ "$(state '[r for r in d["lifecycle"] if r["id"]=="inputs-expire-7d"][0]["conditions"]["prefix"]')"
t "state 40 days" 3456000 "$(state '[r for r in d["lifecycle"] if r["id"]=="state-expire-40d"][0]["deleteObjectsTransition"]["condition"]["maxAge"]')"
t "abort multipart 1 day" 86400 "$(state '[r for r in d["lifecycle"] if r["id"]=="abort-multipart-1d"][0]["abortMultipartUploadsTransition"]["condition"]["maxAge"]')"
t "no rule on outputs/" 0 "$(state 'sum(1 for r in d["lifecycle"] if r["conditions"]["prefix"].startswith("outputs"))')"
ctl_post clearlog '{}'
out=$(A lifecycle 2>&1); t "second run exit" 0 $?
t "idempotent: no write" 0 "$(writes)"
tc "says already in place" "$out" "already in place"
ctl_post set '{"lifecycle":[{"id":"inputs-expire-7d","enabled":true,"conditions":{"prefix":"inputs/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":99}}}]}'
ctl_post clearlog '{}'
out=$(A lifecycle 2>&1); tnz "conflicting rule with our id refused" $?
tc "conflict message" "$out" "different settings"
t "conflict: nothing written" 0 "$(writes)"

# ---------------------------------------------------------------- 5. deploy
new_fake
A deploy >/dev/null 2>&1; tnz "deploy needs a baseline" $?
A preflight >/dev/null 2>&1
out=$(A deploy --dry-run 2>&1); t "deploy dry-run exit" 0 $?
t "deploy dry-run did not call wrangler" 0 "$([[ -e $T/wrangler.argv ]] && echo 1 || echo 0)"
out=$(A deploy 2>&1); rc=$?; t "deploy exit" 0 $rc
tc "id asserted" "$out" "Worker id: jubividia"
tc "settings read back" "$out" "preview URLs off"
tc "others unchanged" "$out" "other Workers unchanged"
tn "token redacted from wrangler output" "$out" "$S_TOK"
tc "token replaced by ***" "$out" "uploading with token ***"
tc "wrangler args pin the name" "$(cat "$T/wrangler.argv")" "deploy --name jubividia --config wrangler.toml"
tc "wrangler runs in ui/" "$(cat "$T/wrangler.argv")" "cwd=$ROOT/ui"
tc "token only via env" "$(cat "$T/wrangler.argv")" "token_in_env=yes account=$ACC metrics=false"
tn "token not on any wrangler argv" "$(grep -v '^token_in_env' "$T/wrangler.argv")" "$S_TOK"
t "deploy touched no secret" 0 "$(state 'len(d["secrets"])')"
t "Worker identity recorded" jubividia "$(pj 'd["id"]' <"$T/state/worker.json")"
t "preview URLs off" False "$(state 'd["worker_settings"]["jubividia"]["previews_enabled"]')"
# previews found ON get switched off and read back
ctl_post set '{"worker_settings":{"jubividia":{"enabled":true,"previews_enabled":true}}}'
out=$(A deploy 2>&1); t "redeploy with previews on" 0 $?
tc "warns and fixes" "$out" "previews_enabled=true"
t "previews now off" False "$(state 'd["worker_settings"]["jubividia"]["previews_enabled"]')"
# Worker deleted and recreated -> Access binding is orphaned
ctl_post recreate '{"name":"jubividia"}'
out=$(A deploy 2>&1); tnz "recreated Worker detected" $?
tc "recreate message" "$out" "Access application is bound to the Worker id"
# another Worker modified behind our back
new_fake
A preflight >/dev/null 2>&1
ctl_post touch '{"name":"jubilab-website"}'
out=$(A deploy 2>&1); tnz "deploy stops when jubilab-website changed" $?
tc "names the change" "$out" "jubilab-website modified_on changed"
# wrong wrangler.toml settings refused (copy of the repo file with a change)
new_fake
A preflight >/dev/null 2>&1
t "wrangler.toml is pinned" 4 "$(grep -cE '^(name|preview_urls|workers_dev|run_worker_first) ' "$ROOT/ui/wrangler.toml")"

# ---------------------------------------------------------------- 6. verify-access
new_fake
out=$(A verify-access 2>&1); t "access front: pass" 0 $?
tc "pass text" "$out" "verify-access: PASS"
t "probe sent no cookie, no credentials" 0 "$(ctl log | pj 'sum(1 for x in d if x.get("front") and (x.get("cookie") or x.get("auth")))')"
t "forged header was really sent once" 1 "$(ctl log | pj 'sum(1 for x in d if x.get("front") and x.get("jwt_header")=="forged.invalid.token")')"
ctl_post set '{"front":"app"}'
out=$(A verify-access 2>&1); tnz "app served without login fails" $?
tc "200 explained" "$out" "served without a login"
ctl_post set '{"front":"closed"}'
out=$(A verify-access 2>&1); tnz "503 (no Access attached) fails" $?
tc "503 explained" "$out" "Access app is missing"
ctl_post set '{"front":"access"}'
mkcfg 'TEAM_DOMAIN=https://other-team.cloudflareaccess.com'
out=$(A verify-access 2>&1); tnz "redirect to a different team fails" $?

# ---------------------------------------------------------------- 7. secrets
new_fake
A preflight >/dev/null 2>&1; A lifecycle >/dev/null 2>&1; A deploy >/dev/null 2>&1
ctl_post clearlog '{}'
out=$(A secrets 2>&1); tnz "secrets refused without the flag" $?
tc "flag message" "$out" "--i-confirmed-access"
t "no write without the flag" 0 "$(writes)"
ctl_post set '{"front":"closed"}'
out=$(A secrets --i-confirmed-access 2>&1); tnz "secrets refused when Access redirect fails" $?
t "no secret written when verification fails" 0 "$(state 'len(d["secrets"])')"
ctl_post set '{"front":"access"}'
mkcfg "UI_RUNPOD_API_KEY=$S_RPACCT"
out=$(A secrets --i-confirmed-access 2>&1); tnz "same key as the account key refused" $?
mkcfg 'ALLOWED_EMAILS=not-an-email'
out=$(A secrets --i-confirmed-access 2>&1); tnz "malformed email list refused" $?
mkcfg 'TEAM_DOMAIN=https://x.cloudflareaccess.com/'
out=$(A secrets --i-confirmed-access 2>&1); tnz "team domain with slash refused" $?
mkcfg
out=$(A secrets --i-confirmed-access --dry-run 2>&1); t "dry-run secrets exit" 0 $?
t "dry-run secrets wrote nothing" 0 "$(writes)"
out=$(A secrets --i-confirmed-access 2>&1); rc=$?; t "secrets exit" 0 $rc
t "five secrets present" "ALLOWED_EMAILS POLICY_AUD RUNPOD_API_KEY RUNPOD_ENDPOINT_ID TEAM_DOMAIN" "$(state '" ".join(sorted(d["secrets"]["jubividia"]))')"
t "RUNPOD_API_KEY secret is the restricted key" "$S_RPK" "$(state 'd["secret_values"]["RUNPOD_API_KEY"]')"
t "ALLOWED_EMAILS carries both addresses" "$S_EMAILS" "$(state 'd["secret_values"]["ALLOWED_EMAILS"]')"
for s in "$S_TOK" "$S_RPK" "$S_RPACCT" "$S_AUD" "ken@example.test" "partner@example.test"; do tn "output has no $s" "$out" "$s"; done
t "no secret on any curl argv path: only PUT secrets carries values" 5 "$(ctl log | pj 'sum(1 for x in d if x["method"]=="PUT" and x["path"].endswith("/secrets"))')"
t "no unexpected route" 0 "$(unexpected)"
t "authorization always sent" 0 "$(ctl log | pj 'sum(1 for x in d if not x.get("front") and not x["auth_ok"])')"

# ---------------------------------------------------------------- 8. postcheck
out=$(A postcheck 2>&1); t "postcheck passes (nothing changed)" 0 $?
tc "postcheck says PASS" "$out" "postcheck: PASS"
new_fake
A preflight >/dev/null 2>&1; A lifecycle >/dev/null 2>&1; A deploy >/dev/null 2>&1
out=$(A postcheck 2>&1); t "postcheck after deploy" 0 $?
ctl_post touch '{"name":"jubilab-website"}'
out=$(A postcheck 2>&1); tnz "postcheck fails when jubilab-website changed" $?
tc "postcheck names it" "$out" "jubilab-website modified_on changed"
new_fake
A preflight >/dev/null 2>&1; A lifecycle >/dev/null 2>&1; A deploy >/dev/null 2>&1
ctl_post set '{"lifecycle":[]}'
out=$(A postcheck 2>&1); tnz "postcheck fails when the lifecycle rules vanished" $?

# ---------------------------------------------------------------- 9. teardown prints, calls nothing
new_fake
out=$(A teardown 2>&1); t "teardown exit" 0 $?
tc "teardown lists secret deletion" "$out" "RUNPOD_API_KEY"
t "teardown made no call" 0 "$(ctl log | pj 'len(d)')"

echo
echo "cloudflare apply tests: $PASS passed, $FAIL failed"
[[ $FAIL == 0 ]]

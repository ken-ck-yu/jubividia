#!/usr/bin/env bash
# Offline tests for infra/runpod/apply.sh and scripts/smoke-job.sh against a fake
# RunPod REST/runtime server on 127.0.0.1. No RunPod, Cloudflare or other network access.
#   make -f infra/runpod/infra.mk test-infra
# shellcheck disable=SC1087,SC2016,SC2034  # SC1087: "$E['x']" is a shell variable followed by a Python subscript inside a string handed to python; SC2016: single quotes keep literal $ / backticks on purpose (injection tests, grep patterns); SC2034: seq loop only counts
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
APPLY=$ROOT/infra/runpod/apply.sh
SMOKE=$ROOT/scripts/smoke-job.sh
T=$(mktemp -d)
REAL_CURL=$(command -v curl)
SHIM=$T/shim
mkdir -p "$SHIM" "$T/tmp"
FAKE_PID=
PASS=0
FAIL=0
# Hermetic by default: any invocation that forgets to set its own base URL hits a dead
# loopback port, never a real host.
export RUNPOD_API_BASE=http://127.0.0.1:9/v2 RUNPOD_RUN_BASE=http://127.0.0.1:9/rt GHCR_BASE=http://127.0.0.1:9/ghcr
# Test mode: lib.sh refuses any URL that is not http://127.0.0.1:* (asserted in section 0b).
export RUNPOD_TEST_MODE=1

# Sentinels: must never appear in output, argv or temp files.
S_KEY=SENTINEL_RPKEY_9f3a1c
S_HF=SENTINEL_HFTOK_77b2e0
S_R2ID=SENTINEL_R2KEYID_41cc9d
S_R2SEC=SENTINEL_R2SECRET_c0de55
SENTINELS=("$S_KEY" "$S_HF" "$S_R2ID" "$S_R2SEC")
REF=0123456789abcdef0123456789abcdef01234567

cleanup() { [[ -n $FAKE_PID ]] && kill "$FAKE_PID" 2>/dev/null; rm -rf "$T"; }
trap cleanup EXIT

# curl shim: records argv (to prove no secret is ever on a command line), then runs real curl.
cat >"$SHIM/curl" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$T/argv.log"
exec "$REAL_CURL" "\$@"
EOF
chmod +x "$SHIM/curl"

# ---------------------------------------------------------------- helpers
t() { if (($# < 3)); then FAIL=$((FAIL + 1)); echo "FAIL: $1: test bug, missing argument"; elif [[ $3 == "$2" ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: expected [$2] got [$3]"; fi; }
tc() { if [[ $2 == *"$3"* ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: output lacks [$3]: ${2:0:300}"; fi; }
tn() { if [[ $2 != *"$3"* ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: output unexpectedly has [$3]"; fi; }
tnz() { if [[ $2 != 0 ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL: $1: expected a non-zero exit"; fi; }

pj() { python3 -I -c "import sys,json; d=json.load(sys.stdin); print($1)"; }
ctl() { "$REAL_CURL" -s "http://127.0.0.1:$PORT/__ctl/$1"; }
ctl_set() { "$REAL_CURL" -s -X POST -d "$1" "http://127.0.0.1:$PORT/__ctl/set" >/dev/null; }
ctl_tamper() { "$REAL_CURL" -s -X POST -d "$1" "http://127.0.0.1:$PORT/__ctl/tamper" >/dev/null; }
writes() { ctl log | pj 'sum(1 for x in d if x["method"] not in ("GET","HEAD") and x["path"].startswith("/v2/"))'; }
count_calls() { ctl log | pj "sum(1 for x in d if x['method']=='$1' and x['path'].startswith('$2'))"; }
state() { ctl state | pj "$1"; }

new_fake() {
  [[ -n $FAKE_PID ]] && kill "$FAKE_PID" 2>/dev/null
  rm -f "$T/port"
  FAKE_KEY=$S_KEY python3 -I "$HERE/fake_runpod.py" "$T/port" &
  FAKE_PID=$!
  local i
  for i in $(seq 1 100); do [[ -s $T/port ]] && break; sleep 0.05; done
  PORT=$(<"$T/port")
  mkcfg
}

mkcfg() { # mkcfg [extra lines...]  (later lines win)
  {
    echo "RUNPOD_API_KEY=$S_KEY"
    echo "HF_TOKEN=$S_HF"
    echo "R2_ACCOUNT_ID=0123456789abcdef0123456789abcdef"
    echo "R2_ACCESS_KEY_ID=$S_R2ID"
    echo "R2_SECRET_ACCESS_KEY=$S_R2SEC"
    echo "R2_BUCKET=jubividia-ltx-eu"
    echo "IMAGE_TAG=sha-f637c09"
    echo "GIT_REF=$REF"
    echo "RUNPOD_POD_IMAGE=ubuntu:22.04"
    printf '%s\n' "$@"
  } >"$T/config.env"
  chmod 600 "$T/config.env"
}

cfgval() { grep -E "^$1=" "$T/config.env" | tail -n1 | cut -d= -f2-; }

A() {
  CONFIG_ENV="$T/config.env" RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" GHCR_BASE="http://127.0.0.1:$PORT/ghcr" \
    TMPDIR="$T/tmp" PATH="$SHIM:$PATH" bash "$APPLY" "$@"
}
SM() {
  CONFIG_ENV="$T/config.env" RUNPOD_RUN_BASE="http://127.0.0.1:$PORT/rt" SMOKE_POLL_S=0.05 SMOKE_CSV="$T/t.csv" \
    SMOKE_IDLE_WAIT_S=20 TMPDIR="$T/tmp" PATH="$SHIM:$PATH" timeout 120 bash "$SMOKE" "$@"
}

full_apply() { A volume >/dev/null 2>&1 && A secrets >/dev/null 2>&1 && A endpoint >/dev/null 2>&1; }

# ---------------------------------------------------------------- 0. static
for f in "$APPLY" "$ROOT/infra/runpod/lib.sh" "$SMOKE" "$HERE/run.sh"; do
  bash -n "$f"; rc=$?; t "bash -n ${f##*/}" 0 "$rc"
done
python3 -I -m py_compile "$ROOT/infra/runpod/rpjson.py" "$HERE/fake_runpod.py"; t "py_compile" 0 $?
if command -v shellcheck >/dev/null; then
  shellcheck -x -e SC1091 "$APPLY" "$ROOT/infra/runpod/lib.sh" "$SMOKE" "$HERE/run.sh"; t "shellcheck" 0 $?
else
  echo "note: shellcheck not installed, skipped"
fi

# no delete path for volumes or the two R2 secrets
SHFILES=("$APPLY" "$ROOT/infra/runpod/lib.sh" "$SMOKE")
t "exactly one 'api DELETE' call site" 1 "$(grep -h 'api DELETE' "${SHFILES[@]}" | grep -vc '^[[:space:]]*#')"
t "no curl -X DELETE" 0 "$(grep -c -e '-X DELETE' "${SHFILES[@]}" | awk -F: '{s+=$NF} END{print s}')"
t "api_delete kinds used" "endpoint pod secret_hf" "$(grep -ho 'api_delete [a-z_]*' "$APPLY" | grep -v 'api_delete kind' | awk '{print $2}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
t "api_delete case labels" "endpoint pod secret_hf" "$(sed -n '/^api_delete()/,/^}/p' "$ROOT/infra/runpod/lib.sh" | grep -E '^\s+[a-z_]+\) path=' | sed -E 's/^\s+([a-z_]+)\).*/\1/' | sort | tr '\n' ' ' | sed 's/ $//')"
t "no volume path inside api_delete" 0 "$(sed -n '/^api_delete()/,/^}/p' "$ROOT/infra/runpod/lib.sh" | grep -c 'network-volumes')"
t "no line deletes a network volume" 0 "$(grep -hE 'network-volumes' "${SHFILES[@]}" | grep -ciE 'delete')"
t "no api_delete with R2 secret names" 0 "$(grep -hE 'api_delete' "$APPLY" | grep -ciE 'R2_KEY|ltx_r2|volume')"
t "hf secret delete is guarded by its name" 1 "$(grep -c 'find_ids /account/secrets "name=\$SECRET_HF"' "$APPLY" | awk '{print ($1>=1)?1:0}')"
t "smoke never uses /runsync" 0 "$(grep -v '^#' "$SMOKE" | grep -c 'runsync')"
t "no RunPod/Cloudflare host hardcoded outside defaults" 0 "$(grep -hoE 'https?://[a-z.]*(runpod|cloudflare)[a-z.]*' "$APPLY" "$SMOKE" | wc -l)"

# ---------------------------------------------------------------- 1. config reader and write_id
new_fake
mkcfg 'HF_TOKEN=$(touch '"$T"'/pwned)' 'EVIL=$(touch '"$T"'/pwned2)' 'R2_BUCKET="my bucket"' 'this is not a kv line' 'GIT_REF=`touch '"$T"'/pwned3`' "RUNPOD_DC='US-WA-1' # comment"
out=$(CONFIG_ENV="$T/config.env" bash -c ". '$ROOT/infra/runpod/lib.sh'; read_config; echo \"[\$(cfg R2_BUCKET)] [\$(cfg HF_TOKEN)] [\$(cfg EVIL x)] [\$(cfg RUNPOD_DC)] [\$(cfg GIT_REF)]\"" 2>&1)
tc "reader keeps quoted spaces" "$out" "[my bucket]"
tc "reader does not execute \$()" "$out" '[$(touch '"$T"'/pwned)]'
tc "reader ignores unknown keys" "$out" "[x]"
tc "reader strips quotes and comment" "$out" "[US-WA-1]"
t "no command ran from config.env" "none" "$([[ -e $T/pwned || -e $T/pwned2 || -e $T/pwned3 ]] && echo ran || echo none)"
mkcfg 'RUNPOD_ENDPOINT_ID='
chmod 640 "$T/config.env"
before=$(grep -v '^RUNPOD_ENDPOINT_ID=' "$T/config.env" | cksum)
CONFIG_ENV="$T/config.env" bash -c ". '$ROOT/infra/runpod/lib.sh'; read_config; write_id RUNPOD_ENDPOINT_ID ep-1; write_id RUNPOD_POD_ID pod-1" >/dev/null 2>&1
t "write_id sets the id" ep-1 "$(cfgval RUNPOD_ENDPOINT_ID)"
t "write_id appends a missing id" pod-1 "$(cfgval RUNPOD_POD_ID)"
t "write_id keeps other lines" "$before" "$(grep -v -e '^RUNPOD_ENDPOINT_ID=' -e '^RUNPOD_POD_ID=' "$T/config.env" | cksum)"
t "write_id keeps file mode" 640 "$(stat -c %a "$T/config.env")"
out=$(CONFIG_ENV="$T/config.env" bash -c ". '$ROOT/infra/runpod/lib.sh'; read_config; write_id HF_TOKEN abc" 2>&1)
tc "write_id refuses non-id keys" "$out" "refused"

# ---------------------------------------------------------------- 1b. v2 contract and hermetic test mode
new_fake
for p in /v1/secrets /v1/endpoints /v1/network-volumes /v1/serverless /secrets /endpoints /network-volumes /v2/secrets /v2/endpoints /v2/account/endpoints; do
  code=$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT$p")
  t "fake rejects old/wrong route $p" 404 "$code"
done
for p in /v2/account/secrets /v2/network-volumes /v2/serverless /v2/pods; do
  code=$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT$p")
  t "fake serves real route $p" 200 "$code"
done
t "fake: missing bearer is 401" 401 "$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/v2/serverless")"
t "fake: old volume field dataCenterId rejected" 422 "$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -X POST -d '{"name":"v","size":80,"dataCenterId":"US-WA-1"}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT/v2/network-volumes")"
t "fake: unknown endpoint field rejected" 422 "$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -X POST -d '{"name":"e","type":"QUEUE","image":"x:y","scaling":{"type":"QUEUE_DELAY","queueDelay":4},"gpu":{"pools":["ADA_48_PRO"]},"networkVolumeId":"v"}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT/v2/serverless")"
t "fake: excluded type outside pools is 400" 400 "$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -X POST -d '{"name":"e","type":"QUEUE","image":"x:y","scaling":{"type":"QUEUE_DELAY","queueDelay":4},"gpu":{"pools":["ADA_48_PRO"],"excludedTypes":["NVIDIA A40"]}}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT/v2/serverless")"
t "no hard-coded old base or routes in the tools" 0 "$(grep -hE '/v1|rest\.runpod\.io|[ "](/secrets|/endpoints)' "${SHFILES[@]}" | grep -vc '^[[:space:]]*#')"
# test mode refuses every non-loopback URL before any request is made
ctl clearlog >/dev/null
for spec in "RUNPOD_API_BASE=https://api.runpod.io/v2" "RUNPOD_RUN_BASE=https://api.runpod.ai/v2" "GHCR_BASE=https://ghcr.io"; do
  out=$(env "$spec" CONFIG_ENV="$T/config.env" bash "$APPLY" status 2>&1); rc=$?
  t "test mode refuses $spec" 4 "$rc"
  tc "refusal message for $spec" "$out" "TEST MODE refuses non-loopback"
done
out=$(env -u RUNPOD_API_BASE CONFIG_ENV="$T/config.env" bash "$APPLY" status 2>&1); rc=$?
t "test mode refuses the real default base" 4 "$rc"
t "refused runs sent no request" 0 "$(ctl log | pj 'len(d)')"
# userinfo and other odd URLs must not pass the loopback check (curl would use the host after '@')
ODD_URLS=(
  'http://127.0.0.1:80@evil.invalid/v2'
  'http://127.0.0.1:x@host/'
  'http://127.0.0.1:9#@host/'
  'http://127.0.0.1:9@api.runpod.io/v2'
  'http://127.0.0.1:9\@host/'
  'http://127.0.0.1:9 @host/'
  'http://127.0.0.1/v2'
  'http://127.0.0.1:/v2'
  'http://127.0.0.1:9.evil.invalid/v2'
  'http://127.0.0.1:9?x=@host'
  'HTTP://127.0.0.1:9/v2'
  'https://127.0.0.1:9/v2'
  'http://localhost:9/v2'
  'http://127.0.0.2:9/v2'
  'http://[::1]:9/v2'
  'http://127.0.0.1:9/v2/%0d%0a@host'
)
for u in "${ODD_URLS[@]}"; do
  out=$(env RUNPOD_API_BASE="$u" CONFIG_ENV="$T/config.env" bash "$APPLY" status 2>&1); rc=$?
  t "odd URL refused: $u" 4 "$rc"
done
t "odd URLs sent no request" 0 "$(ctl log | pj 'len(d)')"
out=$(A status 2>&1); t "a plain loopback URL still works" 0 $?
t "test-mode curl traffic bypasses proxies" 1 "$(grep -c -e '--noproxy' "$T/argv.log" | awk '{print ($1>=1)?1:0}')"

# ---------------------------------------------------------------- 2. image tag validation
new_fake
for bad in latest v1 sha-abc12 sha-ZZZZZZZ sha-f637c09x dev ""; do
  mkcfg "IMAGE_TAG=$bad"
  out=$(A endpoint 2>&1); rc=$?
  tnz "tag '$bad' rejected" "$rc"
  tc "tag '$bad' message" "$out" "IMAGE_TAG"
  t "tag '$bad' made no writes" 0 "$(writes)"
done
mkcfg "IMAGE=ghcr.io/ken-ck-yu/ltx25-worker:latest"
out=$(A endpoint 2>&1); tnz "IMAGE with tag rejected" $?
t "no writes after image rejections" 0 "$(writes)"

# ---------------------------------------------------------------- 3. first apply, then idempotency
new_fake
out=$(A preflight 2>&1); rc=$?
t "preflight ok" 0 "$rc"
tc "preflight checks ghcr" "$out" "publicly pullable"
t "preflight is read only" 0 "$(writes)"
A volume >"$T/o1" 2>&1; t "volume exit" 0 $?
A secrets >"$T/o2" 2>&1; t "secrets exit" 0 $?
A endpoint >"$T/o3" 2>&1; t "endpoint exit" 0 $?
VOL=$(cfgval RUNPOD_NETWORK_VOLUME_ID)
EP=$(cfgval RUNPOD_ENDPOINT_ID)
t "volume id written back" vol-1 "$VOL"
tc "endpoint id written back" "$EP" ep-
t "secret id written back" 1 "$([[ -n $(cfgval RUNPOD_SECRET_ID_R2_KEY_ID) && -n $(cfgval RUNPOD_SECRET_ID_R2_KEY_SECRET) ]] && echo 1 || echo 0)"
t "config.env mode stays 600" 600 "$(stat -c %a "$T/config.env")"
t "volume size" 80 "$(state "d['volumes']['$VOL']['size']")"
t "volume dc" US-WA-1 "$(state "d['volumes']['$VOL']['dataCenter']")"
E="d['endpoints']['$EP']"
t "ep image" ghcr.io/ken-ck-yu/ltx25-worker:sha-f637c09 "$(state "$E['image']")"
t "ep flashboot ON explicitly" FLASHBOOT "$(state "$E['flashboot']")"
t "ep timeout is 900000 ms" 900000 "$(state "$E['timeout']")"
t "ep workers" "0 2 60" "$(state "' '.join(str($E['workers'][k]) for k in ('min','max','idleTimeout'))")"
t "ep scaling is QUEUE_DELAY" QUEUE_DELAY "$(state "$E['scaling']['type']")"
t "ep pools" ADA_48_PRO "$(state "','.join($E['gpu']['pools'])")"
t "ep exclusions" "NVIDIA L40|NVIDIA L40S|NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb" "$(state "'|'.join($E['gpu']['excludedTypes'])")"
t "ep minCuda" 12.8 "$(state "$E['gpu']['minCudaVersion']")"
t "ep dc" US-WA-1 "$(state "','.join($E['dataCenterIds'])")"
t "ep volume mount" "$VOL" "$(state "$E['mounts']['network'][0]['volumeId']")"
t "ep key id is a secret ref" "{{ RUNPOD_SECRET_ltx_r2_access_key_id }}" "$(state "$E['env']['R2_ACCESS_KEY_ID']")"
t "ep secret is a secret ref" "{{ RUNPOD_SECRET_ltx_r2_secret_access_key }}" "$(state "$E['env']['R2_SECRET_ACCESS_KEY']")"
t "ep EXEC_TIMEOUT_S tied to timeout" 900 "$(state "$E['env']['EXEC_TIMEOUT_S']")"
t "two R2 secrets exist" "ltx_r2_access_key_id ltx_r2_secret_access_key" "$(state "' '.join(sorted(s['name'] for s in d['secrets'].values()))")"
epbody=$(ctl log | pj '[x for x in d if x["method"]=="POST" and x["path"]=="/v2/serverless"][0]["body"]')
for s in "${SENTINELS[@]}"; do tn "endpoint create body has no $s" "$epbody" "$s"; done
secbody=$(ctl log | pj '[x["body"]["value"] for x in d if x["method"]=="POST" and x["path"]=="/v2/account/secrets"]')
tc "secret values are really sent to create-secret" "$secbody" "$S_R2ID"
t "authorization header always sent" 0 "$(ctl log | pj 'sum(1 for x in d if x["path"].startswith("/v2/") and not x["auth_ok"])')"

"$REAL_CURL" -s -o /dev/null -X POST -d '{"name":"trap2","type":"QUEUE","image":"x:y","gpu":{"pools":["ADA_48_PRO"]},"scaling":{"type":"REQUEST_COUNT","requestCount":4},"workers":{"idleTimeout":60}}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT/v2/serverless"
t "fake models trap 2 (REQUEST_COUNT + idleTimeout rejected)" 1 "$(ctl state | pj 'len(d["endpoints"])')"
t "apply create body uses QUEUE_DELAY (never REQUEST_COUNT)" QUEUE_DELAY "$(ctl log | pj '[x for x in d if x["method"]=="POST" and x["path"]=="/v2/serverless"][0]["body"]["scaling"]["type"]')"

# idempotency: second full run does nothing
ctl clearlog >/dev/null
A volume >/dev/null 2>&1; A secrets >/dev/null 2>&1; A endpoint >"$T/o4" 2>&1; t "second endpoint run exit" 0 $?
t "second run: no writes at all" 0 "$(writes)"
tc "second run reads back" "$(cat "$T/o4")" "matches config"
# changed tag -> exactly one PATCH with only image
ctl clearlog >/dev/null
mkcfg "IMAGE_TAG=sha-abcdef12" "RUNPOD_NETWORK_VOLUME_ID=$VOL" "RUNPOD_ENDPOINT_ID=$EP"
out=$(A endpoint 2>&1)
t "tag bump: one write" 1 "$(writes)"
t "tag bump: PATCH body is only image" image "$(ctl log | pj '",".join(sorted([x for x in d if x["method"]=="PATCH"][0]["body"]))')"
tc "tag bump announces new release" "$out" "new release"

# ---------------------------------------------------------------- 4. dry run: no writes anywhere
new_fake
sum0=$(cksum <"$T/config.env")
A volume --dry-run >/dev/null 2>&1; A secrets --dry-run >/dev/null 2>&1; out=$(A endpoint --dry-run 2>&1)
t "dry-run (fresh): no writes" 0 "$(writes)"
t "dry-run (fresh): config.env untouched" "$sum0" "$(cksum <"$T/config.env")"
tc "dry-run prints the endpoint body" "$out" '"flashboot":"FLASHBOOT"'
tc "dry-run says would POST" "$out" "would POST /serverless"
t "dry-run (fresh): nothing exists" "0 0 0" "$(ctl state | pj '" ".join(str(len(d[k])) for k in ("volumes","secrets","endpoints"))')"
full_apply
A pod-up >/dev/null 2>&1
ctl clearlog >/dev/null
sum1=$(cksum <"$T/config.env")
ctl_tamper "{\"kind\":\"endpoints\",\"id\":\"$(cfgval RUNPOD_ENDPOINT_ID)\",\"patch\":{\"flashboot\":\"OFF\"}}"
for c in volume secrets endpoint pod-down "teardown-endpoint --yes" ; do
  # shellcheck disable=SC2086
  A $c --dry-run >/dev/null 2>&1
done
mkcfg "RUNPOD_NETWORK_VOLUME_ID=$(cfgval RUNPOD_NETWORK_VOLUME_ID)"
A pod-up --dry-run >/dev/null 2>&1
t "dry-run (existing): no writes" 0 "$(writes)"
t "dry-run left the pod in place" 1 "$(state 'len(d["pods"])')"
t "dry-run left hf secret in place" 1 "$(state 'sum(1 for s in d["secrets"].values() if s["name"]=="hf_token_tmp")')"
_=$sum1

# ---------------------------------------------------------------- 5. REST traps and drift
new_fake
full_apply
VOL=$(cfgval RUNPOD_NETWORK_VOLUME_ID); EP=$(cfgval RUNPOD_ENDPOINT_ID)
E="d['endpoints']['$EP']"
# trap 1: flashboot drifted to OFF -> single-field PATCH
ctl_tamper "{\"kind\":\"endpoints\",\"id\":\"$EP\",\"patch\":{\"flashboot\":\"OFF\"}}"
ctl clearlog >/dev/null
A endpoint >/dev/null 2>&1
t "flashboot drift fixed" FLASHBOOT "$(state "$E['flashboot']")"
t "flashboot fix is a single-field PATCH" "1 flashboot" "$(ctl log | pj '"%d %s" % (sum(1 for x in d if x["method"]=="PATCH"), ",".join(sorted([x for x in d if x["method"]=="PATCH"][0]["body"])))')"
# trap 3: a naive PATCH clears exclusions (the fake is faithful) ...
"$REAL_CURL" -s -o /dev/null -X PATCH -d '{"gpu":{"pools":["ADA_48_PRO"]}}' -H "Authorization: Bearer $S_KEY" "http://127.0.0.1:$PORT/v2/serverless/$EP"
t "fake models trap 3 (pools alone clears exclusions)" 0 "$(state "len($E['gpu']['excludedTypes'])")"
# ... and apply restores them by sending pools and excludedTypes together
ctl clearlog >/dev/null
A endpoint >/dev/null 2>&1
t "exclusions restored" 3 "$(state "len($E['gpu']['excludedTypes'])")"
t "every gpu PATCH carries pools and excludedTypes together" 1 "$(ctl log | pj 'int(all(("pools" in x["body"]["gpu"]) and ("excludedTypes" in x["body"]["gpu"]) for x in d if x["method"]=="PATCH" and "gpu" in x["body"]))')"
t "gpu fix is one PATCH" 1 "$(writes)"
# workers.max lowered by the idle rule -> restored
ctl_tamper "{\"kind\":\"endpoints\",\"id\":\"$EP\",\"patch\":{\"workers\":{\"min\":0,\"max\":0,\"idleTimeout\":60}}}"
out=$(A status 2>&1)
tc "status warns about lowered workers.max" "$out" "WARNING: workers.max is 0"
A endpoint >/dev/null 2>&1
t "workers.max restored" 2 "$(state "$E['workers']['max']")"
# scaling drifted to REQUEST_COUNT
ctl_tamper "{\"kind\":\"endpoints\",\"id\":\"$EP\",\"patch\":{\"scaling\":{\"type\":\"REQUEST_COUNT\",\"requestCount\":4},\"workers\":{\"min\":0,\"max\":2}}}"
A endpoint >/dev/null 2>&1
t "scaling back to QUEUE_DELAY" QUEUE_DELAY "$(state "$E['scaling']['type']")"

# gate flag
new_fake
A volume >/dev/null 2>&1; A secrets >/dev/null 2>&1
A endpoint --max-workers 1 >/dev/null 2>&1
t "--max-workers 1 at create" 1 "$(state "d['endpoints']['$(cfgval RUNPOD_ENDPOINT_ID)']['workers']['max']")"
A endpoint >/dev/null 2>&1
t "restored to 2 afterwards" 2 "$(state "d['endpoints']['$(cfgval RUNPOD_ENDPOINT_ID)']['workers']['max']")"

# ---------------------------------------------------------------- 6. read-back mismatch: patch, never delete
new_fake
A volume >/dev/null 2>&1; A secrets >/dev/null 2>&1
ctl_set '{"timeout_ignored":true}'
out=$(A endpoint 2>&1); rc=$?
t "timeout mismatch at create is repaired" 0 "$rc"
EP=$(cfgval RUNPOD_ENDPOINT_ID)
t "timeout patched to 900000" 900000 "$(state "d['endpoints']['$EP']['timeout']")"
tc "mismatch is reported" "$out" "field 'timeout' differs"
t "no DELETE issued" 0 "$(count_calls DELETE /v2)"
new_fake
A volume >/dev/null 2>&1; A secrets >/dev/null 2>&1
ctl_set '{"timeout_ignored":true,"patch_ignored":"timeout"}'
out=$(A endpoint 2>&1); rc=$?
tnz "persistent mismatch exits non-zero" "$rc"
tc "message says endpoint was not deleted" "$out" "NOT deleted"
t "endpoint still exists" 1 "$(state 'len(d["endpoints"])')"
t "no DELETE on persistent mismatch" 0 "$(count_calls DELETE /v2)"

# ---------------------------------------------------------------- 7. volume rules
new_fake
mkcfg "RUNPOD_VOLUME_GB=100"
A volume >/dev/null 2>&1
VOL=$(cfgval RUNPOD_NETWORK_VOLUME_ID)
t "volume created at 100" 100 "$(state "d['volumes']['$VOL']['size']")"
mkcfg "RUNPOD_VOLUME_GB=60" "RUNPOD_NETWORK_VOLUME_ID=$VOL"
ctl clearlog >/dev/null
out=$(A volume 2>&1); rc=$?
tnz "shrink refused" "$rc"; tc "shrink message" "$out" "refusing to shrink"; t "shrink made no writes" 0 "$(writes)"
mkcfg "RUNPOD_VOLUME_GB=120" "RUNPOD_NETWORK_VOLUME_ID=$VOL"
ctl clearlog >/dev/null
out=$(A volume 2>&1); rc=$?
tnz "grow without --yes refused" "$rc"; tc "grow refusal message" "$out" "--yes"; t "refused grow made no writes" 0 "$(writes)"
A volume --yes >/dev/null 2>&1
t "grow works with --yes" 120 "$(state "d['volumes']['$VOL']['size']")"
# id from config must be the right DC and tier
ctl_tamper "{\"kind\":\"volumes\",\"id\":\"$VOL\",\"patch\":{\"dataCenter\":\"EU-RO-1\"}}"
out=$(A volume --yes 2>&1); rc=$?
tnz "config volume id in the wrong DC refused" "$rc"; tc "wrong DC message" "$out" "expected US-WA-1"
ctl_tamper "{\"kind\":\"volumes\",\"id\":\"$VOL\",\"patch\":{\"dataCenter\":\"US-WA-1\",\"type\":\"HIGH_PERFORMANCE\"}}"
out=$(A volume --yes 2>&1); rc=$?
tnz "config volume id with the wrong tier refused" "$rc"
t "the kill hook is gated on test mode" 1 "$(grep -c 'RUNPOD_TEST_MODE == 1 && .*APPLY_TEST_KILL' "$APPLY")"
# two volumes with the same name+DC: stop
new_fake
ctl_tamper '{"kind":"volumes","add":{"id":"vol-a","name":"jubividia-ltx-us-wa1","size":80,"dataCenter":"US-WA-1","type":"STANDARD"}}'
ctl_tamper '{"kind":"volumes","add":{"id":"vol-b","name":"jubividia-ltx-us-wa1","size":80,"dataCenter":"US-WA-1","type":"STANDARD"}}'
out=$(A volume 2>&1); rc=$?
tnz "ambiguous volume stops" "$rc"; t "ambiguous volume made no writes" 0 "$(writes)"
# stale id never silently creates
mkcfg "RUNPOD_NETWORK_VOLUME_ID=vol-gone"
out=$(A volume 2>&1); rc=$?
tnz "stale volume id stops" "$rc"; t "stale id made no writes" 0 "$(writes)"

# ---------------------------------------------------------------- 8. killed between create and write-back
new_fake
APPLY_TEST_KILL_AFTER_CREATE=volume A volume >/dev/null 2>&1; rc=$?
t "volume run was killed" 137 "$rc"
t "volume exists but id not written" "1 " "$(state 'len(d["volumes"])') $(cfgval RUNPOD_NETWORK_VOLUME_ID)"
A volume >/dev/null 2>&1
t "re-run adopts: still one volume" 1 "$(state 'len(d["volumes"])')"
t "re-run wrote the id" vol-1 "$(cfgval RUNPOD_NETWORK_VOLUME_ID)"
APPLY_TEST_KILL_AFTER_CREATE="secret:ltx_r2_access_key_id" A secrets >/dev/null 2>&1; rc=$?
t "secrets run was killed" 137 "$rc"
A secrets >/dev/null 2>&1; t "secrets re-run ok (no 409)" 0 $?
t "exactly two secrets" 2 "$(state 'len(d["secrets"])')"
APPLY_TEST_KILL_AFTER_CREATE=endpoint A endpoint >/dev/null 2>&1; rc=$?
t "endpoint run was killed" 137 "$rc"
t "endpoint id not written yet" "" "$(cfgval RUNPOD_ENDPOINT_ID)"
A endpoint >/dev/null 2>&1; t "endpoint re-run ok" 0 $?
t "one endpoint only" 1 "$(state 'len(d["endpoints"])')"
t "endpoint id written" ep- "$(cfgval RUNPOD_ENDPOINT_ID | cut -c1-3)"

# ---------------------------------------------------------------- 9. temp pod
new_fake
A volume >/dev/null 2>&1; A secrets >/dev/null 2>&1
for badref in HEAD main 0123456 ""; do
  mkcfg "RUNPOD_NETWORK_VOLUME_ID=$(cfgval RUNPOD_NETWORK_VOLUME_ID)" "GIT_REF=$badref"
  out=$(A pod-up 2>&1); rc=$?
  tnz "GIT_REF '$badref' rejected" "$rc"
done
t "bad GIT_REF made no pod/secret writes" 0 "$(count_calls POST /v2/pods)"
mkcfg "RUNPOD_NETWORK_VOLUME_ID=$(cfgval RUNPOD_NETWORK_VOLUME_ID)" "RUNPOD_POD_IMAGE=ubuntu:latest"
out=$(A pod-up 2>&1); tnz "pod image :latest rejected" $?
mkcfg "RUNPOD_NETWORK_VOLUME_ID=$(cfgval RUNPOD_NETWORK_VOLUME_ID)"
out=$(A pod-up 2>&1); rc=$?
t "pod-up ok" 0 "$rc"
tc "pod-up prints the terminate reminder" "$out" "TERMINATE"
POD=$(cfgval RUNPOD_POD_ID)
t "pod id written back" pod- "$(echo "$POD" | cut -c1-4)"
P="d['pods']['$POD']"
t "pod HF token is a secret ref" "{{ RUNPOD_SECRET_hf_token_tmp }}" "$(state "$P['env']['HF_TOKEN']")"
t "pod GIT_REF env" "$REF" "$(state "$P['env']['GIT_REF']")"
t "pod mounts the volume at /runpod-volume" "/runpod-volume" "$(state "$P['mounts']['network'][0]['path']")"
t "pod is a secure CPU pod" "SECURE cpu3c" "$(state "$P['cloud'] + ' ' + $P['cpu']['id']")"
t "pod uses entrypoint+cmd exec form" "bash -c" "$(state "' '.join($P['entrypoint'])")"
cmdtxt=$(state "$P['cmd'][0]")
tc "pod script checks out the pinned ref" "$cmdtxt" 'git checkout --detach "$GIT_REF"'
tn "pod script has no shallow HEAD clone" "$cmdtxt" "--depth 1"
tc "pod script verifies" "$cmdtxt" "download-models.sh --verify"
t "hf secret exists" 1 "$(state 'sum(1 for s in d["secrets"].values() if s["name"]=="hf_token_tmp")')"
podbody=$(ctl log | pj '[x for x in d if x["method"]=="POST" and x["path"]=="/v2/pods"][0]["body"]')
tn "pod create body has no HF token" "$podbody" "$S_HF"
out=$(A pod-up 2>&1); tnz "second pod-up refused" $?
tc "refusal names the existing pod" "$out" "already exists"
# an unrelated pod must never be touched
ctl_tamper '{"kind":"pods","add":{"id":"pod-other","name":"someone-elses-pod","status":"RUNNING"}}'
VOLB=$(state 'len(d["volumes"])')
HFID=$(state '[k for k,s in d["secrets"].items() if s["name"]=="hf_token_tmp"][0]')
ctl clearlog >/dev/null
out=$(A pod-down 2>&1); rc=$?
t "pod-down ok" 0 "$rc"
t "only the tmp pod deleted" "pod-other" "$(state "','.join(d['pods'])")"
t "DELETEs issued" "/v2/pods/$POD /v2/account/secrets/$HFID" "$(ctl log | pj '" ".join(x["path"] for x in d if x["method"]=="DELETE")')"
t "hf secret gone" 0 "$(state 'sum(1 for s in d["secrets"].values() if s["name"]=="hf_token_tmp")')"
t "R2 secrets survive pod-down" 2 "$(state 'sum(1 for s in d["secrets"].values() if s["name"].startswith("ltx_r2"))')"
t "volume survives pod-down" "$VOLB" "$(state 'len(d["volumes"])')"
t "pod id cleared in config" "" "$(cfgval RUNPOD_POD_ID)"
tc "pod-down says rotate the token" "$out" "rotate"
ctl clearlog >/dev/null
A pod-down >/dev/null 2>&1; t "pod-down is idempotent" 0 $?
t "second pod-down deletes nothing" 0 "$(count_calls DELETE /v2)"
A pod-logs >/dev/null 2>&1; tnz "pod-logs without a pod fails" $?

# ---------------------------------------------------------------- 10. teardown
new_fake
full_apply
out=$(A teardown-endpoint 2>&1); tnz "teardown needs --yes" $?
t "teardown without --yes: endpoint kept" 1 "$(state 'len(d["endpoints"])')"
EP=$(cfgval RUNPOD_ENDPOINT_ID)
ctl clearlog >/dev/null
A teardown-endpoint --yes >/dev/null 2>&1; t "teardown exit" 0 $?
t "teardown: patch to max 0 then delete" "PATCH DELETE" "$(ctl log | pj '" ".join(x["method"] for x in d if x["method"] in ("PATCH","DELETE"))')"
t "endpoint gone" 0 "$(state 'len(d["endpoints"])')"
t "volume and secrets kept" "1 2" "$(state '"%d %d" % (len(d["volumes"]), len(d["secrets"]))')"
t "endpoint id cleared" "" "$(cfgval RUNPOD_ENDPOINT_ID)"

# ---------------------------------------------------------------- 11. secrets hygiene
new_fake
: >"$T/argv.log"
{
  A preflight; A volume; A secrets; A endpoint; A status; A pod-up; A pod-logs; A pod-down
  A endpoint --dry-run; A secrets --rotate; A teardown-endpoint --yes
} >"$T/all.out" 2>&1
ctl_set '{"leak_on_error":true}'
mkcfg "RUNPOD_NETWORK_VOLUME_ID=vol-1"
{ A secrets --rotate; A secrets; } >>"$T/all.out" 2>&1
# a server that echoes the secret body back in an error must be redacted
new_fake
A volume >/dev/null 2>&1
ctl_set '{"leak_on_error":true}'
A secrets >"$T/leak.out" 2>&1; tnz "leaky server error -> failure" $?
tc "error output is redacted" "$(cat "$T/leak.out")" "***"
# wrong key -> 401, key not echoed
CONFIG_ENV="$T/config.env" RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" bash "$APPLY" status >"$T/bad.out" 2>&1
mkcfg "RUNPOD_API_KEY=SENTINEL_WRONGKEY_aa11"
A status >>"$T/bad.out" 2>&1
for s in "${SENTINELS[@]}" SENTINEL_WRONGKEY_aa11; do
  t "no $s in any output" 0 "$(cat "$T/all.out" "$T/leak.out" "$T/bad.out" | grep -c "$s")"
  t "no $s on any curl command line" 0 "$(grep -c "$s" "$T/argv.log")"
  t "no $s in temp files" 0 "$(grep -rl "$s" "$T/tmp" 2>/dev/null | wc -l)"
done
# bash -x is refused, and prints nothing sensitive
mkcfg
out=$(CONFIG_ENV="$T/config.env" RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" bash -x "$APPLY" status 2>&1); rc=$?
t "bash -x refused" 2 "$rc"
tc "bash -x refusal message" "$out" "refusing to run under bash -x"
for s in "${SENTINELS[@]}"; do tn "bash -x output has no $s" "$out" "$s"; done
out=$(CONFIG_ENV="$T/config.env" bash -x "$SMOKE" 2>&1); t "smoke under bash -x refused" 2 $?
for s in "${SENTINELS[@]}"; do tn "smoke bash -x output has no $s" "$out" "$s"; done
out=$(env SHELLOPTS=xtrace CONFIG_ENV="$T/config.env" bash "$APPLY" status 2>&1); tc "SHELLOPTS=xtrace refused" "$out" "refus"
for s in "${SENTINELS[@]}"; do tn "SHELLOPTS=xtrace output has no $s" "$out" "$s"; done

# ---------------------------------------------------------------- 12. smoke-job gate against the fake runtime
new_fake
mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
rm -f "$T/t.csv"
out=$(SM --no-r2-check 2>&1); rc=$?
t "gate passes" 0 "$rc"
tc "gate verdict" "$out" "GATE: PASS"
tc "canary recognised" "$out" "canary OK"
tc "cold start formula (45000+35000)/1000-5" "$out" "= 75.0 s"
tc "second warm within 10%" "$out" "within 10% of the first"
tc "peak vram reported" "$out" "peak_vram_mb=40"
t "csv has header + 6 jobs" 7 "$(wc -l <"$T/t.csv")"
tc "csv records cold flag true" "$(cat "$T/t.csv")" ",cold-tiny,"
t "only /run /status /health /cancel used" 0 "$(ctl log | pj 'sum(1 for x in d if x["path"].startswith("/rt/") and x["path"].split("/")[3] not in ("run","status","health","cancel"))')"
for s in "${SENTINELS[@]}"; do tn "gate output has no $s" "$out" "$s"; done
t "gate bearer sent" 0 "$(ctl log | pj 'sum(1 for x in d if x["path"].startswith("/rt/") and not x["auth_ok"])')"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"default_gen":[100.0,140.0,100.0]}'; rm -f "$T/t.csv"
out=$(SM --no-r2-check 2>&1); rc=$?
t "second default job 40% slower -> fail" 1 "$rc"; tc "fail message" "$out" "more than 10%"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"unhealthy":1}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "unhealthy worker -> stop" 3 "$rc"; tc "unhealthy message" "$out" "Unhealthy"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"stuck":true}'
out=$(SMOKE_MAX_INPROGRESS_S=1 SM --no-r2-check 2>&1); rc=$?
t "stuck IN_PROGRESS -> stop" 3 "$rc"; tc "stuck message" "$out" "stayed IN_PROGRESS"
t "cancel sent on stuck job" 1 "$(count_calls POST /rt/ep-1/cancel | awk '{print ($1>=1)?1:0}')"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"canary_error":"[input_fetch] could not fetch input: InvalidAccessKeyId"}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "unresolved secrets at canary -> stop" 3 "$rc"; tc "canary stop message" "$out" "secrets did not resolve"
t "canary stop ran no model job" 0 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run") and x["body"]["input"]["mode"]=="t2v"])')"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"no_error_code":true}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "missing error_code with [input_fetch] prefix -> canary passes" 0 "$rc"
tc "missing error_code is recorded as a note" "$out" "no separate error_code field"
t "gate ran all jobs after the noted canary" 6 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run")])')"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"canary_error":"[config_error] worker misconfigured: R2_ACCESS_KEY_ID not set","no_error_code":true}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "other prefix at canary -> stop" 3 "$rc"; tc "other-prefix message" "$out" "STOP AND ASK KEN"
t "other prefix: only the canary job ran" 1 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run")])')"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"canary_error":"could not fetch input: 403"}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "canary without any prefix -> stop" 3 "$rc"

# F1: /status that keeps failing can never loop forever
for mode in 500 401 garbage; do
  new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set "{\"status_fail\":\"$mode\"}"
  out=$(SMOKE_POLL_FAIL_LIMIT=3 SM --no-r2-check 2>&1); rc=$?
  t "/status $mode forever -> stop (not a hang)" 3 "$rc"
  tc "/status $mode message" "$out" "failed 3 polls in a row"
  t "/status $mode: cancel sent" 1 "$(count_calls POST /rt/ep-1/cancel | awk '{print ($1>=1)?1:0}')"
done
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"status_fail":"500","status_fail_after":2}'
out=$(SMOKE_POLL_FAIL_LIMIT=1000 SMOKE_MAX_INPROGRESS_S=1 SM --no-r2-check 2>&1); rc=$?
t "in-progress cap still fires while /status fails" 3 "$rc"; tc "cap message while failing" "$out" "stayed IN_PROGRESS"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"status_fail":"500","unhealthy":1}'
out=$(SMOKE_POLL_FAIL_LIMIT=1000 SM --no-r2-check 2>&1); rc=$?
t "unhealthy check still fires while /status fails" 3 "$rc"; tc "unhealthy while failing" "$out" "Unhealthy"

# Q10: overall spend guard
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
out=$(SM --no-r2-check --max-spend 0.00001 2>&1); rc=$?
t "spend cap reached -> stop" 3 "$rc"; tc "spend cap message" "$out" "reached --max-spend"
out=$(SM --no-r2-check --max-spend lots 2>&1); rc=$?
tnz "bad --max-spend rejected" "$rc"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
out=$(SM --no-r2-check 2>&1); tc "summary reports estimated spend" "$out" "estimated spend: \$"
tc "summary shows the default cap" "$out" "cap \$3.00"

# Q4: no pinned image tag, no gate
for bad in "" latest; do
  new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1" "IMAGE_TAG=$bad"
  out=$(SM --no-r2-check 2>&1); rc=$?
  tnz "smoke refuses IMAGE_TAG '$bad'" "$rc"
  t "smoke with IMAGE_TAG '$bad' sent no job" 0 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run")])')"
done

# Q6: the run URL comes from the endpoint's requestUrls
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
ctl_tamper "{\"kind\":\"endpoints\",\"add\":{\"id\":\"ep-1\",\"requestUrls\":{\"run\":\"http://127.0.0.1:$PORT/rt/alt-ep/run\"}}}"
out=$(RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" SM --no-r2-check 2>&1); rc=$?
t "gate runs against requestUrls" 0 "$rc"
t "jobs went to the requestUrls endpoint" 1 "$(ctl log | pj 'int(any(x["path"]=="/rt/alt-ep/run" for x in d) and not any(x["path"]=="/rt/ep-1/run" for x in d))')"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
ctl_tamper "{\"kind\":\"endpoints\",\"add\":{\"id\":\"ep-1\",\"requestUrls\":{\"run\":\"https://api.runpod.ai/v2/ep-1/run\"}}}"
out=$(RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" SM --no-r2-check 2>&1); rc=$?
t "non-loopback requestUrls refused in test mode" 4 "$rc"

# N3: requestUrls.run host is pinned to RunPod domains
for bad in "https://evil.example/v2/ep-1/run" "https://api.runpod.ai.evil.com/v2/ep-1/run" "http://api.runpod.ai/v2/ep-1/run" \
  "https://runpod.ai@evil.com/v2/ep-1/run" "https://evilrunpod.ai/v2/ep-1/run" "https://api.runpod.io#@evil.com/run"; do
  new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
  ctl_tamper "{\"kind\":\"endpoints\",\"add\":{\"id\":\"ep-1\",\"requestUrls\":{\"run\":\"$bad\"}}}"
  out=$(RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" SM --no-r2-check 2>&1); rc=$?
  t "requestUrls $bad refused" 4 "$rc"
  tc "requestUrls $bad: pin message" "$out" "not a RunPod domain"
  t "requestUrls $bad: no job submitted" 0 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run")])')"
done
for good in "https://api.runpod.ai/v2/ep-1/run" "https://ep-1.api.runpod.io/run"; do
  new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
  ctl_tamper "{\"kind\":\"endpoints\",\"add\":{\"id\":\"ep-1\",\"requestUrls\":{\"run\":\"$good\"}}}"
  out=$(RUNPOD_API_BASE="http://127.0.0.1:$PORT/v2" SM --no-r2-check 2>&1); rc=$?
  tc "RunPod URL $good passes the pin (then test mode refuses the network)" "$out" "TEST MODE refuses non-loopback"
  tn "RunPod URL $good is not called a bad domain" "$out" "not a RunPod domain"
done

# N1: /health failing while /status says IN_QUEUE forever must still stop and cancel
for mode in 500 garbage; do
  new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set "{\"queued_forever\":true,\"health_fail\":\"$mode\"}"
  out=$(SMOKE_HEALTH_FAIL_LIMIT=3 SM --no-r2-check 2>&1); rc=$?
  t "/health $mode + queued forever -> stop" 3 "$rc"
  tc "/health $mode message" "$out" "/health failed 3 polls in a row"
  t "/health $mode: cancel sent" 1 "$(count_calls POST /rt/ep-1/cancel | awk '{print ($1>=1)?1:0}')"
done
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"queued_forever":true,"health_fail":"500"}'
out=$(SMOKE_HEALTH_FAIL_LIMIT=100000 SMOKE_JOB_WALL_S=1 SM --no-r2-check 2>&1); rc=$?
t "wall-clock cap stops a job even when nothing else trips" 3 "$rc"; tc "wall-clock message" "$out" "wall-clock"
t "wall-clock cap sent a cancel" 1 "$(count_calls POST /rt/ep-1/cancel | awk '{print ($1>=1)?1:0}')"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"queued_forever":true}'
out=$(SMOKE_JOB_WALL_S=1 SM --no-r2-check 2>&1); rc=$?
t "wall-clock cap with healthy /health and an endless queue" 3 "$rc"
tc "default wall cap is derived from the execution timeout" "$(grep -c 'JOB_WALL_S=\${SMOKE_JOB_WALL_S:-\$((EXEC_S + 600))}' "$SMOKE")" 1

# N2: the stop message names the failing poll's HTTP status, not the cancel call's
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"status_fail":"500"}'
out=$(SMOKE_POLL_FAIL_LIMIT=2 SM --no-r2-check 2>&1)
tc "stop message reports the /status HTTP code" "$out" "last HTTP 500"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"queued_forever":true,"health_fail":"503"}'
out=$(SMOKE_HEALTH_FAIL_LIMIT=2 SM --no-r2-check 2>&1)
tc "stop message reports the /health HTTP code" "$out" "last HTTP 503"

# N4: the spend estimate includes a 60 s idle tail per job (about $0.029), so a $0.02 cap trips after the canary
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
out=$(SM --no-r2-check --max-spend 0.02 2>&1); rc=$?
t "idle tail makes a tiny cap trip after one job" 3 "$rc"; tc "tail spend message" "$out" "reached --max-spend"
t "capped run stopped after the canary" 1 "$(ctl log | pj 'len([x for x in d if x["path"].endswith("/run")])')"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
out=$(SM --no-r2-check 2>&1); tc "full gate stays under the 3.00 default" "$out" "GATE: PASS"

# N5: status aborts on a second page of pods
new_fake; full_apply; A pod-up >/dev/null 2>&1
ctl_set '{"pods_next_page":true}'
out=$(A status 2>&1); rc=$?
tnz "status aborts when the pod list has a second page" "$rc"; tc "second-page message" "$out" "more than one page"

new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; ctl_set '{"default_gen":[310.0]}'
out=$(SM --no-r2-check 2>&1); rc=$?
t "warm gen > 300 s -> stop" 3 "$rc"

# R2 / ffprobe checks with stub aws + ffprobe
mkdir -p "$T/stubs"
cat >"$T/stubs/aws" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" head-object "*) echo video/mp4 ;;
  *" cp "*) for a; do last=$a; done; echo data >"$last" ;;
esac
EOF
cat >"$T/stubs/ffprobe" <<'EOF'
#!/usr/bin/env bash
if [[ ${FAKE_NO_AUDIO-} == 1 ]]; then echo '{"streams":[{"codec_type": "video"}]}'; else echo '{"streams":[{"codec_type": "video"},{"codec_type": "audio","duration":"5.0"}]}'; fi
EOF
chmod +x "$T/stubs/aws" "$T/stubs/ffprobe"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"; rm -f "$T/t.csv"
out=$(SMOKE_ALLOW_STUB_AWS=1 PATH="$T/stubs:$PATH" SM 2>&1); rc=$?
t "gate with R2/audio checks passes" 0 "$rc"; tc "audio present" "$out" "audio stream: present"; tc "R2 head ok" "$out" "R2 ok: outputs/"
tc "csv records audio" "$(cat "$T/t.csv")" ",yes"
new_fake; mkcfg "RUNPOD_ENDPOINT_ID=ep-1"
out=$(SMOKE_ALLOW_STUB_AWS=1 FAKE_NO_AUDIO=1 PATH="$T/stubs:$PATH" SM 2>&1); rc=$?
t "silent mp4 (no audio stream) fails the gate" 1 "$rc"; tc "no audio message" "$out" "no audio stream"
for s in "${SENTINELS[@]}"; do tn "R2 gate output has no $s" "$out" "$s"; done

# ---------------------------------------------------------------- 12b. nothing ever left the machine
t "no curl in this run named a non-loopback host" 0 "$(grep -E 'https?://' "$T/argv.log" | grep -vc 'http://127.0.0.1')"

# ---------------------------------------------------------------- 13. worker env contract
t "handler default equals config default" 1 "$(grep -c 'PLATFORM_LIMIT_S = int(os.environ.get("EXEC_TIMEOUT_S", "900"))' "$ROOT/worker/handler.py")"

echo
echo "infra tests: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]

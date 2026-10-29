#!/usr/bin/env bash
# Offline tests for scripts/download-models.sh: mock HF server + fake volume dir.
# No network, no GPU, no real token. Run: make -f scripts/models.mk test-models
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
SCRIPT=$ROOT/scripts/download-models.sh
REAL_LOCK=$ROOT/scripts/models.lock
T=$(mktemp -d)
TOKEN=hf_TESTTOKEN_do_not_leak_12345
REV=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PASS=0 FAIL=0 SERVER_PID=""

cleanup() { stop_server; rm -rf "$T"; }
trap cleanup EXIT

ok() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
check() { # name cmd...
  local name=$1
  shift
  if "$@"; then ok "$name"; else bad "$name"; fi
}
has() { grep -q -- "$2" "$1"; }
hasnt() { ! grep -q -- "$2" "$1"; }

# --- fixtures
mkdir -p "$T/srv/a" "$T/srv/b" "$T/srv/c" "$T/srv/z"
head -c 300000 /dev/urandom >"$T/srv/a/one.bin"
head -c 200000 /dev/urandom >"$T/srv/b/two.bin"
head -c 1000 /dev/urandom >"$T/srv/c/opt.bin"
head -c 500 /dev/urandom >"$T/srv/z/extra.bin"
sz() { stat -c %s "$1"; }
sh256() { sha256sum "$1" | cut -d' ' -f1; }

write_lock() { # file hashmode(real|null)
  local h1=null h2=null h3=null
  if [[ $2 == real ]]; then
    h1=$(sh256 "$T/srv/a/one.bin") h2=$(sh256 "$T/srv/b/two.bin") h3=$(sh256 "$T/srv/c/opt.bin")
  fi
  cat >"$1" <<EOF
# repo=Org/Repo
# rev=$REV
# rev_date=2026-10-11
$h1  $(sz "$T/srv/a/one.bin")  a/one.bin  default
$h2  $(sz "$T/srv/b/two.bin")  b/two.bin  default
$h3  $(sz "$T/srv/c/opt.bin")  c/opt.bin  optional
EOF
}
write_lock "$T/lock.good" real
write_lock "$T/lock.null" null

start_server() { # extra mock args...
  stop_server
  rm -f "$T/port" "$T/req.log"
  : >"$T/req.log"
  python3 -I "$HERE/mock_hf.py" --root "$T/srv" --rev "$REV" --token "$TOKEN" \
    --log "$T/req.log" --portfile "$T/port" "$@" &
  SERVER_PID=$!
  local n=0
  while [[ ! -s $T/port ]] && ((n < 100)); do sleep 0.1; n=$((n + 1)); done
  HF_ENDPOINT="http://127.0.0.1:$(cat "$T/port")"
  export HF_ENDPOINT
}
stop_server() {
  if [[ -n $SERVER_PID ]]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  SERVER_PID=""
}

new_vol() { VOL=$T/vol$RANDOM; mkdir -p "$VOL"; }
# run the script with fake volume; output to $T/out (stdout+stderr), status in $RC
run() {
  HF_TOKEN=$TOKEN LOCK_FILE=$LOCK SKIP_MOUNT_CHECK=1 WORKFLOWS_SRC=${WF:-$T/nowf} CURL_RETRY_DELAY=1 \
    "$SCRIPT" --volume-root "$VOL" "$@" >"$T/out" 2>&1
  RC=$?
}
nreq() { grep -c "resolve" "$T/req.log" || true; }

# ================================================================ real lock
LOCK=$REAL_LOCK
check "real lock: default total is 41,427,929,848 bytes" \
  test "$(awk '!/^#/&&NF&&$4=="default"{s+=$2}END{print s}' "$REAL_LOCK")" = 41427929848
check "real lock: pinned commit in header" has "$REAL_LOCK" '^# rev=49b093a39c19169a8a81721dcc541e07e945232f$'
check "real lock: hashes all pending" test "$(awk '!/^#/&&NF&&$1!="null"' "$REAL_LOCK" | wc -l)" = 0
expected="diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors 21504034224
text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors 15372969374
vae/ltx-2.5-video-vae-bf16.safetensors 1472223346
vae/ltx-2.5-audio-vae-bf16.safetensors 364866540
latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors 995778752
latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors 261944000
model_patches/ltx-2.5-duration-head-bf16.safetensors 3843690
vae/ltx-2.5-video-vae-conv-bf16.safetensors 1452269922
loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors 8899889568"
check "real lock: paths and sizes match the design note" \
  test "$(awk '!/^#/&&NF{print $3, $2}' "$REAL_LOCK")" = "$expected"
check "--list prints category, filename, path, set (tab separated)" \
  test "$(LOCK_FILE=$REAL_LOCK "$SCRIPT" --list | head -n1 | awk -F'\t' '{print NF" "$1" "$4}')" = "4 diffusion_models default"

new_vol
LOCK=$REAL_LOCK run
check "refuses download while hashes pending, points to --update-lock" \
  bash -c "test $RC -ne 0 && grep -q -- '--update-lock' '$T/out'"
check "pending refusal made no HTTP request and wrote nothing" test ! -e "$VOL/models"
LOCK=$REAL_LOCK run --verify
check "--verify also refuses while pending" test "$RC" -ne 0

# ================================================================ download
LOCK=$T/lock.good
start_server
new_vol
run
check "first run exits 0" test "$RC" = 0
check "files present with right content" bash -c "cmp -s '$T/srv/a/one.bin' '$VOL/models/a/one.bin' && cmp -s '$T/srv/b/two.bin' '$VOL/models/b/two.bin'"
check "optional (lora) not fetched by default" test ! -e "$VOL/models/c/opt.bin"
check "no .partial left" test -z "$(find "$VOL" -name '*.partial')"
check ".manifest-rev written" has "$VOL/models/.manifest-rev" "rev=$REV"
check "table lists downloaded" has "$T/out" downloaded
check "token never printed" hasnt "$T/out" "$TOKEN"
check "token not sent to the redirect (CDN) host" bash -c "! grep '/cdn/' '$T/req.log' | grep -q ' yes\$'"
check "resolve requests carried the token" bash -c "grep 'resolve' '$T/req.log' | grep -q ' yes\$'"

: >"$T/req.log"
run
check "second run exits 0 and makes no HTTP request" bash -c "test $RC = 0 && test ! -s '$T/req.log'"
check "second run reports skipped" has "$T/out" skipped

# truncate -> redownload
truncate -s 1000 "$VOL/models/a/one.bin"
run
check "truncated file is re-downloaded" bash -c "test $RC = 0 && cmp -s '$T/srv/a/one.bin' '$VOL/models/a/one.bin'"

# same-size bit flip: skipped by normal run, caught by --verify
printf 'X' | dd of="$VOL/models/b/two.bin" bs=1 seek=10 conv=notrunc status=none
run
check "normal run trusts size (skips same-size flip)" test "$RC" = 0
run --verify
check "--verify catches a same-size flip" bash -c "test $RC -ne 0 && grep -q BAD-HASH '$T/out'"
cp "$T/srv/b/two.bin" "$VOL/models/b/two.bin"
run --verify
check "--verify passes on good files" bash -c "test $RC = 0 && grep -q OK '$T/out'"
rm "$VOL/models/b/two.bin"
run --verify
check "--verify reports MISSING" bash -c "test $RC -ne 0 && grep -q MISSING '$T/out'"

# --with-lora
run --with-lora
check "--with-lora fetches the optional file" bash -c "test $RC = 0 && cmp -s '$T/srv/c/opt.bin' '$VOL/models/c/opt.bin'"

# corrupt server copy -> partial deleted, non-zero
new_vol
cp "$T/srv/b/two.bin" "$T/two.orig"
printf 'Y' | dd of="$T/srv/b/two.bin" bs=1 seek=5 conv=notrunc status=none
run
check "corrupt upstream: non-zero exit" test "$RC" -ne 0
check "corrupt upstream: no final file and partial deleted" \
  bash -c "test ! -e '$VOL/models/b/two.bin' && test ! -e '$VOL/models/b/two.bin.partial'"
check "corrupt upstream: FAILED in table" has "$T/out" FAILED
cp "$T/two.orig" "$T/srv/b/two.bin"

# resume from existing .partial
new_vol
mkdir -p "$VOL/models/a"
head -c 100000 "$T/srv/a/one.bin" >"$VOL/models/a/one.bin.partial"
run
check "resume from .partial succeeds" bash -c "test $RC = 0 && cmp -s '$T/srv/a/one.bin' '$VOL/models/a/one.bin'"
check "resume sent a Range request" bash -c "grep '/cdn/' '$T/req.log' | grep -q 'bytes=100000-'"

# connection dropped mid-download -> curl retries with Range
start_server --drop-after 5000
new_vol
run
check "dropped connection: run succeeds after retry" bash -c "test $RC = 0 && cmp -s '$T/srv/a/one.bin' '$VOL/models/a/one.bin'"
check "dropped connection: retry used Range" bash -c "grep '/cdn/' '$T/req.log' | grep -q 'bytes=[1-9]'"

# orphan partial cleanup + prune
start_server
new_vol
run
mkdir -p "$VOL/models/old"
echo junk >"$VOL/models/old/gone.safetensors"
echo junk >"$VOL/models/old/gone2.safetensors.partial"
mkdir -p "$VOL/models/c"
echo junk >"$VOL/models/c/opt.bin"
run --prune --dry-run
check "prune --dry-run removes nothing" bash -c "test $RC = 0 && test -e '$VOL/models/old/gone.safetensors' && grep -q 'would remove old/gone.safetensors' '$T/out'"
run --prune
check "prune removes files not in lock (and stray partials)" \
  bash -c "test ! -e '$VOL/models/old/gone.safetensors' && test ! -e '$VOL/models/old/gone2.safetensors.partial'"
check "prune keeps locked files (incl. optional) and .manifest-rev" \
  bash -c "test -e '$VOL/models/a/one.bin' && test -e '$VOL/models/c/opt.bin' && test -e '$VOL/models/.manifest-rev'"

# ================================================================ auth / guards
new_vol
HF_TOKEN="" LOCK_FILE=$LOCK SKIP_MOUNT_CHECK=1 "$SCRIPT" --volume-root "$VOL" >"$T/out" 2>&1
check "missing HF_TOKEN: clear message, non-zero" bash -c "test $? -ne 0 && grep -q 'HF_TOKEN is not set' '$T/out'"

start_server --token other_token_value
new_vol
run
check "401: invalid-token message, non-zero" bash -c "test $RC -ne 0 && grep -q 'HTTP 401' '$T/out' && grep -q 'invalid or expired' '$T/out'"
check "401: token not printed" hasnt "$T/out" "$TOKEN"

start_server --status 403
new_vol
run
check "403: license-acceptance message with model URL" bash -c "test $RC -ne 0 && grep -q 'HTTP 403' '$T/out' && grep -q 'huggingface.co/Org/Repo' '$T/out' && grep -q 'SAME account' '$T/out'"
check "403: token not printed" hasnt "$T/out" "$TOKEN"

start_server
new_vol
HF_TOKEN=$TOKEN LOCK_FILE=$LOCK SKIP_MOUNT_CHECK=1 CURL_RETRY_DELAY=1 bash -x "$SCRIPT" --volume-root "$VOL" >"$T/out" 2>&1
check "bash -x run succeeds" test "$?" = 0
check "bash -x trace never contains the token" hasnt "$T/out" "$TOKEN"

# mountpoint guard (no SKIP_MOUNT_CHECK)
new_vol
HF_TOKEN=$TOKEN LOCK_FILE=$LOCK "$SCRIPT" --volume-root "$VOL" >"$T/out" 2>&1
check "non-mountpoint volume root is refused" bash -c "test $? -ne 0 && grep -q 'not a mountpoint' '$T/out'"
check "non-mountpoint refusal wrote nothing" test ! -e "$VOL/models"
HF_TOKEN=$TOKEN LOCK_FILE=$LOCK "$SCRIPT" --volume-root "$T/does-not-exist" >"$T/out" 2>&1
check "missing volume root is refused" bash -c "test $? -ne 0 && grep -q 'does not exist' '$T/out'"
if mountpoint -q /dev/shm 2>/dev/null; then
  LOCK_FILE=$LOCK WORKFLOWS_SRC=$T/nowf "$SCRIPT" --workflows-only --volume-root /dev/shm >"$T/out" 2>&1
  check "real mountpoint (/dev/shm) passes the guard" test "$?" = 0
  rm -rf /dev/shm/workflows
fi
new_vol
VOLUME_ROOT=$VOL HF_TOKEN=$TOKEN LOCK_FILE=$LOCK SKIP_MOUNT_CHECK=1 WORKFLOWS_SRC=$T/nowf "$SCRIPT" --workflows-only >"$T/out" 2>&1
check "VOLUME_ROOT env is honoured" test -d "$VOL"
VOLUME_ROOT=$T/bogus HF_TOKEN=$TOKEN LOCK_FILE=$LOCK SKIP_MOUNT_CHECK=1 WORKFLOWS_SRC=$T/nowf "$SCRIPT" --workflows-only --volume-root "$VOL" >"$T/out" 2>&1
check "--volume-root flag overrides env" test "$?" = 0

# free space guard
cat >"$T/lock.huge" <<EOF
# repo=Org/Repo
# rev=$REV
$(printf 'a%.0s' {1..64})  900000000000000  a/one.bin  default
EOF
new_vol
: >"$T/req.log"
LOCK=$T/lock.huge run
check "insufficient free space is refused before any download" \
  bash -c "test $RC -ne 0 && grep -q 'not enough free space' '$T/out'"
check "free-space refusal made no download request" test "$(nreq)" = 0

# ================================================================ workflows
mkdir -p "$T/wf_ok" "$T/wf_bad"
echo '{"1": {"class_type": "X"}}' >"$T/wf_ok/t2v.json"
echo '{"1": {"class_type": "X"}}' >"$T/wf_ok/i2v.json"
echo '{"1": ' >"$T/wf_bad/v2v.json"
cp "$T/wf_ok/t2v.json" "$T/wf_bad/t2v.json"
LOCK=$T/lock.good
new_vol
WF=$T/nowf run --workflows-only
check "workflows/ absent: warning, exit 0" bash -c "test $RC = 0 && grep -q WARNING '$T/out'"
WF=$T/wf_bad run --workflows-only
check "invalid workflow JSON: fails, nothing copied" bash -c "test $RC -ne 0 && test ! -e '$VOL/workflows/t2v.json'"
WF=$T/wf_ok run --workflows-only
check "--workflows-only copies workflows" bash -c "test $RC = 0 && cmp -s '$T/wf_ok/t2v.json' '$VOL/workflows/t2v.json' && test -e '$VOL/workflows/i2v.json'"
check "--workflows-only touches no model files" test ! -e "$VOL/models"
check "no temp files left in workflows/" test -z "$(find "$VOL/workflows" -name '.*')"
new_vol
WF=$T/wf_ok run
check "full run also syncs workflows" bash -c "test $RC = 0 && test -e '$VOL/workflows/v2v.json' -o -e '$VOL/workflows/t2v.json'"

# ================================================================ update-lock
cp "$T/lock.null" "$T/lock.upd"
start_server --page-size 2
LOCK=$T/lock.upd HF_TOKEN=$TOKEN LOCK_FILE=$T/lock.upd "$SCRIPT" --update-lock >"$T/out" 2>&1
check "--update-lock exits 0 (paginated tree, 4 files / page size 2)" test "$?" = 0
check "update-lock: hashes filled in" test "$(awk '!/^#/&&NF&&$1=="null"' "$T/lock.upd" | wc -l)" = 0
check "update-lock: hash equals sha256 of file" has "$T/lock.upd" "$(sh256 "$T/srv/a/one.bin")  $(sz "$T/srv/a/one.bin")  a/one.bin  default"
check "update-lock: optional set preserved, extra HF files not added" \
  bash -c "grep -q 'c/opt.bin  optional' '$T/lock.upd' && ! grep -q extra.bin '$T/lock.upd'"
check "update-lock: header has rev and commit date" bash -c "grep -q '^# rev=$REV' '$T/lock.upd' && grep -q '^# rev_date=2026-10-11' '$T/lock.upd'"
check "update-lock: token not printed" hasnt "$T/out" "$TOKEN"
check "update-lock: pagination followed (several tree requests)" test "$(grep -c '/tree/' "$T/req.log")" -ge 2
LOCK=$T/lock.upd
new_vol
WF=$T/nowf run
check "download with updated lock verifies OK" bash -c "test $RC = 0 && cmp -s '$T/srv/a/one.bin' '$VOL/models/a/one.bin'"

cp "$T/lock.null" "$T/lock.nolfs"
start_server --no-lfs b/two.bin
LOCK_FILE=$T/lock.nolfs HF_TOKEN=$TOKEN "$SCRIPT" --update-lock >"$T/out" 2>&1
check "update-lock fails when a file has no LFS sha256" bash -c "test $? -ne 0 && grep -q 'no LFS sha256' '$T/out'"
check "failed update-lock leaves the lock untouched" cmp -s "$T/lock.null" "$T/lock.nolfs"
LOCK_FILE=$T/lock.nolfs HF_TOKEN="" "$SCRIPT" --update-lock >"$T/out" 2>&1
check "update-lock without HF_TOKEN fails clearly" bash -c "test $? -ne 0 && grep -q 'HF_TOKEN is not set' '$T/out'"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
((FAIL == 0))

#!/usr/bin/env bash
# Download the LTX-2.5 model files onto the RunPod network volume.
# Source of truth for what to fetch: scripts/models.lock (pinned HF commit + sha256).
# Run on a temporary pod with the volume attached. See README "Models".
# Dependencies: bash 5.0+ (uses 'local -'), flock (util-linux), curl 7.71+, sha256sum, coreutils (python3 only for
# --update-lock and workflow JSON validation).
# HF_TOKEN is read from the environment only and is never printed or logged.
set -euo pipefail

if ((BASH_VERSINFO[0] < 5)); then
  echo "[models] ERROR: bash 5.0+ is required (found $BASH_VERSION). Ubuntu 22.04 pod images ship bash 5.1." >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
LOCK_FILE=${LOCK_FILE:-$SCRIPT_DIR/models.lock}
WORKFLOWS_SRC=${WORKFLOWS_SRC:-$REPO_ROOT/workflows}
HF_ENDPOINT=${HF_ENDPOINT:-https://huggingface.co}
HF_ENDPOINT=${HF_ENDPOINT%/}
FREE_SLACK_BYTES=${FREE_SLACK_BYTES:-5000000000}
JOBS=${JOBS:-2}
NO_LOCK=${NO_LOCK:-0}
CURL_RETRY_DELAY=${CURL_RETRY_DELAY:-2}
VOLUME_ROOT=${VOLUME_ROOT:-}

ACTION=download
WITH_LORA=0
DRY_RUN=0
REV_OVERRIDE=""

log() { printf '[models] %s\n' "$*" >&2; }
die() { printf '[models] ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: download-models.sh [action] [options]

Actions (default: download the default set, verify, then sync workflows):
  --verify          Re-hash files already on the volume against the lock. Read-only,
                    needs no token or network. Non-zero if any file is missing or bad.
  --prune           Remove files under <volume>/models that are not in the lock
                    (and stray .partial files). Use --dry-run to preview.
  --update-lock     Regenerate sha256/size in scripts/models.lock from the Hugging
                    Face API (needs HF_TOKEN). Review the git diff afterwards.
  --workflows-only  Only copy workflows/*.json to <volume>/workflows/.
  --list            Print the lock as tab-separated: category, filename, repo_path, set.

Options:
  --with-lora          Also handle the optional (LoRA) entries.
  --volume-root DIR    Volume mount (env VOLUME_ROOT; default /runpod-volume if it
                       exists, else /workspace).
  --rev REV            With --update-lock: pin a different HF revision.
  --dry-run            With --prune: only list what would be removed.
  --no-lock            (or NO_LOCK=1) Skip the per-volume run lock, e.g. if the volume
                       filesystem does not support flock. Supervised single run only.
  -h, --help

Environment: HF_TOKEN (read-only token; env only), HF_ENDPOINT, VOLUME_ROOT,
SKIP_MOUNT_CHECK=1 (escape hatch if the mountpoint check wrongly fails on a pod).
EOF
}

while (($#)); do
  case $1 in
    --verify) ACTION=verify ;;
    --prune) ACTION=prune ;;
    --update-lock) ACTION=update-lock ;;
    --workflows-only) ACTION=workflows ;;
    --list) ACTION=list ;;
    --with-lora) WITH_LORA=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-lock) NO_LOCK=1 ;;
    --volume-root) (($# >= 2)) || die "--volume-root needs a value"; VOLUME_ROOT=$2; shift ;;
    --volume-root=*) VOLUME_ROOT=${1#*=} ;;
    --rev) (($# >= 2)) || die "--rev needs a value"; REV_OVERRIDE=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[[ $JOBS =~ ^[1-9][0-9]*$ ]] || die "JOBS must be an integer >= 1 (got '$JOBS')"

# ---------------------------------------------------------------- lock parsing
LOCK_REPO="" LOCK_REV="" LOCK_REV_DATE=""
LOCK_SHA=() LOCK_SIZE=() LOCK_PATH=() LOCK_SET=()
declare -A IN_LOCK=()

parse_lock() {
  [[ -f $LOCK_FILE ]] || die "lock file not found: $LOCK_FILE"
  local line h s p set k v
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line =~ ^#[[:space:]]*(repo|rev|rev_date)=(.*)$ ]]; then
      k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
      case $k in repo) LOCK_REPO=$v ;; rev) LOCK_REV=$v ;; rev_date) LOCK_REV_DATE=$v ;; esac
      continue
    fi
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    read -r h s p set <<<"$line"
    [[ $h == null || $h =~ ^[0-9a-f]{64}$ ]] || die "bad sha256 in lock: $line"
    [[ $s =~ ^[0-9]+$ ]] || die "bad size in lock: $line"
    [[ $p =~ ^[A-Za-z0-9._/-]+$ && $p != /* && $p != *..* ]] || die "bad path in lock: $line"
    [[ $set == default || $set == optional ]] || die "bad set in lock: $line"
    LOCK_SHA+=("$h") LOCK_SIZE+=("$s") LOCK_PATH+=("$p") LOCK_SET+=("$set")
    IN_LOCK["$p"]=1
  done <"$LOCK_FILE"
  [[ -n $LOCK_REPO && $LOCK_REV =~ ^[0-9a-f]{40}$ ]] || die "lock header needs repo= and a 40-hex rev="
  ((${#LOCK_PATH[@]} > 0)) || die "lock has no entries"
}

SEL=()
select_files() {
  local i
  SEL=()
  for i in "${!LOCK_PATH[@]}"; do
    if [[ ${LOCK_SET[$i]} == default ]] || { ((WITH_LORA)) && [[ ${LOCK_SET[$i]} == optional ]]; }; then
      SEL+=("$i")
    fi
  done
}

refuse_if_pending() {
  local i
  for i in "${SEL[@]}"; do
    if [[ ${LOCK_SHA[$i]} == null ]]; then
      die "sha256 hashes in $LOCK_FILE are still pending. Run: HF_TOKEN=... $0 --update-lock (then review and commit the lock)."
    fi
  done
}

# ---------------------------------------------------------------- token / curl
require_token() {
  local - bad='[[:space:][:cntrl:]"\\]'
  set +x # never trace expansions of the token
  { [[ -v HF_TOKEN ]] && ((${#HF_TOKEN} > 0)); } || die "HF_TOKEN is not set. Export a read-only Hugging Face token (env var only)."
  if [[ $HF_TOKEN =~ $bad ]]; then
    die "HF_TOKEN contains whitespace, a newline or another invalid character (a stray newline from pasting is common). Re-enter it without them. (The token is not shown.)"
  fi
}

# Emits a curl config on stdout so the token never appears in argv. xtrace is
# disabled inside so 'bash -x' cannot leak it either.
auth_config() {
  set +x
  printf 'header = "Authorization: Bearer %s"\n' "$HF_TOKEN"
}

explain_http() { # code url
  case $1 in
    401) die "HTTP 401: the Hugging Face token is invalid or expired. Create a read-only token and export it as HF_TOKEN." ;;
    403) die "HTTP 403: access to $LOCK_REPO is not granted. Open https://huggingface.co/$LOCK_REPO, accept the LTX license with the SAME account that owns the token, then retry." ;;
    404) die "HTTP 404 for $2 (check repo/revision/path in the lock)." ;;
    000) die "no HTTP response from $HF_ENDPOINT (network problem?)." ;;
    *) die "HTTP $1 for $2" ;;
  esac
}

check_curl() {
  command -v curl >/dev/null || die "curl not found"
  # capture first: `curl --help all | grep -q` lets grep exit early, curl gets SIGPIPE and
  # pipefail turns that into a false "too old"
  local help
  help=$(curl --help all 2>/dev/null) || true
  [[ $help == *--retry-all-errors* ]] || die "curl too old (need 7.71+ for --retry-all-errors)"
}

# ---------------------------------------------------------------- volume
resolve_volume() {
  if [[ -z $VOLUME_ROOT ]]; then
    if [[ -d /runpod-volume ]]; then VOLUME_ROOT=/runpod-volume; else VOLUME_ROOT=/workspace; fi
  fi
  VOLUME_ROOT=${VOLUME_ROOT%/}
  [[ -d $VOLUME_ROOT ]] || die "volume root $VOLUME_ROOT does not exist. Attach the network volume to the pod (US-WA-1), or pass --volume-root."
  if [[ ${SKIP_MOUNT_CHECK:-0} == 1 ]]; then
    log "WARNING: mountpoint check skipped (SKIP_MOUNT_CHECK=1); files may land on container disk"
  elif ! mountpoint -q "$VOLUME_ROOT"; then
    die "$VOLUME_ROOT is not a mountpoint. Refusing to write to container disk. Attach the network volume, or pass --volume-root DIR for the actual mount."
  fi
  MODELS_DIR=$VOLUME_ROOT/models
}

# One download/prune run per volume at a time (the lock file lives on the volume,
# so it also covers two pods). Held until the script exits.
acquire_run_lock() {
  mkdir -p "$MODELS_DIR"
  local lockf=$MODELS_DIR/.run.lock rc=0
  if [[ $NO_LOCK == 1 ]]; then
    log "WARNING: --no-lock: running without the run lock; make sure no other run uses this volume"
    return 0
  fi
  if ! command -v flock >/dev/null; then
    log "WARNING: flock not found; concurrent runs are not prevented"
    return 0
  fi
  [[ -L $lockf ]] && die "$lockf is a symlink; refusing to open it. Remove it and retry."
  exec 9>>"$lockf" || die "cannot open lock file $lockf (filesystem problem?). Re-run with --no-lock for a supervised single run."
  flock -n -E 200 9 || rc=$?
  case $rc in
    0) ;;
    200) die "another download-models run is already using $VOLUME_ROOT (lock $lockf). Wait for it to finish." ;;
    *) die "could not take the run lock $lockf (flock exit $rc); the volume filesystem may not support locks. For a supervised single run, re-run with --no-lock." ;;
  esac
}

# ---------------------------------------------------------------- actions
do_list() {
  local i
  for i in "${!LOCK_PATH[@]}"; do
    printf '%s\t%s\t%s\t%s\n' "${LOCK_PATH[$i]%%/*}" "${LOCK_PATH[$i]##*/}" "${LOCK_PATH[$i]}" "${LOCK_SET[$i]}"
  done
}

file_size() { stat -c %s -- "$1"; }
hash_of() { sha256sum -- "$1" | cut -d' ' -f1; }

do_verify() {
  local i f bad=0 st
  refuse_if_pending
  printf '%-9s %14s  %s\n' STATUS BYTES PATH
  for i in "${SEL[@]}"; do
    f=$MODELS_DIR/${LOCK_PATH[$i]}
    if [[ ! -f $f ]]; then st=MISSING; bad=1
    elif [[ $(file_size "$f") != "${LOCK_SIZE[$i]}" ]]; then st=BAD-SIZE; bad=1
    elif [[ $(hash_of "$f") != "${LOCK_SHA[$i]}" ]]; then st=BAD-HASH; bad=1
    else st=OK; fi
    printf '%-9s %14s  %s\n' "$st" "${LOCK_SIZE[$i]}" "${LOCK_PATH[$i]}"
  done
  return $bad
}

do_prune() {
  local f rel base n=0
  [[ -d $MODELS_DIR ]] || { log "nothing to prune: $MODELS_DIR missing"; return 0; }
  while IFS= read -r -d '' f; do
    rel=${f#"$MODELS_DIR"/}
    [[ $rel == .manifest-rev || $rel == .run.lock ]] && continue
    base=${rel%.partial}
    [[ -n ${IN_LOCK[$base]:-} ]] && continue
    n=$((n + 1))
    if ((DRY_RUN)); then log "would remove $rel"; else rm -f -- "$f"; log "removed $rel"; fi
  done < <(find "$MODELS_DIR" -mindepth 1 ! -type d -print0)
  if ((DRY_RUN)); then log "$n file(s) would be removed"; else log "$n file(s) removed"; fi
}

sync_workflows() {
  local files=() f dest=$VOLUME_ROOT/workflows tmp
  shopt -s nullglob
  files=("$WORKFLOWS_SRC"/*.json)
  shopt -u nullglob
  if ((${#files[@]} == 0)); then
    log "WARNING: no workflows/*.json found in $WORKFLOWS_SRC; nothing copied"
    return 0
  fi
  if command -v python3 >/dev/null; then
    for f in "${files[@]}"; do
      python3 -m json.tool "$f" >/dev/null 2>&1 || die "invalid JSON, nothing copied: $f"
    done
  else
    log "WARNING: python3 not found; workflow JSON not validated"
  fi
  mkdir -p "$dest"
  for f in "${files[@]}"; do
    tmp=$(mktemp "$dest/.${f##*/}.XXXXXX")
    cp -- "$f" "$tmp"
    chmod 644 "$tmp"
    mv -f -- "$tmp" "$dest/${f##*/}"
    log "workflow copied: ${f##*/}"
  done
}

# curl's own --retry restarts from byte 0 after a dropped connection, so the
# retry loop is here: every fresh curl run resumes the .partial with -C -.
curl_dl() { # url partial expected_size
  local try
  for try in 1 2 3 4 5 6; do
    : "try $try"
    if curl -fL -C - -sS \
      --config <(auth_config) -o "$2" "$1"; then
      return 0
    fi
    [[ -f $2 ]] && (($(file_size "$2") == $3)) && return 0 # already complete (416)
    sleep "$CURL_RETRY_DELAY"
  done
  return 1
}

# Runs in a background subshell; result goes to $WORK/<idx>.
fetch_one() {
  local i=$1 path=${LOCK_PATH[$1]} size=${LOCK_SIZE[$1]} sha=${LOCK_SHA[$1]}
  local final=$MODELS_DIR/$path part=$MODELS_DIR/$path.partial
  local url=$HF_ENDPOINT/$LOCK_REPO/resolve/$LOCK_REV/$path attempt psize
  mkdir -p "$(dirname "$final")"
  rm -f -- "$final"
  for attempt in 1 2; do
    psize=0
    if [[ -f $part ]]; then
      psize=$(file_size "$part")
      if ((psize > size)); then rm -f -- "$part"; psize=0; fi
    fi
    if ((psize != size)); then
      log "downloading $path (attempt $attempt, resume from $psize)"
      if ! curl_dl "$url" "$part" "$size"; then
        echo "FAILED download (partial kept for resume)" >"$WORK/$i"
        return 0
      fi
    fi
    if [[ $(file_size "$part") == "$size" && $(hash_of "$part") == "$sha" ]]; then
      mv -f -- "$part" "$final"
      sync -- "$final" 2>/dev/null || sync
      echo downloaded >"$WORK/$i"
      return 0
    fi
    log "size/sha256 mismatch for $path; discarding partial"
    rm -f -- "$part"
  done
  echo "FAILED verification (sha256/size mismatch after retry)" >"$WORK/$i"
}

# Free bytes on the volume, as an integer. Never goes through awk arithmetic or floating
# point (a 249T value printed as 2.73413e+14 once broke the guard), and a df line that
# can not be parsed is a loud error, not a skipped check.
NETFS_RE='^(fuse|fuseblk|fuse\..*|nfs[0-9]*|cifs|smb3?|smbfs|ceph|glusterfs|lustre|9p|beegfs|moosefs|mfs)$'
NETFS_PLAUSIBLE_KB=$((4 * 1024 * 1024 * 1024)) # 4 TiB in KiB; RunPod volumes max out at 4096 GB
volume_free_bytes() {
  local line fs fstype size_kb used_kb avail_kb
  line=$(df -PkT "$VOLUME_ROOT" 2>/dev/null | awk 'NR==2') || line=
  # shellcheck disable=SC2034
  read -r fs fstype size_kb used_kb avail_kb _ <<<"$line"
  if ! [[ $size_kb =~ ^[0-9]+$ && $avail_kb =~ ^[0-9]+$ && -n $fstype ]]; then
    die "could not parse the free space of $VOLUME_ROOT from 'df -PkT' (got: '${line:-nothing}'). Refusing to continue without a free-space check; verify the volume size by hand."
  fi
  if [[ $fstype =~ $NETFS_RE ]] && ((size_kb > NETFS_PLAUSIBLE_KB)); then
    log "note: $VOLUME_ROOT is a shared network filesystem ($fstype) reporting $((size_kb / 1024 / 1024 / 1024)) TiB in total, far more than any volume. The volume quota set on RunPod, not df, is the real limit; the free figure below is the cluster's. Still refusing if even that is too small."
  fi
  printf '%s' "$((avail_kb * 1024))"
}

do_download() {
  local i f need=0 have free total=0 st failed=0 smallest=-1 code url
  refuse_if_pending
  require_token
  check_curl
  acquire_run_lock
  for f in "${LOCK_PATH[@]}"; do mkdir -p "$MODELS_DIR/${f%/*}"; done # incl. empty loras/
  log "repo $LOCK_REPO at pinned commit $LOCK_REV (${LOCK_REV_DATE:-date unknown})"
  declare -gA STATE=()
  local todo=()
  for i in "${SEL[@]}"; do
    f=$MODELS_DIR/${LOCK_PATH[$i]}
    if [[ -f $f && $(file_size "$f") == "${LOCK_SIZE[$i]}" ]]; then
      STATE[$i]=skipped
    else
      todo+=("$i")
      have=0
      [[ -f $f.partial ]] && have=$(file_size "$f.partial")
      need=$((need + LOCK_SIZE[i] - (have > LOCK_SIZE[i] ? 0 : have)))
    fi
    if ((smallest < 0)) || ((LOCK_SIZE[i] < LOCK_SIZE[smallest])); then smallest=$i; fi
  done
  prune_orphan_partials

  if ((${#todo[@]} > 0)); then
    log "volume $VOLUME_ROOT (on a RunPod network volume df shows the shared cluster filesystem, not the 80 GB quota):"
    df -hT "$VOLUME_ROOT" >&2 || true
    free=$(volume_free_bytes)
    if ((free < need + FREE_SLACK_BYTES)); then
      die "not enough free space on $VOLUME_ROOT: need $((need + FREE_SLACK_BYTES)) bytes (missing files + slack), have $free. Run --prune, or grow the volume."
    fi
    url=$HF_ENDPOINT/$LOCK_REPO/resolve/$LOCK_REV/${LOCK_PATH[$smallest]}
    code=$(curl -sS -I -o /dev/null -w '%{http_code}' --config <(auth_config) "$url") || code=000
    case $code in 2* | 3*) ;; *) explain_http "$code" "$url" ;; esac

    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    for i in "${todo[@]}"; do
      while (($(jobs -rp | wc -l) >= JOBS)); do wait -n || true; done
      fetch_one "$i" &
    done
    wait || true
    for i in "${todo[@]}"; do
      STATE[$i]=$(cat "$WORK/$i" 2>/dev/null || echo "FAILED (no result)")
    done
  fi

  printf '%-14s %14s  %s\n' STATUS BYTES PATH
  for i in "${SEL[@]}"; do
    st=${STATE[$i]}
    [[ $st == skipped || $st == downloaded ]] || failed=1
    [[ $st == FAILED* ]] && st="FAILED"
    printf '%-14s %14s  %s\n' "$st" "${LOCK_SIZE[$i]}" "${LOCK_PATH[$i]}"
    total=$((total + LOCK_SIZE[i]))
  done
  printf 'total %s bytes in %s files\n' "$total" "${#SEL[@]}"
  for i in "${SEL[@]}"; do
    [[ ${STATE[$i]} == FAILED* ]] && log "${LOCK_PATH[$i]}: ${STATE[$i]}"
  done
  if ((failed)); then return 1; fi
  {
    echo "rev=$LOCK_REV"
    echo "lock_sha256=$(hash_of "$LOCK_FILE")"
    echo "date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$MODELS_DIR/.manifest-rev.tmp"
  mv -f -- "$MODELS_DIR/.manifest-rev.tmp" "$MODELS_DIR/.manifest-rev"
}

prune_orphan_partials() {
  local f rel
  while IFS= read -r -d '' f; do
    rel=${f#"$MODELS_DIR"/}
    if [[ -z ${IN_LOCK[${rel%.partial}]:-} ]]; then
      rm -f -- "$f"
      log "removed orphan partial $rel"
    fi
  done < <(find "$MODELS_DIR" -name '*.partial' -print0)
}

do_update_lock() {
  require_token
  check_curl
  command -v python3 >/dev/null || die "python3 is required for --update-lock"
  local rev=${REV_OVERRIDE:-$LOCK_REV} tmp url n=0 next
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  url=$HF_ENDPOINT/api/models/$LOCK_REPO/revision/$rev
  code_get "$url" "$tmp/rev.json" "$tmp/rev.hdr"
  url="$HF_ENDPOINT/api/models/$LOCK_REPO/tree/$rev?recursive=true"
  while [[ -n $url ]]; do
    code_get "$url" "$tmp/page.$n.json" "$tmp/page.$n.hdr"
    next=$(sed -n 's/^[Ll]ink:.*<\([^>]*\)>; *rel="next".*/\1/p' "$tmp/page.$n.hdr" | awk 'NR==1')   # awk reads to the end: no SIGPIPE for sed under pipefail
    if [[ -n $next && $next != "$HF_ENDPOINT"/* ]]; then die "pagination link leaves $HF_ENDPOINT; aborting (token safety)"; fi
    url=$next
    n=$((n + 1))
    ((n < 200)) || die "too many tree pages"
  done
  python3 -I - "$LOCK_FILE" "$tmp" "$n" "$LOCK_REPO" "$(date -u +%Y-%m-%d)" >"$tmp/new.lock" <<'PY'
import json, re, sys
lock, tmp, n, repo, today = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
rev = json.load(open(tmp + "/rev.json"))
sha = rev.get("sha", "")
if not re.fullmatch(r"[0-9a-f]{40}", sha):
    sys.exit("HF revision response has no 40-hex sha")
date = (rev.get("lastModified") or "unknown")[:10]
files = {}
for i in range(n):
    for e in json.load(open("%s/page.%d.json" % (tmp, i))):
        if e.get("type") == "file":
            files[e["path"]] = e
rows = []
for line in open(lock):
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    _, _, path, st = line.split()
    e = files.get(path)
    if e is None:
        sys.exit("path not in HF tree at %s: %s" % (sha, path))
    lfs = e.get("lfs") or {}
    if not re.fullmatch(r"[0-9a-f]{64}", lfs.get("oid", "")):
        sys.exit("no LFS sha256 for %s" % path)
    rows.append((lfs["oid"], lfs.get("size", e.get("size")), path, st))
print("""# jubividia model lock: single source of truth for scripts/download-models.sh
# and for the model filenames/folders used by workflows (see README "Models").
# repo=%s
# rev=%s
# rev_date=%s
# hashes=from-hf-api (trust on first use, generated %s; optionally cross-check the
#   transformer sha256 against a second source)
# Columns (whitespace separated): sha256 size_bytes repo_path set
#   repo_path is also the path under <volume>/models/ (folder = ComfyUI category).
#   set = default | optional (optional is fetched only with --with-lora).
#   sha256 'null' would mean pending (refresh with scripts/download-models.sh --update-lock)""" % (repo, sha, date, today))
for r in rows:
    print("%s  %s  %s  %s" % r)
PY
  mv -f -- "$tmp/new.lock" "$LOCK_FILE"
  log "lock updated: $LOCK_FILE (review the git diff, then commit)"
}

code_get() { # url out hdr  (auth passed via config, never argv)
  local code
  code=$(curl -sS -L -D "$3" -o "$2" -w '%{http_code}' --config <(auth_config) "$1") || code=000
  [[ $code == 200 ]] || explain_http "$code" "$1"
}

# ---------------------------------------------------------------- main
parse_lock
select_files
case $ACTION in
  list) do_list ;;
  update-lock) do_update_lock ;;
  workflows) resolve_volume; sync_workflows ;;
  prune) resolve_volume; acquire_run_lock; do_prune ;;
  verify) resolve_volume; do_verify ;;
  download)
    resolve_volume
    do_download
    sync_workflows
    ;;
esac

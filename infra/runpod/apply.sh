#!/usr/bin/env bash
# Create/verify the RunPod resources for jubividia, idempotently, from config.env.
# Usage: infra/runpod/apply.sh [--dry-run] [--yes] [--rotate] [--max-workers N] <command>
#   preflight  volume  secrets  endpoint  pod-up  pod-logs  pod-down  status  teardown-endpoint
# See infra/runpod/README.md and docs/decisions/endpoint.md. Nothing here is free to
# run for real: volume/pod/endpoint creation bill. --dry-run makes no writes.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ROTATE=0
YES=0
MAX_WORKERS_FLAG=
SKIP_GHCR=0
CMD=

usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# Test hook: simulate the process dying between "create" and "write the id back".
maybe_die_after_create() { [[ ${APPLY_TEST_KILL_AFTER_CREATE-} == "$1" ]] && kill -9 $$; return 0; }

# ---------------------------------------------------------------- derived settings
image_ref() {
  local repo tag
  repo=$(cfg IMAGE ghcr.io/ken-ck-yu/ltx25-worker)
  tag=$(cfg IMAGE_TAG)
  [[ -n $tag ]] || die "IMAGE_TAG is not set in config.env (the sha-<short> tag of the CI build; never latest)"
  valid_image_tag "$tag" || die "IMAGE_TAG must match ^sha-[0-9a-f]{7,}\$ (got a tag that does not; 'latest' and bare tags are rejected)"
  [[ ${repo##*/} != *:* && $repo != *@* ]] || die "IMAGE must be a repository without a tag or digest (the tag comes from IMAGE_TAG)"
  printf '%s:%s' "$repo" "$tag"
}

tune_json() {
  local k parts=()
  for k in JOB_TIMEOUT_S COMFY_READY_TIMEOUT_S INPUT_MAX_BYTES POLL_INTERVAL_S VRAM_SAMPLE_S; do
    if [[ -n ${CFG[$k]-} ]]; then
      [[ ${CFG[$k]} =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "$k must be a number"
      parts+=("\"$k\":\"${CFG[$k]}\"")
    fi
  done
  local IFS=,
  printf '{%s}' "${parts[*]-}"
}

desired_endpoint() {
  local img timeout_ms idle min max jt exec_s
  img=$(image_ref)
  need_cfg R2_ACCOUNT_ID R2_BUCKET
  [[ -n ${CFG[RUNPOD_NETWORK_VOLUME_ID]-} ]] || ((DRY_RUN)) || die "RUNPOD_NETWORK_VOLUME_ID is not set: run 'apply.sh volume' first"
  timeout_ms=$(cfg RUNPOD_EXEC_TIMEOUT_MS 900000)
  idle=$(cfg RUNPOD_IDLE_TIMEOUT_S 60)
  min=$(cfg RUNPOD_WORKERS_MIN 0)
  max=${MAX_WORKERS_FLAG:-$(cfg RUNPOD_WORKERS_MAX 2)}
  valid_uint "$timeout_ms" && ((timeout_ms >= 5000 && timeout_ms <= 604800000)) \
    || die "RUNPOD_EXEC_TIMEOUT_MS must be milliseconds between 5000 and 604800000 (RunPod accepts 5 s to 7 days)"
  valid_uint "$idle" && ((idle >= 1 && idle <= 3600)) || die "RUNPOD_IDLE_TIMEOUT_S must be 1..3600"
  valid_uint "$min" && valid_uint "$max" && ((max >= 1 && min <= max)) || die "workers min/max invalid (max >= 1, min <= max)"
  exec_s=$((timeout_ms / 1000))
  jt=$(cfg JOB_TIMEOUT_S 780)
  [[ $jt =~ ^[0-9]+$ ]] && ((jt + 15 < exec_s)) \
    || die "JOB_TIMEOUT_S ($jt) + 15 s safety must be below the execution timeout (${exec_s} s)"
  (
    export EP_NAME EP_IMAGE="$img" EP_VOLUME_ID EP_DC EP_MIN="$min" EP_MAX="$max" EP_IDLE="$idle"
    export EP_TIMEOUT_MS="$timeout_ms" EP_DISK EP_QUEUE_DELAY EP_R2_ACCOUNT_ID EP_R2_BUCKET
    export EP_SECRET_KEY_ID="$SECRET_R2_KEY_ID" EP_SECRET_KEY_SECRET="$SECRET_R2_KEY_SECRET" EP_TUNE_JSON
    EP_NAME=$(cfg RUNPOD_ENDPOINT_NAME jubividia-ltx25)
    EP_VOLUME_ID=$(cfg RUNPOD_NETWORK_VOLUME_ID dry-run-volume-id)
    EP_DC=$(cfg RUNPOD_DC US-WA-1)
    EP_DISK=$(cfg RUNPOD_DISK_GB 20)
    EP_QUEUE_DELAY=$(cfg RUNPOD_QUEUE_DELAY_S 4)
    EP_R2_ACCOUNT_ID=$(cfg R2_ACCOUNT_ID)
    EP_R2_BUCKET=$(cfg R2_BUCKET)
    EP_TUNE_JSON=$(tune_json)
    pyj body-endpoint
  )
}

# ---------------------------------------------------------------- preflight (reads only)
ghcr_check() {
  local repo tag base token code
  repo=$(cfg IMAGE ghcr.io/ken-ck-yu/ltx25-worker)
  tag=$(cfg IMAGE_TAG)
  if [[ $repo != ghcr.io/* ]]; then say "skip GHCR check: image is not on ghcr.io"; return 0; fi
  repo=${repo#ghcr.io/}
  base=${GHCR_BASE:-https://ghcr.io}
  assert_url_allowed "$base"
  token=$(curl -sS --max-time 30 "$base/token?service=ghcr.io&scope=repository:$repo:pull" 2>/dev/null | pyj get token) || true
  [[ -n $token ]] || die "GHCR: could not get an anonymous pull token for $repo (is the package public?)"
  code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -I \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "$base/v2/$repo/manifests/$tag" 2>/dev/null) || true
  [[ $code == 200 ]] || die "GHCR: anonymous manifest fetch for $repo:$tag returned HTTP $code (tag missing or package not public)"
  say "ok   GHCR: $repo:$tag is publicly pullable"
}

cmd_preflight() {
  need_cfg RUNPOD_API_KEY
  local img n
  img=$(image_ref)
  say "ok   image ref: $img"
  if valid_git_ref "$(cfg GIT_REF)"; then say "ok   GIT_REF is a full commit sha"; else warn "GIT_REF is not a 40-hex commit sha (needed by pod-up)"; fi
  api GET /serverless
  api_must "API key / base URL check (GET /serverless at $API_BASE)"
  say "ok   RunPod API reachable, key accepted"
  ((SKIP_GHCR)) || ghcr_check
  n=$(find_ids /network-volumes "name=$(cfg RUNPOD_VOLUME_NAME jubividia-ltx-us-wa1)" "dataCenter=$(cfg RUNPOD_DC US-WA-1)" "type=STANDARD" | grep -c .) || true
  say "info volumes with the exact name+DC: $n (0 = volume will be created, 1 = adopted, >1 = stop)"
  n=$(find_ids /serverless "name=$(cfg RUNPOD_ENDPOINT_NAME jubividia-ltx25)" | grep -c .) || true
  say "info endpoints with the exact name: $n"
  n=$(find_ids /account/secrets "name=$SECRET_R2_KEY_ID" | grep -c .) || true
  say "info secret $SECRET_R2_KEY_ID: $n"
  n=$(find_ids /account/secrets "name=$SECRET_R2_KEY_SECRET" | grep -c .) || true
  say "info secret $SECRET_R2_KEY_SECRET: $n"
  say "TODO (not checkable here): confirm payment method and balance (~\$15) in the console; re-read RTX 6000 Ada stock at the DC and CPU stock right before each billable step."
}

# ---------------------------------------------------------------- volume
cmd_volume() {
  need_cfg RUNPOD_API_KEY
  local name dc gb id ids n cur
  name=$(cfg RUNPOD_VOLUME_NAME jubividia-ltx-us-wa1)
  dc=$(cfg RUNPOD_DC US-WA-1)
  gb=$(cfg RUNPOD_VOLUME_GB 80)
  valid_uint "$gb" && ((gb >= 10 && gb <= 4096)) || die "RUNPOD_VOLUME_GB must be 10..4096"
  id=$(cfg RUNPOD_NETWORK_VOLUME_ID)
  if [[ -n $id ]]; then
    api GET "/network-volumes/$id"
    ((API_STATUS != 404)) || die "RUNPOD_NETWORK_VOLUME_ID=$id does not exist on this account; clear it in config.env if you really want a new volume"
    api_must "GET /network-volumes/$id"
  else
    ids=$(find_ids /network-volumes "name=$name" "dataCenter=$dc" "type=STANDARD")
    n=$(printf '%s\n' "$ids" | grep -c .) || true
    if ((n > 1)); then die "$n volumes named '$name' in $dc; refusing to guess. Set RUNPOD_NETWORK_VOLUME_ID to the right one."; fi
    if ((n == 1)); then
      id=$ids
      say "adopting existing volume $id"
      write_id RUNPOD_NETWORK_VOLUME_ID "$id"
      api GET "/network-volumes/$id"
      api_must "GET /network-volumes/$id"
    else
      say "creating volume '$name' ${gb} GB in $dc (BILLS \$0.07/GB/month = ~\$5.60/month until deleted in the console)"
      api POST /network-volumes "$(V_NAME=$name V_GB=$gb V_DC=$dc pyj body-volume)" show
      api_must "create volume"
      id=$(json_get id)
      [[ -n $id ]] || die "volume create returned no id"
      maybe_die_after_create volume
      write_id RUNPOD_NETWORK_VOLUME_ID "$id"
      ((DRY_RUN)) && return 0
      api GET "/network-volumes/$id"
      api_must "read back volume"
    fi
  fi
  cur=$(json_get size)
  if [[ $cur =~ ^[0-9]+$ ]]; then
    if ((cur > gb)); then die "volume is $cur GB and RUNPOD_VOLUME_GB is $gb: volumes can only grow, refusing to shrink"; fi
    if ((cur < gb)); then
      say "growing volume $id from $cur to $gb GB"
      api PATCH "/network-volumes/$id" "$(V_GB=$gb pyj body-volume-size)" show
      api_must "grow volume"
    fi
  fi
  say "ok   volume $id ($(json_get name), $(json_get dataCenter))"
}

# ---------------------------------------------------------------- secrets
# ensure_secret NAME VALUE ID_KEY   (create if absent; rotate only with --rotate)
ensure_secret() {
  local name=$1 value=$2 idkey=$3 ids n id body
  ids=$(find_ids /account/secrets "name=$name")
  n=$(printf '%s\n' "$ids" | grep -c .) || true
  ((n <= 1)) || die "$n secrets named $name; refusing to guess"
  if ((n == 0)); then
    say "creating secret $name (free)"
    body=$(S_NAME=$name S_VALUE=$value pyj body-secret)
    api POST /account/secrets "$body"
    api_must "create secret $name"
    id=$(json_get id)
    maybe_die_after_create "secret:$name"
    [[ -z $idkey || -z $id ]] || write_id "$idkey" "$id"
  else
    id=$ids
    [[ -z $idkey ]] || write_id "$idkey" "$id"
    if ((ROTATE)); then
      say "rotating secret $name (workers read the new value at their next boot)"
      body=$(S_VALUE=$value pyj body-secret-value)
      api PATCH "/account/secrets/$id" "$body"
      api_must "rotate secret $name"
    else
      say "ok   secret $name exists (use --rotate to change its value)"
    fi
  fi
}

cmd_secrets() {
  need_cfg RUNPOD_API_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  ensure_secret "$SECRET_R2_KEY_ID" "${CFG[R2_ACCESS_KEY_ID]}" RUNPOD_SECRET_ID_R2_KEY_ID
  ensure_secret "$SECRET_R2_KEY_SECRET" "${CFG[R2_SECRET_ACCESS_KEY]}" RUNPOD_SECRET_ID_R2_KEY_SECRET
  say "note: secret values are write-only on RunPod; keep your own copy of the R2 token."
}

# ---------------------------------------------------------------- endpoint
verify_endpoint() { # verify_endpoint ID DESIRED -> patches only differing groups, then re-reads
  local id=$1 desired=$2 groups g pass
  for pass in 1 2; do
    api GET "/serverless/$id"
    api_must "read back endpoint $id"
    groups=$(printf '%s' "$API_BODY" | EP_DESIRED=$desired pyj diff-endpoint)
    if [[ -z $groups ]]; then
      say "ok   endpoint $id matches config on every owned field (read back)"
      return 0
    fi
    if ((pass == 2)); then
      die "endpoint $id still differs on: $(printf '%s' "$groups" | tr '\n' ' '). It was NOT deleted. Inspect it (apply.sh status) and fix that field; for timeout check the unit (milliseconds)."
    fi
    ((DRY_RUN)) && { say "DRY-RUN endpoint differs on: $(printf '%s' "$groups" | tr '\n' ' ')"; }
    for g in $groups; do
      say "endpoint $id: field '$g' differs; patching only that field"
      case $g in
        image | env) say "     (an image/env change creates a new release and replaces workers)" ;;
        gpu) say "     (pools and excludedTypes are always sent together)" ;;
      esac
      api PATCH "/serverless/$id" "$(EP_DESIRED=$desired pyj group-body "$g")" show
      api_must "patch endpoint field $g"
    done
    ((DRY_RUN)) && return 0
  done
}

cmd_endpoint() {
  need_cfg RUNPOD_API_KEY
  local desired id ids n name
  desired=$(desired_endpoint)
  name=$(cfg RUNPOD_ENDPOINT_NAME jubividia-ltx25)
  say "image:   $(image_ref)"
  say "workers: min $(cfg RUNPOD_WORKERS_MIN 0) max ${MAX_WORKERS_FLAG:-$(cfg RUNPOD_WORKERS_MAX 2)}, idleTimeout $(cfg RUNPOD_IDLE_TIMEOUT_S 60) s, flashboot FLASHBOOT, timeout $(cfg RUNPOD_EXEC_TIMEOUT_MS 900000) ms"
  id=$(cfg RUNPOD_ENDPOINT_ID)
  if [[ -n $id ]]; then
    api GET "/serverless/$id"
    ((API_STATUS != 404)) || die "RUNPOD_ENDPOINT_ID=$id does not exist; clear it in config.env if you want it re-created"
    api_must "GET /serverless/$id"
  else
    ids=$(find_ids /serverless "name=$name")
    n=$(printf '%s\n' "$ids" | grep -c .) || true
    ((n <= 1)) || die "$n endpoints named '$name'; refusing to guess. Set RUNPOD_ENDPOINT_ID."
    if ((n == 1)); then
      id=$ids
      say "adopting existing endpoint $id"
      write_id RUNPOD_ENDPOINT_ID "$id"
    else
      say "creating endpoint '$name' (idle cost \$0; a running RTX 6000 Ada worker bills \$1.75/hr)"
      api POST /serverless "$desired" show
      api_must "create endpoint"
      id=$(json_get id)
      [[ -n $id ]] || die "endpoint create returned no id"
      maybe_die_after_create endpoint
      write_id RUNPOD_ENDPOINT_ID "$id"
      ((DRY_RUN)) && return 0
    fi
  fi
  verify_endpoint "$id" "$desired"
}

# ---------------------------------------------------------------- temp pod
pod_ids() { find_ids /pods "name=$POD_NAME"; }

cmd_pod_up() {
  need_cfg RUNPOD_API_KEY HF_TOKEN RUNPOD_NETWORK_VOLUME_ID
  local ref pimg tag ids n body id
  ref=$(cfg GIT_REF)
  valid_git_ref "$ref" || die "GIT_REF must be a full 40-hex commit sha in config.env (no branch names, no HEAD): the pod runs that exact script"
  pimg=$(cfg RUNPOD_POD_IMAGE)
  [[ -n $pimg ]] || die "RUNPOD_POD_IMAGE is not set (a pinned image with bash 5, curl 7.71+, git; chosen from a template/image read)"
  tag=${pimg##*:}
  { [[ $pimg == *:* && $tag != "$pimg" && -n $tag && $tag != latest && $tag != */* ]]; } || die "RUNPOD_POD_IMAGE needs an explicit non-latest tag"
  ids=$(pod_ids)
  n=$(printf '%s\n' "$ids" | grep -c .) || true
  ((n == 0)) || die "pod '$POD_NAME' already exists ($(printf '%s' "$ids" | tr '\n' ' ')); run pod-logs or pod-down first"
  ensure_hf_secret
  body=$(
    export POD_NAME POD_SECRET_HF="$SECRET_HF" POD_GIT_REF="$ref" POD_IMAGE="$pimg"
    export POD_DC POD_VOLUME_ID POD_CPU_ID POD_VCPU POD_SKIP_MOUNT_CHECK
    POD_DC=$(cfg RUNPOD_DC US-WA-1)
    POD_VOLUME_ID=$(cfg RUNPOD_NETWORK_VOLUME_ID)
    POD_CPU_ID=$(cfg RUNPOD_POD_CPU_ID cpu3c)
    POD_VCPU=$(cfg RUNPOD_POD_VCPU 2)
    POD_SKIP_MOUNT_CHECK=$(cfg SKIP_MOUNT_CHECK 0)
    pyj body-pod
  )
  say "creating CPU pod '$POD_NAME' ($(cfg RUNPOD_POD_CPU_ID cpu3c) x $(cfg RUNPOD_POD_VCPU 2) vCPU, secure, ~\$0.06/hr), repo pinned to $ref"
  api POST /pods "$body" show
  api_must "create pod"
  id=$(json_get id)
  [[ -n $id ]] || die "pod create returned no id"
  maybe_die_after_create pod
  write_id RUNPOD_POD_ID "$id"
  cat <<EOF

############################################################################
#  POD $id IS RUNNING AND BILLING (~\$0.06/hr, plus container disk).
#  It sleeps forever after the download. When pod-logs shows
#  "MODELS DONE", run:   infra/runpod/apply.sh pod-down
#  (TERMINATE, not stop). Then rotate the Hugging Face token.
############################################################################
EOF
}

ensure_hf_secret() {
  local ids n id body
  ids=$(find_ids /account/secrets "name=$SECRET_HF")
  n=$(printf '%s\n' "$ids" | grep -c .) || true
  ((n <= 1)) || die "$n secrets named $SECRET_HF"
  if ((n == 0)); then
    say "creating temporary secret $SECRET_HF (deleted again by pod-down)"
    body=$(S_NAME=$SECRET_HF S_VALUE=${CFG[HF_TOKEN]} pyj body-secret)
    api POST /account/secrets "$body"
    api_must "create secret $SECRET_HF"
  else
    id=$ids
    say "updating temporary secret $SECRET_HF"
    body=$(S_VALUE=${CFG[HF_TOKEN]} pyj body-secret-value)
    api PATCH "/account/secrets/$id" "$body"
    api_must "update secret $SECRET_HF"
  fi
}

resolve_pod() { # prints the id of the pod named exactly $POD_NAME, or nothing
  local id=$(cfg RUNPOD_POD_ID) ids n
  if [[ -n $id ]]; then
    api GET "/pods/$id"
    if api_ok && [[ $(json_get name) == "$POD_NAME" ]]; then printf '%s' "$id"; return 0; fi
  fi
  ids=$(pod_ids)
  n=$(printf '%s\n' "$ids" | grep -c .) || true
  ((n <= 1)) || die "$n pods named $POD_NAME; refusing to guess"
  printf '%s' "$ids"
}

cmd_pod_logs() {
  need_cfg RUNPOD_API_KEY
  local id
  id=$(resolve_pod)
  [[ -n $id ]] || die "no pod named $POD_NAME"
  # The route is a server-sent-event stream; read the last lines for a few seconds and stop.
  HTTP_MAX_TIME=15 api GET "/pods/$id/logs?tail=300"
  if api_ok; then say "$API_BODY"; else
    die "pod logs failed: HTTP $API_STATUS ${API_BODY:0:300}. The console or the MCP stream-pod-logs tool also work for pod $id."
  fi
}

cmd_pod_down() {
  need_cfg RUNPOD_API_KEY
  local id sid
  id=$(resolve_pod)
  if [[ -z $id ]]; then
    say "no pod named $POD_NAME found (already gone)"
  else
    say "terminating pod $id (name $POD_NAME)"
    api_delete pod "$id"
    api_must "terminate pod $id"
    if ((!DRY_RUN)); then
      api GET "/pods/$id"
      ((API_STATUS == 404)) || [[ $(json_get status) == TERMINATED ]] || die "pod $id still exists after delete; check the console NOW (it bills)"
      say "ok   pod $id is gone (read back)"
    fi
  fi
  write_id RUNPOD_POD_ID ""
  # Deliberate, documented exception to "never auto-delete secrets": the temporary
  # HF token secret, by its exact name, nothing else.
  sid=$(find_ids /account/secrets "name=$SECRET_HF")
  if [[ -n $sid ]]; then
    [[ $(printf '%s\n' "$sid" | grep -c .) == 1 ]] || die "more than one secret named $SECRET_HF; not deleting any"
    api_delete secret_hf "$sid"
    api_must "delete temporary secret $SECRET_HF"
    say "ok   temporary secret $SECRET_HF deleted. Now rotate/revoke the Hugging Face token."
  fi
}

# ---------------------------------------------------------------- status (reads only)
cmd_status() {
  need_cfg RUNPOD_API_KEY
  local id k
  say "== volume"
  id=$(cfg RUNPOD_NETWORK_VOLUME_ID)
  if [[ -n $id ]]; then
    api GET "/network-volumes/$id"
    if api_ok; then say "   $id name=$(json_get name) size=$(json_get size)GB dc=$(json_get dataCenter)  (\$0.07/GB/month)"; else say "   $id: HTTP $API_STATUS"; fi
  else say "   none recorded"; fi
  say "== secrets"
  for k in "$SECRET_R2_KEY_ID" "$SECRET_R2_KEY_SECRET"; do
    say "   $k: $(find_ids /account/secrets "name=$k" | grep -c . || true) found"
  done
  say "== endpoint"
  id=$(cfg RUNPOD_ENDPOINT_ID)
  if [[ -n $id ]]; then
    api GET "/serverless/$id"
    if api_ok; then
      say "   $id name=$(json_get name) image=$(json_get image)"
      say "   workers min=$(json_get workers.min) max=$(json_get workers.max) idleTimeout=$(json_get workers.idleTimeout) flashboot=$(json_get flashboot) timeout=$(json_get timeout)ms (\$1.75/hr per running worker)"
      [[ $(json_get workers.max) == "$(cfg RUNPOD_WORKERS_MAX 2)" ]] \
        || warn "workers.max is $(json_get workers.max), config says $(cfg RUNPOD_WORKERS_MAX 2). RunPod lowers max workers after 3/7 idle days: run 'apply.sh endpoint' to restore it."
    else say "   $id: HTTP $API_STATUS"; fi
  else say "   none recorded"; fi
  say "== temp pod"
  api GET /pods
  api_must "list pods"
  k=$(printf '%s' "$API_BODY" | pyj ids "name=$POD_NAME" | grep -c .) || true
  if ((k > 0)); then warn "pod $POD_NAME exists and is BILLING. Run: apply.sh pod-down"; else say "   none"; fi
  say "standing cost when idle: volume only (\$0.07/GB/month)."
}

# ---------------------------------------------------------------- teardown
cmd_teardown_endpoint() {
  need_cfg RUNPOD_API_KEY
  local id
  ((YES)) || die "teardown-endpoint deletes the endpoint (volume and secrets are kept). Re-run with --yes."
  id=$(cfg RUNPOD_ENDPOINT_ID)
  [[ -n $id ]] || die "RUNPOD_ENDPOINT_ID is not set"
  say "setting workers.max=0 on $id, then deleting the endpoint (config only; the volume and secrets stay)"
  api PATCH "/serverless/$id" "{\"workers\":{\"min\":0,\"max\":0,\"idleTimeout\":$(cfg RUNPOD_IDLE_TIMEOUT_S 60)}}"
  api_must "set workers.max=0"
  api_delete endpoint "$id"
  api_must "delete endpoint $id"
  if ((!DRY_RUN)); then
    api GET "/serverless/$id"
    ((API_STATUS == 404)) || die "endpoint $id still readable after delete"
  fi
  write_id RUNPOD_ENDPOINT_ID ""
  say "ok   endpoint deleted. Recreate with: apply.sh endpoint"
}

# ---------------------------------------------------------------- main
while (($#)); do
  case $1 in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --rotate) ROTATE=1 ;;
    --skip-ghcr) SKIP_GHCR=1 ;;
    --max-workers) (($# >= 2)) || die "--max-workers needs a value"; MAX_WORKERS_FLAG=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown flag $1" ;;
    *) [[ -z $CMD ]] || die "only one command"; CMD=$1 ;;
  esac
  shift
done
[[ -z $MAX_WORKERS_FLAG ]] || valid_uint "$MAX_WORKERS_FLAG" || die "--max-workers needs a number"
read_config
case $CMD in
  preflight) cmd_preflight ;;
  volume) cmd_volume ;;
  secrets) cmd_secrets ;;
  endpoint) cmd_endpoint ;;
  pod-up) cmd_pod_up ;;
  pod-logs) cmd_pod_logs ;;
  pod-down) cmd_pod_down ;;
  status) cmd_status ;;
  teardown-endpoint) cmd_teardown_endpoint ;;
  "") usage; exit 2 ;;
  *) die "unknown command $CMD" ;;
esac

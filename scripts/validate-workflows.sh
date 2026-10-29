#!/bin/bash
# Validate workflows/*.json against the real worker image's ComfyUI, no GPU.
#
# Environment (all optional):
#   IMAGE    worker image (default ghcr.io/ken-ck-yu/ltx25-worker:dev, must exist locally)
#   HANDLER  path to worker/handler.py (default <repo>/worker/handler.py)
#   LOCK     path to models.lock (default <repo>/scripts/models.lock)
#
# Needs docker able to mount paths under /home (the snap docker restriction).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/ken-ck-yu/ltx25-worker:dev}"
HANDLER="${HANDLER:-$ROOT/worker/handler.py}"
LOCK="${LOCK:-$ROOT/scripts/models.lock}"

[ -f "$HANDLER" ] || { echo "handler not found: $HANDLER (set HANDLER=...)" >&2; exit 2; }
[ -f "$LOCK" ] || { echo "models.lock not found: $LOCK (set LOCK=...)" >&2; exit 2; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image $IMAGE not found locally; build it from worker/ first" >&2; exit 2; }

VOL="$ROOT/.wf-validate/vol"
rm -rf "$ROOT/.wf-validate"
trap 'rm -rf "$ROOT/.wf-validate"' EXIT

# fake volume: zero-byte files named exactly as in models.lock (all sets)
while read -r _sha _size path _set; do
  case "$path" in ""|\#*) continue ;; esac
  mkdir -p "$VOL/models/$(dirname "$path")"
  : > "$VOL/models/$path"
done < <(grep -v '^[[:space:]]*#' "$LOCK" | grep -v '^[[:space:]]*$')

# handler dir holds only handler.py so nothing else is importable from it
mkdir -p "$ROOT/.wf-validate/handler"
cp "$HANDLER" "$ROOT/.wf-validate/handler/handler.py"

docker run --rm --entrypoint /bin/bash \
  -v "$VOL:/runpod-volume" \
  -v "$ROOT/workflows:/wf:ro" \
  -v "$ROOT/scripts:/check:ro" \
  -v "$ROOT/.wf-validate/handler:/handler:ro" \
  "$IMAGE" /check/wf-in-container.sh

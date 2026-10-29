#!/bin/bash
# Runs INSIDE the worker image (started by scripts/validate-workflows.sh).
# Starts ComfyUI on CPU against the fake volume, then runs the live checks.
set -u
PY=/opt/venv/bin/python
export PYTHONDONTWRITEBYTECODE=1

# sample inputs, so LoadImage/LoadVideo values pass /prompt validation
mkdir -p /comfyui/input
ffmpeg -loglevel error -y -f lavfi -i color=c=blue:s=320x240:d=1 -frames:v 1 /comfyui/input/wf_sample.png
ffmpeg -loglevel error -y -f lavfi -i testsrc=s=320x240:r=24:d=3 -c:v libx264 -pix_fmt yuv420p /comfyui/input/wf_sample.mp4
ffmpeg -loglevel error -y -f lavfi -i testsrc=s=320x240:r=24 -frames:v 12 -c:v libx264 -pix_fmt yuv420p /comfyui/input/wf_short.mp4

cd /comfyui || exit 2
$PY main.py --cpu --listen 127.0.0.1 --port 8188 > /tmp/comfyui.log 2>&1 &
COMFY_PID=$!

# wait up to 4 minutes for the server
for _ in $(seq 1 120); do
  if $PY -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8188/object_info', timeout=5)" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$COMFY_PID" 2>/dev/null; then
    echo "ComfyUI exited early:"; tail -n 40 /tmp/comfyui.log; exit 2
  fi
  sleep 2
done

$PY /check/check_workflows.py live --workflows /wf --handler-dir /handler
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "--- ComfyUI log tail ---"; tail -n 30 /tmp/comfyui.log
fi
kill "$COMFY_PID" 2>/dev/null
exit "$rc"

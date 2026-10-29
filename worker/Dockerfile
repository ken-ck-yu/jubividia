# ltx25-worker: thin layer on runpod/worker-comfyui. No model weights inside.
#
# Pinned by tag AND digest. NOTE: the design named 5.11.0-base, but that tag
# does not exist on Docker Hub (verified 2026-10-29); 5.10.0-base is the newest
# published *-base tag (ComfyUI 0.34.0, torch 2.11.0+cu128, triton 3.6.0).
ARG BASE=runpod/worker-comfyui:5.10.0-base@sha256:e9d18d3db15839ebb10c10c824109fc2956f31ef7bf21916220c008855b0d538
FROM ${BASE}

# ComfyUI-LTXVideo, pinned commit (master 2026-10-20).
ARG LTXV_REF=220e1d45aa0469f518e982102fca4dca92a61862

# Fail the build if the base does not look the way this image assumes.
RUN set -eux; \
    test -f /start.sh; test -f /handler.py; test -f /comfyui/main.py; \
    test -x /opt/venv/bin/python; command -v ffmpeg; command -v uv; \
    /opt/venv/bin/python -c "import boto3, requests, runpod, triton, torch; print('base ok, torch', torch.__version__)"

# Custom node + requirements. constraints.txt is `pip freeze` of the image as
# built on 2026-10-29 (base + LTXVideo requirements): rebuilds resolve to the
# same versions, and the torch family cannot change. Regenerate deliberately
# with: docker run --rm --entrypoint /opt/venv/bin/pip <image> freeze > worker/constraints.txt
COPY constraints.txt /tmp/constraints-full.txt
RUN set -eux; \
    git clone https://github.com/Lightricks/ComfyUI-LTXVideo /comfyui/custom_nodes/ComfyUI-LTXVideo; \
    git -C /comfyui/custom_nodes/ComfyUI-LTXVideo checkout "${LTXV_REF}"; \
    rm -rf /comfyui/custom_nodes/ComfyUI-LTXVideo/.git; \
    /opt/venv/bin/pip list --format=freeze | grep -iE '^(torch|torchvision|torchaudio|triton)==' > /tmp/constraints.txt; \
    cat /tmp/constraints.txt; \
    uv pip install --python /opt/venv/bin/python -c /tmp/constraints.txt -c /tmp/constraints-full.txt \
        -r /comfyui/custom_nodes/ComfyUI-LTXVideo/requirements.txt; \
    /opt/venv/bin/pip list --format=freeze | grep -iE '^(torch|torchvision|torchaudio|triton)==' | diff - /tmp/constraints.txt; \
    rm /tmp/constraints.txt /tmp/constraints-full.txt

COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml
COPY handler.py /handler.py

# Build-time smoke (no GPU): imports, handler compiles, ComfyUI boots on CPU.
RUN set -eux; \
    /opt/venv/bin/python -c "import boto3, triton; import py_compile; py_compile.compile('/handler.py', doraise=True)"; \
    cd /comfyui && /opt/venv/bin/python main.py --cpu --quick-test-for-ci
# Entrypoint/CMD (/start.sh) inherited from the base.

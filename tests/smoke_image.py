"""Run INSIDE the built image (no GPU): `make smoke`."""
import importlib.metadata as md
import os
import subprocess
import sys

BASE_TORCH = {"torch": "2.11.0+cu128", "torchvision": "0.26.0+cu128", "torchaudio": "2.11.0+cu128"}


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name, detail)
    if not ok:
        check.failed = True


check.failed = False

for pkg, ver in BASE_TORCH.items():
    got = md.version(pkg)
    check(f"{pkg} unchanged", got == ver, got)
import triton  # noqa: E402

check("import triton", True, triton.__version__)
import boto3  # noqa: E402

check("import boto3", True, boto3.__version__)
check("ffmpeg", subprocess.run(["ffmpeg", "-version"], capture_output=True).returncode == 0)
check("LTXVideo node pack present", os.path.isdir("/comfyui/custom_nodes/ComfyUI-LTXVideo"))
check("handler installed", os.path.isfile("/handler.py"))

# extra_model_paths.yaml resolves each category under the (fake) volume.
sys.path.insert(0, "/comfyui")
import folder_paths  # noqa: E402
import utils.extra_config  # noqa: E402

utils.extra_config.load_extra_path_config("/comfyui/extra_model_paths.yaml")
for cat in ("diffusion_models", "text_encoders", "vae", "latent_upscale_models", "loras", "model_patches"):
    paths = folder_paths.get_folder_paths(cat)
    check(f"{cat} -> volume", f"/runpod-volume/models/{cat}" in [p.rstrip("/") for p in paths], str(paths))

# Native LTX nodes are registered by this ComfyUI.
src = open("/comfyui/comfy_extras/nodes_lt.py").read() + open("/comfyui/comfy_extras/nodes_lt_audio.py").read()
for n in ("LTXVImgToVideo", "LTXVAddGuide", "LTXVAudioVAELoader", "LTXAVTextEncoderLoader"):
    check(f"native node {n}", n in src)

sys.exit(1 if check.failed else 0)

#!/usr/bin/env python3
"""Generate workflows/{t2v,i2v,v2v}.json (two-stage, default) and
workflows/single-stage/{t2v,i2v,v2v}.json (documented fallback).

The JSON files are the artefacts that ship; this script exists so the three
graphs stay consistent when one of them is edited.  Run it from anywhere:

    python3 scripts/build-workflows.py

Graph derived from the Comfy-Org templates video_ltx2_5_t2v / video_ltx2_5_i2v
(core nodes only).  See workflows/README.md for the contract.
"""
import json
import os
import sys

WORKFLOW_VERSION = 1  # keep equal to "Workflow version" in workflows/README.md

MODELS = {
    "unet": "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
    "clip": "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
    "vae": "ltx-2.5-video-vae-bf16.safetensors",
    "avae": "ltx-2.5-audio-vae-bf16.safetensors",
    "upscaler": "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
}
DEFAULT_NEGATIVE = "pc game, console game, video game, cartoon, childish, ugly."
SIGMAS_STAGE1 = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
SIGMAS_STAGE2 = "0.85, 0.7250, 0.4219, 0.0"
GUIDE_K = 25  # V2V: number of tail frames used as guide, must be 8n+1
GUIDE_WINDOW_S = 4.0  # V2V: only decode the last N seconds of the input


class Graph:
    def __init__(self):
        self.nodes = {}
        self.names = {}

    def add(self, name, class_type, title, **inputs):
        nid = str(len(self.nodes) + 1)
        self.names[name] = nid
        self.nodes[nid] = {"class_type": class_type, "inputs": inputs,
                           "_meta": {"title": title}}
        return name

    def ref(self, name, slot=0):
        return [self.names[name], slot]


def build(mode, two_stage):
    g = Graph()
    r = g.ref
    # --- loaders -----------------------------------------------------------
    g.add("unet", "UNETLoader", "Load Transformer",
          unet_name=MODELS["unet"], weight_dtype="default")
    g.add("vae", "VAELoader", "Load Video VAE", vae_name=MODELS["vae"])
    g.add("avae", "VAELoader", "Load Audio VAE", vae_name=MODELS["avae"])
    g.add("clip", "CLIPLoader", "Load Text Encoder",
          clip_name=MODELS["clip"], type="ltxv", device="default")
    if two_stage:
        g.add("upscaler", "LatentUpscaleModelLoader", "Load Spatial Upscaler",
              model_name=MODELS["upscaler"])
    # --- contract parameters ----------------------------------------------
    g.add("width", "PrimitiveInt", "WIDTH", value=1280)
    g.add("height", "PrimitiveInt", "HEIGHT", value=704)
    g.add("frames", "PrimitiveInt", "FRAMES", value=121)
    g.add("fps", "PrimitiveFloat", "FPS", value=24.0)
    g.add("seed", "PrimitiveInt", "SEED", value=42)
    # --- text -------------------------------------------------------------
    g.add("prompt", "CLIPTextEncode", "PROMPT", text="", clip=r("clip"))
    g.add("negative", "CLIPTextEncode", "NEGATIVE", text=DEFAULT_NEGATIVE, clip=r("clip"))
    g.add("cond", "LTXVConditioning", "Conditioning",
          positive=r("prompt"), negative=r("negative"), frame_rate=r("fps"))
    pos, neg = r("cond", 0), r("cond", 1)

    # --- input handling ---------------------------------------------------
    if mode == "i2v":
        g.add("input", "LoadImage", "INPUT", image="example.png")
        g.add("fit", "ImageScale", "Fit Image To Size", image=r("input"),
              upscale_method="lanczos", width=r("width"), height=r("height"),
              crop="center")
        g.add("pre", "LTXVPreprocess", "Preprocess Image",
              image=r("fit"), img_compression=18)
        guide = r("pre")
    elif mode == "v2v":
        g.add("input", "LoadVideo", "INPUT", file="example.mp4")
        g.add("tail", "Video Slice", "Trim To Last Seconds", video=r("input"),
              start_time=-GUIDE_WINDOW_S, duration=0.0, strict_duration=False)
        g.add("comp", "GetVideoComponents", "Decode Tail", video=r("tail"))
        g.add("last", "ImageFromBatch", "Last K Frames", image=r("comp", 0),
              batch_index=-GUIDE_K, length=GUIDE_K)
        g.add("fit", "ImageScale", "Fit Frames To Size", image=r("last"),
              upscale_method="lanczos", width=r("width"), height=r("height"),
              crop="center")
        guide = r("fit")

    # --- stage-1 video latent ---------------------------------------------
    if two_stage:
        g.add("half_w", "ComfyMathExpression", "Half Width",
              expression="a/2", **{"values.a": r("width")})
        g.add("half_h", "ComfyMathExpression", "Half Height",
              expression="a/2", **{"values.a": r("height")})
        w1, h1 = r("half_w", 1), r("half_h", 1)
    else:
        w1, h1 = r("width"), r("height")
    g.add("empty", "EmptyLTXVLatentVideo", "Empty Video Latent",
          width=w1, height=h1, length=r("frames"), batch_size=1)
    lat = r("empty")
    p1, n1 = pos, neg
    if mode == "i2v":
        g.add("inp1", "LTXVImgToVideoInplace", "Image Condition Stage 1",
              vae=r("vae"), image=guide, latent=lat,
              strength=0.7 if two_stage else 1.0, bypass=False)
        lat = r("inp1")
    elif mode == "v2v":
        g.add("guide1", "LTXVAddGuide", "Guide Stage 1", positive=pos, negative=neg,
              vae=r("vae"), latent=lat, image=guide, frame_idx=0, strength=1.0)
        p1, n1, lat = r("guide1", 0), r("guide1", 1), r("guide1", 2)

    # --- stage-1 sampling (video+audio jointly) ---------------------------
    g.add("alat", "LTXVEmptyLatentAudio", "Empty Audio Latent",
          frames_number=r("frames"), frame_rate=r("fps"), batch_size=1,
          audio_vae=r("avae"))
    g.add("av1", "LTXVConcatAVLatent", "Join AV Stage 1", video_latent=lat,
          audio_latent=r("alat"))
    g.add("guider1", "LTXVDualCFGGuider", "Guider Stage 1", model=r("unet"),
          positive=p1, negative=n1, video_cfg=1.0, audio_cfg=1.0)
    g.add("noise1", "RandomNoise", "Noise Stage 1", noise_seed=r("seed"))
    g.add("samp1", "KSamplerSelect", "Sampler Stage 1", sampler_name="euler_ancestral")
    g.add("sig1", "ManualSigmas", "Sigmas Stage 1", sigmas=SIGMAS_STAGE1)
    g.add("run1", "SamplerCustomAdvanced", "Sample Stage 1", noise=r("noise1"),
          guider=r("guider1"), sampler=r("samp1"), sigmas=r("sig1"),
          latent_image=r("av1"))
    g.add("sep1", "LTXVSeparateAVLatent", "Split AV Stage 1", av_latent=r("run1", 0))
    vid, aud = r("sep1", 0), r("sep1", 1)
    pc, nc = p1, n1

    if two_stage:
        if mode == "v2v":  # guides must go before the upsampler
            g.add("crop1", "LTXVCropGuides", "Crop Guides Stage 1",
                  positive=p1, negative=n1, latent=vid)
            pc, nc, vid = r("crop1", 0), r("crop1", 1), r("crop1", 2)
        g.add("up", "LTXVLatentUpsampler", "Upscale Latent x2", samples=vid,
              upscale_model=r("upscaler"), vae=r("vae"))
        vid = r("up")
        if mode == "i2v":
            g.add("inp2", "LTXVImgToVideoInplace", "Image Condition Stage 2",
                  vae=r("vae"), image=guide, latent=vid, strength=1.0, bypass=False)
            vid = r("inp2")
        elif mode == "v2v":
            g.add("guide2", "LTXVAddGuide", "Guide Stage 2", positive=pc, negative=nc,
                  vae=r("vae"), latent=vid, image=guide, frame_idx=0, strength=1.0)
            pc, nc, vid = r("guide2", 0), r("guide2", 1), r("guide2", 2)
        g.add("av2", "LTXVConcatAVLatent", "Join AV Stage 2", video_latent=vid,
              audio_latent=aud)
        g.add("guider2", "LTXVDualCFGGuider", "Guider Stage 2", model=r("unet"),
              positive=pc, negative=nc, video_cfg=1.0, audio_cfg=1.0)
        g.add("noise2", "RandomNoise", "Noise Stage 2", noise_seed=r("seed"))
        g.add("samp2", "KSamplerSelect", "Sampler Stage 2", sampler_name="euler_ancestral")
        g.add("sig2", "ManualSigmas", "Sigmas Stage 2", sigmas=SIGMAS_STAGE2)
        g.add("run2", "SamplerCustomAdvanced", "Sample Stage 2", noise=r("noise2"),
              guider=r("guider2"), sampler=r("samp2"), sigmas=r("sig2"),
              latent_image=r("av2"))
        g.add("sep2", "LTXVSeparateAVLatent", "Split AV Stage 2", av_latent=r("run2", 0))
        vid, aud = r("sep2", 0), r("sep2", 1)
    if mode == "v2v":  # strip the guide frames from the final video latent
        g.add("cropf", "LTXVCropGuides", "Crop Guides Final", positive=pc,
              negative=nc, latent=vid)
        vid = r("cropf", 2)

    # --- decode + save ----------------------------------------------------
    g.add("dec", "VAEDecodeTiled", "Decode Video", samples=vid, vae=r("vae"),
          tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
    g.add("adec", "LTXVAudioVAEDecode", "Decode Audio", samples=aud, audio_vae=r("avae"))
    g.add("video", "CreateVideo", "Assemble Video", images=r("dec"), fps=r("fps"),
          audio=r("adec"))
    g.add("save", "SaveVideo", "OUTPUT", video=r("video"),
          filename_prefix=f"video/LTX_2.5_{mode}_wf{WORKFLOW_VERSION}",
          format="mp4", **{"format.codec": "h264"})
    return g.nodes


def main():
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "workflows")
    for two_stage, sub in ((True, ""), (False, "single-stage")):
        d = os.path.normpath(os.path.join(root, sub))
        os.makedirs(d, exist_ok=True)
        for mode in ("t2v", "i2v", "v2v"):
            path = os.path.join(d, f"{mode}.json")
            with open(path, "w") as f:
                json.dump(build(mode, two_stage), f, indent=2)
                f.write("\n")
            print("wrote", path)


if __name__ == "__main__":
    sys.exit(main())

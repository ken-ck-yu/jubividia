# worker — design note

## Summary
Build `ghcr.io/ken-ck-yu/ltx25-worker` as a thin layer on the maintained `runpod/worker-comfyui:<pinned>-base` image (Docker Hub; 5.11.0 released 2026-09-21; CUDA 12.8.1, Python 3.12, torch 2.11 cu128, ComfyUI 0.34.0). We add ComfyUI-LTXVideo, ffmpeg, boto3, our own `handler.py` (replacing the stock one; stock `start.sh` still boots ComfyUI) and our `extra_model_paths.yaml` pointing at `/runpod-volume/models`. No weights in the image. The handler fills `/runpod-volume/workflows/{mode}.json`, runs it, uploads mp4 + jpg to R2 via boto3 and returns the key. CI builds to GHCR on push to `main`.

## Verified facts (searched 2026-10-29)
- **worker-comfyui**: actively maintained (5.8.7 Aug 21, 5.10.0 Sep 1, 5.11.0 Sep 21 2026). Base `nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04`, Python 3.12 venv at `/opt/venv`, torch 2.11.0 / cu128, comfy-cli 1.13.0, ComfyUI 0.34.0 in `/comfyui`. Docker Hub tags: `-base`, `-flux1-*`, `-sdxl`, `-sd3`. Custom-node requirements are installed at build by looping `custom_nodes/*/requirements.txt`; helper `comfy-node-install` exists. Entrypoint `/start.sh` runs ComfyUI and `handler.py`. Stock input is `{workflow, images[]}`, not our schema, so we replace the handler. Stock `extra_model_paths.yaml` sets `base_path: /runpod-volume` and maps standard categories (checkpoints, clip, vae, unet, loras, upscale_models, ...); it does not obviously list `diffusion_models`, `text_encoders`, `latent_upscale_models`, hence our own file. Env knobs: `NETWORK_VOLUME_DEBUG`, `REFRESH_WORKER`. 5.8.7 notes: allowed host CUDA 12.8–13.3. 5.11.0 adds a pre-flight check that model files exist (reports expected network-volume paths).
- **LTX-2.5** (HF `Lightricks/LTX-2.5`, gated, LTX-2.x Community License, free under $10M revenue). Stated requirements: Python >=3.12, CUDA >=12.7, torch ~2.7. Base image (3.12 / 12.8 / 2.11) satisfies this. `num_frames % 8 == 1`; width/height divisible by 32.
- **Model files / ComfyUI folders** (docs.comfy.org LTX-2.5 page + HF):
  - `diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`
  - `text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`
  - `vae/ltx-2.5-video-vae-bf16.safetensors` (or lighter `ltx-2.5-video-vae-conv-bf16.safetensors`)
  - `vae/ltx-2.5-audio-vae-bf16.safetensors`
  - `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`
  - File sizes are not published on either page; verify in the `models` feature.
- **ComfyUI-LTXVideo**: README documents Manager install (and clone into `custom_nodes/` + `pip install -r requirements.txt` is the manual equivalent). README states 32GB+ VRAM, 100GB disk. 2.5 example workflows live in `example_workflows/2.5/`. Its requirements.txt contents could not be retrieved; the engineer must read it at build time and ensure it does not change torch.
- **R2 via boto3**: `boto3.client("s3", endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com", aws_access_key_id=..., aws_secret_access_key=..., region_name="auto")`. Region must be `auto` (otherwise SignatureDoesNotMatch). Presigned URLs only work on the r2.cloudflarestorage.com endpoint, not custom domains.

## Stale / contradictory in SPEC.md
1. "FP8 / int8 ComfyUI build" (§2, §4.2): no FP8 LTX-2.5 checkpoint exists. The real file is **int8-convrot** (ComfyUI-only). This is the right choice for Ampere (A6000/A40 have no FP8 tensor cores), but the wording must be fixed.
2. "Gemma 4 12B ~26 GB": that is likely the bf16 size; the int8-convrot encoder is the ComfyUI build and presumably smaller. Sizes unpublished.
3. "Video VAE ~1.5 GB, Audio VAE ~0.4 GB": unverified; two video VAE variants exist (DiffVAE higher quality vs conv faster). Needs a choice in `models`/`workflows`.
4. §4.1 "Pin CUDA/torch to what LTX docs require": LTX gives minimums (CUDA >=12.7, torch ~2.7); base ships 12.8 / 2.11. Whether ComfyUI 0.34.0 has all LTX-2.5 native nodes is unstated (docs say "update to latest, may need nightly").
5. "Fits 48 GB without offloading": plausible, unmeasured.
6. §4.1 says "start from runpod-workers/worker-comfyui"; base is on Docker Hub; GHCR is only our output.

## Design
**Dockerfile** (`worker/Dockerfile`):
- `ARG BASE=runpod/worker-comfyui:5.11.0-base` (pinned tag, ideally digest).
- apt `ffmpeg`; `uv pip install boto3 requests` into `/opt/venv`.
- `git clone` ComfyUI-LTXVideo into `/comfyui/custom_nodes/ComfyUI-LTXVideo` at a pinned commit; install its requirements into `/opt/venv` with a constraints file pinning torch/torchvision/torchaudio to the base's versions.
- `COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml`; `COPY handler.py` over the base's handler (engineer confirms the path inside the 5.11.0 image).
- Build-time smoke test: ComfyUI `--quick-test-for-ci --cpu` and `import boto3`.
- If the ComfyUI version is too old for LTX-2.5 nodes, bump it in the Dockerfile (first engineering check).

**extra_model_paths.yaml**: one section with `base_path: /runpod-volume/models`; keys `diffusion_models`, `text_encoders`, `vae`, `latent_upscale_models`, `loras`, `checkpoints`, `model_patches`, each `<name>/`.

**handler.py** (`runpod.serverless.start`, plain handler):
1. Validate input: `mode` in {t2v,i2v,v2v}; non-empty `prompt`; `input_url` required (http/https) for i2v/v2v; width/height rounded/validated to multiples of 32; frames from `duration`*`fps` rounded to `8k+1` (explicit `num_frames` overrides); defaults 1280x720, 5 s, 24 fps, random seed. Invalid input returns `{"error": msg}`.
2. Download `input_url` to `/comfyui/input/<job_id>_<name>` with size cap and timeout.
3. Load `/runpod-volume/workflows/{mode}.json`; fill nodes via a node-ID table (documented in `workflows/README.md`).
4. Wait for ComfyUI readiness, POST `/prompt` to 127.0.0.1:8188, poll `/history/<id>` with a timeout.
5. Find the output mp4; ffmpeg first-frame jpg; upload both to R2 at `outputs/<YYYY-MM-DD UTC>/<job_id>.mp4|.jpg`.
6. Return `{key, thumb_key, duration_s, gen_time_s, seed}`; delete local input/output. Map ComfyUI errors (CUDA OOM, missing model, node error) to readable messages.
Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; endpoint URL is built in code.

**CI** (`.github/workflows/build-worker.yml`): on push to `main` touching `worker/**` (plus manual dispatch); login to ghcr.io with `GITHUB_TOKEN` (`packages: write`), `docker/build-push-action`, tags `latest` + `sha-<short>`, GHA cache. Free-runner disk may need a cleanup step.

## Decisions
### One-way doors
1. **Base image = `runpod/worker-comfyui` `-base` (pinned) with our own handler.** Options: (a) this; (b) RunPod PyTorch base + own ComfyUI install; (c) stock handler with our logic elsewhere. Recommend (a): maintained, CUDA/torch/ComfyUI/start.sh/volume handling solved, allowed by SPEC §2. Reversibility: moderate (image rebuild only), but later features depend on its paths (`/comfyui`, `/opt/venv`).
2. **Public handler contract** (input schema, output `{key, thumb_key, duration_s, gen_time_s, seed}`, error shape `{"error": msg}`). Recommend the SPEC schema plus explicit `duration` (seconds) and `fps`, with optional `num_frames` overriding. Reversibility: UI and stored data depend on it.
3. **R2 key schema `outputs/<UTC date>/<job_id>.mp4|.jpg`** (as SPEC). Reversibility: gallery listing and existing objects depend on it.
4. **Volume layout the worker consumes**: `/runpod-volume/models/{diffusion_models,text_encoders,vae,latent_upscale_models,loras,model_patches}` and `/runpod-volume/workflows/{mode}.json`. Reversibility: re-copying tens of GB.
5. **Torch/CUDA: keep base's CUDA 12.8 / torch 2.11** rather than downgrading to LTX's "~2.7". LTX gives minimums. Reversibility: rebuild, but int8-convrot kernel compatibility must be proven on a real A6000/A40 before relying on it.
6. **Model variant = distilled int8-convrot transformer + int8-convrot Gemma 4 12B.** Follows from SPEC §2, flagged only because "FP8" in the spec does not exist (Q1).

### Two-way doors
- ComfyUI-LTXVideo pinned by commit and cloned in the Dockerfile (not Manager): reproducible.
- Poll `/history` instead of websocket: simpler, resilient to WS drops.
- Input download via `requests` streaming, 500 MB cap, 60 s timeout.
- Frames from duration/fps rounded to `8k+1`; resolution validated to multiples of 32.
- Tags `latest` + `sha-<short>`; endpoint should reference the sha tag.
- boto3: SigV4, `region_name="auto"`, standard retries, `upload_file` with `ContentType`.
- Node-ID table lives in handler.py, documented in `workflows/README.md`.
- Local files deleted after upload.
- Default video VAE = bf16 DiffVAE (swappable in the workflow JSON, no worker change).

## Questions for Ken
1. **"FP8" does not exist for LTX-2.5.** The ComfyUI build is `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` (int8; suits A6000/A40 since Ampere lacks FP8 hardware). Options: int8-convrot (recommended) or bf16 distilled (~44 GB, will not fit alongside the encoder). Confirm int8-convrot?
2. **Base image**: `runpod/worker-comfyui:5.11.0-base` + our handler (recommended: maintained, CUDA 12.8 / Python 3.12 / torch 2.11 already meet LTX minimums) vs RunPod PyTorch base + own ComfyUI (more control, more maintenance). OK with the recommended one?
3. **CUDA 12.8 / torch 2.11 vs LTX docs "torch ~2.7, CUDA >=12.7"**: keep the newer base versions (recommended) or force torch 2.7?
4. **GHCR package visibility**: public (recommended; no pull credentials in RunPod, image holds no secrets or weights) or private (needs a RunPod registry credential)?
5. **Input retention** (SPEC §9): keep uploaded inputs in R2 for 7 days via a lifecycle rule (recommended) or delete immediately after the job or keep forever? Affects only the ui feature's `inputs/` prefix, not the worker.
6. **Default clip**: 24 fps, 121 frames (~5.04 s, satisfies 8k+1) at 1280x720. OK?

## Concerns / risks
- ComfyUI 0.34.0 in the base may lack native LTX-2.5 nodes/int8-convrot loaders; may require a ComfyUI bump. First engineering check.
- ComfyUI-LTXVideo requirements.txt may pull a different torch; constraints file mitigates. Not verified.
- Image size vs GitHub runner disk (~14 GB free); may need a disk cleanup step.
- Stock `start.sh` / handler path / `network_volume.py` known only second-hand; read the real image.
- Cold start from network volume (22 GB-class transformer + encoder) unmeasured.
- 48 GB headroom at 720p/5 s unmeasured; longer clips may OOM.
- HF repo is gated; Ken must accept the license before the `models` feature.
- GPU ID strings and A6000/A40 serverless availability belong to the `endpoint` feature.

## How the validator should test this
- `docker build` succeeds; image contains `ffmpeg`, `boto3`, `custom_nodes/ComfyUI-LTXVideo`; torch/torchvision/torchaudio versions unchanged from the base (`pip list`).
- ComfyUI starts in the container and `/object_info` lists the LTX nodes and the LTX-2.5 loaders.
- Handler unit tests without GPU: schema validation (bad mode, missing `input_url` for i2v/v2v, non-multiple-of-32 sizes, frame rounding) with mocked ComfyUI HTTP and mocked boto3 (moto/Stubber), asserting endpoint `https://<acct>.r2.cloudflarestorage.com`, `region_name="auto"`, and the key pattern.
- Error paths return readable messages: unreachable/404/oversized `input_url`, ComfyUI error / OOM, timeout.
- `extra_model_paths.yaml`: ComfyUI `folder_paths` resolves each category to `/runpod-volume/models/...` in a container with a fake volume.
- CI workflow lints (actionlint) and builds on a branch without pushing; real GPU end-to-end is deferred until `models`, `workflows`, `endpoint` exist.

## Reviewer
Independent review, 2026-10-29. Searches: ComfyUI LTX-2.5 / int8-convrot support; worker-comfyui repo page (README gave little: handler.py at repo root, a customization guide exists; no version/CUDA info, so the architect's worker-comfyui facts are not independently confirmed by me); HF ComfyUI-Native-INT8_ConvRot.

### Door 1 - Base image: runpod/worker-comfyui:5.11.0-base + own handler. **AGREE WITH CHANGES**
Alternatives steelmanned: (b) RunPod PyTorch base + own ComfyUI (full control of ComfyUI version, no inherited start.sh/network_volume.py behaviour); (c) stock handler. (c) is dead: the SPEC contract cannot be expressed in `{workflow, images[]}`. (b) is a stronger challenger than the note allows, since ComfyUI version coupling is the likeliest source of pain. But ComfyUI >= 0.32.0 has native LTX-2.5 (released 2026-08-11) and native INT8 was merged June 2026, so the base's 0.34.0 satisfies both; (a) wins on maintenance. Changes:
1. Pin by digest, not only tag, and record it.
2. "Replace handler.py, keep start.sh" is a fragile coupling the architect admits is second-hand. Make the Dockerfile fail the build if the expected files/ENTRYPOINT are not where assumed.
3. "Cheap to rebuild" holds only if nothing outside the Dockerfile and extra_model_paths.yaml hardcodes `/comfyui` or `/opt/venv`; workflows must reference model filenames only, never paths.
4. Record compressed image size; a fresh host pays the pull on cold start.

### Door 2 - Handler contract. **AGREE WITH CHANGES**
Alternative: let the UI do rounding/validation and keep the worker dumb. Server-side is right. Changes:
- Return the effective values used (`width`, `height`, `num_frames`, `fps`, `seed`) since the handler silently rounds; add `"v": 1` contract version now.
- Add a stable machine-readable `error_code` (`bad_input`, `oom`, `model_missing`, `timeout`, `input_fetch`, `workflow_mismatch`) alongside `error`, so the UI never string-matches.
- `input_url` is fetched by the worker: reject non-http(s), private/link-local/metadata IPs and redirects to them. Download the input first, before waiting on ComfyUI readiness, because presigned URLs can expire during a multi-minute cold start; UI should use >= 30 min TTL.
- Keys only, never URLs, in the output (agree).
- Handler's internal timeout must be shorter than the 15 min platform execution timeout so the user gets a readable error.

### Door 3 - R2 key schema `outputs/<UTC date>/<job_id>.mp4|.jpg`. **AGREE WITH CHANGES**
Alternatives: `outputs/<job_id>/video.mp4`, or a time-sortable name. R2 listing is lexicographic ascending, so "newest first" needs paging to the end; irrelevant at 40 clips/month, but a timestamp in the filename lets the UI sort without extra calls. Changes:
1. Name `<YYYYMMDDTHHMMSS>-<job_id>`.
2. Store generation parameters (prompt, mode, seed, effective size/frames, gen_time_s) in a sidecar `<same>.json` (or R2 custom metadata) and return `meta_key`. Without it the gallery cannot show prompts and it cannot be backfilled later: this is the real one-way part the architect missed.
3. Confirm RunPod job ids (`uuid-u1` style) are key-safe, and that a retry reusing the id overwrites idempotently.

### Door 4 - Volume layout. **AGREE WITH CHANGES**
Alternative: ship workflows in the image (versioned together with the node-ID table). Workflows on the volume allow editing without a rebuild (good for dev-pod loop) but the handler's node-ID table (image) and workflow JSON (volume) can drift undetected. Change: look nodes up by `_meta.title` (e.g. PROMPT, SEED) rather than numeric IDs, or at minimum validate every touched node ID exists with the expected `class_type` and fail with `workflow_mismatch`. Also: a bigger one-way door nobody flagged is the **network volume datacenter** (SPEC §9): the volume is bound to a DC and `models` populates it first, so it must be decided before `models`, not at `endpoint`.

### Door 5 - Keep CUDA 12.8 / torch 2.11. **AGREE WITH CHANGES**
Alternative: pin torch ~2.7 per LTX docs. Steelman: tested configuration; some node requirements target older wheels. Counter: those are minimums, ComfyUI 0.34 targets modern torch, and downgrading under a base built for 2.11 is the riskier path. INT8 loading is native in ComfyUI via the stock loader. Caveats found: the INT8 ConvRot loader page says INT8 kernels need Triton, so verify `import triton` in the built image; a ComfyUI issue reports "Unknown quantization format" for convrot on older builds, so a ComfyUI bump must be treated as expected and cheap. Ampere (sm_86) has INT8 tensor cores so int8 suits A6000/A40, but I found no source confirming the convrot path specifically on sm_86: **unproven until run on a real A6000 and A40**. Change: make one generation on each GPU (peak VRAM + time, versions recorded) a gating validator test. The door is one-way in time: if it fails, the fallback is not bf16 (does not fit) nor GGUF (excluded) but a bigger, costlier GPU, which is Ken's call.

### Door 6 - Model variant: distilled int8-convrot transformer + int8-convrot Gemma 4 12B. **AGREE WITH CHANGES**
Alternatives: dev transformer (int8 exists, ~21.5 GB class per third-party listings; better quality but many more steps, so more GPU seconds, against priority 2); bf16 encoder (does not fit). Distilled is right. Changes: fix SPEC wording "FP8" to int8-convrot; measure memory with transformer + encoder + upscaler + 720p VAE decode, since a tight fit means ComfyUI offloads and warm jobs pay reload time (threatens acceptance criterion 3); encoder size is unpublished and sets the 100 GB volume budget; note the Community License (free under $10M revenue) in README.

### Two-way doors that are really one-way (or need a rule)
- Sidecar metadata / `meta_key`: looks like UI nicety, is one-way for stored data (Door 3).
- Network volume datacenter: see Door 4.
- Tag policy: `latest` is two-way, but the endpoint config MUST use the sha tag or digest, else reproducibility (SPEC priority 4) silently breaks. Make it a rule for `infra`.
- ComfyUI launch flags in start.sh (vram mode) decide whether warm jobs skip model load; add `cold` (bool) to handler output so latency is explainable.
- GHCR public, 8k+1 frames, polling vs websocket: genuinely two-way; agree.
- A third-party Docker Hub image (notrius/ltx-2.5-serverless) exists for this use; do not use it (supply chain), noted only.

### New questions for Ken
1. Store prompt/params as a sidecar JSON next to each clip? Recommended yes (cannot backfill).
2. If int8-convrot fails on A6000/A40 in real testing, stop and ask about a bigger GPU (cost impact)? Recommended yes; flag the risk now.
3. Network volume datacenter (EU preferred, A6000/A40 serverless stock): decide before `models`.
4. Input presigned-URL lifetime 30 min so cold starts cannot expire it?

Sources: [ComfyUI v0.32.0](https://comfyui-wiki.com/en/news/2026-08-11-comfyui-v0-32-0), [ComfyUI Native INT8 ConvRot](https://huggingface.co/milo01/ComfyUI-Native-INT8_ConvRot), [LTX-2.5 ComfyUI quants](https://huggingface.co/DmitryDB/LTX-2.5-ComfyUI-Quants), [worker-comfyui](https://github.com/runpod-workers/worker-comfyui).

## Ken's decisions (2026-10-29) — binding on the engineer

Architect Q1–Q8 accepted as recommended; Q9 and the input mechanism decided as below. Where this section conflicts with the Design above, this section wins.

1. Model variant: int8-convrot distilled transformer + int8-convrot Gemma 4 encoder (no FP8 build exists).
2. Base image: `runpod/worker-comfyui:5.11.0-base` + our own handler. Pin by digest as well as tag.
3. Keep the base's CUDA 12.8 / torch 2.11. Verify `import triton` in the built image.
4. GHCR package public.
5. Inputs kept in R2 for 7 days (lifecycle rule belongs to the `ui`/`endpoint` features).
6. Defaults: 1280x720, 24 fps, 121 frames.
7. Sidecar JSON of prompt + params next to each clip; return `meta_key`.
8. If int8-convrot fails on the target GPU: stop and ask Ken about a different GPU. Do not fall back to bf16 or GGUF.
9. **GPU / datacenter changed from SPEC §2** (no datacenter has A6000/A40 serverless stock *and* network-volume support): serverless **RTX 6000 Ada at US-WA-1** (stock MEDIUM, $1.75/hr serverless), network volume at US-WA-1. Fallback if stock disappoints: L40S at EU-NL-1. The gating "real generation" test therefore runs on the RTX 6000 Ada, not on A6000/A40. Ken approved this deviation from SPEC §2.
10. **Input contract changed:** the handler takes `input_key` (an R2 key under `inputs/`), not `input_url`. The handler downloads it with its own R2 credentials and rejects any key outside `inputs/`. No presigned URLs, no arbitrary URL fetching (SSRF concern moot). Download the input before loading models.

### Later decisions (2026-10-29, after validation)

- Base image is **`runpod/worker-comfyui:5.10.0-base`**, pinned by tag and digest. `5.11.0-base` is a GitHub release but is not on Docker Hub. Ken accepted 5.10.0.
- Default clip is **1280x704** (720 is not a multiple of 32), 24 fps, 121 frames. Ken accepted. The `workflows` design note requires width and height to be multiples of **64** (two-stage graph); that handler change, plus the v2v INPUT field `file`, lands with the `workflows` feature.
- `JOB_TIMEOUT_S` default is **780 s** (was 840) so uploads and orphan cleanup always finish inside the 900 s platform limit (hard deadline 885 s). Coordinator-accepted, two-way.
- Error text is `[code] message` with `error_code` also kept as a field, in case RunPod `/status` hides the structured field. No job-level retry beyond the bounded upload retry: fail and resubmit.
- The repo is **public** and the GHCR package is expected to be public. Verify package visibility after the first CI run.
- Still unverified until the `endpoint` feature (see `docs/validation/worker.md`): real generation and int8-convrot speed/VRAM on the RTX 6000 Ada (Ken's decision-8 gate; pass/fail thresholds not yet set), real R2 upload, whether `/status` exposes `error_code`, and the first CI run on the 24.75 GB image.

## Invariant for the UI gallery (added by the ui feature)

The handler uploads the .mp4 and .jpg first and the .json sidecar LAST, and deletes the earlier files if the sidecar upload fails (upload_results in worker/handler.py). The UI gallery lists sidecars only and treats a sidecar as the "clip is complete" marker. Do not change this order without changing ui/src/outputs.js. Sidecar fields the UI reads: mode, prompt, seed, width, height, num_frames, fps, gen_time_s, peak_vram_mb, cold, created_at (missing fields render blank).

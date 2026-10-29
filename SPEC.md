# LTX-2.5 Self-Hosted Video Generation (RunPod Serverless) — Project Spec

## 1. Goal

Run Lightricks' open-weight **LTX-2.5** video generation model on **RunPod Serverless** so I can generate video (with synced audio) from **text**, **image**, or **video** inputs from either my **phone** or my **computer**, via a single private URL — and pay **nothing** when idle except storage.

Priorities, in order:

1. **Scale to zero, automatically.** Zero GPU cost when idle. GPU billed only while a job runs (plus cold-start time). No manual start/stop.
2. **Cheapest viable.** Fixed cost = network volume only (~$5.60/mo for 80 GB). Variable cost = per-second GPU while generating.
3. **Works from a phone.** A simple mobile-friendly page: pick mode (T2V / I2V / V2V), upload, prompt, generate, play result, browse past outputs.
4. **Reproducible.** Worker image, endpoint config, front end and infra all live in this repo.

Non-goals: multi-user, public access, fine-tuning, training, interactive ComfyUI editing in production (a dev-pod path for editing workflows is described in 4.7).

## 1a. How to work with me on this

- **Discuss before deciding.** Anything not already fixed in section 2, or anything in this spec that turns out to be wrong, outdated, or in tension with another requirement: stop and ask me. Present the options with a one-line trade-off each and your recommendation, then wait. Do not pick silently and move on.
- This applies especially to: model file choices/filenames once you've read the current LTX docs, torch/CUDA versions, which ComfyUI serverless worker base to use, GPU class selection, cold-start mitigation, how the front end is hosted, anything that changes cost.
- Small implementation details (variable names, file layout within a component, which HTTP library) — just decide.
- Work in the order of section 4 unless you explain why not. Show me a short plan for each component before writing it.
- When something fails (model won't load, OOM, worker times out, node pack API changed), report what you found and ask before working around it.

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Platform | **RunPod Serverless** (Flex workers, min workers = 0) | True scale-to-zero, per-second billing, network-volume support |
| GPU type | **Serverless RTX 6000 Ada (48 GB) at US-WA-1**, network volume at US-WA-1 (stock MEDIUM, ~$1.75/hr serverless); fallback **L40S at EU-NL-1**. | No datacenter had A6000/A40 serverless stock together with network-volume support (checked live 2026-10-29), so the original A6000/A40 choice was replaced; I approved this deviation. Fits the int8 transformer + Gemma 4 encoder without offloading. Do not add other GPUs without asking me — they cost more. |
| Model variant | **LTX-2.5 22B distilled, int8-convrot ComfyUI build** (`ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`, ~21.5 GB) with the int8-convrot Gemma 4 12B encoder (`gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`, ~15.4 GB) | There is no FP8 build of LTX-2.5; int8 suits Ampere/Ada (no FP8 hardware on Ampere). Fits 48 GB. Do NOT use full bf16 (~66 GB; the bf16 encoder file is ~26 GB). Do NOT use GGUF + offload. int8 speed/quality on the RTX 6000 Ada is still to be measured (real-GPU gate pending). |
| Inference backend | **ComfyUI** + official **ComfyUI-LTXVideo** node pack, wrapped as a RunPod serverless worker on base image `runpod/worker-comfyui:5.10.0-base`, pinned by tag and digest (5.11.0-base is a GitHub release but not on Docker Hub); ComfyUI 0.34.0, CUDA 12.8, torch 2.11 | Reference implementation; one model covers T2V / I2V / V2V + audio |
| Model storage | **RunPod Network Volume** (80 GB, standard tier, ~$5.60/mo at $0.07/GB) attached to the endpoint, mounted at `/runpod-volume` | Models are not baked into the image (too large, slow deploys); workers load from the volume |
| Output storage | **Cloudflare R2** bucket | Serverless workers are ephemeral; results must leave the worker. I already use R2. Worker uploads mp4 + thumbnail, returns an object key. |
| Front end hosting | **Cloudflare Worker** (static UI + small API) behind **Cloudflare Access** (my email only) | Free tier, always on, no GPU needed to serve the page, keeps the RunPod API key server-side |
| Auth | Cloudflare Access on the front end; RunPod endpoint called only from the Worker with the API key as a secret | Nothing public reaches RunPod directly |

**Changes since first draft (2026-10-29).** GPU, model variant, base image, volume size, handler contract, model pinning and workflow details were revised after architect/reviewer/validator work. Details are in the design notes `docs/decisions/worker.md`, `docs/decisions/models.md` and `docs/decisions/workflows.md` on the feature branches of PRs #1, #2 and #3 (https://github.com/ken-ck-yu/jubividia/pulls).

## 3. Architecture

```
Phone / Laptop
   │ HTTPS  (Cloudflare Access: my email)
   ▼
Cloudflare Worker  https://ltx.<mydomain>
   ├── serves static mobile UI
   ├── POST /api/generate  → RunPod Serverless  /run        (API key secret)
   ├── GET  /api/status/:id → RunPod Serverless  /status/:id
   ├── GET  /api/outputs    → lists R2 objects
   ├── GET  /api/outputs/:k → streams mp4 from R2 (range requests)
   └── PUT  /api/upload     → stores input image/video in R2 under inputs/, returns the object key

RunPod Serverless Endpoint (min 0, max 1–2 workers, 48 GB GPU)
   worker image: ghcr.io/ken-ck-yu/ltx25-worker
     ├── ComfyUI + ComfyUI-LTXVideo
     ├── handler.py: input → fill workflow template → run → upload result to R2 → return key
     └── /runpod-volume  ← Network Volume (models, workflow templates)
```

Job flow: UI uploads input to R2 → Worker submits `/run` with `{mode, prompt, input_key, params}` → RunPod spins a worker (cold start if none warm) → handler runs ComfyUI workflow → uploads to R2 → UI polls `/status` → plays result from R2.

## 4. Components to build

### 4.1 Serverless worker image (`worker/`)

- Base: `runpod/worker-comfyui:5.10.0-base`, pinned by tag and digest (ComfyUI 0.34.0, CUDA 12.8, torch 2.11).
- Installed in image: ComfyUI, ComfyUI-LTXVideo and its requirements, `ffmpeg`, `boto3` (for R2 S3 API). **No model weights in the image.**
- ComfyUI model paths configured (via `extra_model_paths.yaml`) to point at `/runpod-volume/models/...`.
- `handler.py`:
  - Input schema: `{ "mode": "t2v"|"i2v"|"v2v", "prompt": str, "negative": str?, "input_key": str? (an R2 key under `inputs/`; required for i2v/v2v), "width": int?, "height": int?, "num_frames"/"duration": ?, "fps": int?, "seed": int? }`. Validate and apply defaults. No presigned URLs.
  - Fetches `input_key` from R2 into ComfyUI's input dir if present.
  - Loads the matching workflow template from `/runpod-volume/workflows/{mode}.json`, fills node inputs (node IDs documented in `workflows/README.md`), submits to the in-container ComfyUI, waits for completion (websocket or polling), bounded by `JOB_TIMEOUT_S` (default 780 s, inside the 900 s endpoint execution timeout we chose).
  - Uploads resulting mp4, a jpg thumbnail (ffmpeg, first frame) and a sidecar JSON to R2 under `outputs/<UTC date>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json`.
  - Returns `{ "key": ..., "thumb_key": ..., "meta_key": ..., "v": ..., "cold": ..., "duration_s": ..., "gen_time_s": ..., "seed": ..., "width": ..., "height": ..., "num_frames": ..., "fps": ... }` (effective values for width/height/num_frames/fps/seed).
  - Clear error messages back to the caller on failure (OOM, bad input, timeout), formatted `[code] message` with a separate `error_code` field.
- Keep ComfyUI running between jobs within the same warm worker (the official worker does this) so warm requests skip model load.
- Env/secrets on the endpoint: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- GitHub Actions workflow builds and pushes `ghcr.io/ken-ck-yu/ltx25-worker` to GHCR on push to `main` (the package should be public; the repo is public).

### 4.2 Models (`scripts/download-models.sh`)

Run once from a temporary RunPod **pod** (any cheap GPU or CPU pod, created in US-WA-1) with the network volume attached, since serverless workers can't be used for a ~40 GB download comfortably. Pull from the pinned Hugging Face repo `Lightricks/LTX-2.5` at commit `49b093a39c19169a8a81721dcc541e07e945232f` (gated — accept the LTX-2.x Community License, use `HF_TOKEN`), verified against a sha256 lock `scripts/models.lock`. The repo is public, so use a plain `git clone`. Default set is 41.43 GB (5 required files + conv VAE + temporal upscaler + duration head); the optional LoRA is 8.9 GB.

| Component | Volume path | Notes |
|---|---|---|
| LTX-2.5 22B **distilled** transformer, int8-convrot ComfyUI build | `models/diffusion_models/` (confirm against LTXVideo README) | ~21.5 GB |
| Gemma 4 12B text encoder w/ projection, int8-convrot | `models/text_encoders/` | ~15.4 GB |
| Video VAE | `models/vae/` | ~1.5 GB |
| Audio VAE | `models/vae/` | ~0.4 GB |
| Spatial upscaler (**required** for the default two-stage graph) | `models/latent_upscale_models/` | |
| Conv VAE, temporal upscaler, duration head | per `scripts/models.lock` | part of the default set |
| LoRA (optional) | per `scripts/models.lock` | 8.9 GB |

Filenames and folders are pinned in `scripts/models.lock`. Script must be idempotent; flags: `--verify`, `--prune`, `--update-lock`, `--workflows-only`. Also copy `workflows/*.json` onto the volume.

### 4.3 Workflows (`workflows/`)

Three ComfyUI **API-format** JSON workflows derived from the Comfy-Org `video_ltx2_5_t2v` / `video_ltx2_5_i2v` templates (not the node-pack examples): `t2v.json`, `i2v.json`, `v2v.json`. Document the node IDs for prompt, negative, input file, width, height, frames/duration, fps, seed in `workflows/README.md`; the `SaveVideo` node is titled OUTPUT. Defaults: 1280×704 (width/height multiples of 64), 121 frames (~5 s), 24 fps, mp4 with audio; two-stage distilled graph by default, with a single-stage fallback. V2V means continuation of the input clip, not IC-LoRA editing: the guide is the last 25 frames of the input, the output is the new segment only (it overlaps ~1 s of the source, with new audio), and v2v needs >= 33 frames. Keep defaults conservative for a 48 GB card; expose resolution/length as advanced fields.

### 4.4 Serverless endpoint config (`infra/runpod/`)

Prefer Terraform if a maintained RunPod provider exists; otherwise a script against the RunPod GraphQL API. Settings:

- Image: `ghcr.io/ken-ck-yu/ltx25-worker:<tag>`
- GPU type: RTX 6000 Ada (48 GB) at US-WA-1, fallback L40S at EU-NL-1 (verify the exact GPU ID strings RunPod's serverless API uses)
- Workers: min **0**, max **2**
- Idle timeout: to be set after measuring cold start (ask me before going higher — this is the knob between cold starts and idle cost)
- Execution timeout: 15 min (900 s, our own spend-safety choice, not a platform limit: RunPod allows 5 s to 7 days; the handler's `JOB_TIMEOUT_S` default is 780 s)
- Network volume (80 GB, US-WA-1) attached
- FlashBoot: on, if available for this GPU class
- Env vars/secrets as in 4.1
- Document the endpoint ID in `config.env`.

### 4.5 Front end (`ui/`)

Cloudflare Worker (Wrangler project):

- Serves a single mobile-first page (vanilla HTML/JS, no build step): mode selector (T2V / I2V / V2V), prompt textarea, file picker (camera roll on phone), Generate button, progress/status (queued → cold-starting → running → done, with elapsed time), inline video player, gallery of past outputs from R2.
- "Advanced" collapsible: seed, resolution preset, duration, negative prompt.
- Routes as in section 3. The Worker holds `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` as secrets and talks to R2 via a binding.
- Cloudflare Access application on the hostname; policy = my email, one-time PIN, 24 h session. Managed in `infra/cloudflare/` (Terraform).
- No auth of its own.

### 4.6 Cost visibility

- Worker returns `gen_time_s`; UI shows it and an estimated $ per clip (GPU hourly rate from config).
- `scripts/usage.sh`: pulls last 30 days of endpoint usage/cost from the RunPod API and prints a one-line summary.

### 4.7 Dev path (optional, after everything above works)

- `make dev-pod`: spin a regular RunPod pod (48 GB) with the same volume mounted and ComfyUI exposed through RunPod's proxy, so I can edit workflows in the full ComfyUI editor and export new API JSON. `make dev-down` terminates it. This is the only manual start/stop in the project.

## 5. Repo layout

```
.
├── README.md                 # setup from zero + daily usage + cost notes
├── Makefile
├── config.env.example
├── worker/
│   ├── Dockerfile
│   ├── handler.py
│   └── extra_model_paths.yaml
├── scripts/
│   ├── download-models.sh
│   ├── usage.sh
│   └── dev-pod.sh
├── workflows/
│   ├── t2v.json / i2v.json / v2v.json
│   └── README.md
├── ui/                       # Cloudflare Worker (wrangler.toml, src/, static/)
├── infra/
│   ├── runpod/               # endpoint + volume
│   └── cloudflare/           # R2 bucket, Access app, DNS
└── .github/workflows/build-worker.yml
```

## 6. Acceptance criteria

1. From a fresh clone with secrets filled in: build/push worker → create volume → one-time model download → deploy endpoint → deploy UI → first video generated within ~45 min (download dominated).
2. With **zero** warm workers, a request from my phone completes end to end. Record the cold-start time (volume model load) in README. If cold start exceeds ~3 min, flag it and propose mitigations (FlashBoot, idle timeout, smaller encoder variant) before changing anything.
3. A second request within the idle window skips model load and completes in warm time. Record warm time for a default 720p ~5 s clip.
4. From my phone via Cloudflare Access I can do T2V, I2V (camera-roll image) and V2V (camera-roll video), see progress, play the result with audio, and see it in the gallery. Same from my laptop.
5. After the idle window, RunPod shows 0 running workers and the only accruing charge is the network volume.
6. A failed job shows a readable error in the UI, not a spinner forever.

## 7. Cost model (document in README, keep updated)

- Network Volume 80 GB (standard tier): ~$5.60/mo at $0.07/GB.
- Serverless RTX 6000 Ada: $1.75/hr (per-second; check the endpoint's live rate), billed only for cold start + generation.
- R2: free tier covers this volume of data.
- Cloudflare Worker + Access: $0.
- Example: 40 clips/month × ~3 min GPU each (incl. amortised cold starts) ≈ 2 GPU-hours × $1.75 ≈ $3.50 + $5.60 storage ≈ **~$9/month**.

## 8. References

- LTX docs: https://docs.ltx.video (requirements, model files, ComfyUI setup)
- Model weights: Lightricks/LTX-2.5 on Hugging Face (gated; LTX-2.x Community License)
- ComfyUI-LTXVideo node pack (Lightricks GitHub)
- RunPod Serverless docs, `worker-comfyui`, network volumes, GraphQL API
- Cloudflare Workers, R2, Access docs

## 9. Open questions for me (ask before assuming)

Answered:

- Front end hostname: `<name>.workers.dev` for now; a custom domain can be added later.
- Network volume datacenter: US-WA-1 (see section 2).
- Inputs in R2: kept for 7 days via a lifecycle rule.
- R2 bucket: `jubividia-ltx-eu` (WEUR) in my account.

Still open:

- Idle timeout value, once we've measured cold start.
- Real-GPU gate: int8-convrot on the RTX 6000 Ada (cold/warm times, peak VRAM) is still pending.

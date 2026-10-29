# LTX-2.5 Self-Hosted Video Generation (RunPod Serverless) — Project Spec

## 1. Goal

Run Lightricks' open-weight **LTX-2.5** video generation model on **RunPod Serverless** so I can generate video (with synced audio) from **text**, **image**, or **video** inputs from either my **phone** or my **computer**, via a single private URL — and pay **nothing** when idle except storage.

Priorities, in order:

1. **Scale to zero, automatically.** Zero GPU cost when idle. GPU billed only while a job runs (plus cold-start time). No manual start/stop.
2. **Cheapest viable.** Fixed cost = network volume only (~$7/mo). Variable cost = per-second GPU while generating.
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
| GPU type | **RTX A6000 and A40 only** (both 48 GB Ampere; configure the endpoint's GPU list with exactly these two, A6000 first) | Fits FP8 transformer + Gemma 4 encoder without offloading; cheapest 48 GB cards on RunPod. Do not add L40/L40S/RTX 6000 Ada/80 GB cards without asking me — they cost more. If both A6000 and A40 availability turns out poor, report it and ask. |
| Model variant | **LTX-2.5 22B distilled, FP8 / int8 ComfyUI build** | ~22 GB; fits 48 GB. Do NOT use full bf16 (~66 GB). Do NOT use GGUF + offload. |
| Inference backend | **ComfyUI** + official **ComfyUI-LTXVideo** node pack, wrapped as a RunPod serverless worker (start from `runpod-workers/worker-comfyui` or equivalent current official template — verify it's maintained) | Reference implementation; one model covers T2V / I2V / V2V + audio |
| Model storage | **RunPod Network Volume** (~100 GB) attached to the endpoint, mounted at `/runpod-volume` | Models are not baked into the image (too large, slow deploys); workers load from the volume |
| Output storage | **Cloudflare R2** bucket | Serverless workers are ephemeral; results must leave the worker. I already use R2. Worker uploads mp4 + thumbnail, returns an object key. |
| Front end hosting | **Cloudflare Worker** (static UI + small API) behind **Cloudflare Access** (my email only) | Free tier, always on, no GPU needed to serve the page, keeps the RunPod API key server-side |
| Auth | Cloudflare Access on the front end; RunPod endpoint called only from the Worker with the API key as a secret | Nothing public reaches RunPod directly |

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
   └── PUT  /api/upload     → stores input image/video in R2, returns presigned/short-lived URL

RunPod Serverless Endpoint (min 0, max 1–2 workers, 48 GB GPU)
   worker image: ghcr.io/ken-ck-yu/ltx25-worker
     ├── ComfyUI + ComfyUI-LTXVideo
     ├── handler.py: input → fill workflow template → run → upload result to R2 → return key
     └── /runpod-volume  ← Network Volume (models, workflow templates)
```

Job flow: UI uploads input to R2 → Worker submits `/run` with `{mode, prompt, input_url, params}` → RunPod spins a worker (cold start if none warm) → handler runs ComfyUI workflow → uploads to R2 → UI polls `/status` → plays result from R2.

## 4. Components to build

### 4.1 Serverless worker image (`worker/`)

- Base: current official RunPod ComfyUI worker image (or RunPod PyTorch base + ComfyUI if the worker template is stale). Pin CUDA/torch to what LTX docs require.
- Installed in image: ComfyUI, ComfyUI-LTXVideo and its requirements, `ffmpeg`, `boto3` (for R2 S3 API). **No model weights in the image.**
- ComfyUI model paths configured (via `extra_model_paths.yaml`) to point at `/runpod-volume/models/...`.
- `handler.py`:
  - Input schema: `{ "mode": "t2v"|"i2v"|"v2v", "prompt": str, "negative": str?, "input_url": str? (required for i2v/v2v), "width": int?, "height": int?, "num_frames"/"duration": ?, "fps": int?, "seed": int? }`. Validate and apply defaults.
  - Downloads `input_url` into ComfyUI's input dir if present.
  - Loads the matching workflow template from `/runpod-volume/workflows/{mode}.json`, fills node inputs (node IDs documented in `workflows/README.md`), submits to the in-container ComfyUI, waits for completion (websocket or polling).
  - Uploads resulting mp4 and a jpg thumbnail (ffmpeg, first frame) to R2 under `outputs/<date>/<job_id>.mp4|.jpg`.
  - Returns `{ "key": ..., "thumb_key": ..., "duration_s": ..., "gen_time_s": ..., "seed": ... }`.
  - Clear error messages back to the caller on failure (OOM, bad input, timeout).
- Keep ComfyUI running between jobs within the same warm worker (the official worker does this) so warm requests skip model load.
- Env/secrets on the endpoint: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- GitHub Actions workflow builds and pushes to GHCR on push to `main`.

### 4.2 Models (`scripts/download-models.sh`)

Run once from a temporary RunPod **pod** (any cheap GPU or CPU pod) with the network volume attached, since serverless workers can't be used for a 60–80 GB download comfortably. Pull from the official Lightricks Hugging Face repo (gated — accept the LTX-2.x Community License, use `HF_TOKEN`):

| Component | Volume path | Notes |
|---|---|---|
| LTX-2.5 22B **distilled** transformer, FP8/int8 ComfyUI build | `models/diffusion_models/` (confirm against LTXVideo README) | ~22 GB |
| Gemma 4 12B text encoder w/ projection | `models/text_encoders/` | ~26 GB |
| Video VAE | `models/vae/` | ~1.5 GB |
| Audio VAE | `models/vae/` | ~0.4 GB |
| Spatial upscaler (optional) | `models/latent_upscale_models/` | |

Verify exact current filenames/folders against `docs.ltx.video` and the ComfyUI-LTXVideo README before hardcoding. Script must be idempotent. Also copy `workflows/*.json` onto the volume.

### 4.3 Workflows (`workflows/`)

Three ComfyUI **API-format** JSON workflows derived from the official LTX-2.5 examples in the node pack: `t2v.json`, `i2v.json`, `v2v.json`. Document the node IDs for prompt, negative, input file, width, height, frames/duration, fps, seed in `workflows/README.md`. Defaults: 1280×720, ~5 s, 24–25 fps, mp4 with audio. Keep defaults conservative for a 48 GB card; expose resolution/length as advanced fields.

### 4.4 Serverless endpoint config (`infra/runpod/`)

Prefer Terraform if a maintained RunPod provider exists; otherwise a script against the RunPod GraphQL API. Settings:

- Image: `ghcr.io/ken-ck-yu/ltx25-worker:<tag>`
- GPU types: `NVIDIA RTX A6000`, `NVIDIA A40` — exactly these two, in that priority order (verify the exact GPU ID strings RunPod's serverless API uses)
- Workers: min **0**, max **2**
- Idle timeout: ~60 s (ask me before going higher — this is the knob between cold starts and idle cost)
- Execution timeout: 15 min
- Network volume attached
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

- Network Volume ~100 GB: ~$7/mo.
- Serverless A6000/A40: roughly $1.2/hr Flex (per-second; check the endpoint's live rate) — about 2× the equivalent pod rate, but billed only for cold start + generation.
- R2: free tier covers this volume of data.
- Cloudflare Worker + Access: $0.
- Example: 40 clips/month × ~3 min GPU each (incl. amortised cold starts) ≈ 2 GPU-hours ≈ $2.5 + $7 storage ≈ **~$10/month**.

## 8. References

- LTX docs: https://docs.ltx.video (requirements, model files, ComfyUI setup)
- Model weights: Lightricks/LTX-2.5 on Hugging Face (gated; LTX-2.x Community License)
- ComfyUI-LTXVideo node pack (Lightricks GitHub)
- RunPod Serverless docs, `worker-comfyui`, network volumes, GraphQL API
- Cloudflare Workers, R2, Access docs

## 9. Open questions for me (ask before assuming)

- Which domain for the front end hostname.
- Which RunPod datacenter for the network volume (needs A6000/A40 serverless availability; prefer EU).
- Idle timeout value once we've measured cold start.
- Whether to keep inputs in R2 long-term or delete after the job.

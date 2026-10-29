# jubividia

Self-hosted [LTX-2.5](https://docs.ltx.video) video generation (text / image / video → video with audio) on RunPod Serverless, with a phone-friendly front end on Cloudflare.

- **Spec:** [`SPEC.md`](SPEC.md)
- **How Claude Code works on this repo:** [`CLAUDE.md`](CLAUDE.md) — Anthropic's official `/feature-dev` workflow, vendored in `.claude/`
- **Feature summaries:** `docs/decisions/`

Setup, usage, measured timings and cost will be filled in as features land.

## Worker image (`worker/`)

A thin layer on `runpod/worker-comfyui` (pinned by tag and digest in `worker/Dockerfile`): adds ComfyUI-LTXVideo (pinned commit), our `handler.py` and `extra_model_paths.yaml`. No model weights are inside; models and workflow templates are read from the network volume at `/runpod-volume`.

```
make test    # handler unit tests, no GPU or network (creates .venv)
make lint    # ruff + YAML parse
make build   # docker build -> ghcr.io/ken-ck-yu/ltx25-worker:dev  (image is ~25 GB uncompressed)
make smoke   # checks inside the built image: torch unchanged, triton, boto3, ffmpeg, model-path mapping, native LTX nodes
```

CI (`.github/workflows/build-worker.yml`) builds and pushes `ghcr.io/ken-ck-yu/ltx25-worker` with tags `latest` and `sha-<short>` on pushes to `main` that touch `worker/`. The endpoint must reference the `sha-` tag (or digest), never `latest`. After the first push, set the GHCR package visibility to public (GitHub → Packages → Package settings).

### Job contract (v1)

Input: `mode` (`t2v`/`i2v`/`v2v`), `prompt`, optional `negative`, `input_key` (an R2 key under `inputs/`, required for i2v/v2v; no URLs are accepted), `width`/`height` (default 1280x720; rounded down to a multiple of 32, so 720 becomes 704 and the effective size is returned), `duration` seconds (default 5) with `fps` (default 24) or an explicit `num_frames` (8k+1, default 121), `seed`.

Output: `{v, key, thumb_key, meta_key, duration_s, gen_time_s, seed, width, height, num_frames, fps, cold}`. R2 keys are `outputs/<YYYY-MM-DD>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json`; the `.json` sidecar holds the prompt and parameters. Failure: `{error, error_code}` with codes `bad_input oom model_missing timeout input_fetch workflow_mismatch comfy_error output_missing upload_failed`.

Workflow templates (`/runpod-volume/workflows/<mode>.json`, API format) are filled by node `_meta.title`: `PROMPT`, `NEGATIVE` (optional), `WIDTH`, `HEIGHT`, `FRAMES`, `FPS`, `SEED` (field `text` for the text nodes, `value` for the rest) and, for i2v/v2v, `INPUT` (field `image` / `video`). The `workflows` feature must follow this.

Environment variables are documented in [`config.env.example`](config.env.example). The LTX-2.x Community License (free under $10M revenue) applies to the model weights.

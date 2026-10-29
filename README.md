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

Input: `mode` (`t2v`/`i2v`/`v2v`), `prompt`, optional `negative`, `input_key` (an R2 key under `inputs/`, required for i2v/v2v; no URLs are accepted), `width`/`height` (default 1280x720; 256 to 2048, rounded down to a multiple of 64 because the two-stage graph halves the size, so 720 becomes 704 and the effective size is returned), `duration` seconds (default 5) with `fps` (default 24) or an explicit `num_frames` (8k+1, default 121). For v2v the resulting frame count must be at least 33 (the guide uses the last 25 frames of the input), otherwise `bad_input`. `duration` x `fps` and `num_frames` share one maximum of 481 frames. `seed` is optional.

Output: `{v, key, thumb_key, meta_key, duration_s, gen_time_s, seed, width, height, num_frames, fps, cold}`. R2 keys are `outputs/<YYYY-MM-DD>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json`; the `.json` sidecar holds the prompt and parameters. The timestamp is taken when the job starts, so a retried job gets new keys: the UI must not assume a retry overwrites the earlier result.

Failure: `{error, error_code}`; the text is prefixed with the code, e.g. `[upload_failed] ...`, as a fallback in case RunPod drops `error_code`. Codes: `bad_input`, `config_error` (missing R2 env), `input_fetch`, `workflow_mismatch`, `model_missing`, `oom`, `timeout`, `comfy_unavailable` (ComfyUI unreachable or its process is dead), `comfy_bad_response` (non-JSON reply or no prompt_id), `comfy_error`, `output_missing`, `upload_failed` (after 3 tries). Whether RunPod's `/status` exposes `error_code` for a FAILED job is unverified.

Workflow templates (`/runpod-volume/workflows/<mode>.json`) must be ComfyUI **API format** (not the UI export). They are filled by node `_meta.title`; the first listed input name present on the node is set:

| Title | Input field(s) tried, in order |
|---|---|
| `PROMPT` | `text` |
| `NEGATIVE` (optional unless a negative prompt is sent) | `text` |
| `WIDTH`, `HEIGHT`, `FRAMES`, `FPS` | `value` |
| `SEED` | `value`, `noise_seed`, `seed` |
| `INPUT` (i2v) | `image` (core `LoadImage`), `file` |
| `INPUT` (v2v) | `file` (core `LoadVideo`), `video` |

The output is the single video the graph saves: use exactly one `SaveVideo`, or title the saving node `OUTPUT` (it then wins). Two or more videos without an `OUTPUT` node fail with `workflow_mismatch`; temp/preview files are ignored.

Uploads use boto3 with `request_checksum_calculation` / `response_checksum_validation` set to `when_required` for R2 compatibility, 5 s connect / 30 s read timeouts, boto retries off and the handler's own 3 bounded tries (each try is capped at 45 s by a thread join and all uploads must finish by 885 s after job start, so a stalled R2 can never push the job past the 900 s platform limit; generation gets 780 s by default). A failed job is not retried by the worker: fail and resubmit. **The first real upload to R2 is a gating check**: it has not been exercised against real R2 yet.

`worker/constraints.txt` is a `pip freeze` of the built image, used as a pip constraints file so rebuilds resolve to the same versions (no torch-family changes).

Environment variables are documented in [`config.env.example`](config.env.example). The LTX-2.x Community License (free under $10M revenue) applies to the model weights.

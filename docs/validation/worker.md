# worker — validation

Branch / commit: `feat/worker` @ `e3b92ee` (base `bf915fb`; `main` has since moved to `933671c`, see Q12). Validated 2026-10-29 by the validator agent, which did not write the code. Every claim below was re-run here; none is taken from the engineer's report.

## What I ran

| Command | Outcome |
|---|---|
| `make test` | 48 passed (0.22 s) |
| `unshare -rn .venv/bin/python -m pytest -q tests` (no network namespace) | 48 passed, so the unit tests make no network calls |
| `make lint` (ruff E,F,W + YAML parse) | clean |
| `actionlint` on `.github/workflows/build-worker.yml` (pip `actionlint-py`) | clean, rc 0 |
| Docker Hub API: tags of `runpod/worker-comfyui` matching `5.11` | `count: 0`. `5.11.0-base` does not exist. Newest `*-base` is `5.10.0-base` (pushed 2026-09-01). |
| Docker Hub API: digest of `5.10.0-base` | `sha256:e9d18d3d...b0d538`, identical to the Dockerfile pin. Compressed size of the base is 14.67 GB (amd64). |
| GitHub API: commit `220e1d45...` of ComfyUI-LTXVideo | exists, 2026-10-20, and is the current HEAD |
| `make build` | cached no-op (1.8 s) |
| `docker build --no-cache -t ltx25-worker:val worker` | succeeded. This was a full rebuild including `git clone`, `uv pip install` and the CPU `--quick-test-for-ci` step. The tag was removed afterwards. |
| `make smoke` on the cached image and on the `--no-cache` image | 19 PASS and 0 FAIL on both (torch/torchvision/torchaudio unchanged, triton 3.6.0, boto3, `pip check`, ffmpeg, LTXVideo present, handler installed, 6 model categories map to `/runpod-volume/models/*`, 4 native LTX nodes) |
| ComfyUI on CPU inside the image, `GET /object_info` | 955 nodes registered, 73 LTX nodes. These include `LTXAVTextEncoderLoader`, `LTXVAudioVAELoader`, `LTXVImgToVideo`, `LTXVAddGuide`, `LTXVLatentUpsampler` and `LTXQ8Patch`. `PrimitiveInt`, `PrimitiveFloat`, `LoadImage`, `LoadVideo`, `SaveVideo` and `CreateVideo` are present. The log shows `Adding extra search path` for all 7 categories under `/runpod-volume/models`. This covers the design's "/object_info lists the LTX nodes" check; the earlier smoke only grepped source. |
| `docker run --network none ... python /handler.py --test_input ...` (bad mode; then valid t2v with fake env) | runpod SDK 1.12.0 boots our handler. Returns `bad_input`, and `workflow_mismatch` (no volume), as expected. |
| Image inspection | Entrypoint `/opt/nvidia/nvidia_entrypoint.sh`, Cmd `/start.sh`, `/handler.py` is byte-identical to the repo file (16846 B), size 24.75 GB uncompressed. Installed: transformers 5.21.0, huggingface_hub 2.3.0, numpy 2.5.2, boto3 1.43.85, runpod 1.12.0. |
| Adversarial scripts (kept outside the repo, `$CLAUDE_JOB_DIR/tmp/attack{1,2,3}.py`) | See next sections. They use fake ComfyUI/R2 objects and, for boto, a local HTTP server on 127.0.0.1. |
| Secret scan (`git grep` for key/token/AKIA/private-key patterns, history search for `AKIA`) | no secrets. Only variable names and the `${{ secrets.GITHUB_TOKEN }}` reference. `config.env`/`.env*` are git-ignored. |

No real RunPod or Cloudflare call was made. The RunPod and Cloudflare MCP tools were not used. The one outbound R2-shaped test used `http://127.0.0.1:<port>` and `127.0.0.1:1`; the only real endpoint string seen was the unit-test assertion of `https://acct1234.r2.cloudflarestorage.com` from `make_r2_client`, which was constructed but never contacted.

## Cannot be verified here (needs a GPU, models, R2 or RunPod)

- Any real generation. No model weights, no GPU: `torch.cuda.is_available()` is false here.
- Whether the int8-convrot checkpoint loads and runs on the RTX 6000 Ada (sm_89) with torch 2.11+cu128. This is Ken's decision 8 gate and the reviewer's gating test. It is **not done**. Peak VRAM and warm/cold times are unmeasured. The log shows `comfy_kitchen` warning "You need pytorch with cu130 or higher to use optimized CUDA operations" and the `cuda` backend disabled. The `triton` backend is also "unavailable" on this CPU box, and the `eager` backend is the only one that works here. Which backend int8 uses on the real GPU, and how slow it is, is unknown.
- The `start.sh` GPU preflight, the stock `network_volume.py` behaviour, and cold-start model-load time.
- Real R2 behaviour: that boto3 1.43.85 uploads succeed against R2 (see Q3), that CORS/permissions are right, that `region_name="auto"` signs correctly. Only the client construction (endpoint URL, region) was checked.
- Whether RunPod's `/status` for a FAILED job exposes `error_code` (see Q1).
- Whether the SaveVideo mp4 actually contains audio, and what `status_str`/`outputs` ComfyUI 0.34.0 returns for a real LTX graph (the fakes mimic the documented shape).
- The CI workflow on GitHub (free-runner disk with a 24.75 GB image, GHA cache limits, GHCR push). Only linted.
- Build size on the registry (compressed layer size of our additions).

## Spec & design conformance

"Design" below is the architect's design as overridden by Ken's decisions and the reviewer's accepted changes.

| Item | Status | Note |
|---|---|---|
| Base `runpod/worker-comfyui` `-base` + own handler (decision 2) | Implemented, with deviation | `5.11.0-base` does not exist (verified). `5.10.0-base` is pinned by tag **and** digest, and the Dockerfile comment records why. This is the only reasonable pin, but it needs Ken's acknowledgement because decision 2 named 5.11.0 (Q9). ComfyUI is 0.34.0 as designed. |
| Digest pin + build fails on wrong base layout (reviewer 1.1, 1.2) | Implemented | `RUN test -f /start.sh ... import boto3, requests, runpod, triton, torch`. |
| Workflows reference filenames only (reviewer 1.3) | Implemented | Stated in `extra_model_paths.yaml`; enforcement belongs to `workflows`. |
| Record compressed image size (reviewer 1.4) | Partially | README gives uncompressed (~25 GB). Base compressed is 14.67 GB (I measured); ours not recorded. It affects cold start on a fresh host. |
| ffmpeg, boto3, requests in image | Implemented | Already in the base; the Dockerfile asserts it. |
| ComfyUI-LTXVideo pinned commit, constraints for torch family (design) | Implemented | Commit `220e1d4` verified. Torch/torchvision/torchaudio/triton frozen and diffed after install. Side effects in Q5. |
| `extra_model_paths.yaml` (7 categories at `/runpod-volume/models`) | Implemented | Verified by `folder_paths` and by ComfyUI's own startup log. |
| Build-time smoke (`--cpu --quick-test-for-ci`, `import boto3`, triton) (decision 3) | Implemented | Re-run with `--no-cache`. |
| Handler: validate; defaults 1280x720, 24 fps, 121 frames (decision 6) | Implemented, with deviation | 720 is not a multiple of 32, so the default is really 1280x704 and 5 s gives 121 frames. Documented and the effective size is returned. Needs Ken's OK (Q8). |
| `input_key` under `inputs/`, no URLs (decision 10) | Implemented | `input_url` is ignored/rejected. Every traversal variant I tried was refused (below). Downloaded before ComfyUI wait (but see Q13 on ordering). |
| Workflow lookup by `_meta.title` (reviewer 4) | Implemented | Some malformed shapes escape as generic errors (A-9). The real-node field names are unproven (A-11). |
| Return effective values + `"v":1` + `cold` (reviewer 2/6) | Implemented | `cold` is wrong after a rejected first job (A-3). |
| Stable `error_code` (reviewer 2) | Partially | Codes exist, but the wrong code is returned for real R2 upload failures (A-1), several ComfyUI failures and bad workflow shapes (all `comfy_error`). It is unknown whether `error_code` reaches the caller (Q1). |
| Handler timeout below the platform's 15 min | Implemented | 840 s default, covers input fetch, readiness wait and generation, but not the upload (A-5). |
| Key `outputs/<date>/<YYYYMMDDTHHMMSS>-<job_id>.mp4/.jpg/.json`, sidecar, `meta_key` (decision 7) | Implemented | Job ids are sanitised. Retry idempotency, which the reviewer asked to be confirmed, is not provided (Q6). |
| Local input/output files deleted | Implemented | Verified on success, on every early failure, and for the partial-download case. |
| ComfyUI kept running between jobs | Inherited | Handler never restarts it. It does not monitor it either (Q7). |
| Error mapping (OOM, missing model, node error, timeout) | Implemented | OOM, model-missing, timeout and prompt rejection map correctly in the fakes; real ComfyUI wording is unverified. |
| Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Implemented | `R2_BUCKET` is only checked late (A-2). |
| `config.env.example` complete | Mostly | The four R2 vars and the tuning vars are listed. `COMFY_HOST`, `COMFY_ROOT` and `POLL_INTERVAL_S` are read by the handler but not listed (low impact, internal). |
| CI: GHCR push on `main`, tags `latest` + `sha-<short>`, `GITHUB_TOKEN`, free-disk step | Implemented, unverified | actionlint clean. Disk and cache behaviour on a 24.75 GB image is untested (Q10). |
| GHCR public (decision 4) | Documented | README tells Ken to set visibility after the first push. Cannot be done from the repo. |
| README updated | Yes | Contract, commands, CI, env pointers, license note. Cost model and measured timings not updated (not this feature's job, but see Q11). |
| SPEC §6 criteria touched | See note | #2/#3 (cold/warm timing) and #6 (readable error) cannot be evidenced without a GPU. For #6 the handler returns a readable string in every case I tried, though the code is sometimes wrong. |
| Scope: one-way-door decisions made by the engineer alone | None found | Pin deviation (5.10.0) and the 704 default are forced by facts, flagged by the engineer, and need Ken's acknowledgement. |
| Executable bits / stray files | Clean | No mode other than 100644 is tracked. |

## Attempts to break it

IDs A-n are referenced above and in the verdict.

### Inputs (validation) - all through `validate_input` / `handler()`
- Non-object `input` (None, list, str), empty dict, unknown mode `T2V`: all `bad_input`.
- Prompt: int, whitespace-only, 8001 chars rejected; 8000 chars, CJK + emoji + RTL override, and an embedded NUL accepted and passed through. (NUL reaches ComfyUI; harmless but unfiltered.)
- width/height: string, `True`, 255, 2049, 1280.5 rejected; 1280.0 accepted; 1281 becomes 1280; 257 becomes 256; 2048x2048 accepted (OOM would be reported at run time).
- `width=NaN` (Python `json` accepts the literal) raises `ValueError` inside validation and surfaces as `comfy_error: unexpected worker error` instead of `bad_input` (A-8). `inf` would raise `OverflowError` the same way.
- duration NaN/inf/0/"5" rejected. `fps` 0/61/24.5 rejected. `seed` -1, 2^53+1, "1" rejected; 2^53 accepted.
- **A-4: `duration=20, fps=60` is accepted and produces `num_frames=1201`**, although an explicit `num_frames` is capped at 481. The cap is only applied to one of the two paths, so a caller can request 2.5x the maximum clip length. Worst case is bounded by the 840 s timeout (about $0.41 at $1.75/h), but it will mostly OOM or time out.
- `num_frames` 120 / 482 / 1 rejected; 9 and 481 accepted; `num_frames` wins over `duration`.
- `t2v` with `input_key` rejected; `i2v` without it rejected; `input_url` (including `http://169.254.169.254/`) is never used: ignored for t2v, "input_key is required" for i2v.
- `input_key` refused: `inputs/`, `inputs`, `inputs/../outputs/x.mp4`, `inputs/a/../../b`, `inputs/./a`, `inputs//a`, `/inputs/a`, `INPUTS/a`, `outputs/x.mp4`, backslash, NUL, newline, `../inputs/a`, `s3://`, `http://`, leading space, trailing slash, non-string types, 600-char key. Accepted: `inputs/%2e%2e/x` (literal text, a legal and harmless S3 key), `inputs/日本語/猫.png`, `inputs/\x7f`, `inputs/ a`, `inputs/a b [output].png`, and a key whose last segment is 300 chars.
- **A-6: 300-char (or 90 CJK chars = 270 bytes) basename passes validation and then fails with `OSError: File name too long`** when the handler writes `<jobid>_<basename>` into `/comfyui/input`. The error is reported as `comfy_error: unexpected worker error` and happens before any GPU use. Low impact, wrong code.
- `handler(None)` and `handler("str")` (not a dict job): generic `comfy_error`. RunPod never sends this, so ignored.
- Non-ASCII prompt and non-ASCII key end to end with fakes: success; JSON sidecar is ASCII-escaped and valid.

### Environment and files
- **A-2: `R2_BUCKET` unset on a t2v job: the whole generation runs first, and only the upload step fails** (`upload_failed: worker misconfigured`). `make_r2_client` checks the three credentials up front, but `bucket()` is first called at upload (or at input fetch for i2v/v2v). A misconfigured endpoint therefore burns GPU time on every t2v job. Fail-fast belongs in `run_job` start.
- All four R2 vars missing: immediate `upload_failed`, message names the first missing variable only. The message uses `upload_failed` for what is really a configuration error (cosmetic).
- Workflow file missing -> `workflow_mismatch`; invalid JSON and empty file -> `workflow_mismatch`; wrong node titles (lower case), node without `_meta` -> `workflow_mismatch` naming the missing title.
- **A-9: a workflow in ComfyUI UI format (`{"nodes": [...], "links": [...]}`), a top-level JSON list, or a node whose `inputs` is null is not detected.** Each gives `comfy_error: unexpected worker error: AttributeError/TypeError`, not `workflow_mismatch`. This is likely when someone saves the wrong export from the ComfyUI UI.
- **A-11: `INPUT_FIELD["v2v"] = "video"`, but core ComfyUI 0.34.0 `LoadVideo` takes its input as `file`** (read from `/comfyui/comfy_extras/nodes_video.py`). With a core `LoadVideo` titled INPUT the handler returns `workflow_mismatch: node INPUT has no input 'video'` (confirmed with a fake). It works only with a node class that happens to use `video` (for example a third-party loader). `SEED` has the same coupling: `value` fits `PrimitiveInt` but not `RandomNoise` (`noise_seed`). The contract in README must be matched by the `workflows` feature, but nobody has checked it against the real LTX 2.5 example graphs, so the risk is real.

### ComfyUI behaviour (faked HTTP)
- `POST /prompt` 400 with node_errors "Value not in list" -> `model_missing`; OOM text -> `oom`; timeout -> `timeout` and an `/interrupt` is attempted.
- **A-7: connection error or timeout on `POST /prompt` or `GET /history`** (ComfyUI crashed or was OOM-killed mid-job), non-JSON 200, or 200 without `prompt_id` -> `comfy_error: unexpected worker error: ConnectionError...`. The job is failed but with an unhelpful message. More important, the handler has no notion of "ComfyUI is dead": start.sh writes `/tmp/comfyui.pid` precisely so the handler can notice, and the stock handler used it; ours ignores it. A dead ComfyUI means each later job waits `COMFY_READY_TIMEOUT_S` = 300 s before failing, billed (Q7).
- ComfyUI never ready: `comfy_error` after the configured wait (tested with 2 s).
- A history entry with `status.completed` true but no `outputs` key polls until the 840 s timeout, then reports `timeout`. (Real ComfyUI always includes `outputs`, so low risk.)
- Output path attacks: `subfolder: ".."`, absolute `subfolder: "/etc"`, `filename: "../../x.mp4"`, symlink in `output/` pointing outside, `images: "oops"`, junk values -> all `output_missing`, nothing outside ComfyUI's directories read. Good. Files created in `output/` are removed after a successful upload.

### R2 (real boto3 against a local server)
- `head_object`/`download_file` against a server that answers 403: `input_fetch: could not fetch input: 403`. 404 / missing -> `input not found`. Oversized (ContentLength 10 GB) -> `input file too large`. Partial download failure -> no leftover file.
- **A-1: a real 403 on `upload_file` raises `boto3.exceptions.S3UploadFailedError`, which is neither `ClientError` nor `BotoCoreError`.** The handler's `except (ClientError, BotoCoreError)` around the upload does not catch it, so a bad R2 token or a bucket-permission mistake returns `comfy_error: unexpected worker error: S3UploadFailedError: Failed to upload...` instead of `upload_failed`. `put_object` 403 is caught correctly, and the unit test (`FakeS3`) cannot see this because it raises `ClientError`. The generated video is lost either way.
- Connection refused: each boto call retries (5 attempts, standard mode) taking 10-20 s here, and the uploads are not covered by the job deadline (A-5). With a blackholed endpoint (not tested; needs a non-routable address) the default 60 s connect/read timeouts times 5 attempts per call would be far longer. No timeouts are set in `Config`.
- **A-12: jpg upload failure after the mp4 succeeded leaves an orphan `.mp4` in R2 with no sidecar** (tested with a fake). The gallery must list by `.json`, or the handler must clean up.
- Job-id handling: `../../é<RLO>xxxx...` (200 chars) is sanitised to underscores and truncated to 80; missing id becomes `local`; int ids work.
- **A-3: a rejected job (e.g. bad mode) flips the process-level `_first_job`, so the first real job on that worker reports `cold: false`.** `cold` is meant to explain latency, so this makes the measurements in SPEC §6 criteria 2/3 unreliable for a worker whose first call was invalid.

## Questions / doubts (each needs an answer before acceptance)

1. **Does `error_code` reach the caller?** The RunPod SDK (1.12.0, `rp_job.run_job`, read in the image) pops `error` out of the handler's dict and sends `{"output": {"error_code": "bad_input"}, "error": "..."}`. I confirmed that shape by running the handler through the SDK. Whether `/status` for a FAILED job returns `output` as well as `error` is a platform behaviour I cannot test without calling RunPod. If it does not, the machine-readable `error_code` (reviewer Door 2, SPEC §6.6) is dead on arrival and the `ui` feature must parse text. Who verifies this, and when (first real endpoint job)? Should the code also be prefixed into `error` text as a fallback?
2. **int8-convrot on RTX 6000 Ada is untested** and the base is cu128 while `comfy_kitchen` says its optimized CUDA ops need cu130+. Per Ken's decision 8 the gate is "stop and ask Ken if it fails", but there is also a slow-but-working outcome, which would hurt SPEC §6 criterion 3 and cost without failing. What warm time/VRAM is Ken's threshold for "fails"? Only `-base` and `-base-cuda12.8.1` tags exist on Docker Hub, so a cu130 base is not available as a drop-in.
3. **boto3 1.43.85 default checksums vs Cloudflare R2.** Since boto3 1.36 the default is to add CRC32 checksums/trailers to uploads, which several third-party reports show R2 rejecting ("STREAMING-...-PAYLOAD-TRAILER not implemented", [Cloudflare community](https://community.cloudflare.com/t/aws-sdk-client-s3-v3-729-0-breaks-uploadpart-and-putobject-r2-s3-api-compatibility/758637), [Chatwoot](https://github.com/chatwoot/chatwoot/issues/13299)). The standard workaround is `request_checksum_calculation="when_required"` and `response_checksum_validation="when_required"` in botocore `Config`; the handler sets neither. I could not test this against R2 and cannot tell from the web results whether R2 has since fixed it. The base even carries a `fix-pin-boto3-for-non-aws-s3` tag, which suggests the RunPod maintainers hit a related problem. The engineer should either set those options (cheap, harmless) or the first real upload must be treated as a gating test. Which?
4. **Is a failure after generation really to be unrecoverable?** If the upload fails (A-1, A-5), the finished video is deleted in `finally` and the GPU time is lost. Is one retry or leaving the file for a second attempt wanted, or is fail-and-resubmit acceptable at this scale (about 40 clips per month)?
5. **ComfyUI-LTXVideo requirements bumped transformers 4.57.6 -> 5.21.0, huggingface_hub 0.36.2 -> 2.3.0** (seen in the `--no-cache` build log; `pip check` and a CPU boot are fine). A major-version bump underneath ComfyUI's own text-encoder/tokenizer code is exactly the kind of thing that only shows up when a model loads. The pin in the Dockerfile is for torch only, and the other LTXVideo requirements (`diffusers`, `kornia`, `einops`, ...) are unpinned, so a rebuild next month may differ. Does Ken want a full `pip freeze` constraints file committed for reproducibility (SPEC priority 4), and is the major bump accepted until a real run proves Gemma 4 loading?
6. **Retry idempotency** (reviewer Door 3, item 3: "confirm that a retry reusing the id overwrites idempotently"). The key contains a timestamp taken at job start, so a RunPod retry of the same job id writes a second set of objects under a new key, and the first set (if it got that far) is orphaned. Accepted, or should the key be derived only from `job_id` plus the date?
7. **ComfyUI liveness.** start.sh launches ComfyUI in the background and records `/tmp/comfyui.pid`; the handler does not check it. After a ComfyUI crash the worker stays "healthy" and every job costs 300 s of billed waiting. Should the handler check the PID and fail fast (or exit so RunPod replaces the worker)? This is not in the design and I did not test it in a real container, but the behaviour follows from the code and start.sh.
8. **Default 1280x720 vs "multiples of 32".** Decision 6 says 1280x720; 720 is not divisible by 32, so the handler produces 1280x704 and says so. Alternative: accept 720 if LTX actually allows it (the spec says 32). Ken needs to confirm 704 is acceptable for the default clip, and the README/UI must say so.
9. **Base 5.11.0 -> 5.10.0 (verified).** Decision 2 named 5.11.0. The tag does not exist on Docker Hub as of today. Ken must acknowledge the pin to 5.10.0 (ComfyUI 0.34.0, torch 2.11.0+cu128), because the architect's note that 5.11.0 "adds a pre-flight check that model files exist" therefore does not apply here. The design's "Verified facts" for 5.11.0 should be corrected.
10. **CI at 24.75 GB.** The base is 14.7 GB compressed and 24.5 GB on disk; a standard runner has roughly 14 GB free before the cleanup step. Will the free-space step plus buildx's own copy be enough, and will `cache-to: type=gha,mode=max` hit the 10 GB cache limit? Not verifiable without a push. Is Ken willing to treat the first CI run as the test and to fall back to a larger runner or no GHA cache if it fails?
11. **SPEC §7 and CLAUDE.md are stale.** §7 still says A6000/A40 at about $1.2/h; Ken's decision 9 moved the target to RTX 6000 Ada at $1.75/h in US-WA-1. The handler's worst-case cost per job is bounded by the 840 s limit (about $0.41). Who updates §2/§7 and the README cost section? Also `main` now has a different CLAUDE.md (feature-dev workflow) and a changed README, so merging this branch will conflict on README.md and probably CLAUDE.md; the coordinator should plan for it.
12. **Branch base.** `feat/worker` is based on `bf915fb`; `main` is at `933671c`, which deleted `.claude/agents/*` (this branch still carries them) and added `.claude/commands/feature-dev.md`. Should the branch be rebased before Ken merges?
13. **Order of operations.** The design says "download the input before loading models", which is satisfied. But the workflow template is read after the input download, so a missing or mismatched workflow wastes an R2 download first. Cheap to reorder; mention only because workflow errors will be the most common early failure.
14. **Which mp4 wins?** `find_output_mp4` returns the first mp4 in iteration order of the outputs dict. If the future workflow also writes a preview video, the wrong file could be uploaded. The `workflows` feature should guarantee exactly one `SaveVideo`, or the handler should prefer an output node titled e.g. `OUTPUT`. Which?

## Verdict: ACCEPT WITH FIXES

Owner of all fixes: **engineer**. No design flaw requires the architect, and I found no one-way-door decision taken without approval. The Docker image builds reproducibly (verified with `--no-cache`), starts ComfyUI with the LTX nodes registered and the volume paths mapped, and the handler's validation, traversal defences and cleanup held up under everything I threw at it. What the unit tests did not cover is below.

Required fixes before merge:
1. **A-1**: catch `boto3.exceptions.Boto3Error` (at least `S3UploadFailedError`) around the uploads and map it to `upload_failed`; add a test using a real-shaped exception or the local 403 server approach.
2. **A-2**: validate `R2_BUCKET` (and build the client) at the start of `run_job`, before any GPU work, for every mode.
3. **A-4**: apply the same maximum to the `duration` x `fps` path as to `num_frames` (481).
4. **A-9**: make `fill_workflow`/`load_workflow` reject non-API-format workflows (not a dict of dict nodes with dict `inputs`) with `workflow_mismatch`.
5. **A-7**: catch `requests.RequestException`/`ValueError`/`KeyError` around the ComfyUI calls and map to `comfy_error` with a readable message; decide Q7 (PID check).
6. **A-3**: only mark the worker "not cold" after a job reaches ComfyUI (or at least after validation).
7. **A-6 and A-8**: bound the local filename (for example hash or truncate the basename) and reject NaN/inf in `_int`.
8. **A-5 and Q3**: set explicit boto `connect_timeout`/`read_timeout` and the two `when_required` checksum options, or record in the report that the first real upload is a gating test.
9. **A-11**: align `INPUT_FIELD` with the node classes the real LTX 2.5 example workflows use (document per class: `LoadImage.image`, `LoadVideo.file`), or accept both.
10. **A-12**: delete the uploaded mp4 (best effort) if the jpg or sidecar upload fails, or document that the gallery lists by `.json`.
11. Add `COMFY_HOST`, `COMFY_ROOT`, `POLL_INTERVAL_S` to `config.env.example`.

Not blocking the code, but blocking acceptance as "done": answers to Q1, Q2, Q3, Q5, Q6, Q8, Q9. The gating GPU run (int8-convrot on RTX 6000 Ada, cold and warm timing, peak VRAM, first real R2 upload, and a real FAILED job to see what `/status` returns) has not been executed and must happen once `models`, `workflows` and `endpoint` exist. Until then, this feature is validated only as far as a CPU-only container and fakes can take it.

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


---

# Re-check (2026-10-29, after commits 3be0a61, ec1c0e0, d9cf321)

Re-validated by the validator agent at `feat/worker` @ `d9cf321`. Nothing is taken from the engineer's report. Each fix was exercised against real behaviour: the real handler, **real boto3 1.43.85 and real `requests`** against throw-away local HTTP servers on 127.0.0.1 (a fake S3 and a fake ComfyUI), and the real runpod SDK inside the image. The scripts are kept outside the repo (`$CLAUDE_JOB_DIR/tmp/re{1..5}.py`). No RunPod or Cloudflare endpoint was contacted; `config.env` was not read.

## What I ran

| Command | Outcome |
|---|---|
| `make test` | 90 passed. Also under `unshare -rn` (no network): 90 passed |
| `make lint` | clean |
| `make build` | cached no-op. I then ran `docker build --no-cache -t ltx25-worker:val2 worker`: succeeded (`uv pip install` honoured `-c constraints.txt`, transformers 5.21.0 as before, torch-family `diff` empty, CPU `--quick-test-for-ci` ok). Tag removed afterwards |
| `pip freeze` of the fresh `--no-cache` image vs `worker/constraints.txt` | byte-identical, so the freeze is faithful and reproducible. No `@ file://` or editable lines |
| `make smoke` on the cached image and on the `--no-cache` image | 19 PASS, 0 FAIL on both |
| `/handler.py` in the image vs `worker/handler.py` | identical md5 |
| runpod SDK 1.12.0 inside the image, `--test_input`, `--network none` | `config_error` (no env) and `bad_input` arrive as `{"output": {"error_code": ...}, "error": "..."}`: the new codes survive the SDK exactly like the old ones. This is only the SDK-side shape; the platform `/status` shape is unverified (Q1) |
| Secret scan (working tree, `git log -S AKIA`), tracked modes, ignore rules | No secrets (the only `AKIA` hit in history is my own report text). All tracked files are 100644; the repo needs no executable bit (`/handler.py` is run via `python`, `start.sh` belongs to the base). `config.env`, `.venv`, `__pycache__` are ignored |

## Defects, one by one (A-n from the first report)

| ID | Status | Evidence |
|---|---|---|
| A-1 real `S3UploadFailedError` | **Fixed** | Fake S3 answering 403 to PUT: `upload_failed` after 3 tries, output file removed. 503 SlowDown, connection refused and 403 on the json also give `upload_failed` |
| A-2 bucket checked late | **Fixed** | `R2_BUCKET` unset: `config_error` in 0.0 s, 0 requests to ComfyUI, 0 to S3 |
| A-3 `cold` flag | **Fixed** | `_first_job` stays true after `bad_input`, after an `input_fetch` failure and after a rejected prompt; the next real job reports `cold: true` |
| A-4 duration x fps cap | **Fixed** | 20 s x 60 fps: `bad_input` (1201 > 481); 20 s x 24 fps = 481 accepted; 20 s x 23 = 457; `num_frames` 489 rejected |
| A-5 timeouts | **Partly fixed, hole remains** | Connect/read timeouts 10/60 s are set and both `when_required` checksum options are set (no `x-amz-checksum` or trailer headers on the PUTs the server saw). But a stalled endpoint (accepts the connection, never answers; the realistic R2 brownout) made **one** mp4 upload take **733 s** before `upload_failed` (server saw 12 PUT attempts: 3 handler tries x botocore/s3transfer retries x 60 s). The "30 s grace" is only checked between tries, never inside one. A job that generated for 300 s would exceed RunPod's 900 s execution limit and be killed instead of returning a readable error. See B-4 |
| A-6 long basename | **Fixed** | 300-char and 90 CJK-char basenames pass. Local name is `<jid>_<sha1[:8]><sanitised ext>`, independent of key length; same basename in different folders gives distinct names |
| A-7 ComfyUI failure modes | **Fixed, with notes** | Port closed plus dead PID in `/tmp/comfyui.pid`: `comfy_unavailable` in 0.0 s (was 300 s). PID that dies mid-poll: fails within 1 s. Server that vanishes mid-job with no pid file: `comfy_unavailable`. Non-JSON history, list-shaped history, missing `prompt_id`: `comfy_bad_response`. 400 with OOM or "not in list": `oom` / `model_missing`. **PID mechanism in the real image**: with `bash` as PID 1 (as under `start.sh`) a dead background child is reaped, so `os.kill(pid, 0)` raises `ProcessLookupError` (checked inside the image). Under a non-reaping parent (my harness) a zombie looks alive, but that is not the deployed layout. Residual: B-2, B-3 |
| A-8 NaN/inf | **Fixed for NaN/inf/1e400; huge ints escape** | Every numeric field with NaN, inf, -inf, 1e400 gives `bad_input`; JSON `NaN` end to end gives `bad_input`. A 309+ digit integer (valid JSON) still raises `OverflowError` from `math.isfinite` and returns `comfy_error: unexpected worker error` (B-1) |
| A-9 non-API workflows | **Fixed** | UI format, top-level list, `{}`, null `inputs`, non-dict node, missing `class_type`, invalid JSON, missing file: all `workflow_mismatch` with a readable message, 0 S3 GETs, 0 ComfyUI posts. Residual: a node whose `_meta.title` is a list or dict is unhashable and escapes as `comfy_error` (B-3, cosmetic) |
| A-11 INPUT/SEED fields | **Fixed** | `LoadImage.image` (i2v) and core `LoadVideo.file` (v2v) work; a custom node with `video` works; `RandomNoise.noise_seed` works for SEED; a node with both `image` and `file` only gets the first listed; a wrong class gives `workflow_mismatch` naming the tried fields; duplicate titles are all filled; a link-valued input (`["12", 0]`) on WIDTH is silently replaced by the constant (acceptable, worth knowing). Whether the real LTX 2.5 example graphs use these classes is for `workflows` to confirm |
| A-12 orphan mp4 | **Fixed** | jpg 403 or json 403: mp4 (and jpg) are deleted (DELETE seen on the server, bucket empty afterwards). If DELETE also fails the orphans remain and a warning is logged (best effort, as designed): the gallery should still list by `.json` |

## Questions of the first report

- **Q3 (R2 checksums)**: code fixed. The gating test on real R2 is still needed (README now says so).
- **Q5 (unpinned transitive deps)**: fixed. `constraints.txt` is identical to a fresh build's freeze. It pins transformers 5.21.0 / huggingface_hub 2.3.0; that Gemma 4 loads with them is still unproven.
- **Q6 (retry idempotency)**: settled by documentation. Verified: a retry with the same job id gets new keys (`...T013157-same.mp4` vs `...T013158-same.mp4`); a failed attempt cleans up its own uploads. README warns the UI.
- **Q7 (liveness)**: fixed (A-7).
- **Q13 (order)**: fixed. Workflow load/fill runs before any S3 call (0 GETs on every workflow error).
- **Q14 (which mp4)**: fixed. A node titled `OUTPUT` wins (two mp4s: the OUTPUT node's file was the one chosen); two videos without `OUTPUT`: `workflow_mismatch`; `OUTPUT` node with no mp4: `output_missing`; temp-only: `output_missing`; one file listed under both `images` and `gifs`: de-duplicated and accepted; subfolders work. After the ambiguous or `output_missing` outcomes the extra mp4 files stay in ComfyUI's `output/` on the worker's ephemeral disk (B-5).
- **Q1, Q2, Q4, Q8, Q9, Q10, Q11, Q12**: not code fixes; still open (below). Q12: the branch is still based on `bf915fb`, `main` is at `933671c`, and `.claude/agents/*` is still tracked here.

## New findings in the rewrite

- **B-1 (low)**: integers of 309+ digits in any numeric field raise `OverflowError` and return `comfy_error` instead of `bad_input`. No cost, wrong code. Fix: guard `_num_ok` / compare ints before the float test.
- **B-2 (low)**: if ComfyUI answers `GET /history/<id>` with a persistent non-200 (for example 500), `body` becomes `{}`, `failures` is reset and the loop polls until the 840 s deadline, then reports `timeout`. Only non-JSON and connection errors count as failures. Fix: count non-200 as a failure.
- **B-3 (cosmetic)**: a `/prompt` reply with status 500 is reported as `workflow_mismatch: ComfyUI rejected the workflow` (every non-200 that is not OOM/model-missing is). A 5xx is a server fault, not a template fault. Also the unhashable `_meta.title` case.
- **B-4 (= A-5, needs a fix)**: upload time is not bounded under a stalled R2. Suggested fix: `retries={"max_attempts": 1}` in the boto `Config` (the handler already retries 3 times), and check the deadline before each try. Re-measure with a stalled server; target a worst case well under the 900 s limit even after a long generation.
- **B-5 (cosmetic)**: extra mp4 files left in `/comfyui/output` after `workflow_mismatch` / `output_missing`.
- **B-6 (low)**: `config.env.example` now lists `JOB_TIMEOUT_S`, `COMFY_READY_TIMEOUT_S`, `INPUT_MAX_BYTES`, `WORKFLOWS_DIR`, `COMFY_HOST`, `COMFY_ROOT`, `POLL_INTERVAL_S` and the four R2 variables. `COMFY_PID_FILE` (read by the handler, default `/tmp/comfyui.pid`, which matches `start.sh`) is missing.
- Retry loop vs job deadline: generation is bounded by the 840 s deadline; uploads by `deadline + 30` only between tries (A-5); the readiness wait uses `min(deadline, 300 s)`. `fetch_input` is not bounded by the deadline, only by boto's timeouts. After a very slow input download, `wait_for_comfy` reports "did not become ready" immediately if the deadline has passed (misleading message, harmless).
- Orphan cleanup works (verified for mp4/jpg when a later upload fails). On success, the output file, the input file and the temp dir are all gone after each job.
- The INPUT/SEED candidate tuples behave as the README table says; the 481-frame cap holds on both paths.

## Cannot be verified without a GPU, models, R2 or RunPod

- Any real generation; int8-convrot loading and speed on the RTX 6000 Ada (sm_89, torch 2.11+cu128; `comfy_kitchen` says its optimized ops need cu130); peak VRAM; cold and warm timings (SPEC criteria 2 and 3). This is Ken's decision-8 gate and it has not been run.
- That Gemma 4 and the LTX nodes load under transformers 5.21.0 with real weights.
- Real R2: that the `when_required` options make uploads succeed; CORS and permissions; `region_name="auto"` signing; real R2 timeout behaviour (the A-5 numbers come from a local stall).
- That RunPod's `/status` for a FAILED job returns `output.error_code` (Q1). Only the SDK-side shape is verified.
- The real ComfyUI wording for OOM and missing models (the classifier is tested on my sample strings), the real `/history` shape for the LTX graph, and whether the mp4 has audio.
- The `start.sh` GPU preflight and network-volume behaviour; the PID file semantics are verified only with a bash-PID-1 emulation, not the real `start.sh` on RunPod.
- GitHub Actions: disk and GHA cache with a 24.75 GB image, GHCR push and public visibility (workflow only linted).

## Open (not code)

Q1 (does the platform expose `error_code`?), Q2 (int8-convrot warm-time/VRAM threshold), Q4 (accept losing a finished clip on upload failure?), Q8 (704 default), Q9 (acknowledge base 5.10.0 instead of 5.11.0), Q10 (CI size), Q11 (SPEC §7 and CLAUDE.md stale; merge conflicts with `main`), Q12 (rebase).

## Re-check verdict: ACCEPT WITH FIXES

All twelve defects and the engineer-owned questions are fixed or properly documented. The tests are real (my independent real-boto3 and real-HTTP runs agree with them), the image rebuilds reproducibly with the freeze, and there are no secrets. Remaining required fixes (small, engineer):
1. **A-5 / B-4**: bound the upload time (boto `max_attempts` 1 and a deadline check before every try), then re-measure with a stalled server.
2. **B-2**: count non-200 `/history` replies as failures.
3. **B-6**: add `COMFY_PID_FILE` to `config.env.example`.

Optional (low): B-1, B-3, B-5. The gating GPU run and the first real R2 upload remain mandatory before the feature can be called done.


---

# Second re-check (2026-10-29, after commits 9f3af36 and 4a1d5a8)

Validated at `feat/worker` @ `4a1d5a8` by the validator agent. Same method as the first re-check: real handler, real boto3 and `requests` against local fake S3 and ComfyUI servers on 127.0.0.1 (script `$CLAUDE_JOB_DIR/tmp/re6.py`, outside the repo). No RunPod or Cloudflare call; `config.env` not read.

## Re-run

| Command | Outcome |
|---|---|
| `make test` | 98 passed |
| `make lint` | clean |
| `docker build --no-cache -t ltx25-worker:val3 worker` | succeeded; `pip freeze` of the new image is identical to `worker/constraints.txt`; image `/handler.py` has the same md5 as the repo file. Tag removed afterwards |
| `make smoke` (cached image and `--no-cache` image) | 19 PASS, 0 FAIL on both |
| Secrets in tree (`git grep`) and history | none; all tracked files are 100644 |

## Fixes verified

| Item | Result |
|---|---|
| **A-5, stalled endpoint, default budget** | `upload_failed` after **93.2 s** (3 tries x 30 s read timeout + backoff), engineer's claim ~96 s holds |
| A-5, 20 s hard deadline | `upload_failed` after **20.0 s** (`timed out after 20s`); the deadline is checked before every try (`remaining < 1` breaks out) |
| A-5, generation used the full default budget (780 s, simulated by shifting the clock), then a stalled R2 | uploads gave up at a virtual **872 s** since job start, below the 885 s hard deadline and the 900 s platform limit |
| Orphan cleanup bounded | json 403 plus a DELETE that never answers: job returned `upload_failed` after 23.1 s (each delete capped at 10 s and skipped once the deadline is near) |
| Slow but successful uploads | 20 s per PUT: success (60 s total). 25 s per PUT: success (75 s). 40 s per PUT: cut off by the 30 s read timeout and fails after 93 s (expected; see N-1) |
| Thread leak | each timed-out attempt leaves a daemon thread until its socket times out (at most 30 s later, as boto's own read timeout still applies); 4 were visible immediately after the stall run and none can block process exit. No growth beyond tries x files per job |
| JOB_TIMEOUT_S 840 -> 780 | consistent: handler default, README ("generation gets 780 s", 885 s upload deadline) and `config.env.example` (`JOB_TIMEOUT_S=780`, "at most ~800") agree; no remaining `840` in the repo |
| B-2 | `/history` returning 500: `comfy_unavailable` after 3 polls, 0.1 s (was: polled until the deadline) |
| B-6 | `COMFY_PID_FILE` is in `config.env.example` with the right default |
| B-1 | 309+ digit integers in `width`, `seed`, `duration`, `fps`, `num_frames` all give `bad_input` |
| B-3 | `/prompt` 500 gives `comfy_error` ("server error (HTTP 500)"); 400 gives `workflow_mismatch`; 503 with OOM text still gives `oom`; a node whose `_meta.title` is a list is ignored and the job succeeds |
| Q1 | every error text now starts with `[code] ` (for example `[bad_input] mode must be one of ...`) while `error_code` is kept; documented in README. Whether RunPod keeps `output.error_code` is still unverified, but the code is now readable from the text either way |

## New observations (all low, none blocking)

- **N-1**: the per-attempt cap is a read timeout of 30 s plus 45 s thread limit. A single PUT whose response takes over 30 s (very large clip on a slow link) is cut off and retried, then fails. At 24 fps x 20 s the mp4 is tens of MB, so this should not trigger on R2, but the first real upload should record the upload times.
- **N-2**: an abandoned attempt can still complete on the server after the worker has reported failure (reproduced: the mp4 PUT landed after the timeout), leaving an `.mp4` in R2 without a sidecar. The cleanup only deletes keys the worker saw succeed. The gallery must list by `.json`, as already stated.
- **N-3**: the input download (`fetch_input`) is still bounded only by boto's 5 s / 30 s timeouts, not by the deadline.

## Verdict: ACCEPT

All earlier required fixes (A-5, B-2, B-6) and optional ones (B-1, B-3) are verified. The remaining items (N-1..N-3, B-5) are low and documented.

## Still unverifiable without a GPU, models, R2 or RunPod (for the PR description)

- Any real generation: int8-convrot loading and speed on the RTX 6000 Ada (sm_89, torch 2.11+cu128, `comfy_kitchen` warns about cu130), peak VRAM, cold and warm timings (SPEC criteria 2 and 3). Ken's decision-8 gate; not run.
- That Gemma 4 and the LTX nodes load with real weights under transformers 5.21.0 / huggingface_hub 2.3.0.
- Real R2: that uploads succeed with the `when_required` checksum options, `region_name="auto"` signing, CORS and token permissions, and real timeout behaviour (all upload timings above come from a local fake).
- That RunPod's `/status` for a FAILED job exposes `output.error_code` (only the SDK-side shape and the `[code]` text prefix are verified).
- Real ComfyUI error wording for OOM and missing models, the real `/history` shape for the LTX graph, and whether the mp4 contains audio.
- The real `start.sh` PID file under RunPod (verified only with a bash-PID-1 emulation), the GPU preflight, and network-volume behaviour.
- GitHub Actions: disk and GHA cache with a 24.75 GB image, GHCR push and public visibility (workflow only linted).
- Whether the real LTX 2.5 example workflows use the node classes and fields the contract expects (`workflows` feature).

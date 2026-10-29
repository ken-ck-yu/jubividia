# workflows — independent validation

Validator: independent session, 2026-10-29, branch `feat/workflows` (HEAD 894eddc). No GPU, no RunPod or Cloudflare calls, no secrets read. Code was not changed.

## Verdict: ACCEPT WITH FIXES

The six graphs are structurally correct, wired as designed, pass every engineer check and every check I added, and the V2V tail selection is proven by execution. Nothing blocks the next feature. Fixes (all small, none touch graph topology):

1. Engineer: README "V2V is continuation" overstates where the new clip starts (see Q1); fix wording or the guide placement after Ken answers.
2. Engineer: the checker does not pin loader literals (CLIPLoader `type`, UNETLoader `weight_dtype`, sampler name, sigmas); a wrong but valid value passes (see "Attempts to break it").
3. Coordinator (already known, not this feature): handler must round to 64 (`// 64 * 64`) and v2v needs `num_frames >= 25` (handler minimum is 9).

## What I ran (exact commands, from the worktree)

1. `env LOCK=/home/ken/jubividia/.claude/worktrees/agent-a64d72484c176d9dc/scripts/models.lock make -f scripts/workflows.mk test-workflows` -> `1247 checks, 0 failures`.
2. `env HANDLER=/home/ken/jubividia/.claude/worktrees/feat-worker/worker/handler.py LOCK=/home/ken/jubividia/.claude/worktrees/agent-a64d72484c176d9dc/scripts/models.lock make -f scripts/workflows.mk validate-workflows` -> static 1247/0 failures, then docker (image `ghcr.io/ken-ck-yu/ltx25-worker:dev` present, 24.8 GB): 24 workflow/case lines `ok` (6 files x default, negative+seed, min-size, max-size), `v2v input chain executed: 25 frames`, `Math+CreateVideo+SaveVideo executed: mp4 h264,640`, `2165 checks, 0 failures`.
3. My own scripts (scratch, not committed): a node-graph dump of all six files; 18 mutations of `t2v.json` through the static checker; 6 mutations through the live checker in the same image with a fake volume; a handler `fill_workflow` fuzz (boto3 etc. stubbed); real execution on CPU of the v2v input chain on 6 synthetic clips; a text scan of the JSON for secrets and absolute paths.
Docker notes: `docker run --entrypoint /bin/bash ...` was refused by the shell guard in this worktree; running the script as the entrypoint (`--entrypoint /check/xyz.sh`) worked.

## Conformance table

| Requirement (design / reviewer / Ken) | Result | Evidence |
|---|---|---|
| Model filenames = `models.lock` (5 used) | PASS | static check against lock; hand dump: UNET int8-convrot, Gemma int8-convrot, video VAE bf16, audio VAE bf16, upscaler x2 1.0; bare filenames, no paths |
| CLIPLoader `type=ltxv`, UNETLoader `weight_dtype=default` | PASS | graph dump (all 6); not enforced by the checker (see below) |
| Titles PROMPT, NEGATIVE, WIDTH, HEIGHT, FRAMES, FPS, SEED, OUTPUT unique; INPUT only in i2v/v2v | PASS | static check + dump; INPUT absent in t2v |
| Field names/types the handler fills | PASS | i2v `LoadImage.image`, v2v `LoadVideo.file`, ints for WIDTH/HEIGHT/FRAMES/SEED (`PrimitiveInt.value`), FPS `PrimitiveFloat.value` (handler sends an int, accepted); fuzz fill: no mismatch in 8 cases x 6 files |
| OUTPUT = the only SaveVideo, mp4/h264 | PASS | static + live probe wrote a real h264 mp4 |
| Defaults 1280x704, 24 fps, 121 frames | PASS | node values |
| Stage-1 half size: multiple of 32 only when W,H are multiples of 64 | PASS (workflow) / OPEN (handler) | math `a/2` executed (640 from 1280). Current handler still floors to 32: 1312x1088 -> half 656x544, 1056x704 -> half 528x352 (not 32-multiples). Known follow-up, documented in README |
| Two-stage wiring (reviewer Door 3) | PASS | stage 1 (8 steps, 9 sigmas) -> split -> upsampler -> stage 2 (sigmas 0.85, 0.725, 0.4219, 0.0) -> split -> tiled decode; audio latent from stage 1 re-joined in stage 2; both noise nodes take SEED. Same sampler, sigmas, CFG 1/1, tile 512/64/64/16 as the Comfy-Org template |
| Single-stage fallback documented and shipped | PASS | 3 files, 1 sampler, no upscaler, same titles; all pass `/prompt` x 4 cases |
| V2V = option B, core nodes only | PASS | only core classes; checker/object_info confirmed they exist in the image |
| Guide = LAST K=25 (8n+1) frames | PASS (proved) | `Video Slice` start -4 s -> `GetVideoComponents` -> `ImageFromBatch` batch_index -25 length 25. I ran it on a clip of 8 s red then 2 s blue: all 25 frames blue. Image's `ImageFromBatch` resolves negative index from the end |
| Clip shorter than K | PASS | 12-frame clip -> 12 frames (index clamps to 0); `LTXVAddGuide` crops to 8n+1 itself (9). 5 fps x 8 s -> 20 (window limits it; AddGuide uses 17). 60 fps x 10 s, 25-frame clip, clip with audio -> 25 |
| FRAMES vs K | PASS with note | `LTXVAddGuide` asserts guide latent frames <= latent length: K=25 needs FRAMES >= 25 (4 latent frames). README says "larger than K / UI 33": conservative and fine. Handler minimum 9 fails at run time for v2v (FRAMES 9 or 17 flagged in fuzz); `/prompt` cannot catch it |
| Guide added before AV concat | PASS | Guide stage 1 -> ConcatAV (core refuses a guide on a joined AV latent) |
| Crop before the upscaler, re-add at full size, crop before decode | PASS | node 31 crop (stage-1 conds) -> 32 upsample -> 33 AddGuide full-size -> 41 crop final -> 42 decode. Guide frames resized to WIDTHxHEIGHT once; `LTXVAddGuide` rescales internally to the latent grid, so a second resize node is unnecessary |
| Output is the new segment only | PASS (as built) | guides cropped, source never re-muxed; README says so |
| Audio path | PASS | `LTXVEmptyLatentAudio` (FRAMES, FPS) -> ConcatAV -> sample -> SeparateAV -> `LTXVAudioVAEDecode` -> `CreateVideo(audio=)` -> `SaveVideo` OUTPUT. Input audio ignored (README). Audio presence unproven (needs GPU) |
| Negative node kept | PASS | NEGATIVE feeds `LTXVConditioning` |
| No IC-LoRA, no pack nodes | PASS | none present |
| Version marker | PASS | README `Workflow version: 1` = `_wf1` in every SaveVideo prefix; checker fails on mismatch (negative control passed) |
| No secrets/absolute paths in JSON | PASS | regex scan for `/home`, `/root`, `/tmp`, URLs, token/secret/password: no hits |
| Hygiene | PASS | diff vs main = 14 files, all in allowed set (workflows/, scripts/, `.gitignore`, design note); no root Makefile; `.wf-validate/` ignored; scripts `100755`, `workflows.mk` `100644`; `models.lock` not in this branch; worktree clean |

## Differences from the Comfy-Org templates (t2v/i2v/flf2v, fetched from `Comfy-Org/workflow_templates`)

Same: euler_ancestral, stage-1 sigmas, stage-2 sigmas, CFG 1/1, CLIPLoader ltxv, UNET default dtype, VAEDecodeTiled 512/64/64/16, LTXVConditioning fps, Math `a/2` for half size, stage-2 re-conditioning in i2v.
Different (all documented or deliberate unless marked): flat graph, no subgraphs; `ImageScale`(lanczos, center crop) instead of `ResizeImageMaskNode`; no resolution selector; FRAMES and FPS are direct primitives (template computes `duration*fps+1`; fps goes through a Math node); size 1280x704 (template 1280x720, stage 1 640x360); bypass toggles hard-wired; no prompt enhancer or E2B encoder; both RandomNoise driven by SEED (template: fixed 42 on stage 2); SaveVideo explicit mp4/h264 (template: auto/auto); SaveVideo titled OUTPUT; filename prefix has `_wf1`. flf2v guides use strength 0.7 at frame_idx 0 and -1 in a single stage; our v2v uses strength 1.0 (not stated as a decision anywhere; see Q3). I could read only the first ~100 000 characters of each template.

## Attempts to break it

Static checker, mutations of `t2v.json` (all caught unless noted): removed SEED title, duplicate title, dangling link, self link, wrong filename not in lock, path in filename, OUTPUT retitled, two OUTPUT-titled nodes, two SaveVideo (one retitled), WIDTH wrong class, WIDTH linked instead of literal, wrong version prefix, format `auto`: 13/13 caught. Not caught statically (by design they need object_info): bogus sampler, bogus codec, wrong link type, CLIPLoader type, bad weight_dtype.
Live checker in the image (6 mutations): bogus sampler -> caught (lint and HTTP 400); bogus codec -> caught by lint only (the server returned 200, so the lint is load-bearing); VAE linked into a FLOAT socket -> caught (lint and HTTP 400); string "fast" as frame_rate -> caught (HTTP 400); `weight_dtype=fp99` -> caught; **CLIPLoader `type="wan"` (valid enum value, wrong model family) -> NOT caught**. Static checker also does not validate a link's output slot index against the node (only live lint does).
Fill fuzz through the handler's `validate_input`+`fill_workflow`, 8 cases x 6 files: non-ASCII, emoji, quotes, newline, NUL in prompt; seed 2**53 and 0; 8000-char prompt and negative; 256x256x9 fps 1; 2048x2048x481 fps 60; duration 0.3 s at 60 fps; 20 s at 24 fps; odd sizes. Every fill landed on the right node; the JSON stayed serialisable. Findings: only the known /32 vs /64 mismatch (1312x1088, 1056x704 give a non-32-multiple half size in two-stage) and v2v with FRAMES < 25.
The max case (2048x2048x481) passes `/prompt` only; whether 48 GB can run it is unknown.

## Cannot be verified without a GPU and the real models

Int8-convrot transformer load and kernels; `CLIPLoader` actually loading the Gemma 4 int8 file; real sampling (dynamic-combo shapes are proven only for `/prompt` validation and the executed Math/SaveVideo/v2v-prep subgraphs; the samplers, `LTXVAddGuide` on a real VAE, `LTXVLatentUpsampler` and `LTXVCropGuides` never ran); output quality; audio present and not silent; whether V2V continues the source and how the first second of the output looks (Q1); VRAM and speed of two- vs single-stage at 1280x704; the maximum size/length; behaviour of `LTXVAddGuide` assertions with real latents (including FRAMES just above K); the strength 1.0 choice.

## Questions

1. **Does the V2V output re-render the last second of the input?** `LTXVAddGuide` with `frame_idx 0` and a multi-frame guide appends the K frames as keyframe tokens positioned at time 0 of the NEW clip (read in the image's `nodes_lt.py`: keyframes appended, `causal_fix` for index 0). The first ~1 s of the output is therefore conditioned to look like the input's last second, rather than starting after it. README says the clip "starts from where the input ends". If Ken wants the new clip to start after the source tail, the guide would need a different approach (and the user, if joining clips, gets about 1 s of duplicate). Decide wording or design; the real-GPU test will show it.
2. Should FRAMES for v2v be enforced somewhere (handler or UI) as >= 25 (README says 33)? Today 9 and 17 pass the handler and fail at run time.
3. Is guide strength 1.0 intended for v2v? Template flf2v uses 0.7; i2v stage 1 here uses 0.7 and stage 2 uses 1.0. Strength 1.0 with a 1-second guide may over-anchor the opening; untested.
4. Should the checker pin the loader literals and sampler/sigmas (so `type=wan` or a changed sigma list fails)? Cheap to add; today only the filenames and structure are pinned.
5. Should the window (`GUIDE_WINDOW_S`=4 s) matter for clips below 6 fps (fewer than 25 frames in the window)? Documented; accept or raise the window.
6. SPEC 4.3 says "derived from the official examples in the node pack" and 1280x720; the work derives from Comfy-Org templates and 1280x704 (both approved decisions). Update the SPEC wording?
7. Sync step: the 64-rounding handler change, the `file` field (already in the handler) and `Workflow version: 1` must ship together with the volume sync; who owns that release step?

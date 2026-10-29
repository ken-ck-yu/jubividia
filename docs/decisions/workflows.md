# workflows — design note

## Summary
Three flat, API-format ComfyUI workflows (`workflows/t2v.json`, `i2v.json`, `v2v.json`) plus `workflows/README.md` (node titles/IDs, models, how to validate). T2V and I2V are derived from the **Comfy-Org "LTX-2.5 T2V/I2V" templates** (`video_ltx2_5_t2v.json`, `video_ltx2_5_i2v.json`, in `Comfy-Org/workflow_templates`, the same graph the Comfy docs page points to) and use **only core ComfyUI nodes**; the ComfyUI-LTXVideo pack is not needed for them. They are the two-stage distilled graph (half-res generate, 2x latent upscale, short refine) with audio generated jointly in an audio-video latent. **V2V is the open problem**: every official 2.5 V2V example is an IC-LoRA workflow that needs LoRA weights and pack nodes that no feature has planned for, and it has an unproven interaction with the int8-convrot transformer. Ken must decide what "V2V" means (Question 1) before `models` is finished. Three title-contract mismatches with the worker handler were found (below).

## Verified facts (searched/fetched 2026-10-29; no GPU, no RunPod/Cloudflare calls)
- **Official examples.** `Lightricks/ComfyUI-LTXVideo/example_workflows/2.5/` contains `LTX-2.5_T2V_I2V_Single_Stage_Distilled.json`, `..._Two_Stage_Distilled.json`, `T2A`, `A2V`, several `ICLoRA_*`, `V2V_ICLoRA_Single_Stage_Distilled`, `V2V_TiledFusion_*`, HDR variants (HDR needs ComfyUI >= 0.38.0). The pack's README for these does not name node packs. Several pack examples still reference `ltx-2.5-22b-distilled-transformer-bf16` / `gemma4-12b-with-proj-ltx-2.5-bf16` (not int8). The **Comfy-Org template** versions reference exactly our int8-convrot files, so they are the better base.
- **Core vs node pack.** In `comfyanonymous/ComfyUI` tag **v0.34.0** I confirmed these as core: `comfy_extras/nodes_lt.py` (`EmptyLTXVLatentVideo`, `LTXVImgToVideoInplace`, `LTXVImgToVideo`, `LTXVConditioning`, `LTXVPreprocess`, `LTXVAddGuide`, `LTXVCropGuides`, `LTXVConcatAVLatent`, `LTXVSeparateAVLatent`, `LTXVDualCFGGuider`, `LTXVScheduler`), `nodes_lt_audio.py` (`LTXVEmptyLatentAudio`, `LTXVAudioVAEDecode`, `LTXVAudioVAEEncode`), `nodes_lt_upsampler.py` (`LTXVLatentUpsampler`), `nodes_hunyuan.py` (`LatentUpscaleModelLoader`, folder `latent_upscale_models`), `nodes_custom_sampler.py` (`ManualSigmas`, `RandomNoise`, `KSamplerSelect`, `SamplerCustomAdvanced`), `nodes_video.py` (`LoadVideo` [input `file`], `GetVideoComponents`, `CreateVideo`, `SaveVideo`), `nodes_primitive.py` (`PrimitiveInt/Float/String/StringMultiline/Boolean`, single input `value`), `nodes_math.py` (`ComfyMathExpression`), `nodes_post_processing.py` (`ResizeImageMaskNode`). The Comfy-Org templates tag all of their visible nodes `comfy-core`. Not confirmed in 0.34.0: `CLIPLoader` accepting type `ltxv` and the int8-convrot loader path (the template uses both; worker note already makes "ComfyUI too old" the first engineering check).
- **Pack-only nodes** (seen in the IC-LoRA example, not core as far as I can tell): `LTXICLoRALoaderModelOnly`, `LTXAddVideoICLoRAGuide`, `LTXVSetAudioRefTokens`, plus `TextGenerateLTX2Prompt` (prompt enhancer, needs the extra ~5 GB Gemma E2B encoder; we leave it out), `GemmaAPITextEncode` (API path; leave out).
- **How audio is produced.** Natively, jointly with video: `LTXVEmptyLatentAudio` (audio VAE, frames, fps) is joined to the video latent with `LTXVConcatAVLatent`, both are denoised together in one `SamplerCustomAdvanced`, split with `LTXVSeparateAVLatent`, audio goes through `LTXVAudioVAEDecode`, and `CreateVideo(images, fps, audio)` muxes it, then `SaveVideo`. No external audio file; the prompt describes the sound. In the two-stage graph the audio latent from stage 1 is re-joined with the upscaled video latent for stage 2.
- **Reference two-stage graph (T2V), from the Comfy-Org template:** loaders `UNETLoader` (int8-convrot transformer, `default`), `VAELoader` x2 (video, audio), `CLIPLoader` (Gemma 4 12B, type `ltxv`), `LatentUpscaleModelLoader`. `CLIPTextEncode` positive/negative -> `LTXVConditioning(frame_rate)` -> two `LTXVDualCFGGuider` (video_cfg 1, audio_cfg 1). Stage 1: `EmptyLTXVLatentVideo(width/2, height/2, length)` + audio latent -> concat -> `SamplerCustomAdvanced` (`euler_ancestral`, `ManualSigmas` `1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0`). Upscale: separate, `LTXVLatentUpsampler`, re-concat with stage-1 audio. Stage 2: `SamplerCustomAdvanced` with sigmas `0.85, 0.7250, 0.4219, 0.0`. Decode: separate, `VAEDecodeTiled(512,64,64,16)`, `LTXVAudioVAEDecode`, `CreateVideo`, `SaveVideo`. The template computes length as `duration*fps+1` and half-size as `a/2` with `ComfyMathExpression`.
- **I2V differs only by:** `LoadImage` -> `ResizeImageMaskNode` (longer side 1536, lanczos) -> `LTXVPreprocess` (crf 18) -> `LTXVImgToVideoInplace` on the stage-1 empty video latent (strength 0.7) and again on the upscaled latent (strength 1). In the template a boolean toggles bypass; we hard-wire it per mode.
- **Dynamic-combo inputs.** `ResizeImageMaskNode.resize_type`, `SaveVideo.format/codec` and `ComfyMathExpression.values` are dynamic inputs in 0.34.0; their API-format key shape (dotted sub-keys, `values.a`) cannot be settled from source reading and must be proven by /prompt validation (see test plan).

## Design
**Files.** `workflows/{t2v,i2v,v2v}.json` (flat API format, no subgraphs; author by hand from the templates and prove with the validation below, since there is no GPU or UI here), `workflows/README.md`, and a small offline validator script (`tools/validate_workflows.py`, engineer's call).

**Titled nodes** (the handler fills by `_meta.title`; titles unique per file):

| Title | class_type | field | wired to |
|---|---|---|---|
| PROMPT | `CLIPTextEncode` | `text` | `LTXVConditioning.positive` |
| NEGATIVE | `CLIPTextEncode` | `text` | `LTXVConditioning.negative` (default text kept when handler gets no negative) |
| WIDTH / HEIGHT | `PrimitiveInt` | `value` | final size; stage 1 uses `ComfyMathExpression "a/2"` |
| FRAMES | `PrimitiveInt` | `value` | `EmptyLTXVLatentVideo.length`, `LTXVEmptyLatentAudio.frames_number` (no duration math: handler already sends 8k+1) |
| FPS | `PrimitiveFloat` | `value` | `LTXVConditioning.frame_rate`, `LTXVEmptyLatentAudio.frame_rate`, `CreateVideo.fps` (Float sockets; INT would not link) |
| SEED | `PrimitiveInt` | `value` | both `RandomNoise.noise_seed` (so the seed fully determines output) |
| INPUT (i2v) | `LoadImage` | `image` | resize -> preprocess -> two `LTXVImgToVideoInplace` |
| INPUT (v2v) | `LoadVideo` | **`file`** (mismatch, see below) | depends on Question 1 |

Output: `SaveVideo` with explicit `format: mp4`, codec h264 (handler's `find_output_mp4` needs `.mp4`; do not leave `auto`).

**Model filenames** (only filenames, never paths): `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors`, `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors`, `ltx-2.5-video-vae-bf16.safetensors`, `ltx-2.5-audio-vae-bf16.safetensors`, `ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`. No enhancer encoder, no LoRAs for t2v/i2v.

**Defaults.** 1280x704 (720 is not a multiple of 32), 24 fps, 121 frames (~5.04 s). Stage 1 runs at 640x352.

**V2V options** (decision pending; see Question 1):
- A. Official IC-LoRA V2V (`LTX-2.5_V2V_ICLoRA_Single_Stage_Distilled` or Union Control): edits/controls from a source clip, original audio frozen. Needs IC-LoRA weights (the example uses a `ltx-2.3-...-deblur` LoRA; Union Control is documented for 2.3, not 2.5), pack nodes, and for Union Control extra annotator models. I found no evidence that an IC-LoRA applies cleanly to the int8-convrot transformer.
- B. Core-only video-conditioned generation: decode input with `LoadVideo` + `GetVideoComponents`, resize, feed the first K frames to `LTXVAddGuide` (frame_idx 0) on the stage-1 latent (plus `LTXVCropGuides` before decode): "continue/extend this clip" following the prompt, new audio. Built from the same core nodes as the official graphs; not itself an official example.
- C. Core-only restyle (SDEdit): encode the video with the video VAE and start sampling from a truncated sigma schedule so the source structure survives. Quality unknown.
- D. Ship t2v/i2v now, v2v later (conflicts with SPEC acceptance criterion 4).

## Decisions
### One-way doors
1. **What V2V means / which V2V mechanism (A-D).** It decides which extra weights the `models` feature must download (IC-LoRA files and annotators, tens of GB at worst), whether the worker needs the pack's nodes, and what the UI promises. Recommendation: **B for v1**, because it needs no extra weights, no pack nodes and no LoRA/int8 compatibility gamble; revisit A once a real-GPU test shows an IC-LoRA works on the int8 build. Reversibility: workflow JSON is cheap, but weights on the volume and UI wording are not. If unsure it is one-way, so Ken decides.
2. **Titled-node contract changes in the worker handler** (frozen public contract): (a) v2v INPUT field is `file` not `video` (core `LoadVideo` has no `video` input; the only node with `video` is VideoHelperSuite, not in the image); (b) width/height must round to multiples of **64**, not 32, for the two-stage graph, because stage 1 runs at half size and must itself be a multiple of 32 (1280x704 is fine, 1280x720 or 1056 would silently produce a different size); (c) keep `PROMPT`/`NEGATIVE` as `CLIPTextEncode` nodes (field `text`). Options: change the handler (recommended, two small edits and tests) or bend the workflow (a `ComfyMathExpression` floor-to-64 in the graph, which makes the returned width/height lie). Reversibility: the title/field table is read by handler, README and UI defaults, so fix it before `ui`.
3. **Two-stage (with upscaler) as the default graph vs single-stage.** Two-stage matches the Comfy template, gives better detail at 1280x704 and needs the upscaler file (small); single-stage is faster, lower detail. Recommend two-stage. Mostly a JSON choice, but the upscaler file becomes a required (not optional) model for the `models` feature, so treat as one-way for the model list.
4. **Model set** follows the worker decisions (int8-convrot transformer and Gemma 4 encoder, bf16 video/audio VAEs, x2 upscaler). Confirms the "optional" upscaler is actually required under 3.

### Two-way doors
- Hand-written flat API JSON derived from the Comfy-Org templates (not the pack's pack-dependent examples): they use our exact filenames and only core nodes.
- No prompt enhancer, no Gemma E2B encoder: saves ~5 GB and a model load.
- `euler_ancestral`, template sigma lists and VAEDecodeTiled(512,64,64,16) copied verbatim; tune later.
- Both `RandomNoise` nodes driven by SEED (template fixes stage 2 at 42).
- `FPS` as `PrimitiveFloat`, `FRAMES` as `PrimitiveInt` with no in-graph duration math.
- Explicit mp4/h264 in `SaveVideo`; filename prefix `video/LTX_2.5_<mode>`.
- Workflows live in `workflows/` in the repo; the sync to `/runpod-volume/workflows` belongs to the `models` upload script.
- Video VAE stays bf16 DiffVAE (matches the official example; the lighter conv VAE is a filename swap).
- Single-stage fallback JSONs are not shipped now.

## Questions for Ken
1. **What should "V2V" do?** (A) Official IC-LoRA edit/control: official example, but needs IC-LoRA weights and pack nodes, and I could not confirm it works on the int8 transformer; (B) extend/continue your clip using core nodes only: no extra weights, new audio, not an official example; (C) restyle the clip with core nodes (SDEdit): no extra weights, quality unknown; (D) postpone V2V. Recommendation: B for v1.
2. **Two-stage (half-res, 2x upscale, refine) or single-stage as the default?** Two-stage: better detail, matches Comfy's template, requires the upscaler file. Single-stage: faster/simpler, softer. Recommendation: two-stage.
3. **OK to change the worker contract in two places?** (a) v2v INPUT field becomes `file`; (b) round width/height down to a multiple of **64** (default 1280x704). Recommendation: yes, with updated handler tests. Please also confirm 1280x704 as the default instead of 1280x720.
4. **Negative prompt:** the distilled graph runs CFG 1 (video_cfg 1, audio_cfg 1), where the negative has essentially no effect. Keep the Advanced "negative" field anyway (harmless, may matter if CFG is raised later) or hide it in the UI? Recommendation: keep the node, hide the field.

## Concerns / risks
- **Node-name collisions:** the worker image also installs ComfyUI-LTXVideo; if its node classes share names with core ones (`LTXVConditioning`, `LTXVAddGuide`, ...) they may override core with different signatures. Validate against `/object_info` of the **built image**, not bare ComfyUI. If t2v/i2v/v2v-B need no pack node, consider dropping the pack from the image (worker decision to revisit with Ken).
- Dynamic-combo input shapes (`ResizeImageMaskNode`, `SaveVideo`, `ComfyMathExpression`) are the likeliest places for a hand-written API JSON to be rejected; test plan covers it.
- int8-convrot on the RTX 6000 Ada, VRAM headroom for two-stage at 1280x704 + audio, and warm-run speed are unmeasured; only the real-GPU test in `endpoint` settles them.
- ComfyUI 0.34.0 might lack `CLIPLoader` type `ltxv` or the int8 loader; templates assume a recent build (HDR examples want >= 0.38.0, not needed by us).
- Templates are Comfy-Org content; keep the attribution/source link in `workflows/README.md`.
- V2V option B: guide frames of a long source clip cost memory; the workflow should cap K (for example 25-49 frames) and the handler's input size cap still applies.

## How the validator should test this (no GPU)
1. **Static lint** (`tools/validate_workflows.py`): each file is valid JSON in API format (`{id: {class_type, inputs, _meta}}`); each title in the contract table exists exactly once with the right class and field (INPUT absent in t2v; present with `image`/`file` in i2v/v2v; PROMPT, WIDTH, HEIGHT, FRAMES, FPS, SEED all present); every link `[node_id, slot]` points to an existing node and slot; no model path separators in filenames; filenames equal the five names above.
2. **Schema check against /object_info:** start ComfyUI in the **built worker image** on CPU (`--cpu`) with `extra_model_paths.yaml` pointing at a fake volume containing zero-byte files with the exact model filenames, then fetch `/object_info` and check every `class_type` exists, all required inputs are set, link output types match input types, and combo values are in the listed options.
3. **Server-side validation:** POST each workflow to `/prompt` with the handler's fill applied (use the handler's `fill_workflow` with sample params, including the v2v `file` field). Pass = HTTP 200 and empty `node_errors` (execution then fails on the empty model files; interrupt it). This catches the dynamic-combo key shapes and missing nodes. Also run it with 1280x704 and a max-size case, and assert that 1280x720/1056-wide inputs are rounded to /64 by the handler tests.
4. **Handler round-trip test:** mocked ComfyUI plus these real JSON files through `validate_input` -> `fill_workflow`; assert every filled node exists and no `workflow_mismatch`.
5. **Not provable offline (record as pending in validation notes):** int8-convrot kernels, output quality, VRAM, audio present in the mp4, real timings. These belong to the real-generation gate on the RTX 6000 Ada.

## Reviewer
Independent review, 2026-10-29. No GPU, no RunPod/Cloudflare calls. Sources checked: ComfyUI v0.34.0 `comfy_extras/nodes_lt.py` and `nodes.py` (raw GitHub), [Comfy docs LTX-2.5 page](https://docs.comfy.org/tutorials/video/ltx/ltx-2-5.md), a web search on LTX-2.5 extension workflows, `worker/handler.py` and `docs/decisions/worker.md` (feat-worker), `scripts/models.lock`. Ken's decisions (V2V = B, two-stage, /64 rounding, field `file`, keep negative node and hide field) are treated as made; findings against them are flagged as concerns.

### Verified by me
- `LTXVAddGuide` (core, v0.34.0) takes multi-frame guides at `frame_idx` 0 (a "causal" case encoded directly); guide length is cropped to 8n+1; nonzero indices for guides over one frame snap to 8k+1; strength default 1.0; the guide must fit inside the latent length. `LTXVCropGuides` strips the trailing guide frames from the latent and clears the guide keyframe conditioning. So core nodes can condition on a video clip. They carry **no audio**: guides are video-only.
- `CLIPLoader` in v0.34.0 lists type `ltxv`. `UNETLoader` there lists only `default/fp8_*` weight dtypes; the int8-convrot transformer must therefore load through `default` and rely on ComfyUI's native quantization detection (the worker review already said so; the Comfy docs page names no special loader). Unproven until a real load.
- I found no official or core-only "extend with audio continuity" example. The only extension workflows found are third-party (a Hugging Face community INT8 workflow with a Prompt Relay node). Option B is therefore Ken's own composition of official parts, as the architect said.

### Door 1 - What V2V means: B (extend/continue, core nodes only). AGREE WITH CHANGES
Steelman of the alternatives. **C (SDEdit restyle)** answers what a phone user most plausibly means by "video to video" (change the look of my clip, keep the motion) and needs no guide-frame memory, but is quality-unknown and fights the distilled 8-step schedule. **A (IC-LoRA)** is the only official V2V. **Core FLF2V** (the official `video_ltx2_5_flf2v` template: first and last frame guides) is the closest official, proven core-only pattern; B generalises it from one frame to K frames. B is still the right call for v1 under the SPEC priorities: no extra weights (cheapest), no pack nodes, reproducible.

Changes the architect missed:
1. **Guide the LAST K frames, not the first.** The design says "feed the first K frames ... frame_idx 0". For "continue this clip" the conditioning must be the tail of the source. Using the head produces a re-roll of the beginning. The workflow needs a step that selects the final 8n+1 frames (`GetVideoComponents` then an image-slice/batch node; the exact core node for slicing a frame range must be proven against `/object_info`).
2. **The output is a new clip that begins at the source's tail; it does not contain the source.** Guides are cropped off. The UI wording must say "continuation" (and what the user downloads is the new segment only). Optionally prepend the source in-graph (`ImageBatch` + `CreateVideo`), but then the audio is a seam (source audio vs freshly generated). Recommend: new segment only for v1 and say so in the UI.
3. **Two-stage interaction.** The guide is applied to the stage-1 latent at 640x352. `LTXVCropGuides` must run before `LTXVLatentUpsampler` (the upsampler takes a plain latent), and the guide must be re-added at full resolution for stage 2 (the I2V template does exactly this with `LTXVImgToVideoInplace` twice). The note describes crop only before decode; that would leave guide frames in the upscaler input. Source frames must be resized to stage-1 size for stage 1 and full size for stage 2 (two resize nodes).
4. **Audio on extend is new, unconditioned audio.** Voice, music and ambience will not continue from the source. Acceptable given Ken's choice, but this is a product-visible limitation to state in the README and UI, and it should be checked in the real-GPU test (audio present, not silent).
5. K must be 8n+1 (25 or 49 recommended; snaps otherwise) and K plus new frames fits inside FRAMES; define whether FRAMES is the total latent length including the guide region or the new frames. With guides appended and cropped, FRAMES is the output length. Make `README` state it.
6. Memory: K guide frames at full resolution add VAE-encode cost and extra tokens in attention. At K=25 or 49 and 1280x704 it is small versus the 121-frame latent; keep the cap.
Reversibility: workflow JSON is two-way; no weights depend on it. The one-way part is only UI wording, so decide the "new segment only" wording now. Verdict: B yes, with changes 1-4 recorded as requirements.

### Door 2 - Title-contract changes (field `file`, /64 rounding). AGREE WITH CHANGES
Steelman of the alternative (bend the workflow, keep /32 in the handler): keeps the frozen handler untouched and the contract stable, and a floor-to-64 `ComfyMathExpression` is easy. Rejected: the returned `width`/`height` and the sidecar would then lie, and dynamic-combo math nodes are the riskiest part of a hand-written JSON. Changing the handler is right.
Findings:
- (a) **Already done.** `worker/handler.py` `INPUT_FIELDS` is `{"i2v": ("image","file"), "v2v": ("file","video")}`, so the handler already fills `LoadVideo.file`. No handler change is needed for (a); only the README/design wording ("mismatch") is stale. Do not spend an edit on it.
- (b) Only the rounding is a real change: `width // 32 * 32` becomes `// 64 * 64` (720 gives 704, 1056 gives 1024, 1100 gives 1088), plus the module docstring ("multiple of 32"), the clamp interplay (min 256 is fine), and tests. Note the minimum dimension after rounding is 256, which gives stage 1 of 128; confirm the upsampler accepts that or raise the min to 512.
- **Missing from the title table: `OUTPUT`.** The handler resolves the result by a node titled `OUTPUT`, else exactly one mp4. The design's table omits it. Title the `SaveVideo` node `OUTPUT` in all three files and put it in the lint. This is part of the same frozen contract and should be fixed at the same time.
- 24 fps in a 121-frame default is the contract; `FRAMES` should be a `PrimitiveInt` and the handler's 8k+1 rounding already fits.
Reversibility: the title table is read by handler, README, validator and UI; fix it once, now. Verdict: AGREE (with the OUTPUT addition and the doc correction for (a)).

### Door 3 - Two-stage as the default graph. AGREE WITH CHANGES
Steelman for single-stage: fewer nodes (no upsampler, no second sampler, no second guide application), easier to validate by hand, no latent-upscale artifacts, and the distilled model is designed for it; the docs page itself calls spatial upscaling "optional".
Against the architect's claim: two-stage is not necessarily slower. Stage 1 runs 8 steps at one quarter of the pixels, stage 2 runs 3 steps at full size, versus 8 full-size steps single-stage. I expect two-stage to be equal or cheaper in GPU seconds; the note's "single-stage is faster" is unmeasured and may be wrong. That favours two-stage under priority 2 (cheapest). The cost of the extra stage: one extra ~1.0 GB file (loaded once per cold start, about 2.5 percent of the ~40 GB volume read; negligible), and no second transformer load (both stages reuse the same model). Model-load cost is therefore not the risk.
Risks the architect did not state:
- **VRAM on 48 GB:** transformer 21.5 GB + encoder 15.4 GB = 37 GB if both stay resident, leaving about 10 GB for activations, the 1280x704x121 latent (about 40x22 latent tokens x 16 frames, small) and the tiled VAE decode. ComfyUI will offload the encoder after text encoding, so peak is probably fine, but then each job after a model eviction pays a reload; this is the same risk as worker Door 6 and only the real-GPU test settles it. Record peak VRAM and warm gen time for both graphs.
- Dynamic-combo input shapes remain the main cause of a rejected hand-written JSON, regardless of door.
- The wider the pack/core node mixture, the more the node-name collision concern matters (see below).
Verdict: AGREE two-stage as default, but make the single-stage JSON a documented fallback to be built if the measured two-stage peak VRAM or time loses, and measure both in the real-generation gate.

### Door 4 - Model set. AGREE WITH CHANGES
Alternatives steelmanned: the lighter conv video VAE (`ltx-2.5-video-vae-conv-bf16`, 1.45 GB, in the lock, same size so no saving; only a quality/speed question) and the dev transformer (more steps, more GPU seconds). Neither helps priorities 1-2. The five filenames in the note match `scripts/models.lock` exactly.
Changes:
- `models.lock` currently marks **nine** entries; four are not in the note: temporal upscaler x2 (262 MB, `default`), duration head (`model_patches/`, `default`), conv VAE (`default`), and the 8.9 GB distilled LoRA (`optional`). The `default` set therefore downloads files that no workflow uses. Either the workflows doc says explicitly "five used, others reserved" or the lock demotes unused ones to `optional`, to keep the download and the volume lean and the reproducibility claim honest. Ask `models` to decide.
- SPEC §4.2 still calls the upscaler "optional"; under Door 3 it is required. Fix the SPEC wording.
- **ComfyUI version in the pinned image.** The architect's source check is against v0.34.0, which is the version stated for the `5.11.0` base. Ken later accepted `5.10.0-base`, whose bundled ComfyUI version is not stated in either note. If it is older than the version that introduced these nodes/int8 (the worker review found native LTX-2.5 from 0.32.0), the whole graph fails at `/prompt`. Check `/object_info` in the built image; this is the first engineering check already, but the workflow validation must run against 5.10.0, not 0.34.0.
Verdict: AGREE WITH CHANGES.

### Two-way doors that are really one-way, or missed
- **Dropping ComfyUI-LTXVideo from the image** (suggested in Concerns): technically a rebuild, but the worker feature, SPEC §4.1 and Ken's decisions list the pack. Do not drop it in this feature; validate collisions in the built image first, then bring it to Ken.
- **Workflow files live on the volume** (`/runpod-volume/workflows`) while the handler lives in the image: a handler contract change (title, rounding) and a workflow change must ship together, but they deploy by different routes. Treat "workflow sync to the volume" as part of the release step for any contract change, and record a `workflow version` in the README so a mismatch is diagnosable.
- **Filename prefix `video/LTX_2.5_<mode>`**: the handler finds files by history output, so it is two-way; fine.
- **Seed on both noise nodes**: two-way, fine.
- Handler allows up to 2048x2048 and 481 frames; the default-based test plan covers 1280x704 only. Add one max-size case on the real GPU to see the OOM message path, or lower the cap. Not a workflows blocker.

### Questions for Ken
1. V2V output: the new segment only (recommended; cleanest, audio is all new), or source followed by the new segment with an audio seam? One line in the UI either way.
2. Should `models.lock` keep downloading the four unused files (temporal upscaler, duration head, conv VAE; LoRA is already optional), or be trimmed to the five the workflows use? Trimming is cheaper and more honest; keeping them leaves room for later experiments.
3. The pinned base is 5.10.0 and the notes only prove ComfyUI 0.34.0 for 5.11.0. Are you happy for the engineer to bump ComfyUI inside the Dockerfile if 5.10.0 lacks the nodes, accepting a non-stock base?

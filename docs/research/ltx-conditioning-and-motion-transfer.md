# LTX-2.5 conditioning options and motion transfer (research)

Research date: 2026-10-29. Desk research only: public documentation, Hugging Face model cards and GitHub pages. No GPU, RunPod or Cloudflare call was made, no model was run, no weights were downloaded. Confidence labels: **high** = read on a primary page (official docs, model card, source code); **medium** = primary page that is indirect, a dev-docs page, or two consistent secondary sources; **low** = secondary or marketing source, or my inference. "Unverified" means exactly that: do not rely on it.

## Short answer for Ken

**(A) Several images, first plus last frame, image plus video.** The model itself can do all of these; it is mostly an app limitation, not a model limit. ComfyUI's built-in `LTXVAddGuide` node can pin an image (or a short clip) at any frame position (negative positions count from the end) and several can be chained, so "first and last frame" and "three or four keyframes" need **no extra weights and no new node packs** in principle. The Comfy-Org docs list an official first-and-last-frame template (FLF2V) that uses the same model files we already have. Our v2v mode is already "image plus video" in a narrow sense (the last 25 frames of a clip as a guide). Nothing here has been run on our int8 build, so treat it as likely but unproven until one real-GPU test.

**(B) Cat performs a dance.** There is no cheap, reliable way to do this with LTX-2.5 today. LTX's "control" add-ons (IC-LoRAs) can follow depth, edges or a human skeleton from a driving video, but (1) the Union Control add-on that covers pose is published for LTX-2.3, not 2.5, although LTX's own docs show it running in a 2.5 workflow; (2) it has never been shown (in anything I could find) to work on our int8 build; (3) skeleton control is built for people, so a human dancer's skeleton does not map onto a cat's body; depth/edge control would copy the dancer's silhouette, not turn a cat into a dancer. The purpose-built open model is **Wan 2.2 Animate** (reference image plus driving video, Apache 2.0, about 18 GB in fp8, fits 48 GB on paper), but it is described and trained for human motion and I found no evidence for cats. Hosted services (Kling Motion Control, Runway Act-Two) do exactly this for people; Kling's own page says real human actions are recommended and only "certain stylized humanoid" subjects are recognized, so a photorealistic cat is likely a poor fit too. Honest expectation: a cat will not do a convincing human dance with any current tool I could verify; a cartoon or humanoid-shaped "cat character" has a better chance.

**Recommendation:** ship first-plus-last-frame (and optional middle keyframes) with core nodes only; test it on the real GPU; do not build motion transfer yet. See section 6.

## Capability table

| Feature | Extra weights? | New nodes in the image? | Works on our int8 build? | Effort (estimate) | Confidence |
|---|---|---|---|---|---|
| Image as first frame (i2v, today) | No | No (core `LTXVImgToVideoInplace`) | Yes, measured: the app already runs it per README | done | high |
| First + last frame (FLF2V) | No (Comfy docs: same set as T2V, upscaler omitted) | No: core `LTXVAddGuide` x2 | Template references our exact int8 files; not run by us | 1.5-3 eng-days | medium |
| Multiple keyframes at chosen frame positions | No | No: chain `LTXVAddGuide` | Same as above; not run; middle-frame behaviour inferred from source | 3-5 eng-days incl. UI slots | medium (source read) / low (quality) |
| Image + video (clip as guide) | No | No: core nodes (what our v2v does) | Unproven on GPU (README says overlap behaviour is "not verified") | done (v2v) | medium |
| Video extension with continuous audio | No | Not available | n/a: guides are video-only; audio is regenerated | n/a | medium |
| Audio-driven / audio conditioning (A2V, T2A) | Not checked | Pack examples exist (A2V, T2A) | Unverified | not estimated | low |
| IC-LoRA: Union Control (depth + canny + pose) | Yes: 654 MB LoRA (LTX-2.3 build) + annotator models | Yes: ComfyUI-LTXVideo (we already install it), plus controlnet_aux and Video Depth Anything packs | Unverified. No report found either way | 4-7 eng-days + a risk spike | medium (that it exists), low (that it works on int8) |
| IC-LoRA: Motion Track (spline paths) | Yes (2.3 LoRA) | Yes: pack + tracker | Unverified | not estimated | medium |
| IC-LoRA: Ingredients (reference sheet) | Yes (2.5 LoRA, size not stated) | Yes: pack | Unverified; needs 768x448, 121 frames, 24 fps | not estimated | medium |
| Other 2.5 IC-LoRAs (Restore, Deblur, Layout-To-Render, Day-To-Night, Water-Simulation, Colorization, Clean-Plate, Alpha-Gen, Pixel-Spatial-Upscaler, Decompression) | Yes, each | Yes: pack | Unverified | not estimated | medium |
| Wan 2.2 Animate (motion transfer, separate model) | Yes: about 18 GB fp8 + encoders | Yes: new packs (KJNodes, controlnet_aux, probably a Wan wrapper) | n/a (different model); needs its own test | 8-15 eng-days + image rebuild | medium (feasibility), low (cat quality) |

## 1. LTX-2.x conditioning capabilities

**Core versus pack.** From the ComfyUI source (`comfy_extras/nodes_lt.py`, master): `LTXVAddGuide`, `LTXVCropGuides`, `LTXVImgToVideo`, `LTXVImgToVideoInplace`, `LTXVAddLatentGuide`, `LTXVPreprocess`, `LTXVConditioning`, `LTXVConcatAVLatent`, `LTXVSeparateAVLatent`, `GetICLoRAParameters`, `LTXVReferenceAudio`, `LTXVSpatioTemporalGuidance`, `LTXVModalityGuidance`, `LTXVDualCFGGuider`, `LTXVDurationPredictor` are core. Source: https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/comfy_extras/nodes_lt.py (high). Our own earlier notes confirmed the first group is in tag v0.34.0 (`docs/decisions/workflows.md`); the later ones (`GetICLoRAParameters`, `LTXVReferenceAudio`) were seen on master only, so whether our pinned ComfyUI has them is unverified. Pack-only (ComfyUI-LTXVideo): `LTXICLoRALoaderModelOnly`, `LTXAddVideoICLoRAGuide`, the Tiled Fusion sampler, HDR nodes, audio-only nodes. Source: https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control and https://github.com/Lightricks/ComfyUI-LTXVideo (high).

**Multi-keyframe at arbitrary positions: yes in core.** `LTXVAddGuide` has `frame_idx` (-9999..9999, "negative values are counted from the end"), `strength` (default 1.0; lower relaxes the pin), accepts an image or a video (cropped to 8n+1 frames), and multiple guides chain: each appends its frames to the end of the latent and `LTXVCropGuides` removes them all. For guides longer than one frame, a non-zero index snaps down to the form 8k+1. Single-frame guides are not snapped. Source: the code above (high for what the code does; **quality of mid-clip keyframes is unverified**). A web search found no official LTX-2.5 middle-frame guide, only an LTX-Video 0.9.5 note about chaining and a third-party "LTX Keyframer" node (low). Core also has `LTXVGeneratedKeyframesToGuides` for re-pinning keyframes after a temporal upscale (https://docs.comfy.org/built-in-nodes/LTXVGeneratedKeyframesToGuides.md, high); we do not use the temporal upscaler.

**First + last frame.** The Comfy docs list an FLF2V template ("generates a video between a first and last frame image"), using the T2V model set without the spatial upscaler; they advise matching aspect ratios. Source: https://docs.comfy.org/tutorials/video/ltx/ltx-2-5.md (high that the template exists; the page gives no node list). A Japanese guide describes it as two `LTXVAddGuide` nodes with the end image at `frame_idx -1` and `LTXVCropGuides` after (https://www.ipentec.com/document/ai-image/ltx-25-install-comfyui, low-medium, third-party). Our reviewer also noted the template uses guide strength 0.7 (`docs/decisions/workflows.md`, from earlier work). Whether the workflow is in `Comfy-Org/workflow_templates`: I could not list the repo (GitHub truncated the directory), so the exact template file name here is unverified.

**Image + video, video extension.** Core can condition on a clip (that is our v2v). I found no official core-only "extend with audio continuity" example; the only extend workflows I found are third-party. Guides are video-only, so audio is regenerated. Source: our review in `docs/decisions/workflows.md` (medium).

**Audio conditioning.** The ComfyUI-LTXVideo repo lists text-to-audio and the pack ships A2V and T2A example workflows under `example_workflows/2.5/` per our earlier note; I did not open them, so how audio conditioning works and what it needs is unverified. `LTXVReferenceAudio` exists in core master (name only; function unverified).

**Official example workflows.** Lightricks: `ComfyUI-LTXVideo/example_workflows/` (the README lists 2.5 Tiled Fusion and HDR graphs by name; our earlier notes record T2V/I2V, ICLoRA and V2V examples under `2.5/`). The README lists 2.3 IC-LoRA workflows (Union Control, Motion Track, HDR, Dub-It, Pixel Spatial Upscaler). Comfy-Org: T2V, I2V, FLF2V and "DFR" (distilled transformer plus a detailing IC-LoRA) templates. Sources: https://github.com/Lightricks/ComfyUI-LTXVideo, https://docs.comfy.org/tutorials/video/ltx/ltx-2-5.md (high).

**VRAM and runtime.** No official figures anywhere. The pack README says 32 GB+ VRAM and 100 GB+ disk for the 2.3 pipelines, with low-VRAM loaders (high, but for bf16 builds). Our measured numbers: 43.5 GiB peak, 68 s warm for a 5 s 1280x704 clip. Extra guides add VAE-encode time and extra latent tokens; I expect a few seconds each but this is **unmeasured**. An IC-LoRA adds a second (half-resolution) reference latent, so more tokens and more attention cost (inference; no measurement found). The headroom is thin: 43.5 of 48 GiB (README measured table).

## 2. IC-LoRA for LTX-2.5

**What exists for 2.5 (Hugging Face, Lightricks org listing, pages 1 of 3 seen; other pages unseen).** Repos named `LTX-2.5-22b-IC-LoRA-*`: Water-Simulation, Restore, Pixel-Spatial-Upscaler, Layout-To-Render, Ingredients, Decompression, Deblur, Day-To-Night, Colorization, Clean-Plate, Alpha-Gen; plus `LTX-2.5-22b-LoRA-Slow-Motion-Control` and `-Cinemagraph` (ordinary LoRAs). **No 2.5 Union Control, no 2.5 pose, no 2.5 Motion-Track on the pages I saw.** Source: https://huggingface.co/Lightricks/models (high for what was listed; pages 2-3 unseen, so a 2.5 pose/union repo cannot be fully excluded).

**What exists for 2.3.** `LTX-2.3-22b-IC-LoRA-Union-Control` (canny, depth, pose in one LoRA; file `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors`, 654 MB; license LTX-2 community license; reference video at half the output resolution; load with `LTXICLoRALoaderModelOnly`, add with `LTXAddVideoICLoRAGuide`). Source: https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control and its file tab (high). Also Motion-Track-Control (sparse point trajectories drawn as colored splines; tracks from a tracker such as SpatialTrackerV2 or by hand; https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Motion-Track-Control, high), Ingredients, HDR, DubIt, Relight, Instant-Shave, In-Outpainting, Pixel-Spatial-Upscaler, others. A pose control for the older LTX-2 19B exists (`ltx-2-19b-ic-lora-pose-control.safetensors`, listed in the pack README, high that it is listed; its compatibility with 22B models is unverified and unlikely).

**Union Control on 2.5.** LTX's dev docs describe a Union Control workflow that "runs on LTX-2.5 (distilled 22B transformer, Gemma 4 text encoder, 2.5 VAEs and upscaler)" with the **2.3 Union LoRA reused**. Source: https://docs-dev.ltx.io/open-source-model/feature-guides/structural-control/union-control (medium: a dev-docs site, fetched through a summarizer; the production docs host returned 403). This suggests a 2.3 LoRA applied to the 2.5 distilled model is intended to work, but quality and the int8 case are unverified.

**Base checkpoint per LoRA.** Layout-To-Render: trained on 2.5 dev, inference on 2.5 distilled, rank 128 BF16, recommended CFG 1, `euler_ancestral`, 960x544 then 1920x1088 (https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Layout-To-Render, high). Ingredients: listed as 2.5 dev, usage snippet runs on a distilled base; trained only at 768x448, 121 frames, 24 fps (https://huggingface.co/Lightricks/LTX-2.5-22b-IC-LoRA-Ingredients, high). Union Control: "based on the LTX-2 foundation model", base-variant detail not stated (high that it is not stated). Pattern: trained on dev, run on distilled. Whether any of them were tested on the **bf16 transformer versus our int8-convrot build** is not stated anywhere I found.

**int8/fp8/quantized reports.** I found **no report either way** of an IC-LoRA on an int8/fp8 LTX transformer. Related facts: a community 2.5 quant release says stock ComfyUI LoRA loading is not claimed for its quantized LoRA files (https://huggingface.co/DmitryDB/LTX-2.5-ComfyUI-Quants, low-medium, search snippet); ComfyUI-LTXVideo issue #584 "LTXV Q8 Patcher doesn't work with the public q8_kernels" and #553 "LTX IC Lora Loader (Model Only) will not load into ComfyUi" (https://github.com/Lightricks/ComfyUI-LTXVideo/issues, high that they exist; I did not read their contents, only page 1 of 102 open issues). Generally, ComfyUI applies LoRAs as weight patches, and whether that works with the int8-convrot format is the open question: **unverified; needs a GPU spike**.

**Preprocessor requirements (Union Control workflow).** Depth: Video Depth Anything (`VideoDepthAnythingProcess`), pack ComfyUI-VideoDepthAnything. Canny: `CannyEdgePreprocessor`. Pose: `DWPreprocessor`. Packs: ComfyUI-LTXVideo, ComfyUI-VideoDepthAnything, comfyui_controlnet_aux; annotator models download on first run (so extra downloads, sizes not stated). Source: the docs-dev page above (medium).

**Quality notes (same page).** Output resolution, length and fps follow the reference video; CFG 1.0-1.5; depth is weaker on flat scenes, canny on fur and foliage, and "pose is weaker without people, with heavy occlusion, or in close-ups". Do not mix several control types. Fur being a weak case for canny matters for a cat. (medium)

**License.** LTX-2.x Community License on these LoRAs; free below US$10M annual revenue (group-aggregated), otherwise paid license. The 2026-08 text for 2.5 was not read from a primary source (https://book.st-hakky.com/en/data-science/ltx-2-5-commercial-license-guide, low-medium; https://ltx.io/model/license). Gated: HF access request required.

## 3. The cat-dances-the-dance use case

**Does a human skeleton transfer to a cat?** Honest assessment: unlikely to give what Ken wants. Reasons, in order of evidence:
- LTX's pose control detects "human body keypoints" and its docs call it weaker without people (medium, source above). DWPose is a human pose estimator (my knowledge; not verified on a page here). A cat photo has no human skeleton to condition on; the control video would contain a dancer, so the model would be driven to produce a dancer-shaped figure, not a cat (inference, low-medium).
- A cat has four legs, a tail and a different spine. Even a perfect pose transfer would have to invent how a quadruped "does" arm and hip moves. No tool I found claims to do that (inference).
- No test results for cats on any model were found by two searches (Wan Animate, VACE/Fun Control). Absence of evidence, not evidence of failure.

**Approaches for non-human subjects.**
1. *Depth or edge control (Union Control).* Copies silhouette and layout of the driving video. For a cat you would get the dancer's outline re-skinned; the identity from a still cat photo is not preserved by Union Control (it has no reference-image input in the docs I read). Quality unknown (low).
2. *Reference-image conditioning.* LTX-2.5 "Ingredients" IC-LoRA keeps characters consistent from a composite reference sheet, but it does not take a driving video, is trained for 768x448 only, and a reference video needs at least 121 frames (model card, high). It is a consistency tool, not a motion-transfer tool.
3. *Video-to-video restyle (SDEdit style) with a text prompt "a cat dancing".* Possible with core nodes in principle (our earlier option C); identity of a particular cat would not be preserved; quality unknown.
4. *Animal pose estimators.* comfyui_controlnet_aux may include an animal pose preprocessor (from my memory; unverified here), but a human-dance-to-cat skeleton mapping would still need retargeting that no pipeline I found provides.

**Open models built for reference image + driving video.**
- **Wan 2.2 Animate 14B** (Alibaba). Two modes: Move (animate the reference character with the video's motion) and Mix (replace the person in the video). License **Apache 2.0** (https://huggingface.co/Wan-AI/Wan2.2-Animate-14B, high). The card says it mimics human motion and does not state a human-only restriction, but also gives no animal claim (high that it is silent). Weights: the ComfyUI docs list `Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors` (Kijai fp8) or the bf16 original, plus a 4-step LoRA (`lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16`), `clip_vision_h`, `wan_2.1_vae`, and `umt5_xxl_fp8_e4m3fn_scaled`; custom nodes: ComfyUI-KJNodes and comfyui_controlnet_aux (DWPose). Dimensions must be multiples of 16; each "Video Extend" group adds about 77 frames (https://docs.comfy.org/tutorials/video/wan/wan2-2-animate.md, high). Sizes: fp8 files 17.3-18.4 GB (https://huggingface.co/Kijai/WanVideo_comfy_fp8_scaled/tree/main/Wan22Animate, high); the other files' sizes were not read (about 6-7 GB for the fp8 text encoder, 1-2 GB for clip vision, under 1 GB for VAE and LoRA are my recollection, **unverified**). Order of magnitude: about 27-30 GB of new files, which fits the 80 GB volume (about 41 GB used, so about 39 GB free) but not with a second large model. VRAM: guides say "24 GB practical baseline" (secondary, low-medium); the model card gives no number. The fp8 model should fit a 48 GB card; speed on our card is unmeasured. Human-centric: one secondary source says it is built on human-centric data (low); the Atlas Cloud guidance on aligning reference and video poses is written for humans (low).
- **Wan 2.1 VACE (1.3B/14B).** All-in-one model: reference-to-video, video editing, masked editing; conditions such as depth or pose come from preprocessing. Apache 2.0. 14B supports 480P and 720P. The card gives no VRAM and does not confirm ComfyUI support (https://huggingface.co/Wan-AI/Wan2.1-VACE-14B, high that the card says this). A RunComfy page shows a Wan 2.2 VACE ComfyUI pose-driven workflow with Depth Anything V2 (low-medium). Wan 2.2 Fun Control exists with a `Wan22FunControlToVideo` node (https://sbcode.net/genai/wan2.2-fun-control/, low-medium). These are control-video models: same human-pose problem for a cat; depth control is the fallback.
- Other models (for example UniAnimate, MimicMotion, AnimateAnyone family) exist but I did not verify any; **not assessed**.

**Fit on 48 GB serverless.** Wan Animate fp8: plausible, unmeasured. It would be a **different ComfyUI graph with different models**, so switching between LTX and Wan on one worker means swapping 20-40 GB of weights per job, which hurts the already 4-5 minute cold start. A separate endpoint for Wan avoids that but doubles the infrastructure.

## 4. Integration effort and cost for our stack

All effort numbers are **my estimates**, in engineer-days, for someone who knows this repo, excluding real-GPU waiting time.

### Option 1: first + last frame (and N keyframes) with core nodes only
- *Workflow:* new `workflows` modes or optional extra inputs, built through `scripts/build-workflows.py`; version bump (README release checklist). `LTXVAddGuide` x2 at stage 1 and again at full size for stage 2 (as i2v does with `LTXVImgToVideoInplace`; the architect's note on re-adding guides after upscale applies). Note: our i2v uses `LTXVImgToVideoInplace` strength 0.7, not `LTXVAddGuide`; first-frame pinning with `LTXVAddGuide` behaves differently (guide frames cropped later), so the existing i2v graph should be left alone and the new mode added next to it.
- *Handler:* `INPUT_FIELDS` currently names one input per mode; needs a list of inputs with frame positions, each fetched from R2 and validated. Upload/validate logic already exists per input.
- *Worker (Cloudflare):* `input_key` becomes `input_keys` (or `input_key` + `last_key`); upload limits and validation per slot.
- *UI:* a second file picker ("last frame"), optionally "add keyframe" slots with a position slider (in seconds, snapped to the 8k+1 grid).
- *Image rebuild:* **no** (no new packs, no new weights). Workflows live on the volume; handler changes need an image rebuild only because `handler.py` is in the image.
- *Weights/volume:* none.
- *Runtime/cost:* expected within a few seconds of today's about 68 s / $0.034 per warm clip (unmeasured); cold start unchanged.
- *Risks:* mid-clip keyframes may cause visible jumps or freeze the motion; int8 behaviour unproven; frame-position snapping (8k+1) confuses users; aspect ratio mismatches.
- *Effort:* FLF2V only: 1.5-3 days; N keyframes with UI: 3-5 days.

### Option 2: IC-LoRA Union Control (depth/edge/pose) on LTX
- *Workflow:* new mode `control`; control video input; preprocessor graph (Video Depth Anything, Canny, DWPose); `LTXICLoRALoaderModelOnly` + `LTXAddVideoICLoRAGuide`.
- *Image rebuild:* **yes**. ComfyUI-LTXVideo is already there; add ComfyUI-VideoDepthAnything and comfyui_controlnet_aux (plus their Python dependencies, risking the "torch unchanged" constraint in `worker/constraints.txt`).
- *Weights:* 654 MB LoRA plus annotator models (sizes unverified; Depth Anything and DWPose models are typically hundreds of MB each, my recollection). Fits easily. Added cold-start load: small (LoRA) but annotators download on first run unless pre-baked on the volume; first-run internet downloads on a serverless worker must be avoided (pre-place files).
- *Handler/Worker/UI:* second video input, control-type selector, preview of the control video would be nice.
- *Runtime/cost:* unknown; the extra reference latent adds tokens. Peak VRAM already 43.5 GiB of 48 GiB, so **OOM risk is real**.
- *Risks:* int8 compatibility (biggest); the LoRA is for 2.3 while we run 2.5; cats are a weak case for both pose and canny; license/gating.
- *Effort:* 4-7 days plus a 1-2 day spike. The spike alone (hand-run on a pod with the Union workflow) is the first thing to do.

### Option 3: Wan 2.2 Animate for cat-dance
- *Workflow:* entirely new graph and mode (`animate`), DWPose preprocessing, point-editor masks (the template uses KJNodes' Points Editor, which is interactive; automating subject masks without a UI is non-trivial).
- *Image rebuild:* yes (KJNodes, controlnet_aux, possibly Wan-specific nodes).
- *Weights:* about 27-30 GB (see above, partly unverified); fits the volume; cold-start model load grows; a separate endpoint is advisable.
- *Runtime/cost:* unknown on this card. Wan 14B at 720p is usually slower than LTX distilled (my expectation, low). Treat per-clip cost as several times today's; **not measured**.
- *License:* Apache 2.0 (fine).
- *Risks:* human-only behaviour for cats; quality; a second pipeline to maintain.
- *Effort:* 8-15 days. Not recommended before a cheap feasibility test (Section 6).

### Cold-start
The first clip after idle already takes about 223 s cold start plus generation (README). Extra files read from the volume lengthen that roughly in proportion to size (about 104-119 s for about 37 GB of models today, i.e. about 3 s per GB, rough scaling; unverified for additional files). Option 1 adds nothing; Option 2 adds well under 1 GB for the LoRA; Option 3 adds about 30 GB if on the same endpoint.

## 5. Hosted services (build versus buy)

Only what the vendor's own page says. No pricing is claimed.
- **Kling Motion Control (Kuaishou).** Applies motion from an uploaded video or a motion library to one character in an image. Per its own guide: motion videos 3-30 s (VIDEO 2.6); "Real human actions are recommended, while certain stylized humanoid or humanoid body proportions can be recognized"; the page does not say animals are supported. https://kling.ai/quickstart/motion-control-user-guide (high).
- **Runway Act-Two.** Performance transfer from a driving video to a character reference (image or video): head, face, body, hand. I could not open Runway's own page (HTTP 403); the description above comes from secondary sites (https://www.imagine.art/blogs/runway-act-two-overview and others, low-medium). Animal support: unverified.
- **Wan 2.2 Animate hosted by third parties** (for example Segmind, RunComfy, Atlas Cloud, Magic Hour pages appeared in search). Same model as the open weights; I did not verify any vendor page, so offered features, limits and prices are **unverified**.
- **ComfyUI partner nodes for Kling** exist in the Comfy docs (https://docs.comfy.org/tutorials/partner-nodes/kling/kling-motion-control, title only seen in search results; contents unverified).

Build versus buy: for a single one-off "cat does this dance" request, a hosted tool (Kling Motion Control is the best-documented match for image + driving video) is far cheaper in effort than 8-15 engineering days, and the quality bar for humanoid/cartoon subjects is more likely met. Running costs and terms must be checked by Ken on the vendor sites. Building makes sense only if this becomes a regular feature or privacy or cost control matters.

## 6. Recommendation

**Smallest next step with value: first + last frame (FLF2V) using core nodes only.** It needs no weights, no new packs, no image rebuild of node packs, only a new workflow JSON, a small handler change (second input), a Worker field and a second file picker. If it works, extend to optional middle keyframes with a frame-position control.

**What to test first on the real GPU (a short spike, before any UI):**
1. On the existing endpoint (or a dev pod from the same image), run a hand-edited FLF2V graph: two `LTXVAddGuide` nodes (frame 0 and frame -1), `LTXVCropGuides` before the upscaler and at decode, re-add at full size for stage 2. Use two images with the same aspect ratio. Check: does it load and run on the int8 build, are both frames honoured, peak VRAM versus the 43.5 GiB baseline, warm time versus 68 s.
2. Same graph with a third keyframe in the middle (for example frame 56) to see whether motion freezes or jumps.
3. In the same session, if there is appetite, a half-hour spike of the **Union Control** workflow with the 654 MB LoRA on a dev pod: the sole question is "does the LoRA apply to the int8 transformer without error, and does the output follow a depth video". Do this on a **pod** (not serverless) to avoid image rebuilds.

Cost of the test: about 5-10 warm clips at the current $0.034 each is well under US$1 on the serverless endpoint; add about one cold start ($0.09-0.14, plus time waiting) per session. A dev pod for the Union spike would cost roughly one to two hours of GPU time at the RTX 6000 Ada pod price in the README (about $0.99/hr secure, low stock), so about US$1-2, plus the annotator downloads. These are estimates.

**What not to build yet:**
- No IC-LoRA UI (control-type picker, control video upload) until the int8 spike passes.
- No Wan 2.2 Animate integration. If Ken wants the cat dance, try a hosted tool first (Kling Motion Control) with a humanoid-ish character, to see whether the idea is viable at all.
- No audio-conditioning features, no keyframe timeline UI beyond one or two extra slots.
- Do not add node packs or weights to the image or the 80 GB volume speculatively; cold start is already the weak spot.

## Not verified (summary)

- Any behaviour of conditioning, keyframes or IC-LoRAs on our int8-convrot build (nothing found; nothing run).
- Quality of mid-clip keyframes in LTX-2.5; exact FLF2V template node wiring and file name in `Comfy-Org/workflow_templates` (directory listing truncated).
- Whether a 2.5 Union Control or pose IC-LoRA exists on Hugging Face pages 2-3 of the Lightricks org list (not viewed); whether the 2.3 Union LoRA is officially supported on 2.5 (only a dev-docs page says it is used there).
- Whether the pinned ComfyUI has `GetICLoRAParameters`, `LTXVReferenceAudio` and the pack's IC-LoRA nodes (seen on master).
- Contents of ComfyUI-LTXVideo issues #553 and #584; whether further issues mention int8 or fp8 (only page 1 of 102 read).
- Sizes of annotator models and of the non-transformer Wan Animate files; VRAM and speed of Wan 2.2 Animate on RTX 6000 Ada; any cat or animal result for Wan Animate, VACE, Fun Control or LTX control; existence of an animal-pose preprocessor in comfyui_controlnet_aux.
- Runway Act-Two official page (403); animal support for Kling beyond its stated guidance; all hosted-service prices and limits; the August 2026 LTX-2.x Community License text (read only via a secondary summary).
- All engineer-day, runtime and cost figures for new options (estimates, not measurements).

## Glossary

- **Keyframe:** an image you pin to a chosen moment of the video (first frame, last frame, or in between). The model fills in the motion between pinned frames.
- **Guide:** how LTX implements a keyframe or a clip: extra frames added to the generation process that nudge the result toward them (`LTXVAddGuide`). Strength 1.0 pins hard, lower is a hint.
- **IC-LoRA:** "in-context" LoRA. A small add-on file (hundreds of MB) that teaches the model to follow an extra reference video, such as a depth map, edges, a pose skeleton or a layout. It is trained for one specific job and one base model.
- **Control video:** the reference video an IC-LoRA follows, usually a processed version of a real clip (a depth map, an edge drawing or stick figure) rather than the clip itself.
- **Pose estimation:** software that finds body joints (head, shoulders, elbows, knees) in each frame and draws them as a stick figure (skeleton). DWPose and OpenPose are standard tools; they are built for people.
- **Depth map:** a grayscale image where brightness shows how far each pixel is from the camera.
- **Canny edges:** a black-and-white outline drawing of the strongest edges in an image.
- **Motion transfer:** making a person or character from a still image move like someone in another video.
- **Quantized (int8/fp8):** model weights stored in fewer bits to save memory. Add-ons trained on full-precision weights may not apply cleanly.
- **Distilled model:** a model trained to need fewer steps (8 + 3 for us), faster, and with CFG 1.
- **Core node vs node pack:** core nodes ship inside ComfyUI itself; pack nodes (such as ComfyUI-LTXVideo) are separate add-ons that must be installed in the worker image.

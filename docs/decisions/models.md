# models — design note

## Summary
`scripts/download-models.sh` is run once (and again only when the manifest changes) from a throwaway RunPod CPU pod in US-WA-1 with the network volume attached. It reads a committed, revision-pinned manifest (`scripts/models.lock`: path, size, sha256 per file), downloads each file from the gated `Lightricks/LTX-2.5` repo with `curl -C -` into `*.partial`, verifies size and sha256, then atomically renames. It then copies `workflows/*.json` into `<volume>/workflows/`. Re-running is a no-op for files already present at the right size. The default set is 41.43 GB (38.6 GiB); the volume is **80 GB** (Ken's decision; the architect's original 60 GB is superseded, see "Ken's decisions" below), not the SPEC's 100 GB.

## Verified facts (searched 2026-10-29)
Source: HF API `Lightricks/LTX-2.5` (repo commit `49b093a39c19169a8a81721dcc541e07e945232f`, last modified 2026-10-11), `gated: auto`, license `ltx-2.x-community-license-agreement`, plus the model card. The repo's folder names are already the ComfyUI folder names, so the HF path and the volume path are identical (`models/<repo path>`). docs.ltx.video returned 403 to the fetcher, so docs.ltx.video itself was NOT read; the HF model card and repo tree were used instead. The HF card does not say where files go in ComfyUI, but the repo layout matches the folders in worker.md.

Real sizes (bytes; GB = 1e9):

| Repo path | Bytes | GB | Default? | Purpose |
|---|---|---|---|---|
| diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors | 21,504,034,224 | 21.50 | yes | the transformer (SPEC §2) |
| text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors | 15,372,969,374 | 15.37 | yes | encoder (the SPEC "~26 GB" is the bf16 file, 26.26 GB; int8 is 15.37 GB) |
| vae/ltx-2.5-video-vae-bf16.safetensors | 1,472,223,346 | 1.47 | yes | DiffVAE, higher quality (SPEC "~1.5 GB" correct) |
| vae/ltx-2.5-audio-vae-bf16.safetensors | 364,866,540 | 0.36 | yes | audio VAE (SPEC "~0.4 GB" correct) |
| latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors | 995,778,752 | 1.00 | yes | spatial x2, needed by the multi-stage pipeline |
| latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors | 261,944,000 | 0.26 | yes (cheap option) | optional temporal x2 |
| model_patches/ltx-2.5-duration-head-bf16.safetensors | 3,843,690 | 0.004 | yes (cheap option) | auto clip length from the prompt |
| vae/ltx-2.5-video-vae-conv-bf16.safetensors | 1,452,269,922 | 1.45 | yes (cheap option) | faster/lighter VAE alternative |
| loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors | 8,899,889,568 | 8.90 | no | only for workflows using the *dev* transformer |
| diffusion_models/...dev-transformer-comfy-int8-convrot / ...dev-transformer-bf16 / ...distilled-transformer-bf16 (42.02 GB) / ...nvfp4 (18.72 GB, Blackwell-oriented) | various | | no | excluded by SPEC §2 / worker decisions (8: no bf16 fallback) |
| text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16 | 26,263,858,182 | 26.26 | no | does not fit with the transformer on 48 GB |

Default total = 41,427,929,848 bytes = 41.43 GB = 38.6 GiB. Required-only (first five rows) = 39.71 GB. The `*-comfy-int8-convrot` files are ComfyUI-only per the card.

Gated flow: access is `auto` (instant approval) once a logged-in HF account clicks "Agree and Access" on the model page, which also consents to Lightricks receiving the account info. License: free commercial use under USD 10M revenue; paid above. The token must belong to the account that accepted. A fine-grained token needs the "read access to public gated repos" permission (a classic "read" token also works). Without acceptance, resolve URLs return 403; with a bad token, 401. Not verified end-to-end (no token used here).

Checksums: HF LFS files expose sha256 as `lfs.oid` in `GET /api/models/Lightricks/LTX-2.5/tree/<rev>?recursive=true` and as the `X-Linked-Etag` header on `/resolve/<rev>/<path>`. The public fetcher masked the oids, so I could not capture the actual hashes; the engineer must generate them with the token (see Design).

Volume: RunPod network volumes are $0.07/GB/month (first TB), can be enlarged but not shrunk (per RunPod docs search; docs not opened directly). Mount path: serverless mounts `/runpod-volume`; pod mount path defaults to `/workspace` (not verified in docs this session, so the script must not assume it).

## Design
### Layout (the contract worker.md Door 4 consumes)
```
<VOLUME>/models/{diffusion_models,text_encoders,vae,latent_upscale_models,loras,model_patches}/<file>
<VOLUME>/workflows/{t2v,i2v,v2v}.json
<VOLUME>/models/.manifest-rev      # revision + lock hash of last successful run
```
`loras/` is created (empty) because `extra_model_paths.yaml` references it. `<VOLUME>` is `/runpod-volume` on serverless; on the pod the script uses `$VOLUME_ROOT`, defaulting to `/runpod-volume` if it exists, else `/workspace`. The relative layout is identical, so nothing else changes.

### scripts/models.lock (committed, generated)
One line per file: `sha256  size  repo_path`, header `# repo=Lightricks/LTX-2.5 rev=<40-char commit>`. Generated by `download-models.sh --update-lock` (needs HF_TOKEN and network, queries the tree API at a chosen revision, writes the file, Ken reviews the diff). Normal runs never hit the tree API; they download `…/resolve/<rev>/<path>` so content is pinned to the commit even if Lightricks updates the repo. Which files are in the default set is a `default`/`optional` column or a second list in the lock; `--only <substr>` and `--with-lora` select extras.

### Script behaviour (bash, `set -euo pipefail`, deps: curl, sha256sum, coreutils only)
1. Preflight: `HF_TOKEN` set (never printed, never in argv logs: pass via `curl -H @file` or `--config` on stdin); `VOLUME_ROOT` exists and `mountpoint -q` is true (refuse to write to container disk, which would silently fill and then vanish); `df` free space at least (total of missing files + 5 GB); HEAD on the smallest file (duration head). 401 prints "token invalid"; 403 prints the model-page URL and "accept the license with the same account that owns the token".
2. For each manifest file: if final path exists and size matches, skip (final names only appear after a verified rename, so size match is trustworthy; `--verify` forces full re-hash of everything, about 1-2 min for 41 GB). If size differs, delete and re-download.
3. Download: `curl -fL --retry 5 --retry-all-errors -C - -H "Authorization: Bearer $HF_TOKEN" -o <name>.partial`. curl drops the Authorization header on the cross-host redirect to the CDN by default (do not pass `--location-trusted`). `-C -` resumes after a dropped connection or a pod restart. A 416 on resume (file already complete) is handled as "go verify".
4. Verify: `sha256sum` of `.partial` equals lock value and size equals lock size, else delete `.partial` and fail non-zero (one automatic retry first); then `mv` to the final name and `sync`. Files are processed two at a time (`xargs -P2`) so the 21.5 GB file and the encoder overlap; this is tunable.
5. Workflows: copy `workflows/*.json` (source resolved relative to the script's repo root) to `$VOLUME_ROOT/workflows/` via temp file + `mv` per file. If none exist (the `workflows` feature comes after this one) warn, do not fail. `--workflows-only` re-syncs just these, so editing a workflow never needs a 41 GB re-check; it is also what `dev-pod`/the workflows feature reuses. Validate each file is parseable JSON (`python3 -m json.tool` if present) before copying.
6. End with a table: each file, size, OK/skipped/downloaded; exit 0 only if all default files verified. Idempotent: second run downloads nothing and prints the same table.

How the script reaches the pod: the repo (script, lock, workflows) must be on the pod. Option A: `git clone` the repo on the pod (needs the repo to be public or a deploy token). Option B: `runpodctl send`/scp of `scripts/` and `workflows/` from the laptop. Recommend A if the repo is public, else B (see Q4).

Pod recipe (documented in README, done by Ken or the `endpoint` feature): cheapest CPU pod in US-WA-1 with the volume attached, container disk 10 GB, `HF_TOKEN` as a pod env var, run script, terminate the pod. Time: about 41 GB at 100-300 MB/s is 3-7 minutes plus verify; cost is cents.

## Decisions
### One-way doors
1. **Network volume size = 60 GB (SPEC says ~100 GB).** _Superseded: Ken decided 80 GB ($5.60/mo); the text below is the architect's original reasoning._ Options: (a) 50 GB: fits the 38.6 GiB default set plus about 8 GB. (b) 60 GB: also fits the extra dev-transformer int8 (21.5 GB) experiment? No: 41.4 + 21.5 = 62.9 GB, so 60 does not; it gives about 18 GB headroom for ComfyUI caches, a second VAE or the 8.9 GB LoRA. (c) 100 GB as in SPEC: $7/mo, 2.4x the data. Recommend (b) 60 GB = $4.20/mo. Why: volumes can grow but never shrink, so start small; growing later is cheap and non-destructive. Reversibility: growing is free; shrinking means create new volume, recopy ~41 GB, re-point the endpoint (small money, real hassle). Note SPEC §7's "~$7/mo" becomes ~$4.20.
2. **Volume layout and filenames on the volume** (same as worker.md Door 4): `<VOLUME>/models/<repo-folder>/<exact repo filename>`, `<VOLUME>/workflows/{mode}.json`. Workflows and the handler reference model files by filename; files are never renamed. Recommend: keep HF names verbatim (verified list above). Reversibility: renaming means editing every workflow JSON and re-validating; moving means recopying tens of GB.
3. **Default model set** (what is on the volume after the first run). Options: (a) required five only (39.71 GB); (b) required + conv VAE + temporal upscaler + duration head (41.43 GB, +1.7 GB, about $0.12/mo); (c) b + 8.9 GB distilled LoRA. Recommend (b): the extra four are tiny and let the `workflows` feature choose VAE/upscaler/duration without another paid pod session; the LoRA is only useful with the dev transformer, which is excluded. Reversibility: adding later = one more pod run (cents) but is a separate session, so low cost; classified one-way only because it is bound to the volume size.
4. **Pinned HF revision and lock file with sha256** (content identity of the weights). Options: (a) track `main` and verify size only; (b) pin commit `49b093a…` and verify sha256 from a committed lock. Recommend (b): reproducible (SPEC priority 4); a silent upstream replacement of a weight file is exactly what would otherwise surface as a baffling generation difference. Reversibility: bumping the pin is a one-line change plus `--update-lock`, but re-downloading a changed 21 GB file on the volume.
5. **Datacenter = US-WA-1 (Ken decision 9)** — carried over, not re-opened. The pod MUST be created in US-WA-1 or the volume cannot be attached. Also relevant: stock at US-WA-1 can be MEDIUM, and a CPU pod needs CPU stock there too; if there is none, a cheap GPU pod is the fallback.

### Two-way doors
- Downloader is plain `curl -C -` + `sha256sum`, not `huggingface-cli`/`hf_transfer`: zero pip dependencies on any pod image, simple resume semantics; swapping later is a script-only change.
- `.partial` + verify + atomic `mv`: a final filename always means a verified file.
- Concurrency 2 (`xargs -P2`), `--retry 5`.
- HF token passed through the pod env var `HF_TOKEN`, read from `$HF_TOKEN` only; `config.env.example` gets an `HF_TOKEN=` line (documentation only, no value; Ken's laptop copy is for `--update-lock`, the pod gets it as a pod env var).
- Workflows copied by the same script, plus `--workflows-only`.
- `--verify`, `--only`, `--with-lora`, `--dry-run` flags.
- Free-space guard and mountpoint guard.

## Questions for Ken
_(Answered, see "Ken's decisions" at the end of this note.)_
1. **Volume size.** (a) 50 GB ($3.50/mo) (b) 60 GB ($4.20/mo, recommended) (c) 100 GB as in SPEC ($7/mo). Volumes only grow, never shrink, so starting small is the cheap-to-correct choice. OK with 60 GB?
2. **Default download set.** (a) five required files, 39.7 GB (b) plus conv VAE, temporal upscaler, duration head, 41.4 GB (recommended; +$0.12/mo) (c) b plus the 8.9 GB distilled LoRA. Recommend (b).
3. **HF access.** Have you accepted the LTX-2.x Community License on https://huggingface.co/Lightricks/LTX-2.5 with the account you will use, and do you have a read token (fine-grained: "read access to public gated repos")? Note it also shares your HF profile info with Lightricks, and the license is free only under USD 10M revenue. This is a manual step I cannot do.
4. **How does the script get onto the pod?** (a) `git clone` the repo on the pod (needs the repo to be public or a read-only deploy token; recommended if the repo is public; the worker image is already public) (b) `runpodctl send`/scp from your laptop each time. Is the GitHub repo public?
5. **Checksum trust.** Pin the HF commit `49b093a…` and verify sha256 against a committed lock (recommended), or just verify size and follow `main`? The lock must be generated once with your token (`--update-lock`); the engineer cannot obtain the hashes without it.

## Concerns / risks
- sha256 values could not be captured (public fetch masks LFS oids); the engineer must generate the lock with an authenticated call and cross-check one file's `X-Linked-Etag`.
- docs.ltx.video returned 403; filenames come from the HF repo tree (authoritative for what exists) and worker.md's docs.comfy.org reading. Which of the optional files the official workflows actually load is for the `workflows` feature to confirm; if the official example uses a file not in the manifest (e.g. the distilled LoRA), the manifest gains a line and one more pod run.
- The sizes confirm worker.md concern: the int8 encoder is 15.37 GB, so transformer + encoder = 36.9 GB resident would exceed a 48 GB card only with activations; the RTX 6000 Ada (48 GB) is the same class, so offload behaviour remains the open measurement from the worker note. Not a `models` issue but it decides whether the volume ever needs the bf16 files (answer: no, per decision 8).
- US-WA-1 stock is MEDIUM; the temporary pod may fail to schedule. The volume binds the pod to that datacenter.
- Cold start reads about 37-40 GB from network storage; the throughput of the volume is unmeasured and dominates SPEC criterion 2.
- Pod mount path (`/workspace` vs `/runpod-volume`) not confirmed from docs; the mountpoint guard makes a wrong guess fail loudly instead of filling container disk.
- Token leakage: pod env vars are visible in the console and logs of that pod; use a read-only token and revoke or rotate it after the run.
- A killed run leaves `*.partial` files, which count against volume space until resumed or deleted; the script cleans `.partial` files that do not match any manifest entry.

## How the validator should test this
- `shellcheck scripts/download-models.sh` clean; `bash -n`.
- Offline test with a fake volume (tmpfs dir, `mountpoint` check overridable by env var `SKIP_MOUNT_CHECK=1` for tests only) and a local HTTP server (python `http.server` with Range support) as the HF base URL via `HF_ENDPOINT` override; small fixture files and a fixture lock:
  - first run downloads everything and the table says OK; second run downloads nothing (assert no HTTP requests) and exits 0;
  - truncate a final file: re-downloaded; flip a byte at same size: caught only with `--verify`, and caught always right after download (corrupt the server copy to prove the `.partial` is deleted and the exit code is non-zero);
  - kill curl mid-download (server throttled), re-run: the request carries a `Range` header and the final hash matches;
  - missing `HF_TOKEN`, server returning 401 and 403: distinct readable messages, non-zero exit, token string never appears in output or `set -x` logs;
  - volume path not a mountpoint: refuses; insufficient free space: refuses;
  - `workflows/` absent: warning and exit 0; present with an invalid JSON file: fails before copying; `--workflows-only` touches no model files; re-copy is atomic.
- Check the lock file: every default filename and size matches the table above, paths are exactly the layout in this note, and total of default entries is 41,427,929,848 bytes.
- Real-world acceptance (by Ken, once, on a US-WA-1 pod): script exits 0, `ls -lR /workspace/models` sizes equal the table, second run is instant, `extra_model_paths.yaml` resolves each category on a serverless worker (feeds worker/endpoint validation).

## Reviewer

Reviewed 2026-10-29, independent of the architect. External facts checked against docs.runpod.io/storage/network-volumes and a docs search (no RunPod or Cloudflare API calls, no secrets read). Confirmed: $0.07/GB/month for the first TB; "volume size can be increased later but cannot be decreased"; on Pods the volume replaces the volume disk, typically mounted at `/workspace` (changeable in the template), on Serverless at `/runpod-volume`; network volumes are Secure Cloud only; a volume must be attached at pod creation and cannot be detached later; storage bills while pods are stopped. Not confirmed: a documented minimum size, whether a resize needs the endpoint drained, and whether a CPU pod at US-WA-1 will have stock.

### Door 1: volume size 60 GB. **AGREE WITH CHANGES (prefer 80 GB; 60 GB only with a delete-first update procedure)**
The headroom arithmetic is right for steady state (60 - 41.43 = 18.6 GB) but fails the case of a model version change. The script downloads to `*.partial` while the old file is still present, so replacing the 21.5 GB transformer needs 41.43 + 21.5 = 62.9 GB, and the script's own free-space guard (missing bytes + 5 GB) would refuse at 60 GB. Replacing the encoder too is about 78.3 GB. Filenames are verbatim and contain the version, so a bump usually produces a new name and the old file lingers as an orphan (the script only cleans `.partial` files). At 60 GB every pin bump needs a manual volume grow first, or a delete-first procedure that leaves the endpoint broken during the swap.
Steelman of SPEC's 100 GB: the delta over 60 GB is $2.80/mo (about $34/yr); it absorbs a second model set (dev transformer int8 21.5 GB + LoRA 8.9 GB gives 71.8 GB), a bump with overlap, and unknown working files. "Growth is cheap" cuts both ways: growing is documented, but it is not confirmed to be hot (no endpoint drain), and the first time it is needed is mid-bump. "Shrink is impossible" is real but weak, since the volume can be rebuilt for cents from HF (idempotent script), so over-provisioning is not costly to undo either.
Working files: ComfyUI temp/output/input and handler downloads go to container disk or R2, not the volume, provided `extra_model_paths.yaml` only adds model folders. State this explicitly; if ComfyUI `output/` or `temp/` ever lands on the volume, headroom shrinks silently. Workflows are KB-sized and LoRAs 1-9 GB each; version overlap is the real constraint.
Recommendation: 80 GB ($5.60/mo) covers one full-transformer swap with overlap (62.9) and a LoRA, and is still cheaper than SPEC. If Ken prefers 60 GB, the script needs (a) a `--prune` mode that removes files not in the lock and (b) a documented swap: set endpoint max workers to 0, prune, download, verify, restore. Correct SPEC section 7 either way.

### Door 2: volume layout and verbatim filenames. **AGREE** (one addition)
Mirroring the repo's folder names removes a translation layer and is consistent with worker.md Door 4. Alternative steelmanned: stable aliases (`ltx-transformer.safetensors`) so a bump never touches workflow JSON. It hides which weights are loaded, breaks the match between lock names and file names, and symlinks or copies on a network volume add failure modes. Verbatim wins for reproducibility. The unmentioned failure is that names embed version and precision (`-1.0`, `int8-convrot`), so a bump means editing every workflow JSON and the lock, and leaves orphans. Addition: the workflows feature should take model filenames from one place (a mapping the handler fills in, or generated from the lock) rather than hardcoding them in three JSON files. That is a two-way choice for that feature, but the layout is only safe to freeze if it is made. `.manifest-rev` sits under `models/` outside any category folder, so ComfyUI will not scan it; fine.

### Door 3: default model set (41.43 GB). **AGREE**
The extra 1.72 GB ($0.12/mo) over the five required files is cheaper than a later pod session (Secure Cloud CPU stock at one datacenter, fresh HF token, a manual step for Ken). Excluding the 8.9 GB LoRA is right: it serves only the dev transformer, excluded by SPEC section 2 and Ken's decision 8, and would eat half the headroom in Door 1. This is a two-way door with a small friction cost, not one-way. The extras may prove unused; 12 cents, so no change. The default-set size is what the Door 1 swap arithmetic rests on.

### Door 4: pinned commit plus sha256 lock vs follow `main`. **AGREE WITH CHANGES**
Pinning is right: HF commits are immutable and `/resolve/<rev>/` keeps working after later pushes, so a re-run in six months gives byte-identical weights, the only way SPEC priority 4 holds for a 41 GB artifact. Following `main` risks a silent file change that shows up as a quality shift with no diff in this repo. Steelman of `main`: automatic fixes, no maintenance; but there is no regression detection, and a bump is cheap to do deliberately. Changes: (1) the lock is trust-on-first-use, since hashes come from the same HF API that serves the files; it guards against drift, not a bad first fetch. Cross-check at least the 21.5 GB transformer's sha256 against a second source if one exists, and record the commit date in the lock header. (2) The engineer cannot generate the lock without Ken's token, so schedule that step explicitly; the lock must be committed before the download run counts as validated. (3) Document a bump as a procedure including the Door 1 space and prune steps; "one-line change" understates it. (4) Log the lock hash from `.manifest-rev` in the handler or smoke test so a clip can be tied to a weight set. HF gating revocation of a pinned revision is low probability and mitigated once the files are on the volume.

### Door 5: US-WA-1 for the temporary pod. **AGREE** (weaker one-way label)
Follows from Ken's decision 9 and is forced by the platform: the volume is bound to its datacenter, and the pod must be created there. Alternatives (EU-NL-1 with L40S, Ken's fallback; another datacenter chosen for pod stock) apply only if serverless stock at US-WA-1 stays poor. The lock-in is cheap to undo because the script is idempotent and sources from HF: a move means a new volume, one 3-7 minute pod run, and repointing the endpoint, so the real cost is Ken's attention, not dollars. The real risk is stock: US-WA-1 CPU pod stock is unverified, volumes force Secure Cloud, and "MEDIUM" serverless stock can drop. Recommendation: before creating the volume, the endpoint feature reads capacity for both a serverless RTX 6000 Ada and a CPU pod at US-WA-1, and the README names the fallback (cheapest GPU pod at US-WA-1). Terminate, do not stop, the temporary pod; a stopped pod keeps billing disk.

### Decisions classified two-way that behave as one-way
- Pod mount path (`/workspace` vs `/runpod-volume`): the layout is valid only if the same relative tree appears at both mounts. Test the `mountpoint -q` guard on a real pod once (it may fail if the mount is a bind or overlay), and make `VOLUME_ROOT` settable by flag as well as env.
- Network volume ID in the endpoint config: recreating the volume (Doors 1 or 5) changes the ID and requires an endpoint update. The `endpoint` feature should take the ID from config, not hardcode it.
- Orphaned files with no prune: "never rename, clean `.partial` only" makes the Door 1 size a recurring cost. A `--prune` flag is cheap now and unusable later if never written.
- Resize path: "grow is free and non-destructive" is stated as fact but only "cannot be decreased" is documented. Treat as unconfirmed until tried once.
- Cold-start throughput (37-40 GB read per cold start) decides SPEC criterion 2. If standard storage is too slow, the alternative is high-performance storage (premium price, only some datacenters), and that too is chosen at volume creation.

### Questions for Ken
1. Volume size: 80 GB ($5.60/mo, reviewer preference, allows a transformer swap with overlap) or 60 GB (prune-first update procedure, accepted outage during swaps)? SPEC's 100 GB is $7.00/mo.
2. OK to add a `--prune` flag (removes files not in the lock) and include it in the bump procedure?
3. Approve a read-only capacity check at US-WA-1 for a CPU pod and the RTX 6000 Ada before the volume is created, and name the fallback pod type if CPU stock is zero?
4. Standard network volume or high-performance storage at US-WA-1: decide after one measured cold start, or accept standard for now?
5. Is a trust-on-first-use sha256 lock acceptable, or do you want the transformer's hash cross-checked against a second source before it is committed?

## Ken's decisions (2026-10-29) — binding, supersede the text above where they differ

1. Network volume **80 GB** ($5.60/mo at $0.07/GB), not 60 GB; allows a transformer swap with overlap. SPEC §7 cost is corrected in the README only; SPEC.md is untouched.
2. Default set: the five required files plus conv VAE, temporal upscaler and duration head (41.43 GB). The LoRA is optional (`--with-lora`).
3. `--prune` is added (removes files not in the lock), and the model-bump procedure is documented (max workers 0, prune, download, verify, restore).
4. **Standard** network volume for now; high-performance tier is decided after a measured cold start.
5. **Trust-on-first-use sha256 lock** from the HF API, commit and its date recorded in the lock header; a second-source cross-check of the transformer hash is optional.
6. The repo is **public**, so the temporary pod gets the script with a plain `git clone`.
7. The HF license is accepted and the token was verified working. The token reaches the pod only as the env var `HF_TOKEN` (read-only, rotate after the run); the script never prints or logs it.
8. `VOLUME_ROOT` is settable by flag and env (default `/runpod-volume`, else `/workspace`); the mountpoint guard is tested.
9. ComfyUI temp/output/input never go on the volume.

## Summary (Phase 7)

**Built.** `scripts/download-models.sh` (bash, curl + sha256sum): downloads the pinned `Lightricks/LTX-2.5` files into `<volume>/models/<category>/` via `.partial` + `curl -C -`, verifies size and sha256, renames atomically, creates the category dirs (including empty `loras/`), and syncs `workflows/*.json`. Flags: `--verify` (read-only re-hash), `--prune [--dry-run]`, `--update-lock [--rev]`, `--workflows-only`, `--with-lora`, `--list`, `--volume-root`. Guards: volume must be a mountpoint, free space, one run per volume (flock), token and `JOBS` validation, clear 401/403 messages, refusal while any lock hash is `null`, `df -hT` printed before downloading. `scripts/models.lock` is the single source of files, sizes, sha256 and the pinned commit, and the source of model filenames for the `workflows` feature (`--list`). Offline tests (`tests/models/`, mock HF server, fake volume) run with `make -f scripts/models.mk test-models`.

**Key decisions.** 80 GB standard volume at US-WA-1; verbatim HF filenames and folders; pinned commit with a TOFU sha256 lock (hashes generated 2026-10-29); own curl retry loop because curl's `--retry` restarts from byte 0; plain curl and sha256sum so a pod needs no pip packages.

**Files.** `scripts/download-models.sh`, `scripts/models.lock`, `scripts/models.mk`, `tests/models/run.sh`, `tests/models/mock_hf.py`, README "Models" section, `docs/validation/models.md`.

**Next steps.** Ken runs the first real download on a US-WA-1 pod, then a full `--verify`, and fills in the README "Measured" table. `HF_TOKEN` gets documented in `config.env.example` after the worker branch merges. The `workflows` feature reads filenames from the lock. The `endpoint` feature takes the volume ID from config and checks US-WA-1 capacity. Unverified until then: real gated 401/403 and CDN redirect behaviour, mountpoint on a real pod, throughput, and a hot volume resize.

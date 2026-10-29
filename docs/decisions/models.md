# models — design note

## Summary
`scripts/download-models.sh` is run once (and again only when the manifest changes) from a throwaway RunPod CPU pod in US-WA-1 with the network volume attached. It reads a committed, revision-pinned manifest (`scripts/models.lock`: path, size, sha256 per file), downloads each file from the gated `Lightricks/LTX-2.5` repo with `curl -C -` into `*.partial`, verifies size and sha256, then atomically renames. It then copies `workflows/*.json` into `<volume>/workflows/`. Re-running is a no-op for files already present at the right size. The default set is 41.43 GB (38.6 GiB); the volume should be 60 GB, not 100 GB.

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
1. **Network volume size = 60 GB (SPEC says ~100 GB).** Options: (a) 50 GB: fits the 38.6 GiB default set plus about 8 GB. (b) 60 GB: also fits the extra dev-transformer int8 (21.5 GB) experiment? No: 41.4 + 21.5 = 62.9 GB, so 60 does not; it gives about 18 GB headroom for ComfyUI caches, a second VAE or the 8.9 GB LoRA. (c) 100 GB as in SPEC: $7/mo, 2.4x the data. Recommend (b) 60 GB = $4.20/mo. Why: volumes can grow but never shrink, so start small; growing later is cheap and non-destructive. Reversibility: growing is free; shrinking means create new volume, recopy ~41 GB, re-point the endpoint (small money, real hassle). Note SPEC §7's "~$7/mo" becomes ~$4.20.
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

# ui - design note

## Summary

`ui/` is one Cloudflare Worker (Wrangler project, name `jubividia`, free plan, `workers.dev` only) that serves a mobile-first vanilla page and a small JSON/streaming API in front of the RunPod endpoint `jubividia-ltx25` and the R2 bucket `jubividia-ltx-eu`. The RunPod API key and endpoint id are Worker secrets; R2 is reached through a binding (no S3 keys in the Worker). A Cloudflare Access application scoped to **this Worker only** (email = Ken, one-time PIN, 24 h) is the primary gate. The Worker also verifies the Access JWT on every request (defense in depth), because **`ctx.access` is not available to a Worker that uses Static Assets** (verified, see below), so the JWT check is not optional here.

Spend safety does not depend on the URL staying secret: one active job at a time, a daily attempt cap kept in R2 with conditional writes, server-side caps on size and length that stay inside the measured envelope (1280x704x121 peaked at 43.5 GiB of the 48 GB card), job-level `ttl` and `executionTimeout`, and the RunPod balance as the final backstop.

The coordinator, not this note, makes every Cloudflare change, in the order of "Cloudflare changes" below. No implementation code is written here.

This note made only read-only calls: Cloudflare MCP `workers_list` (names only; I did not read any Worker's code), `r2_bucket_get`, documentation search, and a web search. Nothing was created, changed or deleted on Cloudflare or RunPod. The account has exactly one Worker today, `jubilab-website`, which this design never touches (see "Isolation from jubilab-website").

## Verified facts (searched 2026-10-29)

| Fact | Finding | Source |
|---|---|---|
| Access for Workers, two scopes | (a) Per-Worker Access: self-hosted Access app with destination `{"type":"worker","worker_id":"<id>"}` protects that Worker "regardless of how it is accessed" (workers.dev, previews, custom domains). (b) Hostname Access: self-hosted app whose domain is the exact `workers.dev` hostname (or custom domain or path); protects only that URL. There is also an account-wide "protect all Workers" option, which we must never use (it would reach `jubilab-website`). | developers.cloudflare.com/workers/configuration/cloudflare-access/ |
| JWT validation | Access adds `Cf-Access-Jwt-Assertion`; the docs say to validate it. Pattern: `jose` `createRemoteJWKSet(new URL(TEAM_DOMAIN + "/cdn-cgi/access/certs"))`, `jwtVerify(token, JWKS, {issuer: TEAM_DOMAIN, audience: POLICY_AUD})`, with `TEAM_DOMAIN = https://<team>.cloudflareaccess.com` and `POLICY_AUD` = the Access app's AUD tag. | changelog 2025-10-03 "One-click Cloudflare Access for Workers", workers/configuration/cloudflare-access |
| `ctx.access` is NOT usable with Static Assets | "Workers with Static Assets execute behind an internal router Worker ... the router does not pass `ctx.access` to the user Worker." So an assets-based UI must read and verify the header itself. (`ctx.access` plus `access.dev` in `wrangler.jsonc` for local tests exists, but only helps Workers without assets.) | workers/configuration/cloudflare-access, "ctx.access limitations" |
| One-time PIN | New Zero Trust orgs get the **Cloudflare identity provider** as default login, not OTP (changed 2026-05/06). OTP must be added: Zero Trust > Integrations > Identity providers > One-time PIN, or API `POST /accounts/{id}/access/identity_providers` `{"name":..., "type":"onetimepin","config":{}}`. Access policy then lists Ken's email. Sender is `notify.cloudflare.com`. | cloudflare-one/integrations/identity-providers/one-time-pin |
| Session length | Global and application session duration default 24 h; range 15 min to 1 month; policy session duration defaults to the application's. | access-settings/session-management |
| Zero Trust org / plan | Needs a Zero Trust organization (team name). The Free plan is $0 but onboarding still asks for plan selection and payment details. Whether this account already has an org is **not readable with the tools I have** (the MCP connector has no Zero Trust tools). | cloudflare-one/setup |
| Request body limit | Depends on the **Cloudflare account plan**: Free 100 MB, Pro 100 MB, Business 200 MB; over the limit gives HTTP 413. Response body: no limit. | workers/platform/limits |
| Free-plan Worker limits | CPU 10 ms per request (waiting on fetch/R2 does not count); 100,000 requests/day (error 1027 beyond); 50 external subrequests and 1,000 Cloudflare-service subrequests (R2, etc.) per invocation; 128 MB memory; 6 simultaneous outgoing connections. Streaming an R2 body to the client costs almost no CPU. An RS256 JWT verify is well under 10 ms natively; the JWKS fetch is a subrequest, cached per isolate by `jose`. | workers/platform/limits, changelog 2026-02-11 |
| R2 binding streaming and Range | `bucket.get(key, {range: request.headers, onlyIf: request.headers})` accepts the request headers directly; `object.writeHttpMetadata(headers)`, `httpEtag`; no body in the result means a precondition failed (412/304). `object.range` carries the served offset/length, from which we build `Content-Range` and answer 206 ourselves (iOS Safari will not play `<video>` without proper 206 handling). `put(key, request.body, {httpMetadata})` streams an upload. | r2/api/workers/workers-api-usage, workers-api-reference |
| R2 list | `list({prefix, limit<=1000, cursor, delimiter, include})`; use `truncated`/`cursor`, never compare result count to `limit`; `delimitedPrefixes` returns "directories" when a delimiter is set. Results are lexicographic ascending. | workers-api-reference |
| R2 cost | Free tier per month: 10 GB storage, 1 M Class A (list, put), 10 M Class B (get, head). Egress free. Paid: $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Our volume (about 1 MB per clip, a few hundred operations a day) stays free. | r2/pricing |
| R2 lifecycle | Supported via dashboard, `wrangler r2 bucket lifecycle add <bucket> <name> <prefix> --expire-days N` (also `list`, `remove`, `set --file`) and the S3 `PutBucketLifecycleConfiguration` API. Prefix-scoped. Expiry is applied asynchronously (expect up to about a day late). Bucket lock rules, if any existed, would override lifecycle (none are known to exist). | r2/buckets/object-lifecycles, wrangler r2 commands |
| Local testing | `wrangler dev` runs the Worker in workerd with a **local R2 simulation** (`.wrangler/state`), no Cloudflare writes unless a binding says `"remote": true`. Unit/integration tests: `@cloudflare/vitest-pool-workers` (Workers Vitest integration), bindings available in tests. Miniflare is not a security sandbox (run the dev loop locally only for our own code, which is fine). | workers/testing, workers/local-development, r2/get-started/workers-api |
| Static assets + Worker first | `assets: {directory, binding: "ASSETS", run_worker_first: true}` sends every request through the Worker, which can verify the JWT and then `env.ASSETS.fetch(request)`. Individual asset files are limited to 25 MiB. | workers/static-assets/binding |
| Secrets | `wrangler secret put KEY` / `wrangler secret bulk file.json` (up to 100 per command); local values in git-ignored `.dev.vars`. `wrangler versions secret put` creates a version without deploying. | wrangler commands/workers |
| Terraform | Cloudflare provider v5 is auto-generated from the OpenAPI schema; releases every 2-3 weeks (v5.20.0 on 2026-06-12 is the newest I found); Cloudflare calls v5 stable (2026-04). Earlier v5 releases had recurring-diff bugs on `cloudflare_zero_trust_access_application`. I could **not** confirm that the resource supports the `worker` destination type (the Workers docs show it only as a raw API body). | changelog/product/terraform, search results |
| workers.dev subdomain | The account already hosts `jubilab-website`, so an account-level `workers.dev` subdomain almost certainly exists, but the connector cannot read it. The coordinator must read it (`GET /accounts/{id}/workers/subdomain`, read-only). **Never create or rename it**: it is account-wide and renaming would change every workers.dev URL, including Ken's other site. | inference, flagged |
| R2 bucket | `jubividia-ltx-eu`: location WEUR, Standard, default jurisdiction, created 2026-10-29. Existing lifecycle rules and CORS are not readable with the connector; the coordinator reads them first. No CORS is needed in this design (same-origin only, upload goes through the Worker). | r2_bucket_get |

Worker contract facts used from earlier notes (not re-verified): the handler takes `input_key` under `inputs/`, rounds width/height down to multiples of 64, takes `num_frames` (8k+1, 9..481) or `duration` x `fps`, requires v2v >= 33 frames, returns `{v,key,thumb_key,meta_key,duration_s,gen_time_s,seed,width,height,num_frames,fps,cold,peak_vram_mb}` or `{error: "[code] message", error_code}`; `/status` exposes `error_code` (confirmed in the first gate run); I2V/V2V inputs are scaled to WIDTH x HEIGHT with a **centre crop**; measured: warm default clip 68 s (execution about 71 s), first clip after idle 291.5 s from submit to done (worker start 105 s plus model load 119 s), cold start 223 s, scale-down about 6 min after the last job despite a 60 s idle timeout, peak VRAM 43,473 MiB (default clip), about $0.034 per warm clip at $1.75/hr.

## Design

### Layout

```
ui/
  wrangler.jsonc          # name, main, compatibility_date, r2 binding, assets, limits, observability; NO secrets, NO email
  package.json            # exact versions: wrangler, jose, vitest, @cloudflare/vitest-pool-workers; lockfile committed
  src/index.js            # router, auth, CSRF, handlers (ES modules, no framework; a few small files)
  src/auth.js  src/runpod.js  src/limits.js  src/r2.js  src/errors.js
  static/index.html  static/app.js  static/style.css   # vanilla, no build step
  test/                   # vitest-pool-workers tests, fake JWKS server, RunPod stub
  .dev.vars.example       # names only
infra/cloudflare/
  apply.sh                # bash + curl against the Cloudflare API, same conventions as infra/runpod/apply.sh
  README.md
```

The Worker is plain JS (modules), no build step for the page. `jose` is the only runtime dependency and Wrangler bundles it (a bundle step exists for the Worker, not for the page; "no build step" applies to the front end, as in the spec).

### Request pipeline (every request, including static files)

1. **Fail closed on config**: if any of `TEAM_DOMAIN`, `POLICY_AUD`, `ALLOWED_EMAIL` is missing, answer 503 with no details.
2. **Verify Access JWT**: read `Cf-Access-Jwt-Assertion`; `jwtVerify` with algorithms `["RS256"]`, issuer `TEAM_DOMAIN`, audience `POLICY_AUD`; additionally require `payload.email` equals `ALLOWED_EMAIL` (case-insensitive). Any failure: 403, empty body. This runs even though Access sits in front, so a mis-scoped or disabled Access app, or a request that reaches the Worker by another hostname or a preview URL, still gets nothing.
3. **State-changing requests (POST/PUT/DELETE)**: require `Origin` equal to this Worker's own origin (or `Sec-Fetch-Site: same-origin`), and a custom header `X-Jubividia: 1`. No CORS headers are ever sent, so a cross-site page cannot call the API with the user's cookie even if it could force a request. JSON bodies only (`Content-Type: application/json`, max 16 KB) except upload.
4. **Route** (below). Anything else under `/api/` is 404; non-API paths go to `env.ASSETS.fetch(request)`.
5. **Response headers**: `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API JSON. Everything the page renders from a sidecar (prompt text) goes in via `textContent`, never `innerHTML`.

CPU: one JWT verify per request (RS256 via WebCrypto), plus JSON handling. Expected 1-3 ms, inside the Free plan's 10 ms. Set `limits.cpu_ms` only as a ceiling if it is accepted on the free plan (the docs say limits apply to the Standard usage model; verify at implementation, otherwise skip).

### Routes

| Route | Purpose |
|---|---|
| `GET /api/state` | One call for the page header: `{gpu: "asleep"\|"warm"\|"starting", workers:{idle,running,initializing,throttled,unhealthy}, usage:{today, cap, resets_at_utc}, active: null \| {job_id, mode, submitted_at, state}, limits, rate_usd_per_hr}`. Built from RunPod `GET /health`, the R2 usage counter and `state/active.json`. |
| `PUT /api/upload?kind=image\|video` | Streams the request body into R2 at a server-generated key; returns `{upload_key, bytes}`. |
| `POST /api/generate` | Validates, applies the guards, submits to RunPod; returns 202 `{job_id, expect:{cold_likely, est_total_s}}`. |
| `GET /api/status/:id` | Maps RunPod status to a UI state (below). `:id` must equal the id in `state/active.json` or be found under a recent job (see below), and must match `^[A-Za-z0-9-]{8,64}$`. |
| `POST /api/cancel/:id` | Cancels the active job via RunPod `/cancel/:id`. Optional but recommended in v1 (cheap, saves spend). |
| `GET /api/outputs?before=<YYYY-MM-DD>&limit=12` | Gallery page (below). |
| `GET /api/outputs/*key` (and `HEAD`) | Streams `.mp4`, `.jpg`, `.json` from R2 with Range support. Key must match the output key regex (below); nothing under `inputs/` or `state/` is ever served. |
| anything else | static files (`index.html`, `app.js`, `style.css`) via `ASSETS`. |

Delete-from-gallery, rename and re-run-with-same-input are out of v1.

### Input keys and uploads (never trust client keys)

- The client never sends an R2 key to be used as-is. `PUT /api/upload` generates `inputs/<crypto.randomUUID()>.<ext>` itself. `ext` comes from an allowlist keyed on `kind` and the validated `Content-Type`: image `image/jpeg` -> `jpg`, `image/png` -> `png`, `image/webp` -> `webp`; video `video/mp4` -> `mp4`, `video/quicktime` -> `mov`. Anything else: 415.
- Size: `Content-Length` is required and must be <= cap (image 20 MB, video 95 MB). The body is streamed into `env.BUCKET.put(key, body, {httpMetadata:{contentType}})`; the Worker never buffers it.
- Light content check on the first bytes (read the first chunk, check the magic bytes: JPEG `FF D8 FF`, PNG signature, `RIFF....WEBP`, mp4/mov `....ftyp`, then continue streaming the remainder). Mismatch: 415 and the partial object is deleted. Two-way door; if it proves fiddly it can be dropped, since the handler and ffmpeg reject garbage anyway.
- `POST /api/generate` takes `upload_key` (the string the Worker returned) and re-validates it with `^inputs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|mov)$`, checks the extension matches the mode (i2v needs an image, v2v a video), and `head`s the object so a missing upload fails with 400 here instead of a billed `[input_fetch]` failure on the GPU.
- The Worker is the only writer of `inputs/`. The handler's own rule ("key must be under `inputs/`") stays as a second check.

**Large phone videos.** The Free plan caps a request body at 100 MB (HTTP 413 above it). A 5-10 s phone clip is usually 10-60 MB at 1080p30 and can reach 100+ MB at 4K60 or ProRes. v1 therefore: a client-side check before upload (reject > 95 MB with "This clip is 138 MB; the limit is 95 MB. Trim it or pick Most compatible/1080p in the camera or share sheet"), plus a server-side `Content-Length` check. Two plans for later, both two-way doors: (1) **chunked upload through the Worker using the R2 multipart binding** (`createMultipartUpload` / `resumeMultipartUpload` / `uploadPart`, parts 5 MiB..90 MiB, key and uploadId carried by the client but the key is still server-generated and regex-checked) removes the 100 MB ceiling without S3 credentials or bucket CORS, and still fits the Free plan; (2) presigned S3 URLs, which would put R2 S3 keys in the Worker and need bucket CORS, which I do not recommend. Only the last 4 s of a V2V source are decoded (`GUIDE_WINDOW_S`), so a trimmed clip is all the model needs; a client-side trim is a nicety, not v1.

**Images.** The page downscales the chosen image on a canvas to a long side of 2048 px, JPEG quality 0.9, applying EXIF orientation (`createImageBitmap(..., {imageOrientation: "from-image"})`). That keeps uploads under about 2 MB, fixes rotated phone photos, and converts HEIC where the browser can decode it (iOS Safari). If decoding fails the page uploads the original and says so.

### Validation, caps and presets (server-side, authoritative)

The Worker rejects (400 with a readable message) rather than silently clamping. The client mirrors the same table so the user rarely sees the 400.

| Field | Rule |
|---|---|
| `mode` | `t2v`, `i2v`, `v2v` |
| `prompt` | 1 to 2,000 characters after trim (handler allows 8,000; no reason to) |
| `negative` | not exposed; the Worker does not forward one (CFG 1 ignores it, per the brief) |
| `preset` | one of the table below; the Worker maps it to width/height, so the client never sends raw numbers in v1 |
| `duration_s` | 2 to the preset's max; the Worker converts to `num_frames = 8*round(d*24/8)+1` at fps 24 (5 s -> 121). The Worker sends `num_frames` explicitly so the effective value is deterministic. V2V: at least 33 frames (about 1.4 s) |
| `fps` | fixed 24 in v1 |
| `seed` | optional integer 0..2,147,483,647; absent means the handler picks one (shown afterwards from the result) |
| `upload_key` | required for i2v/v2v, forbidden for t2v |

**Proposed caps (measured envelope).** Peak VRAM was 43.5 GiB at 1280x704x121 out of about 48 GiB, so there is little headroom, and the handler's 2048x2048x481 maximum is untested and almost certainly OOMs. Budget rule: width x height x frames must not exceed 1280 x 704 x 121 (about 109 M). Presets (all multiples of 64):

| Preset | Size | Max duration at 24 fps | Notes |
|---|---|---|---|
| Fast preview | 640x384 | 10 s (241 frames) | cheap sanity check; about 0.27 of the default pixels |
| Square | 832x832 | 6 s (145 frames: 109.0 M budget / 692 k = 157 -> 145) | |
| Landscape (default) | 1280x704 | 5 s (121 frames) | measured: 68 s warm |
| Portrait | 704x1280 | 5 s (121 frames) | same pixels as landscape |
| Wide-ish | 960x576 | 8 s (193 frames) | (553 k x 193 = 107 M) |

Two-way door: raising the envelope later is a config change after a gated "envelope run" (a longer or larger clip on the real endpoint, about $0.1-0.3 each, approved by Ken); the Worker table is the only thing to change. The handler-side hard limits stay as the last line of defence.

I2V/V2V inputs are **centre-cropped** to the chosen size. The page therefore auto-selects landscape/portrait/square from the file's aspect ratio, shows a crop preview overlay, and states "Edges are cut to fit".

### Spend and abuse guards

Layered, none relies on a hidden URL:

1. **Access** in front (primary), **JWT verification** in the Worker (defense in depth). An unauthenticated request never invokes the Worker and so cannot burn the 100k/day request quota.
2. **One active job.** `state/active.json` in R2 (`{job_id, submitted_at, mode}`). `POST /api/generate` returns 409 "A clip is already running" when the stored job is still `IN_QUEUE`/`IN_PROGRESS` (checked with one RunPod `/status` call) and clears the record when it finds it terminal. Combined with the RunPod endpoint's `workers.max` (currently 2; recommend 1 as a backstop, Ken's decision, applied with `apply.sh endpoint`), concurrency is at most one GPU worker.
3. **Daily attempt cap.** `state/usage/<YYYY-MM-DD>.json` (`{attempts, ...}`, UTC day, the same date convention as `outputs/`). Increment happens **before** `/run` using R2 conditional writes (read with its etag, `put` with `onlyIf: {etagMatches}`, retry up to 3 times); if `/run` then fails, decrement best-effort. Proposed cap: **20 attempts per UTC day**. Counting attempts, not completions, so failing jobs count too. Worst case at the cap: 20 x one 15-minute timeout would be about $8.75, a theoretical bound; realistic worst case is about $3 (20 cold default clips at about $0.14), and the RunPod balance (funded about $15) is the hard stop. This costs no extra Cloudflare resource (no KV, no D1); the usage objects are tiny and covered by a lifecycle rule.
4. **Job policy on every submit**: RunPod `/run` body `{input: {...}, policy: {ttl: 1200000, executionTimeout: 900000}}` so a queued job expires after 20 min (stuck LOW-stock queue) and a running job is bounded at the same 900 s as the endpoint. (`policy` is the job-level override mentioned in the endpoint review; confirm the exact field names against the RunPod docs/OpenAPI at implementation and with one canary.)
5. **Caps** from the table above, enforced server-side.
6. **Endpoint auto-pause awareness**: after 3 and 7 idle days RunPod lowers `workers.max` to 2 then 0 and `/run` returns a paused-endpoint error (409). The page maps it to "The GPU endpoint is paused after a quiet week. Ask Ken's coordinator to run `infra/runpod/apply.sh endpoint`" (the `README` documents this recovery). This is an expected state for a once-a-week tool.
7. Secrets: `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` exist only as Worker secrets; never sent to the browser, never logged, and RunPod error bodies are not forwarded raw (the Worker maps them to codes). RunPod base URL is a constant `https://api.runpod.ai/v2` in code; the Worker will not take a URL from any request.

### Mapping RunPod status to UI state

RunPod `/status/:id` returns `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT` (the Worker treats any other value as `running` and logs it). `GET /api/status/:id` also reads `/health` only while the job is `IN_QUEUE`, so it is at most 2 RunPod calls per poll.

| UI state | Rule | Message and expectation shown |
|---|---|---|
| `queued` | `IN_QUEUE` and a worker is idle/running (the job is about to start) | "Waiting for a free GPU slot..." |
| `starting` (cold start) | `IN_QUEUE` and `workers.initializing > 0` or no worker at all (`idle+running+initializing == 0`) | "Starting a GPU. The first clip after a quiet spell takes about 4-5 minutes in total: roughly 1.5-2 minutes to boot the GPU and about 2 minutes to load the 37 GB of model weights, then about a minute to generate. Later clips within a few minutes of each other take about a minute." Elapsed timer plus a progress hint, not a fake percentage. |
| `running` | `IN_PROGRESS` | The model load happens **inside** the first job (it is part of `gen_time_s`), so RunPod cannot tell loading from generating. If the page knew at submit time that the GPU was asleep (`cold_likely`), the label is "Loading the model, then generating (first clip after idle: about 3-4 more minutes)"; otherwise "Generating (about 1-1.5 minutes for a 5 s clip)". Expected time scales by `frames x pixels / default` for warm runs. |
| `done` | `COMPLETED` | Player loads `output.key`, shows the result card (below). |
| `failed` | `FAILED` | Friendly text from the table below, raw `[code] message` in a "Details" expander. |
| `cancelled` | `CANCELLED` | "Cancelled." |
| `timeout` | `TIMED_OUT` or `error_code == timeout` | "Took longer than the limit and was stopped." |
| `unknown/net` | the Worker cannot reach RunPod | The page keeps polling with backoff and says "Lost contact, retrying"; after 2 minutes of failures it shows the error but keeps the job id so a reload recovers (see persistence). |

Persistence: the active job id is in `localStorage` and in `state/active.json` (readable from any device via `/api/state`), so closing the phone tab or switching devices resumes the display. RunPod keeps a finished job's result for about 30 minutes, but the gallery (R2) is the permanent record, so a missed result is just a gallery entry. Polling interval: 4 s while queued/starting, 3 s while running, paused when the tab is hidden, exponential backoff on errors. A 5-minute clip is about 100 polls (about 200 RunPod calls); Free plan request budget and RunPod rate limits are not a concern.

Error texts (`error_code` from `/status`, falling back to the `[code]` prefix):

| Code | Shown to the user |
|---|---|
| `bad_input` | the handler's message (it is already readable) |
| `input_fetch` | "The uploaded file could not be read. Upload it again." |
| `oom` | "This size/length did not fit in GPU memory. Pick a smaller size or a shorter clip." |
| `timeout` | "Took too long and was stopped. Try a smaller size or shorter clip." |
| `model_missing`, `workflow_mismatch`, `config_error` | "The server is misconfigured (`code`). Not something to fix from the phone." |
| `comfy_unavailable`, `comfy_bad_response`, `comfy_error`, `output_missing`, `upload_failed` | "The GPU worker failed (`code`). Try again; if it repeats, tell Ken." |
| paused endpoint / RunPod auth errors | the specific hints above or "Cannot reach the GPU service" (never the key, never the raw body) |

### Gallery

`GET /api/outputs?before=<date>&limit=12` lists R2 in a way that gives newest-first without paging a whole bucket:

1. First call (no `before`): `list({prefix: "outputs/", delimiter: "/"})` returns the date "folders" (`outputs/2026-10-29/`, ...); take them in descending order.
2. For each date, `list({prefix: "outputs/<date>/"})` (a few dozen keys at most with a 20/day cap), keep the `.json` sidecars (a clip exists only if its sidecar was written last by the handler: use the sidecar as the "complete" marker), sort descending by key (the timestamp prefix sorts), and stop once `limit` items are collected. Return `next_before` = the oldest date fully included, or `null`.
3. For each item the Worker reads the sidecar (up to 12 R2 gets in parallel, comfortably inside the 1,000 Cloudflare-service subrequest limit, and R2 gets are Class B) and returns `{id, key, thumb_key, meta: {mode, prompt, seed, width, height, num_frames, fps, gen_time_s, cold, created_at}, est_usd}`. `est_usd = gen_time_s x rate / 3600` with `rate = GPU_USD_PER_HR` (a plain Worker var, 1.75). A missing sidecar field renders as blank, never an error (the page tolerates sidecar drift).

Card contents: thumbnail (`/api/outputs/<thumb_key>`, long immutable cache), mode badge, first two lines of the prompt, size and duration, `gen_time_s`, estimated dollars ("about $0.03 of GPU time; the first clip after idle also pays the GPU boot, about $0.05-0.10 more"), and a "Load" action that copies prompt/mode/seed/preset back into the form. Tap opens the inline player; a Download link uses `?download=1` (adds `Content-Disposition: attachment`). R2 listing cost: 1 to 3 Class A operations per page load, negligible. Outputs have no lifecycle rule (about 1 MB per clip; 10 GB free is about 10,000 clips).

### Streaming with Range (`GET/HEAD /api/outputs/*key`)

- Key regex: `^outputs/\d{4}-\d{2}-\d{2}/\d{8}T\d{6}-[A-Za-z0-9._-]+\.(mp4|jpg|json)$`; reject `..`, encoded slashes and anything else (404).
- `bucket.get(key, {range: request.headers, onlyIf: request.headers})`. Response: `Accept-Ranges: bytes`, `Content-Type` from stored metadata (fallback by extension), `ETag`, `Cache-Control: private, max-age=31536000, immutable` (keys are unique per job). If a `Range` header was sent and `object.range` is present, answer **206** with `Content-Range: bytes <offset>-<offset+length-1>/<size>` and `Content-Length: <length>`; otherwise 200 with `Content-Length: <size>`. Unsatisfiable range: 416 with `Content-Range: bytes */<size>`. No body in the result (precondition failed): 304/412. `HEAD` uses `bucket.head`.
- The R2 body is passed through as a stream; no CPU, no buffering.

### Page (mobile-first)

One column, 16 px gutters, large tap targets (>= 44 px), no horizontal scroll, system fonts, light and dark via `prefers-color-scheme`, no framework. Sections top to bottom:

1. **Status strip**: GPU "asleep / warm" badge with the honest cost of asleep ("first clip about 5 min"), today's usage ("3 of 20 clips today, resets 00:00 UTC"). From `/api/state`.
2. **Mode selector** (segmented control): Text, Image, Video continue. One line of help each (see V2V wording below).
3. **File picker** (I2V/V2V only): a single `<input type="file">` with `accept="image/*"` or `accept="video/*"` and **no** `capture` attribute, so a phone offers the photo library (camera roll) as well as the camera. Shows a preview (image or `<video>` poster), size, duration for video, and the client-side checks (size cap, video shorter than 1 s warns, unreadable file). Upload starts when Generate is pressed (so abandoned picks cost nothing) with an `XMLHttpRequest` upload progress bar.
4. **Prompt** textarea (2,000 char counter), placeholder with a good example (include "and sound" cues, because audio is generated from the prompt).
5. **Generate** button, disabled while a job is active or the daily cap is reached, and while the file is invalid. Subtext shows the expectation (warm: "about 1-1.5 min", asleep: "about 5 min") and the cost estimate.
6. **Progress card** (appears on submit): the state label and explanation from the table, **elapsed time** (mm:ss) updating every second, expected time, Cancel button, and on failure the friendly message plus Details.
7. **Result card**: inline `<video controls playsinline preload="metadata" poster=thumb>` (audio on, tap to unmute rules respected), Download, Share (Web Share API when present), and "Used: seed N, 1280x704, 5.04 s, 67 s of GPU, about $0.03".
8. **Advanced** (collapsed `<details>`): seed (number, blank = random, "reuse last"), resolution preset, duration slider (bounded by the preset's maximum; shows the frame count), and nothing else. Negative prompt is intentionally absent.
9. **Gallery**: grid of cards (2 columns on phones), "Load more" using `before=`.

Sizes and frame counts shown to the user are the effective ones returned by the worker (`width`, `height`, `num_frames`), not the requested ones.

### V2V continuation wording (shown under the mode selector and again in the preview)

"**Continue a video.** This does not edit your clip. It makes a *new* video that starts from the last second of yours (that second is repeated at the start) and carries on from there, following your prompt. The new clip has its own newly made sound; your original sound is not carried over, so joining the two will have an audible seam. Your original is not included in the result."

Under the result of a V2V job: "To join the clips, skip the first second of this new clip" (the first 25 frames, about 1.04 s). A client-side or server-side joiner (concatenate without the duplicated second) is a recommended nicety, not v1.

### Isolation from `jubilab-website`

- The Worker name is `jubividia` (to be confirmed); the Access app destination is this Worker's id only; the infra script lists existing Access apps first and refuses to continue if any existing app already covers our worker or hostname, and refuses to PATCH or DELETE any app whose name is not exactly `jubividia-ui`.
- The "Protect all Workers" setting is never used or even touched; the script contains no code path for account-level Access (grep-tested).
- `workers_dev` and `preview_urls` are set per Worker in `ui/wrangler.jsonc`; nothing sets or reads the account subdomain except a read-only check.
- Nothing in this design reads, calls, binds to, or routes to `jubilab-website`. The API token used by Wrangler is account-wide by nature (Cloudflare tokens cannot be scoped to one Worker), so the scripts hardcode our names and the token is revoked after the work (see "Cloudflare changes", step 1).

### Secrets and configuration

| Name | Kind | Where | Notes |
|---|---|---|---|
| `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` | Worker secrets | `wrangler secret bulk` from `config.env` via a safe reader (never `source`, same pattern as `lib.sh`) | never printed |
| `ALLOWED_EMAIL`, `TEAM_DOMAIN`, `POLICY_AUD` | Worker secrets | same | The repo is public, so Ken's email and the Access identifiers stay out of `wrangler.jsonc`. (They are not secrets in the cryptographic sense; the aim is not to publish them.) |
| `GPU_USD_PER_HR` (1.75), `DAILY_CAP` (20), limits table | plain vars in `wrangler.jsonc` | committed | no sensitive content |
| `BUCKET` | R2 binding to `jubividia-ltx-eu` | `wrangler.jsonc` | no S3 credentials in the Worker |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | local only | `config.env` (git-ignored; add to `config.env.example` names) | used by Wrangler and `infra/cloudflare/apply.sh`, never sent to the Worker |

`config.env.example` gains the new names (no values).

### Infra for Access (`infra/cloudflare/`)

`apply.sh` (bash + curl, `--dry-run`, read-back verification, no secret echo, refuses `bash -x`, same conventions as `infra/runpod/apply.sh`) with subcommands: `preflight` (read-only: token valid, workers.dev subdomain exists, Zero Trust org exists, lists Access apps and IdPs and fails if our name is taken or something unexpected would be affected, reads R2 lifecycle), `lifecycle`, `idp-otp`, `access` (create or reconcile the one app), `status`, `teardown-access` (deletes only the app named `jubividia-ui`). Application body (shape from the docs; field names to be re-checked against the Access applications API at implementation):

```
type: self_hosted, name: jubividia-ui
destinations: [{type: "worker", worker_id: <our worker id>}]    # fallback: a hostname destination for <name>.<sub>.workers.dev
session_duration: 24h, allowed_idps: [<one-time-pin idp id>], auto_redirect_to_identity: true
policies: [{name: "Ken", decision: "allow", include: [{email: {email: <Ken>}}], session_duration: "24h"}]
```

**Why not Terraform.** The spec says Terraform for Access. The v5 provider is maintained (v5.20.0, June 2026, 2-3 week cadence, declared stable in April 2026), but (a) I could not confirm that `cloudflare_zero_trust_access_application` supports the `worker` destination, (b) earlier v5 releases had perpetual-diff bugs on exactly this resource and on access policies, (c) it needs a state file (git-ignored local state, no remote backend) for one application, and (d) `infra/runpod` already set the precedent of a small idempotent REST script with read-back. Recommendation: bash + API, with Terraform noted as an alternative if Ken prefers (two-way door; the one Access app is easy to import or recreate). This is a deviation from the spec text, so it is a question for Ken.

### Local testing without touching Cloudflare

- `wrangler dev` (local mode, the default): R2 is simulated in `.wrangler/state`, static assets are served from disk, secrets come from `.dev.vars`. No Cloudflare API call is needed.
- Auth in dev and tests with **no bypass code in production paths**: tests generate an RSA key pair with `jose`, run a tiny fake JWKS server on 127.0.0.1 (or serve `/cdn-cgi/access/certs` from a test helper), set `TEAM_DOMAIN` to that URL and `POLICY_AUD` to a test value, and mint signed JWTs (valid, wrong aud, wrong issuer, expired, wrong email, `alg: none`, missing). The production code has only the one verification path.
- RunPod is faked: `fetchMock` from `cloudflare:test` if the installed `@cloudflare/vitest-pool-workers` still exports it (verify at implementation), otherwise a stub server and an injectable base URL that is a constant in production (set only in the test config).
- R2 behaviour (Range, conditional put, lists with delimiter, pagination) is tested against the Miniflare R2 simulation in `@cloudflare/vitest-pool-workers`.
- Page logic that does not need a browser (status mapping, caps, preset table, frame arithmetic) is plain modules unit-tested under Vitest. The mobile layout and the iOS Safari `<video>` Range behaviour are validated on the real phone (below).

### Optional niceties kept out of v1 (recommended order)

1. Chunked upload via the R2 multipart binding for videos over 95 MB.
2. A joiner for V2V that returns source + continuation without the duplicated second (needs ffmpeg; best done in the handler or in-browser with WebCodecs, not in the Worker).
3. "Keep warm for 10 minutes" button (spends money while idle; needs Ken's explicit approval and the idle-timeout decision).
4. Delete and favourite in the gallery; re-run with the same input while it still exists (inputs expire after 7 days).
5. Web Push or email on completion for the 5-minute cold path (Cloudflare Email would add a resource).
6. Server-side thumbnails strip or contact sheet; PWA manifest and "Add to Home Screen" icon.
7. Cost tab reading RunPod billing (belongs to the `cost` feature, `scripts/usage.sh`).

## Decisions

### One-way doors

| # | Decision | Why it is hard to reverse | Recommendation |
|---|---|---|---|
| 1 | **Worker name `jubividia`** (hence the URL `jubividia.<subdomain>.workers.dev`) | Renaming means a new URL, a new Access app, new bookmarks and new secrets. Small cost but nothing is automatic. Must not equal `jubilab-website`. | Confirm the name before the first deploy. |
| 2 | **Zero Trust team name** (only if the org does not exist yet) | It becomes the `TEAM_DOMAIN` baked into JWT issuer checks and login URLs; changing it breaks every Access app on the account. | Reuse the existing org if there is one; otherwise Ken picks the name himself. |
| 3 | **R2 lifecycle expiry of `inputs/` after 7 days** | Expired objects are deleted permanently (this is Ken's earlier decision). | Apply as decided; it is scoped to `inputs/` only. |
| 4 | **Gallery depends on `outputs/<UTC date>/<timestamp>-<job>.json` as the "clip is complete" marker** | Already fixed by the worker contract; the UI hard-depends on it (and tolerates missing sidecar fields). | Keep; documented in this note. |
| 5 | **Server-generated input keys `inputs/<uuid>.<ext>` with the extension allowlist** | Stored inputs and the handler's key check depend on it; the extension also decides the ComfyUI loader behaviour. | Keep. |
| 6 | **No Cloudflare-side state beyond R2** (no KV/D1) | Adding KV/D1 later is easy; the one-way part is where usage counters live: R2 `state/` keys (internal, can be migrated). | Keep R2 only. |

### Two-way doors

- Access scope: per-Worker application (recommended) vs hostname application: either can be swapped by deleting and recreating one app.
- Bash + API script vs Terraform for Access.
- Cap values (20 attempts/day, 95 MB uploads, the envelope table) and presets: config only.
- JWT email check in addition to Access (can be dropped; I recommend keeping it).
- Magic-byte sniffing of uploads.
- Cancel button, `GET /api/state` polling cadence, polling intervals, `ttl` of 20 min.
- Static assets served through the Worker (`run_worker_first: true`) vs inline strings: both are internal.
- `workers.max` 1 vs 2 on RunPod (`apply.sh endpoint`).
- Disabling `preview_urls` (can be re-enabled; Access per-Worker would cover them anyway).
- Thumbnail and card layout, wording, and the V2V explanation text.

## Questions for Ken

1. **Worker name.** May the Worker be called `jubividia` (URL `jubividia.<your-workers-subdomain>.workers.dev`)? It must differ from your existing `jubilab-website`; a different name is fine if you prefer one.
2. **Access automation.** SPEC says Terraform for Access. I recommend a small idempotent bash+API script (`infra/cloudflare/apply.sh`, same style as `infra/runpod/apply.sh`) because I could not confirm the Terraform v5 provider supports a per-Worker Access destination and v5 has had recurring-diff bugs on this resource. Script (recommended) or Terraform?
3. **Access scope.** Recommended: an Access application scoped to this one Worker (covers workers.dev and any preview URL), with preview URLs also turned off, and no account-wide "protect all Workers" (which would reach `jubilab-website`). OK?
4. **Zero Trust organization and login method.** I cannot see whether your account already has a Zero Trust organization (team name), for example one that already protects `jubilab-website`. If one exists, may I add the One-time PIN login method to it (an account-level setting; it would also appear as an option on any other Access app that allows all login methods)? If none exists, are you willing to create one on the Free plan yourself in the dashboard (a team name you choose, a payment method is requested but nothing is charged)?
5. **Size and length caps.** Proposed v1 envelope: width x height x frames must not exceed the measured default 1280x704x121 (5 s). Presets: 640x384 up to 10 s, 832x832 up to 6 s, 960x576 up to 8 s, 1280x704 and 704x1280 up to 5 s; no raw width/height entry. Raising it later needs a gated test clip (about $0.10-0.30 each). OK, or do you want to try bigger now?
6. **Daily and concurrency caps.** One active job at a time, and 20 attempts per UTC day (failed jobs count). Realistic worst case at the cap is about $3 a day and the RunPod balance is the hard stop. OK, or a different number? Also, set the RunPod endpoint `workers.max` to 1 as a backstop (a change on the RunPod side, not Cloudflare)?
7. **Large phone videos.** Free-plan Cloudflare rejects a request body above 100 MB. v1 would cap video uploads at 95 MB with a clear message; a Worker-based chunked upload (no new Cloudflare resources) would lift that later. Accept the 95 MB cap for v1, or build chunked upload now?
8. **Cloudflare API token.** The coordinator needs an API token for Wrangler and the Access/R2 steps, scoped to: Workers Scripts Edit, Workers R2 Storage Edit, Access Apps and Policies Edit, Access Organizations/Identity Providers/Groups Edit, and read access to Account Settings (for the workers.dev subdomain read). Cloudflare tokens cannot be limited to one Worker, so it could technically also touch `jubilab-website`; the scripts hard-code our names and refuse anything else. Are you OK creating it with a short expiry and deleting it right after the deployment?
9. **Cancel button in v1.** RunPod cancel of a queued job is clean; cancelling a job that is already running may not stop the GPU immediately (unverified). Include it in v1 and verify it with a tiny job during validation?
10. **Your email in the Worker.** To keep your email out of the public repo, it is stored as a Worker secret (and checked against the Access JWT as a second gate). OK?

## Concerns / risks

- **`ctx.access` does not work with Static Assets**, so JWT verification in the Worker is mandatory, not optional. If it is ever removed, Access alone remains (still safe), but the "wrong hostname / disabled Access app" safety net is lost.
- **Gap between Worker deploy and Access creation.** A Worker on workers.dev is publicly reachable the moment it is deployed. Mitigation: deploy first with no secrets and no Access identifiers (it fails closed with 503 on every request and has no RunPod key), create the Access app, verify the block, and only then set the secrets. The coordinator must follow the order.
- **Free-plan Worker budget**: 10 ms CPU and 100,000 requests/day. JWT verification per request (including thumbnails, 12 per gallery page) is the main CPU consumer; expected 1-3 ms. If CPU limit errors appear (error "exceeded CPU time limit") the options are fewer requests (sprite sheets) or the $5/month Paid plan; flag if seen.
- **Large uploads**: 100 MB hard cap (Cloudflare plan limit). HEVC `.mov` from iPhones: unverified that the ComfyUI `LoadVideo` path decodes HEVC and accepts the `.mov` extension; the validator must test a real phone clip before declaring V2V working. If it fails, the page should ask for "Most Compatible" format or the Worker should reject `.mov` HEVC early.
- **Cold-start honesty**: the first clip after idle is about 4-5 minutes and the scale-down after the last job took about 6 minutes (cause unknown), so "GPU warm" for several minutes after use is likely but not guaranteed; the badge reads RunPod `/health`, not a timer. The page cannot separate "loading the model" from "generating" (both are `IN_PROGRESS`), so the cold label is a hint based on what `/health` said at submit time.
- **Cancel semantics unverified** for a running job; the UI says "Cancelling..." and keeps showing the job until RunPod reports a terminal state.
- **Concurrency race**: the active-job record and usage counter in R2 use conditional writes, but two simultaneous submits from two devices could both pass the check in a rare race. Impact is one extra job; RunPod `workers.max` caps real concurrency. Acceptable.
- **R2 listing assumptions**: the delimiter list returns date prefixes; with the 20/day cap, a month is at most 600 clips; fine. If outputs are ever imported in bulk the page still paginates by date.
- **Sidecar drift**: the page reads `prompt`, `seed`, `width`, `height`, `num_frames`, `fps`, `gen_time_s`, `mode`, `cold`; the exact sidecar key names were not re-read in this note (the handler is the source). The gallery must treat missing keys as blank.
- **R2 lifecycle lag**: expiry is asynchronous; "7 days" means 7 to about 8. Inputs referenced by a very old gallery entry can no longer be reused.
- **Wrangler/Node versions**: Wrangler v4 is current and maintained (secrets config property, `wrangler check startup` added in 2026); pin an exact version in `package.json` and commit the lockfile. Remote bindings and the Workers Vitest integration require recent Wrangler (4.37+ for remote bindings).
- **Access login UX on a phone**: OTP emails come from `notify.cloudflare.com` and can land in spam; a 24 h session means one PIN per day per device. If Ken prefers, the "Cloudflare" identity provider (login with the Cloudflare account) is an alternative the Access app could list as well; I kept OTP because Ken specified it.
- **The Access `worker` destination via raw API is documented but not exercised by me**: the coordinator verifies with a dry run and read-back; fallback is a hostname destination plus `preview_urls: false`.
- **Terraform not used**: spec deviation (question 2).
- **Account-wide token** (question 8) is the largest isolation risk to `jubilab-website` in this feature; mitigated by hard-coded names, preflight listing and short token life, not by Cloudflare scoping.

## How the validator should test this

No Cloudflare writes and no GPU spend (everything local):

1. `npm ci` (lockfile) then the Vitest suite under `@cloudflare/vitest-pool-workers`:
   - **Auth**: no header, malformed token, wrong signature, `alg: none`, wrong issuer, wrong audience, expired, wrong email, right everything. All except the last give 403 with an empty body for every route including `/` and static files; missing config gives 503.
   - **CSRF/CORS**: POST/PUT without `X-Jubividia`, with a foreign `Origin`, with `text/plain`: rejected; no `Access-Control-*` header ever appears.
   - **Upload**: key is server-generated and matches the regex; disallowed content types 415; missing/oversize `Content-Length` rejected; magic-byte mismatch removes the object; large body streams (memory stays flat); client-supplied `key`/path parameters are ignored.
   - **Generate**: every validation row (prompt length, preset, duration vs preset max, seed range, v2v < 33 frames, upload_key regex and extension/mode match, nonexistent upload -> 400, t2v with upload_key -> 400); frame arithmetic (5 s -> 121, 10 s at 640x384 -> 241, never over budget); the exact JSON sent to a stubbed RunPod `/run` (no `negative`, `num_frames` explicit, `policy.ttl`/`executionTimeout`); the RunPod key only in the `Authorization` header; secrets absent from every response and log line.
   - **Guards**: second submit while a job is active -> 409; terminal active job is cleared; counter at the cap -> 429 with reset time; concurrent submits cannot exceed the cap by more than the documented race; a failed `/run` rolls the counter back.
   - **Status mapping**: table-driven over `IN_QUEUE` with/without workers, `IN_PROGRESS`, `COMPLETED`, `FAILED` with and without `error_code` (prefix fallback), `CANCELLED`, `TIMED_OUT`, unknown status, RunPod 401/409/500/non-JSON; user-facing text for each error code; no raw RunPod body leaks.
   - **Outputs/Range**: full 200; `bytes=0-99`, `bytes=100-`, `bytes=-50`, multi-range, out-of-range (416), `If-None-Match` (304), `HEAD`; `Content-Range` and `Content-Length` arithmetic; key regex rejects `inputs/...`, `state/...`, `..`, `%2e%2e`, `%2f`, double slashes, other extensions.
   - **Gallery**: delimiter-based date listing, newest first, `limit` honoured, pagination by `before`, sidecars with missing fields, a `.mp4` without a `.json` (incomplete clip) is skipped, > 1000 keys in a prefix uses cursors correctly.
2. `wrangler dev` (local, no `--remote`) smoke: page loads, mobile viewport (375x667 and 390x844) has no horizontal scroll, upload an image through the page to the local R2, `curl -r 0-99` gets a 206. Grep test: the UI source contains no `innerHTML` with sidecar data, no `eval`, no external script, no secret names in static files.
3. `infra/cloudflare/apply.sh` offline tests like `infra/infra.mk`: fake Cloudflare API on 127.0.0.1, `--dry-run` makes no writes, idempotent re-run makes none, refuses to touch an Access app not named `jubividia-ui`, contains no code path for account-level Access or the workers.dev subdomain (grep), never echoes the token, refuses `bash -x`, reconciles a drifted app with one PATCH.

Real-environment checks, run by the coordinator after Ken approves the plan (small spend only in step c):

a. After the Worker is deployed and Access exists: `curl -s -o /dev/null -w '%{http_code}'` against the workers.dev URL without a cookie must be a redirect to the team domain login (not 200); a request carrying a forged `Cf-Access-Jwt-Assertion` must still be 403 from the Worker; read the Access app back and assert its only destination is our Worker and that `jubilab-website` has no new Access app (list read).
b. From the phone: log in with the one-time PIN (check spam), confirm the 24 h session, load the page, upload a camera-roll photo and a short camera-roll video (include an iPhone HEVC `.mov`), and confirm `<video>` plays with sound and seeks (proves Range on iOS Safari).
c. Run a tiny clip end to end (T2V 640x384 about 3 s, about $0.03-0.14) and then the default clip while the GPU is asleep; verify the state sequence queued/starting -> running -> done with the elapsed timer, the cold explanation, the gallery entry (prompt, `gen_time_s`, estimated dollars), and a deliberate failure (I2V with a deleted upload, or oversize through a hand-crafted request) showing a readable message instead of a spinner (acceptance criterion 6). Test cancel on a queued job and, once, on a running tiny job, and report whether the GPU stops.
d. Spend guards: with the cap temporarily set to 2 in the Worker var (redeploy), the third submit is refused; a second submit while one runs is refused.
e. Lifecycle: `wrangler r2 bucket lifecycle list` shows the three rules scoped to `inputs/`, `state/` and multipart aborts; nothing under `outputs/`.
f. Confirm secrets: `wrangler secret list` shows exactly the five names; `curl` of every static path and API error body contains none of the secret values or names of RunPod endpoints.

## Cloudflare changes

Every change the coordinator will make on Ken's Cloudflare account, in order. Nothing is changed before Ken has seen this exact list. None touches `jubilab-website`, DNS, any zone, the workers.dev subdomain, or any account-wide Access setting.

| # | Change | What it affects | How to undo |
|---|---|---|---|
| 0 | **Read-only checks** (no change): workers.dev subdomain exists (`GET /accounts/{id}/workers/subdomain`); Zero Trust organization exists and its team name; list Access applications and identity providers; `wrangler r2 bucket lifecycle list jubividia-ltx-eu`; confirm no bucket lock rules; read our Worker id after deploy. If the subdomain does not exist, **stop and ask Ken** (it is account-wide). | nothing | n/a |
| 1 | **Ken creates a Cloudflare API token** (dashboard, manual) with the scopes in question 8 and a short expiry; Ken puts it in git-ignored `config.env` as `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID`. | Gives the tooling account-wide reach within those scopes. | Delete the token in the dashboard immediately after the work. |
| 2 | **R2 lifecycle rules on `jubividia-ltx-eu`**: `inputs-expire-7d` (prefix `inputs/`, expire 7 days), `state-expire-40d` (prefix `state/`, expire 40 days), `abort-multipart-1d` (abort incomplete multipart uploads after 1 day). Existing rules, if any, are preserved (read first, add only). | Deletes uploaded inputs after about 7 days and tiny usage files after 40 days. `outputs/` is untouched. | `wrangler r2 bucket lifecycle remove jubividia-ltx-eu --name <rule>`; objects already expired cannot be restored. |
| 3 | **Zero Trust: One-time PIN identity provider** (only if the org exists and Ken answered yes to question 4; if there is no org, Ken creates it first in the dashboard). | Adds a login method at the Zero Trust org level; it appears as an option on any other Access application that allows all login methods. Our app restricts itself to OTP only. | Delete the identity provider (`DELETE /accounts/{id}/access/identity_providers/{id}`) once no app needs it. |
| 4 | **Deploy the Worker `jubividia`** with Wrangler: `workers_dev` on, `preview_urls` off, R2 binding `BUCKET` -> `jubividia-ltx-eu`, static assets, plain vars (`GPU_USD_PER_HR`, `DAILY_CAP`), **no secrets yet**. It is deployed in a fail-closed state (503 for everything because the auth config is missing). | Creates one new Worker and its workers.dev route. | `wrangler delete --name jubividia` (never any other name). |
| 5 | **Create the Access application `jubividia-ui`** (API): destination = our Worker id (fallback: the exact workers.dev hostname), policy "Ken" = allow, email include = Ken's email, allowed IdP = one-time PIN only, session 24 h, auto-redirect to the IdP. Record its AUD tag. Verify with the unauthenticated `curl` redirect check and read-back of the app (only our destination). | Puts Access in front of our Worker only. | `DELETE /accounts/{id}/access/apps/{id}` for the app named `jubividia-ui` only. (Deleting it leaves the Worker publicly reachable but fail-closed on the JWT check, and without secrets it cannot spend anything.) |
| 6 | **Set Worker secrets** (`wrangler secret bulk`, from `config.env`, values never printed): `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, `ALLOWED_EMAIL`, `TEAM_DOMAIN`, `POLICY_AUD`. Only after step 5 is verified. | Makes the Worker functional: it can now submit RunPod jobs for a caller who passes Access. | `wrangler secret delete <NAME> --name jubividia` for each; deleting `RUNPOD_API_KEY` alone stops all spend. |
| 7 | **Smoke tests with no GPU** (page loads on the phone after PIN login, upload to R2, gallery empty/listing, forged JWT -> 403). Then one small generation (RunPod spend, about $0.03-0.14) as in "How the validator should test this", item c. | Writes test objects under `inputs/` and `outputs/` of our bucket; spends a few cents on RunPod. | Delete the test objects (`inputs/` expire by themselves; outputs can be deleted from the dashboard). |
| 8 | **Revoke the API token** from step 1 (Ken, dashboard). Later Worker updates need a new short-lived token. | Removes the standing account-wide credential. | Create a new token when needed. |

Not changed by this feature: the workers.dev subdomain, DNS or any zone, custom domains (a later custom domain is a separate change: add the domain to the Worker, move the Access destination, set `TEAM_DOMAIN`/`POLICY_AUD` as before), the R2 bucket itself and its S3 token, account-wide Access settings ("protect all Workers" stays off), `jubilab-website`, RunPod.

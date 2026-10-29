# ui - independent validation

Validator: independent (did not write the code). Branch `feat/ui`, commits aa3e42a, 85743fe, c0e41c0, 6db295c, 27d8215, 5fba358.
Hard limits observed: no Cloudflare API call, no RunPod call, no wrangler login or deploy, no config.env or .env read. The only outbound requests were `raw.githubusercontent.com` (the public `cloudflare/api-schemas` OpenAPI file) and `archive.ubuntu.com` (four library packages unpacked with `dpkg -x` into a scratch dir so a headless Chromium could start; nothing installed system-wide). Everything else ran on 127.0.0.1 against fakes, Miniflare R2 and `wrangler dev --local`.

## Verdict: ACCEPT WITH FIXES

The security core is sound. I could not defeat the auth gate (about 200 attack variants, all failed closed), could not get two jobs through the reservation, could not choose an input key, endpoint, bucket or job policy from the client, and found no secret or real address in the tree or history. The apply tool matches Cloudflare's real public schema on every route, method, field and unit it uses. The fixes below are small; none changes the architecture. **Do not skip F1 and F2 (they break the documented workflow and the lint gate); the rest are hardening and wording.**

| # | Fix | Who |
|---|---|---|
| F1 | `infra/cloudflare/apply.sh` is mode 100644 but README step 3 to 9 invoke it directly (`infra/cloudflare/apply.sh preflight`); `infra/runpod/apply.sh` is 100755. `git update-index --chmod=+x`. | engineer |
| F2 | With `shellcheck` installed, `bash tests/cloudflare/run.sh` fails (125 pass, 1 fail "shellcheck") and `make -f infra/cloudflare/cf.mk lint-cloudflare` exits 2: SC2034 `TOOL_NAME` in apply.sh line 16 (used by lib.sh; add `# shellcheck disable=SC2034`) and SC2126 in tests/cloudflare/run.sh line 93 (`grep -c`). The engineer's environment had no shellcheck so it never showed. | engineer |
| F3 | A reservation that never gets a job id can block for up to 37 minutes. If the Worker faults (an R2 error in `bumpUsage` or `updateActive`, an isolate dying) between `reserve()` and the end of `/run` handling, the record stays `state:"reserving"` with `job_id:null`. `classify()` only resolves `state:"unknown"` through `/health` after 120 s, so `reserving` stays `busy` until `STALE_RESERVATION_MS` (2,220,000 ms). Spend is not at risk (it fails safe), availability is. Treat a job-less `reserving` record older than about 120 s exactly like `unknown`. Also: if `updateActive` loses the CAS after `/run` succeeded, the job is untracked. Reproduced by test: a 10 minute old job-less record blocks with 409. | engineer |
| F4 | Page text "The run is capped at 15 minutes, about $0.44 at most" (also README, Ken's decision 5) counts only the 900 s execution cap. Worker boot (about 105 s measured) and the idle tail are billed too, so the true worst case is nearer $0.50 to $0.65. The reviewer already noted this. Reword ("about $0.44 of run time, plus GPU boot and idle time") or keep Ken's wording knowingly. | engineer or Ken (Q2) |
| F5 | `jwtVerify` accepts a correctly signed token with no `exp` claim (tested: 200). Cloudflare always sets `exp`, so this is hardening only: add `requiredClaims: ["exp"]`. | engineer |
| F6 | Cosmetic: `#me` ("Signed in as ...") has no wrap rule; a long address is clipped at the right edge at 390 px (screenshot). Add `overflow-wrap: anywhere` to `#me`. | engineer |

## 1. What I ran

| Command | Result |
|---|---|
| `npm --prefix ui test` (check-static + vitest, workerd/Miniflare) | check-static ok; 6 files, 112 passed (engineer's number reproduced) |
| `bash tests/cloudflare/run.sh` | 125 passed, 0 failed (shellcheck skipped: not installed) |
| `make -f infra/runpod/infra.mk test-infra` | 458 passed, 0 failed |
| `make test` | pytest 127 passed |
| `make -f infra/cloudflare/cf.mk test-ui test-cloudflare lint-cloudflare` | 112 + 125 passed; lint: `bash -n` ok, shellcheck skipped |
| scratch venv `pip install shellcheck-py`, `shellcheck -x -s bash infra/cloudflare/apply.sh lib.sh tests/cloudflare/run.sh` | 3 findings: SC2034 (false positive, TOOL_NAME used by lib.sh), SC1091 (info, lib.sh not followed without `-x -e SC1091`, the project's own flags remove it), SC2126 (style). See F2 |
| same with shellcheck on PATH: `bash tests/cloudflare/run.sh`, `make ... lint-cloudflare` | **fails** (125 passed, 1 failed; make exit 2). F2 |
| my attack suite `ui/test/validator-attacks.test.js` (new, 44 tests) via `npx --prefix ui vitest run --root ui` | 44 passed; whole ui suite now 7 files, 156 passed |
| `wrangler dev --config ui/wrangler.toml --local` (no secrets) | `/`, `/app.js`, `/api/state`, `/api/upload`, path-as-is `/../../.dev.vars`, forged JWT + spoofed email header: all 503 with empty body and full security headers. Real static-assets binding is not reachable before the gate |
| headless Chromium (playwright cache, libraries unpacked in scratch) against a stub server that serves the real `ui/static` files with the Worker's CSP | page renders (screenshot reviewed, 390 px); CSP blocks inline script, inline style, inline event handlers and `onerror` (console shows each violation); hostile prompt/email text appears as text and `document.title` is untouched |

Note: `validator-attacks.test.js` is a new file I added and committed with this report. It makes no network calls and changes no source file. Delete it if you only want the report; it also runs under `npm test`.

## 2. Conformance to the design, reviewer requirements and Ken's decisions

| Requirement | Status | Evidence |
|---|---|---|
| Worker `jubividia`, workers.dev on, preview URLs off (explicit) | PASS | wrangler.toml; check-static pins it; apply.sh `deploy` re-reads `/subdomain` and POSTs `{"enabled":true,"previews_enabled":false}` if different |
| JWT verified on every request incl. static, fail closed, empty body | PASS | index.js pipeline; `run_worker_first = true`; real `wrangler dev` smoke; section 3 |
| Two users via `ALLOWED_EMAILS`, case-insensitive, trimmed; empty fails closed | PASS | auth.js; tests; hostile variants below |
| `createRemoteJWKSet` at module scope, keyed by the operator-set TEAM_DOMAIN, 30 s tolerance, RS256 only | PASS | auth.js. Cache cannot be poisoned: the JWKS URL comes only from the secret, never from a token |
| Shared gallery and caps; `by` is a hash, not an address | PASS | `state/active.json` holds 8 hex chars |
| One active job via R2 CAS (`If-None-Match: *`, `etagMatches`), plus `/health` refusal | PASS | 10 concurrent submits: 1x 202, 9x 409, one `/run` call |
| Roll back only on definitive 4xx/5xx; timeout keeps lock and count; cancel keeps lock | PASS | tested incl. 400/401/404/409/429/500/503 |
| `DAILY_CAP` default 30, UTC day, failed attempts count, never negative | PASS | boundary, rollover at 23:59:30Z to 00:00:01Z, corrupt counters |
| Job policy ttl 2,100,000 / executionTimeout 900,000 constants | PASS | request body keys are exactly `input` and `policy`; client fields ignored |
| No UI size presets; handler bounds only (256..2048, multiples of 64, <= 481 frames, v2v >= 33) | PASS with a question | bounds enforced server and client. **Q1:** Advanced holds four "Size shortcuts" buttons (Landscape 1280x704, Portrait, Square, Fast 640x384). They only fill the free fields and limit nothing, but "Fast 640x384" reads as a preset |
| Untested warning beyond 1280x704x121 with worst-case cost | PASS (see F4) | |
| Uploads 95 MB video / 20 MB image, server key `inputs/<uuid>.<ext>`, allowlist, magic bytes, webm/HEIC/AVIF 415, no orphan on failure | PASS | section 4 |
| Cancel in v1 | PASS | |
| Gallery shows gen_time_s, peak VRAM, est. cost | PASS | screenshot |
| V2V wording | PASS | matches the design text |
| `UI_RUNPOD_API_KEY` != management key | PASS | apply.sh `secrets` refuses equal keys |
| Tooling token scopes only Workers Scripts Edit, R2 Storage Edit, Account Settings Read; no Zero Trust path | PASS | allowlist in `call_allowed()` |
| Never touch `jubilab-website` | PASS | section 6 |
| Sidecar-last invariant documented | PASS | docs/decisions/worker.md; field names match `worker/handler.py` lines 687-693 |
| README dashboard steps for Ken, local dev, costs | PASS with Q6 | steps 1 to 9 are consistent with apply.sh ordering |

## 3. Attempts to defeat the auth gate (most important)

Method: tokens minted with `jose` against a fake JWKS served through a fetch stub, run through the unmodified Worker in workerd (file `ui/test/validator-attacks.test.js`, group "VALIDATOR auth gate"), plus a live `wrangler dev --local`. Every denial must be 403 or 503 with an empty body.

| Attack | Result |
|---|---|
| no header; empty; whitespace; `a.b`; `a.b.c`; `....`; `Bearer <good>`; good token plus `.extra` or `x`; 100 kB string; control and non-ASCII characters | all 403, empty |
| `alg:none` (none/None/NONE/nOnE), good token with signature stripped | all 403 |
| HS256/HS384/HS512 signed with the public key as JWK JSON, SPKI PEM and raw modulus (algorithm confusion) | all 403 |
| header says ES256/PS256/RS512/RS384/EdDSA over an RS256 signature | all 403 |
| wrong issuer (other team, trailing slash, http, suffix, upper-case, empty, prefix) | all 403 |
| wrong audience: other, upper-case, trailing space, empty string, empty array, array without ours, missing; array that contains ours | all 403 except the last, which is accepted (valid per RFC 7519) |
| expired by 36 s and 1 h; nbf +120 s and +1 h | 403. Within tolerance (exp -10 s, nbf +10 s) accepted |
| no `exp` claim | **accepted (200)**, F5 |
| valid signature by an unknown key, with its own kid, with another key claiming kid-A; embedded `jwk`, `jku`, `x5u`, `x5c` headers; kid `../../etc`, empty, NUL, case or space variants, missing | all 403; every outbound fetch stayed on the configured team host |
| attacker-controlled `iss` pointing at an attacker team with their own key | 403; JWKS fetched only from the configured TEAM_DOMAIN; the genuine token still works afterwards (no cache poisoning) |
| kid rotation (new key appears in the JWKS) | the first request signed by the new key inside jose's refetch cooldown got 403; a reload after the cooldown works (acceptable, F-info). 20 requests with an unknown kid caused 0 extra JWKS fetches (no amplification) |
| JWKS fetch failure: network error, HTML body, HTTP 500, empty key set, garbage keys | all 403 |
| JWKS hang | released after 5004 ms (jose's default timeout), 403, no stuck request |
| JWKS recovers after a failure | next request works (no permanent negative cache) |
| 30 concurrent cold requests | all 200; jose does not de-duplicate concurrent cold fetches (30 JWKS fetches), then 0 once cached. Informational: a page load on a cold isolate sends about one JWKS fetch per request |
| email: missing; array/object/number/bool/null; service-token shape (sub, common_name only); `mallory@`; `.evil` suffix; `x` prefix; `@@`; comma-joined pair; `;`; `+tag`; Cyrillic lookalike; NUL inside and after; dotted-I; zero-width space; empty; `*`; wildcard in ALLOWED_EMAILS | all 403 |
| email upper-case, surrounding spaces, trailing newline | accepted by design (the signed claim comes from Access; trim and lower-case) |
| `Cf-Access-Authenticated-User-Email`, `X-Forwarded-Email`, `X-Auth-Request-Email`, `Authorization: Bearer`, cookie `CF_Authorization=<good token>` without the header | all 403 on `/`, `/app.js`, `/api/*`: only the header is honoured |
| odd paths `//`, `///api/state`, `/api//state`, `/api/../`, `%2e%2e`, `%2f`, `/.`, `/..`, `/API/state`, trailing slash, `/.dev.vars`, `/src/index.js`, `/wrangler.toml`, backslashes, NUL; methods GET, HEAD, OPTIONS, DELETE, PATCH, TRACE without a token | all 403/503, empty. With a valid token none of them returns state, source or secret text |
| TEAM_DOMAIN / POLICY_AUD / ALLOWED_EMAILS missing, blank, whitespace, non-string, `http://`, with a path, `https://`; list of only commas or no `@` | all 503 or 403, empty. A blank POLICY_AUD never turns into "any audience" |
| denial responses | empty body, `Cache-Control: no-store`, CSP and other security headers present |
| real static-assets binding in the test pool | reachable only with a valid token |

I could not defeat the gate. The residual risks are outside the Worker: Access misconfiguration (policy listing the wrong emails), and a leaked Access session.

## 4. Spend guards, media and upload (Miniflare R2, real conditional writes)

Spend (group "VALIDATOR spend guards"):
- 10 concurrent submits with distinct request ids: exactly one 202, nine 409, one `/run`, usage 1. Two different users at once: 202 + 409.
- Same `request_id` 8 times concurrently: one job, one count, the same job id everywhere.
- Same `request_id` reused after the job finished creates a second billed job (documented; the page clears the id on end).
- `/run` network error: 502 `unknown_outcome`, lock stays (`state:"unknown"`), count stays, next submit 409. After 3 minutes with an empty `/health` it is released.
- 4xx/5xx from `/run`: lock released, count back to 0, no RunPod body in the response.
- Cancel on queued: lock stays until `/status` is terminal; RunPod then reports CANCELLED and an immediate resubmit is allowed when `/health` is empty. Cancel on running with the worker still in progress: resubmit refused (409). Cancel with garbage, traversal or path-like ids: 400/404/405, no RunPod call.
- Daily cap with `DAILY_CAP=2` shared by both users: third attempt 429 with `resets_at` 2026-10-30T00:00:00.000Z; at 00:00:01Z the next UTC day starts at 1. Cap 0 blocks everything. `-1`, `1.5`, `abc`, empty fall back to 30 (still 429 at 30 used). `1e9` is accepted as 1e9 (operator-set var, acceptable).
- Corrupt usage files (`-5`, `"3"`, not JSON, `[]`, `1e999`, `0.5`, `null`): treated as 0, never negative after a rollback.
- `/health` with jobs in flight: 409, no count consumed, no lock left.
- Stale reservation: a 40 minute old record is replaced; a record whose job RunPod does not know (404) is released. **A 10 minute old job-less `reserving` record blocks (F3).**
- Status for another user's job: allowed by design (shared). Unknown, malformed and traversal ids: 404/400. `GET /api/state` does not change the counter.
- Client-chosen keys: body with `input_key`, `key`, `bucket`, `endpoint`, `endpoint_id`, `policy`, `webhook`, `url`, `input`, `s3Config`, `__proto__`, `constructor`, `image_url`, `steps`, `cfg`, `negative` (also as raw JSON with an own `__proto__`): the RunPod request has exactly `input` and `policy`; `input` keys are `fps, height, input_key, mode, num_frames, prompt, width`; `input_key` equals the server-issued upload; policy is the constant. `upload_key` tricks (traversal, other prefixes, upper-case uuid, trailing newline or space, `.json`, URLs, arrays, objects, numbers, mode/extension mismatch, nonexistent): all 400.
- Numeric edges (31 cases: 2112, 255, 1281, 1280.5, string numbers, 482 frames, fps 0/61, duration 0/21/-1, seeds out of range, prompt 2001/blank/array, mode case): all 400. 2048x2048x481 at 60 fps is accepted, flagged untested, worst case $0.44. Huge or malformed bodies: 400/413.

Media and upload:
- Range matrix on a 1000 byte object (real R2 binding): `bytes=0-1` (the iOS Safari probe) 206 `0-1/1000`; `0-0`; `0-`; `999-`; `-1`; `-5000` (clamped to whole); open end beyond size; `1000-`, `1000-2000`, `99999999999999999999-`, `-0` 416 with `Content-Range: bytes */1000`; upper-case unit and surrounding spaces accepted. Multi-range, wrong unit, garbage, reversed, `bytes=`, `bytes=-`, decimals, hex, trailing `;x`: plain 200 with the full body. HEAD (with or without Range) 200 with `Content-Length`; `If-Range` match gives 206, mismatch 200; `If-None-Match` exact, list and `*` give 304. Every response carries `Accept-Ranges: bytes`.
- Zero-byte object: 200 empty; every Range 416; HEAD length 0.
- A sidecar stored with `Content-Type: text/html` is served as `application/json` with `nosniff`. Note: an `.mp4` key stored with `text/html` would be served as `text/html`; only the handler writes `outputs/`, so this is not reachable from the UI.
- Upload: Content-Length lying high or low: 400 and no object left; 96 MB, 999999999999 and 20,000,001 (image) claims: 413 before any read; no Content-Length (stream): 411; none of these leaves anything under `inputs/`.
- 23 extension/kind/type combinations: JPEG as png, PNG as jpg, mp4 as image, video as jpg, `text/html` type, ftyp brands `heic`, `mif1`, `avif`, `heix`, upper-case `HEIC`, webm, heic ext, `jpg/../x`, `jpg%00.png`, `__proto__`, `constructor`, `toString`, empty ext, `kind=../x`, missing kind: all 415/400, nothing stored. Short or non-ftyp bodies: 415. A JPEG header followed by HTML (polyglot) is accepted (magic bytes only), stored at a uuid key with `image/jpeg`, and `GET /api/outputs/inputs/...` is 404, so it can never be served back. Query `name=../../evil.html&key=state/active.json` is ignored.
- CSRF on upload: no header, foreign Origin, `Origin: null`, cross-site and same-site fetch metadata, Origin without the header: all 403, nothing stored.

## 5. The page

- XSS: all server and sidecar text goes through `textContent` or property assignment; the source guard forbids `innerHTML` and friends. Rendered with a hostile prompt (`<img onerror>`, `<script>`, `javascript:`, RTL override, emoji, 3000 characters) and a hostile email: shown as text, `document.title` unchanged. `Load` writes `.value`. Media URLs are built only from validated keys (Worker side) or the handler's own `output.key` (RunPod side, trusted; not re-validated in the browser, informational).
- CSP in a real browser blocks inline script, inline style, inline handlers and `onerror`; page works with CSP (no violation from `app.js`/`style.css`).
- No secrets in static files (check-static greps for the names; I read the three files: none).
- Session expiry: `fetch(..., redirect:"manual")`, opaque redirect or non-JSON gives a clear "sign-in may have expired: reload" message; XHR upload failure maps to the same; the picked file is kept in memory. Polling backs off 3 to 15 s and surfaces the message after 2 minutes.
- Polling cost: status every 3 s (running) or 4 s (queued), `/api/state` every 30 s while visible; each status call is 1 JWT verify, 2 R2 reads and 1 to 2 RunPod calls; a 5 minute cold clip is about 90 polls, far inside the 100,000/day free limit. Hidden tab: `pollOnce` stops, `visibilitychange` refreshes and resumes (read by inspection; not driven on a phone).
- Double tap: `S.busy` is set synchronously and the button disabled before any `await`; a retry after a network error reuses the same `request_id` (server returns the same job).
- Cost arithmetic checked: 68 s at $1.75/h = $0.033 (the page shows $0.033); cold 293 s = $0.142; 900 s = $0.4375 shown as $0.44 (F4 for what it omits).
- Mobile layout by inspection and screenshot: one column, 16 px gutters, 44 px targets, `overflow-x:hidden`, 2-column gallery at 390 px, light/dark tokens. Only issue: F6. A 320 px width and landscape were not rendered.
- Behaviour I could not drive without a click tool: the file picker, upload bar, progress card, result player, Share.

## 6. `infra/cloudflare/apply.sh` against Cloudflare's real schema

Source: `cloudflare/api-schemas` `openapi.json` (public, fetched 2026-10-29). Checked each route, method, request field, response field and unit.

| Used by apply.sh | Real schema | Match |
|---|---|---|
| `GET /user/tokens/verify`, fallback `GET /accounts/{id}/tokens/verify` | both exist | yes |
| `GET /accounts/{id}/workers/subdomain` (read only) | result `{subdomain}` | yes |
| `GET /accounts/{id}/workers/scripts` | result items have `id`, `created_on`, `modified_on` (no pagination parameter in the schema) | yes |
| `GET` and `POST /accounts/{id}/workers/scripts/{name}/subdomain` | GET/POST/DELETE exist; POST body `{enabled (required), previews_enabled}`; result `{enabled, previews_enabled}` | yes (POST, not PUT, is correct) |
| `GET` and `PUT /accounts/{id}/workers/scripts/{name}/secrets` | PUT body `{name, text, type:"secret_text"}` (all required); GET lists | yes |
| `GET /accounts/{id}/r2/buckets/{b}` and `/lock` | `/lock` GET returns `{rules: [...]}` | yes |
| `GET` and `PUT /accounts/{id}/r2/buckets/{b}/lifecycle` | body `{rules:[{id, enabled, conditions:{prefix (required)}, deleteObjectsTransition.condition:{type:"Age", maxAge:int}, abortMultipartUploadsTransition.condition:{type:"Age", maxAge}}]}`; `maxAge` in seconds (604800 = 7 d, 3456000 = 40 d, 86400 = 1 d match); `cf-r2-jurisdiction` header optional (default jurisdiction) | yes. An empty prefix for the abort rule is a valid string |

Mismatches: none found. Unverifiable offline: the exact error body when a bucket has no lifecycle (the script handles both 404 and an empty rules list), and whether `GET /accounts/{id}/workers/scripts/{name}/secrets` returns `[{name,type}]` (schema says list; script reads `name`).

Safety properties (code and my probes):
- Hard-coded names `jubividia`, `jubividia-ltx-eu`; every call passes `call_allowed()` (an exact method+path allowlist, account id forced to 32 hex). Nothing but the Worker `jubividia` (subdomain, secrets), its deploy via `wrangler deploy --name jubividia`, and `jubividia-ltx-eu` lifecycle (the only bucket write) can be modified. `R2_BUCKET` in config.env other than the fixed bucket is refused.
- No `DELETE` verb anywhere (grep test); no Zero Trust or Access route; the account `workers.dev` subdomain is read only (the tool dies on 404 and tells the operator to ask Ken).
- Lifecycle merge: reads existing rules, appends only missing ids, PUTs existing (verbatim) plus ours, reads back and compares every baseline rule byte for byte; a same-id rule with different settings aborts without writing. Idempotent (second run makes no write).
- Token handling: bearer goes through a process-substitution curl config, body through a pipe, `S_VALUE` through the environment of one child, redaction on every message; `bash -x` and `SHELLOPTS`/`BASH_XTRACEFD` are refused; the token reaches wrangler only through its environment. Not in output, argv or files in the offline run. Whether wrangler's own log files under `~/.config/.wrangler/logs` ever hold the token cannot be checked without a real run.
- `--i-confirmed-access` ordering is enforced in code: `secrets` refuses without the flag, re-runs the redirect probe (GET `/`, GET `/api/state`, forged JWT header) and aborts on anything but a redirect to `*.cloudflareaccess.com` (a 200, 503 or 403 means Access is missing or detached), validates all five values, refuses `UI_RUNPOD_API_KEY == RUNPOD_API_KEY`, then sets secrets and lists names. Deploy puts no secrets, so the Worker answers 503 until then.
- Baseline of `jubilab-website` `modified_on` is stored by `preflight` and re-compared in `deploy`, `postcheck`; a change stops the run. A recreated Worker (created_on differs from the recorded one) stops the run with the "Access app is bound to the old id" message.
- Test mode: set `CF_TEST_MODE=1` and every URL (API base and probe URLs) must match `^http://127.0.0.1:<port>(/path)?(?query)?$`. I tried `127.0.0.1:9@evil.invalid`, `127.0.0.1:9:80@evil.invalid`, `?a=b@evil.invalid` in the query, and `127.0.0.1.evil.invalid`: all exit 4 before any request. Weakness, by design: the guard is opt-in (the value must be exactly `1`); `CLOUDFLARE_API_BASE` is honoured in normal mode too, so a mistyped test-mode value (`true`) silently means production. I did not try that (it would reach the real host). Curl also reads `~/.curlrc` (add `-q`).
- Quirk: when the subdomain read fails inside `verify-access`, `$(worker_url)` returns an empty base and the error cascades ("TEST MODE refuses non-loopback URL /"); it still fails closed and no secret is written.

## 7. Hygiene

- No secret or real address in the tree (`git grep` for tokens, 32-hex ids, emails): only `example.test` fixtures and the sentinel strings in tests. History: `git log --all -p` grep for `rpa_`, `cfut_`, `cfat_`, JWT-shaped strings, private-key headers, the owner's address and `gmail` found none in file content. (The owner's real address is the commit author metadata of every commit, as before this feature; flagged only because the repo is public, Q7.)
- `.dev.vars`, `node_modules/`, `.wrangler/`, `.scratch/` ignored (`git check-ignore`). `ui/.dev.vars.example` has names only.
- Executable bits: `infra/cloudflare/apply.sh` is not executable (F1). Other new files match `infra/runpod`.
- `config.env.example` has `CLOUDFLARE_API_TOKEN`, `UI_RUNPOD_API_KEY`, `ALLOWED_EMAILS`, `TEAM_DOMAIN`, `POLICY_AUD` with correct comments; `RUNPOD_ENDPOINT_ID` and `R2_ACCOUNT_ID` already exist.
- README UI section is accurate against the code (limits, ttl 35 min, caps, upload sizes, step order). `npm run dev` cannot reach a signed-in state locally because `TEAM_DOMAIN` must be https and no helper is provided (Q6).
- Not broken: `make test` and the infra tests pass; `worker/`, `.github/` untouched by this feature (only `docs/decisions/worker.md` gained the sidecar-order note). The root Makefile and the CI workflow do not run the ui or cloudflare tests (Q8).
- Test noise: vitest prints `fixed-length pipe ended prematurely` and `Network connection lost` from the upload-abort tests; harmless.

## 8. What cannot be verified here, and what the coordinator must check read-only before each step

Cannot verify without real Cloudflare, RunPod or an iPhone:
- That the Access app is created by "Protect this Worker behind Access", covers workers.dev, lists both emails, and issues a JWT whose `iss`, `aud`, `email` and keys match the Worker's assumptions (`/cdn-cgi/access/certs` on the real team domain). `verify-access` proves only that an unauthenticated request is redirected.
- Real R2 conditional-write atomicity (Miniflare is faithful here but is not the service); the design asked for one two-request race proof against the real bucket.
- Real `/run` `policy` field acceptance, `/cancel` behaviour on a running job and what it bills, `/health` job counts lagging, a RunPod key restricted to the endpoint actually working for `/run`, `/status`, `/health`, `/cancel`.
- iOS Safari: `<video>` playback with the 206 path, HEIC-to-JPEG conversion by the picker, iPhone HEVC `.mov` through the worker, the camera-roll picker, Share sheet, 95 MB upload over mobile, OTP email delivery and the 24 h session.
- The wrangler token-scope sufficiency (deploy with only Workers Scripts Edit + Account Settings Read + R2 Edit), Worker CPU on the free plan (10 ms) with a real JWT verify, and wrangler's own log content.

Coordinator read-only checks (no writes):
1. Before `preflight`: `config.env` mode 600, token scopes shown in the dashboard are exactly the three, short expiry; `R2_ACCOUNT_ID` is the account that hosts `jubividia-ltx-eu`.
2. After `preflight` (read-only): the baseline file lists `jubilab-website` with a `modified_on`; the workers.dev subdomain exists; read the existing R2 lifecycle rules and bucket lock list yourself and confirm the planned adds are only the three ids; review `lifecycle --dry-run` output.
3. Before `deploy`: `git diff` of `ui/wrangler.toml` (name, `preview_urls = false`, `workers_dev = true`, `run_worker_first = true`, bucket); `apply.sh deploy --dry-run`; `ui/node_modules/.bin/wrangler` exists (`npm ci`). After: `workers_list` shows `jubividia` as new and `jubilab-website` `modified_on` unchanged; `GET .../workers/scripts/jubividia/subdomain` shows enabled true, previews false; an unauthenticated `curl` of the workers.dev URL returns 503 (no secrets yet).
4. Before Ken creates the Access app: confirm Worker id from the list; after Ken creates it: read the app in the dashboard (destination is this Worker only, "Allow" policy with exactly the two emails, session 24 h, OTP method), and that no account-wide "protect all Workers" is on. Then `verify-access`.
5. Before `secrets --i-confirmed-access`: Ken has logged in on the phone with both emails; `TEAM_DOMAIN` has no trailing slash and the AUD tag is the new app's; `UI_RUNPOD_API_KEY` is confirmed restricted and different from the management key; `apply.sh secrets --dry-run`. After: secret names list shows exactly five.
6. After the first real clip: `postcheck`; compare `jubilab-website` `modified_on`; read R2 `state/` and `inputs/` keys; check RunPod billing for the test job; then Ken revokes the token.

## Numbered questions

1. **Size shortcuts.** Is the "Size shortcuts" row (Landscape/Portrait/Square/Fast 640x384) acceptable under "no UI size presets", or should it be removed (or renamed so no button looks like a recommended preset)? Owner: Ken/coordinator.
2. **Worst-case cost wording.** Keep "about $0.44 at most" (Ken's decision 5) or add boot and idle time (about $0.50 to $0.65)? F4.
3. **F3 scope.** Should a job-less `reserving` record resolve through `/health` after about 120 s (like `unknown`)? I recommend yes.
4. **`exp` required (F5).** Add `requiredClaims: ["exp"]`? Recommend yes.
5. **F1 and F2** (execute bit; shellcheck-clean lint): engineer to fix before the coordinator runs the tool; confirm after fixing that `make -f infra/cloudflare/cf.mk lint-cloudflare` passes with shellcheck installed.
6. **Local development.** `TEAM_DOMAIN` must be https, so `npm run dev` never gets past 503 on a laptop. Accept (tests cover it), or add a documented dev-only way to serve a fake JWKS over https without any bypass in the Worker?
7. **Commit author email.** Every commit in this public repo carries the owner's real Gmail address as author metadata. Intended?
8. **CI.** Should `.github/workflows` (or the root `make test`) also run `npm --prefix ui ci && npm --prefix ui test` and `tests/cloudflare/run.sh`? Today nothing in CI covers the ui.
9. **Shared cancel.** Either allowed user can cancel the other's running job (shared lock, by design). Accept?
10. **Test mode.** Make the apply tool's test-mode guard fail safe (for example refuse any `CF_TEST_MODE` value other than `0`/`1`, and ignore `CLOUDFLARE_API_BASE` unless test mode is `1`)? Low risk; hardening.

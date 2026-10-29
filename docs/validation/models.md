# models: independent validation

Validator: independent of the engineer and architect. Date 2026-10-29. Branch `feat/models` at `0421bc4`. No code was changed. No RunPod or Cloudflare calls, no token used, `config.env` and `.env*` not read. Scratch scripts lived outside the repo (`$CLAUDE_JOB_DIR/tmp`) and are not committed.

## Verdict: ACCEPT WITH FIXES

The script is sound where it matters most: no weight file can reach its final name without a size and sha256 match, `--prune` is confined to `<volume>/models` and never follows a symlink, a bad `--update-lock` reply never touches the lock, and the token did not show up in argv, `bash -x` output, logs, error messages or the lock in any test. The lock's paths and sizes match the real public repo at the pinned commit. The fixes below are small and none changes the design.

Blocking before merge (engineer):
- F1. `make test-models` is red: 3 of 67 tests fail because they still assume the lock has `null` hashes (the coordinator's commit `0421bc4` filled them).
- F2. README "The sha256 lock" section is stale: it says the lock is committed with all hashes `null`, that the script refuses while pending, and tells Ken to run `--update-lock` first. The lock is now filled.

Should fix (engineer, low effort): F3 to F8 in the table of findings. Items for Ken are in "Questions".

## 1. What I ran

All from `/home/ken/jubividia/.claude/worktrees/agent-a64d72484c176d9dc`.

| Command | Result |
|---|---|
| `make -f scripts/models.mk test-models` | exit 2. "64 passed, 3 failed". Failures: `real lock: hashes all pending`, `refuses download while hashes pending, points to --update-lock`, `pending refusal made no HTTP request and wrote nothing`. All three encode the old null-hash state (tests/models/run.sh lines 85 and 102-104). The engineer's "67 pass" was true before `0421bc4`. |
| `make -f scripts/models.mk lint-models` | `bash -n` passes; then `make: shellcheck: Command not found`, exit 127 (not installed on this machine). |
| `python3 -m venv $CLAUDE_JOB_DIR/tmp/venv`, `pip install shellcheck-py`, then `shellcheck scripts/download-models.sh tests/models/run.sh` | ShellCheck 0.11.0: no findings, exit 0. |
| Unauthenticated `GET https://huggingface.co/api/models/Lightricks/LTX-2.5/tree/49b093a39c19169a8a81721dcc541e07e945232f?recursive=true` | HTTP 200, 23 entries, 17 files. The tree is public; LFS oids are masked (`************`). |
| Unauthenticated `HEAD .../resolve/49b093a.../model_patches/ltx-2.5-duration-head-bf16.safetensors` | HTTP 401, `x-error-code: GatedRepo`, "You must have access to it and be authenticated". No bytes of weights fetched. |
| `git grep` for `hf_[A-Za-z0-9]{20,}` and `Bearer <token>`; `git log -S` for tokens | nothing in tree or history (only the fixture string `hf_TESTTOKEN_do_not_leak_12345` in tests, and the word "hf_transfer" in the design note). |

## 2. Lock versus reality (no weights downloaded)

| Check | Result |
|---|---|
| Every path in the lock exists in the repo tree at `49b093a` | 9 of 9 present. |
| Every size in the lock equals the tree's `lfs.size` | 9 of 9 equal. |
| Default total | 41,427,929,848 bytes, equals the design note. |
| Header `rev=49b093a39c19169a8a81721dcc541e07e945232f`, `rev_date=2026-10-11` | matches Ken's pin and the design note. |
| Layout versus `worker/extra_model_paths.yaml` (feat-worker, read only) | Lock folders are `diffusion_models, text_encoders, vae, latent_upscale_models, model_patches, loras`: all six exist as keys in the yaml (`base_path: /runpod-volume/models`). The yaml also lists `checkpoints/`, which the lock does not use (harmless). |
| sha256 values (the 9 hex strings) | **Could not be verified.** HF masks `lfs.oid` for unauthenticated callers and `resolve` needs a token, so the values are trust-on-first-use as designed. Checked only that all are 64 hex and none repeat (no copy-paste duplicate). Note: the distilled and dev int8 transformers have the identical size 21,504,034,224, so size cannot distinguish them; only the hash can. |
| Other repo files | The tree also holds the dev int8/bf16 transformers, distilled bf16/nvfp4, bf16 encoder: none are in the lock, consistent with SPEC §2 and Ken's decisions. |

## 3. Conformance to Ken's binding decisions and the design note

| Requirement | Status | Evidence |
|---|---|---|
| 80 GB volume, about $5.60/mo | Conforms | README step 2 and cost note: 80 x $0.07 = $5.60. SPEC §2/§7 still say ~100 GB / ~$7 (README states it corrects SPEC; SPEC itself is Ken's file and unchanged). |
| Default set = 5 required + conv VAE + temporal upscaler + duration head = 41,427,929,848 B; LoRA optional | Conforms | lock `default` rows total exactly that; LoRA is `optional`, fetched only with `--with-lora` (tested). |
| `--prune`, with `--dry-run` | Conforms, see section 4 | |
| Standard tier | Conforms | README step 2. |
| sha256 TOFU pinned to commit `49b093a...` | Conforms | lock header; downloads use `/resolve/<rev>/<path>`. |
| Public repo, plain `git clone`, no credentials | Conforms | README step 4. The clone URL `https://github.com/ken-ck-yu/jubividia` was not checked for being public (see Q3). |
| HF_TOKEN only via env on the pod, never printed or logged | Conforms | see section 4, token tests. |
| Layout `/runpod-volume/models/<category>` | Conforms | section 2. |
| Design: `loras/` created empty because yaml references it | **Deviates (F6)** | `mkdir -p` only for directories of files actually fetched; a default run never creates `loras/` (or `checkpoints/`). ComfyUI tolerates missing folders, so low impact. |
| Design: `--only <substr>` flag | Not implemented | Listed as two-way door; not needed now. |
| Design: curl `--retry 5` | Replaced | explicit 6-try loop with `-C -` (justified in a code comment: curl's own retry restarts from byte 0). Behaves correctly in tests. |
| Design note body | **Stale (F7)** | Summary and Door 1 still say 60 GB / $4.20; only the "Reviewer" section moved to 80 GB. CLAUDE.md also requires the Phase 7 summary in `docs/decisions/models.md`; it has not been added. |
| `config.env.example` gets an `HF_TOKEN=` line (design, CLAUDE.md "documents every variable") | **Not done, and the file does not exist** on this branch or on `main` | Not duplicated (nothing to duplicate), but the HF_TOKEN variable is undocumented there. See Q4. |
| Executable bits | OK | `scripts/download-models.sh` is 0755; `run.sh`/`mock_hf.py` are 0644 but invoked via `bash`/`python3`; `models.mk` invoked by make. |

## 4. Attempts to break it

Harness: the engineer's mock HF server plus my own fixtures (up to 60 MB files), fake volume directories, and a second fake API server returning bad replies. Results:

| Attack | Result |
|---|---|
| Truncated final file (1 byte short, and 0 bytes) | Re-downloaded, content identical. PASS |
| Same-size bit flip in a final file | Normal run says `skipped` (trusts size, as documented); `--verify` reports `BAD-HASH`, exit 1. PASS as designed. Note the gap in F8. |
| Server serves corrupted bytes (CDN corruption) | Partial deleted after hash mismatch, one automatic retry, then `FAILED`, exit 1, no final file for it. PASS |
| Garbage `.partial` smaller than the file / exactly full size / larger than the file | Each: mismatch detected, partial discarded, clean re-download, correct content, exit 0. PASS |
| Final exists with wrong size, then server answers 403 | exit 1 with the license message; the old wrong-size file is left in place (deleted only once a download is attempted). PASS |
| SIGKILL of script and curl mid-download, rerun | `.partial` files kept, rerun resumed/verified and renamed, `--verify` OK. PASS |
| "Full disk" via `ulimit -f` (curl cannot write more than 20 MB) | curl dies on every try, 6 tries per file, partials kept, table shows `FAILED`, exit 1, no final files, no bogus `.manifest-rev`. PASS (a real ENOSPC was not reproduced; the free-space pre-check is covered by the engineer's tests). |
| Missing / empty HF_TOKEN | "HF_TOKEN is not set", exit 1. PASS |
| Wrong token, token with trailing space, token containing `"` | 401 message naming the token problem; token not echoed. PASS |
| **Token with a trailing newline** (common when pasting into a pod env var) | curl prints `option --config: error encountered when reading a file`, and the script then reports "no HTTP response ... (network problem?)". No leak (token occurrences in output: 0), but the message is misleading. Finding F3. |
| 401 and 403 | Distinct messages; 403 names `https://huggingface.co/<repo>` and "SAME account". Token absent from output. PASS (against the mock only; see section 5) |
| Non-mountpoint volume root, missing volume root | Refused, nothing written (engineer's tests; `VOLUME_ROOT=/` and empty are also rejected: `/` is stripped to empty and dies). PASS |
| `SKIP_MOUNT_CHECK=1` misuse | Prints a WARNING on every run; effect is limited to `<root>/models` and `<root>/workflows`. A variable left exported in a shell profile would silently disable the guard apart from that warning line. Acceptable, documented. |
| **`--prune` safety**, adversarial tree: symlinks to files and directories outside, a symlinked subdirectory, relative symlink to `<volume>/other/`, names with spaces, newline, leading `-`, `*`, `@`, `]`, and `$(touch PWNED).bin` | 14 orphan entries removed (the symlinks themselves, never their targets). Outside files and dirs intact; `<volume>/other/` and `<volume>/workflows/` intact; no command injection (`PWNED` not created); locked file and its dir kept. `--dry-run` listed exactly the same 14 and removed none. PASS |
| `--prune` when `models` itself is a symlink to an outside dir | "0 file(s) removed", outside file intact. PASS |
| `--prune` with header-only lock / zero-byte lock / unreadable lock (chmod 000) / missing lock / lock with `../` path | All exit 1 and delete nothing (empty: "lock has no entries"; unreadable: bash "Permission denied", exit 1; traversal path: "bad path in lock"). PASS |
| `--prune` with a **truncated but syntactically valid** lock (header + 1 entry) | Deletes every file not in that one entry (3 files in my test). Expected by design (the lock is the truth) but dangerous if the lock is damaged or half-edited. The lock is in git and `--dry-run` exists. Finding F5 (suggestion). |
| `--update-lock` against bad replies: HTML body, non-hex revision sha, empty tree `[]`, truncated JSON, pagination `Link` pointing to another host, non-hex oid | All exit 1, lock byte-identical afterwards (sha256 compared), no temp dirs left, the evil pagination host was never contacted ("pagination link leaves ..."). PASS. Messages for malformed JSON are a raw Python traceback (cosmetic). |
| Two concurrent runs on one volume | No locking. Both exited 1 with a raw `mv: cannot stat ... .partial` message and "FAILED (no result)"; the data on disk ended valid (`--verify` all OK) but a rerun is needed. Finding F4. |
| `JOBS=0` | Infinite busy loop (timeout after 10 s). Env-only misuse. Finding F4. |
| Token exposure: `bash -x` over a full run (331 trace lines) | 0 occurrences of the token, 0 of "Bearer". Token never in the lock, volume, or `.manifest-rev`. PASS |
| Token exposure: argv | The script passes the header via `--config <(...)`, so curl's argv is `--config /dev/fd/N`; no `ps` line other than my own mock-server fixture carried the token. PASS |
| Cross-host redirect | Engineer's test confirms the token is not sent to the redirect (CDN) host; relies on curl's default of stripping `Authorization` on a host change. Real CDN behaviour is unverified (section 5). |

## 5. Hygiene

- No secrets in tree or history. `.gitignore` covers `config.env`, `.env*`, `*.safetensors`.
- README commands match the script (`--verify`, `--prune [--dry-run]`, `--update-lock [--rev]`, `--workflows-only`, `--with-lora`, `--list`, `--volume-root`, `SKIP_MOUNT_CHECK`). Cost $5.60/mo is right. Two inaccuracies: (a) the lock section described above (F2); (b) "`lint-models` runs `bash -n` and `shellcheck` when installed": the make target fails with exit 127 if shellcheck is missing (F1).
- The "3-7 minutes for 41 GB" estimate ignores local sha256 time (roughly 2 to 3 more minutes for 41 GB at about 300 MB/s per hash stream) and the volume's write throughput. Treat as unmeasured.
- Second run is idempotent and trusts file size only (by design). `.manifest-rev` is written after a run in which skipped files were never re-hashed, so it records "last successful run", not "all hashes verified". The README recommends `--verify` as optional.

## 6. Findings for the engineer

| ID | Severity | Finding | Suggested fix |
|---|---|---|---|
| F1 | Must | 3 tests fail on the filled lock; `lint-models` hard-fails without shellcheck. | Make the pending-hash tests use a synthetic null lock (as `lock.null` already exists in run.sh) instead of `REAL_LOCK`; invert the "hashes all pending" check to "no nulls"; guard shellcheck with `command -v` or document installation. |
| F2 | Must | README lock section stale (says null/pending, tells Ken to run `--update-lock`). | Rewrite: lock is filled, how it was generated, when to re-run. |
| F3 | Should | Token with trailing whitespace or newline gives a misleading "network problem". | Reject `HF_TOKEN` containing whitespace/control characters in `require_token` (check length and pattern only, never print it); this also closes curl-config injection via a crafted token. |
| F4 | Should | No run lock; `JOBS` not validated. | `flock` on `$MODELS_DIR/.lock` (or a mkdir lock) with a clear message; require `JOBS` to be an integer >= 1. |
| F5 | Could | `--prune` trusts a truncated lock. | Optionally require the lock's default entry count/total to match `.manifest-rev` or warn when more than N files would be removed; at minimum the README should say "always `--dry-run` first". |
| F6 | Could | Design says `loras/` is created empty; script does not create it. | `mkdir -p` the categories listed in the lock's contract (or all six) in `do_download`. |
| F7 | Should | Design note summary and Door 1 still say 60 GB; no Phase 7 summary. | Add the Phase 7 section recording Ken's final decisions (80 GB, prune, standard tier, TOFU lock, public clone) and mark the 60 GB text superseded. |
| F8 | Could | Size-only skip means a same-size corrupt file survives re-runs; `.manifest-rev` can imply more than was checked. | In the README setup steps make `--verify` mandatory after the first download, not optional; consider a `lock_verified=yes/no` line in `.manifest-rev`. |

## 7. What cannot be verified without a real pod, volume or token

1. Real gated behaviour with a valid token: whether `HEAD resolve` returns 302 (accepted by the script) and what exact status a token without the license returns. I only observed the unauthenticated 401 with `x-error-code: GatedRepo`. 403 handling is tested against the mock only.
2. The real CDN redirect and Xet/signed-URL behaviour: that curl drops `Authorization` on the cross-host hop, and that `-C -` resume works against the real CDN URLs (the mock uses a different hostname, which exercises the same curl rule, but is not the real thing).
3. The sha256 values themselves (masked without a token).
4. That `mountpoint -q` succeeds on the real pod mount (`/workspace` or `/runpod-volume`), and a deeper gap: the guard cannot tell a network volume from the pod's own local volume disk, which is also a mountpoint at `/workspace`. If the network volume were not attached, the script could write 41 GB to the local disk if it has room. Mitigation idea: print `df -h` and the filesystem type of the volume and compare size to about 80 GB.
5. Throughput, total run time, and whether the pod's own disk/CPU make the sha256 pass dominate.
6. Stock: a CPU pod (or the GPU fallback) in US-WA-1, and the RTX 6000 Ada serverless stock there.
7. A real out-of-space (ENOSPC) event; I simulated only with a file-size limit.
8. That a volume resize works hot (documented only as "can be increased").
9. That `extra_model_paths.yaml` resolves each category inside a real ComfyUI worker.

## 8. Questions

1. Fixes F1, F2 and F7 are needed before merge; who owns them? (Engineer, I assume.) Do you want F3 and F4 done now or accepted as known limits for a one-off, supervised run?
2. After the first real run, will you do a full `--verify` before declaring the volume good (recommended, about 2 to 3 minutes of hashing) and record the elapsed time and download speed in the README?
3. Is the GitHub repo `ken-ck-yu/jubividia` actually public today? The clone step fails otherwise, and I could not confirm it without leaving the allowed scope.
4. `config.env.example` does not exist anywhere in the repo, yet CLAUDE.md says it documents every variable and the design promised an `HF_TOKEN=` line. Should the `models` branch create it (risk: conflict with other feature branches that will also create it), or will the first feature that needs it own the file?
5. The lock is trust-on-first-use. Do you want the 21.5 GB transformer hash cross-checked against a second source, as the lock header and review suggest? (The int8 ComfyUI build appears to have no second public source, and the dev and distilled int8 files have identical sizes, so a swapped file would pass the size check.) A lighter option: compare one hash against the "SHA256" shown on the file's page in the browser while logged in to Hugging Face.
6. The mount guard cannot distinguish the network volume from the pod's local volume disk. Accept this (the free-space check and the 80 GB size look-up in step 2 of your own procedure cover most of it), or add a printed `df -h` line so you can eyeball the size before the 41 GB starts?
7. SPEC §2 and §7 still say a 100 GB volume at about $7/mo. Do you want SPEC updated to 80 GB at $5.60/mo, or is the README correction enough?

## Re-check after the fix round (commits 370c651, 2b499b1, 15a032c)

Verdict: **ACCEPT**. All of F1 to F8 and question 6 are resolved in behaviour, not only in text. Two minor residual observations (R1, R2) are noted and do not block.

### Commands and results

| Command | Result |
|---|---|
| `make -f scripts/models.mk test-models` | exit 0, **80 passed, 0 failed** (matches the engineer's claim) |
| `make -f scripts/models.mk lint-models` | exit 0; shellcheck is absent here so the target prints "shellcheck not installed: skipped (only bash -n ran)" instead of failing |
| `shellcheck scripts/download-models.sh tests/models/run.sh` (ShellCheck 0.11.0, scratch venv) | no findings |
| `git grep` for `hf_...` tokens outside tests; `git log -S"Bearer "` | no token in tree or history (only the test fixture string) |

### Findings re-verified against actual behaviour

| ID | Result | Evidence |
|---|---|---|
| F1 tests/lint | Fixed | 80/80; lint skips gracefully. |
| F2 README lock section | Fixed | Now says the lock is filled (2026-10-29, TOFU), `--update-lock` only for a pin bump, script still refuses if any hash is `null`. |
| F3 token validation | Fixed | Under `bash -x`, tokens with trailing newline, trailing space, a tab, a backslash, a double quote and a control character are each rejected with "HF_TOKEN contains whitespace ... (The token is not shown.)", exit 1, zero occurrences of the token in stdout+stderr, nothing written to the volume. A valid token under `bash -x` still works (rc 0, 0 leaks). |
| F4 run lock | Fixed | A held `.run.lock` makes download and `--prune` exit 1 with a readable message naming the lock; `--verify` and `--workflows-only` (read-only or not touching models) are not blocked. Killing the lock holder with SIGKILL leaves no stale lock (kernel releases flock); the next run succeeds. With `flock` removed from PATH the script warns "concurrent runs are not prevented" and proceeds. |
| F4 JOBS | Fixed | `0`, `-1`, `abc`, `1.5`, and `" 2"` rejected with a clear message; `1` and `3` accepted (full run with `JOBS=1` succeeds). Empty `JOBS=` falls back to the default 2 (shell `${JOBS:-2}`), fine. |
| F5 prune warning | Fixed (documentation) | README tells Ken to always run `--prune --dry-run` first. The script still trusts a truncated lock, by design. |
| F6 `loras/` | Fixed | After a default run, `models/c/` (the optional category in my fixture, equivalent to `loras/`) exists empty; the test suite asserts the real categories. |
| F7 design note | Fixed | Summary says 80 GB; Door 1 marked superseded; "Ken's decisions" (9 items) and a Phase 7 summary added. |
| F8 verify / manifest | Fixed (documentation) | README step 4 makes the full `--verify` required and asks for `time`; a "Measured" table is added with every value "_to fill_". `.manifest-rev` is unchanged (still not a proof of full hash verification), which the README now explains. |
| Question 6 (df) | Fixed | `df -hT` for the volume is printed to stderr with a "check size and type ~80 GB" line before downloads start (test and my run both show it). Not printed on a run that has nothing to download. |
| Q4 `config.env.example` | Handled in text | README says HF_TOKEN is documented there after the worker branch merges; this branch does not create the file. Acceptable. |

### Regression hunt for the new lock and token code

- `.run.lock` (an empty file in `models/`) is listed by neither `--verify` nor `--prune`: prune explicitly skips it and my run kept it while removing a real orphan; a file outside `models/` was untouched. It does not interfere with the mountpoint guard (non-mountpoint root is still refused and nothing, including the lock, is created) or the free-space check (it is zero bytes and is created before the `df` read).
- The lock lives on the volume, so it also covers two pods sharing the volume, provided the network filesystem honours `flock`. That is not verifiable here (see below).
- `--prune` on a volume with no `models/` directory now creates an empty `models/` before pruning (harmless, inside the volume).
- Token handling: `require_token` runs `set +x` inside a `local -` scope, so xtrace is restored afterwards (298 traced lines in a full run, none with the token). Token never appeared in argv (`--config /dev/fd/N`), logs, errors, `.manifest-rev` or the lock.

### Residual observations (not blocking)

- R1. `acquire_run_lock` opens the lock with `exec 9>"$MODELS_DIR/.run.lock"`, which truncates its target. If `.run.lock` is a symlink to another file, that file is emptied (I confirmed with a planted symlink). It requires someone to plant the symlink inside `<volume>/models`, so it is a low-risk hardening item: use `exec 9>>` (append) or refuse a symlink.
- R2. `require_token` uses `local -`, which needs bash 5.0 or newer, while the script header says "bash 4.3+". Pod images are normally Ubuntu 22.04 (bash 5.1), so it is fine in practice; the header comment should say 5.0+.
- R3. Typing `--help` with an invalid `JOBS` exits with the JOBS error (the check runs before argument parsing). Cosmetic.

### Still cannot be verified without a real pod, volume and token

1. Real gated behaviour with a valid token: the `HEAD resolve` status (302 expected), and the exact 403 for an account that has not accepted the license. Only the unauthenticated 401 with `GatedRepo` was observed.
2. Real CDN redirect and signed-URL behaviour: that curl drops the Authorization header on the cross-host hop, and that `-C -` resume works against real CDN URLs.
3. The nine sha256 values themselves (masked without a token; trust on first use).
4. `mountpoint -q` on the real pod mount, and whether `df -hT` shows a network filesystem of about 80 GB rather than the pod's local volume disk.
5. That `flock` works on the RunPod network volume filesystem (some network filesystems do not support it; the failure would then show as a misleading "another run is using" message).
6. Throughput, total download time, and the time of the full `--verify` hashing pass (the README "Measured" table is empty until the first real run).
7. US-WA-1 stock for a CPU pod (or the GPU fallback) and for the RTX 6000 Ada serverless GPU.
8. A real out-of-space (ENOSPC) event; only simulated with a file-size limit.
9. A hot volume resize, and that `extra_model_paths.yaml` resolves each category in a real ComfyUI worker.
10. That the GitHub repo is public today (needed for the plain `git clone`).

### Questions

1. Fix R1 (use append or refuse a symlink) and R2 (header says bash 5.0+) now, or accept as known? Neither blocks the merge.
2. Who confirms the repo is public (item 10) before the first pod run?
3. If `flock` turns out to be unsupported on the volume (item 5), is it acceptable to fall back to running without the lock for that one supervised run (the script's existing flock-missing path only covers a missing binary, not an unsupported filesystem)?

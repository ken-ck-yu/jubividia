# Setup from scratch

This is the one working path to rebuild the whole jubividia system on empty accounts, in the order that worked. Every step says where to click or which command to run, what a correct result looks like, how long it takes, what it costs, and what can go wrong.

Related documents:

- [Configuration reference](configuration.md): every `config.env` key, every secret, every setting, every credential scope.
- [Architecture](architecture.md): how the pieces fit together, why they were chosen, the measured numbers, and the operations runbook.

How to read this guide:

- **You** run commands in a WSL terminal (Ubuntu on Windows) or ask Claude Code to run them. Commands are written exactly as they should be typed.
- Words in angle brackets are placeholders you replace: `<your-email>`, `<her-email>`, `<account-id>`, `<team-name>`, `<account-subdomain>`, `<endpoint-id>`, `<volume-id>`, `<aud-tag>`. Never put real values of these in the repository, in a commit, or in a pull request. The repository is public.
- "Not verified" means the statement could not be checked from the repository or from measurements. Dashboards change; where a menu name is not verified, look for the closest wording.
- Prices are those read on 2026-10-29. Re-check them before relying on them.

Contents:

1. [What you are building](#1-what-you-are-building)
2. [Prerequisites and accounts](#2-prerequisites-and-accounts)
3. [Local tools](#3-local-tools)
4. [Get the code and create config.env](#4-get-the-code-and-create-configenv)
5. [Build and publish the worker image](#5-build-and-publish-the-worker-image)
6. [The R2 bucket and its S3 token](#6-the-r2-bucket-and-its-s3-token)
7. [RunPod: volume, models, secrets, endpoint, first GPU test](#7-runpod-volume-models-secrets-endpoint-first-gpu-test)
8. [Cloudflare: lifecycle, Worker, Access, secrets](#8-cloudflare-lifecycle-worker-access-secrets)
9. [First login and first generation from a phone](#9-first-login-and-first-generation-from-a-phone)
10. [Final checklist](#10-final-checklist)
11. [Pitfalls we hit and the fix](#11-pitfalls-we-hit-and-the-fix)

## 1. What you are building

A private web page that makes short videos with sound from a text prompt, a photo, or the end of an existing video, using the open LTX-2.5 model.

- The page and a small API run as one Cloudflare Worker named `jubividia` at `https://jubividia.<account-subdomain>.workers.dev`. Cloudflare Access puts a login in front of it.
- The GPU work runs on RunPod Serverless on an RTX 6000 Ada (48 GB). You pay only while a worker runs, plus a small standing fee for the disk that holds the model files.
- Files (uploads, finished videos, counters) live in a Cloudflare R2 bucket.

The setup order matters because some steps need the output of earlier ones (an id, a tag, a token). Section 11 and the dependency diagram in [architecture.md](architecture.md#f-setup-order-dependency-diagram) explain why.

Total standing cost once finished: about $5.60 per month for the 80 GB RunPod volume. R2 stays inside Cloudflare's free tier at this volume of use (stated in `docs/decisions/ui.md`; not re-measured). Each clip costs a few cents; see the cost table in [configuration.md](configuration.md#cost-table).

## 2. Prerequisites and accounts

Create these accounts first. Use a password manager and turn on two-factor authentication (MFA) wherever it is offered. The admin keys created later can spend money and delete things, so the accounts that issue them must be protected.

| Account | Why | Cost to open |
|---|---|---|
| GitHub | Holds the code and builds the worker image (GitHub Actions) | Free |
| RunPod | Runs the GPU and holds the model volume | Pay as you go; add credit |
| Cloudflare | Hosts the page (Workers), the files (R2) and the login (Zero Trust Access) | Free plan; a payment method may be requested |
| Hugging Face | Source of the model files (gated) | Free |

### 2.1 GitHub

1. Sign in at github.com. Turn on two-factor authentication in your account settings (menu wording not verified).
2. The repository must be **public**. Reasons: the worker image is published to GitHub Container Registry (GHCR) from the repository, the model-download pod runs `git clone https://github.com/ken-ck-yu/jubividia` without credentials, and the build workflow pushes to `ghcr.io/ken-ck-yu/ltx25-worker`. If you use your own copy (a fork), see [Using a fork](#using-a-fork) below.

What can go wrong: a private repository makes the temporary download pod fail at `git clone` (it has no credentials, by design).

### 2.2 RunPod

1. Sign up at runpod.io.
2. **Enable MFA** in the account settings (menu wording not verified).
3. Add a payment method and **add credit**. The README recommends about $15 as the first-run ceiling (worst case in the design note was about $13.6; the actual spend of the first full test run was well under $1, and Ken's total at the time of the gate was about $0.46 of a $10 credit). Enable a **low-balance notification**. Reason: RunPod can remove a network volume when the balance reaches $0 (documented in `docs/decisions/endpoint.md`), which would delete the 41 GB of models. The API cannot read the balance, so check it in the console.
4. Create an **admin API key** (menu: Settings, API Keys; wording not verified) with full access. This is `RUNPOD_API_KEY` in `config.env`. It manages the volume, secrets, endpoint and temporary pod, so it stays only on your own machine. Save it in your password manager; RunPod shows it once.

You will create a second, **restricted** key later (section 7.9) for the Cloudflare Worker.

What can go wrong: a $0 balance. Volume creation and pod creation are refused for low balance; at $0 the platform can delete the volume.

### 2.3 Cloudflare

1. Sign up at cloudflare.com. **Enable MFA** (menu wording not verified).
2. R2 object storage needs to be enabled on the account. Open the dashboard, choose **R2 object storage** in the left menu and follow the prompts. A payment method may be requested even though the free tier covers this use (not verified).
3. Write down the **Account ID** (32 hexadecimal characters). It is shown in the dashboard (for example on the Workers & Pages or R2 overview page; exact place not verified). This is `R2_ACCOUNT_ID` in `config.env`.
4. Zero Trust is set up in section 8 (Free plan, 50 seats). A payment method is asked for at onboarding; nothing is charged on the Free plan (stated in `docs/decisions/ui.md`).
5. The account needs a **workers.dev subdomain** (the `<account-subdomain>` in your page URL). The tool `infra/cloudflare/apply.sh preflight` stops with "the account has no workers.dev subdomain" if it is missing, and it never creates one (it is account-wide). Create it in the dashboard under Workers & Pages the first time you are asked for a subdomain (exact flow not verified).
6. **Important account-specific requirement.** `infra/cloudflare/lib.sh` hard-codes `OTHER_WORKER_BASELINE=jubilab-website` and `preflight` stops with "jubilab-website is not in this account's Worker list: wrong account? Nothing was changed." if the account has no Worker with that name. It was written for an account that already hosts another Worker, which the tool records and re-checks so that it can prove it never touched it. On an account without such a Worker you must change that one line to the name of an existing Worker, or to a throwaway Worker you create first. This has not been tested on a clean account (not verified).

### 2.4 Hugging Face

1. Sign up at huggingface.co.
2. Open https://huggingface.co/Lightricks/LTX-2.5 while signed in and **accept the LTX-2.x Community License** (free under $10M revenue). Without this the download fails with HTTP 403 and a message naming the model page.
3. Create a **read-only access token** (Settings, Access Tokens, type Read; wording not verified). This is `HF_TOKEN`. It is used once, for the model download, and then rotated.

What can go wrong: HTTP 401 means the token is invalid; HTTP 403 means the account that owns the token has not accepted the license.

### Using a fork

Several places name the owner `ken-ck-yu` as a default: `IMAGE` in `config.env.example` and `infra/runpod/apply.sh`, `env: IMAGE` in `.github/workflows/build-worker.yml`, the `git clone` line in `infra/runpod/rpjson.py`. For a fork, change these (and keep the repository public). Not tested (not verified).

## 3. Local tools

You work inside **WSL** (Windows Subsystem for Linux, Ubuntu). Keep the repository in the Linux file system, for example `~/jubividia`, not under `/mnt/c/...`. File permissions such as `chmod 600` may not work on Windows-mounted folders (general WSL behaviour, not verified in this repository).

Check each tool with the version command; a correct result prints a version number.

| Tool | Needed for | Check |
|---|---|---|
| `bash` 5 or newer | All scripts (they refuse older bash) | `bash --version` |
| `git` | Clone and commit | `git --version` |
| `gh` (GitHub CLI) | Look at CI runs, open pull requests | `gh --version`, then `gh auth login` |
| `curl` | All API calls | `curl --version` |
| `python3` | JSON helpers in the scripts (run as `python3 -I`) | `python3 --version` |
| `node` and `npm` | The UI Worker (`npm ci`, `wrangler`). CI uses Node 24 | `node --version` |
| `docker` (optional) | Only for `make build`, `make smoke`, `validate-workflows`. Not needed to run the system, because CI builds the image | `docker --version` |
| `aws` CLI (optional) | The R2 checks inside `scripts/smoke-job.sh` | `aws --version` |
| `ffprobe` (optional) | The audio check inside `scripts/smoke-job.sh` | `ffprobe -version` |

Notes:

- If `aws` or `ffprobe` is missing, run the gate with `--no-r2-check`; the audio and R2 checks are then reported as unverified. (In the first real test `ffmpeg`/`ffprobe` were absent and `sudo` could not prompt for a password in the `!` shell, so a small `ffprobe` wrapper around the worker image was used instead; see section 11.)
- You can use the offline test suites at any time; they need no accounts: `make test`, `make -f infra/runpod/infra.mk test-infra`, `bash tests/cloudflare/run.sh`, and `cd ui && npm ci && npm test`.

## 4. Get the code and create config.env

### 4.1 Clone

```
git clone https://github.com/ken-ck-yu/jubividia
```

then change into the folder (`cd jubividia`). Expected: a folder with `README.md`, `infra/`, `scripts/`, `ui/`, `worker/`.

### 4.2 Create config.env

`config.env` is the one file that holds every setting and secret. It is git-ignored (`.gitignore` lists `config.env`). Create it from the template and restrict it to your user:

```
cp config.env.example config.env
```

```
chmod 600 config.env
```

Edit it with a text editor inside WSL (for example `nano config.env`). **Do not paste secrets into chat, issues, or commit messages, and do not ask Claude Code to print this file.**

Fill it **in stages**, as the steps below tell you; you do not have all values yet. The full meaning of every key is in [configuration.md](configuration.md). The values you need for the first stage:

| Key | Where the value comes from | Section |
|---|---|---|
| `R2_ACCOUNT_ID` | Cloudflare Account ID | 2.3 |
| `R2_BUCKET` | Set to `jubividia-ltx-eu` (fixed name; the Cloudflare tool refuses anything else) | 6 |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 S3 token | 6.2 |
| `RUNPOD_API_KEY` | RunPod admin key | 2.2 |
| `HF_TOKEN` | Hugging Face read-only token | 2.4 |
| `IMAGE_TAG` | The `sha-<short>` tag of the CI build | 5.3 |
| `GIT_REF` | A full 40-character commit hash on GitHub | 4.3 |
| `RUNPOD_POD_IMAGE` | A pinned image tag for the temporary CPU pod | 7.4 |

How the file is read (important if you edit it on Windows):

- Scripts read it with a **fixed-key reader**: only lines like `KEY=value` for known keys are used, it is **never `source`d** (so nothing in it can run as a command), and surrounding quotes are stripped once.
- If a key appears twice, **the last matching line wins**.
- A Windows line ending (CRLF) is tolerated; the reader strips the carriage return.
- Lines starting with `#` are ignored. The values are not printed by the scripts.
- The scripts write ids back into the file for five keys (`RUNPOD_NETWORK_VOLUME_ID`, `RUNPOD_ENDPOINT_ID`, `RUNPOD_POD_ID`, `RUNPOD_SECRET_ID_R2_KEY_ID`, `RUNPOD_SECRET_ID_R2_KEY_SECRET`). They keep the file mode and all other lines.

### 4.3 GIT_REF

The temporary download pod runs the script from an exact commit. Set `GIT_REF` to the full 40-character hash of the latest commit on the `main` branch of your public repository:

```
git rev-parse HEAD
```

Expected: one 40-character hex string. Put it in `config.env` as `GIT_REF=...`. It must be pushed to GitHub, because the pod clones from GitHub. The value shipped in `config.env.example` is an older commit; update it so the pod also gets the current `workflows/*.json`.

What can go wrong: a branch name or `HEAD` instead of the 40-hex hash is refused by `apply.sh pod-up`.

### 4.4 Running the tools

All `apply.sh` commands below read `config.env` in the repository root by default. If your `config.env` is elsewhere (for example when you work in a git worktree, where the ignored file is not copied), point to it explicitly:

```
env CONFIG_ENV=/full/path/to/config.env infra/runpod/apply.sh status
```

Every `apply.sh` accepts `--dry-run` (reads only, no writes). Use it before a real run when in doubt. Both tools refuse to run under `bash -x`, because a trace would print secrets.

## 5. Build and publish the worker image

The worker image is a thin layer on `runpod/worker-comfyui:5.10.0-base` (pinned by tag and digest) that adds ComfyUI-LTXVideo and `handler.py`. It contains no model weights. GitHub Actions builds it and publishes it to GHCR.

### 5.1 How the build is triggered

`.github/workflows/build-worker.yml` runs on a push to `main` that changes `worker/**` (or the workflow file itself), or manually (`workflow_dispatch`). It pushes two tags to `ghcr.io/ken-ck-yu/ltx25-worker`: `latest` and `sha-<short>` (the first 7 characters of the commit). The endpoint must use the `sha-` tag, never `latest`.

If you cloned the repository as it is and it is already on `main` with the worker present, no new commit is needed: start the workflow by hand.

### 5.2 Run the build

On GitHub: open the repository, **Actions** tab, workflow **build-worker**, button **Run workflow**, branch `main`. Or with the CLI:

```
gh workflow run build-worker.yml
```

Watch it:

```
gh run list --workflow build-worker.yml --limit 3
```

Expected: a run whose status becomes `completed` with conclusion `success`. How long: not measured (the base image is about 24 GB uncompressed; the workflow first frees disk space on the runner, and later builds use a cache). Cost: free (GitHub-hosted runner for a public repository; not verified for your plan).

What can go wrong:

- The runner runs out of disk: the workflow already removes unneeded preinstalled software for this reason.
- You see a run for the commit but no tag: the run failed; open it with `gh run view --log-failed`.

### 5.3 Find the tag and make the package public

The tag is `sha-` plus the first 7 characters of the commit that was built:

```
git rev-parse --short=7 HEAD
```

For example the commit `f9bc90a...` gives `sha-f9bc90a`. Use the commit that the successful run built (the commit column of `gh run list`); if you have pulled newer commits since, `HEAD` may differ. Put it in `config.env` as `IMAGE_TAG=sha-<short>`. It must match `^sha-[0-9a-f]{7,}$`; `latest` and anything else is rejected by `apply.sh` and `smoke-job.sh`.

Make the package public (RunPod pulls the image anonymously):

1. On GitHub open your profile, **Packages**, package `ltx25-worker`, **Package settings**.
2. Under **Danger Zone** choose **Change visibility** and set it to **Public** (wording not verified; the README says "GitHub, Packages, Package settings").

Check that it is publicly pullable, without logging in. The RunPod tool does this check for you in section 7.2 (`preflight`: "ok   GHCR: ... is publicly pullable"). You can also check by hand:

```
docker pull ghcr.io/ken-ck-yu/ltx25-worker:sha-<short>
```

This pulls about 25 GB; prefer the `preflight` check, which only fetches the manifest.

What can go wrong: a private package makes `preflight` fail with "anonymous manifest fetch ... returned HTTP 401/404 (tag missing or package not public)". An endpoint pointing at a private image would fail to pull.

## 6. The R2 bucket and its S3 token

### 6.1 Create the bucket in the dashboard

Create the bucket **in the Cloudflare dashboard**, not with a tool. Reason: the **location hint** (Western Europe, "WEUR") can only be set at creation in the dashboard; the Cloudflare MCP connector cannot set it, and a bucket recreated later with the same name keeps its original location.

1. Cloudflare dashboard, **R2 object storage**, **Create bucket**.
2. Name: `jubividia-ltx-eu` (exactly; the tools hard-code this name).
3. Location: choose a **location hint of Western Europe (WEUR)**. Leave the storage class Standard and the jurisdiction at the default.
4. Create.

Expected: the bucket `jubividia-ltx-eu` appears in the R2 list. Cost: R2's free tier covers 10 GB of storage and 1M Class A / 10M Class B operations per month, with free egress (from the design note, `docs/decisions/ui.md`; paid rates apply above the free tier).

What can go wrong: creating it without the hint (the location cannot be changed afterwards; you would have to delete and recreate it, and a recreated bucket with the same name keeps its original location). Other bucket names make `infra/cloudflare/apply.sh` stop ("R2_BUCKET in config.env is not jubividia-ltx-eu").

### 6.2 Create the S3 API token for the bucket

This token is used by the **RunPod worker** (to read inputs and write results) and by the smoke test. It is not used by the Cloudflare Worker, which reaches R2 through a binding.

1. R2 object storage, **Manage API tokens** (or **Manage R2 API Tokens**), **Create API token** (wording not verified).
2. Permission: **Object Read & Write**.
3. Scope: **Apply to specific buckets only**, and choose `jubividia-ltx-eu`. Do not use an account-wide token.
4. Create. Copy the **Access Key ID** and **Secret Access Key** (shown once) into `config.env` as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Also confirm `R2_ACCOUNT_ID` and `R2_BUCKET=jubividia-ltx-eu`.

Do not use the "jurisdiction" S3 endpoint or a custom domain: the worker builds the endpoint `https://<account-id>.r2.cloudflarestorage.com` itself.

What can go wrong: a token scoped to the wrong bucket or with Read-only permission. The first symptom is at the canary job (section 7.8): a read failure shows as `could not fetch input`, and a write failure only shows when a real clip is uploaded.

## 7. RunPod: volume, models, secrets, endpoint, first GPU test

All commands here run on your machine. They call the RunPod management API at `https://api.runpod.io/v2` (routes `/account/secrets`, `/serverless`, `/network-volumes`, `/pods`).

### 7.1 Check that nothing is already set up

```
infra/runpod/apply.sh status
```

Expected: `== volume none recorded`, secrets `0 found`, endpoint `none recorded`, temp pod `none`.

### 7.2 Preflight (read-only, free)

Needs `RUNPOD_API_KEY`, `IMAGE_TAG`, the R2 values in `config.env`.

```
infra/runpod/apply.sh preflight
```

Expected output lines (the ids and tag differ):

```
ok   image ref: ghcr.io/ken-ck-yu/ltx25-worker:sha-<short>
ok   GIT_REF is a full commit sha
ok   RunPod API reachable, key accepted
ok   GHCR: ken-ck-yu/ltx25-worker:sha-<short> is publicly pullable
info volumes with the exact name+DC: 0 (0 = volume will be created, 1 = adopted, >1 = stop)
```

then counts for endpoints and secrets (all 0 on a fresh account) and a reminder to confirm the payment method and balance in the console. Time: seconds. Cost: free.

What can go wrong: "GHCR: could not get an anonymous pull token (is the package public?)" (section 5.3); a rejected key (check `RUNPOD_API_KEY`); a bad tag format.

### 7.3 Create the network volume (billable: about $5.60 per month)

The network volume is the 80 GB disk that holds the model files and workflow templates. It is created in data center **US-WA-1**, type **standard**. These choices cannot be changed later (data center and type are immutable; size can only grow). US-WA-1 is where the RTX 6000 Ada serverless GPU could be used with a standard volume (no data center had A6000/A40 serverless stock together with network volumes).

```
infra/runpod/apply.sh volume
```

Expected:

```
creating volume 'jubividia-ltx-us-wa1' 80 GB in US-WA-1 (BILLS $0.07/GB/month = ~$5.60/month until deleted in the console)
ok   volume <volume-id> (jubividia-ltx-us-wa1, US-WA-1)
```

The script writes `RUNPOD_NETWORK_VOLUME_ID=<volume-id>` into `config.env`. Running it again makes no create call (idempotent). Time: seconds. Cost: $0.07 per GB per month, accruing hourly until you delete the volume in the console. There is deliberately **no code path that deletes the volume**.

What can go wrong: insufficient balance (HTTP error printed with the body); a volume already named the same in the same data center is adopted, not duplicated.

### 7.4 Download the models with a temporary CPU pod

The model files (41.43 GB: int8-convrot distilled transformer, int8-convrot Gemma 4 text encoder, VAEs, upscalers; pinned Hugging Face commit with sha256 in `scripts/models.lock`) are written once to the volume by a **temporary CPU pod**, then the pod is deleted.

1. Choose the pod image. Set `RUNPOD_POD_IMAGE` in `config.env` to an image with bash 5, curl 7.71 or newer, and git, with an explicit non-`latest` tag. `config.env.example` only says "Choose from an image read" and gives no value. The README names `ubuntu:22.04` as the image used in the first real run (Ubuntu 22.04 ships bash 5.1; the pod script installs git, curl, python3 and util-linux with `apt-get` if missing). So `RUNPOD_POD_IMAGE=ubuntu:22.04` is the value used for the measured run.
2. Check stock and the prices in the RunPod console if you like (CPU pod cpu3c, 2 vCPU, secure cloud, about $0.06 per hour at the 2026-10-29 read). If CPU stock were gone, **stop and ask**; the only fallback is a GPU pod at about $0.99 per hour.
3. Start it:

```
infra/runpod/apply.sh pod-up
```

The script creates the temporary secret `hf_token_tmp` from `HF_TOKEN`, creates the pod `jubividia-models-tmp` (volume mounted at `/runpod-volume`), and prints a banner: "POD <id> IS RUNNING AND BILLING". The pod runs this sequence: clone the repository, check out `GIT_REF`, `scripts/download-models.sh`, `scripts/download-models.sh --verify`, print `MODELS DONE - TERMINATE THIS POD NOW (apply.sh pod-down)`, then `sleep infinity`.

4. Watch the log until you see `MODELS DONE`:

```
infra/runpod/apply.sh pod-logs
```

Repeat the command every minute or so; it prints the last lines. Before the download it prints `df -hT` for the volume. On RunPod `df` shows a **615 T shared FUSE filesystem** (for example `mfs#us-wa-1.runpod.net:9421 fuse 615T ... /runpod-volume`) because the 80 GB quota is enforced by the platform, not by `df`. That is normal; the free-space guard accounts for it.

Measured on the first real run (cpu3c, 2 vCPU, US-WA-1): download of 41,427,929,848 bytes in 8 files took 3 min 39 s (about 189 MB/s) and the full `--verify` about 2 min 21 s. Expected total with clone and installs: not measured end to end (the README estimate was 20 to 40 minutes as a safe upper range). Cost: about $0.06 per hour, so cents.

5. **Terminate the pod immediately** (terminate, not stop; a stopped pod keeps billing for disk):

```
infra/runpod/apply.sh pod-down
```

Expected:

```
terminating pod <pod-id> (name jubividia-models-tmp)
ok   pod <pod-id> is gone (read back)
ok   temporary secret hf_token_tmp deleted. Now rotate/revoke the Hugging Face token.
```

6. **Rotate the Hugging Face token** now: on huggingface.co revoke the token you used and, if you will need to download again later, create a new read-only token only at that time. Remove the value from `config.env`.

What can go wrong:

- You forget `pod-down`: the pod bills until terminated. `apply.sh status` warns "pod jubividia-models-tmp exists and is BILLING".
- HTTP 403 in the log: the license was not accepted by the token's account (section 2.4). HTTP 401: invalid token.
- The mount-point check fails on a pod: confirm with `df` that the path really is the volume, then set `SKIP_MOUNT_CHECK=1` in `config.env` and re-run `pod-up` after `pod-down`.
- `df` crashed the free-space guard in the first run (scientific notation); this is fixed in the script (see section 11).

You can also verify the volume contents later without a token: start a pod again and run `scripts/download-models.sh --verify` (read-only, re-hashes every file). A second download run downloads nothing.

### 7.5 Create the R2 secrets on RunPod

The RunPod worker gets the R2 keys through two RunPod **account secrets**, not as plain environment values, so they never appear when the endpoint is read.

```
infra/runpod/apply.sh secrets
```

Expected:

```
creating secret ltx_r2_access_key_id (free)
creating secret ltx_r2_secret_access_key (free)
note: secret values are write-only on RunPod; keep your own copy of the R2 token.
```

The secret ids are written back to `config.env`. Cost: free. Secret names are immutable. Values are write-only: you can never read them back from RunPod.

### 7.6 Create the serverless endpoint

Before the first test, keep `RUNPOD_IDLE_TIMEOUT_S` unset (the default is 60 seconds). You will raise it after the test (section 7.10). Create the endpoint with **one** worker maximum for the test:

```
infra/runpod/apply.sh endpoint --max-workers 1
```

Expected:

```
image:   ghcr.io/ken-ck-yu/ltx25-worker:sha-<short>
workers: min 0 max 1, idleTimeout 60 s, flashboot FLASHBOOT, timeout 900000 ms
creating endpoint 'jubividia-ltx25' (idle cost $0; a running RTX 6000 Ada worker bills $1.75/hr)
ok   endpoint <endpoint-id> matches config on every owned field (read back)
```

`RUNPOD_ENDPOINT_ID=<endpoint-id>` is written to `config.env`. The full list of settings it applies is in [configuration.md](configuration.md#runpod-endpoint-settings). Cost: $0 while idle.

What can go wrong:

- **The endpoint started one worker immediately** even with minimum workers 0 (seen on creation). If you do not want to pay for it, check `infra/runpod/apply.sh status` and the console; the worker stops after the idle timeout. Workers also took several minutes to scale down despite the idle timeout (observed three times; cause unknown). Whether idle time is billed is unconfirmed (one hourly billing bucket looked as if it was not). Until you have confirmed this on your own billing page, treat idle time as billed. Between tests the endpoint was parked (section 11, item 8; park procedure in [architecture.md](architecture.md#park-and-unpark-the-endpoint)).
- `apply.sh` refuses `--max-workers 0` ("workers min/max invalid (max >= 1 ...)").
- "IMAGE_TAG is not set": fill `IMAGE_TAG` (section 5.3).
- The model volume must be in `RUNPOD_DC` (US-WA-1) and mounted; the tool uses the volume id from `config.env`.

### 7.7 The first real-GPU test: scripts/smoke-job.sh (billable, the gate)

This is the gate: it proves the whole chain on real hardware before you build the front end on top of it. Run it only after reading the quote below.

```
scripts/smoke-job.sh --help
```

prints the usage:

```
scripts/smoke-job.sh [--max-spend USD] [--no-r2-check] [--skip-final-cold] [--csv PATH]
```

Add `--no-r2-check` if `aws` or `ffprobe` is missing. `--max-spend` defaults to 3.00 dollars (an estimate of worker time times $1.75 per hour, conservatively adding a 60 s idle tail and one poll interval per job; when reached it cancels the running job and exits 3).

Start it:

```
scripts/smoke-job.sh
```

What it does, in order:

1. **canary**: an image-to-video job pointing at a key that does not exist. It needs working R2 secrets but never loads the models. A pass is the error `[input_fetch] input not found`: that proves the R2 secrets resolved on the worker. Any other error stops the gate here, before any model job.
2. **cold-tiny**: a 256x256, 25-frame text-to-video job on a cold worker.
3. **warm-tiny**: another tiny job with a new seed (its time is the baseline without model loading).
3b. **repeat-same**: the exact same request again; it must complete with a new output file name (ComfyUI would otherwise answer from its cache with no output).
4. **warm-def**: 1280x704, 121 frames, 24 fps.
5. **warm-def2**: the same again; its time must be within 10% of the previous run.
6. wait for the worker to scale to zero, then 7. **cold-def**: the real "first clip after idle" path.

Time: not measured as a whole. The final step waits for scale-to-zero (up to 600 seconds by default) and the first-ever cold start can include a billed 24.75 GB image pull. Cost: the expected quote was about $1 to $2, worst case about $5 to $6 (README); the second real run's own estimate was $0.62.

Every job also appends a line to `docs/validation/endpoint-timings.csv` (a local file).

**How to read the result.** A passing run shows all of these:

- `canary OK: R2 credentials resolved and R2 read works (input_fetch / input not found)`.
- every model job `status=COMPLETED`.
- `repeat-same completed with a new output key`.
- `audio stream: present` for every completed job (with the R2 checks on).
- cold start printed as `worker start X s + model-load overhead Y s = Z s`.
- `peak_vram_mb` per job (report-only) and `estimated spend` below the cap.
- the final lines: `================ GATE SUMMARY ================` followed by `GATE: PASS (no OOM, second warm default job within 10% of the first)`. The exit code is 0.

Other exit codes: 1 = gate failed, 2 = usage or configuration problem, 3 = **stop and ask** (a worker went unhealthy, a job stayed in progress past 15 minutes, a job waited in the queue without a usable worker for more than 5 minutes, the status or health calls failed 5 times in a row, spend reached the cap, cold start above 600 s, and similar). Do not work around exit 3: check `/health`, the worker logs in the RunPod console, and ask.

Values from the real run on 2026-10-29 (gate **passed**, image `sha-f9bc90a`, RTX 6000 Ada, US-WA-1):

| Measurement | Value |
|---|---|
| Warm default clip (1280x704, 121 frames) `gen_time_s` | 68.21 s; second run 66.40 s (2.7% apart) |
| First clip after idle, total from submit to done | 291.5 s: worker start about 105 s plus model load about 119 s, then generation |
| Peak VRAM, default clip | 43,473 MiB (about 42.5 GiB) of 48 GiB; no out-of-memory |
| Audio | AAC 48 kHz stereo present on every clip |

What can go wrong at the canary (the most common first failure): an unresolved or wrong secret. A worker started with a stale or unresolved secret shows up only at the canary job, which is why it runs first. If the canary says `could not fetch input`, check the R2 token scope (section 6.2), then `apply.sh secrets --rotate` (new values reach workers at their next boot).

### 7.8 Park the endpoint while you build the front end

The Cloudflare steps do not need a running GPU. To make sure nothing bills in between, see [Park and unpark the endpoint](architecture.md#park-and-unpark-the-endpoint). In short, `apply.sh` refuses maximum workers 0, so parking is done with the RunPod console or an API PATCH of the endpoint's workers to minimum 0 and maximum 0. `apply.sh endpoint` restores the configured maximum.

### 7.9 Create the restricted RunPod key for the Worker

The Cloudflare Worker must not hold your admin key. Create a second key that can only call this one endpoint.

1. RunPod console, Settings, **API Keys**, create a new key (wording not verified).
2. Choose **Restricted** permissions and set:
   - `api.runpod.io/graphql` (the management API): **None**
   - `api.runpod.ai` (the endpoint runtime API): **Restricted**, only the endpoint `jubividia-ltx25` (`<endpoint-id>`) with **Read/Write**.
3. Copy the key into `config.env` as `UI_RUNPOD_API_KEY`. It must be different from `RUNPOD_API_KEY` (the Cloudflare tool refuses equal values).

What can go wrong: whether a key restricted this way actually works for `/run`, `/status`, `/health` and `/cancel` is only proven by your first generation from the phone (section 9); `docs/validation/ui.md` lists it as an unverified assumption before that.

### 7.10 Set the idle timeout, restore the maximum workers

After the gate passes, set the idle timeout you want. Ken chose **180 seconds** (a longer window keeps the GPU warm between clips; whether idle time is billed is unconfirmed, see 7.6). In `config.env`:

```
RUNPOD_IDLE_TIMEOUT_S=180
```

then apply it, and restore the worker maximum (the config default is 2):

```
infra/runpod/apply.sh endpoint
```

Expected: `endpoint <endpoint-id>: field 'workers' differs; patching only that field`, then `ok   endpoint <endpoint-id> matches config on every owned field (read back)`. If you prefer a hard limit of one GPU, set `RUNPOD_WORKERS_MAX=1` (the Worker already allows only one job at a time).

## 8. Cloudflare: lifecycle, Worker, Access, secrets

The order here is a security requirement: deploy the Worker with **no secrets** (it answers 503 to everyone, "fails closed"), put Cloudflare Access in front, prove with `verify-access` that the login blocks anonymous requests, and only then give the Worker its secrets.

### 8.1 Create the Cloudflare deploy token

1. Cloudflare dashboard, **My Profile**, **API Tokens**, **Create Token**, custom token (wording not verified).
2. Permissions, exactly these three and nothing else:
   - Account, **Workers Scripts**: Edit
   - Account, **Workers R2 Storage**: Edit
   - Account, **Account Settings**: Read
3. **No Zero Trust permission.** The Access application is created by you in the dashboard; the tool has no code path for Access.
4. Set a short expiry (the README calls it a "short-lived token"). Account resources: your account.
5. Copy the token into `config.env` as `CLOUDFLARE_API_TOKEN`.

Cloudflare tokens cannot be limited to a single Worker, so the scripts hard-code the Worker name `jubividia` and the bucket `jubividia-ltx-eu` and refuse anything else. You revoke this token at the end (8.9).

### 8.2 Install the Worker's dependencies

```
npm --prefix ui ci
```

Expected: packages install (wrangler 4.155.0, jose 6.2.14, vitest and the test pool are pinned in `ui/package-lock.json`). Optionally run the offline tests; they use only fakes:

```
npm --prefix ui test
```

### 8.3 Preflight (read-only)

```
infra/cloudflare/apply.sh preflight
```

Expected lines:

```
token: valid
workers.dev subdomain: present (jubividia will be https://jubividia.<subdomain>.workers.dev)
baseline: jubilab-website modified_on=...
Worker jubividia does not exist yet
bucket: jubividia-ltx-eu exists
R2 lifecycle: 0 existing rule(s) (kept as they are)
baseline written: .scratch/cloudflare/baseline.json
```

The baseline file records the other Workers' modification times so that `postcheck` can prove nothing else changed.

What can go wrong: no workers.dev subdomain; no Worker named `jubilab-website` (section 2.3 item 6); a missing or mis-scoped token; `R2_ACCOUNT_ID` not 32 hex characters; the bucket not found (wrong name or wrong account).

### 8.4 Lifecycle rules

```
infra/cloudflare/apply.sh lifecycle
```

Adds three rules to the bucket (existing rules are read, merged and written back unchanged): `inputs-expire-7d` (delete objects under `inputs/` after 7 days), `state-expire-40d` (delete under `state/` after 40 days), `abort-multipart-1d` (abort unfinished multipart uploads after 1 day). Outputs have no expiry rule. Expected last line: `lifecycle: rules added and read back; existing rules unchanged`. R2 applies expiry asynchronously, so "7 days" can mean up to about 8.

### 8.5 Deploy the Worker with no secrets

```
infra/cloudflare/apply.sh deploy
```

It checks `ui/wrangler.toml` (name `jubividia`, `workers_dev = true`, `preview_urls = false`, `run_worker_first = true`), runs `wrangler deploy`, then asserts the Worker identity, that workers.dev is on, preview URLs are off, and the other Workers are unchanged. Expected tail:

```
Worker id: jubividia (created_on=...) as recorded
workers.dev: enabled, preview URLs off (read back)
other Workers unchanged since the baseline
```

Now open `https://jubividia.<account-subdomain>.workers.dev` in a browser. Expected: a blank page with HTTP 503. This is correct: the Worker has no secrets yet, so it refuses every request.

If the script says the Worker was "deleted and recreated", stop: an Access application is bound to the Worker's id and would no longer protect the new one. Recreate the Access application before anything else and do not set secrets.

### 8.6 Zero Trust organization, login method, policy

All of this is in the Cloudflare dashboard (Zero Trust). The menu names below are the ones that worked.

1. **Create the Zero Trust organization** if the account has none: dashboard, **Zero Trust**, follow onboarding, choose the **Free plan** (up to 50 seats; a payment method is requested but nothing is charged). You choose a **team name**; it becomes `<team-name>` in `https://<team-name>.cloudflareaccess.com`. Choose it carefully: changing it later breaks every Access application on the account.
2. **Add the One-time PIN login method.** Go to **Zero Trust, Integrations, Identity providers, Add new identity provider, One-time PIN**. It is **not** under Settings, Authentication (that menu does not exist in the current dashboard). Reason: a new Zero Trust organization has the **Cloudflare** identity provider by default, which admits only members of your own Cloudflare account; a second person needs One-time PIN. With One-time PIN, Access emails a 6-digit code (sender `notify.cloudflare.com`, may land in spam) to an address that your policy lists.
3. **Create a reusable policy.** Go to **Zero Trust, Access controls, Policies**, create a policy:
   - Action: **Allow**
   - Include selector: **Emails**, and add **each** allowed address (`<your-email>`, `<her-email>`).
   - Never use an "Email domain" rule with a public domain such as gmail.com: it would admit everyone with such an address.

What can go wrong: see section 11, items 1 to 3.

### 8.7 Protect the Worker with Access

1. Dashboard, **Workers & Pages**, the Worker `jubividia`, the **Access** tab (wording as it appeared; the same control is a setting in the Worker's settings).
2. Choose **Protect this Worker behind Access**.
3. Scope: **All traffic** (this Worker only).
4. **Attach the policy** you created in 8.6 (from the full policy editor, not the quick dialog).
5. Choose the **session duration** (the design used 24 hours).
6. Save.

Do **not** use the account-wide "protect all Workers" setting when other Workers exist on the account: it would put them behind Access too (section 11, item 2).

Then verify:

```
infra/cloudflare/apply.sh verify-access
```

Expected:

```
ok   GET /: HTTP 302 to the Access login
ok   GET /api/state: HTTP 302 to the Access login
ok   forged Cf-Access-Jwt-Assertion: HTTP 302 to the Access login
verify-access: PASS (unauthenticated requests are redirected to the Access login; the app is never served)
```

If it says `HTTP 503` or `403 means the Worker answered itself: the Access app is missing or not attached to this Worker`, the application is not attached; go back to 8.7. `HTTP 200` means the app is served without a login: fix before anything else. If you have already put `TEAM_DOMAIN` in `config.env`, the redirect must go to that team.

### 8.8 Find the AUD tag, fill config.env, set the Worker secrets

1. Find the **AUD tag**: **Zero Trust, Access controls, Applications**, the application for the Worker, open its settings; the **Application Audience (AUD) Tag** is a long hexadecimal string (exact field label not verified). This is `POLICY_AUD`.
2. In `config.env` set:

```
ALLOWED_EMAILS=<your-email>,<her-email>
TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
POLICY_AUD=<aud-tag>
```

`TEAM_DOMAIN` must have **no trailing slash**. `ALLOWED_EMAILS` is comma-separated; the Worker trims and lower-cases each address.

3. Check that `UI_RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` are in `config.env` (sections 7.9 and 7.6).
4. Optionally rehearse: `infra/cloudflare/apply.sh --dry-run --i-confirmed-access secrets`.
5. Set the secrets (this re-runs the Access check first and refuses if it fails):

```
infra/cloudflare/apply.sh --i-confirmed-access secrets
```

Expected:

```
re-checking the Access redirect before any secret is set
secret set: RUNPOD_API_KEY
secret set: RUNPOD_ENDPOINT_ID
secret set: ALLOWED_EMAILS
secret set: TEAM_DOMAIN
secret set: POLICY_AUD
secrets present (names only): ALLOWED_EMAILS POLICY_AUD RUNPOD_API_KEY RUNPOD_ENDPOINT_ID TEAM_DOMAIN
```

The Worker secret `RUNPOD_API_KEY` is filled from the config key `UI_RUNPOD_API_KEY`. Values are never printed.

What can go wrong: "TEAM_DOMAIN must look like https://<team>.cloudflareaccess.com (no trailing slash)"; "UI_RUNPOD_API_KEY equals RUNPOD_API_KEY"; a mistyped AUD (the Worker then answers 403 after login because the JWT audience does not match).

### 8.9 Postcheck, then revoke the deploy token

```
infra/cloudflare/apply.sh postcheck
```

Expected: `other Workers: unchanged since the baseline`, `lifecycle: our three rules present, existing rules unchanged`, the five secret names, and `postcheck: PASS`.

Then **revoke the Cloudflare API token** in the dashboard and delete `CLOUDFLARE_API_TOKEN` from `config.env`. A later Worker update needs a new short-lived token (`preflight`, `deploy`, `postcheck`).

## 9. First login and first generation from a phone

1. On the phone open `https://jubividia.<account-subdomain>.workers.dev`. Expected: the Cloudflare Access login page.
2. Enter an address that is on the policy. Expected: an email with a 6-digit code (check spam). Enter the code. The session lasts as long as you chose in 8.7.
3. Expected: the page with "Signed in as ..." in the header, the GPU status ("asleep" or "warm"), and today's use ("0 of 30 clips").
4. Choose **Text**, enter a prompt that includes sound cues, for example "a red ball rolls across a wooden table, soft ambient sound", leave the defaults (1280x704, 5.04 s), tap **Generate**.
5. Expected: a progress card with an elapsed timer. The first clip after the GPU slept takes about 4 to 5 minutes in total (measured 291 s); later clips within the idle window take about 1 to 1.5 minutes (measured 68 s generation). The finished clip plays inline with sound and appears in the shared gallery with its generation time, peak VRAM and estimated cost.

Both allowed people can sign in. They share the gallery, the daily cap of 30 clips and the one-job-at-a-time lock.

Expected cost: about $0.034 for a warm 5 s clip, about $0.09 to $0.14 for the first clip after idle (at $1.75 per hour).

What can go wrong:

- **HTTP 503 after login**: the Worker still has no secrets (expected before 8.8) or one is empty or malformed (`TEAM_DOMAIN` with a slash, no emails).
- **HTTP 403 after login**: the AUD tag or `TEAM_DOMAIN` is wrong, or the email you used is not in `ALLOWED_EMAILS`.
- "The GPU service rejected the server's credentials (misconfigured)": the restricted RunPod key is wrong or too narrow.
- "The GPU endpoint was not found (misconfigured)": wrong `RUNPOD_ENDPOINT_ID`.
- "The GPU service refused the job ... it may be paused": the endpoint was idle for a quiet week and RunPod lowered its maximum workers; run `infra/runpod/apply.sh endpoint`.
- No code arrives: the One-time PIN method was not added (section 8.6), or the address is not on the policy (Access sends nothing for unlisted addresses; not verified).

## 10. Final checklist

Tick each line.

- [ ] GitHub repository public; `build-worker` run succeeded; package `ltx25-worker` public; `IMAGE_TAG` is a `sha-` tag.
- [ ] RunPod: MFA on; balance funded with a low-balance notification; volume `jubividia-ltx-us-wa1` 80 GB in US-WA-1; models verified (`MODELS DONE`); `pod-down` done; **no pod running** (`apply.sh status` says `== temp pod none`); Hugging Face token revoked.
- [ ] RunPod secrets `ltx_r2_access_key_id` and `ltx_r2_secret_access_key` exist; endpoint `jubividia-ltx25` matches config; gate passed (`GATE: PASS`).
- [ ] Endpoint settings after the gate: idle timeout as chosen (180 s), maximum workers restored (`apply.sh status` shows no `workers.max` warning).
- [ ] Cloudflare: MFA on; bucket `jubividia-ltx-eu` with the WEUR hint; lifecycle rules present; Worker deployed; Access application attached to this Worker only; policy lists exactly the allowed addresses with the Emails selector; `verify-access` PASS; five secrets set; `postcheck` PASS; deploy token revoked.
- [ ] Phone: login with a PIN works for both people; one clip generated and played with sound.
- [ ] `config.env` is mode 600, not committed (`git status` does not list it), and holds no leftover temporary tokens (`HF_TOKEN`, `CLOUDFLARE_API_TOKEN`).
- [ ] Standing cost understood: about $5.60 per month for the volume; nothing else bills while no worker runs (idle-time billing unconfirmed, see 7.6).

## 11. Pitfalls we hit and the fix

Each item is a dead end we met and what to do instead.

1. **The Cloudflare Worker "Edit Worker access" quick dialog can only create "Email domain" rules.** Typing a full email address there creates a rule that matches nobody. Fix: use the full policy editor (Zero Trust, Access controls, Policies) with the **Emails** selector, and attach the policy to the Worker. Never allow a whole domain such as gmail.com.
2. **Never use the account-wide "protect all Workers" Access setting** when other Workers exist on the account. It would put them behind Access. Protect only this Worker.
3. **The Cloudflare identity provider (the default for new Zero Trust organizations) only admits members of your own Cloudflare account.** A second person cannot log in. Fix: add the **One-time PIN** provider (Zero Trust, Integrations, Identity providers, Add new identity provider, One-time PIN). It is not under Settings, Authentication, which does not exist in the current dashboard.
4. **The Cloudflare MCP connector cannot set an R2 location hint.** Create the bucket in the dashboard with the Western Europe hint. A bucket recreated with the same name keeps its original location.
5. **The RunPod API base is `https://api.runpod.io/v2`**, not `rest.runpod.io/v1`. The routes are `/account/secrets`, `/serverless`, `/network-volumes`, `/pods`. The job runtime API is a different host: `https://api.runpod.ai/v2/<endpoint-id>/run|status/<job>|health|cancel/<job>`.
6. **`config.env` is read by a fixed-key reader that takes the LAST matching line**, never `source`s the file, and tolerates CRLF line endings. Do not rely on shell syntax inside it (no `export`, no `$(...)`, no variables); a duplicated key silently uses the later one.
7. **`apply.sh` refuses maximum workers 0.** Park the endpoint through the RunPod console or an API PATCH of workers to minimum 0 and maximum 0 ([runbook](architecture.md#park-and-unpark-the-endpoint)). Note that a paused endpoint (maximum 0) answers `/run` with HTTP 409.
8. **Endpoint creation immediately started one worker even with minimum 0, and workers took several minutes to scale down despite the idle timeout** (observed three times, cause unknown; the scale-down after the last job took about 6 minutes with a 60 s idle timeout). Billing for idle time looked unbilled in one hourly bucket (a bucket of $0.104 for a worker alive about 8 minutes) but this is unconfirmed. The endpoint was parked at maximum 0 between tests. Fix: after creating the endpoint, check `apply.sh status` and the console; park when you are not testing; confirm idle billing yourself on the RunPod billing page. If it reproduces on an otherwise clean run, repeating the gate with FlashBoot off is the next experiment (not done).
9. **ComfyUI answers an identical repeated request from its cache with no output** (the first real run failed with `[output_missing] node OUTPUT produced no mp4`). Fixed in the handler by a unique per-job filename prefix on the saving node; the gate's `repeat-same` job tests it.
10. **The RunPod volume shows as a 615 T shared FUSE filesystem in `df`** (the 80 GB quota is not shown). The first run crashed the free-space guard (awk printed `249T` in scientific notation). The guard now parses the integer free bytes, prints a note, and refuses only if even that number is too small.
11. **`sudo` cannot prompt for a password in the `!` shell of Claude Code, and `ffmpeg`/`ffprobe` were absent,** so the gate's audio check used a tiny `ffprobe` wrapper around the worker image. Fix: install `ffmpeg` yourself in a normal terminal (`sudo apt install ffmpeg`), or run the gate with `--no-r2-check` and accept that audio and R2 are then unverified.
12. **`gh pr edit` fails with a deprecated Projects error.** Use `gh api -X PATCH repos/<owner>/<repo>/pulls/<n>` with the fields to change.
13. **With `set -o pipefail`, `cmd | grep -q` kills the producer with SIGPIPE and reports failure.** This made `smoke-job.sh` report "audio stream: MISSING" on a clip that had audio (`ffprobe | grep -q`). Fixed by capturing the output first and matching in bash. Remember this in any script you write.
14. **GPU availability for 48 GB cards is LOW everywhere, and two RunPod catalog views can disagree.** A queued job costs nothing until a worker starts. The gate stops and asks if a job waits more than 5 minutes with no usable worker. Do not widen the GPU pool or change data center without a decision (a new volume and a new 41 GB download would be needed).
15. **A worker started with a stale or unresolved secret shows up only at the canary job** (the gate's first job), because the handler only checks that the R2 variables are non-empty. That is why the canary runs first and why it uses a missing input: it costs only worker boot plus the idle time.
16. **Terraform was considered for Cloudflare Access and rejected** (provider support for a Worker destination could not be confirmed, and v5 had recurring-diff bugs on that resource). The repository uses idempotent bash plus API scripts with hard-coded names; the Access application itself is made by hand in the dashboard.
17. **The FP8 community build of LTX exists but was not adopted** (not benchmarked). The repository uses the int8-convrot build.
18. **`infra/cloudflare/apply.sh preflight` requires a Worker named `jubilab-website` to exist** (see section 2.3, item 6). On a clean account this stops the setup at preflight until `OTHER_WORKER_BASELINE` is changed.
19. **Do not delete and recreate the Worker `jubividia`** after Access is set up: the Access application is bound to the Worker's id.

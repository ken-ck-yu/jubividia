"""RunPod serverless handler for LTX-2.5 via the in-container ComfyUI.

Contract v1
-----------
Input (job["input"]):
    mode        "t2v" | "i2v" | "v2v"                       required
    prompt      non-empty str                                required
    negative    str                                          optional
    input_key   R2 key under "inputs/"                       required for i2v/v2v
    width, height   256..2048, rounded down to a multiple of 64
                                                             default 1280x720 (-> 1280x704)
    duration    seconds (float)                              default 5
    fps         1..60                                        default 24
    num_frames  int, 8k+1, 9..481; overrides duration        optional
                (duration*fps is held to the same 481-frame maximum)
    seed        int >= 0                                     default random
Output (success):
    {v, key, thumb_key, meta_key, duration_s, gen_time_s, seed,
     width, height, num_frames, fps, cold, peak_vram_mb}
    peak_vram_mb: max nvidia-smi memory.used (MiB) sampled during generation, or
    null if nvidia-smi is unavailable. Also stored in the sidecar JSON.
Output (failure): {"error": str, "error_code": code}  (RunPod marks FAILED)
    codes: bad_input config_error input_fetch workflow_mismatch model_missing
           oom timeout comfy_unavailable comfy_bad_response comfy_error
           output_missing upload_failed

R2 keys: outputs/<YYYY-MM-DD UTC>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json
The timestamp is taken at job start: a retry of the same job id gets NEW keys.

Workflow templates (/runpod-volume/workflows/<mode>.json, API format) are
filled by node `_meta.title` (see NODE_FIELDS), never by numeric node id.
"""
import datetime
import hashlib
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

import boto3
import requests
from boto3.exceptions import Boto3Error
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

log = logging.getLogger("ltx25-worker")

CONTRACT_VERSION = 1
COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_ROOT = os.environ.get("COMFY_ROOT", "/comfyui")
COMFY_PID_FILE = os.environ.get("COMFY_PID_FILE", "/tmp/comfyui.pid")
WORKFLOWS_DIR = os.environ.get("WORKFLOWS_DIR", "/runpod-volume/workflows")
# Must stay well below the endpoint execution timeout so the caller gets a
# readable error instead of a killed job; the remainder is reserved for uploads.
# Generation budget; the rest of the execution timeout is reserved for uploads.
JOB_TIMEOUT_S = int(os.environ.get("JOB_TIMEOUT_S", "780"))
# The endpoint's execution timeout in seconds. NOT a RunPod platform limit (RunPod
# allows 5 s to 7 days): 900 s is our own spend-safety choice, set on the endpoint as
# RUNPOD_EXEC_TIMEOUT_MS (infra/runpod/apply.sh), which also passes EXEC_TIMEOUT_S
# (= that value / 1000) to the worker so the two cannot drift apart. The default must
# equal RUNPOD_EXEC_TIMEOUT_MS / 1000 in config.env.example.
PLATFORM_LIMIT_S = int(os.environ.get("EXEC_TIMEOUT_S", "900"))
VRAM_SAMPLE_MIN_S = 0.2  # a smaller interval would fork nvidia-smi in a tight loop


def clamp_sample_interval(v):
    return max(VRAM_SAMPLE_MIN_S, float(v))


VRAM_SAMPLE_S = clamp_sample_interval(os.environ.get("VRAM_SAMPLE_S", "1.0"))
SAFETY_S = 15  # everything (incl. uploads/cleanup) must finish this early
ATTEMPT_MAX_S = 45  # hard cap for one upload attempt, enforced by a thread join
COMFY_READY_TIMEOUT_S = int(os.environ.get("COMFY_READY_TIMEOUT_S", "300"))
INPUT_MAX_BYTES = int(os.environ.get("INPUT_MAX_BYTES", str(500 * 1024 * 1024)))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "1.0"))
UPLOAD_TRIES = 3
UPLOAD_BACKOFF_S = 1.0
MAX_FRAMES = 481
V2V_MIN_FRAMES = 33  # v2v guide takes the last 25 frames; FRAMES must exceed 25

MODES = ("t2v", "i2v", "v2v")
DEFAULTS = {"width": 1280, "height": 720, "duration": 5.0, "fps": 24}

# title -> candidate input fields; the first one present on the node is set.
NODE_FIELDS = {
    "PROMPT": ("text",),
    "NEGATIVE": ("text",),
    "WIDTH": ("value",),
    "HEIGHT": ("value",),
    "FRAMES": ("value",),
    "FPS": ("value",),
    "SEED": ("value", "noise_seed", "seed"),
}
# INPUT node candidates per mode (core LoadImage.image, core LoadVideo.file).
INPUT_FIELDS = {"i2v": ("image", "file"), "v2v": ("file", "video")}
OUTPUT_TITLE = "OUTPUT"

_first_job = True  # process-level: first job that reaches ComfyUI is "cold"


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def err(code, message):
    # The code is also prefixed into the text in case RunPod /status drops error_code.
    return {"error": f"[{code}] {message}", "error_code": code}


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
def _num_ok(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return False
    return isinstance(v, int) or math.isfinite(v)  # ints of any size are finite


def _int(inp, name, default, lo, hi):
    v = inp.get(name)
    if v is None:
        return default
    if not _num_ok(v) or int(v) != v:
        raise JobError("bad_input", f"{name} must be an integer")
    v = int(v)
    if not lo <= v <= hi:
        raise JobError("bad_input", f"{name} must be between {lo} and {hi}")
    return v


def validate_input_key(key):
    if not isinstance(key, str) or not key:
        raise JobError("bad_input", "input_key must be a non-empty string")
    parts = key.split("/")
    if (
        not key.startswith("inputs/")
        or len(key) > 512
        or len(parts) < 2
        or any(p in ("", ".", "..") for p in parts)
        or "\\" in key
        or any(ord(c) < 32 for c in key)
    ):
        raise JobError("bad_input", "input_key must be an R2 key under inputs/")
    return key


def validate_input(inp):
    """Return the effective parameter dict, or raise JobError(bad_input)."""
    if not isinstance(inp, dict):
        raise JobError("bad_input", "input must be an object")
    mode = inp.get("mode")
    if mode not in MODES:
        raise JobError("bad_input", f"mode must be one of {', '.join(MODES)}")
    prompt = inp.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("bad_input", "prompt must be a non-empty string")
    if len(prompt) > 8000:
        raise JobError("bad_input", "prompt too long (max 8000 chars)")
    negative = inp.get("negative") or ""
    if not isinstance(negative, str) or len(negative) > 8000:
        raise JobError("bad_input", "negative must be a string (max 8000 chars)")

    input_key = inp.get("input_key")
    if mode in INPUT_FIELDS:
        if input_key is None:
            raise JobError("bad_input", f"input_key is required for {mode}")
        validate_input_key(input_key)
    elif input_key is not None:
        raise JobError("bad_input", "input_key is only valid for i2v/v2v")

    width = _int(inp, "width", DEFAULTS["width"], 256, 2048)
    height = _int(inp, "height", DEFAULTS["height"], 256, 2048)
    # The two-stage graph halves the size, so multiples of 64 keep the stage-1
    # latent a multiple of 32. Round DOWN (720 -> 704) and report the effective
    # size in the output. The 256 minimum guarantees a result of at least 256.
    width, height = width // 64 * 64, height // 64 * 64
    fps = _int(inp, "fps", DEFAULTS["fps"], 1, 60)

    if inp.get("num_frames") is not None:
        num_frames = _int(inp, "num_frames", None, 9, MAX_FRAMES)
        if num_frames % 8 != 1:
            raise JobError("bad_input", "num_frames must be 8k+1 (e.g. 121)")
    else:
        d = inp.get("duration", DEFAULTS["duration"])
        if not _num_ok(d) or not 0.3 <= d <= 20:
            raise JobError("bad_input", "duration must be between 0.3 and 20 seconds")
        num_frames = frames_for(d, fps)
        if num_frames > MAX_FRAMES:
            raise JobError(
                "bad_input",
                f"duration x fps gives {num_frames} frames; the maximum is {MAX_FRAMES} "
                f"(about {MAX_FRAMES / fps:.1f} s at {fps} fps)",
            )

    if mode == "v2v" and num_frames < V2V_MIN_FRAMES:
        raise JobError(
            "bad_input",
            f"v2v needs at least {V2V_MIN_FRAMES} frames (got {num_frames}); "
            "the guide uses the last 25 frames of the input video",
        )

    seed = _int(inp, "seed", None, 0, 2**53)
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    return {
        "mode": mode, "prompt": prompt.strip(), "negative": negative.strip(),
        "input_key": input_key, "width": width, "height": height,
        "fps": fps, "num_frames": num_frames, "seed": seed,
    }


def frames_for(duration_s, fps):
    """Nearest 8k+1 frame count to duration*fps (minimum 9)."""
    k = max(1, round((duration_s * fps - 1) / 8))
    return 8 * k + 1


# --------------------------------------------------------------------------
# R2
# --------------------------------------------------------------------------
REQUIRED_R2_ENV = ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")


def check_r2_env():
    missing = [k for k in REQUIRED_R2_ENV if not os.environ.get(k)]
    if missing:
        raise JobError("config_error", f"worker misconfigured: {', '.join(missing)} not set")


def make_r2_client():
    check_r2_env()
    return boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",  # anything else gives SignatureDoesNotMatch on R2
        config=Config(
            signature_version="s3v4",
            connect_timeout=5,
            read_timeout=30,
            # one boto attempt only: retries are the handler's bounded loop
            retries={"total_max_attempts": 1, "mode": "standard"},
            # boto3 >= 1.36 adds CRC32 trailers by default, which R2 may reject.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        ),
    )


def bucket():
    return os.environ["R2_BUCKET"]


def fetch_input(s3, key, dest):
    try:
        head = s3.head_object(Bucket=bucket(), Key=key)
        if head["ContentLength"] > INPUT_MAX_BYTES:
            raise JobError("input_fetch", "input file too large")
        s3.download_file(bucket(), key, dest)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("404", "NoSuchKey", "NotFound"):
            raise JobError("input_fetch", f"input not found: {key}")
        raise JobError("input_fetch", f"could not fetch input: {code or e}")
    except (BotoCoreError, Boto3Error, OSError) as e:
        raise JobError("input_fetch", f"could not fetch input: {e}")


def local_input_name(jid, key):
    """Bounded, filesystem-safe local name: never depends on key length."""
    ext = re.sub(r"[^A-Za-z0-9.]", "", os.path.splitext(key)[1])[:8]
    digest = hashlib.sha1(key.encode()).hexdigest()[:8]
    return f"{jid}_{digest}{ext}"


def run_bounded(fn, timeout):
    """Run fn in a daemon thread; give up after `timeout` seconds."""
    box = {}

    def target():
        try:
            box["v"] = fn()
        except BaseException as e:  # re-raised in the caller
            box["e"] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        raise TimeoutError(f"timed out after {timeout:.0f}s")
    if "e" in box:
        raise box["e"]
    return box.get("v")


def upload_retry(fn, hard_deadline):
    """Up to UPLOAD_TRIES bounded attempts; never runs past hard_deadline."""
    last = None
    for attempt in range(UPLOAD_TRIES):
        remaining = hard_deadline - time.time()  # checked before EACH try
        if remaining < 1:
            last = last or "no time left before the execution timeout"
            break
        try:
            return run_bounded(fn, min(remaining, ATTEMPT_MAX_S))
        except (ClientError, BotoCoreError, Boto3Error, TimeoutError) as e:
            last = e
            log.warning("upload attempt %d failed: %s", attempt + 1, e)
            wait = UPLOAD_BACKOFF_S * (2 ** attempt)
            if attempt + 1 >= UPLOAD_TRIES or time.time() + wait >= hard_deadline:
                break
            time.sleep(wait)
    raise JobError("upload_failed", f"could not upload result to R2: {last}")


# --------------------------------------------------------------------------
# ComfyUI
# --------------------------------------------------------------------------
def comfy_alive():
    """False only when the PID file exists and that process is gone."""
    try:
        with open(COMFY_PID_FILE) as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return True  # unknown (e.g. local dev): do not block
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def read_vram_mb():
    """Current memory.used (MiB) of the busiest GPU, or None if nvidia-smi is unusable."""
    try:
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return None
        vals = [int(x) for x in r.stdout.split() if x.strip().isdigit()]
        return max(vals) if vals else None
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


class VramSampler:
    """Samples GPU memory.used in a daemon thread; .peak_mb is the maximum seen.

    Tolerant: if nvidia-smi is absent or fails on the first sample the thread
    exits and peak_mb stays None. Includes PyTorch's allocator reserve, so it
    approaches the card size even when the model would fit (report-only number).
    """

    def __init__(self, interval=None):
        self.interval = VRAM_SAMPLE_S if interval is None else interval
        self.peak_mb = None
        self._stop = threading.Event()
        self._t = threading.Thread(target=self._run, daemon=True)

    def _sample(self):
        v = read_vram_mb()
        if v is not None and (self.peak_mb is None or v > self.peak_mb):
            self.peak_mb = v
        return v

    def _run(self):
        if self._sample() is None:
            return
        while not self._stop.wait(self.interval):
            self._sample()

    def start(self):
        self._t.start()
        return self

    def stop(self):
        self._stop.set()
        self._t.join(10)
        return self.peak_mb


def require_comfy_alive():
    if not comfy_alive():
        raise JobError("comfy_unavailable", "ComfyUI process is not running; the worker needs a restart")


def wait_for_comfy(deadline):
    end = min(deadline, time.time() + COMFY_READY_TIMEOUT_S)
    while time.time() < end:
        require_comfy_alive()
        try:
            if requests.get(f"http://{COMFY_HOST}/", timeout=5).ok:
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise JobError("comfy_unavailable", "ComfyUI did not become ready in time")


def load_workflow(mode):
    path = os.path.join(WORKFLOWS_DIR, f"{mode}.json")
    try:
        with open(path) as f:
            wf = json.load(f)
    except FileNotFoundError:
        raise JobError("workflow_mismatch", f"workflow template missing: {path}")
    except (ValueError, OSError) as e:
        raise JobError("workflow_mismatch", f"workflow template unreadable: {e}")
    if isinstance(wf, dict) and isinstance(wf.get("nodes"), list):
        raise JobError("workflow_mismatch",
                       f"{mode}.json is a UI-format workflow; export it with 'Save (API Format)'")
    if not isinstance(wf, dict) or not wf:
        raise JobError("workflow_mismatch", f"{mode}.json is not an API-format workflow object")
    for nid, node in wf.items():
        if (not isinstance(node, dict) or not isinstance(node.get("inputs"), dict)
                or not isinstance(node.get("class_type"), str)):
            raise JobError("workflow_mismatch", f"{mode}.json node {nid} is not an API-format node")
    return wf


def unique_prefix_suffix(jid):
    """Per-run token for the OUTPUT node's filename_prefix.

    ComfyUI caches by node inputs: an identical request (same prompt, seed, size) re-runs
    nothing, the save node is served from cache and reports no output file. A prefix that
    differs on every run makes only the save node re-execute while the expensive upstream
    results stay cached. The random part also covers a retry that reuses the same job id.
    """
    return f"{safe_id(jid)[:40]}_{uuid.uuid4().hex[:8]}"


def fill_workflow(wf, p, input_name, prefix_suffix=None):
    by_title = {}
    for node in wf.values():
        meta = node.get("_meta")
        title = meta.get("title") if isinstance(meta, dict) else None
        if isinstance(title, str) and title:
            by_title.setdefault(title, []).append(node)

    def put(title, fields, value, required=True):
        nodes = by_title.get(title)
        if not nodes:
            if required:
                raise JobError("workflow_mismatch", f"workflow has no node titled {title}")
            return
        for node in nodes:
            field = next((f for f in fields if f in node["inputs"]), None)
            if field is None:
                raise JobError("workflow_mismatch",
                               f"node {title} has none of the inputs {', '.join(fields)}")
            node["inputs"][field] = value

    put("PROMPT", NODE_FIELDS["PROMPT"], p["prompt"])
    put("NEGATIVE", NODE_FIELDS["NEGATIVE"], p["negative"], required=bool(p["negative"]))
    put("WIDTH", NODE_FIELDS["WIDTH"], p["width"])
    put("HEIGHT", NODE_FIELDS["HEIGHT"], p["height"])
    put("FRAMES", NODE_FIELDS["FRAMES"], p["num_frames"])
    put("FPS", NODE_FIELDS["FPS"], p["fps"])
    put("SEED", NODE_FIELDS["SEED"], p["seed"])
    if p["mode"] in INPUT_FIELDS:
        put("INPUT", INPUT_FIELDS[p["mode"]], input_name)
    if prefix_suffix:
        # keep the workflow-version marker (..._wfN) in the prefix, add the run token after it
        for node in by_title.get(OUTPUT_TITLE, []):
            pre = node["inputs"].get("filename_prefix")
            if isinstance(pre, str):
                node["inputs"]["filename_prefix"] = f"{pre}_{prefix_suffix}"
    return wf


def classify_comfy_error(text):
    t = text.lower()
    if "out of memory" in t or "oom" in t.split():
        return "oom", "GPU ran out of memory; try a lower resolution or a shorter clip"
    if "not in list" in t or "no such file" in t or ("model" in t and "not found" in t):
        return "model_missing", f"a model file is missing or misnamed on the volume: {text[:300]}"
    return "comfy_error", f"ComfyUI error: {text[:500]}"


def _comfy_request(method, path, **kw):
    """HTTP call to ComfyUI; connection problems become comfy_unavailable."""
    try:
        return requests.request(method, f"http://{COMFY_HOST}{path}", **kw)
    except requests.RequestException as e:
        require_comfy_alive()
        raise JobError("comfy_unavailable", f"could not reach ComfyUI: {type(e).__name__}")


def submit(wf):
    r = _comfy_request("POST", "/prompt", json={"prompt": wf}, timeout=30)
    if r.status_code != 200:
        code, msg = classify_comfy_error(r.text)
        if code == "comfy_error":
            if r.status_code >= 500:
                msg = f"ComfyUI server error (HTTP {r.status_code}): {r.text[:300]}"
            else:
                code = "workflow_mismatch"
                msg = f"ComfyUI rejected the workflow: {r.text[:500]}"
        raise JobError(code, msg)
    try:
        return r.json()["prompt_id"]
    except (ValueError, KeyError, TypeError):
        raise JobError("comfy_bad_response", "ComfyUI accepted the prompt but returned no prompt_id")


def wait_for_result(prompt_id, deadline):
    failures = 0
    while time.time() < deadline:
        try:
            r = _comfy_request("GET", f"/history/{prompt_id}", timeout=30)
            if r.status_code != 200:
                raise JobError("comfy_unavailable", f"ComfyUI /history returned HTTP {r.status_code}")
            body = r.json()
            if not isinstance(body, dict):
                raise ValueError("history is not an object")
            failures = 0
        except (JobError, ValueError) as e:
            failures += 1
            require_comfy_alive()
            if failures >= 3:
                if isinstance(e, JobError):
                    raise
                raise JobError("comfy_bad_response", "ComfyUI returned an unreadable history reply")
            time.sleep(POLL_INTERVAL_S)
            continue
        entry = body.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                msgs = [m for m in status.get("messages", []) if m and m[0] == "execution_error"]
                detail = ""
                if msgs:
                    d = msgs[-1][1]
                    detail = f"{d.get('exception_type', '')}: {d.get('exception_message', '')}"
                code, msg = classify_comfy_error(detail or "execution failed")
                raise JobError(code, msg)
            if entry.get("outputs") is not None and status.get("completed", True):
                return entry
        require_comfy_alive()
        time.sleep(POLL_INTERVAL_S)
    # best effort: stop the run so the GPU is free for the next job
    try:
        requests.post(f"http://{COMFY_HOST}/interrupt", timeout=5)
    except requests.RequestException:
        pass
    raise JobError("timeout", f"generation exceeded {JOB_TIMEOUT_S}s and was stopped")


def _mp4_paths(outputs):
    found = []
    for out in outputs:
        if not isinstance(out, dict):
            continue
        for items in out.values():
            if not isinstance(items, list):
                continue
            for it in items:
                if not isinstance(it, dict) or it.get("type", "output") != "output":
                    continue  # temp/preview files never count
                if not str(it.get("filename", "")).lower().endswith(".mp4"):
                    continue
                base = os.path.realpath(os.path.join(COMFY_ROOT, "output"))
                path = os.path.realpath(os.path.join(base, str(it.get("subfolder", "")), it["filename"]))
                if os.path.commonpath([path, base]) == base and os.path.isfile(path):
                    found.append(path)
    return found


def find_output_mp4(entry, wf=None):
    """Deterministic: a node titled OUTPUT wins; otherwise exactly one mp4."""
    outputs = entry.get("outputs", {})
    if wf:
        titled = [nid for nid, n in wf.items()
                  if isinstance(n.get("_meta"), dict) and n["_meta"].get("title") == OUTPUT_TITLE]
        if titled:
            found = _mp4_paths([outputs.get(nid) for nid in titled])
            if found:
                return found[0]
            raise JobError("output_missing", f"node {OUTPUT_TITLE} produced no mp4")
    found = sorted(set(_mp4_paths(outputs.values())))
    if not found:
        raise JobError("output_missing", "ComfyUI finished but produced no mp4")
    if len(found) > 1:
        raise JobError("workflow_mismatch",
                       f"workflow produced {len(found)} videos; use a single SaveVideo or title it {OUTPUT_TITLE}")
    return found[0]


def make_thumbnail(mp4, jpg):
    r = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", mp4, "-frames:v", "1", "-q:v", "3", jpg],
        capture_output=True, timeout=60,
    )
    if r.returncode != 0 or not os.path.isfile(jpg):
        raise JobError("output_missing", "could not create thumbnail")


# --------------------------------------------------------------------------
# Handler
# --------------------------------------------------------------------------
def safe_id(job_id):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(job_id))[:80] or "job"


def upload_results(s3, stem, mp4, jpg, meta, hard_deadline):
    b = bucket()
    done = []
    try:
        upload_retry(lambda: s3.upload_file(mp4, b, stem + ".mp4", ExtraArgs={"ContentType": "video/mp4"}),
                     hard_deadline)
        done.append(stem + ".mp4")
        upload_retry(lambda: s3.upload_file(jpg, b, stem + ".jpg", ExtraArgs={"ContentType": "image/jpeg"}),
                     hard_deadline)
        done.append(stem + ".jpg")
        upload_retry(lambda: s3.put_object(Bucket=b, Key=stem + ".json", Body=json.dumps(meta).encode(),
                                           ContentType="application/json"), hard_deadline)
    except JobError:
        for key in done:  # no orphans without a sidecar
            try:
                left = hard_deadline - time.time()
                if left < 1:
                    break
                run_bounded(lambda k=key: s3.delete_object(Bucket=b, Key=k), min(left, 10))
            except Exception:  # best effort
                log.warning("could not delete orphan %s", key)
        raise


def run_job(job):
    global _first_job
    t0 = time.time()
    deadline = t0 + JOB_TIMEOUT_S
    p = validate_input(job.get("input"))
    check_r2_env()  # fail before any download or GPU work
    jid = safe_id(job.get("id", "local"))
    now = datetime.datetime.now(datetime.timezone.utc)
    stem = f"outputs/{now:%Y-%m-%d}/{now:%Y%m%dT%H%M%S}-{jid}"

    s3 = make_r2_client()
    input_name = local_input_name(jid, p["input_key"]) if p["input_key"] else None
    work = tempfile.mkdtemp(prefix="ltx25-")
    created = []
    try:
        # Cheap local checks first, then the input download, then the wait on ComfyUI.
        wf = fill_workflow(load_workflow(p["mode"]), p, input_name,
                           prefix_suffix=unique_prefix_suffix(jid))
        if p["input_key"]:
            dest = os.path.join(COMFY_ROOT, "input", input_name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            created.append(dest)
            fetch_input(s3, p["input_key"], dest)

        wait_for_comfy(deadline)
        require_comfy_alive()
        gen_start = time.time()
        sampler = VramSampler().start()
        try:
            prompt_id = submit(wf)
            cold = _first_job  # only a job that reached ComfyUI consumes the cold flag
            _first_job = False
            entry = wait_for_result(prompt_id, deadline)
        finally:
            peak_vram_mb = sampler.stop()
        gen_time = round(time.time() - gen_start, 2)

        mp4 = find_output_mp4(entry, wf)
        created.append(mp4)
        jpg = os.path.join(work, "thumb.jpg")
        make_thumbnail(mp4, jpg)

        meta = {
            "v": CONTRACT_VERSION, "job_id": jid, "created_at": now.isoformat(),
            "mode": p["mode"], "prompt": p["prompt"], "negative": p["negative"],
            "input_key": p["input_key"], "seed": p["seed"], "width": p["width"],
            "height": p["height"], "num_frames": p["num_frames"], "fps": p["fps"],
            "gen_time_s": gen_time, "cold": cold, "peak_vram_mb": peak_vram_mb,
        }
        upload_results(s3, stem, mp4, jpg, meta, t0 + PLATFORM_LIMIT_S - SAFETY_S)

        return {
            "v": CONTRACT_VERSION, "key": stem + ".mp4", "thumb_key": stem + ".jpg",
            "meta_key": stem + ".json",
            "duration_s": round(p["num_frames"] / p["fps"], 3), "gen_time_s": gen_time,
            "seed": p["seed"], "width": p["width"], "height": p["height"],
            "num_frames": p["num_frames"], "fps": p["fps"], "cold": cold,
            "peak_vram_mb": peak_vram_mb,
        }
    finally:
        for f in created:
            try:
                os.remove(f)
            except OSError:
                pass
        shutil.rmtree(work, ignore_errors=True)


def handler(job):
    try:
        return run_job(job)
    except JobError as e:
        log.error("job failed: %s: %s", e.code, e.message)
        return err(e.code, e.message)
    except Exception as e:  # never leak a traceback shape to the caller
        log.exception("unexpected error")
        return err("comfy_error", f"unexpected worker error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    import runpod

    logging.basicConfig(level=logging.INFO)
    runpod.serverless.start({"handler": handler})

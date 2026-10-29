"""RunPod serverless handler for LTX-2.5 via the in-container ComfyUI.

Contract v1
-----------
Input (job["input"]):
    mode        "t2v" | "i2v" | "v2v"                       required
    prompt      non-empty str                                required
    negative    str                                          optional
    input_key   R2 key under "inputs/"                       required for i2v/v2v
    width, height   256..2048, rounded down to a multiple of 32 default 1280x720 (-> 1280x704)
    duration    seconds (float)                              default 5
    fps         1..60                                        default 24
    num_frames  int, must be 8k+1; overrides duration        optional
    seed        int >= 0                                     default random
Output (success):
    {v, key, thumb_key, meta_key, duration_s, gen_time_s, seed,
     width, height, num_frames, fps, cold}
Output (failure): {"error": str, "error_code": code}  (RunPod marks FAILED)
    codes: bad_input oom model_missing timeout input_fetch workflow_mismatch
           comfy_error output_missing upload_failed

R2 keys: outputs/<YYYY-MM-DD UTC>/<YYYYMMDDTHHMMSS>-<job_id>.mp4|.jpg|.json

Workflow templates (/runpod-volume/workflows/<mode>.json, API format) are
filled by node `_meta.title` (see NODE_FIELDS), never by numeric node id.
"""
import datetime
import json
import logging
import os
import random
import re
import shutil
import subprocess
import tempfile
import time

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

log = logging.getLogger("ltx25-worker")

CONTRACT_VERSION = 1
COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_ROOT = os.environ.get("COMFY_ROOT", "/comfyui")
WORKFLOWS_DIR = os.environ.get("WORKFLOWS_DIR", "/runpod-volume/workflows")
# Must stay below the platform execution timeout (15 min) so the caller gets a
# readable error instead of a killed job.
JOB_TIMEOUT_S = int(os.environ.get("JOB_TIMEOUT_S", "840"))
COMFY_READY_TIMEOUT_S = int(os.environ.get("COMFY_READY_TIMEOUT_S", "300"))
INPUT_MAX_BYTES = int(os.environ.get("INPUT_MAX_BYTES", str(500 * 1024 * 1024)))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "1.0"))

MODES = ("t2v", "i2v", "v2v")
DEFAULTS = {"width": 1280, "height": 720, "duration": 5.0, "fps": 24}

# title -> input field set on that node. Documented for workflows/README.md.
NODE_FIELDS = {
    "PROMPT": "text",
    "NEGATIVE": "text",
    "WIDTH": "value",
    "HEIGHT": "value",
    "FRAMES": "value",
    "FPS": "value",
    "SEED": "value",
}
# Field on the INPUT node, per mode.
INPUT_FIELD = {"i2v": "image", "v2v": "video"}

_first_job = True  # process-level: first job after boot is a "cold" job


class JobError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def err(code, message):
    return {"error": message, "error_code": code}


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
def _int(inp, name, default, lo, hi):
    v = inp.get(name)
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v:
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
    if mode in INPUT_FIELD:
        if input_key is None:
            raise JobError("bad_input", f"input_key is required for {mode}")
        validate_input_key(input_key)
    elif input_key is not None:
        raise JobError("bad_input", "input_key is only valid for i2v/v2v")

    width = _int(inp, "width", DEFAULTS["width"], 256, 2048)
    height = _int(inp, "height", DEFAULTS["height"], 256, 2048)
    # LTX needs multiples of 32; 720 is not one, so round DOWN (720 -> 704) and
    # report the effective size in the output.
    width, height = width // 32 * 32, height // 32 * 32
    fps = _int(inp, "fps", DEFAULTS["fps"], 1, 60)

    if inp.get("num_frames") is not None:
        num_frames = _int(inp, "num_frames", None, 9, 481)
        if num_frames % 8 != 1:
            raise JobError("bad_input", "num_frames must be 8k+1 (e.g. 121)")
    else:
        d = inp.get("duration", DEFAULTS["duration"])
        if isinstance(d, bool) or not isinstance(d, (int, float)) or not 0.3 <= d <= 20:
            raise JobError("bad_input", "duration must be between 0.3 and 20 seconds")
        num_frames = frames_for(d, fps)

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
def make_r2_client():
    try:
        account = os.environ["R2_ACCOUNT_ID"]
        key_id = os.environ["R2_ACCESS_KEY_ID"]
        secret = os.environ["R2_SECRET_ACCESS_KEY"]
    except KeyError as e:
        raise JobError("upload_failed", f"worker misconfigured: {e.args[0]} not set")
    return boto3.client(
        "s3",
        endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
        aws_access_key_id=key_id,
        aws_secret_access_key=secret,
        region_name="auto",  # anything else gives SignatureDoesNotMatch on R2
        config=Config(signature_version="s3v4", retries={"max_attempts": 5, "mode": "standard"}),
    )


def bucket():
    b = os.environ.get("R2_BUCKET")
    if not b:
        raise JobError("upload_failed", "worker misconfigured: R2_BUCKET not set")
    return b


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
    except BotoCoreError as e:
        raise JobError("input_fetch", f"could not fetch input: {e}")


# --------------------------------------------------------------------------
# ComfyUI
# --------------------------------------------------------------------------
def wait_for_comfy(deadline):
    end = min(deadline, time.time() + COMFY_READY_TIMEOUT_S)
    while time.time() < end:
        try:
            if requests.get(f"http://{COMFY_HOST}/", timeout=5).ok:
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise JobError("comfy_error", "ComfyUI did not become ready in time")


def load_workflow(mode):
    path = os.path.join(WORKFLOWS_DIR, f"{mode}.json")
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        raise JobError("workflow_mismatch", f"workflow template missing: {path}")
    except ValueError as e:
        raise JobError("workflow_mismatch", f"workflow template invalid JSON: {e}")


def fill_workflow(wf, p, input_name):
    by_title = {}
    for nid, node in wf.items():
        title = (node.get("_meta") or {}).get("title")
        if title:
            by_title.setdefault(title, []).append(node)

    def put(title, field, value, required=True):
        nodes = by_title.get(title)
        if not nodes:
            if required:
                raise JobError("workflow_mismatch", f"workflow has no node titled {title}")
            return
        for node in nodes:
            if field not in node.get("inputs", {}):
                raise JobError("workflow_mismatch", f"node {title} has no input '{field}'")
            node["inputs"][field] = value

    put("PROMPT", NODE_FIELDS["PROMPT"], p["prompt"])
    put("NEGATIVE", NODE_FIELDS["NEGATIVE"], p["negative"], required=bool(p["negative"]))
    put("WIDTH", NODE_FIELDS["WIDTH"], p["width"])
    put("HEIGHT", NODE_FIELDS["HEIGHT"], p["height"])
    put("FRAMES", NODE_FIELDS["FRAMES"], p["num_frames"])
    put("FPS", NODE_FIELDS["FPS"], p["fps"])
    put("SEED", NODE_FIELDS["SEED"], p["seed"])
    if p["mode"] in INPUT_FIELD:
        put("INPUT", INPUT_FIELD[p["mode"]], input_name)
    return wf


def classify_comfy_error(text):
    t = text.lower()
    if "out of memory" in t or "oom" in t.split():
        return "oom", "GPU ran out of memory; try a lower resolution or a shorter clip"
    if "not in list" in t or "no such file" in t or ("model" in t and "not found" in t):
        return "model_missing", f"a model file is missing or misnamed on the volume: {text[:300]}"
    return "comfy_error", f"ComfyUI error: {text[:500]}"


def submit(wf):
    r = requests.post(f"http://{COMFY_HOST}/prompt", json={"prompt": wf}, timeout=30)
    if r.status_code != 200:
        code, msg = classify_comfy_error(r.text)
        if code == "comfy_error":
            code = "workflow_mismatch"
            msg = f"ComfyUI rejected the workflow: {r.text[:500]}"
        raise JobError(code, msg)
    return r.json()["prompt_id"]


def wait_for_result(prompt_id, deadline):
    while time.time() < deadline:
        r = requests.get(f"http://{COMFY_HOST}/history/{prompt_id}", timeout=30)
        entry = r.json().get(prompt_id) if r.ok else None
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
        time.sleep(POLL_INTERVAL_S)
    # best effort: stop the run so the GPU is free for the next job
    try:
        requests.post(f"http://{COMFY_HOST}/interrupt", timeout=5)
    except requests.RequestException:
        pass
    raise JobError("timeout", f"generation exceeded {JOB_TIMEOUT_S}s and was stopped")


def find_output_mp4(entry):
    for out in entry.get("outputs", {}).values():
        for items in out.values():
            if not isinstance(items, list):
                continue
            for it in items:
                if isinstance(it, dict) and str(it.get("filename", "")).lower().endswith(".mp4"):
                    base = os.path.join(COMFY_ROOT, "temp" if it.get("type") == "temp" else "output")
                    path = os.path.realpath(os.path.join(base, it.get("subfolder", ""), it["filename"]))
                    if os.path.commonpath([path, os.path.realpath(base)]) != os.path.realpath(base):
                        continue
                    if os.path.isfile(path):
                        return path
    raise JobError("output_missing", "ComfyUI finished but produced no mp4")


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


def run_job(job):
    global _first_job
    cold = _first_job
    _first_job = False
    t0 = time.time()
    deadline = t0 + JOB_TIMEOUT_S
    p = validate_input(job.get("input"))
    jid = safe_id(job.get("id", "local"))
    now = datetime.datetime.now(datetime.timezone.utc)
    stem = f"outputs/{now:%Y-%m-%d}/{now:%Y%m%dT%H%M%S}-{jid}"

    s3 = make_r2_client()
    input_name = None
    work = tempfile.mkdtemp(prefix="ltx25-")
    created = []
    try:
        # Download the input first, before waiting on ComfyUI / models.
        if p["input_key"]:
            input_name = f"{jid}_{os.path.basename(p['input_key'])}"
            dest = os.path.join(COMFY_ROOT, "input", input_name)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            created.append(dest)
            fetch_input(s3, p["input_key"], dest)

        wf = fill_workflow(load_workflow(p["mode"]), p, input_name)
        wait_for_comfy(deadline)
        gen_start = time.time()
        entry = wait_for_result(submit(wf), deadline)
        gen_time = round(time.time() - gen_start, 2)

        mp4 = find_output_mp4(entry)
        created.append(mp4)
        jpg = os.path.join(work, "thumb.jpg")
        make_thumbnail(mp4, jpg)

        meta = {
            "v": CONTRACT_VERSION, "job_id": jid, "created_at": now.isoformat(),
            "mode": p["mode"], "prompt": p["prompt"], "negative": p["negative"],
            "input_key": p["input_key"], "seed": p["seed"], "width": p["width"],
            "height": p["height"], "num_frames": p["num_frames"], "fps": p["fps"],
            "gen_time_s": gen_time, "cold": cold,
        }
        try:
            b = bucket()
            s3.upload_file(mp4, b, stem + ".mp4", ExtraArgs={"ContentType": "video/mp4"})
            s3.upload_file(jpg, b, stem + ".jpg", ExtraArgs={"ContentType": "image/jpeg"})
            s3.put_object(Bucket=b, Key=stem + ".json", Body=json.dumps(meta).encode(),
                          ContentType="application/json")
        except (ClientError, BotoCoreError) as e:
            raise JobError("upload_failed", f"could not upload result to R2: {e}")

        return {
            "v": CONTRACT_VERSION, "key": stem + ".mp4", "thumb_key": stem + ".jpg",
            "meta_key": stem + ".json",
            "duration_s": round(p["num_frames"] / p["fps"], 3), "gen_time_s": gen_time,
            "seed": p["seed"], "width": p["width"], "height": p["height"],
            "num_frames": p["num_frames"], "fps": p["fps"], "cold": cold,
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

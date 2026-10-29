"""Handler tests: no GPU, no network. ComfyUI HTTP and R2 are faked."""
import json
import os
import re
import sys

import pytest
from boto3.exceptions import S3UploadFailedError
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "worker"))
import handler  # noqa: E402


def _node(cls, title, field, default):
    return {"class_type": cls, "_meta": {"title": title}, "inputs": {field: default}}


WF = {
    "1": _node("CLIPTextEncode", "PROMPT", "text", ""),
    "2": _node("CLIPTextEncode", "NEGATIVE", "text", ""),
    "3": _node("PrimitiveInt", "WIDTH", "value", 0),
    "4": _node("PrimitiveInt", "HEIGHT", "value", 0),
    "5": _node("PrimitiveInt", "FRAMES", "value", 0),
    "6": _node("PrimitiveInt", "FPS", "value", 0),
    "7": _node("PrimitiveInt", "SEED", "value", 0),
    "8": _node("LoadImage", "INPUT", "image", ""),
}


class FakeS3:
    def __init__(self):
        self.uploads, self.puts, self.downloads = {}, {}, []
        self.missing = False
        self.fail_put = False
        self.fail_upload_keys = ()
        self.upload_calls = 0
        self.deleted = []

    def head_object(self, Bucket, Key):
        if self.missing:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": 10}

    def download_file(self, Bucket, Key, dest):
        self.downloads.append((Bucket, Key))
        with open(dest, "wb") as f:
            f.write(b"img")

    def upload_file(self, path, Bucket, Key, ExtraArgs=None):
        self.upload_calls += 1
        if self.fail_upload_keys and Key.endswith(self.fail_upload_keys):
            raise S3UploadFailedError("Failed to upload: 403 Forbidden")
        with open(path, "rb") as f:
            self.uploads[Key] = (f.read(), ExtraArgs)

    def put_object(self, Bucket, Key, Body, ContentType):
        if self.fail_put:
            raise ClientError({"Error": {"Code": "500"}}, "PutObject")
        self.puts[Key] = json.loads(Body)

    def delete_object(self, Bucket, Key):
        self.deleted.append(Key)
        self.uploads.pop(Key, None)


class Resp:
    def __init__(self, status=200, data=None, text=""):
        self.status_code, self._d, self.text = status, data, text or json.dumps(data)
        self.ok = status == 200

    def json(self):
        return self._d


@pytest.fixture
def env(tmp_path, monkeypatch):
    comfy = tmp_path / "comfy"
    (comfy / "output").mkdir(parents=True)
    wfdir = tmp_path / "wf"
    wfdir.mkdir()
    for m in handler.MODES:
        (wfdir / f"{m}.json").write_text(json.dumps(WF))
    monkeypatch.setattr(handler, "COMFY_ROOT", str(comfy))
    monkeypatch.setattr(handler, "WORKFLOWS_DIR", str(wfdir))
    monkeypatch.setattr(handler, "POLL_INTERVAL_S", 0)
    monkeypatch.setattr(handler, "_first_job", True)
    monkeypatch.setattr(handler, "UPLOAD_BACKOFF_S", 0)
    monkeypatch.setattr(handler, "COMFY_PID_FILE", str(tmp_path / "nopid"))
    for k, val in dict(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID="k",
                       R2_SECRET_ACCESS_KEY="s", R2_BUCKET="bkt").items():
        monkeypatch.setenv(k, val)
    s3 = FakeS3()
    monkeypatch.setattr(handler, "make_r2_client", lambda: s3)

    def fake_thumb(mp4, jpg):
        with open(jpg, "wb") as f:
            f.write(b"jpg")

    monkeypatch.setattr(handler, "make_thumbnail", fake_thumb)
    sent = {}
    state = {"history": None, "post": None}

    def request(method, url, json=None, timeout=None):
        if state.get("raise"):
            raise handler.requests.ConnectionError("boom")
        if url.endswith("/prompt"):
            sent["wf"] = json["prompt"]
            return state["post"] or Resp(200, {"prompt_id": "pid"})
        if "/history/" in url:
            return state.get("hist_resp") or Resp(
                200, state["history"] if state["history"] is not None else {})
        return Resp(200, {})

    monkeypatch.setattr(handler.requests, "request", request)
    monkeypatch.setattr(handler.requests, "get", lambda url, timeout=None: Resp(200, {}))
    monkeypatch.setattr(handler.requests, "post", lambda url, timeout=None: Resp(200, {}))

    def finish():
        (comfy / "output" / "out.mp4").write_bytes(b"mp4data")
        state["history"] = {"pid": {
            "status": {"status_str": "success", "completed": True},
            "outputs": {"9": {"images": [{"filename": "out.mp4", "subfolder": "", "type": "output"}]}}}}

    return type("E", (), dict(s3=s3, sent=sent, state=state, finish=staticmethod(finish),
                              comfy=comfy, wfdir=wfdir))


# ---- validation ----------------------------------------------------------
def v(**kw):
    base = {"mode": "t2v", "prompt": "a cat"}
    base.update(kw)
    return base


def code_of(inp):
    with pytest.raises(handler.JobError) as e:
        handler.validate_input(inp)
    return e.value.code


def test_defaults():
    p = handler.validate_input(v())
    assert (p["width"], p["height"], p["fps"], p["num_frames"]) == (1280, 704, 24, 121)
    assert isinstance(p["seed"], int)


@pytest.mark.parametrize("inp", [
    None, v(mode="x"), v(prompt=""), v(prompt="  "),
    v(width=64), v(fps=0), v(num_frames=120), v(duration=0), v(duration=999),
    v(mode="i2v"), v(mode="v2v"), v(input_key="inputs/a.png"), v(seed=-1), v(width="1280"),
])
def test_bad_input(inp):
    assert code_of(inp) == "bad_input"


@pytest.mark.parametrize("key", [
    "outputs/x.mp4", "/inputs/a.png", "inputs/../outputs/a", "inputs/", "inputs//a",
    "http://evil/inputs/a", "inputs\\a", "inputs/./a", "", 5,
])
def test_input_key_rejected(key):
    assert code_of(v(mode="i2v", input_key=key)) == "bad_input"


def test_size_rounded_down_to_32():
    p = handler.validate_input(v(width=1000, height=721))
    assert (p["width"], p["height"]) == (992, 704)


def test_input_key_ok():
    assert handler.validate_input(v(mode="i2v", input_key="inputs/2026/a b.png"))["input_key"]


@pytest.mark.parametrize("d,fps,exp", [(5, 24, 121), (1, 24, 25), (0.3, 24, 9), (10, 25, 249), (5.04, 24, 121)])
def test_frame_rounding(d, fps, exp):
    n = handler.frames_for(d, fps)
    assert n == exp and n % 8 == 1


def test_explicit_frames_override():
    assert handler.validate_input(v(num_frames=97, duration=10))["num_frames"] == 97


# ---- R2 client -----------------------------------------------------------
def test_r2_client_args(monkeypatch):
    for k, val in dict(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID="k", R2_SECRET_ACCESS_KEY="s", R2_BUCKET="b").items():
        monkeypatch.setenv(k, val)
    seen = {}
    monkeypatch.setattr(handler.boto3, "client", lambda *a, **kw: seen.update(a=a, kw=kw) or object())
    handler.make_r2_client()
    assert seen["a"] == ("s3",)
    assert seen["kw"]["endpoint_url"] == "https://acct123.r2.cloudflarestorage.com"
    assert seen["kw"]["region_name"] == "auto"


def test_r2_client_real_boto(monkeypatch):
    for k, val in dict(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID="k", R2_SECRET_ACCESS_KEY="s", R2_BUCKET="b").items():
        monkeypatch.setenv(k, val)
    c = handler.make_r2_client()
    assert c.meta.endpoint_url == "https://acct123.r2.cloudflarestorage.com"
    assert c.meta.region_name == "auto"


# ---- end to end ----------------------------------------------------------
def test_t2v_success(env):
    env.finish()
    out = handler.handler({"id": "abc-123-u1", "input": v(prompt="hello", negative="blur", seed=7)})
    assert "error" not in out
    assert re.fullmatch(r"outputs/\d{4}-\d\d-\d\d/\d{8}T\d{6}-abc-123-u1\.mp4", out["key"])
    assert out["thumb_key"].endswith(".jpg") and out["meta_key"].endswith(".json")
    assert out["key"][:-4] == out["thumb_key"][:-4] == out["meta_key"][:-5]
    assert (out["v"], out["seed"], out["width"], out["num_frames"], out["fps"], out["cold"]) == (1, 7, 1280, 121, 24, True)
    assert out["duration_s"] == pytest.approx(121 / 24, abs=0.001)
    assert env.s3.uploads[out["key"]][1] == {"ContentType": "video/mp4"}
    meta = env.s3.puts[out["meta_key"]]
    assert meta["prompt"] == "hello" and meta["seed"] == 7
    wf = env.sent["wf"]
    assert wf["1"]["inputs"]["text"] == "hello" and wf["2"]["inputs"]["text"] == "blur"
    assert (wf["3"]["inputs"]["value"], wf["5"]["inputs"]["value"], wf["7"]["inputs"]["value"]) == (1280, 121, 7)
    env.finish()
    assert handler.handler({"id": "j2", "input": v()})["cold"] is False


def test_i2v_downloads_input_and_cleans_up(env):
    env.finish()
    out = handler.handler({"id": "j", "input": v(mode="i2v", input_key="inputs/d/pic.png")})
    assert "error" not in out
    assert env.s3.downloads == [("bkt", "inputs/d/pic.png")]
    name = env.sent["wf"]["8"]["inputs"]["image"]
    assert re.fullmatch(r"j_[0-9a-f]{8}\.png", name)
    assert not os.path.exists(env.comfy / "input" / name)
    assert not os.path.exists(env.comfy / "output" / "out.mp4")


def test_job_id_made_key_safe(env):
    env.finish()
    out = handler.handler({"id": "../x y", "input": v()})
    assert "/../" not in out["key"] and " " not in out["key"]


def test_bad_input_returns_error_shape(env):
    out = handler.handler({"id": "j", "input": v(mode="nope")})
    assert out["error_code"] == "bad_input" and out["error"]


def test_input_not_found(env):
    env.s3.missing = True
    out = handler.handler({"id": "j", "input": v(mode="i2v", input_key="inputs/a.png")})
    assert out["error_code"] == "input_fetch" and "not found" in out["error"]


def test_workflow_mismatch_missing_title(env):
    wf = {k: x for k, x in WF.items() if x["_meta"]["title"] != "SEED"}
    (env.wfdir / "t2v.json").write_text(json.dumps(wf))
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "workflow_mismatch"


def test_workflow_template_missing(env):
    os.remove(env.wfdir / "t2v.json")
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "workflow_mismatch"


def test_comfy_rejects_prompt_model_missing(env):
    env.state["post"] = Resp(400, text="Value not in list: unet_name: 'x.safetensors' not in []")
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "model_missing"


def test_comfy_oom(env):
    env.state["history"] = {"pid": {"status": {"status_str": "error", "messages": [
        ["execution_error", {"exception_type": "torch.OutOfMemoryError",
                             "exception_message": "CUDA out of memory"}]]}, "outputs": {}}}
    out = handler.handler({"id": "j", "input": v()})
    assert out["error_code"] == "oom" and "memory" in out["error"]


def test_timeout(env, monkeypatch):
    monkeypatch.setattr(handler, "JOB_TIMEOUT_S", 0.05)
    env.state["history"] = {}
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "timeout"


def test_no_mp4_in_output(env):
    env.state["history"] = {"pid": {"status": {"status_str": "success", "completed": True},
                                    "outputs": {"9": {"images": []}}}}
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "output_missing"


def test_output_path_traversal_ignored(env):
    (env.comfy / "secret.mp4").write_bytes(b"x")
    env.state["history"] = {"pid": {"status": {"status_str": "success", "completed": True}, "outputs": {
        "9": {"images": [{"filename": "secret.mp4", "subfolder": "..", "type": "output"}]}}}}
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "output_missing"


# ---- fix round ------------------------------------------------------------
def test_a1_upload_s3uploadfailederror_is_upload_failed(env):
    env.finish()
    env.s3.fail_upload_keys = (".mp4",)
    out = handler.handler({"id": "j", "input": v()})
    assert out["error_code"] == "upload_failed"
    assert env.s3.upload_calls == handler.UPLOAD_TRIES  # bounded retry (Q4)


def test_a12_orphan_mp4_deleted_when_jpg_fails(env):
    env.finish()
    env.s3.fail_upload_keys = (".jpg",)
    out = handler.handler({"id": "j", "input": v()})
    assert out["error_code"] == "upload_failed"
    assert any(k.endswith(".mp4") for k in env.s3.deleted)
    assert not env.s3.uploads


def test_a12_orphans_deleted_when_sidecar_fails(env):
    env.finish()
    env.s3.fail_put = True
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "upload_failed"
    assert len(env.s3.deleted) == 2 and not env.s3.uploads


def test_upload_retry_succeeds_on_second_try(env):
    env.finish()
    calls = {"n": 0}
    orig = env.s3.upload_file

    def flaky(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise S3UploadFailedError("transient")
        return orig(*a, **kw)

    env.s3.upload_file = flaky
    assert "error" not in handler.handler({"id": "j", "input": v()})


def test_a2_missing_bucket_fails_before_generation(env, monkeypatch):
    monkeypatch.delenv("R2_BUCKET")
    out = handler.handler({"id": "j", "input": v()})
    assert out["error_code"] == "config_error" and "R2_BUCKET" in out["error"]
    assert "wf" not in env.sent


def test_a3_rejected_job_keeps_cold_flag(env):
    handler.handler({"id": "bad", "input": v(mode="nope")})
    env.finish()
    assert handler.handler({"id": "j", "input": v()})["cold"] is True


def test_a4_duration_times_fps_capped():
    assert code_of(v(duration=20, fps=60)) == "bad_input"
    assert handler.validate_input(v(duration=20, fps=24))["num_frames"] == 481


def test_a5_client_timeouts_and_checksums(monkeypatch):
    for k, val in dict(R2_ACCOUNT_ID="a", R2_ACCESS_KEY_ID="k",
                       R2_SECRET_ACCESS_KEY="s", R2_BUCKET="b").items():
        monkeypatch.setenv(k, val)
    cfg = handler.make_r2_client().meta.config
    assert cfg.connect_timeout == 10 and cfg.read_timeout == 60
    assert cfg.request_checksum_calculation == "when_required"
    assert cfg.response_checksum_validation == "when_required"


def test_a6_long_basename_is_bounded(env):
    env.finish()
    key = "inputs/" + "\u732b" * 90 + ".png"
    out = handler.handler({"id": "j", "input": v(mode="i2v", input_key=key)})
    assert "error" not in out
    assert len(env.sent["wf"]["8"]["inputs"]["image"].encode()) < 60


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), -float("inf")])
@pytest.mark.parametrize("field", ["width", "height", "fps", "seed", "num_frames", "duration"])
def test_a8_nan_inf_rejected(field, bad):
    assert code_of(v(**{field: bad})) == "bad_input"


def test_a7_connection_error_on_submit(env):
    env.state["raise"] = True
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "comfy_unavailable"


class BadJson(Resp):
    def json(self):
        raise ValueError("no json")


def test_a7_non_json_and_missing_prompt_id(env):
    env.state["post"] = BadJson(200, text="<html>")
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "comfy_bad_response"
    env.state["post"] = Resp(200, {"oops": 1})
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "comfy_bad_response"


def test_a7_history_non_json_gives_bad_response(env):
    env.state["hist_resp"] = BadJson(200, text="x")
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "comfy_bad_response"


def test_a7_dead_comfy_pid_fails_fast(env, tmp_path, monkeypatch):
    import subprocess
    pr = subprocess.Popen(["true"])
    pr.wait()
    pidf = tmp_path / "pid"
    pidf.write_text(str(pr.pid))
    monkeypatch.setattr(handler, "COMFY_PID_FILE", str(pidf))
    out = handler.handler({"id": "j", "input": v()})
    assert out["error_code"] == "comfy_unavailable" and "wf" not in env.sent


def test_a7_live_pid_ok(env, tmp_path, monkeypatch):
    pidf = tmp_path / "pid"
    pidf.write_text(str(os.getpid()))
    monkeypatch.setattr(handler, "COMFY_PID_FILE", str(pidf))
    env.finish()
    assert "error" not in handler.handler({"id": "j", "input": v()})


@pytest.mark.parametrize("content", [
    {"nodes": [{"id": 1}], "links": []}, [1, 2], {}, {"1": {"class_type": "X", "inputs": None}},
    {"1": "str"}, {"1": {"inputs": {}}},
])
def test_a9_malformed_workflows(env, content):
    (env.wfdir / "t2v.json").write_text(json.dumps(content))
    assert handler.handler({"id": "j", "input": v()})["error_code"] == "workflow_mismatch"


def test_a11_v2v_loadvideo_file_field(env):
    wf = json.loads(json.dumps(WF))
    wf["8"] = _node("LoadVideo", "INPUT", "file", "")
    (env.wfdir / "v2v.json").write_text(json.dumps(wf))
    env.finish()
    out = handler.handler({"id": "j", "input": v(mode="v2v", input_key="inputs/c.mp4")})
    assert "error" not in out
    assert env.sent["wf"]["8"]["inputs"]["file"].endswith(".mp4")


def test_a11_seed_noise_seed_field(env):
    wf = json.loads(json.dumps(WF))
    wf["7"] = _node("RandomNoise", "SEED", "noise_seed", 0)
    (env.wfdir / "t2v.json").write_text(json.dumps(wf))
    env.finish()
    handler.handler({"id": "j", "input": v(seed=5)})
    assert env.sent["wf"]["7"]["inputs"]["noise_seed"] == 5


def test_q13_workflow_checked_before_download(env):
    os.remove(env.wfdir / "i2v.json")
    out = handler.handler({"id": "j", "input": v(mode="i2v", input_key="inputs/a.png")})
    assert out["error_code"] == "workflow_mismatch" and env.s3.downloads == []


def test_q14_titled_output_wins_and_multiple_rejected(env):
    wf = json.loads(json.dumps(WF))
    wf["9"] = {"class_type": "SaveVideo", "_meta": {"title": "OUTPUT"}, "inputs": {}}
    (env.wfdir / "t2v.json").write_text(json.dumps(wf))
    (env.comfy / "output" / "a.mp4").write_bytes(b"a")
    (env.comfy / "output" / "b.mp4").write_bytes(b"b")
    env.state["history"] = {"pid": {"status": {"status_str": "success", "completed": True}, "outputs": {
        "3": {"images": [{"filename": "a.mp4", "subfolder": "", "type": "output"}]},
        "9": {"images": [{"filename": "b.mp4", "subfolder": "", "type": "output"}]}}}}
    out = handler.handler({"id": "j", "input": v()})
    assert "error" not in out and env.s3.uploads[out["key"]][0] == b"b"
    (env.wfdir / "t2v.json").write_text(json.dumps(WF))
    (env.comfy / "output" / "a.mp4").write_bytes(b"a")
    (env.comfy / "output" / "b.mp4").write_bytes(b"b")
    assert handler.handler({"id": "j2", "input": v()})["error_code"] == "workflow_mismatch"
    env.state["history"]["pid"]["outputs"]["3"]["images"][0]["type"] = "temp"
    (env.comfy / "output" / "b.mp4").write_bytes(b"b")
    assert "error" not in handler.handler({"id": "j3", "input": v()})

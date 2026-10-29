"""Handler tests: no GPU, no network. ComfyUI HTTP and R2 are faked."""
import json
import os
import re
import sys

import pytest
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

    def head_object(self, Bucket, Key):
        if self.missing:
            raise ClientError({"Error": {"Code": "404"}}, "HeadObject")
        return {"ContentLength": 10}

    def download_file(self, Bucket, Key, dest):
        self.downloads.append((Bucket, Key))
        with open(dest, "wb") as f:
            f.write(b"img")

    def upload_file(self, path, Bucket, Key, ExtraArgs=None):
        with open(path, "rb") as f:
            self.uploads[Key] = (f.read(), ExtraArgs)

    def put_object(self, Bucket, Key, Body, ContentType):
        self.puts[Key] = json.loads(Body)


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

    def post(url, json=None, timeout=None):
        if url.endswith("/prompt"):
            sent["wf"] = json["prompt"]
            return state["post"] or Resp(200, {"prompt_id": "pid"})
        return Resp(200, {})

    def get(url, timeout=None):
        if "/history/" in url:
            return Resp(200, state["history"] if state["history"] is not None else {})
        return Resp(200, {})

    monkeypatch.setattr(handler.requests, "post", post)
    monkeypatch.setattr(handler.requests, "get", get)

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
    for k, val in dict(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID="k", R2_SECRET_ACCESS_KEY="s").items():
        monkeypatch.setenv(k, val)
    seen = {}
    monkeypatch.setattr(handler.boto3, "client", lambda *a, **kw: seen.update(a=a, kw=kw) or object())
    handler.make_r2_client()
    assert seen["a"] == ("s3",)
    assert seen["kw"]["endpoint_url"] == "https://acct123.r2.cloudflarestorage.com"
    assert seen["kw"]["region_name"] == "auto"


def test_r2_client_real_boto(monkeypatch):
    for k, val in dict(R2_ACCOUNT_ID="acct123", R2_ACCESS_KEY_ID="k", R2_SECRET_ACCESS_KEY="s").items():
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
    assert env.sent["wf"]["8"]["inputs"]["image"] == "j_pic.png"
    assert not os.path.exists(env.comfy / "input" / "j_pic.png")
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

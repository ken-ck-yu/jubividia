#!/usr/bin/env python3
"""Checks for workflows/*.json (ComfyUI API format).  Standard library only.

    check_workflows.py static --workflows DIR --lock models.lock --readme README.md
        No docker, no ComfyUI: structure, titles, links, model filenames, version marker.

    check_workflows.py live --workflows DIR --handler-dir DIR [--host 127.0.0.1:8188]
        Runs INSIDE the worker image against a running `main.py --cpu`:
        lint against /object_info, then POST every workflow, filled by the
        handler's own fill_workflow, to /prompt (HTTP 200 and no node_errors).

Exit status 0 only if every check passes.
"""
import argparse
import glob
import json
import os
import re
import sys
import urllib.error
import urllib.request

# --- the handler contract (worker/handler.py NODE_FIELDS / INPUT_FIELDS) -----
# title -> (class_type, input field the handler sets)
CONTRACT = {
    "PROMPT": ("CLIPTextEncode", "text"),
    "NEGATIVE": ("CLIPTextEncode", "text"),
    "WIDTH": ("PrimitiveInt", "value"),
    "HEIGHT": ("PrimitiveInt", "value"),
    "FRAMES": ("PrimitiveInt", "value"),
    "FPS": ("PrimitiveFloat", "value"),
    "SEED": ("PrimitiveInt", "value"),
    "OUTPUT": ("SaveVideo", "filename_prefix"),
}
INPUT_CONTRACT = {"i2v": ("LoadImage", "image"), "v2v": ("LoadVideo", "file")}
MODEL_KEYS = ("unet_name", "clip_name", "vae_name", "model_name")
DYNAMIC = ("COMFY_DYNAMICCOMBO_V3", "COMFY_AUTOGROW_V3", "COMFY_MATCHTYPE_V3")


def find_workflows(root):
    """(label, mode, path) for workflows/<mode>.json and workflows/single-stage/<mode>.json."""
    out = []
    for sub in ("", "single-stage"):
        for mode in ("t2v", "i2v", "v2v"):
            path = os.path.join(root, sub, mode + ".json")
            out.append((os.path.join(sub, mode) if sub else mode, mode, path))
    return out


class Report:
    def __init__(self):
        self.errors = []
        self.checks = 0

    def check(self, ok, msg):
        self.checks += 1
        if not ok:
            self.errors.append(msg)
        return ok


def is_link(v):
    return (isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)
            and isinstance(v[1], int) and not isinstance(v[1], bool))


def load(path, rep, label):
    try:
        with open(path) as f:
            wf = json.load(f)
    except (OSError, ValueError) as e:
        rep.check(False, f"{label}: cannot load {path}: {e}")
        return None
    if not rep.check(isinstance(wf, dict) and wf and "nodes" not in wf,
                     f"{label}: not an API-format object (UI format?)"):
        return None
    for nid, n in wf.items():
        if not rep.check(isinstance(n, dict) and isinstance(n.get("inputs"), dict)
                         and isinstance(n.get("class_type"), str)
                         and isinstance((n.get("_meta") or {}).get("title"), str),
                         f"{label}: node {nid} lacks class_type/inputs/_meta.title"):
            return None
    return wf


# ---------------------------------------------------------------------------
# static
# ---------------------------------------------------------------------------
def read_lock(path):
    names = set()
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                names.add(os.path.basename(line.split()[2]))
    return names


def readme_version(path):
    with open(path) as f:
        m = re.search(r"^Workflow version:\s*\*{0,2}(\d+)\*{0,2}\s*$", f.read(), re.M)
    return int(m.group(1)) if m else None


def static_checks(wf, mode, label, lock_names, version, rep):
    titles = {}
    for nid, n in wf.items():
        titles.setdefault(n["_meta"]["title"], []).append(nid)
    for t, ids in titles.items():
        rep.check(len(ids) == 1, f"{label}: title {t!r} used by nodes {ids}")
    for title, (cls, field) in CONTRACT.items():
        ids = titles.get(title, [])
        if rep.check(len(ids) == 1, f"{label}: contract title {title} must exist exactly once"):
            n = wf[ids[0]]
            rep.check(n["class_type"] == cls, f"{label}: {title} must be {cls}, is {n['class_type']}")
            rep.check(field in n["inputs"] and not is_link(n["inputs"][field]),
                      f"{label}: {title} needs literal input {field!r}")
    ids = titles.get("INPUT", [])
    if mode == "t2v":
        rep.check(not ids, f"{label}: t2v must not have an INPUT node")
    else:
        cls, field = INPUT_CONTRACT[mode]
        if rep.check(len(ids) == 1, f"{label}: INPUT must exist exactly once"):
            n = wf[ids[0]]
            rep.check(n["class_type"] == cls and field in n["inputs"],
                      f"{label}: INPUT must be {cls} with field {field!r}")
    saves = [i for i, n in wf.items() if n["class_type"] == "SaveVideo"]
    rep.check(len(saves) == 1, f"{label}: exactly one SaveVideo expected, found {len(saves)}")
    # links
    for nid, n in wf.items():
        for key, v in n["inputs"].items():
            if is_link(v):
                rep.check(v[0] in wf, f"{label}: node {nid}.{key} links to missing node {v[0]}")
                rep.check(v[0] != nid, f"{label}: node {nid}.{key} links to itself")
    # models
    used = set()
    for nid, n in wf.items():
        for k in MODEL_KEYS:
            v = n["inputs"].get(k)
            if isinstance(v, str):
                used.add(v)
                rep.check("/" not in v and "\\" not in v, f"{label}: {v!r} must be a bare filename")
                rep.check(v in lock_names, f"{label}: {v!r} is not in models.lock")
    rep.check(len(used) >= 4, f"{label}: expected at least 4 model files, found {sorted(used)}")
    # version marker in output prefix
    for sid in saves:
        prefix = wf[sid]["inputs"].get("filename_prefix", "")
        rep.check(prefix.endswith(f"_{mode}_wf{version}"),
                  f"{label}: SaveVideo prefix {prefix!r} must end with _{mode}_wf{version}")
        rep.check(wf[sid]["inputs"].get("format") == "mp4",
                  f"{label}: SaveVideo format must be mp4 (handler needs .mp4)")
    # two-stage vs single-stage shape
    two = "single-stage" not in label
    classes = [n["class_type"] for n in wf.values()]
    rep.check((classes.count("SamplerCustomAdvanced") == 2) == two,
              f"{label}: expected {'2' if two else '1'} SamplerCustomAdvanced")
    rep.check(("LTXVLatentUpsampler" in classes) == two,
              f"{label}: upsampler presence does not match stage count")


def run_static(args):
    rep = Report()
    lock = read_lock(args.lock)
    version = readme_version(args.readme)
    rep.check(version is not None, f"{args.readme}: missing line 'Workflow version: N'")
    for label, mode, path in find_workflows(args.workflows):
        wf = load(path, rep, label)
        if wf is not None:
            static_checks(wf, mode, label, lock, version, rep)
    return finish(rep)


# ---------------------------------------------------------------------------
# live (inside the worker image)
# ---------------------------------------------------------------------------
def http(host, path, data=None):
    req = urllib.request.Request(f"http://{host}{path}",
                                 data=None if data is None else json.dumps(data).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def out_type(info, cls, slot):
    outs = info[cls]["output"]
    return outs[slot] if slot < len(outs) else None


def type_ok(src, dst):
    if src is None:
        return False
    if isinstance(src, list):
        src = "COMBO"
    if "*" in (src, dst) or dst in DYNAMIC or src in DYNAMIC:
        return True
    return src in dst.split(",") or dst in src.split(",")


def lint_dynamic_combo(wf, nid, cls, key, v, allspec, label, rep):
    """The server does not validate sub-keys of COMFY_DYNAMICCOMBO_V3 inputs
    (a bogus codec still returned HTTP 200), so walk the option tree here."""
    parts = key.split(".")
    spec = allspec[parts[0]]
    inputs = wf[nid]["inputs"]
    sel_key = parts[0]
    for sub in parts[1:]:
        opts = spec[1].get("options", [])
        chosen = next((o for o in opts if o["key"] == inputs.get(sel_key)), None)
        if not rep.check(chosen is not None,
                         f"{label}: {cls}({nid}).{sel_key}={inputs.get(sel_key)!r} is not an option"):
            return
        sections = chosen["inputs"]
        spec = {**sections.get("required", {}), **sections.get("optional", {})}.get(sub)
        if not rep.check(spec is not None,
                         f"{label}: {cls}({nid}).{key}: {sub!r} not offered by {sel_key}={inputs.get(sel_key)!r}"):
            return
        sel_key = sel_key + "." + sub
    if isinstance(spec[0], str) and spec[0] in DYNAMIC:
        rep.check(any(o["key"] == v for o in spec[1].get("options", [])),
                  f"{label}: {cls}({nid}).{key}={v!r} is not an option")


def lint_object_info(wf, label, info, rep):
    for nid, n in wf.items():
        cls = n["class_type"]
        if not rep.check(cls in info, f"{label}: node {nid} class {cls} not in /object_info"):
            continue
        spec_in = info[cls]["input"]
        allspec = {**spec_in.get("required", {}), **spec_in.get("optional", {})}
        for name in spec_in.get("required", {}):
            rep.check(name in n["inputs"] or any(k.startswith(name + ".") for k in n["inputs"]),
                      f"{label}: {cls}({nid}) missing required input {name}")
        for key, v in n["inputs"].items():
            base = key.split(".")[0]
            if not rep.check(base in allspec, f"{label}: {cls}({nid}) unknown input {key}"):
                continue
            spec = allspec[base]
            typ = spec[0]
            if "." in key:
                if rep.check(isinstance(typ, str) and typ in DYNAMIC,
                             f"{label}: {cls}({nid}).{key} dotted key on non-dynamic input"):
                    if typ == "COMFY_DYNAMICCOMBO_V3":
                        lint_dynamic_combo(wf, nid, cls, key, v, allspec, label, rep)
                continue
            if is_link(v):
                if v[0] in wf:
                    src_cls = wf[v[0]]["class_type"]
                    if src_cls in info:
                        st = out_type(info, src_cls, v[1])
                        rep.check(isinstance(typ, list) or type_ok(st, typ) or typ == "COMBO",
                                  f"{label}: {cls}({nid}).{key} expects {typ}, "
                                  f"{src_cls}({v[0]}) slot {v[1]} gives {st}")
                continue
            if isinstance(typ, str) and typ in DYNAMIC:
                if typ == "COMFY_DYNAMICCOMBO_V3":
                    rep.check(any(o["key"] == v for o in spec[1].get("options", [])),
                              f"{label}: {cls}({nid}).{key}={v!r} is not an option")
                continue
            if len(spec) > 1 and isinstance(spec[1], dict) and (
                    spec[1].get("image_upload") or spec[1].get("video_upload")):
                continue  # file pickers list the input dir; /prompt checks the real value
            opts = typ if isinstance(typ, list) else (
                spec[1].get("options") if len(spec) > 1 and isinstance(spec[1], dict)
                and typ == "COMBO" else None)
            if opts is not None:
                if opts:  # empty list = file-upload combos, checked by /prompt
                    rep.check(v in opts, f"{label}: {cls}({nid}).{key}={v!r} not in {opts}")
            elif typ in ("INT", "FLOAT"):
                ok = isinstance(v, (int, float)) and not isinstance(v, bool)
                rep.check(ok, f"{label}: {cls}({nid}).{key} must be a number")
                if ok and len(spec) > 1 and isinstance(spec[1], dict):
                    lo, hi = spec[1].get("min"), spec[1].get("max")
                    rep.check((lo is None or v >= lo) and (hi is None or v <= hi),
                              f"{label}: {cls}({nid}).{key}={v} outside {lo}..{hi}")
            elif typ == "BOOLEAN":
                rep.check(isinstance(v, bool), f"{label}: {cls}({nid}).{key} must be boolean")
            elif typ == "STRING":
                rep.check(isinstance(v, str), f"{label}: {cls}({nid}).{key} must be a string")


CASES = [
    # name, params (width/height already multiples of 64, as the handler must deliver)
    ("default", dict(prompt="a red fox runs through snow", negative="", width=1280,
                     height=704, num_frames=121, fps=24, seed=123)),
    ("negative+seed", dict(prompt="p", negative="blurry", width=768, height=512,
                           num_frames=97, fps=25, seed=2**40)),
    ("min-size", dict(prompt="p", negative="", width=256, height=256, num_frames=9,
                      fps=1, seed=0)),
    ("max-size", dict(prompt="p", negative="", width=2048, height=2048, num_frames=481,
                      fps=60, seed=2**53)),
]


def run_live(args):
    sys.path.insert(0, args.handler_dir)
    import handler  # the worker's own code
    rep = Report()
    status, body = http(args.host, "/object_info")
    if not rep.check(status == 200, f"/object_info returned HTTP {status}"):
        return finish(rep)
    info = json.loads(body)
    sample = {"i2v": "wf_sample.png", "v2v": "wf_sample.mp4"}
    for label, mode, path in find_workflows(args.workflows):
        wf = load(path, rep, label)
        if wf is None:
            continue
        lint_object_info(wf, label, info, rep)
        for case, params in CASES:
            filled = handler.fill_workflow(json.loads(json.dumps(wf)),
                                           dict(params, mode=mode, input_key=None),
                                           sample.get(mode))
            titled = {n["_meta"]["title"]: n for n in filled.values()}
            rep.check(titled["PROMPT"]["inputs"]["text"] == params["prompt"], f"{label}/{case}: PROMPT not filled")
            rep.check(titled["WIDTH"]["inputs"]["value"] == params["width"], f"{label}/{case}: WIDTH not filled")
            rep.check(titled["SEED"]["inputs"]["value"] == params["seed"], f"{label}/{case}: SEED not filled")
            if mode != "t2v":
                f = INPUT_CONTRACT[mode][1]
                rep.check(titled["INPUT"]["inputs"][f] == sample[mode], f"{label}/{case}: INPUT not filled")
            status, body = http(args.host, "/prompt", {"prompt": filled})
            ok = status == 200
            detail = ""
            if ok:
                resp = json.loads(body)
                ok = not resp.get("node_errors")
                detail = json.dumps(resp.get("node_errors"))
            else:
                detail = body[:1500]
            rep.check(ok, f"{label}/{case}: POST /prompt -> HTTP {status} {detail}")
            print(f"  {'ok  ' if ok else 'FAIL'} {label:22s} {case}")
            http(args.host, "/interrupt", {})
            http(args.host, "/queue", {"clear": True})
    exec_v2v_prep(args.host, args.workflows, rep)
    exec_save_probe(args.host, args.workflows, rep)
    return finish(rep)


def exec_save_probe(host, root, rep):
    """Execute, on CPU, the dynamic-input nodes exactly as t2v.json writes them:
    PrimitiveInt -> ComfyMathExpression(a/2) -> EmptyImage -> CreateVideo -> SaveVideo.
    Proves the 'values.a' and 'format.codec' key shapes and that an .mp4 is written
    with half the width."""
    import subprocess
    import time
    with open(os.path.join(root, "t2v.json")) as f:
        wf = json.load(f)
    by = {n["_meta"]["title"]: n for n in wf.values()}
    half = json.loads(json.dumps(by["Half Width"]))
    half["inputs"]["values.a"] = ["1", 0]
    save = json.loads(json.dumps(by["OUTPUT"]))
    save["inputs"]["video"] = ["4", 0]
    save["inputs"]["filename_prefix"] = "wf_probe/save"
    sub = {
        "1": {"class_type": "PrimitiveInt", "inputs": {"value": 1280}, "_meta": {"title": "w"}},
        "2": half,
        "3": {"class_type": "EmptyImage", "_meta": {"title": "img"},
              "inputs": {"width": ["2", 1], "height": 64, "batch_size": 9, "color": 255}},
        "4": {"class_type": "CreateVideo", "_meta": {"title": "vid"},
              "inputs": {"images": ["3", 0], "fps": 24.0}},
        "5": save,
    }
    status, body = http(host, "/prompt", {"prompt": sub})
    if not rep.check(status == 200, f"save probe: /prompt HTTP {status} {body[:800]}"):
        return
    pid = json.loads(body)["prompt_id"]
    hist = None
    for _ in range(120):
        status, body = http(host, f"/history/{pid}")
        hist = json.loads(body).get(pid)
        if hist and hist.get("status", {}).get("completed") is not None:
            break
        time.sleep(1)
    ok = bool(hist) and hist["status"].get("status_str") == "success"
    width = None
    if ok:
        files = [it for out in hist["outputs"].values() for items in out.values()
                 if isinstance(items, list) for it in items if isinstance(it, dict)]
        mp4 = [it for it in files if str(it.get("filename", "")).endswith(".mp4")]
        ok = bool(mp4)
        if ok:
            path = os.path.join("/comfyui/output", mp4[0].get("subfolder", ""), mp4[0]["filename"])
            r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                "stream=width,codec_name", "-of", "csv=p=0", path],
                               capture_output=True, text=True)
            width = r.stdout.strip()
            ok = width == "h264,640"
    rep.check(ok, f"save probe: status={hist and hist['status'].get('status_str')} ffprobe={width!r} "
                  f"(expected 'h264,640'); {json.dumps(hist and hist['status'].get('messages'))[:600]}")
    print(f"  {'ok  ' if ok else 'FAIL'} Math+CreateVideo+SaveVideo executed: mp4 {width}")


def exec_v2v_prep(host, root, rep):
    """Really execute (CPU, no model) the V2V input chain of v2v.json:
    LoadVideo -> Video Slice -> GetVideoComponents -> ImageFromBatch -> ImageScale,
    and require exactly K frames of the requested size."""
    import time
    with open(os.path.join(root, "v2v.json")) as f:
        wf = json.load(f)
    keep = ("INPUT", "Trim To Last Seconds", "Decode Tail", "Last K Frames", "Fit Frames To Size")
    sub = {i: n for i, n in wf.items() if n["_meta"]["title"] in keep}
    for n in sub.values():
        if n["_meta"]["title"] == "INPUT":
            n["inputs"]["file"] = "wf_sample.mp4"
    wid = {n["_meta"]["title"]: i for i, n in wf.items()}
    for k in ("WIDTH", "HEIGHT"):  # literal sizes instead of the primitive nodes
        sub[wid["Fit Frames To Size"]]["inputs"][k.lower()] = 320 if k == "WIDTH" else 192
    k_expected = wf[wid["Last K Frames"]]["inputs"]["length"]
    sub["900"] = {"class_type": "SaveImage", "_meta": {"title": "probe"},
                  "inputs": {"images": [wid["Fit Frames To Size"], 0],
                             "filename_prefix": "wf_probe"}}
    status, body = http(host, "/prompt", {"prompt": sub})
    if not rep.check(status == 200, f"v2v prep: /prompt HTTP {status} {body[:800]}"):
        return
    pid = json.loads(body)["prompt_id"]
    for _ in range(120):
        status, body = http(host, f"/history/{pid}")
        hist = json.loads(body).get(pid)
        if hist and hist.get("status", {}).get("completed") is not None:
            break
        time.sleep(1)
    else:
        rep.check(False, "v2v prep: did not finish in 120 s")
        return
    ok = hist["status"].get("status_str") == "success"
    n_img = len(hist.get("outputs", {}).get("900", {}).get("images", []))
    rep.check(ok and n_img == k_expected,
              f"v2v prep: status={hist['status'].get('status_str')} frames={n_img}, expected {k_expected}")
    print(f"  {'ok  ' if ok and n_img == k_expected else 'FAIL'} v2v input chain executed: {n_img} frames")


def finish(rep):
    for e in rep.errors:
        print("FAIL:", e)
    print(f"{rep.checks} checks, {len(rep.errors)} failures")
    return 1 if rep.errors else 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("static")
    s.add_argument("--workflows", required=True)
    s.add_argument("--lock", required=True)
    s.add_argument("--readme", required=True)
    s.set_defaults(fn=run_static)
    lv = sub.add_parser("live")
    lv.add_argument("--workflows", required=True)
    lv.add_argument("--handler-dir", required=True)
    lv.add_argument("--host", default="127.0.0.1:8188")
    lv.set_defaults(fn=run_live)
    args = ap.parse_args()
    sys.exit(args.fn(args))


if __name__ == "__main__":
    main()

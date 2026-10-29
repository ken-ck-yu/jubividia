#!/usr/bin/env python3
"""Fake RunPod v2 API + serverless runtime + GHCR for the offline infra tests.

Listens on 127.0.0.1 only. The management API follows RunPod's public v2 OpenAPI document
(server https://api.runpod.io, every route under /v2): /v2/account/secrets, /v2/network-volumes,
/v2/serverless, /v2/pods. Anything else (/v1/..., /secrets, /endpoints, ...) is a 404, so the
earlier wrong-route mistake can not come back unnoticed.

Reproduces the spec's traps: flashboot defaults to OFF; idleTimeout is rejected with REQUEST_COUNT
scaling; a PATCH that sends gpu.pools without gpu.excludedTypes clears the exclusions; excludedTypes
without pools on PATCH is a 400; an exclusion outside the pools is a 400; unknown body fields are
rejected (additionalProperties/unevaluatedProperties false); lists are wrapped
({"secrets":[..]}, {"networkVolumes":[..],"pagination":..}, {"endpoints":..}, {"pods":..}).

Control (no auth): GET /__ctl/log, /__ctl/state, /__ctl/clearlog; POST /__ctl/set, /__ctl/tamper.
Serverless runtime under /rt/<endpoint>, GHCR under /ghcr.
"""
import copy
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("FAKE_KEY", "test-key")
LOCK = threading.Lock()
S = {
    "log": [], "volumes": {}, "secrets": {}, "endpoints": {}, "pods": {},
    "n": 0, "flags": {}, "jobs": {}, "completed": 0, "health_calls_after_done": None,
    "cold_next": True, "default_runs": 0,
}
POOLS = {
    "ADA_48_PRO": ["NVIDIA RTX 6000 Ada Generation", "NVIDIA L40", "NVIDIA L40S",
                   "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 2g.48gb"],
    "AMPERE_48": ["NVIDIA A40", "NVIDIA RTX A6000"],
}
CONTAINER = {"args", "cmd", "entrypoint", "disk", "env", "image", "ports", "registry"}
EP_CREATE = CONTAINER | {"name", "type", "scaling", "gpu", "cpu", "dataCenterIds", "flashboot",
                         "networkVolumes", "mounts", "templateId", "timeout", "workers"}
EP_PATCH = CONTAINER | {"name", "scaling", "gpu", "cpu", "dataCenterIds", "flashboot",
                        "networkVolumes", "mounts", "templateId", "timeout", "workers"}
POD_CREATE = CONTAINER | {"name", "cloud", "cpu", "dataCenterIds", "globalNetworking", "gpu",
                          "mounts", "startJupyter", "startSsh", "templateId"}
SECRET_NAME = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.\-/]*$")
CUDA = re.compile(r"^\d+\.\d+$")


class Reject(Exception):
    def __init__(self, code, detail):
        self.code, self.detail = code, detail


def new_id(prefix):
    S["n"] += 1
    return f"{prefix}-{S['n']}"


def merge(old, new):
    out = copy.deepcopy(old)
    out.update(copy.deepcopy(new))
    return out


def need(cond, code, detail):
    if not cond:
        raise Reject(code, detail)


def only_keys(obj, allowed, what):
    need(isinstance(obj, dict), 422, f"{what} must be an object")
    extra = set(obj) - set(allowed)
    need(not extra, 422, f"{what}: unknown field(s) {sorted(extra)}")


# ---------------------------------------------------------------- validators
def check_workers(w):
    only_keys(w, {"min", "max", "idleTimeout"}, "workers")
    for k in ("min", "max"):
        need(k not in w or (isinstance(w[k], int) and w[k] >= 0), 422, f"workers.{k}")
    if "idleTimeout" in w:
        need(isinstance(w["idleTimeout"], int) and 1 <= w["idleTimeout"] <= 3600, 422, "workers.idleTimeout")


def check_scaling(s):
    need(isinstance(s, dict), 422, "scaling")
    if s.get("type") == "QUEUE_DELAY":
        only_keys(s, {"type", "queueDelay"}, "scaling")
        need(isinstance(s.get("queueDelay"), (int, float)) and s["queueDelay"] >= 0.5, 422, "scaling.queueDelay")
    elif s.get("type") == "REQUEST_COUNT":
        only_keys(s, {"type", "requestCount"}, "scaling")
        need(isinstance(s.get("requestCount"), int) and s["requestCount"] >= 1, 422, "scaling.requestCount")
    else:
        raise Reject(422, "scaling.type must be QUEUE_DELAY or REQUEST_COUNT")


def check_mounts(m):
    only_keys(m, {"network", "global"}, "mounts")
    for kind in ("network", "global"):
        for it in m.get(kind, []):
            only_keys(it, {"volumeId"}, f"mounts.{kind}[]")
            need(isinstance(it.get("volumeId"), str), 422, "mounts volumeId")
            if kind == "network":
                need(it["volumeId"] in S["volumes"], 400, "unknown network volume")


def pool_types(pools):
    types = set()
    for p in pools:
        need(p in POOLS, 400, f"unknown pool {p}")
        types |= set(POOLS[p])
    return types


def check_gpu(g, create, existing):
    only_keys(g, {"pools", "excludedTypes", "count", "allowedCudaVersions", "minCudaVersion"}, "gpu")
    if create:
        need("pools" in g, 422, "gpu.pools is required on create")
    need("pools" not in g or (isinstance(g["pools"], list) and g["pools"]), 422, "gpu.pools")
    if "excludedTypes" in g:
        need("pools" in g or create, 400, "gpu.excludedTypes requires gpu.pools on PATCH")
        types = pool_types(g["pools"])
        for t in g["excludedTypes"]:
            need(t.strip() in types, 400, f"excluded type {t!r} is not in the selected pools")
        need(len(set(t.strip() for t in g["excludedTypes"])) == len(g["excludedTypes"]), 422, "excludedTypes unique")
    elif "pools" in g:
        pool_types(g["pools"])
    if g.get("minCudaVersion") not in (None, ""):
        need(isinstance(g["minCudaVersion"], str) and CUDA.match(g["minCudaVersion"]), 422, "minCudaVersion")
    for v in g.get("allowedCudaVersions", []):
        need(CUDA.match(v), 422, "allowedCudaVersions")
    allowed = g.get("allowedCudaVersions", None if create else existing.get("allowedCudaVersions", []))
    floor = g.get("minCudaVersion", None if create else existing.get("minCudaVersion"))
    need(not (allowed and floor), 400, "allowedCudaVersions and minCudaVersion are mutually exclusive")


def check_container(b):
    need(b.get("entrypoint") is None or isinstance(b["entrypoint"], list), 422, "entrypoint must be an array")
    need(b.get("cmd") is None or isinstance(b["cmd"], list), 422, "cmd must be an array")
    need(b.get("env") is None or all(isinstance(v, str) for v in b["env"].values()), 422, "env values are strings")
    need(b.get("disk") is None or (isinstance(b["disk"], int) and b["disk"] >= 1), 422, "disk")


# ---------------------------------------------------------------- HTTP
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj=None, raw=None, ctype="application/json"):
        data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code)
        if data:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def problem(self, code, detail):
        self.send(code, {"title": "error", "status": code, "detail": detail}, ctype="application/problem+json")

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return {"__bad_json__": raw.decode(errors="replace")}

    def handle_any(self):
        path = self.path.split("?")[0]
        query = self.path.partition("?")[2]
        b = self.body()
        with LOCK:
            if path.startswith("/__ctl/"):
                return self.ctl(path, b)
            if path == "/ghcr/token":
                return self.send(200, {"token": "anon"})
            if path.startswith("/ghcr/v2/") and "/manifests/" in path:
                return self.send(200 if path.rsplit("/", 1)[1].startswith("sha-") else 404, {})
            auth_ok = self.headers.get("Authorization") == f"Bearer {KEY}"
            S["log"].append({"method": self.command, "path": path, "query": query, "body": b,
                             "auth_ok": auth_ok, "has_auth": bool(self.headers.get("Authorization"))})
            if not auth_ok:
                return self.problem(401, "missing or invalid bearer token")
            try:
                if path.startswith("/rt/"):
                    return self.runtime(path, b)
                if path.startswith("/v2/"):
                    return self.mgmt(path[3:], query, b)
            except Reject as r:
                return self.problem(r.code, r.detail)
            return self.problem(404, "no such route")

    do_GET = do_POST = do_PATCH = do_DELETE = do_PUT = do_HEAD = handle_any

    # ------------------------------------------------------------ control
    def ctl(self, path, b):
        if path == "/__ctl/log":
            return self.send(200, S["log"])
        if path == "/__ctl/state":
            return self.send(200, {k: S[k] for k in ("volumes", "secrets", "endpoints", "pods")})
        if path == "/__ctl/set":
            S["flags"].update(b or {})
            return self.send(200, {})
        if path == "/__ctl/tamper":
            coll = S[b["kind"]]
            if b.get("patch"):
                coll[b["id"]].update(b["patch"])
            if b.get("add"):
                coll[b["add"]["id"]] = b["add"]
            return self.send(200, {})
        if path == "/__ctl/clearlog":
            S["log"].clear()
            return self.send(200, {})
        return self.send(404, {})

    # ------------------------------------------------------------ management
    def mgmt(self, path, query, b):
        m = self.command
        parts = [p for p in path.split("/") if p]
        if parts[:2] == ["account", "secrets"]:
            coll, parts = "secrets", parts[1:]
        else:
            coll = {"network-volumes": "volumes", "serverless": "endpoints", "pods": "pods"}.get(
                parts[0] if parts else "")
        if not coll or (coll == "secrets" and parts[0] != "secrets"):
            return self.problem(404, "no such route")
        items = S[coll]
        wrap = {"volumes": "networkVolumes", "secrets": "secrets", "endpoints": "endpoints", "pods": "pods"}[coll]
        if len(parts) == 1:
            if m == "GET":
                rows = [self.public(coll, x) for x in items.values()]
                if coll == "secrets" and "name=" in query:
                    want = query.split("name=")[1].split("&")[0].lower()
                    rows = [r for r in rows if r["name"].lower() == want]
                out = {wrap: rows}
                if coll != "secrets":
                    out["pagination"] = {"nextCursor": None, "hasNextPage": False}
                return self.send(200, out)
            if m == "POST":
                return self.create(coll, b)
            return self.problem(405, "method not allowed")
        rid = parts[1]
        if rid not in items:
            return self.problem(404, "not found")
        if len(parts) == 3 and parts[2] == "logs" and coll == "pods" and m == "GET":
            return self.send(200, raw=b"data: download ok\n\ndata: MODELS DONE\n\n", ctype="text/event-stream")
        if len(parts) != 2:
            return self.problem(404, "no such route")
        if m == "GET":
            return self.send(200, self.public(coll, items[rid]))
        if m == "DELETE":
            del items[rid]
            return self.send(204)
        if m == "PATCH":
            return self.patch(coll, rid, b)
        return self.problem(405, "method not allowed")

    @staticmethod
    def public(coll, x):
        x = copy.deepcopy(x)
        x.pop("value", None)  # secret values are write-only
        return x

    def create(self, coll, b):
        need(isinstance(b, dict) and "__bad_json__" not in b, 400, "bad json")
        items = S[coll]
        if coll == "secrets":
            if S["flags"].get("leak_on_error"):
                return self.problem(400, "bad secret " + json.dumps(b))
            only_keys(b, {"name", "value", "description"}, "secret")
            need(isinstance(b.get("name"), str) and SECRET_NAME.match(b["name"]), 422, "secret name pattern")
            need(isinstance(b.get("value"), str) and b["value"], 422, "secret value")
            need(not any(s["name"] == b["name"] for s in items.values()), 409, "A secret with this name already exists.")
            rid = new_id("sec")
            items[rid] = {"id": rid, "name": b["name"], "value": b["value"], "createdAt": "2026-10-29T00:00:00Z",
                          "valueLastUpdatedAt": "2026-10-29T00:00:00Z"}
        elif coll == "volumes":
            only_keys(b, {"name", "size", "dataCenter", "type"}, "volume")
            for k in ("name", "size", "dataCenter"):
                need(k in b, 422, f"{k} is required")
            need(isinstance(b["size"], int) and 10 <= b["size"] <= 4096, 422, "size 10..4096")
            need(b.get("type", "STANDARD") in ("STANDARD", "HIGH_PERFORMANCE"), 422, "type")
            rid = new_id("vol")
            items[rid] = {"id": rid, "name": b["name"], "size": b["size"], "dataCenter": b["dataCenter"],
                          "type": b.get("type", "STANDARD")}
        elif coll == "endpoints":
            rid = self.create_endpoint(b)
        else:
            rid = self.create_pod(b)
        return self.send(201, self.public(coll, items[rid]))

    def create_endpoint(self, b):
        only_keys(b, EP_CREATE, "endpoint")
        for k in ("name", "type", "scaling"):
            need(k in b, 422, f"{k} is required")
        need(b["type"] in ("QUEUE", "LOAD_BALANCER"), 422, "type")
        need("image" in b or "templateId" in b, 422, "image is required")
        need(("gpu" in b) != ("cpu" in b), 400, "specify exactly one of gpu or cpu")
        check_container(b)
        check_scaling(b["scaling"])
        if "gpu" in b:
            check_gpu(b["gpu"], True, {})
        if "workers" in b:
            check_workers(b["workers"])
        if "mounts" in b:
            check_mounts(b["mounts"])
        need("timeout" not in b or isinstance(b["timeout"], int), 422, "timeout must be an integer")
        need(b.get("flashboot", "OFF") in ("OFF", "FLASHBOOT", "PRIORITY_FLASHBOOT"), 422, "flashboot")
        need(not (b["scaling"]["type"] == "REQUEST_COUNT" and "idleTimeout" in b.get("workers", {})), 400,
             "workers.idleTimeout is not applicable to REQUEST_COUNT scaling")
        rid = new_id("ep")
        e = {k: copy.deepcopy(v) for k, v in b.items() if k not in ("gpu", "workers", "mounts")}
        e["id"] = rid
        e["flashboot"] = b.get("flashboot", "OFF")                    # trap: default OFF
        e["timeout"] = 300000 if S["flags"].get("timeout_ignored") else b.get("timeout", 300000)
        w = {"min": 0, "max": 3, "idleTimeout": 10}
        w.update(b.get("workers", {}))
        if b["scaling"]["type"] == "REQUEST_COUNT":
            w.pop("idleTimeout")
        e["workers"] = w
        if "gpu" in b:
            g = b["gpu"]
            e["gpu"] = {"pools": g["pools"], "excludedTypes": [t.strip() for t in g.get("excludedTypes", [])],
                        "count": g.get("count", 1), "allowedCudaVersions": g.get("allowedCudaVersions", []),
                        "minCudaVersion": g.get("minCudaVersion") or None}
        e["dataCenterIds"] = b.get("dataCenterIds", [])
        net = b.get("mounts", {}).get("network", [])
        e["mounts"] = {"network": net, "global": b.get("mounts", {}).get("global", [])}
        e["networkVolumes"] = [m["volumeId"] for m in net]
        e["createdAt"] = "2026-10-29T00:00:00Z"
        S["endpoints"][rid] = e
        return rid

    def create_pod(self, b):
        only_keys(b, POD_CREATE, "pod")
        need("name" in b and b["name"], 422, "name is required")
        need("image" in b or "templateId" in b, 422, "image is required")
        need(("gpu" in b) != ("cpu" in b), 400, "exactly one of gpu or cpu must be set")
        check_container(b)
        if "cpu" in b:
            only_keys(b["cpu"], {"id", "vcpuCount"}, "cpu")
            need(isinstance(b["cpu"].get("vcpuCount"), int) and b["cpu"]["vcpuCount"] >= 2, 422, "vcpuCount >= 2")
            need(b["cpu"].get("id"), 422, "cpu.id")
        need(b.get("cloud", "SECURE") in ("SECURE", "COMMUNITY"), 422, "cloud")
        m = b.get("mounts", {})
        only_keys(m, {"persistent", "network", "global"}, "mounts")
        need(not ("cpu" in b and "persistent" in m), 400, "mounts.persistent is invalid for CPU pods")
        for it in m.get("network", []):
            only_keys(it, {"volumeId", "path"}, "mounts.network[]")
            need(it.get("path"), 422, "network mount path is required")
            need(it.get("volumeId") in S["volumes"], 400, "unknown network volume")
        rid = new_id("pod")
        p = copy.deepcopy(b)
        p.update({"id": rid, "status": "RUNNING", "cloud": b.get("cloud", "SECURE"), "env": b.get("env", {}),
                  "ports": b.get("ports", []), "dataCenterId": (b.get("dataCenterIds") or [None])[0]})
        if "cpu" in p:
            p["cpu"]["memory"] = 4
        S["pods"][rid] = p
        return rid

    def patch(self, coll, rid, b):
        need(isinstance(b, dict) and "__bad_json__" not in b and b, 422, "empty or invalid body")
        x = S[coll][rid]
        if coll == "volumes":
            only_keys(b, {"name", "size"}, "volume")
            need(b.get("size", x["size"]) >= x["size"], 400, "size decrease attempted")
            need(isinstance(b.get("size", 10), int) and b.get("size", 10) <= 4096, 422, "size")
            x.update(b)
        elif coll == "secrets":
            only_keys(b, {"value", "description"}, "secret")
            need(b.get("value", "x"), 422, "value")
            if "value" in b:
                x["value"] = b["value"]
        elif coll == "endpoints":
            self.patch_endpoint(x, b)
        else:
            return self.problem(405, "pod PATCH not used by this tool")
        return self.send(200, self.public(coll, x))

    def patch_endpoint(self, x, b):
        only_keys(b, EP_PATCH, "endpoint patch")
        check_container(b)
        if "scaling" in b:
            check_scaling(b["scaling"])
        if "workers" in b:
            check_workers(b["workers"])
        if "mounts" in b:
            check_mounts(b["mounts"])
        if "gpu" in b:
            check_gpu(b["gpu"], False, x.get("gpu", {}))
        scaling = b.get("scaling", x["scaling"])
        need(not (scaling["type"] == "REQUEST_COUNT" and "idleTimeout" in b.get("workers", {})), 400,
             "workers.idleTimeout is not applicable to REQUEST_COUNT scaling")
        for k, v in b.items():
            if k == S["flags"].get("patch_ignored"):
                continue
            if k == "gpu":
                g = copy.deepcopy(x["gpu"])
                if "pools" in v:
                    g["pools"] = v["pools"]
                    g["excludedTypes"] = [t.strip() for t in v.get("excludedTypes", [])]   # trap: cleared
                for f in ("count", "allowedCudaVersions"):
                    if f in v:
                        g[f] = v[f]
                if "minCudaVersion" in v:
                    g["minCudaVersion"] = v["minCudaVersion"] or None
                x["gpu"] = g
            elif k == "workers":
                x["workers"] = merge(x["workers"], v)
            elif k == "mounts":
                for kind in ("network", "global"):
                    if kind in v:
                        x["mounts"][kind] = v[kind]
                x["networkVolumes"] = [m["volumeId"] for m in x["mounts"]["network"]]
            else:
                x[k] = copy.deepcopy(v)
        if x["scaling"]["type"] == "REQUEST_COUNT":
            x["workers"].pop("idleTimeout", None)

    # ------------------------------------------------------------ runtime
    def runtime(self, path, b):
        parts = [p for p in path.split("/") if p]       # rt, <ep>, run|status|health|cancel[, id]
        op = parts[2]
        if op == "health":
            fl = S["flags"]
            w = {"idle": 0, "running": 0, "initializing": 0, "ready": 0,
                 "throttled": int(fl.get("throttled", 0)), "unhealthy": int(fl.get("unhealthy", 0))}
            c = S["health_calls_after_done"]
            if c is not None:
                if c > 0:
                    w["idle"] = 1
                    S["health_calls_after_done"] = c - 1
                else:
                    S["cold_next"] = True
                    S["health_calls_after_done"] = None
            return self.send(200, {"jobs": {"inQueue": 0, "inProgress": 0}, "workers": w})
        if op == "run":
            jid = new_id("job")
            S["jobs"][jid] = {"input": (b or {}).get("input", {}), "polls": 0}
            return self.send(200, {"id": jid, "status": "IN_QUEUE"})
        if op == "cancel":
            S["jobs"].get(parts[3], {})["cancelled"] = True
            return self.send(200, {"status": "CANCELLED"})
        if op == "status":
            return self.job_status(parts[3])
        return self.send(404, {})

    def job_status(self, jid):
        job = S["jobs"].get(jid)
        if not job:
            return self.send(404, {})
        fl = S["flags"]
        job["polls"] += 1
        inp = job["input"]
        if fl.get("status_fail") and job["polls"] > int(fl.get("status_fail_after", 0)):
            if fl["status_fail"] == "garbage":
                return self.send(200, raw=b"<html>not json</html>", ctype="text/html")
            return self.problem(int(fl["status_fail"]), "simulated /status failure")
        if fl.get("stuck"):
            return self.send(200, {"id": jid, "status": "IN_PROGRESS"})
        if job["polls"] == 1:
            return self.send(200, {"id": jid, "status": "IN_QUEUE"})
        if job["polls"] == 2:
            return self.send(200, {"id": jid, "status": "IN_PROGRESS"})
        if inp.get("mode") == "i2v":
            msg = fl.get("canary_error", "[input_fetch] input not found: " + str(inp.get("input_key")))
            out = {"error": msg, "error_code": "input_fetch"}
            if fl.get("no_error_code"):
                out.pop("error_code")
            return self.send(200, {"id": jid, "status": "FAILED", "error": msg, "output": out,
                                   "delayTime": 30000, "executionTime": 800})
        if "result" not in job:
            default = int(inp.get("width", 1280)) * int(inp.get("height", 720)) >= 1280 * 704
            cold = S["cold_next"]
            S["cold_next"] = False
            if default:
                gens = fl.get("default_gen", [100.0])
                gen = gens[min(S["default_runs"], len(gens) - 1)]
                S["default_runs"] += 1
            else:
                gen = 5.0
            S["completed"] += 1
            S["health_calls_after_done"] = 2
            stem = f"outputs/2026-10-29/20261029T000000-{jid}"
            out = {"v": 1, "key": stem + ".mp4", "thumb_key": stem + ".jpg", "meta_key": stem + ".json",
                   "gen_time_s": gen, "cold": cold, "width": inp.get("width"), "height": inp.get("height"),
                   "num_frames": inp.get("num_frames"), "fps": inp.get("fps"), "seed": inp.get("seed"),
                   "peak_vram_mb": 40000 + S["completed"]}
            job["result"] = {"id": jid, "status": "COMPLETED", "output": out,
                             "delayTime": 45000 if cold else 200,
                             "executionTime": int((gen + (30 if cold else 0)) * 1000)}
        return self.send(200, job["result"])


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    with open(sys.argv[1], "w") as f:
        f.write(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()

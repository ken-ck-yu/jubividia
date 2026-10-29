#!/usr/bin/env python3
"""Fake RunPod REST + serverless runtime + GHCR for the offline infra tests.

Listens on 127.0.0.1 only. It reproduces the three REST traps from the design note:
  1. flashboot defaults to OFF when the create body omits it,
  2. idleTimeout is rejected with REQUEST_COUNT scaling,
  3. a PATCH that sends gpu.pools without gpu.excludedTypes clears the exclusions.
Control (no auth): GET /__ctl/log, GET /__ctl/state, POST /__ctl/set, POST /__ctl/tamper.
Management API under /v1, serverless runtime under /rt/<endpoint>, GHCR under /token and /v2.
"""
import copy
import json
import os
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


def new_id(prefix):
    S["n"] += 1
    return f"{prefix}-{S['n']}"


def merge(old, new):
    out = copy.deepcopy(old)
    out.update(copy.deepcopy(new))
    return out


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj=None, raw=None):
        data = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return {"__bad_json__": raw.decode(errors="replace")}

    def handle_any(self):
        path = self.path.split("?")[0]
        b = self.body()
        with LOCK:
            if path.startswith("/__ctl/"):
                return self.ctl(path, b)
            if path == "/token":
                return self.send(200, {"token": "anon"})
            if path.startswith("/v2/") and "/manifests/" in path:
                tag = path.rsplit("/", 1)[1]
                return self.send(200 if tag.startswith("sha-") else 404, {})
            auth_ok = self.headers.get("Authorization") == f"Bearer {KEY}"
            S["log"].append({"method": self.command, "path": path, "body": b, "auth_ok": auth_ok,
                             "has_auth": bool(self.headers.get("Authorization"))})
            if not auth_ok:
                return self.send(401, {"error": "unauthorized"})
            if path.startswith("/rt/"):
                return self.runtime(path, b)
            if path.startswith("/v1/"):
                return self.mgmt(path[3:], b)
            return self.send(404, {"error": "no route"})

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
    def mgmt(self, path, b):
        m = self.command
        parts = [p for p in path.split("/") if p]
        kind = parts[0] if parts else ""
        coll = {"network-volumes": "volumes", "secrets": "secrets", "endpoints": "endpoints",
                "pods": "pods"}.get(kind)
        if not coll:
            return self.send(404, {"error": "unknown collection"})
        items = S[coll]
        if len(parts) == 1:
            if m == "GET":
                return self.send(200, [self.public(coll, x) for x in items.values()])
            if m == "POST":
                return self.create(coll, b)
            return self.send(405, {})
        rid = parts[1]
        if rid not in items:
            return self.send(404, {"error": "not found"})
        if len(parts) == 3 and parts[2] == "logs" and coll == "pods":
            return self.send(200, raw=b"\"download ok\\nMODELS DONE\"")
        if m == "GET":
            return self.send(200, self.public(coll, items[rid]))
        if m == "DELETE":
            del items[rid]
            return self.send(204)
        if m == "PATCH":
            return self.patch(coll, rid, b)
        return self.send(405, {})

    @staticmethod
    def public(coll, x):
        x = copy.deepcopy(x)
        x.pop("value", None)  # secret values are write-only
        return x

    def create(self, coll, b):
        if not isinstance(b, dict) or "__bad_json__" in b:
            return self.send(400, {"error": "bad json"})
        items = S[coll]
        if coll == "secrets" and S["flags"].get("leak_on_error"):
            return self.send(400, {"error": "bad secret " + json.dumps(b)})
        if coll == "secrets":
            if any(s["name"] == b.get("name") for s in items.values()):
                return self.send(409, {"error": "name exists"})
            rid = new_id("sec")
            items[rid] = {"id": rid, "name": b["name"], "value": b["value"]}
        elif coll == "volumes":
            rid = new_id("vol")
            items[rid] = {"id": rid, "name": b["name"], "size": b["size"],
                          "dataCenterId": b["dataCenterId"]}
        elif coll == "endpoints":
            if b.get("scaling", {}).get("type") == "REQUEST_COUNT" and "idleTimeout" in b.get("workers", {}):
                return self.send(400, {"error": "idleTimeout is not allowed with REQUEST_COUNT scaling"})
            rid = new_id("ep")
            e = copy.deepcopy(b)
            e["id"] = rid
            e.setdefault("flashboot", "OFF")            # trap 1
            e.setdefault("timeout", 300000)
            if S["flags"].get("timeout_ignored"):
                e["timeout"] = 300000
            items[rid] = e
        else:
            rid = new_id("pod")
            items[rid] = dict(copy.deepcopy(b), id=rid, desiredStatus="RUNNING")
        out = self.public(coll, items[rid])
        return self.send(201, out)

    def patch(self, coll, rid, b):
        x = S[coll][rid]
        if coll == "volumes":
            if b.get("size", x["size"]) < x["size"]:
                return self.send(400, {"error": "cannot shrink"})
            x.update(b)
        elif coll == "secrets":
            x["value"] = b["value"]
        elif coll == "endpoints":
            if b.get("scaling", {}).get("type") == "REQUEST_COUNT" and "idleTimeout" in (b.get("workers") or x.get("workers", {})):
                return self.send(400, {"error": "idleTimeout is not allowed with REQUEST_COUNT scaling"})
            for k, v in b.items():
                if k == "gpu":
                    g = merge(x.get("gpu", {}), v)
                    if "excludedTypes" not in v:
                        g["excludedTypes"] = []          # trap 3
                    x["gpu"] = g
                elif k in ("workers", "scaling") and isinstance(v, dict):
                    x[k] = merge(x.get(k, {}), v)
                elif k == S["flags"].get("patch_ignored"):
                    continue
                else:
                    x[k] = copy.deepcopy(v)
        return self.send(200, self.public(coll, x))

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

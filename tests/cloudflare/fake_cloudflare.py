#!/usr/bin/env python3
"""Fake Cloudflare API plus a fake workers.dev front for infra/cloudflare/apply.sh tests.

Listens on 127.0.0.1 only. Usage: fake_cloudflare.py PORTFILE   (env FAKE_TOKEN = the accepted token)

API (a subset of api.cloudflare.com/client/v4, envelope {success, errors, result}):
  GET  /user/tokens/verify
  GET  /accounts/<acc>/workers/subdomain
  GET  /accounts/<acc>/workers/scripts
  GET|POST /accounts/<acc>/workers/scripts/<name>/subdomain
  GET|PUT  /accounts/<acc>/workers/scripts/<name>/secrets
  GET  /accounts/<acc>/r2/buckets/<bucket>[/lock]
  GET|PUT /accounts/<acc>/r2/buckets/<bucket>/lifecycle     (PUT REPLACES the whole set, like the real API)
Any other path is 404 and recorded as "unexpected", so a test can assert the tool never called it.
Worker front (what workers.dev + Access would answer), mode set via /__ctl/set {"front": ...}:
  access  -> 302 to https://fake-team.cloudflareaccess.com/cdn-cgi/access/login/...
  app     -> 200 (the app served without login: must FAIL verification)
  closed  -> 503 (Worker reachable, no Access attached: must FAIL verification)
Control: GET /__ctl/state, GET /__ctl/log, POST /__ctl/clearlog, POST /__ctl/set, POST /__ctl/deploy
"""
import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACC = "0123456789abcdef0123456789abcdef"
TOKEN = os.environ.get("FAKE_TOKEN", "")
LOCK = threading.Lock()
STATE = {}
LOG = []


def reset():
    STATE.clear()
    STATE.update({
        "subdomain": "kenlab",
        "scripts": {
            "jubilab-website": {"id": "jubilab-website", "created_on": "2025-01-01T00:00:00Z", "modified_on": "2026-09-01T10:00:00Z"},
            "other-worker": {"id": "other-worker", "created_on": "2025-02-01T00:00:00Z", "modified_on": "2026-08-01T10:00:00Z"},
        },
        "worker_settings": {},   # name -> {enabled, previews_enabled}
        "secrets": {},           # name -> {script: [names]}
        "secret_values": {},     # name -> value (so tests can prove values arrive only here)
        "lifecycle": [
            {"id": "keep-me", "enabled": True, "conditions": {"prefix": "tmp/"},
             "deleteObjectsTransition": {"condition": {"type": "Age", "maxAge": 86400}}},
        ],
        "lock": [],
        "bucket": "jubividia-ltx-eu",
        "front": "access",
        "deploy_previews": False,
        "clock": 0,
    })


reset()


def env(result, success=True, errors=None):
    return {"success": success, "errors": errors or [], "messages": [], "result": result}


def now():
    STATE["clock"] += 1
    return "2026-10-29T12:%02d:00Z" % STATE["clock"]


class H(BaseHTTPRequestHandler):
    server_version = "fakecf"

    def log_message(self, *a):
        pass

    def send(self, code, obj, headers=None):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return None

    def handle_any(self, method):
        path = self.path.split("?")[0]
        body = self.body()
        with LOCK:
            if path.startswith("/__ctl/"):
                return self.ctl(method, path, body)
            if path.startswith("/__worker"):
                LOG.append({"method": method, "path": path, "front": True,
                            "jwt_header": self.headers.get("Cf-Access-Jwt-Assertion"),
                            "cookie": self.headers.get("Cookie"), "auth": self.headers.get("Authorization")})
                f = STATE["front"]
                if f == "access":
                    self.send_response(302)
                    self.send_header("Location", "https://fake-team.cloudflareaccess.com/cdn-cgi/access/login/jubividia?kid=x")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if f == "app":
                    return self.send(200, {"app": "served"})
                return self.send(503, {})
            auth_ok = self.headers.get("Authorization") == "Bearer " + TOKEN
            entry = {"method": method, "path": path, "auth_ok": auth_ok, "body": body, "front": False}
            LOG.append(entry)
            if not auth_ok:
                return self.send(401, env(None, False, [{"code": 10000, "message": "Authentication error"}]))
            r = self.route(method, path, body, entry)
            if r is None:
                entry["unexpected"] = True
                return self.send(404, env(None, False, [{"code": 7003, "message": "no route"}]))
            return self.send(*r)

    def route(self, m, p, body, entry):
        if p == "/user/tokens/verify" and m == "GET":
            return 200, env({"id": "tok", "status": "active"})
        pre = "/accounts/%s" % ACC
        if not p.startswith(pre + "/"):
            return None
        q = p[len(pre):]
        if q == "/workers/subdomain" and m == "GET":
            return 200, env({"subdomain": STATE["subdomain"]}) if STATE["subdomain"] else (404, env(None, False, [{"code": 10007, "message": "no subdomain"}]))
        if q == "/workers/scripts" and m == "GET":
            return 200, env(list(STATE["scripts"].values()))
        mm = re.match(r"^/workers/scripts/([^/]+)/subdomain$", q)
        if mm:
            name = mm.group(1)
            cur = STATE["worker_settings"].setdefault(name, {"enabled": True, "previews_enabled": STATE["deploy_previews"]})
            if m == "POST":
                cur.update({"enabled": bool(body.get("enabled")), "previews_enabled": bool(body.get("previews_enabled"))})
            return 200, env(cur)
        mm = re.match(r"^/workers/scripts/([^/]+)/secrets$", q)
        if mm:
            name = mm.group(1)
            if m == "PUT":
                STATE["secrets"].setdefault(name, [])
                if body["name"] not in STATE["secrets"][name]:
                    STATE["secrets"][name].append(body["name"])
                STATE["secret_values"][body["name"]] = body["text"]
                entry["body"] = {"name": body["name"], "text": "<redacted-in-log>", "type": body.get("type")}
                return 200, env({"name": body["name"], "type": "secret_text"})
            return 200, env([{"name": n, "type": "secret_text"} for n in STATE["secrets"].get(name, [])])
        mm = re.match(r"^/r2/buckets/([^/]+)(/lock|/lifecycle)?$", q)
        if mm:
            if mm.group(1) != STATE["bucket"]:
                return 404, env(None, False, [{"code": 10006, "message": "no such bucket"}])
            sub = mm.group(2)
            if sub is None and m == "GET":
                return 200, env({"name": STATE["bucket"]})
            if sub == "/lock" and m == "GET":
                return 200, env({"rules": STATE["lock"]})
            if sub == "/lifecycle" and m == "GET":
                return 200, env({"rules": STATE["lifecycle"]})
            if sub == "/lifecycle" and m == "PUT":
                STATE["lifecycle"] = body["rules"]
                return 200, env({})
        return None

    def ctl(self, m, p, body):
        if p == "/__ctl/state":
            return self.send(200, STATE)
        if p == "/__ctl/log":
            return self.send(200, LOG)
        if p == "/__ctl/clearlog":
            LOG.clear()
            return self.send(200, {})
        if p == "/__ctl/reset":
            reset()
            LOG.clear()
            return self.send(200, {})
        if p == "/__ctl/set":
            STATE.update(body or {})
            return self.send(200, {})
        if p == "/__ctl/deploy":
            name = body["name"]
            cur = STATE["scripts"].get(name)
            if cur is None:
                STATE["scripts"][name] = {"id": name, "created_on": now(), "modified_on": now()}
            else:
                cur["modified_on"] = now()
            return self.send(200, {})
        if p == "/__ctl/touch":   # change another Worker behind the tool's back
            STATE["scripts"][body["name"]]["modified_on"] = now()
            return self.send(200, {})
        if p == "/__ctl/recreate":
            STATE["scripts"][body["name"]] = {"id": body["name"], "created_on": now(), "modified_on": now()}
            return self.send(200, {})
        return self.send(404, {})

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_PUT(self):
        self.handle_any("PUT")

    def do_DELETE(self):
        self.handle_any("DELETE")

    def do_PATCH(self):
        self.handle_any("PATCH")


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    with open(sys.argv[1], "w") as f:
        f.write(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()

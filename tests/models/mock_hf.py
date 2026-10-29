"""Mock Hugging Face server for offline tests of scripts/download-models.sh.

Serves files from --root as <repo>/resolve/<rev>/<path> (302 to a different
host name, localhost vs 127.0.0.1, so curl must drop the Authorization header),
supports Range, and implements the revision and tree APIs (paginated).
Every request is appended to --log as: METHOD PATH RANGE AUTH(yes|no).
"""
import argparse
import hashlib
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ap = argparse.ArgumentParser()
ap.add_argument("--root", required=True)
ap.add_argument("--repo", default="Org/Repo")
ap.add_argument("--rev", required=True)
ap.add_argument("--token", default="hf_TESTTOKEN")
ap.add_argument("--log", required=True)
ap.add_argument("--portfile", required=True)
ap.add_argument("--status", type=int, default=0, help="force this status on resolve/API (401/403)")
ap.add_argument("--drop-after", type=int, default=0, help="close the first full GET of each file after N bytes")
ap.add_argument("--page-size", type=int, default=2)
ap.add_argument("--no-lfs", default="", help="path to report without an lfs block")
args = ap.parse_args()
dropped = set()


def all_files():
    out = []
    for d, _, fs in os.walk(args.root):
        for f in fs:
            out.append(os.path.relpath(os.path.join(d, f), args.root))
    return sorted(out)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def note(self):
        auth = "yes" if self.headers.get("Authorization") == "Bearer " + args.token else (
            "bad" if self.headers.get("Authorization") else "no")
        with open(args.log, "a") as f:
            f.write("%s %s %s %s\n" % (self.command, self.path, self.headers.get("Range", "-"), auth))
        return auth

    def send(self, code, body=b"", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.route()

    def do_GET(self):
        self.route()

    def route(self):
        auth = self.note()
        path, _, query = self.path.partition("?")
        pre = "/" + args.repo
        if path.startswith("/cdn/"):
            return self.serve(path[len("/cdn/"):].split("/", 1)[1])
        if auth != "yes":
            return self.send(401, b"unauthorized")
        if args.status:
            return self.send(args.status, b"forced")
        if path.startswith(pre + "/resolve/" + args.rev + "/"):
            rel = path[len(pre + "/resolve/" + args.rev + "/"):]
            if not os.path.isfile(os.path.join(args.root, rel)):
                return self.send(404)
            host = "localhost:%d" % self.server.server_port
            return self.send(302, b"", {"Location": "http://%s/cdn/%s/%s" % (host, args.rev, rel)})
        if path == "/api/models/%s/revision/%s" % (args.repo, args.rev):
            return self.send(200, json.dumps({"sha": args.rev, "lastModified": "2026-10-11T08:00:00.000Z"}).encode(),
                             {"Content-Type": "application/json"})
        if path == "/api/models/%s/tree/%s" % (args.repo, args.rev):
            cur = int(dict(p.split("=") for p in query.split("&") if "=" in p).get("cursor", "0"))
            files = all_files()
            page = files[cur:cur + args.page_size]
            entries = [{"type": "directory", "path": "somedir"}] if cur == 0 else []
            for rel in page:
                data = open(os.path.join(args.root, rel), "rb").read()
                e = {"type": "file", "path": rel, "size": len(data)}
                if rel != args.no_lfs:
                    e["lfs"] = {"oid": hashlib.sha256(data).hexdigest(), "size": len(data)}
                entries.append(e)
            hdr = {"Content-Type": "application/json"}
            if cur + args.page_size < len(files):
                hdr["Link"] = '<http://127.0.0.1:%d%s?recursive=true&cursor=%d>; rel="next"' % (
                    self.server.server_port, path, cur + args.page_size)
            return self.send(200, json.dumps(entries).encode(), hdr)
        self.send(404)

    def serve(self, rel):
        fp = os.path.join(args.root, rel)
        if not os.path.isfile(fp):
            return self.send(404)
        data = open(fp, "rb").read()
        rng = self.headers.get("Range")
        start = 0
        code = 200
        if rng and rng.startswith("bytes="):
            start = int(rng[6:].split("-")[0])
            if start >= len(data):
                return self.send(416)
            code = 206
        body = data[start:]
        self.send_response(code)
        self.send_header("Content-Length", str(len(body)))
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, len(data) - 1, len(data)))
        self.end_headers()
        if self.command == "HEAD":
            return
        if args.drop_after and rel not in dropped and start == 0:
            dropped.add(rel)
            self.wfile.write(body[:args.drop_after])
            self.wfile.flush()
            self.close_connection = True
            self.connection.close()
            return
        self.wfile.write(body)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(args.portfile, "w") as f:
    f.write(str(srv.server_port))
sys.stderr.write("")
srv.serve_forever()

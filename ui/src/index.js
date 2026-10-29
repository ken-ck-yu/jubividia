// jubividia front-end Worker.
// Pipeline for EVERY request (static files included, run_worker_first = true):
//   1. fail closed if the Access configuration secrets are missing (503, empty body)
//   2. verify the Cf-Access-Jwt-Assertion JWT (403, empty body, on any failure)
//   3. state-changing methods: same-origin check plus the X-Jubividia header
//   4. route; everything else is a static asset
//   5. security headers on every response
import { authConfig, verifyAccess } from "./auth.js";
import { SECURITY_HEADERS, HttpError, bare, errorResponse, json, log } from "./util.js";
import { handleState, handleGenerate, handleStatus, handleCancel } from "./api.js";
import { handleUpload } from "./upload.js";
import { handleGallery, handleOutput } from "./outputs.js";

const API_PREFIX = "/api/";
const OUTPUT_PREFIX = "/api/outputs/";

function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function sameOrigin(request, url) {
  if (request.headers.get("X-Jubividia") !== "1") return false;
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === url.origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin";
}

async function route(request, env, url) {
  const { pathname } = url;
  const m = request.method;

  if (pathname.startsWith(API_PREFIX)) {
    if (pathname === "/api/state") return m === "GET" ? handleState(env) : methodNotAllowed("GET");
    if (pathname === "/api/upload") return m === "PUT" ? handleUpload(request, env) : methodNotAllowed("PUT");
    if (pathname === "/api/generate") return m === "POST" ? handleGenerate(request, env) : methodNotAllowed("POST");
    if (pathname.startsWith("/api/status/")) {
      return m === "GET" ? handleStatus(env, pathname.slice("/api/status/".length)) : methodNotAllowed("GET");
    }
    if (pathname.startsWith("/api/cancel/")) {
      return m === "POST" ? handleCancel(env, pathname.slice("/api/cancel/".length)) : methodNotAllowed("POST");
    }
    if (pathname === "/api/outputs") return m === "GET" ? handleGallery(request, env) : methodNotAllowed("GET");
    if (pathname.startsWith(OUTPUT_PREFIX)) {
      if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
      // Keys never need escaping: any percent sign is refused (no %2e%2e, no %2f).
      if (pathname.includes("%")) return json(404, { error: "not_found" });
      return handleOutput(request, env, pathname.slice(OUTPUT_PREFIX.length));
    }
    return json(404, { error: "not_found" });
  }

  if (m !== "GET" && m !== "HEAD") return methodNotAllowed("GET, HEAD");
  return env.ASSETS.fetch(request);
}

function methodNotAllowed(allow) {
  return json(405, { error: "method_not_allowed" }, { Allow: allow });
}

export default {
  async fetch(request, env) {
    try {
      const cfg = authConfig(env);
      if (!cfg) {
        log("denied", { reason: "not_configured" });
        return secure(bare(503));
      }
      const auth = await verifyAccess(request, cfg);
      if (!auth.ok) {
        log("denied", { reason: auth.reason });
        return secure(bare(403));
      }
      const url = new URL(request.url);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !sameOrigin(request, url)) {
        return secure(json(403, { error: "forbidden", message: "Cross-site request refused." }));
      }
      if (request.method === "OPTIONS") return secure(bare(405)); // no CORS, ever
      return secure(await route(request, env, url));
    } catch (e) {
      if (e instanceof HttpError) return secure(errorResponse(e));
      log("unhandled", { name: e && e.name ? String(e.name) : "Error" });
      return secure(json(500, { error: "internal", message: "Something went wrong." }));
    }
  },
};

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, makeEnv, clearBucket, runpod, ORIGIN } from "./helpers.js";
import { validateParams, DEFAULT_RATE_USD_PER_HR, worstCaseUsd, estimateWarmSeconds, isUntested, formatUsd } from "../static/calc.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

describe("CSRF and CORS", () => {
  const post = (opts) => send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x" }, ...opts });

  it("rejects state-changing requests without the custom header", async () => {
    expect((await post({ noCsrf: true })).status).toBe(403);
  });

  it("rejects a foreign Origin even with the header", async () => {
    const req = await send("/api/generate", {
      method: "POST",
      json: { mode: "t2v", prompt: "x" },
      noCsrf: true,
      headers: { "X-Jubividia": "1", Origin: "https://evil.example" },
    });
    expect(req.status).toBe(403);
  });

  it("rejects cross-site fetch metadata when no Origin is present", async () => {
    const res = await send("/api/generate", {
      method: "POST",
      json: { mode: "t2v", prompt: "x" },
      noCsrf: true,
      headers: { "X-Jubividia": "1", "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("never sends CORS headers and refuses OPTIONS", async () => {
    for (const path of ["/api/state", "/", "/api/outputs"]) {
      const res = await send(path);
      expect([...res.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    }
    expect((await send("/api/state", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(405);
  });
});

describe("response headers and routing", () => {
  it("adds the CSP and friends to API and static responses, and no-store to API JSON", async () => {
    for (const path of ["/", "/api/state", "/api/nope"]) {
      const res = await send(path);
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp, path).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("unsafe-inline");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
    expect((await send("/api/state")).headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers unknown API paths with JSON 404 and wrong methods with 405", async () => {
    expect((await send("/api/nope")).status).toBe(404);
    expect((await send("/api/state", { method: "POST" })).status).toBe(405);
    expect((await send("/api/upload")).status).toBe(405);
    expect((await send("/api/generate")).status).toBe(405);
  });

  it("only serves static assets for GET and HEAD, and passes the request to ASSETS", async () => {
    const seen = [];
    const env = makeEnv({ ASSETS: { fetch: async (r) => (seen.push(new URL(r.url).pathname), new Response("ok")) } });
    expect((await send("/app.js", { env })).status).toBe(200);
    expect(seen).toEqual(["/app.js"]);
    expect((await send("/app.js", { env, method: "POST", json: {} })).status).toBe(405);
  });

  it("keeps a secret out of unexpected-error responses", async () => {
    const env = makeEnv({ BUCKET: { get: async () => { throw new Error("boom " + "rpa_TESTKEY_SECRET_VALUE_123"); }, head: async () => null, list: async () => ({ objects: [], truncated: false }) } });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await send("/api/state", { env });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("rpa_TESTKEY");
  });
});

describe("shared calculations", () => {
  it("warm default matches the measurement and the 15 minute worst case is about $0.44", () => {
    expect(estimateWarmSeconds(1280, 704, 121)).toBe(68);
    expect(worstCaseUsd(DEFAULT_RATE_USD_PER_HR)).toBeCloseTo(0.4375, 4);
    expect(formatUsd(0.4375)).toBe("$0.44");
    expect(formatUsd(0.033)).toBe("$0.033");
  });

  it("marks only sizes beyond 1280x704x121 as untested", () => {
    expect(isUntested(1280, 704, 121)).toBe(false);
    expect(isUntested(640, 384, 241)).toBe(false);
    expect(isUntested(1280, 704, 129)).toBe(true);
    expect(isUntested(2048, 2048, 481)).toBe(true);
  });

  it("does not clamp: it rejects, and allows the full handler range", () => {
    expect(validateParams({ mode: "t2v", prompt: "x", width: 2048, height: 2048, duration_s: 20, fps: 24 }).errors).toEqual([]);
    expect(validateParams({ mode: "t2v", prompt: "x", width: 2112 }).errors.length).toBe(1);
    expect(validateParams({ mode: "t2v", prompt: "x", fps: 60, duration_s: 8 }).errors).toEqual([]);
    expect(validateParams({ mode: "t2v", prompt: "x", fps: 60, duration_s: 8.1 }).errors.length).toBe(1);
  });
});

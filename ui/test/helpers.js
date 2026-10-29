// Test helpers: a fake Access JWKS endpoint, a fake RunPod runtime API, and request builders.
// Both fakes live behind a global fetch stub, so the Worker code under test is unmodified and
// any other outbound request fails the test loudly.
import { env as testEnv } from "cloudflare:test";
import { vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import worker from "../src/index.js";

export const TEAM = "https://fake-team.cloudflareaccess.test";
export const AUD = "test-aud-0123456789abcdef";
export const EMAIL = "ken@example.test";
export const EMAIL2 = "partner@example.test";
export const ORIGIN = "https://jubividia.example.test";
export const SECRETS = {
  RUNPOD_API_KEY: "rpa_TESTKEY_SECRET_VALUE_123",
  RUNPOD_ENDPOINT_ID: "ep12345678",
};
export const EP = SECRETS.RUNPOD_ENDPOINT_ID;

// ------------------------------------------------------------------ JWT minting
const keys = {};
async function key(name) {
  if (!keys[name]) {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = `kid-${name}`;
    jwk.alg = "RS256";
    jwk.use = "sig";
    keys[name] = { privateKey, jwk };
  }
  return keys[name];
}

export async function mintJwt(opts = {}) {
  const {
    email = EMAIL,
    aud = AUD,
    iss = TEAM,
    expSeconds = 3600,
    signer = "main",
    alg = "RS256",
    noEmail = false,
  } = opts;
  const { privateKey } = await key(signer);
  const claims = noEmail ? {} : { email };
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg, kid: `kid-main` })
    .setIssuedAt()
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds);
  return jwt.sign(privateKey);
}

export function unsignedJwt() {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ iss: TEAM, aud: AUD, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
}

// ------------------------------------------------------------------ fake RunPod
export class FakeRunpod {
  constructor() {
    this.reset();
  }
  reset() {
    this.calls = [];
    this.jobs = new Map();
    this.health = {
      workers: { idle: 0, running: 0, initializing: 0, throttled: 0, unhealthy: 0 },
      jobs: { inQueue: 0, inProgress: 0 },
    };
    this.healthStatus = 200;
    this.runMode = "ok"; // ok | network | {status, body}
    this.nextId = 1;
    this.cancelStopsJob = true;
    this.runDelay = 0;
  }
  addJob(id, status, extra = {}) {
    this.jobs.set(id, { id, status, ...extra });
  }
  async handle(path, init) {
    const method = (init?.method || "GET").toUpperCase();
    const headers = new Headers(init?.headers || {});
    const body = init?.body ? JSON.parse(init.body) : null;
    this.calls.push({ method, path, auth: headers.get("Authorization"), body });
    const j = (status, b) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (path === "/health") return j(this.healthStatus, this.health);
    if (path === "/run" && method === "POST") {
      if (this.runDelay) await new Promise((r) => setTimeout(r, this.runDelay));
      if (this.runMode === "network") throw new TypeError("network down");
      if (this.runMode !== "ok") return j(this.runMode.status, this.runMode.body ?? { error: "RAW RUNPOD ERROR BODY" });
      const id = `job-${String(this.nextId++).padStart(8, "0")}-u1`;
      this.jobs.set(id, { id, status: "IN_QUEUE" });
      this.health.jobs.inQueue += 1;
      return j(200, { id, status: "IN_QUEUE" });
    }
    let m = /^\/status\/(.+)$/.exec(path);
    if (m) {
      const job = this.jobs.get(decodeURIComponent(m[1]));
      return job ? j(200, job) : j(404, { error: "not found" });
    }
    m = /^\/cancel\/(.+)$/.exec(path);
    if (m && method === "POST") {
      const job = this.jobs.get(decodeURIComponent(m[1]));
      if (!job) return j(404, {});
      if (this.cancelStopsJob) job.status = "CANCELLED";
      return j(200, { id: job.id, status: "CANCELLED" });
    }
    return j(404, { error: "unexpected path " + path });
  }
}

// ------------------------------------------------------------------ fake JWKS
export const jwks = { requests: 0 };

export const runpod = new FakeRunpod();

export function installFakes() {
  runpod.reset();
  jwks.requests = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === TEAM && url.pathname === "/cdn-cgi/access/certs") {
      jwks.requests += 1;
      const main = await key("main");
      return new Response(JSON.stringify({ keys: [main.jwk] }), { headers: { "Content-Type": "application/json" } });
    }
    if (url.origin === "https://api.runpod.ai" && url.pathname.startsWith(`/v2/${EP}/`)) {
      return runpod.handle(url.pathname.slice(`/v2/${EP}`.length), init);
    }
    throw new Error(`unexpected outbound fetch in test: ${url.origin}${url.pathname}`);
  });
}

// ------------------------------------------------------------------ env and requests
export function makeEnv(over = {}) {
  return {
    BUCKET: testEnv.BUCKET,
    GPU_USD_PER_HR: "1.75",
    DAILY_CAP: "30",
    TEAM_DOMAIN: TEAM,
    POLICY_AUD: AUD,
    ALLOWED_EMAILS: `${EMAIL}, ${EMAIL2}`,
    ...SECRETS,
    ASSETS: { fetch: async () => new Response("<!doctype html><title>x</title>", { headers: { "Content-Type": "text/html" } }) },
    ...over,
  };
}

export async function clearBucket() {
  const b = testEnv.BUCKET;
  let cursor;
  do {
    const res = await b.list({ cursor });
    for (const o of res.objects) await b.delete(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
}

/** Send a request through the Worker. */
export async function send(path, opts = {}) {
  const { method = "GET", headers = {}, body, env = makeEnv(), jwt, json } = opts;
  const h = new Headers(headers);
  const token = jwt === undefined ? await mintJwt() : jwt;
  if (token) h.set("Cf-Access-Jwt-Assertion", token);
  if (method !== "GET" && method !== "HEAD") {
    if (!opts.noCsrf) {
      h.set("X-Jubividia", "1");
      h.set("Origin", ORIGIN);
    }
  }
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  }
  const req = new Request(ORIGIN + path, { method, headers: h, body: payload });
  return worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
}

export const bucket = () => testEnv.BUCKET;

export async function putObject(key, body, contentType) {
  await testEnv.BUCKET.put(key, body, contentType ? { httpMetadata: { contentType } } : undefined);
}

// ------------------------------------------------------------------ sample bytes
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
export function mp4Bytes(brand = "isom", extra = 40) {
  const b = new Uint8Array(12 + extra);
  b.set([0, 0, 0, 24], 0);
  b.set(new TextEncoder().encode("ftyp"), 4);
  b.set(new TextEncoder().encode(brand.padEnd(4, " ")), 8);
  return b;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Upload a tiny valid image and return its server-generated key. */
export async function uploadImage() {
  const res = await send("/api/upload?kind=image&ext=jpg", {
    method: "PUT",
    body: JPEG,
    headers: { "Content-Type": "image/jpeg", "Content-Length": String(JPEG.byteLength) },
  });
  return (await res.json()).upload_key;
}
export async function uploadVideo() {
  const body = mp4Bytes();
  const res = await send("/api/upload?kind=video&ext=mp4", {
    method: "PUT",
    body,
    headers: { "Content-Type": "video/mp4", "Content-Length": String(body.byteLength) },
  });
  return (await res.json()).upload_key;
}

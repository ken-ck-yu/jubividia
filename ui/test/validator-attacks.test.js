// Independent validator's attack tests (not the engineer's). They run the unmodified Worker in
// workerd/Miniflare with a real local R2 binding and in-process fakes for JWKS and RunPod.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from "jose";
import worker from "../src/index.js";
import {
  installFakes, send, makeEnv, clearBucket, runpod, bucket, putObject, uploadImage, uploadVideo,
  AUD, EMAIL, EMAIL2, ORIGIN, JPEG, PNG, mp4Bytes, UUID_RE,
} from "./helpers.js";

// ---------------------------------------------------------------- own JWKS world
let n = 0;
const nextTeam = () => `https://v${++n}-team.cloudflareaccess.test`;
const keyCache = {};
async function kp(name) {
  if (!keyCache[name]) {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const jwk = await exportJWK(publicKey);
    jwk.kid = `kid-${name}`;
    jwk.alg = "RS256";
    jwk.use = "sig";
    keyCache[name] = { publicKey, privateKey, jwk };
  }
  return keyCache[name];
}
const world = { keys: [], mode: "ok", calls: [] };
function installJwksWorld() {
  world.keys = [];
  world.mode = "ok";
  world.calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith(".cloudflareaccess.test") || url.hostname.includes("attacker") || url.hostname.includes("evil")) world.calls.push(url.href);
    if (url.hostname.endsWith(".cloudflareaccess.test") && url.pathname === "/cdn-cgi/access/certs") {
      switch (world.mode) {
        case "throw": throw new TypeError("network down");
        case "html": return new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } });
        case "500": return new Response("boom", { status: 500 });
        case "empty": return new Response(JSON.stringify({ keys: [] }), { headers: { "Content-Type": "application/json" } });
        case "garbagekeys": return new Response(JSON.stringify({ keys: [{ kty: "RSA" }, 7, null] }), { headers: { "Content-Type": "application/json" } });
        case "hang":
          return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError"))));
        default:
          return new Response(JSON.stringify({ keys: world.keys }), { headers: { "Content-Type": "application/json" } });
      }
    }
    throw new Error(`unexpected outbound fetch: ${url.href}`);
  });
}

async function mint(team, o = {}) {
  const { signer = "A", kid = `kid-${signer}`, alg = "RS256", header = {}, iss = team, aud = AUD, email = EMAIL, exp = 3600, nbf, claims = {}, noExp = false, noEmail = false, key } = o;
  const k = await kp(signer);
  const body = { ...(noEmail ? {} : { email }), ...claims };
  let j = new SignJWT(body).setProtectedHeader({ alg, kid, ...header }).setIssuedAt().setIssuer(iss).setAudience(aud);
  if (!noExp) j = j.setExpirationTime(Math.floor(Date.now() / 1000) + exp);
  if (nbf !== undefined) j = j.setNotBefore(Math.floor(Date.now() / 1000) + nbf);
  return j.sign(key ?? k.privateKey);
}
const b64 = (o) => btoa(typeof o === "string" ? o : JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function expectClosed(path, jwt, env, opts = {}) {
  const res = await send(path, { jwt, env, ...opts });
  expect([403, 503], `${opts.method || "GET"} ${path}`).toContain(res.status);
  expect(await res.text()).toBe("");
  return res.status;
}

beforeEach(async () => {
  installFakes();
  await clearBucket();
  await (await import("./helpers.js")).mintJwt(); // warm the helper's lazily created key (it races when first used concurrently)
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ================================================================ 1. AUTH GATE
describe("VALIDATOR auth gate", () => {
  async function setup() {
    installJwksWorld();
    const team = nextTeam();
    world.keys = [(await kp("A")).jwk];
    return { team, env: makeEnv({ TEAM_DOMAIN: team }) };
  }

  it("control: a good token passes", async () => {
    const { team, env } = await setup();
    expect((await send("/", { jwt: await mint(team), env })).status).toBe(200);
  });

  it("no header, empty, whitespace, garbage, bearer-prefixed, 4-segment, huge", async () => {
    const { team, env } = await setup();
    const good = await mint(team);
    for (const t of ["", " ", "x", "a.b", "a.b.c", "....", `Bearer ${good}`, `${good}.extra`, `${good}x`, "A".repeat(100000), "\u0001", "é"]) {
      for (const p of ["/", "/app.js", "/api/state"]) {
        let res;
        try {
          res = await send(p, { jwt: t, env });
        } catch {
          continue; // the Headers class refused the value: it could never reach the Worker
        }
        expect([403, 503], `${JSON.stringify(t.slice(0, 20))} ${p}`).toContain(res.status);
        expect(await res.text()).toBe("");
      }
    }
  });

  it("alg none (several spellings), stripped signature, HS256 with the public key (algorithm confusion), ES256/PS256/RS512 headers", async () => {
    const { team, env } = await setup();
    const k = await kp("A");
    const payload = { iss: team, aud: AUD, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 3600 };
    for (const alg of ["none", "None", "NONE", "nOnE"]) {
      await expectClosed("/api/state", `${b64({ alg, typ: "JWT", kid: "kid-A" })}.${b64(payload)}.`, env);
    }
    const good = await mint(team);
    const [h, p] = good.split(".");
    await expectClosed("/api/state", `${h}.${p}.`, env);
    // HS256 signed with the public key material, as JWK JSON, SPKI PEM and raw modulus
    const pem = await exportSPKI(k.publicKey);
    for (const secret of [new TextEncoder().encode(JSON.stringify(k.jwk)), new TextEncoder().encode(pem), new TextEncoder().encode(k.jwk.n)]) {
      for (const alg of ["HS256", "HS384", "HS512"]) {
        const t = await new SignJWT({ email: EMAIL }).setProtectedHeader({ alg, kid: "kid-A" }).setIssuer(team).setAudience(AUD).setExpirationTime("1h").sign(secret);
        await expectClosed("/api/state", t, env);
      }
    }
    // header claims another algorithm but the signature is the RS256 one
    for (const alg of ["ES256", "PS256", "RS512", "RS384", "EdDSA"]) {
      await expectClosed("/api/state", `${b64({ alg, typ: "JWT", kid: "kid-A" })}.${p}.${good.split(".")[2]}`, env);
    }
  });

  it("wrong issuer (similar hosts, trailing slash, http), wrong audience (string, array, empty, missing, case)", async () => {
    const { team, env } = await setup();
    for (const iss of ["https://evil.cloudflareaccess.test", `${team}/`, team.replace("https", "http"), `${team}.evil.test`, team.toUpperCase(), "", `x${team}`]) {
      await expectClosed("/api/state", await mint(team, { iss }), env);
    }
    for (const aud of ["other", AUD.toUpperCase(), `${AUD} `, "", [], ["a", "b"], [`${AUD}x`]]) {
      await expectClosed("/api/state", await mint(team, { aud }), env);
    }
    // array audience that DOES contain ours is valid per RFC 7519 and is accepted
    expect((await send("/api/state", { jwt: await mint(team, { aud: ["other", AUD] }), env })).status).toBe(200);
    // no aud at all
    const k = await kp("A");
    const t = await new SignJWT({ email: EMAIL }).setProtectedHeader({ alg: "RS256", kid: "kid-A" }).setIssuer(team).setExpirationTime("1h").sign(k.privateKey);
    await expectClosed("/api/state", t, env);
  });

  it("expired, nbf in the future, within and beyond the 30 s tolerance, no exp claim", async () => {
    const { team, env } = await setup();
    await expectClosed("/api/state", await mint(team, { exp: -31 - 5 }), env);
    await expectClosed("/api/state", await mint(team, { exp: -3600 }), env);
    expect((await send("/api/state", { jwt: await mint(team, { exp: -10 }), env })).status).toBe(200);
    await expectClosed("/api/state", await mint(team, { nbf: 120 }), env);
    await expectClosed("/api/state", await mint(team, { nbf: 3600 }), env);
    expect((await send("/api/state", { jwt: await mint(team, { nbf: 10 }), env })).status).toBe(200);
    // FINDING (documented, low): a correctly signed token with no exp claim is accepted
    const noexp = await send("/api/state", { jwt: await mint(team, { noExp: true }), env });
    console.log("VALIDATOR: token without exp ->", noexp.status);
  });

  it("valid signature from an unknown key / unknown kid / attacker-embedded jwk, jku, x5u, kid tricks", async () => {
    const { team, env } = await setup();
    await expectClosed("/api/state", await mint(team, { signer: "B" }), env); // B's kid not in JWKS
    await expectClosed("/api/state", await mint(team, { signer: "B", kid: "kid-A" }), env); // B key claiming A's kid
    const kb = await kp("B");
    await expectClosed("/api/state", await mint(team, { signer: "B", header: { jwk: kb.jwk } }), env);
    world.calls = [];
    await expectClosed("/api/state", await mint(team, { signer: "B", header: { jku: "https://attacker.test/jwks", x5u: "https://attacker.test/x5", x5c: ["AAAA"] } }), env);
    expect(world.calls.every((u) => u.startsWith(team))).toBe(true);
    for (const kid of ["../../etc", "", "kid-A\u0000", "KID-A", "kid-A ", null]) {
      await expectClosed("/api/state", await mint(team, { signer: "B", kid: kid ?? undefined }), env);
    }
  });

  it("token whose iss is attacker controlled cannot redirect the JWKS fetch or poison the cache", async () => {
    const { team, env } = await setup();
    world.calls = [];
    const evil = "https://evil.cloudflareaccess.test";
    // attacker owns evil's key AND signs with it, setting iss to evil
    world.keys = [(await kp("A")).jwk];
    await expectClosed("/api/state", await mint(team, { signer: "B", iss: evil }), env);
    expect(world.calls.every((u) => u.startsWith(team))).toBe(true);
    // the genuine token still works afterwards (cache was not replaced)
    expect((await send("/api/state", { jwt: await mint(team), env })).status).toBe(200);
  });

  it("kid rotation: new key appears in JWKS (jose refetch cooldown behaviour recorded)", async () => {
    const { team, env } = await setup();
    expect((await send("/", { jwt: await mint(team), env })).status).toBe(200);
    world.keys = [(await kp("A")).jwk, (await kp("B")).jwk];
    const first = (await send("/", { jwt: await mint(team, { signer: "B" }), env })).status;
    console.log("VALIDATOR: first request signed by a freshly rotated-in key (within jose cooldown) ->", first);
    expect([200, 403]).toContain(first);
    // a bad kid must not make the worker refetch the JWKS on every request (no amplification)
    world.calls = [];
    for (let i = 0; i < 20; i++) await send("/", { jwt: await mint(team, { signer: "C" }), env });
    console.log("VALIDATOR: JWKS fetches caused by 20 unknown-kid tokens ->", world.calls.length);
    expect(world.calls.length).toBeLessThanOrEqual(2);
  });

  it("JWKS failures fail closed: network error, HTML, 500, empty set, garbage keys, hang (timeout)", async () => {
    for (const mode of ["throw", "html", "500", "empty", "garbagekeys"]) {
      installJwksWorld();
      const team = nextTeam();
      world.keys = [(await kp("A")).jwk];
      world.mode = mode;
      const env = makeEnv({ TEAM_DOMAIN: team });
      expect(await expectClosed("/api/state", await mint(team), env), mode).toBe(403);
    }
    installJwksWorld();
    const team = nextTeam();
    world.mode = "hang";
    const t0 = Date.now();
    await expectClosed("/api/state", await mint(team), makeEnv({ TEAM_DOMAIN: team }));
    const dt = Date.now() - t0;
    console.log("VALIDATOR: hung JWKS fetch released after ms ->", dt);
    expect(dt).toBeLessThan(12000);
  }, 30000);

  it("30 concurrent first requests on a cold isolate all verify (JWKS fetch count recorded)", async () => {
    const { team, env } = await setup();
    const tokens = await Promise.all(Array.from({ length: 30 }, () => mint(team)));
    world.calls = [];
    const rs = await Promise.all(tokens.map((t) => send("/api/state", { jwt: t, env })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    console.log("VALIDATOR: JWKS fetches for 30 concurrent cold requests ->", world.calls.length);
    // observed: jose does NOT de-duplicate concurrent cold fetches (one per request); cached afterwards
    world.calls = [];
    await Promise.all(tokens.map((t) => send("/api/state", { jwt: t, env })));
    expect(world.calls.length).toBe(0);
  });

  it("recovers after the JWKS comes back (no permanent negative cache)", async () => {
    installJwksWorld();
    const team = nextTeam();
    world.keys = [(await kp("A")).jwk];
    world.mode = "throw";
    const env = makeEnv({ TEAM_DOMAIN: team });
    await expectClosed("/api/state", await mint(team), env);
    world.mode = "ok";
    expect((await send("/api/state", { jwt: await mint(team), env })).status).toBe(200);
  });

  it("email claim: missing, wrong type, case, whitespace, lookalikes, injection", async () => {
    const { team, env } = await setup();
    for (const email of [
      "mallory@example.test", "ken@example.test.evil", "xken@example.test", "ken@example.testx", "ken@@example.test",
      "ken@example.test,partner@example.test", "ken@example.test;x", "ken+tag@example.test", "ken@exаmple.test", /* cyrillic a */
      "ken\u0000@example.test", "ken@example.test\u0000", "İken@example.test", "", " ", "@", "*", "ken", "ken@example.test​",
    ]) {
      await expectClosed("/api/state", await mint(team, { email }), env);
    }
    await expectClosed("/api/state", await mint(team, { noEmail: true }), env);
    await expectClosed("/api/state", await mint(team, { noEmail: true, claims: { sub: EMAIL, common_name: EMAIL } }), env); // service-token shape
    for (const bad of [[EMAIL], { a: EMAIL }, 1, true, null]) {
      await expectClosed("/api/state", await mint(team, { noEmail: true, claims: { email: bad } }), env);
    }
    // accepted by design: case and surrounding whitespace (the signed claim comes from Access)
    for (const email of ["KEN@EXAMPLE.TEST", " ken@example.test ", "Partner@Example.Test", "ken@example.test\n"]) {
      const s = (await send("/api/state", { jwt: await mint(team, { email }), env })).status;
      console.log(`VALIDATOR: email ${JSON.stringify(email)} ->`, s);
      expect(s).toBe(200);
    }
    // wildcard / regex characters inside ALLOWED_EMAILS are literals
    const wild = makeEnv({ TEAM_DOMAIN: team, ALLOWED_EMAILS: "*@example.test, .*@example.test" });
    await expectClosed("/api/state", await mint(team, { email: "ken@example.test" }), wild);
  });

  it("Cf-Access-Authenticated-User-Email and other identity headers without a JWT are worthless", async () => {
    const { env } = await setup();
    const headers = {
      "Cf-Access-Authenticated-User-Email": EMAIL, "Cf-Access-Jwt-Assertion-Email": EMAIL2,
      "X-Forwarded-Email": EMAIL, "X-Auth-Request-Email": EMAIL, "Cf-Connecting-Ip": "127.0.0.1", Authorization: "Bearer x",
      Cookie: "CF_Authorization=abc; CF_AppSession=abc", "X-Forwarded-For": "127.0.0.1", Host: "localhost",
    };
    for (const p of ["/", "/app.js", "/api/state", "/api/outputs", "/api/generate"]) {
      await expectClosed(p, "", env, { headers });
    }
    // the cookie form of the token is NOT accepted either (only the header)
    const team = env.TEAM_DOMAIN;
    const good = await mint(team);
    await expectClosed("/", "", env, { headers: { Cookie: `CF_Authorization=${good}` } });
    await expectClosed("/", "", env, { headers: { Authorization: `Bearer ${good}` } });
  });

  it("odd paths and methods with and without a token", async () => {
    const { team, env } = await setup();
    const good = await mint(team);
    const paths = ["//", "///api/state", "/api//state", "/api/../api/state", "/%2e%2e/", "/%2e%2e%2fapi/state", "/api%2fstate", "/.", "/..", "/./app.js", "/app.js/", "/API/state", "/api/state/", "/api/outputs/%2e%2e/state/active.json", "/api/outputs/state/active.json", "/api/outputs/inputs/x.jpg", "/api/outputs//outputs/2026-10-29/20261029T010101-x.mp4", "/\\api\\state", "/api/state?x=1#y", "/index.html", "/wrangler.toml", "/.dev.vars", "/src/index.js", "/../src/auth.js", "/%00", "/api/upload", "/api/cancel/", "/api/status/"];
    for (const p of paths) {
      for (const method of ["GET", "HEAD", "OPTIONS", "DELETE", "PATCH", "TRACE"]) {
        let res;
        try {
          res = await send(p, { method, jwt: "", env });
        } catch {
          continue; // the runtime refused to build the request at all
        }
        expect([403, 503], `${method} ${p}`).toContain(res.status);
        expect(await res.text()).toBe("");
      }
    }
    // with a valid token none of these reach state/, inputs/ or source files
    for (const p of paths.filter((x) => /state|inputs|toml|vars|src|wrangler/.test(x))) {
      const res = await send(p, { jwt: good, env });
      const text = await res.text();
      expect(text, p).not.toMatch(/active\.json|attempts|RUNPOD_API_KEY|jose/);
    }
  });

  it("missing, blank, whitespace or malformed config fails closed even with a perfect token", async () => {
    const { team } = await setup();
    const good = await mint(team);
    const base = { TEAM_DOMAIN: team };
    const variants = [
      { TEAM_DOMAIN: "" }, { TEAM_DOMAIN: "   " }, { TEAM_DOMAIN: undefined }, { TEAM_DOMAIN: `${team}/path` }, { TEAM_DOMAIN: "http://insecure.test" }, { TEAM_DOMAIN: "https://" }, { TEAM_DOMAIN: 5 },
      { POLICY_AUD: "" }, { POLICY_AUD: "  " }, { POLICY_AUD: undefined }, { POLICY_AUD: null },
      { ALLOWED_EMAILS: "" }, { ALLOWED_EMAILS: " , ,, " }, { ALLOWED_EMAILS: undefined }, { ALLOWED_EMAILS: "nobody" }, { ALLOWED_EMAILS: 7 },
    ];
    for (const v of variants) {
      const res = await send("/api/state", { jwt: good, env: makeEnv({ ...base, ...v }) });
      expect([403, 503], JSON.stringify(v)).toContain(res.status);
      expect(await res.text()).toBe("");
    }
    // a blank POLICY_AUD must never turn into "any audience matches"
    expect((await send("/api/state", { jwt: await mint(team, { aud: "anything" }), env: makeEnv({ ...base, POLICY_AUD: " " }) })).status).toBe(503);
  });

  it("every denial carries the security headers and no-store, with an empty body", async () => {
    const { env } = await setup();
    const res = await send("/", { jwt: "", env });
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Length") ?? "0").toBe("0");
  });

  it("the real static-assets binding is only reachable after the gate", async () => {
    const { team } = await setup();
    const hasAssets = typeof testEnv.ASSETS?.fetch === "function";
    console.log("VALIDATOR: real ASSETS binding present in test pool ->", hasAssets);
    if (!hasAssets) return;
    const env = makeEnv({ TEAM_DOMAIN: team, ASSETS: testEnv.ASSETS });
    const open = await send("/", { jwt: await mint(team), env });
    expect(open.status).toBe(200);
    const html = await open.text();
    expect(html).toContain("<title>JubiVidia</title>");
    expect(open.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    await expectClosed("/", "", env);
    await expectClosed("/app.js", "garbage", env);
  });
});

// ================================================================ 2. SPEND GUARDS
describe("VALIDATOR spend guards", () => {
  const gen = (over = {}, id) => send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x", request_id: id, ...over } });
  const runCalls = () => runpod.calls.filter((c) => c.path === "/run");
  const usage = async (date) => {
    const o = await bucket().get(`state/usage/${date ?? new Date().toISOString().slice(0, 10)}.json`);
    return o ? (await o.json()).attempts : 0;
  };

  it("10 concurrent submits with distinct request ids: exactly one reaches RunPod, usage is 1", async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => gen({}, `req-${i}-aaaaaaaa`)));
    const codes = rs.map((r) => r.status).sort();
    console.log("VALIDATOR: concurrent codes ->", codes.join(","), JSON.stringify(await Promise.all(rs.map((r) => r.clone().text()))).slice(0, 600));
    expect(codes.filter((c) => c === 202).length).toBe(1);
    expect(codes.filter((c) => c === 409).length).toBe(9);
    expect(runCalls().length).toBe(1);
    expect(await usage()).toBe(1);
  });

  it("concurrent submits from the two different users", async () => {
    const mk = async (e) => (await import("./helpers.js")).mintJwt({ email: e });
    const [a, b] = await Promise.all([mk(EMAIL), mk(EMAIL2)]);
    const rs = await Promise.all([
      send("/api/generate", { method: "POST", jwt: a, json: { mode: "t2v", prompt: "a" } }),
      send("/api/generate", { method: "POST", jwt: b, json: { mode: "t2v", prompt: "b" } }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(runCalls().length).toBe(1);
  });

  it("the same request_id fired 8 times concurrently creates one job", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => gen({}, "same-req-12345678")));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(runCalls().length).toBe(1);
    expect(await usage()).toBe(1);
    const ids = new Set(bodies.map((b) => b.job_id).filter(Boolean));
    expect(ids.size).toBe(1);
    expect(rs.every((r) => [200, 202, 409].includes(r.status))).toBe(true);
  });

  it("same request_id reused AFTER the job finished creates a second billed job (documented)", async () => {
    const first = await (await gen({}, "reuse-req-1234567")).json();
    runpod.jobs.get(first.job_id).status = "COMPLETED";
    runpod.jobs.get(first.job_id).output = { key: "outputs/2026-10-29/20261029T010101-a.mp4" };
    runpod.health.jobs.inQueue = 0;
    await send("/api/status/" + first.job_id);
    const second = await gen({}, "reuse-req-1234567");
    console.log("VALIDATOR: request_id reuse after completion ->", second.status, await second.clone().text());
    expect(runCalls().length).toBe(2);
  });

  it("/run timeout keeps the lock and the count; the next attempt is refused; health-empty frees it after 2 min", async () => {
    runpod.runMode = "network";
    const r = await gen({}, "timeout-req-12345");
    expect(r.status).toBe(502);
    expect(await usage()).toBe(1);
    const act = await (await bucket().get("state/active.json")).json();
    expect(act.state).toBe("unknown");
    runpod.runMode = "ok";
    expect((await gen({}, "after-timeout-9999")).status).toBe(409);
    expect(runCalls().length).toBe(1);
    // 3 minutes later, /health empty -> free
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 60_000);
    const r2 = await gen({}, "after-timeout-8888");
    console.log("VALIDATOR: submit 3 min after an unknown outcome with empty /health ->", r2.status);
    expect(r2.status).toBe(202);
    expect(await usage()).toBe(2);
  });

  it("4xx/5xx from /run roll back (lock free, count back to 0), 429 maps to 503", async () => {
    for (const status of [400, 401, 404, 409, 429, 500, 503]) {
      await clearBucket();
      runpod.reset();
      runpod.runMode = { status, body: { error: "RAW" } };
      const r = await gen({}, `rb-${status}-12345678`);
      const text = await r.text();
      expect(r.status, String(status)).toBeGreaterThanOrEqual(502 - 0);
      expect(text).not.toContain("RAW");
      expect(await bucket().get("state/active.json")).toBeNull();
      expect(await usage()).toBe(0);
    }
  });

  it("cancel on a queued job, then immediately resubmit", async () => {
    const j = await (await gen({}, "cancel-q-12345678")).json();
    const c = await send(`/api/cancel/${j.job_id}`, { method: "POST" });
    expect(c.status).toBe(202);
    expect(await bucket().get("state/active.json")).not.toBeNull(); // lock stays
    // RunPod now reports CANCELLED (fake default). A resubmit is allowed because the job is terminal.
    runpod.health.jobs.inQueue = 0;
    const again = await gen({}, "cancel-q-87654321");
    console.log("VALIDATOR: resubmit right after cancel (RunPod says CANCELLED, /health empty) ->", again.status);
    // and when the worker is still winding down (/health inProgress=1) it must be refused
    await clearBucket();
    runpod.reset();
    const j2 = await (await gen({}, "cancel-r-12345678")).json();
    runpod.jobs.get(j2.job_id).status = "IN_PROGRESS";
    runpod.cancelStopsJob = false;
    await send(`/api/cancel/${j2.job_id}`, { method: "POST" });
    expect((await gen({}, "cancel-r-87654321")).status).toBe(409);
    expect(runCalls().length).toBe(1);
  });

  it("cancel of a job that is not the active one, of garbage ids, of path-ish ids", async () => {
    await gen({}, "cancel-g-12345678");
    for (const id of ["nope-nope-nope", "../state", "%2e%2e", "a".repeat(200), "x y z q w e r t", "job-00000001-u1/../x"]) {
      const r = await send(`/api/cancel/${id}`, { method: "POST" });
      expect([400, 404, 405]).toContain(r.status);
    }
    expect(runpod.calls.filter((c) => c.path.startsWith("/cancel")).length).toBe(0);
  });

  it("daily cap boundary, shared by both users, and UTC midnight rollover", async () => {
    const env = makeEnv({ DAILY_CAP: "2" });
    const g = (email) => send("/api/generate", { method: "POST", env, json: { mode: "t2v", prompt: "x" } });
    const finish = async () => {
      for (const [id, j] of runpod.jobs) if (j.status === "IN_QUEUE") { j.status = "COMPLETED"; j.output = { key: "outputs/2026-10-29/20261029T010101-a.mp4" }; runpod.health.jobs.inQueue = 0; await send("/api/status/" + id, { env }); }
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-29T23:59:30Z"));
    expect((await g()).status).toBe(202);
    await finish();
    expect((await g()).status).toBe(202);
    await finish();
    const third = await g();
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.resets_at).toBe("2026-10-30T00:00:00.000Z");
    expect(await usage("2026-10-29")).toBe(2);
    vi.setSystemTime(new Date("2026-10-30T00:00:01Z"));
    expect((await g()).status).toBe(202);
    expect(await usage("2026-10-30")).toBe(1);
    // cap 0 blocks everything
    await finish();
    expect((await send("/api/generate", { method: "POST", env: makeEnv({ DAILY_CAP: "0" }), json: { mode: "t2v", prompt: "x" } })).status).toBe(429);
    // negative / float / text caps fall back to 30, not to "unlimited"
    for (const cap of ["-1", "1.5", "abc", "", "1e9"]) {
      await bucket().put("state/usage/2026-10-30.json", JSON.stringify({ attempts: 30 }));
      const r = await send("/api/generate", { method: "POST", env: makeEnv({ DAILY_CAP: cap }), json: { mode: "t2v", prompt: "x" } });
      console.log(`VALIDATOR: DAILY_CAP=${JSON.stringify(cap)} with 30 used ->`, r.status);
      if (cap !== "1e9") expect(r.status).toBe(429);
    }
  });

  it("counter is never negative or NaN: corrupt usage files fail safe", async () => {
    const date = new Date().toISOString().slice(0, 10);
    for (const raw of ['{"attempts":-5}', '{"attempts":"3"}', "not json", "[]", '{"attempts":1e999}', '{"attempts":0.5}', "null"]) {
      await clearBucket();
      runpod.reset();
      await bucket().put(`state/usage/${date}.json`, raw);
      runpod.runMode = { status: 500 };
      await gen({}, "neg-12345678");
      const o = await bucket().get(`state/usage/${date}.json`);
      const txt = await o.text();
      let a;
      try { a = JSON.parse(txt).attempts; } catch { a = "unparseable"; }
      console.log(`VALIDATOR: usage ${raw} -> after rollback`, JSON.stringify(a));
      expect(typeof a === "number" ? a >= 0 : true).toBe(true);
    }
  });

  it("/health in-flight jobs block even with no reservation, and consume no count", async () => {
    runpod.health.jobs.inProgress = 1;
    const r = await gen({}, "health-12345678");
    expect(r.status).toBe(409);
    expect(await usage()).toBe(0);
    expect(await bucket().get("state/active.json")).toBeNull();
    expect(runCalls().length).toBe(0);
  });

  it("stale reservations: a fresh job-less reservation blocks (until stale), an old one is replaced", async () => {
    const now = Date.now();
    await bucket().put("state/active.json", JSON.stringify({ request_id: "ghost-aaaa", reserved_at: now - 10 * 60_000, job_id: null, state: "reserving", mode: "t2v" }));
    // F3 fix: a job-less 'reserving' record older than 120 s resolves through /health (nothing in flight -> free)
    const resolved = await gen({}, "after-ghost-12345");
    expect(resolved.status).toBe(202);
    await bucket().put("state/active.json", JSON.stringify({ request_id: "ghost-cccc", reserved_at: Date.now() - 30_000, job_id: null, state: "reserving", mode: "t2v" }));
    expect((await gen({}, "after-ghost-34567")).status).toBe(409); // still young: may be submitting
    await bucket().put("state/active.json", JSON.stringify({ request_id: "ghost-bbbb", reserved_at: now - 40 * 60_000, job_id: null, state: "reserving" }));
    runpod.health.jobs.inQueue = 0; // the earlier fake job is no longer in flight
    expect((await gen({}, "after-ghost-23456")).status).toBe(202);
  });

  it("a reservation whose job RunPod no longer knows (404) or reports terminal is released", async () => {
    await bucket().put("state/active.json", JSON.stringify({ request_id: "old-aaaa", reserved_at: Date.now() - 5 * 60_000, job_id: "job-gone-0001", state: "submitted" }));
    expect((await gen({}, "after-gone-12345")).status).toBe(202);
  });

  it("status for a job that is not active or last is 404; any allowed user can read the shared active/last job", async () => {
    const j = await (await gen({}, "shared-12345678")).json();
    const other = await (await import("./helpers.js")).mintJwt({ email: EMAIL2 });
    const s = await send(`/api/status/${j.job_id}`, { jwt: other });
    expect(s.status).toBe(200); // shared by design
    expect((await send("/api/status/job-00000099-u1")).status).toBe(404);
    expect((await send("/api/status/..%2fstate")).status).toBe(400);
  });

  it("client cannot choose an input key, bucket, endpoint, policy, URL or RunPod fields", async () => {
    const up = await uploadImage();
    const evil = {
      mode: "i2v", prompt: "x", upload_key: up,
      input_key: "state/active.json", key: "state/active.json", bucket: "other", endpoint: "ep-evil", endpoint_id: "ep-evil", endpointId: "ep-evil",
      policy: { ttl: 1, executionTimeout: 99999999 }, webhook: "https://attacker.test/hook", url: "https://attacker.test", input: { input_key: "state/x", prompt: "y" },
      s3Config: { x: 1 }, __proto__: { polluted: 1 }, constructor: { prototype: { polluted: 1 } }, extra_env: { A: 1 }, negative: "no", cfg: 99, steps: 9999, image_url: "https://attacker.test/i.jpg",
    };
    const r = await send("/api/generate", { method: "POST", json: evil });
    expect(r.status).toBe(202);
    const run = runCalls()[0];
    expect(Object.keys(run.body).sort()).toEqual(["input", "policy"]);
    expect(run.body.policy).toEqual({ ttl: 2_100_000, executionTimeout: 900_000 });
    expect(Object.keys(run.body.input).sort()).toEqual(["fps", "height", "input_key", "mode", "num_frames", "prompt", "width"].sort());
    expect(run.body.input.input_key).toBe(up);
    expect(run.path).toBe("/run");
    // raw JSON with __proto__ own key
    await clearBucket(); runpod.reset();
    const up2 = await uploadImage();
    const raw = `{"mode":"i2v","prompt":"x","upload_key":"${up2}","__proto__":{"input_key":"state/active.json"},"policy":{"ttl":1}}`;
    const r2 = await send("/api/generate", { method: "POST", body: raw, headers: { "Content-Type": "application/json" } });
    expect(r2.status).toBe(202);
    expect(runCalls()[0].body.input.input_key).toBe(up2);
    expect(runCalls()[0].body.policy.ttl).toBe(2_100_000);
  });

  it("upload_key tricks: traversal, other prefixes, uppercase, trailing junk, mismatched mode, http URLs", async () => {
    const img = await uploadImage();
    const vid = await uploadVideo();
    const uuid = img.slice("inputs/".length, -4);
    const bad = [
      "state/active.json", "inputs/../state/active.json", `inputs/${uuid}.jpg/../../state/active.json`, `inputs//${uuid}.jpg`, `/inputs/${uuid}.jpg`, `inputs/${uuid.toUpperCase()}.jpg`,
      `${img}\n`, `${img} `, `${img}.json`, `inputs/${uuid}.JPG`, `inputs/${uuid}.gif`, `https://attacker.test/${uuid}.jpg`, `s3://other/${uuid}.jpg`, `outputs/2026-10-29/20261029T010101-x.mp4`, `inputs/${uuid}.jpg%00.png`, [img], { toString: () => img }, 5,
    ];
    for (const k of bad) {
      const r = await send("/api/generate", { method: "POST", json: { mode: "i2v", prompt: "x", upload_key: k } });
      expect(r.status, JSON.stringify(k)).toBe(400);
    }
    expect((await send("/api/generate", { method: "POST", json: { mode: "i2v", prompt: "x", upload_key: vid } })).status).toBe(400);
    expect((await send("/api/generate", { method: "POST", json: { mode: "v2v", prompt: "x", upload_key: img, num_frames: 41 } })).status).toBe(400);
    expect(runCalls().length).toBe(0);
    expect(await usage()).toBe(0);
  });

  it("numeric parameter edge cases never reach RunPod out of bounds", async () => {
    const cases = [
      { width: 2112 }, { width: 255 }, { width: 1281 }, { width: 1280.5 }, { width: "1280" }, { width: 1e3 }, { width: -64 }, { width: 0 }, { width: null, height: 100000 },
      { num_frames: 482 }, { num_frames: 120 }, { num_frames: 1e9 }, { num_frames: "121" }, { num_frames: 8 }, { fps: 0 }, { fps: 61 }, { fps: 24.5 }, { duration_s: 21 }, { duration_s: 0 }, { duration_s: -1 }, { duration_s: "5" },
      { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 }, { seed: "abc" }, { prompt: "x".repeat(2001) }, { prompt: "   " }, { prompt: 5 }, { prompt: ["a"] }, { mode: "T2V" }, { mode: "t2v " },
    ];
    for (const c of cases) {
      const r = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x", ...c } });
      expect(r.status, JSON.stringify(c)).toBe(400);
    }
    expect(runCalls().length).toBe(0);
    // inclusive extremes are accepted and billed under the worst-case figure
    const ok = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x", width: 2048, height: 2048, num_frames: 481, fps: 60 } });
    expect(ok.status).toBe(202);
    const body = await ok.json();
    expect(body.untested).toBe(true);
    expect(body.expect.worst_case_usd).toBeCloseTo(0.65, 2);
  });

  it("a body that is huge, deeply nested, or not an object", async () => {
    for (const body of ["[]", "null", "5", '"s"', "{", "", "{".repeat(20000), JSON.stringify({ mode: "t2v", prompt: "x", pad: "y".repeat(20000) })]) {
      const r = await send("/api/generate", { method: "POST", body, headers: { "Content-Type": "application/json" } });
      expect([400, 413]).toContain(r.status);
    }
    expect(runCalls().length).toBe(0);
  });

  it("GET /api/state is not a CSRF write surface for the daily counter", async () => {
    await gen({}, "state-write-1234");
    const before = await usage();
    for (let i = 0; i < 5; i++) await send("/api/state");
    expect(await usage()).toBe(before);
  });
});

// ================================================================ 3. MEDIA AND UPLOAD
describe("VALIDATOR media and upload", () => {
  const KEY = "outputs/2026-10-29/20261029T010101-abc.mp4";
  const ranged = (range, extra = {}) => send(`/api/outputs/${KEY}`, { headers: { Range: range, ...extra } });

  it("Range matrix against the real R2 binding", async () => {
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    await putObject(KEY, bytes, "video/mp4");
    const cases = {
      "bytes=0-1": [206, "bytes 0-1/1000", 2], "bytes=0-0": [206, "bytes 0-0/1000", 1], "bytes=0-": [206, "bytes 0-999/1000", 1000],
      "bytes=999-": [206, "bytes 999-999/1000", 1], "bytes=-1": [206, "bytes 999-999/1000", 1], "bytes=-5000": [206, "bytes 0-999/1000", 1000],
      "bytes=500-99999999999": [206, "bytes 500-999/1000", 500], "bytes=1000-": [416, "bytes */1000", 0], "bytes=1000-2000": [416, "bytes */1000", 0],
      "bytes=99999999999999999999-": [416, "bytes */1000", 0], "bytes=-0": [416, "bytes */1000", 0], "BYTES=0-1": [206, "bytes 0-1/1000", 2],
      " bytes=0-1 ": [206, "bytes 0-1/1000", 2],
    };
    for (const [r, [status, cr, len]] of Object.entries(cases)) {
      const res = await ranged(r);
      expect(res.status, r).toBe(status);
      expect(res.headers.get("Content-Range"), r).toBe(cr);
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf.length, r).toBe(len);
      if (status === 206) {
        const start = Number(cr.split(" ")[1].split("-")[0]);
        expect(buf[0]).toBe(bytes[start]);
        expect(res.headers.get("Content-Length")).toBe(String(len));
      }
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    }
    // ignored (plain 200 with full body): multi-range, garbage, wrong unit, reversed, empty
    for (const r of ["bytes=0-1,5-6", "bytes=0-1, 4-5", "items=0-1", "bytes=", "bytes=a-b", "bytes=5-2", "bytes=-", "0-1", "bytes=0-1-2", "bytes=1.5-3", "bytes=0x1-3", "bytes=0-1;x"]) {
      const res = await ranged(r);
      console.log(`VALIDATOR: Range ${JSON.stringify(r)} ->`, res.status);
      expect(res.status, r).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(1000);
    }
    const head = await send(`/api/outputs/${KEY}`, { method: "HEAD", headers: { Range: "bytes=0-1" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("1000");
    expect(await head.text()).toBe("");
    const etag = head.headers.get("ETag");
    expect((await ranged("bytes=0-1", { "If-Range": etag })).status).toBe(206);
    expect((await ranged("bytes=0-1", { "If-Range": '"other"' })).status).toBe(200);
    expect((await send(`/api/outputs/${KEY}`, { headers: { "If-None-Match": etag } })).status).toBe(304);
    expect((await send(`/api/outputs/${KEY}`, { headers: { "If-None-Match": '"zzz", ' + etag } })).status).toBe(304);
    expect((await send(`/api/outputs/${KEY}`, { headers: { "If-None-Match": "*" } })).status).toBe(304);
  });

  it("zero-byte object", async () => {
    await putObject(KEY, new Uint8Array(0), "video/mp4");
    const full = await send(`/api/outputs/${KEY}`);
    expect(full.status).toBe(200);
    expect((await full.arrayBuffer()).byteLength).toBe(0);
    for (const r of ["bytes=0-1", "bytes=0-", "bytes=-1"]) expect((await ranged(r)).status, r).toBe(416);
    expect((await send(`/api/outputs/${KEY}`, { method: "HEAD" })).headers.get("Content-Length")).toBe("0");
  });

  it("a 'server' that has been given hostile bytes still cannot be rendered as HTML", async () => {
    await putObject("outputs/2026-10-29/20261029T010101-evil.json", '{"prompt":"<img src=x onerror=alert(1)>","mode":"t2v"}', "text/html");
    const res = await send("/api/outputs/outputs/2026-10-29/20261029T010101-evil.json");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await putObject(KEY, "<html><script>alert(1)</script>", "text/html");
    const mp4 = await send(`/api/outputs/${KEY}`);
    console.log("VALIDATOR: mp4 key with stored Content-Type text/html is served as ->", mp4.headers.get("Content-Type"));
  });

  async function put(qs, body, headers = {}) {
    return send(`/api/upload?${qs}`, { method: "PUT", body, headers });
  }
  const inputsList = async () => (await bucket().list({ prefix: "inputs/" })).objects.map((o) => o.key);

  it("lying Content-Length: shorter body, longer body, giant claim; failed uploads leave nothing", async () => {
    const body = new Uint8Array(JPEG.length + 50);
    body.set(JPEG);
    const shorter = await put("kind=image&ext=jpg", body, { "Content-Length": String(body.length + 100) });
    console.log("VALIDATOR: claims more than sent ->", shorter.status);
    expect(shorter.status).toBeGreaterThanOrEqual(400);
    const longer = await put("kind=image&ext=jpg", body, { "Content-Length": String(body.length - 10) });
    console.log("VALIDATOR: claims less than sent ->", longer.status);
    const giant = await put("kind=video&ext=mp4", mp4Bytes(), { "Content-Length": "999999999999" });
    expect(giant.status).toBe(413);
    const over = await put("kind=video&ext=mp4", mp4Bytes(), { "Content-Length": "95000001" });
    expect(over.status).toBe(413);
    const overImg = await put("kind=image&ext=jpg", JPEG, { "Content-Length": "20000001" });
    expect(overImg.status).toBe(413);
    expect(await inputsList()).toEqual([]);
  });

  it("no Content-Length / chunked stream is refused or capped; nothing is stored", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(JPEG); c.enqueue(new Uint8Array(1000)); c.close(); } });
    const r = await send("/api/upload?kind=image&ext=jpg", { method: "PUT", body: stream, headers: { "Content-Type": "image/jpeg" } });
    console.log("VALIDATOR: streamed upload with no Content-Length ->", r.status);
    expect([411, 400, 413]).toContain(r.status);
    expect(await inputsList()).toEqual([]);
  });

  it("extension / kind / type mismatches, polyglots and path tricks", async () => {
    const cases = [
      ["kind=image&ext=png", JPEG, "image/png", 415], ["kind=image&ext=jpg", PNG, "image/jpeg", 415], ["kind=video&ext=jpg", JPEG, "image/jpeg", 415], ["kind=image&ext=mp4", mp4Bytes(), "video/mp4", 415],
      ["kind=image&ext=jpg", JPEG, "video/mp4", 415], ["kind=image&ext=jpg", JPEG, "text/html", 415], ["kind=video&ext=mp4", mp4Bytes("heic"), "video/mp4", 415], ["kind=video&ext=mp4", mp4Bytes("mif1"), "video/mp4", 415],
      ["kind=video&ext=mp4", mp4Bytes("avif"), "video/mp4", 415], ["kind=video&ext=mov", mp4Bytes("heix"), "video/quicktime", 415], ["kind=video&ext=mp4", mp4Bytes("HEIC"), "video/mp4", 415], ["kind=video&ext=webm", mp4Bytes(), "video/webm", 415],
      ["kind=image&ext=heic", JPEG, "image/heic", 415], ["kind=image&ext=jpg%2F..%2Fx", JPEG, "image/jpeg", 415], ["kind=image&ext=jpg%00.png", JPEG, "image/jpeg", 415], ["kind=image&ext=..%2f..%2fx", JPEG, "image/jpeg", 415],
      ["kind=image&ext=__proto__", JPEG, "image/jpeg", 415], ["kind=image&ext=constructor", JPEG, "image/jpeg", 415], ["kind=image&ext=toString", JPEG, "image/jpeg", 415], ["kind=image&ext=", JPEG, "image/jpeg", 415], ["kind=../x&ext=jpg", JPEG, "image/jpeg", 400],
      ["kind=image", JPEG, "image/jpeg", 415], ["ext=jpg", JPEG, "image/jpeg", 400],
    ];
    for (const [qs, body, ct, want] of cases) {
      const r = await put(qs, body, { "Content-Type": ct, "Content-Length": String(body.length) });
      expect(r.status, `${qs} ${ct}`).toBe(want);
    }
    expect(await inputsList()).toEqual([]);
    // polyglot: valid JPEG header followed by HTML is accepted (magic bytes only) but never served back
    const poly = new Uint8Array([...JPEG, ...new TextEncoder().encode("<script>alert(1)</script>")]);
    const r = await put("kind=image&ext=jpg&name=../../evil.html&key=state/active.json", poly, { "Content-Type": "image/jpeg", "Content-Length": String(poly.length) });
    expect(r.status).toBe(201);
    const { upload_key } = await r.json();
    expect(upload_key).toMatch(/^inputs\/[0-9a-f-]{36}\.jpg$/);
    expect(upload_key.slice(7, -4)).toMatch(UUID_RE);
    expect((await send(`/api/outputs/${upload_key}`)).status).toBe(404);
    expect((await send(`/api/outputs/outputs/../${upload_key}`)).status).toBe(404);
    const head = await bucket().head(upload_key);
    expect(head.httpMetadata.contentType).toBe("image/jpeg");
    // upload ignores a filename in the query and the stored key set is exactly one
    expect((await inputsList()).length).toBe(1);
  });

  it("an mp4 whose ftyp is far from byte 4, and short files", async () => {
    for (const body of [new Uint8Array([0, 0, 0, 24]), new Uint8Array(11), new Uint8Array(12).fill(0x66), new TextEncoder().encode("<html>")]) {
      const r = await put("kind=video&ext=mp4", body, { "Content-Length": String(body.length) });
      expect(r.status).toBe(415);
    }
    expect(await inputsList()).toEqual([]);
  });

  it("CSRF on upload and generate: no header, foreign origin, null origin, cross-site fetch metadata", async () => {
    for (const h of [{}, { "X-Jubividia": "1", Origin: "https://evil.test" }, { "X-Jubividia": "1", Origin: "null" }, { "X-Jubividia": "1", "Sec-Fetch-Site": "cross-site" }, { "X-Jubividia": "1", "Sec-Fetch-Site": "same-site" }, { Origin: ORIGIN }]) {
      const r = await send("/api/upload?kind=image&ext=jpg", { method: "PUT", noCsrf: true, body: JPEG, headers: { "Content-Length": String(JPEG.length), ...h } });
      expect(r.status, JSON.stringify(h)).toBe(403);
    }
    expect(await inputsList()).toEqual([]);
  });
});

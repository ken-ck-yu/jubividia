import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, makeEnv, mintJwt, unsignedJwt, jwks, AUD, TEAM, clearBucket } from "./helpers.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

const PATHS = ["/", "/app.js", "/api/state", "/api/outputs", "/api/outputs/outputs/2026-10-29/20261029T010101-x.mp4", "/nope"];

async function expectDenied(opts, status = 403) {
  for (const p of PATHS) {
    const res = await send(p, opts);
    expect(res.status, p).toBe(status);
    expect(await res.text(), p).toBe("");
  }
}

describe("access JWT", () => {
  it("accepts a valid token", async () => {
    const res = await send("/");
    expect(res.status).toBe(200);
  });

  it("denies a missing header on every route, with an empty body", async () => {
    await expectDenied({ jwt: "" });
  });

  it("denies malformed, wrongly signed, none-alg, wrong issuer, wrong audience, expired and wrong email", async () => {
    await expectDenied({ jwt: "not.a.jwt" });
    await expectDenied({ jwt: await mintJwt({ signer: "other" }) });
    await expectDenied({ jwt: unsignedJwt() });
    await expectDenied({ jwt: await mintJwt({ iss: "https://evil.cloudflareaccess.test" }) });
    await expectDenied({ jwt: await mintJwt({ aud: "someone-elses-aud" }) });
    await expectDenied({ jwt: await mintJwt({ expSeconds: -3600 }) });
    await expectDenied({ jwt: await mintJwt({ email: "mallory@example.test" }) });
    await expectDenied({ jwt: await mintJwt({ noEmail: true }) });
  });

  it("tolerates a few seconds of clock skew but not minutes", async () => {
    expect((await send("/", { jwt: await mintJwt({ expSeconds: -10 }) })).status).toBe(200);
    expect((await send("/", { jwt: await mintJwt({ expSeconds: -120 }) })).status).toBe(403);
  });

  it("compares the email case-insensitively", async () => {
    const res = await send("/", { jwt: await mintJwt({ email: "KEN@Example.Test" }) });
    expect(res.status).toBe(200);
  });

  it("allows each listed email, rejects a third, and tolerates whitespace, case and empty entries", async () => {
    expect((await send("/", { jwt: await mintJwt({ email: "ken@example.test" }) })).status).toBe(200);
    expect((await send("/", { jwt: await mintJwt({ email: "partner@example.test" }) })).status).toBe(200);
    const third = await send("/", { jwt: await mintJwt({ email: "third@example.test" }) });
    expect(third.status).toBe(403);
    expect(await third.text()).toBe("");
    const env = makeEnv({ ALLOWED_EMAILS: "  Ken@Example.test ,, PARTNER@example.test  ,x" });
    expect((await send("/", { env, jwt: await mintJwt({ email: "partner@example.test" }) })).status).toBe(200);
    expect((await send("/", { env, jwt: await mintJwt({ email: "KEN@EXAMPLE.TEST" }) })).status).toBe(200);
    expect((await send("/", { env, jwt: await mintJwt({ email: "x" }) })).status).toBe(403);
    // a prefix or suffix of an allowed address is not allowed
    expect((await send("/", { jwt: await mintJwt({ email: "en@example.test" }) })).status).toBe(403);
    expect((await send("/", { jwt: await mintJwt({ email: "ken@example.test.evil" }) })).status).toBe(403);
  });

  it("fails closed when the list is empty or has no addresses", async () => {
    for (const v of ["", "  ", ",,", "no-at-sign"]) {
      expect((await send("/", { env: makeEnv({ ALLOWED_EMAILS: v }) })).status, v).toBe(503);
    }
  });

  it("shows who is signed in and records only a hash of the requester in the lock", async () => {
    const { runpod, bucket } = await import("./helpers.js");
    const me = await (await send("/api/state", { jwt: await mintJwt({ email: "partner@example.test" }) })).json();
    expect(me.me).toBe("partner@example.test");
    const gen = (email) => mintJwt({ email }).then((jwt) => send("/api/generate", { method: "POST", jwt, json: { mode: "t2v", prompt: "x" } }));
    expect((await gen("ken@example.test")).status).toBe(202);
    const rec = await (await bucket().get("state/active.json")).text();
    expect(rec).not.toContain("example.test");
    expect(rec).toMatch(/"by":"[0-9a-f]{8}"/);
    const second = await gen("partner@example.test");
    expect(second.status).toBe(409);
    expect((await second.json()).message).toContain("someone else");
    const st = await (await send("/api/state", { jwt: await mintJwt({ email: "ken@example.test" }) })).json();
    expect(st.mine).toBe(true);
    expect(runpod.calls.filter((c) => c.path === "/run").length).toBe(1);
  });

  it("fails closed with 503 and an empty body when any auth secret is missing", async () => {
    for (const k of ["TEAM_DOMAIN", "POLICY_AUD", "ALLOWED_EMAILS"]) {
      const res = await send("/", { env: makeEnv({ [k]: undefined }) });
      expect(res.status, k).toBe(503);
      expect(await res.text()).toBe("");
    }
    // even a perfectly valid token does not help without configuration
    const res = await send("/api/state", { env: makeEnv({ POLICY_AUD: "" }) });
    expect(res.status).toBe(503);
  });

  it("rejects a non-https team domain as misconfiguration", async () => {
    const res = await send("/", { env: makeEnv({ TEAM_DOMAIN: "http://insecure.test" }) });
    expect(res.status).toBe(503);
  });

  it("fetches the JWKS once per isolate, not once per request", async () => {
    await send("/");
    const before = jwks.requests;
    await send("/");
    await send("/app.js");
    await send("/api/state");
    expect(jwks.requests).toBe(before);
  });

  it("never lets an unauthenticated request reach RunPod or R2", async () => {
    const { runpod } = await import("./helpers.js");
    await send("/api/state", { jwt: "" });
    await send("/api/generate", { method: "POST", jwt: "", json: { mode: "t2v", prompt: "x" } });
    expect(runpod.calls.length).toBe(0);
  });

  it("uses the configured audience and team (sanity)", () => {
    expect(AUD).toBeTruthy();
    expect(TEAM.startsWith("https://")).toBe(true);
  });
});

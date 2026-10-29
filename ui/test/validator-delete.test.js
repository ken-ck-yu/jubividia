// Validator's attack tests for DELETE /api/outputs/<key> (branding/delete round). Local fakes only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { installFakes, send, makeEnv, clearBucket, runpod, bucket, putObject, mintJwt, unsignedJwt, ORIGIN, uploadImage } from "./helpers.js";

const BASE = "outputs/2026-10-29/20261029T010101-job1";
const OTHER = "outputs/2026-10-29/20261029T010102-job2";
const KEYS = [`${BASE}.mp4`, `${BASE}.jpg`, `${BASE}.json`, `${OTHER}.mp4`, `${OTHER}.jpg`, `${OTHER}.json`];

async function seed() {
  for (const k of KEYS) await putObject(k, k.endsWith(".json") ? '{"prompt":"p","mode":"t2v"}' : "bytes-" + k, k.endsWith(".mp4") ? "video/mp4" : undefined);
  await putObject("inputs/00000000-0000-4000-8000-000000000000.jpg", "in");
  await putObject("state/active.json", '{"request_id":"r","reserved_at":1}');
  await putObject("state/usage/2026-10-29.json", '{"attempts":7}');
  await putObject("state/last.json", "{}");
  await putObject("outputs/2026-10-29/notes.txt", "x");
  await putObject("other/thing.mp4", "x");
}
const snapshot = async () => {
  const out = {};
  let cursor;
  do {
    const r = await bucket().list({ cursor });
    for (const o of r.objects) out[o.key] = `${o.size}:${o.etag}`;
    cursor = r.truncated ? r.cursor : undefined;
  } while (cursor);
  return out;
};
const del = (path, opts = {}) => send(path, { method: "DELETE", ...opts });

beforeEach(async () => {
  installFakes();
  await clearBucket();
  await mintJwt();
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VALIDATOR delete: strict key", () => {
  it("every malformed or out-of-pattern key deletes nothing", async () => {
    const before = await snapshot();
    const u = "00000000-0000-4000-8000-000000000000";
    const bad = [
      `inputs/${u}.jpg`, "state/active.json", "state/usage/2026-10-29.json", "state/last.json", "other/thing.mp4", "outputs/2026-10-29/notes.txt",
      "outputs/2026-10-29/", "outputs/", "", "outputs", "outputs/2026-10-29/20261029T010101-job1", "outputs/2026-10-29/20261029T010101-job1.",
      `${BASE}.MP4`, `${BASE}.Json`, `${BASE}.mp4/`, `${BASE}.mp4.`, `${BASE}.mp4 `, `${BASE}.mp4%20`, `${BASE}.mp4%00`, `${BASE}.mp4%0a`, `${BASE}.mp4%0d%0a`, `${BASE}.mp4.json.mp4`,
      `${BASE}.png`, `${BASE}.webm`, `${BASE}.mp4x`, `${BASE}..mp4`, `${BASE}.m%704`,
      "outputs/2026-10-29/20261030T010101-job1.mp4", // folder date != timestamp date
      "outputs/2026-13-29/20261329T010101-job1.mp4", "outputs/2026-10-32/20261032T010101-job1.mp4", "outputs/2026-00-10/20260010T010101-job1.mp4",
      "outputs/2026-10-29/20261029T250101-job1.mp4", "outputs/2026-10-29/20261029T016001-job1.mp4", "outputs/2026-10-29/20261029T010160-job1.mp4",
      `outputs/2026-10-29/20261029T010101-${"a".repeat(81)}.mp4`, "outputs/2026-10-29/20261029T010101-.mp4", "outputs/2026-10-29/20261029T010101-job.1.mp4",
      "outputs/2026-10-29/20261029T010101-job 1.mp4", "outputs/2026-10-29/20261029T010101-job%201.mp4", "outputs/2026-10-29/20261029T010101-job1%2f..%2f..%2fstate%2factive.json.mp4",
      "outputs//2026-10-29/20261029T010101-job1.mp4", "outputs/2026-10-29//20261029T010101-job1.mp4", "/outputs/2026-10-29/20261029T010101-job1.mp4",
      "outputs\\2026-10-29\\20261029T010101-job1.mp4", "outputs%5c2026-10-29%5c20261029T010101-job1.mp4", "outputs%2f2026-10-29%2f20261029T010101-job1.mp4",
      "outputs/2026-10-29/20261029T010101-job1.mp4/../../../state/active.json", "outputs/2026-10-29/../../state/active.json", "outputs/../state/active.json", "outputs/%2e%2e/state/active.json",
      "outputs/%2E%2E/state/active.json", "outputs/.%2e/state/active.json", "outputs/%252e%252e/state/active.json", "outputs/2026-10-29/%2e%2e/%2e%2e/state/last.json",
      "outputs/２０２６-10-29/20261029T010101-job1.mp4", "outputs/2026-10-29/２０261029T010101-job1.mp4", "outputs/2026-10-29/20261029Ｔ010101-job1.mp4",
      "outputs/2026-10-29/20261029T010101-jоb1.mp4", "outputs/2026-10-29/20261029T010101-job1.mp４", "outputs/2026-10-29/20261029T010101-job1.Kson",
      "outputs/2026-10-29/20261029T010101-job1.mp4\u0000", "outputs/2026-10-29/20261029T010101-job1.mp4\n", "state/active.json\u0000.mp4", "outputs/2026-10-29/20261029T010101-job1.json\u0000/../../state/active.json",
      "%2e%2e/state/active.json", "..%2fstate%2factive.json", "....//state/active.json",
    ];
    for (const k of bad) {
      let res;
      try {
        res = await del(`/api/outputs/${k}`);
      } catch {
        continue; // the runtime refused to build the request
      }
      // The URL parser strips a trailing space/newline/tab, so those spellings ARE the valid BASE.mp4 key:
      // a 204 for them may only ever delete that one clip (checked below), never anything else.
      const normalisesToValid = /\.mp4( |\n|\u0000)$/.test(k) || k === "outputs\\2026-10-29\\20261029T010101-job1.mp4"; // WHATWG: "\" becomes "/"
      if (!normalisesToValid) expect([400, 404, 405], `${JSON.stringify(k)} ${[...k].filter((c) => c.charCodeAt(0) > 126 || c.charCodeAt(0) < 32).map((c) => c.charCodeAt(0).toString(16))} -> ${res.status}`).toContain(res.status);
      const text = await res.text();
      expect(text).not.toMatch(/active|usage|inputs|state\//);
    }
    const after = await snapshot();
    for (const e of ["mp4", "jpg", "json"]) {
      delete before[`${BASE}.${e}`];
      delete after[`${BASE}.${e}`];
    }
    expect(after).toEqual(before);
  });

  it("DELETE on non-key routes never deletes", async () => {
    const before = await snapshot();
    for (const p of ["/api/outputs", "/api/outputs/", "/api/state", "/api/state/active.json", "/api/upload", "/api/generate", "/api/status/job-00000001-u1", "/api/cancel/job-00000001-u1", "/", "/app.js", "/state/active.json", "/outputs/2026-10-29/20261029T010101-job1.mp4"]) {
      const res = await del(p);
      expect([400, 404, 405], p).toContain(res.status);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("method tricks: GET/HEAD/POST/PUT/PATCH with override headers or query never delete", async () => {
    const before = await snapshot();
    const p = `/api/outputs/${BASE}.mp4`;
    const hdr = { "X-HTTP-Method-Override": "DELETE", "X-Method-Override": "DELETE", "X-HTTP-Method": "DELETE" };
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS"]) {
      const res = await send(`${p}?_method=DELETE&delete=1&download=1`, { method, headers: hdr });
      expect([200, 405], method).toContain(res.status);
      await res.arrayBuffer();
    }
    expect(await snapshot()).toEqual(before);
  });

  it("a valid delete removes exactly that clip, is idempotent, and touches nothing else", async () => {
    const before = await snapshot();
    const r1 = await del(`/api/outputs/${BASE}.mp4`);
    expect(r1.status).toBe(204);
    expect(r1.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(r1.headers.get("Cache-Control")).toBe("no-store");
    const after = await snapshot();
    const expected = { ...before };
    for (const e of ["mp4", "jpg", "json"]) delete expected[`${BASE}.${e}`];
    expect(after).toEqual(expected);
    expect((await del(`/api/outputs/${BASE}.json`)).status).toBe(204); // repeat, different extension
    expect(await snapshot()).toEqual(expected);
    // query string and fragment do not change which clip: the key is the path only
    expect((await del(`/api/outputs/${OTHER}.jpg?key=state/active.json#x`)).status).toBe(204);
    const final = await snapshot();
    expect(final["state/active.json"]).toBe(before["state/active.json"]);
    expect(final["state/usage/2026-10-29.json"]).toBe(before["state/usage/2026-10-29.json"]);
    expect(Object.keys(final).filter((k) => k.startsWith("outputs/2026-10-29/2026"))).toEqual([]);
  });

  it("deleting a clip that never existed is a 204 and creates nothing", async () => {
    const before = await snapshot();
    const res = await del("/api/outputs/outputs/2031-01-01/20310101T000000-nothing.mp4");
    expect(res.status).toBe(204);
    expect(await snapshot()).toEqual(before);
  });
});

describe("VALIDATOR delete: gating", () => {
  it("no JWT, garbage, none-alg, wrong email, expired: 403 with an empty body, nothing deleted", async () => {
    const before = await snapshot();
    const p = `/api/outputs/${BASE}.mp4`;
    const wrong = await mintJwt({ email: "mallory@example.test" });
    const expired = await mintJwt({ expSeconds: -3600 });
    for (const jwt of ["", "x.y.z", unsignedJwt(), wrong, expired]) {
      const res = await del(p, { jwt });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("CSRF: missing header, foreign or null Origin, cross-site metadata, odd content types: 403, nothing deleted", async () => {
    const before = await snapshot();
    const p = `/api/outputs/${BASE}.mp4`;
    const cases = [
      { noCsrf: true },
      { noCsrf: true, headers: { Origin: ORIGIN } },
      { noCsrf: true, headers: { "X-Jubividia": "1", Origin: "https://evil.test" } },
      { noCsrf: true, headers: { "X-Jubividia": "1", Origin: "null" } },
      { noCsrf: true, headers: { "X-Jubividia": "1", "Sec-Fetch-Site": "cross-site" } },
      { noCsrf: true, headers: { "X-Jubividia": "1", "Sec-Fetch-Site": "same-site" } },
      { noCsrf: true, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.test" } },
      { noCsrf: true, headers: { "Content-Type": "text/plain", Origin: "https://evil.test", "X-Jubividia": "1" } },
    ];
    for (const c of cases) {
      const res = await del(p, c);
      expect(res.status, JSON.stringify(c)).toBe(403);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
    expect(await snapshot()).toEqual(before);
    const pre = await send(p, { method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE", Origin: "https://evil.test" } });
    expect(pre.status).toBe(405);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("VALIDATOR delete: ordering, failure and races", () => {
  function failingBucket(failExt, times = Infinity) {
    let n = 0;
    return new Proxy(testEnv.BUCKET, {
      get(t, prop) {
        if (prop === "delete") {
          return async (k) => {
            if (k.endsWith("." + failExt) && n++ < times) throw new Error("R2 internal SECRET-DETAIL-xyz");
            return t.delete(k);
          };
        }
        const v = t[prop];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }

  it("fail each of the three deletes in turn: sidecar goes first, a retry finishes, no detail leaks", async () => {
    for (const ext of ["json", "mp4", "jpg"]) {
      await clearBucket();
      await seed();
      const env = makeEnv({ BUCKET: failingBucket(ext, 1) });
      const r = await del(`/api/outputs/${BASE}.mp4`, { env });
      expect(r.status, ext).toBe(500);
      const body = await r.text();
      expect(body).not.toContain("SECRET-DETAIL");
      expect(body).not.toContain("outputs/");
      const left = (await snapshot());
      const mine = ["json", "mp4", "jpg"].filter((e) => left[`${BASE}.${e}`]);
      console.log(`VALIDATOR: delete failing on .${ext} leaves`, JSON.stringify(mine));
      if (ext === "json") expect(mine).toEqual(["json", "mp4", "jpg"].filter((e) => true)); // nothing deleted yet
      // the sidecar is deleted first, so unless json itself failed the clip is already gone from the gallery
      const gal = await (await send("/api/outputs")).json();
      const listed = gal.items.map((i) => i.meta_key).includes(`${BASE}.json`);
      expect(listed).toBe(ext === "json");
      // retry (no failure now) cleans the rest
      expect((await del(`/api/outputs/${BASE}.jpg`)).status).toBe(204);
      const after = await snapshot();
      expect(["json", "mp4", "jpg"].filter((e) => after[`${BASE}.${e}`])).toEqual([]);
      expect(after[`${OTHER}.mp4`]).toBeTruthy();
    }
  });

  it("two concurrent deletes of the same clip, and a delete racing the gallery list", async () => {
    const [a, b] = await Promise.all([del(`/api/outputs/${BASE}.mp4`), del(`/api/outputs/${BASE}.json`)]);
    expect([a.status, b.status]).toEqual([204, 204]);
    await seed();
    const [d, g1, g2] = await Promise.all([del(`/api/outputs/${BASE}.mp4`), send("/api/outputs"), send("/api/outputs")]);
    expect(d.status).toBe(204);
    expect(g1.status).toBe(200);
    expect(g2.status).toBe(200);
    await g1.json();
    await g2.json();
  });

  it("a delete racing a ranged stream of the same mp4", async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(7);
    await putObject(`${BASE}.mp4`, big, "video/mp4");
    const res = await send(`/api/outputs/${BASE}.mp4`);
    const reader = res.body.getReader();
    await reader.read();
    expect((await del(`/api/outputs/${BASE}.mp4`)).status).toBe(204);
    let got = 0;
    let errored = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
      }
    } catch {
      errored = true;
    }
    console.log("VALIDATOR: stream open during delete -> completed bytes", got, "errored", errored);
    expect((await send(`/api/outputs/${BASE}.mp4`)).status).toBe(404);
  });

  it("a delete issued while the job is still running (only some files exist), then the handler finishes", async () => {
    await clearBucket();
    await seed();
    // handler order: mp4, jpg, then sidecar last
    const k = "outputs/2026-10-29/20261029T020202-running";
    await putObject(`${k}.mp4`, "mp4");
    await putObject(`${k}.jpg`, "jpg");
    expect((await del(`/api/outputs/${k}.mp4`)).status).toBe(204);
    await putObject(`${k}.json`, '{"prompt":"late","mode":"t2v"}'); // sidecar arrives after the delete
    const gal = await (await send("/api/outputs")).json();
    const dangling = gal.items.find((i) => i.meta_key === `${k}.json`);
    console.log("VALIDATOR: sidecar written after a delete lists a clip whose mp4/jpg are gone ->", !!dangling);
    const head = await bucket().head(`${k}.mp4`);
    expect(head).toBeNull();
    // all three written after the delete: the clip simply reappears (nothing orphaned)
    const k2 = "outputs/2026-10-29/20261029T030303-running2";
    expect((await del(`/api/outputs/${k2}.mp4`)).status).toBe(204);
    for (const e of ["mp4", "jpg", "json"]) await putObject(`${k2}.${e}`, e === "json" ? "{}" : "x");
    const gal2 = await (await send("/api/outputs")).json();
    expect(gal2.items.some((i) => i.meta_key === `${k2}.json`)).toBe(true);
    // an mp4/jpg with no sidecar is invisible to the gallery and never cleaned (no lifecycle on outputs/)
    await putObject("outputs/2026-10-29/20261029T040404-orphan.mp4", "x");
    const gal3 = await (await send("/api/outputs")).json();
    expect(gal3.items.some((i) => i.id === "20261029T040404-orphan")).toBe(false);
  });

  it("cannot touch the reservation or the daily counter", async () => {
    const g = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x" } });
    expect(g.status).toBe(202);
    const act0 = await (await bucket().get("state/active.json")).text();
    const use0 = await (await bucket().get(`state/usage/${new Date().toISOString().slice(0, 10)}.json`)).text();
    for (const k of [`${BASE}.mp4`, "state/active.json", `state/usage/${new Date().toISOString().slice(0, 10)}.json`, "state/last.json"]) {
      await del(`/api/outputs/${k}`);
    }
    expect(await (await bucket().get("state/active.json")).text()).toBe(act0);
    expect(await (await bucket().get(`state/usage/${new Date().toISOString().slice(0, 10)}.json`)).text()).toBe(use0);
    expect(runpod.calls.filter((c) => c.path === "/run").length).toBe(1);
  });
});

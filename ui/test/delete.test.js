import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, makeEnv, clearBucket, putObject, bucket, mintJwt } from "./helpers.js";
import { parseDeleteKey } from "../src/outputs.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

const STEM = "outputs/2026-10-29/20261029T101010-job_abc-1";
const del = (key, opts = {}) => send(`/api/outputs/${key}`, { method: "DELETE", ...opts });
const exists = async (k) => (await bucket().head(k)) !== null;

async function clip(stem = STEM, prompt = "hello") {
  await putObject(stem + ".mp4", new Uint8Array(100), "video/mp4");
  await putObject(stem + ".jpg", new Uint8Array(50), "image/jpeg");
  await putObject(stem + ".json", JSON.stringify({ prompt, mode: "t2v" }), "application/json");
}
const listed = async () => (await (await send("/api/outputs")).json()).items.map((i) => i.id);

describe("DELETE /api/outputs/<key>", () => {
  it("removes all three objects and the clip leaves the gallery, whichever of the three keys is named", async () => {
    for (const ext of ["json", "mp4", "jpg"]) {
      await clearBucket();
      await clip();
      expect(await listed()).toEqual(["20261029T101010-job_abc-1"]);
      const res = await del(`${STEM}.${ext}`);
      expect(res.status, ext).toBe(204);
      expect(await res.text()).toBe("");
      for (const e of ["json", "mp4", "jpg"]) expect(await exists(`${STEM}.${e}`), `${ext} ${e}`).toBe(false);
      expect(await listed()).toEqual([]);
    }
  });

  it("only touches that clip: neighbours, inputs/ and state/ survive", async () => {
    await clip();
    await clip("outputs/2026-10-29/20261029T101011-other", "keep");
    await putObject("inputs/11111111-2222-4333-8444-555555555555.jpg", new Uint8Array(3));
    await putObject("state/active.json", "{}");
    expect((await del(`${STEM}.mp4`)).status).toBe(204);
    expect(await exists("outputs/2026-10-29/20261029T101011-other.json")).toBe(true);
    expect(await exists("outputs/2026-10-29/20261029T101011-other.mp4")).toBe(true);
    expect(await exists("inputs/11111111-2222-4333-8444-555555555555.jpg")).toBe(true);
    expect(await exists("state/active.json")).toBe(true);
  });

  it("is idempotent: deleting an already deleted (or never existing) clip is a 204", async () => {
    await clip();
    expect((await del(`${STEM}.json`)).status).toBe(204);
    expect((await del(`${STEM}.json`)).status).toBe(204);
    expect((await del("outputs/2026-10-29/20261029T111111-never")).status).toBe(400); // no extension
    expect((await del("outputs/2026-10-29/20261029T111111-never.mp4")).status).toBe(204);
  });

  it("an orphan mp4 without sidecar can still be deleted", async () => {
    await putObject(STEM + ".mp4", new Uint8Array(10));
    expect((await del(`${STEM}.mp4`)).status).toBe(204);
    expect(await exists(STEM + ".mp4")).toBe(false);
  });

  it("deletes the sidecar FIRST: when the mp4 delete fails the clip is already gone from the gallery and a retry finishes", async () => {
    await clip();
    const real = bucket();
    const order = [];
    let failMp4 = true;
    const BUCKET = {
      delete: async (k) => {
        order.push(k.split(".").pop());
        if (failMp4 && k.endsWith(".mp4")) throw new Error("boom");
        return real.delete(k);
      },
      get: (...a) => real.get(...a),
      head: (...a) => real.head(...a),
      list: (...a) => real.list(...a),
    };
    const env = makeEnv({ BUCKET });
    const res = await del(`${STEM}.json`, { env });
    expect(res.status).toBe(500);
    const j = await res.json();
    expect(j.error).toBe("delete_incomplete");
    expect(j.retryable).toBe(true);
    expect(order).toEqual(["json", "mp4"]);
    expect(await exists(`${STEM}.json`)).toBe(false);
    expect(await listed()).toEqual([]); // gone from the gallery already
    expect(await exists(`${STEM}.mp4`)).toBe(true);
    failMp4 = false;
    expect((await del(`${STEM}.json`, { env })).status).toBe(204);
    expect(await exists(`${STEM}.mp4`)).toBe(false);
    expect(await exists(`${STEM}.jpg`)).toBe(false);
  });

  it("a failing sidecar delete is a retryable 500 and the other objects are not touched", async () => {
    await clip();
    const real = bucket();
    const BUCKET = {
      delete: async (k) => {
        if (k.endsWith(".json")) throw new Error("boom");
        return real.delete(k);
      },
      get: (...a) => real.get(...a), head: (...a) => real.head(...a), list: (...a) => real.list(...a),
    };
    const res = await del(`${STEM}.mp4`, { env: makeEnv({ BUCKET }) });
    expect(res.status).toBe(500);
    expect(await exists(`${STEM}.mp4`)).toBe(true);
  });

  it("paginates the gallery correctly after deletes", async () => {
    for (let i = 0; i < 5; i++) await clip(`outputs/2026-10-29/20261029T10000${i}-j${i}`, `p${i}`);
    expect((await del("outputs/2026-10-29/20261029T100004-j4.mp4")).status).toBe(204);
    expect((await del("outputs/2026-10-29/20261029T100001-j1.json")).status).toBe(204);
    const p1 = await (await send("/api/outputs?limit=2")).json();
    expect(p1.items.map((i) => i.meta.prompt)).toEqual(["p3", "p2"]);
    const p2 = await (await send(`/api/outputs?limit=2&before=${p1.next_before}`)).json();
    expect(p2.items.map((i) => i.meta.prompt)).toEqual(["p0"]);
    expect(p2.next_before).toBeNull();
  });

  it("serving a deleted clip is a 404", async () => {
    await clip();
    await del(`${STEM}.mp4`);
    expect((await send(`/api/outputs/${STEM}.mp4`)).status).toBe(404);
  });
});

describe("invalid keys are 400 and delete nothing", () => {
  const long = "a".repeat(81);
  const cases = [
    "inputs/11111111-2222-4333-8444-555555555555.jpg",
    "state/active.json",
    "state/usage/2026-10-29.json",
    "other/2026-10-29/20261029T101010-a.mp4",
    "outputs/../state/active.json",
    "outputs/2026-10-29/../../state/active.json",
    "outputs/2026-10-29/20261029T101010-..mp4",
    "outputs//2026-10-29/20261029T101010-a.mp4",
    "outputs/2026-10-29//20261029T101010-a.mp4",
    "outputs/2026-10-29/20261029T101010-a.txt",
    "outputs/2026-10-29/20261029T101010-a.mp4.bak",
    "outputs/2026-10-29/20261029T101010-a.png",
    "outputs/2026-13-29/20261329T101010-a.mp4",
    "outputs/2026-10-32/20261032T101010-a.mp4",
    "outputs/2026-10-29/20261029T251010-a.mp4",
    "outputs/2026-10-29/20261029T106010-a.mp4",
    "outputs/2026-10-29/20261028T101010-a.mp4", // timestamp date differs from the folder
    "outputs/2026-10-29/20261029T10101-a.mp4",
    "outputs/2026-10-29/x.mp4",
    `outputs/2026-10-29/20261029T101010-${long}.mp4`,
    "outputs/2026-10-29/20261029T101010-a b.mp4",
    "outputs/2026-10-29/20261029T101010-a.b.mp4",
    "outputs/2026-10-29/20261029T101010-.mp4",
    "outputs/2026-10-29/20261029T101010-a.mp4/",
    "outputs/2026-10-29/20261029T101010-a.mp4/x",
    "outputs/",
    "outputs",
    "",
    "jubividia-ltx-eu/outputs/2026-10-29/20261029T101010-a.mp4",
    "r2/outputs/2026-10-29/20261029T101010-a.mp4",
    "%2e%2e/state/active.json",
    "outputs%2f2026-10-29%2f20261029T101010-a.mp4",
    "outputs/2026-10-29/20261029T101010-a%2e.mp4",
    "outputs/2026-10-29/20261029T101010-a%00.mp4",
  ];

  it.each(cases)("%s", async (key) => {
    await clip(STEM, "survivor");
    await putObject("state/active.json", "{}");
    await putObject("inputs/11111111-2222-4333-8444-555555555555.jpg", new Uint8Array(3));
    const res = await del(key);
    if (key.startsWith("%2e%2e/")) {
      // the URL parser itself resolves this to /api/state/..., which no route serves: 404, nothing deleted
      expect([400, 404]).toContain(res.status);
    } else {
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("bad_key");
    }
    for (const k of [`${STEM}.json`, `${STEM}.mp4`, `${STEM}.jpg`, "state/active.json", "inputs/11111111-2222-4333-8444-555555555555.jpg"]) {
      expect(await exists(k), k).toBe(true);
    }
  });

  it("the key parser agrees", () => {
    expect(parseDeleteKey(`${STEM}.mp4`)).toBe(STEM);
    expect(parseDeleteKey(`${STEM}.json`)).toBe(STEM);
    for (const c of cases) expect(parseDeleteKey(c), c).toBeNull();
  });
});

describe("access control for DELETE", () => {
  beforeEach(() => clip());

  it("rejects missing, malformed, forged and wrong-email tokens (nothing deleted)", async () => {
    for (const jwt of ["", "not.a.jwt", await mintJwt({ signer: "other" }), await mintJwt({ email: "mallory@example.test" })]) {
      const res = await del(`${STEM}.json`, { jwt });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("");
    }
    expect(await exists(`${STEM}.json`)).toBe(true);
  });

  it("needs the X-Jubividia header and a same-origin Origin", async () => {
    expect((await del(`${STEM}.json`, { noCsrf: true })).status).toBe(403);
    expect((await del(`${STEM}.json`, { noCsrf: true, headers: { "X-Jubividia": "1", Origin: "https://evil.example" } })).status).toBe(403);
    expect((await del(`${STEM}.json`, { noCsrf: true, headers: { Origin: ORIGIN_OK } })).status).toBe(403);
    expect((await del(`${STEM}.json`, { noCsrf: true, headers: { "X-Jubividia": "1", "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(await exists(`${STEM}.json`)).toBe(true);
  });

  it("fails closed without configuration, sends no CORS headers, and the second allowed user may delete (shared gallery)", async () => {
    expect((await del(`${STEM}.json`, { env: makeEnv({ POLICY_AUD: "" }) })).status).toBe(503);
    expect(await exists(`${STEM}.json`)).toBe(true);
    const res = await del(`${STEM}.json`, { jwt: await mintJwt({ email: "partner@example.test" }) });
    expect(res.status).toBe(204);
    expect([...res.headers.keys()].some((k) => k.startsWith("access-control-"))).toBe(false);
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("OPTIONS is refused and other methods still 405", async () => {
    expect((await send(`/api/outputs/${STEM}.json`, { method: "OPTIONS" })).status).toBe(405);
    expect((await send(`/api/outputs/${STEM}.json`, { method: "PUT", body: "x" })).status).toBe(405);
    expect(await exists(`${STEM}.json`)).toBe(true);
  });

  it("logs nothing sensitive", async () => {
    const logs = [];
    for (const m of ["log", "warn", "error", "info", "debug"]) vi.spyOn(console, m).mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    await del(`${STEM}.json`);
    expect(logs.join("\n")).not.toMatch(/example\.test|job_abc|outputs\//);
  });
});

const ORIGIN_OK = "https://jubividia.example.test";

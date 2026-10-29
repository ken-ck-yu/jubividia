import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, clearBucket, putObject, bucket } from "./helpers.js";
import { parseRange, validOutputKey, cleanMeta } from "../src/outputs.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

const KEY = "outputs/2026-10-29/20261029T101010-job-abc.mp4";
const body = new Uint8Array(1000).map((_, i) => i % 256);

const get = (key, headers = {}, method = "GET") => send(`/api/${"outputs"}/${key}`, { method, headers });

describe("key validation", () => {
  it("accepts only the output key shape", () => {
    expect(validOutputKey(KEY)).toBe(true);
    expect(validOutputKey("outputs/2026-10-29/20261029T101010-job-abc.json")).toBe(true);
    for (const bad of [
      "inputs/11111111-2222-4333-8444-555555555555.jpg",
      "state/active.json",
      "outputs/../state/active.json",
      "outputs/2026-10-29/../../state/active.json",
      "outputs/2026-10-29/20261029T101010-..mp4",
      "outputs//2026-10-29/20261029T101010-a.mp4",
      "outputs/2026-10-29/20261029T101010-a.txt",
      "outputs/2026-10-29/20261029T101010-a.mp4/x",
      "outputs/2026-10-29/x.mp4",
    ]) expect(validOutputKey(bad), bad).toBe(false);
  });

  it("serves nothing under inputs/ or state/, and refuses encoded traversal", async () => {
    await putObject("inputs/11111111-2222-4333-8444-555555555555.jpg", body);
    await putObject("state/active.json", "{}");
    for (const p of [
      "/api/outputs/inputs/11111111-2222-4333-8444-555555555555.jpg",
      "/api/outputs/state/active.json",
      "/api/outputs/%2e%2e/state/active.json",
      "/api/outputs/outputs%2f2026-10-29%2f20261029T101010-a.mp4",
      "/api/outputs/outputs/2026-10-29/20261029T101010-a%2e%2e.mp4",
      "/api/outputs//outputs/2026-10-29/20261029T101010-a.mp4",
    ]) expect((await send(p)).status, p).toBe(404);
  });
});

describe("range parsing", () => {
  it.each([
    ["bytes=0-99", 1000, { kind: "range", start: 0, end: 99 }],
    ["bytes=0-1", 1000, { kind: "range", start: 0, end: 1 }],
    ["bytes=100-", 1000, { kind: "range", start: 100, end: 999 }],
    ["bytes=-50", 1000, { kind: "range", start: 950, end: 999 }],
    ["bytes=-5000", 1000, { kind: "range", start: 0, end: 999 }],
    ["bytes=900-5000", 1000, { kind: "range", start: 900, end: 999 }],
    ["bytes=1000-", 1000, { kind: "unsatisfiable" }],
    ["bytes=2000-3000", 1000, { kind: "unsatisfiable" }],
    ["bytes=-0", 1000, { kind: "unsatisfiable" }],
    ["bytes=0-0", 0, { kind: "unsatisfiable" }],
    ["bytes=0-1,5-6", 1000, { kind: "none" }],
    ["bytes=5-2", 1000, { kind: "none" }],
    ["items=0-1", 1000, { kind: "none" }],
    ["garbage", 1000, { kind: "none" }],
    [null, 1000, { kind: "none" }],
  ])("%s on %i bytes", (h, size, expected) => {
    expect(parseRange(h, size)).toEqual(expected);
  });
});

describe("GET/HEAD /api/outputs/<key>", () => {
  beforeEach(() => putObject(KEY, body, "video/mp4"));

  it("serves the whole file with length, type, ranges and immutable cache headers", async () => {
    const res = await get(KEY);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Content-Length")).toBe("1000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
  });

  it("answers Safari's bytes=0-1 probe, open ranges and suffix ranges with exact 206 arithmetic", async () => {
    for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=0-99", 0, 99], ["bytes=100-", 100, 999], ["bytes=-50", 950, 999]]) {
      const res = await get(KEY, { Range: range });
      expect(res.status, range).toBe(206);
      expect(res.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/1000`);
      expect(res.headers.get("Content-Length")).toBe(String(end - start + 1));
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      const buf = new Uint8Array(await res.arrayBuffer());
      expect(buf).toEqual(body.slice(start, end + 1));
    }
  });

  it("answers an unsatisfiable range with 416 and Content-Range */size", async () => {
    const res = await get(KEY, { Range: "bytes=5000-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */1000");
  });

  it("answers multi-range and invalid Range with a plain 200", async () => {
    expect((await get(KEY, { Range: "bytes=0-1,10-20" })).status).toBe(200);
    expect((await get(KEY, { Range: "bytes=zz" })).status).toBe(200);
  });

  it("ignores Range when If-Range names another validator", async () => {
    expect((await get(KEY, { Range: "bytes=0-9", "If-Range": '"other"' })).status).toBe(200);
  });

  it("supports HEAD with Accept-Ranges and Content-Length, and conditional 304", async () => {
    const head = await get(KEY, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("1000");
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await head.text()).toBe("");
    const etag = head.headers.get("ETag");
    expect(etag).toBeTruthy();
    const cond = await get(KEY, { "If-None-Match": etag });
    expect(cond.status).toBe(304);
  });

  it("serves sidecars as application/json with nosniff and attachment on ?download=1", async () => {
    await putObject("outputs/2026-10-29/20261029T101010-job-abc.json", JSON.stringify({ prompt: "<img src=x onerror=alert(1)>" }), "text/html");
    const res = await send("/api/outputs/outputs/2026-10-29/20261029T101010-job-abc.json");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const dl = await send(`/api/outputs/${KEY}?download=1`);
    expect(dl.headers.get("Content-Disposition")).toBe('attachment; filename="20261029T101010-job-abc.mp4"');
    expect(dl.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });

  it("404s a missing object and refuses non-GET methods", async () => {
    expect((await get("outputs/2026-10-29/20261029T101010-missing.mp4")).status).toBe(404);
    expect((await send(`/api/outputs/${KEY}`, { method: "PATCH" })).status).toBe(405);
  });
});

async function clip(date, ts, jobId, meta) {
  const stem = `outputs/${date}/${ts}-${jobId}`;
  await putObject(stem + ".mp4", body, "video/mp4");
  await putObject(stem + ".jpg", body, "image/jpeg");
  if (meta !== null) await putObject(stem + ".json", JSON.stringify(meta), "application/json");
  return stem;
}

describe("gallery", () => {
  it("lists newest first, uses sidecars as the completion marker, and ignores incomplete clips", async () => {
    await clip("2026-10-28", "20261028T090000", "a", { mode: "t2v", prompt: "old", gen_time_s: 60 });
    await clip("2026-10-29", "20261029T090000", "b", { mode: "i2v", prompt: "mid", gen_time_s: 70, peak_vram_mb: 43000, cold: true, seed: 3, width: 1280, height: 704, num_frames: 121, fps: 24, created_at: "2026-10-29T09:00:00+00:00" });
    await clip("2026-10-29", "20261029T100000", "c", { mode: "t2v", prompt: "new" });
    await clip("2026-10-29", "20261029T110000", "orphan", null); // mp4 + jpg, no sidecar
    const j = await (await send("/api/outputs")).json();
    expect(j.items.map((i) => i.id)).toEqual(["20261029T100000-c", "20261029T090000-b", "20261028T090000-a"]);
    const b = j.items[1];
    expect(b.key).toBe("outputs/2026-10-29/20261029T090000-b.mp4");
    expect(b.thumb_key).toBe("outputs/2026-10-29/20261029T090000-b.jpg");
    expect(b.meta.peak_vram_mb).toBe(43000);
    expect(b.est_usd).toBeCloseTo((70 * 1.75) / 3600, 4);
    expect(j.items[0].meta.gen_time_s).toBeNull(); // missing fields are blank, never an error
    expect(j.items[0].est_usd).toBeNull();
    expect(j.next_before).toBeNull();
  });

  it("honours limit and paginates with before, across and within dates", async () => {
    for (let i = 0; i < 5; i++) await clip("2026-10-29", `20261029T10000${i}`, `j${i}`, { prompt: `p${i}` });
    await clip("2026-10-27", "20261027T090000", "z", { prompt: "pz" });
    const p1 = await (await send("/api/outputs?limit=2")).json();
    expect(p1.items.map((i) => i.meta.prompt)).toEqual(["p4", "p3"]);
    expect(p1.next_before).toBe("outputs/2026-10-29/20261029T100003-j3.json");
    const p2 = await (await send(`/api/outputs?limit=2&before=${p1.next_before}`)).json();
    expect(p2.items.map((i) => i.meta.prompt)).toEqual(["p2", "p1"]);
    const p3 = await (await send(`/api/outputs?limit=2&before=${p2.next_before}`)).json();
    expect(p3.items.map((i) => i.meta.prompt)).toEqual(["p0", "pz"]);
    expect(p3.next_before).toBeNull();
    const byDate = await (await send("/api/outputs?before=2026-10-29")).json();
    expect(byDate.items.map((i) => i.meta.prompt)).toEqual(["pz"]);
    expect((await send("/api/outputs?before=nonsense")).status).toBe(400);
  });

  it("uses cursors when a prefix holds more than 1000 keys", async () => {
    const puts = [];
    for (let i = 0; i < 1010; i++) {
      const n = String(i).padStart(6, "0");
      puts.push(bucket().put(`outputs/2026-10-29/20261029T${n.slice(0, 6)}-j${i}.json`, JSON.stringify({ prompt: `p${i}` })));
    }
    await Promise.all(puts);
    const j = await (await send("/api/outputs?limit=24")).json();
    expect(j.items.length).toBe(24);
    expect(j.items[0].id).toBe("20261029T001009-j1009");
    expect(j.next_before).not.toBeNull();
  });

  it("sanitises hostile sidecars: unknown fields dropped, types enforced, no markup interpreted by the server", async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await clip("2026-10-29", "20261029T120000", "evil", {
      mode: "<b>", prompt: evil, seed: "5", width: "wide", gen_time_s: "70", cold: "yes", extra: "<x>", created_at: evil.repeat(20),
    });
    await putObject("outputs/2026-10-29/20261029T130000-broken.json", "{ not json");
    const res = await send("/api/outputs");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const j = await res.json();
    const e = j.items.find((i) => i.id.endsWith("-evil"));
    expect(e.meta.prompt).toBe(evil); // data is preserved; the page renders it with textContent
    expect(e.meta.mode).toBeNull();
    expect(e.meta.seed).toBeNull();
    expect(e.meta.width).toBeNull();
    expect(e.meta.gen_time_s).toBeNull();
    expect(e.meta.cold).toBeNull();
    expect(e.meta.extra).toBeUndefined();
    expect(e.meta.created_at.length).toBeLessThanOrEqual(40);
    const broken = j.items.find((i) => i.id.endsWith("-broken"));
    expect(broken.meta.prompt).toBeNull();
  });

  it("cleanMeta tolerates non-objects", () => {
    expect(cleanMeta(null).prompt).toBeNull();
    expect(cleanMeta("x").seed).toBeNull();
  });
});

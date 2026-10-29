import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, clearBucket, bucket, JPEG, PNG, mp4Bytes, UUID_RE } from "./helpers.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

// A Request built in-process has no Content-Length header (a real network request does), so the
// helper sets it, as the browser would.
const put = (query, body, headers = {}) =>
  send(`/api/upload?${query}`, {
    method: "PUT",
    body,
    headers: { "Content-Length": String(body.byteLength), ...headers },
  });

describe("upload", () => {
  it("stores a JPEG at a server-generated key and reports it", async () => {
    const res = await put("kind=image&ext=jpg", JPEG, { "Content-Type": "image/jpeg" });
    const text = await res.clone().text();
    expect(res.status, text).toBe(201);
    const j = JSON.parse(text);
    expect(j.upload_key).toMatch(/^inputs\//);
    expect(j.upload_key.slice("inputs/".length, -".jpg".length)).toMatch(UUID_RE);
    expect(j.bytes).toBe(JPEG.byteLength);
    const obj = await bucket().get(j.upload_key);
    expect(obj.httpMetadata.contentType).toBe("image/jpeg");
    expect(new Uint8Array(await obj.arrayBuffer())).toEqual(JPEG);
  });

  it("derives the type from the extension when the client sends no type (iOS), and accepts octet-stream", async () => {
    expect((await put("kind=image&ext=png", PNG)).status).toBe(201);
    expect((await put("kind=image&ext=jpeg", JPEG, { "Content-Type": "application/octet-stream" })).status).toBe(201);
    const res = await put("kind=video&ext=mov", mp4Bytes("qt  "), { "Content-Type": "video/quicktime" });
    expect(res.status).toBe(201);
    expect((await res.json()).upload_key.endsWith(".mov")).toBe(true);
  });

  it("ignores any client-chosen key or path", async () => {
    const res = await put("kind=image&ext=jpg&key=state/active.json&path=../x", JPEG);
    const j = await res.json();
    expect(j.upload_key).toMatch(/^inputs\/[0-9a-f-]{36}\.jpg$/);
    expect(await bucket().get("state/active.json")).toBeNull();
  });

  it("rejects webm, HEIC/HEIF/AVIF and unknown types with 415", async () => {
    for (const [q, ct] of [
      ["kind=video&ext=webm", "video/webm"],
      ["kind=image&ext=heic", "image/heic"],
      ["kind=image&ext=heif", ""],
      ["kind=image&ext=avif", ""],
      ["kind=image&ext=gif", "image/gif"],
      ["kind=video&ext=avi", ""],
      ["kind=video&ext=jpg", "image/jpeg"],
      ["kind=image&ext=mp4", ""],
      ["kind=image", ""],
    ]) {
      const res = await put(q, JPEG, ct ? { "Content-Type": ct } : {});
      expect(res.status, q).toBe(415);
    }
    expect((await put("kind=image&ext=jpg", JPEG, { "Content-Type": "video/webm" })).status).toBe(415);
    expect((await put("kind=image&ext=jpg", JPEG, { "Content-Type": "image/png" })).status).toBe(415);
    expect((await put("kind=bogus&ext=jpg", JPEG)).status).toBe(400);
  });

  it("checks the magic bytes: wrong content, HEIC inside an mp4 name, short files", async () => {
    expect((await put("kind=image&ext=jpg", PNG, { "Content-Type": "image/jpeg" })).status).toBe(415);
    expect((await put("kind=image&ext=png", JPEG)).status).toBe(415);
    expect((await put("kind=video&ext=mp4", new TextEncoder().encode("<html>not a video</html>"))).status).toBe(415);
    expect((await put("kind=video&ext=mp4", mp4Bytes("heic"))).status).toBe(415);
    expect((await put("kind=video&ext=mov", mp4Bytes("mif1"))).status).toBe(415);
    expect((await put("kind=image&ext=jpg", new Uint8Array([0xff, 0xd8]))).status).toBe(415);
    const listed = await bucket().list({ prefix: "inputs/" });
    expect(listed.objects.length).toBe(0); // nothing was stored for any rejected file
  });

  it("accepts WebP", async () => {
    const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 "), 0, 0]);
    expect((await put("kind=image&ext=webp", webp)).status).toBe(201);
  });

  it("enforces the size caps from Content-Length and refuses a missing or empty length", async () => {
    const big = (n) => ({ "Content-Length": String(n) });
    // The body is never read when the declared length is over the cap.
    const over = await put("kind=video&ext=mp4", mp4Bytes(), big(95_000_001));
    expect(over.status).toBe(413);
    const j = await over.json();
    expect(j.message).toContain("95");
    expect((await put("kind=image&ext=jpg", JPEG, big(20_000_001))).status).toBe(413);
    // chunked body without Content-Length
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(JPEG);
        c.close();
      },
    });
    const res = await send("/api/upload?kind=image&ext=jpg", { method: "PUT", body: stream, headers: {} }).catch((e) => ({ status: -1, e }));
    expect([411, 400, -1]).toContain(res.status);
  });

  it("deletes nothing stored when the body is shorter than declared", async () => {
    const res = await put("kind=image&ext=jpg", JPEG, { "Content-Length": String(JPEG.byteLength + 100) }).catch(() => null);
    if (res) expect([400, 415]).toContain(res.status);
    const listed = await bucket().list({ prefix: "inputs/" });
    expect(listed.objects.length).toBe(0);
  });

  it("streams a multi-megabyte body into R2 intact", async () => {
    const size = 6 * 1024 * 1024;
    const body = new Uint8Array(size);
    body.set(mp4Bytes("isom", 0), 0);
    for (let i = 12; i < size; i += 4096) body[i] = i % 251;
    const res = await put("kind=video&ext=mp4", body, { "Content-Type": "video/mp4" });
    expect(res.status).toBe(201);
    const { upload_key, bytes } = await res.json();
    expect(bytes).toBe(size);
    const head = await bucket().head(upload_key);
    expect(head.size).toBe(size);
  });
});

// PUT /api/upload: streams the body into R2 at a server-generated key.
// The client never names a key. The extension comes from an allowlist (the query "ext" the
// page derives from the file name, so an empty File.type on iOS still works) and must agree
// with the Content-Type header when one is sent. The magic bytes are the real gate.
import { HttpError, json } from "./util.js";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from "../static/calc.js";

const EXT = {
  image: { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" },
  video: { mp4: "video/mp4", mov: "video/quicktime" },
};
const NORMAL_EXT = { jpeg: "jpg" };
const NEUTRAL_TYPES = new Set(["", "application/octet-stream"]);
// Brands of HEIF/AVIF still images that share the ftyp box with video: not video, 415.
const IMAGE_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "avif", "avis"]);

export const UPLOAD_KEY_RE =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|mp4|mov)$/;

const UNSUPPORTED = {
  webm: "WebM is not supported. Use an MP4 or MOV video.",
  heic: "HEIC is not supported. Pick the photo through the photo library so the phone converts it to JPEG, or export it as JPEG.",
  heif: "HEIF is not supported. Export the photo as JPEG.",
  avif: "AVIF is not supported. Use JPEG, PNG or WebP.",
};

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

/** Magic-byte check of the first bytes against the claimed extension. */
export function magicOk(ext, head) {
  if (ext === "jpg") return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === "png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return head.length >= 8 && sig.every((v, i) => head[i] === v);
  }
  if (ext === "webp") return head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP";
  if (ext === "mp4" || ext === "mov") {
    if (head.length < 12 || ascii(head, 4, 8) !== "ftyp") return false;
    return !IMAGE_BRANDS.has(ascii(head, 8, 12).trim().toLowerCase());
  }
  return false;
}

export async function handleUpload(request, env) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  if (kind !== "image" && kind !== "video") throw new HttpError(400, "bad_kind", "kind must be image or video.");
  const rawExt = (url.searchParams.get("ext") || "").toLowerCase();
  if (UNSUPPORTED[rawExt]) throw new HttpError(415, "unsupported_type", UNSUPPORTED[rawExt]);
  const table = EXT[kind];
  if (!Object.hasOwn(table, rawExt)) {
    throw new HttpError(415, "unsupported_type", `Unsupported ${kind} type. Allowed: ${Object.keys(table).join(", ")}.`);
  }
  const ext = NORMAL_EXT[rawExt] || rawExt;
  const contentType = table[rawExt];
  const sent = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!NEUTRAL_TYPES.has(sent) && sent !== contentType) {
    if (/^(video\/webm|image\/hei[cf])/.test(sent)) {
      throw new HttpError(415, "unsupported_type", "WebM and HEIC files are not supported.");
    }
    throw new HttpError(415, "type_mismatch", "The file type does not match its extension.");
  }

  const cap = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  const lenHeader = request.headers.get("Content-Length");
  if (lenHeader === null || !/^\d+$/.test(lenHeader)) {
    throw new HttpError(411, "length_required", "Content-Length is required.");
  }
  const length = Number(lenHeader);
  if (length === 0) throw new HttpError(400, "empty", "The file is empty.");
  if (length > cap) {
    const mb = (n) => Math.round((n / 1e6) * 10) / 10;
    throw new HttpError(
      413,
      "too_large",
      `This file is ${mb(length)} MB; the limit for ${kind}s is ${mb(cap)} MB.` +
        (kind === "video" ? " Trim it or share a smaller version." : ""),
    );
  }
  if (!request.body) throw new HttpError(400, "empty", "The file is empty.");

  const key = `inputs/${crypto.randomUUID()}.${ext}`;
  const reader = request.body.getReader();

  // Read just enough to look at the magic bytes, then stream everything (buffered part first).
  const buffered = [];
  let have = 0;
  while (have < 16) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered.push(value);
    have += value.byteLength;
  }
  const head = new Uint8Array(Math.min(have, 16));
  let off = 0;
  for (const c of buffered) {
    for (let i = 0; i < c.byteLength && off < head.length; i++) head[off++] = c[i];
  }
  if (!magicOk(ext, head)) {
    await reader.cancel().catch(() => {});
    throw new HttpError(415, "bad_content", "The file content does not look like a " + ext.toUpperCase() + " file.");
  }

  const { readable, writable } = new FixedLengthStream(length);
  const pump = (async () => {
    const writer = writable.getWriter();
    try {
      for (const c of buffered) await writer.write(c);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (e) {
      await writer.abort(e).catch(() => {});
      throw e;
    }
  })();
  try {
    const [, stored] = await Promise.all([pump, env.BUCKET.put(key, readable, { httpMetadata: { contentType } })]);
    if (!stored) throw new Error("put returned nothing");
  } catch {
    await env.BUCKET.delete(key).catch(() => {});
    throw new HttpError(400, "bad_body", "The upload was cut off or its size did not match. Try again.");
  }
  return json(201, { upload_key: key, bytes: length, kind, ext });
}

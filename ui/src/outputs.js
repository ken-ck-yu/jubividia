// GET /api/outputs (gallery) and GET|HEAD /api/outputs/<key> (streaming with Range).
//
// Invariant (docs/decisions/ui.md, worker contract): the handler uploads the .mp4 and .jpg
// first and the .json sidecar LAST, and deletes the earlier files if the sidecar fails. A
// listed sidecar therefore means a complete clip, and the gallery lists sidecars only.
// Changing that order in worker/handler.py breaks the gallery.
import { HttpError, json } from "./util.js";
import { costUsd } from "../static/calc.js";

export const OUTPUT_KEY_RE = /^outputs\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}-[A-Za-z0-9._-]+\.(mp4|jpg|json)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIDECAR_RE = /^outputs\/\d{4}-\d{2}-\d{2}\/\d{8}T\d{6}-[A-Za-z0-9._-]+\.json$/;
const TYPES = { mp4: "video/mp4", jpg: "image/jpeg", json: "application/json" };
const IMMUTABLE = "private, max-age=31536000, immutable";
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

export function validOutputKey(key) {
  return typeof key === "string" && key.length <= 300 && OUTPUT_KEY_RE.test(key) && !key.includes("..");
}

// ------------------------------------------------------------------ delete

// Stricter than the read pattern: real calendar-looking date and time, a timestamp that matches the
// folder date, and a job id limited to what the handler produces (safe_id: [A-Za-z0-9_-], max 80).
const DELETE_KEY_RE =
  /^outputs\/(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\/(\d{8})T(?:[01]\d|2[0-3])[0-5]\d[0-5]\d-[A-Za-z0-9_-]{1,80}\.(?:mp4|jpg|json)$/;

export function parseDeleteKey(key) {
  if (typeof key !== "string" || key.length > 200 || key.includes("..") || key.includes("//")) return null;
  const m = DELETE_KEY_RE.exec(key);
  if (!m || m[1].replaceAll("-", "") !== m[2]) return null;
  return key.slice(0, key.lastIndexOf("."));
}

/**
 * DELETE /api/outputs/<key>: removes the whole clip: mp4 first, then jpg, the sidecar .json LAST.
 * The gallery lists clips by sidecar, so the sidecar being last means a partial failure leaves the
 * card visible and the user can simply tap Delete again (a retry finishes the job). The reverse
 * order would leave unlisted files forever (no lifecycle rule on outputs/) with no way to retry.
 * R2 delete of a missing key succeeds, so a repeat is a 204 too. Brief window: a card may show
 * while its video is already gone.
 */
export async function handleDelete(env, key) {
  const base = parseDeleteKey(key);
  if (!base) throw new HttpError(400, "bad_key", "Not a clip key.");
  for (const ext of ["mp4", "jpg", "json"]) {
    try {
      await env.BUCKET.delete(`${base}.${ext}`);
    } catch {
      throw new HttpError(500, "delete_incomplete", "The clip could only be partly deleted. Try again.", { retryable: true });
    }
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

// ------------------------------------------------------------------ gallery

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Whitelist and type-check sidecar fields; anything missing becomes null, never an error. */
export function cleanMeta(m) {
  const o = m && typeof m === "object" ? m : {};
  return {
    mode: ["t2v", "i2v", "v2v"].includes(o.mode) ? o.mode : null,
    prompt: str(o.prompt, 2000),
    seed: num(o.seed),
    width: num(o.width),
    height: num(o.height),
    num_frames: num(o.num_frames),
    fps: num(o.fps),
    gen_time_s: num(o.gen_time_s),
    peak_vram_mb: num(o.peak_vram_mb),
    cold: typeof o.cold === "boolean" ? o.cold : null,
    created_at: str(o.created_at, 40),
  };
}

async function listAll(bucket, opts) {
  const keys = [];
  const prefixes = [];
  let cursor;
  for (let i = 0; i < 50; i++) {
    const res = await bucket.list({ ...opts, cursor, limit: 1000 });
    for (const o of res.objects) keys.push(o.key);
    for (const p of res.delimitedPrefixes || []) prefixes.push(p);
    if (!res.truncated) break;
    cursor = res.cursor;
  }
  return { keys, prefixes };
}

export async function handleGallery(request, env) {
  const url = new URL(request.url);
  let limit = Number(url.searchParams.get("limit") || DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);
  const before = url.searchParams.get("before");
  let beforeDate = null;
  let beforeKey = null;
  if (before) {
    if (DATE_RE.test(before)) beforeDate = before;
    else if (SIDECAR_RE.test(before)) {
      beforeKey = before;
      beforeDate = before.split("/")[1];
    } else throw new HttpError(400, "bad_before", "before must be a date or a clip key.");
  }

  const { prefixes } = await listAll(env.BUCKET, { prefix: "outputs/", delimiter: "/" });
  const dates = prefixes
    .map((p) => p.split("/")[1])
    .filter((d) => DATE_RE.test(d))
    .sort()
    .reverse()
    .filter((d) => (beforeKey ? d <= beforeDate : beforeDate ? d < beforeDate : true));

  const picked = [];
  let more = false;
  for (const d of dates) {
    const { keys } = await listAll(env.BUCKET, { prefix: `outputs/${d}/` });
    const sidecars = keys
      .filter((k) => SIDECAR_RE.test(k))
      .sort()
      .reverse()
      .filter((k) => !(beforeKey && k >= beforeKey));
    for (const k of sidecars) {
      if (picked.length >= limit) {
        more = true;
        break;
      }
      picked.push(k);
    }
    if (more) break;
  }

  const rate = Number(env.GPU_USD_PER_HR) || 1.75;
  const items = await Promise.all(
    picked.map(async (metaKey) => {
      let meta = {};
      try {
        const obj = await env.BUCKET.get(metaKey);
        if (obj) meta = await obj.json();
      } catch {
        meta = {};
      }
      const m = cleanMeta(meta);
      const base = metaKey.slice(0, -".json".length);
      return {
        id: base.split("/").pop(),
        key: base + ".mp4",
        thumb_key: base + ".jpg",
        meta_key: metaKey,
        meta: m,
        est_usd: m.gen_time_s === null ? null : Math.round(costUsd(m.gen_time_s, rate) * 10000) / 10000,
      };
    }),
  );
  return json(200, { items, next_before: more && picked.length ? picked[picked.length - 1] : null });
}

// ------------------------------------------------------------------ streaming

/** Parse a single-range Range header against a known size.
 * @returns {{kind: "none"} | {kind: "range", start: number, end: number} | {kind: "unsatisfiable"}}
 */
export function parseRange(header, size) {
  if (!header) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "none" }; // multi-range / invalid: plain 200
  if (size === 0) return { kind: "unsatisfiable" };
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return { kind: "unsatisfiable" };
  if (m[2] === "") return { kind: "range", start, end: size - 1 };
  const end = Number(m[2]);
  if (end < start) return { kind: "none" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

function baseHeaders(key, etag, contentType, download) {
  const ext = key.split(".").pop();
  const h = new Headers({
    "Content-Type": ext === "json" ? "application/json" : contentType || TYPES[ext] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": IMMUTABLE,
    ETag: etag,
  });
  if (download) {
    const name = key.split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_");
    h.set("Content-Disposition", `attachment; filename="${name}"`);
  }
  return h;
}

const etagMatches = (header, httpEtag) =>
  !!header && header.split(",").some((t) => t.trim() === httpEtag || t.trim() === "*" || t.trim() === `W/${httpEtag}`);

export async function handleOutput(request, env, key) {
  if (!validOutputKey(key)) return json(404, { error: "not_found" });
  const url = new URL(request.url);
  const download = url.searchParams.get("download") === "1";
  const isHead = request.method === "HEAD";

  const head = await env.BUCKET.head(key);
  if (!head) return json(404, { error: "not_found" });
  const h = baseHeaders(key, head.httpEtag, head.httpMetadata?.contentType, download);

  if (etagMatches(request.headers.get("If-None-Match"), head.httpEtag)) {
    h.delete("Content-Type");
    return new Response(null, { status: 304, headers: h });
  }

  // If-Range with a different validator means: ignore Range and send the whole thing.
  const ifRange = request.headers.get("If-Range");
  const rangeHeader = ifRange && ifRange.trim() !== head.httpEtag ? null : request.headers.get("Range");
  const r = isHead ? { kind: "none" } : parseRange(rangeHeader, head.size);

  if (r.kind === "unsatisfiable") {
    h.set("Content-Range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers: h });
  }
  if (isHead) {
    h.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers: h });
  }
  if (r.kind === "range") {
    const length = r.end - r.start + 1;
    let obj;
    try {
      obj = await env.BUCKET.get(key, { range: { offset: r.start, length } });
    } catch {
      h.set("Content-Range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers: h });
    }
    if (!obj || !obj.body) return json(404, { error: "not_found" });
    h.set("Content-Range", `bytes ${r.start}-${r.end}/${head.size}`);
    h.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj || !obj.body) return json(404, { error: "not_found" });
  h.set("Content-Length", String(head.size));
  return new Response(obj.body, { status: 200, headers: h });
}

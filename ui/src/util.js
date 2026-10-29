// Small helpers shared by the route modules.

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; " +
    "style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

/** Empty-bodied error: used for auth and config failures so nothing is disclosed. */
export function bare(status) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function errorResponse(e) {
  return json(e.status, { error: e.code, message: e.message, ...e.extra });
}

/**
 * Structured log line. Only whitelisted primitive fields are written: never a request,
 * header, body, token or environment object, so no secret can reach the logs.
 */
export function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    else if (typeof v === "string") safe[k] = v.slice(0, 120);
  }
  console.log(JSON.stringify({ event, ...safe }));
}

export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function nextUtcMidnight(ms) {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export async function readJsonBody(request, maxBytes = 16 * 1024) {
  const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (ct !== "application/json") throw new HttpError(415, "bad_content_type", "Send application/json.");
  const len = Number(request.headers.get("Content-Length") || "0");
  if (len > maxBytes) throw new HttpError(413, "too_large", "Request body too large.");
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "Request body too large.");
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new HttpError(400, "bad_json", "The request body is not valid JSON.");
  }
}

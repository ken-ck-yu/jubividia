// Thin RunPod serverless runtime client. The base URL is a constant: no request can change it.
// The API key and endpoint id come from Worker secrets and appear only in the request URL
// and Authorization header; error bodies from RunPod are never forwarded to the browser.

export const RUNPOD_BASE = "https://api.runpod.ai/v2";
export const JOB_TTL_MS = 2_100_000; // 35 min: queue wait + cold start + the 15 min execution timeout
export const JOB_EXEC_TIMEOUT_MS = 900_000; // milliseconds, like the endpoint setting
export const STALE_RESERVATION_MS = JOB_TTL_MS + 120_000;
const CALL_TIMEOUT_MS = 15_000;

export class RunpodNetworkError extends Error {}

export function runpodConfig(env) {
  const key = typeof env.RUNPOD_API_KEY === "string" ? env.RUNPOD_API_KEY.trim() : "";
  const ep = typeof env.RUNPOD_ENDPOINT_ID === "string" ? env.RUNPOD_ENDPOINT_ID.trim() : "";
  if (!key || !/^[A-Za-z0-9_-]{4,64}$/.test(ep)) return null;
  return { key, ep };
}

/** @returns {Promise<{status: number, body: any}>}; throws RunpodNetworkError on network failure or timeout. */
async function call(cfg, method, path, payload) {
  let res;
  try {
    res = await fetch(`${RUNPOD_BASE}/${cfg.ep}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new RunpodNetworkError("runpod unreachable");
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export const runpod = {
  health: (cfg) => call(cfg, "GET", "/health"),
  status: (cfg, id) => call(cfg, "GET", `/status/${encodeURIComponent(id)}`),
  cancel: (cfg, id) => call(cfg, "POST", `/cancel/${encodeURIComponent(id)}`),
  run: (cfg, input) =>
    call(cfg, "POST", "/run", { input, policy: { ttl: JOB_TTL_MS, executionTimeout: JOB_EXEC_TIMEOUT_MS } }),
};

const n = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** Reduce a /health body to numbers. Returns null when the body is unusable. */
export function parseHealth(res) {
  if (!res || res.status !== 200 || !res.body || typeof res.body !== "object") return null;
  const w = res.body.workers || {};
  const j = res.body.jobs || {};
  return {
    workers: {
      idle: n(w.idle),
      running: n(w.running),
      initializing: n(w.initializing),
      throttled: n(w.throttled),
      unhealthy: n(w.unhealthy),
    },
    inQueue: n(j.inQueue),
    inProgress: n(j.inProgress),
  };
}

export function gpuState(h) {
  if (!h) return "unknown";
  if (h.workers.idle + h.workers.running > 0) return "warm";
  if (h.workers.initializing > 0) return "starting";
  return "asleep";
}

/** Whether the next job will most likely pay a GPU boot plus the model load. */
export function coldLikely(h) {
  return !h || h.workers.idle + h.workers.running === 0;
}

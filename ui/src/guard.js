// Spend guards kept in R2 with conditional writes (atomic compare-and-swap):
//   state/active.json            the one-job reservation (create-if-absent with If-None-Match: *)
//   state/usage/<UTC date>.json  attempts counted for that UTC day
//   state/last.json              the most recently finished job (so a reload can still resolve it)
// R2 evaluates conditional writes atomically against committed state, so two concurrent
// /api/generate calls cannot both hold the reservation.
import { STALE_RESERVATION_MS, runpod, parseHealth, RunpodNetworkError } from "./runpod.js";
import { utcDate } from "./util.js";

export const ACTIVE_KEY = "state/active.json";
export const LAST_KEY = "state/last.json";
export const usageKey = (date) => `state/usage/${date}.json`;
const UNKNOWN_RESOLVE_MS = 120_000;
const CAS_TRIES = 6;

const IF_ABSENT = () => ({ onlyIf: new Headers({ "If-None-Match": "*" }) });
const IF_ETAG = (etag) => ({ onlyIf: { etagMatches: etag } });

/** @returns {Promise<{etag: string, data: any} | null>}; data is null for an unreadable object. */
export async function readState(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  let data = null;
  try {
    data = await obj.json();
  } catch {
    data = null;
  }
  return { etag: obj.etag, data };
}

async function putState(bucket, key, value, cond) {
  const opts = { httpMetadata: { contentType: "application/json" }, ...(cond || {}) };
  const res = await bucket.put(key, JSON.stringify(value), opts);
  return res !== null; // null means the precondition failed
}

// ------------------------------------------------------------------ daily counter

export function dailyCap(env) {
  const n = Number(env.DAILY_CAP);
  return Number.isInteger(n) && n >= 0 ? n : 30;
}

export async function readUsage(bucket, date) {
  const cur = await readState(bucket, usageKey(date));
  const a = cur?.data?.attempts;
  return Number.isInteger(a) && a >= 0 ? a : 0;
}

/**
 * Compare-and-swap change of the day's attempts. delta +1 refuses at the cap, -1 never goes
 * below zero. @returns {Promise<{ok: boolean, attempts: number}>}
 */
export async function bumpUsage(bucket, date, delta, cap) {
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await readState(bucket, usageKey(date));
    const have = Number.isInteger(cur?.data?.attempts) && cur.data.attempts >= 0 ? cur.data.attempts : 0;
    if (delta > 0 && have >= cap) return { ok: false, attempts: have };
    const next = Math.max(0, have + delta);
    if (next === have) return { ok: true, attempts: have };
    const done = await putState(bucket, usageKey(date), { attempts: next }, cur ? IF_ETAG(cur.etag) : IF_ABSENT());
    if (done) return { ok: true, attempts: next };
  }
  return { ok: false, attempts: -1 };
}

// ------------------------------------------------------------------ one-job reservation

const isTerminalRunpod = (s) => ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(s);

/**
 * Decide whether the stored record still blocks a new job.
 * @returns {Promise<"same" | "busy" | "free">}
 */
async function classify(cfg, rec, requestId, now) {
  const d = rec.data;
  if (!d || typeof d !== "object") return "free"; // corrupt record must never lock forever
  if (requestId && d.request_id === requestId) return "same";
  const age = now - (Number.isFinite(d.reserved_at) ? d.reserved_at : 0);
  if (age > STALE_RESERVATION_MS) return "free";
  try {
    if (d.job_id) {
      const st = await runpod.status(cfg, d.job_id);
      if (st.status === 404) return "free"; // RunPod no longer knows the job (ttl)
      if (st.status === 200 && isTerminalRunpod(st.body?.status)) return "free";
      return "busy";
    }
    // A job-less record is either an ambiguous submit ("unknown") or a Worker that faulted between
    // reserve() and the end of /run handling ("reserving"): both resolve through /health after 120 s.
    if ((d.state === "unknown" || d.state === "reserving") && age > UNKNOWN_RESOLVE_MS) {
      const h = parseHealth(await runpod.health(cfg));
      if (h && h.inQueue + h.inProgress === 0) return "free";
    }
  } catch (e) {
    if (!(e instanceof RunpodNetworkError)) throw e;
  }
  return "busy";
}

/**
 * Take the single reservation.
 * @returns {Promise<{kind: "ok"} | {kind: "same", record: any} | {kind: "busy", record: any}>}
 */
export async function reserve(bucket, cfg, record, now) {
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await readState(bucket, ACTIVE_KEY);
    if (!cur) {
      if (await putState(bucket, ACTIVE_KEY, record, IF_ABSENT())) return { kind: "ok" };
      continue;
    }
    const verdict = await classify(cfg, cur, record.request_id, now);
    if (verdict === "same") return { kind: "same", record: cur.data };
    if (verdict === "busy") return { kind: "busy", record: cur.data };
    if (await putState(bucket, ACTIVE_KEY, record, IF_ETAG(cur.etag))) return { kind: "ok" };
  }
  return { kind: "busy", record: null };
}

/** Update the record we own (matched by request_id) with CAS; false when it was taken over. */
export async function updateActive(bucket, requestId, patch) {
  for (let i = 0; i < CAS_TRIES; i++) {
    const cur = await readState(bucket, ACTIVE_KEY);
    if (!cur || !cur.data || cur.data.request_id !== requestId) return false;
    if (await putState(bucket, ACTIVE_KEY, { ...cur.data, ...patch }, IF_ETAG(cur.etag))) return true;
  }
  return false;
}

/** Remove the reservation if it is still ours (by request_id, or by job_id when settling). */
export async function release(bucket, match) {
  const cur = await readState(bucket, ACTIVE_KEY);
  if (!cur) return false;
  const d = cur.data;
  const ours = !d || (match.request_id && d.request_id === match.request_id) || (match.job_id && d.job_id === match.job_id);
  if (!ours) return false;
  await bucket.delete(ACTIVE_KEY);
  return true;
}

export async function readActive(bucket) {
  const cur = await readState(bucket, ACTIVE_KEY);
  return cur && cur.data && typeof cur.data === "object" ? cur.data : null;
}

export async function readLast(bucket) {
  const cur = await readState(bucket, LAST_KEY);
  return cur && cur.data && typeof cur.data === "object" ? cur.data : null;
}

/** A job reached a terminal state: remember it for reloads and free the lock. */
export async function settle(bucket, jobId, view, now) {
  await putState(bucket, LAST_KEY, { job_id: jobId, finished_at: now, view });
  await release(bucket, { job_id: jobId });
}

export function usageDate(now) {
  return utcDate(now);
}

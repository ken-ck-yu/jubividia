// JSON API: state, generate, status, cancel.
import { HttpError, json, readJsonBody, log, utcDate, nextUtcMidnight } from "./util.js";
import {
  runpod,
  runpodConfig,
  parseHealth,
  gpuState,
  coldLikely,
  RunpodNetworkError,
  JOB_EXEC_TIMEOUT_MS,
} from "./runpod.js";
import {
  reserve,
  release,
  updateActive,
  readActive,
  readLast,
  settle,
  bumpUsage,
  readUsage,
  dailyCap,
} from "./guard.js";
import { mapStatus, TERMINAL } from "./status.js";
import { emailTag } from "./auth.js";
import { UPLOAD_KEY_RE } from "./upload.js";
import * as calc from "../static/calc.js";

const JOB_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const COLD_EXTRA_S = 225; // measured: first clip after idle took 291 s vs 68 s warm

const rateOf = (env) => {
  const r = Number(env.GPU_USD_PER_HR);
  return Number.isFinite(r) && r > 0 ? r : calc.DEFAULT_RATE_USD_PER_HR;
};

function needRunpod(env) {
  const cfg = runpodConfig(env);
  if (!cfg) throw new HttpError(503, "not_configured", "The GPU service is not configured.");
  return cfg;
}

/** RunPod call wrapper: network failure becomes a readable 502. */
async function guardNet(p) {
  try {
    return await p;
  } catch (e) {
    if (e instanceof RunpodNetworkError) {
      throw new HttpError(502, "gpu_unreachable", "Cannot reach the GPU service right now. Try again in a moment.");
    }
    throw e;
  }
}

function publicActive(a, state) {
  if (!a) return null;
  return {
    job_id: a.job_id || null,
    mode: a.mode || null,
    submitted_at: a.submitted_at || null,
    reserved_at: a.reserved_at || null,
    reservation: a.state || null,
    cold_likely: !!a.cold_likely,
    cancel_requested: !!a.cancel_requested_at,    state: state || (a.job_id ? "running" : "starting"),
  };
}

export function limitsInfo(env) {
  const rate = rateOf(env);
  return {
    min_side: calc.MIN_SIDE,
    max_side: calc.MAX_SIDE,
    max_frames: calc.MAX_FRAMES,
    v2v_min_frames: calc.V2V_MIN_FRAMES,
    min_fps: calc.MIN_FPS,
    max_fps: calc.MAX_FPS,
    default_fps: calc.DEFAULT_FPS,
    envelope: { width: calc.DEFAULT_WIDTH, height: calc.DEFAULT_HEIGHT, frames: 121, pixel_frames: calc.ENVELOPE },
    max_image_bytes: calc.MAX_IMAGE_BYTES,
    max_video_bytes: calc.MAX_VIDEO_BYTES,
    max_prompt: calc.MAX_PROMPT,
    exec_timeout_s: JOB_EXEC_TIMEOUT_MS / 1000,
    worst_case_usd: Math.round(calc.worstCaseUsd(rate) * 100) / 100,
    warm_default_s: calc.DEFAULT_WARM_S,
    cold_extra_s: COLD_EXTRA_S,
  };
}

// ------------------------------------------------------------------ GET /api/state

export async function handleState(env, me, now = Date.now()) {
  const cfg = runpodConfig(env);
  const rate = rateOf(env);
  const cap = dailyCap(env);
  const date = utcDate(now);

  let health = null;
  if (cfg) {
    try {
      health = parseHealth(await runpod.health(cfg));
    } catch (e) {
      if (!(e instanceof RunpodNetworkError)) throw e;
    }
  }

  let active = await readActive(env.BUCKET);
  let activeState = null;
  if (active && active.job_id && cfg) {
    try {
      const st = await runpod.status(cfg, active.job_id);
      if (st.status === 200) {
        const view = mapStatus(st.body, health, rate, active.cold_likely);
        activeState = view.state;
        if (TERMINAL.has(view.state)) {
          await settle(env.BUCKET, active.job_id, view, now);
          active = null;
        }
      } else if (st.status === 404) {
        await release(env.BUCKET, { job_id: active.job_id });
        active = null;
      }
    } catch (e) {
      if (!(e instanceof RunpodNetworkError)) throw e;
      activeState = "net";
    }
  }
  const last = await readLast(env.BUCKET);

  return json(200, {
    me: me || null, // the verified Access email, shown (escaped) in the page header
    mine: !!(active && me && active.by && active.by === (await emailTag(me))),
    gpu: gpuState(health),
    workers: health ? health.workers : null,
    queue: health ? { in_queue: health.inQueue, in_progress: health.inProgress } : null,
    usage: { today: await readUsage(env.BUCKET, date), cap, date, resets_at: nextUtcMidnight(now) },
    active: publicActive(active, activeState),
    last: last ? { job_id: last.job_id || null, state: last.view?.state || null, finished_at: last.finished_at || null } : null,
    limits: limitsInfo(env),
    rate_usd_per_hr: rate,
    configured: !!cfg,
  });
}

// ------------------------------------------------------------------ POST /api/generate

function runFailure(status) {
  if (status === 401 || status === 403) {
    return new HttpError(502, "gpu_auth", "The GPU service rejected the server's credentials (misconfigured).");
  }
  if (status === 404) return new HttpError(502, "gpu_missing", "The GPU endpoint was not found (misconfigured).");
  if (status === 429) return new HttpError(503, "gpu_busy", "The GPU service is rate limiting. Try again in a minute.");
  if (status >= 500) return new HttpError(502, "gpu_error", "The GPU service had an error. Try again.");
  return new HttpError(
    502,
    "gpu_refused",
    "The GPU service refused the job. If the endpoint was idle for a quiet week it may be paused: " +
      "run infra/runpod/apply.sh endpoint to restore it.",
  );
}

export async function handleGenerate(request, env, me, now = Date.now()) {
  const body = await readJsonBody(request);
  const { errors, p } = calc.validateParams(body);

  let uploadKey = null;
  if (p.mode === "t2v") {
    if (body.upload_key !== undefined && body.upload_key !== null) errors.push("upload_key is not allowed for text-to-video");
  } else if (p.mode === "i2v" || p.mode === "v2v") {
    uploadKey = body.upload_key;
    if (typeof uploadKey !== "string" || !UPLOAD_KEY_RE.test(uploadKey)) {
      errors.push("upload_key is missing or invalid; upload the file first");
      uploadKey = null;
    } else {
      const ext = uploadKey.split(".").pop();
      const wantImage = p.mode === "i2v";
      const isImage = ["jpg", "png", "webp"].includes(ext);
      if (wantImage !== isImage) {
        errors.push(wantImage ? "image to video needs an image upload" : "video continuation needs a video upload");
      }
    }
  }
  if (errors.length) throw new HttpError(400, "bad_input", errors.join("; "), { errors });

  const requestId =
    typeof body.request_id === "string" && REQUEST_ID_RE.test(body.request_id) ? body.request_id : crypto.randomUUID();
  const cfg = needRunpod(env);
  const rate = rateOf(env);
  const cap = dailyCap(env);
  const date = utcDate(now);

  if (uploadKey) {
    const head = await env.BUCKET.head(uploadKey);
    if (!head) throw new HttpError(400, "upload_missing", "The uploaded file was not found. Upload it again.");
  }

  // Early, cheap refusal; the authoritative increment happens below after the reservation.
  if ((await readUsage(env.BUCKET, date)) >= cap) throw capError(cap, now);

  const record = {
    request_id: requestId,
    reserved_at: now,
    job_id: null,
    state: "reserving",
    mode: p.mode,
    submitted_at: null,
    cold_likely: false,
    by: me ? await emailTag(me) : null, // short hash, never the address
  };
  const got = await guardNet(reserve(env.BUCKET, cfg, record, now));
  if (got.kind === "same") {
    if (got.record.job_id) return json(200, jobResponse(got.record.job_id, got.record.cold_likely, p, rate, true));
    throw new HttpError(409, "busy", "This request is still being submitted.", { active: publicActive(got.record) });
  }
  if (got.kind === "busy") {
    const mine = !!(got.record && me && got.record.by === (await emailTag(me)));
    throw new HttpError(409, "busy", mine ? "A clip is already running." : "Another job is running (started by someone else). Wait for it to finish.", {
      active: publicActive(got.record),
      mine,
    });
  }

  // From here on we hold the reservation: every early exit releases it.
  let health;
  try {
    health = parseHealth(await runpod.health(cfg));
  } catch (e) {
    await release(env.BUCKET, { request_id: requestId });
    if (e instanceof RunpodNetworkError) {
      throw new HttpError(502, "gpu_unreachable", "Cannot reach the GPU service right now. Try again in a moment.");
    }
    throw e;
  }
  if (!health) {
    await release(env.BUCKET, { request_id: requestId });
    throw new HttpError(502, "gpu_unreachable", "The GPU service did not answer properly. Try again in a moment.");
  }
  if (health.inQueue + health.inProgress > 0) {
    await release(env.BUCKET, { request_id: requestId });
    throw new HttpError(409, "busy", "The GPU is already working on a job.", { in_flight: health.inQueue + health.inProgress });
  }
  const cold = coldLikely(health);

  const counted = await bumpUsage(env.BUCKET, date, +1, cap);
  if (!counted.ok) {
    await release(env.BUCKET, { request_id: requestId });
    throw capError(cap, now);
  }

  const input = {
    mode: p.mode,
    prompt: p.prompt,
    width: p.width,
    height: p.height,
    num_frames: p.num_frames,
    fps: p.fps,
    ...(p.seed !== undefined ? { seed: p.seed } : {}),
    ...(uploadKey ? { input_key: uploadKey } : {}),
  };

  let res;
  try {
    res = await runpod.run(cfg, input);
  } catch (e) {
    if (!(e instanceof RunpodNetworkError)) throw e;
    // Ambiguous: the job may exist and bill. Keep the reservation and the count.
    await updateActive(env.BUCKET, requestId, { state: "unknown", cold_likely: cold });
    log("run_unknown_outcome", { mode: p.mode });
    throw new HttpError(
      502,
      "unknown_outcome",
      "Lost contact while submitting. The job may have started; this page will pick it up if so. Wait a minute before trying again.",
    );
  }
  const jobId = res.body && typeof res.body.id === "string" && JOB_ID_RE.test(res.body.id) ? res.body.id : null;
  if (res.status >= 200 && res.status < 300 && jobId) {
    await updateActive(env.BUCKET, requestId, { job_id: jobId, state: "submitted", submitted_at: now, cold_likely: cold });
    log("job_submitted", { mode: p.mode, untested: p.untested });
    return json(202, jobResponse(jobId, cold, p, rate, false));
  }
  if (res.status >= 200 && res.status < 300) {
    await updateActive(env.BUCKET, requestId, { state: "unknown", cold_likely: cold });
    throw new HttpError(502, "unknown_outcome", "The GPU service gave an unexpected answer. Wait a minute before trying again.");
  }
  // Definitive 4xx/5xx: nothing was queued. Roll back.
  await release(env.BUCKET, { request_id: requestId });
  await bumpUsage(env.BUCKET, date, -1, cap);
  log("run_rejected", { status: res.status });
  throw runFailure(res.status);
}

function capError(cap, now) {
  return new HttpError(
    429,
    "daily_cap",
    `The daily limit of ${cap} clips is reached. It resets at midnight UTC.`,
    { resets_at: nextUtcMidnight(now), cap },
  );
}

function jobResponse(jobId, cold, p, rate, repeated) {
  const frames = p.num_frames;
  const est = calc.estimateWarmSeconds(p.width, p.height, frames) + (cold ? COLD_EXTRA_S : 5);
  return {
    job_id: jobId,
    repeated,
    untested: !!p.untested,
    expect: {
      cold_likely: cold,
      est_total_s: est,
      est_cost_usd: Math.round(calc.costUsd(est, rate) * 1000) / 1000,
      worst_case_usd: Math.round(calc.worstCaseUsd(rate) * 100) / 100,
    },
  };
}

// ------------------------------------------------------------------ GET /api/status/:id

export async function handleStatus(env, id, now = Date.now()) {
  if (!JOB_ID_RE.test(id)) throw new HttpError(400, "bad_id", "Bad job id.");
  const active = await readActive(env.BUCKET);
  const last = await readLast(env.BUCKET);
  const isActive = active && active.job_id === id;
  const isLast = last && last.job_id === id;
  if (!isActive && !isLast) throw new HttpError(404, "unknown_job", "No such job.");
  if (!isActive && isLast && last.view) return json(200, { ...last.view, job_id: id, finished_at: last.finished_at });

  const cfg = needRunpod(env);
  const rate = rateOf(env);
  const st = await guardNet(runpod.status(cfg, id));
  if (st.status === 404) {
    // RunPod dropped the record (ttl). Free the lock and tell the page.
    const view = {
      state: "failed",
      runpod_status: "EXPIRED",
      error: { code: "expired", message: "The GPU service no longer has this job. Check the gallery.", details: "" },
    };
    await settle(env.BUCKET, id, view, now);
    return json(200, { ...view, job_id: id });
  }
  if (st.status !== 200 || !st.body || typeof st.body !== "object") {
    throw new HttpError(502, "gpu_unreachable", "Cannot reach the GPU service right now.", { state: "net" });
  }
  let health = null;
  if (st.body.status === "IN_QUEUE") {
    try {
      health = parseHealth(await runpod.health(cfg));
    } catch (e) {
      if (!(e instanceof RunpodNetworkError)) throw e;
    }
  }
  const view = mapStatus(st.body, health, rate, active.cold_likely);
  view.job_id = id;
  view.submitted_at = active.submitted_at || null;
  view.cancel_requested = !!active.cancel_requested_at;
  if (TERMINAL.has(view.state)) await settle(env.BUCKET, id, view, now);
  return json(200, view);
}

// ------------------------------------------------------------------ POST /api/cancel/:id

export async function handleCancel(env, id, now = Date.now()) {
  if (!JOB_ID_RE.test(id)) throw new HttpError(400, "bad_id", "Bad job id.");
  const active = await readActive(env.BUCKET);
  if (!active || active.job_id !== id) throw new HttpError(404, "unknown_job", "That job is not the active one.");
  const cfg = needRunpod(env);
  const res = await guardNet(runpod.cancel(cfg, id));
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(502, "cancel_failed", "The GPU service did not accept the cancel. Try again.");
  }
  // The lock stays until /status reports a terminal state: a cancelled job can keep billing
  // while its worker winds down.
  await updateActive(env.BUCKET, active.request_id, { cancel_requested_at: now });
  return json(202, { ok: true, message: "Cancelling. The next clip can start once the GPU has stopped." });
}

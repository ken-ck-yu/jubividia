// Mapping of RunPod job states to the states the page shows, and of handler error codes to
// readable text. RunPod error bodies are never forwarded; only the handler's own
// "[code] message" text (bounded) is passed as "details".
import { costUsd } from "../static/calc.js";

export const TERMINAL = new Set(["done", "failed", "cancelled", "timeout"]);

export const ERROR_TEXT = {
  input_fetch: "The uploaded file could not be read. Upload it again.",
  oom: "This size or length did not fit in GPU memory. Pick a smaller size or a shorter clip.",
  timeout: "Took too long and was stopped. Try a smaller size or a shorter clip.",
  model_missing: "The server is misconfigured (model_missing). Not something to fix from the phone.",
  workflow_mismatch: "The server is misconfigured (workflow_mismatch). Not something to fix from the phone.",
  config_error: "The server is misconfigured (config_error). Not something to fix from the phone.",
  comfy_unavailable: "The GPU worker failed (comfy_unavailable). Try again; if it repeats, tell Ken.",
  comfy_bad_response: "The GPU worker failed (comfy_bad_response). Try again; if it repeats, tell Ken.",
  comfy_error: "The GPU worker failed (comfy_error). Try again; if it repeats, tell Ken.",
  output_missing: "The GPU worker failed (output_missing). Try again; if it repeats, tell Ken.",
  upload_failed: "The GPU worker failed (upload_failed). Try again; if it repeats, tell Ken.",
};

/** @returns {{code: string, message: string, details: string}} */
export function describeError(raw, code) {
  const details = typeof raw === "string" ? raw.slice(0, 600) : "";
  let c = typeof code === "string" ? code : "";
  if (!c) {
    const m = /^\[([a-z_]+)\]/.exec(details);
    if (m) c = m[1];
  }
  let message;
  if (c === "bad_input") {
    message = details.replace(/^\[bad_input\]\s*/, "") || "The request was rejected.";
  } else if (ERROR_TEXT[c]) {
    message = ERROR_TEXT[c];
  } else {
    message = "The job failed. Try again; if it repeats, tell Ken.";
  }
  return { code: c || "unknown", message, details };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Keep only the known success fields, with types checked. */
export function pickOutput(out, rate) {
  if (!out || typeof out !== "object") return null;
  const str = (v) => (typeof v === "string" ? v.slice(0, 300) : null);
  const gen = num(out.gen_time_s);
  return {
    key: str(out.key),
    thumb_key: str(out.thumb_key),
    meta_key: str(out.meta_key),
    duration_s: num(out.duration_s),
    gen_time_s: gen,
    seed: num(out.seed),
    width: num(out.width),
    height: num(out.height),
    num_frames: num(out.num_frames),
    fps: num(out.fps),
    cold: typeof out.cold === "boolean" ? out.cold : null,
    peak_vram_mb: num(out.peak_vram_mb),
    est_usd: gen === null ? null : Math.round(costUsd(gen, rate) * 10000) / 10000,
  };
}

/**
 * @param st   RunPod /status body
 * @param health  parsed /health (only used while IN_QUEUE) or null
 * @returns the UI view of the job
 */
export function mapStatus(st, health, rate, coldHint) {
  const view = {
    state: "running",
    runpod_status: typeof st?.status === "string" ? st.status : "UNKNOWN",
    delay_ms: num(st?.delayTime),
    execution_ms: num(st?.executionTime),
    cold_likely: !!coldHint,
  };
  switch (view.runpod_status) {
    case "IN_QUEUE": {
      const w = health?.workers;
      const total = w ? w.idle + w.running + w.initializing : 0;
      view.state = !w || w.initializing > 0 || total === 0 ? "starting" : "queued";
      break;
    }
    case "IN_PROGRESS":
      view.state = "running";
      break;
    case "COMPLETED": {
      const outErr = st.output && typeof st.output === "object" ? st.output.error : null;
      if (outErr) {
        Object.assign(view, failure(outErr, st.output.error_code));
      } else {
        view.state = "done";
        view.output = pickOutput(st.output, rate);
      }
      break;
    }
    case "FAILED":
      Object.assign(view, failure(st.error ?? st.output?.error, st.error_code ?? st.output?.error_code));
      break;
    case "CANCELLED":
      view.state = "cancelled";
      break;
    case "TIMED_OUT":
      view.state = "timeout";
      view.error = describeError("", "timeout");
      break;
    default:
      view.state = "running"; // unknown value: keep the job visible, never drop it
  }
  return view;
}

function failure(raw, code) {
  const error = describeError(raw, code);
  return { state: error.code === "timeout" ? "timeout" : "failed", error };
}

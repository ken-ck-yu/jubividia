// Shared by the page (static/app.js) and the Worker (src/*.js): one source of truth for the
// handler's hard bounds, the frame arithmetic, parameter validation and the cost estimates.
// Pure functions, no DOM, no Worker APIs.

// Hard bounds copied from worker/handler.py (the handler stays the last line of defence).
export const MIN_SIDE = 256;
export const MAX_SIDE = 2048;
export const MAX_FRAMES = 481;
export const MIN_FRAMES = 9;
export const MIN_FPS = 1;
export const MAX_FPS = 60;
export const DEFAULT_FPS = 24;
export const V2V_MIN_FRAMES = 33;
export const MAX_SEED = 4294967295;
export const MAX_PROMPT = 2000;

// The only measured point: 1280x704x121 (peak 43,473 MiB, 68 s warm). Beyond it is untested.
export const ENVELOPE = 1280 * 704 * 121;
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 704;
export const DEFAULT_WARM_S = 68;
export const EXEC_TIMEOUT_S = 900;
export const DEFAULT_RATE_USD_PER_HR = 1.75;

export const MAX_IMAGE_BYTES = 20 * 1000 * 1000;
export const MAX_VIDEO_BYTES = 95 * 1000 * 1000;

const isInt = (v) => typeof v === "number" && Number.isInteger(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Nearest 8k+1 frame count to duration*fps (minimum 9); same formula as handler.frames_for. */
export function framesFor(durationS, fps) {
  const k = Math.max(1, Math.round((durationS * fps - 1) / 8));
  return 8 * k + 1;
}

export function maxDurationS(fps) {
  return MAX_FRAMES / fps;
}

export function pixelFrames(width, height, frames) {
  return width * height * frames;
}

export function isUntested(width, height, frames) {
  return pixelFrames(width, height, frames) > ENVELOPE;
}

export function costUsd(seconds, rateUsdPerHr) {
  return (seconds * rateUsdPerHr) / 3600;
}

// Realistic worst case for one job: the 15 minute run cap, plus GPU boot (about 105 s, measured),
// plus the idle tail (180 s idle timeout), plus a margin for the scale-down lag seen in the gate
// runs (about 6 minutes after the last job). One shared constant for page, Worker and README.
export const BOOT_S = 105;
export const IDLE_TAIL_S = 180;
export const SCALE_DOWN_MARGIN_S = 150;
export const WORST_CASE_S = EXEC_TIMEOUT_S + BOOT_S + IDLE_TAIL_S + SCALE_DOWN_MARGIN_S;

export function worstCaseUsd(rateUsdPerHr) {
  return costUsd(WORST_CASE_S, rateUsdPerHr);
}

export function worstCaseText(rateUsdPerHr) {
  return `up to about $${(Math.round(worstCaseUsd(rateUsdPerHr) * 100) / 100).toFixed(2)} (15 min run cap + boot + idle)`;
}

/** Rough warm run time: scales the measured default clip by pixels x frames. */
export function estimateWarmSeconds(width, height, frames) {
  return Math.round((DEFAULT_WARM_S * pixelFrames(width, height, frames)) / ENVELOPE);
}

export function formatUsd(v) {
  if (!isNum(v)) return "";
  if (v < 0.1) return "$" + v.toFixed(3);
  return "$" + v.toFixed(2);
}

/**
 * Validate the generation parameters. Returns { errors: string[], p } where p holds the
 * effective values (num_frames always explicit). Rejects instead of clamping.
 */
export function validateParams(inp) {
  const errors = [];
  const p = {};
  if (!inp || typeof inp !== "object") return { errors: ["body must be an object"], p };

  const mode = inp.mode;
  if (!["t2v", "i2v", "v2v"].includes(mode)) errors.push("mode must be t2v, i2v or v2v");
  p.mode = mode;

  const prompt = typeof inp.prompt === "string" ? inp.prompt.trim() : "";
  if (!prompt) errors.push("prompt must not be empty");
  else if (prompt.length > MAX_PROMPT) errors.push(`prompt is too long (max ${MAX_PROMPT} characters)`);
  p.prompt = prompt;

  const side = (name, def) => {
    const v = inp[name] === undefined || inp[name] === null ? def : inp[name];
    if (!isInt(v)) {
      errors.push(`${name} must be a whole number`);
      return def;
    }
    if (v < MIN_SIDE || v > MAX_SIDE) errors.push(`${name} must be between ${MIN_SIDE} and ${MAX_SIDE}`);
    else if (v % 64 !== 0) errors.push(`${name} must be a multiple of 64`);
    return v;
  };
  p.width = side("width", DEFAULT_WIDTH);
  p.height = side("height", DEFAULT_HEIGHT);

  let fps = DEFAULT_FPS;
  if (inp.fps !== undefined && inp.fps !== null) {
    if (!isInt(inp.fps) || inp.fps < MIN_FPS || inp.fps > MAX_FPS) {
      errors.push(`fps must be a whole number between ${MIN_FPS} and ${MAX_FPS}`);
    } else fps = inp.fps;
  }
  p.fps = fps;

  let frames;
  if (inp.num_frames !== undefined && inp.num_frames !== null) {
    if (!isInt(inp.num_frames) || inp.num_frames < MIN_FRAMES || inp.num_frames > MAX_FRAMES) {
      errors.push(`num_frames must be a whole number between ${MIN_FRAMES} and ${MAX_FRAMES}`);
    } else if (inp.num_frames % 8 !== 1) {
      errors.push("num_frames must be 8k+1 (for example 121)");
    } else frames = inp.num_frames;
  } else {
    const d = inp.duration_s === undefined || inp.duration_s === null ? 5 : inp.duration_s;
    if (!isNum(d) || d < 0.3 || d > 20) {
      errors.push("duration_s must be between 0.3 and 20 seconds");
    } else {
      frames = framesFor(d, fps);
      if (frames > MAX_FRAMES) {
        errors.push(
          `duration x fps gives ${frames} frames; the maximum is ${MAX_FRAMES} (about ${maxDurationS(fps).toFixed(1)} s at ${fps} fps)`,
        );
        frames = undefined;
      }
    }
  }
  p.num_frames = frames;
  if (frames !== undefined && mode === "v2v" && frames < V2V_MIN_FRAMES) {
    errors.push(`video continuation needs at least ${V2V_MIN_FRAMES} frames (about 1.4 s at 24 fps)`);
  }

  if (inp.seed !== undefined && inp.seed !== null && inp.seed !== "") {
    if (!isInt(inp.seed) || inp.seed < 0 || inp.seed > MAX_SEED) {
      errors.push(`seed must be a whole number between 0 and ${MAX_SEED}`);
    } else p.seed = inp.seed;
  }

  p.untested =
    errors.length === 0 && frames !== undefined && isUntested(p.width, p.height, frames) ? true : false;
  return { errors, p };
}

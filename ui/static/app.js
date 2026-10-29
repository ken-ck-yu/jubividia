// jubividia page. Vanilla ES module, no build step.
// Rules: everything that comes from the server or from a sidecar is put into the page with
// textContent / property assignment, never as markup. No inline styles (CSP forbids them).
import * as calc from "./calc.js";

const $ = (id) => document.getElementById(id);
const MB = 1000 * 1000;

const COLD_TEXT =
  "Starting a GPU. The first clip after a quiet spell takes about 4-5 minutes in total: " +
  "roughly 1.5-2 minutes to boot the GPU and about 2 minutes to load the 37 GB of model weights, " +
  "then about a minute to generate. The GPU stays warm for about 3 minutes after a clip " +
  "(longer in practice), so later clips run in about a minute.";
const MODE_HELP = {
  t2v: "Describe a scene; the model makes a video with sound.",
  i2v: "Start from your picture. It is scaled and centre-cropped to the chosen size (edges are cut to fit).",
  v2v:
    "Continue a video. This does not edit your clip. It makes a new video that starts from the last second " +
    "of yours (that second is repeated at the start) and carries on from there, following your prompt. " +
    "The new clip has its own newly made sound; your original sound is not carried over, so joining the two " +
    "will have an audible seam. Your original is not included in the result.",
};
const IMAGE_EXT = ["jpg", "jpeg", "png", "webp"];
const VIDEO_EXT = ["mp4", "mov", "m4v"];

const S = {
  mode: "t2v",
  file: null, // { blob, ext, type, name, kind, width, height, duration }
  uploaded: null, // { blob, key } reuse after a failed generate
  server: null,
  job: null, // { id, params, startedAt, view }
  requestId: null,
  lastSeed: null,
  busy: false,
  poll: { timer: null, fails: 0, firstFailAt: 0 },
  tick: null,
  galleryNext: null,
};

// ------------------------------------------------------------------ small helpers
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === "text") e.textContent = v;
    else if (k === "class") e.className = v;
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}
function show(node, on = true) {
  node.hidden = !on;
}
function setText(id, text) {
  $(id).textContent = text;
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; the page works without it */
  }
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtMB = (n) => `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
const localTime = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

class SessionError extends Error {}

/** fetch wrapper. A redirect to the Access login or a non-JSON answer means the session lapsed. */
async function api(path, { method = "GET", json } = {}) {
  const headers = {};
  let body;
  if (method !== "GET") headers["X-Jubividia"] = "1";
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", redirect: "manual" });
  } catch {
    throw new SessionError("network");
  }
  if (res.type === "opaqueredirect" || res.redirected) throw new SessionError("redirect");
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) {
    if (res.status === 403 || res.status === 401 || ct.includes("text/html")) throw new SessionError("not-json");
    throw new SessionError("not-json");
  }
  const data = await res.json();
  return { status: res.status, ok: res.ok, data };
}
const SESSION_MSG = "Cannot reach the server. Your sign-in may have expired: reload the page to sign in again. Your picked file is kept until you reload.";

// ------------------------------------------------------------------ server state strip
async function refreshState() {
  try {
    const { data } = await api("/api/state");
    S.server = data;
    renderStrip();
    if (data.active && data.active.job_id && !S.job) adoptJob(data.active.job_id, null, data.active.submitted_at);
    updateForm();
  } catch (e) {
    if (e instanceof SessionError) {
      setText("gpu-badge", "Offline or signed out");
      setText("usage", "");
    }
  }
}

function renderStrip() {
  const s = S.server;
  const badge = $("gpu-badge");
  badge.className = "badge";
  const gpu = s.gpu;
  if (gpu === "warm") {
    badge.classList.add("warm");
    badge.textContent = "GPU warm: a clip takes about a minute";
  } else if (gpu === "starting") {
    badge.classList.add("starting");
    badge.textContent = "GPU starting";
  } else if (gpu === "asleep") {
    badge.textContent = "GPU asleep: first clip takes about 5 minutes";
  } else badge.textContent = "GPU status unknown";
  const u = s.usage;
  setText("usage", `${u.today} of ${u.cap} clips today. Resets ${localTime(u.resets_at)} your time.`);
  if (!s.configured) setText("usage", "The GPU service is not configured yet.");
  setText("me", s.me ? `Signed in as ${s.me}` : "");
}

// ------------------------------------------------------------------ mode and file
function setMode(mode) {
  S.mode = mode;
  setText("mode-help", MODE_HELP[mode]);
  const needsFile = mode !== "t2v";
  show($("file-section"), needsFile);
  const input = $("file");
  input.accept = mode === "i2v" ? "image/*" : "video/*";
  $("file-label").textContent = mode === "i2v" ? "Choose a photo" : "Choose a video";
  clearFile();
  $("v2v-tip").hidden = true;
  updateForm();
}

function clearFile() {
  S.file = null;
  S.uploaded = null;
  $("file").value = "";
  show($("file-error"), false);
  const prev = $("file-preview");
  prev.replaceChildren();
  show(prev, false);
  setText("file-info", "");
}

function fileError(msg) {
  setText("file-error", msg);
  show($("file-error"), true);
}

function extOf(name, type) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || "");
  if (m) return m[1].toLowerCase();
  // iOS can hand over a File with an empty type or name: fall back to the MIME type
  const t = (type || "").toLowerCase();
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };
  return map[t] || "";
}

async function downscaleImage(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.9));
  if (!blob) throw new Error("encode failed");
  return { blob, width: bmp.width, height: bmp.height };
}

function autoSize(w, h) {
  const ar = w / h;
  let size = [832, 832];
  if (ar > 1.15) size = [1280, 704];
  else if (ar < 0.87) size = [704, 1280];
  $("width").value = size[0];
  $("height").value = size[1];
}

async function onFile() {
  const file = $("file").files && $("file").files[0];
  S.file = null;
  S.uploaded = null;
  show($("file-error"), false);
  $("file-preview").replaceChildren();
  show($("file-preview"), false);
  setText("file-info", "");
  if (!file) return updateForm();
  const ext = extOf(file.name, file.type);

  if (S.mode === "i2v") {
    if (ext === "webm" || ext === "gif") return fileError("This image type is not supported. Use JPEG, PNG or WebP.");
    let prepared = null;
    try {
      const d = await downscaleImage(file);
      prepared = { blob: d.blob, ext: "jpg", type: "image/jpeg", width: d.width, height: d.height };
    } catch {
      if (!IMAGE_EXT.includes(ext)) {
        return fileError(
          ext === "heic" || ext === "heif"
            ? "This browser cannot convert HEIC. Choose the photo from the photo library (the phone converts it to JPEG) or export it as JPEG."
            : "This image could not be read. Use JPEG, PNG or WebP.",
        );
      }
      prepared = { blob: file, ext: ext === "jpeg" ? "jpg" : ext, type: file.type || "", width: 0, height: 0 };
      setText("file-info", "Could not shrink the picture here; uploading the original.");
    }
    if (prepared.blob.size > calc.MAX_IMAGE_BYTES) {
      return fileError(`This picture is ${fmtMB(prepared.blob.size)}; the limit is ${fmtMB(calc.MAX_IMAGE_BYTES)}.`);
    }
    S.file = { ...prepared, name: file.name, kind: "image" };
    const url = URL.createObjectURL(prepared.blob);
    const img = el("img", { src: url, alt: "Selected picture" });
    $("file-preview").replaceChildren(img);
    show($("file-preview"), true);
    if (prepared.width) autoSize(prepared.width, prepared.height);
    const info = `${fmtMB(prepared.blob.size)} to upload. Edges are cut to fit the chosen size.`;
    $("file-info").textContent = (prepared.width ? `${prepared.width}x${prepared.height}. ` : "") + info;
  } else {
    if (ext === "webm") return fileError("WebM video is not supported. Use an MP4 or MOV video.");
    if (!VIDEO_EXT.includes(ext)) return fileError("This video type is not supported. Use MP4 or MOV.");
    if (file.size > calc.MAX_VIDEO_BYTES) {
      return fileError(
        `This clip is ${fmtMB(file.size)}; the limit is ${fmtMB(calc.MAX_VIDEO_BYTES)}. Trim it, or pick a lower quality ` +
          "(for example Most Compatible or 1080p) when sharing from the Photos app.",
      );
    }
    S.file = { blob: file, ext: ext === "m4v" ? "mp4" : ext, type: ext === "mov" ? "video/quicktime" : "video/mp4", name: file.name, kind: "video", width: 0, height: 0, duration: 0 };
    const url = URL.createObjectURL(file);
    const v = el("video", { src: url, controls: true, muted: true, playsInline: true, preload: "metadata" });
    v.addEventListener("loadedmetadata", () => {
      S.file.width = v.videoWidth;
      S.file.height = v.videoHeight;
      S.file.duration = v.duration;
      if (v.videoWidth) autoSize(v.videoWidth, v.videoHeight);
      const short = v.duration < 1 ? " This clip is shorter than 1 second; the result may be poor." : "";
      setText("file-info", `${fmtMB(file.size)}, ${v.duration.toFixed(1)} s, ${v.videoWidth}x${v.videoHeight}. Edges are cut to fit.${short}`);
      updateForm();
    });
    v.addEventListener("error", () => {
      setText("file-info", `${fmtMB(file.size)}. This browser cannot preview the video, but it can still be uploaded.`);
    });
    $("file-preview").replaceChildren(v);
    show($("file-preview"), true);
    setText("file-info", `${fmtMB(file.size)}`);
  }
  updateForm();
}

// ------------------------------------------------------------------ form
function readParams() {
  const num = (id) => {
    const v = $(id).value.trim();
    return v === "" ? undefined : Number(v);
  };
  const p = {
    mode: S.mode,
    prompt: $("prompt").value,
    width: num("width"),
    height: num("height"),
    fps: num("fps"),
    duration_s: num("duration"),
  };
  const seed = num("seed");
  if (seed !== undefined) p.seed = seed;
  return p;
}

function updateForm() {
  const params = readParams();
  const { errors, p } = calc.validateParams(params);
  setText("prompt-count", `${params.prompt.trim().length}/${calc.MAX_PROMPT}`);
  const rate = S.server ? S.server.rate_usd_per_hr : calc.DEFAULT_RATE_USD_PER_HR;

  const warn = $("untested-warning");
  const frames = p.num_frames;
  if (frames) {
    const secs = (frames / p.fps).toFixed(2);
    setText("frames-info", `${frames} frames, ${secs} s at ${p.fps} fps`);
  } else setText("frames-info", "");
  if (frames && p.width && p.height && calc.isUntested(p.width, p.height, frames)) {
    const worst = calc.worstCaseText(rate);
    warn.textContent =
      `Untested size: ${p.width}x${p.height} x ${frames} frames is beyond the measured 1280x704 x 121. ` +
      `It may take much longer, can fail or run out of memory, and a failed run still bills until it stops. ` +
      `The run is capped at 15 minutes; worst case ${worst}.`;
    show(warn, true);
  } else show(warn, false);

  const formErr = errors.filter((e) => !/^prompt must not be empty/.test(e));
  setText("form-error", formErr.join(" "));
  show($("form-error"), formErr.length > 0);

  // hint under the button
  const hints = [];
  if (frames && p.width && p.height) {
    const warm = calc.estimateWarmSeconds(p.width, p.height, frames);
    const cold = S.server && S.server.gpu !== "warm";
    const est = warm + (cold ? S.server?.limits?.cold_extra_s ?? 225 : 5);
    hints.push(`Expect about ${mmss(est)}${cold ? " (GPU asleep)" : ""}, roughly ${calc.formatUsd(calc.costUsd(est, rate))} of GPU time.`);
  }
  setText("generate-hint", hints.join(" "));

  const capped = S.server && S.server.usage.today >= S.server.usage.cap;
  const needFile = S.mode !== "t2v" && !S.file;
  const ok = errors.length === 0 && !needFile && !S.busy && !S.job && !capped && !(S.server && !S.server.configured);
  $("generate").disabled = !ok;
  if (capped) setText("generate-hint", `The daily limit of ${S.server.usage.cap} clips is reached. It resets ${localTime(S.server.usage.resets_at)}.`);
  $("reuse-seed").disabled = S.lastSeed === null;
}

// ------------------------------------------------------------------ upload and submit
function uploadFile(f, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload?kind=${f.kind}&ext=${encodeURIComponent(f.ext)}`);
    xhr.setRequestHeader("X-Jubividia", "1");
    if (f.type) xhr.setRequestHeader("Content-Type", f.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        return reject(new SessionError("not-json"));
      }
      if (xhr.status === 201) resolve(data.upload_key);
      else reject(new Error(data.message || "Upload failed."));
    };
    xhr.onerror = () => reject(new SessionError("network"));
    xhr.send(f.blob);
  });
}

async function onGenerate() {
  const params = readParams();
  const { errors, p } = calc.validateParams(params);
  if (errors.length) return updateForm();
  S.busy = true;
  updateForm();
  show($("progress"), true);
  show($("result"), false);
  show($("progress-error"), false);
  show($("error-details"), false);
  show($("cancel"), false);
  setText("progress-label", "Starting");
  setText("progress-explain", "");
  try {
    let uploadKey = null;
    if (S.mode !== "t2v") {
      if (S.uploaded && S.uploaded.blob === S.file.blob) uploadKey = S.uploaded.key;
      else {
        setText("progress-label", "Uploading");
        setText("progress-explain", `Sending ${fmtMB(S.file.blob.size)} to the server.`);
        const bar = $("upload-bar");
        bar.value = 0;
        show(bar, true);
        uploadKey = await uploadFile(S.file, (pct) => (bar.value = pct));
        show(bar, false);
        S.uploaded = { blob: S.file.blob, key: uploadKey };
      }
    }
    S.requestId = S.requestId || crypto.randomUUID();
    const body = {
      request_id: S.requestId,
      mode: S.mode,
      prompt: p.prompt,
      width: p.width,
      height: p.height,
      fps: p.fps,
      num_frames: p.num_frames,
      ...(p.seed !== undefined ? { seed: p.seed } : {}),
      ...(uploadKey ? { upload_key: uploadKey } : {}),
    };
    const { status, data } = await api("/api/generate", { method: "POST", json: body });
    if (status === 202 || status === 200) {
      adoptJob(data.job_id, { ...p, untested: data.untested, expect: data.expect }, Date.now());
      refreshState();
    } else if (status === 409 && data.active && data.active.job_id) {
      adoptJob(data.active.job_id, null, data.active.submitted_at);
      setText("progress-explain", "A clip was already running; showing it.");
    } else {
      S.requestId = null;
      failForm(data.message || "The request was refused.");
      if (status === 429) refreshState();
    }
  } catch (e) {
    show($("upload-bar"), false);
    failForm(e instanceof SessionError ? SESSION_MSG : e.message || "Something went wrong.");
  } finally {
    S.busy = false;
    updateForm();
  }
}

function failForm(msg) {
  setText("progress-label", "Could not start");
  setText("progress-explain", "");
  setText("progress-error", msg);
  show($("progress-error"), true);
}

// ------------------------------------------------------------------ job progress
function adoptJob(id, params, startedAt) {
  S.job = { id, params, startedAt: startedAt || Date.now(), view: null };
  store("jubividia.job", id);
  show($("progress"), true);
  show($("cancel"), true);
  $("cancel").disabled = false;
  show($("progress-error"), false);
  show($("error-details"), false);
  setText("progress-label", "Queued");
  schedulePoll(0);
  if (!S.tick) S.tick = setInterval(renderElapsed, 1000);
  updateForm();
}

function renderElapsed() {
  if (!S.job) return;
  setText("elapsed", mmss(Math.max(0, (Date.now() - S.job.startedAt) / 1000)));
}

function expectedText(view) {
  const p = S.job && S.job.params;
  if (p && p.num_frames) {
    const warm = calc.estimateWarmSeconds(p.width, p.height, p.num_frames);
    const cold = view && view.cold_likely;
    return `Expected about ${mmss(warm + (cold ? S.server?.limits?.cold_extra_s ?? 225 : 5))}`;
  }
  return view && view.cold_likely ? "Expected about 5:00" : "Expected about 1:15";
}

function schedulePoll(ms) {
  clearTimeout(S.poll.timer);
  S.poll.timer = setTimeout(pollOnce, ms);
}

async function pollOnce() {
  if (!S.job) return;
  if (document.hidden) return; // resumed by visibilitychange
  try {
    const { status, data } = await api(`/api/status/${S.job.id}`);
    if (status === 404) {
      endJob();
      return;
    }
    if (status !== 200) throw new Error(data.message || "status");
    S.poll.fails = 0;
    S.poll.firstFailAt = 0;
    renderView(data);
    if (["done", "failed", "cancelled", "timeout"].includes(data.state)) return finishJob(data);
    schedulePoll(data.state === "running" ? 3000 : 4000);
  } catch (e) {
    S.poll.fails += 1;
    S.poll.firstFailAt = S.poll.firstFailAt || Date.now();
    const lost = Date.now() - S.poll.firstFailAt;
    setText("progress-explain", "Lost contact, retrying...");
    if (lost > 120000) {
      setText("progress-error", e instanceof SessionError ? SESSION_MSG : "Still cannot reach the server. The job keeps running; reload this page to pick it up.");
      show($("progress-error"), true);
    }
    schedulePoll(Math.min(15000, 3000 * 2 ** Math.min(S.poll.fails, 3)));
  }
}

function renderView(v) {
  S.job.view = v;
  if (v.submitted_at) S.job.startedAt = v.submitted_at;
  const labels = { queued: "Queued", starting: "Starting a GPU", running: "Running", done: "Done", failed: "Failed", cancelled: "Cancelled", timeout: "Stopped: too slow" };
  setText("progress-label", labels[v.state] || "Working");
  let explain = "";
  if (v.state === "queued") explain = "Waiting for a free GPU slot...";
  else if (v.state === "starting") explain = COLD_TEXT;
  else if (v.state === "running") {
    explain = v.cold_likely
      ? "Loading the model, then generating (first clip after idle: about 3-4 more minutes)."
      : "Generating (about 1-1.5 minutes for a 5 second clip).";
    if (S.job.params && S.job.params.untested) explain += " This size is untested; it can take much longer.";
  } else if (v.state === "cancelled") explain = "Cancelled.";
  else if (v.state === "timeout") explain = v.error ? v.error.message : "Took longer than the limit and was stopped.";
  if (v.cancel_requested && !["done", "failed", "cancelled", "timeout"].includes(v.state)) explain = "Cancelling... " + explain;
  setText("progress-explain", explain);
  setText("expected", expectedText(v));
  renderElapsed();
}

function finishJob(v) {
  clearTimeout(S.poll.timer);
  clearInterval(S.tick);
  S.tick = null;
  show($("cancel"), false);
  if (v.state === "done" && v.output) {
    showResult({ ...v.output, prompt: (S.job.params && S.job.params.prompt) || null, mode: (S.job.params && S.job.params.mode) || null });
    if (v.output.seed !== null) S.lastSeed = v.output.seed;
    refreshGallery(true);
  } else if (v.state === "failed" || v.state === "timeout") {
    setText("progress-error", v.error ? v.error.message : "The job failed.");
    show($("progress-error"), true);
    if (v.error && v.error.details) {
      setText("error-text", v.error.details);
      show($("error-details"), true);
    }
  }
  endJob();
  refreshState();
}

function endJob() {
  S.job = null;
  S.requestId = null;
  store("jubividia.job", null);
  updateForm();
}

async function onCancel() {
  if (!S.job) return;
  $("cancel").disabled = true;
  try {
    const { ok, data } = await api(`/api/cancel/${S.job.id}`, { method: "POST" });
    setText("progress-explain", ok ? "Cancelling... " + data.message : data.message || "Cancel failed.");
    if (!ok) $("cancel").disabled = false;
    schedulePoll(1500);
  } catch {
    setText("progress-explain", SESSION_MSG);
    $("cancel").disabled = false;
  }
}

// ------------------------------------------------------------------ result and gallery
function statsLine(o) {
  const parts = [];
  if (o.width && o.height) parts.push(`${o.width}x${o.height}`);
  if (o.num_frames && o.fps) parts.push(`${o.num_frames} frames, ${(o.num_frames / o.fps).toFixed(1)} s`);
  if (o.seed !== null && o.seed !== undefined) parts.push(`seed ${o.seed}`);
  if (typeof o.gen_time_s === "number") parts.push(`${o.gen_time_s.toFixed(0)} s of GPU`);
  if (typeof o.peak_vram_mb === "number") parts.push(`peak VRAM ${(o.peak_vram_mb / 1024).toFixed(1)} GiB`);
  const rate = S.server ? S.server.rate_usd_per_hr : calc.DEFAULT_RATE_USD_PER_HR;
  const est = typeof o.est_usd === "number" ? o.est_usd : typeof o.gen_time_s === "number" ? calc.costUsd(o.gen_time_s, rate) : null;
  if (est !== null) parts.push(`about ${calc.formatUsd(est)}`);
  if (o.cold === true) parts.push("cold start (boot cost not included)");
  return parts.join(" | ");
}

function mediaUrl(key, download) {
  return `/api/outputs/${key}${download ? "?download=1" : ""}`;
}

function showResult(o) {
  const v = $("player");
  v.poster = o.thumb_key ? mediaUrl(o.thumb_key) : "";
  v.src = mediaUrl(o.key);
  setText("result-stats", statsLine(o));
  setText("result-prompt", o.prompt || "");
  $("download").href = mediaUrl(o.key, true);
  show($("v2v-tip"), o.mode === "v2v");
  const canShare = !!navigator.share;
  show($("share"), canShare);
  $("share").onclick = async () => {
    try {
      const blob = await (await fetch(mediaUrl(o.key))).blob();
      const file = new File([blob], o.key.split("/").pop(), { type: "video/mp4" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else await navigator.share({ title: "jubividia clip", text: o.prompt || "" });
    } catch {
      /* cancelled by the user */
    }
  };
  show($("result"), true);
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function loadParams(item) {
  const m = item.meta;
  if (m.prompt !== null) $("prompt").value = m.prompt;
  if (m.width) $("width").value = m.width;
  if (m.height) $("height").value = m.height;
  if (m.fps) $("fps").value = m.fps;
  if (m.num_frames && m.fps) $("duration").value = (m.num_frames / m.fps).toFixed(2);
  if (m.seed !== null) $("seed").value = m.seed;
  if (m.mode === "t2v") {
    $("advanced").open = true;
    document.querySelector('input[name="mode"][value="t2v"]').checked = true;
    setMode("t2v");
  }
  updateForm();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function card(item) {
  const m = item.meta;
  const img = el("img", { class: "thumb", src: mediaUrl(item.thumb_key), alt: "Clip thumbnail", loading: "lazy" });
  const tag = el("span", { class: "tag", text: m.mode ? m.mode.toUpperCase() : "?" });
  const meta = el(
    "div",
    { class: "meta" },
    tag,
    el("div", { class: "p", text: m.prompt || "(no prompt recorded)" }),
    el("div", { class: "muted", text: statsLine({ ...m, est_usd: item.est_usd }) }),
  );
  const play = el("button", { type: "button", text: "Play" });
  const load = el("button", { type: "button", text: "Load" });
  const dl = el("a", { class: "button", href: mediaUrl(item.key, true), text: "Save" });
  play.addEventListener("click", () => showResult({ ...m, key: item.key, thumb_key: item.thumb_key, est_usd: item.est_usd }));
  img.addEventListener("click", () => play.click());
  load.addEventListener("click", () => loadParams(item));
  return el("div", { class: "item" }, img, meta, el("div", { class: "acts" }, play, load, dl));
}

async function refreshGallery(reset) {
  const grid = $("gallery");
  try {
    const q = reset || !S.galleryNext ? "" : `&before=${encodeURIComponent(S.galleryNext)}`;
    const { ok, data } = await api(`/api/outputs?limit=12${q}`);
    if (!ok) return;
    if (reset) grid.replaceChildren();
    for (const item of data.items) grid.append(card(item));
    S.galleryNext = data.next_before;
    show($("load-more"), !!data.next_before);
    show($("gallery-empty"), grid.children.length === 0);
  } catch {
    /* the strip already tells the user when the session is gone */
  }
}

// ------------------------------------------------------------------ wiring
// The brand photo is optional (git-ignored): show it only if it loads; otherwise the text brand stands alone.
function initBrandImage() {
  const img = $("brand-img");
  if (!img) return;
  img.addEventListener("load", () => {
    img.hidden = false;
  });
  img.addEventListener("error", () => {
    img.remove();
  });
  // hidden images still load; if it finished before this script ran, handle that too
  if (img.complete) {
    if (img.naturalWidth > 0) img.hidden = false;
    else img.remove();
  }
}

function init() {
  initBrandImage();
  for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", () => setMode(r.value));
  $("file").addEventListener("change", onFile);
  for (const id of ["prompt", "seed", "width", "height", "duration", "fps"]) $(id).addEventListener("input", updateForm);
  for (const b of document.querySelectorAll(".preset")) {
    b.addEventListener("click", () => {
      $("width").value = b.dataset.w;
      $("height").value = b.dataset.h;
      updateForm();
    });
  }
  $("reuse-seed").addEventListener("click", () => {
    if (S.lastSeed !== null) $("seed").value = S.lastSeed;
    updateForm();
  });
  $("generate").addEventListener("click", onGenerate);
  $("cancel").addEventListener("click", onCancel);
  $("load-more").addEventListener("click", () => refreshGallery(false));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshState();
      if (S.job) schedulePoll(0);
    }
  });
  setMode("t2v");
  const saved = recall("jubividia.job");
  if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) adoptJob(saved, null, null);
  refreshState();
  refreshGallery(true);
  setInterval(() => {
    if (!document.hidden) refreshState();
  }, 30000);
}

init();

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installFakes, send, runpod, clearBucket, bucket, SECRETS } from "./helpers.js";
import { ACTIVE_KEY, LAST_KEY } from "../src/guard.js";
import { mapStatus, describeError } from "../src/status.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

const gen = async () => {
  const res = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x" } });
  return (await res.json()).job_id;
};
const status = async (id) => (await send(`/api/status/${id}`)).json();

describe("status mapping (table)", () => {
  const H = (w) => ({ workers: { idle: 0, running: 0, initializing: 0, throttled: 0, unhealthy: 0, ...w }, inQueue: 1, inProgress: 0 });
  const rows = [
    [{ status: "IN_QUEUE" }, H({}), "starting"],
    [{ status: "IN_QUEUE" }, H({ initializing: 1 }), "starting"],
    [{ status: "IN_QUEUE" }, H({ idle: 1 }), "queued"],
    [{ status: "IN_QUEUE" }, H({ running: 1 }), "queued"],
    [{ status: "IN_QUEUE" }, null, "starting"],
    [{ status: "IN_PROGRESS" }, null, "running"],
    [{ status: "CANCELLED" }, null, "cancelled"],
    [{ status: "TIMED_OUT" }, null, "timeout"],
    [{ status: "FAILED", error: "[oom] x", error_code: "oom" }, null, "failed"],
    [{ status: "FAILED", error: "[timeout] generation exceeded 780s" }, null, "timeout"],
    [{ status: "SOMETHING_NEW" }, null, "running"],
    [{}, null, "running"],
    [{ status: "COMPLETED", output: { error: "[comfy_error] x", error_code: "comfy_error" } }, null, "failed"],
  ];
  it.each(rows)("%j health=%j -> %s", (st, health, expected) => {
    expect(mapStatus(st, health, 1.75, false).state).toBe(expected);
  });

  it("maps every handler error code to readable text and falls back on the [code] prefix", () => {
    for (const code of ["input_fetch", "oom", "timeout", "model_missing", "workflow_mismatch", "config_error", "comfy_unavailable", "comfy_bad_response", "comfy_error", "output_missing", "upload_failed"]) {
      const d = describeError(`[${code}] raw`, code);
      expect(d.message.length).toBeGreaterThan(10);
      expect(d.message).not.toContain("raw");
    }
    expect(describeError("[oom] GPU ran out", undefined).code).toBe("oom");
    expect(describeError("[bad_input] width must be an integer", "bad_input").message).toBe("width must be an integer");
    expect(describeError("weird", undefined).message).toContain("Try again");
  });

  it("keeps gen time, peak VRAM and a cost estimate for a finished clip", () => {
    const v = mapStatus(
      { status: "COMPLETED", output: { key: "outputs/2026-10-29/20261029T010101-a.mp4", gen_time_s: 72, peak_vram_mb: 43473, width: 1280, height: 704, num_frames: 121, fps: 24, cold: false, seed: 5, evil: "<script>" } },
      null, 1.75, false,
    );
    expect(v.output.gen_time_s).toBe(72);
    expect(v.output.peak_vram_mb).toBe(43473);
    expect(v.output.est_usd).toBeCloseTo(0.035, 3);
    expect(v.output.evil).toBeUndefined();
  });
});

describe("GET /api/status/:id", () => {
  it("walks queue -> starting -> running -> done, and the lock is freed with last.json written", async () => {
    const id = await gen();
    let v = await status(id);
    expect(v.state).toBe("starting"); // no worker at all
    expect(v.cold_likely).toBe(true);
    runpod.health.workers.idle = 1;
    expect((await status(id)).state).toBe("queued");
    runpod.jobs.get(id).status = "IN_PROGRESS";
    expect((await status(id)).state).toBe("running");
    runpod.jobs.get(id).status = "COMPLETED";
    runpod.jobs.get(id).output = { key: "outputs/2026-10-29/20261029T010101-a.mp4", thumb_key: "outputs/2026-10-29/20261029T010101-a.jpg", meta_key: "outputs/2026-10-29/20261029T010101-a.json", gen_time_s: 70, peak_vram_mb: 43000, cold: true };
    v = await status(id);
    expect(v.state).toBe("done");
    expect(v.output.est_usd).toBeGreaterThan(0);
    expect(await bucket().get(ACTIVE_KEY)).toBeNull();
    expect(await bucket().get(LAST_KEY)).not.toBeNull();
    // a reload after the lock is gone still resolves from last.json without RunPod
    const calls = runpod.calls.length;
    expect((await status(id)).state).toBe("done");
    expect(runpod.calls.length).toBe(calls);
  });

  it("shows a failed job with a friendly message and the details", async () => {
    const id = await gen();
    Object.assign(runpod.jobs.get(id), { status: "FAILED", error: "[oom] GPU ran out of memory", error_code: "oom" });
    const v = await status(id);
    expect(v.state).toBe("failed");
    expect(v.error.message).toContain("did not fit in GPU memory");
    expect(v.error.details).toContain("[oom]");
  });

  it("rejects unknown ids and bad shapes without calling RunPod", async () => {
    await gen();
    const before = runpod.calls.length;
    expect((await send("/api/status/job-99999999-u1")).status).toBe(404);
    expect((await send("/api/status/..%2fstate")).status).toBe(400);
    expect((await send("/api/status/a")).status).toBe(400);
    expect(runpod.calls.length).toBe(before);
  });

  it("reports a network problem as 502 and keeps the lock", async () => {
    const id = await gen();
    vi.spyOn(runpod, "handle").mockImplementation(async () => {
      throw new TypeError("down");
    });
    const res = await send(`/api/status/${id}`);
    expect(res.status).toBe(502);
    expect(await bucket().get(ACTIVE_KEY)).not.toBeNull();
  });

  it("treats RunPod 404 (ttl expired) as terminal and frees the lock", async () => {
    const id = await gen();
    runpod.jobs.delete(id);
    const v = await status(id);
    expect(v.state).toBe("failed");
    expect(v.error.code).toBe("expired");
    expect(await bucket().get(ACTIVE_KEY)).toBeNull();
  });

  it("does not leak RunPod 401/500 bodies", async () => {
    const id = await gen();
    vi.spyOn(runpod, "handle").mockImplementation(async () => new Response(JSON.stringify({ error: "RAW BODY " + SECRETS.RUNPOD_API_KEY }), { status: 401 }));
    const res = await send(`/api/status/${id}`);
    expect(res.status).toBe(502);
    const t = await res.text();
    expect(t).not.toContain("RAW BODY");
  });
});

describe("cancel", () => {
  it("cancels the active job but keeps the lock until the status is terminal", async () => {
    const id = await gen();
    runpod.cancelStopsJob = false; // RunPod accepts the cancel, the worker is still winding down
    const res = await send(`/api/cancel/${id}`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(runpod.calls.some((c) => c.method === "POST" && c.path === `/cancel/${id}`)).toBe(true);
    expect(await bucket().get(ACTIVE_KEY)).not.toBeNull();
    const again = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "next" } });
    expect(again.status).toBe(409);
    // the page keeps showing the job; once RunPod reports a terminal state the lock goes
    runpod.jobs.get(id).status = "CANCELLED";
    runpod.health.jobs.inQueue = 0;
    expect((await status(id)).state).toBe("cancelled");
    expect(await bucket().get(ACTIVE_KEY)).toBeNull();
    expect((await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "next" } })).status).toBe(202);
  });

  it("refuses to cancel anything that is not the active job, and needs the CSRF header", async () => {
    const id = await gen();
    expect((await send("/api/cancel/job-00000000-u9", { method: "POST" })).status).toBe(404);
    expect((await send("/api/cancel/bad", { method: "POST" })).status).toBe(400);
    expect((await send(`/api/cancel/${id}`, { method: "POST", noCsrf: true })).status).toBe(403);
    expect((await send(`/api/cancel/${id}`)).status).toBe(405);
  });
});

describe("GET /api/state", () => {
  it("reports gpu state, usage with the reset time, the active job and the limits", async () => {
    let s = await (await send("/api/state")).json();
    expect(s.gpu).toBe("asleep");
    expect(s.usage).toMatchObject({ today: 0, cap: 30 });
    expect(new Date(s.usage.resets_at).getUTCHours()).toBe(0);
    expect(s.active).toBeNull();
    expect(s.limits.worst_case_usd).toBe(0.44);
    expect(s.limits.max_video_bytes).toBe(95_000_000);
    const id = await gen();
    runpod.health.workers.initializing = 1;
    s = await (await send("/api/state")).json();
    expect(s.gpu).toBe("starting");
    expect(s.usage.today).toBe(1);
    expect(s.active.job_id).toBe(id);
    runpod.health.workers.idle = 1;
    expect((await (await send("/api/state")).json()).gpu).toBe("warm");
    runpod.jobs.get(id).status = "COMPLETED";
    s = await (await send("/api/state")).json();
    expect(s.active).toBeNull();
    expect(s.last.job_id).toBe(id);
  });

  it("still answers when RunPod is unreachable", async () => {
    vi.spyOn(runpod, "handle").mockImplementation(async () => {
      throw new TypeError("down");
    });
    const res = await send("/api/state");
    expect(res.status).toBe(200);
    expect((await res.json()).gpu).toBe("unknown");
  });
});

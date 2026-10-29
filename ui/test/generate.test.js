import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installFakes, send, makeEnv, runpod, clearBucket, bucket, uploadImage, uploadVideo, SECRETS, EP,
} from "./helpers.js";
import { bumpUsage, readUsage, ACTIVE_KEY } from "../src/guard.js";
import { utcDate } from "../src/util.js";
import { framesFor, validateParams } from "../static/calc.js";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

const gen = (json, env) => send("/api/generate", { method: "POST", json, env });
const runCalls = () => runpod.calls.filter((c) => c.path === "/run");

describe("frame arithmetic", () => {
  it("matches the handler's 8k+1 rule", () => {
    expect(framesFor(5, 24)).toBe(121);
    expect(framesFor(10, 24)).toBe(241);
    expect(framesFor(0.3, 24)).toBe(9);
    expect(framesFor(20, 24)).toBe(481);
    expect(framesFor(1.4, 24)).toBe(33);
  });
});

describe("validation", () => {
  const bad = async (body, text) => {
    const res = await gen(body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    const j = await res.json();
    expect(j.message).toContain(text);
    expect(runCalls().length).toBe(0);
  };

  it("rejects bad mode, empty and overlong prompts", async () => {
    await bad({ mode: "x2v", prompt: "a" }, "mode");
    await bad({ mode: "t2v", prompt: "   " }, "prompt");
    await bad({ mode: "t2v", prompt: "a".repeat(2001) }, "too long");
  });

  it("rejects sizes outside the handler's bounds or not multiples of 64", async () => {
    await bad({ mode: "t2v", prompt: "a", width: 128 }, "width");
    await bad({ mode: "t2v", prompt: "a", height: 4096 }, "height");
    await bad({ mode: "t2v", prompt: "a", width: 1000 }, "multiple of 64");
    await bad({ mode: "t2v", prompt: "a", width: 640.5 }, "whole number");
    await bad({ mode: "t2v", prompt: "a", width: "640" }, "whole number");
  });

  it("rejects frame and duration problems", async () => {
    await bad({ mode: "t2v", prompt: "a", num_frames: 122 }, "8k+1");
    await bad({ mode: "t2v", prompt: "a", num_frames: 489 }, "between 9 and 481");
    await bad({ mode: "t2v", prompt: "a", duration_s: 25 }, "duration_s");
    await bad({ mode: "t2v", prompt: "a", duration_s: 20, fps: 30 }, "maximum is 481");
    await bad({ mode: "t2v", prompt: "a", fps: 61 }, "fps");
    await bad({ mode: "t2v", prompt: "a", seed: -1 }, "seed");
    await bad({ mode: "t2v", prompt: "a", seed: 1.5 }, "seed");
  });

  it("keeps the 33-frame minimum for video continuation", async () => {
    const key = await uploadVideo();
    await bad({ mode: "v2v", prompt: "a", upload_key: key, num_frames: 25 }, "at least 33");
    const ok = await gen({ mode: "v2v", prompt: "a", upload_key: key, num_frames: 33 });
    expect(ok.status).toBe(202);
  });

  it("checks upload_key shape, mode match and existence", async () => {
    const img = await uploadImage();
    const vid = await uploadVideo();
    await bad({ mode: "t2v", prompt: "a", upload_key: img }, "not allowed");
    await bad({ mode: "i2v", prompt: "a" }, "upload_key");
    await bad({ mode: "i2v", prompt: "a", upload_key: "inputs/../state/active.json" }, "upload_key");
    await bad({ mode: "i2v", prompt: "a", upload_key: "outputs/2026-10-29/20261029T010101-x.mp4" }, "upload_key");
    await bad({ mode: "i2v", prompt: "a", upload_key: vid }, "image upload");
    await bad({ mode: "v2v", prompt: "a", upload_key: img }, "video upload");
    const missing = "inputs/11111111-2222-4333-8444-555555555555.jpg";
    const res = await gen({ mode: "i2v", prompt: "a", upload_key: missing });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("upload_missing");
    expect(runCalls().length).toBe(0);
  });

  it("requires JSON and the CSRF header, and ignores unknown or key-like fields", async () => {
    const res = await send("/api/generate", { method: "POST", body: "mode=t2v", headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(415);
    const res2 = await send("/api/generate", { method: "POST", json: { mode: "t2v", prompt: "x" }, noCsrf: true });
    expect(res2.status).toBe(403);
    const ok = await gen({ mode: "t2v", prompt: "hello", input_key: "state/active.json", key: "inputs/x", policy: { ttl: 1 } });
    expect(ok.status).toBe(202);
    expect(runCalls()[0].body.input.input_key).toBeUndefined();
  });
});

describe("what is sent to RunPod", () => {
  it("sends explicit frames, no negative, the job policy in milliseconds, and the key only as a header", async () => {
    const key = await uploadImage();
    const res = await gen({ mode: "i2v", prompt: "  a prompt  ", upload_key: key, width: 640, height: 384, duration_s: 5, seed: 7, negative: "ignored" });
    expect(res.status).toBe(202);
    const call = runCalls()[0];
    expect(call.body).toEqual({
      input: { mode: "i2v", prompt: "a prompt", width: 640, height: 384, num_frames: 121, fps: 24, seed: 7, input_key: key },
      policy: { ttl: 2100000, executionTimeout: 900000 },
    });
    expect(call.auth).toBe(`Bearer ${SECRETS.RUNPOD_API_KEY}`);
    expect(JSON.stringify(call.body)).not.toContain(SECRETS.RUNPOD_API_KEY);
    expect(JSON.stringify(call.body)).not.toContain(EP);
  });

  it("omits the seed when the user leaves it blank and flags untested sizes", async () => {
    const res = await gen({ mode: "t2v", prompt: "x", width: 1280, height: 704, num_frames: 121 });
    expect(runCalls()[0].body.input.seed).toBeUndefined();
    expect((await res.json()).untested).toBe(false);
  });

  it("allows sizes beyond the measured envelope but marks them untested with the worst case cost", async () => {
    const res = await gen({ mode: "t2v", prompt: "x", width: 1920, height: 1088, num_frames: 481 });
    expect(res.status).toBe(202);
    const j = await res.json();
    expect(j.untested).toBe(true);
    expect(j.expect.worst_case_usd).toBe(0.44);
    expect(validateParams({ mode: "t2v", prompt: "x", width: 2048, height: 2048, num_frames: 481 }).errors).toEqual([]);
  });

  it("reports cold-likely from /health", async () => {
    let j = await (await gen({ mode: "t2v", prompt: "x" })).json();
    expect(j.expect.cold_likely).toBe(true);
    await clearBucket();
    runpod.reset();
    runpod.health.workers.idle = 1;
    j = await (await gen({ mode: "t2v", prompt: "x" })).json();
    expect(j.expect.cold_likely).toBe(false);
  });
});

describe("one active job", () => {
  it("refuses a second submit while one is active, and adopts via the active summary", async () => {
    const first = await (await gen({ mode: "t2v", prompt: "one" })).json();
    const second = await gen({ mode: "t2v", prompt: "two" });
    expect(second.status).toBe(409);
    const j = await second.json();
    expect(j.error).toBe("busy");
    expect(j.active.job_id).toBe(first.job_id);
    expect(runCalls().length).toBe(1);
  });

  it("lets only one of two concurrent submits reach RunPod", async () => {
    runpod.runDelay = 20;
    const results = await Promise.all([
      gen({ mode: "t2v", prompt: "a", request_id: "req-aaaaaaaa" }),
      gen({ mode: "t2v", prompt: "b", request_id: "req-bbbbbbbb" }),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([202, 409]);
    expect(runCalls().length).toBe(1);
    expect(await readUsage(bucket(), utcDate(Date.now()))).toBe(1);
  });

  it("returns the same job for a repeated request_id instead of a 409", async () => {
    const a = await (await gen({ mode: "t2v", prompt: "x", request_id: "req-12345678" })).json();
    const again = await gen({ mode: "t2v", prompt: "x", request_id: "req-12345678" });
    expect(again.status).toBe(200);
    const b = await again.json();
    expect(b.job_id).toBe(a.job_id);
    expect(b.repeated).toBe(true);
    expect(runCalls().length).toBe(1);
  });

  it("refuses when RunPod /health shows jobs in flight (lost record or foreign job) and releases the lock", async () => {
    runpod.health.jobs.inProgress = 1;
    const res = await gen({ mode: "t2v", prompt: "x" });
    expect(res.status).toBe(409);
    expect(runCalls().length).toBe(0);
    expect(await bucket().get(ACTIVE_KEY)).toBeNull();
    expect(await readUsage(bucket(), utcDate(Date.now()))).toBe(0);
    runpod.health.jobs.inProgress = 0;
    expect((await gen({ mode: "t2v", prompt: "x" })).status).toBe(202);
  });

  it("frees the lock when the stored job is terminal on RunPod", async () => {
    const first = await (await gen({ mode: "t2v", prompt: "one" })).json();
    runpod.jobs.get(first.job_id).status = "COMPLETED";
    runpod.health.jobs.inQueue = 0;
    const second = await gen({ mode: "t2v", prompt: "two" });
    expect(second.status).toBe(202);
  });

  it("replaces a stale reservation (older than ttl plus margin) and a corrupt one", async () => {
    await bucket().put(ACTIVE_KEY, JSON.stringify({ request_id: "old-request", reserved_at: Date.now() - 3 * 3600 * 1000, job_id: "job-xxxxxxxx", state: "submitted" }));
    expect((await gen({ mode: "t2v", prompt: "x" })).status).toBe(202);
    await bucket().put(ACTIVE_KEY, "not json {");
    runpod.health.jobs.inQueue = 0;
    runpod.jobs.forEach((j) => (j.status = "COMPLETED"));
    expect((await gen({ mode: "t2v", prompt: "y" })).status).toBe(202);
  });

  it("keeps the reservation when /run times out or the network fails (ambiguous outcome)", async () => {
    runpod.runMode = "network";
    const res = await gen({ mode: "t2v", prompt: "x" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("unknown_outcome");
    const rec = await (await bucket().get(ACTIVE_KEY)).json();
    expect(rec.state).toBe("unknown");
    expect(await readUsage(bucket(), utcDate(Date.now()))).toBe(1); // not rolled back
    runpod.runMode = "ok";
    expect((await gen({ mode: "t2v", prompt: "again" })).status).toBe(409);
  });

  it("rolls back reservation and count on a definitive 4xx or 5xx from /run, with no raw RunPod body", async () => {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      await clearBucket();
      runpod.runMode = { status, body: { error: "RAW RUNPOD ERROR BODY", key: SECRETS.RUNPOD_API_KEY } };
      const res = await gen({ mode: "t2v", prompt: "x" });
      expect([502, 503], String(status)).toContain(res.status);
      const text = await res.text();
      expect(text).not.toContain("RAW RUNPOD ERROR BODY");
      expect(text).not.toContain(SECRETS.RUNPOD_API_KEY);
      expect(await bucket().get(ACTIVE_KEY)).toBeNull();
      expect(await readUsage(bucket(), utcDate(Date.now()))).toBe(0);
    }
  });

  it("gives a paused-endpoint hint for a refused job", async () => {
    runpod.runMode = { status: 409, body: {} };
    const j = await (await gen({ mode: "t2v", prompt: "x" })).json();
    expect(j.error).toBe("gpu_refused");
    expect(j.message).toContain("apply.sh endpoint");
  });
});

describe("daily cap", () => {
  const env = makeEnv({ DAILY_CAP: "2" });
  const finishAll = () => {
    runpod.jobs.forEach((j) => (j.status = "COMPLETED"));
    runpod.health.jobs.inQueue = 0;
  };

  it("refuses the attempt after the cap with 429 and the reset time; failed jobs count", async () => {
    expect((await gen({ mode: "t2v", prompt: "1" }, env)).status).toBe(202);
    finishAll();
    runpod.jobs.forEach((j) => (j.status = "FAILED")); // a failed job still counts
    expect((await gen({ mode: "t2v", prompt: "2" }, env)).status).toBe(202);
    finishAll();
    const third = await gen({ mode: "t2v", prompt: "3" }, env);
    expect(third.status).toBe(429);
    const j = await third.json();
    expect(j.error).toBe("daily_cap");
    expect(new Date(j.resets_at).getUTCHours()).toBe(0);
    expect(runCalls().length).toBe(2);
  });

  it("defaults to 30 when the var is absent or garbage", async () => {
    const state = await (await send("/api/state", { env: makeEnv({ DAILY_CAP: "garbage" }) })).json();
    expect(state.usage.cap).toBe(30);
    expect((await (await send("/api/state")).json()).usage.cap).toBe(30);
  });

  it("the CAS counter never exceeds the cap under concurrent increments and never goes below zero", async () => {
    const date = "2026-01-01";
    const results = await Promise.all(Array.from({ length: 8 }, () => bumpUsage(bucket(), date, +1, 3)));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(await readUsage(bucket(), date)).toBe(3);
    await Promise.all(Array.from({ length: 8 }, () => bumpUsage(bucket(), date, -1, 3)));
    expect(await readUsage(bucket(), date)).toBe(0);
  });
});

describe("secrets", () => {
  it("never appear in any response or log line", async () => {
    const logs = [];
    for (const m of ["log", "warn", "error", "info", "debug"]) {
      vi.spyOn(console, m).mockImplementation((...a) => logs.push(a.map(String).join(" ")));
    }
    const texts = [];
    for (const res of [
      await send("/api/state"),
      await gen({ mode: "t2v", prompt: "x" }),
      await gen({ mode: "t2v", prompt: "x" }),
      await gen({ mode: "t2v" }),
      await send("/api/state", { jwt: "" }),
    ]) texts.push(await res.text(), JSON.stringify([...res.headers]));
    runpod.runMode = { status: 500, body: { leak: SECRETS.RUNPOD_API_KEY } };
    await clearBucket();
    texts.push(await (await gen({ mode: "t2v", prompt: "x" })).text());
    const all = texts.join("\n") + logs.join("\n");
    for (const v of [SECRETS.RUNPOD_API_KEY, SECRETS.RUNPOD_ENDPOINT_ID, "ken@example.test", "fake-team.cloudflareaccess", "test-aud-0123456789abcdef"]) {
      expect(all, v).not.toContain(v);
    }
  });
});

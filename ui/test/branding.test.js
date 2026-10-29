import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env as testEnv } from "cloudflare:test";
import { installFakes, send, makeEnv, clearBucket } from "./helpers.js";
import indexHtml from "../static/index.html?raw";
import appJs from "../static/app.js?raw";

beforeEach(async () => {
  installFakes();
  await clearBucket();
});
afterEach(() => vi.restoreAllMocks());

// An ASSETS stand-in that has brand.jpg, so the auth ordering can be tested with the file present.
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const withBrand = () =>
  makeEnv({
    ASSETS: {
      fetch: async (r) =>
        new URL(r.url).pathname === "/brand.jpg"
          ? new Response(JPG, { headers: { "Content-Type": "image/jpeg" } })
          : new Response("not found", { status: 404 }),
    },
  });
const withoutBrand = () => makeEnv({ ASSETS: { fetch: async () => new Response("not found", { status: 404 }) } });

describe("brand photo", () => {
  it("is served only after the Access JWT check", async () => {
    const ok = await send("/brand.jpg", { env: withBrand() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/jpeg");
    expect(ok.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
    const denied = await send("/brand.jpg", { env: withBrand(), jwt: "" });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("");
    const forged = await send("/brand.jpg", { env: withBrand(), jwt: "not.a.jwt" });
    expect(forged.status).toBe(403);
    const unconfigured = await send("/brand.jpg", { env: makeEnv({ ...withBrand(), TEAM_DOMAIN: "" }) });
    expect(unconfigured.status).toBe(503);
  });

  it("a missing brand.jpg gives the normal not-found behaviour (and still needs a JWT)", async () => {
    expect((await send("/brand.jpg", { env: withoutBrand() })).status).toBe(404);
    expect((await send("/brand.jpg", { env: withoutBrand(), jwt: "" })).status).toBe(403);
  });

  it("the real asset binding answers 200 image/jpeg when the optional file exists, else 404", async () => {
    if (!testEnv.ASSETS) return; // binding not provided by this pool version
    const res = await send("/brand.jpg", { env: makeEnv({ ASSETS: testEnv.ASSETS }) });
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(res.headers.get("Content-Type")).toContain("image/jpeg");
  });

  it("the page has the masthead with the optional hidden image and no inline handlers", () => {
    expect(indexHtml).toContain("<title>JubiVidia</title>");
    expect(indexHtml).toMatch(/<img id="brand-img"[^>]*src="brand\.jpg"[^>]*width="\d+"[^>]*height="\d+"[^>]*hidden/);
    expect(indexHtml).toContain("JubiVidia</p>");
    expect(indexHtml).toContain("Short videos from words, photos and clips.");
    expect(indexHtml).not.toMatch(/\son(load|error)\s*=/i);
    expect(appJs).toContain('addEventListener("load"');
    expect(appJs).toContain('addEventListener("error"');
  });

  it("no personal source path or file name appears in the page code", () => {
    for (const text of [indexHtml, appJs]) expect(text).not.toMatch(/WhatsApp|Zone\.Identifier|jubividia-samples/i);
  });
});

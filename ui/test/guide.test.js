import { describe, it, expect } from "vitest";
import indexHtml from "../static/index.html?raw";
import appJs from "../static/app.js?raw";
import { checkHtml, ALLOWED_ANCHOR_HOSTS } from "../scripts/static-rules.mjs";

describe("prompt guide markup", () => {
  it("has the nudge above the prompt box and the details block right under it", () => {
    const nudge = indexHtml.indexOf("New here? Open the prompt guide below: a good prompt matters more than any setting.");
    const label = indexHtml.indexOf('<label for="prompt"');
    const area = indexHtml.indexOf('<textarea id="prompt"');
    const guide = indexHtml.indexOf('<details id="prompt-guide"');
    expect(nudge).toBeGreaterThan(-1);
    expect(nudge).toBeLessThan(label);
    expect(area).toBeLessThan(guide);
    expect(indexHtml).toContain("<summary>Prompt guide for beginners</summary>");
    expect(indexHtml).toContain('id="guide-examples"');
  });

  it("explains the five parts and the rules of thumb", () => {
    for (const s of ["Main action first", "How it moves", "Who and where", "Camera and light", "Sound.", "present tense", "Image mode", "Video continue mode", "repeats the last second", "reuse the seed", "Fast 640x384", "1280x704", "readable text, logos and crowds"]) {
      expect(indexHtml, s).toContain(s);
    }
  });

  it("lists exactly the five reading links, all opened safely", () => {
    const anchors = [...indexHtml.matchAll(/<a\b[^>]*href="https:[^>]*>/g)].map((m) => m[0]);
    expect(anchors.length).toBe(5);
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    for (const u of [
      "https://ltx.io/blog/prompting-guide-for-ltx-2",
      "https://fal.ai/learn/tools/how-to-use-ltx-2-5",
      "https://deapi.ai/blog/ltx-2-5-prompting-guide-multi-shot-scenes-native-audio-and-prompts-that-actually-cut",
      "https://ltxworkflow.com/resources/tutorials/ltx-23-prompting-guide",
      "https://docs.comfy.org/es/tutorials/video/ltx/ltx-2",
    ]) expect(indexHtml).toContain(`href="${u}"`);
    expect(indexHtml).toContain("The official LTX guide");
  });
});

describe("examples and wiring", () => {
  const EX = {
    t2v: [
      "A red fox trots through fresh snow at sunrise, breath steaming in the cold air. The camera tracks slowly alongside at ground level. Soft golden light through bare trees. Quiet crunching footsteps in snow and distant birdsong.",
      "Rain falls on a quiet city street at night, neon signs reflecting in the puddles. A man in a yellow raincoat walks toward the camera under an umbrella, slow handheld shot. The patter of rain, a distant siren, and his footsteps splashing.",
      "A cozy kitchen at dawn. A kettle comes to a boil on the stove and steam curls upward. Static camera, warm window light. The kettle whistles softly, with a clock ticking in the background.",
    ],
    i2v: ["The cat blinks slowly, then stretches and yawns, tail flicking. The camera pushes in gently. Calm, warm room light. Soft purring and a faint rustle of fabric."],
    v2v: ["The dog keeps running across the field, then slows and turns toward the camera, tail wagging. Same bright sunny light. Panting and grass rustling."],
  };

  it("contains every example, grouped by mode", () => {
    for (const [mode, list] of Object.entries(EX)) {
      const block = new RegExp(`${mode}: \\[([\\s\\S]*?)\\n  \\],`).exec(appJs);
      expect(block, mode).not.toBeNull();
      for (const text of list) expect(block[1], mode).toContain(text);
    }
  });

  it("fills the prompt box with .value, switches mode when needed, shows the current mode first, never innerHTML", () => {
    expect(appJs).toContain('$("prompt").value = text');
    expect(appJs).toContain('text: "Use this prompt"');
    expect(appJs).toContain("[S.mode, ...");
    expect(appJs).toContain("setMode(mode)");
    expect(appJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    expect(appJs).toContain('addEventListener("click", () => useExample(mode, text))');
  });

  it("opens the guide on the first visit only, with storage wrapped in try/catch and no cookies", () => {
    expect(appJs).toContain('recall(GUIDE_SEEN_KEY) === null');
    expect(appJs).toContain('$("prompt-guide").open = true');
    expect(appJs).toContain('store(GUIDE_SEEN_KEY, "1")');
    expect(appJs).toMatch(/function store[\s\S]*?try \{[\s\S]*?catch/);
    expect(appJs).toMatch(/function recall[\s\S]*?try \{[\s\S]*?catch/);
    expect(appJs).not.toMatch(/document\.cookie/);
  });

  it("does not mention the owner or the photo in the example text", () => {
    expect(appJs + indexHtml).not.toMatch(/WhatsApp|Zone\.Identifier|jubividia-samples/i);
  });
});

describe("delete UI wiring", () => {
  it("has a confirm dialog with shared-gallery wording and Cancel/Delete, and buttons on cards and the result", () => {
    expect(indexHtml).toContain('<dialog id="confirm-delete"');
    expect(indexHtml).toContain("Delete this clip permanently? The video, thumbnail and details are removed for both users (shared gallery). This can't be undone.");
    expect(indexHtml).toContain('id="confirm-cancel"');
    expect(indexHtml).toContain('id="confirm-ok"');
    expect(indexHtml).toContain('id="delete-result"');
    expect(appJs).toContain('text: "Delete"');
    expect(appJs).toContain('method: "DELETE"');
    expect(appJs).toContain('"X-Jubividia": "1"');
    expect(appJs).toContain("showModal");
    expect(appJs).toMatch(/v\.pause\(\);[\s\S]*?removeAttribute\("src"\)[\s\S]*?show\(\$\("result"\), false\)/);
  });
});

describe("static rules: external URLs", () => {
  const page = (body) => `<!doctype html><html><head><title>x</title><script type="module" src="app.js"></script></head><body>${body}</body></html>`;
  const A = (href, extra = 'target="_blank" rel="noopener noreferrer"') => `<a href="${href}" ${extra}>l</a>`;

  it("passes the real page", () => {
    expect(checkHtml(indexHtml)).toEqual([]);
  });

  it("accepts each allowlisted host as an anchor", () => {
    for (const h of ALLOWED_ANCHOR_HOSTS) expect(checkHtml(page(A(`https://${h}/x`))), h).toEqual([]);
  });

  it("rejects an anchor to any other host, other schemes and look-alike hosts", () => {
    for (const href of ["https://evil.example/x", "http://ltx.io/x", "https://ltx.io.evil.example/x", "https://evil.example/ltx.io", "//evil.example/x", "https://user@evil.example/", "https://notltx.io/", "https://sub.ltx.io/"]) {
      expect(checkHtml(page(A(href))).length, href).toBeGreaterThan(0);
    }
  });

  it("requires target=_blank and rel=noopener noreferrer on allowed anchors", () => {
    expect(checkHtml(page(A("https://ltx.io/x", ""))).length).toBeGreaterThan(0);
    expect(checkHtml(page(A("https://ltx.io/x", 'target="_blank" rel="noopener"'))).length).toBeGreaterThan(0);
    expect(checkHtml(page(A("https://ltx.io/x", 'rel="noopener noreferrer"'))).length).toBeGreaterThan(0);
  });

  it("still rejects every other kind of external reference, inline script, inline style and handlers", () => {
    for (const body of [
      '<script src="https://ltx.io/a.js"></script>',
      '<link rel="stylesheet" href="https://ltx.io/a.css">',
      '<img src="https://ltx.io/a.png" alt="">',
      '<video src="//ltx.io/a.mp4"></video>',
      '<iframe src="https://ltx.io/"></iframe>',
      '<form action="https://ltx.io/post"></form>',
      "<p>see https://ltx.io/blog</p>",
      "<script>alert(1)</script>",
      '<p style="color:red">x</p>',
      '<button onclick="x()">x</button>',
      '<img src="x" onerror="x()">',
    ]) expect(checkHtml(page(body)).length, body).toBeGreaterThan(0);
  });
});

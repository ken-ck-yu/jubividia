import { describe, it, expect } from "vitest";
import { checkHtml, checkCss } from "../scripts/static-rules.mjs";

// B1: any URL whose scheme is not http(s) (or a relative/fragment link) is rejected, however it is dressed.
const page = (body) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;
const bad = (name, body) => expect(checkHtml(page(body)).length, name).toBeGreaterThan(0);

describe("static rules: hostile and tricky URL forms", () => {
  it("rejects the three snippets the validator found", () => {
    bad("javascript:", '<a href="javascript:alert(1)">x</a>');
    bad("mixed case", '<a href="JaVaScRiPt:alert(1)">x</a>');
    bad("tab inside the scheme", '<a href="java\tscript:alert(1)">x</a>');
  });

  it("rejects non-http(s) schemes in every URL-bearing attribute, however they are dressed", () => {
    const forms = [
      '<a href="vbscript:x">x</a>',
      '<a href="data:text/html,<b>x</b>">x</a>',
      '<a href=" javascript:alert(1)">x</a>',
      '<a href="\n\rjavascript:alert(1)">x</a>',
      '<a href="java\nscript:alert(1)">x</a>',
      '<a href="java\r\nscript:alert(1)">x</a>',
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="&#x6A;avascript:alert(1)">x</a>',
      '<a href="javascript&colon;alert(1)">x</a>',
      '<a href="java&Tab;script:alert(1)">x</a>',
      "<a href='javascript:alert(1)'>x</a>",
      "<a href=javascript:alert(1)>x</a>",
      '<a HREF="JAVASCRIPT:alert(1)">x</a>',
      '<a href = "javascript:alert(1)">x</a>',
      '<a href="\u0001javascript:alert(1)">x</a>',
      '<a href="file:///etc/passwd">x</a>',
      '<a href="blob:https://x/y">x</a>',
      '<a href="ftp://ltx.io/x">x</a>',
      '<a href="https://ltx.io:8443@evil.example/">x</a>',
      '<img src="data:image/png;base64,AAAA" alt="">',
      '<img src="javascript:alert(1)" alt="">',
      '<video poster="data:image/png;base64,AAAA"></video>',
      '<video src="blob:x"></video>',
      '<form action="javascript:alert(1)"></form>',
      '<button formaction="javascript:alert(1)">x</button>',
      '<a xlink:href="javascript:alert(1)">x</a>',
      '<a href="#x" ping="https://ltx.io/p">x</a>',
      '<img srcset="data:image/png;base64,AAAA 1x" alt="">',
      '<img srcset="a.png 1x, https://evil.example/b.png 2x" alt="">',
      '<object data="data:text/html,x"></object>',
      '<iframe srcdoc="x"></iframe>',
      '<base href="https://evil.example/">',
      '<meta http-equiv="refresh" content="0;url=https://evil.example/">',
      '<meta http-equiv="Refresh" content="0;url=javascript:alert(1)">',
    ];
    for (const f of forms) bad(f, f);
  });

  it("still accepts relative, absolute-path and fragment URLs", () => {
    for (const ok of [
      '<a href="#top">x</a>',
      '<a href="/api/state">x</a>',
      '<a href="page.html?x=1">x</a>',
      '<img src="brand.jpg" alt="">',
      '<video poster="/api/outputs/a.jpg" src="a.mp4"></video>',
      '<link rel="stylesheet" href="style.css">',
    ]) expect(checkHtml(page(ok)), ok).toEqual([]);
  });

  it("allowlisted https anchors with target and rel stay fine, but only on <a>", () => {
    const a = (h) => `<a href="${h}" target="_blank" rel="noopener noreferrer">x</a>`;
    expect(checkHtml(page(a("https://docs.comfy.org/es/tutorials/video/ltx/ltx-2")))).toEqual([]);
    expect(checkHtml(page(a("HTTPS://LTX.IO/blog"))), "scheme and host case").toEqual([]);
    expect(checkHtml(page(a("ht\ttps://ltx.io/x"))), "a tab a browser would drop").toEqual([]);
    bad("link tag", '<link rel="stylesheet" href="https://ltx.io/a.css">');
    bad("area", '<area href="https://ltx.io/x">');
  });

  it("CSS: any url() with a scheme or host, @import and escaped urls are rejected", () => {
    expect(checkCss("a{background:url(brand.jpg)} b{background:url('/x.png')} c{background:url(\"#frag\")}")).toEqual([]);
    for (const css of [
      "a{background:url(https://evil.example/x.png)}",
      "a{background:url('//evil.example/x.png')}",
      'a{background:url("data:image/png;base64,AAAA")}',
      "a{background:url(javascript:alert(1))}",
      "a{background:url( JaVa\tScRiPt:alert(1) )}",
      "a{background:url(\\6a avascript:alert(1))}",
      '@import "https://evil.example/x.css";',
    ]) expect(checkCss(css).length, css).toBeGreaterThan(0);
  });
});

// Pure string rules for index.html, shared by check-static.mjs (Node) and the Vitest suite.
// The only external URLs allowed in the page are <a href> links to this exact host allowlist,
// opened with target="_blank" rel="noopener noreferrer". Every other external reference
// (script, stylesheet, img, video, iframe, form, anything in an attribute or text) fails.
export const ALLOWED_ANCHOR_HOSTS = ["ltx.io", "fal.ai", "deapi.ai", "ltxworkflow.com", "docs.comfy.org"];

export function checkHtml(html) {
  const failures = [];
  if (/\son[a-z]+\s*=/i.test(html)) failures.push("index.html: inline event handler attribute");
  if (/\sstyle\s*=/i.test(html)) failures.push("index.html: inline style attribute");
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) failures.push("index.html: inline <script>");

  let rest = html;
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /\shref\s*=\s*"([^"]*)"/i.exec(tag);
    if (!href || !/^(https?:)?\/\//i.test(href[1])) continue; // local anchors are fine
    let host = "";
    let protocol = "";
    try {
      const u = new URL(href[1]);
      host = u.hostname;
      protocol = u.protocol;
    } catch {
      /* falls through to the failure below */
    }
    if (protocol !== "https:" || !ALLOWED_ANCHOR_HOSTS.includes(host)) {
      failures.push(`index.html: external anchor to a host that is not allowed: ${href[1].slice(0, 60)}`);
    } else if (!/\starget\s*=\s*"_blank"/i.test(tag) || !/\srel\s*=\s*"[^"]*noopener[^"]*"/i.test(tag) || !/\srel\s*=\s*"[^"]*noreferrer[^"]*"/i.test(tag)) {
      failures.push(`index.html: external anchor must have target="_blank" rel="noopener noreferrer": ${host}`);
    }
    rest = rest.replace(tag, "<a>"); // allowed (or already reported): not an "other" external reference
  }
  if (/(?:https?:)?\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(rest.replace(/<!doctype[^>]*>/i, ""))) {
    failures.push("index.html: external resource or non-anchor external URL");
  }
  return failures;
}

// Pure string rules for index.html and style.css, shared by check-static.mjs (Node) and the Vitest suite.
//
// Rules for URLs in the page:
//  - the only external URLs are <a href> links to this exact host allowlist (https only),
//    opened with target="_blank" rel="noopener noreferrer";
//  - every other URL-bearing attribute (src, action, formaction, poster, srcset, xlink:href, ping, data,
//    cite, background, ...) and every CSS url() must be relative or a fragment: ANY scheme
//    (javascript:, data:, vbscript:, https: ...) is rejected, as is a protocol-relative //host;
//  - schemes are judged the way a browser reads them: leading control characters and spaces are
//    stripped and tab, CR and LF are removed anywhere in the value, case is ignored, and an
//    entity-encoded value (&#106;, &colon;, &Tab;, ...) is rejected outright.
export const ALLOWED_ANCHOR_HOSTS = ["ltx.io", "fal.ai", "deapi.ai", "ltxworkflow.com", "docs.comfy.org"];

const URL_ATTRS = new Set([
  "href", "src", "action", "formaction", "poster", "srcset", "xlink:href", "ping", "data", "cite", "background",
  "longdesc", "manifest", "codebase", "usemap", "profile", "icon", "lowsrc", "dynsrc", "archive",
]);
const BANNED_TAGS = /<\s*(iframe|object|embed|frame|frameset|base|applet|portal)\b/i;

/** The way a browser reads a URL value before looking at its scheme. */
export function normalizeUrl(v) {
  // eslint-disable-next-line no-control-regex
  return v.replace(/^[\u0000- ]+/, "").replace(/[\t\r\n]/g, "").replace(/[\u0000- ]+$/, "");
}

const hasEntity = (v) => /&(#x?[0-9a-f]+|colon|tab|newline|sol|lpar|rpar|apos|quot|amp|lt|gt)\b;?/i.test(v);
const schemeOf = (n) => {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(n);
  return m ? m[1].toLowerCase() : null;
};
const isExternalish = (n) => schemeOf(n) !== null || n.startsWith("//") || n.startsWith("\\\\") || n.startsWith("/\\");

function attrsOf(tag) {
  const out = [];
  const re = /([^\s"'<>/=]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<\s*[a-z0-9-]+/i, "").replace(/\/?>$/, "");
  for (const m of body.matchAll(re)) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""]);
  return out;
}

export function checkHtml(html) {
  const failures = [];
  if (/\son[a-z]+\s*=/i.test(html)) failures.push("index.html: inline event handler attribute");
  if (/\sstyle\s*=/i.test(html)) failures.push("index.html: inline style attribute");
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(html)) failures.push("index.html: inline <script>");
  if (BANNED_TAGS.test(html)) failures.push("index.html: iframe, object, embed, base or similar tag");

  let rest = html;
  // quote-aware: a ">" inside a quoted attribute value does not end the tag
  for (const m of html.matchAll(/<[a-z](?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const tag = m[0];
    const name = /^<\s*([a-z0-9-]+)/i.exec(tag)[1].toLowerCase();
    const attrs = attrsOf(tag);
    if (name === "meta" && attrs.some(([k, v]) => k === "http-equiv" && /refresh/i.test(normalizeUrl(v)))) {
      failures.push("index.html: meta refresh is not allowed");
    }
    let anchorOk = false;
    for (const [k, raw] of attrs) {
      if (!URL_ATTRS.has(k)) continue;
      if (hasEntity(raw)) {
        failures.push(`index.html: entity-encoded URL in ${k}`);
        continue;
      }
      const n = normalizeUrl(raw);
      if (k === "srcset") {
        if (/:|\/\//.test(n)) failures.push("index.html: srcset must hold relative URLs only");
        continue;
      }
      if (!isExternalish(n)) continue; // relative, absolute path or fragment
      if (name === "a" && k === "href") {
        let host = "";
        let protocol = "";
        try {
          const u = new URL(n);
          host = u.hostname;
          protocol = u.protocol;
        } catch {
          /* reported below */
        }
        if (protocol !== "https:" || !ALLOWED_ANCHOR_HOSTS.includes(host)) {
          failures.push(`index.html: anchor href is not an allowed https host (scheme ${schemeOf(n) ?? "none"}): ${n.slice(0, 40)}`);
        } else if (!/\starget\s*=\s*"_blank"/i.test(tag) || !/\srel\s*=\s*"[^"]*noopener[^"]*"/i.test(tag) || !/\srel\s*=\s*"[^"]*noreferrer[^"]*"/i.test(tag)) {
          failures.push(`index.html: external anchor must have target="_blank" rel="noopener noreferrer": ${host}`);
        } else anchorOk = true;
      } else {
        failures.push(`index.html: ${name} ${k} must be a relative URL (found ${schemeOf(n) ?? "a protocol-relative URL"})`);
      }
    }
    if (anchorOk) rest = rest.replace(tag, "<a>");
  }
  // anything URL-shaped left over (text, other attributes) is an unexpected external reference
  if (/(?:https?:)?\/\/[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(rest.replace(/<!doctype[^>]*>/i, ""))) {
    failures.push("index.html: external resource or non-anchor external URL");
  }
  return failures;
}

export function checkCss(css) {
  const failures = [];
  if (/@import/i.test(css)) failures.push("style.css: @import");
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    if (/\\/.test(raw) || hasEntity(raw)) failures.push("style.css: escaped url()");
    else if (isExternalish(normalizeUrl(raw))) failures.push(`style.css: url() with a scheme or host: ${raw.slice(0, 40)}`);
  }
  return failures;
}

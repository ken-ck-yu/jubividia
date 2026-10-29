// Source-level guards for the page and the Worker (run by `npm test`, no network, no browser).
// Fails when the front end could render server data as markup, runs inline or remote code, or
// mentions a secret name.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { checkHtml, checkCss } from "./static-rules.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const list = (d) => readdirSync(join(root, d)).map((f) => join(d, f));

// brand.jpg is the one optional, git-ignored, binary file (a personal photo; see README "Personalising the page").
const KNOWN_STATIC = ["static/index.html", "static/app.js", "static/style.css", "static/calc.js"];
const OPTIONAL_BINARY = "static/brand.jpg";
const allStatic = list("static");
const staticFiles = allStatic.filter((f) => f !== OPTIONAL_BINARY);
const srcFiles = list("src");
const failures = [];

for (const f of staticFiles) if (!KNOWN_STATIC.includes(f)) failures.push(`${f}: unexpected file in static/`);
for (const f of KNOWN_STATIC) if (!staticFiles.includes(f)) failures.push(`${f}: missing`);
try {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "--", "static"], { encoding: "utf8" });
  if (/brand\.jpg/.test(tracked)) failures.push("static/brand.jpg is tracked by git: it must stay git-ignored");
} catch {
  /* not a git checkout: skip */
}

// No personal photo or image of any kind may be tracked, and no source path of one may be mentioned.
try {
  const all = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }).split("\n");
  const imgs = all.filter((f) => /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(f));
  if (imgs.length) failures.push(`tracked image files: ${imgs.join(", ")}`);
  const html0 = read("static/index.html") + read("static/app.js") + read("static/style.css");
  if (/WhatsApp|Zone\.Identifier|jubividia-samples/i.test(html0)) failures.push("static files mention a personal photo source");
} catch {
  /* not a git checkout: skip */
}

const STATIC_FORBIDDEN = [
  [/\binnerHTML\b/, "innerHTML"],
  [/\bouterHTML\b/, "outerHTML"],
  [/\binsertAdjacentHTML\b/, "insertAdjacentHTML"],
  [/\bdocument\.write\b/, "document.write"],
  [/\beval\s*\(/, "eval("],
  [/\bnew\s+Function\b/, "new Function"],
  [/setAttribute\(\s*["']style["']/, 'setAttribute("style")'],
  [/\bsetTimeout\(\s*["'`]/, "setTimeout with a string"],
  [/\.srcdoc\b/, "srcdoc"],
  [/\bimportScripts\b/, "importScripts"],
];
for (const f of staticFiles) {
  const text = read(f);
  for (const [re, name] of STATIC_FORBIDDEN) if (re.test(text)) failures.push(`${f}: uses ${name}`);
  if (/RUNPOD_|ALLOWED_EMAIL|TEAM_DOMAIN|POLICY_AUD|CLOUDFLARE_API_TOKEN|api\.runpod/.test(text)) {
    failures.push(`${f}: mentions a secret name or the RunPod host`);
  }
}
const html = read("static/index.html");
failures.push(...checkHtml(html)); // inline handlers/styles/scripts; only allowlisted external <a href> links
failures.push(...checkCss(read("static/style.css")));
if (/(?<![A-Za-z.])(?:https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(read("static/app.js").replace(/\/\/ .*$/gm, "")) ) {
  failures.push("app.js: contains an absolute URL");
}
for (const f of srcFiles) {
  const text = read(f);
  if (/\beval\s*\(|new\s+Function\b/.test(text)) failures.push(`${f}: eval or new Function`);
  if (/console\.(log|info|warn|error|debug)\(/.test(text) && f !== "src/util.js") failures.push(`${f}: console output outside util.log()`);
  if (/access-control-allow/i.test(text)) failures.push(`${f}: sets a CORS header`);
}
// the production code has one auth path and no escape hatch
for (const f of srcFiles) {
  if (/bypass|skipAuth|DEV_MODE|DISABLE_AUTH/i.test(read(f))) failures.push(`${f}: looks like an auth bypass`);
}
const toml = read("wrangler.toml");
if (!/^preview_urls\s*=\s*false\s*$/m.test(toml)) failures.push("wrangler.toml: preview_urls must be false");
if (!/^workers_dev\s*=\s*true\s*$/m.test(toml)) failures.push("wrangler.toml: workers_dev must be true");
if (!/^run_worker_first\s*=\s*true\s*$/m.test(toml)) failures.push("wrangler.toml: run_worker_first must be true");
if (!/^name\s*=\s*"jubividia"\s*$/m.test(toml)) failures.push('wrangler.toml: name must be "jubividia"');
if (!/bucket_name\s*=\s*"jubividia-ltx-eu"/.test(toml)) failures.push("wrangler.toml: wrong bucket");
if (/jubilab/i.test(toml + staticFiles.map(read).join("") + srcFiles.map(read).join(""))) {
  failures.push("the other Worker's name appears in ui/ code");
}

if (failures.length) {
  console.error("check-static FAILED:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`check-static ok (${staticFiles.length} static, ${srcFiles.length} src files)`);

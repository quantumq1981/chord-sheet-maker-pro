/**
 * Deploy asset guard.
 *
 * GitHub Pages serves the Vite `dist/` build. Root JS files (renderer.js,
 * importGuitarPro.js, powerTabImporter.js, …) are NOT part of the Vite bundle —
 * they're copied into dist/ by a hand-maintained list in the deploy workflow.
 * If a new root script is wired into a page but forgotten in that copy list, it
 * 404s in production and the feature silently breaks (see PR #279, where every
 * .ptb import appeared broken because powerTabImporter.js wasn't deployed).
 *
 * This guard runs after the copy step and fails the build if any deployed HTML
 * page references a local (non-CDN, non-Vite-bundled) script that isn't present
 * in dist/. CDN URLs (http/https) and absolute Vite asset paths (/…) are
 * bundled or external and therefore skipped.
 *
 * Usage: node scripts/verify-deploy-assets.mjs [distDir]   (default: dist)
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const distDir = process.argv[2] || 'dist';

if (!existsSync(distDir)) {
  console.error(`verify-deploy-assets: "${distDir}" does not exist — run the build + copy first.`);
  process.exit(1);
}

const htmlFiles = readdirSync(distDir).filter((f) => f.endsWith('.html'));
if (htmlFiles.length === 0) {
  console.error(`verify-deploy-assets: no .html entry points found in "${distDir}".`);
  process.exit(1);
}

const SRC_RE = /<script\b[^>]*\bsrc=["']([^"']+)["']/gi;
// Stylesheets 404 just as silently as scripts, and a missing one takes the whole
// layout with it — so <link rel=stylesheet> is checked by the same rule. Matched in
// two steps because rel and href appear in either order in real markup.
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const linkStylesheetHref = (tag) =>
  /\brel=["']?stylesheet["']?/i.test(tag) ? (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1] : undefined;
// Relative dynamic-import specifiers inside a local script. Only string literals
// are followable; a computed specifier is out of scope by construction.
const DYNAMIC_IMPORT_RE = /\bimport\(\s*["'](\.[^"']+)["']\s*\)/g;
const dynamicImports = (source) => {
  const out = [];
  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = DYNAMIC_IMPORT_RE.exec(source)) !== null) out.push(m[1]);
  return out;
};

const missing = [];
let checked = 0;

for (const html of htmlFiles) {
  const src = readFileSync(join(distDir, html), 'utf8');
  const refs = [];
  SRC_RE.lastIndex = 0;
  let m;
  while ((m = SRC_RE.exec(src)) !== null) refs.push(m[1]);
  LINK_TAG_RE.lastIndex = 0;
  while ((m = LINK_TAG_RE.exec(src)) !== null) {
    const href = linkStylesheetHref(m[0]);
    if (href) refs.push(href);
  }

  {
    for (const ref of refs) {
      // External (CDN) or Vite-bundled absolute asset — not our responsibility.
      if (/^https?:\/\//i.test(ref) || ref.startsWith('//') || ref.startsWith('/')) continue;
      checked++;
      const target = join(distDir, dirname(html), ref);
      if (!existsSync(target)) {
        missing.push(`${html} references "${ref}" — not found at ${target}`);
        continue;
      }
      // A script tag is not the only way a page pulls in code. recognitionBridge.js
      // reaches the recognition engine with a dynamic import(), which no <script src>
      // scan can see — so the engine could be dropped from the copy list and only
      // fail in production, on the first Guitar Pro import. Follow those specifiers.
      for (const spec of dynamicImports(readFileSync(target, 'utf8'))) {
        checked++;
        const dep = join(distDir, dirname(html), dirname(ref), spec);
        if (!existsSync(dep)) {
          missing.push(`${ref} dynamically imports "${spec}" — not found at ${dep}`);
        }
      }
    }
  }
}

if (missing.length > 0) {
  console.error('verify-deploy-assets: the deploy would 404 on these local assets:\n');
  for (const line of missing) console.error('  ✗ ' + line);
  console.error(
    '\nAdd the missing file(s) to the "Copy static root files into dist" step in .github/workflows/ci.yml.'
  );
  process.exit(1);
}

console.log(
  `verify-deploy-assets: OK — ${checked} local asset reference(s) across ${htmlFiles.length} page(s) all present in ${distDir}/.`
);

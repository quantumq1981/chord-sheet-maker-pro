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
const missing = [];
let checked = 0;

for (const html of htmlFiles) {
  const src = readFileSync(join(distDir, html), 'utf8');
  let m;
  while ((m = SRC_RE.exec(src)) !== null) {
    const ref = m[1];
    // External (CDN) or Vite-bundled absolute asset — not our responsibility.
    if (/^https?:\/\//i.test(ref) || ref.startsWith('//') || ref.startsWith('/')) continue;
    checked++;
    const target = join(distDir, dirname(html), ref);
    if (!existsSync(target)) missing.push(`${html} references "${ref}" — not found at ${target}`);
  }
}

if (missing.length > 0) {
  console.error('verify-deploy-assets: the deploy would 404 on these local scripts:\n');
  for (const line of missing) console.error('  ✗ ' + line);
  console.error(
    '\nAdd the missing file(s) to the "Copy static root files into dist" step in .github/workflows/ci.yml.'
  );
  process.exit(1);
}

console.log(
  `verify-deploy-assets: OK — ${checked} local script reference(s) across ${htmlFiles.length} page(s) all present in ${distDir}/.`
);

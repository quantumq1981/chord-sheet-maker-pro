/*
 * pwa.test.mjs — contract guards for the installable/offline layer.
 *
 * A service worker is the one part of this app that can fail in a way the
 * developer cannot see or debug from a phone: it caches, so a mistake persists
 * across reloads. None of it is unit-testable (it needs a browser), so what is
 * tested here is the set of properties that would make it dangerous if wrong:
 *
 *   - the precache list matches what actually deploys (an asset that ships but
 *     is not cached works online and vanishes offline — a stage-only failure)
 *   - navigation stays network-first, so no deploy can be permanently pinned
 *   - every path is relative, because the app is served from a project subpath
 *   - the manifest is valid and self-consistent with the icons that exist
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));
const indexHtml = read('index.html');
// Line continuations joined so the multi-line `cp` reads as one string.
const ci = read('.github/workflows/ci.yml').replace(/\\\n/g, ' ');

/** The precache array, as the worker actually declares it. */
function precacheList() {
  const m = sw.match(/var PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(m, 'PRECACHE array not found in sw.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** The root files the deploy step copies into dist/. */
function deployedFiles() {
  const m = ci.match(/cp ([^\n]*?) dist\//);
  assert.ok(m, 'cp step not found in ci.yml');
  return m[1].split(/\s+/).filter(Boolean);
}

// ── The precache list vs what actually ships ─────────────────────────────────

test('every precached file is real and is copied into the deploy', () => {
  const deployed = new Set(deployedFiles());
  for (const url of precacheList()) {
    if (url === './') continue; // the navigation root, served as index.html
    const file = url.replace(/^\.\//, '');
    assert.ok(existsSync(join(root, file)), `precached ${file} does not exist`);
    assert.ok(deployed.has(file), `precached ${file} is missing from the deploy cp list`);
  }
});

test('every deployed script is precached — no asset works online but not offline', () => {
  const precached = new Set(precacheList().map((u) => u.replace(/^\.\//, '')));
  // Deliberate exclusions, both of which would be wrong to precache:
  //  - sw.js: the browser fetches and version-checks the worker script itself.
  //    A worker that caches its own script can serve itself back and block its
  //    own update — the exact "stuck on an old build" failure this design avoids.
  //  - the standalone importer pages are separate entry points, not this shell.
  const notShell = new Set(['sw.js', 'ug-txt-importer.html', 'sheet-ocr-importer.html']);
  for (const file of deployedFiles()) {
    if (!/\.(js|mjs|css)$/.test(file)) continue;
    if (notShell.has(file)) continue;
    assert.ok(precached.has(file), `${file} deploys but is not in the sw.js PRECACHE list`);
  }
});

// ── The properties that keep a bad worker from being unrecoverable ───────────

test('navigations are network-first, so a deploy can never be pinned by the cache', () => {
  // The single most important property here. If this inverts to cache-first, a
  // user can be stuck on an old build with no way to clear it from a phone.
  const navBlock = sw.slice(sw.indexOf("req.mode === 'navigate'"));
  const fetchAt = navBlock.indexOf('fetch(req)');
  const cacheAt = navBlock.indexOf('caches.match');
  assert.ok(fetchAt > -1 && cacheAt > -1, 'navigation handler not found');
  assert.ok(fetchAt < cacheAt, 'navigation must try the network before the cache');
});

test('the worker only ever deletes its own caches', () => {
  assert.match(sw, /indexOf\('csmp-'\) === 0/, 'cache cleanup is scoped to this app prefix');
});

test('only complete same-origin responses are written to the cache', () => {
  // Caching an opaque or error response would serve it back as though it were real.
  assert.match(sw, /response\.status !== 200/);
  assert.match(sw, /response\.type !== 'basic'/);
});

test('every precached path is relative — the app is served from a subpath', () => {
  for (const url of precacheList()) {
    assert.ok(!url.startsWith('/'), `${url} is absolute; it would resolve off the project subpath`);
  }
});

test('registration is feature-detected and its failure is swallowed', () => {
  assert.match(indexHtml, /'serviceWorker' in navigator/);
  const reg = indexHtml.slice(indexHtml.indexOf("navigator.serviceWorker.register('sw.js')"));
  assert.match(reg.slice(0, 200), /\.catch\(/, 'a refused registration must not break boot');
});

// ── Manifest ─────────────────────────────────────────────────────────────────

test('the manifest is installable: relative scope, standalone, 192 + 512 icons', () => {
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), 'an install prompt needs a 192px icon');
  assert.ok(sizes.includes('512x512'), 'and a 512px icon');
  assert.ok(
    manifest.icons.some((i) => i.purpose === 'maskable'),
    'a maskable icon keeps the mark inside Android’s circular crop'
  );
});

test('every icon the manifest names exists and is a real PNG', () => {
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\.\//, '');
    const buf = readFileSync(join(root, file));
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${file} is not a PNG`);
  }
});

test('index.html links the manifest and the iOS icon, which ignores the manifest', () => {
  assert.match(indexHtml, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(indexHtml, /rel="apple-touch-icon"/);
  assert.match(indexHtml, /name="apple-mobile-web-app-capable"/);
});

test('the manifest and icons are copied into the deploy', () => {
  const deployed = new Set(deployedFiles());
  for (const f of ['manifest.webmanifest', 'sw.js', 'apple-touch-icon.png']) {
    assert.ok(deployed.has(f), `${f} is missing from the deploy cp list`);
  }
  for (const icon of manifest.icons) {
    assert.ok(deployed.has(icon.src.replace(/^\.\//, '')), `${icon.src} is not deployed`);
  }
});

/*
 * uiShell.test.mjs — contract guards for the Capture / Prepare / Perform shell.
 *
 * The shell is browser-only glue (visibility + a router), so it cannot be
 * behaviourally tested here. What CAN be checked is the contract the glue
 * depends on, and every item below is a way it has silently broken before or
 * could:
 *
 *   - a data-stage-item naming a stage the router doesn't know → the element
 *     disappears from every stage, because the CSS rule only ever hides
 *   - the nav rendered after the inline <script> that wires it → zero listeners
 *   - a reference left behind to the removed User/Power switch → TypeError on
 *     load, which on this app means a blank page
 *   - ui.css missing from the deploy copy list → 404 in production only
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

const html = read('index.html');
const css = read('ui.css');
const ci = read('.github/workflows/ci.yml');

const STAGES = ['capture', 'prepare', 'perform'];

// ── Nav ──────────────────────────────────────────────────────────────────────

test('stage nav renders exactly the three known destinations', () => {
  const navStages = [...html.matchAll(/<button[^>]*\bdata-stage="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(navStages, STAGES);
});

test('stage nav precedes the inline script that wires it', () => {
  const navAt = html.indexOf('class="stageNav"');
  // The inline app script is the first <script> with no src attribute.
  const scriptAt = html.search(/<script>\s*\n\/\* =+\s*\n\s*Core constants/);
  assert.ok(navAt > 0, 'nav markup present');
  assert.ok(scriptAt > 0, 'inline app script found');
  assert.ok(
    navAt < scriptAt,
    'nav must be parsed before the script that queries it, or it gets no listeners'
  );
});

// ── Stage membership ─────────────────────────────────────────────────────────

test('every data-stage-item names only known stages', () => {
  const values = [...html.matchAll(/data-stage-item="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length > 0, 'at least one element is stage-scoped');
  for (const v of values) {
    for (const s of v.trim().split(/\s+/)) {
      assert.ok(STAGES.includes(s), `unknown stage "${s}" in data-stage-item="${v}"`);
    }
  }
});

test('each stage owns at least one element', () => {
  const values = [...html.matchAll(/data-stage-item="([^"]+)"/g)].map((m) => m[1]).join(' ');
  for (const s of STAGES) {
    assert.ok(values.includes(s), `no element assigned to "${s}"`);
  }
});

test('the chart itself is never stage-scoped', () => {
  // .grid holds the source textarea + preview. Hiding it in any stage would make
  // the app look broken, so it must stay chrome.
  const grid = html.match(/<div class="grid"[^>]*>/);
  assert.ok(grid, '.grid present');
  assert.ok(!grid[0].includes('data-stage-item'), '.grid must remain visible in every stage');
});

// ── CSS contract ─────────────────────────────────────────────────────────────

test('stage rules only hide — they never assign a display value', () => {
  // Forcing a display value on show would flatten flex/grid/inline-flex elements
  // back to block. So every `display` inside a [data-stage-item] rule must be none.
  const rules = [...css.matchAll(/\[data-stage-item[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(rules.length > 0, 'found stage-item rules');
  for (const body of rules) {
    for (const [, value] of body.matchAll(/display:\s*([a-z-]+)/g)) {
      assert.ok(
        value === 'none' || value === 'revert',
        `stage rule sets display:${value} — only none (hide) and revert (print) are allowed`
      );
    }
  }
});

test('every stage has a hide rule', () => {
  for (const s of STAGES) {
    assert.ok(
      css.includes(`body[data-stage='${s}'] [data-stage-item]:not([data-stage-item~='${s}'])`),
      `missing hide rule for ${s}`
    );
  }
});

test('print media un-hides stage content so printing is never stage-dependent', () => {
  const print = css.slice(css.indexOf('@media print'));
  assert.ok(print.includes('display: revert !important'), 'print restores hidden stage items');
  assert.ok(print.includes('.stageNav'), 'nav is hidden in print');
});

// ── The retired User/Power switch ────────────────────────────────────────────

test('no reference survives to the removed mode switch', () => {
  for (const dead of ['modeSwitch', 'labelUser', 'labelPower', 'mode-knob', 'mode-toggle-label']) {
    assert.ok(!html.includes(dead), `stale reference to ${dead}`);
  }
});

test('the Advanced control exists and applyAppMode drives it', () => {
  assert.ok(html.includes('id="btnAdvanced"'), 'Advanced button present');
  assert.ok(html.includes('id="advLabel"'), 'Advanced label present');
  const fn = html.slice(
    html.indexOf('function applyAppMode'),
    html.indexOf('function loadAppMode')
  );
  assert.ok(fn.includes("getElementById('btnAdvanced')"), 'applyAppMode updates the new control');
  assert.ok(fn.includes('power-mode'), 'still drives the body class the .power-only rules use');
});

// ── Per-stage disclosure ─────────────────────────────────────────────────────

test('the Advanced choice is stored per stage, and applyStage re-reads it', () => {
  const apply = html.slice(
    html.indexOf('function applyAppMode'),
    html.indexOf('function loadAppMode')
  );
  assert.ok(
    apply.includes('modeKey(currentStage())'),
    'applyAppMode must write the stage-scoped key, not one global mode'
  );

  const stage = html.slice(html.indexOf('function applyStage'), html.indexOf('function loadStage'));
  assert.ok(
    stage.includes('applyAppMode(loadAppMode())'),
    'switching stage must re-apply that stage’s Advanced state'
  );
  // The lookup keys off data-stage, so the attribute has to be set first.
  assert.ok(
    stage.indexOf("setAttribute('data-stage'") < stage.indexOf('applyAppMode'),
    'data-stage must be set before the mode is re-read'
  );
});

test('a pre-split saved mode still applies', () => {
  const fn = html.slice(
    html.indexOf('function loadAppMode'),
    html.indexOf('function switchToMode')
  );
  assert.ok(fn.includes('MODE_KEY_LEGACY'), 'loadAppMode falls back to the legacy global key');
});

test('the per-stage mode keys are backed up', () => {
  const backup = read('backupRestore.js');
  for (const s of STAGES) {
    assert.ok(backup.includes(`'csmpn_appMode:${s}'`), `csmpn_appMode:${s} missing from backup`);
  }
  assert.ok(backup.includes("'csmpn_stage'"), 'the active stage is backed up too');
});

// ── Advanced tools are split across the stages ───────────────────────────────

test('the advanced tools row is chrome, and each of its groups picks a stage', () => {
  const row = html.slice(
    html.indexOf('toolbar-row toolbar-row--tools'),
    html.indexOf('<div class="tips">')
  );
  const rowTag = row.slice(0, row.indexOf('>'));
  assert.ok(
    !rowTag.includes('data-stage-item'),
    'the row must not be stage-scoped — its groups are, so every stage keeps a tools row'
  );

  const groups = [...row.matchAll(/<div class="toolbar-group"([^>]*)>/g)].map((m) => m[1]);
  assert.ok(groups.length >= STAGES.length, 'one advanced group per stage');
  for (const g of groups) {
    assert.ok(g.includes('data-stage-item'), 'every advanced group declares its stage');
  }
  const owned = groups.join(' ');
  for (const s of STAGES) {
    assert.ok(owned.includes(s), `no advanced tools assigned to "${s}"`);
  }
});

test('pure fake book export is a first-stage output, not an advanced one', () => {
  // The advanced row is .power-only, so anything inside it is hidden until
  // Advanced is switched on. Fake book is the app's headline output — it belongs
  // with the everyday exports.
  const row = html.slice(
    html.indexOf('toolbar-row toolbar-row--tools'),
    html.indexOf('<div class="tips">')
  );
  assert.ok(!row.includes('btnExportFakeBook'), 'fake book export must not sit behind Advanced');
  assert.ok(html.includes('id="btnExportFakeBook"'), 'the button still exists');
});

// ── Stage headings ───────────────────────────────────────────────────────────

test('every stage has a heading, and only its own', () => {
  const heads = [...html.matchAll(/<div class="stageHead" data-stage-item="([a-z]+)">/g)].map(
    (m) => m[1]
  );
  assert.deepEqual(heads, STAGES, 'one heading per stage, in workflow order');
});

test('body.power-mode remains the gate for existing .power-only elements', () => {
  assert.ok(html.includes('body.user-mode .power-only'), 'the power-only rule is untouched');
  assert.ok(html.match(/class="[^"]*power-only/), 'power-only elements still exist');
});

// ── Deploy ───────────────────────────────────────────────────────────────────

test('ui.css ships — it is in the deploy copy list', () => {
  assert.ok(/cp [^\n]*\bui\.css\b/s.test(ci.replace(/\\\n/g, ' ')), 'ui.css in the cp step');
});

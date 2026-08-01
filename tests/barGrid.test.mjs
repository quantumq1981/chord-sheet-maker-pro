/*
 * barGrid.test.mjs — fake-book bar column widths.
 *
 * The bug these guard: every bar got `minmax(0, 1fr)`, so a bar holding three
 * chords was allotted exactly as much room as a bar holding one — and because
 * bar content is `white-space:nowrap`, the extra chords did not wrap or shrink,
 * they printed on top of the next bar. On a real Steely Dan "Peg" chart the bar
 * `D7#9_C6/9_G7sus4` ran into the following `E7#9`, rendering as `G7sus4E7#9`.
 *
 * Two properties fix it, and both are tested here:
 *   1. a min-content floor, so a track can never be narrower than its chords
 *   2. weights, so a dense bar claims more of the row's free space
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

/*
 * renderer.js touches browser globals at load, so evaluate just the two pure
 * grid helpers alongside the real bar parser — the point is to drive genuine
 * `parseBarStructures` output, not a hand-built stand-in of it.
 */
function load() {
  const ctx = {
    window: {},
    console,
    module: { exports: {} },
    fbSettings: { barsPerRow: 4, chordAlign: 'left', includeLyrics: true },
  };
  vm.createContext(ctx);
  for (const f of ['utils.js', 'chordTheory.js', 'chordProcessing.js', 'csmpnParser.js']) {
    vm.runInContext(read(f), ctx);
  }
  const src = read('renderer.js');
  const from = src.indexOf('function barGridWeight');
  const to = src.indexOf('function renderBars');
  assert.ok(from > -1 && to > from, 'grid helpers not found in renderer.js');
  vm.runInContext(src.slice(from, to), ctx);
  return ctx;
}

const ctx = load();
const { barGridWeight, buildGridTemplate, tokenizeBars, parseBarStructures } = ctx;
const barsOf = (csmpn) => Array.from(parseBarStructures(tokenizeBars(csmpn)));

// ── Weights ──────────────────────────────────────────────────────────────────

test('a bar claims space in proportion to the chords it holds', () => {
  assert.equal(barGridWeight({ token: 'C9' }), 1);
  assert.equal(barGridWeight({ token: 'D7_D7#9' }), 2);
  assert.equal(barGridWeight({ token: 'D7#9_C6/9_G7sus4' }), 3);
});

test('weight is capped so one dense bar cannot starve the rest of the row', () => {
  // The min-content floor already guarantees it cannot collide, so there is no
  // need to let a six-chord bar take six times its neighbours' width.
  assert.equal(barGridWeight({ token: 'A_B_C_D_E_F' }), 4);
});

test('padding bars and empty tokens still occupy a full share', () => {
  // renderBars pads short rows with `{ token: '' }`; a 0 or NaN weight there
  // would make the grid template invalid.
  for (const empty of [{ token: '' }, { token: '   ' }, {}, null, undefined, '']) {
    assert.equal(barGridWeight(empty), 1);
  }
});

test('weight accepts a plain string bar, as renderMeasure does', () => {
  assert.equal(barGridWeight('D7_D7#9'), 2);
  assert.equal(barGridWeight('C9'), 1);
});

test('a bracketed group counts its chords, not the brackets', () => {
  // chordsheet.com `[A B_C]` is ONE bar holding three chords.
  assert.equal(barGridWeight({ token: '[A B_C]' }), 3);
});

// ── The template ─────────────────────────────────────────────────────────────

test('every bar track has a min-content floor — the collision fix', () => {
  // With minmax(0, …) a nowrap bar overflows into its neighbour. This is the
  // property that makes that impossible, so assert no 0-floor track survives.
  const tpl = buildGridTemplate(barsOf('D7#9_C6/9_G7sus4 | E7#9 | C9 | D7_D7#9'));
  assert.ok(!/minmax\(\s*0\s*,/.test(tpl), `0-floor track in: ${tpl}`);
  assert.equal((tpl.match(/minmax\(min-content,/g) || []).length, 4);
});

test('the real colliding row from the Peg chart gets proportional columns', () => {
  const bars = barsOf('D7#9_C6/9_G7sus4 | E7#9 | C9 | D7_D7#9');
  assert.deepEqual(
    Array.from(bars, (b) => b.token),
    ['D7#9_C6/9_G7sus4', 'E7#9', 'C9', 'D7_D7#9']
  );
  const tpl = buildGridTemplate(bars);
  assert.deepEqual(
    (tpl.match(/(\d)fr/g) || []).map(String),
    ['3fr', '1fr', '1fr', '2fr'],
    'the three-chord bar must claim three shares, the two-chord bar two'
  );
});

test('the template keeps a barline column on both sides of every bar', () => {
  const tpl = buildGridTemplate(barsOf('C | G | Am | F'));
  assert.equal((tpl.match(/14px/g) || []).length, 5, '4 bars → 5 barline columns');
  assert.ok(tpl.startsWith('14px '), 'opening barline');
  assert.ok(tpl.endsWith(' 14px'), 'closing barline');
});

test('an all-simple row is still even — no layout change where none was needed', () => {
  const tpl = buildGridTemplate(barsOf('C | G | Am | F'));
  assert.deepEqual((tpl.match(/(\d)fr/g) || []).map(String), ['1fr', '1fr', '1fr', '1fr']);
});

test('a bar count builds the uniform template the export path expects', () => {
  const tpl = buildGridTemplate(4);
  assert.equal((tpl.match(/minmax\(min-content, 1fr\)/g) || []).length, 4);
  assert.equal((tpl.match(/14px/g) || []).length, 5);
});

test('degenerate input yields a barline rather than a broken template', () => {
  for (const bad of [[], 0, null, undefined, 'nonsense']) {
    assert.equal(buildGridTemplate(bad), '14px');
  }
});

test('caching keys on the weights, not the bar count', () => {
  // One cache entry per SHAPE. Two rows with the same bar count but different
  // chord densities must not be served each other's template.
  const dense = buildGridTemplate(barsOf('A_B_C | D | E | F'));
  const plain = buildGridTemplate(barsOf('A | D | E | F'));
  assert.notEqual(dense, plain);
  assert.equal(buildGridTemplate(barsOf('A_B_C | D | E | F')), dense, 'stable on repeat');
});

// ── The CSS that has to agree with it ────────────────────────────────────────

test('no stylesheet default reintroduces a 0-floor bar track', () => {
  // Three places set these columns: the default rule, the mobile-portrait
  // override, and the per-row inline style. A 0 floor in any one of them brings
  // the collision back on whichever surface it governs.
  const html = read('index.html');
  // Only .barlineRow rules — other grids (settings panels) legitimately use a
  // 0 floor because their content wraps.
  const rules = (html.match(/\.barlineRow\{[\s\S]*?\}/g) || []).filter((r) =>
    /grid-template-columns/.test(r)
  );
  assert.ok(rules.length >= 2, `expected the default and mobile grid rules, got ${rules.length}`);
  for (const rule of rules) {
    const decl = (rule.match(/grid-template-columns:[^;]*/) || [''])[0];
    assert.ok(!/minmax\(\s*0\s*,/.test(decl), `0-floor bar track: ${decl.trim()}`);
    assert.match(decl, /minmax\(min-content,/);
  }
});

test('the mobile override yields to export so the PDF keeps per-row columns', () => {
  // It needs !important to beat the inline template on a phone; scoping it to
  // :not(.exporting) is what lets the export still match the preview.
  const html = read('index.html');
  const m = html.match(/body:not\(\.exporting\) \.barlineRow\{[\s\S]*?\}/);
  assert.ok(m, 'mobile grid override is not scoped to :not(.exporting)');
  assert.match(m[0], /grid-template-columns:[^;]*!important/);
});

test('the export rule no longer forces uniform columns', () => {
  const html = read('index.html');
  const m = html.match(/body\.exporting \.barlineRow\{[\s\S]*?\}/);
  assert.ok(m, 'export rule not found');
  assert.ok(
    !/grid-template-columns/.test(m[0]),
    'forcing a uniform template here would override the per-row layout in exports'
  );
  assert.ok(
    !/--export-grid-template/.test(html),
    'the export grid variable is dead and must not linger'
  );
});

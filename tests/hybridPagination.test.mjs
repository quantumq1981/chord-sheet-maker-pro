import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads just enough of the stack for paginateUnits() to be exercised directly.
// paginateUnits is pure — no DOM, no SVG side effects — so this harness never
// touches document/window beyond the stubs the other files expect at load time.
function loadRenderer() {
  const root = new URL('..', import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), 'utf8');

  const context = {
    window: {},
    document: {
      querySelector() {
        return null;
      },
      createElement() {
        return { click() {}, setAttribute() {}, style: {} };
      },
      body: { appendChild() {} },
    },
    fbSettings: { fgColor: '#111', bgColor: '#fff', chordColor: '#0044cc', barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'sharp',
    console,
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context);
  vm.runInContext(read('chordProcessing.js'), context);
  vm.runInContext(read('csmpnParser.js'), context);
  vm.runInContext(read('importPipeline.js'), context);
  vm.runInContext(read('musicXmlCore.js'), context);
  vm.runInContext(read('renderer.js'), context);
  return context;
}

// Synthetic units — no draw side effects needed, paginateUnits only reads
// unit.height / unit.keepWithNext / unit.sectionIndex / unit.sectionFirst / unit.kind.
const unit = (overrides) => ({
  kind: 'system',
  height: 100,
  sectionIndex: 0,
  sectionFirst: false,
  draw: () => '',
  ...overrides,
});

const PAGE_OPTS = (extra) => ({
  pageWidth: 816,
  pageHeight: 1056,
  marginTop: 40,
  marginBottom: 40,
  makeHeader: (key) => ({ height: 60, draw: () => `<!--hdr:${key}-->` }),
  contKey: 'G',
  ...extra,
});

test('N short systems that fit in one usable page produce exactly 1 page', () => {
  const ctx = loadRenderer();
  const units = Array.from({ length: 5 }, () => unit({ height: 100 }));
  const pages = ctx.paginateUnits(units, PAGE_OPTS());
  assert.equal(pages.length, 1);
  assert.equal(pages[0].placed.length, 5);
});

test('systems summing to ~2.4 usable pages produce exactly 3 pages, none crossing a page boundary', () => {
  const ctx = loadRenderer();
  // usable = 1056 - 40 - 40 = 976. Each system 150px tall -> ~6.5/page.
  // 16 systems * 150 = 2400 -> spans just over 2 pages, force a 3rd via count.
  const units = Array.from({ length: 16 }, () => unit({ height: 150 }));
  const pages = ctx.paginateUnits(units, PAGE_OPTS());
  assert.equal(pages.length, 3);
  const usable = 1056 - 40 - 40;
  for (const page of pages) {
    for (const p of page.placed) {
      assert.ok(p.originY >= 40, 'unit starts at or after the top margin');
      assert.ok(
        p.originY + p.unit.height <= 40 + usable + 0.001,
        `unit [${p.originY}, ${p.originY + p.unit.height}] must not cross the usable-area boundary (${40 + usable})`
      );
    }
  }
});

test('mid-section page break injects a pageHeader unit at the top of the continued page', () => {
  const ctx = loadRenderer();
  const usable = 1056 - 40 - 40; // 976
  // Fill page 1 almost to the brim with section 0, then continue section 0
  // (sectionFirst:false) onto page 2 — should get a synthetic header.
  const units = [
    unit({ height: usable - 50, sectionIndex: 0, sectionFirst: true }),
    unit({ height: 200, sectionIndex: 0, sectionFirst: false }),
  ];
  const pages = ctx.paginateUnits(units, PAGE_OPTS());
  assert.equal(pages.length, 2);
  assert.equal(pages[1].placed[0].unit.kind, 'pageHeader');
  assert.equal(pages[1].placed[0].unit.sectionIndex, 0);
});

test('section-first row that overflows does NOT inject a pageHeader (clef already in the unit)', () => {
  const ctx = loadRenderer();
  const usable = 1056 - 40 - 40;
  // Page 1 fills up with section 0; section 1's FIRST row overflows onto page 2.
  const units = [
    unit({ height: usable - 50, sectionIndex: 0, sectionFirst: true }),
    unit({ height: 200, sectionIndex: 1, sectionFirst: true }),
  ];
  const pages = ctx.paginateUnits(units, PAGE_OPTS());
  assert.equal(pages.length, 2);
  assert.equal(pages[1].placed[0].unit.kind, 'system');
  assert.equal(pages[1].placed[0].unit.sectionFirst, true);
});

test('keepWithNext label is never the last placed unit on a page when its system does not fit', () => {
  const ctx = loadRenderer();
  const usable = 1056 - 40 - 40;
  // Fill page 1 leaving just enough room for the label alone, but not the label + its system.
  const units = [
    unit({ height: usable - 30, sectionIndex: 0, sectionFirst: false, kind: 'system' }),
    unit({
      height: 20,
      sectionIndex: 1,
      sectionFirst: true,
      kind: 'sectionLabel',
      keepWithNext: true,
    }),
    unit({ height: 150, sectionIndex: 1, sectionFirst: true, kind: 'system' }),
  ];
  const pages = ctx.paginateUnits(units, PAGE_OPTS());
  assert.equal(pages.length, 2);
  // The label must have moved to page 2 together with its system, not been
  // stranded alone at the bottom of page 1.
  const page1Kinds = pages[0].placed.map((p) => p.unit.kind);
  assert.ok(!page1Kinds.includes('sectionLabel'), 'label is not orphaned on page 1');
  assert.equal(pages[1].placed[0].unit.kind, 'sectionLabel');
  assert.equal(pages[1].placed[1].unit.kind, 'system');
});

test('a single system taller than a whole usable page is isolated on its own page and fires warn() once', () => {
  const ctx = loadRenderer();
  const usable = 1056 - 40 - 40;
  const warnings = [];
  const units = [
    unit({ height: 100 }),
    unit({ height: usable + 200, kind: 'system' }), // taller than any page
    unit({ height: 100 }),
  ];
  const pages = ctx.paginateUnits(units, PAGE_OPTS({ warn: (msg) => warnings.push(msg) }));
  assert.equal(pages.length, 3, 'oversized unit gets isolated on its own page');
  assert.equal(pages[1].placed.length, 1);
  assert.equal(pages[1].placed[0].unit.height, usable + 200);
  assert.equal(warnings.length, 1, 'warn() fired exactly once');
  assert.match(warnings[0], /exceeds usable page height/i);
});

test('empty units[] produces zero pages', () => {
  const ctx = loadRenderer();
  const pages = ctx.paginateUnits([], PAGE_OPTS());
  // Cross-realm array (vm context) — compare by length, not reference/structural
  // identity against a same-realm [].
  assert.equal(Array.from(pages).length, 0);
});

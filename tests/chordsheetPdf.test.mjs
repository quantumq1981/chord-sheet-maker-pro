import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadChordsheet() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('chordsheetPdf.js'), ctx);
  return ctx.window.ChordsheetPdf;
}

const CS = loadChordsheet();
const C = String.fromCharCode;
const FLAT = C(0xe10d),
  SEVEN = C(0xe197),
  DIM = C(0xe190),
  MAJ = C(0xe180),
  BAR = C(0xe030),
  METER = C(0xf587);

test('decodeChordsheetGlyphs maps the PUA music font to text', () => {
  assert.equal(CS.decodeChordsheetGlyphs('B' + FLAT + SEVEN), 'Bb7'); // flat + 7
  assert.equal(CS.decodeChordsheetGlyphs('E' + DIM + SEVEN), 'Eo7'); // dim7
  assert.equal(CS.decodeChordsheetGlyphs('E' + FLAT + MAJ + SEVEN), 'Ebmaj7'); // maj7
  assert.ok(CS.decodeChordsheetGlyphs(BAR).includes('|')); // barline
});

test('isChordsheetText detects the format', () => {
  assert.equal(CS.isChordsheetText('see https://www.chordsheet.com/song/1'), true);
  assert.equal(CS.isChordsheetText('A' + BAR + 'B'), true); // has the barline glyph
  assert.equal(CS.isChordsheetText('| Bb7 | Eb7 |'), false); // plain text, not chordsheet
});

test('detectMeter reads the time-signature glyph (12/8) and defaults to 4/4', () => {
  assert.equal(CS.detectMeter('header ' + METER + ' Bb7'), '12/8');
  assert.equal(CS.detectMeter('no meter glyph here'), '4/4');
});

test('groupItemsIntoText re-joins split glyph runs by x-gap', () => {
  // "B","flat","7" are adjacent (small gaps) → "Bb7"; "Eb7" is far → a space.
  const fs = 12;
  const items = [
    { str: 'B', x: 0, y: 100, w: 6, fontSize: fs },
    { str: FLAT, x: 6, y: 100, w: 3, fontSize: fs },
    { str: SEVEN, x: 9, y: 100, w: 3, fontSize: fs },
    { str: 'E' + FLAT + SEVEN, x: 60, y: 100, w: 14, fontSize: fs },
  ];
  const text = CS.decodeChordsheetGlyphs(CS.groupItemsIntoText(items));
  assert.equal(text.replace(/\s+/g, ' ').trim(), 'Bb7 Eb7');
});

// ── End-to-end against the real chordsheet.com export ─────────────────────────

const csmpn = CS.chordsheetTextToCsmpn(read('tests/fixtures/chordsheet-sincityblues.txt'), {
  barsPerRow: 4,
});

test('chordsheetTextToCsmpn extracts the header (12/8, tempo 81)', () => {
  assert.match(csmpn, /Time: 12\/8/);
  assert.match(csmpn, /Tempo: 81/);
});

test('chordsheetTextToCsmpn reconstructs sections and bars matching the PDF', () => {
  for (const sec of [
    '- Verse 1',
    '- Pre-Chorus',
    '- Chorus 1',
    '- Bridge',
    '- 1st Ending',
    '- 2nd Ending',
    '- CODA',
  ]) {
    assert.ok(csmpn.includes(sec), `missing section ${sec}`);
  }
  // Verse 1: Bb7 | % | Eb7 | %  (similes preserved)
  assert.match(csmpn, /- Verse 1\nBb7 % Eb7 %/);
  // multi-chord bars join with _
  assert.ok(csmpn.includes('Eb7_Eo7'), 'Eb7 Eo7 → one bar');
  assert.ok(csmpn.includes('Ebmaj7_Eo7'), 'Ebmaj7 Eo7 → one bar');
  // the bridge passing-chord run
  assert.ok(csmpn.includes('B7_C7_Db7_D7'), 'bridge passing chords');
  // CODA
  assert.ok(csmpn.includes('Bb_B13'), 'CODA Bb B13');
});

test('the generated CSMPN parses cleanly through CSMP parseCSMPN', () => {
  const ctx = {
    window: {},
    console,
    fbSettings: { barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'flat',
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {} }),
      head: { appendChild() {} },
      querySelector: () => null,
    },
  };
  ctx.window.document = ctx.document;
  ctx.window.dispatchEvent = () => {};
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of ['utils.js', 'chordProcessing.js', 'csmpnParser.js'])
    vm.runInContext(read(f), ctx);
  const doc = ctx.parseCSMPN(csmpn);
  const markers = doc.blocks.filter((b) => b.type === 'marker').length;
  assert.ok(markers >= 12, `expected the song's sections, got ${markers}`);
});

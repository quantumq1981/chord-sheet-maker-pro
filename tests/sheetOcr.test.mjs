// Unit tests for sheetOcr.js — the pure core of the Sheet Music Chord OCR
// importer (sheet-ocr-importer.html). Loaded in a vm context like the other
// browser-global modules; pixel tests use small synthetic grayscale buffers.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = vm.createContext({});
ctx.globalThis = ctx;
vm.runInContext(readFileSync(join(root, 'sheetOcr.js'), 'utf8'), ctx);
const S = ctx.SheetOcr;

// Synthetic grayscale image helper: white page, painter draws ink.
function makeImg(w, h, painter) {
  const data = new Uint8ClampedArray(w * h).fill(240);
  const setPx = (x, y, v = 0) => {
    if (x >= 0 && x < w && y >= 0 && y < h) data[y * w + x] = v;
  };
  const hline = (y, x0, x1, v = 0) => {
    for (let x = x0; x < x1; x++) setPx(x, y, v);
  };
  const rect = (x0, y0, x1, y1, v = 0) => {
    for (let y = y0; y < y1; y++) hline(y, x0, x1, v);
  };
  if (painter) painter({ setPx, hline, rect });
  return { data, w, h };
}

// A 2px-thick 5-line staff with `gap` px line spacing starting at yTop.
function drawStaff(p, yTop, gap, x0, x1, lines = 5) {
  for (let i = 0; i < lines; i++) {
    p.hline(yTop + i * gap, x0, x1);
    p.hline(yTop + i * gap + 1, x0, x1);
  }
}

test('otsuThreshold splits a bimodal ink/paper histogram', () => {
  const hist = new Array(256).fill(0);
  hist[30] = 500; // ink
  hist[220] = 5000; // paper
  const t = S.otsuThreshold(hist);
  assert.ok(t > 30 && t <= 220, `threshold ${t} should sit between the modes`);
  // pixels at the ink mode must classify as ink under the `< thresh` test
  assert.ok(30 < t);
});

test('cropContentBounds trims black letterbox bands', () => {
  const img = makeImg(100, 120, (p) => {
    p.rect(0, 0, 100, 20, 5); // top black band
    p.rect(0, 100, 100, 120, 5); // bottom black band
  });
  const b = S.cropContentBounds(img.data, img.w, img.h);
  assert.ok(b.y0 >= 19 && b.y0 <= 21, `y0=${b.y0}`);
  assert.ok(b.y1 >= 99 && b.y1 <= 101, `y1=${b.y1}`);
});

test('analyzePage finds a synthetic 5-line staff as one system with a band', () => {
  const img = makeImg(600, 400, (p) => {
    drawStaff(p, 200, 17, 30, 570);
  });
  const r = S.analyzePage(img.data, img.w, img.h, { deskew: false });
  assert.equal(r.staves.length, 1);
  assert.equal(r.staves[0].lines.length, 5);
  assert.ok(Math.abs(r.staves[0].gap - 17) < 2, `gap=${r.staves[0].gap}`);
  assert.equal(r.systems.length, 1);
  assert.equal(r.bands.length, 1);
  assert.ok(r.bands[0].bottom < r.systems[0].top, 'band sits above the staff');
});

test('groupStaves rejects irregularly spaced lines', () => {
  const staves = S.groupStaves([100, 110, 140, 145, 190]);
  assert.equal(staves.length, 0);
});

test('groupStaves accepts a 4-line staff and reports nominal 5-line height', () => {
  const staves = S.groupStaves([100, 117, 134, 151]);
  assert.equal(staves.length, 1);
  assert.equal(staves[0].lines.length, 4);
  assert.ok(Math.abs(staves[0].nominalHeight - 17 * 4) < 2);
});

test('groupSystems merges close staves and splits distant ones', () => {
  const mk = (top) => ({
    top,
    bottom: top + 68,
    height: 68,
    nominalHeight: 68,
    gap: 17,
    lines: [top],
  });
  // grand staff pair 100px apart, next system 400px lower
  const systems = S.groupSystems([mk(100), mk(268), mk(700), mk(868)]);
  assert.equal(systems.length, 2);
  assert.equal(systems[0].staves.length, 2);
  assert.equal(systems[1].staves.length, 2);
});

test('chordStripBands anchors above a 4-line staff at its nominal top', () => {
  const staff5 = {
    top: 500,
    bottom: 568,
    height: 68,
    nominalHeight: 68,
    gap: 17,
    lines: [1, 2, 3, 4, 5],
  };
  const staff4 = {
    top: 517,
    bottom: 568,
    height: 51,
    nominalHeight: 68,
    gap: 17,
    lines: [1, 2, 3, 4],
  };
  const b5 = S.chordStripBands([{ staves: [staff5], top: 500, bottom: 568 }], 0)[0];
  const b4 = S.chordStripBands([{ staves: [staff4], top: 517, bottom: 568 }], 0)[0];
  // The 4-line staff's band must NOT extend 17px lower than the 5-line one:
  // the missing top line is assumed to be at the nominal position.
  assert.ok(Math.abs(b4.bottom - b5.bottom) < 2, `${b4.bottom} vs ${b5.bottom}`);
});

test('xyCutBlocks separates blobs and ignores full-width line bleed', () => {
  const img = makeImg(300, 100, (p) => {
    p.rect(30, 40, 55, 60); // blob 1
    p.rect(120, 40, 150, 60); // blob 2
    p.hline(90, 0, 300); // full-width staff-line bleed at the bottom edge
    p.hline(91, 0, 300);
  });
  const blocks = S.xyCutBlocks(img.data, img.w, { x0: 0, x1: 300, y0: 0, y1: 100 }, 128);
  assert.equal(blocks.length, 2, JSON.stringify(blocks));
  assert.ok(
    blocks.every((b) => b.y1 <= 62),
    'line bleed must not be a block'
  );
});

test('chordTextBlocks keeps text-sized blocks and top-slices tall ones', () => {
  const staffH = 68;
  const picked = S.chordTextBlocks(
    [
      { x0: 0, x1: 80, y0: 0, y1: 30 }, // chord-name sized
      { x0: 100, x1: 190, y0: 0, y1: 130 }, // name fused with its diagram
      { x0: 200, x1: 290, y0: 0, y1: 300 }, // way too tall (staff region)
      { x0: 300, x1: 302, y0: 0, y1: 30 }, // vertical sliver
    ],
    staffH
  );
  assert.equal(picked.length, 2);
  const slice = picked.find((b) => b.topSlice);
  assert.ok(slice && slice.y1 - slice.y0 < staffH, 'tall block reduced to top slice');
});

test('repairOcrToken fixes the measured OCR confusions', () => {
  assert.equal(S.repairOcrToken('F#07'), 'F#o7');
  assert.equal(S.repairOcrToken('Am7susd'), 'Am7sus4');
  assert.equal(S.repairOcrToken('Cmaj1'), 'Cmaj7');
  assert.equal(S.repairOcrToken('Gg#o7'), 'G#o7');
  assert.equal(S.repairOcrToken('6m7'), 'Gm7');
  assert.equal(S.repairOcrToken('Am17'), 'Am7');
  assert.equal(S.repairOcrToken('Caj9'), 'Cmaj9');
  assert.equal(S.repairOcrToken('Craj9'), 'Cmaj9');
  assert.equal(S.repairOcrToken('Am/C.'), 'Am/C');
});

test('repairOcrToken never destroys a flat (the Bb regression)', () => {
  assert.equal(S.repairOcrToken('Bb7'), 'Bb7');
  assert.equal(S.normalizeOcrChord('Bb7', { confidence: 99 }), 'Bb7');
});

test('normalizeOcrChord accepts the printed vocabulary', () => {
  for (const c of [
    'Cmaj7',
    'F13sus4',
    'Am7/G',
    'F#dim7',
    'G#o7',
    'Am7sus4',
    'Cmaj9/D',
    'F#m7b5',
    'Dm7/G',
    'F13sus',
  ]) {
    assert.equal(S.normalizeOcrChord(c), c, c);
  }
  assert.equal(S.normalizeOcrChord('N.C.'), 'N.C.');
  assert.equal(S.normalizeOcrChord('CM7'), 'Cmaj7');
});

test('normalizeOcrChord rejects OCR garbage', () => {
  for (const junk of ['F373', '3fr', 'EE', 'ooo', 'x32310', 'Cbb', '17', 'hoid', 'a']) {
    assert.equal(S.normalizeOcrChord(junk), null, junk);
  }
});

test('normalizeOcrChord gates low-confidence bare roots', () => {
  assert.equal(S.normalizeOcrChord('A', { confidence: 40 }), null);
  assert.equal(S.normalizeOcrChord('A', { confidence: 95 }), 'A');
  assert.equal(S.normalizeOcrChord('Am7', { confidence: 40 }), 'Am7', 'gate is bare-roots only');
});

test('stitchNoChord and mergeSplitChordWords reassemble split prints', () => {
  const words = [
    { text: 'No', x0: 0, x1: 20, y0: 0, y1: 20 },
    { text: 'chord', x0: 26, x1: 70, y0: 0, y1: 20 },
    { text: 'Cmaj', x0: 100, x1: 140, y0: 0, y1: 20 },
    { text: '7', x0: 144, x1: 152, y0: 0, y1: 20 },
  ];
  const out = S.mergeSplitChordWords(S.stitchNoChord(words));
  assert.deepEqual(
    out.map((w) => w.text),
    ['N.C.', 'Cmaj7']
  );
});

test('buildTimeline maps x positions to measures and beats', () => {
  const tl = S.buildTimeline(
    [
      [
        { chord: 'C', xNorm: 0.05 },
        { chord: 'G', xNorm: 0.6 },
      ],
      [{ chord: 'F', xNorm: 0.1 }],
    ],
    { barsPerSystem: 2, beatsPerBar: 4 }
  );
  assert.deepEqual(
    tl.map((t) => [t.chord, t.measure, t.beat, t.staffIndex]),
    [
      ['C', 1, 1, 0],
      ['G', 2, 1, 1], // xNorm 0.6 -> bar 2, beat floor(0.2*4)+1 = 1
      ['F', 3, 1, 1],
    ].map((x, i) => [x[0], x[1], x[2], i < 2 ? 0 : 1])
  );
});

test('timelineToCsmpn emits bars, simile and honest N.C.', () => {
  const csmpn = S.timelineToCsmpn(
    [
      { chord: 'C', measure: 2, beat: 1 },
      { chord: 'G', measure: 4, beat: 1 },
      { chord: 'Am', measure: 4, beat: 3 },
    ],
    { barsPerRow: 4, title: 'Test' }
  );
  assert.ok(csmpn.includes('Title: Test'));
  assert.ok(csmpn.includes('- Chart'));
  assert.ok(csmpn.includes('| N.C. | C | % | G_Am |'), csmpn);
});

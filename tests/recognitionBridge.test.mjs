/*
 * recognitionBridge.test.mjs — the import seam: file bytes → CSMPN, through the
 * vendored recognition engine.
 *
 * recognitionBridge.js is a classic browser script whose only browser-dependent
 * parts are the dynamic `import()` and the `window` export. Loading it in a vm
 * with a stubbed `window` and a stubbed dynamic import lets the whole thing —
 * including `importBinary`, the part chooser and the melodic-simplify decision —
 * run headlessly against the REAL engine and the REAL fixtures.
 *
 * What matters here, and why:
 *   - defaulting to part 0 would hand back a vocal line transcribed as chords;
 *     the part chooser is what makes a multi-track import usable
 *   - a single-note part must condense to one chord per bar, or a fingerpicked
 *     piece exports one "chord" per note
 *   - the CSMPN it emits has to parse through THIS repo's parser with no
 *     warnings, because everything downstream reads CSMPN
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

import * as engine from '../recognitionEngine.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = (...p) => new Uint8Array(readFileSync(join(root, ...p)));

/** Objects built inside the vm belong to another realm, so deepEqual would fail
 *  on identity alone. Round-tripping through JSON compares them by value. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const bridgeSource = () => readFileSync(join(root, 'recognitionBridge.js'), 'utf8');

/** The bridge with its one un-runnable line — the dynamic import — swapped for
 *  an injected loader. `import()` is syntax, not a global, so it must be rewritten. */
const stubbedBridgeSource = () =>
  bridgeSource().replace("import('./recognitionEngine.mjs')", '__loadEngineModule()');

/**
 * Load the bridge with the engine already resolved, so no dynamic import runs.
 * `import()` is syntax, not a global, so the source is rewritten to call an
 * injected loader — the one line of the module that cannot run under Node as-is.
 */
function loadBridge(engineModule = engine) {
  const ctx = {
    window: {},
    console,
    __loadEngineModule: () => Promise.resolve(engineModule),
  };
  vm.createContext(ctx);
  // The bridge reads window.ChordTheory for harmony recovery — the same oracle
  // the app's own importers use, so recovery is tested through the real thing.
  for (const f of ['utils.js', 'chordTheory.js']) {
    vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx);
  }
  vm.runInContext(stubbedBridgeSource(), ctx);
  return ctx.window.RecognitionBridge;
}

/** This repo's own CSMPN parser stack, for checking the handoff. */
function loadCsmpnParser() {
  const ctx = { window: {}, module: { exports: {} }, console };
  vm.createContext(ctx);
  for (const f of ['utils.js', 'chordTheory.js', 'chordProcessing.js', 'csmpnParser.js']) {
    vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx);
  }
  return {
    parseCSMPN: ctx.parseCSMPN || ctx.window.parseCSMPN,
    parseBarStructures: ctx.parseBarStructures || ctx.window.parseBarStructures,
  };
}

const bridge = loadBridge();

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('chartTitleFromFilename turns a filename into a readable title', () => {
  assert.equal(bridge.chartTitleFromFilename('Steely Dan - Peg.gp4'), 'Steely Dan - Peg');
  assert.equal(
    bridge.chartTitleFromFilename('the-allman-brothers-band-blue_sky.gp3'),
    'the-allman-brothers-band-blue sky'
  );
  assert.equal(bridge.chartTitleFromFilename(''), '');
  assert.equal(bridge.chartTitleFromFilename('no-extension'), 'no-extension');
});

test('partHarmonyScore rewards comping over a busy melody line', () => {
  const bar = (events) => ({ events });
  // Same number of events; one states chords, the other is a single-note line
  // that names many symbols. The comping part must win.
  const comping = {
    bars: [
      bar([
        { midis: [60, 64, 67], symbol: 'C' },
        { midis: [62, 65, 69], symbol: 'Dm' },
      ]),
    ],
  };
  const melody = {
    bars: [
      bar([
        { midis: [60], symbol: 'C' },
        { midis: [62], symbol: 'Dm' },
      ]),
    ],
  };
  assert.ok(bridge.partHarmonyScore(comping) > bridge.partHarmonyScore(melody));
  assert.equal(bridge.partHarmonyScore({ bars: [] }), 0);
  assert.equal(bridge.partHarmonyScore(null), 0);
});

test('partHarmonyScore ignores non-chords: N.C. and the unrecognised symbol', () => {
  const score = {
    bars: [
      {
        events: [
          { midis: [60], symbol: '—' },
          { midis: [61], symbol: 'N.C.' },
        ],
      },
    ],
  };
  assert.equal(bridge.partHarmonyScore(score), 0);
});

test('pickChordPart returns the strongest part, keeping file order on a tie', () => {
  const one = { bars: [{ events: [{ midis: [60], symbol: 'C' }] }] };
  const many = { bars: [{ events: [{ midis: [60, 64, 67], symbol: 'C' }] }] };
  assert.equal(bridge.pickChordPart([one, many]), 1);
  assert.equal(bridge.pickChordPart([many, one]), 0);
  assert.equal(bridge.pickChordPart([one, one]), 0, 'a tie keeps the earlier part');
  assert.equal(bridge.pickChordPart([]), 0, 'an empty list still yields a valid index');
});

test('importSummary counts what the status line and diagnostics report', () => {
  const score = {
    tuning: 'Drop D',
    capo: 2,
    parts: [{ index: 0 }, { index: 1 }],
    bars: [
      { section: 'Verse', events: [{}, {}] },
      { events: [{}] },
      { section: 'Chorus', events: [] },
    ],
  };
  assert.deepEqual(plain(bridge.importSummary(score)), {
    bars: 3,
    sections: 2,
    chords: 3,
    parts: 2,
    tuning: 'Drop D',
    capo: 2,
  });
});

// ── The real thing: fixtures through importBinary ────────────────────────────

test('a multi-track Guitar Pro file is read from a part that carries chords', async () => {
  // Blue Sky's track 0 is a melody line. Reading it would produce a chart of
  // single notes; the chooser has to land on a comping track instead.
  const res = await bridge.importBinary(bytes('the-allman-brothers-band-blue_sky.gp3'), {
    filename: 'the-allman-brothers-band-blue_sky.gp3',
  });
  assert.equal(res.partIndex, 2, 'the rhythm track is the one that states the changes');
  assert.equal(res.summary.bars, 164);
  assert.equal(res.format, 'gp');
  assert.ok(res.parts.length > 1, 'the part list is returned so the picker can offer it');
  assert.match(res.csmpn, /^Title: the-allman-brothers-band-blue sky$/m);
});

test('the chosen part carries the verse progression into CSMPN', () => {
  const score = engine.parseGP345(bytes('the-allman-brothers-band-blue_sky.gp3'), true, 2);
  const csmpn = engine.scoreToCSMPN(score, { title: 'Blue Sky', useSharp: true });
  const { parseCSMPN, parseBarStructures } = loadCsmpnParser();
  const doc = parseCSMPN(csmpn);
  const block = doc.blocks.find((b) => Array.isArray(b.tokens) && b.tokens.includes('|'));
  const bars = plain(parseBarStructures(block.tokens).map((b) => b.token));
  // E A A E — the opening the upstream engine is pinned to, arriving as real bars.
  assert.deepEqual(bars.slice(0, 4), ['E', 'A', '%', 'E']);
});

test('an explicit partIndex overrides the chooser — this is what the picker does', async () => {
  const res = await bridge.importBinary(bytes('Steely Dan - Peg.gp4'), {
    filename: 'Peg.gp4',
    partIndex: 3,
  });
  assert.equal(res.partIndex, 3);
  assert.equal(res.parts[3].name, 'Rhythm guitar');
  assert.match(res.csmpn, /Gmaj7/, 'Peg opens on Gmaj7');
});

test('Power Tab imports end to end — the format CSMP could not fully read before', async () => {
  // powerTabImporter.js is header-and-tunings only; this is the whole point of
  // routing .ptb through the engine.
  const res = await bridge.importBinary(bytes('tests', 'fixtures', 'a-major-shape-arpeggio.ptb'), {
    filename: 'a-major-shape-arpeggio.ptb',
  });
  assert.equal(res.summary.bars, 10);
  assert.equal(res.summary.tuning, 'Standard');
  assert.ok(res.csmpn.includes('Tuning: Standard'));
});

test('a single-note part is condensed to one chord per bar, not one per note', async () => {
  const res = await bridge.importBinary(bytes('tests', 'fixtures', 'a-major-shape-arpeggio.ptb'), {
    filename: 'arpeggio.ptb',
  });
  assert.equal(res.melodic, true, 'an arpeggio is detected as melodic');
  assert.equal(res.summary.chords, res.summary.bars, 'exactly one chord per bar');
});

test('every bridge import parses through this repo’s CSMPN with zero warnings', async () => {
  const { parseCSMPN } = loadCsmpnParser();
  const files = [
    ['the-allman-brothers-band-blue_sky.gp3'],
    ['Steely Dan - Peg.gp4'],
    ['steely-dan-kid_charlemegne.gp3'],
    ['tests', 'fixtures', 'a-major-shape-arpeggio.ptb'],
  ];
  for (const parts of files) {
    const res = await bridge.importBinary(bytes(...parts), { filename: parts[parts.length - 1] });
    const doc = parseCSMPN(res.csmpn);
    assert.deepEqual(doc.warnings || [], [], `${parts.join('/')} handoff must be warning-free`);
    assert.ok(doc.title, `${parts.join('/')} carries a title`);
  }
});

test('a file the engine cannot read rejects, so the caller can fall back', async () => {
  await assert.rejects(() =>
    bridge.importBinary(new Uint8Array([1, 2, 3, 4]), { filename: 'x.gp5' })
  );
});

test('a failed engine load does not poison later attempts', async () => {
  let calls = 0;
  const ctx = {
    window: {},
    console,
    __loadEngineModule: () =>
      ++calls === 1 ? Promise.reject(new Error('network')) : Promise.resolve(engine),
  };
  const src = stubbedBridgeSource();
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const b = ctx.window.RecognitionBridge;
  await assert.rejects(() => b.loadEngine());
  assert.ok(await b.loadEngine(), 'the second attempt retries instead of replaying the failure');
});

test('the dynamic-import specifier matches ENGINE_URL, so the deploy guard follows the real path', () => {
  // The import is written as a literal because scripts/verify-deploy-assets.mjs
  // can only follow a string. That makes ENGINE_URL a second copy of the path —
  // this pins them together so the guard can never end up checking a stale one.
  const src = bridgeSource();
  const literal = src.match(/import\(\s*'([^']+)'\s*\)/);
  assert.ok(literal, 'the engine is loaded by a literal dynamic import');
  assert.equal(literal[1], bridge.ENGINE_URL);
});

// ── Cross-track harmony recovery ─────────────────────────────────────────────

test('harvestBarPitches weighs pitch classes by duration across every part', () => {
  const scores = [
    { bars: [{ events: [{ midis: [60], qdur: 4 }] }] }, // C, held
    { bars: [{ events: [{ midis: [64, 67], qdur: 1 }] }] }, // E + G, brief
  ];
  const h = plain(bridge.harvestBarPitches(scores, 0));
  assert.equal(h.bassPc, 0, 'the lowest note is the bass');
  assert.ok(h.weights[0] > h.weights[4], 'the held note outweighs the brief one');
  assert.deepEqual(
    Object.keys(h.weights)
      .map(Number)
      .sort((a, b) => a - b),
    [0, 4, 7]
  );
});

test('harvestBarPitches is empty when no part plays that bar', () => {
  const h = plain(bridge.harvestBarPitches([{ bars: [{ events: [] }] }], 0));
  assert.deepEqual(h.weights, {});
  assert.equal(h.bassPc, null);
});

test('an empty bar takes its harmony from the other parts', () => {
  // The chosen part rests; another part plays a C major triad.
  const chosen = { timeSig: [4, 4], bars: [{ events: [] }] };
  const others = [chosen, { bars: [{ events: [{ midis: [48, 52, 55], qdur: 4 }] }] }];
  const out = bridge.recoverEmptyBars(chosen, others, {});
  assert.equal(out.recoveredBars, 1);
  assert.equal(out.bars[0].events[0].symbol, 'C');
  assert.equal(out.bars[0].events[0].recovered, true);
  assert.equal(out.bars[0].events[0].durBeats, 4, 'a whole-bar event');
  assert.deepEqual(plain(out.bars[0].events[0].midis), [], 'no fingering is claimed');
});

test('a bar that states its own chords is never second-guessed', () => {
  const chosen = { timeSig: [4, 4], bars: [{ events: [{ symbol: 'Am', midis: [57, 60, 64] }] }] };
  const others = [chosen, { bars: [{ events: [{ midis: [48, 52, 55], qdur: 4 }] }] }];
  const out = bridge.recoverEmptyBars(chosen, others, {});
  assert.equal(out.recoveredBars, undefined, 'nothing was recovered');
  assert.equal(out.bars[0].events[0].symbol, 'Am');
});

test('silence and a lone note stay an honest N.C.', () => {
  const chosen = { timeSig: [4, 4], bars: [{ events: [] }, { events: [] }] };
  const others = [
    chosen,
    { bars: [{ events: [] }, { events: [{ midis: [60], qdur: 4 }] }] }, // silence, then one note
  ];
  const out = bridge.recoverEmptyBars(chosen, others, {});
  assert.equal((out.bars[0].events || []).length, 0, 'silence recovers nothing');
  assert.equal((out.bars[1].events || []).length, 0, 'a single pitch class is not a chord');
});

test('recovery does not mutate the engine’s own score', () => {
  const chosen = { timeSig: [4, 4], bars: [{ events: [] }] };
  const others = [chosen, { bars: [{ events: [{ midis: [48, 52, 55], qdur: 4 }] }] }];
  const out = bridge.recoverEmptyBars(chosen, others, {});
  assert.notEqual(out, chosen);
  assert.equal(chosen.bars[0].events.length, 0, 'the input is untouched');
});

test('a real multi-track import comes back playable, not half N.C.', async () => {
  // The regression this recovery exists for: routing imports through the engine
  // alone returned 45% of Peg's bars and 49% of Kid Charlemagne's as N.C., because
  // the chosen guitar rests while the band plays.
  for (const [file, part] of [
    ['Steely Dan - Peg.gp4', 3],
    ['steely-dan-kid_charlemegne.gp3', 0],
  ]) {
    const res = await bridge.importBinary(bytes(file), {
      filename: file,
      partIndex: part,
      tab: false,
      hybrid: false,
    });
    const cells = res.csmpn
      .split('\n')
      .filter((l) => l.includes('|'))
      .flatMap((l) => l.split(/\s*(?:\|\||\|:|:\||\||\|\])\s*/))
      .map((c) => c.trim())
      .filter(Boolean);
    const nc = cells.filter((c) => c === 'N.C.').length;
    assert.ok(res.recoveredBars > 20, `${file}: expected real recovery, got ${res.recoveredBars}`);
    assert.ok(nc / cells.length < 0.1, `${file}: ${nc}/${cells.length} bars still N.C.`);
  }
});

test('recovery is skipped, not fatal, when ChordTheory is absent', () => {
  const ctx = { window: {}, console, __loadEngineModule: () => Promise.resolve(engine) };
  vm.createContext(ctx);
  vm.runInContext(stubbedBridgeSource(), ctx);
  const bare = ctx.window.RecognitionBridge;
  const score = { timeSig: [4, 4], bars: [{ events: [] }] };
  assert.equal(bare.recoverEmptyBars(score, [score], {}), score, 'returned unchanged');
});

// ── Tab PDFs (fret geometry, no chord symbols) ───────────────────────────────

test('pdfTokenScale normalises an oversized export page and leaves normal ones alone', () => {
  // A Guitar Pro / alphaTab PDF page can be 4209pt tall. The engine's parser
  // only measures string-line gaps under 20pt, so at that scale it finds none,
  // falls back to 7pt, and reports zero systems on a page full of legible tab.
  assert.ok(Math.abs(bridge.pdfTokenScale(4209) - 792 / 4209) < 1e-9);
  assert.equal(bridge.pdfTokenScale(792), 1, 'a normal page is untouched');
  assert.equal(bridge.pdfTokenScale(1000), 1, 'below the 1.5x trigger, untouched');
  assert.equal(bridge.pdfTokenScale(0), 1, 'no height is not a division by zero');
  assert.equal(bridge.pdfTokenScale(2000, 1000), 0.5, 'the target is configurable');
});

test('importTabPdf refuses too little to work with rather than returning half a chart', async () => {
  assert.equal(await bridge.importTabPdf([], {}), null);
  assert.equal(await bridge.importTabPdf(null, {}), null, 'a scanned PDF yields no digits');
  // Enough tokens to pass the count gate, but no staff geometry in them.
  const junk = Array.from({ length: 20 }, (_, i) => ({ page: 1, x: i * 40, y: 100, val: 3 }));
  assert.equal(await bridge.importTabPdf(junk, {}), null, 'one row is not a staff');
});

test('importTabPdf reads six string lines into chords and hands back parseable CSMPN', async () => {
  // A synthetic system: two measures, each two columns of an open E shape on six
  // evenly spaced string lines, at the ~7pt spacing the engine expects, with a
  // measure number above each.
  const SP = 7;
  const top = 200;
  const shape = [0, 2, 2, 1, 0, 0]; // low E -> high e
  const tokens = [];
  [
    [40, [60, 140]],
    [240, [260, 340]],
  ].forEach(([markX, xs], mi) => {
    tokens.push({ page: 1, x: markX, y: top - SP * 2.5, val: mi + 1 });
    xs.forEach((x) =>
      shape.forEach((fret, engIdx) =>
        tokens.push({ page: 1, x, y: top + (5 - engIdx) * SP, val: fret })
      )
    );
  });

  const res = await bridge.importTabPdf(tokens, { title: 'Synthetic' });
  assert.ok(res, 'a well-formed system is read');
  assert.equal(res.systems, 1);
  assert.equal(res.columns, 4);
  assert.equal(res.summary.bars, 2);
  assert.match(res.csmpn, /^Title: Synthetic$/m);
  assert.match(res.csmpn, /\bE\b/, 'the open E shape is named');

  const { parseCSMPN } = loadCsmpnParser();
  const doc = parseCSMPN(res.csmpn);
  assert.deepEqual(doc.warnings || [], [], 'the tab-PDF handoff must be warning-free too');

  // The frets belong to one transcription rather than to a chord shape worth
  // showing, and column geometry carries no reliable onset timing.
  assert.ok(!res.csmpn.includes('{tab'), 'no tab block');
  assert.ok(!res.csmpn.includes('{hybrid'), 'no hybrid block');
});

/*
 * recognitionEngine.test.mjs — the vendored recognition engine, proven IN THIS REPO
 * against real committed files, and proven to hand off cleanly to CSMPN.
 *
 * Two distinct jobs:
 *
 *  1. GROUND TRUTH. These are the same fixtures and the same expected progressions
 *     Tab-Translator-Pro asserts upstream. Re-asserting them here is not redundant:
 *     it proves the engine behaves identically when loaded as a native ES module in
 *     THIS repo (no Babel, no Blob URL, no in-browser transpile) rather than through
 *     the upstream zero-build loader.
 *
 *  2. THE SEAM. scoreToCSMPN output must parse through this repo's own parseCSMPN +
 *     parseBarStructures with ZERO warnings. That is the actual integration contract
 *     — everything downstream (fake book, Slash-Rhythm, exports, setlists) reads
 *     CSMPN, so if the handoff is clean the engine is usable by the whole app.
 *
 * Guitar Pro note: parseGuitarProOrXML is async (GP7/8 unzips via DecompressionStream),
 * so it is always awaited. The GP3/4/5 and Power Tab readers are synchronous.
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

/** Chord symbols per bar, de-duplicated — one entry per bar, repeats collapsed. */
const barSymbols = (score, from, to) =>
  score.bars.slice(from, to).map((b) => [...new Set(b.events.map((e) => e.symbol))].join(' '));

/** Load this repo's CSMPN parser stack into a vm context (browser globals). */
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

// ── Ground truth: Guitar Pro 3/4 binary ──────────────────────────────────────

test('GP3: Blue Sky rhythm track reproduces the verse E A A E E A A E', () => {
  const score = engine.parseGP345(bytes('the-allman-brothers-band-blue_sky.gp3'), true, 2);
  assert.equal(score.source, 'gp');
  assert.equal(score.tempo, 100);
  assert.equal(score.tuning, 'Standard');
  assert.equal(barSymbols(score, 0, 8).join(' '), 'E A A E E A A E');
});

test('GP3: Kid Charlemagne bars 27-28 resolve to C7 (the bars PDF geometry mis-reads)', () => {
  // Documented failure case: the PDF importer anchors this sparse system one string
  // off and reports Fm7. Reading the actual file is what gets it right.
  const score = engine.parseGP345(bytes('steely-dan-kid_charlemegne.gp3'), true, 0);
  assert.equal(score.parts[0].name, 'Rhythm Guitar');
  assert.deepEqual(barSymbols(score, 26, 28), ['C7', 'C7']);
});

test('GP4: Peg rhythm guitar reads the opening jazz changes', () => {
  const score = engine.parseGP345(bytes('Steely Dan - Peg.gp4'), true, 3);
  assert.equal(score.parts[3].name, 'Rhythm guitar');
  assert.equal(barSymbols(score, 0, 5).join(' | '), 'Gmaj7 | F#7 | Fmaj7 | E7 | Ebmaj7');
});

test('GP: every fret reconstructs its MIDI through the track tuning', () => {
  // Cross-check that string/fret and pitch agree — catches byte-misalignment, which
  // is the failure mode that matters in a hand-rolled binary reader.
  const score = engine.parseGP345(bytes('the-allman-brothers-band-blue_sky.gp3'), true, 2);
  const openE = [40, 45, 50, 55, 59, 64]; // standard tuning, low E first
  let checked = 0;
  for (const bar of score.bars) {
    for (const ev of bar.events) {
      if (!ev.frets || !ev.midis) continue;
      for (const [str, fret] of Object.entries(ev.frets)) {
        const expected = openE[Number(str)] + fret;
        assert.ok(ev.midis.includes(expected), `string ${str} fret ${fret} => MIDI ${expected}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `expected a meaningful sample, checked ${checked}`);
});

// ── Ground truth: Power Tab ──────────────────────────────────────────────────

test('Power Tab: .ptb parses to bars with tuning (completes CSMP’s Phase-A importer)', () => {
  const score = engine.parsePowerTab(
    bytes('tests', 'fixtures', 'a-major-shape-arpeggio.ptb'),
    true
  );
  assert.equal(score.bars.length, 10);
  assert.equal(score.tuning, 'Standard');
  assert.deepEqual(Array.from(score.timeSig), [4, 4]);
});

test('Power Tab: an arpeggio is detected as melodic and simplifies to one chord per bar', () => {
  const score = engine.parsePowerTab(
    bytes('tests', 'fixtures', 'a-major-shape-arpeggio.ptb'),
    true
  );
  assert.equal(engine.melodicFraction(score), 1);
  assert.equal(engine.isMelodicScore(score), true);
  const simplified = engine.simplifyScore(score, true);
  assert.equal(simplified.bars.length, 10);
  for (const bar of simplified.bars) {
    assert.equal(bar.events.length, 1, 'a simplified bar carries exactly one chord');
  }
});

// ── Format routing ───────────────────────────────────────────────────────────

test('parseGuitarProOrXML routes by magic bytes, not by file extension', async () => {
  const cases = [
    ['the-allman-brothers-band-blue_sky.gp3', 164],
    ['steely-dan-kid_charlemegne.gp3', 106],
    ['Steely Dan - Peg.gp4', 117],
  ];
  for (const [file, expectedBars] of cases) {
    const score = await engine.parseGuitarProOrXML(bytes(file), true);
    assert.equal(score.source, 'gp', `${file} routed to the Guitar Pro reader`);
    assert.equal(score.bars.length, expectedBars, `${file} bar count`);
  }
});

// ── The seam: engine output must be consumable as CSMPN ──────────────────────

test('scoreToCSMPN output parses through this repo’s parseCSMPN with zero warnings', () => {
  const { parseCSMPN } = loadCsmpnParser();
  const score = engine.parseGP345(bytes('Steely Dan - Peg.gp4'), true, 3);
  const csmpn = engine.scoreToCSMPN(score, { title: 'Peg', tempo: score.tempo, useSharp: true });

  const doc = parseCSMPN(csmpn);
  assert.deepEqual(doc.warnings || [], [], 'CSMPN handoff must be warning-free');
  assert.equal(doc.title, 'Peg');
  assert.equal(doc.time, '4/4');
  assert.equal(doc.tempo, '117');
  assert.ok(doc.blocks.length > 0);
});

test('CSMPN handoff carries the chart harmony into parsed bar structures', () => {
  const { parseCSMPN, parseBarStructures } = loadCsmpnParser();
  const score = engine.parseGP345(bytes('Steely Dan - Peg.gp4'), true, 3);
  const csmpn = engine.scoreToCSMPN(score, { title: 'Peg', tempo: score.tempo, useSharp: true });

  const doc = parseCSMPN(csmpn);
  // A real bar block is delimited by barline tokens; header lines are not.
  const barBlock = doc.blocks.find((b) => Array.isArray(b.tokens) && b.tokens.includes('|'));
  assert.ok(barBlock, 'expected at least one bar block');
  const bars = parseBarStructures(barBlock.tokens);
  assert.ok(bars.length > 0, 'bar structures parse out of the handoff');
  // The opening changes survive the round trip into real bar tokens.
  assert.equal(bars[0].token, 'Gmaj7');
});

test('Tuning:/Capo: headers are consumed as metadata, never parsed as a bar', () => {
  // Regression: the engine emits `Tuning:` (and `Capo:`) on every Guitar Pro and
  // Power Tab import, but parseCSMPN's metaRE only knew `Capo`. A "Tuning: Standard"
  // line therefore fell through to the content pass and became a leading BAR in every
  // handed-off chart. Both fields must be recognised as headers.
  const { parseCSMPN } = loadCsmpnParser();
  const doc = parseCSMPN(
    ['Title: T', 'Time: 4/4', 'Tuning: Drop D', 'Capo: 2', '', '- Chart', 'C | G |'].join('\n')
  );
  assert.equal(doc.tuning, 'Drop D');
  assert.equal(doc.capo, 2);
  const barBlocks = doc.blocks.filter((b) => Array.isArray(b.tokens) && b.tokens.length);
  assert.equal(barBlocks.length, 1, 'only the real chart line is a bar block');
  assert.ok(!JSON.stringify(barBlocks[0].tokens).includes('Tuning'));
});

test('CSMPN handoff uses the family enharmonic spelling (no A#/Db/D#/Gb/G#)', () => {
  const score = engine.parseGP345(bytes('Steely Dan - Peg.gp4'), true, 3);
  const csmpn = engine.scoreToCSMPN(score, { title: 'Peg', useSharp: true });
  for (const banned of ['A#', 'Db', 'D#', 'Gb', 'G#']) {
    assert.ok(!csmpn.includes(banned), `CSMPN must not spell ${banned}`);
  }
});

/*
 * recognitionEngineParity.test.mjs — drift guard for the VENDORED recognition engine.
 *
 * `recognitionEngine.mjs` is a byte-for-byte mirror of Tab-Translator-Pro's
 * `engine.tsx`. Two repos, one file: without a guard it silently forks the moment
 * either side is edited. Same problem, same shape of answer as
 * tests/chordTheoryParity.test.ts, which pins src/utils/fretToChord.ts equal to
 * chordTheory.js.
 *
 * Three things are guarded here:
 *   1. PROVENANCE — the local copy still hashes to what we recorded when we
 *      vendored it, so an in-repo edit (the thing that starts a fork) fails CI.
 *   2. PURITY — the engine stays React-free / DOM-free / dependency-free. That is
 *      an upstream invariant, and it is the ONLY reason this repo can load a
 *      2,800-line engine with no bundler, no Babel and no CDN.
 *   3. CROSS-REPO AGREEMENT — the engine's note spelling matches chordTheory.js.
 *      The family enharmonic default (Bb C# Eb F# Ab) is documented in all three
 *      repos; if either side re-spells, every downstream chart disagrees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

const provenance = JSON.parse(read('recognitionEngine.provenance.json'));
const engineSrc = readFileSync(new URL('../recognitionEngine.mjs', import.meta.url));
const engine = await import('../recognitionEngine.mjs');

function loadChordTheory() {
  const ctx = { window: {}, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('chordTheory.js'), ctx);
  return ctx.window.ChordTheory;
}

// ── 1. Provenance ────────────────────────────────────────────────────────────

test('vendored engine still matches its recorded upstream hash (no in-repo edits)', () => {
  const actual = createHash('sha256').update(engineSrc).digest('hex');
  assert.equal(
    actual,
    provenance.sha256,
    'recognitionEngine.mjs changed. It is a vendored mirror — edit it upstream in ' +
      'Tab-Translator-Pro/engine.tsx, re-copy, then update recognitionEngine.provenance.json.'
  );
});

test('provenance manifest records a resolvable upstream commit', () => {
  assert.match(provenance.upstream.commit, /^[0-9a-f]{40}$/);
  assert.equal(provenance.upstream.path, 'engine.tsx');
  assert.equal(provenance.vendoredFile, 'recognitionEngine.mjs');
  assert.equal(engineSrc.length, provenance.bytes);
});

// ── 2. Purity (what makes the zero-build load possible) ──────────────────────

test('engine is React-free and DOM-free', () => {
  const src = engineSrc.toString('utf8');
  // Strip comments/strings-in-prose is overkill; these identifiers never appear in
  // this engine's prose, so a bare source scan is the honest check.
  for (const forbidden of ['from "react"', "from 'react'", 'React.', 'useState(', 'document.']) {
    assert.ok(!src.includes(forbidden), `engine must not reference ${forbidden}`);
  }
});

test('engine has no import statements (zero dependencies, self-contained)', () => {
  const src = engineSrc.toString('utf8');
  assert.ok(
    !/^\s*import\s/m.test(src),
    'engine must stay dependency-free — it is loaded as a bare ES module with no bundler'
  );
});

test('engine parses as a native ES module and exports its public surface', () => {
  // Import success above already proves it parses; assert the API the app binds to.
  for (const fn of [
    'parseGuitarProOrXML',
    'parseGP345',
    'parseGPX',
    'parsePowerTab',
    'parseMusicXML',
    'scoreToCSMPN',
    'scoreToMusicXML',
    'scoreToMidi',
    'transposeScore',
    'analyzeKey',
    'transcribeChords',
    'detectPitch',
    'alignPcmToScore',
  ]) {
    assert.equal(typeof engine[fn], 'function', `missing export ${fn}`);
  }
});

// ── 3. Cross-repo agreement ──────────────────────────────────────────────────

test('engine NOTE_SHARP matches chordTheory.js NOTE_NAMES (family enharmonic default)', () => {
  const CT = loadChordTheory();
  assert.deepEqual(Array.from(engine.NOTE_SHARP), Array.from(CT.NOTE_NAMES));
});

test('the family default spells Bb C# Eb F# Ab — never A#/Db/D#/Gb/G#', () => {
  const names = Array.from(engine.NOTE_SHARP);
  assert.deepEqual(names, ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
  for (const banned of ['A#', 'Db', 'D#', 'Gb', 'G#']) {
    assert.ok(!names.includes(banned), `${banned} is not the family default spelling`);
  }
});

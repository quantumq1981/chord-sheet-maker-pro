import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadChordTheory() {
  const ctx = { window: {}, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('chordTheory.js'), ctx);
  return ctx.window.ChordTheory;
}

const CT = loadChordTheory();

test('NOTE_NAMES is the family canonical spelling (Bb C# Eb F# Ab — never A#/Db/D#/Gb/G#)', () => {
  assert.deepEqual(Array.from(CT.NOTE_NAMES), [
    'C',
    'C#',
    'D',
    'Eb',
    'E',
    'F',
    'F#',
    'G',
    'Ab',
    'A',
    'Bb',
    'B',
  ]);
});

test('CHORD_PATTERNS is well-formed (root-relative, root-0, deduped suffixes)', () => {
  assert.ok(Array.isArray(CT.CHORD_PATTERNS) && CT.CHORD_PATTERNS.length >= 20);
  const suffixes = new Set();
  for (const p of CT.CHORD_PATTERNS) {
    assert.equal(typeof p.suffix, 'string');
    assert.ok(Array.isArray(p.intervals) && p.intervals.length >= 2);
    assert.equal(p.intervals[0], 0, `${p.suffix} must start at the root (0)`);
    assert.ok(
      p.intervals.every((i) => i >= 0 && i < 12),
      `${p.suffix} intervals in 0..11`
    );
    assert.ok(!suffixes.has(p.suffix), `duplicate suffix ${p.suffix}`);
    suffixes.add(p.suffix);
  }
  // common qualities present
  for (const s of ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus4'])
    assert.ok(suffixes.has(s), `missing ${s}`);
});

test('the major triad is first (exact-match recognisers depend on order)', () => {
  assert.deepEqual(Array.from(CT.CHORD_PATTERNS[0].intervals), [0, 4, 7]);
  assert.equal(CT.CHORD_PATTERNS[0].suffix, '');
});

// ── inferKeyFromChords ────────────────────────────────────────────────────────

test('inferKeyFromChords: Dm from the Sultans of Swing progression', () => {
  // Verse loop: Dm C Bb A(7) F — every chord diatonic to D minor,
  // A/A7 (harmonic-minor V) rules out the relative major F.
  const chords = ['Dm', 'C', 'Bb', 'A', 'A7', 'Dm', 'C', 'Bb', 'F', 'C', 'A', 'Dm'];
  assert.equal(CT.inferKeyFromChords(chords), 'Dm');
});

test('inferKeyFromChords: plain major key (G)', () => {
  assert.equal(CT.inferKeyFromChords(['G', 'C', 'D', 'Em', 'C', 'D7', 'G']), 'G');
});

test('inferKeyFromChords: relative-minor tie broken by tonic chord (Am vs C)', () => {
  assert.equal(CT.inferKeyFromChords(['Am', 'F', 'C', 'G', 'Am']), 'Am');
  assert.equal(CT.inferKeyFromChords(['C', 'Am', 'F', 'G', 'C']), 'C');
});

test('inferKeyFromChords: flat keys use family spelling', () => {
  assert.equal(CT.inferKeyFromChords(['Eb', 'Ab', 'Bb7', 'Cm', 'Eb']), 'Eb');
});

test('inferKeyFromChords: ignores non-chord tokens and slash basses', () => {
  assert.equal(CT.inferKeyFromChords(['%', 'N.C.', 'D/F#', 'G', 'A7', 'D']), 'D');
});

test('inferKeyFromChords: null on empty or unparseable input', () => {
  assert.equal(CT.inferKeyFromChords([]), null);
  assert.equal(CT.inferKeyFromChords(['%', 'N.C.']), null);
  assert.equal(CT.inferKeyFromChords(null), null);
});

// ── Bass-priority chord recognition (the analysis sequence) ──────────────────

const rec = (w, bass, opts) => CT.recognizeChordFromPcs(w, bass, opts);

test('bass-priority: [C,E,G,A] is C6 with C in the bass, Am7 with A', () => {
  const pcs = { 0: 3, 4: 3, 7: 3, 9: 3 };
  assert.equal(rec(pcs, 0), 'C6');
  assert.equal(rec(pcs, 9), 'Am7');
});

test('bass-priority: [Bb,D,F,G] is Bb6 over Bb, Gm7 over G', () => {
  const pcs = { 10: 3, 2: 3, 5: 3, 7: 3 };
  assert.equal(rec(pcs, 10), 'Bb6');
  assert.equal(rec(pcs, 7), 'Gm7');
});

test('hybrid upper structure: Bb triad over C bass names as C9sus4', () => {
  // Bb(10) D(2) F(5) over a structural C(0) bass
  assert.equal(rec({ 0: 4, 10: 3, 2: 3, 5: 3 }, 0), 'C9sus4');
});

test('hybrid upper structure: G triad over E bass names as Em7', () => {
  assert.equal(rec({ 4: 4, 7: 3, 11: 3, 2: 3 }, 4), 'Em7');
});

test('tritone rule: root + 3rd + b7 resolves to the dominant reading', () => {
  assert.equal(rec({ 0: 3, 4: 3, 10: 3 }, 0), 'C7');
});

test('inversion labeling: chord-tone bass that is not the root gets a slash', () => {
  assert.equal(rec({ 0: 4, 4: 4, 7: 4 }, 4), 'C/E');
  assert.equal(rec({ 0: 4, 4: 4, 7: 4 }, 4, { slash: false }), 'C');
  assert.equal(rec({ 0: 4, 4: 4, 7: 4 }, 0), 'C'); // root bass: no slash
});

test('non-structural bass never steers naming', () => {
  // C major triad with a barely-sounding low F# (passing tone, < 10% weight)
  assert.equal(rec({ 0: 4, 4: 4, 7: 4, 6: 0.2 }, 6), 'C');
});

test('guardrails survive: lone notes and empty input stay null', () => {
  assert.equal(rec({ 2: 4 }, 2), null);
  assert.equal(rec({}, null), null);
  assert.equal(rec({ 2: 2, 4: 2 }, 2), null); // two adjacent melody notes
});

// ── Key-aware enharmonic spelling ─────────────────────────────────────────────

test('keyFifths: majors, minors, worded forms', () => {
  assert.equal(CT.keyFifths('C'), 0);
  assert.equal(CT.keyFifths('E'), 4);
  assert.equal(CT.keyFifths('Bb'), -2);
  assert.equal(CT.keyFifths('Dm'), -1);
  assert.equal(CT.keyFifths('F#m'), 3);
  assert.equal(CT.keyFifths('Eb major'), -3);
  assert.equal(CT.keyFifths('B minor'), 2);
  assert.equal(CT.keyFifths(''), null);
  assert.equal(CT.keyFifths('nonsense'), null);
});

test('spellPcForKey: sharp keys spell sharpward, flat keys flatward', () => {
  assert.equal(CT.spellPcForKey(8, 'E'), 'G#');
  assert.equal(CT.spellPcForKey(8, 'Fm'), 'Ab');
  assert.equal(CT.spellPcForKey(1, 'Db'), 'Db');
  assert.equal(CT.spellPcForKey(1, 'A'), 'C#');
  assert.equal(CT.spellPcForKey(10, 'F'), 'Bb');
  // Unknown / 0-fifths keys → family default (Bb C# Eb F# Ab)
  assert.equal(CT.spellPcForKey(8, 'C'), 'Ab');
  assert.equal(CT.spellPcForKey(8, null), 'Ab');
});

test('recognizeChordFromPcs spells recovered chords for the chart key', () => {
  // G#/Ab major triad: pcs 8, 0, 3
  const pcs = { 8: 4, 0: 3, 3: 3 };
  assert.equal(rec(pcs, 8, { key: 'E' }), 'G#');
  assert.equal(rec(pcs, 8), 'Ab');
});

// Cross-realm objects are not reference-equal to plain ones, so compare copies.
const split = (t) => {
  const r = CT.splitChordToken(t);
  return r ? { root: r.root, suffix: r.suffix, bass: r.bass } : r;
};

// ── Reading a chord token ─────────────────────────────────────────────────────
//
// Two things in a real chart contain a slash: the 6/9 family and a slash bass.
// Splitting naively on `/` reads `C6/9` as "C6 over the note 9" — not a chord —
// which is how every 6/9 in a Steely Dan "Peg" chart came to play silence.

test('a slash bass is split off, but a 6/9 quality keeps its slash', () => {
  assert.deepEqual(split('C6/9'), { root: 'C', suffix: '6/9', bass: null });
  assert.deepEqual(split('C6/9/D'), { root: 'C', suffix: '6/9', bass: 'D' });
  assert.deepEqual(split('C/E'), { root: 'C', suffix: '', bass: 'E' });
  assert.deepEqual(split('Cmaj7/G'), { root: 'C', suffix: 'maj7', bass: 'G' });
});

test('only a note name counts as a bass — a digit after the slash does not', () => {
  // The rule that separates the two meanings of `/`.
  for (const tok of ['C6/9', 'C9/11', 'C7/6']) {
    assert.equal(split(tok).bass, null, `${tok} has no bass`);
  }
  for (const [tok, bass] of [
    ['Bb6/9/G', 'G'],
    ['G9/D', 'D'],
    ['E7b9/D', 'D'],
    ['Am/C', 'C'],
  ]) {
    assert.equal(split(tok).bass, bass);
  }
});

test('splitting normalises unicode accidentals and drops accent marks', () => {
  assert.deepEqual(split('E♭maj7'), { root: 'Eb', suffix: 'maj7', bass: null });
  assert.deepEqual(split('F♯7'), { root: 'F#', suffix: '7', bass: null });
  assert.deepEqual(split('G7!'), { root: 'G', suffix: '7', bass: null });
});

test('non-chords split to null rather than a bogus root', () => {
  for (const tok of ['', '   ', '%', '%%', 'N.C.', 'NC', 'n.c.', null, undefined, 'xyz']) {
    assert.equal(split(tok), null, `${JSON.stringify(tok)} is not a chord`);
  }
});

// ── Suffix aliases ───────────────────────────────────────────────────────────

test('the 6/9 family lands on the one spelling the pattern table uses', () => {
  for (const s of ['6/9', '69', '6-9', '6add9']) {
    assert.equal(CT.normalizeChordSuffix(s), '6add9', `${s} should canonicalise`);
  }
  assert.deepEqual(Array.from(CT.intervalsForSuffix('6/9')), [0, 2, 4, 7, 9]);
});

test('case is preserved where it carries the chord — M7 is not m7', () => {
  // The one place a case-insensitive alias lookup would be catastrophic:
  // it would turn every major 7th into a minor 7th.
  assert.deepEqual(Array.from(CT.intervalsForSuffix('M7')), [0, 4, 7, 11], 'major 7');
  assert.deepEqual(Array.from(CT.intervalsForSuffix('m7')), [0, 3, 7, 10], 'minor 7');
  assert.deepEqual(Array.from(CT.intervalsForSuffix('Maj7')), [0, 4, 7, 11]);
  assert.deepEqual(Array.from(CT.intervalsForSuffix('min7')), [0, 3, 7, 10]);
});

test('bare maj is a major triad, not a major seventh', () => {
  for (const s of ['maj', 'major', 'Maj', 'M', '']) {
    assert.deepEqual(Array.from(CT.intervalsForSuffix(s)), [0, 4, 7], `${s} is a triad`);
  }
});

test('jazz shorthand glyphs resolve to real qualities', () => {
  assert.deepEqual(Array.from(CT.intervalsForSuffix('△7')), [0, 4, 7, 11]);
  assert.deepEqual(Array.from(CT.intervalsForSuffix('°7')), [0, 3, 6, 9]);
  assert.deepEqual(Array.from(CT.intervalsForSuffix('ø')), [0, 3, 6, 10]);
  assert.deepEqual(Array.from(CT.intervalsForSuffix('-7')), [0, 3, 7, 10]);
  assert.deepEqual(Array.from(CT.intervalsForSuffix('+')), [0, 4, 8]);
});

test('an unknown suffix returns null so callers can choose their own fallback', () => {
  assert.equal(CT.intervalsForSuffix('13b9#11'), null);
  assert.equal(CT.intervalsForSuffix('wat'), null);
});

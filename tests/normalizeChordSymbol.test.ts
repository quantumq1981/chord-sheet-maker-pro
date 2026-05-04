import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChordSymbol,
  splitMultiChordSpan,
  CHORD_REGEX,
} from '../src/ingest/chordNormalizer.js';

describe('normalizeChordSymbol', () => {
  // ── Unicode accidentals ───────────────────────────────────────────────────
  it('converts unicode flat ♭ to b', () => {
    assert.equal(normalizeChordSymbol('B♭7'), 'Bb7');
  });
  it('converts unicode sharp ♯ to #', () => {
    assert.equal(normalizeChordSymbol('F♯m7'), 'F#m7');
  });

  // ── Greek omicron (MuseScore diminished) ─────────────────────────────────
  it('maps Greek omicron ο + 7 to dim7 (E♭ο7 → Ebdim7)', () => {
    assert.equal(normalizeChordSymbol('E♭ο7'), 'Ebdim7');
  });
  it('maps Greek omicron ο alone to dim', () => {
    assert.equal(normalizeChordSymbol('Bο'), 'Bdim');
  });

  // ── Half-diminished (Ø) ───────────────────────────────────────────────────
  it('maps Ø to m7b5 (EØ → Em7b5)', () => {
    assert.equal(normalizeChordSymbol('EØ'), 'Em7b5');
  });
  it('maps Ø7 to m7b5 (EØ7 → Em7b5)', () => {
    assert.equal(normalizeChordSymbol('EØ7'), 'Em7b5');
  });
  it('maps ø (lowercase) to m7b5', () => {
    assert.equal(normalizeChordSymbol('Eø'), 'Em7b5');
  });

  // ── European maj7 suffix ──────────────────────────────────────────────────
  it('maps 7M suffix to maj7 (F7M → Fmaj7)', () => {
    assert.equal(normalizeChordSymbol('F7M'), 'Fmaj7');
  });
  it('maps Bb7M to Bbmaj7', () => {
    assert.equal(normalizeChordSymbol('B♭7M'), 'Bbmaj7');
  });

  // ── Jazz triangle shorthand j (MuseScore PDF extraction) ─────────────────
  it('maps j7 to maj7 (Dj7 → Dmaj7)', () => {
    assert.equal(normalizeChordSymbol('Dj7'), 'Dmaj7');
  });
  it('maps Fj7 to Fmaj7', () => {
    assert.equal(normalizeChordSymbol('Fj7'), 'Fmaj7');
  });
  it('maps Gj7 to Gmaj7', () => {
    assert.equal(normalizeChordSymbol('Gj7'), 'Gmaj7');
  });

  // ── Delta triangle Δ ──────────────────────────────────────────────────────
  it('maps Δ to maj7', () => {
    assert.equal(normalizeChordSymbol('CΔ'), 'Cmaj7');
  });
  it('maps Δ7 to maj7', () => {
    assert.equal(normalizeChordSymbol('CΔ7'), 'Cmaj7');
  });

  // ── Pseudo-slash: /b5 /#5 are alterations, not bass notes ────────────────
  it('strips /b5 pseudo-slash (C#m7/b5 → C#m7)', () => {
    assert.equal(normalizeChordSymbol('C#m7/b5'), 'C#m7');
  });
  it('strips /#5 pseudo-slash (C#m7/#5 → C#m7)', () => {
    assert.equal(normalizeChordSymbol('C#m7/#5'), 'C#m7');
  });
  it('preserves real slash chords (G/B unchanged)', () => {
    assert.equal(normalizeChordSymbol('G/B'), 'G/B');
  });
  it('preserves real slash chords with accidental (Cm6/Eb)', () => {
    assert.equal(normalizeChordSymbol('Cm6/E♭'), 'Cm6/Eb');
  });

  // ── Parenthesised omit qualifiers ────────────────────────────────────────
  it('strips (no5) from E7(no5)', () => {
    assert.equal(normalizeChordSymbol('E7(no5)'), 'E7');
  });
  it('strips (no3) from G7(no3)', () => {
    assert.equal(normalizeChordSymbol('G7(no3)'), 'G7');
  });

  // ── Standard cases pass through correctly ────────────────────────────────
  it('leaves plain major chord unchanged (G)', () => {
    assert.equal(normalizeChordSymbol('G'), 'G');
  });
  it('normalises minor (Amin → Am)', () => {
    assert.equal(normalizeChordSymbol('Amin'), 'Am');
  });
  it('normalises dim7 (Bdim7 passes through)', () => {
    assert.equal(normalizeChordSymbol('Bdim7'), 'Bdim7');
  });
  it('normalises aug (Caug passes through)', () => {
    assert.equal(normalizeChordSymbol('Caug'), 'Caug');
  });
  it('normalises sus4 (Dsus4 passes through)', () => {
    assert.equal(normalizeChordSymbol('Dsus4'), 'Dsus4');
  });
  it('handles stacked extensions (E7#9#5 passes through)', () => {
    // After unicode replacement: E7#9#5 — stays as-is (CHORD_REGEX handles via [0-9]+[b#][0-9]+)
    assert.equal(normalizeChordSymbol('E7♯9♯5'), 'E7#9#5');
  });
  it('handles 13b9 chord (G13b9 passes through)', () => {
    assert.equal(normalizeChordSymbol('G13♭9'), 'G13b9');
  });
  it('strips internal spaces from split PDF spans (C maj7 → Cmaj7 → C)', () => {
    // normalizeChordSymbol strips spaces first, then "maj" alone → stripped
    assert.equal(normalizeChordSymbol('C maj7'), 'Cmaj7');
  });

  // ── MajN suffixes (Steely Dan – Kid Charlemagne) ─────────────────────────
  it('maps CMaj9 to Cmaj9', () => {
    assert.equal(normalizeChordSymbol('CMaj9'), 'Cmaj9');
  });
  it('maps CMaj7 to Cmaj7 (already covered by existing Maj7 rule)', () => {
    assert.equal(normalizeChordSymbol('CMaj7'), 'Cmaj7');
  });
  it('maps FMaj7 to Fmaj7', () => {
    assert.equal(normalizeChordSymbol('FMaj7'), 'Fmaj7');
  });

  // ── 7sus4 / 9sus4 (Doobie Brothers, Carlton, Robben Ford) ────────────────
  it('passes A7sus4 through (dominant sus4)', () => {
    assert.equal(normalizeChordSymbol('A7sus4'), 'A7sus4');
    assert.ok(CHORD_REGEX.test('A7sus4'));
  });
  it('passes C7sus4 through', () => {
    assert.equal(normalizeChordSymbol('C7sus4'), 'C7sus4');
    assert.ok(CHORD_REGEX.test('C7sus4'));
  });
  it('passes G7sus4 through', () => {
    assert.equal(normalizeChordSymbol('G7sus4'), 'G7sus4');
    assert.ok(CHORD_REGEX.test('G7sus4'));
  });

  // ── European flat-suffix on extensions (Charlie Parker – Now's The Time) ──
  it('converts D79- (D7 flat-9 European notation) to D7b9', () => {
    assert.equal(normalizeChordSymbol('D79-'), 'D7b9');
  });
  it('converts F9- (F dominant flat-9, 7 implied) to F7b9', () => {
    assert.equal(normalizeChordSymbol('F9-'), 'F7b9');
  });
  it('converts G9- to G7b9', () => {
    assert.equal(normalizeChordSymbol('G9-'), 'G7b9');
  });
  it('strips /5+ pseudo-slash augmented-fifth (F7/5+ → F7)', () => {
    assert.equal(normalizeChordSymbol('F7/5+'), 'F7');
  });
  it('strips /add13 pseudo-slash annotation (Bb7/add13 → Bb7)', () => {
    assert.equal(normalizeChordSymbol('Bb7/add13'), 'Bb7');
  });

  // ── Bare "no5" without parentheses (Steely Dan – Kid Charlemagne) ─────────
  it('strips bare no5 from G6 no5', () => {
    assert.equal(normalizeChordSymbol('G6 no5'), 'G6');
  });
  it('strips bare no5 from D6 no5', () => {
    assert.equal(normalizeChordSymbol('D6 no5'), 'D6');
  });
  it('strips bare no5 from A6 no5', () => {
    assert.equal(normalizeChordSymbol('A6 no5'), 'A6');
  });

  // ── dim+b7 annotation (Steely Dan – Kid Charlemagne) ─────────────────────
  it('normalises Bdim +b7 to Bdim7', () => {
    assert.equal(normalizeChordSymbol('Bdim +b7'), 'Bdim7');
  });
  it('normalises Edim +b7 to Edim7', () => {
    assert.equal(normalizeChordSymbol('Edim +b7'), 'Edim7');
  });

  // ── Non-standard dim-after-digit (span-merge artifact) ───────────────────
  it('strips dim suffix after digit (E7dim → E7)', () => {
    assert.equal(normalizeChordSymbol('E7dim'), 'E7');
  });
  it('strips dim suffix after digit (A7dim → A7)', () => {
    assert.equal(normalizeChordSymbol('A7dim'), 'A7');
  });
  it('does not affect Edim7 (no digit before dim)', () => {
    assert.equal(normalizeChordSymbol('Edim7'), 'Edim7');
  });

  // ── Combined sus notation (Fsus2/4) ──────────────────────────────────────
  it('normalises Fsus2/4 to Fsus2', () => {
    assert.equal(normalizeChordSymbol('Fsus2/4'), 'Fsus2');
    assert.ok(CHORD_REGEX.test(normalizeChordSymbol('Fsus2/4')));
  });
  it('normalises Asus4/2 to Asus4', () => {
    assert.equal(normalizeChordSymbol('Asus4/2'), 'Asus4');
  });

  // ── CHORD_REGEX: plain major chords must match ────────────────────────────
  it('CHORD_REGEX matches plain major chord G', () => {
    assert.ok(CHORD_REGEX.test('G'));
  });
  it('CHORD_REGEX matches plain major chord D', () => {
    assert.ok(CHORD_REGEX.test('D'));
  });
  it('CHORD_REGEX matches real slash chord G/B', () => {
    assert.ok(CHORD_REGEX.test('G/B'));
  });
  it('CHORD_REGEX matches maj9 after MajN normalisation (Cmaj9)', () => {
    assert.ok(CHORD_REGEX.test(normalizeChordSymbol('CMaj9')));
  });

  // ── splitMultiChordSpan: no5 tokens filtered before validation ────────────
  it('splitMultiChordSpan filters no5 token (Dm7 G6 no5 → [Dm7, G6])', () => {
    assert.deepEqual(splitMultiChordSpan('Dm7 G6 no5'), ['Dm7', 'G6']);
  });
  it('splitMultiChordSpan returns null for single chord with no5 (G6 no5)', () => {
    assert.equal(splitMultiChordSpan('G6 no5'), null);
  });

  // ── Parenthesised tension/voicing decorators (UG Pro edge cases) ──────────
  it('strips parenthesised number suffix: C7M(8) → Cmaj7', () => {
    assert.equal(normalizeChordSymbol('C7M(8)'), 'Cmaj7');
    assert.ok(CHORD_REGEX.test(normalizeChordSymbol('C7M(8)')));
  });
  it('strips (7) after pseudo-slash removal: Bm7/5+(7) → Bm7', () => {
    assert.equal(normalizeChordSymbol('Bm7/5+(7)'), 'Bm7');
    assert.ok(CHORD_REGEX.test(normalizeChordSymbol('Bm7/5+(7)')));
  });
  it('strips bare (7) suffix on a plain chord: G(7) → G', () => {
    assert.equal(normalizeChordSymbol('G(7)'), 'G');
  });

  // ── sus4add9 / sus2add9 compound quality ─────────────────────────────────
  it('CHORD_REGEX matches Dsus4add9 via sus[24](?:add\\d+)?', () => {
    assert.ok(CHORD_REGEX.test('Dsus4add9'));
  });
  it('CHORD_REGEX matches Csus2add11', () => {
    assert.ok(CHORD_REGEX.test('Csus2add11'));
  });
  it('normalizeChordSymbol leaves Dsus4add9 unchanged (already canonical)', () => {
    assert.equal(normalizeChordSymbol('Dsus4add9'), 'Dsus4add9');
  });
});

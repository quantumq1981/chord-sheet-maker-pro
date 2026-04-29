import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChordSymbol } from '../src/ingest/chordNormalizer.js';

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
});

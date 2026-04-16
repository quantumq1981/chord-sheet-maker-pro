/**
 * slashFeatures.test.ts
 *
 * Tests for the ASC/ASL font-feature-settings logic used in index.html.
 *
 * Two distinct behaviours are tested:
 *
 * 1. fbChordFeatures(fontPack) — mirrors the CSS-variable logic in
 *    applyFBSettings() that drives --fb-chord-features.  The variable is set
 *    to '"ss01" 1' only when an ASC pack (pori / norfolk / norfolksans) is
 *    active; otherwise it is 'normal'.
 *
 * 2. snChordFeatures(chordStr) — mirrors the getChordFontFeatures() function
 *    inside the Slash Notation IIFE (~line 6839).  The SN slashChordFont stack
 *    always includes ASC fonts for every pack (even "default"), so ss01 is
 *    applied whenever the chord string contains a slash character.
 *
 * If you change pack IDs, CSS variable values, or the ss01 triggering logic in
 * index.html, update these tests to match.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Fake Book font-feature-settings (CSS variable) ──────────────────────────

/** Mirrors the isAscPack / --fb-chord-features logic in applyFBSettings(). */
function fbChordFeatures(fontPack: string): string {
  const ASC_PACKS = ['pori', 'norfolk', 'norfolksans'];
  return ASC_PACKS.includes(fontPack) ? '"ss01" 1' : 'normal';
}

test('fbChordFeatures: default pack → normal (no ASC font in fakeBookChordFont stack)', () => {
  assert.equal(fbChordFeatures('default'), 'normal');
});

test('fbChordFeatures: pori pack → "ss01" 1', () => {
  assert.equal(fbChordFeatures('pori'), '"ss01" 1');
});

test('fbChordFeatures: norfolk pack → "ss01" 1', () => {
  assert.equal(fbChordFeatures('norfolk'), '"ss01" 1');
});

test('fbChordFeatures: norfolksans pack → "ss01" 1', () => {
  assert.equal(fbChordFeatures('norfolksans'), '"ss01" 1');
});

test('fbChordFeatures: unknown pack → normal (safe fallback)', () => {
  assert.equal(fbChordFeatures('unknown'), 'normal');
  assert.equal(fbChordFeatures(''), 'normal');
});

// ── Slash Notation SVG font-feature-settings ─────────────────────────────────

/**
 * Mirrors the core slash-detection logic of getChordFontFeatures() in the SN
 * IIFE.  The SN slashChordFont always includes ASC fonts for all packs, so
 * ss01 is applied for any chord containing "/" (or the legacy "?" separator).
 * Returns the fontFeatureSettings string, or '' for non-slash chords.
 */
function snChordFeatures(chordStr: string): string {
  const s = (chordStr || '').trim();
  if (!s) return '';
  // Legacy ASC input: "D?F#" → "D/F#" + angled slash
  if (s.includes('?') || s.includes('/')) return '"ss01" 1';
  return '';
}

test('snChordFeatures: standard slash chord D/F# → "ss01" 1', () => {
  assert.equal(snChordFeatures('D/F#'), '"ss01" 1');
});

test('snChordFeatures: flat bass Ebm7/Bb → "ss01" 1', () => {
  assert.equal(snChordFeatures('Ebm7/Bb'), '"ss01" 1');
});

test('snChordFeatures: legacy ? separator D?F# → "ss01" 1', () => {
  assert.equal(snChordFeatures('D?F#'), '"ss01" 1');
});

test('snChordFeatures: non-slash chord Cmaj7 → empty string', () => {
  assert.equal(snChordFeatures('Cmaj7'), '');
});

test('snChordFeatures: N.C. → empty string', () => {
  assert.equal(snChordFeatures('N.C.'), '');
});

test('snChordFeatures: empty string → empty string', () => {
  assert.equal(snChordFeatures(''), '');
});

// ── formatNavText — Segno/Coda symbol substitution ───────────────────────────

/**
 * Mirrors formatNavText() from the Slash Notation IIFE.
 * Verifies that navigation keywords are replaced with their Unicode musical
 * symbols (𝄋 Segno U+1D10B, 𝄌 Coda U+1D10C) before SVG rendering.
 */
function formatNavText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\bDAL\s+SEGNO\b/gi, 'D.S.\uD834\uDD0B')
    .replace(/\bDA\s+CAPO\b/gi, 'D.C.')
    .replace(/\bD\.S\.(?=\s|$)/g, 'D.S.\uD834\uDD0B')
    .replace(/\bSEGNO\b/gi, '\uD834\uDD0B')
    .replace(/\bTO\s+CODA\b/gi, 'To \uD834\uDD0C')
    .replace(/\bAL\s+CODA\b/gi, 'al \uD834\uDD0C')
    .replace(/\bCODA\b/gi, '\uD834\uDD0C');
}

test('formatNavText: SEGNO → 𝄋 symbol', () => {
  assert.equal(formatNavText('SEGNO'), '\uD834\uDD0B');
});

test('formatNavText: D.S. → D.S.𝄋', () => {
  assert.equal(formatNavText('D.S. al Fine'), 'D.S.\uD834\uDD0B al Fine');
});

test('formatNavText: DAL SEGNO → D.S.𝄋', () => {
  assert.equal(formatNavText('Dal Segno'), 'D.S.\uD834\uDD0B');
});

test('formatNavText: CODA → 𝄌 symbol', () => {
  assert.equal(formatNavText('CODA'), '\uD834\uDD0C');
});

test('formatNavText: TO CODA → To 𝄌', () => {
  assert.equal(formatNavText('To Coda'), 'To \uD834\uDD0C');
});

test('formatNavText: AL CODA → al 𝄌', () => {
  assert.equal(formatNavText('D.S. al Coda'), 'D.S.\uD834\uDD0B al \uD834\uDD0C');
});

test('formatNavText: DA CAPO → D.C. (no symbol)', () => {
  assert.equal(formatNavText('Da Capo'), 'D.C.');
});

test('formatNavText: plain Fine unchanged', () => {
  assert.equal(formatNavText('D.C. al Fine'), 'D.C. al Fine');
});

test('formatNavText: empty string → empty string', () => {
  assert.equal(formatNavText(''), '');
});

// ── rehearsalMarkLetter — single-letter section detection ─────────────────────

/** Mirrors rehearsalMarkLetter() from the Slash Notation IIFE. */
function rehearsalMarkLetter(label: string | null): string | null {
  if (!label) return null;
  const m = label.trim().match(/^\[?([A-Z])\]?$/i);
  return m ? m[1].toUpperCase() : null;
}

test('rehearsalMarkLetter: bare letter A → "A"', () => {
  assert.equal(rehearsalMarkLetter('A'), 'A');
});

test('rehearsalMarkLetter: bracketed [B] → "B"', () => {
  assert.equal(rehearsalMarkLetter('[B]'), 'B');
});

test('rehearsalMarkLetter: lowercase b → "B"', () => {
  assert.equal(rehearsalMarkLetter('b'), 'B');
});

test('rehearsalMarkLetter: "Verse" → null (not a single letter)', () => {
  assert.equal(rehearsalMarkLetter('Verse'), null);
});

test('rehearsalMarkLetter: "AB" → null (two letters)', () => {
  assert.equal(rehearsalMarkLetter('AB'), null);
});

test('rehearsalMarkLetter: null → null', () => {
  assert.equal(rehearsalMarkLetter(null), null);
});

// ── isCompoundMeter — dotted-beat time signature detection ────────────────────

/** Mirrors isCompoundMeter() from the Slash Notation IIFE. */
function isCompoundMeter(ts: string): boolean {
  if (!ts) return false;
  const m = ts.match(/^(\d+)\/8$/);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  return n >= 6 && n % 3 === 0;
}

test('isCompoundMeter: 6/8 → true', () => {
  assert.equal(isCompoundMeter('6/8'), true);
});

test('isCompoundMeter: 9/8 → true', () => {
  assert.equal(isCompoundMeter('9/8'), true);
});

test('isCompoundMeter: 12/8 → true', () => {
  assert.equal(isCompoundMeter('12/8'), true);
});

test('isCompoundMeter: 4/4 → false', () => {
  assert.equal(isCompoundMeter('4/4'), false);
});

test('isCompoundMeter: 3/4 → false', () => {
  assert.equal(isCompoundMeter('3/4'), false);
});

test('isCompoundMeter: 3/8 → false (not compound — only 3 beats, not divisible by 3 in groups)', () => {
  assert.equal(isCompoundMeter('3/8'), false);
});

test('isCompoundMeter: 5/8 → false', () => {
  assert.equal(isCompoundMeter('5/8'), false);
});

test('isCompoundMeter: empty string → false', () => {
  assert.equal(isCompoundMeter(''), false);
});

// ── formatChordQuality accidental conversion ──────────────────────────────────

/**
 * Mirrors the accidental-conversion step added at the end of formatChordQuality()
 * in chordProcessing.js. Only the conversion rule is tested here — the full
 * quality formatting (maj7Style, minorStyle, etc.) depends on fbSettings globals
 * that are not available in the test environment.
 *
 * Rule: b/# that follows a digit, '(' or ',' and precedes a digit is converted
 * to the Unicode accidental symbol ♭/♯.
 */
function convertTensionAccidentals(q: string): string {
  return q.replace(/([\d(,])b(?=\d)/g, '$1♭').replace(/([\d(,])#(?=\d)/g, '$1♯');
}

test('convertTensionAccidentals: 7b9 → 7♭9', () => {
  assert.equal(convertTensionAccidentals('7b9'), '7♭9');
});

test('convertTensionAccidentals: 7#9 → 7♯9', () => {
  assert.equal(convertTensionAccidentals('7#9'), '7♯9');
});

test('convertTensionAccidentals: maj13(#11) → maj13(♯11)', () => {
  assert.equal(convertTensionAccidentals('maj13(#11)'), 'maj13(♯11)');
});

test('convertTensionAccidentals: 7(b9,#11) → 7(♭9,♯11)', () => {
  assert.equal(convertTensionAccidentals('7(b9,#11)'), '7(♭9,♯11)');
});

test('convertTensionAccidentals: m7b5 → m7♭5 (half-dim notation)', () => {
  assert.equal(convertTensionAccidentals('m7b5'), 'm7♭5');
});

test('convertTensionAccidentals: 9sus4 unchanged (no accidentals)', () => {
  assert.equal(convertTensionAccidentals('9sus4'), '9sus4');
});

test('convertTensionAccidentals: dim7 unchanged', () => {
  assert.equal(convertTensionAccidentals('dim7'), 'dim7');
});

test('convertTensionAccidentals: empty string → empty string', () => {
  assert.equal(convertTensionAccidentals(''), '');
});

// ── chordKind MusicXML mapping ────────────────────────────────────────────────

/**
 * Mirrors chordKind() from the Slash Notation IIFE in index.html.
 * Handles all dimStyle variants ('°', 'dim', 'o'), minorStyle variants
 * ('m', 'min', '−'), maj7Style variants ('maj', 'MA', 'Δ'), and corrects
 * aug vs aug7 ordering so aug7 is not swallowed by the aug catch-all.
 */
function chordKind(quality: string): string {
  if (!quality) return 'major';
  const q = quality.toLowerCase();
  // Half-diminished first — must precede minor checks
  if (q.startsWith('ø') || q === 'm7♭5' || q === 'm7b5') return 'half-diminished';
  // Major-seventh: maj7/MA7/Δ7 and all extended forms (maj9, Δ13, etc.)
  if (q.startsWith('maj') || q.startsWith('ma') || q.startsWith('δ')) return 'major-seventh';
  // Diminished-seventh: °7, dim7, o7 (letter o convention)
  if (q.startsWith('°7') || q.startsWith('dim7') || q === 'o7' || q.startsWith('o7'))
    return 'diminished-seventh';
  // Diminished: °, dim, o
  if (q.startsWith('°') || q.startsWith('dim') || q === 'o' || q.startsWith('o '))
    return 'diminished';
  // Augmented-seventh — must precede augmented to prevent aug eating aug7
  if (q.startsWith('+7') || q.startsWith('aug7') || q.startsWith('7#5') || q.startsWith('7♯5'))
    return 'augmented-seventh';
  // Augmented: + or aug (without 7)
  if (q === '+' || q.startsWith('aug')) return 'augmented';
  // Minor — all style variants: m, min, mi, − (U+2212 minus sign)
  if (q === 'm' || q === 'min' || q === 'mi' || q === '−') return 'minor';
  // Minor-seventh and extended minor
  if (q.startsWith('m7') || q.startsWith('min7') || q.startsWith('mi7') || q.startsWith('−7'))
    return 'minor-seventh';
  if (q.startsWith('m') && /\d/.test(q)) return 'minor-seventh'; // m9, m11, m13
  if (q.startsWith('−') && /\d/.test(q)) return 'minor-seventh'; // −9, −11, −13
  // Major-sixth
  if (q === '6' || q.startsWith('6/9')) return 'major-sixth';
  // Dominant: 7 and extensions (7b9, 9, 11, 13, etc.)
  if (q === '7') return 'dominant';
  if (/^[79]/.test(q) || q.startsWith('13') || q.startsWith('11')) return 'dominant';
  // Suspended
  if (q.startsWith('sus4') || q === 'sus') return 'suspended-fourth';
  if (q.startsWith('sus2')) return 'suspended-second';
  return 'major';
}

test('chordKind: no quality → major', () => {
  assert.equal(chordKind(''), 'major');
});

test('chordKind: maj7 → major-seventh', () => {
  assert.equal(chordKind('maj7'), 'major-seventh');
});

test('chordKind: maj9 → major-seventh (extended major)', () => {
  assert.equal(chordKind('maj9'), 'major-seventh');
});

test('chordKind: Δ7 → major-seventh (triangle style)', () => {
  assert.equal(chordKind('Δ7'), 'major-seventh');
});

test('chordKind: Δ9 → major-seventh (triangle extended)', () => {
  assert.equal(chordKind('Δ9'), 'major-seventh');
});

test('chordKind: m → minor', () => {
  assert.equal(chordKind('m'), 'minor');
});

test('chordKind: − → minor (minus style)', () => {
  assert.equal(chordKind('−'), 'minor');
});

test('chordKind: m7 → minor-seventh', () => {
  assert.equal(chordKind('m7'), 'minor-seventh');
});

test('chordKind: −7 → minor-seventh (minus style)', () => {
  assert.equal(chordKind('−7'), 'minor-seventh');
});

test('chordKind: m9 → minor-seventh (extended minor)', () => {
  assert.equal(chordKind('m9'), 'minor-seventh');
});

test('chordKind: 7 → dominant', () => {
  assert.equal(chordKind('7'), 'dominant');
});

test('chordKind: 9 → dominant', () => {
  assert.equal(chordKind('9'), 'dominant');
});

test('chordKind: dim → diminished', () => {
  assert.equal(chordKind('dim'), 'diminished');
});

test('chordKind: dim7 → diminished-seventh', () => {
  assert.equal(chordKind('dim7'), 'diminished-seventh');
});

test('chordKind: ° → diminished (degree symbol style)', () => {
  assert.equal(chordKind('°'), 'diminished');
});

test('chordKind: °7 → diminished-seventh (degree symbol style)', () => {
  assert.equal(chordKind('°7'), 'diminished-seventh');
});

test('chordKind: o → diminished (letter-o style)', () => {
  assert.equal(chordKind('o'), 'diminished');
});

test('chordKind: o7 → diminished-seventh (letter-o style)', () => {
  assert.equal(chordKind('o7'), 'diminished-seventh');
});

test('chordKind: + → augmented', () => {
  assert.equal(chordKind('+'), 'augmented');
});

test('chordKind: aug → augmented', () => {
  assert.equal(chordKind('aug'), 'augmented');
});

test('chordKind: aug7 → augmented-seventh (not swallowed by aug)', () => {
  assert.equal(chordKind('aug7'), 'augmented-seventh');
});

test('chordKind: +7 → augmented-seventh', () => {
  assert.equal(chordKind('+7'), 'augmented-seventh');
});

test('chordKind: 6 → major-sixth', () => {
  assert.equal(chordKind('6'), 'major-sixth');
});

test('chordKind: 6/9 → major-sixth', () => {
  assert.equal(chordKind('6/9'), 'major-sixth');
});

test('chordKind: ø → half-diminished', () => {
  assert.equal(chordKind('ø'), 'half-diminished');
});

test('chordKind: m7♭5 → half-diminished', () => {
  assert.equal(chordKind('m7♭5'), 'half-diminished');
});

test('chordKind: sus4 → suspended-fourth', () => {
  assert.equal(chordKind('sus4'), 'suspended-fourth');
});

test('chordKind: sus2 → suspended-second', () => {
  assert.equal(chordKind('sus2'), 'suspended-second');
});

test('chordKind: add9 → major', () => {
  assert.equal(chordKind('add9'), 'major');
});

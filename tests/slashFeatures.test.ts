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
    .replace(/\bDAL\s+SEGNO\b/gi,        'D.S.\uD834\uDD0B')
    .replace(/\bDA\s+CAPO\b/gi,          'D.C.')
    .replace(/\bD\.S\.(?=\s|$)/g,        'D.S.\uD834\uDD0B')
    .replace(/\bSEGNO\b/gi,              '\uD834\uDD0B')
    .replace(/\bTO\s+CODA\b/gi,          'To \uD834\uDD0C')
    .replace(/\bAL\s+CODA\b/gi,          'al \uD834\uDD0C')
    .replace(/\bCODA\b/gi,               '\uD834\uDD0C');
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

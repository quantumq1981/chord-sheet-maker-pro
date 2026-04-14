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

import test from 'node:test';
import assert from 'node:assert/strict';
import { sniffFormatFromText, sniffFormatFromBytes } from '../src/ingest/sniffFormat.js';

// ── Text-based detection ────────────────────────────────────────────────────

test('ChordPro directive → chordpro', () => {
  const text = '{title: My Song}\n{artist: Someone}\n[Cm7]verse lyrics\n';
  assert.equal(sniffFormatFromText(text).format, 'chordpro');
});

test('UG section header → ultimateguitar', () => {
  const text = '[Verse 1]\nAm7         F7\nSome lyrics here\n';
  assert.equal(sniffFormatFromText(text).format, 'ultimateguitar');
});

test('CSMPN fakebook barlines → fakebook', () => {
  const text = 'Title: Blue Bossa\n\n[A]\n|: Cm7 | F7 | Bb7 | Eb7 :|\n';
  assert.equal(sniffFormatFromText(text).format, 'fakebook');
});

test('ABC X: header → abc', () => {
  const text = 'X:1\nT:Greensleeves\nK:Am\n|: A2 |"Am"c3 |\n';
  assert.equal(sniffFormatFromText(text).format, 'abc');
});

test('MusicXML score-partwise → musicxml', () => {
  const text = '<?xml version="1.0"?>\n<score-partwise version="3.1">\n</score-partwise>\n';
  assert.equal(sniffFormatFromText(text).format, 'musicxml');
});

test('bare bracket chords (no UG section) → chordpro', () => {
  const text = 'Some text with [Am7] inline and [F/C] chords\n';
  assert.equal(sniffFormatFromText(text).format, 'chordpro');
});

// ── Bytes-based detection ───────────────────────────────────────────────────

test('PDF magic bytes → pdf', () => {
  // %PDF-1.4
  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  assert.equal(sniffFormatFromBytes(bytes, 'chart.pdf').format, 'pdf');
});

test('.pdf extension → pdf regardless of content', () => {
  const bytes = new TextEncoder().encode('{title: Test}\n');
  assert.equal(sniffFormatFromBytes(bytes, 'mysong.pdf').format, 'pdf');
});

test('.cho extension → chordpro via extension fallback', () => {
  // Content that has no strong signal, but extension is .cho
  const bytes = new TextEncoder().encode('C  G  Am  F\n');
  assert.equal(sniffFormatFromBytes(bytes, 'song.cho').format, 'chordpro');
});

test('ZIP magic bytes (non-GP) → mxl', () => {
  // PK\x03\x04 is the ZIP local-file magic
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
  assert.equal(sniffFormatFromBytes(bytes, 'score.mxl').format, 'mxl');
});

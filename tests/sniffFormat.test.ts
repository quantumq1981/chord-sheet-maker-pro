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

test('.xml extension with <?xml and score-partwise → musicxml', () => {
  const bytes = new TextEncoder().encode('<?xml version="1.0"?>\n<score-partwise>\n</score-partwise>');
  assert.equal(sniffFormatFromBytes(bytes, 'score.xml').format, 'musicxml');
});

test('.gp5 extension → guitarpro regardless of content', () => {
  const bytes = new TextEncoder().encode('irrelevant content');
  assert.equal(sniffFormatFromBytes(bytes, 'tab.gp5').format, 'guitarpro');
});

test('fakebook simile marker in byte-decoded text → fakebook', () => {
  const text = 'Title: My Song\n\n[A]\n| Cmaj7 \u00B7/\u00B7 | F7 |\n';
  const bytes = new TextEncoder().encode(text);
  assert.equal(sniffFormatFromBytes(bytes, 'song.txt').format, 'fakebook');
});

// ── Edge cases: empty / plain content ──────────────────────────────────────

test('empty string → unknown', () => {
  assert.equal(sniffFormatFromText('').format, 'unknown');
});

test('plain prose (no music signals) → unknown', () => {
  const text = 'This is just a paragraph of text.\nNo chords or directives here.\nJust words and sentences.';
  assert.equal(sniffFormatFromText(text).format, 'unknown');
});

test('chord-over-words (two all-chord lines above lyric lines) → chords-over-words', () => {
  // Each chord line must have ≥2 chord tokens and ≥70% chord tokens
  const text = 'Am7 F7 C G\nThese are lyrics\nEm7 Dm7 G7 C\nMore lyrics here\n';
  assert.equal(sniffFormatFromText(text).format, 'chords-over-words');
});

test('SVG content with viewBox attribute → svg', () => {
  const text = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>';
  assert.equal(sniffFormatFromText(text).format, 'svg');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsmpn, expandCsmpnRepeats } from '../src/parsers/csmpnParser.js';
import type { ChordToken } from '../src/models/ChordChartModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'txt');

/** The simile marker used for '%' repeat bars in CSMPN. */
const SIMILE = '\u00B7/\u00B7';

/** Collect all chord texts from a section's lines. */
function sectionChords(doc: ReturnType<typeof parseCsmpn>, sectionIndex = 0): string[] {
  const chords: string[] = [];
  const section = doc.sections[sectionIndex];
  if (!section) return chords;
  for (const line of section.lines) {
    for (const tok of line.tokens) {
      if (tok.kind === 'chord') chords.push((tok as ChordToken).text);
    }
  }
  return chords;
}

// ── Metadata ────────────────────────────────────────────────────────────────

test('parseCsmpn: title and composer extracted', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);

  assert.equal(doc.title, 'Blue Bossa');
  assert.equal(doc.artist, 'Kenny Dorham');
});

test('parseCsmpn: key, time, and tempo extracted', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);

  assert.equal(doc.key, 'Cm');
  assert.equal(doc.time, '3/4');
  assert.equal(doc.tempo, '120');
});

// ── Section structure ───────────────────────────────────────────────────────

test('parseCsmpn: exactly one section created', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);

  assert.equal(doc.sections.length, 1);
});

test('parseCsmpn: section label is "A"', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);

  assert.equal(doc.sections[0].label, 'A');
});

test('parseCsmpn: two bar-lines in section', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);

  assert.equal(doc.sections[0].lines.length, 2);
});

// ── Chord accuracy ──────────────────────────────────────────────────────────

test('parseCsmpn: eight chord tokens across both lines', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.equal(chords.length, 8);
});

test('parseCsmpn: first chord is Cm7', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.equal(chords[0], 'Cm7');
});

test('parseCsmpn: Ebmaj7 is present in bar line 2', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes('Ebmaj7'), 'Ebmaj7 should be present');
});

test('parseCsmpn: simile marker present for % bar', () => {
  const text = readFileSync(join(fixtureDir, 'simple.csmpn'), 'utf-8');
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes(SIMILE), '% should render as simile marker ·/·');
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test('parseCsmpn: empty string returns one default section with no lines', () => {
  const doc = parseCsmpn('');

  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].label, 'Chart');
  assert.equal(doc.sections[0].lines.length, 0);
});

test('parseCsmpn: metadata-only input extracts metadata and creates default section', () => {
  const text = 'Title: My Song\nComposer: John Doe\nKey: G\nTime: 4/4\n';
  const doc = parseCsmpn(text);

  assert.equal(doc.title, 'My Song');
  assert.equal(doc.artist, 'John Doe');
  assert.equal(doc.key, 'G');
  assert.equal(doc.time, '4/4');
  // No bar content → falls back to default empty section
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].lines.length, 0);
});

test('parseCsmpn: two named sections both appear in correct order', () => {
  const text = '[A]\n| Cmaj7 | Dm7 | G7 | Cmaj7 |\n\n[B]\n| Fmaj7 | Em7 | Dm7 | Cmaj7 |\n';
  const doc = parseCsmpn(text);

  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].label, 'A');
  assert.equal(doc.sections[1].label, 'B');
});

test('parseCsmpn: N.C. token produces chord token with text "N.C."', () => {
  const text = '[Intro]\n| N.C. | Cmaj7 |\n';
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes('N.C.'), 'N.C. should appear as a chord token');
});

test('parseCsmpn: |: and :| repeat barlines produce correct barline tokens', () => {
  const text = '[A]\n|: Cmaj7 | F7 :|\n';
  const doc = parseCsmpn(text);
  const barlines = doc.sections[0].lines[0].tokens
    .filter((t) => t.kind === 'barline')
    .map((t) => t.text);

  assert.ok(barlines.includes('|:'), 'Should include |: open-repeat barline');
  assert.ok(barlines.includes(':|'), 'Should include :| close-repeat barline');
});

test('parseCsmpn: bare bar content outside any section auto-creates Chart section', () => {
  const text = '| Cmaj7 | F7 | G7 | Cmaj7 |\n';
  const doc = parseCsmpn(text);

  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].label, 'Chart');
  const chords = sectionChords(doc);
  assert.ok(chords.includes('Cmaj7'));
});

test('parseCsmpn: legacy ASC separator "?" remains parseable as chord token text', () => {
  const text = '[A]\n| D?F# | G7 |\n';
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes('D?F#'));
});

test('parseCsmpn: ASC flatter-angle suffix "z" is preserved in chord text', () => {
  const text = '[A]\n| D/F#z | G7 |\n';
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes('D/F#z'));
});

test('parseCsmpn: ASC small-caps marker "`" is preserved in chord text', () => {
  const text = '[A]\n| D/F#` | G7 |\n';
  const doc = parseCsmpn(text);
  const chords = sectionChords(doc);

  assert.ok(chords.includes('D/F#`'));
});

// ── expandCsmpnRepeats ───────────────────────────────────────────────────────

test('expandCsmpnRepeats: |: ... :| doubles the chord group', () => {
  const out = expandCsmpnRepeats('|: C Am F G :|');
  assert.ok(out.includes('C Am F G C Am F G'), `got: ${out}`);
});

test('expandCsmpnRepeats: |: ... :| x3 repeats three times', () => {
  const out = expandCsmpnRepeats('|: Dm7 G7 :| x3');
  const count = (out.match(/Dm7/g) ?? []).length;
  assert.equal(count, 3);
});

test('expandCsmpnRepeats: inner | bar separator is preserved', () => {
  const out = expandCsmpnRepeats('|: C Am | F G :|');
  assert.ok(out.includes('C Am | F G C Am | F G'), `got: ${out}`);
});

test('expandCsmpnRepeats: two repeat groups on one line both expand', () => {
  const out = expandCsmpnRepeats('|: C G :| |: Am F :| x3');
  const cCount = (out.match(/\bC\b/g) ?? []).length;
  const amCount = (out.match(/Am/g) ?? []).length;
  assert.equal(cCount, 2);
  assert.equal(amCount, 3);
});

test('expandCsmpnRepeats: metadata and marker lines pass through unchanged', () => {
  const input = 'Title: My Song\n- Verse\nC G Am F';
  assert.equal(expandCsmpnRepeats(input), input);
});

test('expandCsmpnRepeats: barRepeats:false leaves text unchanged', () => {
  const input = '|: C Am F G :|';
  assert.equal(expandCsmpnRepeats(input, { barRepeats: false }), input);
});

test('expandCsmpnRepeats: empty string returns empty string', () => {
  assert.equal(expandCsmpnRepeats(''), '');
});

test('expandCsmpnRepeats: non-repeat chord line passes through unchanged', () => {
  const input = 'C Am F G';
  assert.equal(expandCsmpnRepeats(input), input);
});

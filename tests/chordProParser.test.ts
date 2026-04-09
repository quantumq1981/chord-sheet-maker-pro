import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseChordPro, parseUltimateGuitar } from '../src/parsers/chordProParser.js';
import type { ChordToken } from '../src/models/ChordChartModel.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'txt');

/** Collect all chord token texts from a ChordChartDocument, across all sections and lines. */
function allChordTexts(doc: ReturnType<typeof parseChordPro>): string[] {
  const chords: string[] = [];
  for (const section of doc.sections) {
    for (const line of section.lines) {
      for (const tok of line.tokens) {
        if (tok.kind === 'chord') chords.push((tok as ChordToken).text);
      }
    }
  }
  return chords;
}

// ── ChordPro format ─────────────────────────────────────────────────────────

test('parseChordPro: metadata extracted correctly', () => {
  const text = readFileSync(join(fixtureDir, 'simple.chordpro'), 'utf-8');
  const doc = parseChordPro(text);

  assert.equal(doc.title, 'Blue Bossa');
  assert.equal(doc.artist, 'Kenny Dorham');
  assert.equal(doc.key, 'Cm');
  assert.equal(doc.time, '3/4');
  assert.equal(doc.tempo, '120');
});

test('parseChordPro: one verse section created', () => {
  const text = readFileSync(join(fixtureDir, 'simple.chordpro'), 'utf-8');
  const doc = parseChordPro(text);

  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].type, 'verse');
});

test('parseChordPro: chord tokens present in section', () => {
  const text = readFileSync(join(fixtureDir, 'simple.chordpro'), 'utf-8');
  const doc = parseChordPro(text);
  const chords = allChordTexts(doc);

  assert.ok(chords.includes('Cm7'), 'Cm7 should be present');
  assert.ok(chords.includes('Dm7b5'), 'Dm7b5 should be present');
  assert.ok(chords.includes('G7'), 'G7 should be present');
  assert.ok(chords.includes('Cm'), 'Cm should be present');
});

// ── Ultimate Guitar format ──────────────────────────────────────────────────

test('parseUltimateGuitar: two sections detected', () => {
  const text = readFileSync(join(fixtureDir, 'simple-ug.txt'), 'utf-8');
  const doc = parseUltimateGuitar(text);

  assert.equal(doc.sections.length, 2);
});

test('parseUltimateGuitar: section labels match input headers', () => {
  const text = readFileSync(join(fixtureDir, 'simple-ug.txt'), 'utf-8');
  const doc = parseUltimateGuitar(text);

  const labels = doc.sections.map((s) => s.label ?? '');
  assert.ok(
    labels.some((l) => l.includes('Verse')),
    'First section should contain "Verse"'
  );
  assert.ok(
    labels.some((l) => l.includes('Chorus')),
    'Second section should contain "Chorus"'
  );
});

test('parseUltimateGuitar: section types inferred correctly', () => {
  const text = readFileSync(join(fixtureDir, 'simple-ug.txt'), 'utf-8');
  const doc = parseUltimateGuitar(text);

  assert.equal(doc.sections[0].type, 'verse');
  assert.equal(doc.sections[1].type, 'chorus');
});

test('parseUltimateGuitar: chord names appear in line content', () => {
  const text = readFileSync(join(fixtureDir, 'simple-ug.txt'), 'utf-8');
  const doc = parseUltimateGuitar(text);

  // UG chords-over-words lines are stored as lyric tokens with raw text;
  // chord tokens are only produced when the source uses [bracket] syntax.
  const allText = doc.sections
    .flatMap((s) => s.lines)
    .flatMap((l) => l.tokens)
    .map((t) => t.text)
    .join(' ');

  assert.ok(allText.includes('Am7'), 'Am7 should appear in line content');
  assert.ok(allText.includes('F7'), 'F7 should appear in line content');
  assert.ok(allText.includes('Cm'), 'Cm should appear in line content');
  assert.ok(allText.includes('G7'), 'G7 should appear in line content');
  assert.ok(allText.includes('Fm'), 'Fm should appear in line content');
});

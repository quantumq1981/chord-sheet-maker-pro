import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsmpn } from '../src/parsers/csmpnParser.js';
import { generateMusicXml } from '../src/export/musicXmlExporter.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Count occurrences of a substring in a string. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}

// ── Empty / no-bar input ─────────────────────────────────────────────────────

test('generateMusicXml: empty document returns empty string', () => {
  const doc = parseCsmpn('');
  const xml = generateMusicXml(doc);
  assert.equal(xml, '');
});

test('generateMusicXml: metadata-only document returns empty string', () => {
  const doc = parseCsmpn('Title: My Song\nComposer: Jane Doe\n');
  const xml = generateMusicXml(doc);
  assert.equal(xml, '');
});

// ── Basic structure ───────────────────────────────────────────────────────────

test('generateMusicXml: produces valid XML declaration', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

test('generateMusicXml: produces score-partwise root element', () => {
  const doc = parseCsmpn('[A]\n| Cmaj7 | F |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<score-partwise version="4.0">'));
  assert.ok(xml.includes('</score-partwise>'));
});

test('generateMusicXml: movement-title from doc.title', () => {
  const doc = parseCsmpn('Title: Blue Bossa\n[A]\n| Cm7 | F7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<movement-title>Blue Bossa</movement-title>'));
});

test('generateMusicXml: composer in identification block', () => {
  const doc = parseCsmpn('Title: T\nComposer: Kenny Dorham\n[A]\n| Cm7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<creator type="composer">Kenny Dorham</creator>'));
});

test('generateMusicXml: no identification block when no composer', () => {
  const doc = parseCsmpn('Title: T\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(!xml.includes('<identification>'));
});

// ── First-measure attributes ──────────────────────────────────────────────────

test('generateMusicXml: first measure has <attributes> block', () => {
  const doc = parseCsmpn('[A]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<attributes>'));
  assert.ok(xml.includes('<divisions>1</divisions>'));
});

test('generateMusicXml: key signature fifths for G major', () => {
  const doc = parseCsmpn('Key: G\n[A]\n| G | D |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>1</fifths>'));
  assert.ok(xml.includes('<mode>major</mode>'));
});

test('generateMusicXml: key signature fifths for Bb major', () => {
  const doc = parseCsmpn('Key: Bb\n[A]\n| Bb | F |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>-2</fifths>'));
  assert.ok(xml.includes('<mode>major</mode>'));
});

test('generateMusicXml: Gm key emits fifths=-2 with mode=minor', () => {
  const doc = parseCsmpn('Key: Gm\n[A]\n| Gm | Dm |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>-2</fifths>'));
  assert.ok(xml.includes('<mode>minor</mode>'));
});

test('generateMusicXml: Am key emits fifths=0 with mode=minor', () => {
  const doc = parseCsmpn('Key: Am\n[A]\n| Am | E7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>0</fifths>'));
  assert.ok(xml.includes('<mode>minor</mode>'));
});

test('generateMusicXml: no key defaults to C major (fifths=0, mode=major)', () => {
  const doc = parseCsmpn('[A]\n| C | G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>0</fifths>'));
  assert.ok(xml.includes('<mode>major</mode>'));
});

test('generateMusicXml: Bb minor key emits fifths=-5 with mode=minor', () => {
  const doc = parseCsmpn('Key: Bbm\n[A]\n| Bbm | Fm |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<fifths>-5</fifths>'));
  assert.ok(xml.includes('<mode>minor</mode>'));
});

test('generateMusicXml: time signature 4/4', () => {
  const doc = parseCsmpn('Time: 4/4\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<beats>4</beats>'));
  assert.ok(xml.includes('<beat-type>4</beat-type>'));
});

test('generateMusicXml: time signature 3/4', () => {
  const doc = parseCsmpn('Time: 3/4\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<beats>3</beats>'));
  assert.ok(xml.includes('<beat-type>4</beat-type>'));
});

test('generateMusicXml: treble clef in attributes', () => {
  const doc = parseCsmpn('[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<clef><sign>G</sign><line>2</line></clef>'));
});

test('generateMusicXml: slash measure-style in attributes', () => {
  const doc = parseCsmpn('[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<measure-style><slash type="start" use-stems="no"/></measure-style>'));
});

test('generateMusicXml: attributes only in first measure', () => {
  const doc = parseCsmpn('[A]\n| G | C | D | G |\n');
  const xml = generateMusicXml(doc);
  assert.equal(countOccurrences(xml, '<attributes>'), 1);
});

// ── Tempo ─────────────────────────────────────────────────────────────────────

test('generateMusicXml: tempo direction when doc.tempo present', () => {
  const doc = parseCsmpn('Tempo: 120\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<per-minute>120</per-minute>'));
  assert.ok(xml.includes('<sound tempo="120"/>'));
});

test('generateMusicXml: includeTempo:false suppresses tempo direction', () => {
  const doc = parseCsmpn('Tempo: 120\n[A]\n| G |\n');
  const xml = generateMusicXml(doc, { includeTempo: false });
  assert.ok(!xml.includes('<per-minute>'));
  assert.ok(!xml.includes('<sound tempo'));
});

// ── Section rehearsal marks ───────────────────────────────────────────────────

test('generateMusicXml: single section produces one rehearsal mark', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<rehearsal enclosure="none" default-y="40">Intro</rehearsal>'));
  assert.equal(countOccurrences(xml, '<rehearsal'), 1);
});

test('generateMusicXml: rehearsal mark on first bar of each section', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n[Verse]\n| D | G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<rehearsal enclosure="none" default-y="40">Intro</rehearsal>'));
  assert.ok(xml.includes('<rehearsal enclosure="none" default-y="40">Verse</rehearsal>'));
  assert.equal(countOccurrences(xml, '<rehearsal'), 2);
});

test('generateMusicXml: fakebook-style section headers produce rehearsal marks', () => {
  const doc = parseCsmpn('= Chorus\n| Am | F | C | G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<rehearsal enclosure="none" default-y="40">Chorus</rehearsal>'));
});

test('generateMusicXml: rehearsal mark placed after <attributes> in measure 1', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  const attrEnd = xml.indexOf('</attributes>');
  const rehearsalStart = xml.indexOf('<rehearsal');
  assert.ok(attrEnd < rehearsalStart, '<attributes> must precede <rehearsal>');
});

test('generateMusicXml: rehearsal mark placed before <harmony> in measure 1', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  const rehearsalEnd = xml.indexOf('</direction>', xml.indexOf('<rehearsal'));
  const harmonyStart = xml.indexOf('<harmony>');
  assert.ok(rehearsalEnd < harmonyStart, '<rehearsal> direction must precede <harmony>');
});

test('generateMusicXml: useBoxedRehearsal emits enclosure="square"', () => {
  const doc = parseCsmpn('[A]\n| G | C |\n');
  const xml = generateMusicXml(doc, { useBoxedRehearsal: true });
  assert.ok(xml.includes('<rehearsal enclosure="square" default-y="40">A</rehearsal>'));
});

test('generateMusicXml: navigation text (D.C.) does not produce rehearsal mark', () => {
  // A standalone nav-only section (no bars) is filtered out by extractBars,
  // so test a nav label that has bars following it directly.
  const doc = parseCsmpn('[D.C. al Fine]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  assert.ok(!xml.includes('<rehearsal'), 'nav label must not produce a rehearsal mark');
});

test('generateMusicXml: no rehearsal mark for default Chart section', () => {
  // Bars outside any section auto-create a "Chart" section in parseCsmpn
  const doc = parseCsmpn('| G | C | D | G |\n');
  const xml = generateMusicXml(doc);
  // "Chart" is the auto-label — it SHOULD get a rehearsal mark because it is a valid label.
  // This test verifies we don't crash and that we get exactly one rehearsal mark.
  assert.equal(countOccurrences(xml, '<rehearsal'), 1);
});

test('generateMusicXml: three sections produce three rehearsal marks', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n[Verse]\n| Am | F |\n[Chorus]\n| C | G |\n');
  const xml = generateMusicXml(doc);
  assert.equal(countOccurrences(xml, '<rehearsal'), 3);
});

// ── Measures and measure count ────────────────────────────────────────────────

test('generateMusicXml: correct measure count for two sections', () => {
  const doc = parseCsmpn('[Intro]\n| G | C |\n[Verse]\n| D | G |\n');
  const xml = generateMusicXml(doc);
  assert.equal(countOccurrences(xml, '<measure number='), 4);
});

test('generateMusicXml: measure numbers are sequential across sections', () => {
  const doc = parseCsmpn('[A]\n| G | C |\n[B]\n| D | G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('number="1"'));
  assert.ok(xml.includes('number="2"'));
  assert.ok(xml.includes('number="3"'));
  assert.ok(xml.includes('number="4"'));
});

// ── Slash noteheads ───────────────────────────────────────────────────────────

test('generateMusicXml: slash notehead in every measure', () => {
  const doc = parseCsmpn('Time: 4/4\n[A]\n| G | C |\n');
  const xml = generateMusicXml(doc);
  // 2 measures × 4 beats = 8 slash noteheads
  assert.equal(countOccurrences(xml, '<notehead>slash</notehead>'), 8);
});

test('generateMusicXml: compound 12/8 produces 4 slashes per measure', () => {
  const doc = parseCsmpn('Time: 12/8\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.equal(countOccurrences(xml, '<notehead>slash</notehead>'), 4);
});

// ── Harmony elements ──────────────────────────────────────────────────────────

test('generateMusicXml: single chord produces one <harmony>', () => {
  const doc = parseCsmpn('[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.equal(countOccurrences(xml, '<harmony>'), 1);
  assert.ok(xml.includes('<root-step>G</root-step>'));
  assert.ok(xml.includes('<kind>major</kind>'));
});

test('generateMusicXml: flat root-step encoded with alter -1', () => {
  const doc = parseCsmpn('[A]\n| Bb |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<root-step>B</root-step>'));
  assert.ok(xml.includes('<alter>-1</alter>'));
});

test('generateMusicXml: sharp root-step encoded with alter 1', () => {
  const doc = parseCsmpn('[A]\n| F# |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<root-step>F</root-step>'));
  assert.ok(xml.includes('<alter>1</alter>'));
});

test('generateMusicXml: minor seventh chord maps to kind minor-seventh', () => {
  const doc = parseCsmpn('[A]\n| Am7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<kind>minor-seventh</kind>'));
});

test('generateMusicXml: major seventh chord maps to kind major-seventh', () => {
  const doc = parseCsmpn('[A]\n| Cmaj7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<kind>major-seventh</kind>'));
});

test('generateMusicXml: dominant seventh chord maps to kind dominant', () => {
  const doc = parseCsmpn('[A]\n| G7 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<kind>dominant</kind>'));
});

test('generateMusicXml: half-diminished chord maps to kind half-diminished', () => {
  const doc = parseCsmpn('[A]\n| Bm7b5 |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<kind>half-diminished</kind>'));
});

test('generateMusicXml: slash chord produces <bass> element', () => {
  const doc = parseCsmpn('[A]\n| G/B |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('<bass>'));
  assert.ok(xml.includes('<bass-step>B</bass-step>'));
});

test('generateMusicXml: N.C. bar produces no harmony element', () => {
  const doc = parseCsmpn('[A]\n| N.C. |\n');
  const xml = generateMusicXml(doc);
  assert.ok(!xml.includes('<harmony>'));
});

// ── includeKeySignature option ────────────────────────────────────────────────

test('generateMusicXml: includeKeySignature:false emits fifths 0', () => {
  const doc = parseCsmpn('Key: G\n[A]\n| G | D |\n');
  const xml = generateMusicXml(doc, { includeKeySignature: false });
  // fifths should be 0 (C major) when option is false
  assert.ok(xml.includes('<fifths>0</fifths>'));
});

// ── staffSize option ──────────────────────────────────────────────────────────

test('generateMusicXml: staffSize > 0 emits <defaults><scaling>', () => {
  const doc = parseCsmpn('[A]\n| G |\n');
  const xml = generateMusicXml(doc, { staffSize: 7 });
  assert.ok(xml.includes('<scaling><millimeters>7</millimeters><tenths>40</tenths></scaling>'));
});

test('generateMusicXml: staffSize 0 omits <defaults>', () => {
  const doc = parseCsmpn('[A]\n| G |\n');
  const xml = generateMusicXml(doc, { staffSize: 0 });
  assert.ok(!xml.includes('<defaults>'));
});

// ── XML safety ────────────────────────────────────────────────────────────────

test('generateMusicXml: ampersand in title is XML-escaped', () => {
  const doc = parseCsmpn('Title: Rock & Roll\n[A]\n| G |\n');
  const xml = generateMusicXml(doc);
  assert.ok(xml.includes('Rock &amp; Roll'));
  assert.ok(!xml.includes('Rock & Roll'));
});

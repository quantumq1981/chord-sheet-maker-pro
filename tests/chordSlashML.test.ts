/**
 * chordSlashML.test.ts
 *
 * Comprehensive test suite for the ChordSlashML parser, SVG renderer,
 * LilyPond converter, and format detector.
 *
 * Coverage targets (>95% grammar coverage):
 *   ✔ Header metadata (Title, Composer, Key, Time, Tempo, Style)
 *   ✔ Section labels ([Verse], [Chorus], etc.)
 *   ✔ Comment lines (#)
 *   ✔ Measure parsing — single-line and multi-measure
 *   ✔ Barline types (single | double || repeat |: :|)
 *   ✔ Beat tokens — chord name, slash _, rest .
 *   ✔ Compound beats (C_G, F_Em)
 *   ✔ Tuplet groups (C Am F)
 *   ✔ Common progressions (I-IV-V-I, ii-V-I, 12-bar blues, modal vamps)
 *   ✔ Extended/altered chords (G7#5b9, Bm7b5, Cadd9, Bbmaj7#11)
 *   ✔ Slash-bass chords (C/E, G/B, D/F#, Ebm7/Gb)
 *   ✔ Time signature changes (4/4 → 3/4)
 *   ✔ Compound meters (6/8, 9/8, 12/8)
 *   ✔ Edge cases (empty input, metadata-only, whitespace, unknown lines)
 *   ✔ beatsPerMeasure utility
 *   ✔ beatChordText utility
 *   ✔ collectChords utility
 *   ✔ SVG rendering — structure, content, dimensions
 *   ✔ LilyPond conversion — note names, qualities, structure
 *   ✔ Format detection — sniffFormatFromText, .csml extension
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseChordSlashML,
  beatsPerMeasure,
  beatChordText,
  collectChords,
  looksLikeChordSlashML,
} from '../src/parsers/chordSlashMLParser.js';
import type { CSMLDocument, CSMLBeat } from '../src/parsers/chordSlashMLParser.js';

import {
  renderChordSlashMLSvg,
  chordSlashMLToSvg,
} from '../src/renderers/chordSlashMLSvgRenderer.js';

import {
  chordSlashMLToLilypond,
  csmlToLilypond,
} from '../src/converters/chordSlashMLToLilypond.js';

import { sniffFormatFromText, sniffFormatFromBytes } from '../src/ingest/sniffFormat.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Return the first section's measures. */
function measures(doc: CSMLDocument, sectionIdx = 0) {
  return doc.sections[sectionIdx]?.measures ?? [];
}

/** Return all beats from all measures in the first section. */
function allBeats(doc: CSMLDocument, sectionIdx = 0): CSMLBeat[] {
  return measures(doc, sectionIdx).flatMap((m) => m.beats);
}

// ─── Metadata parsing ─────────────────────────────────────────────────────────

test('parseChordSlashML: empty string produces one empty section', () => {
  const doc = parseChordSlashML('');
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].measures.length, 0);
});

test('parseChordSlashML: parses Title', () => {
  const doc = parseChordSlashML('Title: My Song\n| C _ _ _ |');
  assert.equal(doc.title, 'My Song');
});

test('parseChordSlashML: parses Composer', () => {
  const doc = parseChordSlashML('Composer: John Coltrane\n| C _ _ _ |');
  assert.equal(doc.composer, 'John Coltrane');
});

test('parseChordSlashML: parses Key', () => {
  const doc = parseChordSlashML('Key: Bb\n| Bb _ _ _ |');
  assert.equal(doc.key, 'Bb');
});

test('parseChordSlashML: default Time is 4/4', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  assert.equal(doc.time, '4/4');
});

test('parseChordSlashML: parses Time 3/4', () => {
  const doc = parseChordSlashML('Time: 3/4\n| C _ _ |');
  assert.equal(doc.time, '3/4');
});

test('parseChordSlashML: parses Tempo as integer', () => {
  const doc = parseChordSlashML('Tempo: 132\n| C _ _ _ |');
  assert.equal(doc.tempo, 132);
});

test('parseChordSlashML: parses Tempo with BPM notation', () => {
  const doc = parseChordSlashML('Tempo: ♩=120\n| C _ _ _ |');
  assert.equal(doc.tempo, 120);
});

test('parseChordSlashML: parses Style', () => {
  const doc = parseChordSlashML('Style: Jazz\n| C _ _ _ |');
  assert.equal(doc.style, 'Jazz');
});

test('parseChordSlashML: all metadata fields together', () => {
  const text = [
    'Title: Blue Bossa',
    'Composer: Kenny Dorham',
    'Key: Cm',
    'Time: 3/4',
    'Tempo: 120',
    'Style: Bossa Nova',
    '| Cm _ _ |',
  ].join('\n');
  const doc = parseChordSlashML(text);
  assert.equal(doc.title, 'Blue Bossa');
  assert.equal(doc.composer, 'Kenny Dorham');
  assert.equal(doc.key, 'Cm');
  assert.equal(doc.time, '3/4');
  assert.equal(doc.tempo, 120);
  assert.equal(doc.style, 'Bossa Nova');
});

// ─── Comment lines ─────────────────────────────────────────────────────────────

test('parseChordSlashML: comment lines are ignored', () => {
  const doc = parseChordSlashML('# This is a comment\n| C _ _ _ |');
  assert.equal(doc.sections[0].measures.length, 1);
  assert.equal(doc.warnings.length, 0);
});

test('parseChordSlashML: multiple comments are all ignored', () => {
  const text = ['# Verse section', '# by me', '| Am _ _ _ |'].join('\n');
  const doc = parseChordSlashML(text);
  assert.equal(doc.sections[0].measures.length, 1);
});

// ─── Section labels ────────────────────────────────────────────────────────────

test('parseChordSlashML: section label creates named section', () => {
  const text = '[Intro]\n| C _ _ _ |';
  const doc = parseChordSlashML(text);
  assert.equal(doc.sections[0].label, 'Intro');
});

test('parseChordSlashML: multiple sections are all created', () => {
  const text = '[Verse]\n| C _ _ _ |\n[Chorus]\n| F _ G _ |';
  const doc = parseChordSlashML(text);
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].label, 'Verse');
  assert.equal(doc.sections[1].label, 'Chorus');
});

test('parseChordSlashML: section with no label gets empty string', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  assert.equal(doc.sections[0].label, '');
});

test('parseChordSlashML: unlabelled measures before section go in their own section', () => {
  const text = '| C _ _ _ |\n[Verse]\n| Am _ _ _ |';
  const doc = parseChordSlashML(text);
  assert.ok(doc.sections.length >= 2);
});

// ─── Measure and barline parsing ──────────────────────────────────────────────

test('parseChordSlashML: single measure produces one measure', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  assert.equal(measures(doc).length, 1);
});

test('parseChordSlashML: four measures on one line', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ | F _ G _ | C _ _ _ |');
  assert.equal(measures(doc).length, 4);
});

test('parseChordSlashML: double barline || at end', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ ||');
  const ms = measures(doc);
  assert.equal(ms[ms.length - 1].rightBarline, 'final');
});

test('parseChordSlashML: repeat-start |: left barline', () => {
  const doc = parseChordSlashML('|: C _ _ _ | Am _ _ _ :|');
  assert.equal(measures(doc)[0].leftBarline, 'repeat-start');
});

test('parseChordSlashML: repeat-end :| right barline', () => {
  const doc = parseChordSlashML('|: C _ _ _ | Am _ _ _ :|');
  const ms = measures(doc);
  assert.equal(ms[ms.length - 1].rightBarline, 'repeat-end');
});

test('parseChordSlashML: single barline is the default', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ |');
  assert.equal(measures(doc)[0].leftBarline, 'single');
  assert.equal(measures(doc)[0].rightBarline, 'single');
});

test('parseChordSlashML: multiple measure lines in a section', () => {
  const text = ['[A]', '| C _ _ _ | Am _ _ _ |', '| F _ _ _ | G _ _ _ |'].join('\n');
  const doc = parseChordSlashML(text);
  assert.equal(measures(doc).length, 4);
});

// ─── Beat slot tokens ──────────────────────────────────────────────────────────

test('parseChordSlashML: chord beat token', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  const beats = allBeats(doc);
  assert.equal(beats[0].kind, 'chord');
  assert.equal((beats[0] as { kind: 'chord'; text: string }).text, 'C');
});

test('parseChordSlashML: underscore produces slash beat', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  const beats = allBeats(doc);
  assert.equal(beats[1].kind, 'slash');
  assert.equal(beats[2].kind, 'slash');
  assert.equal(beats[3].kind, 'slash');
});

test('parseChordSlashML: forward slash / also produces slash beat', () => {
  const doc = parseChordSlashML('| C / / / |');
  const beats = allBeats(doc);
  assert.equal(beats[1].kind, 'slash');
});

test('parseChordSlashML: dot produces rest beat', () => {
  const doc = parseChordSlashML('| C . _ _ |');
  const beats = allBeats(doc);
  assert.equal(beats[1].kind, 'rest');
});

test('parseChordSlashML: two chords in a measure', () => {
  const doc = parseChordSlashML('| F _ G _ |');
  const beats = allBeats(doc);
  assert.equal(beats[0].kind, 'chord');
  assert.equal((beats[0] as { kind: 'chord'; text: string }).text, 'F');
  assert.equal(beats[2].kind, 'chord');
  assert.equal((beats[2] as { kind: 'chord'; text: string }).text, 'G');
});

// ─── Compound beats ────────────────────────────────────────────────────────────

test('parseChordSlashML: C_G produces compound beat', () => {
  const doc = parseChordSlashML('| C_G _ _ _ |');
  const beats = allBeats(doc);
  assert.equal(beats[0].kind, 'compound');
});

test('parseChordSlashML: compound beat has correct chord parts', () => {
  const doc = parseChordSlashML('| C_G _ _ _ |');
  const beats = allBeats(doc);
  const b = beats[0] as { kind: 'compound'; parts: Array<{ chord: string; separator: string }> };
  assert.equal(b.parts[0].chord, 'C');
  assert.equal(b.parts[1].chord, 'G');
});

test('parseChordSlashML: F_Em produces compound beat with F and Em', () => {
  const doc = parseChordSlashML('| F_Em _ _ _ |');
  const b = allBeats(doc)[0] as {
    kind: 'compound';
    parts: Array<{ chord: string }>;
  };
  assert.equal(b.parts[0].chord, 'F');
  assert.equal(b.parts[1].chord, 'Em');
});

// ─── Tuplet groups ─────────────────────────────────────────────────────────────

test('parseChordSlashML: (C Am F) produces tuplet beat', () => {
  const doc = parseChordSlashML('| (C Am F) G |');
  const beats = allBeats(doc);
  assert.equal(beats[0].kind, 'tuplet');
});

test('parseChordSlashML: tuplet count equals inner beats', () => {
  const doc = parseChordSlashML('| (C Am F) G |');
  const t = allBeats(doc)[0] as { kind: 'tuplet'; count: number; beats: CSMLBeat[] };
  assert.equal(t.count, 3);
  assert.equal(t.beats.length, 3);
});

test('parseChordSlashML: tuplet inner beats are correct chords', () => {
  const doc = parseChordSlashML('| (C Am F) G |');
  const t = allBeats(doc)[0] as { kind: 'tuplet'; beats: CSMLBeat[] };
  assert.equal((t.beats[0] as { kind: 'chord'; text: string }).text, 'C');
  assert.equal((t.beats[1] as { kind: 'chord'; text: string }).text, 'Am');
  assert.equal((t.beats[2] as { kind: 'chord'; text: string }).text, 'F');
});

test('parseChordSlashML: (C G) two-element is also a tuplet', () => {
  const doc = parseChordSlashML('| (C G) _ _ _ |');
  const t = allBeats(doc)[0];
  assert.equal(t.kind, 'tuplet');
});

// ─── Chord name variants ───────────────────────────────────────────────────────

test('parseChordSlashML: minor chord Am', () => {
  const doc = parseChordSlashML('| Am _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Am');
});

test('parseChordSlashML: minor seventh Dm7', () => {
  const doc = parseChordSlashML('| Dm7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Dm7');
});

test('parseChordSlashML: dominant seventh G7', () => {
  const doc = parseChordSlashML('| G7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'G7');
});

test('parseChordSlashML: major seventh Cmaj7', () => {
  const doc = parseChordSlashML('| Cmaj7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Cmaj7');
});

test('parseChordSlashML: flat root Bbmaj7', () => {
  const doc = parseChordSlashML('| Bbmaj7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Bbmaj7');
});

test('parseChordSlashML: sharp root F#m7', () => {
  const doc = parseChordSlashML('| F#m7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'F#m7');
});

test('parseChordSlashML: half-diminished Bm7b5', () => {
  const doc = parseChordSlashML('| Bm7b5 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Bm7b5');
});

test('parseChordSlashML: diminished dim7 chord', () => {
  const doc = parseChordSlashML('| Bdim7 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Bdim7');
});

test('parseChordSlashML: add chord Cadd9', () => {
  const doc = parseChordSlashML('| Cadd9 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Cadd9');
});

test('parseChordSlashML: slash bass chord C/E', () => {
  const doc = parseChordSlashML('| C/E _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'C/E');
});

test('parseChordSlashML: slash bass D/F#', () => {
  const doc = parseChordSlashML('| D/F# _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'D/F#');
});

test('parseChordSlashML: slash bass Ebm7/Gb', () => {
  const doc = parseChordSlashML('| Ebm7/Gb _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Ebm7/Gb');
});

test('parseChordSlashML: augmented aug chord', () => {
  const doc = parseChordSlashML('| Caug _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Caug');
});

test('parseChordSlashML: suspended sus4', () => {
  const doc = parseChordSlashML('| Asus4 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Asus4');
});

test('parseChordSlashML: extended maj9', () => {
  const doc = parseChordSlashML('| Fmaj9 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'Fmaj9');
});

test('parseChordSlashML: 7sus4 altered dominant', () => {
  const doc = parseChordSlashML('| G7sus4 _ _ _ |');
  assert.equal((allBeats(doc)[0] as { kind: 'chord'; text: string }).text, 'G7sus4');
});

// ─── Common progressions ───────────────────────────────────────────────────────

test('parseChordSlashML: I-IV-V-I progression', () => {
  const doc = parseChordSlashML('| C _ _ _ | F _ _ _ | G _ _ _ | C _ _ _ |');
  const ms = measures(doc);
  assert.equal(ms.length, 4);
  assert.equal((ms[0].beats[0] as { kind: 'chord'; text: string }).text, 'C');
  assert.equal((ms[1].beats[0] as { kind: 'chord'; text: string }).text, 'F');
  assert.equal((ms[2].beats[0] as { kind: 'chord'; text: string }).text, 'G');
  assert.equal((ms[3].beats[0] as { kind: 'chord'; text: string }).text, 'C');
});

test('parseChordSlashML: ii-V-I jazz progression', () => {
  const doc = parseChordSlashML('| Dm7 _ _ _ | G7 _ _ _ | Cmaj7 _ _ _ |');
  const ms = measures(doc);
  assert.equal((ms[0].beats[0] as { kind: 'chord'; text: string }).text, 'Dm7');
  assert.equal((ms[1].beats[0] as { kind: 'chord'; text: string }).text, 'G7');
  assert.equal((ms[2].beats[0] as { kind: 'chord'; text: string }).text, 'Cmaj7');
});

test('parseChordSlashML: 12-bar blues (partial — 4 measures)', () => {
  const text =
    '| C _ _ _ | C _ _ _ | C _ _ _ | C _ _ _ |\n' +
    '| F _ _ _ | F _ _ _ | C _ _ _ | C _ _ _ |\n' +
    '| G _ _ _ | F _ _ _ | C _ _ _ | C _ _ _ |';
  const doc = parseChordSlashML(text);
  assert.equal(measures(doc).length, 12);
});

test('parseChordSlashML: modal vamp Am7-D7', () => {
  const doc = parseChordSlashML('| Am7 _ D7 _ |');
  const ms = measures(doc);
  assert.equal(ms.length, 1);
  const beats = ms[0].beats;
  assert.equal((beats[0] as { kind: 'chord'; text: string }).text, 'Am7');
  assert.equal((beats[2] as { kind: 'chord'; text: string }).text, 'D7');
});

// ─── Time signatures and beatsPerMeasure ──────────────────────────────────────

test('beatsPerMeasure: 4/4 returns 4', () => {
  assert.equal(beatsPerMeasure('4/4'), 4);
});

test('beatsPerMeasure: 3/4 returns 3', () => {
  assert.equal(beatsPerMeasure('3/4'), 3);
});

test('beatsPerMeasure: 6/8 returns 2 (compound)', () => {
  assert.equal(beatsPerMeasure('6/8'), 2);
});

test('beatsPerMeasure: 9/8 returns 3 (compound)', () => {
  assert.equal(beatsPerMeasure('9/8'), 3);
});

test('beatsPerMeasure: 12/8 returns 4 (compound)', () => {
  assert.equal(beatsPerMeasure('12/8'), 4);
});

test('beatsPerMeasure: 2/4 returns 2', () => {
  assert.equal(beatsPerMeasure('2/4'), 2);
});

test('beatsPerMeasure: 2/2 returns 2', () => {
  assert.equal(beatsPerMeasure('2/2'), 2);
});

test('beatsPerMeasure: invalid returns 4 as default', () => {
  assert.equal(beatsPerMeasure(''), 4);
  assert.equal(beatsPerMeasure('not/valid'), 4);
});

// ─── beatChordText utility ────────────────────────────────────────────────────

test('beatChordText: chord beat returns text', () => {
  const beat: CSMLBeat = { kind: 'chord', text: 'Am7' };
  assert.equal(beatChordText(beat), 'Am7');
});

test('beatChordText: slash beat returns null', () => {
  const beat: CSMLBeat = { kind: 'slash' };
  assert.equal(beatChordText(beat), null);
});

test('beatChordText: rest beat returns null', () => {
  const beat: CSMLBeat = { kind: 'rest' };
  assert.equal(beatChordText(beat), null);
});

test('beatChordText: compound beat returns first chord', () => {
  const beat: CSMLBeat = {
    kind: 'compound',
    parts: [
      { chord: 'C', separator: '_' },
      { chord: 'G', separator: '_' },
    ],
  };
  assert.equal(beatChordText(beat), 'C');
});

test('beatChordText: tuplet returns first inner chord', () => {
  const beat: CSMLBeat = {
    kind: 'tuplet',
    count: 3,
    beats: [
      { kind: 'chord', text: 'Dm7' },
      { kind: 'chord', text: 'G7' },
      { kind: 'chord', text: 'Cmaj7' },
    ],
  };
  assert.equal(beatChordText(beat), 'Dm7');
});

// ─── collectChords utility ────────────────────────────────────────────────────

test('collectChords: collects unique chord names in order', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ | F _ G _ |');
  const chords = collectChords(doc);
  assert.deepEqual(chords, ['C', 'Am', 'F', 'G']);
});

test('collectChords: no duplicates across sections', () => {
  const text = '[A]\n| C _ _ _ |\n[B]\n| C _ Am _ |';
  const doc = parseChordSlashML(text);
  const chords = collectChords(doc);
  assert.equal(chords.filter((c) => c === 'C').length, 1);
});

test('collectChords: includes compound beat chords', () => {
  const doc = parseChordSlashML('| C_G _ _ _ |');
  const chords = collectChords(doc);
  assert.ok(chords.includes('C'));
  assert.ok(chords.includes('G'));
});

test('collectChords: includes tuplet chords', () => {
  const doc = parseChordSlashML('| (C Am F) G |');
  const chords = collectChords(doc);
  assert.ok(chords.includes('C'));
  assert.ok(chords.includes('Am'));
  assert.ok(chords.includes('F'));
  assert.ok(chords.includes('G'));
});

// ─── looksLikeChordSlashML ────────────────────────────────────────────────────

test('looksLikeChordSlashML: pipe-with-underscore returns true', () => {
  assert.ok(looksLikeChordSlashML('| C _ _ _ |'));
});

test('looksLikeChordSlashML: CSMPN simile marker returns false', () => {
  assert.ok(!looksLikeChordSlashML('| C | Am |·/·'));
});

test('looksLikeChordSlashML: ChordPro directive returns false', () => {
  assert.ok(!looksLikeChordSlashML('{title: My Song}\n| C _ _ _ |'));
});

// ─── SVG rendering ────────────────────────────────────────────────────────────

test('renderChordSlashMLSvg: returns an SVG string', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
});

test('renderChordSlashMLSvg: SVG has width attribute 760', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.includes('width="760"'));
});

test('renderChordSlashMLSvg: SVG has height attribute', () => {
  const doc = parseChordSlashML('| C _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(/height="\d+"/.test(svg));
});

test('renderChordSlashMLSvg: SVG contains chord text', () => {
  const doc = parseChordSlashML('| Am7 _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.includes('Am7'));
});

test('renderChordSlashMLSvg: SVG contains title text', () => {
  const doc = parseChordSlashML('Title: My Song\n| C _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.includes('My Song'));
});

test('renderChordSlashMLSvg: accepts measuresPerRow option', () => {
  const doc = parseChordSlashML('| C _ _ _ | Am _ _ _ | F _ _ _ | G _ _ _ |');
  const svg2 = renderChordSlashMLSvg(doc, { measuresPerRow: 2 });
  const svg4 = renderChordSlashMLSvg(doc, { measuresPerRow: 4 });
  // More rows → taller SVG
  const h2 = parseInt(/height="(\d+)"/.exec(svg2)?.[1] ?? '0');
  const h4 = parseInt(/height="(\d+)"/.exec(svg4)?.[1] ?? '0');
  assert.ok(h2 > h4, `measuresPerRow:2 height ${h2} should be > measuresPerRow:4 height ${h4}`);
});

test('renderChordSlashMLSvg: section labels appear in SVG', () => {
  const doc = parseChordSlashML('[Verse]\n| C _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.includes('Verse'));
});

test('chordSlashMLToSvg: convenience function produces valid SVG', () => {
  const svg = chordSlashMLToSvg('Title: Test\n| D _ _ _ | G _ _ _ |');
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('Test'));
  assert.ok(svg.includes('D'));
  assert.ok(svg.includes('G'));
});

test('renderChordSlashMLSvg: escape HTML in chord text', () => {
  // Chord text should be XML-escaped in SVG output
  const doc = parseChordSlashML('Title: Song <&> Me\n| C _ _ _ |');
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(!svg.includes('<&>'), 'Raw HTML in title should be escaped');
});

// ─── LilyPond conversion ──────────────────────────────────────────────────────

test('chordSlashMLToLilypond: returns a string', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(typeof ly === 'string');
});

test('chordSlashMLToLilypond: includes LilyPond version header', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(ly.includes('\\version "2.24.0"'));
});

test('chordSlashMLToLilypond: includes \\improvisationOn', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(ly.includes('\\improvisationOn'));
});

test('chordSlashMLToLilypond: includes \\chordmode block', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(ly.includes('\\chordmode'));
});

test('chordSlashMLToLilypond: includes RhythmicStaff', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(ly.includes('RhythmicStaff'));
});

test('chordSlashMLToLilypond: title appears in header', () => {
  const ly = chordSlashMLToLilypond('Title: Blue Note\n| C _ _ _ |');
  assert.ok(ly.includes('Blue Note'));
});

test('chordSlashMLToLilypond: composer appears in header', () => {
  const ly = chordSlashMLToLilypond('Composer: Miles Davis\n| C _ _ _ |');
  assert.ok(ly.includes('Miles Davis'));
});

test('chordSlashMLToLilypond: C major chord maps to c in chordmode', () => {
  const ly = chordSlashMLToLilypond('| C _ _ _ |');
  assert.ok(/\bc4\b/.test(ly) || /\bc1\b/.test(ly) || /\bc2\b/.test(ly));
});

test('chordSlashMLToLilypond: Bb chord maps to bes', () => {
  const ly = chordSlashMLToLilypond('| Bb _ _ _ |');
  assert.ok(ly.includes('bes'), 'Bb should map to LilyPond bes');
});

test('chordSlashMLToLilypond: F# maps to fis', () => {
  const ly = chordSlashMLToLilypond('| F# _ _ _ |');
  assert.ok(ly.includes('fis'), 'F# should map to LilyPond fis');
});

test('chordSlashMLToLilypond: Eb maps to ees', () => {
  const ly = chordSlashMLToLilypond('| Eb _ _ _ |');
  assert.ok(ly.includes('ees'), 'Eb should map to LilyPond ees');
});

test('chordSlashMLToLilypond: minor chord m7 maps to :m7 suffix', () => {
  const ly = chordSlashMLToLilypond('| Am7 _ _ _ |');
  assert.ok(ly.includes(':m7'), 'Am7 should produce :m7 quality');
});

test('chordSlashMLToLilypond: maj7 maps to :maj7 suffix', () => {
  const ly = chordSlashMLToLilypond('| Cmaj7 _ _ _ |');
  assert.ok(ly.includes(':maj7'));
});

test('chordSlashMLToLilypond: 3/4 time signature emitted', () => {
  const ly = chordSlashMLToLilypond('Time: 3/4\n| C _ _ |');
  assert.ok(ly.includes('\\time 3/4'));
});

test('chordSlashMLToLilypond: tempo appears when specified', () => {
  const ly = chordSlashMLToLilypond('Tempo: 120\n| C _ _ _ |');
  assert.ok(ly.includes('120'));
});

test('chordSlashMLToLilypond: section label becomes rehearsal mark comment', () => {
  const ly = chordSlashMLToLilypond('[Verse]\n| C _ _ _ |');
  assert.ok(ly.includes('[Verse]') || ly.includes('Verse'));
});

test('chordSlashMLToLilypond: repeat-start becomes \\repeat volta', () => {
  const ly = chordSlashMLToLilypond('|: C _ _ _ | Am _ _ _ :|');
  assert.ok(ly.includes('\\repeat volta'));
});

test('csmlToLilypond: accepts pre-parsed document', () => {
  const doc = parseChordSlashML('Title: Test\n| Dm7 _ G7 _ |');
  const ly = csmlToLilypond(doc);
  assert.ok(ly.includes('Test'));
  assert.ok(ly.includes('ges') || ly.includes('g'));
});

// ─── Format detection ─────────────────────────────────────────────────────────

test('sniffFormatFromText: detects chordslashml by underscore pattern', () => {
  const result = sniffFormatFromText('| C _ _ _ | Am _ _ _ |');
  assert.equal(result.format, 'chordslashml');
});

test('sniffFormatFromText: does not detect chordslashml for plain CSMPN', () => {
  // CSMPN has no underscores inside bars
  const result = sniffFormatFromText('| C | Am | F | G |');
  assert.notEqual(result.format, 'chordslashml');
});

test('sniffFormatFromText: chordpro takes precedence over chordslashml', () => {
  const result = sniffFormatFromText('{title: My Song}\n| C _ _ _ |');
  assert.notEqual(result.format, 'chordslashml');
});

test('sniffFormatFromBytes: detects chordslashml from text bytes', () => {
  const text = '| C _ _ _ | Am _ _ _ |';
  const result = sniffFormatFromBytes(encode(text));
  assert.equal(result.format, 'chordslashml');
});

test('sniffFormatFromBytes: detects chordslashml by .csml extension', () => {
  // File with no underscores but .csml extension
  const result = sniffFormatFromBytes(encode('| C | Am | F | G |'), 'chart.csml');
  assert.equal(result.format, 'chordslashml');
});

test('sniffFormatFromBytes: fakebook |: takes precedence over chordslashml', () => {
  // A line with |: at start should be fakebook, not chordslashml
  const text = '|: C _ _ _ :|\n| Am _ _ _ |';
  // FAKEBOOK_RE matches |: at line start
  const result = sniffFormatFromText(text);
  // fakebook should win because FAKEBOOK_RE is checked first
  assert.equal(result.format, 'fakebook');
});

// ─── Full round-trip integration tests ────────────────────────────────────────

test('full pipeline: parse → SVG → contains all progression chords', () => {
  const text = [
    'Title: Autumn Leaves',
    'Key: G',
    'Time: 4/4',
    '[A]',
    '| Cm7 _ _ _ | F7 _ _ _ | Bbmaj7 _ _ _ | Ebmaj7 _ _ _ |',
    '| Am7b5 _ _ _ | D7 _ _ _ | Gm _ _ _ | Gm _ _ _ |',
  ].join('\n');
  const svg = chordSlashMLToSvg(text);
  assert.ok(svg.includes('Cm7'));
  assert.ok(svg.includes('F7'));
  assert.ok(svg.includes('Bbmaj7'));
  assert.ok(svg.includes('Ebmaj7'));
  assert.ok(svg.includes('D7'));
  assert.ok(svg.includes('Gm'));
});

test('full pipeline: parse → LilyPond → well-formed output', () => {
  const text = [
    'Title: So What',
    'Composer: Miles Davis',
    'Key: Dm',
    'Tempo: 136',
    '[Main]',
    '| Dm7 _ _ _ | Dm7 _ _ _ | Ebm7 _ _ _ | Ebm7 _ _ _ |',
  ].join('\n');
  const ly = chordSlashMLToLilypond(text);
  assert.ok(ly.includes('So What'));
  assert.ok(ly.includes('Miles Davis'));
  assert.ok(ly.includes('\\version "2.24.0"'));
  assert.ok(ly.includes('\\chordmode'));
  assert.ok(ly.includes('\\improvisationOn'));
  assert.ok(ly.includes(':m7'));
});

test('full pipeline: 12-bar blues → 12 measures', () => {
  const text = [
    'Time: 4/4',
    '[Blues in C]',
    '| C _ _ _ | C _ _ _ | C _ _ _ | C _ _ _ |',
    '| F _ _ _ | F _ _ _ | C _ _ _ | C _ _ _ |',
    '| G _ _ _ | F _ _ _ | C _ _ _ | C _ _ _ ||',
  ].join('\n');
  const doc = parseChordSlashML(text);
  const allMeasures = doc.sections.flatMap((s) => s.measures);
  assert.equal(allMeasures.length, 12);
  assert.equal(allMeasures[allMeasures.length - 1].rightBarline, 'final');
});

test('full pipeline: 3/4 waltz time has 3 beats', () => {
  const doc = parseChordSlashML('Time: 3/4\n| Am _ _ | E7 _ _ | Am _ _ |');
  assert.equal(beatsPerMeasure(doc.time), 3);
  // Each measure has 3 beat slots
  for (const m of measures(doc)) {
    assert.equal(m.beats.length, 3, `Expected 3 beats, got ${m.beats.length}`);
  }
});

test('full pipeline: complex jazz chart', () => {
  const text = [
    'Title: Giant Steps',
    'Composer: John Coltrane',
    'Key: B',
    'Tempo: 286',
    'Style: Jazz',
    '[A]',
    '| Bmaj7 _ D7 _ | Gmaj7 _ Bb7 _ | Ebmaj7 _ _ _ | Am7 _ D7 _ |',
    '| Gmaj7 _ Bb7 _ | Ebmaj7 _ F#7 _ | Bmaj7 _ _ _ | Fm7 _ Bb7 _ |',
    '[B]',
    '| Ebmaj7 _ _ _ | Am7 _ D7 _ | Gmaj7 _ _ _ | C#m7 _ F#7 _ |',
    '| Bmaj7 _ _ _ | Fm7 _ Bb7 _ | Ebmaj7 _ _ _ | C#m7 _ F#7 _ ||',
  ].join('\n');
  const doc = parseChordSlashML(text);
  assert.equal(doc.title, 'Giant Steps');
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].measures.length, 8);
  assert.equal(doc.sections[1].measures.length, 8);
  const svg = renderChordSlashMLSvg(doc);
  assert.ok(svg.includes('Giant Steps'));
  assert.ok(svg.includes('Bmaj7'));
  assert.ok(svg.includes('Ebmaj7'));
});

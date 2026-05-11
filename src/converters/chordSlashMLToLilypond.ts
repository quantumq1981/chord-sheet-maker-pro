/**
 * chordSlashMLToLilypond.ts
 *
 * Converts a parsed ChordSlashML document into a LilyPond (.ly) source file.
 *
 * LilyPond is the industry-standard music engraving system.  Compiling the
 * generated .ly file with `lilypond --svg` or `lilypond --pdf` produces
 * publication-quality vector output.
 *
 * Generated score structure:
 *
 *   \version "2.24.0"
 *   \header { title = "..." composer = "..." }
 *   \score {
 *     \new StaffGroup <<
 *       \new ChordNames { \chordmode { … } }
 *       \new RhythmicStaff {
 *         \improvisationOn
 *         …rhythmic slash notation…
 *       }
 *     >>
 *   }
 *
 * Chord name mapping
 * ──────────────────
 *   ChordSlashML uses standard lead-sheet names (Am7, Bbmaj7, G7#5, etc.).
 *   LilyPond \chordmode uses a different suffix grammar (m7, maj7, aug,
 *   etc.) with note names in Dutch solfège (c, d, e, f, g, a, b, cis, des,
 *   fis, bes …).  The converter maps between the two.
 *
 * Rhythmic notation
 * ─────────────────
 *   Each beat slot gets a LilyPond rhythmic value based on the time signature:
 *     4/4 → each beat = quarter note (4)
 *     3/4 → each beat = quarter note (4)
 *     6/8 → each beat = dotted quarter (4.)
 *     12/8 → each beat = dotted quarter (4.)
 *   Compound beats (C_G) → two eighth notes (8 8).
 *   Tuplets → \tuplet N/M { … }.
 *   Rests → r4 (or appropriate value).
 *   Slash continuation → c4 (middle C as the improvisationOn placeholder).
 */

import type { CSMLDocument, CSMLBeat, CSMLMeasure } from '../parsers/chordSlashMLParser.js';
import { parseChordSlashML, beatsPerMeasure } from '../parsers/chordSlashMLParser.js';

export { parseChordSlashML };

// ─── Note name mapping (lead-sheet → LilyPond) ────────────────────────────────

const NOTE_MAP: Record<string, string> = {
  C: 'c',
  'C#': 'cis',
  Db: 'des',
  D: 'd',
  'D#': 'dis',
  Eb: 'ees',
  E: 'e',
  F: 'f',
  'F#': 'fis',
  Gb: 'ges',
  G: 'g',
  'G#': 'gis',
  Ab: 'aes',
  A: 'a',
  'A#': 'ais',
  Bb: 'bes',
  B: 'b',
  'B#': 'bis',
  Cb: 'ces',
};

/** Quality suffix mapping from lead-sheet to LilyPond chordmode. */
const QUALITY_MAP: Array<[string, string]> = [
  // Major extensions (longest first)
  ['maj13', 'maj13'],
  ['maj11', 'maj11'],
  ['maj9', 'maj9'],
  ['maj7', 'maj7'],
  ['maj6', '6'],
  ['maj', ''],
  // Minor-major
  ['mM7', 'm7+'],
  // Minor extensions
  ['m7b5', 'm7.5-'],
  ['m13', 'm13'],
  ['m11', 'm11'],
  ['m9', 'm9'],
  ['m7', 'm7'],
  ['m6', 'm6'],
  ['min', 'm'],
  ['m', 'm'],
  // Dominant + alterations
  ['7#9', '7.9+'],
  ['7b9', '7.9-'],
  ['7#5', '7.5+'],
  ['7b5', '7.5-'],
  ['7sus4', '7sus4'],
  ['7sus2', '7sus2'],
  ['aug7', 'aug7'],
  ['13', '13'],
  ['11', '11'],
  ['9', '9'],
  ['7', '7'],
  // Diminished
  ['dim7', 'dim7'],
  ['dim', 'dim'],
  // Augmented
  ['aug', 'aug'],
  // Suspended
  ['sus4', 'sus4'],
  ['sus2', 'sus2'],
  // Added tones
  ['6add9', '6.9'],
  ['9sus4', '9sus4'],
  ['add13', 'add13'],
  ['add11', 'add11'],
  ['add9', 'add9'],
  // Simple
  ['6', '6'],
  ['5', '5'],
  ['M', ''],
];

/** Parse a lead-sheet chord name into { root, quality, bass }. */
function parseLeadSheetChord(chord: string): {
  root: string;
  quality: string;
  bass: string | null;
} | null {
  const rootM = /^([A-G])(##|bb|[#b])?/.exec(chord);
  if (!rootM) return null;
  const root = rootM[0];
  let rest = chord.slice(root.length);

  let bass: string | null = null;
  const slashIdx = rest.indexOf('/');
  if (slashIdx !== -1) {
    const bassRaw = rest.slice(slashIdx + 1);
    rest = rest.slice(0, slashIdx);
    bass = bassRaw;
  }

  let quality = rest;
  // normalise 'M' at end to empty (major)
  if (quality === 'M') quality = '';

  return { root, quality, bass };
}

/** Convert a lead-sheet note (C, Bb, F#, etc.) to a LilyPond note name. */
function noteToLy(note: string): string {
  // Try exact match first, then root + accidental separately
  if (NOTE_MAP[note]) return NOTE_MAP[note];
  // Double accidentals
  const m = /^([A-G])(##|bb|[#b])$/.exec(note);
  if (m) {
    const base = NOTE_MAP[m[1]] ?? m[1].toLowerCase();
    const acc = m[2] === '##' ? 'isis' : m[2] === 'bb' ? 'eses' : m[2] === '#' ? 'is' : 'es';
    return base + acc;
  }
  return note.toLowerCase();
}

/** Convert a lead-sheet quality string to a LilyPond chordmode suffix. */
function qualityToLy(quality: string): string {
  if (!quality) return '';
  for (const [from, to] of QUALITY_MAP) {
    if (quality === from) return to ? ':' + to : '';
  }
  // Fallback: pass through lowercased
  return ':' + quality.toLowerCase();
}

/** Convert a full lead-sheet chord name to a LilyPond chordmode token. */
function chordToLy(chord: string, duration: string): string {
  const parsed = parseLeadSheetChord(chord);
  if (!parsed) return `c${duration}`; // fallback

  const rootLy = noteToLy(parsed.root);
  const qualLy = qualityToLy(parsed.quality);

  let result = `${rootLy}${duration}${qualLy}`;
  if (parsed.bass) {
    const bassLy = noteToLy(parsed.bass);
    result += `/+${bassLy}`;
  }
  return result;
}

// ─── Duration helpers ─────────────────────────────────────────────────────────

/**
 * Return the LilyPond duration string for one beat given a time signature.
 * Compound meters (6/8, 9/8, 12/8) use dotted quarter notes per visual beat.
 */
function beatDuration(time: string): string {
  const m = /^(\d+)\/(\d+)$/.exec(time);
  if (!m) return '4';
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  if (den === 8 && num % 3 === 0) return '4.'; // compound: dotted quarter per beat
  if (den === 2) return '2';
  if (den === 4) return '4';
  if (den === 8) return '8';
  if (den === 16) return '16';
  return '4';
}

/** The placeholder note used in \improvisationOn context for non-rest slots. */
const SLASH_NOTE = 'c';

// ─── Measure → LilyPond tokens ────────────────────────────────────────────────

function beatToLyTokens(beat: CSMLBeat, dur: string, halfDur: string): string[] {
  switch (beat.kind) {
    case 'chord':
      return [`${SLASH_NOTE}${dur}`];

    case 'slash':
      return [`${SLASH_NOTE}${dur}`];

    case 'rest':
      return [`r${dur}`];

    case 'compound': {
      // Two eighth notes (on-beat + off-beat)
      const n = beat.parts.length;
      const tokens: string[] = [];
      for (let i = 0; i < n; i++) {
        tokens.push(`${SLASH_NOTE}${halfDur}`);
      }
      return tokens;
    }

    case 'tuplet': {
      const n = beat.beats.length;
      const inner = beat.beats.map(() => `${SLASH_NOTE}${dur}`).join(' ');
      return [`\\tuplet ${n}/2 { ${inner} }`];
    }
  }
}

/** Collect chord events from a beat for the ChordNames staff. */
interface ChordEvent {
  chord: string | null;
  duration: string;
  beats: number; // number of beat slots this event spans
}

function beatToChordEvent(beat: CSMLBeat, dur: string, halfDur: string): ChordEvent[] {
  switch (beat.kind) {
    case 'chord':
      return [{ chord: beat.text, duration: dur, beats: 1 }];
    case 'slash':
    case 'rest':
      return [{ chord: null, duration: dur, beats: 1 }];
    case 'compound': {
      return beat.parts.map((p) => ({ chord: p.chord, duration: halfDur, beats: 0.5 }));
    }
    case 'tuplet':
      return beat.beats.map((b) => ({
        chord: b.kind === 'chord' ? b.text : null,
        duration: dur,
        beats: 1 / beat.beats.length,
      }));
  }
}

/** Generate LilyPond chordmode content for a measure. */
function measureToChordmode(
  measure: CSMLMeasure,
  bpm: number,
  dur: string,
  halfDur: string
): string {
  const events: ChordEvent[] = [];

  for (const beat of measure.beats) {
    events.push(...beatToChordEvent(beat, dur, halfDur));
  }

  // Fill remaining beats with silence
  for (let i = measure.beats.length; i < bpm; i++) {
    events.push({ chord: null, duration: dur, beats: 1 });
  }

  // Merge consecutive null chord events (chord holds over)
  const tokens: string[] = [];
  let lastChord: string | null = null;
  let accumulated = 0;

  const flush = (holdDur: string) => {
    if (lastChord !== null) {
      tokens.push(chordToLy(lastChord, holdDur));
    } else {
      tokens.push(`s${holdDur}`); // spacer for held chord
    }
    accumulated = 0;
  };

  for (const ev of events) {
    if (ev.chord !== null) {
      if (accumulated > 0) flush(dur); // flush previous held
      lastChord = ev.chord;
      accumulated = ev.beats;
    } else {
      // null = no new chord — extend previous
      accumulated += ev.beats;
    }
  }
  if (accumulated > 0) flush(dur);

  return tokens.join(' ');
}

/** Generate LilyPond RhythmicStaff content for a measure. */
function measureToRhythm(measure: CSMLMeasure, bpm: number, dur: string, halfDur: string): string {
  const tokens: string[] = [];

  for (const beat of measure.beats) {
    tokens.push(...beatToLyTokens(beat, dur, halfDur));
  }

  // Fill remaining
  for (let i = measure.beats.length; i < bpm; i++) {
    tokens.push(`${SLASH_NOTE}${dur}`);
  }

  return tokens.join(' ');
}

// ─── Repeat barline helpers ────────────────────────────────────────────────────

function leftBarlineLy(kind: CSMLMeasure['leftBarline']): string {
  if (kind === 'repeat-start') return '\\repeat volta 2 {';
  return '';
}

function rightBarlineLy(kind: CSMLMeasure['rightBarline']): string {
  if (kind === 'repeat-end') return '}';
  if (kind === 'final' || kind === 'double') return '\\bar "|."';
  return '';
}

// ─── Top-level generator ───────────────────────────────────────────────────────

/**
 * Convert a parsed ChordSlashML document to a LilyPond source string (.ly).
 *
 * The output is suitable for passing to `lilypond --svg` or `lilypond --pdf`.
 */
export function csmlToLilypond(doc: CSMLDocument): string {
  const bpm = beatsPerMeasure(doc.time);
  const dur = beatDuration(doc.time);
  // For compound beats, each sub-note is twice as fast
  const halfDur = dur.endsWith('.') ? dur.slice(0, -1) : String(parseInt(dur, 10) * 2);

  const chordLines: string[] = [];
  const rhythmLines: string[] = [];

  // Build chord and rhythm content per section
  for (const sec of doc.sections) {
    if (sec.label) {
      chordLines.push(`  % [${sec.label}]`);
      rhythmLines.push(`  % [${sec.label}]`);
      // Rehearsal mark
      rhythmLines.push(
        `  \\mark \\markup { \\box "\\italic { ${sec.label.replace(/"/g, '\\"')} }" }`
      );
    }

    for (const meas of sec.measures) {
      const leftLy = leftBarlineLy(meas.leftBarline);
      const rightLy = rightBarlineLy(meas.rightBarline);

      const cm = measureToChordmode(meas, bpm, dur, halfDur);
      const rm = measureToRhythm(meas, bpm, dur, halfDur);

      if (leftLy) {
        chordLines.push(`  ${leftLy}`);
        rhythmLines.push(`  ${leftLy}`);
      }

      chordLines.push(`  ${cm} |`);
      rhythmLines.push(`  ${rm} |`);

      if (rightLy) {
        chordLines.push(`  ${rightLy}`);
        rhythmLines.push(`  ${rightLy}`);
      }
    }
  }

  const titleEsc = doc.title.replace(/"/g, '\\"');
  const composerEsc = doc.composer.replace(/"/g, '\\"');
  const keyLy = doc.key ? noteToLy(doc.key.replace(/m$/, '').trim()) : 'c';
  const keyMode = doc.key.endsWith('m') ? 'minor' : 'major';
  const timeLy = doc.time.replace('/', '/');

  const lines: string[] = [
    `\\version "2.24.0"`,
    ``,
    `\\header {`,
    `  title = "${titleEsc}"`,
    `  composer = "${composerEsc}"`,
    `  tagline = ##f`,
    `}`,
    ``,
    `\\score {`,
    `  \\new StaffGroup <<`,
    `    \\new ChordNames {`,
    `      \\set chordChanges = ##t`,
    `      \\chordmode {`,
    `        \\key ${keyLy} \\${keyMode}`,
    `        \\time ${timeLy}`,
    ...(doc.tempo ? [`        \\tempo 4 = ${doc.tempo}`] : []),
    ...chordLines.map((l) => `    ${l}`),
    `      }`,
    `    }`,
    `    \\new RhythmicStaff {`,
    `      \\improvisationOn`,
    `      \\key ${keyLy} \\${keyMode}`,
    `      \\time ${timeLy}`,
    ...rhythmLines.map((l) => `    ${l}`),
    `    }`,
    `  >>`,
    `  \\layout {`,
    `    \\context {`,
    `      \\Score`,
    `      \\omit TimeSignature`,
    `    }`,
    `  }`,
    `}`,
  ];

  return lines.join('\n') + '\n';
}

/**
 * Parse ChordSlashML text and return a LilyPond source string.
 */
export function chordSlashMLToLilypond(text: string): string {
  return csmlToLilypond(parseChordSlashML(text));
}

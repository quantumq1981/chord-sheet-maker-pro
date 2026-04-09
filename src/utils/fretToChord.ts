/**
 * fretToChord.ts
 *
 * Identify a chord name from a set of fret/string positions.
 *
 * Algorithm
 * ─────────
 * 1. Convert each (stringIndex, fret) pair into a MIDI note number using the
 *    staff's open-string tuning (passed in by the caller so non-standard
 *    tunings work correctly).
 * 2. Reduce to a set of pitch classes (0-11, where 0=C, …, 11=B).
 * 3. Try every possible root (0-11) and check whether the resulting interval
 *    set matches a known chord pattern.
 * 4. Return the first match as a chord name string, or null if unrecognised.
 *
 * Scope notes
 * ───────────
 * • Only called when a beat has ≥ 3 non-muted notes AND no explicit chord
 *   annotation is already present — avoids false positives on melody runs.
 * • Standard tuning (high-e to low-E): [64, 59, 55, 50, 45, 40].
 *   AlphaTab exposes this as `staff.tuning` (index 0 = highest string).
 */

// ─── Chord patterns ───────────────────────────────────────────────────────────

/**
 * Each entry maps an unordered set of intervals-from-root (semitones) to a
 * chord quality suffix.  Listed roughly from simplest to most complex so the
 * first match wins the most-common interpretation.
 */
const CHORD_PATTERNS: ReadonlyArray<{ suffix: string; intervals: readonly number[] }> = [
  { suffix: '', intervals: [0, 4, 7] }, // major
  { suffix: 'm', intervals: [0, 3, 7] }, // minor
  { suffix: '5', intervals: [0, 7] }, // power chord
  { suffix: '7', intervals: [0, 4, 7, 10] }, // dominant 7
  { suffix: 'maj7', intervals: [0, 4, 7, 11] }, // major 7
  { suffix: 'm7', intervals: [0, 3, 7, 10] }, // minor 7
  { suffix: 'mM7', intervals: [0, 3, 7, 11] }, // minor-major 7
  { suffix: 'm7b5', intervals: [0, 3, 6, 10] }, // half-diminished
  { suffix: 'dim7', intervals: [0, 3, 6, 9] }, // diminished 7
  { suffix: 'dim', intervals: [0, 3, 6] }, // diminished triad
  { suffix: 'aug', intervals: [0, 4, 8] }, // augmented
  { suffix: 'sus4', intervals: [0, 5, 7] }, // suspended 4
  { suffix: 'sus2', intervals: [0, 2, 7] }, // suspended 2
  { suffix: 'add9', intervals: [0, 2, 4, 7] }, // add9
  { suffix: '6', intervals: [0, 4, 7, 9] }, // major 6
  { suffix: 'm6', intervals: [0, 3, 7, 9] }, // minor 6
  { suffix: '9', intervals: [0, 2, 4, 7, 10] }, // dominant 9
];

// ─── Note names (sharps) ──────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setsEqual(a: number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x - y);
  const sortedB = [...b].sort((x, y) => x - y);
  return sortedA.every((v, i) => v === sortedB[i]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Note specification for a single sounding string.
 *
 * `stringIndex`  0-based index into `openMidiNotes`
 *                (0 = highest-pitch string, e.g. high-e on a 6-string guitar)
 * `fret`         Fret number (0 = open)
 */
export interface FretNote {
  stringIndex: number;
  fret: number;
}

/**
 * Attempt to identify a chord name from a set of fret positions.
 *
 * @param openMidiNotes  Open-string MIDI notes from the staff tuning,
 *                       indexed 0 = highest string.
 * @param notes          Non-muted, non-dead notes to analyse.
 * @returns  Chord name string (e.g. "Am", "Cmaj7") or null if unrecognised.
 */
export function fretsToChordName(openMidiNotes: number[], notes: FretNote[]): string | null {
  if (notes.length < 2) return null;

  // Build unique pitch-class set
  const pitchClasses = new Set<number>();
  for (const { stringIndex, fret } of notes) {
    const open = openMidiNotes[stringIndex];
    if (open !== undefined) {
      pitchClasses.add((open + fret) % 12);
    }
  }

  const pcs = [...pitchClasses];
  if (pcs.length < 2) return null;

  // Try each pitch class as the root
  for (let root = 0; root < 12; root++) {
    const intervals = pcs.map((pc) => (pc - root + 12) % 12);
    for (const pattern of CHORD_PATTERNS) {
      if (setsEqual(intervals, pattern.intervals)) {
        return `${NOTE_NAMES[root]}${pattern.suffix}`;
      }
    }
  }

  return null; // Unrecognised voicing
}

/**
 * Standard 6-string guitar tuning: open-string MIDI notes
 * (index 0 = high-e, index 5 = low-E).
 * Used as a fallback when AlphaTab does not expose staff tuning.
 */
export const STANDARD_6_STRING_TUNING = [64, 59, 55, 50, 45, 40] as const;

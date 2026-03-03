/**
 * fretToChord.ts
 *
 * Identify a chord name from a set of fret/string positions.
 *
 * Algorithm
 * ─────────
 * 1. Convert each (stringIndex, fret) pair to a MIDI note using the staff's
 *    open-string tuning, so non-standard tunings (drop-D, DADGAD …) work.
 * 2. Reduce to unique pitch classes (0–11).
 * 3. Try every pitch class as the root and match against known patterns.
 * 4. Return the first match or null if unrecognised.
 *
 * Only called when a beat has ≥ 3 non-muted notes AND no explicit chord
 * annotation — avoids false positives on single-note melody runs.
 */

import type { SectionType } from '../models/ChordChartModel';
export type { SectionType }; // re-export so gpParser can import from one place

// ─── Chord patterns ───────────────────────────────────────────────────────────

const CHORD_PATTERNS: ReadonlyArray<{ suffix: string; intervals: readonly number[] }> = [
  { suffix: '',      intervals: [0, 4, 7] },
  { suffix: 'm',     intervals: [0, 3, 7] },
  { suffix: '5',     intervals: [0, 7] },
  { suffix: '7',     intervals: [0, 4, 7, 10] },
  { suffix: 'maj7',  intervals: [0, 4, 7, 11] },
  { suffix: 'm7',    intervals: [0, 3, 7, 10] },
  { suffix: 'mM7',   intervals: [0, 3, 7, 11] },
  { suffix: 'm7b5',  intervals: [0, 3, 6, 10] },
  { suffix: 'dim7',  intervals: [0, 3, 6, 9] },
  { suffix: 'dim',   intervals: [0, 3, 6] },
  { suffix: 'aug',   intervals: [0, 4, 8] },
  { suffix: 'sus4',  intervals: [0, 5, 7] },
  { suffix: 'sus2',  intervals: [0, 2, 7] },
  { suffix: 'add9',  intervals: [0, 2, 4, 7] },
  { suffix: '6',     intervals: [0, 4, 7, 9] },
  { suffix: 'm6',    intervals: [0, 3, 7, 9] },
  { suffix: '9',     intervals: [0, 2, 4, 7, 10] },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function setsEqual(a: number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x - y);
  const sb = [...b].sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface FretNote {
  /** 0-based index into openMidiNotes (0 = highest-pitch string). */
  stringIndex: number;
  fret: number;
}

/**
 * @param openMidiNotes  Open-string MIDI notes from staff tuning (index 0 = highest string).
 * @param notes          Non-muted, non-dead notes to analyse.
 * @returns  Chord name or null if unrecognised.
 */
export function fretsToChordName(openMidiNotes: number[], notes: FretNote[]): string | null {
  if (notes.length < 2) return null;
  const pcs = new Set<number>();
  for (const { stringIndex, fret } of notes) {
    const open = openMidiNotes[stringIndex];
    if (open !== undefined) pcs.add((open + fret) % 12);
  }
  const pcArr = [...pcs];
  if (pcArr.length < 2) return null;
  for (let root = 0; root < 12; root++) {
    const intervals = pcArr.map((pc) => (pc - root + 12) % 12);
    for (const pat of CHORD_PATTERNS) {
      if (setsEqual(intervals, pat.intervals)) return `${NOTE_NAMES[root]}${pat.suffix}`;
    }
  }
  return null;
}

/** Standard 6-string guitar tuning (index 0 = high-e, index 5 = low-E). */
export const STANDARD_6_STRING_TUNING = [64, 59, 55, 50, 45, 40] as const;

/**
 * ChordChartModel.ts
 *
 * Normalized internal model for text-based chord charts.  This is the
 * "ChordChartModel" described in the ecosystem analysis — a format-agnostic
 * representation of sections, lines, and tokens produced by any of the supported
 * text-chart parsers (ChordPro, Ultimate Guitar, chords-over-words).
 */

import type { SourceFormat } from '../ingest/sniffFormat';

// ─── Token types ─────────────────────────────────────────────────────────────

export interface ChordToken {
  kind: 'chord';
  /** Raw chord name as found in the source, e.g. "Am7", "F#/A", "Bbmaj7". */
  text: string;
}

export interface LyricToken {
  kind: 'lyric';
  text: string;
}

export interface CommentToken {
  kind: 'comment';
  text: string;
}

export type ChartToken = ChordToken | LyricToken | CommentToken;

// ─── Line ────────────────────────────────────────────────────────────────────

export interface ChartLine {
  tokens: ChartToken[];
}

// ─── Section ─────────────────────────────────────────────────────────────────

export type SectionType =
  | 'verse'
  | 'chorus'
  | 'bridge'
  | 'intro'
  | 'outro'
  | 'pre-chorus'
  | 'interlude'
  | 'solo'
  | 'grid'
  | 'tab'
  | 'unknown';

/**
 * One beat-column in an ASCII tablature section.
 * `strings[i]` is the fret for string index i (0 = highest-pitch string).
 * `null` means the string is not played in this beat.
 * `-1` means the string is muted / dead.
 */
export interface TabColumn {
  strings: (number | null)[];
}

export interface ChartSection {
  type: SectionType;
  /** Human-readable label, e.g. "Verse 1", "Chorus". */
  label?: string;
  lines: ChartLine[];
  /**
   * Structured tablature data — only present for sections whose type is 'tab'.
   * Each element represents one beat position.  Stored in the model so that
   * fret-number transposition can be applied without re-parsing ASCII text.
   *
   * `strings[i]`  — fret value for string i (0 = highest-pitched string,
   *                 i.e. high-e for a 6-string guitar):
   *   null  →  no note on this string (rendered as  -- )
   *   -1    →  muted / dead note     (rendered as  x  )
   *   0-24  →  fret number
   */
  tabColumns?: TabColumn[];
}

// ─── Document ────────────────────────────────────────────────────────────────

export interface ChordChartDocument {
  title?: string;
  artist?: string;
  subtitle?: string;
  key?: string;
  capo?: string;
  tempo?: string;
  time?: string;
  genre?: string;
  sections: ChartSection[];
  /** Which parser produced this document. */
  sourceFormat: SourceFormat;
}

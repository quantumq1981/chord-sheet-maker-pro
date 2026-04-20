export type PageSize = 'letter' | 'a4';

export type ChordProFormatMode = 'lyrics-inline' | 'grid-only' | 'auto';

export type RepeatStrategy = 'none' | 'simple-unroll' | 'full-unroll';

export type ChordBracketStyle = 'separate' | 'combined';

export type BarlineStyle = 'pipes' | 'none';

export type MeasureWrapPolicy = 'bars-per-line' | 'no-wrap';

export type KeySignaturePolicy = 'emit-if-known' | 'omit';

export type TimeSignaturePolicy = 'emit-if-known' | 'omit';

export type MetadataPolicy = 'emit' | 'omit';

export interface ConvertOptions {
  barsPerLine: number;
  gridSlotsPerMeasure?: number;
  barlineStyle: BarlineStyle;
  wrapPolicy: MeasureWrapPolicy;
  chordBracketStyle: ChordBracketStyle;
  formatMode: ChordProFormatMode;
  repeatStrategy: RepeatStrategy;
  annotateUnexpandedRepeats: boolean;
  metadataPolicy: MetadataPolicy;
  keyPolicy: KeySignaturePolicy;
  timePolicy: TimeSignaturePolicy;
  normalizeWhitespace: boolean;
}

export interface ConvertInput {
  filename?: string;
  xmlText: string;
}

export interface ConvertOutput {
  chordPro: string;
  warnings: string[];
  error?: string;
  diagnostics: ConverterDiagnostics;
}

export interface ConverterDiagnostics {
  filename?: string;
  timestampIso: string;
  isMxl: boolean;
  partsCount: number;
  selectedLyricPartId?: string;
  title?: string;
  composer?: string;
  key?: string;
  time?: string;
  tempo?: string;
  measuresCount: number;
  versesDetected: string[];
  hasAnyLyrics: boolean;
  hasAnyHarmony: boolean;
  repeatMarkersFound: number;
  endingsFound: number;
  barsPerLine: number;
  formatModeResolved: 'lyrics-inline' | 'grid-only';
  /** Number of mid-song key signature changes detected (0 if none). */
  keyChanges: number;
  /** Number of mid-song time signature changes detected (0 if none). */
  timeChanges: number;
  /** True when the first measure appears to be a pickup/anacrusis bar. */
  hasPickupBar: boolean;
  /** Unique section labels found (from rehearsal marks or direction text). Empty when none. */
  sectionsDetected: string[];
}

export interface HarmonyEvent {
  measureIndex: number;
  offsetDivisions: number;
  chordText: string;
}

export interface LyricEvent {
  verse: string;
  measureIndex: number;
  offsetDivisions: number;
  text: string;
  syllabic?: 'single' | 'begin' | 'middle' | 'end';
  extend?: boolean;
}

export interface MeasureData {
  measureIndex: number;
  durationDivisions: number;
  harmonies: HarmonyEvent[];
  lyricsByVerse: Record<string, LyricEvent[]>;
  repeatStart?: boolean;
  repeatEnd?: boolean;
  endings?: number[];
  /** Section label parsed from a rehearsal mark or recognised direction word at this measure. */
  sectionLabel?: string;
}

export interface MeasureRenderResult {
  measureIndex: number;
  hasLyrics: boolean;
  text: string;
  gridCells?: string[];
}

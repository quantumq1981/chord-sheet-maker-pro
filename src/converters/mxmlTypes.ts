/**
 * mxmlTypes.ts
 *
 * Shared types, interfaces, and constants for the MusicXML → ChordPro converter.
 * Extracted from musicXMLtochordpro.ts (Sprint 5, item 3.2).
 */

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

/** Internal metadata extracted from MusicXML score headers. */
export interface ParsedMetadata {
  title?: string;
  composer?: string;
  key?: string;
  time?: string;
  tempo?: string;
}

export const KIND_SUFFIX_MAP: Record<string, string> = {
  // Triads
  major: '',
  minor: 'm',
  diminished: 'dim',
  augmented: 'aug',
  // Suspended
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  // Sixths
  'major-sixth': '6',
  'minor-sixth': 'm6',
  // Seventh family
  dominant: '7',
  'major-seventh': 'maj7',
  'augmented-major-seventh': 'augmaj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'augmented-seventh': 'aug7',
  'half-diminished': 'm7b5',
  'major-minor': 'mmaj7',
  // Ninths
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  // Elevenths
  'dominant-11th': '11',
  'major-11th': 'maj11',
  'minor-11th': 'm11',
  // Thirteenths
  'dominant-13th': '13',
  'major-13th': 'maj13',
  'minor-13th': 'm13',
  // Power / pedal
  power: '5',
  pedal: 'ped',
  // No quality (root only)
  none: '',
  // Classical augmented-sixth chords (some notation apps emit these)
  Neapolitan: 'N6',
  Italian: 'It+6',
  French: 'Fr+6',
  German: 'Gr+6',
  Tristan: 'Tr',
};

export function getDefaultConvertOptions(): ConvertOptions {
  return {
    barsPerLine: 4,
    barlineStyle: 'pipes',
    wrapPolicy: 'bars-per-line',
    chordBracketStyle: 'separate',
    formatMode: 'auto',
    repeatStrategy: 'none',
    annotateUnexpandedRepeats: true,
    metadataPolicy: 'emit',
    keyPolicy: 'emit-if-known',
    timePolicy: 'emit-if-known',
    normalizeWhitespace: true,
  };
}

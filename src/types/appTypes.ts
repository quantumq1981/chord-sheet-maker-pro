/**
 * appTypes.ts
 *
 * Shared UI-level types used across App.tsx and its hooks.
 * Extracted from App.tsx (Sprint 4, item 3.1).
 */

export type AppMode =
  | 'empty'
  | 'notation'
  | 'chord-chart'
  | 'ug-pro-importer'
  | 'oemer-image-importer'
  | 'svg-importer';

export type ExportFeedback = {
  type: 'success' | 'error';
  message: string;
};

export type ChordProModeUi = 'auto' | 'lyrics-inline' | 'grid-only';
export type ChordProBracketUi = 'separate' | 'combined';
export type ChordProRepeatUi = 'none' | 'simple-unroll' | 'full-unroll';

export type ChordProUiState = {
  barsPerLine: number;
  mode: ChordProModeUi;
  chordBracketStyle: ChordProBracketUi;
  repeatStrategy: ChordProRepeatUi;
};

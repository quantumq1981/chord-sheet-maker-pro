import type { ChordChartDocument, ChartToken } from '../models/ChordChartModel';

export interface ImportQualityResult {
  score: number;
  warnings: string[];
  diagnostics: string[];
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function scoreImportQuality(doc: ChordChartDocument): ImportQualityResult {
  let chordCount = 0;
  let lyricCount = 0;
  let labeledSections = 0;
  let emptyLines = 0;

  for (const section of doc.sections) {
    if (section.label) labeledSections++;
    for (const line of section.lines) {
      if (line.tokens.length === 0) {
        emptyLines++;
        continue;
      }
      for (const token of line.tokens as ChartToken[]) {
        if (token.kind === 'chord') chordCount++;
        if (token.kind === 'lyric') lyricCount++;
      }
    }
  }

  const warnings: string[] = [];
  const diagnostics: string[] = [];

  if (chordCount === 0) warnings.push('No chord tokens detected.');
  if (doc.sections.length === 0) warnings.push('No sections parsed.');
  if (lyricCount === 0) warnings.push('No lyric tokens detected.');
  if (!doc.title) warnings.push('Missing title metadata.');
  if (!doc.key) warnings.push('Missing key metadata.');

  const lyricChordRatio = chordCount > 0 ? lyricCount / chordCount : 0;
  const sectionLabelRatio = doc.sections.length > 0 ? labeledSections / doc.sections.length : 0;

  let score = 100;
  if (chordCount === 0) score -= 50;
  if (doc.sections.length === 0) score -= 25;
  if (lyricChordRatio < 0.2) score -= 15;
  if (sectionLabelRatio < 0.5) score -= 10;
  if (emptyLines > 3) score -= 5;
  if (!doc.title) score -= 5;
  if (!doc.key) score -= 5;

  diagnostics.push(`Chord tokens: ${chordCount}`);
  diagnostics.push(`Lyric tokens: ${lyricCount}`);
  diagnostics.push(`Section labels: ${labeledSections}/${doc.sections.length}`);
  diagnostics.push(`Lyric/chord ratio: ${lyricChordRatio.toFixed(2)}`);

  return {
    score: clampScore(score),
    warnings,
    diagnostics,
  };
}

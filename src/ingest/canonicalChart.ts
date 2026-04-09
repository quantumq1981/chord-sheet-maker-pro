import type { ChordChartDocument, ChartSection, ChartLine } from '../models/ChordChartModel';

function normalizeMeta(value: string | undefined, fallback = ''): string | undefined {
  if (!value) return fallback || undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized || fallback || undefined;
}

function normalizeTime(value: string | undefined): string | undefined {
  const cleaned = normalizeMeta(value);
  if (!cleaned) return '4/4';
  if (/^C\|?$/i.test(cleaned)) return cleaned.toUpperCase() === 'C|' ? '2/2' : '4/4';
  return cleaned;
}

function normalizeSection(section: ChartSection): ChartSection {
  const lines: ChartLine[] = section.lines
    .map((line) => ({
      ...line,
      tokens: line.tokens
        .map((token) =>
          token.kind === 'barline'
            ? token
            : { ...token, text: token.text.replace(/\s+/g, ' ').trim() }
        )
        .filter((token) => (token.kind === 'barline' ? true : token.text.length > 0)),
    }))
    .filter((line) => line.tokens.length > 0);

  return {
    ...section,
    label: normalizeMeta(section.label),
    lines,
  };
}

export function canonicalizeChordChartDocument(doc: ChordChartDocument): ChordChartDocument {
  return {
    ...doc,
    title: normalizeMeta(doc.title, 'Untitled'),
    artist: normalizeMeta(doc.artist),
    key: normalizeMeta(doc.key, 'C'),
    tempo: normalizeMeta(doc.tempo),
    time: normalizeTime(doc.time),
    genre: normalizeMeta(doc.genre),
    sections: doc.sections.map(normalizeSection).filter((section) => section.lines.length > 0),
  };
}

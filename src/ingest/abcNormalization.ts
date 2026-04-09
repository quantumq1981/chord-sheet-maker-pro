import { normalizeLineEndings } from '../utils/sectionUtils';

export interface AbcNormalizationResult {
  normalizedText: string;
  changed: boolean;
  notes: string[];
}

const HEADER_ORDER = ['X', 'T', 'M', 'L', 'Q', 'K'] as const;

function normalizeHeaderSpacing(line: string): string {
  return line.replace(
    /^\s*([A-Za-z])\s*:\s*(.*)$/,
    (_m, f: string, value: string) => `${f.toUpperCase()}: ${value.trim()}`
  );
}

function normalizeQuotedChords(line: string): string {
  return line.replace(/"([^"\n]+)"/g, (_m, raw: string) => `"${raw.trim().replace(/\s+/g, ' ')}"`);
}

function normalizeBarlineSpacing(line: string): string {
  return line
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s*:\|\s*/g, ' :| ')
    .replace(/\s*\|:\s*/g, ' |: ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeAbcForImport(input: string): AbcNormalizationResult {
  const text = normalizeLineEndings(input);
  const lines = text.split('\n');
  const notes: string[] = [];

  const normalizedLines = lines.map((rawLine) => {
    const line = rawLine.replace(/\t/g, '  ').replace(/\s+$/g, '');
    if (!line.trim()) return '';

    if (/^[A-Za-z]\s*:/.test(line.trim())) {
      return normalizeHeaderSpacing(line);
    }

    if (/^[wW]\s*:/.test(line.trim())) {
      return line
        .replace(/^[wW]\s*:/, 'w:')
        .replace(/\s+/g, ' ')
        .trim();
    }

    let body = normalizeQuotedChords(line);
    if (/[|:]/.test(body)) body = normalizeBarlineSpacing(body);
    return body;
  });

  // Keep only the first occurrence of core headers in canonical order at top.
  const headers = new Map<string, string>();
  const body: string[] = [];
  for (const line of normalizedLines) {
    const m = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (m) {
      const field = m[1].toUpperCase();
      if (HEADER_ORDER.includes(field as (typeof HEADER_ORDER)[number]) && !headers.has(field)) {
        headers.set(field, `${field}: ${m[2]}`.trim());
      } else {
        body.push(line);
      }
    } else {
      body.push(line);
    }
  }

  const headerLines: string[] = [];
  for (const header of HEADER_ORDER) {
    const value = headers.get(header);
    if (value) headerLines.push(value);
  }

  if (!headers.has('X')) {
    headerLines.unshift('X: 1');
    notes.push('Inserted missing X: reference number.');
  }

  const normalizedText = [...headerLines, ...body]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    normalizedText,
    changed: normalizedText !== text.trim(),
    notes,
  };
}

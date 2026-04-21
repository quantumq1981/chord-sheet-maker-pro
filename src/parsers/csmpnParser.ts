/**
 * csmpnParser.ts
 *
 * Parser for Chord Sheet Maker Pro Notation (CSMPN) text.
 *
 * Converts CSMPN text into a ChordChartDocument so it can be rendered
 * by the existing ChordChart component.
 *
 * CSMPN format:
 *
 *   Title: Song Name
 *   Composer: Artist
 *   Style: Jazz
 *   Tempo: ♩=120
 *   Key: C
 *   Time: 4/4
 *
 *   [Section Name]
 *   ‖ Chord | Chord | Chord | Chord |
 *   | Chord | Chord ‖
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
  SectionType,
} from '../models/ChordChartModel';
import { sectionTypeFromLabel } from '../utils/sectionUtils';

/** The Unicode simile marker used for "repeat previous bar". */
const SIMILE = '\u00B7/\u00B7';

/**
 * Parse CSMPN text into a ChordChartDocument.
 */
export function parseCsmpn(text: string): ChordChartDocument {
  const doc: ChordChartDocument = {
    title: '',
    artist: '',
    key: '',
    tempo: '',
    time: '',
    genre: '',
    sections: [],
    sourceFormat: 'ultimateguitar',
  };

  const lines = text.split(/\r?\n/);

  let currentSection: ChartSection | null = null;

  const flush = () => {
    if (currentSection) {
      doc.sections.push(currentSection);
    }
  };

  const openSection = (label: string) => {
    flush();
    const type: SectionType = sectionTypeFromLabel(label);
    currentSection = { type, label, lines: [] };
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // ── Header fields ───────────────────────────────────────────────────────
    const headerMatch = line.match(/^(Title|Composer|Style|Tempo|Key|Time)\s*:\s*(.+)$/i);
    if (headerMatch) {
      const field = headerMatch[1].toLowerCase();
      const value = headerMatch[2].trim();
      switch (field) {
        case 'title':
          doc.title = value;
          break;
        case 'composer':
          doc.artist = value;
          break;
        case 'style':
          doc.genre = value;
          break;
        case 'tempo': {
          // Extract numeric BPM from "♩=120" or just "120"
          const bpm = value.match(/(\d{2,3})/)?.[1] ?? value;
          doc.tempo = bpm;
          break;
        }
        case 'key':
          doc.key = value;
          break;
        case 'time':
          doc.time = value;
          break;
      }
      continue;
    }

    // ── Section header ──────────────────────────────────────────────────────
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      openSection(sectionMatch[1]);
      continue;
    }

    const fakebookSectionMatch = line.match(/^[-:=]\s+(.+)$/);
    if (fakebookSectionMatch) {
      openSection(fakebookSectionMatch[1].trim());
      continue;
    }

    // ── Blank line ──────────────────────────────────────────────────────────
    if (!line) continue;

    // ── Bar line ────────────────────────────────────────────────────────────
    // Lines that start with ‖ or | contain measure/bar content.
    if (/^[‖|]/.test(line) || line.includes('|')) {
      if (!currentSection) {
        // Bare bar content outside a section — auto-create a section
        openSection('Chart');
      }
      const normalizedLine = /^[‖|]/.test(line) ? line : `| ${line}`;
      const chartLine = parseBarLine(normalizedLine);
      if (chartLine.tokens.length > 0) {
        currentSection!.lines.push(chartLine);
      }
      continue;
    }
  }

  flush();

  // If no sections were created, wrap everything in a default section
  if (doc.sections.length === 0) {
    doc.sections.push({ type: 'unknown', label: 'Chart', lines: [] });
  }

  return doc;
}

/**
 * Parse a single bar-notation line into a ChartLine.
 *
 * Input examples:
 *   ‖ Cmaj7 | Am7 | Dm7 | G7 |
 *   | Fmaj7 | Em7 ‖
 *   ‖ % | % | Cmaj7 | G7 ‖
 */
function parseBarLine(line: string): ChartLine {
  const tokens: ChartToken[] = [];

  // Split on barline characters while keeping the delimiters
  // Barline chars: ‖ (U+2016), | (vertical bar)
  // We need to handle: ‖, |, |:, :|, ||  (CSMPN uses ‖ for double-bar)
  const parts = line.split(/(‖|\|:?|:\|)/);

  for (const part of parts) {
    const p = part.trim();
    if (!p) continue;

    if (p === '‖') {
      tokens.push({ kind: 'barline', text: '||' });
    } else if (p === '|:') {
      tokens.push({ kind: 'barline', text: '|:' });
    } else if (p === ':|') {
      tokens.push({ kind: 'barline', text: ':|' });
    } else if (p === '|') {
      tokens.push({ kind: 'barline', text: '|' });
    } else {
      // Content between barlines — may contain multiple chord tokens separated by spaces
      const chords = p.split(/\s+/).filter(Boolean);
      for (const chord of chords) {
        if (chord === '%') {
          tokens.push({ kind: 'chord', text: SIMILE });
        } else if (chord === 'N.C.' || chord === 'NC') {
          tokens.push({ kind: 'chord', text: 'N.C.' });
        } else if (/^[A-G]/.test(chord)) {
          tokens.push({ kind: 'chord', text: chord });
        } else {
          // Could be a direction or comment — emit as lyric for now
          tokens.push({ kind: 'lyric', text: chord });
        }
      }
    }
  }

  return { tokens };
}

// ── Repeat expansion ─────────────────────────────────────────────────────────

/**
 * Expand |: ... :| repeat barlines in CSMPN text.
 *
 * Each |: content :| group is played twice by default.
 * An optional xN suffix sets the repeat count: `|: C Am :| x3` → three plays.
 * Inner | bar separators within the repeat are preserved in the expanded output.
 * Metadata, section markers, and non-bar lines pass through unchanged.
 *
 * D.C. / D.S. / Coda section-level navigation is not expanded by this function.
 */
export function expandCsmpnRepeats(text: string, opts: { barRepeats?: boolean } = {}): string {
  if (opts.barRepeats === false || !text) return text ?? '';
  return text.split('\n').map(expandBarRepeatLine).join('\n');
}

function expandBarRepeatLine(line: string): string {
  if (!line.includes('|:') && !line.includes(':|')) return line;

  return line.replace(
    /\|:\s*((?:[^|]|\|(?!:))*?)\s*:\|(?:\s+x(\d+))?/gi,
    (_match, content: string, times: string | undefined) => {
      const n = times ? Math.max(1, Math.min(16, parseInt(times, 10))) : 2;
      const trimmed = content.trim();
      return Array.from({ length: n }, () => trimmed).join(' ');
    }
  );
}

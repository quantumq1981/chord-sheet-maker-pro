/**
 * ugProPdfPureFns.ts
 *
 * Pure, zero-dependency-on-pdfjs functions extracted from ugProPdfImporter.ts
 * for unit testing.  All functions here operate only on plain data structures
 * (TextSpan, number arrays, Uint8ClampedArray) with no browser API calls.
 *
 * Safe to import in Node.js tests via tsx/esm.
 */

import type { TextSpan } from './ugProPdfUtils.js';
import { SMUFL_REPEAT_START, SMUFL_REPEAT_END, SMUFL_REPEAT_BOTH } from './ugProPdfUtils.js';
import { normalizeChordSymbol, splitMultiChordSpan, CHORD_REGEX } from './chordNormalizer.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Marker {
  type:
    | 'rehearsal'
    | 'repeat-start'
    | 'repeat-end'
    | 'coda'
    | 'segno'
    | 'fine'
    | 'ds'
    | 'dc'
    | 'nc';
  value: string;
  x: number;
  y: number;
}

export interface SongMetadata {
  title: string;
  composer: string;
  style: string;
  tempo: string;
  key: string;
  time: string;
}

export interface SectionDef {
  label: string;
  startMeasure: number;
}

/** One element of DebugJson['linear']['measures']. */
export interface LinearMeasure {
  n: number;
  chords: string[];
  directives: string[];
  timeSig?: string;
  repeatStart?: boolean;
  repeatEnd?: boolean;
}

export interface SpanGroup {
  yCenter: number;
  spans: TextSpan[];
}

/** Minimal config subset needed by the emit functions. */
export interface EmitConfig {
  measuresPerLine: number;
  fillEmptyMeasuresWithPercent: boolean;
}

export interface ClassifiedSpans {
  chordSpans: TextSpan[];
  rehearsalSpans: TextSpan[];
  directionMarkers: Marker[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HEADER_KW_PAT =
  /\b(Tuning|Capo|Transcribed|Transcription|Difficulty|Author|Arranger|Engraved|Engraver|www\.|http|©|Copyright|Produced)\b/i;

const SECTION_LABEL_RE =
  /^(intro|verse|pre[-\s]?chorus|chorus|refrain|bridge|solo|guitar\s+solo|outro|interlude|tag|turnaround|hook|main|groove|vamp|break|section|part|theme|pickup|instrumental|melody|riff|head|shout|stop|ending|fade|buildup|breakdown)\s*[0-9a-z]*[:\s]*$/i;

const DIRECTION_TEXTS = new Set([
  'N.C.',
  'N.C',
  'NC',
  'Fine',
  'Coda',
  'D.S.',
  'DS',
  'D.C.',
  'DC',
  'D.S.al',
  'D.C.al',
  'To',
  'Double-time',
  'Half-time',
  'Freely',
  'Tacet',
  'Simile',
  'Vamp',
  'Rit.',
  'Rit',
  'Rail.',
  'Accel.',
  'Intro',
  'Verse',
  'Chorus',
  'Bridge',
  'Solo',
  'Outro',
  'Coda',
  'Interlude',
  'Pre',
  'Post',
]);

// ─── Pure functions ───────────────────────────────────────────────────────────

/** 2D affine matrix multiply: result = m1 × m2, matrices encoded as [a,b,c,d,e,f]. */
export function mul2d(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Classify a direction text span into a Marker, or return null. */
export function classifyDirective(span: TextSpan): Marker | null {
  const t = span.text.trim().replace(/\s+/g, ' ');
  const upper = t.toUpperCase();
  if (upper === 'N.C.' || upper === 'N.C' || upper === 'NC')
    return { type: 'nc', value: 'N.C.', x: span.x, y: span.y };
  if (/^(D\.S\.|DS)/i.test(t)) return { type: 'ds', value: t, x: span.x, y: span.y };
  if (/^(D\.C\.|DC)/i.test(t)) return { type: 'dc', value: t, x: span.x, y: span.y };
  if (/^fine$/i.test(t)) return { type: 'fine', value: 'Fine', x: span.x, y: span.y };
  if (/^coda$/i.test(t)) return { type: 'coda', value: 'Coda', x: span.x, y: span.y };
  return null;
}

/**
 * Group text spans into horizontal bands (staff systems) by Y-coordinate.
 * Groups are sorted top-to-bottom (descending Y in PDF space).
 */
export function clusterIntoSystems(spans: TextSpan[], thresholdPx: number): SpanGroup[] {
  const sorted = [...spans].sort((a, b) => b.y - a.y);
  const groups: SpanGroup[] = [];

  for (const span of sorted) {
    let bestGroup: SpanGroup | null = null;
    let bestDist = Infinity;
    for (const g of groups) {
      const dist = Math.abs(span.y - g.yCenter);
      if (dist < thresholdPx && dist < bestDist) {
        bestDist = dist;
        bestGroup = g;
      }
    }
    if (bestGroup) {
      bestGroup.spans.push(span);
      bestGroup.yCenter = bestGroup.spans.reduce((s, sp) => s + sp.y, 0) / bestGroup.spans.length;
    } else {
      groups.push({ yCenter: span.y, spans: [span] });
    }
  }

  groups.sort((a, b) => b.yCenter - a.yCenter);
  return groups;
}

/**
 * For multi-track PDFs, drop system groups whose span count is less than half
 * the densest group's count, eliminating phantom/background systems.
 * Only applies when there are more than 8 groups.
 */
export function filterDensestSystems(groups: SpanGroup[]): SpanGroup[] {
  if (groups.length <= 8) return groups;
  const maxCount = Math.max(...groups.map((g) => g.spans.length));
  const threshold = Math.max(2, Math.round(maxCount * 0.5));
  return groups.filter((g) => g.spans.length >= threshold);
}

/**
 * Returns the length of the longest continuous dark-pixel run in a single column.
 * Rejects false barline peaks caused by dense chord text (text has gaps; barlines do not).
 */
export function longestDarkRun(
  data: Uint8ClampedArray,
  col: number,
  bandW: number,
  bandH: number,
  threshold = 128
): number {
  let maxRun = 0;
  let cur = 0;
  for (let row = 0; row < bandH; row++) {
    const i = (row * bandW + col) * 4;
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (gray < threshold) {
      cur++;
      if (cur > maxRun) maxRun = cur;
    } else {
      cur = 0;
    }
  }
  return maxRun;
}

/** Compute overall dark-pixel density in the band image (0–1). */
export function computeStemDensity(data: Uint8ClampedArray, total: number): number {
  let dark = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (gray < 128) dark++;
  }
  return dark / total;
}

/**
 * Map a section label to its fake-book prefix character.
 *   -  →  Intro / Verse / Tag / generic
 *   :  →  Chorus / Refrain
 *   =  →  Bridge
 */
export function fakebookSectionPrefix(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('chorus') || l.includes('refrain')) return ':';
  if (l.includes('bridge')) return '=';
  return '-';
}

/**
 * Build a bar token for one measure.
 *   - Empty bar with no prior chord → 'N.C.'
 *   - Empty bar with prior chord + fillPercent → '%'
 *   - Multi-chord bars → joined with _  (e.g. Bb7_A7_D7)
 */
export function barToken(
  m: LinearMeasure,
  lastChord: string,
  fillPercent: boolean
): [token: string, newLastChord: string] {
  if (m.chords.length === 0) {
    if (!lastChord) return ['N.C.', ''];
    return [fillPercent ? '%' : lastChord, lastChord];
  }
  const token = m.chords.join('_');
  return [token, m.chords[m.chords.length - 1]];
}

/** Emit fake-book style CSMPN text from linearised measure data. */
export function emitFakebook(
  metadata: SongMetadata,
  sections: SectionDef[],
  linearMeasures: LinearMeasure[],
  config: EmitConfig
): string {
  const out: string[] = [];

  if (metadata.title) out.push(`Title: ${metadata.title}`);
  if (metadata.composer) out.push(`Composer: ${metadata.composer}`);
  if (metadata.style) out.push(`Style: ${metadata.style}`);
  if (metadata.tempo) out.push(`Tempo: ${metadata.tempo}`);
  if (metadata.time) out.push(`Time: ${metadata.time}`);
  if (metadata.key) out.push(`Key: ${metadata.key}`);
  out.push('');

  const mpl = config.measuresPerLine;
  const total = linearMeasures.length;
  let lastChord = '';
  let currentTimeSig = metadata.time;

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const sec = sections[secIdx];
    const nextStart = secIdx + 1 < sections.length ? sections[secIdx + 1].startMeasure : total;
    const secMeasures = linearMeasures.slice(sec.startMeasure, nextStart);
    if (secMeasures.length === 0) continue;

    const prefix = fakebookSectionPrefix(sec.label);
    out.push(`${prefix} ${sec.label}`);

    const row: string[] = [];
    const flushRow = () => {
      if (row.length > 0) {
        out.push(row.join(' '));
        row.length = 0;
      }
    };

    for (const m of secMeasures) {
      if (m.timeSig && m.timeSig !== currentTimeSig) {
        flushRow();
        out.push(`; Time: ${m.timeSig}`);
        currentTimeSig = m.timeSig;
      }
      if (m.repeatStart) flushRow();
      const [rawTok, next] = barToken(m, lastChord, config.fillEmptyMeasuresWithPercent);
      let tok = rawTok;
      if (m.repeatStart) tok = `|: ${tok}`;
      if (m.repeatEnd) tok = `${tok} :|`;
      row.push(tok);
      lastChord = next;
      if (m.repeatEnd) flushRow();
      else if (row.length >= mpl) flushRow();
    }
    flushRow();

    out.push('');
  }

  return out.join('\n');
}

/** Emit classic CSMPN with ‖ / | barlines and [Section] headers. */
export function emitBarlinesStyle(
  metadata: SongMetadata,
  sections: SectionDef[],
  linearMeasures: LinearMeasure[],
  config: EmitConfig
): string {
  const out: string[] = [];

  if (metadata.title) out.push(`Title: ${metadata.title}`);
  if (metadata.composer) out.push(`Composer: ${metadata.composer}`);
  if (metadata.style) out.push(`Style: ${metadata.style}`);
  if (metadata.tempo) out.push(`Tempo: ♩=${metadata.tempo}`);
  if (metadata.key) out.push(`Key: ${metadata.key}`);
  if (metadata.time) out.push(`Time: ${metadata.time}`);
  out.push('');

  const mpl = config.measuresPerLine;
  const total = linearMeasures.length;
  let lastChord = '';
  let currentTimeSig = metadata.time;

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const sec = sections[secIdx];
    const nextStart = secIdx + 1 < sections.length ? sections[secIdx + 1].startMeasure : total;
    const secMeasures = linearMeasures.slice(sec.startMeasure, nextStart);
    if (secMeasures.length === 0) continue;

    out.push(`[${sec.label}]`);

    const row: Array<{ tok: string }> = [];
    let secTokenStart = 0;

    const flushRow = () => {
      if (row.length === 0) return;
      const toks = row.map((r) => r.tok);
      const isFirst = secTokenStart === 0;
      secTokenStart += row.length;
      const isLast = secTokenStart >= secMeasures.length;
      let line: string;
      if (isFirst) {
        line = '‖ ' + toks.join(' | ') + (isLast ? ' ‖' : ' |');
      } else if (isLast) {
        line = '| ' + toks.join(' | ') + ' ‖';
      } else {
        line = '| ' + toks.join(' | ') + ' |';
      }
      out.push(line);
      row.length = 0;
    };

    for (const m of secMeasures) {
      if (m.timeSig && m.timeSig !== currentTimeSig) {
        flushRow();
        out.push(`; Time: ${m.timeSig}`);
        currentTimeSig = m.timeSig;
      }

      if (m.repeatStart) flushRow();

      let tok: string;
      if (m.chords.length === 0) {
        tok = config.fillEmptyMeasuresWithPercent && lastChord ? '%' : lastChord || '%';
      } else {
        tok = m.chords.join(' ');
        lastChord = m.chords[m.chords.length - 1];
      }
      if (m.repeatStart) tok = `|: ${tok}`;
      if (m.repeatEnd) tok = `${tok} :|`;
      row.push({ tok });
      if (m.repeatEnd) flushRow();
      else if (row.length >= mpl) flushRow();
    }
    flushRow();

    out.push('');
  }

  return out.join('\n');
}

/**
 * Extract song metadata from page spans.
 * Title = largest font span near top of page 0; composer = next-largest.
 */
export function extractMetadata(spans: TextSpan[], pageHeight: number): SongMetadata {
  const meta: SongMetadata = {
    title: '',
    composer: '',
    style: '',
    tempo: '',
    key: '',
    time: '',
  };

  const topSpans = spans
    .filter((s) => s.pageIndex === 0 && s.y > pageHeight * 0.75)
    .sort((a, b) => b.fontSize - a.fontSize);

  if (topSpans.length > 0) meta.title = topSpans[0].text.trim();
  if (topSpans.length > 1) meta.composer = topSpans[1].text.trim();

  const allFirstPage = spans.filter((s) => s.pageIndex === 0);
  for (const span of allFirstPage) {
    const t = span.text.trim();
    const tempoMatch = t.match(/[♩=]\s*=?\s*(\d{2,3})/);
    if (tempoMatch) {
      meta.tempo = tempoMatch[1];
      break;
    }
    const bareMatch = t.match(/^=\s*(\d{2,3})$/);
    if (bareMatch) {
      meta.tempo = bareMatch[1];
      break;
    }
  }

  for (const span of allFirstPage) {
    const t = span.text.trim();
    const keyMatch = t.match(/[Kk]ey\s*(?:of\s*)?([A-G][b#]?\s*(?:major|minor|maj|min|m)?)/);
    if (keyMatch) {
      meta.key = keyMatch[1].trim();
      break;
    }
    const sigMatch = t.match(/^([A-G][b#]?)\s+(Major|Minor|major|minor)$/);
    if (sigMatch) {
      meta.key = `${sigMatch[1]} ${sigMatch[2]}`;
      break;
    }
  }

  for (const span of allFirstPage) {
    const t = span.text.trim();
    const timeMatch = t.match(/^(\d+\/\d+)$/);
    if (timeMatch) {
      meta.time = timeMatch[1];
      break;
    }
  }

  return meta;
}

/**
 * Classify page spans into chord candidates, rehearsal markers, and directions.
 * Applies header exclusion and median-font-size filtering.
 * Coordinates assumed in PDF space (y from bottom).
 */
export function classifyPageSpans(
  spans: TextSpan[],
  pageH: number,
  headerExclusionRatio: number,
  pageW = 612
): ClassifiedSpans {
  const result: ClassifiedSpans = { chordSpans: [], rehearsalSpans: [], directionMarkers: [] };

  const headerThresholdY = pageH * (1 - headerExclusionRatio);

  const sizes = spans
    .filter((s) => s.text.trim().length > 1 && /^[A-G]/.test(s.text.trim()))
    .map((s) => s.fontSize)
    .sort((a, b) => a - b);
  const medianFontSize = sizes.length >= 3 ? sizes[Math.floor(sizes.length / 2)] : 7;

  const dirPat =
    /^(N\.C\.?|Fine|Coda|D\.S|D\.C|To\s|Double|Half-time|Freely|Tacet|Simile|Vamp|Rit|Rail|Accel)/i;

  for (const span of spans) {
    const t = span.text.trim();
    if (!t || t.length > 20) continue;
    if (span.y > headerThresholdY) continue;
    if (HEADER_KW_PAT.test(t)) continue;
    if (span.fontSize > medianFontSize * 2.5) continue;

    if (SECTION_LABEL_RE.test(t)) {
      result.rehearsalSpans.push(span);
      continue;
    }

    if (t === SMUFL_REPEAT_START || t === SMUFL_REPEAT_END || t === SMUFL_REPEAT_BOTH) {
      if (t === SMUFL_REPEAT_START || t === SMUFL_REPEAT_BOTH) {
        result.directionMarkers.push({ type: 'repeat-start', value: '|:', x: span.x, y: span.y });
      }
      if (t === SMUFL_REPEAT_END || t === SMUFL_REPEAT_BOTH) {
        result.directionMarkers.push({ type: 'repeat-end', value: ':|', x: span.x, y: span.y });
      }
      continue;
    }

    if (DIRECTION_TEXTS.has(t) || dirPat.test(t)) {
      const dir = classifyDirective(span);
      if (dir) result.directionMarkers.push(dir);
      continue;
    }

    if (/^[A-Z][0-9]?$/.test(t) && span.fontSize > medianFontSize * 1.3) {
      result.rehearsalSpans.push(span);
      continue;
    }

    if (/^\d+$/.test(t)) continue;
    if (!/^[A-G]/.test(t)) continue;
    if (/^[A-G]$/.test(t) && span.x < pageW * 0.04) continue;

    const normed = normalizeChordSymbol(t);
    if (CHORD_REGEX.test(normed) || CHORD_REGEX.test(t)) {
      result.chordSpans.push(span);
    } else if (splitMultiChordSpan(t)) {
      result.chordSpans.push(span);
    }
  }

  return result;
}

/**
 * ugProPdfImporter.ts
 *
 * UG Pro PDF → CSMPN (Chord Sheet Maker Pro Notation) Importer
 *
 * Pipeline overview:
 *   1. Load PDF with pdf.js, render each page to an offscreen canvas.
 *   2. Extract all text spans WITH coordinates (x, y, width, height, font-size).
 *   3. Classify spans: chord candidates vs. metadata vs. direction text.
 *   4. Cluster chord spans into staff systems by Y-coordinate.
 *   5. Detect barlines via image-based vertical-projection analysis on each system band.
 *   6. Map each chord span to a measure (barline interval) by its x-center.
 *   7. Linearise across all systems/pages into a flat measure array.
 *   8. Emit CSMPN text from the linear measure list.
 *   9. Return { csmpnText, debugJson } plus per-page render data for the overlay.
 *
 * Non-goals for v1:
 *   - Full OMR / melody extraction
 *   - DS/DC/Coda expansion
 *   - Full repeat/volta expansion (markers stored in debugJson only)
 */

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/display/api';

// ─── Worker setup ─────────────────────────────────────────────────────────────

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

// ─── Configuration ────────────────────────────────────────────────────────────

export interface UGProImporterConfig {
  /** Number of measures per output line in CSMPN. */
  measuresPerLine: number;
  /** If true, prefer writing one chord per bar (first detected). */
  preferOneChordPerBar: boolean;
  /** If true and multiple chords detected in one bar, keep them all. */
  allowMultiChordBars: boolean;
  /** Fill empty measures with % (repeat previous). */
  fillEmptyMeasuresWithPercent: boolean;
  /** Reserved for future use. */
  expandRepeats: boolean;
  /** Max vertical distance (px at renderScale) for two spans to be in the same system. */
  ySystemClusterThresholdPx: number;
  /** Barline peak must cover at least this fraction of system height to qualify. */
  barlinePeakMinHeightRatio: number;
  /** Minimum horizontal spacing between adjacent barlines (px at renderScale). */
  barlinePeakMinSpacingPx: number;
  /** Scale factor for rendering PDF pages to canvas for barline detection. */
  renderScale: number;
  /**
   * Output format for the emitted text.
   *   'csmpn-barlines' – classic CSMPN with ‖ / | barlines and [Section] headers (default).
   *   'csmpn-fakebook' – native fake-book style: - / : / = section prefixes,
   *                      no | separators, multi-chord bars joined with _.
   */
  outputMode: 'csmpn-barlines' | 'csmpn-fakebook';
  /** Fraction of page height from top to exclude as title/header text (default 0.13 = 13%). */
  headerExclusionRatio: number;
  /** Barline detection preset. 'auto' selects via stem-density pixel analysis. */
  barlinePreset: 'auto' | 'sparse' | 'tab-heavy';
}

export const DEFAULT_CONFIG: UGProImporterConfig = {
  measuresPerLine: 4,
  preferOneChordPerBar: true,
  allowMultiChordBars: true,
  fillEmptyMeasuresWithPercent: true,
  expandRepeats: false,
  ySystemClusterThresholdPx: 45,
  barlinePeakMinHeightRatio: 0.55,
  barlinePeakMinSpacingPx: 18,
  renderScale: 1.8,
  outputMode: 'csmpn-fakebook',
  headerExclusionRatio: 0.13,
  barlinePreset: 'auto',
};

// ─── Intermediate types ───────────────────────────────────────────────────────

export interface TextSpan {
  /** Raw text content. */
  text: string;
  /** PDF coordinate system: x from left edge, y from bottom of page. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  pageIndex: number;
}

export interface ChordEvent {
  x: number;
  y: number;
  raw: string;
  norm: string;
  confidence: number;
}

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

export interface MeasureDebug {
  measureIndex: number;
  /** Global (linear) measure number. */
  globalIndex: number;
  xRange: [number, number];
  events: ChordEvent[];
  directives: string[];
}

export interface SystemDebug {
  systemIndex: number;
  pageIndex: number;
  /** [x0, y0, x1, y1] in PDF coordinate units. */
  bbox: [number, number, number, number];
  /** x positions of detected barlines in PDF coordinate units. */
  barlinesX: number[];
  measures: MeasureDebug[];
  markers: Marker[];
  /** Barline preset used ('sparse' or 'tab-heavy'). */
  preset?: string;
  /** Stem pixel density (0–1) used for auto preset selection. */
  stemDensity?: number;
}

export interface PageRenderData {
  pageIndex: number;
  /** Canvas element with the rendered page. */
  canvas: HTMLCanvasElement;
  /** PDF viewport scale used for the canvas. */
  scale: number;
  /** Width of the PDF page in user units. */
  pageWidthPt: number;
  /** Height of the PDF page in user units. */
  pageHeightPt: number;
  systems: SystemDebug[];
}

export interface DebugJson {
  metadata: {
    title: string;
    composer: string;
    style: string;
    tempo: string;
    key: string;
    time: string;
  };
  pages: Array<{
    pageIndex: number;
    systems: SystemDebug[];
  }>;
  linear: {
    measures: Array<{
      n: number;
      chords: string[];
      directives: string[];
    }>;
  };
}

export interface ImportResult {
  csmpnText: string;
  debugJson: DebugJson;
  /** Per-page render data for the debug overlay UI. */
  pageRenders: PageRenderData[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Header keywords — exclude from chord detection. */
const HEADER_KW_PAT =
  /\b(Tuning|Capo|Transcribed|Transcription|Difficulty|Author|Arranger|Engraved|Engraver|www\.|http|©|Copyright|Produced)\b/i;

const STEM_DENSITY_THRESHOLD = 0.08;
const MIN_TOTAL_CHORD_SPANS = 6;
const MIN_PAGE_CHORD_SPANS = 4;

interface BarlinePresetConfig {
  stemRunRatio: number;
  minSpacingPx: number;
  minHeightRatio: number;
}

const BARLINE_PRESETS: Record<string, BarlinePresetConfig> = {
  sparse: { stemRunRatio: 0.65, minSpacingPx: 18, minHeightRatio: 0.55 },
  'tab-heavy': { stemRunRatio: 0.8, minSpacingPx: 28, minHeightRatio: 0.65 },
};

// ─── Chord normalisation ──────────────────────────────────────────────────────

/**
 * normalizeChordSymbol
 *
 * Central normalisation function. Used by all parsing stages.
 * Converts various unicode and informal chord notations to canonical CSMPN form.
 */
export function normalizeChordSymbol(raw: string): string {
  let s = raw.trim();

  // Strip internal whitespace (PDF can split "C maj7" as one span with a space)
  s = s.replace(/\s+/g, '');

  // 1. Unicode accidentals
  s = s.replace(/♭/g, 'b').replace(/♯/g, '#');

  // 2. Root note: uppercase first letter
  if (s.length === 0) return s;
  s = s[0].toUpperCase() + s.slice(1);

  // 3. Half-diminished: Ø / ø → m7b5
  //    Must handle: EØ, Eø, EØ7, Eø7 → Em7b5
  s = s.replace(/([A-G][b#]?)([Øø])7?/g, '$1m7b5');

  // 4. Diminished with 7: o7 / °7 → dim7
  s = s.replace(/([A-G][b#]?)(o7|°7)/g, '$1dim7');
  // Bare diminished: o / ° → dim (but not if already 'dim')
  s = s.replace(/([A-G][b#]?)(°|(?<![a-z])o(?!7|[a-z]))/g, '$1dim');

  // 5. Major seventh: Δ / 7M / M7 / Maj7 / MAJ7 → maj7
  s = s.replace(/Δ7?/g, 'maj7');
  s = s.replace(/7M\b/g, 'maj7');
  s = s.replace(/M7\b/g, 'maj7');
  s = s.replace(/[Mm][Aa][Jj]7/g, 'maj7');
  // Bare "maj" is optional and should not imply maj7.
  // Example: Cmaj → C
  s = s.replace(/([A-G][b#]?)maj\b/g, '$1');

  // 6. Minor: "min" → "m" (but not "diminished")
  s = s.replace(/min(?!or)/g, 'm');

  // 7. Preserve slash chords, alterations — nothing else to change.
  return s;
}

// ─── Chord classification ─────────────────────────────────────────────────────

/** Regex to match a plausible chord symbol rooted on a note name. */
const CHORD_REGEX =
  /^[A-G][b#]?(?:maj7|maj|m7b5|m7|m6|m9|m11|m13|mM7|m|dim7|dim|aug7|aug|sus4|sus2|sus|add9|add11|add13|add|7M|[Øø]7?|°7?|Δ7?|M7?|[0-9]+(?:[b#][0-9]+)*)(?:\/[A-G][b#]?)?$/;

/** Direction / structural text that must NOT be classified as chords. */
const DIRECTION_TEXTS = new Set([
  'N.C.',
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

/** Classify direction text spans into Marker objects. */
function classifyDirective(span: TextSpan): Marker | null {
  const t = span.text.trim().replace(/\s+/g, ' ');
  const upper = t.toUpperCase();
  if (upper === 'N.C.' || upper === 'NC')
    return { type: 'nc', value: 'N.C.', x: span.x, y: span.y };
  if (/^(D\.S\.|DS)/i.test(t)) return { type: 'ds', value: t, x: span.x, y: span.y };
  if (/^(D\.C\.|DC)/i.test(t)) return { type: 'dc', value: t, x: span.x, y: span.y };
  if (/^fine$/i.test(t)) return { type: 'fine', value: 'Fine', x: span.x, y: span.y };
  if (/^coda$/i.test(t)) return { type: 'coda', value: 'Coda', x: span.x, y: span.y };
  return null;
}

// ─── Span extraction ──────────────────────────────────────────────────────────

/** 2D affine matrix multiply: result = m1 × m2, matrices encoded as [a,b,c,d,e,f]. */
function mul2d(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Extract text spans from a PDF page using the viewport transform for accurate
 * coordinates on rotated or non-standard-origin pages.
 * Stores coordinates in PDF user units (x left-to-right, y bottom-to-top).
 */
function extractPageSpans(
  page: PDFPageProxy,
  items: TextItem[],
  pageH: number,
  pageIndex: number
): TextSpan[] {
  const viewport = page.getViewport({ scale: 1 });
  const vt = viewport.transform as number[];
  const spans: TextSpan[] = [];

  for (const ti of items) {
    if (!ti.str.trim()) continue;
    const t = mul2d(vt, ti.transform as number[]);
    // t[4] = canvas x (= PDF x for unrotated), t[5] = canvas y from top
    // Convert canvas y-from-top back to PDF y-from-bottom: y_pdf = pageH - t[5]
    const x = t[4];
    const y = pageH - t[5];
    const fontSize = Math.hypot(t[2] || 0, t[3] || 0) || Math.hypot(t[0] || 0, t[1] || 0) || 12;
    spans.push({
      text: ti.str,
      x,
      y,
      width: (ti.width ?? 0) > 0 ? ti.width : fontSize,
      height: (ti.height ?? 0) > 0 ? ti.height : fontSize,
      fontSize,
      pageIndex,
    });
  }
  return spans;
}

// ─── Span classification ──────────────────────────────────────────────────────

interface ClassifiedSpans {
  chordSpans: TextSpan[];
  rehearsalSpans: TextSpan[];
  directionMarkers: Marker[];
}

/**
 * Classify page spans into chord candidates, rehearsal markers, and directions.
 * Applies header exclusion and median-font-size filtering to suppress title text.
 * Coordinates assumed in PDF space (y from bottom; top of page = high y).
 */
function classifyPageSpans(
  spans: TextSpan[],
  pageH: number,
  headerExclusionRatio: number
): ClassifiedSpans {
  const result: ClassifiedSpans = { chordSpans: [], rehearsalSpans: [], directionMarkers: [] };

  // Top N% of page in PDF space: y > pageH * (1 - ratio)
  const headerThresholdY = pageH * (1 - headerExclusionRatio);

  // Median font size from multi-char spans starting with a note root
  const sizes = spans
    .filter((s) => s.text.trim().length > 1 && /^[A-G]/.test(s.text.trim()))
    .map((s) => s.fontSize)
    .sort((a, b) => a - b);
  const medianFontSize = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : 12;

  const dirPat =
    /^(N\.C\.|Fine|Coda|D\.S|D\.C|To\s|Double|Half-time|Freely|Tacet|Simile|Vamp|Rit|Rail|Accel)/i;

  for (const span of spans) {
    const t = span.text.trim();
    if (!t || t.length > 20) continue;

    // Exclude header area (top N% of page in PDF space)
    if (span.y > headerThresholdY) continue;

    // Exclude known header keywords (title, copyright, tuning, etc.)
    if (HEADER_KW_PAT.test(t)) continue;

    // Exclude very large text (headings — more than 2.5× median font)
    if (span.fontSize > medianFontSize * 2.5) continue;

    if (DIRECTION_TEXTS.has(t) || dirPat.test(t)) {
      const dir = classifyDirective(span);
      if (dir) result.directionMarkers.push(dir);
      continue;
    }

    // Rehearsal markers: single uppercase letter (optionally + digit), large or left-margin
    if (/^[A-Z][0-9]?$/.test(t) && !CHORD_REGEX.test(t)) {
      result.rehearsalSpans.push(span);
      continue;
    }

    // Chord candidates
    if (/^\d+$/.test(t)) continue;
    if (!/^[A-G]/.test(t)) continue;
    const normed = normalizeChordSymbol(t);
    if (CHORD_REGEX.test(normed) || CHORD_REGEX.test(t)) {
      result.chordSpans.push(span);
    }
  }

  return result;
}

// ─── System clustering ────────────────────────────────────────────────────────

interface SpanGroup {
  yCenter: number;
  spans: TextSpan[];
}

/**
 * Group text spans into horizontal bands (staff systems) by Y-coordinate.
 * Uses a greedy threshold merge: if a span's Y is within `thresholdPx`
 * of an existing group's centroid, it joins that group; otherwise it starts a new one.
 * Groups are sorted top-to-bottom (descending Y in PDF space).
 */
function clusterIntoSystems(spans: TextSpan[], thresholdPx: number): SpanGroup[] {
  // Sort spans top-to-bottom: in PDF space Y increases upward, so higher Y = higher on page.
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
      // Update centroid
      bestGroup.yCenter = bestGroup.spans.reduce((s, sp) => s + sp.y, 0) / bestGroup.spans.length;
    } else {
      groups.push({ yCenter: span.y, spans: [span] });
    }
  }

  // Sort top-to-bottom (descending y in PDF space)
  groups.sort((a, b) => b.yCenter - a.yCenter);
  return groups;
}

/**
 * For multi-track PDFs, drop system groups whose span count is less than half the
 * densest group's count, eliminating phantom/background systems.
 */
function filterDensestSystems(groups: SpanGroup[]): SpanGroup[] {
  if (groups.length <= 8) return groups;
  const maxCount = Math.max(...groups.map((g) => g.spans.length));
  const threshold = Math.max(2, Math.round(maxCount * 0.5));
  return groups.filter((g) => g.spans.length >= threshold);
}

// ─── Barline detection (image-based) ─────────────────────────────────────────

async function renderPageToCanvas(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * Returns the length of the longest continuous dark-pixel run in a single column.
 * Rejects false barline peaks caused by dense chord text (text has gaps; barlines do not).
 */
function longestDarkRun(
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

/**
 * Compute overall dark-pixel density in the band image.
 * High density → tab-heavy preset; low density → sparse preset.
 */
function computeStemDensity(data: Uint8ClampedArray, total: number): number {
  let dark = 0;
  for (let i = 0; i < total * 4; i += 4) {
    const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (gray < 128) dark++;
  }
  return dark / total;
}

/**
 * Detect barline x-positions within a staff band using vertical projection.
 * Uses `longestDarkRun` to reject false peaks from dense chord text.
 * Returns canvas-column peaks converted to PDF user units.
 */
function detectBarlinesInBand(
  canvas: HTMLCanvasElement,
  bandY0: number,
  bandY1: number,
  bandX0: number,
  bandX1: number,
  preset: BarlinePresetConfig,
  scale: number
): number[] {
  const ctx = canvas.getContext('2d')!;
  const bandH = Math.max(1, bandY1 - bandY0);
  const bandW = Math.max(1, bandX1 - bandX0);
  if (bandW <= 0 || bandH <= 0) return [];

  const imageData = ctx.getImageData(bandX0, bandY0, bandW, bandH);
  const data = imageData.data;
  const stemRunMin = Math.floor(bandH * preset.stemRunRatio);

  const profile = new Float32Array(bandW);
  for (let col = 0; col < bandW; col++) {
    let darkCount = 0;
    for (let row = 0; row < bandH; row++) {
      const idx = (row * bandW + col) * 4;
      const gray = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (gray < 128) darkCount++;
    }
    profile[col] = darkCount / bandH;
  }

  const peaks: number[] = [];
  for (let col = 1; col < bandW - 1; col++) {
    if (
      profile[col] < preset.minHeightRatio ||
      profile[col] < profile[col - 1] ||
      profile[col] < profile[col + 1]
    )
      continue;
    if (longestDarkRun(data, col, bandW, bandH) < stemRunMin) continue;

    if (peaks.length === 0 || col - peaks[peaks.length - 1] >= preset.minSpacingPx) {
      peaks.push(col);
    } else if (profile[col] > profile[peaks[peaks.length - 1]]) {
      peaks[peaks.length - 1] = col;
    }
  }

  return peaks.map((px) => (bandX0 + px) / scale);
}

// ─── Metadata extraction ──────────────────────────────────────────────────────

interface SongMetadata {
  title: string;
  composer: string;
  style: string;
  tempo: string;
  key: string;
  time: string;
}

/**
 * Extract song metadata from the top-of-page text spans.
 * Heuristic: title = largest font span near top of first page;
 *            composer = next-largest or directly below;
 *            tempo = span containing ♩ or "BPM" or just a number near a tempo glyph.
 */
function extractMetadata(spans: TextSpan[], pageHeight: number): SongMetadata {
  const meta: SongMetadata = { title: '', composer: '', style: '', tempo: '', key: '', time: '' };

  // Consider only spans in the top 25% of the first page
  const topSpans = spans
    .filter((s) => s.pageIndex === 0 && s.y > pageHeight * 0.75)
    .sort((a, b) => b.fontSize - a.fontSize);

  if (topSpans.length > 0) {
    meta.title = topSpans[0].text.trim();
  }
  if (topSpans.length > 1) {
    meta.composer = topSpans[1].text.trim();
  }

  // Tempo: look for patterns like ♩=120 or "= 120" or bare number near top
  const allFirstPage = spans.filter((s) => s.pageIndex === 0);
  for (const span of allFirstPage) {
    const t = span.text.trim();
    const tempoMatch = t.match(/[♩=]\s*=?\s*(\d{2,3})/);
    if (tempoMatch) {
      meta.tempo = tempoMatch[1];
      break;
    }
    // bare "= 120" style
    const bareMatch = t.match(/^=\s*(\d{2,3})$/);
    if (bareMatch) {
      meta.tempo = bareMatch[1];
      break;
    }
  }

  // Key: look for e.g. "Key: C" or "Key of G" patterns
  for (const span of allFirstPage) {
    const t = span.text.trim();
    const keyMatch = t.match(/[Kk]ey\s*(?:of\s*)?([A-G][b#]?\s*(?:major|minor|maj|min|m)?)/);
    if (keyMatch) {
      meta.key = keyMatch[1].trim();
      break;
    }
    // Standalone key signature text like "C Major" or "Bb"
    const sigMatch = t.match(/^([A-G][b#]?)\s+(Major|Minor|major|minor)$/);
    if (sigMatch) {
      meta.key = `${sigMatch[1]} ${sigMatch[2]}`;
      break;
    }
  }

  // Time signature: look for "4/4", "3/4", "6/8" etc.
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

// ─── Main importer ────────────────────────────────────────────────────────────

/**
 * importUGProPdf
 *
 * Loads a UG Pro PDF file and converts it to CSMPN notation.
 *
 * @param file  The PDF File object from a <input type="file"> or drag-and-drop.
 * @param cfg   Optional configuration overrides.
 * @returns     { csmpnText, debugJson, pageRenders }
 */

// ─── Emitter helpers ─────────────────────────────────────────────────────────

type LinearMeasure = DebugJson['linear']['measures'][number];

interface SectionDef {
  label: string;
  startMeasure: number;
}

/**
 * Map a section label to its fake-book prefix character.
 *   -  →  Intro / Verse / Tag / Interlude / Outro / Turnaround / generic
 *   :  →  Chorus / Refrain
 *   =  →  Bridge
 */
function fakebookSectionPrefix(label: string): string {
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
function barToken(
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

/**
 * Emit fake-book style CSMPN:
 *   - / : / =  section prefix
 *   bars joined by spaces (no | separators)
 *   multi-chord bars with _
 *   |: :| only if repeat detected (v1: never emitted, always expanded)
 */
function emitFakebook(
  metadata: SongMetadata,
  sections: SectionDef[],
  linearMeasures: LinearMeasure[],
  config: UGProImporterConfig
): string {
  const out: string[] = [];

  // Header — same fields, no ♩ glyph in Tempo line for cleaner copy-paste
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

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const sec = sections[secIdx];
    const nextStart = secIdx + 1 < sections.length ? sections[secIdx + 1].startMeasure : total;
    const secMeasures = linearMeasures.slice(sec.startMeasure, nextStart);
    if (secMeasures.length === 0) continue;

    const prefix = fakebookSectionPrefix(sec.label);
    out.push(`${prefix} ${sec.label}`);

    // Build bar tokens
    const tokens: string[] = [];
    for (const m of secMeasures) {
      const [tok, next] = barToken(m, lastChord, config.fillEmptyMeasuresWithPercent);
      tokens.push(tok);
      lastChord = next;
    }

    // Emit rows of mpl bars each
    for (let i = 0; i < tokens.length; i += mpl) {
      out.push(tokens.slice(i, i + mpl).join(' '));
    }

    out.push('');
  }

  return out.join('\n');
}

/**
 * Emit classic CSMPN with ‖ / | barlines and [Section] headers.
 */
function emitBarlinesStyle(
  metadata: SongMetadata,
  sections: SectionDef[],
  linearMeasures: LinearMeasure[],
  config: UGProImporterConfig
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

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const sec = sections[secIdx];
    const nextStart = secIdx + 1 < sections.length ? sections[secIdx + 1].startMeasure : total;
    const secMeasures = linearMeasures.slice(sec.startMeasure, nextStart);
    if (secMeasures.length === 0) continue;

    out.push(`[${sec.label}]`);

    // Build bar tokens (spaces for multi-chord bars in barline mode)
    const tokens: string[] = secMeasures.map((m) => {
      if (m.chords.length === 0) {
        const tok = config.fillEmptyMeasuresWithPercent && lastChord ? '%' : lastChord || '%';
        return tok;
      }
      const tok = m.chords.join(' ');
      lastChord = m.chords[m.chords.length - 1];
      return tok;
    });

    // Format into lines of mpl measures with ‖ / | barlines
    for (let i = 0; i < tokens.length; i += mpl) {
      const lineTokens = tokens.slice(i, i + mpl);
      const isFirst = i === 0;
      const isLast = i + mpl >= tokens.length;
      let line: string;
      if (isFirst) {
        line = '‖ ' + lineTokens.join(' | ') + (isLast ? ' ‖' : ' |');
      } else if (isLast) {
        line = '| ' + lineTokens.join(' | ') + ' ‖';
      } else {
        line = '| ' + lineTokens.join(' | ') + ' |';
      }
      out.push(line);
    }

    out.push('');
  }

  return out.join('\n');
}

export async function importUGProPdf(
  file: File,
  cfg: Partial<UGProImporterConfig> = {}
): Promise<ImportResult> {
  const config: UGProImporterConfig = { ...DEFAULT_CONFIG, ...cfg };

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;

  // ── Collect all text spans + per-page classification ─────────────────────
  const allSpans: TextSpan[] = [];
  interface PageMeta {
    page: PDFPageProxy;
    pageH: number;
    pageW: number;
    chordSpans: TextSpan[];
    rehearsalSpans: TextSpan[];
    directionMarkers: Marker[];
  }
  const pageMetas: PageMeta[] = [];

  for (let pNum = 1; pNum <= numPages; pNum++) {
    const page = await pdf.getPage(pNum);
    const vp1 = page.getViewport({ scale: 1 });
    const pageH = vp1.height;
    const pageW = vp1.width;
    const content = await page.getTextContent();
    const textItems = content.items.filter(
      (i): i is TextItem => typeof i === 'object' && i !== null && 'str' in i
    );
    const pageSpans = extractPageSpans(page, textItems, pageH, pNum - 1);
    allSpans.push(...pageSpans);

    const { chordSpans, rehearsalSpans, directionMarkers } = classifyPageSpans(
      pageSpans,
      pageH,
      config.headerExclusionRatio
    );
    pageMetas.push({ page, pageH, pageW, chordSpans, rehearsalSpans, directionMarkers });
  }

  // ── Fail-safe: reject vector-only PDFs ───────────────────────────────────
  const totalChordSpans = pageMetas.reduce((s, p) => s + p.chordSpans.length, 0);
  if (totalChordSpans < MIN_TOTAL_CHORD_SPANS) {
    throw new Error(
      `Only ${totalChordSpans} chord span(s) found across the entire document. ` +
        'Chord text is likely encoded as vector graphics — OCR fallback required.'
    );
  }

  // ── Extract metadata from first page ────────────────────────────────────
  const metadata = extractMetadata(allSpans, pageMetas[0].pageH);

  // ── Per-page barline detection + system building ─────────────────────────
  const pageRenders: PageRenderData[] = [];
  const allSystemsDebug: SystemDebug[] = [];
  let globalMeasureIndex = 0;

  for (let pNum = 1; pNum <= numPages; pNum++) {
    const { page, pageH, pageW, chordSpans, rehearsalSpans, directionMarkers } =
      pageMetas[pNum - 1];
    const scale = config.renderScale;
    const canvas = await renderPageToCanvas(page, scale);

    if (chordSpans.length < MIN_PAGE_CHORD_SPANS) {
      pageRenders.push({
        pageIndex: pNum - 1,
        canvas,
        scale,
        pageWidthPt: pageW,
        pageHeightPt: pageH,
        systems: [],
      });
      continue;
    }

    // Stable staff envelope: 5%..95% of page width (PDF units)
    const staffLeft = pageW * 0.05;
    const staffRight = pageW * 0.95;
    const canvasBX0 = Math.max(0, Math.round(staffLeft * scale));
    const canvasBX1 = Math.min(canvas.width, Math.round(staffRight * scale));

    let systemGroups = clusterIntoSystems(chordSpans, config.ySystemClusterThresholdPx);
    systemGroups = filterDensestSystems(systemGroups);

    const pageSystems: SystemDebug[] = [];
    const forcedPresetName = config.barlinePreset !== 'auto' ? config.barlinePreset : null;

    for (let sysIdx = 0; sysIdx < systemGroups.length; sysIdx++) {
      const group = systemGroups[sysIdx];
      if (group.spans.length === 0) continue;

      const chordY = group.yCenter; // PDF-space y from bottom
      const yVals = group.spans.map((s) => s.y);
      const y0 = Math.min(...yVals) - 15;
      const y1 = Math.max(...yVals) + 15;

      // Helper: compute canvas band from PDF-space chordY
      const computeBand = (belowPts: number) => {
        const by0 = Math.max(
          0,
          Math.round((pageH - (chordY + 25)) * scale) // 25 pts above chord in PDF space
        );
        const by1 = Math.min(
          canvas.height,
          Math.round((pageH - (chordY - belowPts)) * scale) // belowPts below chord
        );
        return { by0, by1 };
      };

      // First pass: compute stem density to auto-select preset
      const { by0: initBy0, by1: initBy1 } = computeBand(80);
      const ctx = canvas.getContext('2d')!;
      const initBW = Math.max(1, canvasBX1 - canvasBX0);
      const initBH = Math.max(1, initBy1 - initBy0);
      const initData = ctx.getImageData(canvasBX0, initBy0, initBW, initBH).data;
      const stemDensity = computeStemDensity(initData, initBW * initBH);

      const usedPresetName =
        forcedPresetName ?? (stemDensity > STEM_DENSITY_THRESHOLD ? 'tab-heavy' : 'sparse');
      let presetCfg = BARLINE_PRESETS[usedPresetName];

      let { by0, by1 } = computeBand(80);
      let barlinesXPdf = detectBarlinesInBand(
        canvas,
        by0,
        by1,
        canvasBX0,
        canvasBX1,
        presetCfg,
        scale
      );

      // Two-pass: if tab-heavy, expand band 280 pts below chord and re-run
      if (!forcedPresetName && usedPresetName === 'tab-heavy') {
        ({ by0, by1 } = computeBand(280));
        barlinesXPdf = detectBarlinesInBand(
          canvas,
          by0,
          by1,
          canvasBX0,
          canvasBX1,
          BARLINE_PRESETS['tab-heavy'],
          scale
        );
      }

      // Add boundary barlines at stable staff edges if not already present
      if (barlinesXPdf.length === 0 || barlinesXPdf[0] > staffLeft + 30) {
        barlinesXPdf.unshift(staffLeft);
      }
      if (barlinesXPdf[barlinesXPdf.length - 1] < staffRight - 30) {
        barlinesXPdf.push(staffRight);
      }
      barlinesXPdf.sort((a, b) => a - b);

      // ── Map chord spans to measures ──────────────────────────────────────
      const sortedSpans = [...group.spans].sort((a, b) => a.x - b.x);
      const numMeasures = Math.max(1, barlinesXPdf.length - 1);
      const measureEvents: ChordEvent[][] = Array.from({ length: numMeasures }, () => []);

      for (const span of sortedSpans) {
        const cx = span.x + (span.width > 0 ? span.width / 2 : 0);
        let measureSlot = numMeasures - 1;
        for (let m = 0; m < barlinesXPdf.length - 1; m++) {
          if (cx >= barlinesXPdf[m] && cx < barlinesXPdf[m + 1]) {
            measureSlot = m;
            break;
          }
        }
        const raw = span.text.trim();
        const norm = normalizeChordSymbol(raw);
        measureEvents[measureSlot].push({
          x: span.x,
          y: span.y,
          raw,
          norm,
          confidence: CHORD_REGEX.test(norm) ? 1.0 : CHORD_REGEX.test(raw) ? 0.85 : 0.7,
        });
      }

      for (const events of measureEvents) events.sort((a, b) => a.x - b.x);

      // Collect markers within this system's y range
      const systemMarkers: Marker[] = [];
      for (const rSpan of rehearsalSpans) {
        if (rSpan.y >= y0 && rSpan.y <= y1)
          systemMarkers.push({
            type: 'rehearsal',
            value: rSpan.text.trim(),
            x: rSpan.x,
            y: rSpan.y,
          });
      }
      for (const dir of directionMarkers) {
        if (dir.y >= y0 && dir.y <= y1) systemMarkers.push(dir);
      }

      const measuresDebug: MeasureDebug[] = measureEvents.map((events, localIdx) => ({
        measureIndex: localIdx,
        globalIndex: globalMeasureIndex + localIdx,
        xRange: [barlinesXPdf[localIdx] ?? staffLeft, barlinesXPdf[localIdx + 1] ?? staffRight],
        events,
        directives: [],
      }));

      globalMeasureIndex += numMeasures;

      const sysDebug: SystemDebug = {
        systemIndex: sysIdx,
        pageIndex: pNum - 1,
        bbox: [staffLeft, y0, staffRight, y1],
        barlinesX: barlinesXPdf,
        measures: measuresDebug,
        markers: systemMarkers,
        preset: usedPresetName,
        stemDensity,
      };

      pageSystems.push(sysDebug);
      allSystemsDebug.push(sysDebug);
    }

    pageRenders.push({
      pageIndex: pNum - 1,
      canvas,
      scale,
      pageWidthPt: pageW,
      pageHeightPt: pageH,
      systems: pageSystems,
    });
  }

  // ── Build linear measure list ─────────────────────────────────────────────
  const linearMeasures: DebugJson['linear']['measures'] = [];
  for (const sys of allSystemsDebug) {
    for (const meas of sys.measures) {
      const chords =
        meas.events.length === 0
          ? []
          : !config.allowMultiChordBars || config.preferOneChordPerBar
            ? [meas.events[0].norm]
            : meas.events.map((e) => e.norm);
      linearMeasures.push({ n: meas.globalIndex, chords, directives: meas.directives });
    }
  }

  // ── Section detection with deduplication ─────────────────────────────────
  interface Section {
    label: string;
    startMeasure: number;
  }
  const sections: Section[] = [];
  const seen = new Set<string>();
  let measOffset = 0;
  for (const sys of allSystemsDebug) {
    for (const mk of sys.markers.filter((m) => m.type === 'rehearsal')) {
      const key = `${mk.value}@${measOffset}`;
      if (!seen.has(key)) {
        seen.add(key);
        sections.push({ label: mk.value, startMeasure: measOffset });
      }
    }
    measOffset += sys.measures.length;
  }
  if (sections.length === 0) sections.push({ label: 'Chords', startMeasure: 0 });

  // ── Emit ─────────────────────────────────────────────────────────────────
  const csmpnText =
    config.outputMode === 'csmpn-fakebook'
      ? emitFakebook(metadata, sections, linearMeasures, config)
      : emitBarlinesStyle(metadata, sections, linearMeasures, config);

  const debugJson: DebugJson = {
    metadata,
    pages: pageRenders.map((pr) => ({ pageIndex: pr.pageIndex, systems: pr.systems })),
    linear: { measures: linearMeasures },
  };

  return { csmpnText, debugJson, pageRenders };
}

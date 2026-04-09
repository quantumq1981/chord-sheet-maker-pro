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

// ─── Chord normalisation ──────────────────────────────────────────────────────

/**
 * normalizeChordSymbol
 *
 * Central normalisation function. Used by all parsing stages.
 * Converts various unicode and informal chord notations to canonical CSMPN form.
 */
export function normalizeChordSymbol(raw: string): string {
  let s = raw.trim();

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

  // 5. Major seventh: 7M / Δ / Maj7 / MAJ7 / maj7 → maj7
  s = s.replace(/Δ7?/g, 'maj7');
  s = s.replace(/7M\b/g, 'maj7');
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

/**
 * Returns true if `text` looks like a chord symbol.
 * Filters out: pure numbers, single capital letters (rehearsal marks), direction words.
 */
function isChordCandidate(span: TextSpan): boolean {
  const t = span.text.trim();
  if (!t || t.length > 16) return false;
  if (/^\d+$/.test(t)) return false; // bar numbers
  if (/^[A-Z]$/.test(t)) return false; // rehearsal letters (A, B, C …)
  if (DIRECTION_TEXTS.has(t)) return false;

  // Allow common direction marker detection
  const directionPattern =
    /^(N\.C\.|Fine|Coda|D\.S|D\.C|To\s|Double|Half-time|Freely|Tacet|Simile|Vamp|Rit|Rail|Accel)/i;
  if (directionPattern.test(t)) return false;

  // Must start with a note root
  if (!/^[A-G]/.test(t)) return false;

  // Try normalised form — must still match chord regex after normalisation
  const normed = normalizeChordSymbol(t);
  return CHORD_REGEX.test(normed) || CHORD_REGEX.test(t);
}

/** Returns true if `text` is a rehearsal marker (single or double letter). */
function isRehearsalMarker(span: TextSpan): boolean {
  const t = span.text.trim();
  // Single uppercase letter, or pairs like "A1", "B2"
  return /^[A-Z][0-9]?$/.test(t) && !CHORD_REGEX.test(t);
}

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

// ─── Barline detection (image-based) ─────────────────────────────────────────

/**
 * Render a PDF page to an HTMLCanvasElement at the given scale.
 */
async function renderPageToCanvas(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/**
 * Detect barline x-positions within a staff band using vertical projection.
 *
 * Algorithm:
 *   1. Crop the canvas to the system's y-band (with a small margin).
 *   2. Convert pixels to grayscale.
 *   3. For each column x, count the number of dark pixels.
 *   4. Find peaks (local maxima that exceed minHeightRatio * bandHeight).
 *   5. Merge peaks that are too close together.
 *   6. Return barline x positions (in PDF coordinate units).
 */
function detectBarlinesInBand(
  canvas: HTMLCanvasElement,
  /** y0, y1 in canvas pixels (top/bottom of system band). */
  bandY0: number,
  bandY1: number,
  /** x0, x1 in canvas pixels (left/right margin). */
  bandX0: number,
  bandX1: number,
  config: UGProImporterConfig,
  /** Conversion: canvas pixels → PDF user units. */
  scale: number
): number[] {
  const ctx = canvas.getContext('2d')!;
  const bandH = Math.max(1, bandY1 - bandY0);
  const bandW = Math.max(1, bandX1 - bandX0);

  if (bandW <= 0 || bandH <= 0) return [];

  const imageData = ctx.getImageData(bandX0, bandY0, bandW, bandH);
  const data = imageData.data;

  // Build column darkness profile
  const profile = new Float32Array(bandW);
  for (let col = 0; col < bandW; col++) {
    let darkCount = 0;
    for (let row = 0; row < bandH; row++) {
      const idx = (row * bandW + col) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      if (gray < 100) darkCount++;
    }
    profile[col] = darkCount / bandH;
  }

  // Find peaks above threshold
  const threshold = config.barlinePeakMinHeightRatio;
  const minSpacing = config.barlinePeakMinSpacingPx;
  const peaks: number[] = [];

  for (let col = 1; col < bandW - 1; col++) {
    if (
      profile[col] >= threshold &&
      profile[col] >= profile[col - 1] &&
      profile[col] >= profile[col + 1]
    ) {
      // Check minimum spacing from last accepted peak
      if (peaks.length === 0 || col - peaks[peaks.length - 1] >= minSpacing) {
        peaks.push(col);
      } else if (profile[col] > profile[peaks[peaks.length - 1]]) {
        // Replace with stronger peak if within spacing window
        peaks[peaks.length - 1] = col;
      }
    }
  }

  // Convert canvas pixel x → PDF user units
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
 *   - Multi-chord bars → joined with _  (e.g. Bb7_A7_D7)
 *   - Empty bar → %
 */
function barToken(
  m: LinearMeasure,
  lastChord: string,
  fillPercent: boolean
): [token: string, newLastChord: string] {
  if (m.chords.length === 0) {
    return [fillPercent && lastChord ? '%' : lastChord || '%', lastChord];
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

  // ── Collect all text spans across all pages ──────────────────────────────
  const allSpans: TextSpan[] = [];

  for (let pNum = 1; pNum <= numPages; pNum++) {
    const page = await pdf.getPage(pNum);
    const content = await page.getTextContent();

    for (const item of content.items) {
      if (!('str' in item)) continue;
      const ti = item as TextItem;
      if (!ti.str.trim()) continue;

      // PDF transform: [scaleX, skewX, skewY, scaleY, tx, ty]
      const tx = ti.transform[4] as number;
      const ty = ti.transform[5] as number;
      // Font size is encoded in scaleY (index 3)
      const fontSize = Math.abs(ti.transform[3] as number);

      allSpans.push({
        text: ti.str,
        x: tx,
        y: ty,
        width: ti.width ?? fontSize,
        height: ti.height ?? fontSize,
        fontSize,
        pageIndex: pNum - 1,
      });
    }
  }

  // ── Extract metadata from first page ────────────────────────────────────
  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const metadata = extractMetadata(allSpans, firstViewport.height);

  // ── Per-page processing ─────────────────────────────────────────────────
  const pageRenders: PageRenderData[] = [];
  const allSystemsDebug: SystemDebug[] = [];
  let globalMeasureIndex = 0;

  for (let pNum = 1; pNum <= numPages; pNum++) {
    const page = await pdf.getPage(pNum);
    const viewport1 = page.getViewport({ scale: 1 });
    const pageH = viewport1.height;
    const pageW = viewport1.width;

    // Render page to canvas for barline detection
    const canvas = await renderPageToCanvas(page, config.renderScale);
    const scale = config.renderScale;

    // Filter spans for this page
    const pageSpans = allSpans.filter((s) => s.pageIndex === pNum - 1);

    // Separate chord candidates from other spans
    const chordSpans = pageSpans.filter(isChordCandidate);
    const rehearsalSpans = pageSpans.filter(isRehearsalMarker);
    const directionSpans = pageSpans
      .filter((s) => !isChordCandidate(s) && !isRehearsalMarker(s))
      .map(classifyDirective)
      .filter((m): m is Marker => m !== null);

    // Skip pages with no chord candidates (e.g., cover page)
    if (chordSpans.length === 0) {
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

    // ── Cluster chord spans into systems by Y ──────────────────────────────
    const systemGroups = clusterIntoSystems(chordSpans, config.ySystemClusterThresholdPx);

    const pageSystems: SystemDebug[] = [];

    for (let sysIdx = 0; sysIdx < systemGroups.length; sysIdx++) {
      const group = systemGroups[sysIdx];
      const spans = group.spans;

      if (spans.length === 0) continue;

      // System bounding box in PDF coordinate units
      const xVals = spans.map((s) => s.x);
      const yVals = spans.map((s) => s.y);
      const x0 = Math.min(...xVals) - 10;
      const x1 = Math.max(...xVals.map((x, i) => x + spans[i].width)) + 10;
      const y0 = Math.min(...yVals) - 15;
      const y1 = Math.max(...yVals) + 15;

      // ── Barline detection on this system's band ──────────────────────────
      // Convert PDF y (bottom-origin) → canvas y (top-origin)
      const canvasY0 = Math.max(0, Math.round((pageH - y1) * scale));
      const canvasY1 = Math.min(canvas.height, Math.round((pageH - y0) * scale));
      const canvasX0 = Math.max(0, Math.round(x0 * scale));
      const canvasX1 = Math.min(canvas.width, Math.round(x1 * scale));

      // Expand band vertically to catch staff lines below chord labels
      const expandedY0 = Math.max(0, canvasY0 - Math.round(20 * scale));
      const expandedY1 = Math.min(canvas.height, canvasY1 + Math.round(40 * scale));

      const barlinesXPdf = detectBarlinesInBand(
        canvas,
        expandedY0,
        expandedY1,
        canvasX0,
        canvasX1,
        config,
        scale
      );

      // Always add left and right edges as boundary barlines if not present
      const leftEdge = x0 + 5;
      const rightEdge = x1 - 5;
      if (barlinesXPdf.length === 0 || barlinesXPdf[0] > leftEdge + 30) {
        barlinesXPdf.unshift(leftEdge);
      }
      if (barlinesXPdf[barlinesXPdf.length - 1] < rightEdge - 30) {
        barlinesXPdf.push(rightEdge);
      }

      // ── Map chord spans to measures ──────────────────────────────────────
      // Sort barlines and spans left-to-right
      barlinesXPdf.sort((a, b) => a - b);
      const sortedSpans = [...spans].sort((a, b) => a.x - b.x);

      const numMeasures = Math.max(1, barlinesXPdf.length - 1);
      const measureEvents: ChordEvent[][] = Array.from({ length: numMeasures }, () => []);

      for (const span of sortedSpans) {
        const cx = span.x + span.width / 2;
        // Find which measure interval contains this chord's x-center
        let measureSlot = 0;
        for (let m = 0; m < barlinesXPdf.length - 1; m++) {
          if (cx >= barlinesXPdf[m] && cx < barlinesXPdf[m + 1]) {
            measureSlot = m;
            break;
          }
          // Assign to last measure if beyond all barlines
          if (cx >= barlinesXPdf[barlinesXPdf.length - 1]) {
            measureSlot = numMeasures - 1;
          }
        }

        const raw = span.text.trim();
        const norm = normalizeChordSymbol(raw);
        measureEvents[measureSlot].push({
          x: span.x,
          y: span.y,
          raw,
          norm,
          confidence: CHORD_REGEX.test(norm) ? 1.0 : 0.7,
        });
      }

      // Sort events within each measure by x
      for (const events of measureEvents) {
        events.sort((a, b) => a.x - b.x);
      }

      // Collect rehearsal markers and directives for this system
      const systemMarkers: Marker[] = [];
      for (const rSpan of rehearsalSpans) {
        if (rSpan.y >= y0 && rSpan.y <= y1) {
          systemMarkers.push({
            type: 'rehearsal',
            value: rSpan.text.trim(),
            x: rSpan.x,
            y: rSpan.y,
          });
        }
      }
      for (const dir of directionSpans) {
        if (dir.y >= y0 && dir.y <= y1) {
          systemMarkers.push(dir);
        }
      }

      // Build measure debug objects
      const measuresDebug: MeasureDebug[] = measureEvents.map((events, localIdx) => ({
        measureIndex: localIdx,
        globalIndex: globalMeasureIndex + localIdx,
        xRange: [barlinesXPdf[localIdx] ?? x0, barlinesXPdf[localIdx + 1] ?? x1],
        events,
        directives: [],
      }));

      globalMeasureIndex += numMeasures;

      const sysDebug: SystemDebug = {
        systemIndex: sysIdx,
        pageIndex: pNum - 1,
        bbox: [x0, y0, x1, y1],
        barlinesX: barlinesXPdf,
        measures: measuresDebug,
        markers: systemMarkers,
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
      let chords: string[];

      if (meas.events.length === 0) {
        chords = [];
      } else if (!config.allowMultiChordBars || config.preferOneChordPerBar) {
        chords = [meas.events[0].norm];
      } else {
        chords = meas.events.map((e) => e.norm);
      }

      linearMeasures.push({
        n: meas.globalIndex,
        chords,
        directives: meas.directives,
      });
    }
  }

  // ── Section detection ─────────────────────────────────────────────────────
  // Collect rehearsal markers from all systems, sorted by global measure position
  interface Section {
    label: string;
    startMeasure: number;
  }

  const sections: Section[] = [];
  let measOffset = 0;
  for (const sys of allSystemsDebug) {
    const sysRehearsals = sys.markers.filter((m) => m.type === 'rehearsal');
    if (sysRehearsals.length > 0) {
      for (const r of sysRehearsals) {
        sections.push({ label: r.value, startMeasure: measOffset });
      }
    }
    measOffset += sys.measures.length;
  }

  // If no rehearsal markers found, create a single "Chorus 1" section
  if (sections.length === 0) {
    sections.push({ label: 'Chorus 1', startMeasure: 0 });
  }

  // ── Emit ─────────────────────────────────────────────────────────────────
  const csmpnText =
    config.outputMode === 'csmpn-fakebook'
      ? emitFakebook(metadata, sections, linearMeasures, config)
      : emitBarlinesStyle(metadata, sections, linearMeasures, config);

  // ── Build debugJson ──────────────────────────────────────────────────────
  const debugJson: DebugJson = {
    metadata,
    pages: pageRenders.map((pr) => ({
      pageIndex: pr.pageIndex,
      systems: pr.systems,
    })),
    linear: { measures: linearMeasures },
  };

  return { csmpnText, debugJson, pageRenders };
}

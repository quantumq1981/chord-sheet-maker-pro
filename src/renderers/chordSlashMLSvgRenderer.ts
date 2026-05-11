/**
 * chordSlashMLSvgRenderer.ts
 *
 * Renders a parsed ChordSlashML document as a self-contained SVG string.
 *
 * Layout model
 * ────────────
 *   The SVG is PAGE_W pixels wide.  Measures are grouped into rows of up to
 *   measuresPerRow measures.  Each system (row) comprises:
 *
 *     TITLE_AREA_H    — title/meta block (first system only)
 *     SECTION_LABEL_H — section-label strip (when a section starts a row)
 *     CHORD_AREA_H    — space above the staff for chord symbols
 *     STAFF_H         — 5-line staff  (4 × LINE_GAP)
 *     SYSTEM_PAD_BOT  — breathing room below staff
 *
 * Staff details
 * ─────────────
 *   Slash noteheads are parallelograms (standard "rhythmic slash" notation).
 *   Chord symbols appear above the staff centred on each beat.
 *   Barlines extend through the full staff height.
 *   Repeat and final barlines use standard thick+thin conventions.
 *
 * All output is plain SVG text — no external libraries required.
 */

import type { CSMLDocument, CSMLMeasure, CSMLBeat } from '../parsers/chordSlashMLParser.js';
import {
  parseChordSlashML,
  beatsPerMeasure,
  beatChordText,
} from '../parsers/chordSlashMLParser.js';

export type { CSMLDocument };
export { parseChordSlashML };

// ─── Layout constants ─────────────────────────────────────────────────────────

const PAGE_W = 760;
const MARGIN_H = 36;
const CLEF_W = 50;

const LINE_GAP = 8;
const STAFF_LINES = 5;
const STAFF_H = (STAFF_LINES - 1) * LINE_GAP; // 32px
const CHORD_AREA_H = 38;
const SYSTEM_PAD_BOT = 40;
const SYSTEM_ROW_H = CHORD_AREA_H + STAFF_H + SYSTEM_PAD_BOT; // 110px
const SECTION_LABEL_H = 22;
const TITLE_AREA_H = 56;

// Slash notehead parallelogram geometry
const SN_W = 9;
const SN_H = 5.5;
const SN_LEAN = 5;

// ─── Renderer options ──────────────────────────────────────────────────────────

export interface RenderOptions {
  measuresPerRow?: number;
  fgColor?: string;
  bgColor?: string;
  chordColor?: string;
  chordFontSize?: number;
  chordFont?: string;
  labelFont?: string;
  stems?: boolean;
  keySig?: string;
}

interface ResolvedOpts {
  measuresPerRow: number;
  fgColor: string;
  bgColor: string;
  chordColor: string;
  chordFontSize: number;
  chordFont: string;
  labelFont: string;
  stems: boolean;
  keySig: string;
}

function resolveOpts(opts?: RenderOptions): ResolvedOpts {
  return {
    measuresPerRow: opts?.measuresPerRow ?? 4,
    fgColor: opts?.fgColor ?? '#000000',
    bgColor: opts?.bgColor ?? '#ffffff',
    chordColor: opts?.chordColor ?? '#000000',
    chordFontSize: opts?.chordFontSize ?? 14,
    chordFont: opts?.chordFont ?? 'Georgia, serif',
    labelFont: opts?.labelFont ?? 'Arial, sans-serif',
    stems: opts?.stems ?? false,
    keySig: opts?.keySig ?? '',
  };
}

// ─── SVG primitive helpers ─────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function svgLine(x1: number, y1: number, x2: number, y2: number, col: string, w = 1): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}"/>`;
}

function slashHead(cx: number, cy: number, col: string): string {
  const x1 = cx - SN_W / 2;
  const y1 = cy + SN_H / 2;
  const x2 = cx + SN_W / 2;
  const y2 = cy + SN_H / 2;
  const x3 = cx + SN_W / 2 + SN_LEAN;
  const y3 = cy - SN_H / 2;
  const x4 = cx - SN_W / 2 + SN_LEAN;
  const y4 = cy - SN_H / 2;
  return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3} ${x4},${y4}" fill="${col}"/>`;
}

function noteStem(cx: number, cy: number, col: string): string {
  return svgLine(cx + SN_LEAN / 2 + 4, cy - SN_H / 2, cx + SN_LEAN / 2 + 4, cy - 22, col, 1.5);
}

function staffLines(x: number, y: number, w: number, col: string): string {
  const lines: string[] = [];
  for (let i = 0; i < STAFF_LINES; i++) {
    lines.push(svgLine(x, y + i * LINE_GAP, x + w, y + i * LINE_GAP, col, 1));
  }
  return lines.join('');
}

function trebleClef(x: number, y: number, _col: string): string {
  // Render as italic text glyph — works universally without font embedding
  return `<text x="${x}" y="${y + STAFF_H + 4}" font-size="40" font-family="serif" fill="${_col}" dominant-baseline="bottom">𝄞</text>`;
}

const SHARP_KEY_COUNT: Record<string, number> = {
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  'F#': 6,
  'C#': 7,
};
const FLAT_KEY_COUNT: Record<string, number> = {
  F: 1,
  Bb: 2,
  Eb: 3,
  Ab: 4,
  Db: 5,
  Gb: 6,
  Cb: 7,
};
const SHARP_Y_OFFSETS = [0, 12, -4, 8, 20, 4, 16];
const FLAT_Y_OFFSETS = [16, 4, 20, 8, 24, 12, 28];

interface KsResult {
  svg: string;
  width: number;
}

function keySigSvg(x: number, staffY: number, keySig: string, col: string): KsResult {
  if (SHARP_KEY_COUNT[keySig] !== undefined) {
    const count = SHARP_KEY_COUNT[keySig];
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push(
        `<text x="${x + i * 8}" y="${staffY + SHARP_Y_OFFSETS[i] - 4}" font-size="14" font-family="serif" fill="${col}" dominant-baseline="hanging">♯</text>`
      );
    }
    return { svg: parts.join(''), width: count * 8 + 4 };
  }
  if (FLAT_KEY_COUNT[keySig] !== undefined) {
    const count = FLAT_KEY_COUNT[keySig];
    const parts: string[] = [];
    for (let i = 0; i < count; i++) {
      parts.push(
        `<text x="${x + i * 8}" y="${staffY + FLAT_Y_OFFSETS[i] - 8}" font-size="14" font-family="serif" fill="${col}" dominant-baseline="hanging">♭</text>`
      );
    }
    return { svg: parts.join(''), width: count * 8 + 4 };
  }
  return { svg: '', width: 0 };
}

function timeSigSvg(x: number, staffY: number, time: string, col: string): string {
  const m = /^(\d+)\/(\d+)$/.exec(time);
  if (!m) return '';
  return (
    `<text x="${x + 6}" y="${staffY + 2}" font-size="16" font-weight="bold" font-family="serif" fill="${col}" dominant-baseline="hanging">${m[1]}</text>` +
    `<text x="${x + 6}" y="${staffY + 16}" font-size="16" font-weight="bold" font-family="serif" fill="${col}" dominant-baseline="hanging">${m[2]}</text>`
  );
}

type BarlineKind = 'single' | 'double' | 'final' | 'repeat-start' | 'repeat-end';

function barlineSvg(x: number, y: number, h: number, kind: BarlineKind, col: string): string {
  const dotR = 3;
  switch (kind) {
    case 'single':
      return svgLine(x, y, x, y + h, col, 1.5);
    case 'double':
      return svgLine(x - 2, y, x - 2, y + h, col, 1) + svgLine(x + 2, y, x + 2, y + h, col, 1);
    case 'final':
      return svgLine(x - 3, y, x - 3, y + h, col, 1) + svgLine(x, y, x, y + h, col, 4);
    case 'repeat-start':
      return (
        svgLine(x, y, x, y + h, col, 4) +
        svgLine(x + 4, y, x + 4, y + h, col, 1) +
        `<circle cx="${x + 9}" cy="${y + h * 0.33}" r="${dotR}" fill="${col}"/>` +
        `<circle cx="${x + 9}" cy="${y + h * 0.67}" r="${dotR}" fill="${col}"/>`
      );
    case 'repeat-end':
      return (
        svgLine(x - 9, y, x - 9, y + h, col, 1) +
        svgLine(x - 5, y, x - 5, y + h, col, 4) +
        `<circle cx="${x - 13}" cy="${y + h * 0.33}" r="${dotR}" fill="${col}"/>` +
        `<circle cx="${x - 13}" cy="${y + h * 0.67}" r="${dotR}" fill="${col}"/>`
      );
  }
}

// ─── Row grouping ──────────────────────────────────────────────────────────────

interface RowMeasure {
  measure: CSMLMeasure;
  sectionLabel?: string;
}

interface Row {
  measures: RowMeasure[];
  isFirstRow: boolean;
}

function buildRows(doc: CSMLDocument, mpr: number): Row[] {
  const rows: Row[] = [];
  let current: RowMeasure[] = [];
  let isFirstRow = true;

  const flush = () => {
    if (current.length > 0) {
      rows.push({ measures: current, isFirstRow });
      isFirstRow = false;
      current = [];
    }
  };

  for (const sec of doc.sections) {
    for (let mi = 0; mi < sec.measures.length; mi++) {
      const rm: RowMeasure = { measure: sec.measures[mi] };
      if (mi === 0 && sec.label) rm.sectionLabel = sec.label;

      if (sec.measures[mi].leftBarline === 'repeat-start' && current.length > 0) {
        flush();
      }

      current.push(rm);

      if (
        current.length >= mpr ||
        sec.measures[mi].rightBarline === 'repeat-end' ||
        sec.measures[mi].rightBarline === 'final'
      ) {
        flush();
      }
    }
  }

  flush();
  return rows;
}

// ─── Beat notehead renderer ────────────────────────────────────────────────────

function renderBeatNoteheads(
  beat: CSMLBeat,
  cx: number,
  cy: number,
  subSpacing: number,
  fg: string,
  withStem: boolean,
  out: string[],
  depth: number
): void {
  if (depth > 3) return;

  switch (beat.kind) {
    case 'chord':
    case 'slash':
      out.push(slashHead(cx, cy, fg));
      if (withStem) out.push(noteStem(cx, cy, fg));
      break;

    case 'rest':
      out.push(`<rect x="${cx - 5}" y="${cy - 2}" width="10" height="4" fill="${fg}"/>`);
      break;

    case 'compound': {
      const n = Math.min(beat.parts.length, 4);
      for (let i = 0; i < n; i++) {
        const nhX = cx - (subSpacing * (n - 1)) / 2 + i * subSpacing;
        out.push(slashHead(nhX, cy, fg));
        if (withStem) out.push(noteStem(nhX, cy, fg));
      }
      break;
    }

    case 'tuplet': {
      const n = beat.beats.length;
      const sp = subSpacing / Math.max(n, 1);
      for (let i = 0; i < n; i++) {
        const nhX = cx - (subSpacing * (n - 1)) / 2 + i * subSpacing;
        renderBeatNoteheads(beat.beats[i], nhX, cy, sp, fg, withStem, out, depth + 1);
      }
      // Tuplet bracket
      const bx1 = cx - (subSpacing * (n - 1)) / 2 - 4;
      const bx2 = cx + (subSpacing * (n - 1)) / 2 + 4;
      const by = cy - 28;
      out.push(
        svgLine(bx1, by, bx2, by, fg, 1),
        svgLine(bx1, by, bx1, by + 6, fg, 1),
        svgLine(bx2, by, bx2, by + 6, fg, 1),
        `<text x="${(bx1 + bx2) / 2}" y="${by - 2}" font-size="9" font-family="Arial,sans-serif" fill="${fg}" text-anchor="middle">${n}</text>`
      );
      break;
    }
  }
}

// ─── Main SVG render ───────────────────────────────────────────────────────────

/**
 * Render a parsed ChordSlashML document as a self-contained SVG string.
 */
export function renderChordSlashMLSvg(doc: CSMLDocument, opts?: RenderOptions): string {
  const o = resolveOpts(opts);
  const mpr = o.measuresPerRow;
  const { fgColor: fg, bgColor: bg, chordColor: cc } = o;
  const rows = buildRows(doc, mpr);
  const bpm = beatsPerMeasure(doc.time);

  // Compute total SVG height
  let totalH = TITLE_AREA_H;
  for (const row of rows) {
    const hasLabel = row.measures.some((rm) => rm.sectionLabel);
    totalH += (hasLabel ? SECTION_LABEL_H : 0) + SYSTEM_ROW_H;
  }

  const parts: string[] = [];
  parts.push(`<rect width="${PAGE_W}" height="${totalH}" fill="${bg}"/>`);

  // Title block
  if (doc.title) {
    parts.push(
      `<text x="${PAGE_W / 2}" y="28" font-size="20" font-weight="bold" font-family="${esc(o.labelFont)}" fill="${fg}" text-anchor="middle">${esc(doc.title)}</text>`
    );
  }
  const metaParts: string[] = [];
  if (doc.composer) metaParts.push(esc(doc.composer));
  if (doc.key) metaParts.push(`Key: ${esc(doc.key)}`);
  if (doc.tempo) metaParts.push(`♩= ${doc.tempo}`);
  if (doc.style) metaParts.push(esc(doc.style));
  if (metaParts.length > 0) {
    parts.push(
      `<text x="${PAGE_W / 2}" y="46" font-size="11" font-family="${esc(o.labelFont)}" fill="${fg}" text-anchor="middle">${metaParts.join('   ')}</text>`
    );
  }

  let curY = TITLE_AREA_H;

  for (const row of rows) {
    const labelText = row.measures.find((rm) => rm.sectionLabel)?.sectionLabel;

    if (labelText) {
      parts.push(
        `<text x="${MARGIN_H}" y="${curY + 16}" font-size="13" font-weight="bold" font-style="italic" font-family="${esc(o.labelFont)}" fill="${fg}">${esc(labelText)}</text>`
      );
      curY += SECTION_LABEL_H;
    }

    const staffY = curY + CHORD_AREA_H;
    const rowX = MARGIN_H;
    const showClef = row.isFirstRow || Boolean(labelText);
    const clefUsedW = showClef ? CLEF_W : 0;

    if (showClef) {
      parts.push(trebleClef(rowX, staffY - 8, fg));
      const { svg: ksSvg, width: ksW } = keySigSvg(rowX + 28, staffY, o.keySig, fg);
      parts.push(ksSvg);
      const tsX = rowX + 28 + ksW;
      parts.push(timeSigSvg(tsX, staffY, doc.time, fg));
    }

    const rowUsableW = PAGE_W - 2 * MARGIN_H - clefUsedW;
    const measW = rowUsableW / row.measures.length;
    const staffStartX = rowX + clefUsedW;

    parts.push(staffLines(staffStartX, staffY, rowUsableW, fg));

    // Opening barline of first measure
    const firstBarKind = row.measures[0].measure.leftBarline;
    parts.push(
      barlineSvg(
        staffStartX,
        staffY,
        STAFF_H,
        firstBarKind === 'repeat-start' ? 'repeat-start' : 'single',
        fg
      )
    );

    let mx = staffStartX;

    for (let mi = 0; mi < row.measures.length; mi++) {
      const { measure } = row.measures[mi];
      const measLeft = mx;
      const measRight = mx + measW;
      const beatSpacing = measW / Math.max(bpm, 1);
      const noteCy = staffY + Math.floor(STAFF_H / 2);

      // Render beats
      for (let bi = 0; bi < measure.beats.length; bi++) {
        const beat = measure.beats[bi];
        const bx = measLeft + beatSpacing * bi + beatSpacing * 0.5;

        const chordTxt = beatChordText(beat);
        if (chordTxt) {
          parts.push(
            `<text x="${bx}" y="${staffY - 10}" font-size="${o.chordFontSize}" font-family="${esc(o.chordFont)}" fill="${cc}" text-anchor="middle">${esc(chordTxt)}</text>`
          );
        }

        const noteheads: string[] = [];
        renderBeatNoteheads(beat, bx, noteCy, beatSpacing * 0.4, fg, o.stems, noteheads, 0);
        parts.push(...noteheads);
      }

      // Fill remaining beats with plain slash noteheads
      for (let bi = measure.beats.length; bi < bpm; bi++) {
        const bx = measLeft + beatSpacing * bi + beatSpacing * 0.5;
        parts.push(slashHead(bx, noteCy, fg));
        if (o.stems) parts.push(noteStem(bx, noteCy, fg));
      }

      mx = measRight;

      // Right barline
      const isLast = mi === row.measures.length - 1;
      const rk = measure.rightBarline;
      const resolvedRk: BarlineKind =
        rk === 'final' && isLast
          ? 'final'
          : rk === 'repeat-end'
            ? 'repeat-end'
            : rk === 'double'
              ? 'double'
              : 'single';
      parts.push(barlineSvg(measRight, staffY, STAFF_H, resolvedRk, fg));
    }

    curY += SYSTEM_ROW_H;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${totalH}" viewBox="0 0 ${PAGE_W} ${totalH}">`,
    ...parts,
    '</svg>',
  ].join('\n');
}

/**
 * Parse ChordSlashML text and render it directly to an SVG string.
 */
export function chordSlashMLToSvg(text: string, opts?: RenderOptions): string {
  return renderChordSlashMLSvg(parseChordSlashML(text), opts);
}

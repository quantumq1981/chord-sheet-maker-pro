/**
 * ugProPdfUtils.ts — Pure PDF span utilities with no browser / pdfjs-dist dependency.
 * Safe to import in Node.js tests.
 *
 * Exports:
 *   - TextSpan interface (PDF coordinate-space text element)
 *   - SMuFL glyph constants (time sig digits, key sig accidentals, repeat barlines)
 *   - detectTimeSigSpans()  — reconstruct time-sig fractions from SMuFL stacks
 *   - detectKeySig()        — detect key signature from SMuFL accidental count
 *   - mergeFragmentSpans()  — reconstruct chord names split across PDF text runs
 */

import { normalizeChordSymbol, CHORD_REGEX } from './chordNormalizer.js';

/**
 * A text element extracted from a PDF page, with PDF coordinate-space position.
 * x: from left edge, y: from bottom of page (PDF convention).
 */
export interface TextSpan {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  pageIndex: number;
}

// ─── Time-signature glyph detection ─────────────────────────────────────────

/**
 * MuseScore embeds time signature digits as SMuFL private-use characters
 * (Leland font, U+E080–U+E089).  Two stacked glyphs at the same X form a
 * fraction: the one with the higher PDF-y is the numerator.
 */
export const SMUFL_DIGIT: Record<string, string> = {
  '': '0',
  '': '1',
  '': '2',
  '': '3',
  '': '4',
  '': '5',
  '': '6',
  '': '7',
  '': '8',
  '': '9',
};
export const SMUFL_COMMON = ''; // common time → 4/4
export const SMUFL_CUT = ''; // cut time    → 2/2

// Key-signature accidentals (standard SMuFL / Leland font)
export const SMUFL_FLAT_KS = ''; // accidentalFlat
export const SMUFL_SHARP_KS = ''; // accidentalSharp

// Repeat barline type glyphs (standard SMuFL / Leland font)
export const SMUFL_REPEAT_START = ''; // barlineStartRepeat
export const SMUFL_REPEAT_END = ''; // barlineEndRepeat
export const SMUFL_REPEAT_BOTH = ''; // barlineEndStartRepeat

export interface TimeSigRecord {
  timeSig: string;
  x: number;
  y: number;
}

/**
 * Scan page spans for SMuFL time-signature glyphs and reconstruct the
 * time-sig fractions (e.g. 3/4, 12/8).  Returns one record per change point.
 */
export function detectTimeSigSpans(spans: TextSpan[]): TimeSigRecord[] {
  const candidates = spans.filter((s) => {
    const t = s.text.trim();
    return (
      t.length === 1 && (SMUFL_DIGIT[t] !== undefined || t === SMUFL_COMMON || t === SMUFL_CUT)
    );
  });
  if (candidates.length === 0) return [];

  // Group by similar X (±15 pt) — numerator and denominator share an X position
  const groups: TextSpan[][] = [];
  for (const span of candidates) {
    let placed = false;
    for (const grp of groups) {
      if (Math.abs(grp[0].x - span.x) < 15) {
        grp.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([span]);
  }

  const result: TimeSigRecord[] = [];
  for (const grp of groups) {
    const common = grp.find((s) => s.text.trim() === SMUFL_COMMON);
    if (common) {
      result.push({ timeSig: '4/4', x: common.x, y: common.y });
      continue;
    }
    const cut = grp.find((s) => s.text.trim() === SMUFL_CUT);
    if (cut) {
      result.push({ timeSig: '2/2', x: cut.x, y: cut.y });
      continue;
    }
    if (grp.length < 2) continue;

    // Sort by y descending — higher y in PDF space = top of staff = numerator
    grp.sort((a, b) => b.y - a.y);
    const topY = grp[0].y;
    const numSpans = grp.filter((s) => Math.abs(s.y - topY) < 15).sort((a, b) => a.x - b.x);
    const denSpans = grp.filter((s) => Math.abs(s.y - topY) >= 15).sort((a, b) => a.x - b.x);
    if (numSpans.length === 0 || denSpans.length === 0) continue;

    const num = numSpans.map((s) => SMUFL_DIGIT[s.text.trim()] ?? '').join('');
    const den = denSpans.map((s) => SMUFL_DIGIT[s.text.trim()] ?? '').join('');
    if (!num || !den) continue;

    result.push({ timeSig: `${num}/${den}`, x: grp[0].x, y: topY });
  }
  return result;
}

// ─── Key-signature glyph detection ───────────────────────────────────────────

/** Maps sharp count → major key name (index = number of sharps). */
export const KEY_FROM_SHARPS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
/** Maps flat count → major key name (index = number of flats). */
export const KEY_FROM_FLATS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

export interface KeySigRecord {
  /** Key name, e.g. 'G', 'Bb', 'F#', or 'C' when no accidentals detected. */
  key: string;
  numAccidentals: number;
  accidentalType: 'sharp' | 'flat' | 'none';
}

/**
 * Detect the initial key signature from SMuFL accidental glyphs (Leland font
 * U+E260 = flat, U+E262 = sharp) that appear in the left-most zone of the page.
 * Key-sig accidentals live between the clef and the time sig — always well inside
 * the left 25% of the page width.  Returns null only when no SMuFL accidentals
 * are found in that zone (caller can leave metadata.key as-is).
 */
export function detectKeySig(spans: TextSpan[], pageW: number): KeySigRecord | null {
  const leftZone = pageW * 0.25;

  const sharpCount = spans.filter((s) => s.text.trim() === SMUFL_SHARP_KS && s.x < leftZone).length;

  const flatCount = spans.filter((s) => s.text.trim() === SMUFL_FLAT_KS && s.x < leftZone).length;

  if (sharpCount >= 1 && sharpCount <= 7) {
    return {
      key: KEY_FROM_SHARPS[sharpCount],
      numAccidentals: sharpCount,
      accidentalType: 'sharp',
    };
  }
  if (flatCount >= 1 && flatCount <= 7) {
    return { key: KEY_FROM_FLATS[flatCount], numAccidentals: flatCount, accidentalType: 'flat' };
  }
  return null;
}

// ─── Fragment span merging ────────────────────────────────────────────────────

/**
 * MuseScore sometimes renders a single chord symbol across two or more separate
 * PDF text runs — typically when a font shift occurs at the slash separator or
 * at the start of a quality suffix.  Examples seen in real UG Pro PDFs:
 *   "D9" + "/F"   → "D9/F"   (slash chord split at /)
 *   "B♭" + "7/A"  → "Bb7/A"  (quality + slash bass separated)
 *   "E"  + "dim7" → "Edim7"  (root and quality in two runs)
 *   "G"  + "m11"  → "Gm11"
 *
 * Algorithm:
 *   1. Group spans by page and Y-band (±5 pt).
 *   2. Within each band, sort left-to-right and greedily merge consecutive spans
 *      when (a) the right span does NOT start with a note letter [A-G] (i.e. it
 *      cannot be an independent chord root) and (b) the concatenated text passes
 *      CHORD_REGEX after normalisation and (c) the horizontal gap is narrow
 *      (< 3× the current font size).
 */
export function mergeFragmentSpans(pageSpans: TextSpan[]): TextSpan[] {
  // Sort: page index, then Y descending, then X ascending
  const sorted = [...pageSpans].sort((a, b) =>
    a.pageIndex !== b.pageIndex
      ? a.pageIndex - b.pageIndex
      : Math.abs(a.y - b.y) > 5
        ? b.y - a.y
        : a.x - b.x
  );

  // Build Y-bands: same page + Y within ±5 pt
  const bands: TextSpan[][] = [];
  for (const span of sorted) {
    let placed = false;
    for (const band of bands) {
      const rep = band[0];
      if (rep.pageIndex === span.pageIndex && Math.abs(rep.y - span.y) <= 5) {
        band.push(span);
        placed = true;
        break;
      }
    }
    if (!placed) bands.push([span]);
  }

  const result: TextSpan[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x - b.x);

    let i = 0;
    while (i < band.length) {
      // Work on a mutable copy so we can extend in the inner loop
      let cur: TextSpan = band[i];
      let curText = cur.text.trim();

      // Greedily absorb subsequent fragment spans
      while (i + 1 < band.length) {
        const next = band[i + 1];
        const nextText = next.text.trim();

        // Estimated right edge of current span (width is often 0 in some PDFs)
        const estimatedW = cur.width > 0 ? cur.width : cur.fontSize * curText.length * 0.55;
        const gap = next.x - (cur.x + estimatedW);

        // Stop if: different page, gap too large, or right span is an independent chord root
        if (next.pageIndex !== cur.pageIndex || gap >= cur.fontSize * 3 || /^[A-G]/.test(nextText))
          break;

        const combined = curText + nextText;
        const normedCombined = normalizeChordSymbol(combined);
        if (CHORD_REGEX.test(normedCombined) || CHORD_REGEX.test(combined)) {
          const nextRight = next.x + (next.width > 0 ? next.width : next.fontSize);
          cur = {
            ...cur,
            text: combined,
            width: Math.max(0, nextRight - cur.x),
          };
          curText = combined;
          i++; // consume next
        } else {
          break; // combined still invalid — stop
        }
      }

      result.push(cur);
      i++;
    }
  }
  return result;
}

/**
 * extractTextFromPdf.ts
 *
 * Extracts plain text from a PDF file using PDF.js, preserving the visual
 * line structure so that chord-chart formats (Ultimate Guitar, chords-over-words)
 * can be detected and parsed from PDF exports.
 *
 * Line reconstruction
 * ───────────────────
 * PDF content streams store text as positioned glyphs, not natural lines.
 * We reconstruct lines by grouping text items that share the same vertical
 * (Y) position (within a ±2 pt tolerance) and sorting each group left-to-right
 * by X position.  Pages are joined with a blank line between them.
 *
 * Worker
 * ──────
 * The PDF.js worker is loaded from the same package via import.meta.url so
 * Vite resolves and bundles it correctly for both dev and production.
 */

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';

// Vite resolves `new URL(..., import.meta.url)` to a static asset URL at
// build time.  This is the recommended way to reference web workers in Vite.
GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).href;

/** Vertical tolerance in PDF user units for considering items on the same line. */
const LINE_Y_TOLERANCE = 2;

function roundToLine(y: number): number {
  return Math.round(y / LINE_Y_TOLERANCE) * LINE_Y_TOLERANCE;
}

/**
 * Extract all text from a PDF ArrayBuffer.
 *
 * Returns a plain-text string with lines reconstructed from glyph positions.
 * Pages are separated by a single blank line.
 *
 * Throws if the PDF is password-protected or unreadable.
 */
export async function extractTextFromPdf(data: ArrayBuffer): Promise<string> {
  const loadingTask = getDocument({ data });
  const pdf = await loadingTask.promise;

  const pageTexts: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    // Group items by rounded Y coordinate
    const lineMap = new Map<number, Array<{ x: number; text: string }>>();

    for (const item of content.items) {
      // TextItem has `str` and `transform`; TextMarkedContent does not
      if (!('str' in item)) continue;
      const str = item.str;
      if (!str) continue;

      // transform is [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const x = item.transform[4] as number;
      const y = roundToLine(item.transform[5] as number);

      let row = lineMap.get(y);
      if (!row) {
        row = [];
        lineMap.set(y, row);
      }
      row.push({ x, text: str });
    }

    // Sort Y values descending (PDF origin is bottom-left; higher Y = higher on page)
    const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);

    const lines = sortedYs.map((y) => {
      const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
      return items.map((i) => i.text).join('');
    });

    pageTexts.push(lines.join('\n'));
  }

  return pageTexts.join('\n\n');
}

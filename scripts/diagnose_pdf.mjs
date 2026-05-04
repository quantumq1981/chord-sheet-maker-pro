/**
 * diagnose_pdf.mjs — dump raw PDF.js text spans from a UG Pro PDF.
 * Usage: node scripts/diagnose_pdf.mjs <path-to-pdf> [maxPages]
 *
 * Outputs per-span: str, x, y, width, height, fontSize, fontName
 * Also summarises: font names, unique str values, y-bands.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// pdfjs-dist legacy (no canvas needed for text extraction)
const pdfjsLib = await import(
  '../node_modules/pdfjs-dist/legacy/build/pdf.mjs'
);

const pdfFile = process.argv[2];
const maxPages = Number(process.argv[3] || 2);

if (!pdfFile) {
  console.error('Usage: node scripts/diagnose_pdf.mjs <pdf> [maxPages]');
  process.exit(1);
}

const data = readFileSync(pdfFile);
const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
const doc = await loadingTask.promise;
const totalPages = Math.min(doc.numPages, maxPages);

console.log(`=== ${path.basename(pdfFile)} (${doc.numPages} pages, showing ${totalPages}) ===\n`);

const CHORD_RE = /^[A-G][b#]?(maj|min|m|dim|aug|sus|add|M|[0-9]|\/[A-G]|Ø|ø|°|Δ|j)?/;
const NOTE_ROOT = /^[A-G]$/;

for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
  const page = await doc.getPage(pageNum);
  const vp = page.getViewport({ scale: 1.0 });
  const pageH = vp.height;
  const pageW = vp.width;
  const textContent = await page.getTextContent({ includeMarkedContent: false });

  const spans = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = item.transform;
    // PDF transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
    const x = tx[4];
    const y = tx[5];
    const fontSize = Math.hypot(tx[0], tx[1]);
    spans.push({
      str: item.str,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      w: Math.round((item.width || 0) * 10) / 10,
      h: Math.round(fontSize * 10) / 10,
      font: item.fontName || '?',
    });
  }

  console.log(`--- Page ${pageNum} (${Math.round(pageW)}×${Math.round(pageH)}) — ${spans.length} spans ---`);

  // Collect stats
  const fonts = new Map();
  const yBands = new Map();
  const singleLetterSpans = [];

  for (const s of spans) {
    fonts.set(s.font, (fonts.get(s.font) || 0) + 1);
    const band = Math.round(s.y / 10) * 10;
    if (!yBands.has(band)) yBands.set(band, []);
    yBands.get(band).push(s.str);
    if (/^[a-gA-G]$/.test(s.str)) singleLetterSpans.push(s);
  }

  console.log('\nFont names and counts:');
  for (const [font, count] of [...fonts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${font}: ${count}`);
  }

  console.log('\nAll spans (x, y, h, font, str):');
  for (const s of spans) {
    const tag = /^[A-G][b#]?/.test(s.str) ? ' <<CHORD?' : '';
    console.log(`  x=${s.x.toString().padStart(6)} y=${s.y.toString().padStart(6)} h=${s.h.toString().padStart(5)} font=${s.font.padEnd(30)} "${s.str}"${tag}`);
  }

  console.log(`\nSingle-letter [A-G] spans (${singleLetterSpans.length} total):`);
  for (const s of singleLetterSpans) {
    console.log(`  x=${s.x.toString().padStart(6)} y=${s.y.toString().padStart(6)} h=${s.h.toString().padStart(5)} font=${s.font} "${s.str}"`);
  }

  // Y-band summary
  const sortedBands = [...yBands.entries()].sort((a, b) => b[0] - a[0]);
  console.log('\nY-band summary (top to bottom, y=distance from bottom):');
  for (const [band, strs] of sortedBands) {
    const preview = strs.slice(0, 12).map(s => `"${s}"`).join(' ');
    console.log(`  y≈${band}: ${preview}${strs.length > 12 ? ` ... (${strs.length} total)` : ''}`);
  }

  console.log('');
}

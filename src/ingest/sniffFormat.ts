/**
 * sniffFormat.ts
 *
 * Lightweight format-detection utility. Reads up to 2 KB of a file's raw bytes
 * plus its filename extension and returns a discriminated-union tag identifying
 * the most likely format.  No external dependencies.
 *
 * Detection order (first match wins):
 *   1a. PDF magic / .pdf              → pdf
 *   1b. GP extension or magic bytes   → guitarpro   (.gp .gp3 .gp4 .gp5 .gpx)
 *   1c. ZIP magic (non-GP)            → mxl
 *   2.  XML + score root element      → musicxml
 *   3.  ABC X: header                 → abc
 *   4.  ChordPro directives           → chordpro
 *   5.  UG section headers            → ultimateguitar
 *   6.  Inline bracket chords         → chordpro
 *   7.  Chord-over-words heuristic    → chords-over-words
 *   8.  Extension fallback            → chordpro | unknown
 */

export type SourceFormat =
  | 'chordpro'
  | 'ultimateguitar'
  | 'chords-over-words'
  | 'abc'
  | 'guitarpro'
  | 'fakebook'
  | 'oemer-image';

export type DetectedFormat =
  | { format: 'mxl' }
  | { format: 'musicxml' }
  | { format: 'svg' }
  | { format: 'chordpro' }
  | { format: 'ultimateguitar' }
  | { format: 'chords-over-words' }
  | { format: 'abc' }
  | { format: 'guitarpro' }
  | { format: 'fakebook' }
  | { format: 'pdf' }
  | { format: 'unknown' };

// ZIP local-file magic: PK\x03\x04
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

// PDF magic: %PDF
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const;

// Guitar Pro binary magic: "FICHIER " (GP3 / GP4 / GP5 header prefix)
const GP_BINARY_MAGIC = [0x46, 0x49, 0x43, 0x48, 0x49, 0x45, 0x52, 0x20] as const;

// PowerTab magic: "PTAB"
const PTB_MAGIC = [0x50, 0x54, 0x41, 0x42] as const;

// File extensions that are always Guitar Pro / PowerTab (even if ZIP-based like .gpx / .gp)
const GP_EXTENSIONS = new Set(['gp', 'gp3', 'gp4', 'gp5', 'gpx', 'ptb']);

// Canonical chord token pattern (root + optional quality + optional bass)
const CHORD_TOKEN_RE =
  /^[A-G][#b]?(?:m(?:aj)?|M|maj|min|dim|aug|sus[24]?|add\d*)?(?:\d+)?(?:\/[A-G][#b]?)?$/;

// ChordPro metadata / structural directives
const CHORDPRO_DIRECTIVE_RE =
  /\{\s*(?:title|t|artist|a|subtitle|st|key|capo|tempo|time|start_of_chorus|soc|start_of_verse|sov|start_of_grid|sog|start_of_bridge|sob|comment|c)\s*[}:]/i;

// UG-style section header inside square brackets, e.g. [Verse 1], [Chorus]
const UG_SECTION_RE =
  /^\[(?:Verse|Chorus|Bridge|Intro|Outro|Pre-?Chorus|Interlude|Hook|Solo|Instrumental|Refrain)[^\]]*\]/im;

// Inline bracket chord, e.g. [Am7], [F#/A], [Bbmaj7]
const BRACKET_CHORD_RE = /\[[A-G][#b]?[^\]\n]{0,10}\]/;

// ABC notation: X: index field (always present and first) + typical header fields
const ABC_HEADER_RE = /^X\s*:\s*\d/m;

// Fake-book lead-sheet: repeat-bar barlines (|: or :|) or ·/· simile marker
const FAKEBOOK_RE = /(?:^\s*\|:[ \t]|[ \t]:\|\s*$|\u00B7\/\u00B7)/m;

function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3]
  );
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === PDF_MAGIC[0] &&
    bytes[1] === PDF_MAGIC[1] &&
    bytes[2] === PDF_MAGIC[2] &&
    bytes[3] === PDF_MAGIC[3]
  );
}

function hasGpBinaryMagic(bytes: Uint8Array): boolean {
  if (bytes.length < GP_BINARY_MAGIC.length) return false;
  return GP_BINARY_MAGIC.every((b, i) => bytes[i] === b);
}

function hasPtbMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === PTB_MAGIC[0] &&
    bytes[1] === PTB_MAGIC[1] &&
    bytes[2] === PTB_MAGIC[2] &&
    bytes[3] === PTB_MAGIC[3]
  );
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** Returns true if every non-empty whitespace-delimited token looks like a chord. */
function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const matches = tokens.filter((t) => CHORD_TOKEN_RE.test(t)).length;
  // Require ≥2 chord tokens and ≥70% of tokens to be chords
  return matches >= 2 && matches / tokens.length >= 0.7;
}

/**
 * Sniff the format of a file from its raw bytes and optional filename.
 *
 * @param bytes  Raw bytes of the file (pass the full ArrayBuffer slice or at
 *               least the first 4 KB for best accuracy).
 * @param filename  Original filename, used for extension fallback.
 */
export function sniffFormatFromBytes(bytes: Uint8Array, filename = ''): DetectedFormat {
  const ext = fileExtension(filename);

  // 1a. PDF magic bytes or .pdf extension → PDF
  if (hasPdfMagic(bytes) || ext === 'pdf') {
    return { format: 'pdf' };
  }

  // 1b. Guitar Pro / PowerTab — checked BEFORE the generic ZIP branch so that
  //     ZIP-based formats (.gpx, .gp) are not mis-classified as MXL.
  if (GP_EXTENSIONS.has(ext) || hasGpBinaryMagic(bytes) || hasPtbMagic(bytes)) {
    return { format: 'guitarpro' };
  }

  // 1c. ZIP magic → MXL
  if (hasZipMagic(bytes)) {
    return { format: 'mxl' };
  }

  // Decode up to 2 KB for text-based heuristics
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2048));

  // 2a. SVG detection — must precede MusicXML check because SVG is also XML.
  //     Match on .svg extension OR the presence of an <svg element combined
  //     with the W3C SVG namespace (single- or double-quoted), or a bare
  //     <svg> opening tag when the extension is already .svg.
  if (ext === 'svg') {
    return { format: 'svg' };
  }
  if (
    head.includes('<svg') &&
    (head.includes('xmlns="http://www.w3.org/2000/svg"') ||
      head.includes("xmlns='http://www.w3.org/2000/svg'") ||
      // Namespace may appear on a child element — bare <svg is sufficient when
      // combined with an SVG-characteristic attribute
      head.includes('viewBox=') ||
      head.includes('xmlns:svg='))
  ) {
    return { format: 'svg' };
  }

  // 2b. MusicXML detection
  if (head.includes('<score-partwise') || head.includes('<score-timewise')) {
    return { format: 'musicxml' };
  }
  if ((ext === 'xml' || ext === 'musicxml') && head.trimStart().startsWith('<?xml')) {
    return { format: 'musicxml' };
  }

  // 3. ABC notation — X: index field is a reliable unique signature
  if (ABC_HEADER_RE.test(head) || ext === 'abc') {
    return { format: 'abc' };
  }

  // 3b. Fake-book lead-sheet — |: repeat-bar barlines or ·/· simile marker
  if (FAKEBOOK_RE.test(head)) {
    return { format: 'fakebook' };
  }

  // 4. ChordPro directives
  if (CHORDPRO_DIRECTIVE_RE.test(head)) {
    return { format: 'chordpro' };
  }

  // 5. UG-style section headers
  if (UG_SECTION_RE.test(head)) {
    return { format: 'ultimateguitar' };
  }

  // 6. Inline bracket chords (without UG sections → treat as ChordPro)
  if (BRACKET_CHORD_RE.test(head)) {
    return { format: 'chordpro' };
  }

  // 7. Chord-over-words heuristic: count chord-only lines vs text lines
  const lines = head.split('\n');
  let chordLines = 0;
  let textLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (isChordLine(line)) {
      chordLines++;
    } else {
      textLines++;
    }
  }
  if (chordLines >= 2 && chordLines >= textLines * 0.25) {
    return { format: 'chords-over-words' };
  }

  // 8. Extension fallback for known chord-chart extensions
  if (['cho', 'chopro', 'chord', 'crd', 'pro'].includes(ext)) {
    return { format: 'chordpro' };
  }

  return { format: 'unknown' };
}

/**
 * Sniff the format of a plain text string (no binary / file-extension
 * information available).  Useful when the raw bytes aren't accessible
 * (e.g. text pasted directly into an editor).
 *
 * Detection order mirrors `sniffFormatFromBytes` but skips the ZIP/MXL and
 * file-extension branches since neither applies to bare text.
 */
export function sniffFormatFromText(text: string): DetectedFormat {
  const head = text.slice(0, 2048);

  // SVG — check before MusicXML for the same reason as in sniffFormatFromBytes
  if (
    head.includes('<svg') &&
    (head.includes('xmlns="http://www.w3.org/2000/svg"') ||
      head.includes("xmlns='http://www.w3.org/2000/svg'") ||
      head.includes('viewBox=') ||
      head.includes('xmlns:svg='))
  ) {
    return { format: 'svg' };
  }

  // MusicXML embedded in text
  if (head.includes('<score-partwise') || head.includes('<score-timewise')) {
    return { format: 'musicxml' };
  }

  // ABC notation
  if (ABC_HEADER_RE.test(head)) {
    return { format: 'abc' };
  }

  // Fake-book lead-sheet — |: repeat-bar barlines or ·/· simile marker
  if (FAKEBOOK_RE.test(head)) {
    return { format: 'fakebook' };
  }

  // ChordPro directives
  if (CHORDPRO_DIRECTIVE_RE.test(head)) {
    return { format: 'chordpro' };
  }

  // UG-style section headers
  if (UG_SECTION_RE.test(head)) {
    return { format: 'ultimateguitar' };
  }

  // Inline bracket chords
  if (BRACKET_CHORD_RE.test(head)) {
    return { format: 'chordpro' };
  }

  // Chord-over-words heuristic
  const lines = head.split('\n');
  let chordLines = 0;
  let textLines = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (isChordLine(line)) {
      chordLines++;
    } else {
      textLines++;
    }
  }
  if (chordLines >= 2 && chordLines >= textLines * 0.25) {
    return { format: 'chords-over-words' };
  }

  return { format: 'unknown' };
}

export function isMusicXmlFormat(detected: DetectedFormat): boolean {
  return detected.format === 'musicxml' || detected.format === 'mxl';
}

export function isSvgFormat(detected: DetectedFormat): boolean {
  return detected.format === 'svg';
}

export function isPdfFormat(detected: DetectedFormat): boolean {
  return detected.format === 'pdf';
}

export function isGuitarProFormat(detected: DetectedFormat): boolean {
  return detected.format === 'guitarpro';
}

export function isChordChartFormat(detected: DetectedFormat): boolean {
  return (
    detected.format === 'chordpro' ||
    detected.format === 'ultimateguitar' ||
    detected.format === 'chords-over-words' ||
    detected.format === 'abc' ||
    detected.format === 'fakebook'
  );
  // Note: 'guitarpro' is handled separately via isGuitarProFormat — it has its
  // own async parse path rather than going through parseChordChart().
}

export function asSourceFormat(detected: DetectedFormat): SourceFormat | null {
  if (
    detected.format === 'chordpro' ||
    detected.format === 'ultimateguitar' ||
    detected.format === 'chords-over-words' ||
    detected.format === 'abc' ||
    detected.format === 'fakebook'
  ) {
    return detected.format;
  }
  return null;
}

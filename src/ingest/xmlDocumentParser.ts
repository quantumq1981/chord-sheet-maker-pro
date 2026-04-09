/**
 * xmlDocumentParser.ts
 *
 * Unified XML document parser for ChordSheet Maker Pro (CSMPN V1.10.0).
 *
 * Accepts exactly two XML-based formats:
 *   • SVG   — root element <svg> with xmlns="http://www.w3.org/2000/svg"
 *   • MusicXML — root element <score-partwise> (DTD or namespace optional)
 *
 * Both formats are parsed into a single UnifiedDocument model that downstream
 * components (renderer, storage, further processing) can consume without
 * knowing which format was originally uploaded.
 *
 * ─── Architecture ───────────────────────────────────────────────────────────
 *
 *   parseXmlDocument(text, filename?)
 *       │
 *       ├─ detectXmlFormat()          ← format detection (root element + ns)
 *       │
 *       ├─ parseSvgDocument()         ← delegates to svgImporter.importSvg()
 *       │                               maps SvgImportResult → UnifiedDocument
 *       │
 *       └─ parseMusicXmlDocument()    ← structured <score-partwise> walker:
 *                                       metadata, parts, measures,
 *                                       harmonies (structured objects),
 *                                       lyrics (per measure)
 *
 * ─── Model summary ──────────────────────────────────────────────────────────
 *
 *   UnifiedDocument {
 *     type:      'svg' | 'musicxml'
 *     metadata:  { title, creator, description, key, time }
 *     svgData?:  SvgImportResult  (viewBox, elements[], extractedText, stats)
 *     musicData?: {
 *       parts: [{
 *         id, name,
 *         measures: [{ number, harmonies: [{root,kind,bass,formatted}], lyrics }]
 *       }]
 *       allHarmonies: HarmonySymbol[]   ← flat, document order
 *       allLyrics:    string[]          ← flat, document order
 *     }
 *   }
 */

import { importSvg, SVG_NAMESPACE, type SvgImportResult } from './svgImporter';

// ─── Public model types ───────────────────────────────────────────────────────

/**
 * Metadata common to both SVG and MusicXML documents.
 * Fields are sourced from format-specific locations but normalised here.
 */
export interface DocumentMetadata {
  /** SVG <title> or MusicXML <work-title> / <movement-title>. */
  title?: string;
  /**
   * Author / composer.
   * SVG: <desc> text heuristic (first "by …" line) or absent.
   * MusicXML: <creator type="composer">.
   */
  creator?: string;
  /** SVG <desc> element text. MusicXML: not mapped. */
  description?: string;
  /** MusicXML key signature, e.g. "Bb" or "Gm". SVG: absent. */
  key?: string;
  /** MusicXML time signature, e.g. "4/4". SVG: absent. */
  time?: string;
}

/**
 * A single chord symbol extracted from a <harmony> element.
 * All fields come from getAttribute / textContent on the harmony sub-tree.
 */
export interface HarmonySymbol {
  /** Root pitch class, e.g. "G", "Bb", "F#". */
  root: string;
  /**
   * Normalised chord quality suffix, e.g. "" (major), "m", "7", "maj7",
   * "m7", "dim", "aug", "m7b5".
   */
  kind: string;
  /** Bass note after a slash, e.g. "B" for G/B. Absent when not present. */
  bass?: string;
  /** Pre-formatted chord symbol string ready for display, e.g. "Gm7/B". */
  formatted: string;
}

/** One measure within a part. */
export interface MeasureData {
  /** Measure number from the `number` attribute (1-based when absent). */
  number: number;
  /** Chord symbols found in this measure, in document order. */
  harmonies: HarmonySymbol[];
  /** Lyric syllables / words found in <lyric> elements in this measure. */
  lyrics: string[];
}

/** One instrument part. */
export interface PartData {
  /** Part id attribute, e.g. "P1". */
  id: string;
  /** Human-readable part name from <part-name>, e.g. "Piano". */
  name?: string;
  measures: MeasureData[];
}

/** Structured MusicXML content. */
export interface MusicXmlDocumentData {
  parts: PartData[];
  /**
   * Flat list of every harmony symbol across all parts and measures,
   * in document order.  Convenience accessor — same objects as in parts[].
   */
  allHarmonies: HarmonySymbol[];
  /**
   * Flat list of every lyric string across all parts and measures,
   * in document order.
   */
  allLyrics: string[];
}

/**
 * The unified internal document model.
 *
 * Exactly one of svgData / musicData is populated, matching `type`.
 */
export interface UnifiedDocument {
  /** Discriminator — which format produced this document. */
  type: 'svg' | 'musicxml';
  /** Normalised metadata from whichever format was parsed. */
  metadata: DocumentMetadata;
  /**
   * Populated when type === 'svg'.
   * Contains viewBox, full element tree, stats, and extracted text.
   */
  svgData?: SvgImportResult;
  /**
   * Populated when type === 'musicxml'.
   * Contains parts, measures, harmonies, and lyrics.
   */
  musicData?: MusicXmlDocumentData;
}

// ─── Format detection ─────────────────────────────────────────────────────────

type XmlFormat = 'svg' | 'musicxml' | 'unknown';

/**
 * Detect the XML format from the first 2 KB of source text.
 *
 * Strategy (order matters — both are XML so we check content first):
 *   1. MusicXML: root element <score-partwise> or <score-timewise>.
 *   2. SVG: root element <svg> with W3C SVG namespace.
 *   3. SVG: .svg file extension hint (filename parameter).
 *   4. SVG: bare <svg> tag (namespace-less / inline fragments).
 *   5. Unknown: everything else.
 *
 * This is intentionally separate from sniffFormat.ts so that
 * xmlDocumentParser can be used stand-alone (e.g. in tests or server-side).
 */
function detectXmlFormat(source: string, filename = ''): XmlFormat {
  const head = source.slice(0, 2048);
  const ext = filename.includes('.')
    ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
    : '';

  // MusicXML check first — <score-partwise> is highly specific
  if (head.includes('<score-partwise') || head.includes('<score-timewise')) {
    return 'musicxml';
  }

  // SVG — namespace-aware detection
  if (
    ext === 'svg' ||
    (head.includes('<svg') &&
      (head.includes(`xmlns="${SVG_NAMESPACE}"`) ||
        head.includes(`xmlns='${SVG_NAMESPACE}'`) ||
        head.includes('viewBox=') ||
        head.includes('xmlns:svg='))) ||
    // Bare <svg> tag (inline / namespace-stripped fragments)
    /^(<\?xml[^>]*\?>\s*)?<svg[\s>/]/i.test(head.trimStart())
  ) {
    return 'svg';
  }

  return 'unknown';
}

// ─── MusicXML helpers ─────────────────────────────────────────────────────────

/**
 * Normalise a MusicXML <kind> text value to a display chord-quality suffix.
 * Mirrors the logic in musicXmlToCsmpnFakebook.ts — kept here so this module
 * is self-contained.
 */
function normalizeKind(kind: string): string {
  const v = kind.toLowerCase().trim();
  if (!v || v === 'major') return '';
  if (v === 'minor') return 'm';
  if (v === 'dominant') return '7';
  if (v === 'major-seventh') return 'maj7';
  if (v === 'minor-seventh') return 'm7';
  if (v === 'dominant-ninth') return '9';
  if (v === 'major-ninth') return 'maj9';
  if (v === 'minor-ninth') return 'm9';
  if (v === 'dominant-11th') return '11';
  if (v === 'dominant-13th') return '13';
  if (v === 'half-diminished') return 'm7b5';
  if (v === 'diminished') return 'dim';
  if (v === 'diminished-seventh') return 'dim7';
  if (v === 'augmented') return 'aug';
  if (v === 'augmented-seventh') return 'aug7';
  if (v === 'suspended-second') return 'sus2';
  if (v === 'suspended-fourth') return 'sus4';
  if (v === 'major-minor') return 'mMaj7';
  if (v === 'pedal') return 'ped';
  if (v === 'power') return '5';
  // Unknown quality — return the raw value so nothing is silently lost
  return kind;
}

/** Resolve an alter value string ("-1" / "0" / "1") to a symbol. */
function alterSymbol(alterText: string | null): string {
  if (alterText === '1' || alterText === '1.0') return '#';
  if (alterText === '-1' || alterText === '-1.0') return 'b';
  return '';
}

/**
 * Parse one <harmony> element into a HarmonySymbol.
 * Returns null when the element has no root-step (malformed / comment harmony).
 */
function parseHarmonyElement(el: Element): HarmonySymbol | null {
  const rootStep = el.querySelector('root > root-step')?.textContent?.trim() ?? '';
  if (!rootStep) return null;

  const rootAlter = el.querySelector('root > root-alter')?.textContent?.trim() ?? null;
  const root = rootStep + alterSymbol(rootAlter);

  const kindRaw = el.querySelector('kind')?.textContent?.trim() ?? '';
  const kind = normalizeKind(kindRaw);

  // Degree modifications — add / alter / subtract
  const degreeStr = Array.from(el.querySelectorAll('degree'))
    .map((d) => {
      const val = d.querySelector('degree-value')?.textContent?.trim() ?? '';
      const type = d.querySelector('degree-type')?.textContent?.trim() ?? '';
      if (!val || !type) return '';
      if (type === 'add') return `add${val}`;
      if (type === 'alter') return `#${val}`;
      if (type === 'subtract') return `no${val}`;
      return '';
    })
    .filter(Boolean)
    .join('');

  // Bass note
  const bassStep = el.querySelector('bass > bass-step')?.textContent?.trim() ?? '';
  const bassAlter = el.querySelector('bass > bass-alter')?.textContent?.trim() ?? null;
  const bass = bassStep ? bassStep + alterSymbol(bassAlter) : undefined;

  const formatted = `${root}${kind}${degreeStr}${bass ? `/${bass}` : ''}`;

  return { root, kind: `${kind}${degreeStr}`, bass, formatted };
}

/** Extract all lyric strings from a <measure> element, in document order. */
function extractLyrics(measure: Element): string[] {
  const lyrics: string[] = [];
  for (const lyric of measure.querySelectorAll('note > lyric')) {
    // MusicXML lyric structure: <syllabic> + <text> [+ <elision> + <text>]*
    // We join all <text> children within the lyric element.
    const texts = Array.from(lyric.querySelectorAll('text'))
      .map((t) => t.textContent?.trim() ?? '')
      .filter(Boolean);
    if (texts.length > 0) lyrics.push(texts.join(''));
  }
  return lyrics;
}

/** Convert circle-of-fifths integer + mode to a key string, e.g. "Bb" or "Gm". */
function keyFromFifths(fifths: number, mode?: string): string {
  const major = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const minor = [
    'Abm',
    'Ebm',
    'Bbm',
    'Fm',
    'Cm',
    'Gm',
    'Dm',
    'Am',
    'Em',
    'Bm',
    'F#m',
    'C#m',
    'G#m',
    'D#m',
    'A#m',
  ];
  const idx = Math.max(0, Math.min(14, fifths + 7));
  return (mode ?? '').toLowerCase() === 'minor' ? minor[idx] : major[idx];
}

// ─── Format-specific parsers ──────────────────────────────────────────────────

/** Parse an SVG source string into a UnifiedDocument. */
function parseSvgDocument(source: string): UnifiedDocument {
  const svgData = importSvg(source); // throws on unrecoverable parse failure

  // Pull metadata from svgData fields (already extracted by svgImporter)
  const metadata: DocumentMetadata = {
    title: svgData.title,
    description: svgData.description,
    // SVG has no formal creator field — check description for "by …" pattern
    creator: svgData.description
      ? (/^by\s+(.+)/i.exec(svgData.description.split('\n')[0]) ?? [])[1]?.trim()
      : undefined,
  };

  return { type: 'svg', metadata, svgData };
}

/**
 * Parse a MusicXML <score-partwise> source string into a UnifiedDocument.
 * Also accepts <score-timewise> but flattens it to the same part/measure model.
 */
function parseMusicXmlDocument(source: string): UnifiedDocument {
  const domParser = new DOMParser();
  const doc = domParser.parseFromString(source, 'application/xml');

  // Surface any parse error immediately with a clear message
  const parseErr =
    doc.querySelector('parsererror') ?? doc.getElementsByTagName('parsererror').item(0);
  if (parseErr) {
    const msg = parseErr.textContent?.trim().slice(0, 300) ?? 'XML parse error';
    throw new Error(`MusicXML parse failed: ${msg}`);
  }

  const score = doc.querySelector('score-partwise, score-timewise');
  if (!score) {
    throw new Error(
      'Document is not a MusicXML score. ' +
        'Expected root element <score-partwise> or <score-timewise>.'
    );
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  const title =
    score.querySelector('work > work-title')?.textContent?.trim() ||
    score.querySelector('movement-title')?.textContent?.trim() ||
    undefined;

  const creator =
    Array.from(score.querySelectorAll('identification > creator'))
      .find((el) => (el.getAttribute('type') ?? '').toLowerCase() === 'composer')
      ?.textContent?.trim() ||
    // Fallback: first creator regardless of type
    score.querySelector('identification > creator')?.textContent?.trim() ||
    undefined;

  // Key and time are tracked as running state while walking measures
  let keyFifths: number | undefined;
  let keyMode: string | undefined;
  let timeBeats: string | undefined;
  let timeBeatType: string | undefined;

  // ── Part list — name lookup ───────────────────────────────────────────────

  const partNames: Record<string, string> = {};
  for (const scorePart of score.querySelectorAll('part-list > score-part')) {
    const id = scorePart.getAttribute('id') ?? '';
    const name = scorePart.querySelector('part-name')?.textContent?.trim() ?? '';
    if (id) partNames[id] = name;
  }

  // ── Parts & measures ──────────────────────────────────────────────────────

  const allHarmonies: HarmonySymbol[] = [];
  const allLyrics: string[] = [];
  const parts: PartData[] = [];

  for (const partEl of score.querySelectorAll('part')) {
    const partId = partEl.getAttribute('id') ?? `P${parts.length + 1}`;
    const partName = partNames[partId] || undefined;
    const measures: MeasureData[] = [];

    let measureIndex = 0;
    for (const measureEl of partEl.querySelectorAll('measure')) {
      measureIndex++;
      const numAttr = measureEl.getAttribute('number');
      const number = numAttr !== null ? parseInt(numAttr, 10) || measureIndex : measureIndex;

      // Update running key / time signature from <attributes>
      const attrsEl = measureEl.querySelector('attributes');
      if (attrsEl) {
        const fifthsText = attrsEl.querySelector('key > fifths')?.textContent?.trim();
        const parsedFifths = parseInt(fifthsText ?? '', 10);
        if (!isNaN(parsedFifths)) keyFifths = parsedFifths;

        const modeText = attrsEl.querySelector('key > mode')?.textContent?.trim();
        if (modeText) keyMode = modeText;

        const beatsText = attrsEl.querySelector('time > beats')?.textContent?.trim();
        if (beatsText) timeBeats = beatsText;

        const beatTypeText = attrsEl.querySelector('time > beat-type')?.textContent?.trim();
        if (beatTypeText) timeBeatType = beatTypeText;
      }

      // Harmonies — structured objects via getAttribute-based extractor
      const harmonies: HarmonySymbol[] = [];
      for (const harmEl of measureEl.querySelectorAll('harmony')) {
        const sym = parseHarmonyElement(harmEl);
        if (sym) {
          harmonies.push(sym);
          allHarmonies.push(sym);
        }
      }

      // Lyrics
      const lyrics = extractLyrics(measureEl);
      allLyrics.push(...lyrics);

      measures.push({ number, harmonies, lyrics });
    }

    parts.push({ id: partId, name: partName, measures });
  }

  const metadata: DocumentMetadata = {
    title,
    creator,
    key: typeof keyFifths === 'number' ? keyFromFifths(keyFifths, keyMode) : undefined,
    time: timeBeats && timeBeatType ? `${timeBeats}/${timeBeatType}` : undefined,
  };

  return {
    type: 'musicxml',
    metadata,
    musicData: { parts, allHarmonies, allLyrics },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an XML document (SVG or MusicXML) from its raw UTF-8 text source and
 * return a unified {@link UnifiedDocument} model.
 *
 * Format detection is automatic:
 *   • Root element `<score-partwise>` or `<score-timewise>` → MusicXML
 *   • Root element `<svg>` with W3C SVG namespace  → SVG
 *   • Neither → throws with a clear, actionable error message
 *
 * @param source    Full file contents as a UTF-8 decoded string.
 * @param filename  Original filename, used as a hint for `.svg` extension
 *                  detection (optional but recommended).
 * @returns         Populated {@link UnifiedDocument}.
 * @throws {Error}  When the format cannot be determined, or when parsing
 *                  fails unrecoverably.  The message is always human-readable.
 */
export function parseXmlDocument(source: string, filename = ''): UnifiedDocument {
  if (!source.trim()) {
    throw new Error('Document source is empty.');
  }

  const format = detectXmlFormat(source, filename);

  switch (format) {
    case 'svg':
      return parseSvgDocument(source);

    case 'musicxml':
      return parseMusicXmlDocument(source);

    case 'unknown':
    default:
      throw new Error(
        'Unsupported XML format. ' +
          'Expected an SVG document (root <svg> with xmlns="http://www.w3.org/2000/svg") ' +
          'or a MusicXML score (root <score-partwise>). ' +
          `The supplied ${filename ? `file "${filename}"` : 'document'} matches neither.`
      );
  }
}

/**
 * Convenience type-guard: narrow a UnifiedDocument to the SVG variant.
 *
 * @example
 * const doc = parseXmlDocument(text);
 * if (isSvgDocument(doc)) {
 *   console.log(doc.svgData.viewBox);
 * }
 */
export function isSvgDocument(
  doc: UnifiedDocument
): doc is UnifiedDocument & { svgData: SvgImportResult } {
  return doc.type === 'svg' && doc.svgData !== undefined;
}

/**
 * Convenience type-guard: narrow a UnifiedDocument to the MusicXML variant.
 *
 * @example
 * const doc = parseXmlDocument(text);
 * if (isMusicXmlDocument(doc)) {
 *   console.log(doc.musicData.allHarmonies.map(h => h.formatted));
 * }
 */
export function isMusicXmlDocument(
  doc: UnifiedDocument
): doc is UnifiedDocument & { musicData: MusicXmlDocumentData } {
  return doc.type === 'musicxml' && doc.musicData !== undefined;
}

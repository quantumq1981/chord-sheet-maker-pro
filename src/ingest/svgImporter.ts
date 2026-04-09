/**
 * svgImporter.ts
 *
 * Standard SVG importer for ChordSheet Maker Pro (CSMPN V1.10.0 Fake Book Edition).
 *
 * Replaces the former OpenSong XML / OpenLyrics XML parsers with a namespace-
 * aware, attribute-centric SVG document parser conforming to W3C SVG 1.1/2.0.
 *
 * ─── Architectural brief ────────────────────────────────────────────────────
 *
 *  Part 1 — Namespace & Prolog Handling
 *    • Accepts <svg> as the valid root element.
 *    • Does NOT reject documents whose root is <svg> rather than <song>.
 *    • Explicitly supports xmlns="http://www.w3.org/2000/svg".
 *    • Falls back from strict image/svg+xml to lenient text/xml parsing
 *      when the strict parse fails, so malformed namespace declarations
 *      never cause a hard abort.
 *
 *  Part 2 — Parsing Logic: From Inner Text to Attributes
 *    • ALL geometry is extracted via getAttribute(), never via nodeValue /
 *      textContent (except for <text>/<tspan> where text IS the data).
 *    • Handles <rect>, <circle>, <ellipse>, <path>, <line>, <polygon>,
 *      <polyline>, <use>, <image> and captures: x, y, width, height, cx, cy,
 *      r, rx, ry, d (path data), points, x1/y1/x2/y2, fill, stroke.
 *    • Does NOT look for <verse>, <body>, <song>, or <set> tags.
 *
 *  Part 3 — Structural Hierarchy & Geometry
 *    • Reads the viewBox attribute to establish the coordinate system.
 *    • Recursively walks <g> groups and any container element, capturing
 *      transform attributes at every level for spatial hierarchy.
 *    • Gracefully ignores / skips leftover OpenSong or OpenLyrics XML tags
 *      without throwing "unexpected tag" errors.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg' as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Parsed representation of the SVG viewBox coordinate system. */
export interface SvgViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Attribute-centric record for a single SVG element node.
 *
 * All geometry comes from getAttribute() calls, never from inner text.
 * Unknown / legacy tags are stored with their original tag name so nothing
 * is silently discarded.
 */
export interface SvgElementRecord {
  /**
   * Local element name, lowercased.
   * e.g. 'rect', 'circle', 'path', 'g', 'text', 'verse' (unknown — kept).
   */
  tag: string;

  // ── Identity ──────────────────────────────────────────────────────────────
  id?: string;
  className?: string;

  // ── Geometry — extracted via getAttribute(), not nodeValue ────────────────

  /** <rect>, <svg>, <image>, <use>, <foreignObject> origin X. */
  x?: number;
  /** <rect>, <svg>, <image>, <use>, <foreignObject> origin Y. */
  y?: number;
  /** <rect>, <svg>, <image> width. */
  width?: number;
  /** <rect>, <svg>, <image> height. */
  height?: number;

  /** <circle> / <ellipse> centre X. */
  cx?: number;
  /** <circle> / <ellipse> centre Y. */
  cy?: number;
  /** <circle> radius. */
  r?: number;
  /** <ellipse> x-axis radius. */
  rx?: number;
  /** <ellipse> y-axis radius. */
  ry?: number;

  /**
   * <path> `d` attribute — the path data string.
   * Captured verbatim; consumers may parse further with a path-data library.
   */
  d?: string;

  /** <polygon> / <polyline> `points` attribute. */
  points?: string;

  /** <line> start X. */
  x1?: number;
  /** <line> start Y. */
  y1?: number;
  /** <line> end X. */
  x2?: number;
  /** <line> end Y. */
  y2?: number;

  // ── Styling — parsed from presentation attributes ─────────────────────────
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  opacity?: string;
  /** Raw inline `style` attribute value. */
  style?: string;

  // ── Spatial transform ─────────────────────────────────────────────────────
  /**
   * Raw `transform` attribute string (e.g. "translate(10,20) rotate(45)").
   * Preserved verbatim so renderers can apply or inspect it downstream.
   */
  transform?: string;

  // ── Text content — only for <text>, <tspan>, <textPath> ──────────────────
  /**
   * Concatenated text content of text-rendering elements.
   * Only populated when `tag` is 'text', 'tspan', or 'textpath'.
   */
  textContent?: string;

  // ── Structural ────────────────────────────────────────────────────────────
  /**
   * Parsed child element records.
   * Populated for all element types so that unexpected wrapper tags (incl.
   * legacy OpenSong / OpenLyrics elements) don't swallow their subtrees.
   */
  children: SvgElementRecord[];

  /** Attributes not in the explicitly-mapped set above. */
  otherAttributes: Record<string, string>;
}

/** Flat per-type element counts accumulated over the full document. */
export interface SvgElementStats {
  totalElements: number;
  paths: number;
  rects: number;
  circles: number;
  ellipses: number;
  lines: number;
  polygons: number;
  polylines: number;
  groups: number;
  texts: number;
  images: number;
  uses: number;
  defs: number;
  /** Elements whose tag is not a recognised SVG primitive. */
  other: number;
}

/** Full import result returned by {@link importSvg}. */
export interface SvgImportResult {
  /** Original SVG source text, preserved verbatim for re-export and preview. */
  svgSource: string;

  /**
   * Parsed viewBox — the canonical coordinate system of this SVG.
   * Undefined when the root <svg> has no viewBox attribute.
   */
  viewBox?: SvgViewBox;

  /**
   * Raw `width` / `height` attribute values from the root <svg> element.
   * May contain units (e.g. "800px", "21cm") or bare numbers.
   * Falls back to viewBox dimensions when the attributes are absent.
   */
  width?: string;
  height?: string;

  /**
   * Resolved XML namespace.
   * Normally "http://www.w3.org/2000/svg".
   */
  xmlns: string;

  /** Content of the top-level <title> element, if present. */
  title?: string;

  /** Content of the top-level <desc> element, if present. */
  description?: string;

  /** Flat element-type counts across the whole document. */
  stats: SvgElementStats;

  /** Top-level parsed child elements of the <svg> root. */
  elements: SvgElementRecord[];

  /**
   * All text strings found inside <text> / <tspan> / <textPath> nodes,
   * in document order, with leading/trailing whitespace stripped.
   */
  extractedText: string[];

  /** Non-fatal warnings collected during parsing. */
  warnings: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse the `viewBox` attribute string ("minX minY width height").
 * The SVG spec allows commas and/or whitespace as delimiters.
 */
function parseViewBox(raw: string): SvgViewBox | undefined {
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return undefined;
}

/**
 * Read a numeric attribute value from an element.
 * Returns `undefined` when the attribute is absent or its value is not a
 * finite number (so callers never see NaN).
 */
function numAttr(el: Element, name: string): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null) return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read a string attribute value from an element.
 * Returns `undefined` (not null) when absent, for consistent optional handling.
 */
function strAttr(el: Element, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v !== null ? v : undefined;
}

/**
 * The set of attribute names that are explicitly mapped into SvgElementRecord
 * fields.  Any attribute outside this set goes into `otherAttributes`.
 */
const MAPPED_ATTRS = new Set([
  'id',
  'class',
  'x',
  'y',
  'width',
  'height',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'x1',
  'y1',
  'x2',
  'y2',
  'fill',
  'stroke',
  'stroke-width',
  'opacity',
  'style',
  'transform',
  // Root-level metadata attributes (excluded from "other")
  'xmlns',
  'viewBox',
  'version',
  'xmlns:xlink',
  'xml:space',
  'xml:lang',
]);

/** Collect all attributes NOT in MAPPED_ATTRS into a plain object. */
function extractOtherAttributes(el: Element): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    if (!MAPPED_ATTRS.has(attr.localName) && !MAPPED_ATTRS.has(attr.name)) {
      result[attr.name] = attr.value;
    }
  }
  return result;
}

/** SVG tags that render text — these get their textContent captured. */
const TEXT_TAGS = new Set(['text', 'tspan', 'textpath', 'altglyph', 'altglyphdef']);

/**
 * Recursively parse one DOM Element into an {@link SvgElementRecord}.
 *
 * Design contract:
 *   • All geometry is read via getAttribute() — never nodeValue.
 *   • Unknown / non-SVG tags (including legacy OpenSong / OpenLyrics elements)
 *     are tolerated: they produce a record with their original tag name and
 *     their children are still recursed into.
 *   • No exception is thrown for "unexpected" tags.
 */
function parseElement(
  el: Element,
  stats: SvgElementStats,
  extractedText: string[]
): SvgElementRecord {
  const tag = el.localName.toLowerCase();

  // ── Update element-type counters ──────────────────────────────────────────
  stats.totalElements++;
  switch (tag) {
    case 'path':
      stats.paths++;
      break;
    case 'rect':
      stats.rects++;
      break;
    case 'circle':
      stats.circles++;
      break;
    case 'ellipse':
      stats.ellipses++;
      break;
    case 'line':
      stats.lines++;
      break;
    case 'polygon':
      stats.polygons++;
      break;
    case 'polyline':
      stats.polylines++;
      break;
    case 'g':
      stats.groups++;
      break;
    case 'text':
    case 'tspan':
    case 'textpath':
      stats.texts++;
      break;
    case 'image':
      stats.images++;
      break;
    case 'use':
      stats.uses++;
      break;
    case 'defs':
      stats.defs++;
      break;
    default:
      stats.other++;
      break;
  }

  // ── Build attribute-centric record ────────────────────────────────────────
  const record: SvgElementRecord = {
    tag,

    id: strAttr(el, 'id'),
    className: strAttr(el, 'class'),

    // Geometry via getAttribute() — not nodeValue
    x: numAttr(el, 'x'),
    y: numAttr(el, 'y'),
    width: numAttr(el, 'width'),
    height: numAttr(el, 'height'),

    cx: numAttr(el, 'cx'),
    cy: numAttr(el, 'cy'),
    r: numAttr(el, 'r'),
    rx: numAttr(el, 'rx'),
    ry: numAttr(el, 'ry'),

    d: strAttr(el, 'd'), // path data — verbatim
    points: strAttr(el, 'points'),

    x1: numAttr(el, 'x1'),
    y1: numAttr(el, 'y1'),
    x2: numAttr(el, 'x2'),
    y2: numAttr(el, 'y2'),

    // Styling — from presentation attributes
    fill: strAttr(el, 'fill'),
    stroke: strAttr(el, 'stroke'),
    strokeWidth: strAttr(el, 'stroke-width'),
    opacity: strAttr(el, 'opacity'),
    style: strAttr(el, 'style'),

    // Spatial transform — preserved verbatim for recursive group handling
    transform: strAttr(el, 'transform'),

    children: [],
    otherAttributes: extractOtherAttributes(el),
  };

  // ── Text content (text-rendering elements only) ───────────────────────────
  if (TEXT_TAGS.has(tag)) {
    const text = el.textContent?.trim();
    if (text) {
      record.textContent = text;
      extractedText.push(text);
    }
  }

  // ── Recurse into ALL child elements ───────────────────────────────────────
  //
  // We recurse unconditionally — not only for known container tags — so that
  // unexpected wrapper elements (e.g. legacy <song>, <verse>, <set> from
  // OpenSong/OpenLyrics artefacts) do NOT silently swallow their sub-trees.
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE) {
      record.children.push(parseElement(child as Element, stats, extractedText));
    }
  }

  return record;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse an SVG document from its raw UTF-8 text source.
 *
 * Implements the three-part architectural mandate:
 *
 *   1. Namespace / prolog:  Uses `image/svg+xml` for namespace-aware parsing;
 *      falls back to `text/xml` on strict-parse failure so missing / wrong
 *      namespace declarations never cause a hard abort.  Accepts `<svg>` as
 *      the valid root — does NOT require `<song>` or `<set>`.
 *
 *   2. Attribute extraction:  All geometry is read via `getAttribute()`.
 *      The parser does not look for `<verse>` or `<body>` nodes.
 *
 *   3. Structural hierarchy:  Reads `viewBox` to establish coordinates.
 *      Recursively processes `<g>` groups and `transform` attributes.
 *
 * @param svgSource  Full SVG file text (UTF-8 decoded).
 * @returns          Fully populated {@link SvgImportResult}.
 * @throws {Error}   Only on completely empty input or an unrecoverable XML
 *                   parse failure.  All other issues are non-fatal warnings.
 */
export function importSvg(svgSource: string): SvgImportResult {
  if (!svgSource.trim()) {
    throw new Error('SVG source is empty.');
  }

  const warnings: string[] = [];

  // ── Stage 1: Parse XML ────────────────────────────────────────────────────
  //
  // Try strict image/svg+xml first (namespace-aware, validates SVG prolog).
  // On failure try lenient text/xml (tolerates missing / incorrect xmlns).
  // This two-pass strategy means we NEVER throw on "missing namespace".

  const parser = new DOMParser();

  const strictDoc = parser.parseFromString(svgSource, 'image/svg+xml');
  const strictErr =
    strictDoc.querySelector('parsererror') ?? strictDoc.getElementsByTagName('parsererror').item(0);

  let doc: Document;

  if (strictErr) {
    // Strict parse failed — try lenient fallback
    const lenientDoc = parser.parseFromString(svgSource, 'text/xml');
    const lenientErr =
      lenientDoc.querySelector('parsererror') ??
      lenientDoc.getElementsByTagName('parsererror').item(0);

    if (lenientErr) {
      const msg = lenientErr.textContent?.trim().slice(0, 300) ?? 'XML parse error';
      throw new Error(`SVG parse failed: ${msg}`);
    }

    warnings.push(
      'Strict SVG parsing (image/svg+xml) failed; fell back to text/xml mode. ' +
        'The document may have a non-standard namespace declaration.'
    );
    doc = lenientDoc;
  } else {
    doc = strictDoc;
  }

  // ── Stage 2: Locate <svg> root ────────────────────────────────────────────
  //
  // Accept <svg> directly.  When the root is something else (e.g. an XML
  // prolog wrapper, or a document that embeds SVG inside another element),
  // search for a nested <svg> before giving up.

  const docRoot = doc.documentElement;
  const docRootTag = docRoot.localName.toLowerCase();

  let svgRoot: Element;

  if (docRootTag === 'svg') {
    svgRoot = docRoot;
  } else {
    warnings.push(
      `Root element is <${docRootTag}>, expected <svg>. ` + 'Searching for a nested <svg> element.'
    );

    // Query with namespace first, then without (covers both strict & lenient parse results)
    const nested =
      doc.getElementsByTagNameNS(SVG_NAMESPACE, 'svg').item(0) ??
      docRoot.getElementsByTagName('svg').item(0);

    if (!nested) {
      throw new Error(
        `No <svg> element found in the document (root is <${docRootTag}>). ` +
          'Please upload a valid SVG file.'
      );
    }

    warnings.push('Using nested <svg> element as the document root.');
    svgRoot = nested;
  }

  // ── Stage 3: Extract document-level metadata ──────────────────────────────

  const xmlns = svgRoot.getAttribute('xmlns') ?? svgRoot.namespaceURI ?? SVG_NAMESPACE;

  if (xmlns !== SVG_NAMESPACE && !xmlns.toLowerCase().includes('svg')) {
    warnings.push(
      `SVG root xmlns is "${xmlns}"; expected "${SVG_NAMESPACE}". ` +
        'Namespace-qualified queries may not resolve correctly.'
    );
  }

  // viewBox — establishes the coordinate system
  const viewBoxRaw = svgRoot.getAttribute('viewBox');
  const viewBox = viewBoxRaw ? parseViewBox(viewBoxRaw) : undefined;
  if (viewBoxRaw && !viewBox) {
    warnings.push(`Could not parse viewBox value: "${viewBoxRaw}"`);
  }

  // Dimensions — prefer explicit attributes; fall back to viewBox values
  const widthAttr = strAttr(svgRoot, 'width');
  const heightAttr = strAttr(svgRoot, 'height');
  const width = widthAttr ?? (viewBox ? String(viewBox.width) : undefined);
  const height = heightAttr ?? (viewBox ? String(viewBox.height) : undefined);

  // Optional document-level title / description (namespace-aware queries)
  const titleEl =
    svgRoot.getElementsByTagNameNS(SVG_NAMESPACE, 'title').item(0) ??
    svgRoot.getElementsByTagName('title').item(0);
  const descEl =
    svgRoot.getElementsByTagNameNS(SVG_NAMESPACE, 'desc').item(0) ??
    svgRoot.getElementsByTagName('desc').item(0);

  const title = titleEl?.textContent?.trim() || undefined;
  const description = descEl?.textContent?.trim() || undefined;

  // ── Stage 4: Walk the element tree ────────────────────────────────────────

  const stats: SvgElementStats = {
    totalElements: 0,
    paths: 0,
    rects: 0,
    circles: 0,
    ellipses: 0,
    lines: 0,
    polygons: 0,
    polylines: 0,
    groups: 0,
    texts: 0,
    images: 0,
    uses: 0,
    defs: 0,
    other: 0,
  };
  const extractedText: string[] = [];
  const elements: SvgElementRecord[] = [];

  for (let i = 0; i < svgRoot.childNodes.length; i++) {
    const child = svgRoot.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE) {
      elements.push(parseElement(child as Element, stats, extractedText));
    }
  }

  return {
    svgSource,
    viewBox,
    width,
    height,
    xmlns,
    title,
    description,
    stats,
    elements,
    extractedText,
    warnings,
  };
}

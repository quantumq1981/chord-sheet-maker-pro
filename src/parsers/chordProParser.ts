/**
 * chordProParser.ts
 *
 * Pure-TypeScript, zero-dependency parser for three text-chord dialects:
 *
 *   1. ChordPro  — `{directives}` + `[chord]` tokens inline with lyrics
 *   2. Ultimate Guitar (UG) — `[Section]` headers + `[chord]` tokens
 *   3. Chords-over-words — chord lines stacked above lyric lines
 *
 * All three produce a normalized `ChordChartDocument` (see ChordChartModel.ts).
 * No external parser library is required, keeping the bundle size and license
 * surface minimal.
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
  BarlineToken,
  SectionType,
} from '../models/ChordChartModel';
import type { SourceFormat } from '../ingest/sniffFormat';
import { parseAbcNotation } from './abcParser';
import { sectionTypeFromLabel, normalizeLineEndings } from '../utils/sectionUtils';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maps lower-cased directive names to ChordChartDocument metadata keys. */
const DIRECTIVE_META: Record<
  string,
  keyof Pick<ChordChartDocument, 'title' | 'artist' | 'subtitle' | 'key' | 'capo' | 'tempo' | 'time' | 'genre'>
> = {
  // Title
  title: 'title',  t: 'title',
  // Artist / composer — MusicXML converters often emit {composer:} or {author:}
  artist: 'artist', a: 'artist',
  composer: 'artist', author: 'artist',
  // Other metadata
  subtitle: 'subtitle', st: 'subtitle',
  key: 'key',
  capo: 'capo',
  // Tempo — accept both {tempo:} and {bpm:}
  tempo: 'tempo', bpm: 'tempo',
  // Time — accept both {time:} and {meter:}
  time: 'time', meter: 'time',
  // Genre / style
  genre: 'genre', style: 'genre',
};

/** Maps lower-cased section-start directive names to SectionType. */
const SECTION_START: Record<string, SectionType> = {
  start_of_chorus: 'chorus',   soc: 'chorus',
  start_of_verse: 'verse',     sov: 'verse',
  start_of_bridge: 'bridge',   sob: 'bridge',
  start_of_grid: 'grid',       sog: 'grid',
  start_of_tab: 'tab',         sot: 'tab',
  start_of_pre_chorus: 'pre-chorus',
  start_of_intro: 'intro',
  start_of_outro: 'outro',
  start_of_interlude: 'interlude',
  start_of_solo: 'solo',
};

/** Lower-cased section-end directive names. */
const SECTION_END = new Set([
  'end_of_chorus', 'eoc',
  'end_of_verse', 'eov',
  'end_of_bridge', 'eob',
  'end_of_grid', 'eog',
  'end_of_tab', 'eot',
  'end_of_pre_chorus',
  'end_of_intro',
  'end_of_outro',
  'end_of_interlude',
  'end_of_solo',
]);

/** Recognizes UG-style section headers like [Verse 1] or [Chorus]. */
const UG_SECTION_RE =
  /^\[(Verse|Chorus|Bridge|Intro|Outro|Pre-?Chorus|Interlude|Hook|Solo|Instrumental|Refrain|Tab|Break|Fill|Riff|Coda|Tag|Vamp|Outro Solo|Guitar Solo|Piano Solo)[^\]]*\]$/i;

/** UG metadata header line: "Key: G", "Artist: Beatles", "BPM: 120", etc. */
const UG_META_LINE_RE =
  /^(song|title|artist|author|composer|key|capo|bpm|tempo|tuning|genre|style|time|meter|time\s+signature|album)\s*[:\-]\s*(.+)$/i;

/** Chord token pattern used by the chords-over-words heuristic. */
const CHORD_TOKEN_RE =
  /^[A-G][#b]?(?:m(?:aj)?|M|maj|min|dim|aug|sus[24]?|add\d*)?(?:\d+)?(?:\/[A-G][#b]?)?$/;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Flush a section into the document, ignoring fully-empty sections. */
function flushSection(doc: ChordChartDocument, section: ChartSection): void {
  const nonEmpty = section.lines.filter((l) => l.tokens.length > 0);
  if (nonEmpty.length > 0) {
    doc.sections.push({ ...section, lines: nonEmpty });
  }
}

/** Build an empty unnamed section. */
function makeSection(type: SectionType = 'unknown', label?: string): ChartSection {
  return { type, label, lines: [] };
}

/**
 * Parse a single line that may contain inline bracket-chord tokens.
 * e.g. "[Am]Hello [G]world" → [{chord:'Am'},{lyric:'Hello '},{chord:'G'},{lyric:'world'}]
 */
function parseBracketLine(line: string): ChartLine {
  const tokens: ChartToken[] = [];
  const bracketRe = /\[([^\]]+)\]([^\[]*)/g;
  let match: RegExpExecArray | null;

  // Text before the first bracket
  const firstBracket = line.indexOf('[');
  if (firstBracket > 0) {
    const pre = line.slice(0, firstBracket);
    if (pre.trim()) tokens.push({ kind: 'lyric', text: pre.trimEnd() });
  }

  while ((match = bracketRe.exec(line)) !== null) {
    const chordText = match[1].trim();
    const lyricText = match[2]; // keep internal spacing

    tokens.push({ kind: 'chord', text: chordText });
    if (lyricText.trim() || lyricText.includes(' ')) {
      // Preserve trailing space so words don't jam together at render time
      const safe = lyricText.trimEnd();
      if (safe || lyricText.startsWith(' ')) {
        tokens.push({ kind: 'lyric', text: lyricText.length > 0 ? lyricText : '' });
      }
    }
  }

  return { tokens };
}

// ─── 1. ChordPro parser ───────────────────────────────────────────────────────

/**
 * Parse canonical ChordPro text (v5/v6-compatible subset).
 * Handles `{directives}`, `[chord]` inline tokens, and UG-style `[Section]`
 * headers (since many real-world files mix both conventions).
 */
export function parseChordPro(text: string): ChordChartDocument {
  const doc: ChordChartDocument = { sections: [], sourceFormat: 'chordpro' };
  let current = makeSection();

  for (const rawLine of normalizeLineEndings(text).split('\n')) {
    const trimmed = rawLine.trim();

    // Blank lines act as soft section separators in un-directed files
    if (!trimmed) continue;

    // Comment lines beginning with %
    if (trimmed.startsWith('%')) continue;

    // ── Directive: {name: value} or {name} ──
    const directiveMatch = trimmed.match(/^\{([^:}]+)(?::([^}]*))?\}$/);
    if (directiveMatch) {
      const key = directiveMatch[1].trim().toLowerCase();
      const value = directiveMatch[2]?.trim();

      // Metadata directives
      const metaKey = DIRECTIVE_META[key];
      if (metaKey && value) {
        (doc as unknown as Record<string, unknown>)[metaKey] = value;
        continue;
      }

      // Section-start directives
      const sType = SECTION_START[key];
      if (sType !== undefined) {
        flushSection(doc, current);
        current = makeSection(sType, value || undefined);
        continue;
      }

      // Section-end directives
      if (SECTION_END.has(key)) {
        flushSection(doc, current);
        current = makeSection();
        continue;
      }

      // Comment / annotation directive
      if ((key === 'comment' || key === 'c' || key === 'comment_italic' || key === 'ci') && value) {
        current.lines.push({ tokens: [{ kind: 'comment', text: value }] });
        continue;
      }

      // All other directives are silently ignored
      continue;
    }

    // ── UG-style section header: [Verse 1], [Chorus], … ──
    if (UG_SECTION_RE.test(trimmed)) {
      flushSection(doc, current);
      const label = trimmed.slice(1, -1); // strip []
      current = makeSection(sectionTypeFromLabel(label), label);
      continue;
    }

    // ── Content line (may have inline [chord] tokens) ──
    if (trimmed.includes('[')) {
      const line = parseBracketLine(trimmed);
      if (line.tokens.length > 0) current.lines.push(line);
      continue;
    }

    // ── Plain lyric / text line ──
    current.lines.push({ tokens: [{ kind: 'lyric', text: trimmed }] });
  }

  flushSection(doc, current);
  return doc;
}

// ─── 2. Ultimate Guitar parser ────────────────────────────────────────────────

/**
 * Parse Ultimate Guitar–style text.
 *
 * UG files share ChordPro's inline-bracket-chord syntax but prefix most songs
 * with a plain-text metadata header (before the first [Section] label) that
 * looks like:
 *
 *   Artist: The Beatles
 *   Song: Hey Jude
 *   Key: F
 *   Capo: 1
 *   BPM: 75
 *   Tuning: Standard E
 *   Genre: Rock
 *
 * This header is NOT ChordPro-directive syntax, so `parseChordPro` silently
 * ignores it.  This function pre-scans those lines before delegating to the
 * shared ChordPro parser, then merges the extracted metadata in.
 */
export function parseUltimateGuitar(text: string): ChordChartDocument {
  const normalized = normalizeLineEndings(text);
  const lines = normalized.split('\n');

  // ── Pre-scan header metadata ──
  // Scan all lines before the first UG section header for "Key: Value" pairs.
  // We also scan a short window past section headers in case metadata appears
  // after a blank intro section (some editors put it there).
  const headerMeta: Partial<Pick<ChordChartDocument, 'title' | 'artist' | 'subtitle' | 'key' | 'capo' | 'tempo' | 'time' | 'genre'>> = {};
  let foundFirstSection = false;
  let linesScannedPastSection = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (UG_SECTION_RE.test(trimmed)) {
      foundFirstSection = true;
      continue;
    }

    // Only scan up to 8 lines past the first section for stray metadata
    if (foundFirstSection) {
      if (linesScannedPastSection++ >= 8) break;
      // Stop scanning if we hit content that looks like chord/lyric lines
      if (trimmed.includes('[') && !UG_META_LINE_RE.test(trimmed)) break;
    }

    const m = trimmed.match(UG_META_LINE_RE);
    if (!m) continue;

    const key = m[1].toLowerCase().replace(/\s+/g, '');
    const value = m[2].trim();
    if (!value) continue;

    switch (key) {
      case 'song':
      case 'title':   headerMeta.title    = headerMeta.title    ?? value; break;
      case 'artist':
      case 'author':
      case 'composer':headerMeta.artist   = headerMeta.artist   ?? value; break;
      case 'key':     headerMeta.key      = headerMeta.key      ?? value; break;
      case 'capo':    headerMeta.capo     = headerMeta.capo     ?? value; break;
      case 'bpm':
      case 'tempo':   headerMeta.tempo    = headerMeta.tempo    ?? value; break;
      case 'time':
      case 'meter':
      case 'timesignature': headerMeta.time = headerMeta.time   ?? value; break;
      case 'genre':
      case 'style':   headerMeta.genre    = headerMeta.genre    ?? value; break;
      case 'tuning':
        // Preserve tuning as subtitle only if nothing else is there
        headerMeta.subtitle = headerMeta.subtitle ?? `Tuning: ${value}`;
        break;
    }
  }

  // ── Parse chord content ──
  const doc = parseChordPro(normalized);
  doc.sourceFormat = 'ultimateguitar';

  // Merge: header metadata wins over anything the ChordPro parser found
  // (UG files rarely have ChordPro-style directives, but handle the case)
  if (headerMeta.title)    doc.title    = headerMeta.title;
  if (headerMeta.artist)   doc.artist   = headerMeta.artist;
  if (headerMeta.key)      doc.key      = headerMeta.key;
  if (headerMeta.capo)     doc.capo     = headerMeta.capo;
  if (headerMeta.tempo)    doc.tempo    = headerMeta.tempo;
  if (headerMeta.time)     doc.time     = headerMeta.time;
  if (headerMeta.genre)    doc.genre    = headerMeta.genre;
  if (headerMeta.subtitle) doc.subtitle = headerMeta.subtitle;

  return doc;
}

// ─── 3. Chords-over-words parser ─────────────────────────────────────────────

/** Return true when every non-empty token in the line looks like a chord name. */
function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return false;
  const chordCount = tokens.filter((t) => CHORD_TOKEN_RE.test(t)).length;
  return chordCount >= 1 && chordCount / tokens.length >= 0.7;
}

/**
 * Parse "chords-over-lyrics" format: each chord line sits immediately above
 * the lyric line it annotates.  The chords are paired with the lyric and
 * emitted as a single ChartLine of alternating chord/lyric tokens.
 */
export function parseChordsOverWords(text: string): ChordChartDocument {
  const doc: ChordChartDocument = { sections: [], sourceFormat: 'chords-over-words' };
  const current = makeSection();
  const rawLines = normalizeLineEndings(text).split('\n');
  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    if (isChordLine(trimmed)) {
      const chordTokens: ChartToken[] = trimmed
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => ({ kind: 'chord' as const, text: t }));

      const nextLine = rawLines[i + 1]?.trim() ?? '';
      if (nextLine && !isChordLine(nextLine)) {
        // Pair chord tokens with the following lyric line
        current.lines.push({
          tokens: [...chordTokens, { kind: 'lyric', text: nextLine }],
        });
        i += 2;
      } else {
        // Orphaned chord line (no following lyric)
        current.lines.push({ tokens: chordTokens });
        i++;
      }
      continue;
    }

    // Plain lyric or title-like line
    current.lines.push({ tokens: [{ kind: 'lyric', text: trimmed }] });
    i++;
  }

  flushSection(doc, current);
  return doc;
}

// ─── 4. Fake-book parser ──────────────────────────────────────────────────────

/**
 * Metadata key names recognised in fake-book headers (case-insensitive).
 * Mirrors the `UG_META_LINE_RE` keys but adapted for fake-book conventions.
 */
const FB_META_RE =
  /^(title|style|tempo|time|key|artist|composer|subtitle|album|genre)\s*[:\-]\s*(.+)$/i;

/** Fake-book section header: "- Intro", "= Bridge", "-- 1st Ending", etc. */
const FB_SECTION_RE = /^[-=]+\s+(.+)$/;

/**
 * Convert a single bar-row string (the content between or including `|:` / `:|`)
 * into a ChartLine whose tokens are barlines and chord tokens.
 *
 * Input:  "|: Bb7 Bb7_A7_D7 ·/· Eb6 :|"
 * Output: [barline(|:), chord(Bb7), barline(|), chord(Bb7), chord(A7), chord(D7),
 *          barline(|), chord(·/·), barline(|), chord(Eb6), barline(:|)]
 */
function parseBarRow(row: string): ChartLine {
  const tokens: ChartToken[] = [];
  let body = row.trim();

  // Opening barline
  let openBarline: BarlineToken['text'] | null = null;
  if (body.startsWith('|:')) {
    openBarline = '|:';
    body = body.slice(2).trimStart();
  } else if (body.startsWith('||')) {
    openBarline = '||';
    body = body.slice(2).trimStart();
  } else if (body.startsWith('|')) {
    openBarline = '|';
    body = body.slice(1).trimStart();
  }

  // Closing barline
  let closeBarline: BarlineToken['text'] | null = null;
  if (body.endsWith(':|')) {
    closeBarline = ':|';
    body = body.slice(0, -2).trimEnd();
  } else if (body.endsWith('||')) {
    closeBarline = '||';
    body = body.slice(0, -2).trimEnd();
  } else if (body.endsWith('|')) {
    closeBarline = '|';
    body = body.slice(0, -1).trimEnd();
  }

  if (openBarline) tokens.push({ kind: 'barline', text: openBarline });

  // Each space-separated item is one "bar"; within a bar `_` separates chords
  const barEntries = body.split(/\s+/).filter(Boolean);
  for (let bi = 0; bi < barEntries.length; bi++) {
    if (bi > 0) tokens.push({ kind: 'barline', text: '|' });
    const chords = barEntries[bi].split('_').filter(Boolean);
    for (const chord of chords) {
      tokens.push({ kind: 'chord', text: chord });
    }
  }

  if (closeBarline) tokens.push({ kind: 'barline', text: closeBarline });

  return { tokens };
}

/**
 * Parse fake-book lead-sheet notation.
 *
 * Format overview
 * ───────────────
 *  Metadata header (any order, before the first section):
 *    Title: Sin City Blues
 *    Key: Bb  /  Tempo: 90  /  Time: 12/8  /  Style: Slow Blues Swing
 *
 *  Section headers — a line starting with one or more `-` or `=` characters:
 *    - Intro        (= 'intro')
 *    = Bridge       (= 'bridge')
 *    - Pre-Chorus   (= 'pre-chorus')
 *
 *  Bar rows — lines containing |: / :| repeat markers or plain | barlines:
 *    |: Bb7 Bb7_A7_D7 Eb6 Eo7_Go7 :|
 *
 *    • Space-separated items are individual bars.
 *    • `_` separates multiple chords within one bar (beat changes).
 *    • `·/·` is a simile marker: "repeat the previous bar".
 *    • A row may span two physical lines when |: and :| are on separate lines.
 */
export function parseFakeBook(text: string): ChordChartDocument {
  const doc: ChordChartDocument = { sections: [], sourceFormat: 'fakebook' };
  let current = makeSection();

  const lines = normalizeLineEndings(text).split('\n');
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    i++;

    if (!trimmed) continue;

    // ── Metadata ──
    const metaMatch = trimmed.match(FB_META_RE);
    if (metaMatch && !trimmed.startsWith('|')) {
      const key = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      switch (key) {
        case 'title':    doc.title    = doc.title    ?? value; break;
        case 'artist':
        case 'composer': doc.artist   = doc.artist   ?? value; break;
        case 'subtitle': doc.subtitle = doc.subtitle ?? value; break;
        case 'key':      doc.key      = doc.key      ?? value; break;
        case 'tempo':    doc.tempo    = doc.tempo    ?? value; break;
        case 'time':     doc.time     = doc.time     ?? value; break;
        case 'style':
        case 'genre':    doc.genre    = doc.genre    ?? value; break;
      }
      continue;
    }

    // ── Section header ──
    const sectionMatch = trimmed.match(FB_SECTION_RE);
    if (sectionMatch) {
      flushSection(doc, current);
      const label = sectionMatch[1].trim();
      current = makeSection(sectionTypeFromLabel(label), label);
      continue;
    }

    // ── Bar row ──
    if (trimmed.startsWith('|') || trimmed.includes('\u00B7/\u00B7')) {
      // Accumulate across physical lines: if the row starts with |: but hasn't
      // closed with :| yet, append the next line(s) until :| is found.
      let accumulated = trimmed;
      if (accumulated.startsWith('|:') && !accumulated.includes(':|')) {
        while (i < lines.length) {
          const next = lines[i]?.trim() ?? '';
          if (!next) break;
          if (FB_SECTION_RE.test(next) || FB_META_RE.test(next)) break;
          accumulated += ' ' + next;
          i++;
          if (accumulated.includes(':|')) break;
        }
      }

      const line = parseBarRow(accumulated);
      if (line.tokens.length > 0) current.lines.push(line);
      continue;
    }

    // ── Anything else (comments, free text) — skip silently ──
  }

  flushSection(doc, current);
  return doc;
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Route text to the appropriate parser based on the pre-detected source format
 * and return a normalized ChordChartDocument.
 */
export function parseChordChart(text: string, sourceFormat: SourceFormat): ChordChartDocument {
  switch (sourceFormat) {
    case 'ultimateguitar':    return parseUltimateGuitar(text);
    case 'chords-over-words': return parseChordsOverWords(text);
    case 'abc':               return parseAbcNotation(text);
    case 'fakebook':          return parseFakeBook(text);
    default:                  return parseChordPro(text);
  }
}

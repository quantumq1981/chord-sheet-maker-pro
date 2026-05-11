/**
 * chordSlashMLParser.ts
 *
 * Parser for ChordSlashML — a minimal, human-writable text syntax for lead
 * sheets and chord charts that captures chord changes, beats (slashes), and
 * rhythm patterns.
 *
 * ── Syntax overview ──────────────────────────────────────────────────────────
 *
 *   # comment lines are ignored
 *   Title: Song Name
 *   Composer: Artist
 *   Key: C
 *   Time: 4/4          (default 4/4 when omitted)
 *   Tempo: 120
 *   Style: Jazz
 *
 *   [Section Label]
 *   | C _ _ _ | Am _ _ _ | F _ G _ | C _ _ _ ||
 *
 * Beat-slot tokens inside a measure:
 *   ChordName   — occupies a beat (e.g. C, Am, F#m7, Bbmaj7#11)
 *   _  /        — continuation slash (rhythmic placeholder)
 *   .           — rest
 *   C_G         — compound: C on the beat, G on the off-beat (eighth feel)
 *   (C Am F)    — tuplet group: three beats in the space of one
 *
 * Barline tokens:
 *   |           — single barline
 *   |:          — repeat start
 *   :|          — repeat end
 *   ||          — double barline (final or section break)
 *
 * ── EBNF grammar ─────────────────────────────────────────────────────────────
 *
 *   Document     = { Comment | MetaLine } { Section }
 *   Comment      = '#' { any } newline
 *   MetaLine     = FieldName ':' WS* FieldValue newline
 *   FieldName    = 'Title'|'Composer'|'Key'|'Time'|'Tempo'|'Style'
 *   Section      = SectionLabel? MeasureLine+
 *   SectionLabel = '[' LabelText ']' newline
 *   MeasureLine  = BarLeft MeasureBody ('|' MeasureBody)* BarRight newline
 *   BarLeft      = '|:' | '|'
 *   BarRight     = ':|' | '||' | '|'
 *   MeasureBody  = WS* BeatSlot (WS+ BeatSlot)* WS*
 *   BeatSlot     = TupletGroup | CompoundBeat | '_' | '/' | '.'
 *   TupletGroup  = '(' WS* BeatSlot (WS+ BeatSlot)+ WS* ')'
 *   CompoundBeat = ChordName (('_'|'.') ChordName)*
 *   ChordName    = Note Quality? ('/' Note Quality?)?
 *   Note         = [A-G] Accidental?
 *   Accidental   = '##'|'bb'|'#'|'b'
 *   Quality      = (see QUALITY_RE below)
 */

// ─── IR Types ─────────────────────────────────────────────────────────────────

/** A single beat-slot within a measure. */
export type CSMLBeat =
  | { kind: 'chord'; text: string }
  | { kind: 'slash' }
  | { kind: 'rest' }
  | { kind: 'compound'; parts: CSMLCompoundPart[] }
  | { kind: 'tuplet'; beats: CSMLBeat[]; count: number };

/** Part of a compound beat (e.g. C_G → beat + off-beat). */
export interface CSMLCompoundPart {
  chord: string;
  separator: '_' | '.'; // '_' = off-beat slash, '.' = dotted subdivision
}

export type BarlineKind = 'single' | 'repeat-start' | 'repeat-end' | 'double' | 'final';

export interface CSMLMeasure {
  beats: CSMLBeat[];
  leftBarline: BarlineKind; // barline before this measure
  rightBarline: BarlineKind; // barline after this measure
}

export interface CSMLSection {
  label: string;
  measures: CSMLMeasure[];
}

export interface CSMLDocument {
  title: string;
  composer: string;
  key: string;
  /** Time signature string, e.g. "4/4", "3/4", "6/8". */
  time: string;
  /** BPM, 0 if not specified. */
  tempo: number;
  style: string;
  sections: CSMLSection[];
  /** Non-fatal parse warnings. */
  warnings: string[];
}

// ─── Chord name recognition ────────────────────────────────────────────────────

/**
 * Quality suffixes in longest-first order so greedy matching works correctly.
 * Covers all standard lead-sheet chord qualities including extensions and
 * alterations used in jazz, pop, and classical charts.
 */
const QUALITY_SUFFIXES = [
  // Major extensions
  'maj13',
  'maj11',
  'maj9',
  'maj7',
  'maj6',
  'maj',
  // Minor-major
  'mM7',
  // Minor extensions
  'm7b5',
  'm13',
  'm11',
  'm9',
  'm7',
  'm6',
  'min',
  'm',
  // Dominant + alterations
  '7#9',
  '7b9',
  '7#5',
  '7b5',
  '7sus4',
  '7sus2',
  'aug7',
  '13',
  '11',
  '9',
  '7',
  // Diminished
  'dim7',
  'dim',
  // Augmented
  'aug',
  // Suspended
  'sus4',
  'sus2',
  // Added tones
  '6add9',
  '9sus4',
  'add13',
  'add11',
  'add9',
  // Simple
  '6',
  '5',
  'M',
] as const;

/** Matches a note root with optional double/single accidental. */
const NOTE_RE = /^[A-G](##|bb|[#b])?/;

// ─── Tokeniser ────────────────────────────────────────────────────────────────

type TokKind =
  | 'barline' // |  |:  :|  ||
  | 'lparen' // (
  | 'rparen' // )
  | 'slash' // _ or /
  | 'rest' // .
  | 'compound-sep' // the _ or . *inside* a compound beat (after chord name)
  | 'chord' // a chord name
  | 'unknown';

interface Tok {
  kind: TokKind;
  text: string;
}

/** Tokenise the content of a single measure (text between two `|` delimiters). */
function tokeniseMeasureContent(raw: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < raw.length) {
    // skip whitespace
    if (raw[i] === ' ' || raw[i] === '\t') {
      i++;
      continue;
    }
    if (raw[i] === '(') {
      tokens.push({ kind: 'lparen', text: '(' });
      i++;
      continue;
    }
    if (raw[i] === ')') {
      tokens.push({ kind: 'rparen', text: ')' });
      i++;
      continue;
    }
    if (raw[i] === '.') {
      tokens.push({ kind: 'rest', text: '.' });
      i++;
      continue;
    }
    // Try to read a chord name
    const m = NOTE_RE.exec(raw.slice(i));
    if (m) {
      // Greedily consume the full chord token (root + quality + optional /Bass)
      let end = i + m[0].length;
      // quality
      const afterRoot = raw.slice(end);
      let qualLen = 0;
      for (const q of QUALITY_SUFFIXES) {
        if (afterRoot.startsWith(q)) {
          qualLen = q.length;
          break;
        }
      }
      end += qualLen;
      // optional slash bass
      if (raw[end] === '/' && end + 1 < raw.length && NOTE_RE.test(raw.slice(end + 1))) {
        end++; // skip /
        const bassM = NOTE_RE.exec(raw.slice(end));
        if (bassM) {
          end += bassM[0].length;
          // bass quality (rare but allowed: C/Em)
          const afterBassRoot = raw.slice(end);
          for (const q of QUALITY_SUFFIXES) {
            if (afterBassRoot.startsWith(q)) {
              end += q.length;
              break;
            }
          }
        }
      }
      const chordText = raw.slice(i, end);
      // Check if immediately followed by a compound separator
      if (end < raw.length && (raw[end] === '_' || raw[end] === '.')) {
        tokens.push({ kind: 'chord', text: chordText });
        tokens.push({ kind: 'compound-sep', text: raw[end] as '_' | '.' });
        i = end + 1;
        continue;
      }
      tokens.push({ kind: 'chord', text: chordText });
      i = end;
      continue;
    }
    // slash / underscore
    if (raw[i] === '_' || raw[i] === '/') {
      tokens.push({ kind: 'slash', text: raw[i] });
      i++;
      continue;
    }
    // unknown — skip
    tokens.push({ kind: 'unknown', text: raw[i] });
    i++;
  }
  return tokens;
}

// ─── Beat parser ──────────────────────────────────────────────────────────────

/** Parse a flat token list into a structured beat list. */
function parseBeats(tokens: Tok[], warnings: string[]): CSMLBeat[] {
  const beats: CSMLBeat[] = [];
  let i = 0;

  const consume = (): Tok | undefined => tokens[i++];
  const peek = (): Tok | undefined => tokens[i];

  while (i < tokens.length) {
    const tok = peek();
    if (!tok) break;

    if (tok.kind === 'lparen') {
      // tuplet group
      consume();
      const inner: CSMLBeat[] = [];
      while (i < tokens.length && peek()?.kind !== 'rparen') {
        const t = peek()!;
        if (t.kind === 'chord') {
          consume();
          inner.push({ kind: 'chord', text: t.text });
        } else if (t.kind === 'slash') {
          consume();
          inner.push({ kind: 'slash' });
        } else if (t.kind === 'rest') {
          consume();
          inner.push({ kind: 'rest' });
        } else {
          consume(); // skip unknown
        }
      }
      if (peek()?.kind === 'rparen') consume();
      if (inner.length < 2) {
        warnings.push(`Tuplet group has fewer than 2 elements — treated as plain beats`);
        beats.push(...inner);
      } else {
        beats.push({ kind: 'tuplet', beats: inner, count: inner.length });
      }
      continue;
    }

    if (tok.kind === 'chord') {
      consume();
      // Check for compound-sep immediately following
      if (peek()?.kind === 'compound-sep') {
        const parts: CSMLCompoundPart[] = [{ chord: tok.text, separator: '_' }];
        while (peek()?.kind === 'compound-sep') {
          const sep = consume()!;
          const next = peek();
          if (next?.kind === 'chord') {
            consume();
            parts.push({ chord: next.text, separator: sep.text as '_' | '.' });
          }
        }
        // Last part has no separator — attach it
        beats.push({ kind: 'compound', parts });
        continue;
      }
      beats.push({ kind: 'chord', text: tok.text });
      continue;
    }

    if (tok.kind === 'slash') {
      consume();
      beats.push({ kind: 'slash' });
      continue;
    }

    if (tok.kind === 'rest') {
      consume();
      beats.push({ kind: 'rest' });
      continue;
    }

    consume(); // skip rparen / unknown outside tuplet
  }

  return beats;
}

// ─── Measure line parser ───────────────────────────────────────────────────────

function barlineKindLeft(s: string): BarlineKind {
  if (s === '|:') return 'repeat-start';
  return 'single';
}

function barlineKindRight(s: string): BarlineKind {
  if (s === ':|') return 'repeat-end';
  if (s === '||') return 'final';
  return 'single';
}

/**
 * Parse a single measure line like:
 *   | C _ _ _ | Am _ _ _ | F _ G _ | C _ _ _ ||
 * Returns an array of measures, one per `| … |` segment.
 *
 * Algorithm
 * ─────────
 * We split the line into a typed sequence of BARLINE and CONTENT parts.
 * The structure is always:
 *
 *   BARLINE  CONTENT  BARLINE  CONTENT  BARLINE  …  CONTENT  BARLINE
 *
 * Measure i uses barline[i] as its left barline, content[i] as its beats,
 * and barline[i+1] as its right barline.  Barlines between adjacent measures
 * belong to both the measure on their left (right barline) and the measure
 * on their right (left barline).
 */
function parseMeasureLine(line: string, warnings: string[]): CSMLMeasure[] {
  type Part = { kind: 'bar'; text: string } | { kind: 'content'; text: string };
  const parts: Part[] = [];

  let i = 0;
  while (i < line.length) {
    if (line[i] === '|') {
      if (line.slice(i, i + 2) === '|:') {
        parts.push({ kind: 'bar', text: '|:' });
        i += 2;
      } else if (line.slice(i, i + 2) === '||') {
        parts.push({ kind: 'bar', text: '||' });
        i += 2;
      } else {
        parts.push({ kind: 'bar', text: '|' });
        i += 1;
      }
    } else if (line[i] === ':' && i + 1 < line.length && line[i + 1] === '|') {
      parts.push({ kind: 'bar', text: ':|' });
      i += 2;
    } else {
      let content = '';
      while (i < line.length && line[i] !== '|' && !(line[i] === ':' && line[i + 1] === '|')) {
        content += line[i++];
      }
      const trimmed = content.trim();
      if (trimmed) parts.push({ kind: 'content', text: trimmed });
    }
  }

  // Collect barlines and content blocks separately while preserving order
  const barlines: string[] = [];
  const contents: string[] = [];
  let expectBar = true; // alternating: bar → content → bar → content…

  for (const p of parts) {
    if (p.kind === 'bar') {
      barlines.push(p.text);
      expectBar = false;
    } else {
      if (expectBar) {
        // Content with no preceding barline — synthesise a single barline
        barlines.push('|');
      }
      contents.push(p.text);
      expectBar = true; // next should be a barline
    }
  }

  // Ensure trailing barline
  if (contents.length > 0 && barlines.length <= contents.length) {
    barlines.push('|');
  }

  const measures: CSMLMeasure[] = [];
  for (let mi = 0; mi < contents.length; mi++) {
    const leftBar = barlines[mi] ?? '|';
    const rightBar = barlines[mi + 1] ?? '|';
    const toks = tokeniseMeasureContent(contents[mi]);
    const beats = parseBeats(toks, warnings);
    measures.push({
      beats,
      leftBarline: barlineKindLeft(leftBar),
      rightBarline: barlineKindRight(rightBar),
    });
  }

  return measures;
}

// ─── Top-level parser ─────────────────────────────────────────────────────────

const META_RE = /^(Title|Composer|Key|Time|Tempo|Style)\s*:\s*(.+)$/i;
const SECTION_LABEL_RE = /^\[([^\]]+)\]$/;
const COMMENT_RE = /^#/;
const MEASURE_LINE_RE = /^[|:]/; // starts with | or :

/**
 * Parse ChordSlashML text into a structured document IR.
 *
 * Never throws — parse errors are collected in `doc.warnings`.
 */
export function parseChordSlashML(text: string): CSMLDocument {
  const doc: CSMLDocument = {
    title: '',
    composer: '',
    key: '',
    time: '4/4',
    tempo: 0,
    style: '',
    sections: [],
    warnings: [],
  };

  const lines = text.split(/\r?\n/);
  let currentSection: CSMLSection | null = null;

  const flushSection = () => {
    if (currentSection && currentSection.measures.length > 0) {
      doc.sections.push(currentSection);
    }
  };

  const openSection = (label: string) => {
    flushSection();
    currentSection = { label, measures: [] };
  };

  const ensureSection = () => {
    if (!currentSection) {
      currentSection = { label: '', measures: [] };
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || COMMENT_RE.test(line)) continue;

    // Header meta fields
    const metaMatch = META_RE.exec(line);
    if (metaMatch) {
      const field = metaMatch[1].toLowerCase();
      const value = metaMatch[2].trim();
      switch (field) {
        case 'title':
          doc.title = value;
          break;
        case 'composer':
          doc.composer = value;
          break;
        case 'key':
          doc.key = value;
          break;
        case 'time':
          doc.time = value;
          break;
        case 'tempo': {
          const bpm = parseInt(value.replace(/[^\d]/g, ''), 10);
          doc.tempo = isNaN(bpm) ? 0 : bpm;
          break;
        }
        case 'style':
          doc.style = value;
          break;
      }
      continue;
    }

    // Section label [Label]
    const secMatch = SECTION_LABEL_RE.exec(line);
    if (secMatch) {
      openSection(secMatch[1].trim());
      continue;
    }

    // Measure line
    if (MEASURE_LINE_RE.test(line)) {
      ensureSection();
      const measures = parseMeasureLine(line, doc.warnings);
      currentSection!.measures.push(...measures);
      continue;
    }

    // Anything else — warn
    doc.warnings.push(`Unrecognised line: "${line.slice(0, 60)}"`);
  }

  flushSection();

  // If nothing was parsed, create a stub
  if (doc.sections.length === 0) {
    doc.sections.push({ label: '', measures: [] });
  }

  return doc;
}

// ─── Utility helpers ───────────────────────────────────────────────────────────

/** Return the number of visual beats per measure for a given time signature. */
export function beatsPerMeasure(time: string): number {
  const m = /^(\d+)\/(\d+)$/.exec(time);
  if (!m) return 4;
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  // Compound meters: 6/8=2, 9/8=3, 12/8=4
  if (den === 8 && num % 3 === 0) return num / 3;
  return num;
}

/** Return the plain chord text from a CSMLBeat (null for slash/rest). */
export function beatChordText(beat: CSMLBeat): string | null {
  if (beat.kind === 'chord') return beat.text;
  if (beat.kind === 'compound') return beat.parts[0]?.chord ?? null;
  if (beat.kind === 'tuplet') return beatChordText(beat.beats[0]);
  return null;
}

/** Collect all unique chord names that appear in a document. */
export function collectChords(doc: CSMLDocument): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sec of doc.sections) {
    for (const meas of sec.measures) {
      for (const beat of meas.beats) {
        collectFromBeat(beat, seen, out);
      }
    }
  }
  return out;
}

function collectFromBeat(beat: CSMLBeat, seen: Set<string>, out: string[]): void {
  if (beat.kind === 'chord') {
    if (!seen.has(beat.text)) {
      seen.add(beat.text);
      out.push(beat.text);
    }
  } else if (beat.kind === 'compound') {
    for (const p of beat.parts) {
      if (!seen.has(p.chord)) {
        seen.add(p.chord);
        out.push(p.chord);
      }
    }
  } else if (beat.kind === 'tuplet') {
    for (const b of beat.beats) collectFromBeat(b, seen, out);
  }
}

/** Check whether `text` is likely ChordSlashML (used by format detection). */
export function looksLikeChordSlashML(text: string): boolean {
  // Must have at least one measure line starting with | and containing beats
  const hasBarLine = /^\s*\|[^|]/m.test(text);
  // And NOT look like CSMPN (which uses ‖ or fake-book ·/· simile)
  const hasCsmpnMarkers = /‖|·\/·/.test(text);
  // And NOT look like ChordPro (which has {directives})
  const hasChordProDirectives = /\{[a-z_]+[}:]/.test(text);
  return hasBarLine && !hasCsmpnMarkers && !hasChordProDirectives;
}

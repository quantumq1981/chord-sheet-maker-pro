/**
 * abcParser.ts
 *
 * Converts ABC notation into a normalized ChordChartDocument for fakebook
 * rendering.  ABC is a text-based music format widely used for folk and
 * traditional music:
 *
 *   X:1
 *   T:Greensleeves
 *   C:Traditional English
 *   M:3/4
 *   L:1/8
 *   Q:1/4=80
 *   R:Waltz
 *   K:Am
 *   |: A2 |"Am"c3 d "G"B3 G |"Am"A3 B "C"c2 d |
 *   w: A- las, my love, you do me wrong,
 *
 * Extracted for the fakebook:
 *   • Header metadata  (T, C, M, Q, K, R, Z)
 *   • Chord symbols    ("chord" strings in the body)
 *   • Lyrics           (w: / W: lines, aligned to chord positions)
 *   • Sections         (multiple X: tunes, P: parts, or %% / % labels)
 *
 * Chord / lyric alignment
 * ──────────────────────
 * In ABC a chord symbol applies to the note that immediately follows it.
 * w: syllables are aligned one-to-one with notes.  We approximate this by
 * associating each chord with the next available lyric syllable — accurate
 * enough for display purposes without a full ABC engine.
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
} from '../models/ChordChartModel';
import { sectionTypeFromLabel, normalizeLineEndings } from '../utils/sectionUtils';

// ─── Key signature helpers ────────────────────────────────────────────────────

/** Semitone value for each root note (sharps and flats both mapped). */
const ROOT_TO_SEMI: Record<string, number> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
};

/** Preferred note name for each semitone 0–11 (flat-preferred for ambiguous). */
const SEMI_TO_NOTE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Semitones to subtract from the modal root to obtain the relative major root.
 * E.g. D Dorian (offset 2) → D−2 = C major.
 */
const MODE_TO_REL_MAJOR_OFFSET: Record<string, number> = {
  dor: 2, // Dorian = 2nd degree
  phr: 4, // Phrygian = 3rd degree
  lyd: 5, // Lydian = 4th degree
  mix: 7, // Mixolydian = 5th degree
  loc: 11, // Locrian = 7th degree
};

/**
 * Convert an ABC K: value to a CSMPN-compatible key string.
 *
 * Major and minor keys are preserved as-is ("G", "Am", "Bb").
 * Modal keys (Dorian, Phrygian, Lydian, Mixolydian, Locrian) are converted
 * to their relative major — the key signature players actually read — so the
 * CSMPN key field is always a standard major or minor key name.
 *
 *   "G"    → "G"
 *   "Am"   → "Am"
 *   "Dmix" → "G"   (D Mixolydian = G major key signature)
 *   "DDor" → "C"   (D Dorian = C major key signature)
 *   "Hp"   → undefined (Highland pipes — no key)
 */
function parseAbcKey(raw: string): string | undefined {
  const v = raw.trim();
  if (!v || /^(none|Hp|HP)$/i.test(v)) return undefined;

  // Root note + optional accidental
  const m = v.match(/^([A-G][#b]?)\s*(.*)$/i);
  if (!m) return v;

  // Normalise root capitalisation (ABC allows lowercase, e.g. "am")
  const root = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const modePart = (m[2] ?? '').trim();

  if (!modePart) return root; // plain major

  // Minor and Ionian (= major) — express normally
  if (/^m(in(or)?)?$/i.test(modePart)) return `${root}m`;
  if (/^maj(or)?$/i.test(modePart) || /^ion(ian)?$/i.test(modePart)) return root;
  // Aeolian = relative minor, e.g. A Aeolian → "Am"
  if (/^aeo(lian)?$/i.test(modePart)) return `${root}m`;

  // Modal keys: compute relative major key signature
  const modeKey = modePart.slice(0, 3).toLowerCase();
  const offset = MODE_TO_REL_MAJOR_OFFSET[modeKey];
  if (offset !== undefined) {
    const rootSemi = ROOT_TO_SEMI[root];
    if (rootSemi !== undefined) {
      const relMajorSemi = (rootSemi - offset + 12) % 12;
      return SEMI_TO_NOTE[relMajorSemi];
    }
  }

  // Unknown mode — append as-is (e.g. K:Gsus)
  return `${root} ${modePart}`.trim();
}

/**
 * Convert an ABC M: value to a time-signature string.
 *   "4/4" → "4/4", "C" → "4/4", "C|" → "2/2"
 */
function parseAbcMeter(raw: string): string | undefined {
  const v = raw.trim();
  if (v === 'C') return '4/4';
  if (v === 'C|') return '2/2';
  if (/^\d+\/\d+$/.test(v)) return v;
  return undefined;
}

/**
 * Convert an ABC Q: value to a BPM string.
 *   "120"          → "120"
 *   "1/4=120"      → "120"
 *   '"Andante" 80' → "80"
 *   '"Moderato" 1/4=100' → "100"
 */
function parseAbcTempo(raw: string): string | undefined {
  const v = raw.trim();
  // Simple integer
  if (/^\d+$/.test(v)) return v;
  // note_length=N  (e.g. 1/4=120)
  const eqMatch = v.match(/=\s*(\d+)\s*$/);
  if (eqMatch) return eqMatch[1];
  // "label" N  (e.g. "Andante" 80)
  const labelMatch = v.match(/"[^"]*"\s+(\d+)/);
  if (labelMatch) return labelMatch[1];
  return undefined;
}

// ─── Lyric helpers ────────────────────────────────────────────────────────────

/**
 * Split an ABC w: lyric string into display syllables.
 *
 * ABC lyric conventions:
 *   "word-"  next syllable follows without space (hyphen)
 *   "_"      elongates the previous syllable (skip note)
 *   "*"      skip this note
 *   "|"      marks a bar boundary (aligns with | in body)
 *   "\-"     literal hyphen
 */
function parseLyricLine(line: string): string[] {
  const syllables: string[] = [];
  const parts = line.split(/\s+/);
  for (const part of parts) {
    if (!part || part === '|' || part === '*' || part === '_') continue;
    // Strip trailing hyphens that signal continuation (we don't need them)
    const text = part.replace(/\\-/g, '-').replace(/-$/, '').trim();
    if (text) syllables.push(text);
  }
  return syllables;
}

// ─── Body parsing ─────────────────────────────────────────────────────────────

/** ABC fingering / annotation prefixes that are NOT chord symbols. */
const FINGERING_RE = /^[\^_!0-5(]/;

/**
 * When the ABC body uses `[V:N]` inline voice markers (common in multi-voice
 * scores exported from MuseScore or Sibelius), return only the body text for
 * the voice that contains the most chord symbols.  This prevents duplicate
 * bars that arise when both a melody voice and a comping voice are concatenated.
 *
 * Falls back to the full body text if no `[V:` markers are present.
 */
function extractRichestVoice(bodyText: string): string {
  if (!bodyText.includes('[V:')) return bodyText;

  const voiceText: Map<string, string> = new Map();
  let currentVoice = '__root__';
  let pos = 0;

  while (pos < bodyText.length) {
    const vStart = bodyText.indexOf('[V:', pos);
    if (vStart === -1) {
      // Append remainder to current voice
      voiceText.set(currentVoice, (voiceText.get(currentVoice) ?? '') + bodyText.slice(pos));
      break;
    }
    // Append text before this marker
    if (vStart > pos) {
      voiceText.set(
        currentVoice,
        (voiceText.get(currentVoice) ?? '') + bodyText.slice(pos, vStart)
      );
    }
    const vEnd = bodyText.indexOf(']', vStart);
    if (vEnd === -1) break;
    currentVoice = bodyText.slice(vStart + 3, vEnd).trim();
    pos = vEnd + 1;
  }

  // Score each voice by the count of non-fingering chord symbols
  let bestVoice = '';
  let bestCount = 0;
  for (const [voice, text] of voiceText) {
    let count = 0;
    let i = 0;
    while (i < text.length) {
      if (text[i] === '"') {
        const end = text.indexOf('"', i + 1);
        if (end !== -1) {
          const inner = text.slice(i + 1, end).trim();
          if (inner && !FINGERING_RE.test(inner)) count++;
          i = end + 1;
          continue;
        }
      }
      i++;
    }
    if (count > bestCount) {
      bestCount = count;
      bestVoice = voice;
    }
  }

  return bestVoice ? (voiceText.get(bestVoice) ?? bodyText) : bodyText;
}

/** Clean an ABC chord string: strip ornaments, convert % → / for slash chords. */
function cleanChord(raw: string): string {
  // "G%D" → "G/D" (ABC slash-chord convention)
  return raw.replace(/%/, '/').trim();
}

/**
 * Partition ABC body text into bars, returning the chord symbols per bar.
 *
 * Bar separators:  |  ||  |:  :|  :||  [|  |]  (:  :)
 * We treat every `|` character (not inside a chord string) as a bar boundary.
 *
 * When the body contains `[V:N]` voice markers (multi-voice score), only the
 * harmonically richest voice is processed to avoid doubled bars.
 */
function extractBarChords(bodyText: string): string[][] {
  const effectiveBody = extractRichestVoice(bodyText);
  const bars: string[][] = [];
  let currentChords: string[] = [];

  let i = 0;
  while (i < effectiveBody.length) {
    const ch = effectiveBody[i];

    if (ch === '"') {
      // Chord symbol: read until the closing quote
      const end = effectiveBody.indexOf('"', i + 1);
      if (end !== -1) {
        const raw = effectiveBody.slice(i + 1, end).trim();
        // Skip fingering annotations and empty strings
        if (raw && !FINGERING_RE.test(raw)) {
          const chord = cleanChord(raw);
          if (chord) currentChords.push(chord);
        }
        i = end + 1;
        continue;
      }
    }

    if (ch === '|') {
      // Flush current bar (even if empty — keep structure)
      bars.push(currentChords);
      currentChords = [];
    }

    if (ch === '%') {
      // Comment to end of line — advance past it and the newline in one step
      while (i < effectiveBody.length && effectiveBody[i] !== '\n') i++;
      if (i < effectiveBody.length) i++; // step past the '\n' itself
      continue;
    }

    i++;
  }

  // Flush last bar
  if (currentChords.length > 0) bars.push(currentChords);

  // Drop entirely empty bars (repeats / double bars with no chords)
  return bars.filter((b) => b.length > 0);
}

// ─── Line builder ─────────────────────────────────────────────────────────────

/** Number of bars to group per display line. */
const BARS_PER_LINE = 4;

/**
 * Build ChartLines from an array of per-bar chord lists and a flat syllable list.
 *
 * Each line gets BARS_PER_LINE bars worth of chords.  Each chord consumes
 * one syllable from the syllable list (simple one-to-one heuristic).
 */
function buildLines(barChords: string[][], syllables: string[]): ChartLine[] {
  const lines: ChartLine[] = [];
  let syllableIdx = 0;

  for (let lineStart = 0; lineStart < barChords.length; lineStart += BARS_PER_LINE) {
    const barsSlice = barChords.slice(lineStart, lineStart + BARS_PER_LINE);
    const tokens: ChartToken[] = [];

    for (const bar of barsSlice) {
      for (const chord of bar) {
        tokens.push({ kind: 'chord', text: chord });
        const lyric = syllables[syllableIdx];
        if (lyric !== undefined) {
          tokens.push({ kind: 'lyric', text: `${lyric} ` });
          syllableIdx++;
        }
      }
    }

    if (tokens.length > 0) lines.push({ tokens });
  }

  // Append any leftover syllables (more lyrics than chord changes) as a
  // lyric-only line so nothing is silently dropped.
  if (syllableIdx < syllables.length) {
    lines.push({ tokens: [{ kind: 'lyric', text: syllables.slice(syllableIdx).join(' ') }] });
  }

  return lines;
}

// ─── Tune block parser ────────────────────────────────────────────────────────

interface TuneMeta {
  title?: string;
  composer?: string;
  key?: string;
  time?: string;
  tempo?: string;
  genre?: string;
}

interface TuneBody {
  bodyText: string; // raw body text (after K:)
  allLyrics: string[]; // all w: / W: syllables in order
  partLabels: string[]; // section markers found in body
}

function parseTuneLines(tuneLines: string[]): { meta: TuneMeta; body: TuneBody } {
  const meta: TuneMeta = {};
  const headerWLines: string[] = [];
  const bodyParts: string[] = [];
  const bodyWLines: string[] = [];
  const partLabels: string[] = [];

  let pastKey = false;

  for (const line of tuneLines) {
    const trimmed = line.trim();

    // ── Header fields (single letter + colon, before K:) ──
    if (!pastKey) {
      const hm = trimmed.match(/^([A-Za-z])\s*:\s*(.*)$/);
      if (hm) {
        const [, field, rawValue] = hm;
        const value = rawValue.trim();

        switch (field) {
          case 'T':
            meta.title = meta.title ?? value;
            break;
          case 'C':
            meta.composer = meta.composer ?? value;
            break;
          case 'M':
            meta.time = parseAbcMeter(value) ?? meta.time;
            break;
          case 'Q':
            meta.tempo = parseAbcTempo(value) ?? meta.tempo;
            break;
          case 'R':
            meta.genre = meta.genre ?? value;
            break;
          case 'W':
            headerWLines.push(value);
            break;
          case 'L':
            /* unit note length — not needed for chord display */ break;
          case 'K':
            meta.key = parseAbcKey(value);
            pastKey = true;
            break;
          // X:, Z:, S:, A:, N:, G:, H:, O:, F:, B: — informational, skip
        }
        continue;
      }
    }

    if (!pastKey) {
      // Body line before any K: (non-standard but handle gracefully)
      bodyParts.push(line);
      continue;
    }

    // ── Body ──
    // Inline lyric line
    if (/^[wW]\s*:/.test(trimmed)) {
      bodyWLines.push(trimmed.replace(/^[wW]\s*:\s*/, ''));
      continue;
    }

    // P: part marker in body
    if (/^P\s*:/.test(trimmed)) {
      const label = trimmed.replace(/^P\s*:\s*/, '').trim();
      if (label && label.length < 40) partLabels.push(`Part ${label}`);
      continue;
    }

    // %% directive (Guido extension / text annotation)
    if (trimmed.startsWith('%%')) {
      const label = trimmed.slice(2).trim();
      if (label && label.length < 40 && !/^(MIDI|vskip|newpage)/i.test(label)) {
        partLabels.push(label);
      }
      continue;
    }

    // % comment — check if it looks like a section label
    if (trimmed.startsWith('%')) {
      const label = trimmed.slice(1).trim();
      if (label && label.length < 40) partLabels.push(label);
      continue;
    }

    bodyParts.push(line);
  }

  const allLyrics = [
    ...headerWLines.flatMap(parseLyricLine),
    ...bodyWLines.flatMap(parseLyricLine),
  ];

  return {
    meta,
    body: {
      bodyText: bodyParts.join('\n'),
      allLyrics,
      partLabels,
    },
  };
}

// ─── Section assembly ─────────────────────────────────────────────────────────

/**
 * Turn extracted bar-chords + lyrics into one or more ChartSection objects.
 *
 * If part labels are present, the bars are split approximately evenly between
 * them (a rough heuristic — without a full ABC engine we don't know the exact
 * bar count per part).  Otherwise, the tune is emitted as a single section.
 */
function assembleSections(
  barChords: string[][],
  allLyrics: string[],
  partLabels: string[],
  fallbackLabel?: string
): ChartSection[] {
  if (barChords.length === 0) return [];

  if (partLabels.length === 0) {
    const lines = buildLines(barChords, allLyrics);
    if (lines.length === 0) return [];
    return [
      {
        type: 'unknown',
        label: fallbackLabel,
        lines,
      },
    ];
  }

  // Split bars evenly across parts
  const barsPerPart = Math.ceil(barChords.length / partLabels.length);
  const sections: ChartSection[] = [];

  for (let i = 0; i < partLabels.length; i++) {
    const startBar = i * barsPerPart;
    const endBar = Math.min(startBar + barsPerPart, barChords.length);
    const sliceBars = barChords.slice(startBar, endBar);

    const chordsInPart = sliceBars.reduce((n, b) => n + b.length, 0);
    const syllableStart = Math.round((i / partLabels.length) * allLyrics.length);
    const partLyrics = allLyrics.slice(syllableStart, syllableStart + chordsInPart);

    const lines = buildLines(sliceBars, partLyrics);
    if (lines.length === 0) continue;

    sections.push({
      type: sectionTypeFromLabel(partLabels[i]),
      label: partLabels[i],
      lines,
    });
  }

  return sections.length > 0
    ? sections
    : [
        {
          type: 'unknown',
          label: fallbackLabel,
          lines: buildLines(barChords, allLyrics),
        },
      ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse ABC notation text into a ChordChartDocument.
 *
 * Supports multi-tune files (multiple X: fields).  The first tune's header
 * fields populate the document-level metadata.  Each tune becomes one or more
 * sections depending on its P: parts and %% / % labels.
 */
export function parseAbcNotation(text: string): ChordChartDocument {
  const doc: ChordChartDocument = { sections: [], sourceFormat: 'abc' };

  const normalized = normalizeLineEndings(text);

  // ── Split into individual tunes on X: boundaries ──
  const allLines = normalized.split('\n');
  const tuneBlocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of allLines) {
    if (/^\s*X\s*:\s*\d/.test(line) && currentBlock.length > 0) {
      tuneBlocks.push(currentBlock);
      currentBlock = [line];
    } else {
      currentBlock.push(line);
    }
  }
  if (currentBlock.length > 0) tuneBlocks.push(currentBlock);

  // If there is no X: field, treat the whole file as one tune
  if (tuneBlocks.length === 0) tuneBlocks.push(allLines);

  let metadataApplied = false;
  // Keep the last parsed body so the fallback below can reuse it without
  // a second call to parseTuneLines(allLines).
  let lastBody: TuneBody | null = null;

  for (const block of tuneBlocks) {
    const { meta, body } = parseTuneLines(block);
    lastBody = body;

    // Apply document-level metadata from the first tune that has any
    if (!metadataApplied) {
      if (meta.title) doc.title = meta.title;
      if (meta.composer) doc.artist = meta.composer;
      if (meta.key) doc.key = meta.key;
      if (meta.time) doc.time = meta.time;
      if (meta.tempo) doc.tempo = meta.tempo;
      if (meta.genre) doc.genre = meta.genre;
      if (meta.title || meta.composer) metadataApplied = true;
    }

    const barChords = extractBarChords(body.bodyText);
    const sections = assembleSections(barChords, body.allLyrics, body.partLabels, meta.title);

    doc.sections.push(...sections);
  }

  // ── Fallback: if no chords but lyrics exist, emit a lyrics-only line ──
  // Reuses the already-parsed body; no second parse needed.
  if (doc.sections.length === 0 && lastBody && lastBody.allLyrics.length > 0) {
    doc.sections.push({
      type: 'unknown',
      lines: [{ tokens: [{ kind: 'lyric', text: lastBody.allLyrics.join(' ') }] }],
    });
  }

  return doc;
}

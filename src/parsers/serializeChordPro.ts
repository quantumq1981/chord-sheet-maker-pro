/**
 * serializeChordPro.ts
 *
 * Converts a normalized ChordChartDocument back to canonical ChordPro text.
 * Round-trips cleanly with the three parsers in chordProParser.ts.
 *
 * Section-type → directive mapping follows the ChordPro v6 spec (underscores
 * for multi-word names, e.g. `start_of_pre_chorus` not `start_of_pre-chorus`).
 */

import { transposeChord } from '../renderers/ChordChart';
import type { ChordChartDocument, SectionType } from '../models/ChordChartModel';

// ─── Section-type helpers ─────────────────────────────────────────────────────

/**
 * Map a SectionType to its ChordPro directive base name (the part after
 * `start_of_` / `end_of_`).  Returns `null` for 'unknown' sections, which
 * are emitted without a surrounding directive pair.
 */
function directiveBase(type: SectionType): string | null {
  switch (type) {
    case 'chorus':
      return 'chorus';
    case 'verse':
      return 'verse';
    case 'bridge':
      return 'bridge';
    case 'grid':
      return 'grid';
    case 'tab':
      return 'tab';
    case 'pre-chorus':
      return 'pre_chorus'; // spec: underscore, not hyphen
    case 'intro':
      return 'intro';
    case 'outro':
      return 'outro';
    case 'interlude':
      return 'interlude';
    case 'solo':
      return 'solo';
    default:
      return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Serialize a ChordChartDocument to canonical ChordPro text.
 *
 * @param doc            The normalized document to serialize.
 * @param transposeSteps Semitone shift applied to every chord and to the key
 *                       directive (positive = up, negative = down).
 */
export function serializeChordProDocument(doc: ChordChartDocument, transposeSteps = 0): string {
  const lines: string[] = [];

  // ── Header metadata ──
  if (doc.title) lines.push(`{title: ${doc.title}}`);
  if (doc.artist) lines.push(`{artist: ${doc.artist}}`);
  if (doc.subtitle) lines.push(`{subtitle: ${doc.subtitle}}`);
  if (doc.key) {
    const displayKey = transposeSteps !== 0 ? transposeChord(doc.key, transposeSteps) : doc.key;
    lines.push(`{key: ${displayKey}}`);
  }
  if (doc.capo) lines.push(`{capo: ${doc.capo}}`);
  if (doc.tempo) lines.push(`{tempo: ${doc.tempo}}`);
  if (doc.time) lines.push(`{time: ${doc.time}}`);
  if (doc.genre) lines.push(`{genre: ${doc.genre}}`);

  // ── Sections ──
  for (const section of doc.sections) {
    lines.push('');

    const base = directiveBase(section.type);
    if (base !== null) {
      if (section.label) {
        lines.push(`{start_of_${base}: ${section.label}}`);
      } else {
        lines.push(`{start_of_${base}}`);
      }
    } else if (section.label) {
      // Unknown type but has a label: emit a comment directive so the label
      // is preserved in round-trip output rather than silently dropped.
      lines.push(`{comment: ${section.label}}`);
    }

    for (const line of section.lines) {
      const parts: string[] = [];
      for (const token of line.tokens) {
        if (token.kind === 'chord') {
          const displayed =
            transposeSteps !== 0 ? transposeChord(token.text, transposeSteps) : token.text;
          parts.push(`[${displayed}]`);
        } else if (token.kind === 'lyric') {
          parts.push(token.text);
        } else if (token.kind === 'comment') {
          parts.push(`{comment: ${token.text}}`);
        }
      }
      lines.push(parts.join(''));
    }

    if (base !== null) {
      lines.push(`{end_of_${base}}`);
    }
  }

  return lines.join('\n').trimStart();
}

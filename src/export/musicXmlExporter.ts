/**
 * musicXmlExporter.ts
 *
 * Generates MusicXML 4.0 (Partwise) from a ChordChartDocument produced by
 * parseCsmpn().  Section labels become <rehearsal> direction elements placed
 * above the first measure of each section, so notation software (MuseScore,
 * Dorico, Sibelius) preserves song structure.
 *
 * Usage:
 *   import { generateMusicXml } from './musicXmlExporter';
 *   const xml = generateMusicXml(doc, { useBoxedRehearsal: true });
 */

import type { ChordChartDocument, ChartSection, ChartToken } from '../models/ChordChartModel';

// ── Public types ─────────────────────────────────────────────────────────────

export interface MusicXmlOptions {
  /** Wrap rehearsal marks in a square box (enclosure="square"). Default: false (enclosure="none"). */
  useBoxedRehearsal?: boolean;
  /** Emit a <metronome> + <sound tempo> direction. Default: true. */
  includeTempo?: boolean;
  /** Include <key> in the first measure's <attributes>. Default: true. */
  includeKeySignature?: boolean;
  /** Staff size in millimeters for <defaults><scaling>. 0 = omit. Default: 0. */
  staffSize?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Unicode simile marker emitted by parseCsmpn() for '%' repeat bars. */
const SIMILE = '\u00B7/\u00B7';

/** Navigation text patterns — labels matching this are NOT turned into rehearsal marks. */
const NAV_RE = /\b(D\.C\.|D\.S\.|FINE|CODA|AL FINE|AL CODA|DAL SEGNO|DA CAPO|TO CODA|SEGNO)\b/i;

/** Key → fifths offset (positive = sharps, negative = flats). */
const KEY_SIG_FIFTHS: Record<string, number> = {
  C: 0,
  Am: 0,
  G: 1,
  Em: 1,
  D: 2,
  Bm: 2,
  A: 3,
  'F#m': 3,
  E: 4,
  'C#m': 4,
  B: 5,
  'G#m': 5,
  'F#': 6,
  'D#m': 6,
  'C#': 7,
  F: -1,
  Dm: -1,
  Bb: -2,
  Gm: -2,
  Eb: -3,
  Cm: -3,
  Ab: -4,
  Fm: -4,
  Db: -5,
  Bbm: -5,
  Gb: -6,
  Ebm: -6,
  Cb: -7,
};

// ── Utilities ─────────────────────────────────────────────────────────────────

function escapeXml(s: string): string {
  return (s ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert the chart key string (e.g. "Cm", "F# major", "Bb") to a MusicXML
 * <fifths> integer.  Returns 0 (C major) when unknown.
 */
function keyToFifths(keyStr: string): number {
  if (!keyStr) return 0;
  const s = keyStr
    .trim()
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .replace(/\s*(major|maj)\s*$/i, '')
    .replace(/\s*(minor|min)\s*$/i, 'm');
  const normalised = s[0].toUpperCase() + s.slice(1);
  return KEY_SIG_FIFTHS[normalised] ?? 0;
}

/**
 * Visual beats per measure following Real Book convention:
 *   12/8 → 4, 9/8 → 3, 6/8 → 2, N/4 → N
 */
function visualBeats(timeSig: string): number {
  if (!timeSig) return 4;
  const m = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return 4;
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  if (den === 8 && num >= 6 && num % 3 === 0) return num / 3;
  return Math.max(1, num);
}

// ── Chord parsing ─────────────────────────────────────────────────────────────

interface ParsedChord {
  rootStep: string;
  rootAlter: number;
  kind: string;
  bassStep: string;
  bassAlter: number;
}

/**
 * Map a chord quality string to a MusicXML <kind> value.
 * Covers all common chord types including half-diminished, augmented, suspended.
 */
function chordKindFromQuality(quality: string): string {
  if (!quality) return 'major';
  const q = quality.toLowerCase();
  if (q.startsWith('ø') || q === 'm7♭5' || q === 'm7b5') return 'half-diminished';
  if (q.startsWith('maj') || q.startsWith('ma') || q.startsWith('δ')) return 'major-seventh';
  if (q.startsWith('°7') || q.startsWith('dim7') || q === 'o7' || q.startsWith('o7'))
    return 'diminished-seventh';
  if (q.startsWith('°') || q.startsWith('dim') || q === 'o' || q.startsWith('o '))
    return 'diminished';
  if (q.startsWith('+7') || q.startsWith('aug7') || q.startsWith('7#5') || q.startsWith('7♯5'))
    return 'augmented-seventh';
  if (q === '+' || q.startsWith('aug')) return 'augmented';
  if (q === 'm' || q === 'min' || q === 'mi' || q === '−') return 'minor';
  if (q.startsWith('m7') || q.startsWith('min7') || q.startsWith('mi7') || q.startsWith('−7'))
    return 'minor-seventh';
  if (q.startsWith('m') && /\d/.test(q)) return 'minor-seventh';
  if (q.startsWith('−') && /\d/.test(q)) return 'minor-seventh';
  if (q === '6' || q === '6/9' || q.startsWith('6/9')) return 'major-sixth';
  if (q === '7') return 'dominant';
  if (/^[79]/.test(q) || q.startsWith('13') || q.startsWith('11')) return 'dominant';
  if (q.startsWith('sus4') || q === 'sus') return 'suspended-fourth';
  if (q.startsWith('sus2')) return 'suspended-second';
  return 'major';
}

/**
 * Parse a chord display string (e.g. "F#m7/A", "Bbmaj7", "G!") into its
 * MusicXML components.  Returns null if the string is not a valid chord root.
 */
function parseChordForXml(text: string): ParsedChord | null {
  // Strip articulation suffixes added by the CSMPN renderer
  const stripped = text.replace(/[!^.=]$/, '').trim();
  if (!stripped) return null;

  const rootMatch = stripped.match(/^([A-G])(♭|♯|b|#)?/);
  if (!rootMatch) return null;

  const rootStep = rootMatch[1];
  const accStr = rootMatch[2] ?? '';
  const rootAlter =
    accStr === '♭' || accStr === 'b' ? -1 : accStr === '♯' || accStr === '#' ? 1 : 0;

  const afterRoot = stripped.slice(rootMatch[0].length);
  // Bass note follows the last '/'
  const slashIdx = afterRoot.lastIndexOf('/');
  const qualRaw = slashIdx >= 0 ? afterRoot.slice(0, slashIdx) : afterRoot;

  let bassStep = '';
  let bassAlter = 0;
  if (slashIdx >= 0) {
    const bassStr = afterRoot.slice(slashIdx + 1);
    const bassMatch = bassStr.match(/^([A-G])(♭|♯|b|#)?/);
    if (bassMatch) {
      bassStep = bassMatch[1];
      const bassAccStr = bassMatch[2] ?? '';
      bassAlter =
        bassAccStr === '♭' || bassAccStr === 'b'
          ? -1
          : bassAccStr === '♯' || bassAccStr === '#'
            ? 1
            : 0;
    }
  }

  return { rootStep, rootAlter, kind: chordKindFromQuality(qualRaw), bassStep, bassAlter };
}

// ── Bar extraction from ChartSection ─────────────────────────────────────────

interface Bar {
  /** Chord display strings for this measure (empty for simile bars). */
  chords: string[];
  /** True when the bar is a simile/repeat marker (no harmony emitted). */
  isSimile: boolean;
}

/**
 * Walk the token stream of a section and group chord tokens into measures
 * separated by barlines.  Each closing barline produces one Bar entry.
 */
function extractBars(section: ChartSection): Bar[] {
  const bars: Bar[] = [];
  let current: string[] = [];
  let open = false;

  const closeBar = (closing: ChartToken) => {
    if (!open) return;
    bars.push({
      chords: current.filter((c) => c !== SIMILE),
      isSimile: current.length > 0 && current.every((c) => c === SIMILE),
    });
    current = [];
    void closing;
  };

  for (const line of section.lines) {
    for (const token of line.tokens) {
      if (token.kind === 'barline') {
        closeBar(token);
        open = true;
      } else if (token.kind === 'chord' && open) {
        current.push(token.text);
      }
    }
  }
  // CSMPN lines always end with a closing barline, so `current` is empty here.
  // Flush any trailing partial bar defensively.
  if (open && current.length > 0) {
    bars.push({ chords: current.filter((c) => c !== SIMILE), isSimile: false });
  }

  return bars;
}

// ── XML fragment builders ─────────────────────────────────────────────────────

function buildFirstMeasureAttributes(
  beats: string,
  beatType: string,
  divisions: number,
  fifths: number
): string {
  return `
      <attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>${fifths}</fifths><mode>major</mode></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <measure-style><slash type="start" use-stems="no"/></measure-style>
      </attributes>`;
}

function buildTempoDirection(tempo: string): string {
  const t = escapeXml(tempo);
  return `
      <direction placement="above">
        <direction-type><metronome parentheses="no">
          <beat-unit>quarter</beat-unit><per-minute>${t}</per-minute>
        </metronome></direction-type>
        <sound tempo="${t}"/>
      </direction>`;
}

function buildRehearsalDirection(label: string, boxed: boolean): string {
  const enclosure = boxed ? 'square' : 'none';
  return `
      <direction placement="above">
        <direction-type>
          <rehearsal enclosure="${enclosure}" default-y="40">${escapeXml(label)}</rehearsal>
        </direction-type>
      </direction>`;
}

function buildHarmonyElement(parsed: ParsedChord, offset: number): string {
  const alterTag = parsed.rootAlter !== 0 ? `<alter>${parsed.rootAlter}</alter>` : '';
  const bassAlterTag = parsed.bassAlter !== 0 ? `<bass-alter>${parsed.bassAlter}</bass-alter>` : '';
  const bassXml = parsed.bassStep
    ? `<bass><bass-step>${escapeXml(parsed.bassStep)}</bass-step>${bassAlterTag}</bass>`
    : '';
  const offsetTag = offset > 0 ? `<offset>${offset}</offset>` : '';
  return `
      <harmony>${offsetTag}<root><root-step>${escapeXml(parsed.rootStep)}</root-step>${alterTag}</root><kind>${parsed.kind}</kind>${bassXml}</harmony>`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate a MusicXML 4.0 Partwise document from a parsed CSMPN chart.
 *
 * Section markers (e.g. `= Intro`, `[Verse 1]`) become `<rehearsal>` direction
 * elements placed above the first measure of each section, allowing notation
 * software to display clearly labelled song sections.
 *
 * @returns The complete MusicXML string, or an empty string when the document
 *   contains no bars.
 */
export function generateMusicXml(doc: ChordChartDocument, options?: MusicXmlOptions): string {
  const opts = {
    useBoxedRehearsal: false,
    includeTempo: true,
    includeKeySignature: true,
    staffSize: 0,
    ...options,
  };

  const title = escapeXml(doc.title ?? 'Untitled');
  const composer = doc.artist ?? '';
  const timeSig = doc.time ?? '4/4';
  const bpm = visualBeats(timeSig);
  const timeParts = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/) ?? ['4/4', '4', '4'];
  const beats = timeParts[1];
  const beatType = timeParts[2];
  const divisions = 1;
  const fifths = opts.includeKeySignature ? keyToFifths(doc.key ?? '') : 0;

  const measureParts: string[] = [];
  let measureIndex = 0;

  for (const section of doc.sections) {
    const bars = extractBars(section);
    if (bars.length === 0) continue;

    const label = section.label ?? '';
    const isNavLabel = NAV_RE.test(label);

    for (let bi = 0; bi < bars.length; bi++) {
      const bar = bars[bi];
      const num = ++measureIndex;

      // ── 1. <attributes> (first measure only) ────────────────────────────
      let xml = '';
      if (num === 1) {
        xml += buildFirstMeasureAttributes(beats, beatType, divisions, fifths);
        if (opts.includeTempo && doc.tempo) {
          xml += buildTempoDirection(doc.tempo);
        }
      }

      // ── 2. <direction> rehearsal mark (first bar of each named section) ──
      if (bi === 0 && label && !isNavLabel) {
        xml += buildRehearsalDirection(label, opts.useBoxedRehearsal);
      }

      // ── 3. <harmony> chord symbols ───────────────────────────────────────
      if (!bar.isSimile) {
        for (let ci = 0; ci < bar.chords.length; ci++) {
          const chordText = bar.chords[ci];
          const clean = chordText.replace(/[!^.=]$/, '').trim();
          if (!clean || clean.toUpperCase() === 'N.C.' || clean.toUpperCase() === 'NC') continue;
          const parsed = parseChordForXml(clean);
          if (!parsed) continue;
          const offset = Math.round(
            (ci / Math.max(bar.chords.length, 1)) * parseInt(beats, 10) * divisions
          );
          xml += buildHarmonyElement(parsed, offset);
        }
      }

      // ── 4. <note> slash noteheads (one per visual beat) ─────────────────
      for (let b = 0; b < bpm; b++) {
        xml += `\n      <note><pitch><step>B</step><octave>4</octave></pitch><duration>${divisions}</duration><type>quarter</type><notehead>slash</notehead></note>`;
      }

      measureParts.push(`
    <measure number="${num}">${xml}
    </measure>`);
    }
  }

  if (measureParts.length === 0) return '';

  const defaultsXml =
    opts.staffSize > 0
      ? `\n  <defaults><scaling><millimeters>${opts.staffSize}</millimeters><tenths>40</tenths></scaling></defaults>`
      : '';

  const identificationXml = composer
    ? `\n  <identification><creator type="composer">${escapeXml(composer)}</creator></identification>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">${defaultsXml}
  <movement-title>${title}</movement-title>${identificationXml}
  <part-list>
    <score-part id="P1"><part-name>Rhythm Guitar</part-name></score-part>
  </part-list>
  <part id="P1">${measureParts.join('')}
  </part>
</score-partwise>`;
}

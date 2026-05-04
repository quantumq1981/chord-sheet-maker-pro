/**
 * gpParser.ts
 *
 * Parses Guitar Pro files (.gp, .gp3, .gp4, .gp5, .gpx) into a normalized
 * ChordChartDocument using AlphaTab as the binary decoder.
 *
 * AlphaTab (~3 MB) is lazy-loaded via dynamic import so it is only fetched
 * when the user actually opens a Guitar Pro file.
 *
 * Conversion strategy
 * ───────────────────
 *  1. Load score via AlphaTab's ScoreLoader (synchronous binary parsing).
 *  2. Extract document-level metadata: title, artist, tempo.
 *  3. Identify the "lyric track": the track whose beats carry the most
 *     beat.text syllables (typically the melody or vocal line).
 *  4. Identify the "chord track": the first non-percussion track (usually the
 *     lead guitar or piano).  If it coincides with the lyric track, one pass
 *     yields both chords and lyrics.
 *  5. Walk masterBars in order.  When a Section marker appears, close the
 *     current ChartSection and start a new one (verse, chorus, etc.).
 *  6. Within each measure:
 *       • Chord source priority: beat.chord.name > fret-to-chord recognition
 *         (fret-to-chord is only attempted when ≥ 3 non-muted notes are
 *          sounding, to avoid false positives on melody runs).
 *       • Lyric source: beat.text from the lyric track; falls back to
 *         beat.text on the chord track when they are the same.
 *       • Emit a chord token whenever the chord changes.
 *       • Emit a lyric token for every non-empty beat.text.
 *       • When a lyric is present, repeat the current chord (even if
 *         unchanged) so each syllable gets an anchor in the rendered output.
 *  7. After the main chord/lyric sections, append one 'tab' section per
 *     non-percussion track containing all beats as TabColumn data.
 *     The renderer groups them into rows and formats ASCII tablature.
 *
 * AlphaTab object model notes
 * ───────────────────────────
 * All AlphaTab types are accessed as `any` to avoid pulling in the large
 * `@coderline/alphatab` type declarations at compile time (they are used only
 * at run time via the dynamic import).  Key properties used:
 *
 *   score.title / .artist / .tempo / .masterBars[] / .tracks[]
 *   track.name / .isPercussion / .staves[]
 *   staff.bars[] / .tuning (number[], index 0 = highest string)
 *   bar.voices[] / .masterBar
 *   voice.beats[] / .isEmpty
 *   beat.notes[] / .text / .chord / .isEmpty
 *   beat.chord.name (string)
 *   note.string (1-based, 1 = highest string) / .fret / .isMute / .isDead
 *   masterBar.section?.text / .section?.marker
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
  SectionType,
  TabColumn,
} from '../models/ChordChartModel';
import { fretsToChordName, STANDARD_6_STRING_TUNING } from '../utils/fretToChord';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Measures to pack into a single chord/lyric display line. */
const MEASURES_PER_LINE = 4;

/** Minimum simultaneous notes required to attempt fret-to-chord recognition. */
const MIN_NOTES_FOR_CHORD = 3;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Map a Guitar Pro section marker string to a SectionType. */
function sectionTypeFromLabel(label: string): SectionType {
  const l = label.toLowerCase();
  if (l.includes('verse')) return 'verse';
  if (l.includes('chorus') || l.includes('refrain')) return 'chorus';
  if (l.includes('bridge')) return 'bridge';
  if (l.includes('intro')) return 'intro';
  if (l.includes('outro') || l.includes('coda')) return 'outro';
  if (l.includes('solo')) return 'solo';
  if (l.includes('interlude')) return 'interlude';
  if (l.includes('pre') && l.includes('chorus')) return 'pre-chorus';
  return 'unknown';
}

/** Safely read beats from the first non-empty voice in a bar. */
function beatsFromBar(bar: any): any[] {
  if (!bar?.voices) return [];
  for (const voice of bar.voices) {
    if (!voice.isEmpty && voice.beats?.length) {
      return Array.from(voice.beats);
    }
  }
  return [];
}

/** Safely read bars from the first staff of a track. */
function barsFromTrack(track: any): any[] {
  const staff = track?.staves?.[0];
  return staff?.bars ? Array.from(staff.bars) : [];
}

/**
 * Derive the open-string MIDI notes for a staff.
 * AlphaTab exposes `staff.tuning` as an array where index 0 is the highest
 * string.  Falls back to standard 6-string tuning if absent.
 */
function staffTuning(track: any): number[] {
  const tuning = track?.staves?.[0]?.tuning;
  if (Array.isArray(tuning) && tuning.length > 0) {
    return tuning as number[];
  }
  return [...STANDARD_6_STRING_TUNING];
}

/**
 * Extract a chord name from a single beat.
 *
 * Priority order:
 *  1. Explicit chord annotation (beat.chord.name) — most reliable.
 *  2. Fret-to-chord recognition — only when ≥ MIN_NOTES_FOR_CHORD non-muted,
 *     non-dead notes are sounding (avoids tagging melody runs as chords).
 */
function chordNameFromBeat(beat: any, openMidiNotes: number[]): string | null {
  // 1. Explicit annotation
  const explicit: string | undefined = beat?.chord?.name;
  if (explicit) return explicit.trim() || null;

  // 2. Fret analysis
  const notes: any[] = beat?.notes ? Array.from(beat.notes) : [];
  const soundingNotes = notes.filter(
    (n: any) => !n.isMute && !n.isDead && typeof n.fret === 'number'
  );
  if (soundingNotes.length < MIN_NOTES_FOR_CHORD) return null;

  return fretsToChordName(
    openMidiNotes,
    soundingNotes.map((n: any) => ({
      stringIndex: (n.string as number) - 1, // AlphaTab: 1-based → 0-based
      fret: n.fret as number,
    }))
  );
}

/**
 * Find the track with the richest harmonic content by scoring:
 *   +2 per beat with an explicit chord annotation (beat.chord.name)
 *   +1 per beat with ≥3 sounding (non-muted, non-dead) notes
 * Falls back to the first non-percussion track when no track scores above 0.
 */
function findChordTrack(tracks: any[]): any {
  let bestTrack: any = null;
  let bestScore = -1;

  for (const track of tracks) {
    if (track.isPercussion) continue;
    let score = 0;
    for (const bar of barsFromTrack(track)) {
      for (const beat of beatsFromBar(bar)) {
        if (beat?.chord?.name) score += 2;
        const notes: any[] = beat?.notes ? Array.from(beat.notes) : [];
        const sounding = notes.filter(
          (n: any) => !n.isMute && !n.isDead && typeof n.fret === 'number'
        );
        if (sounding.length >= 3) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestTrack = track;
    }
  }

  return bestTrack ?? tracks.find((t: any) => !t.isPercussion) ?? tracks[0];
}

/**
 * Find the track whose beats carry the most lyric text.
 * Falls back to the chord track if nothing has lyrics.
 */
function findLyricTrack(tracks: any[], chordTrack: any): any {
  let bestTrack = chordTrack;
  let bestCount = 0;

  for (const track of tracks) {
    let count = 0;
    for (const bar of barsFromTrack(track)) {
      for (const beat of beatsFromBar(bar)) {
        if (beat?.text) count++;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestTrack = track;
    }
  }

  return bestTrack;
}

// ─── Section / line builders ──────────────────────────────────────────────────

/** One measure's worth of processed events. */
interface MeasureData {
  measureIndex: number;
  /** Ordered list of (chord?, lyric?) pairs for this measure. */
  events: Array<{ chord: string | null; lyric: string | null }>;
}

/**
 * Convert raw track bars into MeasureData, pairing the chord track
 * (for harmony) with the lyric track (for syllables).
 */
function buildMeasureData(chordBars: any[], lyricBars: any[], openMidi: number[]): MeasureData[] {
  const measures: MeasureData[] = [];
  const count = chordBars.length;

  for (let mi = 0; mi < count; mi++) {
    const cBeats = beatsFromBar(chordBars[mi]);
    const lBeats = beatsFromBar(lyricBars[mi] ?? null);
    const events: Array<{ chord: string | null; lyric: string | null }> = [];

    const beatCount = Math.max(cBeats.length, lBeats.length);
    for (let bi = 0; bi < beatCount; bi++) {
      const cBeat = cBeats[bi] ?? null;
      const lBeat = lBeats[bi] ?? null;

      const chord = cBeat ? chordNameFromBeat(cBeat, openMidi) : null;
      // Prefer lyric from the dedicated lyric track; fall back to chord track
      const lyricRaw: string = lBeat?.text || cBeat?.text || '';
      const lyric = lyricRaw.trim() || null;

      if (chord !== null || lyric !== null) {
        events.push({ chord, lyric });
      }
    }

    measures.push({ measureIndex: mi, events });
  }

  return measures;
}

/**
 * Convert a slice of MeasureData into ChartLines.
 *
 * Rules:
 *  • Group MEASURES_PER_LINE measures into one line.
 *  • Within a line: emit a chord token when the chord changes; always emit
 *    a chord token when there is a lyric (so syllables stay anchored).
 *  • Consecutive identical chords with no lyric are de-duplicated.
 */
function measureSliceToLines(measures: MeasureData[]): ChartLine[] {
  const lines: ChartLine[] = [];

  for (let li = 0; li < measures.length; li += MEASURES_PER_LINE) {
    const slice = measures.slice(li, li + MEASURES_PER_LINE);
    const tokens: ChartToken[] = [];
    let lastEmittedChord: string | null = null;

    for (const measure of slice) {
      for (const { chord, lyric } of measure.events) {
        const effectiveChord: string | null = chord ?? lastEmittedChord;

        if (lyric) {
          // Always anchor a lyric to a chord (repeat even if unchanged)
          if (effectiveChord) {
            tokens.push({ kind: 'chord', text: effectiveChord });
            lastEmittedChord = effectiveChord;
          }
          tokens.push({ kind: 'lyric', text: `${lyric} ` });
        } else if (chord && chord !== lastEmittedChord) {
          // Chord-only change: emit once
          tokens.push({ kind: 'chord', text: chord });
          lastEmittedChord = chord;
        }

        if (chord) lastEmittedChord = chord;
      }
    }

    if (tokens.length > 0) lines.push({ tokens });
  }

  return lines;
}

// ─── Tab section builder ──────────────────────────────────────────────────────

/**
 * Build a 'tab' ChartSection for a single guitar track.
 *
 * Each beat becomes one TabColumn.  Muted notes are stored as -1,
 * dead notes as -1, sounding notes as their fret number,
 * absent strings as null.
 */
function buildTabSection(track: any, _masterBars: any[]): ChartSection | null {
  const bars = barsFromTrack(track);
  if (bars.length === 0) return null;

  const tuning = staffTuning(track);
  const stringCount = tuning.length;
  const columns: TabColumn[] = [];

  for (let mi = 0; mi < bars.length; mi++) {
    for (const beat of beatsFromBar(bars[mi])) {
      // Build one column per beat
      const col: (number | null)[] = new Array(stringCount).fill(null);

      const notes: any[] = beat?.notes ? Array.from(beat.notes) : [];
      for (const note of notes) {
        const strIdx = (note.string as number) - 1; // 1-based → 0-based
        if (strIdx < 0 || strIdx >= stringCount) continue;

        if (note.isMute || note.isDead) {
          col[strIdx] = -1; // muted / dead
        } else if (typeof note.fret === 'number') {
          col[strIdx] = note.fret;
        }
      }

      // Only add the column if at least one string has data
      if (col.some((v) => v !== null)) {
        columns.push({ strings: col });
      }
    }
  }

  if (columns.length === 0) return null;

  const label = (track.name as string | undefined)?.trim() || 'Guitar Tab';

  return {
    type: 'tab',
    label,
    lines: [], // Content is in tabColumns; lines stays empty
    tabColumns: columns,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Parse Guitar Pro bytes into a ChordChartDocument.
 *
 * @throws  If AlphaTab cannot be loaded or the file cannot be parsed.
 */
export async function parseGuitarPro(bytes: Uint8Array): Promise<ChordChartDocument> {
  // ── 1. Load AlphaTab lazily ──
  let at: any;
  try {
    at = await import('@coderline/alphatab');
  } catch {
    throw new Error(
      'Could not load the Guitar Pro parser library (@coderline/alphatab). ' +
        'Check your network connection and try again.'
    );
  }

  // ── 2. Decode the score ──
  let score: any;
  try {
    const settings = new at.Settings();
    score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  } catch (err) {
    throw new Error(`Guitar Pro file could not be read: ${(err as Error).message ?? String(err)}`);
  }

  // ── 3. Document metadata ──
  const doc: ChordChartDocument = {
    title: (score.title as string | undefined)?.trim() || undefined,
    artist: (score.artist as string | undefined)?.trim() || undefined,
    tempo: typeof score.tempo === 'number' ? String(score.tempo) : undefined,
    sections: [],
    sourceFormat: 'guitarpro',
  };

  const masterBars: any[] = score.masterBars ? Array.from(score.masterBars) : [];
  const tracks: any[] = score.tracks ? Array.from(score.tracks) : [];

  if (tracks.length === 0 || masterBars.length === 0) return doc;

  // ── 4. Track selection ──
  const chordTrack = findChordTrack(tracks);
  const lyricTrack = findLyricTrack(tracks, chordTrack);

  const openMidi = staffTuning(chordTrack);
  const chordBars = barsFromTrack(chordTrack);
  const lyricBars = barsFromTrack(lyricTrack);
  const measureData = buildMeasureData(chordBars, lyricBars, openMidi);

  // ── 5. Section grouping ──
  // Walk masterBars, watching for section markers to start new sections.
  interface SectionAccum {
    label: string | undefined;
    type: SectionType;
    measures: MeasureData[];
  }

  const sectionAccums: SectionAccum[] = [];
  let current: SectionAccum = { label: undefined, type: 'unknown', measures: [] };

  for (let mi = 0; mi < masterBars.length; mi++) {
    const masterBar = masterBars[mi];
    const sectionMarker: string | undefined =
      masterBar?.section?.text?.trim() || masterBar?.section?.marker?.trim() || undefined;

    if (sectionMarker && current.measures.length > 0) {
      sectionAccums.push(current);
      current = {
        label: sectionMarker,
        type: sectionTypeFromLabel(sectionMarker),
        measures: [],
      };
    } else if (sectionMarker && current.measures.length === 0) {
      // Label the current (still-empty) section
      current.label = sectionMarker;
      current.type = sectionTypeFromLabel(sectionMarker);
    }

    if (mi < measureData.length) {
      current.measures.push(measureData[mi]);
    }
  }
  if (current.measures.length > 0) sectionAccums.push(current);

  // ── 6. Emit chord/lyric sections ──
  for (const accum of sectionAccums) {
    const lines = measureSliceToLines(accum.measures);
    if (lines.length === 0) continue;
    doc.sections.push({
      type: accum.type,
      label: accum.label,
      lines,
    });
  }

  // ── 7. Append tab sections for each guitar track ──
  for (const track of tracks) {
    if (track.isPercussion) continue;
    const tabSection = buildTabSection(track, masterBars);
    if (tabSection) doc.sections.push(tabSection);
  }

  return doc;
}

/**
 * gpParser.ts
 *
 * Parse Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx) and PowerTab (.ptb) files
 * into a ChordChartDocument using the AlphaTab library as the binary decoder.
 *
 * AlphaTab is lazy-imported so the ~3 MB library stays out of the initial
 * bundle and is only loaded when the user opens a Guitar Pro file.
 *
 * Document structure produced
 * ─────────────────────────────
 * For each named section in the score (from MasterBar.section markers):
 *   1. A chord/lyric ChartSection (type derived from the section label,
 *      lines = one ChartLine per bar with chord-change + lyric tokens).
 *   2. A 'tab' ChartSection (tabColumns = one TabColumn per beat) so the
 *      renderer can display ASCII tablature for that section.
 *
 * If the score has no section markers a single chord section + single tab
 * section cover the whole song.
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
  TabColumn,
} from '../models/ChordChartModel';
import { fretsToChordName, STANDARD_6_STRING_TUNING, type FretNote } from '../utils/fretToChord';
import { sectionTypeFromLabel } from '../utils/sectionUtils';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Count the total number of notes across all staves/bars/voices of a track. */
function countNotes(track: { staves: { bars: { voices: { beats: { notes: unknown[] }[] }[] }[] }[] }): number {
  let n = 0;
  for (const staff of track.staves)
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const beat of voice.beats)
          n += beat.notes.length;
  return n;
}

/** Count beats that carry lyric or text annotations across all staves/bars/voices. */
function countLyricBeats(
  track: { staves: { bars: { voices: { beats: { lyrics: string[] | null; text: string | null }[] }[] }[] }[] },
): number {
  let n = 0;
  for (const staff of track.staves)
    for (const bar of staff.bars)
      for (const voice of bar.voices)
        for (const beat of voice.beats)
          if (beat.lyrics?.length || beat.text) n++;
  return n;
}

/** Flush a pair of (chord/lyric section, tab section) into the document. */
function flushSectionPair(
  doc: ChordChartDocument,
  chordSec: ChartSection,
  tabCols: TabColumn[],
  tabLabel: string | undefined,
): void {
  if (chordSec.lines.length > 0) {
    doc.sections.push(chordSec);
  }
  if (tabCols.length > 0) {
    doc.sections.push({
      type: 'tab',
      label: tabLabel,
      lines: [],
      tabColumns: tabCols,
    });
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseGuitarPro(bytes: Uint8Array): Promise<ChordChartDocument> {
  // Lazy-load AlphaTab so it doesn't inflate the initial bundle.
  const at = await import('@coderline/alphatab');

  let score: ReturnType<typeof at.importer.ScoreLoader.loadScoreFromBytes>;
  try {
    score = at.importer.ScoreLoader.loadScoreFromBytes(bytes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Provide a friendlier message for unsupported sub-formats (e.g. PowerTab)
    if (msg.toLowerCase().includes('unsupported') || msg.toLowerCase().includes('format')) {
      throw new Error(
        `This file format is not supported by the Guitar Pro parser. ` +
        `Accepted formats: GP3, GP4, GP5, GPX (GP6), GP7/GP8. ` +
        `PowerTab (.ptb) is not yet supported. (${msg})`,
      );
    }
    throw new Error(`Failed to parse Guitar Pro file: ${msg}`);
  }

  const doc: ChordChartDocument = {
    sections: [],
    sourceFormat: 'guitarpro',
    title: score.title || undefined,
    artist: score.artist || undefined,
    tempo: score.tempo > 0 ? String(score.tempo) : undefined,
    subtitle: score.subTitle || undefined,
  };

  // ── Pick tracks ────────────────────────────────────────────────────────────

  const guitarTracks = score.tracks.filter((t) => !t.isPercussion);
  if (guitarTracks.length === 0) return doc;

  // Chord track = non-percussion track with the most notes.
  const chordTrack = guitarTracks.reduce(
    (best, t) => (countNotes(t) > countNotes(best) ? t : best),
    guitarTracks[0],
  );

  // Lyric track = non-percussion track with the most lyric/text beats.
  const lyricTrack = guitarTracks.reduce(
    (best, t) => (countLyricBeats(t) > countLyricBeats(best) ? t : best),
    guitarTracks[0],
  );

  const staff = chordTrack.staves[0];
  if (!staff) return doc;

  // staff.tuning: index 0 = highest-pitch string (top line of tab)
  const tuning: number[] = staff.tuning.length > 0
    ? [...staff.tuning]
    : [...STANDARD_6_STRING_TUNING];
  const numStrings = tuning.length;

  const lyricStaff = lyricTrack.staves[0];
  const numBars = Math.min(staff.bars.length, score.masterBars.length);

  // ── Process bars ───────────────────────────────────────────────────────────

  let chordSection: ChartSection = { type: 'unknown', lines: [] };
  let tabCols: TabColumn[] = [];
  let tabLabel: string | undefined;

  for (let barIdx = 0; barIdx < numBars; barIdx++) {
    const masterBar = score.masterBars[barIdx];
    const bar = staff.bars[barIdx];
    const lyricBar = lyricStaff?.bars[barIdx];

    // New section marker → flush the current pair and start fresh.
    if (masterBar.section) {
      flushSectionPair(doc, chordSection, tabCols, tabLabel);

      const sLabel = (masterBar.section.text || masterBar.section.marker).trim();
      const sType = sectionTypeFromLabel(sLabel);
      chordSection = { type: sType, label: sLabel, lines: [] };
      tabCols = [];
      tabLabel = sLabel;
    }

    // Use voice 0 (primary melody voice).
    const voice = bar.voices[0];
    const lyricVoice = lyricBar?.voices[0];
    if (!voice) continue;

    const barTokens: ChartToken[] = [];
    let lastChordInBar: string | null = null;

    for (let beatIdx = 0; beatIdx < voice.beats.length; beatIdx++) {
      const beat = voice.beats[beatIdx];
      const lyricBeat = lyricVoice?.beats[beatIdx];

      if (beat.isRest || beat.notes.length === 0) continue;

      // ── Chord name ────────────────────────────────────────────────────────

      let chordName: string | null = beat.chord?.name?.trim() || null;

      if (!chordName && beat.notes.length >= 2) {
        const fretNotes: FretNote[] = beat.notes
          // AlphaTab string 1 = lowest string = highest stringIndex
          .filter((n) => !n.isDead && n.fret !== undefined)
          .map((n) => ({ stringIndex: numStrings - n.string, fret: n.fret }));
        if (fretNotes.length >= 2) {
          chordName = fretsToChordName(tuning, fretNotes);
        }
      }

      // ── Lyric text ────────────────────────────────────────────────────────

      const rawLyrics = lyricBeat?.lyrics ?? beat.lyrics;
      const rawText = lyricBeat?.text ?? beat.text;
      const lyricText = (rawLyrics?.[0] ?? rawText ?? '').trim() || null;

      // Emit chord token only when the chord changes within the bar.
      if (chordName && chordName !== lastChordInBar) {
        barTokens.push({ kind: 'chord', text: chordName });
        lastChordInBar = chordName;
      }
      if (lyricText) {
        barTokens.push({ kind: 'lyric', text: lyricText });
      }

      // ── Tab column ────────────────────────────────────────────────────────

      const col: TabColumn = { strings: tuning.map(() => null) };
      for (const note of beat.notes) {
        // AlphaTab note.string: 1 = lowest (bottom tab line) → stringIndex = numStrings - note.string
        const si = numStrings - note.string;
        if (si >= 0 && si < numStrings) {
          col.strings[si] = note.isDead ? -1 : note.fret;
        }
      }
      tabCols.push(col);
    }

    if (barTokens.length > 0) {
      chordSection.lines.push({ tokens: barTokens } as ChartLine);
    }
  }

  // Flush the final pair.
  flushSectionPair(doc, chordSection, tabCols, tabLabel);

  return doc;
}

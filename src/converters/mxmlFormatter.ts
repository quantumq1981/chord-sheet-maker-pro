/**
 * mxmlFormatter.ts
 *
 * ChordPro text rendering functions for the MusicXML → ChordPro converter.
 * Extracted from musicXMLtochordpro.ts (Sprint 5, item 3.2).
 */

import type { MeasureData, LyricEvent, ConvertOptions, ChordBracketStyle } from './mxmlTypes';

interface MeasureGroup {
  sectionLabel?: string;
  measures: MeasureData[];
}

export function renderLyricsInline(
  measures: MeasureData[],
  verseKeys: string[],
  options: ConvertOptions
): string[] {
  const lines: string[] = [];

  verseKeys.forEach((verse, verseIdx) => {
    const measureTexts = measures.map((measure) => {
      const lyrics = measure.lyricsByVerse[verse] ?? [];
      return renderSingleMeasureLyrics(measure, lyrics, options);
    });

    if (verseKeys.length > 1) {
      lines.push('{start_of_verse}');
      lines.push(`{comment: Verse ${verse}}`);
    }

    lines.push(...emitWrappedBars(measureTexts, options));

    if (verseKeys.length > 1) {
      lines.push('{end_of_verse}');
      if (verseIdx < verseKeys.length - 1) {
        lines.push('');
      }
    }
  });

  return lines;
}

export function renderGrid(
  measures: MeasureData[],
  options: ConvertOptions,
  warnings: string[],
  timeSignature?: string
): string[] {
  const slotsPerMeasure = resolveGridSlotsPerMeasure(options, timeSignature);
  let measuresWithMultipleChords = 0;
  let totalCollisions = 0;
  const droppedChordNames: string[] = [];

  const measureTexts = measures.map((measure) => {
    const slots = Array(slotsPerMeasure).fill('.');
    const harmonies = [...measure.harmonies].sort((a, b) => a.offsetDivisions - b.offsetDivisions);
    if (harmonies.length > 1) {
      measuresWithMultipleChords += 1;
    }

    for (const harmony of harmonies) {
      const slotIndexRaw =
        measure.durationDivisions > 0
          ? Math.floor(
              (harmony.offsetDivisions / Math.max(1, measure.durationDivisions)) * slotsPerMeasure
            )
          : 0;
      const slotIndex = Math.max(0, Math.min(slotsPerMeasure - 1, slotIndexRaw));
      if (slots[slotIndex] !== '.') {
        totalCollisions += 1;
        droppedChordNames.push(harmony.chordText);
        continue;
      }
      slots[slotIndex] = `[${harmony.chordText}]`;
    }

    return slots.join(' ');
  });

  if (measuresWithMultipleChords > 0) {
    warnings.push(
      `Grid quantized to ${slotsPerMeasure} slots/measure; ${measuresWithMultipleChords} measure${measuresWithMultipleChords > 1 ? 's' : ''} contain multiple chord changes.`
    );
  }
  if (totalCollisions > 0) {
    const preview =
      droppedChordNames.length <= 6
        ? droppedChordNames.join(', ')
        : `${droppedChordNames.slice(0, 6).join(', ')} … (${droppedChordNames.length - 6} more)`;
    warnings.push(
      `${totalCollisions} chord${totalCollisions > 1 ? 's' : ''} dropped due to grid slot collisions (${preview}). Switch to lyrics-inline mode or increase grid resolution.`
    );
  }

  return ['{start_of_grid}', ...emitWrappedBars(measureTexts, options), '{end_of_grid}'];
}

export function resolveGridSlotsPerMeasure(
  options: ConvertOptions,
  timeSignature?: string
): number {
  const configuredSlots = options.gridSlotsPerMeasure;
  if (Number.isFinite(configuredSlots) && configuredSlots != null && configuredSlots > 0) {
    return Math.floor(configuredSlots);
  }

  if (!timeSignature) {
    return 4;
  }

  const [beatsText] = timeSignature.split('/');
  const beats = Number.parseInt(beatsText, 10);
  if (!Number.isFinite(beats) || beats <= 0) {
    return 4;
  }

  // MVP: use the top number directly (e.g., 6/8 => 6 slots).
  return beats;
}

export function emitWrappedBars(measureTexts: string[], options: ConvertOptions): string[] {
  if (measureTexts.length === 0) {
    return [];
  }

  const barsPerLine = Math.max(1, Math.floor(options.barsPerLine || 4));
  const usePipes = options.barlineStyle === 'pipes';
  const chunkSize = options.wrapPolicy === 'no-wrap' ? measureTexts.length : barsPerLine;
  const lines: string[] = [];

  for (let idx = 0; idx < measureTexts.length; idx += chunkSize) {
    const chunk = measureTexts.slice(idx, idx + chunkSize);
    if (usePipes) {
      lines.push(`| ${chunk.join(' | ')} |`);
    } else {
      lines.push(chunk.join('  '));
    }
  }

  return lines;
}

export function renderSingleMeasureLyrics(
  measure: MeasureData,
  lyricEvents: LyricEvent[],
  options: ConvertOptions
): string {
  if (lyricEvents.length === 0) {
    const fallbackChord = measure.harmonies[0]?.chordText;
    return fallbackChord ? `[${fallbackChord}]` : '';
  }

  const sortedLyrics = [...lyricEvents].sort((a, b) => a.offsetDivisions - b.offsetDivisions);
  const sortedHarmonies = [...measure.harmonies].sort(
    (a, b) => a.offsetDivisions - b.offsetDivisions
  );

  const chordBucket = new Map<number, string[]>();
  let carryIndex = 0;

  for (const harmony of sortedHarmonies) {
    while (
      carryIndex < sortedLyrics.length - 1 &&
      sortedLyrics[carryIndex].offsetDivisions < harmony.offsetDivisions
    ) {
      carryIndex += 1;
    }
    const list = chordBucket.get(carryIndex) ?? [];
    list.push(harmony.chordText);
    chordBucket.set(carryIndex, list);
  }

  const tokens: string[] = [];
  sortedLyrics.forEach((lyric, lyricIdx) => {
    const attached = chordBucket.get(lyricIdx) ?? [];
    const prefix =
      attached.length === 0 ? '' : formatChordPrefix(attached, options.chordBracketStyle);
    const suffix = lyric.syllabic === 'begin' || lyric.syllabic === 'middle' ? '-' : '';
    const token = `${prefix}${lyric.text}${suffix}`;
    tokens.push(token);
  });

  const joined = tokens.join(' ');
  return options.normalizeWhitespace ? joined.replace(/\s+/g, ' ').trim() : joined;
}

/**
 * Split an ordered list of measures into contiguous groups, starting a new
 * group each time a measure carries a `sectionLabel`.  Measures without a
 * label continue in the current group.
 */
export function groupBySection(measures: MeasureData[]): MeasureGroup[] {
  if (measures.length === 0) {
    return [];
  }

  const groups: MeasureGroup[] = [];
  let current: MeasureGroup = { measures: [] };

  for (const measure of measures) {
    if (measure.sectionLabel !== undefined && current.measures.length > 0) {
      // Flush the current group and start a new one at this section boundary.
      groups.push(current);
      current = { sectionLabel: measure.sectionLabel, measures: [] };
    } else if (measure.sectionLabel !== undefined && current.sectionLabel === undefined) {
      // First measure carries a label — annotate the current (still empty) group.
      current.sectionLabel = measure.sectionLabel;
    }
    current.measures.push(measure);
  }

  if (current.measures.length > 0) {
    groups.push(current);
  }

  return groups;
}

export function formatChordPrefix(chords: string[], style: ChordBracketStyle): string {
  if (chords.length === 0) {
    return '';
  }
  if (style === 'combined') {
    return `[${chords.join(' ')}]`;
  }
  return chords.map((chord) => `[${chord}]`).join('');
}

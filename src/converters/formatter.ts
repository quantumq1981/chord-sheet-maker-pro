import type {
  ConvertOptions,
  ConverterDiagnostics,
  MeasureData,
  LyricEvent,
  ChordBracketStyle,
} from './types';

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

export function resolveMeasureOrder(
  measures: MeasureData[],
  options: ConvertOptions,
  warnings: string[],
  diagnostics: ConverterDiagnostics
): number[] {
  const baseOrder = measures.map((measure) => measure.measureIndex);

  if (options.repeatStrategy === 'none') {
    return baseOrder;
  }

  if (options.repeatStrategy === 'simple-unroll') {
    if (diagnostics.endingsFound > 0) {
      warnings.push(
        'Repeat endings (volta brackets) found but not supported by Simple Unroll — switch to Full Unroll for volta expansion.'
      );
      return baseOrder;
    }

    const startIdx = measures.findIndex((measure) => measure.repeatStart);
    if (startIdx < 0) {
      return baseOrder;
    }
    const endIdx = measures.findIndex((measure, index) => index > startIdx && measure.repeatEnd);
    if (endIdx < 0) {
      return baseOrder;
    }

    const duplicatedRange = baseOrder.slice(startIdx, endIdx + 1);
    return [...baseOrder.slice(0, endIdx + 1), ...duplicatedRange, ...baseOrder.slice(endIdx + 1)];
  }

  if (options.repeatStrategy === 'full-unroll') {
    return fullUnrollWithVolta(measures, warnings);
  }

  return baseOrder;
}

/**
 * Volta-aware repeat unroller.
 *
 * Processes the measure list in order and, whenever it encounters a
 * repeat-start barline, it:
 *   1. Locates the matching backward-repeat barline (`repeatEnd`).
 *   2. Scans forward past that barline to collect any additional volta-bracket
 *      measures (MusicXML often places 2nd-ending measures after the backward
 *      barline in source order).
 *   3. Splits the section into a *body* (measures with no ending markers) and
 *      per-ending groups (keyed by the ending number in `MeasureData.endings`).
 *   4. Emits one pass for each ending number in ascending order:
 *        body + ending-1 measures, then body + ending-2 measures, etc.
 *   5. For sections with no endings at all the section is simply doubled.
 *
 * Nested repeats and edge cases (missing repeat-end, etc.) fall back to
 * including the affected measures in source order with a warning.
 */
function fullUnrollWithVolta(measures: MeasureData[], warnings: string[]): number[] {
  const result: number[] = [];
  let i = 0;
  let expansionCount = 0;

  while (i < measures.length) {
    const measure = measures[i];

    if (!measure.repeatStart) {
      result.push(measure.measureIndex);
      i++;
      continue;
    }

    const repeatStartIdx = i;
    let repeatEndIdx = -1;
    for (let j = i; j < measures.length; j++) {
      if (measures[j].repeatEnd) {
        repeatEndIdx = j;
        break;
      }
    }

    if (repeatEndIdx < 0) {
      warnings.push(
        `Repeat section starting at measure ${measure.measureIndex + 1} has no matching end barline; emitted once.`
      );
      result.push(measure.measureIndex);
      i++;
      continue;
    }

    let sectionEndIdx = repeatEndIdx;
    for (let j = repeatEndIdx + 1; j < measures.length; j++) {
      if (measures[j].endings && measures[j].endings!.length > 0) {
        sectionEndIdx = j;
      } else {
        break;
      }
    }

    const sectionMeasures = measures.slice(repeatStartIdx, sectionEndIdx + 1);
    const firstEndingOffset = sectionMeasures.findIndex((m) => m.endings && m.endings.length > 0);

    if (firstEndingOffset < 0) {
      const indices = sectionMeasures.map((m) => m.measureIndex);
      result.push(...indices, ...indices);
      expansionCount++;
      i = sectionEndIdx + 1;
      continue;
    }

    const body = sectionMeasures.slice(0, firstEndingOffset).map((m) => m.measureIndex);
    const endingGroups = new Map<number, number[]>();
    for (const m of sectionMeasures) {
      if (!m.endings || m.endings.length === 0) {
        continue;
      }
      for (const endNum of m.endings) {
        const group = endingGroups.get(endNum) ?? [];
        group.push(m.measureIndex);
        endingGroups.set(endNum, group);
      }
    }

    const sortedEndingNums = [...endingGroups.keys()].sort((a, b) => a - b);
    for (const endNum of sortedEndingNums) {
      result.push(...body, ...(endingGroups.get(endNum) ?? []));
    }

    expansionCount++;
    i = sectionEndIdx + 1;
  }

  if (expansionCount > 0) {
    warnings.push(
      `${expansionCount} repeat section${expansionCount > 1 ? 's' : ''} fully expanded (volta-aware).`
    );
  }

  return result;
}

export function groupBySection(measures: MeasureData[]): MeasureGroup[] {
  if (measures.length === 0) {
    return [];
  }

  const groups: MeasureGroup[] = [];
  let current: MeasureGroup = { measures: [] };

  for (const measure of measures) {
    if (measure.sectionLabel !== undefined && current.measures.length > 0) {
      groups.push(current);
      current = { sectionLabel: measure.sectionLabel, measures: [] };
    } else if (measure.sectionLabel !== undefined && current.sectionLabel === undefined) {
      current.sectionLabel = measure.sectionLabel;
    }
    current.measures.push(measure);
  }

  if (current.measures.length > 0) {
    groups.push(current);
  }

  return groups;
}

function renderSingleMeasureLyrics(
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

function emitWrappedBars(measureTexts: string[], options: ConvertOptions): string[] {
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

function resolveGridSlotsPerMeasure(options: ConvertOptions, timeSignature?: string): number {
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

  return beats;
}

function formatChordPrefix(chords: string[], style: ChordBracketStyle): string {
  if (chords.length === 0) {
    return '';
  }
  if (style === 'combined') {
    return `[${chords.join(' ')}]`;
  }
  return chords.map((chord) => `[${chord}]`).join('');
}

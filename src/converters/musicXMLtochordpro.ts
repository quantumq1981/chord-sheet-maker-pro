/**
 * musicXMLtochordpro.ts
 *
 * Pipeline orchestrator: MusicXML → ChordPro conversion.
 * Delegates XML parsing to mxmlXmlParser and text rendering to mxmlFormatter.
 * Split from a 1,309-line monolith in Sprint 5 (item 3.2).
 *
 * Public API is fully re-exported here for backward compatibility.
 */

import JSZip from 'jszip';

// Re-export all public types and helpers so callers import from this module as before.
export type {
  PageSize,
  ChordProFormatMode,
  RepeatStrategy,
  ChordBracketStyle,
  BarlineStyle,
  MeasureWrapPolicy,
  KeySignaturePolicy,
  TimeSignaturePolicy,
  MetadataPolicy,
  ConvertOptions,
  ConvertInput,
  ConvertOutput,
  ConverterDiagnostics,
  HarmonyEvent,
  LyricEvent,
  MeasureData,
  MeasureRenderResult,
} from './mxmlTypes';
export { getDefaultConvertOptions } from './mxmlTypes';

import { getDefaultConvertOptions } from './mxmlTypes';
import type { ConvertOptions, ConvertInput, ConvertOutput, ConverterDiagnostics, MeasureData } from './mxmlTypes';
import {
  parseMetadata,
  selectLyricPart,
  buildMeasureData,
  detectAttributeChanges,
  detectPickupBar,
} from './mxmlXmlParser';
import { groupBySection, renderLyricsInline, renderGrid } from './mxmlFormatter';

export async function extractMusicXmlTextFromFile(file: File): Promise<{
  filename: string;
  xmlText: string;
  isMxl: boolean;
}> {
  const filename = file.name;
  const isMxl = filename.toLowerCase().endsWith('.mxl');

  if (!isMxl) {
    return { filename, xmlText: await file.text(), isMxl: false };
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) {
    throw new Error('Invalid MXL: META-INF/container.xml was not found.');
  }

  const containerText = await containerEntry.async('text');
  const containerDoc = new DOMParser().parseFromString(containerText, 'application/xml');
  const parserError = containerDoc.querySelector('parsererror');
  if (parserError) {
    throw new Error('Invalid MXL: container.xml could not be parsed.');
  }

  const rootfile = containerDoc.querySelector('rootfile');
  const rootPath = rootfile?.getAttribute('full-path')?.trim();
  if (!rootPath) {
    throw new Error('Invalid MXL: rootfile full-path not found in container.xml.');
  }

  const scoreEntry = zip.file(rootPath);
  if (!scoreEntry) {
    throw new Error(`Invalid MXL: score file '${rootPath}' not found.`);
  }

  return {
    filename,
    xmlText: await scoreEntry.async('text'),
    isMxl: true,
  };
}

export function convertMusicXmlToChordPro(
  input: ConvertInput,
  options?: Partial<ConvertOptions>
): ConvertOutput {
  const mergedOptions = { ...getDefaultConvertOptions(), ...(options ?? {}) };
  const warnings: string[] = [];

  const diagnostics: ConverterDiagnostics = {
    filename: input.filename,
    timestampIso: new Date().toISOString(),
    isMxl: input.filename?.toLowerCase().endsWith('.mxl') ?? false,
    partsCount: 0,
    measuresCount: 0,
    versesDetected: [],
    hasAnyLyrics: false,
    hasAnyHarmony: false,
    repeatMarkersFound: 0,
    endingsFound: 0,
    barsPerLine: mergedOptions.barsPerLine,
    formatModeResolved: 'grid-only',
    keyChanges: 0,
    timeChanges: 0,
    hasPickupBar: false,
    sectionsDetected: [],
  };

  try {
    const xmlDoc = new DOMParser().parseFromString(input.xmlText, 'application/xml');
    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
      throw new Error('XML parse error: ' + (parserError.textContent ?? 'unknown'));
    }

    const parts = [...xmlDoc.querySelectorAll('score-partwise > part')];
    diagnostics.partsCount = parts.length;

    const metadata = parseMetadata(xmlDoc);
    diagnostics.title = metadata.title;
    diagnostics.composer = metadata.composer;
    diagnostics.key = metadata.key;
    diagnostics.time = metadata.time;
    diagnostics.tempo = metadata.tempo;

    const selectedLyricPartId = selectLyricPart(xmlDoc);
    diagnostics.selectedLyricPartId = selectedLyricPartId;

    const measures = buildMeasureData(xmlDoc, selectedLyricPartId);
    diagnostics.measuresCount = measures.length;

    const attrChanges = detectAttributeChanges(xmlDoc);
    diagnostics.keyChanges = attrChanges.keyChanges;
    diagnostics.timeChanges = attrChanges.timeChanges;
    diagnostics.hasPickupBar = detectPickupBar(measures);

    if (attrChanges.keyChanges > 0) {
      warnings.push(
        `Mid-song key change detected (${attrChanges.keyChanges} change${attrChanges.keyChanges > 1 ? 's' : ''}); only the opening key is reflected in the output.`
      );
    }
    if (attrChanges.timeChanges > 0) {
      warnings.push(
        `Mid-song time signature change detected (${attrChanges.timeChanges} change${attrChanges.timeChanges > 1 ? 's' : ''}); grid quantization uses the opening time signature.`
      );
    }
    if (diagnostics.hasPickupBar) {
      warnings.push(
        'First measure appears to be a pickup/anacrusis bar (shorter than subsequent measures).'
      );
    }

    const verseSet = new Set<string>();
    let hasAnyLyrics = false;
    let hasAnyHarmony = false;
    let repeatMarkersFound = 0;
    let endingsFound = 0;

    for (const measure of measures) {
      if (measure.repeatStart || measure.repeatEnd) {
        repeatMarkersFound += 1;
      }
      if (measure.endings && measure.endings.length > 0) {
        endingsFound += measure.endings.length;
      }
      if (measure.harmonies.length > 0) {
        hasAnyHarmony = true;
      }
      for (const [verseKey, events] of Object.entries(measure.lyricsByVerse)) {
        if (events.length > 0) {
          hasAnyLyrics = true;
          verseSet.add(verseKey);
        }
      }
    }

    diagnostics.versesDetected = [...verseSet].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true })
    );
    diagnostics.hasAnyLyrics = hasAnyLyrics;
    diagnostics.hasAnyHarmony = hasAnyHarmony;
    diagnostics.repeatMarkersFound = repeatMarkersFound;
    diagnostics.endingsFound = endingsFound;

    const measureOrder = resolveMeasureOrder(measures, mergedOptions, warnings, diagnostics);
    const orderedMeasures = measureOrder
      .map((i) => measures[i])
      .filter((m): m is MeasureData => Boolean(m));

    const formatModeResolved =
      mergedOptions.formatMode === 'auto'
        ? hasAnyLyrics
          ? 'lyrics-inline'
          : 'grid-only'
        : mergedOptions.formatMode;
    diagnostics.formatModeResolved = formatModeResolved;

    if (!hasAnyHarmony) {
      warnings.push('no harmony found');
    }
    if (!hasAnyLyrics && formatModeResolved !== 'grid-only') {
      warnings.push('no lyrics found');
    }

    const lines: string[] = [];
    if (mergedOptions.metadataPolicy === 'emit') {
      if (metadata.title) {
        lines.push(`{title: ${metadata.title}}`);
      }
      // Use {artist:} — the canonical ChordPro directive — rather than
      // {composer:} which parsers outside this project won't recognise.
      if (metadata.composer) {
        lines.push(`{artist: ${metadata.composer}}`);
      }
      if (mergedOptions.keyPolicy === 'emit-if-known' && metadata.key) {
        lines.push(`{key: ${metadata.key}}`);
      }
      if (mergedOptions.timePolicy === 'emit-if-known' && metadata.time) {
        lines.push(`{time: ${metadata.time}}`);
      }
      if (metadata.tempo) {
        lines.push(`{tempo: ${metadata.tempo}}`);
      }
    }

    // Group measures by section label so each section gets its own header comment.
    const measureGroups = groupBySection(orderedMeasures);
    const sectionLabelSet = new Set<string>();
    for (const m of orderedMeasures) {
      if (m.sectionLabel) {
        sectionLabelSet.add(m.sectionLabel);
      }
    }
    diagnostics.sectionsDetected = [...sectionLabelSet].sort();

    if (formatModeResolved === 'lyrics-inline') {
      const verseKeys = diagnostics.versesDetected.length > 0 ? diagnostics.versesDetected : ['1'];

      for (let gi = 0; gi < measureGroups.length; gi++) {
        const group = measureGroups[gi];
        const rendered = renderLyricsInline(group.measures, verseKeys, mergedOptions);
        if (rendered.length === 0) {
          continue;
        }
        if (lines.length > 0) {
          lines.push('');
        }
        if (group.sectionLabel) {
          lines.push(`{comment: ${group.sectionLabel}}`);
        }
        lines.push(...rendered);
      }
    } else {
      for (let gi = 0; gi < measureGroups.length; gi++) {
        const group = measureGroups[gi];
        const rendered = renderGrid(group.measures, mergedOptions, warnings, metadata.time);
        if (rendered.length === 0) {
          continue;
        }
        if (lines.length > 0) {
          lines.push('');
        }
        if (group.sectionLabel) {
          lines.push(`{comment: ${group.sectionLabel}}`);
        }
        lines.push(...rendered);
      }
    }

    if (
      mergedOptions.repeatStrategy === 'none' &&
      repeatMarkersFound > 0 &&
      mergedOptions.annotateUnexpandedRepeats
    ) {
      warnings.push('repeats present but not expanded');
      lines.push('% Repeats in the original score are not expanded.');
    }

    if (lines.length === 0) {
      lines.push('{title: Untitled}');
    }

    return {
      chordPro: lines.join('\n'),
      warnings,
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown conversion failure';
    return {
      chordPro: '{title: Untitled}\n% Failed to convert MusicXML.',
      warnings,
      error: message,
      diagnostics,
    };
  }
}

function resolveMeasureOrder(
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
    // Legacy path: bail out when volta endings are present.
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

    // Locate the first backward-repeat barline after this repeat-start.
    const repeatStartIdx = i;
    let repeatEndIdx = -1;
    for (let j = i; j < measures.length; j++) {
      if (measures[j].repeatEnd) {
        repeatEndIdx = j;
        break;
      }
    }

    if (repeatEndIdx < 0) {
      // No matching repeat-end — emit as-is and keep scanning.
      warnings.push(
        `Repeat section starting at measure ${measure.measureIndex + 1} has no matching end barline; emitted once.`
      );
      result.push(measure.measureIndex);
      i++;
      continue;
    }

    // Scan past the backward-repeat barline to include any trailing
    // volta-bracket measures (e.g. the 2nd-ending block that follows).
    let sectionEndIdx = repeatEndIdx;
    for (let j = repeatEndIdx + 1; j < measures.length; j++) {
      if (measures[j].endings && measures[j].endings!.length > 0) {
        sectionEndIdx = j;
      } else {
        break;
      }
    }

    const sectionMeasures = measures.slice(repeatStartIdx, sectionEndIdx + 1);

    // Find where volta endings first appear within this section.
    const firstEndingOffset = sectionMeasures.findIndex((m) => m.endings && m.endings.length > 0);

    if (firstEndingOffset < 0) {
      // No endings — simple double (play the section twice).
      const indices = sectionMeasures.map((m) => m.measureIndex);
      result.push(...indices, ...indices);
      expansionCount++;
      i = sectionEndIdx + 1;
      continue;
    }

    // Body = measures before the first ending bracket.
    const body = sectionMeasures.slice(0, firstEndingOffset).map((m) => m.measureIndex);

    // Group measures by ending number (a measure can appear in multiple groups
    // when its endings[] contains multiple values, e.g. [1, 2]).
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

    // Emit one pass per ending: body + ending-N measures.
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

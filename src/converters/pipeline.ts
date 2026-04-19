import JSZip from 'jszip';
import type { ConvertInput, ConvertOptions, ConvertOutput, ConverterDiagnostics } from './types';
import {
  parseMetadata,
  selectLyricPart,
  buildMeasureData,
  detectAttributeChanges,
  detectPickupBar,
} from './xmlParser';
import { renderLyricsInline, renderGrid, resolveMeasureOrder, groupBySection } from './formatter';

export * from './types';

export function getDefaultConvertOptions(): ConvertOptions {
  return {
    barsPerLine: 4,
    barlineStyle: 'pipes',
    wrapPolicy: 'bars-per-line',
    chordBracketStyle: 'separate',
    formatMode: 'auto',
    repeatStrategy: 'none',
    annotateUnexpandedRepeats: true,
    metadataPolicy: 'emit',
    keyPolicy: 'emit-if-known',
    timePolicy: 'emit-if-known',
    normalizeWhitespace: true,
  };
}

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

  const xmlDoc = new DOMParser().parseFromString(input.xmlText, 'application/xml');
  const parseIssue = xmlDoc.querySelector('parsererror');

  const diagnostics: ConverterDiagnostics = {
    filename: input.filename,
    timestampIso: new Date().toISOString(),
    isMxl: Boolean(input.filename?.toLowerCase().endsWith('.mxl')),
    partsCount: xmlDoc.querySelectorAll('score-partwise > part').length,
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

  if (parseIssue) {
    return {
      chordPro: '{title: Untitled}\n% Failed to parse MusicXML.',
      warnings,
      error: 'MusicXML parser error',
      diagnostics,
    };
  }

  try {
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
      .filter((m): m is (typeof measures)[number] => Boolean(m));

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

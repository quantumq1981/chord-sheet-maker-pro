import type { SourceFormat } from './sniffFormat';
import type { ChordChartDocument } from '../models/ChordChartModel';
import { parseChordChart } from '../parsers/chordProParser';
import { normalizeAbcForImport } from './abcNormalization';
import { scoreImportQuality } from './importQuality';
import { canonicalizeChordChartDocument } from './canonicalChart';
import { tryConvertAbcToMusicXmlViaNotaGen } from './notagenBridge';
import {
  convertMusicXmlToChordPro,
  getDefaultConvertOptions,
} from '../converters/musicXMLtochordpro';

export interface ImportPipelineResult {
  document: ChordChartDocument;
  normalizedAbcText?: string;
  originalAbcText?: string;
}

const ABC_FALLBACK_THRESHOLD = 60;

export async function importWithNotaGenPipeline(
  text: string,
  sourceFormat: SourceFormat,
  filename: string
): Promise<ImportPipelineResult> {
  if (sourceFormat !== 'abc') {
    const baseDoc = canonicalizeChordChartDocument(parseChordChart(text, sourceFormat));
    const quality = scoreImportQuality(baseDoc);
    baseDoc.importQuality = {
      score: quality.score,
      warnings: quality.warnings,
      strategy: 'direct',
    };
    baseDoc.importDiagnostics = quality.diagnostics;
    return { document: baseDoc };
  }

  const normalized = normalizeAbcForImport(text);
  let doc = canonicalizeChordChartDocument(parseChordChart(normalized.normalizedText, 'abc'));
  let quality = scoreImportQuality(doc);
  const diagnostics = [...quality.diagnostics];

  if (normalized.changed) diagnostics.unshift('ABC text was normalized before parse.');
  for (const note of normalized.notes) diagnostics.push(note);

  if (quality.score < ABC_FALLBACK_THRESHOLD) {
    const fallbackXml = await tryConvertAbcToMusicXmlViaNotaGen(normalized.normalizedText);
    if (fallbackXml) {
      const conversion = convertMusicXmlToChordPro(
        { filename: filename || 'import.abc', xmlText: fallbackXml },
        getDefaultConvertOptions()
      );
      if (!conversion.error) {
        const fallbackDoc = canonicalizeChordChartDocument(
          parseChordChart(conversion.chordPro, 'chordpro')
        );
        const fallbackQuality = scoreImportQuality(fallbackDoc);
        if (fallbackQuality.score >= quality.score) {
          doc = fallbackDoc;
          quality = fallbackQuality;
          diagnostics.push(`Fallback ABC→MusicXML→ChordPro selected (${fallbackQuality.score}).`);
          diagnostics.push(...conversion.warnings);
          doc.sourceFormat = 'abc';
          doc.importQuality = {
            score: fallbackQuality.score,
            warnings: fallbackQuality.warnings,
            strategy: 'abc-via-musicxml-fallback',
          };
        }
      }
    }
  }

  if (!doc.importQuality) {
    doc.importQuality = { score: quality.score, warnings: quality.warnings, strategy: 'direct' };
  }
  doc.importDiagnostics = [...(doc.importDiagnostics ?? []), ...diagnostics];

  return {
    document: doc,
    normalizedAbcText: normalized.changed ? normalized.normalizedText : undefined,
    originalAbcText: normalized.changed ? text : undefined,
  };
}

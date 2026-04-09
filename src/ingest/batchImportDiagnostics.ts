import { sniffFormatFromText, asSourceFormat } from './sniffFormat';
import type { SourceFormat } from './sniffFormat';
import { importWithNotaGenPipeline } from './notagenImportPipeline';

export interface BatchImportInput {
  filename: string;
  text: string;
  sourceFormat?: SourceFormat;
}

export interface BatchImportRow {
  filename: string;
  title: string;
  key: string;
  tempo: string;
  time: string;
  sourceFormat: string;
  confidence: number;
  warnings: string;
}

export async function batchImportWithDiagnostics(files: BatchImportInput[]) {
  const rows: BatchImportRow[] = [];
  const diagnostics: string[] = [];

  for (const file of files) {
    const detected =
      file.sourceFormat ?? asSourceFormat(sniffFormatFromText(file.text)) ?? 'chordpro';
    const result = await importWithNotaGenPipeline(file.text, detected, file.filename);
    const doc = result.document;
    const quality = doc.importQuality;

    rows.push({
      filename: file.filename,
      title: doc.title ?? 'Untitled',
      key: doc.key ?? 'C',
      tempo: doc.tempo ?? '',
      time: doc.time ?? '4/4',
      sourceFormat: detected,
      confidence: quality?.score ?? 0,
      warnings: (quality?.warnings ?? []).join(' | '),
    });

    diagnostics.push(
      JSON.stringify({
        filename: file.filename,
        sourceFormat: detected,
        importQuality: quality,
        importDiagnostics: doc.importDiagnostics ?? [],
        sections: doc.sections.length,
      })
    );
  }

  const csvHeader = [
    'filename',
    'title',
    'key',
    'tempo',
    'time',
    'source_format',
    'confidence',
    'warnings',
  ];
  const csvRows = rows.map((row) =>
    [
      row.filename,
      row.title,
      row.key,
      row.tempo,
      row.time,
      row.sourceFormat,
      String(row.confidence),
      row.warnings,
    ]
      .map((cell) => `"${cell.replace(/"/g, '""')}"`)
      .join(',')
  );

  return {
    rows,
    diagnosticsJsonl: diagnostics.join('\n'),
    csv: [csvHeader.join(','), ...csvRows].join('\n'),
  };
}

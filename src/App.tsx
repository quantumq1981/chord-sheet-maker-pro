import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  sniffFormatFromBytes,
  isMusicXmlFormat,
  isChordChartFormat,
  isGuitarProFormat,
  isPdfFormat,
  isSvgFormat,
  asSourceFormat,
} from './ingest/sniffFormat';
import { extractMusicXmlTextFromFile } from './converters/musicXMLtochordpro';
import { parseChordChart } from './parsers/chordProParser';
import { parseCsmpn } from './parsers/csmpnParser';
import { serializeChordProDocument } from './parsers/serializeChordPro';
import type { ChordChartDocument } from './models/ChordChartModel';
import ChordChart from './renderers/ChordChart';
import SlashNotationView from './renderers/SlashNotationView';
import { canonicalizeChordChartDocument } from './ingest/canonicalChart';
import { importWithNotaGenPipeline } from './ingest/notagenImportPipeline';
import type { ImportQualityResult } from './ingest/importQuality';
import UGProImporterPanel from './components/UGProImporterPanel';
import OemerImageImporterPanel from './components/OemerImageImporterPanel';
import SvgImporterPanel from './components/SvgImporterPanel';
import { ImportErrorBoundary, SlashNotationBoundary } from './components/ErrorBoundary';
import { useOsmdRenderer } from './hooks/useOsmdRenderer';
import { useExportActions } from './hooks/useExportActions';
import type { AppMode, ChordProModeUi, ChordProBracketUi, ChordProRepeatUi } from './types/appTypes';

// ─── File-accept string ───────────────────────────────────────────────────────

const FILE_INPUT_ACCEPT = [
  // SVG vector graphics
  '.svg',
  'image/svg+xml',
  // MusicXML / MXL
  '.xml',
  '.musicxml',
  '.mxl',
  'application/vnd.recordare.musicxml+xml',
  'application/xml',
  'text/xml',
  'application/zip',
  // Guitar Pro (binary GP3-GP5 and ZIP-based GPX/GP7)
  '.gp',
  '.gp3',
  '.gp4',
  '.gp5',
  '.gpx',
  // ChordPro dialects
  '.cho',
  '.chopro',
  '.chord',
  '.crd',
  '.pro',
  // Generic text (UG-style, chords-over-words)
  '.txt',
  // ABC notation (folk / traditional music)
  '.abc',
  // Guitar Pro (GP3–GP5 binary, GP6 GPX, GP7/8 GP) and PowerTab
  '.gp',
  '.gp3',
  '.gp4',
  '.gp5',
  '.gpx',
  '.ptb',
  // PDF (UG exports, chord sheets exported from notation apps, etc.)
  '.pdf',
  'application/pdf',
].join(',');

// OSMD helpers, general helpers, and export actions extracted to src/utils/osmdHelpers.ts
// and src/hooks/useExportActions.ts respectively.

function deriveProFilename(loadedFilename: string): string {
  const trimmed = loadedFilename.trim();
  if (!trimmed) return 'song.pro';
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.musicxml')) return `${trimmed.slice(0, -'.musicxml'.length)}.pro`;
  if (lower.endsWith('.xml') || lower.endsWith('.mxl')) return `${trimmed.slice(0, -4)}.pro`;
  const dot = trimmed.lastIndexOf('.');
  return dot > 0 ? `${trimmed.slice(0, dot)}.pro` : `${trimmed}.pro`;
}

function serializeChordProFromDocument(doc: ChordChartDocument, transposeSteps: number): string {
  return serializeChordProDocument(doc, transposeSteps);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

// ─── Main component ───────────────────────────────────────────────────────────

export default function App() {
  // ── Mode ──
  const [appMode, setAppMode] = useState<AppMode>('empty');

  // ── Shared ──
  const [loadedFilename, setLoadedFilename] = useState('');
  const [renderError, setRenderError] = useState('');
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);

  // ── Notation (OSMD) mode — delegated to useOsmdRenderer ──
  const {
    containerRef, osmdRef,
    loadedXmlText, setLoadedXmlText,
    isMxl, setIsMxl,
    renderedPageCount,
    diagnostics,
    fitWidth, adjustZoom,
    resetAutoFit, clearOsmd,
  } = useOsmdRenderer({ setRenderError });

  // Tracks nested dragenter/dragleave events so child elements don't falsely
  // clear the `isDragging` visual state.
  const dragDepthRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);

  // ── Chord-chart mode state ──
  const [chartDocument, setChartDocument] = useState<ChordChartDocument | null>(null);
  const [transposeSteps, setTransposeSteps] = useState(0);
  const [detectedFormatLabel, setDetectedFormatLabel] = useState('');
  const [importQuality, setImportQuality] = useState<ImportQualityResult | null>(null);
  const [importDiagnostics, setImportDiagnostics] = useState<string[]>([]);

  // ── Slash notation overlay (within chord-chart mode) ──
  const [showSlashNotation, setShowSlashNotation] = useState(false);
  const [slashMeasuresPerRow, setSlashMeasuresPerRow] = useState(4);

  // ── UG Pro importer mode state ──
  const [ugProFile, setUgProFile] = useState<File | null>(null);

  // ── SVG importer mode state ──
  const [svgFile, setSvgFile] = useState<File | null>(null);

  // ── Derived: XML validation warnings ──
  const xmlWarnings = useMemo(() => {
    if (!diagnostics) return [] as string[];
    if (!diagnostics.isValidXml) return ['Invalid MusicXML/XML (parse error).'];
    if (!diagnostics.isMusicXml) return ['XML is valid but not MusicXML.'];
    const list: string[] = [];
    if (diagnostics.harmonies === 0)
      list.push('No chord symbols (<harmony>) found — showing notation only.');
    if (!diagnostics.hasKey) list.push('No key signature found — key may be inferred.');
    if (!diagnostics.hasTime) list.push('No time signature found — time may be inferred.');
    if (!diagnostics.hasDivisions)
      list.push('No <divisions> found — rhythmic rendering may be unreliable.');
    return list;
  }, [diagnostics]);

  // ── Export actions — delegated to useExportActions ──
  const {
    exportFeedback, setExportFeedback,
    pdfPageSize, setPdfPageSize,
    pdfBlobUrl, pdfFilename,
    chordProUi, setChordProUi,
    chordProText,
    chordProWarnings,
    chordProDiagnostics,
    canShare, canSharePdf,
    clearPdfOutput, clearExportState,
    showExportError, showExportSuccess,
    downloadXml, downloadDiagnostics,
    exportSvg, exportPng, exportPdf, printScore,
    generateChordPro, viewAsFakebook,
    copyChordPro, downloadChordProText,
    shareText, sharePdf,
  } = useExportActions({
    containerRef, osmdRef,
    loadedXmlText, loadedFilename,
    diagnostics, xmlWarnings, renderError, renderedPageCount,
    setRenderError, setChartDocument, setImportQuality, setImportDiagnostics,
    setTransposeSteps, setDetectedFormatLabel, setAppMode,
  });

  // ── Clear all ──
  const clearAll = useCallback(() => {
    setAppMode('empty');
    setLoadedFilename('');
    setRenderError('');
    // Notation — delegated to hook
    clearOsmd();
    // Export state — delegated to hook
    clearExportState();
    // Chart
    setChartDocument(null);
    setTransposeSteps(0);
    setDetectedFormatLabel('');
    setImportQuality(null);
    setImportDiagnostics([]);
    setShowSlashNotation(false);
    // UG Pro importer
    setUgProFile(null);
    // SVG importer
    setSvgFile(null);
  }, [clearOsmd, clearExportState]);

  // ── UG Pro importer: CSMPN import callback ──
  const onImportCsmpn = useCallback((csmpnText: string) => {
    try {
      const doc = parseCsmpn(csmpnText);
      setChartDocument(canonicalizeChordChartDocument(doc));
      setTransposeSteps(0);
      setDetectedFormatLabel('UG Pro PDF (CSMPN)');
      setImportQuality(null);
      setImportDiagnostics([]);
      setRenderError('');
      setExportFeedback(null);
      setUgProFile(null);
      setAppMode('chord-chart');
    } catch (err) {
      setRenderError(`CSMPN parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const onImportOemerCsmpn = useCallback((csmpnText: string) => {
    try {
      const doc = parseCsmpn(csmpnText);
      doc.sourceFormat = 'oemer-image';
      setChartDocument(canonicalizeChordChartDocument(doc));
      setTransposeSteps(0);
      setDetectedFormatLabel('oemer-image');
      setImportQuality(null);
      setImportDiagnostics([]);
      setRenderError('');
      setExportFeedback(null);
      setUgProFile(null);
      setAppMode('chord-chart');
    } catch (err) {
      setRenderError(`CSMPN parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // ── File loading ──
  const loadFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_SIZE_BYTES) {
      setRenderError(
        `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). ` +
          `Maximum supported size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.`
      );
      return;
    }
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const detected = sniffFormatFromBytes(bytes, file.name);

      if (isMusicXmlFormat(detected)) {
        // ── Notation path ──
        const { filename, xmlText, isMxl: loadedFromMxl } =
          await extractMusicXmlTextFromFile(file);
        resetAutoFit();
        setLoadedFilename(filename);
        setLoadedXmlText(xmlText);
        setIsMxl(loadedFromMxl);
        setRenderError('');
        clearExportState();
        // Clear chord-chart state
        setChartDocument(null);
        setTransposeSteps(0);
        setDetectedFormatLabel(detected.format === 'mxl' ? 'MXL' : 'MusicXML');
        setImportQuality(null);
        setImportDiagnostics([]);
        setAppMode('notation');
      } else if (isChordChartFormat(detected)) {
        // ── Chord-chart path ──
        const text = new TextDecoder('utf-8').decode(bytes);
        const sourceFormat = asSourceFormat(detected)!;
        const imported = await importWithNotaGenPipeline(text, sourceFormat, file.name);
        const doc = imported.document;

        const formatLabels: Record<string, string> = {
          chordpro: 'ChordPro',
          ultimateguitar: 'Ultimate Guitar',
          'chords-over-words': 'Chords over Words',
          abc: 'ABC Notation',
          fakebook: 'Fake Book',
        };

        setLoadedFilename(file.name);
        setChartDocument(doc);
        setImportQuality(
          doc.importQuality
            ? {
                score: doc.importQuality.score,
                warnings: doc.importQuality.warnings,
                diagnostics: doc.importDiagnostics ?? [],
              }
            : null
        );
        setImportDiagnostics(doc.importDiagnostics ?? []);
        setTransposeSteps(0);
        setDetectedFormatLabel(formatLabels[sourceFormat] ?? sourceFormat);
        setRenderError('');
        clearOsmd();
        clearExportState();
        setImportQuality(null);
        setImportDiagnostics([]);
        setAppMode('chord-chart');
      } else if (isGuitarProFormat(detected)) {
        // ── Guitar Pro path (.gp / .gp3 / .gp4 / .gp5 / .gpx) ──
        // AlphaTab is loaded lazily on first GP file open (~3 MB chunk).
        const { parseGuitarPro } = await import('./parsers/gpParser');
        const doc = await parseGuitarPro(bytes);

        setLoadedFilename(file.name);
        setChartDocument(doc);
        setImportQuality(
          doc.importQuality
            ? {
                score: doc.importQuality.score,
                warnings: doc.importQuality.warnings,
                diagnostics: doc.importDiagnostics ?? [],
              }
            : null
        );
        setImportDiagnostics(doc.importDiagnostics ?? []);
        setTransposeSteps(0);
        setDetectedFormatLabel('Guitar Pro');
        setRenderError('');
        clearOsmd();
        clearExportState();
        setAppMode('chord-chart');
      } else if (isSvgFormat(detected)) {
        // ── SVG path: route to SVG importer panel ──
        setLoadedFilename(file.name);
        setSvgFile(file);
        setRenderError('');
        setChartDocument(null);
        clearOsmd();
        clearExportState();
        setImportQuality(null);
        setImportDiagnostics([]);
        setUgProFile(null);
        setAppMode('svg-importer');
      } else if (isPdfFormat(detected)) {
        // ── PDF path: route to UG Pro PDF importer ──
        setLoadedFilename(file.name);
        setUgProFile(file);
        setRenderError('');
        setChartDocument(null);
        clearOsmd();
        clearExportState();
        setAppMode('ug-pro-importer');
      } else if (isGuitarProFormat(detected)) {
        // ── Guitar Pro / PowerTab path ──
        const { parseGuitarPro } = await import('./parsers/gpParser');
        const doc = await parseGuitarPro(bytes);

        // Determine a human-readable label from the file extension.
        const gpExt = file.name.split('.').pop()?.toLowerCase() ?? '';
        const gpLabel: Record<string, string> = {
          gp: 'Guitar Pro 7/8',
          gpx: 'Guitar Pro 6',
          gp5: 'Guitar Pro 5',
          gp4: 'Guitar Pro 4',
          gp3: 'Guitar Pro 3',
          ptb: 'PowerTab',
        };

        setLoadedFilename(file.name);
        setChartDocument(doc);
        setTransposeSteps(0);
        setDetectedFormatLabel(gpLabel[gpExt] ?? 'Guitar Pro');
        setRenderError('');
        clearOsmd();
        clearExportState();
        setAppMode('chord-chart');
      } else {
        setRenderError(
          'Unsupported file type. Upload .svg (SVG graphic), .xml/.mxl (notation), ' +
            '.gp/.gp5/.gpx (Guitar Pro), ' +
            '.cho/.pro/.abc/.txt (chord chart), or .pdf. For OEMER, use "OEMER Image OMR".'
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Surface actionable context where possible.
      if (
        message.toLowerCase().includes('out of memory') ||
        message.toLowerCase().includes('quota')
      ) {
        setRenderError(
          'Not enough memory to open this file. Try a smaller file or close other browser tabs.'
        );
      } else if (
        message.toLowerCase().includes('not allowed') ||
        message.toLowerCase().includes('permission')
      ) {
        setRenderError(
          'Permission denied reading the file. Try saving it locally and re-uploading.'
        );
      } else if (
        message.toLowerCase().includes('network') ||
        message.toLowerCase().includes('fetch')
      ) {
        setRenderError(
          'Network error while loading the file. Check your connection and try again.'
        );
      } else {
        setRenderError(
          `Could not open file: ${message}. Verify the file is not corrupted and matches a supported format.`
        );
      }
    }
  }, []);

  const onFileInput = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      await loadFile(file);
      event.target.value = '';
    },
    [loadFile]
  );

  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) setIsDragging(true);
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault(); // required to allow drop
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (!file) return;
      await loadFile(file);
    },
    [loadFile]
  );

  // Export actions (downloadXml, downloadDiagnostics, exportSvg, exportPng, exportPdf,
  // printScore, generateChordPro, viewAsFakebook, copyChordPro, downloadChordProText,
  // shareText, sharePdf, clearPdfOutput) delegated to useExportActions above.

  // ── Chord-chart controls ──
  const adjustTranspose = useCallback((delta: number) => {
    setTransposeSteps((prev) =>
      (((prev + delta + 12) % 12) + 12) % 12 === 0 && delta < 0
        ? -12 + ((((prev + delta + 12) % 12) + 12) % 12)
        : prev + delta
    );
  }, []);

  const normalizedTranspose = ((transposeSteps % 12) + 12) % 12;
  const displayTranspose = normalizedTranspose > 6 ? normalizedTranspose - 12 : normalizedTranspose;

  const chartProText = useMemo(() => {
    if (!chartDocument) return '';
    return serializeChordProFromDocument(chartDocument, transposeSteps);
  }, [chartDocument, transposeSteps]);

  // ─── Render ───────────────────────────────────────────────────────────────

  const canExportNotation = appMode === 'notation' && Boolean(loadedXmlText);

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="top-bar">
        <label className="upload-btn">
          Upload
          <input type="file" accept={FILE_INPUT_ACCEPT} onChange={onFileInput} />
        </label>
        <button type="button" onClick={() => setAppMode('oemer-image-importer')}>
          OEMER Image OMR
        </button>

        {appMode === 'empty' && (
          <span className="hint">
            Drag &amp; drop .svg (graphic), .xml / .mxl (notation), .gp / .gp5 / .gpx (Guitar Pro),
            or .cho / .pro / .abc / .txt / .pdf (chord chart)
          </span>
        )}

        {appMode === 'notation' && (
          <>
            <span className="mode-badge mode-badge--notation">Notation</span>
            <button type="button" onClick={() => adjustZoom(-0.1)}>
              Zoom −
            </button>
            <button type="button" onClick={() => adjustZoom(0.1)}>
              Zoom +
            </button>
            <button type="button" onClick={fitWidth}>
              Fit Width
            </button>
          </>
        )}

        {appMode === 'chord-chart' && (
          <>
            <span className="mode-badge mode-badge--chart">
              Chord Chart · {detectedFormatLabel}
            </span>
            {chartDocument && (
              <div className="top-slash-controls">
                <button
                  type="button"
                  className={`btn-slash-notation btn-slash-notation--top${showSlashNotation ? ' active' : ''}`}
                  onClick={() => setShowSlashNotation((v) => !v)}
                >
                  {showSlashNotation ? 'Back to Chord Chart' : 'Slash Notation'}
                </button>
                {showSlashNotation && (
                  <label className="top-slash-mpr" htmlFor="sn-mpr-top">
                    Measures/row
                    <input
                      id="sn-mpr-top"
                      type="number"
                      min={1}
                      max={8}
                      value={slashMeasuresPerRow}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v)) setSlashMeasuresPerRow(Math.max(1, Math.min(8, v)));
                      }}
                    />
                  </label>
                )}
              </div>
            )}
          </>
        )}

        {appMode === 'ug-pro-importer' && (
          <span className="mode-badge mode-badge--chart">UG Pro PDF Importer</span>
        )}

        {appMode === 'oemer-image-importer' && (
          <span className="mode-badge mode-badge--chart">OEMER Image OMR</span>
        )}

        {appMode === 'svg-importer' && (
          <span className="mode-badge mode-badge--chart">SVG Importer</span>
        )}

        {appMode !== 'empty' && (
          <button type="button" onClick={clearAll}>
            Clear
          </button>
        )}
      </header>

      {/* ── Error banners ── */}
      {loadedXmlText && diagnostics && !diagnostics.isValidXml && (
        <div className="error-banner">
          XML parse error: {diagnostics.parseError ?? 'Invalid XML'}
        </div>
      )}
      {renderError && <div className="error-banner">{renderError}</div>}

      {/* ── Content area ── */}
      <main className="content-grid">
        {/* ── Left: score viewport OR chord chart OR importer panels ── */}
        {appMode === 'svg-importer' ? (
          <section
            className={`chord-chart-viewport svg-importer-viewport ${isDragging ? 'dragging' : ''}`}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{ gridColumn: '1 / -1' }}
          >
            {isDragging && (
              <div className="drop-overlay" aria-hidden>
                <span>Drop SVG to load</span>
              </div>
            )}
            <ImportErrorBoundary label="SVG Importer" key={svgFile?.name}>
              <SvgImporterPanel initialFile={svgFile} />
            </ImportErrorBoundary>
          </section>
        ) : appMode === 'ug-pro-importer' ? (
          <section
            className={`chord-chart-viewport ug-pro-importer-viewport ${isDragging ? 'dragging' : ''}`}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            style={{ gridColumn: '1 / -1' }}
          >
            {isDragging && (
              <div className="drop-overlay" aria-hidden>
                <span>Drop PDF to load</span>
              </div>
            )}
            <ImportErrorBoundary label="UG Pro Importer" key={ugProFile?.name}>
              <UGProImporterPanel
                initialFile={ugProFile}
                onImportCsmpn={onImportCsmpn}
              />
            </ImportErrorBoundary>
          </section>
        ) : appMode === 'oemer-image-importer' ? (
          <section className="chord-chart-viewport" style={{ gridColumn: '1 / -1' }}>
            <ImportErrorBoundary label="OEMER Image Importer">
              <OemerImageImporterPanel onImportCsmpn={onImportOemerCsmpn} />
            </ImportErrorBoundary>
          </section>
        ) : appMode !== 'chord-chart' ? (
          <section
            className={`score-viewport ${isDragging ? 'dragging' : ''}`}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {isDragging && (
              <div className="drop-overlay" aria-hidden>
                <span>Drop to load</span>
              </div>
            )}
            {appMode === 'empty' && !isDragging && (
              <p className="placeholder">
                Drop a file here, or use the file picker below.
                <br />
                Supports MusicXML / MXL, ChordPro / text chord charts, and PDF chord sheets.
              </p>
            )}
            <div ref={containerRef} className="score-container" />
          </section>
        ) : (
          <section
            className={`chord-chart-viewport ${isDragging ? 'dragging' : ''}`}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            {isDragging && (
              <div className="drop-overlay" aria-hidden>
                <span>Drop to load</span>
              </div>
            )}
            {chartDocument && (
              showSlashNotation ? (
                <SlashNotationBoundary key={(chartDocument.title ?? '') + chartDocument.sections.length}>
                  <SlashNotationView
                    document={chartDocument}
                    transposeSteps={transposeSteps}
                    measuresPerRow={slashMeasuresPerRow}
                  />
                </SlashNotationBoundary>
              ) : (
                <ChordChart document={chartDocument} transposeSteps={transposeSteps} />
              ))}
          </section>
        )}

        {/* ── Right: side panel ── */}
        <aside className="side-panel">
          {/* ── Chord-chart mode panel ── */}
          {appMode === 'chord-chart' && chartDocument && (
            <>
              {/* If source was MusicXML, allow jumping back to the notation view */}
              {loadedXmlText && (
                <button
                  type="button"
                  className="back-to-notation-btn"
                  onClick={() => setAppMode('notation')}
                >
                  ← Back to Notation
                </button>
              )}
              <h2>Chart Info</h2>
              <ul>
                <li>
                  <strong>File:</strong> {loadedFilename}
                </li>
                <li>
                  <strong>Format:</strong> {detectedFormatLabel}
                </li>
                {importQuality && (
                  <li>
                    <strong>Import confidence:</strong> {importQuality.score}/100
                    {chartDocument.importQuality?.strategy === 'abc-via-musicxml-fallback' &&
                      ' (ABC→MusicXML fallback)'}
                  </li>
                )}
                {chartDocument.title && (
                  <li>
                    <strong>Title:</strong> {chartDocument.title}
                  </li>
                )}
                {chartDocument.artist && (
                  <li>
                    <strong>Artist:</strong> {chartDocument.artist}
                  </li>
                )}
                {chartDocument.key && (
                  <li>
                    <strong>Key:</strong> {chartDocument.key}
                  </li>
                )}
                {chartDocument.capo && (
                  <li>
                    <strong>Capo:</strong> {chartDocument.capo}
                  </li>
                )}
                {chartDocument.tempo && (
                  <li>
                    <strong>Tempo:</strong> {chartDocument.tempo} BPM
                  </li>
                )}
                {chartDocument.time && (
                  <li>
                    <strong>Time:</strong> {chartDocument.time}
                  </li>
                )}
                {chartDocument.genre && (
                  <li>
                    <strong>Genre:</strong> {chartDocument.genre}
                  </li>
                )}
                <li>
                  <strong>Sections:</strong> {chartDocument.sections.length}
                </li>
              </ul>
              {importQuality && importQuality.warnings.length > 0 && (
                <div className="warning-block">
                  <strong>Import warnings</strong>
                  <ul>
                    {importQuality.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {importDiagnostics.length > 0 && (
                <p className="hint-text" title={importDiagnostics.join('\n')}>
                  Diagnostics: {importDiagnostics.slice(0, 2).join(' · ')}
                </p>
              )}

              <h2>Slash Notation</h2>
              <button
                type="button"
                className={`btn-slash-notation${showSlashNotation ? ' active' : ''}`}
                onClick={() => setShowSlashNotation((v) => !v)}
              >
                {showSlashNotation ? '← Back to Chord Chart' : '𝄞 Convert to Slash Notation'}
              </button>
              {showSlashNotation && (
                <div className="sn-mpr-row">
                  <label htmlFor="sn-mpr">Measures per row:</label>
                  <input
                    id="sn-mpr"
                    type="number"
                    min={1}
                    max={8}
                    value={slashMeasuresPerRow}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10);
                      if (Number.isFinite(v)) setSlashMeasuresPerRow(Math.max(1, Math.min(8, v)));
                    }}
                  />
                </div>
              )}

              <h2>Transpose</h2>
              <div className="transpose-row">
                <button type="button" onClick={() => adjustTranspose(-1)}>
                  −1
                </button>
                <span className="transpose-value">
                  {displayTranspose > 0 ? `+${displayTranspose}` : displayTranspose}
                </span>
                <button type="button" onClick={() => adjustTranspose(1)}>
                  +1
                </button>
                <button
                  type="button"
                  onClick={() => setTransposeSteps(0)}
                  disabled={transposeSteps === 0}
                >
                  Reset
                </button>
              </div>

              <h2>Export ChordPro</h2>
              <div className="chart-actions">
                <button type="button" onClick={() => void copyChordPro(chartProText)}>
                  Copy ChordPro
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadChordProText(chartProText, deriveProFilename(loadedFilename))
                  }
                >
                  Download .pro
                </button>
                {canShare && (
                  <button
                    type="button"
                    onClick={() => void shareText(chartProText, deriveProFilename(loadedFilename))}
                  >
                    Share
                  </button>
                )}
              </div>

              <textarea
                className="chordpro-output"
                value={chartProText}
                placeholder="Normalized ChordPro output will appear here."
                wrap="off"
                spellCheck={false}
                readOnly
              />
            </>
          )}

          {/* ── Notation mode panel ── */}
          {appMode === 'notation' && (
            <>
              <h2>Diagnostics</h2>
              {diagnostics ? (
                <ul>
                  <li>
                    <strong>File:</strong> {loadedFilename || 'n/a'}
                  </li>
                  <li>
                    <strong>Root:</strong> {diagnostics.rootName}
                  </li>
                  <li>
                    <strong>Version:</strong> {diagnostics.version}
                  </li>
                  {!diagnostics.isValidXml && diagnostics.parseError && (
                    <li>
                      <strong>Parse error:</strong> {diagnostics.parseError}
                    </li>
                  )}
                  <li>
                    <strong>Parts:</strong> {diagnostics.parts}
                  </li>
                  <li>
                    <strong>Measures:</strong> {diagnostics.measures}
                  </li>
                  <li>
                    <strong>Notes:</strong> {diagnostics.notes}
                  </li>
                  <li>
                    <strong>Harmonies:</strong> {diagnostics.harmonies}
                  </li>
                  <li>
                    <strong>Has key:</strong> {diagnostics.hasKey ? 'yes' : 'no'}
                  </li>
                  <li>
                    <strong>Has time:</strong> {diagnostics.hasTime ? 'yes' : 'no'}
                  </li>
                  <li>
                    <strong>Has divisions:</strong> {diagnostics.hasDivisions ? 'yes' : 'no'}
                  </li>
                  <li>
                    <strong>Source type:</strong> {isMxl ? 'MXL archive' : 'XML text'}
                  </li>
                </ul>
              ) : (
                <p>No file loaded.</p>
              )}

              <h2>Warnings</h2>
              {xmlWarnings.length > 0 ? (
                <ul>
                  {xmlWarnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : (
                <p>No warnings.</p>
              )}

              <h2>ChordPro Export</h2>
              <div className="chordpro-options-grid">
                <label className="export-label" htmlFor="chordpro-bars">
                  Bars per line
                </label>
                <input
                  id="chordpro-bars"
                  type="number"
                  min={1}
                  max={16}
                  value={chordProUi.barsPerLine}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setChordProUi((p) => ({
                      ...p,
                      barsPerLine: Number.isFinite(v)
                        ? Math.max(1, Math.min(16, v))
                        : p.barsPerLine,
                    }));
                  }}
                />
                <label className="export-label" htmlFor="chordpro-mode">
                  Mode
                </label>
                <select
                  id="chordpro-mode"
                  value={chordProUi.mode}
                  onChange={(e) =>
                    setChordProUi((p) => ({ ...p, mode: e.target.value as ChordProModeUi }))
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="lyrics-inline">Lyrics Inline</option>
                  <option value="grid-only">Grid Only</option>
                </select>
                <label className="export-label" htmlFor="chordpro-brackets">
                  Chord bracket style
                </label>
                <select
                  id="chordpro-brackets"
                  value={chordProUi.chordBracketStyle}
                  onChange={(e) =>
                    setChordProUi((p) => ({
                      ...p,
                      chordBracketStyle: e.target.value as ChordProBracketUi,
                    }))
                  }
                >
                  <option value="separate">Separate</option>
                  <option value="combined">Combined</option>
                </select>
                <label className="export-label" htmlFor="chordpro-repeat">
                  Repeat
                </label>
                <select
                  id="chordpro-repeat"
                  value={chordProUi.repeatStrategy}
                  onChange={(e) =>
                    setChordProUi((p) => ({
                      ...p,
                      repeatStrategy: e.target.value as ChordProRepeatUi,
                    }))
                  }
                >
                  <option value="none">None</option>
                  <option value="simple-unroll">Simple Unroll</option>
                  <option value="full-unroll">Full Unroll (Volta)</option>
                </select>
              </div>

              <div className="export-actions">
                <button
                  type="button"
                  onClick={() => void generateChordPro()}
                  disabled={!canExportNotation}
                >
                  Generate ChordPro
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => void viewAsFakebook()}
                  disabled={!canExportNotation}
                  title="Convert to ChordPro and switch to fakebook lead-sheet view"
                >
                  View as Fakebook
                </button>
                <button
                  type="button"
                  onClick={() => void copyChordPro(chordProText)}
                  disabled={!chordProText}
                >
                  Copy
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadChordProText(chordProText, deriveProFilename(loadedFilename))
                  }
                  disabled={!chordProText}
                >
                  Download .pro
                </button>
                {canShare && (
                  <button
                    type="button"
                    onClick={() => void shareText(chordProText, deriveProFilename(loadedFilename))}
                    disabled={!chordProText}
                  >
                    Share
                  </button>
                )}
              </div>

              <textarea
                className="chordpro-output"
                value={chordProText}
                placeholder="Generated ChordPro will appear here..."
                wrap="off"
                spellCheck={false}
                readOnly
              />

              {chordProWarnings.length > 0 && (
                <div className="warning-block">
                  <strong>ChordPro warnings</strong>
                  <ul>
                    {chordProWarnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              {chordProDiagnostics && (
                <p className="hint-text">
                  Resolved mode: <strong>{chordProDiagnostics.formatModeResolved}</strong> ·
                  Measures: {chordProDiagnostics.measuresCount}
                  {chordProDiagnostics.keyChanges > 0 && (
                    <span className="diag-badge diag-badge--warn">
                      {chordProDiagnostics.keyChanges} key change
                      {chordProDiagnostics.keyChanges > 1 ? 's' : ''}
                    </span>
                  )}
                  {chordProDiagnostics.timeChanges > 0 && (
                    <span className="diag-badge diag-badge--warn">
                      {chordProDiagnostics.timeChanges} time sig change
                      {chordProDiagnostics.timeChanges > 1 ? 's' : ''}
                    </span>
                  )}
                  {chordProDiagnostics.hasPickupBar && (
                    <span className="diag-badge diag-badge--info">pickup bar</span>
                  )}
                  {chordProDiagnostics.sectionsDetected.length > 0 && (
                    <span
                      className="diag-badge diag-badge--info"
                      title={chordProDiagnostics.sectionsDetected.join(', ')}
                    >
                      {chordProDiagnostics.sectionsDetected.length} section
                      {chordProDiagnostics.sectionsDetected.length > 1 ? 's' : ''}
                    </span>
                  )}
                </p>
              )}

              <h2>Export</h2>
              <label className="export-label" htmlFor="pdf-page-size">
                PDF Page Size
              </label>
              <select
                id="pdf-page-size"
                value={pdfPageSize}
                onChange={(e) => setPdfPageSize(e.target.value as PdfPageSize)}
                disabled={!canExportNotation}
              >
                <option value="letter">Letter (Portrait)</option>
                <option value="a4">A4 (Portrait)</option>
              </select>

              <div className="export-actions">
                <button type="button" onClick={downloadXml} disabled={!canExportNotation}>
                  Download XML
                </button>
                <button type="button" onClick={downloadDiagnostics} disabled={!canExportNotation}>
                  Download Diagnostics JSON
                </button>
                <button type="button" onClick={exportSvg} disabled={!canExportNotation}>
                  Export SVG (first page)
                </button>
                <button
                  type="button"
                  onClick={() => void exportPng()}
                  disabled={!canExportNotation}
                >
                  Export PNG (first page)
                </button>
                <button
                  type="button"
                  onClick={() => void exportPdf()}
                  disabled={!canExportNotation}
                >
                  Generate PDF
                </button>
                {renderedPageCount > 6 && (
                  <button
                    type="button"
                    onClick={() => void exportPdf(1)}
                    disabled={!canExportNotation}
                  >
                    Export PDF (First Page)
                  </button>
                )}
                <button type="button" onClick={printScore} disabled={renderedPageCount === 0}>
                  Print / Save as PDF
                </button>
              </div>

              {pdfBlobUrl && (
                <div className="pdf-ready-box">
                  <p className="pdf-ready-title">PDF Ready</p>
                  <div className="pdf-ready-actions">
                    <a
                      href={pdfBlobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="open-pdf-link"
                    >
                      Open PDF
                    </a>
                    <a href={pdfBlobUrl} download={pdfFilename}>
                      Download PDF
                    </a>
                    {canSharePdf && (
                      <button type="button" onClick={() => void sharePdf()}>
                        Share PDF
                      </button>
                    )}
                    <button type="button" onClick={clearPdfOutput}>
                      Clear PDF
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Empty state ── */}
          {appMode === 'empty' && <p>Upload a file to get started.</p>}

          {exportFeedback && (
            <p className={`export-feedback ${exportFeedback.type}`}>{exportFeedback.message}</p>
          )}
        </aside>
      </main>
    </div>
  );
}

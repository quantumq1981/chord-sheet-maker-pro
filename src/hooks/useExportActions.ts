/**
 * useExportActions.ts
 *
 * Custom hook owning all notation and chord-chart export state and callbacks.
 * Extracted from App.tsx (Sprint 4, item 3.1).
 *
 * Owns:
 *   - exportFeedback (success / error banner)
 *   - pdfPageSize, pdfBlobUrl, pdfFilename
 *   - chordProUi options, chordProText, chordProWarnings, chordProDiagnostics
 *
 * Exposes callbacks:
 *   - downloadXml, downloadDiagnostics, exportSvg, exportPng, exportPdf, printScore
 *   - generateChordPro, viewAsFakebook
 *   - copyChordPro, downloadChordProText, shareText, sharePdf
 *   - clearPdfOutput, clearExportState
 */

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { jsPDF } from 'jspdf';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import {
  type PdfPageSize,
  type Diagnostics,
  PRINT_ZOOM,
  snapshotEngravingRules,
  applyPrintProfile,
  restoreEngravingRules,
  getBaseFilename,
  getRenderedSvgs,
  triggerBlobDownload,
  serializeSvg,
  svgToCanvas,
  canvasToBlob,
} from '../utils/osmdHelpers';
import {
  convertMusicXmlToChordPro,
  getDefaultConvertOptions,
  type ChordBracketStyle,
  type ChordProFormatMode,
  type ConverterDiagnostics,
  type RepeatStrategy,
} from '../converters/musicXMLtochordpro';
import { parseChordChart } from '../parsers/chordProParser';
import { canonicalizeChordChartDocument } from '../ingest/canonicalChart';
import type { ChordChartDocument } from '../models/ChordChartModel';
import type { ImportQualityResult } from '../ingest/importQuality';
import type {
  AppMode,
  ExportFeedback,
  ChordProModeUi,
  ChordProBracketUi,
  ChordProRepeatUi,
  ChordProUiState,
} from '../types/appTypes';

// ─── Private helpers ──────────────────────────────────────────────────────────

function buildChordProOptionsFromUI(uiState: ChordProUiState) {
  const defaultOptions = getDefaultConvertOptions();
  const formatModeMap: Record<ChordProModeUi, ChordProFormatMode> = {
    auto: 'auto',
    'lyrics-inline': 'lyrics-inline',
    'grid-only': 'grid-only',
  };
  const bracketStyleMap: Record<ChordProBracketUi, ChordBracketStyle> = {
    separate: 'separate',
    combined: 'combined',
  };
  const repeatMap: Record<ChordProRepeatUi, RepeatStrategy> = {
    none: 'none',
    'simple-unroll': 'simple-unroll',
    'full-unroll': 'full-unroll',
  };

  return {
    ...defaultOptions,
    barsPerLine: uiState.barsPerLine,
    formatMode: formatModeMap[uiState.mode],
    chordBracketStyle: bracketStyleMap[uiState.chordBracketStyle],
    repeatStrategy: repeatMap[uiState.repeatStrategy],
    barlineStyle: 'pipes' as const,
    wrapPolicy: 'bars-per-line' as const,
  };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseExportActionsProps {
  // From useOsmdRenderer
  containerRef: RefObject<HTMLDivElement | null>;
  osmdRef: RefObject<OpenSheetMusicDisplay | null>;
  loadedXmlText: string;
  loadedFilename: string;
  diagnostics: Diagnostics | null;
  xmlWarnings: string[];
  renderError: string;
  renderedPageCount: number;
  // From App state
  setRenderError: (msg: string) => void;
  setChartDocument: Dispatch<SetStateAction<ChordChartDocument | null>>;
  setImportQuality: Dispatch<SetStateAction<ImportQualityResult | null>>;
  setImportDiagnostics: Dispatch<SetStateAction<string[]>>;
  setTransposeSteps: Dispatch<SetStateAction<number>>;
  setDetectedFormatLabel: Dispatch<SetStateAction<string>>;
  setAppMode: Dispatch<SetStateAction<AppMode>>;
}

export function useExportActions({
  containerRef,
  osmdRef,
  loadedXmlText,
  loadedFilename,
  diagnostics,
  xmlWarnings,
  renderError,
  renderedPageCount,
  setRenderError,
  setChartDocument,
  setImportQuality,
  setImportDiagnostics,
  setTransposeSteps,
  setDetectedFormatLabel,
  setAppMode,
}: UseExportActionsProps) {
  // ── State ──
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  const [pdfPageSize, setPdfPageSize] = useState<PdfPageSize>('letter');
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [pdfFilename, setPdfFilename] = useState('score.pdf');
  const [chordProUi, setChordProUi] = useState<ChordProUiState>({
    barsPerLine: 4,
    mode: 'auto',
    chordBracketStyle: 'separate',
    repeatStrategy: 'none',
  });
  const [chordProText, setChordProText] = useState('');
  const [chordProWarnings, setChordProWarnings] = useState<string[]>([]);
  const [chordProDiagnostics, setChordProDiagnostics] = useState<ConverterDiagnostics | null>(null);

  // ── PDF blob URL lifecycle ──
  useEffect(() => {
    return () => {
      if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    };
  }, [pdfBlobUrl]);

  // ── Derived ──
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const canSharePdf =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function';

  const baseName = getBaseFilename(loadedFilename);

  // ── Feedback helpers ──
  const showExportError = useCallback(
    (msg: string) => setExportFeedback({ type: 'error', message: msg }),
    []
  );
  const showExportSuccess = useCallback(
    (msg: string) => setExportFeedback({ type: 'success', message: msg }),
    []
  );

  // ── PDF / file output reset ──
  const clearPdfOutput = useCallback(() => {
    setPdfBlobUrl(null);
    setPdfFilename('score.pdf');
  }, []);

  /** Reset all export-owned state (called by App's clearAll). */
  const clearExportState = useCallback(() => {
    setExportFeedback(null);
    setPdfBlobUrl(null);
    setPdfFilename('score.pdf');
    setChordProText('');
    setChordProWarnings([]);
    setChordProDiagnostics(null);
  }, []);

  // ── Notation exports ──
  const downloadXml = useCallback(() => {
    if (!loadedXmlText) {
      showExportError('Load a file before downloading XML.');
      return;
    }
    try {
      triggerBlobDownload(
        new Blob([loadedXmlText], { type: 'application/xml;charset=utf-8' }),
        `${baseName}.xml`
      );
      showExportSuccess('Downloaded XML.');
    } catch (error) {
      showExportError(
        `XML download failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [baseName, loadedXmlText, showExportError, showExportSuccess]);

  const downloadDiagnostics = useCallback(() => {
    if (!loadedXmlText) {
      showExportError('Load a file before downloading diagnostics.');
      return;
    }
    try {
      const payload = {
        filename: loadedFilename || `${baseName}.xml`,
        diagnostics,
        warnings: xmlWarnings,
        renderError: renderError || null,
        timestamp: new Date().toISOString(),
      };
      triggerBlobDownload(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
        `${baseName}.diagnostics.json`
      );
      showExportSuccess('Downloaded diagnostics JSON.');
    } catch (error) {
      showExportError(
        `Diagnostics export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [
    baseName,
    diagnostics,
    loadedFilename,
    loadedXmlText,
    renderError,
    showExportError,
    showExportSuccess,
    xmlWarnings,
  ]);

  const exportSvg = useCallback(() => {
    const svg = getRenderedSvgs(containerRef.current)[0];
    if (!svg) {
      showExportError('No rendered score found.');
      return;
    }
    try {
      triggerBlobDownload(
        new Blob([serializeSvg(svg)], { type: 'image/svg+xml;charset=utf-8' }),
        `${baseName}.page1.svg`
      );
      showExportSuccess('Exported first SVG page.');
    } catch (error) {
      showExportError(
        `SVG export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [baseName, containerRef, showExportError, showExportSuccess]);

  const exportPng = useCallback(async () => {
    const svg = getRenderedSvgs(containerRef.current)[0];
    if (!svg) {
      showExportError('No rendered score found.');
      return;
    }
    try {
      const canvas = await svgToCanvas(svg, 2);
      const blob = await canvasToBlob(canvas, 'image/png');
      triggerBlobDownload(blob, `${baseName}.png`, true);
      showExportSuccess('Exported first page as PNG.');
    } catch (error) {
      showExportError(
        `PNG export failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [baseName, containerRef, showExportError, showExportSuccess]);

  const exportPdf = useCallback(
    async (maxPages?: number) => {
      const osmd = osmdRef.current;
      if (!osmd) {
        showExportError('Renderer is not ready yet.');
        return;
      }
      const initialSvgs = getRenderedSvgs(containerRef.current);
      if (initialSvgs.length === 0) {
        showExportError('No rendered score found.');
        return;
      }

      const isLetter = pdfPageSize === 'letter';
      const unit = isLetter ? 'in' : 'mm';
      const format: [number, number] = isLetter ? [8.5, 11] : [210, 297];
      const margin = isLetter ? 0.5 : 12;
      const rulesSnapshot = snapshotEngravingRules(osmd);
      const zoomSnapshot = osmd.Zoom;

      try {
        applyPrintProfile(osmd, pdfPageSize);
        osmd.Zoom = PRINT_ZOOM;
        osmd.render();
        const svgs = getRenderedSvgs(containerRef.current);
        if (svgs.length === 0)
          throw new Error('No rendered score found after applying print layout.');
        const pdf = new jsPDF({ orientation: 'portrait', unit, format });
        const pagesToExport = typeof maxPages === 'number' ? svgs.slice(0, maxPages) : svgs;

        for (let index = 0; index < pagesToExport.length; index++) {
          const canvas = await svgToCanvas(pagesToExport[index], 1.5);
          const jpegData = canvas.toDataURL('image/jpeg', 0.92);
          if (index > 0) pdf.addPage(format, 'portrait');
          const pageWidth = pdf.internal.pageSize.getWidth();
          const pageHeight = pdf.internal.pageSize.getHeight();
          const availableWidth = pageWidth - margin * 2;
          const availableHeight = pageHeight - margin * 2;
          const imgAspect = canvas.width / canvas.height;
          let w = availableWidth;
          let h = w / imgAspect;
          if (h > availableHeight) {
            h = availableHeight;
            w = h * imgAspect;
          }
          const x = (pageWidth - w) / 2;
          const y = (pageHeight - h) / 2;
          pdf.addImage(jpegData, 'JPEG', x, y, w, h, undefined, 'FAST');
        }

        const blob = pdf.output('blob');
        const url = URL.createObjectURL(blob);
        setPdfBlobUrl(url);
        setPdfFilename(`${baseName}.pdf`);
        showExportSuccess('PDF ready. Tap Open PDF.');
      } catch (error) {
        showExportError(
          `PDF export failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        restoreEngravingRules(osmd, rulesSnapshot);
        osmd.Zoom = zoomSnapshot;
        osmd.render();
      }
    },
    [baseName, containerRef, osmdRef, pdfPageSize, showExportError, showExportSuccess]
  );

  const printScore = useCallback(() => {
    const osmd = osmdRef.current;
    if (!osmd || renderedPageCount === 0) {
      showExportError('No rendered score found.');
      return;
    }
    const rulesSnapshot = snapshotEngravingRules(osmd);
    const zoomSnapshot = osmd.Zoom;
    let restored = false;
    const restoreAfterPrint = () => {
      if (restored) return;
      restored = true;
      window.removeEventListener('afterprint', restoreAfterPrint);
      restoreEngravingRules(osmd, rulesSnapshot);
      osmd.Zoom = zoomSnapshot;
      osmd.render();
    };
    try {
      applyPrintProfile(osmd, pdfPageSize);
      osmd.Zoom = PRINT_ZOOM;
      osmd.render();
      window.addEventListener('afterprint', restoreAfterPrint, { once: true });
      window.print();
      setTimeout(restoreAfterPrint, 1000);
    } catch (error) {
      restoreAfterPrint();
      showExportError(`Print failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [osmdRef, pdfPageSize, renderedPageCount, showExportError]);

  // ── MusicXML → ChordPro ──
  const generateChordPro = useCallback(async () => {
    if (!loadedXmlText) {
      showExportError('Load a MusicXML file before generating ChordPro.');
      return;
    }
    try {
      const options = buildChordProOptionsFromUI(chordProUi);
      const result = await convertMusicXmlToChordPro(
        { filename: loadedFilename, xmlText: loadedXmlText },
        options
      );
      setChordProText(result.chordPro);
      setChordProWarnings(result.warnings);
      setChordProDiagnostics(result.diagnostics);
      if (result.error) {
        showExportError(`ChordPro generated with issues: ${result.error}`);
        return;
      }
      showExportSuccess('ChordPro generated.');
      return result.chordPro;
    } catch (error) {
      showExportError(
        `ChordPro conversion failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return undefined;
  }, [chordProUi, loadedFilename, loadedXmlText, showExportError, showExportSuccess]);

  // ── MusicXML → Fakebook ──
  const viewAsFakebook = useCallback(async () => {
    let pro = chordProText;
    if (!pro) {
      pro = (await generateChordPro()) ?? '';
      if (!pro) return;
    }
    const doc = canonicalizeChordChartDocument(parseChordChart(pro, 'chordpro'));
    setChartDocument(doc);
    setImportQuality(null);
    setImportDiagnostics([]);
    setTransposeSteps(0);
    setDetectedFormatLabel('MusicXML (Fakebook)');
    setRenderError('');
    setExportFeedback(null);
    setAppMode('chord-chart');
  }, [
    chordProText,
    generateChordPro,
    setAppMode,
    setChartDocument,
    setDetectedFormatLabel,
    setImportDiagnostics,
    setImportQuality,
    setRenderError,
    setTransposeSteps,
  ]);

  const copyChordPro = useCallback(
    async (text: string) => {
      if (!text) {
        showExportError('Nothing to copy.');
        return;
      }
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.setAttribute('readonly', 'true');
          textarea.style.cssText = 'position:fixed;opacity:0';
          document.body.append(textarea);
          textarea.select();
          const copied = document.execCommand('copy');
          textarea.remove();
          if (!copied) throw new Error('Copy command was not successful.');
        }
        showExportSuccess('Copied.');
      } catch (error) {
        showExportError(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [showExportError, showExportSuccess]
  );

  const downloadChordProText = useCallback(
    (text: string, filename: string) => {
      if (!text) {
        showExportError('Nothing to download.');
        return;
      }
      try {
        triggerBlobDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
        showExportSuccess('Downloaded .pro file.');
      } catch (error) {
        showExportError(
          `ChordPro download failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    [showExportError, showExportSuccess]
  );

  const shareText = useCallback(
    async (text: string, filename: string) => {
      if (!text) {
        showExportError('Nothing to share.');
        return;
      }
      if (!canShare) {
        showExportError('Share is not supported in this browser.');
        return;
      }
      try {
        const file = new File([text], filename, { type: 'text/plain' });
        await navigator.share({ files: [file], title: filename });
        showExportSuccess('Shared.');
      } catch (error) {
        showExportError(`Share failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [canShare, showExportError, showExportSuccess]
  );

  const sharePdf = useCallback(async () => {
    if (!pdfBlobUrl) {
      showExportError('Generate PDF first.');
      return;
    }
    if (!canSharePdf) {
      showExportError('PDF share is not supported in this browser.');
      return;
    }
    try {
      const response = await fetch(pdfBlobUrl);
      const blob = await response.blob();
      const file = new File([blob], pdfFilename, { type: 'application/pdf' });
      if (!navigator.canShare({ files: [file] })) {
        showExportError('PDF share is not supported in this browser.');
        return;
      }
      await navigator.share({ files: [file], title: pdfFilename });
      showExportSuccess('PDF shared.');
    } catch (error) {
      showExportError(
        `PDF share failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [canSharePdf, pdfBlobUrl, pdfFilename, showExportError, showExportSuccess]);

  return {
    // State
    exportFeedback,
    setExportFeedback,
    pdfPageSize,
    setPdfPageSize,
    pdfBlobUrl,
    pdfFilename,
    chordProUi,
    setChordProUi,
    chordProText,
    setChordProText,
    chordProWarnings,
    chordProDiagnostics,
    canShare,
    canSharePdf,
    // Resets
    clearPdfOutput,
    clearExportState,
    // Callbacks
    showExportError,
    showExportSuccess,
    downloadXml,
    downloadDiagnostics,
    exportSvg,
    exportPng,
    exportPdf,
    printScore,
    generateChordPro,
    viewAsFakebook,
    copyChordPro,
    downloadChordProText,
    shareText,
    sharePdf,
  };
}

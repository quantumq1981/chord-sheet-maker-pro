/**
 * UGProImporterPanel.tsx
 *
 * React UI for the UG Pro PDF → CSMPN importer.
 *
 * Features:
 *   - File picker (drag-drop or button) accepting PDF files.
 *   - Runs importUGProPdf() and shows progress.
 *   - Debug overlay: renders each page canvas and draws system boxes,
 *     barlines, chord tokens, and measure index numbers.
 *   - CSMPN output text area with a Copy button.
 *   - Debug JSON viewer (collapsible).
 *   - "Use This Chart" callback to push CSMPN into the parent app.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  importUGProPdf,
  DEFAULT_CONFIG,
  normalizeChordSymbol,
  type ImportResult,
  type PageRenderData,
  type UGProImporterConfig,
} from '../ingest/ugProPdfImporter';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  /** Called when the user clicks "Use This Chart" with the CSMPN text. */
  onImportCsmpn?: (csmpnText: string) => void;
  /**
   * Optional: pre-load a PDF file immediately when the panel mounts.
   * Used when the app routes a dropped PDF directly to this panel.
   */
  initialFile?: File | null;
}

type ImportStatus = 'idle' | 'loading' | 'done' | 'error';

// ─── Debug overlay drawing ────────────────────────────────────────────────────

/**
 * Draw the debug overlay onto an HTMLCanvasElement.
 * The canvas should already have the rendered PDF page as its background.
 */
function drawDebugOverlay(
  overlayCanvas: HTMLCanvasElement,
  pageRender: PageRenderData,
): void {
  const ctx = overlayCanvas.getContext('2d');
  if (!ctx) return;

  const { canvas: srcCanvas, scale, pageHeightPt, systems } = pageRender;

  // First, draw the PDF page image as background
  overlayCanvas.width = srcCanvas.width;
  overlayCanvas.height = srcCanvas.height;
  ctx.drawImage(srcCanvas, 0, 0);

  // Helper: convert PDF coordinates → canvas pixels
  // PDF: y=0 at bottom; canvas: y=0 at top
  const toCanvasX = (pdfX: number) => pdfX * scale;
  const toCanvasY = (pdfY: number) => (pageHeightPt - pdfY) * scale;

  for (const sys of systems) {
    const [bx0, by0, bx1, by1] = sys.bbox;
    const cx0 = toCanvasX(bx0);
    const cy0 = toCanvasY(by1); // note: y1 in PDF is top of box
    const cx1 = toCanvasX(bx1);
    const cy1 = toCanvasY(by0);

    // System bounding box — semi-transparent blue
    ctx.strokeStyle = 'rgba(0, 100, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.setLineDash([]);

    // System label
    ctx.fillStyle = 'rgba(0, 100, 255, 0.8)';
    ctx.font = `${Math.round(10 * scale)}px monospace`;
    ctx.fillText(`sys ${sys.systemIndex}`, cx0 + 2, cy0 - 4);

    // Barlines — red vertical lines spanning the system box
    for (const barX of sys.barlinesX) {
      const cx = toCanvasX(barX);
      ctx.strokeStyle = 'rgba(220, 40, 40, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy0);
      ctx.lineTo(cx, cy1);
      ctx.stroke();
    }

    // Measure index numbers
    for (const meas of sys.measures) {
      const mx = toCanvasX((meas.xRange[0] + meas.xRange[1]) / 2);
      ctx.fillStyle = 'rgba(180, 0, 200, 0.85)';
      ctx.font = `bold ${Math.round(8 * scale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`m${meas.globalIndex}`, mx, cy0 - 1);
      ctx.textAlign = 'left';

      // Chord event labels
      for (const evt of meas.events) {
        const ex = toCanvasX(evt.x);
        const ey = toCanvasY(evt.y);

        // Background pill
        const label = evt.norm;
        ctx.font = `bold ${Math.round(9 * scale)}px monospace`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(255, 230, 0, 0.85)';
        ctx.fillRect(ex - 1, ey - Math.round(9 * scale) - 1, tw + 4, Math.round(10 * scale) + 2);

        ctx.fillStyle = '#222';
        ctx.fillText(label, ex + 1, ey - 2);
      }
    }

    // Rehearsal markers — green label
    for (const marker of sys.markers) {
      if (marker.type === 'rehearsal') {
        const mx = toCanvasX(marker.x);
        const my = toCanvasY(marker.y);
        ctx.fillStyle = 'rgba(0, 160, 80, 0.9)';
        ctx.font = `bold ${Math.round(12 * scale)}px sans-serif`;
        ctx.fillText(`[${marker.value}]`, mx, my - 2);
      }
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function UGProImporterPanel({ onImportCsmpn, initialFile }: Props) {
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [showJson, setShowJson] = useState(false);
  const [copiedCsmpn, setCopiedCsmpn] = useState(false);
  const [config, setConfig] = useState<UGProImporterConfig>({ ...DEFAULT_CONFIG });

  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Draw overlay when page or result changes ──────────────────────────────
  useEffect(() => {
    if (!result || !overlayCanvasRef.current) return;
    const pageRender = result.pageRenders[currentPage];
    if (!pageRender) return;
    drawDebugOverlay(overlayCanvasRef.current, pageRender);
  }, [result, currentPage]);

  // ── Auto-process initialFile when provided ────────────────────────────────
  useEffect(() => {
    if (initialFile) {
      processFile(initialFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // ── File handling ─────────────────────────────────────────────────────────
  const processFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        setError('Please select a PDF file.');
        setStatus('error');
        return;
      }

      setStatus('loading');
      setError('');
      setResult(null);
      setCurrentPage(0);

      try {
        const importResult = await importUGProPdf(file, config);
        setResult(importResult);
        setStatus('done');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    },
    [config],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile],
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault();

  const handleCopyCsmpn = useCallback(async () => {
    if (!result?.csmpnText) return;
    try {
      await navigator.clipboard.writeText(result.csmpnText);
      setCopiedCsmpn(true);
      setTimeout(() => setCopiedCsmpn(false), 2000);
    } catch {
      // Fallback for Safari/older browsers
      const ta = document.createElement('textarea');
      ta.value = result.csmpnText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopiedCsmpn(true);
      setTimeout(() => setCopiedCsmpn(false), 2000);
    }
  }, [result]);

  const handleUseChart = useCallback(() => {
    if (result?.csmpnText && onImportCsmpn) {
      onImportCsmpn(result.csmpnText);
    }
  }, [result, onImportCsmpn]);

  // ── Config helpers ────────────────────────────────────────────────────────
  const handleConfigChange = <K extends keyof UGProImporterConfig>(
    key: K,
    value: UGProImporterConfig[K],
  ) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const totalPages = result?.pageRenders.length ?? 0;
  const pagesWithSystems = result?.pageRenders.filter((pr) => pr.systems.length > 0) ?? [];
  const measureCount = result?.debugJson.linear.measures.length ?? 0;
  const chordCount = result?.debugJson.linear.measures.reduce(
    (acc, m) => acc + m.chords.length, 0,
  ) ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.panel}>
      <h2 style={styles.heading}>UG Pro PDF → CSMPN Importer</h2>

      {/* Config panel */}
      <details style={styles.configSection}>
        <summary style={styles.configSummary}>Configuration</summary>
        <div style={styles.configGrid}>
          <label style={styles.configLabel}>Measures / line</label>
          <input
            type="number"
            min={1}
            max={8}
            value={config.measuresPerLine}
            onChange={(e) => handleConfigChange('measuresPerLine', parseInt(e.target.value, 10))}
            style={styles.configInput}
          />

          <label style={styles.configLabel}>Render scale</label>
          <input
            type="number"
            min={0.8}
            max={3}
            step={0.1}
            value={config.renderScale}
            onChange={(e) => handleConfigChange('renderScale', parseFloat(e.target.value))}
            style={styles.configInput}
          />

          <label style={styles.configLabel}>System cluster threshold (px)</label>
          <input
            type="number"
            min={10}
            max={100}
            value={config.ySystemClusterThresholdPx}
            onChange={(e) => handleConfigChange('ySystemClusterThresholdPx', parseInt(e.target.value, 10))}
            style={styles.configInput}
          />

          <label style={styles.configLabel}>Barline peak min height ratio</label>
          <input
            type="number"
            min={0.1}
            max={1.0}
            step={0.05}
            value={config.barlinePeakMinHeightRatio}
            onChange={(e) => handleConfigChange('barlinePeakMinHeightRatio', parseFloat(e.target.value))}
            style={styles.configInput}
          />

          <label style={styles.configLabel}>Barline min spacing (px)</label>
          <input
            type="number"
            min={5}
            max={80}
            value={config.barlinePeakMinSpacingPx}
            onChange={(e) => handleConfigChange('barlinePeakMinSpacingPx', parseInt(e.target.value))}
            style={styles.configInput}
          />

          <label style={styles.configLabel}>
            <input
              type="checkbox"
              checked={config.fillEmptyMeasuresWithPercent}
              onChange={(e) => handleConfigChange('fillEmptyMeasuresWithPercent', e.target.checked)}
            />
            {' '}Empty bars → %
          </label>
          <div />

          <label style={styles.configLabel}>
            <input
              type="checkbox"
              checked={config.allowMultiChordBars}
              onChange={(e) => handleConfigChange('allowMultiChordBars', e.target.checked)}
            />
            {' '}Allow multi-chord bars
          </label>
          <div />
        </div>
      </details>

      {/* Drop zone */}
      <div
        style={{
          ...styles.dropZone,
          ...(status === 'loading' ? styles.dropZoneLoading : {}),
        }}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        {status === 'loading' ? (
          <span style={styles.statusText}>Processing PDF...</span>
        ) : (
          <span style={styles.statusText}>
            Drop a UG Pro PDF here or <u>click to browse</u>
          </span>
        )}
      </div>

      {/* Error */}
      {status === 'error' && (
        <div style={styles.errorBox}>{error}</div>
      )}

      {/* Results */}
      {status === 'done' && result && (
        <div style={styles.results}>
          {/* Summary stats */}
          <div style={styles.stats}>
            <span>{totalPages} page{totalPages !== 1 ? 's' : ''}</span>
            <span>{pagesWithSystems.length} system page{pagesWithSystems.length !== 1 ? 's' : ''}</span>
            <span>{measureCount} measures</span>
            <span>{chordCount} chords</span>
          </div>

          {/* Page selector */}
          {totalPages > 1 && (
            <div style={styles.pageNav}>
              <span>Page: </span>
              {result.pageRenders.map((_, i) => (
                <button
                  key={i}
                  style={{
                    ...styles.pageBtn,
                    ...(i === currentPage ? styles.pageBtnActive : {}),
                  }}
                  onClick={() => setCurrentPage(i)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          )}

          {/* Debug overlay canvas */}
          <div style={styles.canvasWrapper}>
            <canvas
              ref={overlayCanvasRef}
              style={styles.overlayCanvas}
            />
          </div>

          {/* Legend */}
          <div style={styles.legend}>
            <span style={{ color: 'rgba(0,100,255,0.8)' }}>■ System bbox</span>
            <span style={{ color: 'rgba(220,40,40,0.8)' }}>| Barlines</span>
            <span style={{ color: 'rgba(180,0,200,0.9)' }}>m# Measure index</span>
            <span style={{ background: 'rgba(255,230,0,0.85)', color: '#222', padding: '0 4px' }}>
              Chord token
            </span>
          </div>

          {/* CSMPN output */}
          <div style={styles.csmpnSection}>
            <div style={styles.csmpnHeader}>
              <span style={styles.csmpnLabel}>CSMPN Output</span>
              <div style={styles.csmpnActions}>
                <button style={styles.actionBtn} onClick={handleCopyCsmpn}>
                  {copiedCsmpn ? 'Copied!' : 'Copy'}
                </button>
                {onImportCsmpn && (
                  <button
                    style={{ ...styles.actionBtn, ...styles.primaryBtn }}
                    onClick={handleUseChart}
                  >
                    Use This Chart
                  </button>
                )}
              </div>
            </div>
            <textarea
              style={styles.csmpnTextarea}
              readOnly
              value={result.csmpnText}
              spellCheck={false}
            />
          </div>

          {/* Debug JSON viewer */}
          <details style={styles.jsonSection}>
            <summary
              style={styles.jsonSummary}
              onClick={() => setShowJson((v) => !v)}
            >
              Debug JSON {showJson ? '▲' : '▼'}
            </summary>
            <pre style={styles.jsonPre}>
              {JSON.stringify(result.debugJson, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────────────────────────
// Using inline styles for portability — no external CSS dependency.

const styles: Record<string, React.CSSProperties> = {
  panel: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '100%',
    padding: '16px',
    boxSizing: 'border-box',
    color: '#e0e0e0',
  },
  heading: {
    fontSize: '1.25rem',
    fontWeight: 700,
    marginBottom: '12px',
    color: '#fff',
  },
  configSection: {
    marginBottom: '12px',
    background: 'rgba(255,255,255,0.05)',
    borderRadius: '6px',
    padding: '8px 12px',
    border: '1px solid rgba(255,255,255,0.1)',
  },
  configSummary: {
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.9rem',
    color: '#aac',
  },
  configGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '6px 12px',
    marginTop: '10px',
    alignItems: 'center',
    fontSize: '0.82rem',
  },
  configLabel: {
    color: '#ccc',
  },
  configInput: {
    background: 'rgba(255,255,255,0.1)',
    border: '1px solid rgba(255,255,255,0.2)',
    borderRadius: '4px',
    color: '#eee',
    padding: '3px 6px',
    fontSize: '0.82rem',
    width: '80px',
  },
  dropZone: {
    border: '2px dashed rgba(255,255,255,0.25)',
    borderRadius: '10px',
    padding: '32px 16px',
    textAlign: 'center',
    cursor: 'pointer',
    transition: 'background 0.2s',
    background: 'rgba(255,255,255,0.03)',
    marginBottom: '12px',
    userSelect: 'none',
  },
  dropZoneLoading: {
    background: 'rgba(0,100,255,0.07)',
    borderColor: 'rgba(0,120,255,0.5)',
  },
  statusText: {
    fontSize: '0.95rem',
    color: '#aac',
  },
  errorBox: {
    background: 'rgba(200,0,0,0.15)',
    border: '1px solid rgba(220,50,50,0.4)',
    borderRadius: '6px',
    color: '#f88',
    padding: '10px 14px',
    fontSize: '0.88rem',
    marginBottom: '12px',
  },
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  stats: {
    display: 'flex',
    gap: '16px',
    flexWrap: 'wrap',
    fontSize: '0.85rem',
    color: '#aac',
  },
  pageNav: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.88rem',
    color: '#ccc',
  },
  pageBtn: {
    padding: '3px 10px',
    borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(255,255,255,0.07)',
    color: '#ccc',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  pageBtnActive: {
    background: 'rgba(0,120,255,0.4)',
    borderColor: 'rgba(0,150,255,0.6)',
    color: '#fff',
  },
  canvasWrapper: {
    overflowX: 'auto',
    overflowY: 'auto',
    maxHeight: '600px',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '6px',
    background: '#1a1a1a',
  },
  overlayCanvas: {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
  },
  legend: {
    display: 'flex',
    gap: '14px',
    flexWrap: 'wrap',
    fontSize: '0.78rem',
    color: '#aaa',
    alignItems: 'center',
  },
  csmpnSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  csmpnHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '8px',
  },
  csmpnLabel: {
    fontWeight: 600,
    fontSize: '0.92rem',
    color: '#dde',
  },
  csmpnActions: {
    display: 'flex',
    gap: '8px',
  },
  actionBtn: {
    padding: '5px 14px',
    borderRadius: '5px',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'rgba(255,255,255,0.08)',
    color: '#ccc',
    cursor: 'pointer',
    fontSize: '0.85rem',
  },
  primaryBtn: {
    background: 'rgba(0,120,255,0.45)',
    borderColor: 'rgba(0,160,255,0.6)',
    color: '#fff',
    fontWeight: 600,
  },
  csmpnTextarea: {
    width: '100%',
    minHeight: '220px',
    background: 'rgba(0,0,0,0.35)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '6px',
    color: '#e8e8ff',
    fontFamily: 'monospace',
    fontSize: '0.82rem',
    padding: '10px',
    resize: 'vertical',
    boxSizing: 'border-box',
    lineHeight: 1.55,
  },
  jsonSection: {
    background: 'rgba(0,0,0,0.2)',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.08)',
    padding: '8px 12px',
  },
  jsonSummary: {
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: '0.88rem',
    color: '#99a',
  },
  jsonPre: {
    fontFamily: 'monospace',
    fontSize: '0.72rem',
    color: '#8af',
    overflowX: 'auto',
    maxHeight: '360px',
    overflowY: 'auto',
    marginTop: '8px',
    lineHeight: 1.45,
  },
};

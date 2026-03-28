/**
 * SvgImporterPanel.tsx
 *
 * React UI for the Standard SVG Importer (ChordSheet Maker Pro v1.10.0).
 *
 * Replaces the former OpenSong XML / OpenLyrics XML upload panels with a
 * self-contained SVG import experience.
 *
 * Features:
 *   - Drag-and-drop / file-picker accepting .svg files.
 *   - Live SVG preview rendered via a sandboxed <img> blob URL.
 *   - Zoom controls (25 % → 400 %, plus Fit-to-panel shortcut).
 *   - Document metadata: viewBox coordinate system, width/height, xmlns.
 *   - Element statistics: per-type counts across the full document tree.
 *   - Extracted text strings harvested from <text> / <tspan> nodes.
 *   - Parser warnings panel (non-fatal issues collected during import).
 *   - Download button to re-export the original SVG source verbatim.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { importSvg, SVG_NAMESPACE, type SvgImportResult } from '../ingest/svgImporter';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /**
   * Pre-load this file when the panel mounts.
   * Used when the app routes a dropped / picked SVG directly to this panel.
   */
  initialFile?: File | null;
}

// ─── Local types ──────────────────────────────────────────────────────────────

type ImportStatus = 'idle' | 'loading' | 'done' | 'error';

/** Zoom state: a positive number = explicit CSS scale; 'fit' = max-width 100%. */
type ZoomMode = number | 'fit';

// ─── Component ────────────────────────────────────────────────────────────────

export default function SvgImporterPanel({ initialFile }: Props) {
  const [status, setStatus]           = useState<ImportStatus>('idle');
  const [error, setError]             = useState('');
  const [result, setResult]           = useState<SvgImportResult | null>(null);
  const [previewUrl, setPreviewUrl]   = useState<string | null>(null);
  const [zoom, setZoom]               = useState<ZoomMode>('fit');
  const [filename, setFilename]       = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke object URL when it changes or component unmounts
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // ── File processing ────────────────────────────────────────────────────────

  const processFile = useCallback(async (file: File) => {
    const nameLower = file.name.toLowerCase();
    if (!nameLower.endsWith('.svg') && file.type !== 'image/svg+xml') {
      setError('Please select an SVG file (.svg).');
      setStatus('error');
      return;
    }

    setStatus('loading');
    setError('');
    setResult(null);
    setFilename(file.name);

    // Revoke the previous preview URL before creating a new one
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    try {
      const text = await file.text();
      const parsed = importSvg(text);

      // Build a sandboxed blob URL for the <img> preview.
      // Using <img> (not dangerouslySetInnerHTML) keeps script execution
      // fully sandboxed by the browser regardless of SVG content.
      const blob = new Blob([parsed.svgSource], { type: 'image/svg+xml' });
      const url  = URL.createObjectURL(blob);

      setResult(parsed);
      setPreviewUrl(url);
      setZoom('fit');
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }, []);

  // Auto-process a file supplied by the parent on mount / prop change
  useEffect(() => {
    if (initialFile) void processFile(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  // ── Event handlers ─────────────────────────────────────────────────────────

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void processFile(file);
    },
    [processFile],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void processFile(file);
    },
    [processFile],
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => e.preventDefault();

  const handleReset = useCallback(() => {
    setStatus('idle');
    setError('');
    setResult(null);
    setFilename('');
    setZoom('fit');
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleDownload = useCallback(() => {
    if (!result?.svgSource) return;
    const blob = new Blob([result.svgSource], { type: 'image/svg+xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename || 'export.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
  }, [result, filename]);

  // ── Zoom helpers ───────────────────────────────────────────────────────────

  const zoomStep = (delta: number) =>
    setZoom((z) => {
      const current = z === 'fit' ? 1 : z;
      return Math.max(0.25, Math.min(4, Number((current + delta).toFixed(2))));
    });

  const zoomLabel = zoom === 'fit' ? 'Fit' : `${Math.round((zoom as number) * 100)}%`;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={s.panel}>
      <h2 style={s.heading}>SVG Importer</h2>

      {/* ── Drop zone (shown when idle or errored) ── */}
      {status !== 'done' && (
        <div
          style={{
            ...s.dropZone,
            ...(status === 'loading' ? s.dropZoneActive : {}),
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg,image/svg+xml"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          {status === 'loading' ? (
            <span style={s.statusText}>Parsing SVG document…</span>
          ) : (
            <>
              <span style={s.dropIcon}>⬆</span>
              <span style={s.statusText}>
                Drop an <strong>.svg</strong> file here, or{' '}
                <u style={s.browseLink}>click to browse</u>
              </span>
              <span style={s.dropHint}>
                Accepts standard SVG 1.1 / 2.0 — namespace-aware parsing
              </span>
            </>
          )}
        </div>
      )}

      {/* ── Error message ── */}
      {status === 'error' && (
        <div style={s.errorBox}>
          <strong>Import error:</strong> {error}
        </div>
      )}

      {/* ── Result ── */}
      {status === 'done' && result && (
        <div style={s.results}>

          {/* ── Action bar ── */}
          <div style={s.actionBar}>
            <div style={s.fileLabel}>
              <span style={s.fileLabelIcon}>◈</span>
              <span style={s.fileLabelText}>
                {result.title ?? filename ?? 'SVG Document'}
              </span>
            </div>
            <div style={s.actionBtns}>
              <button style={s.btn} onClick={handleReset}>← New File</button>
              <button style={s.btn} onClick={handleDownload}>Download SVG</button>
            </div>
          </div>

          {/* ── Parser warnings ── */}
          {result.warnings.length > 0 && (
            <div style={s.warningBox}>
              <strong style={s.warningTitle}>Parser notices:</strong>
              <ul style={s.warningList}>
                {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {/* ── Two-column body: preview + metadata ── */}
          <div style={s.twoCol}>

            {/* ── Left: SVG preview ── */}
            <div style={s.previewCol}>
              <div style={s.previewHeader}>
                <span style={s.sectionLabel}>Preview</span>
                <div style={s.zoomRow}>
                  <button style={s.zoomBtn} onClick={() => zoomStep(-0.25)}>−</button>
                  <span style={s.zoomValue}>{zoomLabel}</span>
                  <button style={s.zoomBtn} onClick={() => zoomStep(+0.25)}>+</button>
                  <button style={s.zoomBtn} onClick={() => setZoom(1)}>1:1</button>
                  <button style={s.zoomBtn} onClick={() => setZoom('fit')}>Fit</button>
                </div>
              </div>

              <div style={s.previewViewport}>
                {previewUrl && (
                  <img
                    src={previewUrl}
                    alt={result.title ?? 'SVG preview'}
                    style={
                      zoom === 'fit'
                        ? s.previewImgFit
                        : {
                            ...s.previewImgZoomed,
                            transform: `scale(${zoom})`,
                          }
                    }
                  />
                )}
              </div>
            </div>

            {/* ── Right: metadata + stats ── */}
            <div style={s.metaCol}>

              {/* Document metadata */}
              <div style={s.card}>
                <div style={s.cardTitle}>Document Metadata</div>
                <table style={s.metaTable}>
                  <tbody>
                    {result.width && (
                      <tr>
                        <td style={s.metaKey}>Width</td>
                        <td style={s.metaVal}>{result.width}</td>
                      </tr>
                    )}
                    {result.height && (
                      <tr>
                        <td style={s.metaKey}>Height</td>
                        <td style={s.metaVal}>{result.height}</td>
                      </tr>
                    )}
                    {result.viewBox ? (
                      <tr>
                        <td style={s.metaKey}>viewBox</td>
                        <td style={s.metaVal}>
                          {`${result.viewBox.x} ${result.viewBox.y} `}
                          {`${result.viewBox.width} ${result.viewBox.height}`}
                        </td>
                      </tr>
                    ) : (
                      <tr>
                        <td style={s.metaKey}>viewBox</td>
                        <td style={{ ...s.metaVal, ...s.metaMuted }}>none</td>
                      </tr>
                    )}
                    <tr>
                      <td style={s.metaKey}>xmlns</td>
                      <td style={{
                        ...s.metaVal,
                        ...(result.xmlns === SVG_NAMESPACE ? s.metaOk : s.metaWarn),
                      }}>
                        {result.xmlns}
                      </td>
                    </tr>
                    {result.title && (
                      <tr>
                        <td style={s.metaKey}>title</td>
                        <td style={s.metaVal}>{result.title}</td>
                      </tr>
                    )}
                    {result.description && (
                      <tr>
                        <td style={s.metaKey}>desc</td>
                        <td style={s.metaVal}>{result.description}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Element statistics */}
              <div style={s.card}>
                <div style={s.cardTitle}>
                  Element Statistics
                  <span style={s.cardBadge}>{result.stats.totalElements} total</span>
                </div>
                <div style={s.statsGrid}>
                  {(
                    [
                      ['Paths',      result.stats.paths],
                      ['Rects',      result.stats.rects],
                      ['Circles',    result.stats.circles],
                      ['Ellipses',   result.stats.ellipses],
                      ['Lines',      result.stats.lines],
                      ['Polygons',   result.stats.polygons],
                      ['Polylines',  result.stats.polylines],
                      ['Groups',     result.stats.groups],
                      ['Texts',      result.stats.texts],
                      ['Images',     result.stats.images],
                      ['Uses',       result.stats.uses],
                      ['Defs',       result.stats.defs],
                      ['Other',      result.stats.other],
                    ] as [string, number][]
                  )
                    .filter(([, n]) => n > 0)
                    .map(([label, count]) => (
                      <div key={label} style={s.statChip}>
                        <span style={s.statCount}>{count}</span>
                        <span style={s.statLabel}>{label}</span>
                      </div>
                    ))}
                </div>
              </div>

              {/* Extracted text content */}
              {result.extractedText.length > 0 && (
                <div style={s.card}>
                  <div style={s.cardTitle}>
                    Extracted Text
                    <span style={s.cardBadge}>{result.extractedText.length}</span>
                  </div>
                  <ul style={s.textList}>
                    {result.extractedText.map((t, i) => (
                      <li key={i} style={s.textItem}>&ldquo;{t}&rdquo;</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Empty text notice */}
              {result.extractedText.length === 0 && (
                <div style={s.card}>
                  <div style={s.cardTitle}>Extracted Text</div>
                  <p style={s.emptyNote}>
                    No &lt;text&gt; or &lt;tspan&gt; elements found in this SVG.
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Inline styles ────────────────────────────────────────────────────────────
// Self-contained — no external CSS dependency required.

const s: Record<string, React.CSSProperties> = {
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
    marginTop: 0,
    marginBottom: '14px',
    color: '#fff',
    letterSpacing: '0.01em',
  },

  // ── Drop zone ──
  dropZone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    border: '2px dashed rgba(255,255,255,0.22)',
    borderRadius: '12px',
    padding: '48px 24px',
    textAlign: 'center',
    cursor: 'pointer',
    background: 'rgba(255,255,255,0.03)',
    transition: 'background 0.2s, border-color 0.2s',
    marginBottom: '12px',
    userSelect: 'none',
  },
  dropZoneActive: {
    background: 'rgba(80,160,255,0.08)',
    borderColor: 'rgba(80,180,255,0.55)',
  },
  dropIcon: {
    fontSize: '2rem',
    lineHeight: 1,
    color: 'rgba(120,180,255,0.7)',
  },
  statusText: {
    fontSize: '0.97rem',
    color: '#b0c4de',
  },
  dropHint: {
    fontSize: '0.78rem',
    color: 'rgba(180,200,220,0.55)',
  },
  browseLink: {
    cursor: 'pointer',
    color: '#7ab8f5',
  },

  // ── Error ──
  errorBox: {
    background: 'rgba(200,0,0,0.14)',
    border: '1px solid rgba(220,50,50,0.4)',
    borderRadius: '8px',
    color: '#f99',
    padding: '10px 14px',
    fontSize: '0.88rem',
    marginBottom: '12px',
  },

  // ── Results ──
  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },

  // ── Action bar ──
  actionBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '10px',
    padding: '8px 0',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  },
  fileLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    overflow: 'hidden',
  },
  fileLabelIcon: {
    color: 'rgba(120,200,255,0.8)',
    fontSize: '1.1rem',
    flexShrink: 0,
  },
  fileLabelText: {
    fontWeight: 600,
    fontSize: '0.95rem',
    color: '#dde',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  actionBtns: {
    display: 'flex',
    gap: '8px',
    flexShrink: 0,
  },
  btn: {
    padding: '5px 14px',
    borderRadius: '6px',
    border: '1px solid rgba(255,255,255,0.18)',
    background: 'rgba(255,255,255,0.07)',
    color: '#ccc',
    cursor: 'pointer',
    fontSize: '0.84rem',
    whiteSpace: 'nowrap',
  },

  // ── Warnings ──
  warningBox: {
    background: 'rgba(255,200,0,0.07)',
    border: '1px solid rgba(255,200,0,0.28)',
    borderRadius: '8px',
    padding: '10px 14px',
    fontSize: '0.83rem',
    color: '#e8d080',
  },
  warningTitle: {
    display: 'block',
    marginBottom: '4px',
  },
  warningList: {
    margin: 0,
    paddingLeft: '18px',
    lineHeight: 1.6,
  },

  // ── Two-column layout ──
  twoCol: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
    gap: '14px',
    alignItems: 'start',
  },

  // ── Preview column ──
  previewCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    minWidth: 0,
  },
  previewHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
  },
  sectionLabel: {
    fontWeight: 600,
    fontSize: '0.88rem',
    color: '#aac',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  zoomRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  zoomBtn: {
    padding: '3px 9px',
    borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.06)',
    color: '#bbb',
    cursor: 'pointer',
    fontSize: '0.82rem',
    lineHeight: 1.4,
  },
  zoomValue: {
    minWidth: '40px',
    textAlign: 'center',
    fontSize: '0.82rem',
    color: '#aac',
    fontVariantNumeric: 'tabular-nums',
  },
  previewViewport: {
    overflow: 'auto',
    maxHeight: '560px',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: '8px',
    background: '#141416',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  previewImgFit: {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
  },
  previewImgZoomed: {
    display: 'block',
    transformOrigin: 'top left',
    // width/height intentionally left to natural size so the viewport scrolls
  },

  // ── Metadata column ──
  metaCol: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minWidth: 0,
  },

  // ── Cards ──
  card: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.09)',
    borderRadius: '8px',
    padding: '10px 12px',
  },
  cardTitle: {
    fontWeight: 600,
    fontSize: '0.84rem',
    color: '#9ab',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  cardBadge: {
    background: 'rgba(80,160,255,0.2)',
    border: '1px solid rgba(80,160,255,0.35)',
    borderRadius: '99px',
    color: '#7ab8f5',
    fontSize: '0.75rem',
    padding: '1px 8px',
    fontWeight: 500,
    letterSpacing: 0,
    textTransform: 'none',
  },

  // ── Metadata table ──
  metaTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.82rem',
  },
  metaKey: {
    color: '#889',
    paddingRight: '10px',
    paddingBottom: '4px',
    verticalAlign: 'top',
    whiteSpace: 'nowrap',
    fontVariantNumeric: 'tabular-nums',
  },
  metaVal: {
    color: '#dde',
    wordBreak: 'break-all',
    paddingBottom: '4px',
  },
  metaMuted: {
    color: '#556',
    fontStyle: 'italic',
  },
  metaOk: {
    color: '#7de898',
  },
  metaWarn: {
    color: '#e8c070',
  },

  // ── Stats grid ──
  statsGrid: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  statChip: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    background: 'rgba(80,120,200,0.15)',
    border: '1px solid rgba(80,120,200,0.25)',
    borderRadius: '6px',
    padding: '5px 10px',
    minWidth: '52px',
  },
  statCount: {
    fontSize: '1.05rem',
    fontWeight: 700,
    color: '#7ab8f5',
    lineHeight: 1.2,
  },
  statLabel: {
    fontSize: '0.72rem',
    color: '#889',
    marginTop: '2px',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },

  // ── Extracted text list ──
  textList: {
    margin: 0,
    paddingLeft: '16px',
    fontSize: '0.83rem',
    color: '#ccd',
    lineHeight: 1.7,
    maxHeight: '160px',
    overflowY: 'auto',
  },
  textItem: {
    wordBreak: 'break-word',
  },

  // ── Empty state ──
  emptyNote: {
    fontSize: '0.82rem',
    color: '#556',
    fontStyle: 'italic',
    margin: 0,
  },
};

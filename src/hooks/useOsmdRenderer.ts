/**
 * useOsmdRenderer.ts
 *
 * Custom hook that owns all OSMD notation-renderer state and effects.
 * Extracted from App.tsx (Sprint 4, item 3.1).
 *
 * The hook encapsulates:
 *   - The DOM container ref and OSMD instance ref
 *   - loadedXmlText / isMxl state
 *   - zoom / renderedPageCount state
 *   - OSMD initialisation effect
 *   - OSMD render-on-change effect
 *   - Derived `diagnostics` (from parseXmlWithDiagnostics)
 *   - fitWidth / adjustZoom callbacks
 *   - clearOsmd helper (resets all OSMD state for "Clear" button)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { parseXmlWithDiagnostics, getRenderedSvgs, type Diagnostics } from '../utils/osmdHelpers';

// ─── Hook ──────────────────────────────────────────────────────────────────────

interface UseOsmdRendererProps {
  /** Called when OSMD throws during load/render. Passes the error message. */
  setRenderError: (msg: string) => void;
}

export function useOsmdRenderer({ setRenderError }: UseOsmdRendererProps) {
  // ── Refs ──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const didAutoFitRef = useRef(false);
  const xmlLoadedRef = useRef('');

  // ── State ──
  const [loadedXmlText, setLoadedXmlText] = useState('');
  const [isMxl, setIsMxl] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [renderedPageCount, setRenderedPageCount] = useState(0);

  // ── Derived: XML diagnostics ──
  const parsedXml = useMemo(() => {
    if (!loadedXmlText) return null;
    return parseXmlWithDiagnostics(loadedXmlText);
  }, [loadedXmlText]);

  const diagnostics: Diagnostics | null = parsedXml?.diagnostics ?? null;

  // ── OSMD initialisation ──
  useEffect(() => {
    if (!containerRef.current || osmdRef.current) return;
    osmdRef.current = new OpenSheetMusicDisplay(containerRef.current, {
      autoResize: true,
      drawingParameters: 'default',
    });
    return () => {
      osmdRef.current = null;
    };
  }, []);

  // ── Fit-to-width callback ──
  const fitWidth = useCallback(() => {
    const container = containerRef.current;
    const osmd = osmdRef.current;
    if (!container || !osmd) return;
    const firstPage = container.querySelector('.osmd-page') as HTMLElement | null;
    const containerWidth = container.clientWidth;
    if (firstPage && firstPage.offsetWidth > 0) {
      const ratio = containerWidth / firstPage.offsetWidth;
      const target = osmd.Zoom * ratio;
      setZoom(Math.max(0.4, Math.min(2.5, Number(target.toFixed(2)))));
      return;
    }
    setZoom(containerWidth < 600 ? 0.6 : containerWidth < 900 ? 0.8 : 1.0);
  }, []);

  // ── OSMD render on XML / zoom / diagnostics change ──
  useEffect(() => {
    const render = async () => {
      const osmd = osmdRef.current;
      if (!osmd || !loadedXmlText) return;
      if (!diagnostics?.isValidXml || !diagnostics.isMusicXml) {
        if (containerRef.current) containerRef.current.innerHTML = '';
        xmlLoadedRef.current = '';
        setRenderedPageCount(0);
        return;
      }
      try {
        setRenderError('');
        if (xmlLoadedRef.current !== loadedXmlText) {
          await osmd.load(loadedXmlText);
          xmlLoadedRef.current = loadedXmlText;
        }
        osmd.Zoom = zoom;
        osmd.render();
        setRenderedPageCount(getRenderedSvgs(containerRef.current).length);
        if (!didAutoFitRef.current) {
          didAutoFitRef.current = true;
          requestAnimationFrame(fitWidth);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRenderError(message);
        xmlLoadedRef.current = '';
        setRenderedPageCount(0);
      }
    };
    void render();
    // setRenderError is stable (React setState setter); safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedXmlText, zoom, diagnostics, fitWidth]);

  // ── Zoom adjustment ──
  const adjustZoom = useCallback((delta: number) => {
    setZoom((prev) => Math.max(0.4, Math.min(2.5, Number((prev + delta).toFixed(2)))));
  }, []);

  // ── Reset auto-fit flag (called before setLoadedXmlText on new file load) ──
  const resetAutoFit = useCallback(() => {
    didAutoFitRef.current = false;
  }, []);

  // ── Full reset (called by clearAll and when switching away from notation mode) ──
  const clearOsmd = useCallback(() => {
    setLoadedXmlText('');
    setIsMxl(false);
    setZoom(1);
    setRenderedPageCount(0);
    xmlLoadedRef.current = '';
    didAutoFitRef.current = false;
    if (containerRef.current) containerRef.current.innerHTML = '';
  }, []);

  return {
    containerRef,
    osmdRef,
    loadedXmlText,
    setLoadedXmlText,
    isMxl,
    setIsMxl,
    zoom,
    renderedPageCount,
    diagnostics,
    fitWidth,
    adjustZoom,
    resetAutoFit,
    clearOsmd,
  };
}

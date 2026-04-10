/**
 * osmdHelpers.ts
 *
 * Pure utility functions extracted from App.tsx (Sprint 4, item 3.1).
 * Contains OSMD engraving-rule manipulation, SVG/canvas helpers, and
 * the XML diagnostic parser. No React dependencies.
 */

import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

// ─── Shared types ──────────────────────────────────────────────────────────────

export type PdfPageSize = 'letter' | 'a4';
export type PrintPageSize = PdfPageSize;

export type Diagnostics = {
  isValidXml: boolean;
  isMusicXml: boolean;
  parseError?: string;
  rootName: string;
  version: string;
  parts: number;
  measures: number;
  notes: number;
  harmonies: number;
  hasKey: boolean;
  hasTime: boolean;
  hasDivisions: boolean;
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const IOS_USER_AGENT = /iPad|iPhone|iPod/;
export const PRINT_ZOOM = 1.0;

// ─── OSMD engraving-rule helpers ──────────────────────────────────────────────

type MutableEngravingRules = OpenSheetMusicDisplay['EngravingRules'] & {
  PageWidth?: number;
};

type EngravingRulesSnapshot = Partial<{
  PageWidth: number;
  PageHeight: number;
  PageTopMargin: number;
  PageBottomMargin: number;
  PageLeftMargin: number;
  PageRightMargin: number;
  SystemLeftMargin: number;
  SystemRightMargin: number;
}> & {
  PageFormatWidth?: number;
  PageFormatHeight?: number;
};

export function getRuleValue(
  rules: MutableEngravingRules,
  key: keyof EngravingRulesSnapshot
): number | undefined {
  if (!(key in rules)) return undefined;
  const value = (rules as unknown as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

export function setRuleValue(
  rules: MutableEngravingRules,
  key: keyof EngravingRulesSnapshot,
  value: number
): void {
  if (!(key in rules)) return;
  (rules as unknown as Record<string, unknown>)[key] = value;
}

export function snapshotEngravingRules(osmd: OpenSheetMusicDisplay): EngravingRulesSnapshot {
  const rules = osmd.EngravingRules as MutableEngravingRules;
  const pageFormat =
    'PageFormat' in rules
      ? (rules.PageFormat as { width?: number; height?: number } | undefined)
      : undefined;

  return {
    PageWidth: getRuleValue(rules, 'PageWidth'),
    PageHeight: getRuleValue(rules, 'PageHeight'),
    PageTopMargin: getRuleValue(rules, 'PageTopMargin'),
    PageBottomMargin: getRuleValue(rules, 'PageBottomMargin'),
    PageLeftMargin: getRuleValue(rules, 'PageLeftMargin'),
    PageRightMargin: getRuleValue(rules, 'PageRightMargin'),
    SystemLeftMargin: getRuleValue(rules, 'SystemLeftMargin'),
    SystemRightMargin: getRuleValue(rules, 'SystemRightMargin'),
    PageFormatWidth: typeof pageFormat?.width === 'number' ? pageFormat.width : undefined,
    PageFormatHeight: typeof pageFormat?.height === 'number' ? pageFormat.height : undefined,
  };
}

export function applyPrintProfile(osmd: OpenSheetMusicDisplay, pageSize: PrintPageSize): void {
  const rules = osmd.EngravingRules as MutableEngravingRules;
  const formatId = pageSize === 'letter' ? 'Letter_P' : 'A4_P';
  osmd.setPageFormat(formatId);

  if (pageSize === 'letter') {
    setRuleValue(rules, 'PageWidth', 8.5);
    setRuleValue(rules, 'PageHeight', 11);
    setRuleValue(rules, 'PageTopMargin', 0.5);
    setRuleValue(rules, 'PageBottomMargin', 0.5);
    setRuleValue(rules, 'PageLeftMargin', 0.5);
    setRuleValue(rules, 'PageRightMargin', 0.5);
  } else {
    setRuleValue(rules, 'PageWidth', 210);
    setRuleValue(rules, 'PageHeight', 297);
    setRuleValue(rules, 'PageTopMargin', 12);
    setRuleValue(rules, 'PageBottomMargin', 12);
    setRuleValue(rules, 'PageLeftMargin', 12);
    setRuleValue(rules, 'PageRightMargin', 12);
  }
}

export function restoreEngravingRules(
  osmd: OpenSheetMusicDisplay,
  snapshot: EngravingRulesSnapshot
): void {
  const rules = osmd.EngravingRules as MutableEngravingRules;

  if (
    typeof snapshot.PageFormatWidth === 'number' &&
    typeof snapshot.PageFormatHeight === 'number'
  ) {
    osmd.setCustomPageFormat(snapshot.PageFormatWidth, snapshot.PageFormatHeight);
  }

  const ruleKeys: (keyof EngravingRulesSnapshot)[] = [
    'PageWidth',
    'PageHeight',
    'PageTopMargin',
    'PageBottomMargin',
    'PageLeftMargin',
    'PageRightMargin',
    'SystemLeftMargin',
    'SystemRightMargin',
  ];

  for (const key of ruleKeys) {
    const value = snapshot[key];
    if (typeof value === 'number') setRuleValue(rules, key, value);
  }
}

// ─── General helpers ──────────────────────────────────────────────────────────

export function getBaseFilename(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) return 'score';
  const parts = cleaned.split('.');
  if (parts.length === 1) return cleaned;
  parts.pop();
  return parts.join('.') || 'score';
}

export function getRenderedSvgs(container: HTMLDivElement | null): SVGSVGElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll('svg'));
}

export function isIOSBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return IOS_USER_AGENT.test(navigator.userAgent);
}

export function triggerBlobDownload(blob: Blob, filename: string, iOSFallbackToTab = false): void {
  const url = URL.createObjectURL(blob);
  if (iOSFallbackToTab && isIOSBrowser()) {
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      URL.revokeObjectURL(url);
      throw new Error('Popup blocked. Please allow popups and try export again.');
    }
    // iOS needs the URL to stay alive while the user interacts with the new tab.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

export function serializeSvg(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

export async function svgToCanvas(svg: SVGSVGElement, scale: number): Promise<HTMLCanvasElement> {
  const serialized = serializeSvg(svg);
  const svgBlob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode rendered SVG image.'));
      img.src = svgUrl;
    });

    const svgWidth = svg.viewBox.baseVal?.width || svg.clientWidth || image.naturalWidth;
    const svgHeight = svg.viewBox.baseVal?.height || svg.clientHeight || image.naturalHeight;

    if (svgWidth <= 0 || svgHeight <= 0) throw new Error('Rendered score has invalid dimensions.');

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(svgWidth * scale));
    canvas.height = Math.max(1, Math.round(svgHeight * scale));

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context is unavailable in this browser.');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    return canvas;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

export async function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`Failed to create ${type} blob.`));
        return;
      }
      resolve(blob);
    }, type);
  });
}

// ─── XML / MusicXML diagnostics ───────────────────────────────────────────────

export function parseXmlWithDiagnostics(xmlText: string): {
  doc: Document;
  diagnostics: Diagnostics;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'application/xml');

  const parserErrorNode =
    doc.querySelector('parsererror') ?? doc.getElementsByTagName('parsererror').item(0);

  if (parserErrorNode) {
    const errorText = parserErrorNode.textContent?.trim();
    return {
      doc,
      diagnostics: {
        isValidXml: false,
        isMusicXml: false,
        parseError: errorText ? errorText.slice(0, 300) : 'Invalid XML',
        rootName: 'error',
        version: 'n/a',
        parts: 0,
        measures: 0,
        notes: 0,
        harmonies: 0,
        hasKey: false,
        hasTime: false,
        hasDivisions: false,
      },
    };
  }

  const root = doc.documentElement;
  const rootName = root?.nodeName ?? 'unknown';
  const isMusicXml = rootName === 'score-partwise' || rootName === 'score-timewise';

  if (!isMusicXml) {
    return {
      doc,
      diagnostics: {
        isValidXml: true,
        isMusicXml: false,
        rootName,
        version: 'n/a',
        parts: 0,
        measures: 0,
        notes: 0,
        harmonies: 0,
        hasKey: false,
        hasTime: false,
        hasDivisions: false,
      },
    };
  }

  const queryCount = (selector: string) => doc.querySelectorAll(selector).length;

  return {
    doc,
    diagnostics: {
      isValidXml: true,
      isMusicXml: true,
      parseError: undefined,
      rootName,
      version: root?.getAttribute('version') ?? 'n/a',
      parts: queryCount('part'),
      measures: queryCount('measure'),
      notes: queryCount('note'),
      harmonies: queryCount('harmony'),
      hasKey: doc.querySelector('attributes > key') !== null,
      hasTime: doc.querySelector('attributes > time') !== null,
      hasDivisions: doc.querySelector('attributes > divisions') !== null,
    },
  };
}

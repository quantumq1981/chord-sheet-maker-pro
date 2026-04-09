/**
 * sectionUtils.ts
 *
 * Shared helpers used by all chord-chart parsers.
 */

import type { SectionType } from '../models/ChordChartModel';

/**
 * Infer a SectionType from a human-readable section label.
 * Checks are ordered so the most specific match wins (e.g. "pre-chorus"
 * is tested before the bare "chorus" substring).
 */
export function sectionTypeFromLabel(label: string): SectionType {
  const l = label.toLowerCase();
  if (l.includes('pre-chorus') || l.includes('prechorus')) return 'pre-chorus';
  if (l.includes('chorus') || l.includes('refrain')) return 'chorus';
  if (l.includes('verse')) return 'verse';
  if (l.includes('bridge')) return 'bridge';
  if (l.includes('intro')) return 'intro';
  if (l.includes('outro') || l.includes('coda')) return 'outro';
  if (l.includes('interlude')) return 'interlude';
  if (l.includes('solo')) return 'solo';
  if (l.includes('grid')) return 'grid';
  if (l.includes('tab')) return 'tab';
  return 'unknown';
}

/** Normalise Windows / old-Mac line endings to `\n`. */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

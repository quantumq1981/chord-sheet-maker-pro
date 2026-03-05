/**
 * validate.js  —  UG Pro PDF Importer v1.2 test runner logic
 *
 * Exported functions:
 *   runValidation(file, importFn, config?) → Promise<ValidationResult>
 *   formatReport(results)                 → string (plain-text table)
 *
 * importFn signature matches importUGProPdf(file, config, onProgress) from ug-pro-importer.html.
 */

'use strict';

// ─── Expected fixture baselines ──────────────────────────────────────────────
// Loose bounds – these are sanity checks, not exact match.
const FIXTURE_EXPECTATIONS = {
  'Robben Ford - Revelation - Pro.pdf': {
    minMeasures: 20,
    maxEmptyPct: 40,
    minChordSpans: 20,
    mustNotWarnVectorChords: false,
    description: 'Standard notation – stable measure stream, no header pollution',
  },
  'Alannah Myles - Black Velvet - Pro.pdf': {
    minMeasures: 16,
    maxEmptyPct: 40,
    minChordSpans: 10,
    mustNotWarnVectorChords: false,
    singleLetterChordsExpected: true,
    noTuningSpansInOutput: true,
    description: 'Tab-heavy – single-letter chords (A/D/G…), Tuning header must be excluded',
  },
  'Larry Carlton - Room 335 - Pro.pdf': {
    minMeasures: 20,
    maxEmptyPct: 40,
    minChordSpans: 15,
    maxRuntimeMs: 20000,
    mustNotWarnVectorChords: false,
    description: 'Multi-system – must not time out (<20s); chord mapping coherent',
  },
  'Robben Ford - Aint Got Nothin But The Blues - Pro.pdf': {
    minMeasures: 12,
    maxEmptyPct: 50,
    minChordSpans: 10,
    mustNotWarnVectorChords: false,
    description: 'Multi-system – must not merge wrong systems',
  },
  'Charlie Parker - Confirmation - Pro.pdf': {
    minMeasures: 24,
    maxEmptyPct: 30,
    minChordSpans: 30,
    mustNotWarnVectorChords: false,
    description: 'Jazz standard – clean chord stream, first/last measures not dropped',
  },
};

const DEFAULT_CONFIG = {
  outputMode: 'csmpn-fakebook',
  measuresPerLine: 4,
  headerExclusionRatio: 0.13,
  renderScale: 1.8,
  yClusterThreshold: 45,
  multiChord: 'join',
  fillEmpty: 'percent',
  preset: 'auto',
};

// ─── runValidation ────────────────────────────────────────────────────────────

/**
 * Run the importer on a single file and return a ValidationResult.
 *
 * @param {File}     file      - PDF File object
 * @param {Function} importFn  - importUGProPdf(file, config, onProgress) → Promise
 * @param {Object}   [config]  - optional config overrides
 * @returns {Promise<ValidationResult>}
 */
async function runValidation(file, importFn, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const logs = [];
  const t0 = performance.now();
  let result = null;
  let error = null;

  try {
    result = await importFn(file, cfg, msg => logs.push(msg));
  } catch (err) {
    error = err;
  }

  const runtimeMs = Math.round(performance.now() - t0);
  const fname = file.name;
  const expect = FIXTURE_EXPECTATIONS[fname] || {};

  // ─── Metrics ────────────────────────────────────────────────────────────
  const metrics = computeMetrics(result, runtimeMs);
  const checks  = runChecks(metrics, expect, result, fname);
  const passed  = error === null && checks.filter(c => c.status === 'FAIL').length === 0;

  return {
    filename: fname,
    description: expect.description || '',
    passed,
    error: error ? error.message : null,
    runtimeMs,
    metrics,
    checks,
    logs,
    csmpnText: result ? result.csmpnText : '',
  };
}

function computeMetrics(result, runtimeMs) {
  if (!result) return { runtimeMs };
  const { songIR, debugJson } = result;

  const totalSystems    = songIR.systems.length;
  const totalMeasures   = songIR.measures.length;
  const emptyMeasures   = songIR.measures.filter(m => m.chords.length === 0).length;
  const emptyPct        = totalMeasures > 0 ? Math.round(emptyMeasures / totalMeasures * 100) : 0;
  const totalChordSpans = debugJson.pages.reduce((s, p) => s + p.chordSpansFound, 0);
  const headerFiltered  = debugJson.pages.reduce((s, p) => s + p.headerFilteredSpans, 0);
  const avgBarlines     = totalSystems > 0
    ? +(songIR.systems.reduce((s, sys) => s + sys.barlinesX.length - 1, 0) / totalSystems).toFixed(1)
    : 0;
  const warnings        = songIR.warnings || [];
  const hasVectorWarn   = warnings.some(w => /extractable|OCR/i.test(w));

  return {
    runtimeMs,
    chordSpansFound: totalChordSpans,
    systemsDetected: totalSystems,
    barlinesPerSystemAvg: avgBarlines,
    measuresTotal: totalMeasures,
    emptyMeasures,
    percentEmptyMeasures: emptyPct,
    headerFilteredSpans: headerFiltered,
    warnings,
    hasVectorWarn,
  };
}

function runChecks(metrics, expect, result, fname) {
  const checks = [];

  function check(name, cond, detail) {
    checks.push({ name, status: cond ? 'PASS' : 'FAIL', detail: detail || '' });
  }

  if (!result) {
    checks.push({ name: 'Import succeeded', status: 'FAIL', detail: 'importUGProPdf threw' });
    return checks;
  }

  check('Import succeeded',      result !== null, '');
  check('Has measures',          metrics.measuresTotal > 0, `got ${metrics.measuresTotal}`);
  check('Min measures',          metrics.measuresTotal >= (expect.minMeasures || 1),
    `${metrics.measuresTotal} >= ${expect.minMeasures || 1}`);
  check('Chord spans found',     metrics.chordSpansFound >= (expect.minChordSpans || 1),
    `${metrics.chordSpansFound} >= ${expect.minChordSpans || 1}`);
  check('Empty measure %',       metrics.percentEmptyMeasures <= (expect.maxEmptyPct || 60),
    `${metrics.percentEmptyMeasures}% <= ${expect.maxEmptyPct || 60}%`);
  check('Has systems',           metrics.systemsDetected > 0, `${metrics.systemsDetected}`);

  if (expect.maxRuntimeMs) {
    check('Runtime within limit', metrics.runtimeMs <= expect.maxRuntimeMs,
      `${metrics.runtimeMs}ms <= ${expect.maxRuntimeMs}ms`);
  }

  if (expect.mustNotWarnVectorChords === true) {
    check('No vector-chord warning', !metrics.hasVectorWarn, metrics.hasVectorWarn ? 'OCR warning triggered' : '');
  }

  // Black Velvet: verify Tuning text not in output
  if (expect.noTuningSpansInOutput) {
    const hasTuning = /\bTuning\b|\bE A D G B E\b/i.test(result.csmpnText);
    check('No tuning text in output', !hasTuning, hasTuning ? '"Tuning" leaked into CSMPN output' : '');
  }

  // Black Velvet: check single-letter chords appear in output
  if (expect.singleLetterChordsExpected) {
    const hasSingleLetter = /\b[A-G]\b/.test(result.csmpnText);
    check('Single-letter chords present', hasSingleLetter, hasSingleLetter ? '' : 'No single-letter chord tokens found');
  }

  // Confirmation: first + last measure should have chords
  if (fname.includes('Confirmation')) {
    const measures = result.songIR.measures;
    if (measures.length > 0) {
      check('First measure has chord', measures[0].chords.length > 0,
        measures[0].chords.length === 0 ? 'First measure empty' : '');
      check('Last measure has chord',  measures[measures.length-1].chords.length > 0,
        measures[measures.length-1].chords.length === 0 ? 'Last measure empty' : '');
    }
  }

  return checks;
}

// ─── formatReport ─────────────────────────────────────────────────────────────

function formatReport(results) {
  const SEP = '─'.repeat(80);
  const lines = [`UG Pro PDF Importer v1.2  –  Validation Report`, SEP];

  let totalPass = 0, totalFail = 0;

  for (const r of results) {
    const statusIcon = r.passed ? '✅ PASS' : r.error ? '💥 ERROR' : '❌ FAIL';
    lines.push(`\n${statusIcon}  ${r.filename}`);
    if (r.description) lines.push(`     ${r.description}`);
    lines.push(`     Runtime: ${r.runtimeMs}ms`);

    if (r.error) {
      lines.push(`     Error: ${r.error}`);
      totalFail++;
      continue;
    }

    const m = r.metrics;
    lines.push([
      `     chordSpansFound=${m.chordSpansFound}`,
      `systemsDetected=${m.systemsDetected}`,
      `barlinesPerSys≈${m.barlinesPerSystemAvg}`,
      `measures=${m.measuresTotal}`,
      `emptyMeasures=${m.percentEmptyMeasures}%`,
      `headerFiltered=${m.headerFilteredSpans}`,
    ].join('  '));

    if (m.warnings.length > 0) {
      for (const w of m.warnings) lines.push(`     ⚠ ${w}`);
    }

    lines.push('     Checks:');
    for (const c of r.checks) {
      const icon = c.status === 'PASS' ? '  ✓' : '  ✗';
      lines.push(`${icon} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    }

    if (r.passed) totalPass++; else totalFail++;
  }

  lines.push(`\n${SEP}`);
  lines.push(`Result: ${totalPass}/${results.length} fixtures passed, ${totalFail} failed`);
  const passMark = totalPass >= Math.ceil(results.length * 0.8) ? '✅ Definition of Done: MET' : '❌ Definition of Done: NOT MET';
  lines.push(passMark);
  return lines.join('\n');
}

// Export for browser use
if (typeof window !== 'undefined') {
  window.UGProValidate = { runValidation, formatReport, FIXTURE_EXPECTATIONS, DEFAULT_CONFIG };
}
// Export for Node (future)
if (typeof module !== 'undefined') {
  module.exports = { runValidation, formatReport, FIXTURE_EXPECTATIONS, DEFAULT_CONFIG };
}

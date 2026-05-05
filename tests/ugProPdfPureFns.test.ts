/**
 * tests/ugProPdfPureFns.test.ts
 *
 * Unit tests for the pure, pdfjs-free functions in ugProPdfPureFns.ts.
 * Run via: node --import tsx/esm --test tests/ugProPdfPureFns.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TextSpan } from '../src/ingest/ugProPdfUtils.js';
import {
  mul2d,
  classifyDirective,
  clusterIntoSystems,
  filterDensestSystems,
  longestDarkRun,
  computeStemDensity,
  fakebookSectionPrefix,
  barToken,
  emitFakebook,
  emitBarlinesStyle,
  extractMetadata,
  classifyPageSpans,
} from '../src/ingest/ugProPdfPureFns.js';
import type {
  LinearMeasure,
  SectionDef,
  SongMetadata,
  EmitConfig,
} from '../src/ingest/ugProPdfPureFns.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function span(text: string, x = 100, y = 500, fontSize = 10, pageIndex = 0): TextSpan {
  return { text, x, y, width: fontSize * text.length * 0.6, height: fontSize, fontSize, pageIndex };
}

function measure(chords: string[], opts: Partial<LinearMeasure> = {}): LinearMeasure {
  return { n: 0, chords, directives: [], ...opts };
}

const DEFAULT_CONFIG: EmitConfig = { measuresPerLine: 4, fillEmptyMeasuresWithPercent: false };

// ── mul2d ─────────────────────────────────────────────────────────────────────

describe('mul2d', () => {
  it('identity × identity = identity', () => {
    const id = [1, 0, 0, 1, 0, 0];
    assert.deepEqual(mul2d(id, id), id);
  });

  it('translation matrix: e,f terms added', () => {
    // Translate by (10, 20) × translate by (5, 3) = translate by (15, 23)
    const t1 = [1, 0, 0, 1, 10, 20];
    const t2 = [1, 0, 0, 1, 5, 3];
    const result = mul2d(t1, t2);
    assert.equal(result[4], 15);
    assert.equal(result[5], 23);
  });

  it('scale matrix: scales correctly', () => {
    const scale2 = [2, 0, 0, 2, 0, 0];
    const scale3 = [3, 0, 0, 3, 0, 0];
    const result = mul2d(scale2, scale3);
    assert.equal(result[0], 6); // 2×3
    assert.equal(result[3], 6);
  });

  it('rotation 90° composition is correct', () => {
    // 90° rotation: [0, 1, -1, 0, 0, 0]
    const r90 = [0, 1, -1, 0, 0, 0];
    const result = mul2d(r90, r90); // 180° rotation
    assert.equal(result[0], -1);
    assert.equal(result[3], -1);
  });
});

// ── classifyDirective ─────────────────────────────────────────────────────────

describe('classifyDirective', () => {
  it('N.C. → nc marker', () => {
    const m = classifyDirective(span('N.C.', 50, 300));
    assert.ok(m !== null);
    assert.equal(m!.type, 'nc');
    assert.equal(m!.value, 'N.C.');
  });

  it('NC (no periods) → nc marker', () => {
    const m = classifyDirective(span('NC'));
    assert.ok(m !== null);
    assert.equal(m!.type, 'nc');
  });

  it('D.S. → ds marker', () => {
    const m = classifyDirective(span('D.S.'));
    assert.ok(m !== null);
    assert.equal(m!.type, 'ds');
  });

  it('D.C. → dc marker', () => {
    const m = classifyDirective(span('D.C.'));
    assert.ok(m !== null);
    assert.equal(m!.type, 'dc');
  });

  it('Fine → fine marker', () => {
    const m = classifyDirective(span('Fine'));
    assert.ok(m !== null);
    assert.equal(m!.type, 'fine');
    assert.equal(m!.value, 'Fine');
  });

  it('Coda → coda marker', () => {
    const m = classifyDirective(span('Coda'));
    assert.ok(m !== null);
    assert.equal(m!.type, 'coda');
  });

  it('plain chord text → null', () => {
    assert.equal(classifyDirective(span('Am7')), null);
  });

  it('stores x/y from span', () => {
    const m = classifyDirective(span('Fine', 42, 123));
    assert.equal(m!.x, 42);
    assert.equal(m!.y, 123);
  });
});

// ── clusterIntoSystems ────────────────────────────────────────────────────────

describe('clusterIntoSystems', () => {
  it('empty input → empty output', () => {
    assert.equal(clusterIntoSystems([], 20).length, 0);
  });

  it('spans within threshold merge into one group', () => {
    const spans = [span('G', 50, 700), span('Am', 100, 705), span('F', 150, 698)];
    const groups = clusterIntoSystems(spans, 20);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].spans.length, 3);
  });

  it('spans far apart form separate groups', () => {
    const spans = [span('G', 50, 700), span('C', 50, 400)]; // 300pt apart
    const groups = clusterIntoSystems(spans, 20);
    assert.equal(groups.length, 2);
  });

  it('groups sorted top-to-bottom (descending Y in PDF space)', () => {
    const spans = [span('G', 50, 400), span('C', 50, 700)];
    const groups = clusterIntoSystems(spans, 20);
    assert.ok(groups[0].yCenter > groups[1].yCenter, 'first group should have higher Y');
  });

  it('three distinct systems at 700, 500, 300', () => {
    const spans = [
      span('G', 50, 700),
      span('Am', 100, 700),
      span('C', 50, 500),
      span('F', 100, 500),
      span('D', 50, 300),
    ];
    const groups = clusterIntoSystems(spans, 20);
    assert.equal(groups.length, 3);
  });

  it('centroid updates correctly as spans join group', () => {
    const spans = [span('G', 50, 700), span('Am', 100, 710)]; // 10pt apart, threshold 20
    const groups = clusterIntoSystems(spans, 20);
    assert.equal(groups.length, 1);
    assert.ok(Math.abs(groups[0].yCenter - 705) < 1, 'centroid should be ~705');
  });
});

// ── filterDensestSystems ──────────────────────────────────────────────────────

describe('filterDensestSystems', () => {
  it('≤8 groups returned unchanged', () => {
    const groups = Array.from({ length: 8 }, (_, i) => ({
      yCenter: i * 100,
      spans: Array(10).fill(span('G')),
    }));
    assert.equal(filterDensestSystems(groups).length, 8);
  });

  it('9+ groups: drops sparse ones below 50% of densest', () => {
    const rich = Array(20).fill(span('G'));
    const sparse = Array(5).fill(span('G')); // 5 < 20*0.5 = 10 → dropped
    const groups = [
      ...Array.from({ length: 8 }, () => ({ yCenter: 0, spans: rich })),
      { yCenter: 100, spans: sparse },
    ];
    const result = filterDensestSystems(groups);
    // sparse group (5 spans) should be dropped when max=20, threshold=10
    assert.equal(result.length, 8);
  });

  it('9+ groups: keeps groups at exactly 50%', () => {
    const rich = Array(20).fill(span('G'));
    const ok = Array(10).fill(span('G')); // 10 = 20*0.5 → kept
    const groups = [
      ...Array.from({ length: 8 }, () => ({ yCenter: 0, spans: rich })),
      { yCenter: 100, spans: ok },
    ];
    const result = filterDensestSystems(groups);
    assert.equal(result.length, 9);
  });
});

// ── longestDarkRun ────────────────────────────────────────────────────────────

describe('longestDarkRun', () => {
  it('all-white column → 0', () => {
    // 4×4 grid, all pixels = 255 (white)
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(255);
    assert.equal(longestDarkRun(data, 0, 4, 4), 0);
  });

  it('all-black column → bandH', () => {
    // 1-wide × 4-tall strip, all black
    const data = new Uint8ClampedArray(1 * 4 * 4).fill(0);
    assert.equal(longestDarkRun(data, 0, 1, 4), 4);
  });

  it('alternating rows → max run of 1', () => {
    // Col 0 of a 1-wide × 4-tall strip: row0=black, row1=white, row2=black, row3=white
    const data = new Uint8ClampedArray(1 * 4 * 4).fill(255);
    // row 0: pixel [0..3] = 0 (black)
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
    data[3] = 255; // alpha
    // row 2: pixel [8..11] = 0
    data[8] = 0;
    data[9] = 0;
    data[10] = 0;
    assert.equal(longestDarkRun(data, 0, 1, 4), 1);
  });

  it('continuous run of 3 in 5 rows', () => {
    // 1-wide × 5-tall: rows 1,2,3 are black; rows 0 and 4 are white
    const data = new Uint8ClampedArray(1 * 5 * 4).fill(255);
    for (const row of [1, 2, 3]) {
      data[row * 4] = 0;
      data[row * 4 + 1] = 0;
      data[row * 4 + 2] = 0;
    }
    assert.equal(longestDarkRun(data, 0, 1, 5), 3);
  });
});

// ── computeStemDensity ────────────────────────────────────────────────────────

describe('computeStemDensity', () => {
  it('all-white image → 0', () => {
    const data = new Uint8ClampedArray(4 * 4).fill(255);
    assert.equal(computeStemDensity(data, 4), 0);
  });

  it('all-black image → 1', () => {
    const data = new Uint8ClampedArray(4 * 4).fill(0);
    assert.equal(computeStemDensity(data, 4), 1);
  });

  it('half black, half white → ~0.5', () => {
    const data = new Uint8ClampedArray(8 * 4).fill(255);
    // First 4 pixels (one pixel = 4 bytes) are black
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
    data[4] = 0;
    data[5] = 0;
    data[6] = 0;
    data[8] = 0;
    data[9] = 0;
    data[10] = 0;
    data[12] = 0;
    data[13] = 0;
    data[14] = 0;
    assert.equal(computeStemDensity(data, 8), 0.5);
  });
});

// ── fakebookSectionPrefix ─────────────────────────────────────────────────────

describe('fakebookSectionPrefix', () => {
  it('"Chorus" → ":"', () => assert.equal(fakebookSectionPrefix('Chorus'), ':'));
  it('"Chorus 2" → ":"', () => assert.equal(fakebookSectionPrefix('Chorus 2'), ':'));
  it('"Refrain" → ":"', () => assert.equal(fakebookSectionPrefix('Refrain'), ':'));
  it('"Bridge" → "="', () => assert.equal(fakebookSectionPrefix('Bridge'), '='));
  it('"Verse" → "-"', () => assert.equal(fakebookSectionPrefix('Verse'), '-'));
  it('"Intro" → "-"', () => assert.equal(fakebookSectionPrefix('Intro'), '-'));
  it('"Solo" → "-"', () => assert.equal(fakebookSectionPrefix('Solo'), '-'));
  it('empty string → "-"', () => assert.equal(fakebookSectionPrefix(''), '-'));
});

// ── barToken ──────────────────────────────────────────────────────────────────

describe('barToken', () => {
  it('single chord bar → chord token', () => {
    const [tok, last] = barToken(measure(['G']), '', false);
    assert.equal(tok, 'G');
    assert.equal(last, 'G');
  });

  it('multi-chord bar → joined with _', () => {
    const [tok] = barToken(measure(['Bb7', 'A7']), '', false);
    assert.equal(tok, 'Bb7_A7');
  });

  it('empty bar, no prior chord → N.C.', () => {
    const [tok, last] = barToken(measure([]), '', false);
    assert.equal(tok, 'N.C.');
    assert.equal(last, '');
  });

  it('empty bar, prior chord, fillPercent=false → repeats prior chord', () => {
    const [tok, last] = barToken(measure([]), 'Am', false);
    assert.equal(tok, 'Am');
    assert.equal(last, 'Am');
  });

  it('empty bar, prior chord, fillPercent=true → %', () => {
    const [tok] = barToken(measure([]), 'Am', true);
    assert.equal(tok, '%');
  });

  it('updates lastChord to final chord in multi-chord bar', () => {
    const [, last] = barToken(measure(['G7', 'Cmaj7', 'Fmaj7']), '', false);
    assert.equal(last, 'Fmaj7');
  });
});

// ── emitFakebook ──────────────────────────────────────────────────────────────

describe('emitFakebook', () => {
  const meta: SongMetadata = {
    title: 'My Song',
    composer: 'J. Artist',
    style: '',
    tempo: '120',
    time: '4/4',
    key: 'G',
  };

  it('emits header metadata', () => {
    const out = emitFakebook(meta, [], [], DEFAULT_CONFIG);
    assert.ok(out.includes('Title: My Song'));
    assert.ok(out.includes('Composer: J. Artist'));
    assert.ok(out.includes('Tempo: 120'));
    assert.ok(out.includes('Time: 4/4'));
    assert.ok(out.includes('Key: G'));
  });

  it('omits empty metadata fields', () => {
    const out = emitFakebook({ ...meta, style: '', composer: '' }, [], [], DEFAULT_CONFIG);
    assert.ok(!out.includes('Style:'));
    assert.ok(!out.includes('Composer:'));
  });

  it('uses correct section prefix for Chorus', () => {
    const sections: SectionDef[] = [{ label: 'Chorus', startMeasure: 0 }];
    const measures = [measure(['C']), measure(['G']), measure(['Am']), measure(['F'])];
    const out = emitFakebook(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes(': Chorus'));
  });

  it('uses = prefix for Bridge', () => {
    const sections: SectionDef[] = [{ label: 'Bridge', startMeasure: 0 }];
    const measures = [measure(['Dm'])];
    const out = emitFakebook(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes('= Bridge'));
  });

  it('groups measures into rows of measuresPerLine', () => {
    const sections: SectionDef[] = [{ label: 'Verse', startMeasure: 0 }];
    const measures = [
      measure(['C']),
      measure(['G']),
      measure(['Am']),
      measure(['F']),
      measure(['C']),
      measure(['G']),
    ];
    const cfg: EmitConfig = { measuresPerLine: 4, fillEmptyMeasuresWithPercent: false };
    const out = emitFakebook(meta, sections, measures, cfg);
    const contentLines = out
      .split('\n')
      .filter(
        (l) =>
          l.trim() &&
          !l.startsWith('Title') &&
          !l.startsWith('Composer') &&
          !l.startsWith('Tempo') &&
          !l.startsWith('Time') &&
          !l.startsWith('Key') &&
          !l.startsWith('- Verse')
      );
    // 6 bars ÷ 4 per row = 2 rows
    assert.equal(contentLines.length, 2);
  });

  it('emits repeat barlines inline', () => {
    const sections: SectionDef[] = [{ label: 'Verse', startMeasure: 0 }];
    const measures = [
      measure(['G'], { repeatStart: true }),
      measure(['Am']),
      measure(['F'], { repeatEnd: true }),
    ];
    const out = emitFakebook(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes('|:'), `expected |: in:\n${out}`);
    assert.ok(out.includes(':|'), `expected :| in:\n${out}`);
  });

  it('inserts time-sig change comment', () => {
    const sections: SectionDef[] = [{ label: 'Bridge', startMeasure: 0 }];
    const measures = [measure(['G']), measure(['Am'], { timeSig: '3/4' })];
    const out = emitFakebook(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes('; Time: 3/4'), `expected time-sig comment in:\n${out}`);
  });

  it('two sections handled correctly', () => {
    const sections: SectionDef[] = [
      { label: 'Verse', startMeasure: 0 },
      { label: 'Chorus', startMeasure: 2 },
    ];
    const measures = [measure(['G']), measure(['Am']), measure(['C']), measure(['F'])];
    const out = emitFakebook(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes('- Verse'));
    assert.ok(out.includes(': Chorus'));
  });
});

// ── emitBarlinesStyle ─────────────────────────────────────────────────────────

describe('emitBarlinesStyle', () => {
  const meta: SongMetadata = {
    title: 'Blues Song',
    composer: '',
    style: '',
    tempo: '100',
    time: '4/4',
    key: 'Bb',
  };

  it('emits [Section] headers', () => {
    const sections: SectionDef[] = [{ label: 'Verse 1', startMeasure: 0 }];
    const out = emitBarlinesStyle(meta, sections, [measure(['Bb'])], DEFAULT_CONFIG);
    assert.ok(out.includes('[Verse 1]'));
  });

  it('first row starts with ‖', () => {
    const sections: SectionDef[] = [{ label: 'Verse', startMeasure: 0 }];
    const out = emitBarlinesStyle(
      meta,
      sections,
      [measure(['G']), measure(['Am'])],
      DEFAULT_CONFIG
    );
    assert.ok(out.includes('‖'), `expected ‖ in:\n${out}`);
  });

  it('final row ends with ‖', () => {
    const sections: SectionDef[] = [{ label: 'Verse', startMeasure: 0 }];
    const out = emitBarlinesStyle(meta, sections, [measure(['G'])], DEFAULT_CONFIG);
    const lines = out.split('\n').filter((l) => l.includes('‖'));
    assert.ok(
      lines.some((l) => l.endsWith('‖')),
      `expected trailing ‖ in:\n${out}`
    );
  });

  it('emits ♩= tempo prefix', () => {
    const out = emitBarlinesStyle(meta, [], [], DEFAULT_CONFIG);
    assert.ok(out.includes('Tempo: ♩=100'));
  });

  it('multiple measures separated by |', () => {
    const sections: SectionDef[] = [{ label: 'Main', startMeasure: 0 }];
    const measures = [measure(['G']), measure(['Am']), measure(['F'])];
    const out = emitBarlinesStyle(meta, sections, measures, DEFAULT_CONFIG);
    assert.ok(out.includes(' | '), `expected | separator in:\n${out}`);
  });
});

// ── extractMetadata ───────────────────────────────────────────────────────────

describe('extractMetadata', () => {
  const PAGE_H = 792;

  it('extracts title as largest-font span in top 25%', () => {
    // Top 25%: y > 792 * 0.75 = 594
    const spans = [
      span('My Song Title', 100, 700, 24), // large font, top area
      span('G Am F C', 100, 400, 10), // chord area — not top 25%
    ];
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.title, 'My Song Title');
  });

  it('extracts composer as second-largest span in top area', () => {
    const spans = [span('Song Name', 100, 750, 24), span('By Composer', 100, 730, 16)];
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.title, 'Song Name');
    assert.equal(meta.composer, 'By Composer');
  });

  it('extracts tempo from ♩= pattern', () => {
    const spans = [span('♩=120', 300, 650, 10)];
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.tempo, '120');
  });

  it('extracts tempo from bare "= 120" pattern', () => {
    const spans = [span('= 120', 300, 650, 10)];
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.tempo, '120');
  });

  it('extracts time signature', () => {
    const spans = [span('4/4', 50, 640, 12)];
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.time, '4/4');
  });

  it('returns empty strings when no matching spans', () => {
    const meta = extractMetadata([], PAGE_H);
    assert.equal(meta.title, '');
    assert.equal(meta.tempo, '');
    assert.equal(meta.key, '');
  });

  it('ignores page-index > 0 spans for title/composer', () => {
    const spans = [span('Other Page', 100, 700, 24)];
    spans[0] = { ...spans[0], pageIndex: 1 };
    const meta = extractMetadata(spans, PAGE_H);
    assert.equal(meta.title, '');
  });
});

// ── classifyPageSpans ─────────────────────────────────────────────────────────

describe('classifyPageSpans', () => {
  const PAGE_H = 792;
  const PAGE_W = 612;

  it('valid chord span → chordSpans', () => {
    // y < 792*(1-0.13) = 688.9 → below header exclusion zone
    const spans = [span('Am7', 100, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.chordSpans.length, 1);
    assert.equal(result.chordSpans[0].text, 'Am7');
  });

  it('header area span (y > threshold) → excluded', () => {
    // y=750 > 688.9 → in header zone → excluded
    const spans = [span('Am7', 100, 750, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.chordSpans.length, 0);
  });

  it('section label → rehearsalSpans', () => {
    const spans = [span('Chorus', 100, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.rehearsalSpans.length, 1);
    assert.equal(result.chordSpans.length, 0);
  });

  it('direction text (Fine) → directionMarkers', () => {
    const spans = [span('Fine', 200, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.directionMarkers.length, 1);
    assert.equal(result.directionMarkers[0].type, 'fine');
  });

  it('N.C. → directionMarker of type nc', () => {
    const spans = [span('N.C.', 100, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    const nc = result.directionMarkers.find((m) => m.type === 'nc');
    assert.ok(nc, 'expected nc marker');
  });

  it('very large font span → excluded (header text)', () => {
    // medianFontSize will be ~7 (fallback), 7*2.5=17.5. A 50pt font is excluded.
    const spans = [
      span('Am', 100, 400, 7),
      span('G', 200, 400, 7),
      span('F', 300, 400, 7),
      span('BigTitle', 100, 300, 50), // too large
    ];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    const bigSpan = result.chordSpans.find((s) => s.text === 'BigTitle');
    assert.equal(bigSpan, undefined);
  });

  it('left-margin single letter → excluded (tab string label)', () => {
    // x < 612*0.04 = 24.5 and single letter [A-G]
    const spans = [span('E', 10, 400, 10)]; // x=10 < 24.5
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.chordSpans.length, 0);
  });

  it('rehearsal letter larger than 1.3× median → rehearsalSpans', () => {
    // 3 chord spans at fontSize=8 → median=8; 8*1.3=10.4
    // Single uppercase letter at fontSize=14 → rehearsal
    const spans = [
      span('Am', 100, 400, 8),
      span('Dm', 200, 400, 8),
      span('Em', 300, 400, 8),
      span('A', 50, 400, 14), // single letter, big font
    ];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    const rehearsalA = result.rehearsalSpans.find((s) => s.text === 'A');
    assert.ok(rehearsalA, 'single uppercase A at large font should be rehearsal marker');
  });

  it('header keyword spans → excluded', () => {
    const spans = [span('Tuning: Standard', 100, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.chordSpans.length, 0);
    assert.equal(result.rehearsalSpans.length, 0);
  });

  it('span with text longer than 20 chars → excluded', () => {
    const spans = [span('This is a very long text span', 100, 400, 10)];
    const result = classifyPageSpans(spans, PAGE_H, 0.13, PAGE_W);
    assert.equal(result.chordSpans.length, 0);
  });
});

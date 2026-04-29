import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTimeSigSpans,
  detectKeySig,
  mergeFragmentSpans,
  type TextSpan,
} from '../src/ingest/ugProPdfUtils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function span(text: string, x: number, y: number, pageIndex = 0, fontSize = 12): TextSpan {
  return { text, x, y, width: fontSize * text.length * 0.6, height: fontSize, fontSize, pageIndex };
}

// SMuFL time-signature digit glyphs (Leland font U+E080–U+E089)
const D = [
  '', // 0
  '', // 1
  '', // 2
  '', // 3
  '', // 4
  '', // 5
  '', // 6
  '', // 7
  '', // 8
  '', // 9
];
const COMMON_TIME = ''; // → 4/4
const CUT_TIME = ''; // → 2/2

// SMuFL key-signature glyphs
const FLAT = ''; // accidentalFlat
const SHARP = ''; // accidentalSharp

const PAGE_W = 612; // standard letter PDF width

// ── detectTimeSigSpans ────────────────────────────────────────────────────────

describe('detectTimeSigSpans', () => {
  it('returns empty array when no SMuFL digits present', () => {
    const spans = [span('G', 100, 50), span('C7', 200, 50)];
    assert.deepEqual(detectTimeSigSpans(spans), []);
  });

  it('detects 4/4 from stacked digit pair (higher y = numerator)', () => {
    // PDF y increases upward; numerator is at higher y
    const spans = [
      span(D[4], 50, 100), // numerator: 4
      span(D[4], 52, 82), //  denominator: 4 (y < 100, below in PDF space)
    ];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '4/4');
  });

  it('detects 3/4', () => {
    const spans = [span(D[3], 50, 100), span(D[4], 52, 82)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '3/4');
  });

  it('detects 6/8', () => {
    const spans = [span(D[6], 50, 100), span(D[8], 52, 82)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '6/8');
  });

  it('detects 12/8 from two numerator digits + one denominator digit', () => {
    // Numerator "12" spans at same Y, denominator "8" at lower Y
    const spans = [
      span(D[1], 48, 100), // '1' of '12'
      span(D[2], 58, 100), // '2' of '12'
      span(D[8], 53, 82), //  '8'
    ];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '12/8');
  });

  it('detects common time (C glyph → 4/4)', () => {
    const spans = [span(COMMON_TIME, 50, 100)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '4/4');
  });

  it('detects cut time (₵ glyph → 2/2)', () => {
    const spans = [span(CUT_TIME, 50, 100)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].timeSig, '2/2');
  });

  it('detects two time sigs at different x positions (mid-score change)', () => {
    // First system at x≈50: 4/4
    // Second system at x≈300: 3/4
    const spans = [
      span(D[4], 50, 100),
      span(D[4], 52, 82),
      span(D[3], 300, 100),
      span(D[4], 302, 82),
    ];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 2);
    const timeSigs = result.map((r) => r.timeSig).sort();
    assert.deepEqual(timeSigs, ['3/4', '4/4']);
  });

  it('ignores lone digit with no partner', () => {
    const spans = [span(D[4], 50, 100)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 0);
  });

  it('records x and y coordinates from the top glyph', () => {
    const spans = [span(D[3], 55, 110), span(D[4], 57, 90)];
    const result = detectTimeSigSpans(spans);
    assert.equal(result.length, 1);
    assert.equal(result[0].x, 55);
    assert.equal(result[0].y, 110);
  });
});

// ── detectKeySig ──────────────────────────────────────────────────────────────

describe('detectKeySig', () => {
  it('returns null when no accidentals in left zone', () => {
    const spans = [span('G', 200, 200), span('C7', 300, 200)];
    assert.equal(detectKeySig(spans, PAGE_W), null);
  });

  it('ignores accidentals outside left 25% zone (chord-symbol accidentals)', () => {
    // x=400 > 612*0.25=153 → not key-sig zone
    const spans = [span(SHARP, 400, 200), span(FLAT, 450, 200)];
    assert.equal(detectKeySig(spans, PAGE_W), null);
  });

  it('detects G major (1 sharp)', () => {
    const result = detectKeySig([span(SHARP, 60, 200)], PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'G');
    assert.equal(result.numAccidentals, 1);
    assert.equal(result.accidentalType, 'sharp');
  });

  it('detects D major (2 sharps)', () => {
    const result = detectKeySig([span(SHARP, 55, 200), span(SHARP, 65, 200)], PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'D');
    assert.equal(result.numAccidentals, 2);
  });

  it('detects A major (3 sharps)', () => {
    const sharps = [55, 62, 69].map((x) => span(SHARP, x, 200));
    const result = detectKeySig(sharps, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'A');
  });

  it('detects E major (4 sharps)', () => {
    const sharps = [55, 62, 69, 76].map((x) => span(SHARP, x, 200));
    const result = detectKeySig(sharps, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'E');
  });

  it('detects F# major (6 sharps)', () => {
    const sharps = [55, 60, 65, 70, 75, 80].map((x) => span(SHARP, x, 200));
    const result = detectKeySig(sharps, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'F#');
  });

  it('detects F major (1 flat)', () => {
    const result = detectKeySig([span(FLAT, 60, 200)], PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'F');
    assert.equal(result.numAccidentals, 1);
    assert.equal(result.accidentalType, 'flat');
  });

  it('detects Bb major (2 flats)', () => {
    const result = detectKeySig([span(FLAT, 55, 200), span(FLAT, 65, 200)], PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'Bb');
  });

  it('detects Eb major (3 flats)', () => {
    const flats = [55, 65, 75].map((x) => span(FLAT, x, 200));
    const result = detectKeySig(flats, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'Eb');
  });

  it('detects Ab major (4 flats)', () => {
    const flats = [55, 63, 71, 79].map((x) => span(FLAT, x, 200));
    const result = detectKeySig(flats, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'Ab');
  });

  it('detects Gb major (6 flats)', () => {
    const flats = [55, 62, 69, 76, 83, 90].map((x) => span(FLAT, x, 200));
    const result = detectKeySig(flats, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'Gb');
  });

  it('sharps in left zone take priority over flats outside', () => {
    const spans = [
      span(SHARP, 60, 200), // inside zone
      span(FLAT, 400, 200), // outside zone — ignored
    ];
    const result = detectKeySig(spans, PAGE_W);
    assert.ok(result);
    assert.equal(result.key, 'G');
    assert.equal(result.accidentalType, 'sharp');
  });
});

// ── mergeFragmentSpans ────────────────────────────────────────────────────────

describe('mergeFragmentSpans', () => {
  it('passes standalone valid chords through unchanged', () => {
    const input = [span('Gm7', 100, 200), span('C7', 200, 200)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 2);
    assert.equal(result.find((s) => s.x === 100)?.text, 'Gm7');
    assert.equal(result.find((s) => s.x === 200)?.text, 'C7');
  });

  it('merges slash chord split at / (D9 + /F → D9/F)', () => {
    const input = [
      span('D9', 100, 200),
      span('/F', 120, 200), // gap ~6px, well within 3×fontSize threshold
    ];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'D9/F');
  });

  it('merges root + quality suffix (G + m11 → Gm11)', () => {
    const input = [span('G', 100, 200), span('m11', 115, 200)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Gm11');
  });

  it('merges root + diminished suffix (E + dim7 → Edim7)', () => {
    const input = [span('E', 100, 200), span('dim7', 112, 200)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Edim7');
  });

  it('merges quality + slash bass (Bb + 7/A → Bb7/A)', () => {
    const input = [
      span('B♭', 100, 200), // B♭
      span('7/A', 118, 200),
    ];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'B♭7/A');
  });

  it('does NOT merge two valid independent chord roots (G7 + C7 → stays separate)', () => {
    // Both start with [A-G] so the right span is not a fragment
    const input = [span('G7', 100, 200), span('C7', 200, 200)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 2);
  });

  it('does NOT merge spans on different pages', () => {
    const input = [span('G', 100, 200, 0), span('m7', 115, 200, 1)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 2);
  });

  it('does NOT merge when gap exceeds 3× fontSize', () => {
    // fontSize=12, gap = 250-112=138 >> 3*12=36
    const input = [span('G', 100, 200), span('m11', 250, 200)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 2);
  });

  it('preserves spans on different Y bands without merging', () => {
    // Spans at y=200 and y=300 are different systems
    const input = [span('G', 100, 200), span('m7', 115, 300)];
    const result = mergeFragmentSpans(input);
    assert.equal(result.length, 2);
  });

  it('handles empty input', () => {
    assert.deepEqual(mergeFragmentSpans([]), []);
  });
});

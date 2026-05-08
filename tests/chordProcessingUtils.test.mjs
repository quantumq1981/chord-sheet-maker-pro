/**
 * tests/chordProcessingUtils.test.mjs
 *
 * Unit tests for the pure utility functions in chordProcessing.js.
 * Uses Node.js `vm` to load the browser-global script into a sandboxed
 * context with mocked dependencies (fbSettings, normalizeAccidentals, escapeHtml).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── Context factory ───────────────────────────────────────────────────────────

function makeContext(fbOverrides = {}) {
  const context = {
    fbSettings: {
      maj7Style: 'Maj7', // default: display as "MA7"
      minorStyle: 'm',
      dimStyle: 'dim',
      halfDimStyle: 'ø',
      barLines: 'visible',
      ...fbOverrides,
    },
    validationWarnings: [],
    // Inline stubs matching utils.js implementations
    normalizeAccidentals: (s) =>
      (s ?? '').replace(/♭/g, 'b').replace(/♯/g, '#').replace(/ /g, ' ').trim(),
    escapeHtml: (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    console,
  };

  const src = readFileSync(new URL('../chordProcessing.js', import.meta.url), 'utf8');
  vm.createContext(context);
  vm.runInContext(src, context);
  return context;
}

// Shared context — pure functions are idempotent so sharing is safe
const ctx = makeContext();

// ── detectNotationPreferenceFromKeyOrText ─────────────────────────────────────

describe('detectNotationPreferenceFromKeyOrText', () => {
  it('key containing "b" returns flat', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('Gb', ''), 'flat');
  });
  it('key containing "#" returns sharp', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('F#', ''), 'sharp');
  });
  it('no key but flat chord in text returns flat', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('', 'G Ab C Dm'), 'flat');
  });
  it('no key but sharp chord in text returns sharp', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('', 'C# G D'), 'sharp');
  });
  it('no key and no accidentals defaults to sharp', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('', 'G Am C D'), 'sharp');
  });
  it('key "C" with flat chords in text returns flat', () => {
    assert.equal(ctx.detectNotationPreferenceFromKeyOrText('C', 'Bb F C G'), 'flat');
  });
});

// ── transposeNote ─────────────────────────────────────────────────────────────

describe('transposeNote', () => {
  it('C up 2 semitones = D', () => {
    assert.equal(ctx.transposeNote('C', 2, 'sharp'), 'D');
  });
  it('C up 1 semitone sharp pref = C#', () => {
    assert.equal(ctx.transposeNote('C', 1, 'sharp'), 'C#');
  });
  it('C up 1 semitone flat pref = Db', () => {
    assert.equal(ctx.transposeNote('C', 1, 'flat'), 'Db');
  });
  it('B up 1 semitone = C (wrap-around)', () => {
    assert.equal(ctx.transposeNote('B', 1, 'sharp'), 'C');
  });
  it('G up 5 semitones = C', () => {
    assert.equal(ctx.transposeNote('G', 5, 'sharp'), 'C');
  });
  it('up 12 semitones = same note (octave)', () => {
    assert.equal(ctx.transposeNote('D', 12, 'sharp'), 'D');
  });
  it('Ab up 0 semitones = Ab', () => {
    assert.equal(ctx.transposeNote('Ab', 0, 'flat'), 'Ab');
  });
});

// ── transposeChordSimple ──────────────────────────────────────────────────────

describe('transposeChordSimple', () => {
  it('transposes root and preserves minor quality', () => {
    assert.equal(ctx.transposeChordSimple('Am', 2, 'sharp'), 'Bm');
  });
  it('transposes dominant seventh', () => {
    assert.equal(ctx.transposeChordSimple('G7', 2, 'sharp'), 'A7');
  });
  it('uses flat preference when specified', () => {
    assert.equal(ctx.transposeChordSimple('G7', 1, 'flat'), 'Ab7');
  });
  it('transposes slash chord root and bass', () => {
    assert.equal(ctx.transposeChordSimple('G/B', 2, 'sharp'), 'A/C#');
  });
  it('leaves N.C. unchanged', () => {
    assert.equal(ctx.transposeChordSimple('N.C.', 5, 'sharp'), 'N.C.');
  });
  it('preserves maj7 quality string', () => {
    assert.equal(ctx.transposeChordSimple('Cmaj7', 5, 'flat'), 'Fmaj7');
  });
  it('transposes Bb correctly with flat pref', () => {
    assert.equal(ctx.transposeChordSimple('Bb', 2, 'flat'), 'C');
  });
});

// ── transposeChordToken ───────────────────────────────────────────────────────

describe('transposeChordToken', () => {
  it('leaves % repeat token unchanged', () => {
    assert.equal(ctx.transposeChordToken('%', 5, 'sharp'), '%');
  });
  it('leaves %% simile token unchanged', () => {
    assert.equal(ctx.transposeChordToken('%%', 3, 'flat'), '%%');
  });
  it('leaves N.C. unchanged', () => {
    assert.equal(ctx.transposeChordToken('N.C.', 7, 'sharp'), 'N.C.');
  });
  it('leaves barline token unchanged', () => {
    assert.equal(ctx.transposeChordToken('|', 2, 'sharp'), '|');
  });
  it('leaves Fine unchanged', () => {
    assert.equal(ctx.transposeChordToken('Fine', 4, 'flat'), 'Fine');
  });
  it('transposes a plain chord', () => {
    assert.equal(ctx.transposeChordToken('Am', 2, 'sharp'), 'Bm');
  });
  it('transposes multi-chord token (underscore-joined)', () => {
    assert.equal(ctx.transposeChordToken('Gm7_C7', 2, 'sharp'), 'Am7_D7');
  });
  it('transposes chord wrapped in parens', () => {
    assert.equal(ctx.transposeChordToken('(G)', 2, 'sharp'), '(A)');
  });
});

// ── transposeWholeText ────────────────────────────────────────────────────────

describe('transposeWholeText', () => {
  it('transposes Key header line', () => {
    const input = 'Key: G\n- Verse\nG D Em C';
    const result = ctx.transposeWholeText(input, 2);
    assert.ok(result.includes('Key: A'), `Expected Key: A, got: ${result}`);
  });
  it('preserves Title and Composer lines unchanged', () => {
    const input = 'Title: My Song\nComposer: Artist\nKey: C\nC G Am F';
    const result = ctx.transposeWholeText(input, 5);
    assert.ok(result.includes('Title: My Song'));
    assert.ok(result.includes('Composer: Artist'));
  });
  it('transposes chord bar lines', () => {
    const input = 'Key: C\n- Verse\nC Am F G';
    const result = ctx.transposeWholeText(input, 2);
    // C→D, Am→Bm, F→G, G→A
    assert.ok(result.includes('D') && result.includes('Bm'));
  });
});

// ── normalizeBarlineDelimiters ────────────────────────────────────────────────

describe('normalizeBarlineDelimiters', () => {
  it('|: and :| preserved as canonical repeat tokens', () => {
    const r = ctx.normalizeBarlineDelimiters('|: G Am :|');
    assert.ok(r.includes('|:'), `Expected |:, got: ${JSON.stringify(r)}`);
    assert.ok(r.includes(':|'), `Expected :|, got: ${JSON.stringify(r)}`);
  });
  it('converts ‖ (unicode double barline) to ||', () => {
    const r = ctx.normalizeBarlineDelimiters('‖ G | Am ‖');
    assert.ok(r.includes('||'), `Expected ||, got: ${JSON.stringify(r)}`);
  });
  it('|] (final barline) is preserved', () => {
    const r = ctx.normalizeBarlineDelimiters('G Am |]');
    assert.ok(r.includes('|]'), `Expected |], got: ${JSON.stringify(r)}`);
  });
  it('leaves plain | separators intact', () => {
    const r = ctx.normalizeBarlineDelimiters('| G | Am |');
    assert.ok(r.includes('|'), 'Expected | separator');
  });
});

// ── tokenizeBars ─────────────────────────────────────────────────────────────

describe('tokenizeBars', () => {
  it('splits a bar line into tokens', () => {
    // Spread into a regular array to avoid vm-realm prototype mismatch with deepEqual
    const tokens = [...ctx.tokenizeBars('| G | Am | F | C |')];
    assert.deepEqual(tokens, ['|', 'G', '|', 'Am', '|', 'F', '|', 'C', '|']);
  });
  it('handles chord names with extensions', () => {
    const tokens = [...ctx.tokenizeBars('| Cmaj7 | G7sus4 |')];
    assert.ok(tokens.includes('Cmaj7'));
    assert.ok(tokens.includes('G7sus4'));
  });
  it('returns empty array for empty input', () => {
    assert.equal(ctx.tokenizeBars('').length, 0);
  });
  it('keeps quoted annotations intact', () => {
    const tokens = [...ctx.tokenizeBars('| G "slow" | Am |')];
    const annotation = tokens.find((t) => t.startsWith('"'));
    assert.equal(annotation, '"slow"');
  });
});

// ── isBarlineToken ────────────────────────────────────────────────────────────

describe('isBarlineToken', () => {
  it('| is a barline token', () => assert.ok(ctx.isBarlineToken('|')));
  it('|| is a barline token', () => assert.ok(ctx.isBarlineToken('||')));
  it('|: is a barline token', () => assert.ok(ctx.isBarlineToken('|:')));
  it(':| is a barline token', () => assert.ok(ctx.isBarlineToken(':|')));
  it('G is not a barline token', () => assert.ok(!ctx.isBarlineToken('G')));
  it('Am7 is not a barline token', () => assert.ok(!ctx.isBarlineToken('Am7')));
});

// ── mapBarlineToken ───────────────────────────────────────────────────────────

describe('mapBarlineToken', () => {
  it('| → single', () => assert.equal(ctx.mapBarlineToken('|'), 'single'));
  it('|| → double', () => assert.equal(ctx.mapBarlineToken('||'), 'double'));
  it('|: → repeat-start', () => assert.equal(ctx.mapBarlineToken('|:'), 'repeat-start'));
  it('||: → repeat-start', () => assert.equal(ctx.mapBarlineToken('||:'), 'repeat-start'));
  it(':| → repeat-end', () => assert.equal(ctx.mapBarlineToken(':|'), 'repeat-end'));
  it(':|| → repeat-end', () => assert.equal(ctx.mapBarlineToken(':||'), 'repeat-end'));
  it('|] → final', () => assert.equal(ctx.mapBarlineToken('|]'), 'final'));
});

// ── formatChordQuality ────────────────────────────────────────────────────────

describe('formatChordQuality', () => {
  it('empty string → empty string', () => {
    assert.equal(ctx.formatChordQuality(''), '');
  });
  it('dim preserved when dimStyle=dim', () => {
    assert.equal(ctx.formatChordQuality('dim'), 'dim');
    assert.equal(ctx.formatChordQuality('dim7'), 'dim7');
  });
  it('aug → + symbol', () => {
    assert.equal(ctx.formatChordQuality('aug'), '+');
  });
  it('m preserved when minorStyle=m', () => {
    assert.equal(ctx.formatChordQuality('m'), 'm');
    assert.equal(ctx.formatChordQuality('m7'), 'm7');
  });
  it('minor suffix variations normalize to m (minorStyle=m)', () => {
    assert.equal(ctx.formatChordQuality('min'), 'm');
    assert.equal(ctx.formatChordQuality('mi7'), 'm7');
  });
  it('maj7 → MA7 (Maj7 style — default)', () => {
    // With maj7Style='Maj7' the code returns 'MA' + suffix
    assert.equal(ctx.formatChordQuality('maj7'), 'MA7');
  });
  it('ø → ø7 (halfDimStyle=ø default)', () => {
    assert.equal(ctx.formatChordQuality('ø'), 'ø7');
    assert.equal(ctx.formatChordQuality('m7b5'), 'ø7');
  });
  it('b/# in extensions converted to unicode (7b9 → 7♭9)', () => {
    assert.equal(ctx.formatChordQuality('7b9'), '7♭9');
    assert.equal(ctx.formatChordQuality('7#11'), '7♯11');
  });
});

// ── parseChordToken ───────────────────────────────────────────────────────────

describe('parseChordToken', () => {
  it('plain major chord', () => {
    const r = ctx.parseChordToken('G');
    assert.equal(r.root, 'G');
    assert.equal(r.quality, '');
    assert.equal(r.bass, '');
  });
  it('minor chord', () => {
    const r = ctx.parseChordToken('Am');
    assert.equal(r.root, 'A');
    assert.equal(r.quality, 'm');
  });
  it('slash chord', () => {
    const r = ctx.parseChordToken('G/B');
    assert.equal(r.root, 'G');
    assert.equal(r.bass, 'B');
  });
  it('flat root uses unicode symbol in display', () => {
    const r = ctx.parseChordToken('Bb7');
    assert.equal(r.root, 'B♭');
    assert.equal(r.quality, '7');
  });
  it('dim7 chord', () => {
    const r = ctx.parseChordToken('Bdim7');
    assert.equal(r.root, 'B');
    assert.equal(r.quality, 'dim7');
  });
  it('returns null for unparseable token', () => {
    assert.equal(ctx.parseChordToken('xyz_unknown'), null);
  });
  it('lowercase root implies minor (a → Am)', () => {
    const r = ctx.parseChordToken('a');
    assert.equal(r.root, 'A');
    assert.equal(r.quality, 'm');
  });
  it('blank chord */G', () => {
    const r = ctx.parseChordToken('*/G');
    assert.ok(r.isBlank);
    assert.equal(r.bass, 'G');
  });
});

// ── parseBarStructures: volta endingLabel ─────────────────────────────────────

describe('parseBarStructures — volta endingLabel', () => {
  it('1. prefix sets endingLabel on the bar and token on the chord', () => {
    // "| 1. G | Am |"
    const bars = ctx.parseBarStructures(['|', '1.', 'G', '|', 'Am', '|']);
    assert.equal(bars.length, 2);
    assert.equal(bars[0].endingLabel, '1.');
    assert.equal(bars[0].token, 'G');
    assert.ok(!bars[1].endingLabel);
    assert.equal(bars[1].token, 'Am');
  });

  it('2. prefix sets endingLabel on the bar', () => {
    // "| 2. Em |"
    const bars = ctx.parseBarStructures(['|', '2.', 'Em', '|']);
    assert.equal(bars.length, 1);
    assert.equal(bars[0].endingLabel, '2.');
    assert.equal(bars[0].token, 'Em');
  });

  it('volta prefix only affects its own bar, not subsequent bars', () => {
    // "| G | Am | 1. C | D |"
    const bars = ctx.parseBarStructures(['|', 'G', '|', 'Am', '|', '1.', 'C', '|', 'D', '|']);
    assert.equal(bars.length, 4);
    assert.ok(!bars[0].endingLabel);
    assert.ok(!bars[1].endingLabel);
    assert.equal(bars[2].endingLabel, '1.');
    assert.equal(bars[2].token, 'C');
    assert.ok(!bars[3].endingLabel);
    assert.equal(bars[3].token, 'D');
  });

  it('volta prefix with repeat barlines preserves leftBar/rightBar', () => {
    // "|: G | Am | 1. C :|"
    const bars = ctx.parseBarStructures(['|:', 'G', '|', 'Am', '|', '1.', 'C', ':|']);
    assert.equal(bars.length, 3);
    assert.equal(bars[0].leftBar, 'repeat-start');
    assert.equal(bars[2].endingLabel, '1.');
    assert.equal(bars[2].rightBar, 'repeat-end');
  });
});

// ── formatChordQuality with alternate fbSettings ──────────────────────────────

describe('formatChordQuality — alternate settings', () => {
  it('maj7 → Δ7 when maj7Style=triangle', () => {
    const altCtx = makeContext({ maj7Style: 'triangle' });
    assert.equal(altCtx.formatChordQuality('maj7'), 'Δ7');
  });
  it('maj7 → maj7 when maj7Style=maj', () => {
    const altCtx = makeContext({ maj7Style: 'maj' });
    assert.equal(altCtx.formatChordQuality('maj7'), 'maj7');
  });
  it('m → min when minorStyle=min', () => {
    const altCtx = makeContext({ minorStyle: 'min' });
    assert.equal(altCtx.formatChordQuality('m'), 'min');
  });
  it('m7b5 → m7b5 when halfDimStyle=m7b5', () => {
    const altCtx = makeContext({ halfDimStyle: 'm7b5' });
    assert.equal(altCtx.formatChordQuality('m7b5'), 'm7b5');
  });
  it('dim → ° when dimStyle=o-circle', () => {
    const altCtx = makeContext({ dimStyle: 'o-circle' });
    assert.equal(altCtx.formatChordQuality('dim7'), '°7');
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadScaffolder() {
  const src = readFileSync(new URL('../importPipeline.js', import.meta.url), 'utf8');
  const start = src.indexOf('const HYBRID_PRESET_PATTERNS');
  if (start < 0) throw new Error('HYBRID_PRESET_PATTERNS not found in importPipeline.js');
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(src.slice(start), context);
  return {
    toHybridCSMPN: context.window.toHybridCSMPN,
    HYBRID_PRESET_PATTERNS: context.window.HYBRID_PRESET_PATTERNS,
  };
}

test('scaffolds 4/4 quarter-hit pattern with correct bar count', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = 'Title: Test\nTime: 4/4\n\n- Verse\n| G | D | Em | C |\n';
  const out = toHybridCSMPN(csmpn, 'quarter');
  assert.ok(out.includes('{hybrid'));
  assert.ok(out.includes('b1: 1:q 2:q 3:q 4:q'));
  assert.ok(out.includes('b4: 1:q 2:q 3:q 4:q'));
  assert.ok(!out.includes('b5:'));
});

test('does not double-insert when {hybrid} block already present', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = '- Verse\n| G | D |\n{hybrid\nb1: 1:q 2:q 3:q 4:q\nb2: 1:q 2:q 3:q 4:q\n}';
  const out = toHybridCSMPN(csmpn, 'quarter');
  assert.equal((out.match(/\{hybrid/g) || []).length, 1);
});

test('selects slow-blues pattern for 12/8 time signature', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = 'Time: 12/8\n\n- Intro\n| Bb7 | D7 |\n';
  const out = toHybridCSMPN(csmpn, 'slow-blues');
  assert.ok(out.includes('1:q 4:q 7:q 10:q'));
});

test('counts bars correctly across multiple bar lines in the same section', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = '- Verse\n| G | D |\n| Em | C |\n';
  const out = toHybridCSMPN(csmpn, 'quarter');
  // 2 bar lines × 2 bars each = 4 bars, all in one {hybrid} block after the last bar line
  assert.ok(out.includes('b4: '));
  assert.ok(!out.includes('b5:'));
  assert.equal((out.match(/\{hybrid/g) || []).length, 1);
});

test('generates independent {hybrid} blocks for multiple sections', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = '- Verse\n| G | D |\n- Chorus\n| C | G |\n';
  const out = toHybridCSMPN(csmpn, 'quarter');
  assert.equal((out.match(/\{hybrid/g) || []).length, 2);
});

test('falls back to 4/4 pattern when time sig is not in preset map', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = 'Time: 7/8\n\n- Verse\n| G | D |\n';
  const out = toHybridCSMPN(csmpn, 'quarter');
  assert.ok(out.includes('1:q 2:q 3:q 4:q'));
});

test('swing preset adds accent flags on strong beats', () => {
  const { toHybridCSMPN } = loadScaffolder();
  const csmpn = 'Time: 4/4\n\n- Verse\n| G |\n';
  const out = toHybridCSMPN(csmpn, 'swing');
  assert.ok(out.includes('1:q!'));
  assert.ok(out.includes('3:q!'));
});

test('HYBRID_PRESET_PATTERNS covers all seven presets', () => {
  const { HYBRID_PRESET_PATTERNS } = loadScaffolder();
  const expected = ['quarter', 'eighth', 'swing', 'funk-16', 'bossa', 'waltz', 'slow-blues'];
  for (const key of expected) {
    assert.ok(key in HYBRID_PRESET_PATTERNS, `Missing preset: ${key}`);
    assert.ok('4/4' in HYBRID_PRESET_PATTERNS[key], `Preset ${key} missing 4/4`);
    assert.ok('12/8' in HYBRID_PRESET_PATTERNS[key], `Preset ${key} missing 12/8`);
  }
});

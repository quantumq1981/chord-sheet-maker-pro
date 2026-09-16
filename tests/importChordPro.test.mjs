/**
 * tests/importChordPro.test.mjs
 *
 * Regression tests for importChordPro (importPipeline.js). The reported bug: a
 * chords-over-lyrics sheet imported via ChordPro rendered ONLY section headers —
 * every chord-less and every bare-chord line was silently dropped. Loads the
 * browser-global script chain into a vm sandbox (same pattern as
 * importPipelineUtils.test.mjs) with a setStatus stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeCtx() {
  const context = {
    fbSettings: { barsPerRow: 4, includeLyrics: true },
    importDiagnostics: null,
    validationWarnings: [],
    setStatus: () => {},
    document: {
      getElementById: () => null,
      createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
      body: { appendChild: () => {} },
    },
    window: {},
    navigator: {},
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    console,
  };
  const root = new URL('../', import.meta.url).pathname;
  const load = (n) => readFileSync(root + n, 'utf8');
  vm.createContext(context);
  vm.runInContext(load('utils.js'), context);
  vm.runInContext(load('chordProcessing.js'), context);
  vm.runInContext(load('csmpnParser.js'), context);
  vm.runInContext(load('importPipeline.js'), context);
  return context;
}
const ctx = makeCtx();

test('importChordPro: chords-over-lyrics keeps the lyrics AND the chords (the reported bug)', () => {
  const src = [
    '[Verse 1]',
    '       C            G',
    "There's a bright golden haze on the meadow",
    '[Chorus]',
    '   C            G',
    "Oh what a beautiful mornin'",
  ].join('\n');
  const out = ctx.importChordPro(src);
  assert.ok(/^: Verse 1$/m.test(out), 'Verse 1 section header preserved');
  assert.ok(/^: Chorus$/m.test(out), 'Chorus section header preserved');
  // Lyrics survive as CSMPN ; comment lines (previously dropped entirely).
  assert.ok(/;\s*There's a bright golden haze on the meadow/.test(out), 'verse lyric preserved');
  assert.ok(/;\s*Oh what a beautiful mornin'/.test(out), 'chorus lyric preserved');
  // Bare chord lines become bars (previously dropped → empty chart).
  assert.ok(/^C G$/m.test(out), 'bare chord line → bars');
  // And it is emphatically NOT just headers.
  assert.ok(
    out.split('\n').some((l) => /^;/.test(l)),
    'output carries lyric lines, not only headers'
  );
});

test('importChordPro: bracketed inline ChordPro still works (no regression)', () => {
  const src = [
    '{title: Test Song}',
    '{start_of_verse}',
    '[C]Hello [G]world',
    '{end_of_verse}',
  ].join('\n');
  const out = ctx.importChordPro(src);
  assert.ok(/^Title: Test Song$/m.test(out), 'title header');
  assert.ok(/^: Verse$/m.test(out), 'start_of_verse → section');
  assert.ok(/^C G$/m.test(out), 'inline chords → bars');
  assert.ok(/;\s*Hello world/.test(out), 'inline-chord lyric preserved');
});

test('importChordPro: {comment} lyric + [chord]-only line (the Billy Joel structure)', () => {
  const src = [
    '[Verse 1]',
    '[E]',
    "{comment: What's the matter with the clothes I'm wearing?}",
  ].join('\n');
  const out = ctx.importChordPro(src);
  assert.ok(/^: Verse 1$/m.test(out), 'section');
  assert.ok(/^E$/m.test(out), 'chord-only bracket line → bar');
  assert.ok(/;\s*What's the matter with the clothes/.test(out), 'comment lyric preserved');
});

test('importChordPro: {sot}…{eot} tab block is skipped, not emitted as lyrics', () => {
  const src = ['{sot}', 'e|--0--2--3--|', 'B|--1--1--0--|', '{eot}', 'A real lyric line'].join(
    '\n'
  );
  const out = ctx.importChordPro(src);
  assert.ok(!/0--2--3/.test(out), 'tab lines are dropped');
  assert.ok(/;\s*A real lyric line/.test(out), 'real lyric after the tab block survives');
});

test('importChordPro: empty / whitespace input does not throw', () => {
  assert.doesNotThrow(() => ctx.importChordPro(''));
  assert.doesNotThrow(() => ctx.importChordPro('   \n  \n'));
});

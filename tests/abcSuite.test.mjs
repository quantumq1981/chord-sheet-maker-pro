import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// abcSuite.js pure helpers need no DOM/abcjs.
function loadAbc() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('abcSuite.js'), ctx);
  return ctx.window.ABCSuite;
}

const A = loadAbc();

test('exposes the expected API surface', () => {
  for (const fn of [
    'extractAbcTitle',
    'abcTempoBpm',
    'sniffIsAbc',
    'defaultAbcExample',
    'ensureAbcHeaders',
    'render',
    'createSynthController',
    'abcjsReady',
  ]) {
    assert.equal(typeof A[fn], 'function', `${fn} is a function`);
  }
  assert.match(A.SOUNDFONT_URL, /cdn\.jsdelivr\.net/); // CSP-allowed host
});

test('extractAbcTitle reads the first T: field', () => {
  assert.equal(A.extractAbcTitle('X:1\nT:Greensleeves\nK:Am\nA'), 'Greensleeves');
  assert.equal(A.extractAbcTitle('X:1\nK:C\nC'), 'Untitled');
});

test('abcTempoBpm parses Q: in both forms', () => {
  assert.equal(A.abcTempoBpm('X:1\nQ:1/4=120\nK:C'), 120);
  assert.equal(A.abcTempoBpm('X:1\nQ:1/4 = 90\nK:C'), 90);
  assert.equal(A.abcTempoBpm('X:1\nQ:144\nK:C'), 144);
  assert.equal(A.abcTempoBpm('X:1\nK:C'), null);
});

test('sniffIsAbc requires both X: and K:', () => {
  assert.equal(A.sniffIsAbc('X:1\nT:T\nK:C\nCDEF'), true);
  assert.equal(A.sniffIsAbc('just some chords G C D'), false);
  assert.equal(A.sniffIsAbc('K:C only'), false);
});

test('defaultAbcExample is a complete, well-formed tune', () => {
  const ex = A.defaultAbcExample();
  assert.equal(A.sniffIsAbc(ex), true);
  // ensureAbcHeaders is a no-op on already-complete input
  assert.equal(A.ensureAbcHeaders(ex), ex);
});

test('ensureAbcHeaders leaves well-formed ABC untouched', () => {
  const ok = 'X:1\nT:Tune\nM:6/8\nL:1/8\nK:G\nGAB cde';
  assert.equal(A.ensureAbcHeaders(ok), ok);
});

test('ensureAbcHeaders injects X:/M:/L:/K: for a bare body', () => {
  const out = A.ensureAbcHeaders('CDEF GABc | c4 z4 |]');
  const lines = out.split('\n');
  assert.equal(lines[0], 'X:1');
  assert.ok(out.includes('M:4/4'));
  assert.ok(out.includes('L:1/8'));
  // K: must be the last header line, immediately before the body
  const kIdx = lines.findIndex((l) => l.startsWith('K:'));
  assert.equal(lines[kIdx], 'K:C');
  assert.equal(lines[kIdx + 1], 'CDEF GABc | c4 z4 |]');
  assert.equal(A.sniffIsAbc(out), true);
});

test('ensureAbcHeaders preserves present fields and only fills the gaps', () => {
  // Has T:, M:, body — but no X: and no K:
  const out = A.ensureAbcHeaders('T:Partial\nM:3/4\n"Am"A2c2e2');
  assert.ok(out.includes('T:Partial'));
  assert.ok(out.includes('M:3/4')); // not overwritten with the 4/4 default
  assert.ok(/(^|\n)X:1/.test(out));
  assert.ok(/(^|\n)L:1\/8/.test(out)); // missing → default added
  const lines = out.split('\n');
  assert.equal(lines[lines.length - 1], '"Am"A2c2e2'); // body stays last
  assert.ok(lines[lines.length - 2].startsWith('K:')); // K: just above body
});

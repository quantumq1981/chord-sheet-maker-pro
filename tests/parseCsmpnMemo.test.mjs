/**
 * Unit tests for the parseCSMPN memoization wrapper installed at the end of
 * csmpnParser.js. The parser is loaded into a vm context (mirroring the other
 * root-JS tests) so the global reassignment behaves exactly as it does in the
 * browser.
 *
 * Verifies:
 *   1. Parsing is still correct (memo wrapper is transparent).
 *   2. Identical input returns the SAME cached object reference (cache hit).
 *   3. Different input returns a different object.
 *   4. The FIFO cache (MAX=4) evicts the oldest entry, so a 5th distinct text
 *      pushes the first one out and re-parsing it yields a fresh object.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadParser() {
  const root = new URL('..', import.meta.url);
  const utilsSrc = readFileSync(new URL('utils.js', root), 'utf8');
  const chordProcSrc = readFileSync(new URL('chordProcessing.js', root), 'utf8');
  const csmpnParserSrc = readFileSync(new URL('csmpnParser.js', root), 'utf8');

  const context = {
    window: {},
    document: {
      createElement() {
        return { click() {}, setAttribute() {}, style: {} };
      },
      body: { appendChild() {} },
    },
    fbSettings: {},
    validationWarnings: [],
    console,
  };
  vm.createContext(context);
  vm.runInContext(utilsSrc, context);
  vm.runInContext(chordProcSrc, context);
  vm.runInContext(csmpnParserSrc, context);
  return context;
}

test('parseCSMPN memo: parsing is still correct', () => {
  const ctx = loadParser();
  const doc = ctx.parseCSMPN('Title: Test Song\nKey: C\n- Verse\nC G Am F');
  assert.equal(doc.title, 'Test Song');
  assert.equal(doc.key, 'C');
  assert.ok(doc.blocks.length > 0);
});

test('parseCSMPN memo: identical text returns the same cached reference', () => {
  const ctx = loadParser();
  const text = 'Title: A\n- V\nC G';
  const first = ctx.parseCSMPN(text);
  const second = ctx.parseCSMPN(text);
  assert.strictEqual(first, second, 'cache hit should return the identical object');
});

test('parseCSMPN memo: different text returns different objects', () => {
  const ctx = loadParser();
  const a = ctx.parseCSMPN('Title: A\n- V\nC G');
  const b = ctx.parseCSMPN('Title: B\n- V\nD A');
  assert.notStrictEqual(a, b);
  assert.equal(a.title, 'A');
  assert.equal(b.title, 'B');
});

test('parseCSMPN memo: FIFO cache evicts the oldest entry past MAX=4', () => {
  const ctx = loadParser();
  const t1 = 'Title: 1\n- V\nC';
  const first1 = ctx.parseCSMPN(t1);
  // Fill the cache with 4 more distinct texts, pushing t1 out (MAX=4).
  ctx.parseCSMPN('Title: 2\n- V\nD');
  ctx.parseCSMPN('Title: 3\n- V\nE');
  ctx.parseCSMPN('Title: 4\n- V\nF');
  ctx.parseCSMPN('Title: 5\n- V\nG');
  const first1Again = ctx.parseCSMPN(t1);
  // t1 was evicted, so it is re-parsed into a fresh object (not the cached one).
  assert.notStrictEqual(first1, first1Again);
  assert.equal(first1Again.title, '1');
});

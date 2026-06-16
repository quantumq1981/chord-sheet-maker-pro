import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The TS twin (fretToChord.ts) and the browser-global source (chordTheory.js) must
// carry identical chord-recognition DATA. This test fails if either drifts.
import {
  NOTE_NAMES as TS_NOTE_NAMES,
  CHORD_PATTERNS as TS_CHORD_PATTERNS,
} from '../src/utils/fretToChord.js';

function loadChordTheory() {
  const ctx: { window: Record<string, unknown>; module: { exports: unknown } } = {
    window: {},
    module: { exports: {} },
  };
  vm.createContext(ctx);
  const src = readFileSync(new URL('../chordTheory.js', import.meta.url), 'utf8');
  vm.runInContext(src, ctx as unknown as vm.Context);
  return ctx.window.ChordTheory as {
    NOTE_NAMES: string[];
    CHORD_PATTERNS: Array<{ suffix: string; intervals: number[] }>;
  };
}

const CT = loadChordTheory();

// Array.from rebuilds containers in THIS realm — CT comes from a vm context whose
// array prototype would otherwise trip the strict deepEqual.
const norm = (arr: ReadonlyArray<{ suffix: string; intervals: readonly number[] }>) =>
  Array.from(arr, (p) => ({ suffix: p.suffix, intervals: Array.from(p.intervals) }));

test('chordTheory.js NOTE_NAMES matches fretToChord.ts', () => {
  assert.deepEqual(Array.from(CT.NOTE_NAMES), Array.from(TS_NOTE_NAMES));
});

test('chordTheory.js CHORD_PATTERNS matches fretToChord.ts (same suffixes, intervals, AND order)', () => {
  assert.deepEqual(norm(CT.CHORD_PATTERNS), norm(TS_CHORD_PATTERNS));
});

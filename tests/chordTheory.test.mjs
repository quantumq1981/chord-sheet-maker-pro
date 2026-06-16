import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadChordTheory() {
  const ctx = { window: {}, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('chordTheory.js'), ctx);
  return ctx.window.ChordTheory;
}

const CT = loadChordTheory();

test('NOTE_NAMES is the family canonical spelling (Bb C# Eb F# Ab — never A#/Db/D#/Gb/G#)', () => {
  assert.deepEqual(Array.from(CT.NOTE_NAMES), [
    'C',
    'C#',
    'D',
    'Eb',
    'E',
    'F',
    'F#',
    'G',
    'Ab',
    'A',
    'Bb',
    'B',
  ]);
});

test('CHORD_PATTERNS is well-formed (root-relative, root-0, deduped suffixes)', () => {
  assert.ok(Array.isArray(CT.CHORD_PATTERNS) && CT.CHORD_PATTERNS.length >= 20);
  const suffixes = new Set();
  for (const p of CT.CHORD_PATTERNS) {
    assert.equal(typeof p.suffix, 'string');
    assert.ok(Array.isArray(p.intervals) && p.intervals.length >= 2);
    assert.equal(p.intervals[0], 0, `${p.suffix} must start at the root (0)`);
    assert.ok(
      p.intervals.every((i) => i >= 0 && i < 12),
      `${p.suffix} intervals in 0..11`
    );
    assert.ok(!suffixes.has(p.suffix), `duplicate suffix ${p.suffix}`);
    suffixes.add(p.suffix);
  }
  // common qualities present
  for (const s of ['', 'm', '7', 'maj7', 'm7', 'dim', 'aug', 'sus4'])
    assert.ok(suffixes.has(s), `missing ${s}`);
});

test('the major triad is first (exact-match recognisers depend on order)', () => {
  assert.deepEqual(Array.from(CT.CHORD_PATTERNS[0].intervals), [0, 4, 7]);
  assert.equal(CT.CHORD_PATTERNS[0].suffix, '');
});

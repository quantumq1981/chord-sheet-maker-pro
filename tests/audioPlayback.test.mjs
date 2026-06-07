import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// audioPlayback.js alone — the pure chord/interval helpers need no other modules.
function loadAudio() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('audioPlayback.js'), ctx);
  return ctx.window.AudioPlayback;
}

// Full stack so buildSchedule can call the real parseHybridChartFromCSMPN.
function loadStack() {
  const ctx = {
    window: {},
    console,
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {} }),
      querySelector: () => null,
    },
    fbSettings: { barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'flat',
    CustomEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
  };
  ctx.window.document = ctx.document;
  ctx.window.dispatchEvent = () => {};
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of [
    'utils.js',
    'chordProcessing.js',
    'csmpnParser.js',
    'musicXmlCore.js',
    'renderer.js',
    'importPipeline.js',
    'audioPlayback.js',
  ])
    vm.runInContext(read(f), ctx);
  return ctx.window.AudioPlayback;
}

// Array.from rebuilds the array in THIS realm (chordToMidi returns vm-realm arrays,
// whose prototype would otherwise trip deepStrictEqual).
const pcs = (midi) => Array.from(midi, (m) => ((m % 12) + 12) % 12);

test('chordToMidi builds correct pitch classes for common qualities', () => {
  const A = loadAudio();
  // C major triad → C E G (+ bass C)
  assert.deepEqual(pcs(A.chordToMidi('C')), [0, 0, 4, 7]);
  // C minor → C Eb G
  assert.deepEqual(pcs(A.chordToMidi('Cm')), [0, 0, 3, 7]);
  // C7 → C E G Bb
  assert.deepEqual(pcs(A.chordToMidi('C7')), [0, 0, 4, 7, 10]);
  // Cmaj7 → C E G B
  assert.deepEqual(pcs(A.chordToMidi('Cmaj7')), [0, 0, 4, 7, 11]);
  // half-diminished F#m7b5 → F# A C E
  assert.deepEqual(pcs(A.chordToMidi('F#m7b5')), [6, 6, 9, 0, 4]);
});

test('chordToMidi puts the slash bass at the bottom', () => {
  const A = loadAudio();
  const midi = A.chordToMidi('D/F#');
  assert.equal(pcs([midi[0]])[0], 6, 'lowest note is F# (the slash bass)');
  // and the chord itself is a D major triad above it
  assert.deepEqual(
    pcs(midi.slice(1)).sort((a, b) => a - b),
    [2, 6, 9]
  );
});

test('chordToMidi returns nothing for non-pitched tokens', () => {
  const A = loadAudio();
  assert.equal(A.chordToMidi('%').length, 0);
  assert.equal(A.chordToMidi('N.C.').length, 0);
  assert.equal(A.chordToMidi('').length, 0);
});

test('buildSchedule plays chord changes in time for a plain chart', () => {
  const A = loadStack();
  const s = A.buildSchedule('Tempo: 120\nTime: 4/4\n\n- V\n| C | Am | F | G |\n');
  assert.equal(s.tempo, 120);
  assert.equal(s.strikes.length, 4);
  // 120 BPM, 4/4 → 2s per bar; one chord per bar at 0,2,4,6
  assert.deepEqual(
    Array.from(s.strikes, (k) => Math.round(k.t * 100) / 100),
    [0, 2, 4, 6]
  );
  assert.deepEqual(
    Array.from(s.strikes, (k) => k.chord),
    ['C', 'Am', 'F', 'G']
  );
});

test('buildSchedule follows the notated hybrid rhythm', () => {
  const A = loadStack();
  const s = A.buildSchedule(
    'Tempo: 120\nTime: 4/4\n\n- V\n| C | G |\n{hybrid\nb1: 1:q(C) 2:e 2&:e 3:q 4:q\nb2: 1:h(G) 3:h\n}'
  );
  // bar 1 = 5 hits, bar 2 = 2 hits
  assert.equal(s.strikes.length, 7);
  // first hit at t=0, the "2&" hit at t=0.75 (beat 2.5 × 0.5s)
  assert.equal(Math.round(s.strikes[0].t * 100) / 100, 0);
  assert.equal(Math.round(s.strikes[2].t * 100) / 100, 0.75);
  // bar 2 half-note G at t=2.0 lasting 1.0s
  const g = s.strikes.find((k) => k.chord === 'G');
  assert.equal(Math.round(g.t * 100) / 100, 2);
  assert.equal(Math.round(g.dur * 100) / 100, 1);
});

test('buildSchedule holds the previous chord through a % repeat bar', () => {
  const A = loadStack();
  const s = A.buildSchedule('Tempo: 120\nTime: 4/4\n\n- V\n| C | % |\n');
  assert.equal(s.strikes.length, 2);
  assert.equal(s.strikes[1].chord, 'C', '% bar repeats the previous chord');
});

test('buildSchedule respects compound-meter bar length (12/8)', () => {
  const A = loadStack();
  // 12/8 at 120 BPM → 6 quarter-units/bar × 0.5s = 3s per bar; 2 bars → 6s total
  const s = A.buildSchedule('Tempo: 120\nTime: 12/8\n\n- V\n| Bb7 | Eb7 |\n');
  assert.equal(Math.round(s.duration * 100) / 100, 6);
  assert.equal(Math.round(s.strikes[1].t * 100) / 100, 3);
});

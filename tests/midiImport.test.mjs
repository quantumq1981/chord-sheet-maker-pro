import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadMidi() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('midiImport.js'), ctx);
  return ctx.window.MidiImport;
}

const M = loadMidi();

// A minimal Standard MIDI File: ppq=96, tempo 120 (500000 µs/qn), 4/4, a C-major
// triad (C4/E4/G4 = 60/64/67) sounding for one full 4/4 bar (0 → 384 ticks).
function tinyMidi() {
  return Uint8Array.from([
    0x4d,
    0x54,
    0x68,
    0x64,
    0x00,
    0x00,
    0x00,
    0x06, // MThd, len 6
    0x00,
    0x00, // format 0
    0x00,
    0x01, // 1 track
    0x00,
    0x60, // division = 96 ppq
    0x4d,
    0x54,
    0x72,
    0x6b,
    0x00,
    0x00,
    0x00,
    0x2c, // MTrk, len 44
    0x00,
    0xff,
    0x51,
    0x03,
    0x07,
    0xa1,
    0x20, // tempo 500000 → 120bpm
    0x00,
    0xff,
    0x58,
    0x04,
    0x04,
    0x02,
    0x18,
    0x08, // 4/4
    0x00,
    0x90,
    0x3c,
    0x40, // C4 on
    0x00,
    0x90,
    0x40,
    0x40, // E4 on
    0x00,
    0x90,
    0x43,
    0x40, // G4 on
    0x83,
    0x00,
    0x80,
    0x3c,
    0x40, // +384, C4 off
    0x00,
    0x80,
    0x40,
    0x40, // E4 off
    0x00,
    0x80,
    0x43,
    0x40, // G4 off
    0x00,
    0xff,
    0x2f,
    0x00, // EOT
  ]);
}

test('readVLQ decodes variable-length quantities', () => {
  assert.equal(M.readVLQ([0x00], { p: 0 }), 0);
  assert.equal(M.readVLQ([0x7f], { p: 0 }), 127);
  assert.equal(M.readVLQ([0x81, 0x00], { p: 0 }), 128);
  assert.equal(M.readVLQ([0x83, 0x00], { p: 0 }), 384);
  assert.equal(M.readVLQ([0xff, 0x7f], { p: 0 }), 16383);
});

test('parseMidi reads header, tempo, time signature, and notes', () => {
  const p = M.parseMidi(tinyMidi());
  assert.equal(p.ppq, 96);
  assert.equal(p.tempoBpm, 120);
  assert.deepEqual({ num: p.timeSig.num, den: p.timeSig.den }, { num: 4, den: 4 });
  assert.equal(p.notes.length, 3);
  const midis = Array.from(p.notes, (n) => n.midi).sort((a, b) => a - b);
  assert.deepEqual(midis, [60, 64, 67]);
  for (const n of p.notes) {
    assert.equal(n.start, 0);
    assert.equal(n.dur, 384);
  }
});

test('parseMidi throws on a non-MIDI buffer', () => {
  assert.throws(() => M.parseMidi(Uint8Array.from([1, 2, 3, 4])), /Not a MIDI file/);
});

test('recognizeChord names common triads/sevenths from pitch classes', () => {
  assert.equal(M.recognizeChord([0, 4, 7], 0), 'C');
  assert.equal(M.recognizeChord([0, 3, 7], 0), 'Cm');
  assert.equal(M.recognizeChord([0, 4, 7, 10], 0), 'C7');
  assert.equal(M.recognizeChord([0, 4, 7, 11], 0), 'Cmaj7');
  assert.equal(M.recognizeChord([2, 6, 9], 2), 'D'); // family spelling (F# not Gb)
});

test('recognizeChord uses canonical (flat) spelling for black-key roots', () => {
  assert.equal(M.recognizeChord([10, 2, 5], 10), 'Bb'); // not A#
  assert.equal(M.recognizeChord([3, 7, 10], 3), 'Eb'); // not D#
  assert.equal(M.recognizeChord([8, 0, 3], 8), 'Ab'); // not G#
});

test('recognizeChord emits a slash chord when the bass is not the root', () => {
  assert.equal(M.recognizeChord([0, 4, 7], 4), 'C/E');
  assert.equal(M.recognizeChord([7, 11, 2], 11), 'G/B');
});

test('recognizeChord returns a bare note name for a single pitch class', () => {
  assert.equal(M.recognizeChord([9], 9), 'A');
});

test('notesToBars slices into bars and keeps strong pitch classes', () => {
  // ppq 96, 4/4 → barTicks 384. Bar0 = C major; bar1 = G major.
  const notes = [
    { midi: 60, start: 0, dur: 384 },
    { midi: 64, start: 0, dur: 384 },
    { midi: 67, start: 0, dur: 384 },
    { midi: 55, start: 384, dur: 384 },
    { midi: 59, start: 384, dur: 384 },
    { midi: 62, start: 384, dur: 384 },
  ];
  const bars = M.notesToBars(notes, 96, { num: 4, den: 4 });
  assert.equal(bars.length, 2);
  assert.equal(M.recognizeChord(Array.from(bars[0].pcs), bars[0].bassPc), 'C');
  assert.equal(M.recognizeChord(Array.from(bars[1].pcs), bars[1].bassPc), 'G');
  assert.equal(bars[0].bassPc, 0); // lowest note C
});

test('keyName maps the key-signature sf/mi to a family-spelled key', () => {
  assert.equal(M.keyName({ sf: 0, mi: 0 }), 'C');
  assert.equal(M.keyName({ sf: -2, mi: 0 }), 'Bb');
  assert.equal(M.keyName({ sf: 3, mi: 1 }), 'Am');
  assert.equal(M.keyName(null), '');
});

test('midiToCsmpn produces a complete CSMPN chart from MIDI bytes', () => {
  const csmpn = M.midiToCsmpn(tinyMidi(), { title: 'Test' });
  assert.ok(csmpn.includes('Title: Test'));
  assert.ok(csmpn.includes('Time: 4/4'));
  assert.ok(csmpn.includes('Tempo: 120'));
  assert.ok(csmpn.includes('- Chart'));
  assert.ok(/\bC\b/.test(csmpn.split('- Chart')[1]), csmpn);
});

test('midiToCsmpn collapses consecutive identical bars to %', () => {
  const notes = [];
  for (let b = 0; b < 3; b++) {
    notes.push({ midi: 60, start: b * 384, dur: 384 });
    notes.push({ midi: 64, start: b * 384, dur: 384 });
    notes.push({ midi: 67, start: b * 384, dur: 384 });
  }
  const parsed = { ppq: 96, timeSig: { num: 4, den: 4 }, tempoBpm: 120, keySig: null, notes };
  const body = M.midiToCsmpn(parsed, {}).split('- Chart')[1];
  // first bar C, next two collapse to %
  assert.equal((body.match(/%/g) || []).length, 2, body);
});

/*
 * audioCapture.test.mjs — the browser seam for the engine's audio DSP.
 *
 * The analysis lives in recognitionEngine.mjs and is tested there. What this
 * file owns is everything BETWEEN a file and that analysis: choosing an
 * analysis rate, downmixing, resampling, and the cents maths a tuner shows.
 * All of it is pure, so all of it is tested here — `decodeToPcm`,
 * `createTuner` and `pcmToChart` are the three functions that genuinely need a
 * browser, and they are the only ones left uncovered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const ctx = { window: {}, module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'audioCapture.js'), 'utf8'), ctx);
  return ctx.window.AudioCapture;
}

const ac = load();

// ── Downmix ──────────────────────────────────────────────────────────────────

test('downmix averages channels rather than summing them', () => {
  // Summing would clip a loud stereo file the moment both channels agree.
  const l = Float32Array.from([1, 0.5, -1]);
  const r = Float32Array.from([1, -0.5, -1]);
  const out = ac.downmix([l, r], 3);
  assert.deepEqual(Array.from(out), [1, 0, -1]);
});

test('downmix passes a mono track through, and survives no channels at all', () => {
  const mono = Float32Array.from([0.25, -0.75]);
  assert.deepEqual(Array.from(ac.downmix([mono], 2)), [0.25, -0.75]);
  assert.deepEqual(Array.from(ac.downmix([], 3)), [0, 0, 0]);
});

// ── Resample ─────────────────────────────────────────────────────────────────

test('resample halves the sample count when halving the rate', () => {
  const src = Float32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const out = ac.resample(src, 32000, 16000);
  assert.equal(out.length, 4);
  assert.deepEqual(Array.from(out), [0, 2, 4, 6]);
});

test('resample interpolates rather than dropping samples', () => {
  // A naive nearest-neighbour would give 0 here; linear gives the midpoint.
  const out = ac.resample(Float32Array.from([0, 10]), 2, 4);
  assert.ok(Math.abs(out[1] - 5) < 1e-6, `expected ~5, got ${out[1]}`);
});

test('resample is a passthrough at the same rate, and safe on empty input', () => {
  const src = Float32Array.from([1, 2, 3]);
  assert.equal(ac.resample(src, 16000, 16000), src, 'same rate returns the input');
  assert.equal(ac.resample(new Float32Array(0), 44100, 16000).length, 0);
  assert.equal(ac.resample(null, 44100, 16000).length, 0);
});

test('the analysis rate is well above twice the highest pitch class that matters', () => {
  // Chroma needs frequency resolution, not fidelity. 16 kHz keeps a phone
  // responsive on a four-minute song while clearing Nyquist for guitar range.
  assert.equal(ac.ANALYSIS_RATE, 16000);
});

// ── The tuner readout ────────────────────────────────────────────────────────

test('centsOff reads concert A as exactly in tune', () => {
  const a = ac.centsOff(440);
  assert.equal(a.midi, 69);
  assert.equal(a.cents, 0);
});

test('centsOff reports which way a string is out, and by how much', () => {
  const sharp = ac.centsOff(440 * Math.pow(2, 49 / 1200));
  assert.equal(sharp.midi, 69);
  assert.equal(sharp.cents, 49);

  const flat = ac.centsOff(440 * Math.pow(2, -20 / 1200));
  assert.equal(flat.midi, 69);
  assert.equal(flat.cents, -20);
});

test('exactly half a semitone flips to the neighbour, which is the honest read', () => {
  // A quarter-tone is genuinely ambiguous; reporting Bb -50 rather than A +50
  // is what a hardware tuner does, and it keeps |cents| <= 50 always.
  const quarter = ac.centsOff(440 * Math.pow(2, 50 / 1200));
  assert.equal(quarter.midi, 70);
  assert.equal(quarter.cents, -50);
});

test('centsOff finds the right note across the guitar range', () => {
  assert.equal(ac.centsOff(82.41).midi, 40, 'low E');
  assert.equal(ac.centsOff(329.63).midi, 64, 'high e');
});

test('centsOff honours a non-440 reference, and rejects silence', () => {
  assert.equal(ac.centsOff(432, 432).cents, 0, 'A=432 tuning');
  assert.equal(ac.centsOff(0), null);
  assert.equal(ac.centsOff(-5), null);
  assert.equal(ac.centsOff(null), null);
});

test('tuningVerdict is tighter than a player can hear, but not absurdly so', () => {
  assert.equal(ac.tuningVerdict(0), 'in-tune');
  assert.equal(ac.tuningVerdict(5), 'in-tune');
  assert.equal(ac.tuningVerdict(-5), 'in-tune');
  assert.equal(ac.tuningVerdict(6), 'close');
  assert.equal(ac.tuningVerdict(-25), 'close');
  assert.equal(ac.tuningVerdict(26), 'off');
  assert.equal(ac.tuningVerdict(null), 'none', 'nothing playing is not "off"');
});

// ── Meter ────────────────────────────────────────────────────────────────────

test('pulsesPerBar counts compound meters in dotted quarters, not eighths', () => {
  assert.equal(ac.pulsesPerBar('4/4'), 4);
  assert.equal(ac.pulsesPerBar('3/4'), 3);
  assert.equal(ac.pulsesPerBar('12/8'), 4, '12/8 pulses four times, not twelve');
  assert.equal(ac.pulsesPerBar('6/8'), 2);
  assert.equal(ac.pulsesPerBar('9/8'), 3);
});

test('pulsesPerBar falls back to 4/4 on anything it cannot read', () => {
  assert.equal(ac.pulsesPerBar(''), 4);
  assert.equal(ac.pulsesPerBar(null), 4);
  assert.equal(ac.pulsesPerBar('nonsense'), 4);
  // 5/8 is not a compound meter — 5 is not divisible by 3.
  assert.equal(ac.pulsesPerBar('5/8'), 5);
});

// ── Vocal-isolation A/B gate ──────────────────────────────────────────────────

test('clarityDelta only calls isolation a win when it clears the noise margin', () => {
  // Clarity is a relative gauge, so a tiny bump is measurement noise, not a real
  // improvement. A 1% rise must not flip the decision.
  const tiny = ac.clarityDelta(0.4, 0.404);
  assert.equal(tiny.deltaPct, 1);
  assert.equal(tiny.helps, false, '1% is within the noise floor');

  const win = ac.clarityDelta(0.4, 0.52);
  assert.equal(win.deltaPct, 30);
  assert.equal(win.helps, true, '30% cleaner is a real win');
});

test('clarityDelta never calls it a win when isolation made the signal worse', () => {
  const worse = ac.clarityDelta(0.5, 0.3);
  assert.equal(worse.deltaPct, -40);
  assert.equal(worse.helps, false, 'a panned-instrument mess is not an improvement');
});

test('clarityDelta reports the numbers it read back for the UI', () => {
  const d = ac.clarityDelta(0.42, 0.61);
  assert.equal(d.raw, 0.42);
  assert.equal(d.isolated, 0.61);
});

test('clarityDelta is safe when the raw mix scored zero clarity', () => {
  // No divide-by-zero: a from-nothing gain reads as a full win, silence as none.
  assert.equal(ac.clarityDelta(0, 0.3).deltaPct, 100);
  assert.equal(ac.clarityDelta(0, 0.3).helps, true);
  assert.equal(ac.clarityDelta(0, 0).helps, false);
});

test('clarityDelta honours a caller-supplied margin', () => {
  assert.equal(ac.clarityDelta(0.4, 0.42, 10).helps, false, '5% under a 10% bar');
  assert.equal(ac.clarityDelta(0.4, 0.42, 4).helps, true, '5% over a 4% bar');
});

// ── Shipping ─────────────────────────────────────────────────────────────────

test('supported() is false without Web Audio rather than throwing', () => {
  assert.equal(ac.supported(), false, 'no AudioContext in the vm');
});

test('audioCapture ships — it is in the deploy copy list', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\\\n/g, ' ');
  assert.ok(/cp [^\n]*\baudioCapture\.js\b/s.test(ci), 'audioCapture.js in the cp step');
});

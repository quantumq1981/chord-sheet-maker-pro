/**
 * audioCapture.js — the browser seam for the recognition engine's audio DSP
 * (browser global + `window.AudioCapture`).
 *
 * The analysis itself is already pure and headless-tested inside
 * `recognitionEngine.mjs` — `transcribeChords`, `detectPitch`, `extractCenter`,
 * `harmonicClarity`, `audioEventsToScore`. None of it can run without samples,
 * and getting samples is the one thing only a browser can do. So this file holds
 * exactly three impure things and nothing else:
 *
 *   1. `decodeAudioData` — a file (or the audio track of a video) → PCM
 *   2. `getUserMedia` + an AnalyserNode — the microphone, for the tuner
 *   3. an rAF loop — the tuner's polling clock
 *
 * Everything else here is pure and unit-tested: choosing an analysis sample
 * rate, turning stereo into the mono the DSP wants, and the cents/În-tune maths
 * the tuner displays.
 *
 * HONEST LIMIT, carried from the engine: a clean isolated stem gives an editable
 * sketch; a dense full mix mislabels. The UI says so rather than implying the
 * chart is authoritative.
 */
(function () {
  // The DSP works on a downsampled signal — chroma needs frequency resolution,
  // not fidelity, and 16 kHz keeps an iPhone's main thread responsive on a
  // four-minute song. Well above twice the highest pitch class that matters.
  var ANALYSIS_RATE = 16000;

  // ── Pure helpers ──────────────────────────────────────────────────────────

  /**
   * Average channels into the single track the analysers take.
   *
   * Kept separate from `decodeToPcm` because stereo is worth holding on to: the
   * engine's `extractCenter` needs both channels to isolate a centred vocal, and
   * re-decoding a file to change one toggle is a visible pause on a phone.
   */
  function downmix(channels, length) {
    var out = new Float32Array(length);
    var n = channels.length;
    if (!n) return out;
    for (var c = 0; c < n; c++) {
      var ch = channels[c];
      for (var i = 0; i < length; i++) out[i] += ch[i] / n;
    }
    return out;
  }

  /**
   * Linear-interpolating resample. Deliberately not a windowed-sinc: the target
   * is chroma and pitch estimation, both of which read magnitude spectra, and
   * the interpolation error sits far below the noise a real recording carries.
   */
  function resample(samples, fromRate, toRate) {
    if (!samples || !samples.length) return new Float32Array(0);
    if (!fromRate || fromRate === toRate) return samples;
    var ratio = fromRate / toRate;
    var outLen = Math.max(1, Math.floor(samples.length / ratio));
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      var a = samples[i0];
      var b = i0 + 1 < samples.length ? samples[i0 + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  /**
   * Cents away from the nearest equal-tempered semitone, and the note it is
   * nearest to. This is the whole readout of a tuner: −50..+50 with 0 in tune.
   */
  function centsOff(freq, refA) {
    refA = refA || 440;
    if (!freq || freq <= 0) return null;
    var midiExact = 69 + 12 * (Math.log(freq / refA) / Math.LN2);
    var midi = Math.round(midiExact);
    return { midi: midi, cents: Math.round((midiExact - midi) * 100) };
  }

  /**
   * How a tuner should behave, not just what it reads: ±5 cents reads as in
   * tune (tighter than a player can hear on a plucked string), ±25 as close.
   */
  function tuningVerdict(cents) {
    if (cents == null) return 'none';
    var a = Math.abs(cents);
    if (a <= 5) return 'in-tune';
    if (a <= 25) return 'close';
    return 'off';
  }

  /**
   * Beats per bar, from the chart's own meter, for quantising audio onsets.
   * Compound meters pulse in dotted quarters — 12/8 is four, not twelve.
   */
  function pulsesPerBar(timeSig) {
    var m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(timeSig || '4/4'));
    if (!m) return 4;
    var num = parseInt(m[1], 10);
    var den = parseInt(m[2], 10);
    if (den === 8 && num % 3 === 0 && num >= 6) return num / 3;
    return num || 4;
  }

  /**
   * The A/B gate for centre-channel vocal isolation: given the harmonic clarity
   * of the raw mix and of the isolated centre, decide whether isolation actually
   * helped *this* file. Clarity is a relative gauge — spectral leakage sets a
   * floor, so the honest read is the delta, not the absolute. Isolation "helps"
   * only when it raises clarity by more than a small margin, so noise in the
   * measurement can't flip the decision.
   */
  function clarityDelta(raw, isolated, marginPct) {
    raw = +raw || 0;
    isolated = +isolated || 0;
    var margin = marginPct != null ? marginPct : 3;
    var deltaPct = raw > 0 ? Math.round(((isolated - raw) / raw) * 100) : isolated > 0 ? 100 : 0;
    return {
      raw: raw,
      isolated: isolated,
      deltaPct: deltaPct,
      helps: isolated > raw && deltaPct >= margin,
    };
  }

  // ── Browser-only ──────────────────────────────────────────────────────────

  function audioContextClass() {
    return typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
  }

  function supported() {
    return !!audioContextClass();
  }

  /**
   * A file's bytes → analysis-rate PCM. Handles audio files and video
   * containers alike, because `decodeAudioData` pulls the audio track out of an
   * .mp4/.mov for free.
   *
   * Both channels are kept at the analysis rate so a later "isolate vocals"
   * toggle does not force a re-decode.
   */
  async function decodeToPcm(arrayBuffer) {
    var Ctx = audioContextClass();
    if (!Ctx) throw new Error('This browser has no Web Audio support.');
    var ctx = new Ctx();
    try {
      var buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
      var chans = [];
      for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      var mono = downmix(chans, buf.length);
      return {
        mono: resample(mono, buf.sampleRate, ANALYSIS_RATE),
        left: resample(chans[0] || mono, buf.sampleRate, ANALYSIS_RATE),
        right: resample(chans[1] || chans[0] || mono, buf.sampleRate, ANALYSIS_RATE),
        stereo: buf.numberOfChannels > 1,
        sampleRate: ANALYSIS_RATE,
        durationSec: buf.duration,
      };
    } finally {
      // Safari caps how many AudioContexts a page may hold; a decode context
      // that is never closed will eventually refuse to open another.
      if (ctx.close) {
        try {
          await ctx.close();
        } catch (_e) {
          /* already closed */
        }
      }
    }
  }

  /**
   * PCM → CSMPN, through the engine's chord transcription and its own
   * beat-quantising score builder.
   *
   * The hop and smoothing are the values the engine's own UI settled on: a
   * strum or a passing lead note must not be able to flip the chord by itself.
   */
  async function pcmToChart(pcm, opts) {
    opts = opts || {};
    if (!window.RecognitionBridge) throw new Error('Recognition engine not available.');
    var engine = await window.RecognitionBridge.loadEngine();

    var events = engine.transcribeChords(pcm.mono, pcm.sampleRate, {
      hopSec: 0.12,
      smoothSec: 0.5,
      minDurSec: 0.4,
      // Polyphonic audio lights 4+ pitch classes per frame, so the recogniser
      // reaches for 9ths and 6/9s and a plain G · Em · F · Am chorus comes back
      // as mush. Ranks above 14 are the jazz extensions; capping restores the
      // skeleton. Off by default so a jazz stem can still name what it plays.
      maxRank: opts.simple === false ? undefined : 14,
    });
    if (!events || !events.length) return null;

    var score = engine.audioEventsToScore(events, {
      bpm: opts.bpm || 120,
      beatsPerBar: pulsesPerBar(opts.timeSig || '4/4'),
    });
    if (!score || !score.bars || !score.bars.length) return null;

    var key = engine.analyzeKey(score);
    return {
      csmpn: engine.scoreToCSMPN(score, {
        title: opts.title || 'Audio import',
        key: key,
        tempo: opts.bpm || 0,
        useSharp: true,
        // Audio carries no fingering, and onsets are estimates rather than
        // notated rhythm — claiming either would be dressing up a guess.
        tab: false,
        hybrid: false,
      }),
      score: score,
      events: events,
      key: engine.keyName(key, true) || '',
      bars: score.bars.length,
    };
  }

  /**
   * Centre-channel vocal isolation, gated on whether it measurably helps.
   *
   * Lead and backing vocals are almost always mixed to the centre while
   * instruments are panned to the sides, so isolating the centre pulls a usable
   * vocal stem — the engine's `extractCenter` does the STFT work. But it is an
   * approximation (centred kick/bass leaks in, a mono file is a passthrough), so
   * the decision is not made blind: `harmonicClarity` scores the raw mix and the
   * isolated centre, and the centred signal is used ONLY when it reads cleaner.
   *
   * Returns the mono signal to analyse (`center` when it helps, else the raw
   * downmix), the A/B numbers for the UI to report, and whether isolation was
   * applied. A mono file skips the whole thing — there is no centre to extract.
   */
  async function isolateAndGate(pcm, opts) {
    opts = opts || {};
    if (!pcm || !pcm.stereo) {
      return { mono: pcm ? pcm.mono : null, ab: null, applied: false, stereo: false };
    }
    if (!window.RecognitionBridge) throw new Error('Recognition engine not available.');
    var engine = await window.RecognitionBridge.loadEngine();
    // A mild high-pass trims centred kick/bass leak so it can't fake a bass note
    // under the vocal; the vocal fundamental sits well above it.
    var center = engine.extractCenter(pcm.left, pcm.right, pcm.sampleRate, {
      minFreq: opts.minFreq != null ? opts.minFreq : 120,
    });
    var rawClarity = engine.harmonicClarity(pcm.mono, pcm.sampleRate);
    var isoClarity = engine.harmonicClarity(center, pcm.sampleRate);
    var ab = clarityDelta(rawClarity, isoClarity, opts.marginPct);
    return { mono: ab.helps ? center : pcm.mono, ab: ab, applied: ab.helps, stereo: true };
  }

  /**
   * Live pitch from the microphone. Returns a handle with `stop()`; `onNote`
   * fires with `{ freq, midi, note, cents, verdict, clarity }` or null when
   * nothing steady is being played.
   *
   * Feature-detected and try/catch'd throughout: a denied permission or a
   * device with no input must produce a clear message, never a dead UI.
   */
  async function createTuner(opts) {
    opts = opts || {};
    var Ctx = audioContextClass();
    if (!Ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot access the microphone.');
    }
    if (!window.RecognitionBridge) throw new Error('Recognition engine not available.');
    var engine = await window.RecognitionBridge.loadEngine();

    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var ctx = new Ctx();
    if (ctx.state === 'suspended' && ctx.resume) await ctx.resume(); // iOS
    var src = ctx.createMediaStreamSource(stream);
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);

    var buf = new Float32Array(analyser.fftSize);
    var raf = null;
    var stopped = false;
    var lastAt = 0;

    function tick(ts) {
      if (stopped) return;
      // ~70ms between reads: faster than a player can react, slow enough to
      // leave the phone's main thread alone.
      if (ts - lastAt >= 70) {
        lastAt = ts;
        analyser.getFloatTimeDomainData(buf);
        var got = null;
        try {
          got = engine.detectPitch(buf, ctx.sampleRate, { minClarity: opts.minClarity || 0.9 });
        } catch (_e) {
          got = null;
        }
        if (got && got.freq) {
          var off = centsOff(got.freq, opts.refA);
          opts.onNote &&
            opts.onNote({
              freq: got.freq,
              midi: off ? off.midi : got.midi,
              note: engine.midiToNoteName(off ? off.midi : got.midi, true),
              cents: off ? off.cents : 0,
              verdict: tuningVerdict(off ? off.cents : null),
              clarity: got.clarity,
            });
        } else {
          opts.onNote && opts.onNote(null);
        }
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);

    return {
      stop: function () {
        stopped = true;
        if (raf) cancelAnimationFrame(raf);
        // Release the mic indicator, then the context — leaving either open
        // keeps the recording dot lit on iOS long after the panel closes.
        try {
          stream.getTracks().forEach(function (t) {
            t.stop();
          });
        } catch (_e) {
          /* already stopped */
        }
        try {
          if (ctx.close) ctx.close();
        } catch (_e) {
          /* already closed */
        }
      },
    };
  }

  var api = {
    ANALYSIS_RATE: ANALYSIS_RATE,
    downmix: downmix,
    resample: resample,
    centsOff: centsOff,
    tuningVerdict: tuningVerdict,
    pulsesPerBar: pulsesPerBar,
    clarityDelta: clarityDelta,
    supported: supported,
    decodeToPcm: decodeToPcm,
    pcmToChart: pcmToChart,
    isolateAndGate: isolateAndGate,
    createTuner: createTuner,
  };
  if (typeof window !== 'undefined') window.AudioCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

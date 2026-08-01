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

  /**
   * The chords one bar renders, in the exact order `renderer.js` `hrBar()` draws
   * them. This is the ONE thing the reference-audio sync couples to: the engine
   * score built below and the `data-ci` indices the renderer stamps must agree on
   * chord ORDER (not beats), so the Nth chord here is `[data-ci="N"]` on the page.
   * Mirror of hrBar: events carrying a chord win; otherwise the `_`-split token.
   */
  function chartChordList(bar) {
    var events = bar && Array.isArray(bar.events) ? bar.events : [];
    var withChord = [];
    for (var i = 0; i < events.length; i++) {
      if (events[i] && events[i].chord)
        withChord.push(String(events[i].chord).replace(/[!~]$/, '').trim());
    }
    if (withChord.length) return withChord;
    if (bar && bar.chordToken) {
      return String(bar.chordToken)
        .replace(/[!~]$/, '')
        .trim()
        .split('_')
        .map(function (p) {
          return p.trim();
        })
        .filter(Boolean);
    }
    return [];
  }

  function parseTimeSig(ts) {
    var m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(ts || '4/4'));
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : [4, 4];
  }

  /**
   * Turn the current CSMPN chart into the engine's score shape (the one
   * `scoreChromaSequence`/`scoreEventTimes`/`alignPcmToScore` consume) plus a
   * `keyToCi` map from each event's `${bar}.${beat}` key back to the running
   * chord index the renderer stamped. Walks `parseHybridChartFromCSMPN` sections
   * → bars in the same order the renderer does, so indices line up.
   *
   * `chordToMidi` is injected (the app passes `AudioPlayback.chordToMidi`) so this
   * stays pure and unit-testable with a stub. Beats are assigned by even split
   * within the bar — the alignment keys are internal and mapped back to `ci`, so
   * the beat values only need to be self-consistent, not match the renderer's.
   */
  function csmpnChartToScore(source, chordToMidi) {
    var parse = typeof window !== 'undefined' && window.parseHybridChartFromCSMPN;
    if (!parse) return null;
    var hybrid = parse(source || '');
    if (!hybrid || !hybrid.sections || !hybrid.sections.length) return null;
    var docTs = parseTimeSig(hybrid.time || '4/4');
    var bars = [];
    var keyToCi = {};
    var ci = 0;
    var barNum = 0;
    for (var si = 0; si < hybrid.sections.length; si++) {
      var secBars = hybrid.sections[si].bars || [];
      for (var bi = 0; bi < secBars.length; bi++) {
        var bar = secBars[bi];
        barNum++;
        var ts = bar && bar.timeSig ? parseTimeSig(bar.timeSig) : docTs;
        var pulses = ts[0] || 4;
        var chords = chartChordList(bar);
        var n = chords.length;
        var events = [];
        for (var k = 0; k < n; k++) {
          var dur = pulses / n;
          var beat = k * dur;
          var midis = chordToMidi ? chordToMidi(chords[k]) || [] : [];
          events.push({
            symbol: chords[k],
            midis: Array.from(midis),
            beat: beat,
            durBeats: dur,
            qbeat: beat,
            qdur: dur,
          });
          keyToCi[barNum + '.' + beat] = ci;
          ci++;
        }
        bars.push({ number: barNum, timeSig: ts, events: events });
      }
    }
    if (!ci) return null;
    return { score: { timeSig: docTs, bars: bars }, keyToCi: keyToCi, chordCount: ci };
  }

  /**
   * Map DTW/linear segment keys onto chord indices. Pure helper split out so the
   * key→ci translation is unit-testable without the engine.
   */
  function segmentsToCi(segments, keyToCi) {
    return (segments || []).map(function (seg) {
      var ci = seg.key != null && keyToCi[seg.key] != null ? keyToCi[seg.key] : -1;
      return { sec: seg.sec, ci: ci };
    });
  }

  /*
   * Notation and score formats a musician plausibly reaches for when a control
   * says "attach a file" — none of which `decodeAudioData` can touch. A .mid is
   * note events and a .musicxml is engraving instructions; neither contains a
   * waveform, so the browser rejects them with a bare "Unable to decode audio
   * data" that tells the player nothing about what to do instead.
   */
  var SCORE_EXTS = {
    mid: 'MIDI',
    midi: 'MIDI',
    xml: 'MusicXML',
    musicxml: 'MusicXML',
    mxl: 'MusicXML',
    gp: 'Guitar Pro',
    gp3: 'Guitar Pro',
    gp4: 'Guitar Pro',
    gp5: 'Guitar Pro',
    gpx: 'Guitar Pro',
    ptb: 'Power Tab',
    abc: 'ABC notation',
    csmpn: 'a chart',
    csml: 'a chart',
    cho: 'a chart',
    pro: 'a chart',
    crd: 'a chart',
    pdf: 'a PDF',
    txt: 'a text chart',
  };

  /**
   * What to tell the player when a file will not decode. The distinction that
   * matters: a score file is not a failure to explain, it is the wrong door —
   * those formats already have importers that build a chart. Anything else is a
   * genuine decode failure, so name the formats that do work.
   */
  function decodeFailureMessage(filename, purpose) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || ''));
    var kind = m ? SCORE_EXTS[m[1].toLowerCase()] : null;
    var what = purpose || 'This';
    if (kind) {
      return (
        what +
        ' needs a recording — an audio file with sound in it. ' +
        m[0] +
        ' is ' +
        kind +
        ', which describes notes rather than storing sound. ' +
        'Use Import to turn that into a chart instead.'
      );
    }
    return (
      what +
      ' could not read that file as audio. MP3, M4A, WAV and AAC all work, ' +
      'as does the audio track of an MP4 or MOV.'
    );
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
      var buf;
      try {
        buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
      } catch (e) {
        // Flagged so callers can tell "this file is not audio" apart from a
        // failure later in the pipeline and say something useful about it.
        var err = new Error('Could not decode that file as audio.');
        err.decodeFailed = true;
        err.cause = e;
        throw err;
      }
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
   * Align a reference recording to the current chart for a synced playhead.
   *
   * Builds the engine score from the chart, runs the engine's DTW aligner
   * (`alignPcmToScore` — already vendored + tested) to get audio-time → chord
   * segments, plus the linear `scoreEventTimes` map as a confidence fallback.
   * Both are returned with keys already translated to chord indices (`ci`), so
   * the rAF playhead just highlights `[data-ci]`. DTW is adopted only when its
   * confidence clears `minConfidence`; otherwise the caller stretches the linear
   * map across the recording (the honest "no reliable tempo" fallback).
   */
  async function alignReference(pcm, source, opts) {
    opts = opts || {};
    if (!window.RecognitionBridge) throw new Error('Recognition engine not available.');
    var chordToMidi = (window.AudioPlayback && window.AudioPlayback.chordToMidi) || null;
    var built = csmpnChartToScore(source, chordToMidi);
    if (!built || !built.chordCount) return null;
    var engine = await window.RecognitionBridge.loadEngine();
    var bpm = opts.bpm || 120;

    var linearRaw = engine.scoreEventTimes(built.score, bpm);
    var linear = (linearRaw.events || [])
      .map(function (e) {
        return {
          start: e.start,
          dur: e.dur,
          ci: built.keyToCi[e.key] != null ? built.keyToCi[e.key] : -1,
        };
      })
      .filter(function (e) {
        return e.ci >= 0;
      });

    var out = {
      chordCount: built.chordCount,
      chartDurationSec: linearRaw.duration || 0,
      linear: linear,
      dtw: null,
      confidence: 0,
      useDtw: false,
    };
    try {
      var al = engine.alignPcmToScore(pcm.mono, pcm.sampleRate, built.score, {
        hopSec: opts.hopSec || 0.25,
      });
      if (al && al.segments) {
        out.confidence = al.confidence || 0;
        out.dtw = segmentsToCi(al.segments, built.keyToCi);
        out.useDtw = out.confidence >= (opts.minConfidence != null ? opts.minConfidence : 0.35);
      }
    } catch (_e) {
      /* DTW failed → the linear map carries the sync */
    }
    return out;
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
    SCORE_EXTS: SCORE_EXTS,
    decodeFailureMessage: decodeFailureMessage,
    clarityDelta: clarityDelta,
    chartChordList: chartChordList,
    csmpnChartToScore: csmpnChartToScore,
    segmentsToCi: segmentsToCi,
    supported: supported,
    decodeToPcm: decodeToPcm,
    pcmToChart: pcmToChart,
    isolateAndGate: isolateAndGate,
    alignReference: alignReference,
    createTuner: createTuner,
  };
  if (typeof window !== 'undefined') window.AudioCapture = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

/**
 * audioPlayback.js — "hear your chart" (browser global + window.AudioPlayback).
 *
 * Turns the current chart into sound using the SAME parsed model the renderer uses
 * (parseHybridChartFromCSMPN), so audio matches the page: it plays the chord changes
 * in time, and where a {hybrid} rhythm block exists it plays the notated hits.
 *
 * Sound is a built-in Web Audio synth — 100% offline, zero downloads, no CSP/network
 * changes (works in iOS Safari / stage use).
 *
 * The pure functions (chordToMidi, buildSchedule) take no DOM/audio and are unit-tested;
 * the AudioPlayer runtime is the only browser-only part.
 */
(function () {
  // ── Chord → pitches ───────────────────────────────────────────────────────
  var LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function noteNameToPc(name) {
    if (!name) return null;
    var m = /^([A-Ga-g])([b#♭♯]?)/.exec(name.trim());
    if (!m) return null;
    var pc = LETTER_PC[m[1].toUpperCase()];
    if (pc === undefined) return null;
    var acc = m[2];
    if (acc === '#' || acc === '♯') pc += 1;
    else if (acc === 'b' || acc === '♭') pc -= 1;
    return ((pc % 12) + 12) % 12;
  }

  // Raw quality string → semitone intervals above the root (always includes a fifth).
  // Good-enough voicings for hearing the harmony, not a theory engine.
  function qualityIntervals(qRaw) {
    var q = String(qRaw || '')
      .replace(/[♭]/g, 'b')
      .replace(/[♯]/g, '#')
      .replace(/△|Δ|△/g, 'maj7')
      .replace(/°|º/g, 'dim')
      .replace(/ø|Ø/g, 'm7b5')
      .toLowerCase()
      .trim();

    // Half-diminished
    if (/^m7b5|^min7b5|^m7-5|^-7b5/.test(q)) return [0, 3, 6, 10];

    var third, fifth;
    var seventh = null;
    var extra = [];

    if (/^dim|^o(?!ne)/.test(q)) {
      third = 3;
      fifth = 6;
      if (/dim7|o7/.test(q)) seventh = 9; // diminished 7th
      else if (/7/.test(q)) seventh = 10;
    } else if (/^aug|^\+/.test(q)) {
      third = 4;
      fifth = 8;
      if (/7/.test(q)) seventh = 10;
    } else if (/^sus2/.test(q)) {
      third = 2;
      fifth = 7;
    } else if (/^sus/.test(q)) {
      third = 5; // sus4
      fifth = 7;
    } else if (/^(m|min|-)(?!a)/.test(q)) {
      third = 3; // minor (but not "maj")
      fifth = 7;
    } else {
      third = 4; // major triad default
      fifth = 7;
    }

    if (seventh === null) {
      if (/maj7|maj9|maj11|maj13|ma7|m7\b/.test(q) === false && /(^|[^a-z])maj/.test(q) && /7|9|11|13/.test(q))
        seventh = 11;
      else if (/maj7|ma7|maj9|maj13/.test(q)) seventh = 11;
      else if (/7|9|11|13/.test(q)) seventh = 10;
    }

    // 6th chords (C6, m6) — but not when it's really a 7/9/11/13
    if (/(^|[^0-9])6/.test(q) && !/7|9|11|13/.test(q)) extra.push(9);
    // A touch of color for extended chords
    if (/9|11|13/.test(q)) extra.push(14);

    var ivals = [0, third, fifth];
    if (seventh !== null) ivals.push(seventh);
    for (var i = 0; i < extra.length; i++) ivals.push(extra[i]);
    // unique + sorted
    var seen = {};
    var out = [];
    for (var j = 0; j < ivals.length; j++) {
      if (!seen[ivals[j]]) {
        seen[ivals[j]] = 1;
        out.push(ivals[j]);
      }
    }
    out.sort(function (a, b) {
      return a - b;
    });
    return out;
  }

  // Chord token → array of MIDI note numbers (a bass note + the voicing). Returns
  // [] for tokens with no playable root (e.g. "%", "N.C.", rests).
  function chordToMidi(token, rootMidiBase) {
    var raw = String(token || '')
      .replace(/[!~]+$/, '')
      .trim();
    if (!raw || raw === '%' || /^n\.?c\.?$/i.test(raw)) return [];
    var m = /^([A-G][b#♭♯]?)([^/]*?)(?:\/([A-G][b#♭♯]?))?$/.exec(raw);
    if (!m) return [];
    var rootPc = noteNameToPc(m[1]);
    if (rootPc === null) return [];
    var intervals = qualityIntervals(m[2]);
    var base = (rootMidiBase || 48) + rootPc; // root near C3..B3
    var notes = intervals.map(function (iv) {
      return base + iv;
    });
    // Bass: slash bass an octave below, else the root an octave below the voicing.
    var bassPc = m[3] ? noteNameToPc(m[3]) : rootPc;
    var bassMidi = 36 + (bassPc === null ? rootPc : bassPc);
    notes.unshift(bassMidi);
    return notes;
  }

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  // ── Timing ────────────────────────────────────────────────────────────────
  // Quarter-units per bar: simple = num*(4/den); compound (×/8) stays num*4/den
  // too (12/8 → 6, 6/8 → 3, 9/8 → 4.5), matching the renderer's bar capacity.
  function meterQuarterUnits(time) {
    var mm = /^(\d+)\/(\d+)$/.exec(time || '4/4');
    if (!mm) return 4;
    return (parseInt(mm[1], 10) * 4) / parseInt(mm[2], 10);
  }
  function meterNumerator(time) {
    var mm = /^(\d+)\/(\d+)$/.exec(time || '4/4');
    return mm ? parseInt(mm[1], 10) : 4;
  }

  function clampTempo(t) {
    t = parseInt(t, 10);
    if (!t || isNaN(t)) return 100;
    return Math.max(30, Math.min(300, t));
  }

  // Build a flat playback schedule from chart source. Uses the global
  // parseHybridChartFromCSMPN (same model as the renderer); a parse fn can be
  // injected via opts.parse for tests. Returns { tempo, duration, strikes }.
  function buildSchedule(source, opts) {
    opts = opts || {};
    var parse =
      opts.parse ||
      (typeof window !== 'undefined' && window.parseHybridChartFromCSMPN) ||
      (typeof parseHybridChartFromCSMPN !== 'undefined' ? parseHybridChartFromCSMPN : null);
    var hy = parse ? parse(source || '') : null;
    if (!hy || !Array.isArray(hy.sections)) return { tempo: 100, duration: 0, strikes: [] };

    var bpm = clampTempo(hy.tempo);
    var spq = 60 / bpm; // seconds per quarter-unit
    var time = hy.time || '4/4';
    var quPerBar = meterQuarterUnits(time);
    var quPerPos = quPerBar / meterNumerator(time);
    var barDur = quPerBar * spq;

    var strikes = [];
    var t = 0;
    var lastChords = [];

    function splitChords(token) {
      return String(token || '')
        .replace(/[!~x]+$/, '')
        .split('_')
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);
    }

    for (var si = 0; si < hy.sections.length; si++) {
      var bars = hy.sections[si].bars || [];
      for (var bi = 0; bi < bars.length; bi++) {
        var bar = bars[bi];
        var chords = splitChords(bar.chordToken);
        if ((!chords.length || (chords.length === 1 && chords[0] === '%')) && lastChords.length)
          chords = lastChords; // repeat-bar / blank → hold the previous chord
        if (chords.length && chords[0] !== '%') lastChords = chords;

        var events = (bar.events || []).filter(function (e) {
          return e && e.type !== 'rest';
        });

        if (events.length) {
          for (var ei = 0; ei < events.length; ei++) {
            var e = events[ei];
            var offsetQu = (e.beat - 1) * quPerPos;
            var frac = quPerBar ? offsetQu / quPerBar : 0;
            var chTok =
              e.chord ||
              chords[Math.min(chords.length - 1, Math.floor(frac * chords.length))] ||
              chords[0];
            var midi = chordToMidi(chTok);
            if (midi.length)
              strikes.push({
                t: t + offsetQu * spq,
                dur: Math.max(0.09, (e.beats || quPerPos) * spq),
                midi: midi,
                chord: chTok,
                accent: !!e.accent,
              });
          }
        } else if (chords.length) {
          var share = barDur / chords.length;
          for (var ci = 0; ci < chords.length; ci++) {
            var mid = chordToMidi(chords[ci]);
            if (mid.length)
              strikes.push({
                t: t + ci * share,
                dur: share,
                midi: mid,
                chord: chords[ci],
                accent: false,
              });
          }
        }
        t += barDur;
      }
    }
    return { tempo: bpm, duration: t, strikes: strikes };
  }

  // ── Web Audio runtime (browser only) ──────────────────────────────────────
  function createPlayer() {
    var ctx = null;
    var master = null;
    var nodes = [];
    var endTimer = null;

    function ensureCtx() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.22;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      return ctx;
    }

    function voice(midi, startT, durT, accent) {
      var f = midiToFreq(midi);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      // Soft second oscillator an octave up for body
      var g = ctx.createGain();
      var peak = (accent ? 0.42 : 0.3) / 1;
      var end = startT + durT;
      g.gain.setValueAtTime(0.0001, startT);
      g.gain.linearRampToValueAtTime(peak, startT + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0006, end);
      osc.connect(g);
      g.connect(master);
      osc.start(startT);
      osc.stop(end + 0.05);
      nodes.push(osc);
    }

    function play(schedule, onEnd) {
      if (!ensureCtx()) return false;
      stop();
      var t0 = ctx.currentTime + 0.08;
      var strumStep = 0.014; // slight stagger → strum feel
      schedule.strikes.forEach(function (s) {
        for (var i = 0; i < s.midi.length; i++) voice(s.midi[i], t0 + s.t + i * strumStep, s.dur, s.accent);
      });
      if (onEnd) endTimer = setTimeout(onEnd, (schedule.duration + 0.4) * 1000);
      return true;
    }

    function stop() {
      if (endTimer) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      nodes.forEach(function (n) {
        try {
          n.stop();
        } catch (_) {
          /* already stopped */
        }
      });
      nodes = [];
    }

    return { play: play, stop: stop, ensureCtx: ensureCtx };
  }

  var api = {
    noteNameToPc: noteNameToPc,
    qualityIntervals: qualityIntervals,
    chordToMidi: chordToMidi,
    midiToFreq: midiToFreq,
    meterQuarterUnits: meterQuarterUnits,
    buildSchedule: buildSchedule,
    createPlayer: createPlayer,
  };
  if (typeof window !== 'undefined') window.AudioPlayback = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

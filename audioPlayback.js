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
    /*
     * The shared table first. chordTheory.js already holds correct intervals
     * for the whole common palette — 6/9, add9, 7sus4, 7b9, 7#9 — and this
     * function's own structural parser got every one of them wrong (add9 and
     * 6/9 gained a ♭7 they do not have; the sus and the altered 9ths were
     * flattened to a plain dominant 9). Reading the table means a chord added
     * there improves playback for free, instead of drifting from it.
     *
     * The structural parser below still runs for anything the table lacks
     * (11ths, 13ths, odd spellings), so nothing that used to sound goes quiet.
     */
    var ct = typeof window !== 'undefined' && window.ChordTheory;
    if (ct && typeof ct.intervalsForSuffix === 'function') {
      var known = ct.intervalsForSuffix(qRaw);
      if (known) return known;
    }

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
      if (/dim7|o7/.test(q))
        seventh = 9; // diminished 7th
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
      if (
        /maj7|maj9|maj11|maj13|ma7|m7\b/.test(q) === false &&
        /(^|[^a-z])maj/.test(q) &&
        /7|9|11|13/.test(q)
      )
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
    /*
     * Splitting is shared with the notation path (chordTheory.splitChordToken)
     * because the hard case is the same in both: a `/` can mean a slash bass OR
     * be part of the quality, as in 6/9. Treating `/9` as a bass made the whole
     * token fail to parse, so every 6/9 chord played silence.
     */
    var ct = typeof window !== 'undefined' && window.ChordTheory;
    var parts = ct && typeof ct.splitChordToken === 'function' ? ct.splitChordToken(token) : null;
    if (!parts) {
      // Fallback for a page that somehow loaded without chordTheory.js: the
      // old shape, minus the 6/9 case it could never handle anyway.
      var raw = String(token || '')
        .replace(/[!~]+$/, '')
        .trim();
      if (!raw || raw === '%' || /^n\.?c\.?$/i.test(raw)) return [];
      var mm = /^([A-G][b#♭♯]?)([^/]*?)(?:\/([A-G][b#♭♯]?))?$/.exec(raw);
      if (!mm) return [];
      parts = { root: mm[1], suffix: mm[2], bass: mm[3] || null };
    }
    var rootPc = noteNameToPc(parts.root);
    if (rootPc === null) return [];
    var intervals = qualityIntervals(parts.suffix);
    var base = (rootMidiBase || 48) + rootPc; // root near C3..B3
    var notes = intervals.map(function (iv) {
      return base + iv;
    });
    // Bass: slash bass an octave below, else the root an octave below the voicing.
    var bassPc = parts.bass ? noteNameToPc(parts.bass) : rootPc;
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
  // Felt pulses per bar (Real-Book convention): compound meters collapse to
  // dotted-quarter beats (12/8→4, 9/8→3, 6/8→2), simple meters use the numerator.
  function pulseCount(time) {
    var mm = /^(\d+)\/(\d+)$/.exec(time || '4/4');
    if (!mm) return 4;
    var num = parseInt(mm[1], 10);
    var den = parseInt(mm[2], 10);
    if (den === 8 && num % 3 === 0 && num >= 6) return num / 3;
    return num;
  }
  function isCompound(time) {
    var mm = /^(\d+)\/(\d+)$/.exec(time || '');
    return (
      !!mm && parseInt(mm[2], 10) === 8 && parseInt(mm[1], 10) % 3 === 0 && parseInt(mm[1], 10) >= 6
    );
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

    // Default-groove feel: comp the chord on each beat pulse + a softer swung
    // off-beat, so a plain chart flows instead of holding one chord per bar.
    var pulses = pulseCount(time);
    var pulseQu = quPerBar / pulses;
    var compound = isCompound(time);
    var swing = compound || /swing|shuffle|blues|jazz|boogie/i.test(hy.style || '');
    var offFrac = swing ? 0.66 : 0.5; // where the off-beat lands within the beat

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
                vel: e.accent ? 1 : 0.82,
              });
          }
        } else if (chords.length) {
          // No notated rhythm → default groove: a strum on each beat pulse plus a
          // softer, swung off-beat, picking up the chord active at that point.
          var chordAtFrac = function (frac) {
            return chords[Math.min(chords.length - 1, Math.floor(frac * chords.length))];
          };
          for (var p = 0; p < pulses; p++) {
            var beatQu = p * pulseQu;
            var onCh = chordAtFrac(quPerBar ? beatQu / quPerBar : 0);
            var onMidi = chordToMidi(onCh);
            if (onMidi.length)
              strikes.push({
                t: t + beatQu * spq,
                dur: Math.max(0.12, pulseQu * offFrac * spq * 0.95),
                midi: onMidi,
                chord: onCh,
                vel: p === 0 ? 1 : 0.8, // downbeat accent
              });
            var offQu = beatQu + pulseQu * offFrac;
            var offCh = chordAtFrac(quPerBar ? offQu / quPerBar : 0);
            var offMidi = chordToMidi(offCh);
            if (offMidi.length)
              strikes.push({
                t: t + offQu * spq,
                dur: Math.max(0.1, pulseQu * (1 - offFrac) * spq * 0.95),
                midi: offMidi,
                chord: offCh,
                vel: 0.5, // softer off-beat → groove, not a metronome
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
    var playToken = 0; // bumped by stop()/new play() to cancel a pending start

    function ensureCtx() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.22;
        master.connect(ctx.destination);
        // iOS Safari unlock: starting a 1-sample silent buffer from inside the
        // user gesture is what actually lets the context produce output —
        // resume() on its own is unreliable on iOS.
        try {
          var b = ctx.createBuffer(1, 1, 22050);
          var s = ctx.createBufferSource();
          s.buffer = b;
          s.connect(ctx.destination);
          if (s.start) s.start(0);
          else if (s.noteOn) s.noteOn(0);
        } catch (_e) {
          /* unlock best-effort */
        }
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        try {
          ctx.resume();
        } catch (_e) {}
      }
      return ctx;
    }

    function voice(midi, startT, durT, vel) {
      var f = midiToFreq(midi);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      var g = ctx.createGain();
      var peak = 0.34 * (vel == null ? 0.8 : vel);
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
      var myToken = ++playToken;
      var started = false;

      function startAll() {
        if (started || myToken !== playToken) return; // superseded by stop()/replay
        started = true;
        // Compute t0 from the clock only once it is actually running — on iOS
        // ctx.currentTime stays 0 while suspended, which would mis-time/drop notes.
        var t0 = ctx.currentTime + 0.08;
        var strumStep = 0.014; // slight stagger → strum feel
        schedule.strikes.forEach(function (s) {
          var vel = s.vel == null ? (s.accent ? 1 : 0.8) : s.vel;
          for (var i = 0; i < s.midi.length; i++) {
            voice(s.midi[i], t0 + s.t + i * strumStep, s.dur, vel);
          }
        });
        if (onEnd) endTimer = setTimeout(onEnd, (schedule.duration + 0.4) * 1000);
      }

      if (ctx.state !== 'running' && ctx.resume) {
        ctx.resume().then(startAll, startAll);
        // Safety net if resume() never settles (some iOS builds): start anyway.
        setTimeout(startAll, 350);
      } else {
        startAll();
      }
      return true;
    }

    function stop() {
      playToken++; // invalidate any pending startAll
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

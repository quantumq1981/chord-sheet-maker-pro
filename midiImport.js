/**
 * midiImport.js — Standard MIDI File → CSMPN chord chart (browser global +
 * window.MidiImport).
 *
 * abcjs (and our other importers) can't read MIDI, so this is a small, zero-dep
 * SMF parser + a tolerant chord-per-bar recogniser. The pure functions
 * (readVLQ, parseMidi, recognizeChord, notesToBars, midiToCsmpn) take no DOM and
 * are unit-tested; index.html just wires a .mid/.midi file into midiToCsmpn.
 *
 * Honest limits: MIDI is raw polyphony with no chord symbols, so chord-per-bar is
 * an approximation — strong (duration-weighted) pitch classes per bar are matched
 * to the nearest chord template (extras/missing tolerated), bass = lowest sounding
 * note. Passing tones and dense arrangements won't always match a lead sheet; it's
 * a starting chart to clean up, same spirit as the GP/PDF importers.
 */
(function () {
  'use strict';

  // Canonical note spelling + chord templates from the shared chordTheory.js
  // (window.ChordTheory) — single source of truth, loaded before this module.
  var NOTE_NAMES = window.ChordTheory.NOTE_NAMES;
  var CHORD_PATTERNS = window.ChordTheory.CHORD_PATTERNS;

  function mod12(n) {
    return ((n % 12) + 12) % 12;
  }

  // ── Byte helpers ───────────────────────────────────────────────────────────

  /** Read a MIDI variable-length quantity at cursor {p}. Returns the value. */
  function readVLQ(bytes, cur) {
    var value = 0;
    var b;
    do {
      b = bytes[cur.p++];
      value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return value;
  }

  function readU32(bytes, cur) {
    var v =
      (bytes[cur.p] << 24) |
      (bytes[cur.p + 1] << 16) |
      (bytes[cur.p + 2] << 8) |
      bytes[cur.p + 3];
    cur.p += 4;
    return v >>> 0;
  }

  function readU16(bytes, cur) {
    var v = (bytes[cur.p] << 8) | bytes[cur.p + 1];
    cur.p += 2;
    return v;
  }

  // ── SMF parser ─────────────────────────────────────────────────────────────

  /**
   * Parse a Standard MIDI File (Uint8Array / ArrayBuffer) into a normalized
   * structure: { ppq, format, tempoBpm, timeSig:{num,den}, keySig, notes:[] }.
   * notes: { midi, channel, start, dur } in absolute ticks. Percussion (channel
   * 10 / index 9) is dropped. Throws on a bad header.
   */
  function parseMidi(input) {
    var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    var cur = { p: 0 };
    if (
      bytes[0] !== 0x4d ||
      bytes[1] !== 0x54 ||
      bytes[2] !== 0x68 ||
      bytes[3] !== 0x64
    ) {
      throw new Error('Not a MIDI file (missing MThd header)');
    }
    cur.p = 4;
    var headerLen = readU32(bytes, cur);
    var format = readU16(bytes, cur);
    var ntracks = readU16(bytes, cur);
    var division = readU16(bytes, cur);
    cur.p = 8 + headerLen; // skip any extra header bytes
    var ppq = division & 0x8000 ? 480 : division; // SMPTE division → fallback ppq

    var notes = [];
    var tempoBpm = null;
    var timeSig = null;
    var keySig = null;

    for (var t = 0; t < ntracks; t++) {
      // find MTrk
      while (
        cur.p < bytes.length - 4 &&
        !(
          bytes[cur.p] === 0x4d &&
          bytes[cur.p + 1] === 0x54 &&
          bytes[cur.p + 2] === 0x72 &&
          bytes[cur.p + 3] === 0x6b
        )
      ) {
        cur.p++;
      }
      if (cur.p >= bytes.length - 4) break;
      cur.p += 4;
      var trackLen = readU32(bytes, cur);
      var trackEnd = cur.p + trackLen;
      var absTick = 0;
      var running = 0;
      var pending = {}; // "ch:note" → { midi, channel, start }

      while (cur.p < trackEnd) {
        absTick += readVLQ(bytes, cur);
        var status = bytes[cur.p];
        if (status & 0x80) {
          cur.p++;
          running = status;
        } else {
          status = running; // running status — data byte, reuse last status
        }
        var type = status & 0xf0;
        var channel = status & 0x0f;

        if (status === 0xff) {
          // meta
          var metaType = bytes[cur.p++];
          var len = readVLQ(bytes, cur);
          var dataStart = cur.p;
          if (metaType === 0x51 && len === 3) {
            var usq =
              (bytes[dataStart] << 16) |
              (bytes[dataStart + 1] << 8) |
              bytes[dataStart + 2];
            if (tempoBpm == null && usq > 0) tempoBpm = Math.round(60000000 / usq);
          } else if (metaType === 0x58 && len >= 2) {
            if (timeSig == null) {
              timeSig = { num: bytes[dataStart], den: Math.pow(2, bytes[dataStart + 1]) };
            }
          } else if (metaType === 0x59 && len >= 1) {
            if (keySig == null) keySig = { sf: (bytes[dataStart] << 24) >> 24, mi: bytes[dataStart + 1] };
          }
          cur.p = dataStart + len;
        } else if (status === 0xf0 || status === 0xf7) {
          // sysex — skip
          var sysLen = readVLQ(bytes, cur);
          cur.p += sysLen;
        } else if (type === 0x90) {
          var note = bytes[cur.p++];
          var vel = bytes[cur.p++];
          var key = channel + ':' + note;
          if (vel > 0) {
            pending[key] = { midi: note, channel: channel, start: absTick };
          } else if (pending[key]) {
            finishNote(pending, key, absTick, channel, notes);
          }
        } else if (type === 0x80) {
          var note2 = bytes[cur.p++];
          cur.p++; // release velocity
          finishNote(pending, channel + ':' + note2, absTick, channel, notes);
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          cur.p += 2; // 2-byte channel messages we ignore
        } else if (type === 0xc0 || type === 0xd0) {
          cur.p += 1; // 1-byte channel messages
        } else {
          cur.p++; // unknown — step to avoid an infinite loop
        }
      }
      cur.p = trackEnd;
    }

    return {
      ppq: ppq || 480,
      format: format,
      tempoBpm: tempoBpm,
      timeSig: timeSig,
      keySig: keySig,
      notes: notes,
    };
  }

  function finishNote(pending, key, endTick, channel, notes) {
    var n = pending[key];
    if (!n) return;
    delete pending[key];
    if (channel === 9) return; // drop percussion
    var dur = endTick - n.start;
    if (dur <= 0) return;
    notes.push({ midi: n.midi, channel: n.channel, start: n.start, dur: dur });
  }

  // ── Chord recognition ────────────────────────────────────────────────────────

  /**
   * Recognise a chord name from the pitch classes present in a bar plus the bass
   * pitch class. Tolerant scoring (TTP-style: inter − 0.8·extra − 1.2·missing);
   * picks the best-fitting template, prefers the common interpretation on ties.
   * One pc → the bare note name; nothing usable → null.
   */
  function recognizeChord(presentPcs, bassPc) {
    var present = {};
    var list = [];
    for (var i = 0; i < presentPcs.length; i++) {
      var pc = mod12(presentPcs[i]);
      if (!present[pc]) {
        present[pc] = true;
        list.push(pc);
      }
    }
    if (list.length === 0) return null;
    if (list.length === 1) return NOTE_NAMES[list[0]];

    var best = null;
    for (var root = 0; root < 12; root++) {
      for (var idx = 0; idx < CHORD_PATTERNS.length; idx++) {
        var pat = CHORD_PATTERNS[idx];
        var inter = 0;
        var missing = 0;
        for (var k = 0; k < pat.intervals.length; k++) {
          if (present[mod12(root + pat.intervals[k])]) inter++;
          else missing++;
        }
        var extra = list.length - inter;
        var score = inter - 0.8 * extra - 1.2 * missing;
        var size = pat.intervals.length;
        if (
          !best ||
          score > best.score + 1e-9 ||
          (Math.abs(score - best.score) < 1e-9 &&
            (size < best.size || (size === best.size && idx < best.idx)))
        ) {
          best = { score: score, root: root, suffix: pat.suffix, size: size, idx: idx };
        }
      }
    }
    if (!best || best.score < 0.5) return null;
    var name = NOTE_NAMES[best.root] + best.suffix;
    var b = mod12(bassPc);
    if (b !== best.root && present[b]) name += '/' + NOTE_NAMES[b];
    return name;
  }

  // ── Bars ──────────────────────────────────────────────────────────────────

  /**
   * Slice notes into bars and reduce each to its strong (duration-weighted) pitch
   * classes + bass. Returns [{ pcs:[], bassPc, hasNotes }]. `opts.maxBars` caps
   * runaway files (default 256).
   */
  function notesToBars(notes, ppq, timeSig, opts) {
    opts = opts || {};
    var ts = timeSig || { num: 4, den: 4 };
    var barTicks = Math.max(1, Math.round(ts.num * ((ppq * 4) / ts.den)));
    var maxTick = 0;
    for (var i = 0; i < notes.length; i++) {
      var e = notes[i].start + notes[i].dur;
      if (e > maxTick) maxTick = e;
    }
    var nBars = Math.min(opts.maxBars || 256, Math.max(1, Math.ceil(maxTick / barTicks)));
    var bars = [];
    for (var b = 0; b < nBars; b++) {
      var lo = b * barTicks;
      var hi = lo + barTicks;
      var weight = {}; // pc → total overlap ticks
      var total = 0;
      var lowestByWeight = null;
      var per = []; // {midi, w}
      for (var n = 0; n < notes.length; n++) {
        var nt = notes[n];
        var ov = Math.min(hi, nt.start + nt.dur) - Math.max(lo, nt.start);
        if (ov <= 0) continue;
        var pc = mod12(nt.midi);
        weight[pc] = (weight[pc] || 0) + ov;
        total += ov;
        per.push({ midi: nt.midi, w: ov });
      }
      if (total === 0) {
        bars.push({ pcs: [], bassPc: null, hasNotes: false });
        continue;
      }
      var thresh = total * 0.1; // drop brief passing tones
      var pcs = [];
      for (var p2 = 0; p2 < 12; p2++) {
        if (weight[p2] && weight[p2] >= thresh) pcs.push(p2);
      }
      if (pcs.length === 0) {
        // keep the single strongest pc so a thin bar still names something
        var bestPc = 0;
        var bestW = -1;
        Object.keys(weight).forEach(function (kk) {
          if (weight[kk] > bestW) {
            bestW = weight[kk];
            bestPc = Number(kk);
          }
        });
        pcs = [bestPc];
      }
      // bass = lowest-pitch structural note (its pc must be in the kept set)
      per.sort(function (a, c) {
        return a.midi - c.midi;
      });
      for (var q = 0; q < per.length; q++) {
        if (pcs.indexOf(mod12(per[q].midi)) >= 0) {
          lowestByWeight = mod12(per[q].midi);
          break;
        }
      }
      bars.push({ pcs: pcs, bassPc: lowestByWeight == null ? pcs[0] : lowestByWeight, hasNotes: true });
    }
    return bars;
  }

  // ── CSMPN emit ───────────────────────────────────────────────────────────────

  var SF_TO_KEY = {
    '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb',
    '-1': 'F', '0': 'C', '1': 'G', '2': 'D', '3': 'A', '4': 'E', '5': 'B',
    '6': 'F#', '7': 'C#',
  };

  function keyName(keySig) {
    if (!keySig) return '';
    var base = SF_TO_KEY[String(keySig.sf)];
    if (!base) return '';
    return keySig.mi ? base + 'm' : base;
  }

  /**
   * Full pipeline: MIDI bytes → CSMPN text. Header (Time/Tempo/Key) + one chord
   * per bar (consecutive identical bars collapse to `%`, empty bars → N.C.),
   * `opts.barsPerRow` bars per line (default 4), `opts.title` for the Title.
   */
  function midiToCsmpn(input, opts) {
    opts = opts || {};
    var parsed = input && input.notes ? input : parseMidi(input);
    var ts = parsed.timeSig || { num: 4, den: 4 };
    var bars = notesToBars(parsed.notes, parsed.ppq, ts, opts);

    var header = [];
    header.push('Title: ' + (opts.title || 'Imported MIDI'));
    var k = keyName(parsed.keySig);
    if (k) header.push('Key: ' + k);
    header.push('Time: ' + ts.num + '/' + ts.den);
    if (parsed.tempoBpm) header.push('Tempo: ' + parsed.tempoBpm);

    var tokens = [];
    var prev = null;
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i];
      var tok;
      if (!bar.hasNotes) {
        tok = 'N.C.';
        prev = null;
      } else {
        var name = recognizeChord(bar.pcs, bar.bassPc);
        tok = name || 'N.C.';
        if (name && name === prev) {
          tok = '%';
        } else {
          prev = name;
        }
      }
      tokens.push(tok);
    }
    if (!tokens.length) tokens.push('N.C.');

    var bpr = Math.max(1, opts.barsPerRow || 4);
    var lines = [];
    for (var j = 0; j < tokens.length; j += bpr) {
      lines.push(tokens.slice(j, j + bpr).join(' '));
    }
    return header.join('\n') + '\n\n- Chart\n' + lines.join('\n') + '\n';
  }

  var api = {
    NOTE_NAMES: NOTE_NAMES,
    CHORD_PATTERNS: CHORD_PATTERNS,
    readVLQ: readVLQ,
    parseMidi: parseMidi,
    recognizeChord: recognizeChord,
    notesToBars: notesToBars,
    keyName: keyName,
    midiToCsmpn: midiToCsmpn,
  };
  if (typeof window !== 'undefined') window.MidiImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

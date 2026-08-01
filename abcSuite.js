/**
 * abcSuite.js — ABC notation render + playback (browser global + window.ABCSuite).
 *
 * Phase A (render) + Phase B (playback) of the ABC notation integration. See
 * docs/ABC-NOTATION-INTEGRATION-EVALUATION.md. Built on abcjs (already loaded in
 * index.html as abcjs@6.2.2, CSP-allowed), the same engine the reference ABC
 * Transcription Tools app uses — so render + synth are essentially free to switch on.
 *
 * The pure functions (ensureAbcHeaders, extractAbcTitle, abcTempoBpm, sniffIsAbc,
 * defaultAbcExample) take no DOM/abcjs and are unit-tested. The render + synth
 * runtime is the only browser-only part.
 *
 * Phase C (csmpnToAbc round-trip + Load into Chart / From Source) is intentionally
 * NOT in this module yet — it lands after A+B per the agreed roadmap.
 */
(function () {
  'use strict';

  // abcjs's default soundfont host (paulrosen.github.io) is NOT in our CSP
  // connect-src. jsdelivr serves the same gh-pages content and IS allow-listed,
  // so playback works with zero CSP changes.
  var SOUNDFONT_BASE = 'https://cdn.jsdelivr.net/gh/paulrosen/midi-js-soundfonts@gh-pages/';
  var SOUNDFONT_URL = SOUNDFONT_BASE + 'abcjs/'; // default (compact abcjs set)

  // Selectable soundfonts (all jsdelivr-hosted → CSP-clean). Larger = fuller sound.
  var SOUNDFONTS = [
    { name: 'Default (compact)', url: SOUNDFONT_BASE + 'abcjs/' },
    { name: 'FluidR3 (fuller)', url: SOUNDFONT_BASE + 'FluidR3_GM/' },
    { name: 'MusyngKite (richest)', url: SOUNDFONT_BASE + 'MusyngKite/' },
  ];

  var HEADER_RE = /^[A-Za-z]:/; // an ABC information field line (X:, T:, K:, …)

  // General-MIDI melody instruments offered in the playback picker (program #).
  var MELODY_INSTRUMENTS = [
    { name: 'Piano', program: 0 },
    { name: 'Acoustic Guitar', program: 24 },
    { name: 'Nylon Guitar', program: 25 },
    { name: 'Electric Piano', program: 4 },
    { name: 'Vibraphone', program: 11 },
    { name: 'Accordion', program: 21 },
    { name: 'Violin', program: 40 },
    { name: 'Flute', program: 73 },
  ];

  /** Clamp a transpose amount to a sane ±2-octave range. */
  function clampSemitones(n) {
    n = Math.round(Number(n) || 0);
    return Math.max(-24, Math.min(24, n));
  }

  /** Clamp a tempo percentage to a sane 10–400% range. */
  function clampPercent(n) {
    n = Math.round(Number(n) || 0);
    if (!n) n = 100;
    return Math.max(10, Math.min(400, n));
  }

  /**
   * Tune Trainer schedule (pure, unit-tested): expand {startPercent, endPercent,
   * incrementPercent, loopsPerStep} into the flat list of tempo percentages to
   * play, each step repeated loopsPerStep times. Walks start→end by increment
   * (capped at end); increment 0 just loops at the start tempo. Total entries are
   * capped at 200 so a tiny increment can't produce a runaway schedule.
   */
  function buildTrainerSteps(opts) {
    opts = opts || {};
    var start = clampPercent(opts.startPercent != null ? opts.startPercent : 60);
    var end = clampPercent(opts.endPercent != null ? opts.endPercent : 100);
    if (end < start) end = start;
    var inc = Math.max(0, Math.round(Number(opts.incrementPercent) || 0));
    var loops = Math.max(1, Math.round(Number(opts.loopsPerStep) || 1));
    var tempos = [];
    if (inc === 0) {
      tempos.push(start);
    } else {
      for (var p = start; p < end; p += inc) tempos.push(p);
      tempos.push(end); // always finish exactly on the end tempo
    }
    var out = [];
    for (var t = 0; t < tempos.length && out.length < 200; t++) {
      for (var l = 0; l < loops && out.length < 200; l++) out.push(tempos[t]);
    }
    return out;
  }

  // ── Pure helpers (unit-tested; no DOM, no abcjs) ───────────────────────────

  /** First T: title in the tune, trimmed; falls back to 'Untitled'. */
  function extractAbcTitle(abc) {
    var lines = String(abc || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*T:\s*(.+?)\s*$/.exec(lines[i]);
      if (m && m[1]) return m[1];
    }
    return 'Untitled';
  }

  /**
   * Beats-per-minute from a Q: tempo field, or null if absent/unparseable.
   * Handles "Q:1/4=120", "Q:120", and "Q:1/4 = 120".
   */
  function abcTempoBpm(abc) {
    var lines = String(abc || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = /^\s*Q:\s*(.+?)\s*$/.exec(lines[i]);
      if (!m) continue;
      var v = m[1];
      var eq = /=\s*(\d+(?:\.\d+)?)/.exec(v); // "1/4=120" → 120
      if (eq) return Math.round(parseFloat(eq[1]));
      var bare = /^(\d+(?:\.\d+)?)\s*$/.exec(v); // "120"
      if (bare) return Math.round(parseFloat(bare[1]));
      return null;
    }
    return null;
  }

  /** Heuristic: does this text look like ABC (has an X: index AND a K: key)? */
  function sniffIsAbc(text) {
    var t = String(text || '');
    return /(^|\n)\s*X\s*:/i.test(t) && /(^|\n)\s*K\s*:/i.test(t);
  }

  /** A minimal, complete starter tune for the editor. */
  function defaultAbcExample() {
    return [
      'X:1',
      'T:My Tune',
      'C:Composer',
      'M:4/4',
      'L:1/8',
      'Q:1/4=120',
      'K:C',
      '"C"CEGc "G"BdgB | "Am"ceac "F"AcfA | "C"GEGc "G"d4 | "C"c8 |]',
    ].join('\n');
  }

  /**
   * Guarantee a renderable header (X:, M:, L:, K:) so abcjs never chokes on a
   * bare body or a partial paste.
   *
   * - Well-formed input (has both X: and K:) is returned unchanged.
   * - Otherwise we collect whatever information fields are present, fill the
   *   missing defaults, and reassemble: X:, T:, C:, M:, L:, Q:, R: … then K:
   *   (which MUST be the last header line before the body in ABC), then the body
   *   (every non-field line, in order).
   */
  function ensureAbcHeaders(abc) {
    var src = String(abc == null ? '' : abc);
    if (/(^|\n)\s*X:/.test(src) && /(^|\n)\s*K:/.test(src)) return src;

    var lines = src.split(/\r?\n/);
    var fields = {}; // letter → value (first wins)
    var order = [];
    var body = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var hm = /^([A-Za-z]):\s?(.*)$/.exec(line);
      if (hm && HEADER_RE.test(line)) {
        var key = hm[1];
        if (!(key in fields)) {
          fields[key] = hm[2];
          order.push(key);
        }
      } else if (line.trim() !== '') {
        body.push(line);
      }
    }

    if (!('X' in fields)) fields.X = '1';
    if (!('M' in fields)) fields.M = '4/4';
    if (!('L' in fields)) fields.L = '1/8';
    if (!('K' in fields)) fields.K = 'C';

    // Canonical header ordering; K: always last. Unknown fields keep first-seen order.
    var pref = ['X', 'T', 'C', 'O', 'R', 'M', 'L', 'Q'];
    var emitted = {};
    var out = [];
    for (var p = 0; p < pref.length; p++) {
      if (pref[p] in fields) {
        out.push(pref[p] + ':' + fields[pref[p]]);
        emitted[pref[p]] = true;
      }
    }
    for (var o = 0; o < order.length; o++) {
      var k = order[o];
      if (k === 'K' || emitted[k]) continue;
      out.push(k + ':' + fields[k]);
      emitted[k] = true;
    }
    out.push('K:' + fields.K);
    return out.concat(body).join('\n');
  }

  // ── Phase C: CSMPN → ABC round-trip (pure; unit-tested) ────────────────────

  /** ASCII-ify a chord token for an ABC "…" annotation (♯→#, ♭→b). */
  function normalizeChordForAbc(tok) {
    return String(tok || '')
      .replace(/♯/g, '#')
      .replace(/♭/g, 'b')
      .replace(/[△Δ]/g, 'maj7')
      .replace(/°/g, 'dim')
      .replace(/ø/g, 'm7b5')
      .replace(/"/g, '')
      .trim();
  }

  /** Eighth-note units in one bar of the given time signature (L:1/8 base). */
  function abcBarUnits(timeSig) {
    var m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(timeSig || '4/4').trim());
    if (!m) return 8;
    var num = parseInt(m[1], 10);
    var den = parseInt(m[2], 10);
    if (!num || !den) return 8;
    return Math.max(1, Math.round((num * 8) / den));
  }

  /** Split `units` as evenly as possible into `n` integer durations (front-loaded). */
  function splitUnits(units, n) {
    if (n <= 1) return [units];
    var base = Math.floor(units / n);
    var rem = units - base * n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(Math.max(1, base + (i < rem ? 1 : 0)));
    return out;
  }

  // ── Chord voicing: token → ABC chord [notes] (staff notation + guitar tab) ──

  var LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  function noteNameToPc(letter, acc) {
    var base = LETTER_PC[String(letter || '').toUpperCase()];
    if (base == null) return null;
    if (acc === '#') base += 1;
    else if (acc === 'b') base -= 1;
    return ((base % 12) + 12) % 12;
  }

  // Resolve a chord-quality suffix to interval list using the shared chord DB.
  function lookupIntervals(suffix, patterns) {
    var s = String(suffix || '')
      .replace(/[△Δ]/g, 'maj7')
      .replace(/[°º]/g, 'dim')
      .replace(/ø/g, 'm7b5')
      .trim();
    var map = {};
    for (var i = 0; i < patterns.length; i++) map[patterns[i].suffix] = patterns[i].intervals;
    if (s in map) return map[s];
    var alias = {
      M7: 'maj7',
      maj: '',
      major: '',
      min: 'm',
      minor: 'm',
      '-': 'm',
      'm7-5': 'm7b5',
      o7: 'dim7',
      o: 'dim',
      '+': 'aug',
      '+7': 'aug7',
      sus: 'sus4',
      '7sus': '7sus4',
      '6/9': '6add9',
    };
    if (alias[s] != null && alias[s] in map) return map[alias[s]];
    // Fallback so any chord still voices: minor vs major triad.
    return /^m(?!aj)/i.test(s) ? map['m'] : map[''];
  }

  /**
   * Voice a chord token into sorted MIDI pitches using the shared chord DB
   * (chordTheory.js CHORD_PATTERNS). Root stacked from C3; slash bass an octave
   * below. Pure (patterns injected). Returns null for N.C./%/unparseable.
   */
  function chordTokenToMidis(token, patterns) {
    if (!patterns || !patterns.length) return null;
    var t = String(token == null ? '' : token)
      .replace(/♭/g, 'b')
      .replace(/♯/g, '#')
      .trim();
    if (!t || /^(N\.?C\.?|%+)$/i.test(t)) return null;
    var upper = t;
    var bassName = null;
    var slash = t.lastIndexOf('/');
    if (slash > 0) {
      upper = t.slice(0, slash);
      bassName = t.slice(slash + 1).trim();
    }
    var m = /^([A-Ga-g])([#b]?)(.*)$/.exec(upper.trim());
    if (!m) return null;
    var rootPc = noteNameToPc(m[1], m[2]);
    if (rootPc == null) return null;
    var intervals = lookupIntervals(m[3] || '', patterns);
    if (!intervals) return null;
    var rootMidi = 48 + rootPc; // C3..B3
    var midis = [];
    for (var k = 0; k < intervals.length; k++) midis.push(rootMidi + intervals[k]);
    if (bassName) {
      var bm = /^([A-Ga-g])([#b]?)/.exec(bassName);
      if (bm) {
        var bpc = noteNameToPc(bm[1], bm[2]);
        if (bpc != null) {
          var bassMidi = 36 + bpc; // octave below the root region…
          if (bassMidi < 40) bassMidi += 12; // …but keep it on/above the guitar low E (40)
          midis.push(bassMidi);
        }
      }
    }
    var seen = {};
    var out = [];
    midis
      .sort(function (a, b) {
        return a - b;
      })
      .forEach(function (x) {
        if (!seen[x]) {
          seen[x] = 1;
          out.push(x);
        }
      });
    return out.length ? out : null;
  }

  /** MIDI → ABC pitch token with an EXPLICIT accidental (^/_/=) so the rendered
   *  pitch is exact in any key. Uses the family note spelling from chordTheory. */
  function midiToAbcPitch(midi, names) {
    var nm = names[((midi % 12) + 12) % 12];
    var letter = nm[0];
    var acc = nm.length > 1 ? (nm[1] === '#' ? '^' : '_') : '=';
    var octave = Math.floor(midi / 12) - 1; // MIDI 60 → octave 4 → "C"
    var tok;
    if (octave >= 5) {
      tok = acc + letter.toLowerCase();
      for (var i = 5; i < octave; i++) tok += "'";
    } else {
      tok = acc + letter;
      for (var j = octave; j < 4; j++) tok += ',';
    }
    return tok;
  }

  /**
   * Chord token → an ABC chord `[notes]` (no duration), or null. `patterns` and
   * `names` default to the shared chordTheory.js globals. abcjs renders the
   * bracket as stacked noteheads on the staff AND as guitar tab (with the
   * tablature render option). This is what turns a chord chart into real notation.
   */
  function chordToAbcChord(token, patterns, names) {
    patterns =
      patterns ||
      (typeof window !== 'undefined' && window.ChordTheory && window.ChordTheory.CHORD_PATTERNS);
    names =
      names ||
      (typeof window !== 'undefined' && window.ChordTheory && window.ChordTheory.NOTE_NAMES);
    if (!patterns || !names) return null;
    var midis = chordTokenToMidis(token, patterns);
    if (!midis) return null;
    var out = '';
    for (var i = 0; i < midis.length; i++) out += midiToAbcPitch(midis[i], names);
    return '[' + out + ']';
  }

  /**
   * Convert a CSMPN chart to ABC, reusing the SAME section/bar model the renderer
   * and audio use (parseHybridChartFromCSMPN), so the ABC matches the page: header
   * from the chart meta; each bar becomes a measure of chord-annotated rests
   * ("C" z8) — which abcjs renders as a chord chart AND plays as accompaniment.
   * Repeat barlines, voltas, and section labels are carried through.
   *
   * `opts.parse` lets tests inject the parser; in the browser it falls back to the
   * global `parseHybridChartFromCSMPN`. `opts.barsPerLine` defaults to 4.
   */
  function csmpnToAbc(csmpn, opts) {
    opts = opts || {};
    var parse =
      opts.parse ||
      (typeof parseHybridChartFromCSMPN !== 'undefined'
        ? parseHybridChartFromCSMPN
        : typeof window !== 'undefined' && window.parseHybridChartFromCSMPN);
    if (typeof parse !== 'function') throw new Error('CSMPN parser unavailable');

    var doc = parse(String(csmpn || '')) || {};
    var time = doc.time || '4/4';
    var units = abcBarUnits(time);
    var barsPerLine = opts.barsPerLine || 4;
    // Voiced mode: emit each chord's actual pitches as an ABC chord [..] so abcjs
    // renders staff noteheads (+ guitar tab with the tablature option), not rests.
    var voiced = !!opts.voiced;
    var patterns =
      opts.patterns ||
      (typeof window !== 'undefined' && window.ChordTheory && window.ChordTheory.CHORD_PATTERNS) ||
      null;
    var names =
      (typeof window !== 'undefined' && window.ChordTheory && window.ChordTheory.NOTE_NAMES) ||
      null;
    // Per-chord body: voiced chord bracket when possible, else a whole-bar rest.
    function chordBody(rawTok, dur) {
      if (voiced && patterns && names) {
        var br = chordToAbcChord(rawTok, patterns, names);
        if (br) return br + dur;
      }
      return 'z' + dur;
    }

    var header = ['X:1'];
    if (doc.title) header.push('T:' + doc.title);
    if (doc.composer) header.push('C:' + doc.composer);
    header.push('M:' + time);
    header.push('L:1/8');
    if (doc.tempo) header.push('Q:1/4=' + parseInt(doc.tempo, 10));
    header.push('K:' + (normalizeChordForAbc(doc.key) || 'C'));

    // Flatten every bar across sections into a uniform model first, then engrave.
    var flat = [];
    var sections = doc.sections || [];
    var prevChord = null;
    var prevRaw = null;
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      var sbars = sec.bars || [];
      var label = sec.label ? normalizeChordForAbc(String(sec.label).trim()) : '';
      for (var b = 0; b < sbars.length; b++) {
        var bar = sbars[b];
        var measure = b === 0 && label ? '"^' + label + '" ' : '';
        var rawTok = bar.chordToken == null ? '' : String(bar.chordToken).trim();
        var chords = rawTok ? rawTok.split('_') : [];
        if (!rawTok || rawTok === '%' || rawTok === '%%') {
          // sustain: repeat the previous chord (symbol + voiced notes)
          measure += (prevChord ? '"' + prevChord + '"' : '') + chordBody(prevRaw, units);
        } else if (/^N\.?C\.?$/i.test(rawTok)) {
          measure += 'z' + units;
          prevChord = null;
          prevRaw = null;
        } else {
          var durs = splitUnits(units, chords.length);
          var parts = [];
          for (var c = 0; c < chords.length; c++) {
            var name = normalizeChordForAbc(chords[c]);
            if (name) {
              prevChord = name;
              prevRaw = chords[c];
            }
            parts.push((name ? '"' + name + '"' : '') + chordBody(chords[c], durs[c]));
          }
          measure += parts.join(' ');
        }
        flat.push({
          measure: measure,
          leftRepeat: bar.leftBar === 'repeat-start',
          rightRepeat: bar.rightBar === 'repeat-end',
          ending: bar.endingLabel ? String(bar.endingLabel).replace(/[^0-9]/g, '') : '',
        });
      }
    }

    if (!flat.length) return header.concat(['| z' + units + ' |]']).join('\n');

    // Engrave with leading-barline reconciliation: a bar's left barline is the
    // previous bar's close, upgraded to |: when this bar starts a repeat.
    var n = flat.length;
    var lines = [];
    var cur = flat[0].leftRepeat ? '|:' : '|';
    for (var i = 0; i < n; i++) {
      var fb = flat[i];
      if (fb.ending) cur += '[' + fb.ending;
      cur += ' ' + fb.measure + ' ';
      var close;
      if (fb.rightRepeat) close = ':|';
      else if (i === n - 1) close = '|]';
      else if (flat[i + 1].leftRepeat) close = '|:';
      else close = '|';
      cur += close;
      var atWrap = (i + 1) % barsPerLine === 0;
      if (i === n - 1 || atWrap) {
        lines.push(cur.replace(/\s+/g, ' ').trim());
        cur =
          i === n - 1
            ? ''
            : close === ':|' || close === '|]'
              ? i + 1 < n && flat[i + 1].leftRepeat
                ? '|:'
                : '|'
              : '';
      }
    }

    return header.concat(lines.filter(Boolean)).join('\n');
  }

  // ── Print pagination ───────────────────────────────────────────────────────
  //
  // abcjs renders a tune as ONE continuous SVG, however tall. Handing that to a
  // print dialog lets the browser slice it wherever a sheet happens to end —
  // through the middle of a staff — so measures get cut in half and every page
  // after the first starts mid-system. abcjs has no pagination of its own.
  //
  // The fix is to window onto the tall SVG: one page-sized `<svg viewBox>` per
  // sheet, each cut at a staff boundary. These two functions are that geometry,
  // kept pure so the packing is testable without a browser; the measuring of
  // where the staves actually sit is the browser's job.

  /** Printable aspect (height ÷ width) of a paper size with equal margins. */
  function pageAspect(paper, marginIn) {
    var m = marginIn == null ? 0.5 : Math.max(0, Number(marginIn) || 0);
    var dims = String(paper || 'letter').toLowerCase() === 'a4' ? [8.27, 11.69] : [8.5, 11];
    var w = dims[0] - 2 * m;
    var h = dims[1] - 2 * m;
    if (w <= 0 || h <= 0) return 11 / 8.5;
    return h / w;
  }

  /**
   * One printed page's height, in the SVG's own user units. The content is
   * scaled to the page width, so a page covers `width × aspect` of it.
   */
  function pageBandHeight(contentWidth, aspect) {
    var w = Number(contentWidth) || 0;
    var a = Number(aspect) || 11 / 8.5;
    return w > 0 ? w * a : 0;
  }

  /**
   * Pack staff bands into pages, never splitting one across a sheet.
   *
   * `bands` are the measured `{top, bottom}` extents of each staff system, in
   * document order. Every returned page is the SAME `height`, so each sheet
   * scales identically — a short last page leaves white space rather than being
   * magnified, which is what "uneven" looked like.
   *
   * `contentBottom` is where this page's music actually ends. It matters because
   * a fixed-height window would otherwise still SHOW the top of the next system
   * — assigning that system to the following page is not enough, the sheet has
   * to be clipped to its own content or the cut staff reappears at the bottom.
   *
   * A band taller than a page gets a page to itself and is allowed to overflow:
   * clipping it would lose music, and there is nowhere better to put it.
   */
  function paginateBands(bands, pageHeight) {
    var list = [];
    for (var i = 0; i < (bands || []).length; i++) {
      var b = bands[i];
      if (!b) continue;
      var top = Number(b.top);
      var bottom = Number(b.bottom);
      if (!isFinite(top) || !isFinite(bottom) || bottom <= top) continue;
      list.push({ top: top, bottom: bottom });
    }
    if (!list.length) return [];
    list.sort(function (x, y) {
      return x.top - y.top;
    });

    var lastBottom = list[list.length - 1].bottom;
    var h = Number(pageHeight);
    if (!isFinite(h) || h <= 0) {
      // No usable page height — one page holding everything beats losing music.
      var all = lastBottom - list[0].top;
      return [{ top: list[0].top, height: all, contentBottom: lastBottom }];
    }

    var pages = [];
    var pageTop = list[0].top;
    var pageBottom = list[0].bottom;
    for (var j = 0; j < list.length; j++) {
      if (list[j].bottom - pageTop > h && list[j].top > pageTop) {
        pages.push({ top: pageTop, height: h, contentBottom: pageBottom });
        pageTop = list[j].top;
      }
      pageBottom = Math.max(pageBottom, list[j].bottom);
    }
    pages.push({ top: pageTop, height: h, contentBottom: pageBottom });
    return pages;
  }

  // ── Runtime (browser-only: abcjs render + synth) ───────────────────────────

  function abcjsReady() {
    return (
      typeof window !== 'undefined' && window.ABCJS && typeof window.ABCJS.renderAbc === 'function'
    );
  }

  /**
   * Wait for the deferred abcjs CDN script to finish loading. Resolves with the
   * ABCJS global, rejects after ~8s. (The <script defer> already requests it; we
   * just await its presence on first ABC-panel open — idle cost stays zero.)
   */
  function ensureAbcjs() {
    return new Promise(function (resolve, reject) {
      if (abcjsReady()) return resolve(window.ABCJS);
      var waited = 0;
      var iv = setInterval(function () {
        if (abcjsReady()) {
          clearInterval(iv);
          resolve(window.ABCJS);
        } else if ((waited += 100) >= 8000) {
          clearInterval(iv);
          reject(new Error('abcjs failed to load'));
        }
      }, 100);
    });
  }

  /**
   * Build the abcjs renderAbc options object from semantic Tier-2 controls
   * (`transpose` semitones, `guitarTab` toggle). Pure + unit-tested. `program`
   * is NOT a render option (it's injected into the ABC as %%MIDI program — abcjs
   * synth reads the instrument only from the tune, not from a synth option).
   */
  function buildRenderOptions(opts) {
    opts = opts || {};
    var o = { add_classes: true, responsive: 'resize', selectionColor: '#0044cc' };
    if (typeof opts.transpose === 'number' && opts.transpose !== 0) {
      o.visualTranspose = clampSemitones(opts.transpose);
    }
    if (opts.guitarTab) o.tablature = [{ instrument: 'guitar' }];
    for (var k in opts) {
      if (
        k !== 'transpose' &&
        k !== 'guitarTab' &&
        k !== 'program' &&
        Object.prototype.hasOwnProperty.call(opts, k)
      ) {
        o[k] = opts[k];
      }
    }
    return o;
  }

  /**
   * Insert a `%%MIDI program N` directive so abcjs's synth plays the chosen GM
   * instrument — the synth reads the program ONLY from the tune, never from a
   * CreateSynth option, so the instrument is a render-time (visualObj) concern.
   * No-op if the tune already declares a program. Pure + unit-tested.
   */
  function withMidiProgram(abc, program) {
    var p = Math.max(0, Math.min(127, Math.round(Number(program) || 0)));
    var src = String(abc == null ? '' : abc);
    if (/(^|\n)%%MIDI\s+program\b/i.test(src)) return src;
    var lines = src.split(/\r?\n/);
    var insertAt = 0;
    for (var i = 0; i < lines.length; i++) {
      if (/^[A-Za-z]:/.test(lines[i])) insertAt = i + 1;
      else if (lines[i].trim() !== '') break; // first body/non-field line
    }
    lines.splice(insertAt, 0, '%%MIDI program ' + p);
    return lines.join('\n');
  }

  /**
   * Render ABC into `el` (a DOM node or selector). `opts` accepts the semantic
   * Tier-2 controls (transpose, guitarTab, program) — `program` is injected as a
   * %%MIDI directive so playback uses the chosen instrument. Returns the first
   * tune's visualObj (needed by the synth) or null on failure.
   */
  function render(el, abc, opts) {
    if (!abcjsReady()) return null;
    opts = opts || {};
    var prepared = ensureAbcHeaders(abc);
    if (typeof opts.program === 'number') prepared = withMidiProgram(prepared, opts.program);
    var visualObjs = window.ABCJS.renderAbc(el, prepared, buildRenderOptions(opts));
    return visualObjs && visualObjs.length ? visualObjs[0] : null;
  }

  /**
   * Measure where each staff system sits inside a rendered abcjs SVG.
   *
   * Structure-agnostic on purpose: abcjs's class names and group nesting have
   * changed between versions, so this reads the geometry rather than the markup
   * — the SVG's top-level `<g>` children are its systems, and getBBox reports
   * where each one actually landed. If that yields fewer than two bands (an
   * abcjs layout we don't recognise), the caller falls back to printing one
   * continuous SVG, which is exactly today's behaviour: never worse.
   */
  function measureStaffBands(svg) {
    var out = [];
    if (!svg || typeof svg.querySelectorAll !== 'function') return out;
    var kids = svg.children || [];
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (!el || String(el.tagName).toLowerCase() !== 'g') continue;
      var box;
      try {
        box = el.getBBox();
      } catch (_e) {
        continue; // not rendered / not measurable
      }
      if (!box || box.height <= 0) continue;
      out.push({ top: box.y, bottom: box.y + box.height });
    }
    return out;
  }

  /**
   * Build print-ready pages from a rendered SVG: one page-sized window per
   * sheet, cut at staff boundaries. Returns null when the SVG can't be measured
   * into two or more bands, so the caller keeps the single-SVG path.
   */
  function buildPrintPages(svg, opts) {
    opts = opts || {};
    if (!svg) return null;
    var vb = svg.viewBox && svg.viewBox.baseVal;
    var width = vb && vb.width ? vb.width : Number(svg.getAttribute('width')) || 0;
    var originX = vb ? vb.x : 0;
    if (!width) return null;

    var bands = measureStaffBands(svg);
    if (bands.length < 2) return null;

    var pageH = pageBandHeight(width, pageAspect(opts.paper, opts.marginIn));
    var pages = paginateBands(bands, pageH);
    if (!pages.length) return null;
    return { width: width, originX: originX, pages: pages, content: svg.innerHTML };
  }

  /** True when this browser can do Web Audio playback (and we're on https/secure). */
  function synthSupported() {
    return !!(
      abcjsReady() &&
      window.ABCJS.synth &&
      typeof window.ABCJS.synth.supportsAudio === 'function' &&
      window.ABCJS.synth.supportsAudio()
    );
  }

  /**
   * Build our OWN transport on abcjs's low-level CreateSynth — deliberately NOT
   * the SynthController inline widget, which demands abcjs-audio.css (blocked by
   * our CSP style-src) and prints a red "CSS required" warning. This gives us a
   * dependency-free Play/Stop the panel styles itself.
   *
   * `opts.tempoPercent` (default 100) scales playback tempo via abcjs's
   * `millisecondsPerMeasure` init override — used by the Tune Trainer.
   * Returns { ready, play(), pause(), resume(), stop(), durationMs } or null.
   * play() resumes the AudioContext from the user gesture (iOS requirement).
   */
  function createPlayer(visualObj, opts) {
    if (!synthSupported() || !visualObj) return null;
    var o = opts || {};
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ac = o.audioContext || (Ctx ? new Ctx() : null);
    var pct = clampPercent(o.tempoPercent || 100);
    var synth = new window.ABCJS.synth.CreateSynth();
    var initOpts = {
      audioContext: ac || undefined,
      visualObj: visualObj,
      options: {
        soundFontUrl: o.soundFontUrl || SOUNDFONT_URL,
        program: typeof o.program === 'number' ? o.program : 0,
      },
    };
    var baseMsPerMeasure = 0;
    try {
      if (typeof visualObj.millisecondsPerMeasure === 'function') {
        baseMsPerMeasure = visualObj.millisecondsPerMeasure() || 0;
      }
    } catch (_) {
      /* not available — play at the tune's native tempo */
    }
    if (baseMsPerMeasure && pct !== 100) {
      initOpts.millisecondsPerMeasure = Math.round((baseMsPerMeasure * 100) / pct);
    }
    var player = { ready: null, durationMs: 0 };
    // Best-effort up-front duration (scaled); refined from prime() below.
    try {
      if (typeof visualObj.getTotalTime === 'function') {
        player.durationMs = Math.round(((visualObj.getTotalTime() || 0) * 1000 * 100) / pct);
      }
    } catch (_) {
      /* getTotalTime not available pre-prime — fine */
    }
    player.ready = synth
      .init(initOpts)
      .then(function () {
        return synth.prime();
      })
      .then(function (res) {
        // prime() resolves with { status, duration } (seconds) — the exact length.
        if (res && typeof res.duration === 'number' && res.duration > 0) {
          player.durationMs = Math.round((res.duration * 1000 * 100) / pct);
        }
        return res;
      });
    Object.assign(player, {
      play: function () {
        if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
        return player.ready.then(function () {
          return synth.start();
        });
      },
      pause: function () {
        try {
          synth.pause();
        } catch (_) {
          /* noop */
        }
      },
      resume: function () {
        if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
        try {
          synth.resume();
        } catch (_) {
          /* noop */
        }
      },
      stop: function () {
        try {
          synth.stop();
        } catch (_) {
          /* noop */
        }
      },
    });
    return player;
  }

  /**
   * Tune Trainer runtime: chains createPlayer through the percentages from
   * buildTrainerSteps, advancing on each step's (scaled) duration. Shares one
   * AudioContext across steps. Browser-only. `opts.onStep(i, total, pct)` and
   * `opts.onDone()` are progress callbacks. Returns { steps, start(), stop() }.
   */
  function createTrainer(visualObj, opts) {
    if (!synthSupported() || !visualObj) return null;
    var o = opts || {};
    var steps = buildTrainerSteps(o);
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ac = o.audioContext || (Ctx ? new Ctx() : null);
    var i = -1;
    var stopped = false;
    var cur = null;
    var timer = null;
    var onStep = typeof o.onStep === 'function' ? o.onStep : function () {};
    var onDone = typeof o.onDone === 'function' ? o.onDone : function () {};

    function advance() {
      if (stopped) return;
      i++;
      if (i >= steps.length) {
        onDone();
        return;
      }
      var pct = steps[i];
      onStep(i, steps.length, pct);
      cur = createPlayer(visualObj, {
        program: o.program,
        soundFontUrl: o.soundFontUrl,
        tempoPercent: pct,
        audioContext: ac,
      });
      if (!cur) return;
      cur
        .play()
        .then(function () {
          timer = setTimeout(advance, (cur.durationMs || 0) + 250);
        })
        .catch(function () {
          /* skip a failed step */
        });
    }

    return {
      steps: steps,
      start: function () {
        stopped = false;
        i = -1;
        advance();
      },
      stop: function () {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (cur) {
          try {
            cur.stop();
          } catch (_) {
            /* noop */
          }
        }
      },
    };
  }

  var api = {
    SOUNDFONT_URL: SOUNDFONT_URL,
    SOUNDFONTS: SOUNDFONTS,
    MELODY_INSTRUMENTS: MELODY_INSTRUMENTS,
    // pure
    clampSemitones: clampSemitones,
    clampPercent: clampPercent,
    buildTrainerSteps: buildTrainerSteps,
    buildRenderOptions: buildRenderOptions,
    pageAspect: pageAspect,
    pageBandHeight: pageBandHeight,
    paginateBands: paginateBands,
    measureStaffBands: measureStaffBands,
    buildPrintPages: buildPrintPages,
    withMidiProgram: withMidiProgram,
    extractAbcTitle: extractAbcTitle,
    abcTempoBpm: abcTempoBpm,
    sniffIsAbc: sniffIsAbc,
    defaultAbcExample: defaultAbcExample,
    ensureAbcHeaders: ensureAbcHeaders,
    csmpnToAbc: csmpnToAbc,
    chordToAbcChord: chordToAbcChord,
    chordTokenToMidis: chordTokenToMidis,
    // runtime
    abcjsReady: abcjsReady,
    ensureAbcjs: ensureAbcjs,
    render: render,
    synthSupported: synthSupported,
    createPlayer: createPlayer,
    createTrainer: createTrainer,
  };
  if (typeof window !== 'undefined') window.ABCSuite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

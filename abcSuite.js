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
  var SOUNDFONT_URL =
    'https://cdn.jsdelivr.net/gh/paulrosen/midi-js-soundfonts@gh-pages/abcjs/';

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
          measure += (prevChord ? '"' + prevChord + '"' : '') + 'z' + units; // sustain
        } else if (/^N\.?C\.?$/i.test(rawTok)) {
          measure += 'z' + units;
          prevChord = null;
        } else {
          var durs = splitUnits(units, chords.length);
          var parts = [];
          for (var c = 0; c < chords.length; c++) {
            var name = normalizeChordForAbc(chords[c]);
            if (name) prevChord = name;
            parts.push((name ? '"' + name + '"' : '') + 'z' + durs[c]);
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
        cur = i === n - 1 ? '' : close === ':|' || close === '|]' ? (i + 1 < n && flat[i + 1].leftRepeat ? '|:' : '|') : '';
      }
    }

    return header.concat(lines.filter(Boolean)).join('\n');
  }

  // ── Runtime (browser-only: abcjs render + synth) ───────────────────────────

  function abcjsReady() {
    return (
      typeof window !== 'undefined' &&
      window.ABCJS &&
      typeof window.ABCJS.renderAbc === 'function'
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
   * (`transpose` semitones, `guitarTab` toggle). Pure + unit-tested. Any other
   * keys pass straight through to abcjs.
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
        Object.prototype.hasOwnProperty.call(opts, k)
      ) {
        o[k] = opts[k];
      }
    }
    return o;
  }

  /**
   * Render ABC into `el` (a DOM node or selector). `opts` accepts the semantic
   * Tier-2 controls (transpose, guitarTab) via buildRenderOptions. Returns the
   * first tune's visualObj (needed by the synth) or null on failure.
   */
  function render(el, abc, opts) {
    if (!abcjsReady()) return null;
    var visualObjs = window.ABCJS.renderAbc(
      el,
      ensureAbcHeaders(abc),
      buildRenderOptions(opts)
    );
    return visualObjs && visualObjs.length ? visualObjs[0] : null;
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
   * Build an abcjs SynthController bound to a transport element and load a tune.
   * The controller renders its own play/loop/progress/tempo controls and handles
   * the iOS audio-unlock on the user's click. Returns the controller (or null).
   */
  function createSynthController(transportEl, visualObj, opts) {
    if (!synthSupported() || !visualObj) return null;
    var o = opts || {};
    var controller = new window.ABCJS.synth.SynthController();
    controller.load(transportEl, o.cursorControl || null, {
      displayLoop: true,
      displayRestart: true,
      displayPlay: true,
      displayProgress: true,
      displayWarp: true,
    });
    var setTune = controller.setTune(visualObj, false, {
      soundFontUrl: o.soundFontUrl || SOUNDFONT_URL,
      program: typeof o.program === 'number' ? o.program : 0,
    });
    if (setTune && typeof setTune.catch === 'function') setTune.catch(function () {});
    return controller;
  }

  var api = {
    SOUNDFONT_URL: SOUNDFONT_URL,
    MELODY_INSTRUMENTS: MELODY_INSTRUMENTS,
    // pure
    clampSemitones: clampSemitones,
    buildRenderOptions: buildRenderOptions,
    extractAbcTitle: extractAbcTitle,
    abcTempoBpm: abcTempoBpm,
    sniffIsAbc: sniffIsAbc,
    defaultAbcExample: defaultAbcExample,
    ensureAbcHeaders: ensureAbcHeaders,
    csmpnToAbc: csmpnToAbc,
    // runtime
    abcjsReady: abcjsReady,
    ensureAbcjs: ensureAbcjs,
    render: render,
    synthSupported: synthSupported,
    createSynthController: createSynthController,
  };
  if (typeof window !== 'undefined') window.ABCSuite = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

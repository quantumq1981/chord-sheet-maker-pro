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
   * Render ABC into `el` (a DOM node or selector). Returns the first tune's
   * visualObj (needed by the synth) or null on failure.
   */
  function render(el, abc, opts) {
    if (!abcjsReady()) return null;
    var options = Object.assign(
      { add_classes: true, responsive: 'resize', selectionColor: '#0044cc' },
      opts || {}
    );
    var visualObjs = window.ABCJS.renderAbc(el, ensureAbcHeaders(abc), options);
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
    // pure
    extractAbcTitle: extractAbcTitle,
    abcTempoBpm: abcTempoBpm,
    sniffIsAbc: sniffIsAbc,
    defaultAbcExample: defaultAbcExample,
    ensureAbcHeaders: ensureAbcHeaders,
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

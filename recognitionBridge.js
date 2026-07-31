/**
 * recognitionBridge.js — the seam between the vendored recognition engine and
 * this app's CSMPN pipeline (browser global + `window.RecognitionBridge`).
 *
 * `recognitionEngine.mjs` is a native ES module (vendored verbatim from
 * Tab-Translator-Pro; see recognitionEngine.provenance.json). `index.html` and
 * every root module here are classic scripts, so they cannot `import` it. This
 * file is the one place that crosses that line, via a LAZY dynamic import:
 *
 *   - Lazy because the engine is ~170 KB of binary-format parsers. Loading it on
 *     boot would cost that parse on every visit, on iOS Safari, for a user who
 *     may never open a Guitar Pro file. It loads on the first import instead.
 *   - Dynamic `import()` works inside a classic script and resolves against the
 *     document base URL, which is where CI copies the engine — so the same
 *     specifier is correct in dev, in `dist/`, and under the GitHub Pages
 *     sub-path.
 *
 * Everything except `loadEngine`/`importBinary` is pure and unit-tested; the two
 * runtime functions are the only browser-dependent parts.
 */
(function () {
  var ENGINE_URL = './recognitionEngine.mjs';

  // Memoised so a second import doesn't refetch or re-evaluate the module.
  var _enginePromise = null;

  function loadEngine() {
    if (!_enginePromise) {
      // Written as a literal, not as ENGINE_URL: scripts/verify-deploy-assets.mjs
      // follows dynamic imports to prove the engine actually ships, and it can
      // only read a string. A test pins the two spellings together.
      _enginePromise = import('./recognitionEngine.mjs').catch(function (err) {
        _enginePromise = null; // a failed load must not poison later attempts
        throw err;
      });
    }
    return _enginePromise;
  }

  // ── Pure helpers ──────────────────────────────────────────────────────────

  /**
   * A readable chart title from a filename: drop the extension, turn separators
   * into spaces, collapse whitespace. Guitar Pro's own metadata does not survive
   * into the engine's score shape, so the filename is what we have.
   */
  function chartTitleFromFilename(name) {
    if (!name) return '';
    return String(name)
      .replace(/\.[A-Za-z0-9]{1,6}$/, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * How much harmony a part actually carries.
   *
   * A multi-track Guitar Pro file has one score per instrument, and only some of
   * them state the changes. Two signals, both read off the parsed events:
   *   - events sounding 3+ notes at once (a part that COMPS, not a melody line)
   *   - how many distinct chord symbols it names (harmonic variety, not one vamp)
   *
   * Weighted 2:1 toward comping, because a busy single-note lead line can name
   * many symbols without ever stating a chord. Bass, lead and percussion tracks
   * score ~0 on the first term, which is what keeps them from winning.
   */
  function partHarmonyScore(score) {
    if (!score || !score.bars || !score.bars.length) return 0;
    var chordy = 0;
    var symbols = Object.create(null);
    var distinct = 0;
    for (var i = 0; i < score.bars.length; i++) {
      var events = score.bars[i].events || [];
      for (var j = 0; j < events.length; j++) {
        var ev = events[j];
        if (ev.midis && ev.midis.length >= 3) chordy++;
        var sym = ev.symbol;
        if (sym && sym !== '—' && sym !== 'N.C.' && !symbols[sym]) {
          symbols[sym] = true;
          distinct++;
        }
      }
    }
    return chordy * 2 + distinct;
  }

  /**
   * Index of the part that best states the changes. Ties keep the earlier part,
   * which puts the file's own track order in charge when the scores agree.
   * Returns 0 for an empty list so callers always have a valid index.
   */
  function pickChordPart(scores) {
    var best = 0;
    var bestScore = -1;
    for (var i = 0; i < (scores || []).length; i++) {
      var s = partHarmonyScore(scores[i]);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  }

  /** Counts for the status line and the Import Details panel. */
  function importSummary(score) {
    var bars = (score && score.bars) || [];
    var sections = 0;
    var chords = 0;
    for (var i = 0; i < bars.length; i++) {
      if (bars[i].section) sections++;
      chords += (bars[i].events || []).length;
    }
    return {
      bars: bars.length,
      sections: sections || 1,
      chords: chords,
      parts: ((score && score.parts) || []).length || 1,
      tuning: (score && score.tuning) || '',
      capo: (score && score.capo) || 0,
    };
  }

  // ── Runtime ───────────────────────────────────────────────────────────────

  /**
   * Read a Guitar Pro (3–8 / GPX), Power Tab or MusicXML file into CSMPN.
   *
   * Steps, in order, and why each is here:
   *  1. Parse part 0 to learn the part list (the engine routes by magic bytes,
   *     so the extension is only ever a hint).
   *  2. Re-parse every part and pick the one that carries the harmony. Track 0
   *     is usually a vocal or lead line — defaulting to it would hand back a
   *     melody transcribed as chords.
   *  3. Simplify when the chosen part is melodic (an arpeggiated or single-note
   *     part), so it reads as one chord per bar instead of one chord per note.
   *  4. Emit CSMPN through the engine's own exporter, which already speaks this
   *     app's native bar syntax plus {tab} voicings and {hybrid} rhythm.
   *
   * `opts.partIndex` skips step 2 — that is the path the part picker uses.
   */
  async function importBinary(bytes, opts) {
    opts = opts || {};
    var engine = await loadEngine();
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var name = opts.filename || '';
    var useSharp = opts.useSharp !== false;

    var first = await engine.parseGuitarProOrXML(u8, name, useSharp, 0);
    var parts = first.parts || [];

    var index = 0;
    var score = first;
    if (opts.partIndex != null) {
      index = opts.partIndex;
      if (index !== 0) score = await engine.parseGuitarProOrXML(u8, name, useSharp, index);
    } else if (parts.length > 1) {
      var scores = [first];
      for (var i = 1; i < parts.length; i++) {
        scores.push(await engine.parseGuitarProOrXML(u8, name, useSharp, i));
      }
      index = pickChordPart(scores);
      score = scores[index];
    }

    // An arpeggiated or single-note part would otherwise export one chord per
    // note; collapsing it to one chord per bar is what makes it a chart.
    var melodic = engine.isMelodicScore(score);
    var charted = melodic ? engine.simplifyScore(score, useSharp) : score;

    var key = engine.analyzeKey(charted);
    var csmpn = engine.scoreToCSMPN(charted, {
      title: opts.title || chartTitleFromFilename(name) || 'Imported chart',
      key: key,
      tempo: score.tempo,
      useSharp: useSharp,
      tab: opts.tab !== false,
      hybrid: opts.hybrid !== false,
    });

    return {
      csmpn: csmpn,
      score: charted,
      rawScore: score,
      parts: parts,
      partIndex: index,
      melodic: melodic,
      key: engine.keyName(key, useSharp) || '',
      summary: importSummary(charted),
      format: score.source || '',
    };
  }

  window.RecognitionBridge = {
    ENGINE_URL: ENGINE_URL,
    loadEngine: loadEngine,
    chartTitleFromFilename: chartTitleFromFilename,
    partHarmonyScore: partHarmonyScore,
    pickChordPart: pickChordPart,
    importSummary: importSummary,
    importBinary: importBinary,
  };
})();

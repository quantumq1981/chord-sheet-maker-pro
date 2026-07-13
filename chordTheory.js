/**
 * chordTheory.js — single source of truth for the family's chord-recognition DATA
 * (browser global + window.ChordTheory).
 *
 * The canonical note spelling (`NOTE_NAMES`, the family enharmonic default
 * Bb·C#·Eb·F#·Ab) and the chord-template table (`CHORD_PATTERNS`) used to be copied
 * into importGuitarPro.js, midiImport.js, and src/utils/fretToChord.ts — a drift
 * risk every time a pattern was added or the spelling changed. They now live here
 * once; the two browser-global importers read `window.ChordTheory`, and the TS twin
 * (fretToChord.ts) is pinned to this file by tests/chordTheoryParity.test.ts.
 *
 * Loaded as a classic <script> before midiImport.js (and before the deferred
 * importGuitarPro.js). Plain object export so it also loads in the Node vm tests.
 */
(function () {
  // Family canonical spelling — ALWAYS Bb C# Eb F# Ab (never A#/Db/D#/Gb/G#).
  var NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // Chord templates (intervals above the root). ORDER IS SIGNIFICANT — earlier =
  // more common; exact-match recognisers return the first match, tolerant scorers
  // break ties toward earlier entries. Keep in sync with fretToChord.ts (guarded
  // by tests/chordTheoryParity.test.ts).
  var CHORD_PATTERNS = [
    { suffix: '', intervals: [0, 4, 7] }, // major
    { suffix: 'm', intervals: [0, 3, 7] }, // minor
    { suffix: '5', intervals: [0, 7] }, // power chord
    { suffix: '7', intervals: [0, 4, 7, 10] }, // dominant 7
    { suffix: 'maj7', intervals: [0, 4, 7, 11] }, // major 7
    { suffix: 'm7', intervals: [0, 3, 7, 10] }, // minor 7
    { suffix: 'mM7', intervals: [0, 3, 7, 11] }, // minor-major 7
    { suffix: 'm7b5', intervals: [0, 3, 6, 10] }, // half-diminished
    { suffix: 'dim7', intervals: [0, 3, 6, 9] }, // diminished 7
    { suffix: 'dim', intervals: [0, 3, 6] }, // diminished triad
    { suffix: 'aug', intervals: [0, 4, 8] }, // augmented
    { suffix: 'sus4', intervals: [0, 5, 7] }, // suspended 4
    { suffix: 'sus2', intervals: [0, 2, 7] }, // suspended 2
    { suffix: 'add9', intervals: [0, 2, 4, 7] }, // add9
    { suffix: '6', intervals: [0, 4, 7, 9] }, // major 6
    { suffix: 'm6', intervals: [0, 3, 7, 9] }, // minor 6
    { suffix: '9', intervals: [0, 2, 4, 7, 10] }, // dominant 9
    { suffix: '7sus4', intervals: [0, 5, 7, 10] }, // dominant 7 suspended 4
    { suffix: 'aug7', intervals: [0, 4, 8, 10] }, // augmented 7
    { suffix: '7b5', intervals: [0, 4, 6, 10] }, // dominant 7 flat 5
    { suffix: '7#9', intervals: [0, 3, 4, 7, 10] }, // dominant 7 sharp 9 (Hendrix)
    { suffix: '7b9', intervals: [0, 1, 4, 7, 10] }, // dominant 7 flat 9
    { suffix: 'maj9', intervals: [0, 2, 4, 7, 11] }, // major 9
    { suffix: 'm9', intervals: [0, 2, 3, 7, 10] }, // minor 9
    { suffix: '9sus4', intervals: [0, 2, 5, 7, 10] }, // dominant 9 suspended 4
    { suffix: '6add9', intervals: [0, 2, 4, 7, 9] }, // major 6 add 9
  ];

  // ── Chord-based key inference ─────────────────────────────────────────────
  // Many GP files ship with the key signature left at the default (C major /
  // 0 accidentals), and PDF text layers rarely carry a usable key at all. This
  // scores every major and minor key against the chart's chords (diatonic
  // triad-quality match) so importers can backfill the Key: header field.

  var _PC_BY_NAME = {
    C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4,
    F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9,
    'A#': 10, Bb: 10, B: 11, Cb: 11,
  };

  // Diatonic chord qualities by scale-degree offset (semitones above tonic).
  // Minor includes the harmonic-minor dominant (major/dom V) alongside the
  // natural-minor v, plus the bVII that pop/rock minor keys lean on.
  var _MAJOR_DEGREES = { 0: 'maj', 2: 'min', 4: 'min', 5: 'maj', 7: 'maj', 9: 'min', 11: 'dim' };
  var _MINOR_DEGREES = { 0: 'min', 2: 'dim', 3: 'maj', 5: 'min', 7: 'both', 8: 'maj', 10: 'maj' };

  /**
   * Parse a chord token into { pc, quality } where quality is
   * 'maj' | 'min' | 'dim' | 'dom'. Returns null for non-chords (%, N.C., …).
   */
  function _parseChordForKey(token) {
    if (!token) return null;
    var t = String(token).trim();
    t = t.replace(/[♭]/g, 'b').replace(/[♯]/g, '#');
    var m = t.match(/^([A-G])([b#]?)/);
    if (!m) return null;
    var pc = _PC_BY_NAME[m[1] + m[2]];
    if (pc === undefined) return null;
    var rest = t.slice(m[0].length).split('/')[0]; // ignore slash bass
    var quality = 'maj';
    if (/^(dim|o(?![a-z])|°|º)/.test(rest) || /m7b5|ø/.test(rest)) quality = 'dim';
    else if (/^(m|min|mi(?![a-z]))(?!aj)/.test(rest)) quality = 'min';
    else if (/^(7|9|11|13)/.test(rest)) quality = 'dom';
    return { pc: pc, quality: quality };
  }

  /**
   * Infer the most likely key from a chart's chord tokens.
   * @param {string[]} chords  Chord tokens in chart order (repeats welcome —
   *                           frequency is part of the signal).
   * @returns {string|null}    Key string like 'Dm' or 'C', or null when the
   *                           input has no parseable chords or no clear winner.
   */
  function inferKeyFromChords(chords) {
    if (!chords || !chords.length) return null;
    var parsed = [];
    for (var i = 0; i < chords.length; i++) {
      var p = _parseChordForKey(chords[i]);
      if (p) parsed.push(p);
    }
    if (!parsed.length) return null;

    var first = parsed[0];
    var last = parsed[parsed.length - 1];

    var bestKey = null;
    var bestScore = -Infinity;
    for (var tonic = 0; tonic < 12; tonic++) {
      for (var mode = 0; mode < 2; mode++) {
        var degrees = mode === 0 ? _MAJOR_DEGREES : _MINOR_DEGREES;
        var score = 0;
        for (var ci = 0; ci < parsed.length; ci++) {
          var ch = parsed[ci];
          var off = (ch.pc - tonic + 12) % 12;
          var expected = degrees[off];
          if (expected === undefined) {
            score -= 1; // chromatic root
          } else if (
            expected === ch.quality ||
            (expected === 'both' && (ch.quality === 'maj' || ch.quality === 'min' || ch.quality === 'dom')) ||
            (expected === 'maj' && ch.quality === 'dom' && off === 7) || // V7
            (expected === 'maj' && ch.quality === 'dom' && off === 0) // blues I7
          ) {
            score += 2;
          } else {
            score += 0.5; // root diatonic, quality off
          }
        }
        // Tonic bonus: charts overwhelmingly start and/or end on the tonic.
        var tonicQuality = mode === 0 ? 'maj' : 'min';
        if (first.pc === tonic && (first.quality === tonicQuality || first.quality === 'dom')) score += 3;
        if (last.pc === tonic && (last.quality === tonicQuality || last.quality === 'dom')) score += 2;

        if (score > bestScore) {
          bestScore = score;
          bestKey = NOTE_NAMES[tonic] + (mode === 1 ? 'm' : '');
        }
      }
    }
    // Require a minimally coherent fit: at least half the chords scoring as
    // diatonic matches. Below that the chart is too chromatic to call.
    if (bestScore < parsed.length) return null;
    return bestKey;
  }

  var api = {
    NOTE_NAMES: NOTE_NAMES,
    CHORD_PATTERNS: CHORD_PATTERNS,
    inferKeyFromChords: inferKeyFromChords,
  };
  if (typeof window !== 'undefined') window.ChordTheory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

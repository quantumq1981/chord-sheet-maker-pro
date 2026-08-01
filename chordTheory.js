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

  // ── Key signatures & enharmonic spelling ──────────────────────────────────
  // NOTE_NAMES is the family default (Bb C# Eb F# Ab), used when no key is
  // known. When a chart's key IS known, chromatic pitch classes should be
  // spelled for that key: pc 8 is G# in E major but Ab in C minor. The rule:
  // sharp keys spell sharpward, flat keys flatward, 0-fifths keys use the
  // family default. (Full scale-degree spelling is a future refinement; this
  // covers the practical fake-book cases.)

  var NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  var NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

  var _MAJOR_FIFTHS = {
    C: 0,
    G: 1,
    D: 2,
    A: 3,
    E: 4,
    B: 5,
    'F#': 6,
    'C#': 7,
    F: -1,
    Bb: -2,
    Eb: -3,
    Ab: -4,
    Db: -5,
    Gb: -6,
    Cb: -7,
  };
  var _MINOR_FIFTHS = {
    A: 0,
    E: 1,
    B: 2,
    'F#': 3,
    'C#': 4,
    'G#': 5,
    'D#': 6,
    'A#': 7,
    D: -1,
    G: -2,
    C: -3,
    F: -4,
    Bb: -5,
    Eb: -6,
    Ab: -7,
  };

  /**
   * Circle-of-fifths position for a key string ('Dm', 'E', 'Bb major',
   * 'F# minor', …). Returns an integer −7…7, or null when unparseable.
   */
  function keyFifths(keyStr) {
    if (!keyStr) return null;
    var s = String(keyStr).trim().replace(/[♭]/g, 'b').replace(/[♯]/g, '#');
    var m = s.match(/^([A-G][b#]?)\s*(m\b|min\b|minor\b|-|maj\b|major\b)?/i);
    if (!m) return null;
    var root = m[1][0].toUpperCase() + m[1].slice(1);
    var isMinor = /^(m|min|minor|-)$/i.test(m[2] || '');
    var table = isMinor ? _MINOR_FIFTHS : _MAJOR_FIFTHS;
    return table[root] !== undefined ? table[root] : null;
  }

  /**
   * Spell a pitch class for a key: sharp keys → sharp names, flat keys →
   * flat names, unknown/0-fifths → the family default NOTE_NAMES.
   */
  function spellPcForKey(pc, keyStr) {
    var fifths = keyFifths(keyStr);
    pc = ((pc % 12) + 12) % 12;
    if (fifths === null || fifths === 0) return NOTE_NAMES[pc];
    return fifths > 0 ? NOTE_NAMES_SHARP[pc] : NOTE_NAMES_FLAT[pc];
  }

  // ── Bass-priority chord recognition ───────────────────────────────────────
  // Names a chord from a weighted pitch-class collection using the sequence:
  //   1. isolate the bass note (the harmonic foundation)
  //   2. measure intervals from candidate roots — the BASS-rooted reading is
  //      preferred, so [C,E,G,A] with C in the bass is C6, with A it's Am7,
  //      and Bb-triad-over-C names as C9sus4 (hybrid/upper-structure chords
  //      fall out of the same rule)
  //   3. tritone check — collections containing a root+3rd+b7 tritone bias
  //      toward the dominant-family reading
  //   4. contextual label — when a non-bass root wins decisively and the bass
  //      is one of its chord tones, emit the inversion as a slash (C/E)
  //
  // Guardrails: at least 2 structural pitch classes (≥10% of the collection's
  // weight) and a confidence floor, so lone melody notes and true silence
  // never fabricate harmony.

  /**
   * @param {Object<number,number>} pcWeights  pitch class → sounding weight
   * @param {number|null} bassPc               lowest sounding pitch class
   * @param {object} [opts]
   *   key   {string}   chart key for enharmonic spelling ('Em', 'Bb', …)
   *   slash {boolean}  emit inversion slashes (default true)
   * @returns {string|null}
   */
  function recognizeChordFromPcs(pcWeights, bassPc, opts) {
    opts = opts || {};
    var pcs = Object.keys(pcWeights || {}).map(Number);
    if (!pcs.length) return null;
    var total = 0;
    for (var i = 0; i < pcs.length; i++) total += pcWeights[pcs[i]];
    var strong = pcs.filter(function (pc) {
      return pcWeights[pc] >= total * 0.1;
    });
    if (strong.length < 2) return null;
    var pcSet = Object.create(null);
    for (var si = 0; si < strong.length; si++) pcSet[strong[si]] = true;

    // Bass logic only applies when the bass is itself structural — a brief
    // low passing tone must not steer the naming.
    var bassStructural = typeof bassPc === 'number' && pcSet[bassPc] ? bassPc : null;

    var spell = function (pc) {
      return opts.key ? spellPcForKey(pc, opts.key) : NOTE_NAMES[pc];
    };

    var scoreRootPattern = function (root, pat) {
      var covered = Object.create(null);
      var inter = 0;
      var missing = 0;
      for (var ii = 0; ii < pat.intervals.length; ii++) {
        var pc = (root + pat.intervals[ii]) % 12;
        covered[pc] = true;
        if (pcSet[pc]) inter++;
        else missing++;
      }
      var extra = 0;
      for (var ei = 0; ei < strong.length; ei++) {
        if (!covered[strong[ei]]) extra++;
      }
      var score = inter - 0.8 * extra - 1.2 * missing;
      // Tritone rule: a sounding 3rd+b7 tritone flags dominant function —
      // bias patterns that actually contain that tritone.
      if (
        pcSet[(root + 4) % 12] &&
        pcSet[(root + 10) % 12] &&
        pat.intervals.indexOf(4) >= 0 &&
        pat.intervals.indexOf(10) >= 0
      ) {
        score += 0.4;
      }
      if (bassStructural !== null && root === bassStructural) score += 0.3;
      return score;
    };

    var bestOverall = null;
    var bestOverallScore = -Infinity;
    var bestBass = null;
    var bestBassScore = -Infinity;
    for (var root = 0; root < 12; root++) {
      for (var pi = 0; pi < CHORD_PATTERNS.length; pi++) {
        var s = scoreRootPattern(root, CHORD_PATTERNS[pi]);
        if (s > bestOverallScore) {
          bestOverallScore = s;
          bestOverall = { root: root, pat: CHORD_PATTERNS[pi] };
        }
        if (bassStructural !== null && root === bassStructural && s > bestBassScore) {
          bestBassScore = s;
          bestBass = { root: root, pat: CHORD_PATTERNS[pi] };
        }
      }
    }

    var FLOOR = 1.5;
    // Bass-priority: the bass-rooted reading wins ties and near-ties (this is
    // what turns [C,E,G,A]/C into C6 and Bb-triad/C into C9sus4). Only an
    // overwhelmingly better non-bass reading overrides it.
    if (bestBass && bestBassScore >= FLOOR && bestOverallScore - bestBassScore <= 1.5) {
      return spell(bestBass.root) + bestBass.pat.suffix;
    }
    if (!bestOverall || bestOverallScore < FLOOR) return null;
    var name = spell(bestOverall.root) + bestOverall.pat.suffix;
    // Inversion labeling: structural chord-tone bass that isn't the root.
    if (opts.slash !== false && bassStructural !== null && bassStructural !== bestOverall.root) {
      var isChordTone = bestOverall.pat.intervals.some(function (iv) {
        return (bestOverall.root + iv) % 12 === bassStructural;
      });
      if (isChordTone) name += '/' + spell(bassStructural);
    }
    return name;
  }

  // ── Chord-based key inference ─────────────────────────────────────────────
  // Many GP files ship with the key signature left at the default (C major /
  // 0 accidentals), and PDF text layers rarely carry a usable key at all. This
  // scores every major and minor key against the chart's chords (diatonic
  // triad-quality match) so importers can backfill the Key: header field.

  var _PC_BY_NAME = {
    C: 0,
    'B#': 0,
    'C#': 1,
    Db: 1,
    D: 2,
    'D#': 3,
    Eb: 3,
    E: 4,
    Fb: 4,
    F: 5,
    'E#': 5,
    'F#': 6,
    Gb: 6,
    G: 7,
    'G#': 8,
    Ab: 8,
    A: 9,
    'A#': 10,
    Bb: 10,
    B: 11,
    Cb: 11,
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
            (expected === 'both' &&
              (ch.quality === 'maj' || ch.quality === 'min' || ch.quality === 'dom')) ||
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
        if (first.pc === tonic && (first.quality === tonicQuality || first.quality === 'dom'))
          score += 3;
        if (last.pc === tonic && (last.quality === tonicQuality || last.quality === 'dom'))
          score += 2;

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

  /*
   * ── Reading a chord token ────────────────────────────────────────────────
   *
   * Musicians write the same chord several ways, and two of those ways contain
   * a slash: the 6/9 family, and any slash bass. Splitting naively on `/` turns
   * `C6/9` into "C6 over the note 9", which is not a chord at all — that is how
   * every 6/9 in a real chart came to play silence.
   *
   * The rule that disambiguates them: a slash bass is ALWAYS a note name and
   * nothing else. `/9` is part of the quality; `/D` is a bass.
   */

  var BASS_RE = /^[A-Ga-g][#b♯♭]?$/;

  /** Split a raw chord token into root, quality suffix and slash bass. */
  function splitChordToken(token) {
    var t = String(token == null ? '' : token)
      .replace(/[♭]/g, 'b')
      .replace(/[♯]/g, '#')
      .replace(/[!~]+$/, '')
      .trim();
    if (!t || /^%+$/.test(t) || /^n\.?c\.?$/i.test(t)) return null;

    var bass = null;
    var slash = t.lastIndexOf('/');
    if (slash > 0 && BASS_RE.test(t.slice(slash + 1).trim())) {
      bass = t.slice(slash + 1).trim();
      t = t.slice(0, slash);
    }
    var m = /^([A-Ga-g][#b]?)(.*)$/.exec(t.trim());
    if (!m) return null;
    return { root: m[1], suffix: (m[2] || '').trim(), bass: bass };
  }

  /*
   * Alias → the canonical suffix used in CHORD_PATTERNS. Ordered longest-first
   * where prefixes overlap, since these are exact whole-suffix replacements.
   */
  var SUFFIX_ALIASES = {
    '6/9': '6add9',
    69: '6add9',
    '6-9': '6add9',
    add2: 'add9',
    majadd9: 'add9',
    sus: 'sus4',
    '7sus': '7sus4',
    '9sus': '9sus4',
    // Bare "maj"/"M" is a major TRIAD, not a major 7th — only the numbered
    // forms mean the seventh. Getting this backwards would put an 11th-hour
    // major 7th into every plain chord written that way.
    maj: '',
    major: '',
    Maj: '',
    Major: '',
    MAJ: '',
    M: '',
    ma7: 'maj7',
    Ma7: 'maj7',
    MA7: 'maj7',
    M7: 'maj7',
    Maj7: 'maj7',
    MAJ7: 'maj7',
    Maj9: 'maj9',
    M9: 'maj9',
    '^7': 'maj7',
    'm(maj7)': 'mM7',
    mmaj7: 'mM7',
    minmaj7: 'mM7',
    mmaj: 'mM7',
    min: 'm',
    Min: 'm',
    MIN: 'm',
    minor: 'm',
    Minor: 'm',
    '-': 'm',
    min7: 'm7',
    Min7: 'm7',
    '-7': 'm7',
    min6: 'm6',
    min9: 'm9',
    o: 'dim',
    o7: 'dim7',
    '+': 'aug',
    '+7': 'aug7',
    aug5: 'aug',
    ø: 'm7b5',
    ø7: 'm7b5',
    min7b5: 'm7b5',
    'm7-5': 'm7b5',
    '-7b5': 'm7b5',
    halfdim: 'm7b5',
  };

  /**
   * Canonical form of a raw quality suffix — unicode folded to ASCII, then any
   * known alias mapped onto the spelling CHORD_PATTERNS uses.
   *
   * Deliberately NOT lower-cased wholesale: `M7` (major 7) and `m7` (minor 7)
   * differ only by case, so folding them together would turn every major 7th
   * into a minor 7th.
   */
  function normalizeChordSuffix(suffix) {
    var s = String(suffix == null ? '' : suffix)
      .replace(/[♭]/g, 'b')
      .replace(/[♯]/g, '#')
      // The triangle and ø already imply the seventh, so `△7` and `ø7` must
      // collapse to one — expanding the glyph first would yield `maj77`.
      .replace(/[△Δ∆]\s*7?/g, 'maj7')
      .replace(/[øØ]\s*7?/g, 'm7b5')
      .replace(/[°º]/g, 'dim')
      .replace(/\s+/g, '')
      .trim();
    if (!s) return '';
    /*
     * Exact lookup only, with the realistic capitalisations spelled out in the
     * table. A case-insensitive fallback is tempting and wrong: `M7` (major 7)
     * and `m7` (minor 7) differ by case alone, so any fuzzy match risks turning
     * every major 7th into a minor 7th.
     */
    return Object.prototype.hasOwnProperty.call(SUFFIX_ALIASES, s) ? SUFFIX_ALIASES[s] : s;
  }

  /**
   * Intervals for a quality suffix from the shared table, or null if unknown.
   * Callers own their fallback: playback approximates, notation may decline.
   */
  function intervalsForSuffix(suffix) {
    var want = normalizeChordSuffix(suffix);
    for (var i = 0; i < CHORD_PATTERNS.length; i++) {
      if (CHORD_PATTERNS[i].suffix === want) return CHORD_PATTERNS[i].intervals.slice();
    }
    return null;
  }

  var api = {
    NOTE_NAMES: NOTE_NAMES,
    CHORD_PATTERNS: CHORD_PATTERNS,
    SUFFIX_ALIASES: SUFFIX_ALIASES,
    splitChordToken: splitChordToken,
    normalizeChordSuffix: normalizeChordSuffix,
    intervalsForSuffix: intervalsForSuffix,
    inferKeyFromChords: inferKeyFromChords,
    keyFifths: keyFifths,
    spellPcForKey: spellPcForKey,
    recognizeChordFromPcs: recognizeChordFromPcs,
  };
  if (typeof window !== 'undefined') window.ChordTheory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

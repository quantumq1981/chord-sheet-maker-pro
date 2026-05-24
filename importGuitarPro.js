/* ============================================================
   importGuitarPro.js
   Guitar Pro (.gp, .gp3, .gp4, .gp5, .gpx) → CSMPN converter
   for Chord Sheet Maker Pro (index.html ecosystem).

   Architecture
   ─────────────
   • AlphaTab is loaded lazily from CDN on first call — 0 cost
     until the user actually opens a GP file.
   • All conversion logic is pure (no DOM, no globals beyond
     window.alphaTab after CDN load) so it can be tested with
     Node.js vm.runInContext and mocked AlphaTab stubs.
   • Exposes window.importGuitarProToCSMPN(bytes, opts) →
     Promise<string> and the inner pure helpers for testing.
============================================================ */

// ── AlphaTab CDN ──────────────────────────────────────────────────────────────

const _GP_AT_CDN =
  'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.1/dist/alphaTab.min.js';

let _gpAtInstance = null;
let _gpAtLoadPromise = null;

/**
 * Lazily load AlphaTab from CDN and return the namespace object.
 * Subsequent calls return the cached instance immediately.
 */
function _loadAlphaTab() {
  if (_gpAtInstance) return Promise.resolve(_gpAtInstance);
  if (_gpAtLoadPromise) return _gpAtLoadPromise;

  _gpAtLoadPromise = new Promise(function (resolve, reject) {
    // Already on window (e.g., another page loaded it)
    if (
      typeof window !== 'undefined' &&
      window.alphaTab &&
      (window.alphaTab.Settings || window.alphaTab.importer)
    ) {
      _gpAtInstance = window.alphaTab;
      resolve(_gpAtInstance);
      return;
    }

    var script = document.createElement('script');
    script.src = _GP_AT_CDN;
    script.crossOrigin = 'anonymous';
    script.onload = function () {
      var at = (typeof window !== 'undefined' && window.alphaTab) || null;
      if (!at) {
        reject(new Error('AlphaTab loaded but window.alphaTab not found. Try refreshing.'));
        return;
      }
      _gpAtInstance = at;
      resolve(at);
    };
    script.onerror = function () {
      _gpAtLoadPromise = null; // allow retry
      reject(
        new Error(
          'Failed to load Guitar Pro parser library from CDN. ' +
            'Check your internet connection and try again.'
        )
      );
    };
    document.head.appendChild(script);
  });

  return _gpAtLoadPromise;
}

/**
 * Attempt to parse a GP binary with AlphaTab, trying multiple known API shapes
 * across AlphaTab versions (1.x CDN UMD vs ESM-built bundle).
 */
function _loadScoreFromBytes(at, bytes) {
  var settings = null;
  // Settings constructor location varies across builds
  if (at.Settings) settings = new at.Settings();
  else if (at.model && at.model.Settings) settings = new at.model.Settings();
  else settings = {};

  // ScoreLoader location varies across builds
  if (at.importer && at.importer.ScoreLoader) {
    return at.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  }
  if (at.ScoreLoader) {
    return at.ScoreLoader.loadScoreFromBytes(bytes, settings);
  }
  throw new Error(
    'Guitar Pro parser library loaded but ScoreLoader API not found. ' +
      'The CDN version may be incompatible — please report this issue.'
  );
}

// ── Tuning / chord helpers ────────────────────────────────────────────────────

/** Standard 6-string guitar open-string MIDI notes (index 0 = high-e). */
var _STANDARD_TUNING = [64, 59, 55, 50, 45, 40];

var _CHORD_PATTERNS = [
  { suffix: '', intervals: [0, 4, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
  { suffix: '5', intervals: [0, 7] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'mM7', intervals: [0, 3, 7, 11] },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10] },
  { suffix: 'dim7', intervals: [0, 3, 6, 9] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: 'add9', intervals: [0, 2, 4, 7] },
  { suffix: '6', intervals: [0, 4, 7, 9] },
  { suffix: 'm6', intervals: [0, 3, 7, 9] },
  { suffix: '9', intervals: [0, 2, 4, 7, 10] },
  { suffix: '7sus4', intervals: [0, 5, 7, 10] },
  { suffix: 'aug7', intervals: [0, 4, 8, 10] },
  { suffix: '7b5', intervals: [0, 4, 6, 10] },
  { suffix: '7#9', intervals: [0, 3, 4, 7, 10] },
  { suffix: '7b9', intervals: [0, 1, 4, 7, 10] },
  { suffix: 'maj9', intervals: [0, 2, 4, 7, 11] },
  { suffix: 'm9', intervals: [0, 2, 3, 7, 10] },
  { suffix: '9sus4', intervals: [0, 2, 5, 7, 10] },
  { suffix: '6add9', intervals: [0, 2, 4, 7, 9] },
];

var _NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/**
 * Attempt to identify a chord name from fret/string positions.
 * @param {number[]} openMidi  Open-string MIDI notes (index 0 = highest string).
 * @param {{stringIndex:number, fret:number}[]} notes  Sounding notes.
 * @returns {string|null}
 */
function _fretsToChordName(openMidi, notes) {
  if (!notes || notes.length < 2) return null;
  var pcsSet = Object.create(null);
  var lowestMidi = Infinity;
  var lowestPc = 0;
  for (var i = 0; i < notes.length; i++) {
    var open = openMidi[notes[i].stringIndex];
    if (open !== undefined) {
      var midi = open + notes[i].fret;
      var pc = midi % 12;
      pcsSet[pc] = true;
      if (midi < lowestMidi) {
        lowestMidi = midi;
        lowestPc = pc;
      }
    }
  }
  var pcs = Object.keys(pcsSet).map(Number);
  if (pcs.length < 2) return null;

  for (var root = 0; root < 12; root++) {
    var intervals = pcs
      .map(function (pc) {
        return (pc - root + 12) % 12;
      })
      .sort(function (a, b) {
        return a - b;
      });

    for (var pi = 0; pi < _CHORD_PATTERNS.length; pi++) {
      var pat = _CHORD_PATTERNS[pi];
      var ps = pat.intervals.slice().sort(function (a, b) {
        return a - b;
      });
      if (
        intervals.length === ps.length &&
        intervals.every(function (v, idx) {
          return v === ps[idx];
        })
      ) {
        var name = _NOTE_NAMES[root] + pat.suffix;
        if (lowestPc !== root) name += '/' + _NOTE_NAMES[lowestPc];
        return name;
      }
    }
  }
  return null;
}

// ── Chord name normalization ──────────────────────────────────────────────────

/**
 * Normalize AlphaTab chord names to CSMPN-safe strings.
 * 1. Strips outer parentheses: "(Gm7)" → "Gm7"
 *    (prevents CSMPN repeat-group false-positive when the name appears in bar lines)
 * 2. Collapses parenthesized numeric-only extensions: "C7M(8)" → "C7M8"
 *    (prevents the hybrid token regex from failing on nested parens)
 */
function _normalizeGpChordName(name) {
  if (!name) return name;
  name = name.trim();
  // Strip outer parens: "(Gm7)" → "Gm7"
  name = name.replace(/^\(([^)]+)\)$/, '$1');
  // Collapse parenthesized numeric extensions: "C7M(8)" → "C7M8"
  name = name.replace(/\((\d+)\)/g, '$1');
  return name.trim();
}

// ── Key-signature mapping ─────────────────────────────────────────────────────

/** Maps AlphaTab keySignature integer (−7…+7) and keySignatureType (0=Maj,1=Min) to a key string. */
function _gpKeyToStr(keySig, keyType) {
  var isMinor = keyType === 1;
  var sharps = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  var flats = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
  var sharpMin = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
  var flatMin = ['Am', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'];
  var idx = Math.abs(keySig || 0);
  if ((keySig || 0) >= 0) {
    return isMinor ? (sharpMin[idx] || 'Am') : (sharps[idx] || 'C');
  }
  return isMinor ? (flatMin[idx] || 'Am') : (flats[idx] || 'C');
}

// ── Duration helpers ──────────────────────────────────────────────────────────

/**
 * AlphaTab Duration enum numeric values:
 *   Whole=1, Half=2, Quarter=4, Eighth=8, Sixteenth=16, ThirtySecond=32, SixtyFourth=64
 * Quarter-note count: 4 / durValue, adjusted for dots and optional tuplet ratio.
 * @param {number} durVal        AlphaTab duration integer
 * @param {number} dots          Dot count (0, 1, or 2)
 * @param {number} [tupletNum]   Tuplet numerator (e.g. 3 for triplet); omit or 1 = no tuplet
 * @param {number} [tupletDen]   Tuplet denominator (e.g. 2 for triplet)
 */
function _gpDurToQuarters(durVal, dots, tupletNum, tupletDen) {
  var base = 4 / (durVal > 0 ? durVal : 4);
  if (dots === 1) base *= 1.5;
  else if (dots === 2) base *= 1.75;
  if (typeof tupletNum === 'number' && tupletNum > 1 &&
      typeof tupletDen === 'number' && tupletDen > 0) {
    base *= (tupletDen / tupletNum);
  }
  return base;
}

function _gpDurToLetter(durVal) {
  if (durVal <= 1) return 'w';
  if (durVal <= 2) return 'h';
  if (durVal <= 4) return 'q';
  if (durVal <= 8) return 'e';
  return 's'; // 16th and shorter → smallest supported
}

/**
 * Convert a cumulative quarter-note offset within a measure to a
 * hybrid beat-position string: "1", "2", "1&", "3&", etc.
 */
function _cumQToHybridPos(cumQ) {
  var whole = Math.floor(cumQ);
  var frac = cumQ - whole;
  var beatNum = whole + 1;
  return frac >= 0.4 ? beatNum + '&' : String(beatNum);
}

// ── AlphaTab model accessors ──────────────────────────────────────────────────

function _beatsFromBar(bar) {
  if (!bar || !bar.voices) return [];
  var voices = Array.from ? Array.from(bar.voices) : [].slice.call(bar.voices);
  for (var i = 0; i < voices.length; i++) {
    var v = voices[i];
    if (!v.isEmpty && v.beats && v.beats.length > 0) {
      return Array.from ? Array.from(v.beats) : [].slice.call(v.beats);
    }
  }
  return [];
}

function _barsFromTrack(track) {
  var staff = track && track.staves && track.staves[0];
  if (!staff || !staff.bars) return [];
  return Array.from ? Array.from(staff.bars) : [].slice.call(staff.bars);
}

function _staffTuning(track) {
  var t = track && track.staves && track.staves[0] && track.staves[0].tuning;
  if (t && t.length > 0) return Array.from ? Array.from(t) : [].slice.call(t);
  return _STANDARD_TUNING.slice();
}

/** Select the track with the richest harmonic content (explicit chord annotations preferred). */
function _findChordTrack(tracks) {
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    if (track.isPercussion) continue;
    var score = 0;
    var bars = _barsFromTrack(track);
    for (var b = 0; b < bars.length; b++) {
      var beats = _beatsFromBar(bars[b]);
      for (var bt = 0; bt < beats.length; bt++) {
        var beat = beats[bt];
        if (beat && beat.chord && beat.chord.name) score += 2;
        var notes = beat && beat.notes ? (Array.from ? Array.from(beat.notes) : [].slice.call(beat.notes)) : [];
        var sounding = notes.filter(function (n) {
          return !n.isMute && !n.isDead && typeof n.fret === 'number';
        });
        if (sounding.length >= 3) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = track;
    }
  }
  return best || tracks.find(function (t) { return !t.isPercussion; }) || tracks[0];
}

/**
 * Extract a chord name from a single beat.
 * Priority: explicit annotation > fret-to-chord recognition.
 */
function _extractChord(beat, openMidi) {
  var explicit = beat && beat.chord && beat.chord.name;
  if (explicit) return _normalizeGpChordName(explicit) || null;

  var notes = beat && beat.notes ? (Array.from ? Array.from(beat.notes) : [].slice.call(beat.notes)) : [];
  var sounding = notes
    .filter(function (n) {
      return !n.isMute && !n.isDead && typeof n.fret === 'number';
    })
    .map(function (n) {
      return { stringIndex: n.string - 1, fret: n.fret };
    });

  if (sounding.length < 3) return null;
  return _fretsToChordName(openMidi, sounding);
}

/**
 * Extract a voicing string from a beat's chord frame.
 * Returns "fret1,fret2,fret3,fret4,fret5,fret6" (high-e first) or null.
 * Uses -1 / negative fret numbers to mean muted → rendered as "x".
 */
function _extractVoicing(beat, stringCount) {
  var chord = beat && beat.chord;
  if (!chord) return null;

  // AlphaTab Chord.strings: array indexed by string (0 = string 1 = high-e)
  var strings = chord.strings;
  if (!strings || !strings.length) return null;

  var n = Math.min(strings.length, stringCount || 6);
  var parts = [];
  var hasPlayable = false;
  for (var i = 0; i < n; i++) {
    var fret = strings[i];
    if (fret === null || fret === undefined || fret < 0) {
      parts.push('x');
    } else {
      parts.push(String(fret));
      hasPlayable = true;
    }
  }
  // Pad to 6 strings if short
  while (parts.length < 6) parts.push('x');
  return hasPlayable ? parts.join(',') : null;
}

// ── CSMPN builder ─────────────────────────────────────────────────────────────

/**
 * Main conversion: AlphaTab score object → CSMPN text string.
 *
 * @param {object} score  Decoded AlphaTab score
 * @param {object} opts
 *   barsPerRow  {number}  Bars per row (default 4)
 *   includeTab  {boolean} Emit {tab} voicing blocks (default true)
 *   includeHybrid {boolean} Emit {hybrid} rhythm blocks (default true)
 * @returns {string}  CSMPN text
 */
function _buildCsmpnFromScore(score, opts) {
  opts = opts || {};
  var barsPerRow = (opts.barsPerRow > 0 ? Math.floor(opts.barsPerRow) : 4);
  var includeTab = opts.includeTab !== false;
  var includeHybrid = opts.includeHybrid !== false;

  var tracks = score.tracks ? (Array.from ? Array.from(score.tracks) : [].slice.call(score.tracks)) : [];
  var masterBars = score.masterBars ? (Array.from ? Array.from(score.masterBars) : [].slice.call(score.masterBars)) : [];

  if (!tracks.length || !masterBars.length) return '';

  var chordTrack = _findChordTrack(tracks);
  var openMidi = _staffTuning(chordTrack);
  var stringCount = openMidi.length;
  var chordBars = _barsFromTrack(chordTrack);

  // ── Per-measure data collection ──────────────────────────────────────────

  // voicings: Map<chordName → voicingString> (first seen wins)
  var voicings = Object.create(null);

  var measures = []; // [{barContent, hybridLines, sectionText, timeSigNum}]

  var prevChordGlobal = null;

  for (var mi = 0; mi < chordBars.length && mi < masterBars.length; mi++) {
    var mb = masterBars[mi];
    var beats = _beatsFromBar(chordBars[mi]);

    var timeSigNum = (mb && mb.timeSignatureNumerator) || 4;
    var sectionText = mb && mb.section && mb.section.text
      ? mb.section.text.trim()
      : null;

    // Collect chord changes within this bar
    var barChords = [];
    var lastChordInBar = prevChordGlobal;

    // Collect hybrid events
    var hybridParts = [];
    var cumQ = 0;
    var hybridChordActive = null;
    // Track emitted half-beat positions so 16th notes don't generate duplicates.
    // The hybrid system has 8th-note (half-beat) resolution; finer durations
    // from GP files collapse onto the same slot and must be deduplicated.
    var seenHybridPos = Object.create(null);

    for (var bi = 0; bi < beats.length; bi++) {
      var beat = beats[bi];
      var chord = _extractChord(beat, openMidi);
      var durVal = (beat && beat.duration) || 4;
      var dots = (beat && beat.dots) || 0;
      // AlphaTab tupletNumerator/tupletDenominator default to -1 when not a tuplet.
      // > 0 check safely handles both -1 (no tuplet) and 0 (invalid) cases.
      var tupletNum = (beat && beat.tupletNumerator > 0) ? beat.tupletNumerator : 1;
      var tupletDen = (beat && beat.tupletDenominator > 0) ? beat.tupletDenominator : 1;
      var quarters = _gpDurToQuarters(durVal, dots, tupletNum, tupletDen);
      var isRest = !!(beat && beat.isRest);

      // Collect voicing
      if (chord && !voicings[chord]) {
        var v = _extractVoicing(beat, stringCount);
        if (v) voicings[chord] = v;
      }

      // Bar chord-change tracking (for CSMPN bar content)
      if (chord && chord !== lastChordInBar) {
        barChords.push(chord);
        lastChordInBar = chord;
      }

      // Hybrid event generation
      var pos = _cumQToHybridPos(cumQ);
      var durLetter = _gpDurToLetter(durVal);
      // Append tN flag so the renderer can draw tuplet brackets (e.g. t3 for triplet).
      var tupletFlag = (tupletNum > 1) ? 't' + tupletNum : '';

      if (!seenHybridPos[pos]) {
        if (isRest) {
          hybridParts.push(pos + ':r' + durLetter + tupletFlag);
          seenHybridPos[pos] = true;
        } else {
          var chordChanged = chord && chord !== hybridChordActive;
          if (chordChanged) {
            hybridParts.push(pos + ':' + durLetter + '(' + chord + ')' + tupletFlag);
            hybridChordActive = chord;
            seenHybridPos[pos] = true;
          } else if (chord) {
            hybridParts.push(pos + ':' + durLetter + tupletFlag);
            seenHybridPos[pos] = true;
          }
        }
      }

      cumQ += quarters;
    }

    // Bar content: chord symbols for this bar
    var barContent;
    if (barChords.length === 0) {
      barContent = prevChordGlobal ? '%' : 'N.C.';
    } else {
      barContent = barChords.join(' ');
      prevChordGlobal = barChords[barChords.length - 1];
    }

    measures.push({
      barContent: barContent,
      hybridLine: hybridParts.length > 0 ? hybridParts.join(' ') : '',
      sectionText: sectionText,
      timeSigNum: timeSigNum,
      repeatStart: !!(mb && mb.isRepeatStart),
      repeatEnd: !!(mb && mb.isRepeatEnd),
      // alternateEndings bitmask: bit 0 = 1st volta, bit 1 = 2nd volta, etc.
      alternateEndings: (mb && mb.alternateEndings) || 0,
    });
  }

  // ── Section grouping ──────────────────────────────────────────────────────

  // Build section boundary map
  var sectionStarts = Object.create(null); // mi → sectionLabel
  for (var si = 0; si < measures.length; si++) {
    if (measures[si].sectionText) sectionStarts[si] = measures[si].sectionText;
  }
  if (!sectionStarts[0]) sectionStarts[0] = 'Main';

  // Group measures into sections
  var sections = []; // [{label, measures[]}]
  var curSection = null;

  for (var mi2 = 0; mi2 < measures.length; mi2++) {
    if (sectionStarts[mi2] !== undefined) {
      if (curSection) sections.push(curSection);
      curSection = { label: sectionStarts[mi2], measures: [] };
    }
    if (curSection) curSection.measures.push(measures[mi2]);
  }
  if (curSection && curSection.measures.length) sections.push(curSection);

  // ── Header ────────────────────────────────────────────────────────────────

  var lines = [];
  var title = ((score.title || '').trim());
  var artist = ((score.artist || score.composer || '').trim());
  var tempo = (typeof score.tempo === 'number' ? score.tempo : 0);

  // Key from first masterBar
  var keyStr = 'C';
  var timeStr = '4/4';
  if (masterBars.length > 0) {
    var mb0 = masterBars[0];
    if (typeof mb0.keySignature === 'number') {
      keyStr = _gpKeyToStr(mb0.keySignature, mb0.keySignatureType || 0);
    }
    if (mb0.timeSignatureNumerator && mb0.timeSignatureDenominator) {
      timeStr = mb0.timeSignatureNumerator + '/' + mb0.timeSignatureDenominator;
    }
  }

  if (title) lines.push('Title: ' + title);
  if (artist) lines.push('Composer: ' + artist);
  lines.push('Key: ' + keyStr);
  lines.push('Time: ' + timeStr);
  if (tempo > 0) lines.push('Tempo: ' + tempo);
  lines.push('');

  // ── Per-section output ────────────────────────────────────────────────────

  for (var secIdx = 0; secIdx < sections.length; secIdx++) {
    var sec = sections[secIdx];
    lines.push(': ' + sec.label);

    // ── Repeat-aware bar-content rows ──────────────────────────────────────
    // Rows break at barsPerRow, at repeat-start boundaries, and after repeat-end
    // bars so that |: and :| never share a line ambiguously.
    var secMeasures = sec.measures;
    var rowGroups = [];
    var curRowGrp = [];
    for (var rmi = 0; rmi < secMeasures.length; rmi++) {
      var rm = secMeasures[rmi];
      if (rm.repeatStart && curRowGrp.length > 0) {
        rowGroups.push(curRowGrp);
        curRowGrp = [];
      }
      curRowGrp.push(rm);
      if (rm.repeatEnd || curRowGrp.length >= barsPerRow) {
        rowGroups.push(curRowGrp);
        curRowGrp = [];
      }
    }
    if (curRowGrp.length > 0) rowGroups.push(curRowGrp);

    for (var rgi = 0; rgi < rowGroups.length; rgi++) {
      var rg = rowGroups[rgi];
      var rowParts = [];
      for (var rpi = 0; rpi < rg.length; rpi++) {
        var rm2 = rg[rpi];
        var leftBar = rm2.repeatStart ? '|:' : '|';
        // Volta ending prefix: "1. " or "2. " (CSMPN token before the chord)
        var voltaPfx = (rm2.alternateEndings & 1) ? '1. ' :
                       (rm2.alternateEndings & 2) ? '2. ' : '';
        rowParts.push(leftBar + ' ' + voltaPfx + rm2.barContent);
      }
      var lastRM = rg[rg.length - 1];
      var trailingBar = lastRM.repeatEnd ? ' :|' : ' |';
      lines.push(rowParts.join(' ') + trailingBar);
    }

    // {tab} voicing block — collect unique chords used in this section
    if (includeTab) {
      var tabLines = [];
      var seenInSec = Object.create(null);
      for (var mi3 = 0; mi3 < secMeasures.length; mi3++) {
        var bc = secMeasures[mi3].barContent;
        if (bc === '%' || bc === 'N.C.') continue;
        var chords = bc.split(/\s+/);
        for (var ci = 0; ci < chords.length; ci++) {
          var ch = chords[ci];
          if (ch && voicings[ch] && !seenInSec[ch]) {
            seenInSec[ch] = true;
            tabLines.push('  ' + ch + ': ' + voicings[ch]);
          }
        }
      }
      if (tabLines.length > 0) {
        lines.push('{tab');
        for (var ti = 0; ti < tabLines.length; ti++) lines.push(tabLines[ti]);
        lines.push('}');
      }
    }

    // {hybrid} block — one barN: entry per measure
    if (includeHybrid) {
      var hybridBodyLines = [];
      for (var mi4 = 0; mi4 < secMeasures.length; mi4++) {
        var hl = secMeasures[mi4].hybridLine;
        if (hl) {
          hybridBodyLines.push('  bar' + (mi4 + 1) + ': ' + hl);
        }
      }
      if (hybridBodyLines.length > 0) {
        lines.push('{hybrid');
        for (var hi = 0; hi < hybridBodyLines.length; hi++) lines.push(hybridBodyLines[hi]);
        lines.push('}');
      }
    }

    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert Guitar Pro file bytes to CSMPN text.
 * Lazily loads AlphaTab from CDN on first call.
 *
 * @param {Uint8Array|ArrayBuffer} input   Raw GP file bytes
 * @param {object}                 [opts]  Options passed to _buildCsmpnFromScore
 * @returns {Promise<string>}              CSMPN text
 */
async function importGuitarProToCSMPN(input, opts) {
  var at = await _loadAlphaTab();
  var bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  var score = _loadScoreFromBytes(at, bytes);
  return _buildCsmpnFromScore(score, opts || {});
}

// Expose on window for index.html
if (typeof window !== 'undefined') {
  window.importGuitarProToCSMPN = importGuitarProToCSMPN;

  /**
   * Render GP / Power Tab notation into a DOM container using AlphaTab's
   * native rendering engine.  Returns a Promise<AlphaTabApi>.
   *
   * opts:
   *   staveProfile  1=ScoreTab (default), 2=Score, 3=Tab
   *   layoutMode    0=Page (default), 1=Horizontal
   */
  window.renderGpNotation = async function renderGpNotation(container, bytes, opts) {
    var at = await _loadAlphaTab();
    var o  = opts || {};

    // Build settings — handle varied API shapes across AlphaTab builds
    var settings;
    if      (at.Settings)               settings = new at.Settings();
    else if (at.model && at.model.Settings) settings = new at.model.Settings();
    else                                settings = {};

    if (settings.core) {
      // Disable workers — required for inline use without a separate worker file
      settings.core.useWorkers = false;
      // Point font + script to the CDN so SMuFL fonts load correctly on iOS
      settings.core.fontDirectory =
        'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.1/dist/font/';
      settings.core.scriptFile = _GP_AT_CDN;
    }

    if (settings.display) {
      settings.display.staveProfile = o.staveProfile !== undefined ? o.staveProfile : 1;
      settings.display.layoutMode   = o.layoutMode   !== undefined ? o.layoutMode   : 0;
    }

    var Api = at.AlphaTabApi || (at.model && at.model.AlphaTabApi);
    if (!Api) throw new Error('AlphaTabApi not found in this AlphaTab build — try refreshing.');

    var api  = new Api(container, settings);
    var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    api.load(data);
    return api;
  };
}

// Expose pure helpers for Node.js vm.runInContext tests
// (The vm context will see these as globals since the script runs in context scope)
var _GP_TEST_EXPORTS = {
  _gpKeyToStr: _gpKeyToStr,
  _fretsToChordName: _fretsToChordName,
  _buildCsmpnFromScore: _buildCsmpnFromScore,
  _extractVoicing: _extractVoicing,
  _cumQToHybridPos: _cumQToHybridPos,
  _gpDurToQuarters: _gpDurToQuarters,
  _gpDurToLetter: _gpDurToLetter,
  _normalizeGpChordName: _normalizeGpChordName,
};

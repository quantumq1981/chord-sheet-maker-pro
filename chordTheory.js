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

  var api = { NOTE_NAMES: NOTE_NAMES, CHORD_PATTERNS: CHORD_PATTERNS };
  if (typeof window !== 'undefined') window.ChordTheory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

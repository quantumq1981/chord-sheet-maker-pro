/* ============================================================================
 *  TAB DECODER · TabTranslator Pro — RECOGNITION ENGINE (pure module)
 *
 *  Extracted verbatim from TabDecoderPro.tsx (Roadmap Wave 1 #1). This file is
 *  pure ES — zero React, zero browser globals (the only browser seam,
 *  extractTokens via window.pdfjsLib, stays in the UI file). That purity is what
 *  lets the headless harness import it directly in Node AND lets a Web Worker
 *  run the full "raw bytes -> score" pipeline off the main thread (Wave 1 #3).
 *
 *  DO NOT add React/DOM/browser dependencies here. See CLAUDE.md invariants.
 * ==========================================================================*/

/* ---- bit helpers --------------------------------------------------------- */
const makeMask = (intervals) => intervals.reduce((m, i) => m | (1 << (i % 12)), 0);
const popcount = (n) => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
const rotateRight = (mask, r) => ((mask >> r) | (mask << (12 - r))) & 0xfff; // root r → bit 0
const toBinary12 = (mask) => mask.toString(2).padStart(12, "0");

/* ---- static data stores -------------------------------------------------- */
const TUNINGS = {
  Standard: [40, 45, 50, 55, 59, 64], // E2 A2 D3 G3 B3 E4  (index 0 = lowest)
  "Drop D": [38, 45, 50, 55, 59, 64], // D2 A2 D3 G3 B3 E4
};
// Family enharmonic DEFAULT (always): Bb, C#, Eb, F#, Ab — never A#/Db/D#/Gb/G#.
// This is the default spelling (useSharp=true); NOTE_FLAT is the explicit all-flats override.
const NOTE_SHARP = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const NOTE_FLAT  = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const INTERVAL_LABELS = ["R", "♭2", "2", "♭3", "3", "4", "♭5", "5", "♭6", "6", "♭7", "7"];

const QUALITIES = [
  { name: "Power chord",    suffix: "5",     intervals: [0, 7],        rank: 6 },
  { name: "Major",          suffix: "",      intervals: [0, 4, 7],     rank: 0 },
  { name: "Minor",          suffix: "m",     intervals: [0, 3, 7],     rank: 1 },
  { name: "Diminished",     suffix: "dim",   intervals: [0, 3, 6],     rank: 7 },
  { name: "Augmented",      suffix: "aug",   intervals: [0, 4, 8],     rank: 8 },
  { name: "Sus2",           suffix: "sus2",  intervals: [0, 2, 7],     rank: 5 },
  { name: "Sus4",           suffix: "sus4",  intervals: [0, 5, 7],     rank: 4 },
  { name: "Major 6th",      suffix: "6",     intervals: [0, 4, 7, 9],  rank: 9 },
  { name: "Minor 6th",      suffix: "m6",    intervals: [0, 3, 7, 9],  rank: 10 },
  { name: "Dominant 7th",   suffix: "7",     intervals: [0, 4, 7, 10], rank: 2 },
  { name: "Major 7th",      suffix: "maj7",  intervals: [0, 4, 7, 11], rank: 11 },
  { name: "Minor 7th",      suffix: "m7",    intervals: [0, 3, 7, 10], rank: 3 },
  { name: "Half-dim 7th",   suffix: "m7♭5",  intervals: [0, 3, 6, 10], rank: 12 },
  { name: "Diminished 7th", suffix: "dim7",  intervals: [0, 3, 6, 9],  rank: 13 },
  { name: "7sus4",          suffix: "7sus4", intervals: [0, 5, 7, 10], rank: 14 },
  // Extended/altered qualities (rank high = uncommon → never win a ranking tie over
  // a plainer chord; they only win when they genuinely fit MORE of the voicing).
  { name: "Add 9",          suffix: "add9",  intervals: [0, 2, 4, 7],      rank: 15 },
  { name: "Minor-major 7",  suffix: "m(maj7)", intervals: [0, 3, 7, 11],   rank: 16 },
  { name: "6/9",            suffix: "6/9",   intervals: [0, 2, 4, 7, 9],   rank: 17 },
  { name: "Dominant 9th",   suffix: "9",     intervals: [0, 2, 4, 7, 10],  rank: 18 },
  { name: "Minor 9th",      suffix: "m9",    intervals: [0, 2, 3, 7, 10],  rank: 19 },
  { name: "Major 9th",      suffix: "maj9",  intervals: [0, 2, 4, 7, 11],  rank: 20 },
  { name: "7♭9",            suffix: "7♭9",   intervals: [0, 1, 4, 7, 10],  rank: 21 },
  { name: "7♯9",            suffix: "7♯9",   intervals: [0, 3, 4, 7, 10],  rank: 22 },
].map((q) => ({ ...q, mask: makeMask(q.intervals) }));

const PRESETS = [
  { label: "C major",        tuning: "Standard", tab: "e|-0-|\nB|-1-|\nG|-0-|\nD|-2-|\nA|-3-|\nE|-x-|" },
  { label: "G major",        tuning: "Standard", tab: "e|-3-|\nB|-0-|\nG|-0-|\nD|-0-|\nA|-2-|\nE|-3-|" },
  { label: "A minor",        tuning: "Standard", tab: "e|-0-|\nB|-1-|\nG|-2-|\nD|-2-|\nA|-0-|\nE|-x-|" },
  { label: "E minor",        tuning: "Standard", tab: "e|-0-|\nB|-0-|\nG|-0-|\nD|-2-|\nA|-2-|\nE|-0-|" },
  { label: "F (barre)",      tuning: "Standard", tab: "e|-1-|\nB|-1-|\nG|-2-|\nD|-3-|\nA|-3-|\nE|-1-|" },
  { label: "C/E (slash)",    tuning: "Standard", tab: "e|-0-|\nB|-1-|\nG|-0-|\nD|-2-|\nA|-3-|\nE|-0-|" },
  { label: "D/F# (slash)",   tuning: "Standard", tab: "e|-2-|\nB|-3-|\nG|-2-|\nD|-0-|\nA|-0-|\nE|-2-|" },
  { label: "Asus4",          tuning: "Standard", tab: "e|-0-|\nB|-3-|\nG|-2-|\nD|-2-|\nA|-0-|\nE|-x-|" },
  { label: "Dm7",            tuning: "Standard", tab: "e|-1-|\nB|-1-|\nG|-2-|\nD|-0-|\nA|-x-|\nE|-x-|" },
  { label: "G7",             tuning: "Standard", tab: "e|-1-|\nB|-0-|\nG|-0-|\nD|-0-|\nA|-2-|\nE|-3-|" },
  { label: "Cmaj7 (no 5th)", tuning: "Standard", tab: "e|-0-|\nB|-0-|\nG|-x-|\nD|-2-|\nA|-3-|\nE|-x-|" },
  { label: "D5 (Drop D)",    tuning: "Drop D",   tab: "e|----|\nB|----|\nG|----|\nD|--0-|\nA|--0-|\nD|--0-|" },
];

/* ---- ASCII tab parser (manual mode) -------------------------------------- */
function parseTab(text) {
  const raw = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const stringLines = raw.filter((l) => /[-x|0-9]/i.test(l)).slice(0, 6);
  if (stringLines.length === 0) return { strings: [], blocks: [] };
  const stripped = stringLines.map((l) => {
    const m = l.match(/^\s*[a-gA-G][#b]?\d?\s*\|?(.*)$/);
    return m ? m[1] : l.replace(/^\|/, "");
  });
  const n = stripped.length;
  const events = [];
  const strings = [];
  stripped.forEach((content, k) => {
    const stringIndex = n - 1 - k; // top line = highest string
    strings.push({ idx: stringIndex, content: stringLines[k] });
    for (let i = 0; i < content.length; i++) {
      if (/[0-9]/.test(content[i])) {
        let num = content[i], j = i + 1;
        while (j < content.length && /[0-9]/.test(content[j])) { num += content[j]; j++; }
        events.push({ stringIndex, col: i, fret: parseInt(num, 10) });
        i = j - 1;
      }
    }
  });
  const TOL = 1;
  events.sort((a, b) => a.col - b.col);
  const blocks = [];
  let cur = null;
  for (const ev of events) {
    if (!cur || ev.col > cur.anchor + TOL) { cur = { anchor: ev.col, col: ev.col, notes: [] }; blocks.push(cur); }
    if (!cur.notes.some((nN) => nN.stringIndex === ev.stringIndex)) cur.notes.push({ stringIndex: ev.stringIndex, fret: ev.fret });
  }
  return { strings, blocks: blocks.map(({ col, notes }) => ({ col, notes })) };
}

/* ---- engine core --------------------------------------------------------- */
function fretToMidi(block, tuningArr, capo, useSharp) {
  return block.notes
    .map(({ stringIndex, fret }) => {
      const open = tuningArr[stringIndex];
      if (open === undefined) return null;
      const midi = open + capo + fret;
      return { stringIndex, fret, midi, name: (useSharp ? NOTE_SHARP : NOTE_FLAT)[midi % 12] };
    })
    .filter(Boolean)
    .sort((a, b) => a.midi - b.midi);
}
function normalise(notes) {
  if (notes.length === 0) return { chroma: [], chordMask: 0, bassPc: null, bassMidi: null };
  const bassMidi = notes[0].midi;
  const chroma = [...new Set(notes.map((nN) => nN.midi % 12))].sort((a, b) => a - b);
  return { chroma, chordMask: makeMask(chroma), bassPc: bassMidi % 12, bassMidi };
}
function recognise(chroma, chordMask, bassPc, opts = {}) {
  if (chroma.length === 0) return null;
  if (chroma.length === 1) return { roots: chroma[0], single: true, candidates: [], bassPc };
  const candidates = [];
  for (const root of chroma) {
    const transposed = rotateRight(chordMask, root);
    for (const q of QUALITIES) {
      // Opt-in: cap chord complexity by `rank` (basic triads/7ths/6/sus ≤14, jazz
      // extensions add9/9/m9/maj9/6-9/7♭9/7♯9/m(maj7) ≥15). DEFAULT is undefined → no
      // filtering, so the oracle stays byte-identical for tab/PDF/GP/XML recognition;
      // only the audio path opts in (polyphonic vocal/instrument chroma over-labels
      // extensions — the 3 voices light 4+ pcs, so the scorer reaches for a 9th).
      if (opts.maxRank != null && q.rank > opts.maxRank) continue;
      const inter = popcount(transposed & q.mask);
      const extra = popcount(transposed & ~q.mask & 0xfff);
      const missing = popcount(q.mask & ~transposed & 0xfff);
      const score = inter - 0.8 * extra - 1.2 * missing;       // ranking
      const confidence = inter / (inter + extra + missing);    // displayed (Jaccard)
      candidates.push({ root, quality: q, transposed, inter, extra, missing, score, confidence });
    }
  }
  candidates.sort((a, b) => (b.score - a.score) || (a.quality.rank - b.quality.rank));
  const best = candidates[0];
  return { best, candidates: candidates.slice(0, 4), isSlash: bassPc !== null && best.root !== bassPc, bassPc };
}
/* ============================================================================
 *  Wave 3 #10 — chord-QUALITY classifier ("confidence-gated second opinion")
 *  ---------------------------------------------------------------------------
 *  The rule-based engine (`recognise`/`QUALITIES`) is the ORACLE and the test
 *  oracle — it is deterministic and near-optimal on a binary pitch-class SET. A
 *  classifier earns its keep only on a *weighted / noisy* chroma (duration-
 *  weighted, partial/missing tones) — the engine's honest limits. So this is a
 *  small 2-layer MLP "brain" (tanh hidden, softmax out) over the 22 engine qualities.
 *
 *  WHY pure-JS matmul, not onnxruntime-web: GitHub Pages can't set COOP/COEP, so
 *  WASM threads (SharedArrayBuffer) are unavailable; and the net is tiny, so it
 *  needs no runtime at all. This forward pass is identical in interface to an
 *  ONNX tensor pass (`x[12] → {quality, confidence}`), so a real `.onnx` of the
 *  same shape swaps in later by replacing ONLY the body of `classifyChromaQuality`
 *  — the arbiter contract, the tests and the worker boundary stay unchanged.
 *  Weights are code-gen'd by `scripts/train_chord_classifier.py` (dependency-free,
 *  reproducible, seed 11; 22-class MLP, ~85% held-out / 22-of-22 canonical).
 *  Embedded (not a fetched asset) BECAUSE it is tiny and that keeps it offline-
 *  robust on iOS — the "fetch the asset" rule is for the heavy future .onnx. */
const CHORD_CLASSIFIER = {
  classes: ["", "m", "7", "maj7", "m7", "dim", "aug", "sus4", "sus2", "6", "m6", "m7♭5", "dim7", "7sus4", "add9", "m(maj7)", "6/9", "9", "m9", "maj9", "7♭9", "7♯9"],  // engine QUALITIES suffixes ("" = major)
  arch: "mlp", hidden: 28, norm: "max",
  b1: [1.05891, -0.42684, 1.56746, 0.41673, 0.35762, -0.06417, 0.1537, 0.89483, 1.00366, -0.399, 1.2446, 0.08282, 0.50045, -0.05597, 0.04847, -0.28273, 0.32245, -0.58702, -0.96056, -0.04952, 0.42632, -0.72939, 0.87809, 0.09684, -1.42624, 0.12855, 0.92251, -1.41031],
  W1: [
    [0.15412, 0.51277, -0.12164, -0.81559, -0.14746, -0.51743, -0.66249, 0.21361, -0.27515, 1.12651, -1.23708, -1.83579],
    [-0.0542, 0.51937, 0.56523, -1.36309, 1.47683, 1.47966, 0.12808, -0.00101, -0.17675, -0.36283, 0.33131, -0.69494],
    [0.77841, -0.23079, -1.03581, -0.37094, -1.18138, -0.08912, 0.93966, -0.69763, -0.47785, 0.20149, -1.76665, -0.65802],
    [0.59089, 0.95842, 0.0116, 0.12202, -1.15283, 1.01091, -0.30774, -0.59703, 0.25179, -1.2828, 1.62687, -0.83628],
    [-0.02209, 1.09485, -2.30088, -0.66263, 1.50738, 0.44299, -0.01302, -0.19449, 0.91241, 0.1418, 0.63635, -0.85262],
    [-0.64363, 0.23158, 1.62866, 1.39461, -0.72338, -0.81314, 0.2068, -0.28201, 0.31145, 0.04206, 0.47006, -0.86686],
    [0.01189, 0.16517, -0.4814, 0.80441, 0.48644, -1.43666, -0.55014, -0.01623, 0.64416, 0.70638, -1.24645, 0.20698],
    [0.26541, -1.00403, 0.34951, 0.14814, -1.37291, 0.88518, -0.62424, -0.37226, -0.24238, -0.64328, -0.82951, -1.32775],
    [0.23735, 0.17241, -0.55575, 0.42282, -0.65685, -0.51352, 1.55376, -2.25227, 0.70299, 0.26723, -1.31676, -0.79533],
    [-0.15666, -0.43283, -0.6775, -0.68997, 1.56567, -0.37175, -1.18133, 0.86619, 0.29489, 0.68364, -0.41701, -0.84216],
    [0.24052, 0.55856, -0.74946, -0.95662, -0.28976, 0.99312, 0.75625, -0.5732, -0.51435, -0.24591, -0.82478, -0.40696],
    [0.02514, 0.83002, 1.20938, -1.33837, 1.32567, -1.03718, -1.45391, 0.37382, 0.31147, -0.5754, -0.23747, -1.02433],
    [-0.44944, -0.71622, -0.14915, 1.10622, 0.65553, -1.33916, 0.11015, -0.08639, -0.54909, -1.9275, -0.63636, 1.14969],
    [-0.41024, 1.15489, -1.37144, 0.31151, -0.77374, 0.8105, -0.8734, 1.26887, -0.36465, -0.71343, 0.76593, 0.43664],
    [-0.03124, 0.754, 1.00119, -0.09274, -0.49135, -0.62757, 0.62188, 0.61463, -0.93897, 0.17765, 0.21995, -0.09988],
    [-0.27197, 0.30368, 0.40397, -0.73844, -1.0528, 0.55017, 1.01947, -0.41168, -0.5349, -0.69373, 1.60583, -0.7833],
    [0.02181, -0.47176, -0.83714, 1.30091, -1.03471, 0.86622, 0.02058, -0.56581, -0.0654, 0.18864, 0.88164, -0.63368],
    [-0.7064, -0.11854, -0.04699, 1.49906, -0.69693, -0.32123, 0.59363, -0.03818, -0.64704, 2.86057, -0.27464, -0.0537],
    [-0.31694, -0.71155, 0.72142, 0.84782, 1.01844, -0.87393, 0.43696, 0.86892, -0.88125, 1.38051, 0.49815, -0.69174],
    [-0.01382, 0.67777, -0.03464, -0.97469, 0.70417, 0.3213, -0.70984, -0.42267, 1.08863, -1.36858, 0.14531, 1.10782],
    [0.49198, -0.56336, 0.25929, -1.8575, 0.61568, -0.79322, 0.36858, -0.015, 0.11674, 1.43611, -1.37859, 0.82725],
    [-0.15318, -1.78619, 0.57661, -0.45087, 0.83063, -0.70621, 0.03435, 0.57951, 0.07438, 0.00295, 1.16202, 1.22329],
    [0.30019, -0.43565, -0.61754, -0.19028, -0.86593, -0.1873, -0.15621, -0.54698, 0.02642, -0.4467, 0.99637, -0.5257],
    [-0.4121, 1.02108, -2.12074, 1.19562, 0.64875, -1.31808, 1.04986, 0.1172, 0.24375, -1.11749, 0.74018, 0.17122],
    [-0.3219, 0.87576, 0.67643, 0.48102, 0.41667, 0.38543, 0.93188, -0.26878, 1.6109, 1.33924, 1.32975, -0.55052],
    [0.08155, 0.1024, 0.90669, 0.92995, -0.49089, 0.53982, -1.19627, 1.00147, 0.36338, -0.5486, -0.22255, -0.50089],
    [0.29386, 0.3767, -0.68813, -0.15044, 0.2541, -1.27344, 0.77315, -1.14333, 0.49959, 0.07435, -1.53211, 0.69221],
    [-0.19817, 1.21432, 1.4051, -0.18785, 0.18327, 0.76475, 1.76115, 0.11766, -0.06656, 0.67321, -0.34298, 1.14284],
  ],
  b2: [0.31936, 0.48452, 0.62499, 0.14449, 0.07051, 0.62964, 0.28149, 0.12443, 0.49597, -0.51867, 0.17148, -0.19682, -0.34183, -0.12081, -0.20824, -0.0572, -0.18938, -0.40323, -0.48712, -0.13909, -0.51537, -0.16912],
  W2: [
    [0.70168, 0.22956, 0.68389, -0.37751, 0.2442, -0.76273, 0.0565, 0.37442, 0.24212, 0.58492, 0.5445, 1.13246, 1.31544, -0.26669, -0.16043, -0.60659, -0.67551, -0.97119, 0.03881, 0.13923, 1.12189, -0.05245, 0.13539, -0.62584, -0.9338, -0.62375, 0.55829, -0.8816],
    [0.97262, -0.59494, 0.40973, 0.40085, -1.044, 0.71115, 0.54548, 1.15887, 0.13694, -0.04033, -0.25087, 0.37157, 0.61285, 0.40137, 0.34739, -0.47917, 0.27156, 0.09509, -0.5279, -0.53544, -0.60464, -0.7812, 0.36454, 0.68721, -1.46919, 0.74354, -0.52876, -1.81824],
    [-0.12317, 0.62988, -0.87181, 0.29124, 0.80485, -0.4699, -0.96552, -0.38911, -1.22887, 0.69128, -0.41881, 1.26335, 0.1014, -0.23192, 0.24337, 0.65395, 0.00321, -1.1427, -0.23054, 0.79398, -0.12889, 0.89221, 0.75363, -0.57912, -0.43551, -0.7655, -0.60469, -1.16021],
    [-0.83532, -0.36418, 0.2974, -1.45989, -0.2858, -0.80266, 0.17357, -1.07624, -0.40929, 0.25293, 0.08594, -0.16904, 1.51666, 0.23078, -0.34306, -0.46261, -0.61401, -0.88826, -0.61484, 0.74253, 0.88842, 0.70223, -0.23462, 1.0059, -0.70638, -0.56753, 0.89446, 0.39236],
    [-0.1047, -0.38536, -0.62504, 0.42323, -0.74433, 0.42056, -0.43682, 0.7812, -0.91797, -0.36475, -0.13104, -1.14631, 0.09084, 1.46204, -0.08851, 0.83317, 1.21337, -0.05979, -0.24467, -0.63397, -1.26469, -0.47471, 0.42894, 0.8906, -0.38834, 0.56178, -1.16223, -1.30242],
    [0.2198, 0.11582, 1.00441, 1.14452, 0.96022, 0.38712, 0.12857, 0.46933, 1.954, -1.05797, 0.73981, -0.57801, 0.60489, -0.3533, 0.02878, 0.47352, 0.38088, 0.54045, 0.01103, -0.38332, -0.4284, -1.2158, 0.73148, 1.34406, -0.02141, -0.5062, 1.2868, 0.4823],
    [0.16457, -0.34149, 0.4749, 0.48345, 1.22452, 0.09343, 1.06368, 0.31649, 1.27829, 0.35749, -0.05415, 0.69422, -0.1914, -1.1778, -1.93815, -0.70635, 0.10147, -1.08934, -1.29294, 1.274, 0.61032, -0.13101, 0.62108, 0.61467, 0.91102, -0.32841, 1.15162, -0.98881],
    [0.56467, 0.8652, 1.00432, 0.09886, 0.09717, -1.02525, -0.41043, 1.20224, 0.37077, 0.2474, 1.40743, -0.90106, -1.02762, 0.29714, -0.69442, -0.01644, 0.58169, -0.25824, -1.47045, 0.33005, 0.20482, -1.21066, 0.01551, -2.12192, -1.06403, 0.56527, -0.19276, -0.19554],
    [1.2608, -0.54672, 0.2782, 0.73043, -1.27221, 0.81671, -0.32153, 0.99406, 0.36636, -0.54208, 0.39599, 0.66452, -0.59275, -0.45567, 0.78578, 0.31927, -0.55474, -0.5308, -0.18642, -0.62179, 0.75371, -0.37657, 0.23616, -1.61839, -1.03422, 0.54807, 0.31814, -0.17521],
    [0.96714, -0.05833, 1.0835, -1.53346, 1.30899, -0.84825, 0.93124, -0.76627, 0.13174, 1.33253, 0.72228, 0.38721, -0.64677, -0.18331, -0.32838, -0.6112, -0.46856, 1.5183, 0.22776, 0.11254, 0.93853, -0.11817, -0.55029, -0.8348, -0.30459, -0.52314, 0.88496, 0.22939],
    [1.12694, -1.47571, 0.95733, -1.20762, -0.73644, 0.22724, 0.90808, 0.05479, 0.29319, 0.72669, -0.28819, -0.81537, -0.53392, 0.46697, 0.1958, -0.69741, 0.64158, 1.15855, 0.71394, -0.99392, 0.58616, -0.3535, -0.12537, 0.52357, 0.30046, 0.9418, -0.38514, -0.44979],
    [-0.86444, -0.2376, 0.21096, 0.91715, 0.62735, 0.90299, -0.99149, -0.03971, 1.71691, -1.39646, 0.60973, -1.55885, 0.07491, -0.07973, 0.23981, 1.36093, 0.60371, 0.16663, -0.03641, -0.42565, -1.52236, -0.6216, 0.81136, 1.40639, 0.57012, -0.73821, -0.04452, 0.0152],
    [0.31671, -0.64009, 0.87443, -0.21887, 0.78056, 0.03737, 0.91843, -0.83163, 2.20063, -0.86306, 0.49948, -1.38524, -0.45021, -0.56789, 0.14213, -0.70137, 0.49338, 1.72659, 1.07098, -0.64263, 0.34125, 0.01914, -0.02244, 0.83079, 1.22964, -0.88665, 0.58646, 1.03302],
    [-0.58999, 0.98517, 0.68323, 0.55752, 0.3358, -0.93411, -0.82863, 0.94546, -1.1001, -0.51665, 0.91183, -0.45251, -1.19325, 0.83589, 0.17756, 1.44357, 0.63986, -0.62534, -1.0535, 0.10914, -1.04095, -0.03976, 0.45198, -1.22856, -0.01151, -0.0329, -1.16796, -0.33678],
    [0.44045, 0.86352, -0.25355, -0.36026, -0.78998, 0.82526, -0.13695, 0.45079, -0.09637, 0.79443, 0.02258, 1.17036, 0.55919, -0.62695, -0.06913, -0.63995, -1.2082, -1.34474, 0.58946, 0.67215, 0.93579, 0.44114, -0.70054, -0.56956, -0.17307, 0.66764, 0.18265, 0.52311],
    [-0.64061, -1.35237, 0.48137, -0.47488, -1.6689, -0.02417, 0.94525, -0.19602, -0.41223, -1.69618, -0.24875, -1.2136, 0.87158, 0.93286, 0.27566, -0.52886, 0.29521, 0.07674, -0.52293, 0.24489, -0.42847, 0.88192, 0.06933, 0.44207, -1.03161, 0.53408, 0.21729, 0.26955],
    [1.31236, 0.88523, -0.19476, -0.55808, -0.50266, 0.33226, 0.30245, -0.26465, -0.05612, 0.62958, -0.30755, 1.0907, -0.93275, -0.99313, 0.13494, -0.42665, -1.24827, 1.41086, 1.11244, -0.51688, 0.72423, -0.07047, -0.88092, -0.27988, 1.73175, 0.23348, 0.40628, 1.33812],
    [-0.64611, 1.30093, -1.35709, 0.62998, -0.10747, 0.09029, -0.7769, -0.53413, -1.53647, 0.45747, -0.51405, 0.69821, -0.60059, -1.05262, 0.41727, 0.33156, -0.45091, -0.90815, 1.05759, 0.19084, 0.58979, 0.74265, 0.51615, -1.26514, 0.64958, -0.18305, -0.93234, 0.8228],
    [-0.03429, -0.62927, -1.09527, 0.67245, -1.09579, 1.09644, -0.45652, 0.8188, -0.76281, -0.78792, -0.56929, -0.02685, -0.52975, -0.1929, 0.09954, 0.43545, 0.69248, 0.81449, 1.1071, -1.22319, -2.09535, 0.76974, 0.14997, -0.88582, 0.74318, 0.77055, -1.24082, -0.12628],
    [-1.22226, -0.10186, -1.14198, -0.85726, -1.43015, -0.056, 0.16958, -0.77764, -0.58938, -0.25935, -0.4219, 0.28548, 1.48653, -0.81378, -0.13089, -0.57167, -0.79978, -0.10029, 0.26367, 0.39845, 0.6115, 1.35789, -1.30853, -0.94993, -0.05468, -0.47357, 0.29838, 1.6964],
    [-0.10657, 1.10758, -0.88024, 0.9447, 1.51289, 0.02895, -0.11158, -1.06524, -0.53756, 0.2253, 0.13906, 1.30209, -0.60372, 1.81986, 0.27766, 0.16242, -0.31571, -1.1005, -0.8924, 1.60777, -0.79021, -1.3582, -0.53484, 0.95994, 1.05057, 0.38821, -0.04411, 1.03537],
    [-1.10972, 0.16253, -1.32838, -0.03543, 0.40915, 0.47778, -0.09542, -0.71344, -0.67131, 0.74668, -1.60372, -0.05727, 1.40484, 0.22373, -0.39954, -0.34222, 0.49492, -0.40674, 0.80288, 0.02777, -1.49053, 0.39028, -0.48757, 1.83976, 0.07268, 0.45852, -1.12585, -0.5874],
  ],
};
/* Forward pass: a 12-d chroma (weighted or binary) + a root pitch-class → the most
 * likely QUALITY at that root. Rotates to root-relative, max-normalises (matching
 * training), then runs the 2-layer MLP: h = tanh(W1·x + b1); softmax(W2·h + b2).
 * Returns the engine QUALITIES suffix, a probability, and the full distribution.
 * Pure + sync. SWAP POINT: replace ONLY this body with an ONNX inference of the
 * same shape and the arbiter/tests/worker boundary are unchanged. */
function classifyChromaQuality(chroma, root = 0) {
  if (!Array.isArray(chroma) || chroma.length !== 12) return null;
  const r = ((root % 12) + 12) % 12;
  const x = new Array(12);
  for (let i = 0; i < 12; i++) x[i] = chroma[(i + r) % 12] || 0;   // root-relative
  const mx = Math.max(...x) || 1;
  for (let i = 0; i < 12; i++) x[i] /= mx;                          // max-norm
  const { W1, b1, W2, b2, classes } = CHORD_CLASSIFIER;
  const h = W1.map((row, j) => { let s = b1[j]; for (let i = 0; i < 12; i++) s += row[i] * x[i]; return Math.tanh(s); });
  const z = W2.map((row, k) => { let s = b2[k]; for (let j = 0; j < h.length; j++) s += row[j] * h[j]; return s; });
  const m = Math.max(...z);
  const e = z.map((zk) => Math.exp(zk - m));
  const sum = e.reduce((a, c) => a + c, 0) || 1;
  const probs = e.map((ek) => ek / sum);
  let bi = 0; for (let k = 1; k < probs.length; k++) if (probs[k] > probs[bi]) bi = k;
  return { suffix: classes[bi], confidence: probs[bi], probs };
}
/* The CONTRACT (Wave 3 #10): the engine is the supreme oracle. The classifier is
 * consulted ONLY when the engine is unsure (Jaccard confidence < `gate`), and it
 * can adopt the model's quality only when the model is itself confident
 * (`minModel`). A confident engine is NEVER overridden. Returns the engine result
 * shape, tagged with `source` and (when consulted) `secondOpinion`. PURE — same
 * signature a real ONNX inference would slot behind, so the wiring never changes.
 *
 * NOTE for the live integration: surface `source === "classifier"` as a
 * SUPPLEMENTARY readout, do not silently rewrite the chart symbol, until it's
 * device-validated — that preserves the validated corpus (the oracle's output). */
function arbitrateChord(engineResult, chroma, opts = {}) {
  const gate = opts.gate != null ? opts.gate : 0.75;
  const minModel = opts.minModel != null ? opts.minModel : 0.8;
  if (!engineResult || engineResult.single || !engineResult.best)
    return { result: engineResult, source: "engine", secondOpinion: null };
  const conf = engineResult.best.confidence || 0;
  if (conf >= gate) return { result: engineResult, source: "engine", secondOpinion: null };
  const op = classifyChromaQuality(chroma, engineResult.best.root);  // engine keeps the ROOT
  if (!op) return { result: engineResult, source: "engine", secondOpinion: null };
  const q = QUALITIES.find((x) => x.suffix === op.suffix) || null;
  const secondOpinion = q ? { root: engineResult.best.root, quality: q, confidence: op.confidence } : null;
  if (secondOpinion && op.confidence > minModel && q !== engineResult.best.quality) {
    const best = { ...engineResult.best, quality: q, confidence: op.confidence };
    return { result: { ...engineResult, best }, source: "classifier", secondOpinion };
  }
  return { result: engineResult, source: "engine", secondOpinion }; // unsure ⇒ keep the oracle
}
function symbolOf(result, useSharp) {
  if (!result) return "—";
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  // A single-note block is just that note — return the bare name (e.g. "E"), NOT
  // "E (single)". The annotation used to be baked into the symbol STRING, which
  // then flowed verbatim into every exporter (ABC/MusicXML/CSMPN) and the chart
  // label as spurious noise (`"E (single)"[E,,]/2`). The single-note fact is
  // carried by the `result.single` FLAG instead (the readout panel reads it to
  // hide chord-quality details), so dropping the suffix here cleans every consumer
  // at the single source without touching recognition logic or QUALITIES.
  if (result.single) return names[result.roots];
  const { best, isSlash, bassPc } = result;
  const sym = names[best.root] + best.quality.suffix;
  return isSlash ? `${sym}/${names[bassPc]}` : sym;
}
// frets keyed by engine string index (0 = low E) → chord symbol (standard tuning)
function symbolForFrets(fretsByEng, useSharp) {
  const notes = Object.entries(fretsByEng).map(([si, fret]) => ({ stringIndex: +si, fret }));
  const midi = fretToMidi({ notes }, TUNINGS.Standard, 0, useSharp);
  const norm = normalise(midi);
  return symbolOf(recognise(norm.chroma, norm.chordMask, norm.bassPc), useSharp);
}
// a set of absolute MIDI notes → chord symbol (used by the MusicXML path, where
// pitch is explicit so no tuning/fret round-trip is needed)
function symbolForMidis(midis, useSharp) {
  const notes = [...new Set(midis)].sort((a, b) => a - b).map((m) => ({ midi: m }));
  const norm = normalise(notes);
  return symbolOf(recognise(norm.chroma, norm.chordMask, norm.bassPc), useSharp);
}
// frets (engine-keyed, standard tuning) → absolute MIDI list. Lets the PDF path
// carry real pitches into export/playback the same way the MusicXML path does.
function fretsToMidis(fretsByEng) {
  return Object.entries(fretsByEng)
    .map(([si, fret]) => { const open = TUNINGS.Standard[+si]; return open === undefined ? null : open + fret; })
    .filter((m) => m != null)
    .sort((a, b) => a - b);
}

/* ============================================================================
 *  PATH A — digital PDF parser (PDF.js text positions → chord chart)
 *  Mirrors the validated reference algorithm:
 *   1. extract integer text tokens with (x, top-down y)
 *   2. cluster y → string lines; group lines → staff systems (run of ≥4)
 *   3. per system: assign notes to strings by round((y-topY)/spacing)
 *   4. cluster x → chord columns; map columns to measures via the number row
 *   5. recognise each column; collapse consecutive duplicates per measure
 * ==========================================================================*/
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
function clusterVals(vals, gap) {
  const s = [...new Set(vals)].sort((a, b) => a - b);
  if (!s.length) return [];
  const out = []; let cur = [s[0]];
  for (let i = 1; i < s.length; i++) { if (s[i] - cur[cur.length - 1] <= gap) cur.push(s[i]); else { out.push(median(cur)); cur = [s[i]]; } }
  out.push(median(cur)); return out;
}
function estimateSpacing(ys) {
  const s = [...new Set(ys)].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < s.length; i++) { const g = s[i] - s[i - 1]; if (g > 0.5) gaps.push(g); }
  if (!gaps.length) return 7;
  // The string-line spacing is the MOST COMMON gap: a staff repeats it 5×(systems)
  // times, so it dominates. Noise gaps (chord-text baseline jitter) and the large
  // system/page gaps are comparatively rare. Cluster near-equal gaps (within 12%)
  // and take the biggest cluster's median. This is scale-INVARIANT — it recovers
  // ~7pt on a 1× export and ~37pt on a 4× Guitar-Pro/alphaTab export alike —
  // where the old "median of the smaller half, capped <20pt" returned 7 (no sub-20
  // gaps at 4× → 0 systems) or was dragged down to noise (~3.5 → mis-clustering).
  gaps.sort((a, b) => a - b);
  const clusters = [];
  for (const g of gaps) {
    const c = clusters.find((c) => Math.abs(g - c.center) <= c.center * 0.12);
    if (c) { c.vals.push(g); c.center = median(c.vals); }
    else clusters.push({ center: g, vals: [g] });
  }
  clusters.sort((a, b) => b.vals.length - a.vals.length || a.center - b.center);
  return clusters[0].center || 7;
}
function buildChart(tokens) {
  const pages = {};
  tokens.forEach((t) => (pages[t.page] = pages[t.page] || []).push(t));
  const measures = new Map();
  let systemsFound = 0, columnsFound = 0;

  Object.values(pages).forEach((ds) => {
    if (ds.length < 6) return;
    const spacing = estimateSpacing(ds.map((d) => d.y));
    const lineGap = spacing * 0.5, sysGap = spacing * 2.2, colGap = spacing * 1.3, pad = spacing * 0.7;

    const lines = clusterVals(ds.map((d) => d.y), lineGap);
    const groups = []; let cur = [lines[0]];
    for (let i = 1; i < lines.length; i++) { if (lines[i] - cur[cur.length - 1] <= sysGap) cur.push(lines[i]); else { groups.push(cur); cur = [lines[i]]; } }
    groups.push(cur);
    // A staff system = a run of evenly-spaced string lines. Sparse systems (a
    // melodic line that only touches a few strings) can show as few as 3 lines,
    // so accept >=3; header/measure-number rows are single lines (excluded) and
    // sit in their own group (split by sysGap), so they don't slip through.
    const staves = groups.filter((g) => g.length >= 3).map((g) => ({ topY: Math.min(...g), botY: Math.max(...g) }));

    staves.forEach((st, si) => {
      systemsFound++;
      const lo = st.topY - pad, hi = st.topY + spacing * 5 + pad;
      const staffNotes = ds.filter((d) => d.y >= lo && d.y <= hi);

      const prevBot = si > 0 ? staves[si - 1].botY : -Infinity;
      const cand = ds.filter((d) => d.y > prevBot + pad && d.y < st.topY - pad);
      let marks = [];
      if (cand.length) {
        const rowLines = clusterVals(cand.map((d) => d.y), lineGap);
        let bestRow = null, bestCount = -1;
        rowLines.forEach((ry) => { const c = cand.filter((d) => Math.abs(d.y - ry) <= lineGap).length; if (c > bestCount) { bestCount = c; bestRow = ry; } });
        marks = cand.filter((d) => Math.abs(d.y - bestRow) <= lineGap).map((d) => ({ num: d.val, x: d.x })).sort((a, b) => a.x - b.x);
        marks = marks.filter((m, i) => !(i > 0 && i < marks.length - 1 && m.num > marks[i - 1].num + 3 && m.num > marks[i + 1].num));
      }

      staffNotes.sort((a, b) => a.x - b.x);
      const cols = []; let cc = [];
      for (const d of staffNotes) { if (cc.length && d.x - cc[cc.length - 1].x > colGap) { cols.push(cc); cc = []; } cc.push(d); }
      if (cc.length) cols.push(cc);

      // Horizontal extent of each bar in this system: from its measure-number
      // mark to the next mark (last bar runs to the system's right edge). Used
      // downstream to quantise chord onsets onto beats; purely additive.
      const sysRightX = staffNotes.length ? staffNotes[staffNotes.length - 1].x : null;
      const markExt = new Map();
      marks.forEach((mk, i) => {
        const startX = mk.x;
        const endX = i + 1 < marks.length ? marks[i + 1].x
          : (sysRightX != null ? sysRightX + colGap : startX + colGap * 4);
        markExt.set(mk.num, { startX, endX });
      });

      cols.forEach((col) => {
        const cx = Math.min(...col.map((d) => d.x));
        const frets = {};
        col.forEach((d) => {
          const top = Math.round((d.y - st.topY) / spacing); // 0 = high e
          if (top < 0 || top > 5) return;
          const eng = 5 - top;                                // 0 = low E
          if (frets[eng] === undefined) frets[eng] = d.val;
        });
        if (!Object.keys(frets).length) return;
        let meas = null;
        for (const m of marks) if (cx >= m.x - pad) meas = m.num;
        if (meas == null) return;
        columnsFound++;
        if (!measures.has(meas)) measures.set(meas, { number: meas, columns: [] });
        const mo = measures.get(meas);
        mo.columns.push({ x: cx, frets });
        if (mo.startX === undefined && markExt.has(meas)) {
          const e = markExt.get(meas); mo.startX = e.startX; mo.endX = e.endX;
        }
      });
    });
  });

  const list = [...measures.values()].sort((a, b) => a.number - b.number);
  list.forEach((m) => m.columns.sort((a, b) => a.x - b.x));
  return { measures: list, systemsFound, columnsFound };
}

/* ---- score model: chords placed on beats within each bar -----------------
 * Turns the geometric chart into a lead-sheet-shaped score. Consecutive
 * identical symbols collapse to one event (the chord's onset). Each onset's x
 * is quantised onto a beat using the bar's horizontal extent (Invariant: the
 * bar's FIRST chord is the downbeat). 4/4 is assumed — time-signature detection
 * from the PDF is a clean future task. Durations fill to the next onset.
 * ------------------------------------------------------------------------- */
/* True (un-quantised) onset + duration in beats, kept ALONGSIDE the integer
 * beat/durBeats (which the chord-grid chart view needs for CSS-grid placement).
 * `qbeat`/`qdur` carry the real timing so ABC export and playback are accurate
 * for dense melodic lines — where rounding several onsets to the same integer
 * beat would otherwise make durBeats = 0 (invalid ABC) and stack notes in time.
 * `qbeat` must already be set per event; `qdur` is always > 0. */
function _fillTrueDur(events, beats) {
  events.forEach((e, i) => { e.qdur = Math.max(1e-4, (i + 1 < events.length ? events[i + 1].qbeat : beats) - e.qbeat); });
}
function buildScore(chart, useSharp, beatsPerBar = 4) {
  const bars = chart.measures.map((m) => {
    const events = [];
    m.columns.forEach((c) => {
      const symbol = symbolForFrets(c.frets, useSharp);
      const last = events[events.length - 1];
      if (!last || last.symbol !== symbol) events.push({ symbol, frets: c.frets, midis: fretsToMidis(c.frets), x: c.x });
    });
    const haveExt = typeof m.startX === "number" && typeof m.endX === "number" && m.endX > m.startX;
    const width = haveExt ? m.endX - m.startX : 0;
    events.forEach((e, i) => {
      const b = i === 0 ? 0                                 // bar's first chord = downbeat
        : haveExt ? ((e.x - m.startX) / width) * beatsPerBar
        : i;                                               // no geometry → just sequence
      e.qbeat = Math.max(0, b);                            // true fractional position
      e.beat = Math.max(0, Math.min(beatsPerBar - 1, Math.round(b)));
    });
    for (let i = 1; i < events.length; i++)                // keep beats strictly increasing
      if (events[i].beat <= events[i - 1].beat)
        events[i].beat = Math.min(beatsPerBar - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : beatsPerBar) - e.beat; });
    _fillTrueDur(events, beatsPerBar);
    return { number: m.number, events: events.map(({ x, ...e }) => e) };
  });
  return { timeSig: [beatsPerBar, 4], bars };
}

/* ---- simplify: aggregate each bar's notes into one best-fit chord ----------
 * For dense transcriptions (melody + harmony) the per-onset chart is noise. This
 * collapses every bar to a single chord by weighting each pitch class by the
 * total duration it sounds (so sustained/structural tones beat brief passing
 * notes) and keeping the strong ones, then running that chroma + the bar's bass
 * through the same engine. Output is the same score shape (one event/bar), so it
 * flows through render / transpose / playback / export unchanged. Opt-in — the
 * detailed per-onset path is untouched (Blue Sky stays as-is). ---------------- */
function simplifyScore(score, useSharp) {
  const bars = score.bars.map((bar) => {
    const sig = bar.timeSig || score.timeSig;
    const mk = { section: bar.section, repeatStart: bar.repeatStart, repeatEnd: bar.repeatEnd, ending: bar.ending }; // carry markers
    const pcW = new Array(12).fill(0);
    let any = false;
    for (const e of bar.events) {
      const w = Math.max(0.25, e.durBeats || 1);
      for (const m of e.midis || []) { pcW[m % 12] += w; any = true; }
    }
    if (!any) return { number: bar.number, timeSig: bar.timeSig, ...mk, events: [] };
    const maxW = Math.max(...pcW);
    const chroma = [];
    for (let pc = 0; pc < 12; pc++) if (pcW[pc] >= maxW * 0.2) chroma.push(pc); // drop weak passing tones
    // bass = lowest note that is a *structural* tone (kept pc), so a brief low
    // melody/passing note doesn't manufacture a spurious slash chord.
    let bassMidi = Infinity;
    for (const e of bar.events) for (const m of e.midis || []) if (pcW[m % 12] >= maxW * 0.2 && m < bassMidi) bassMidi = m;
    const result = recognise(chroma, makeMask(chroma), bassMidi % 12);
    const symbol = symbolOf(result, useSharp);
    let midis;                                            // clean voicing for playback/export
    if (result && !result.single && result.best) {
      const rootMidi = 48 + result.best.root;
      midis = result.best.quality.intervals.map((i) => rootMidi + i);
      if (result.isSlash) midis = [36 + result.bassPc, ...midis];
    } else midis = bassMidi === Infinity ? [] : [bassMidi];
    return { number: bar.number, timeSig: bar.timeSig, ...mk, events: [{ symbol, beat: 0, durBeats: sig[0], midis, frets: undefined }] };
  });
  return { ...score, bars, simplified: true };
}

/* ---- melodic detection: "mostly single notes" → a line, not block harmony ----
 * An arpeggiated / single-note part (a lead line, a plucked/arpeggiated rhythm
 * guitar, a single-note PDF head) recognises one "chord" per note, so its bars come
 * out over-quartered (Bb_Ab_F#_B …). `isMelodicScore` is the shared, pure test the UI
 * uses BOTH to nudge AND to auto-enable Simplify (1 chord/bar) so such a chart exports
 * / hands off as a clean fakebook. `melodicFraction` returns the raw single-note ratio.
 * Kept in the pure engine (not the UI) so it's the single source of the threshold and
 * headless-testable. Default gate: ≥4 events AND ≥50% of them single-note. */
function melodicFraction(score) {
  let total = 0, single = 0;
  (score.bars || []).forEach((b) => (b.events || []).forEach((e) => { total++; if (e.midis && e.midis.length === 1) single++; }));
  return total ? single / total : 0;
}
function isMelodicScore(score, opts = {}) {
  const minEvents = opts.minEvents != null ? opts.minEvents : 4;
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  let total = 0;
  (score.bars || []).forEach((b) => (b.events || []).forEach(() => total++));
  return total >= minEvents && melodicFraction(score) >= threshold;
}

/* ---- arrange: procedural rhythm generator (Roadmap Wave 2 #8) --------------
 * Turns a recognised HARMONIC chart (chords on their beats) into a rhythmic
 * ARRANGEMENT by stamping a comping/strum template across each bar — each hit
 * carries the chord SOUNDING at that position (so multi-chord bars keep their
 * changes). Pure + deterministic, no model — templates are fixed patterns. The
 * output is the SAME score shape every parser emits, so it flows untouched
 * through the exporters (CSMPN/CSML {hybrid} rhythm, MIDI, ABC), playback,
 * transpose and key analysis — zero new plumbing.
 *
 * Templates are per-beat sub-patterns (→ meter-independent; `tup` flags a tuplet
 * so the {hybrid}/CSMPN export draws the bracket). `block` is special-cased:
 * it keeps the existing onsets (the harmonic rhythm) — a clean sustain.
 *   block · quarters · eighths · shuffle (swung eighths) · sixteenths · skank (reggae off-beat)
 * HONEST LIMIT: CSMP's {hybrid} grid is eighth-resolution, so `sixteenths` round-trips
 * lossily into CSMPN/CSML slash-rhythm (positions collapse) — but the SCORE itself
 * (qbeat/qdur) is exact, so MIDI / ABC / playback render all 16ths faithfully.
 * `template` may be a name or `{ template }`; unknown name → passthrough. */
const ARRANGE_TEMPLATES = {
  block: null,                                                   // keep existing onsets
  quarters: [{ at: 0, dur: 1, tup: 0 }],                         // one strum per beat
  eighths: [{ at: 0, dur: 0.5, tup: 0 }, { at: 0.5, dur: 0.5, tup: 0 }],
  shuffle: [{ at: 0, dur: 2 / 3, tup: 3 }, { at: 2 / 3, dur: 1 / 3, tup: 3 }], // long-short swing
  sixteenths: [{ at: 0, dur: 0.25, tup: 0 }, { at: 0.25, dur: 0.25, tup: 0 }, { at: 0.5, dur: 0.25, tup: 0 }, { at: 0.75, dur: 0.25, tup: 0 }],
  skank: [{ at: 0.5, dur: 0.5, tup: 0 }],                        // reggae/ska: chord on the off-beat only
};
function arrangeScore(score, template = "quarters") {
  const name = (template && typeof template === "object" ? template.template : template) || "quarters";
  if (!(name in ARRANGE_TEMPLATES)) return score;               // unknown → never throw, passthrough
  const pat = ARRANGE_TEMPLATES[name];
  const bars = (score.bars || []).map((bar) => {
    const sig = bar.timeSig || score.timeSig || [4, 4];
    const beats = sig[0];
    const mk = { section: bar.section, repeatStart: bar.repeatStart, repeatEnd: bar.repeatEnd, ending: bar.ending };
    const src = (bar.events || []).map((e) => ({ ...e, _q: e.qbeat != null ? e.qbeat : e.beat })).sort((a, b) => a._q - b._q);
    if (!src.length) return { number: bar.number, timeSig: bar.timeSig, ...mk, events: [] };
    const chordAt = (pos) => { let c = src[0]; for (const e of src) { if (e._q <= pos + 1e-6) c = e; else break; } return c; };
    let onsets;
    if (pat === null) onsets = src.map((e) => ({ q: e._q, tup: e.tuplet || 0, src: e }));
    else { onsets = []; for (let b = 0; b < beats; b++) for (const h of pat) { const q = b + h.at; if (q < beats - 1e-6) onsets.push({ q, tup: h.tup, src: chordAt(q) }); } }
    const events = onsets.map((o) => ({
      symbol: o.src.symbol, midis: o.src.midis ? [...o.src.midis] : [], frets: o.src.frets,
      tuplet: o.tup || 0, qbeat: o.q, beat: Math.max(0, Math.min(beats - 1, Math.round(o.q))),
    }));
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(beats - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : beats) - e.beat; });
    _fillTrueDur(events, beats);                                 // true qbeat/qdur for {hybrid}/ABC/playback/MIDI
    return { number: bar.number, timeSig: bar.timeSig, ...mk, events };
  });
  return { ...score, bars, arrangedAs: name };
}

/* ============================================================================
 *  PATH C — MusicXML import  (explicit meter + tuning + rhythm, no recognition
 *  of geometry needed). MusicXML encodes <time>, <staff-tuning> and every
 *  note's <duration>/<pitch>/<string>+<fret>, so meter, tuning and beat
 *  placement are EXACT — only the chord *symbol* is inferred, by running each
 *  onset's simultaneous pitches through the same engine. Guitar Pro files can
 *  be exported to MusicXML, so this covers them too. Uses the browser's built-in
 *  DOMParser — zero new app dependencies.
 *
 *  Output is the SAME score shape buildScore produces:
 *    { source, timeSig:[beats,beatType], tuning, bars:[{ number, timeSig,
 *      events:[{ symbol, beat, durBeats, midis, frets }] }] }
 *  so the lead-sheet / grid renderer and the exporters are shared across paths.
 * ==========================================================================*/
const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const _xEls = (parent, tag) => (parent ? Array.from(parent.getElementsByTagName(tag)) : []);
const _xFirst = (parent, tag) => { const e = _xEls(parent, tag); return e.length ? e[0] : null; };
const _xText = (el) => (el && el.textContent != null ? String(el.textContent).trim() : "");
const _xChildText = (parent, tag) => _xText(_xFirst(parent, tag));
function _pitchToMidi(p) {
  const step = _xChildText(p, "step");
  const alter = parseInt(_xChildText(p, "alter") || "0", 10) || 0;
  const oct = parseInt(_xChildText(p, "octave") || "4", 10);
  if (!(step in STEP_SEMI)) return null;
  return (oct + 1) * 12 + STEP_SEMI[step] + alter;
}
function _parseTuning(staffTunings) {
  const arr = [];
  staffTunings.forEach((st) => {
    const line = parseInt(st.getAttribute("line") || "0", 10); // line 1 = bottom = low string
    const step = _xChildText(st, "tuning-step");
    const oct = parseInt(_xChildText(st, "tuning-octave") || "0", 10);
    const alter = parseInt(_xChildText(st, "tuning-alter") || "0", 10) || 0;
    if (line >= 1 && line <= 6 && step in STEP_SEMI) arr[line - 1] = (oct + 1) * 12 + STEP_SEMI[step] + alter;
  });
  return arr.length === 6 && arr.every((v) => typeof v === "number") ? arr : null;
}
function _tuningName(arr) {
  if (!arr) return "Standard";
  for (const [n, t] of Object.entries(TUNINGS)) if (t.every((v, i) => v === arr[i])) return n;
  return "Custom";
}
function parseMusicXML(xml, useSharp = true, partIndex = 0) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (_xEls(doc, "parsererror").length) throw new Error("Not valid XML.");
  const partEls = _xEls(doc, "part");
  if (!partEls.length) throw new Error("No <part> found — is this a MusicXML score?");
  // instrument names from <part-list>, in document order, for the part picker
  const nameById = {};
  _xEls(doc, "score-part").forEach((sp) => { nameById[sp.getAttribute("id")] = _xChildText(sp, "part-name") || sp.getAttribute("id"); });
  const parts = partEls.map((pe, i) => ({ index: i, id: pe.getAttribute("id"), name: nameById[pe.getAttribute("id")] || `Part ${i + 1}` }));
  const idx = Math.max(0, Math.min(partEls.length - 1, partIndex | 0));
  const part = partEls[idx];

  let divisions = 1, beats = 4, beatType = 4, tuning = null;
  const bars = [];
  _xEls(part, "measure").forEach((measure, mi) => {
    let cursor = 0, lastOnset = 0;
    const onsets = new Map(); // onset(div) -> { midis:[], frets:{} }
    for (let node = measure.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      const tag = node.nodeName;
      if (tag === "attributes") {
        const d = _xChildText(node, "divisions"); if (d) divisions = parseInt(d, 10) || divisions;
        const t = _xFirst(node, "time");
        if (t) { const b = _xChildText(t, "beats"), bt = _xChildText(t, "beat-type"); if (b) beats = parseInt(b, 10) || beats; if (bt) beatType = parseInt(bt, 10) || beatType; }
        const sts = _xEls(node, "staff-tuning"); if (sts.length) { const tu = _parseTuning(sts); if (tu) tuning = tu; }
      } else if (tag === "note") {
        if (_xFirst(node, "grace")) continue;
        const dur = parseInt(_xChildText(node, "duration") || "0", 10) || 0;
        const isChord = !!_xFirst(node, "chord");
        const isRest = !!_xFirst(node, "rest");
        const onset = isChord ? lastOnset : cursor;
        if (!isChord) { lastOnset = cursor; cursor += dur; }
        if (isRest) continue;
        let midi = null, eng = null, fret = null;
        const p = _xFirst(node, "pitch"); if (p) midi = _pitchToMidi(p);
        const tech = _xFirst(node, "technical");
        if (tech) {
          const sNum = parseInt(_xChildText(tech, "string"), 10);
          const f = parseInt(_xChildText(tech, "fret"), 10);
          if (!isNaN(sNum) && !isNaN(f)) { eng = 6 - sNum; fret = f; if (midi == null) { const open = (tuning || TUNINGS.Standard)[eng]; if (open != null) midi = open + f; } }
        }
        if (midi == null) continue;
        const tm = _xFirst(node, "time-modification"); let tup = 0; if (tm) { const an = parseInt(_xChildText(tm, "actual-notes") || "0", 10); if (an > 1) tup = an; }
        if (!onsets.has(onset)) onsets.set(onset, { midis: [], frets: {}, tuplet: tup });
        const o = onsets.get(onset); o.midis.push(midi); if (eng != null && o.frets[eng] === undefined) o.frets[eng] = fret;
      } else if (tag === "backup") { cursor -= parseInt(_xChildText(node, "duration") || "0", 10) || 0; }
      else if (tag === "forward") { cursor += parseInt(_xChildText(node, "duration") || "0", 10) || 0; }
    }
    const divPerBeat = (divisions * 4) / beatType || divisions;
    const raw = [...onsets.entries()].sort((a, b2) => a[0] - b2[0]).map(([onset, o]) => ({
      symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b2) => a - b2), frets: o.frets, tuplet: o.tuplet || 0, onset,
    }));
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.qbeat = e.onset / divPerBeat; e.beat = Math.max(0, Math.min(beats - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(beats - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : beats) - e.beat; });
    _fillTrueDur(events, beats);
    const number = parseInt(measure.getAttribute("number") || String(mi + 1), 10);
    // section/repeat/ending markers: <rehearsal> text, <barline><repeat>/<ending>
    const reh = _xFirst(measure, "rehearsal");
    const section = (reh && _xText(reh).trim()) || "";
    let repeatStart = false, repeatEnd = false, ending = null;
    _xEls(measure, "barline").forEach((bl) => {
      const rep = _xFirst(bl, "repeat"); const dir = rep && rep.getAttribute("direction");
      if (dir === "forward") repeatStart = true; else if (dir === "backward") repeatEnd = true;
      const end = _xFirst(bl, "ending"); const n = end && end.getAttribute("number");
      if (end && (end.getAttribute("type") === "start") && n) ending = String(n).split(/[,\s]+/)[0];
    });
    bars.push({ number, timeSig: [beats, beatType], section: section || undefined, repeatStart, repeatEnd, ending, events: events.map(({ onset, ...e }) => e) });
  });
  // tempo: <sound tempo="…"> if present, else a <metronome> per-minute (assume
  // it's a quarter-note BPM). null → callers default (e.g. 100 for playback).
  let tempo = null;
  const sound = _xEls(doc, "sound").find((s) => s.getAttribute("tempo"));
  if (sound) { const v = parseFloat(sound.getAttribute("tempo")); if (!isNaN(v)) tempo = v; }
  if (tempo == null) { const pm = _xFirst(doc, "per-minute"); if (pm) { const v = parseFloat(_xText(pm)); if (!isNaN(v)) tempo = v; } }
  return { source: "musicxml", timeSig: bars.length ? bars[0].timeSig : [beats, beatType], tuning: _tuningName(tuning), tempo, bars, parts, partIndex: idx };
}

/* ===========================================================================
 *  PATH D — Guitar Pro (GP7 / GP8 `.gp`) import
 *  --------------------------------------------------------------------------
 *  A `.gp` file is a plain ZIP whose `Content/score.gpif` is an XML document —
 *  so this is parseable with ZERO new dependencies: the ZIP is inflated with
 *  the platform's native `DecompressionStream('deflate-raw')` (present in the
 *  browser and Node ≥18) and the XML read with the same `DOMParser` Path C uses.
 *
 *  gpif is a flat list of elements joined by id references, not nested like
 *  MusicXML:  MasterBar.Bars[track] → Bar.Voices → Voice.Beats → Beat
 *  → { Rhythm ref, Notes ids } ; Note carries a direct
 *  `<Property name="Midi"><Number>` (so no pitch math) plus String/Fret. We
 *  resolve the id graph, accumulate each voice's onsets from a Rhythm-derived
 *  duration, run each onset's MIDI through the same engine, and emit the SAME
 *  score shape as buildScore / parseMusicXML — so the chart, exporters,
 *  transpose, key analysis and playback are all shared for free.
 *
 *  Older formats (GP3/4/5 binary, GPX binary filesystem, Power Tab) are NOT
 *  parsed here — they need binary readers / a dependency; the honest route for
 *  those stays "open in TuxGuitar/MuseScore → export MusicXML" (Path C).
 * ==========================================================================*/
const _GP_NV = { Whole: 4, Half: 2, Quarter: 1, Eighth: 0.5, "16th": 0.25, "32nd": 0.125, "64th": 0.0625, "128th": 0.03125 };
const _gpProp = (el, name) => _xEls(el, "Property").find((p) => p.getAttribute("name") === name) || null;
const _gpById = (doc, tag) => { const m = new Map(); _xEls(doc, tag).forEach((e) => { const id = e.getAttribute("id"); if (id != null) m.set(id, e); }); return m; };
const _gpIds = (txt) => (txt || "").trim().split(/\s+/).filter((s) => s.length);
function _gpRhythmQuarters(r) {
  if (!r) return 1;
  let q = _GP_NV[_xChildText(r, "NoteValue")]; if (q == null) q = 1;
  const dot = _xFirst(r, "AugmentationDot"); if (dot) { const c = parseInt(dot.getAttribute("count") || "1", 10); q *= c >= 2 ? 1.75 : 1.5; }
  const tup = _xFirst(r, "PrimaryTuplet"); if (tup) { const n = parseInt(tup.getAttribute("num") || "0", 10), d = parseInt(tup.getAttribute("den") || "0", 10); if (n > 0 && d > 0) q *= d / n; }
  return q;
}
/* Tuplet group size (num) of a Rhythm, or 0 — for the {hybrid} `tN` flag. */
function _gpRhythmTuplet(r) {
  const tup = r && _xFirst(r, "PrimaryTuplet"); if (!tup) return 0;
  const n = parseInt(tup.getAttribute("num") || "0", 10);
  return n > 1 ? n : 0;
}
function _gpNoteMidi(note) {
  const me = _gpProp(note, "Midi"); const n = me ? parseInt(_xChildText(me, "Number"), 10) : NaN;
  if (!isNaN(n)) return n;
  const pe = _gpProp(note, "ConcertPitch") || _gpProp(note, "TransposedPitch");
  const p = pe && _xFirst(pe, "Pitch");
  if (p) { const step = _xChildText(p, "Step"); const acc = _xChildText(p, "Accidental"); const oct = parseInt(_xChildText(p, "Octave") || "0", 10); if (step in STEP_SEMI) return oct * 12 + STEP_SEMI[step] + (acc === "#" ? 1 : acc === "b" ? -1 : 0); }
  // GP6 piano/concert parts encode pitch as Tone(<Step> = chromatic 0–11) + Octave(<Number>)
  const toneEl = _gpProp(note, "Tone"), octEl = _gpProp(note, "Octave");
  if (toneEl && octEl) { const step = parseInt(_xChildText(toneEl, "Step"), 10), oct = parseInt(_xChildText(octEl, "Number"), 10); if (!isNaN(step) && !isNaN(oct)) return oct * 12 + step; }
  return null;
}
function parseGPIF(xml, useSharp = true, partIndex = 0) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (_xEls(doc, "parsererror").length) throw new Error("Not valid gpif XML.");
  const tracks = _xEls(doc, "Track").filter((t) => t.getAttribute("id") != null);
  if (!tracks.length) throw new Error("No <Track> found — is this a GP7/8 .gp file?");
  const parts = tracks.map((t, i) => ({ index: i, id: t.getAttribute("id"), name: (_xChildText(t, "Name") || `Track ${i + 1}`).trim() || `Track ${i + 1}` }));
  const idx = Math.max(0, Math.min(tracks.length - 1, partIndex | 0));

  const barMap = _gpById(doc, "Bar"), voiceMap = _gpById(doc, "Voice"), beatMap = _gpById(doc, "Beat"), noteMap = _gpById(doc, "Note"), rhythmMap = _gpById(doc, "Rhythm");
  // tuning of the chosen track (display only — MIDI is read directly per note)
  let tuning = null;
  const tunProp = _gpProp(tracks[idx], "Tuning") || (_xFirst(tracks[idx], "Staff") && _gpProp(_xFirst(tracks[idx], "Staff"), "Tuning"));
  if (tunProp) { const pit = _gpIds(_xChildText(tunProp, "Pitches")).map(Number); if (pit.length === 6 && pit.every((v) => !isNaN(v))) tuning = pit; } // gpif lists low→high (String 0 = low E)

  const bars = [];
  let lastSig = [4, 4];
  _xEls(doc, "MasterBar").forEach((mb, mi) => {
    const tt = _xChildText(mb, "Time");
    if (tt && /^\d+\/\d+$/.test(tt)) lastSig = tt.split("/").map((n) => parseInt(n, 10));
    const [bts, btype] = lastSig;
    // section/repeat/ending markers the gpif carries but we used to ignore
    const secEl = _xFirst(mb, "Section");
    const section = (secEl && (_xChildText(secEl, "Text") || "").trim()) || "";
    const repEl = _xFirst(mb, "Repeat");
    const repeatStart = !!(repEl && repEl.getAttribute("start") === "true");
    const repeatEnd = !!(repEl && repEl.getAttribute("end") === "true");
    const altTxt = (_xChildText(mb, "AlternateEndings") || "").trim();
    const ending = altTxt ? altTxt.split(/\s+/)[0] : null;
    const barIds = _gpIds(_xChildText(mb, "Bars"));
    const bar = barMap.get(barIds[idx]);
    const onsets = new Map(); // onsetQuarters -> { midis:[], frets:{} }
    if (bar) {
      _gpIds(_xChildText(bar, "Voices")).filter((v) => v !== "-1").forEach((vId) => {
        const voice = voiceMap.get(vId); if (!voice) return;
        let cursor = 0;
        _gpIds(_xChildText(voice, "Beats")).forEach((beatId) => {
          const beat = beatMap.get(beatId); if (!beat) return;
          const rRef = _xFirst(beat, "Rhythm"); const rEl = rRef && rhythmMap.get(rRef.getAttribute("ref")); const q = _gpRhythmQuarters(rEl); const tup = _gpRhythmTuplet(rEl);
          const noteIds = _gpIds(_xText(_xFirst(beat, "Notes")));
          if (noteIds.length) {
            if (!onsets.has(cursor)) onsets.set(cursor, { midis: [], frets: {}, tuplet: tup });
            const o = onsets.get(cursor);
            noteIds.forEach((nId) => {
              const note = noteMap.get(nId); if (!note) return;
              const sEl = _gpProp(note, "String"), fEl = _gpProp(note, "Fret");
              let s = null, f = null;
              if (sEl && fEl) { s = parseInt(_xChildText(sEl, "String"), 10), f = parseInt(_xChildText(fEl, "Fret"), 10); if (isNaN(s) || isNaN(f)) s = f = null; }
              // GP7/8 carry a direct <Midi>; GP6 gpif carries only String+Fret, so
              // fall back to tuning+fret (String 0 = low E, tuning low→high).
              let midi = _gpNoteMidi(note);
              if (midi == null && s != null) { const tun = tuning || TUNINGS.Standard; if (s >= 0 && s < tun.length) midi = tun[s] + f; }
              if (midi == null) return;
              o.midis.push(midi);
              if (s != null && s >= 0 && s <= 5 && o.frets[s] === undefined) o.frets[s] = f;
            });
          }
          cursor += q;
        });
      });
    }
    const qPerBeat = 4 / btype; // a "beat" = one 1/beatType note
    const raw = [...onsets.entries()].filter(([, o]) => o.midis.length).sort((a, b) => a[0] - b[0])
      .map(([onset, o]) => ({ symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b) => a - b), frets: o.frets, tuplet: o.tuplet || 0, onset }));
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.qbeat = e.onset / qPerBeat; e.beat = Math.max(0, Math.min(bts - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(bts - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : bts) - e.beat; });
    _fillTrueDur(events, bts);
    bars.push({ number: mi + 1, timeSig: [bts, btype], section: section || undefined, repeatStart, repeatEnd, ending, events: events.map(({ onset, ...e }) => e) });
  });

  // tempo: first <Automation><Type>Tempo</Type> … <Value>BPM ref</Value>
  let tempo = null;
  const tAuto = _xEls(doc, "Automation").find((a) => _xChildText(a, "Type") === "Tempo");
  if (tAuto) { const v = parseFloat((_xChildText(tAuto, "Value") || "").split(/\s+/)[0]); if (!isNaN(v)) tempo = v; }
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : lastSig, tuning: _tuningName(tuning), tempo, bars, parts, partIndex: idx };
}

/* Inflate a `.gp` (GP7/8) ZIP and return its Content/score.gpif XML text.
 * Minimal central-directory ZIP reader + native deflate-raw — zero deps. */
async function gpUnzip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error("Not a .gp file (no ZIP directory).");
  const cdOff = dv.getUint32(eo + 16, true), cdCount = dv.getUint16(eo + 10, true);
  let p = cdOff, target = null;
  for (let n = 0; n < cdCount && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const lhOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (name.endsWith("score.gpif")) { target = { method, compSize, lhOff }; break; }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!target) throw new Error("No score.gpif inside — is this a GP7/8 .gp file? (Older .gp3/4/5/.gpx are binary; export MusicXML instead.)");
  const lh = target.lhOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error("Corrupt .gp (bad local header).");
  const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const comp = u8.subarray(dataStart, dataStart + target.compSize);
  if (target.method === 0) return new TextDecoder("utf-8").decode(comp);
  const stream = new Response(comp).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new TextDecoder("utf-8").decode(new Uint8Array(await new Response(stream).arrayBuffer()));
}
async function parseGP(buf, useSharp = true, partIndex = 0) { return parseGPIF(await gpUnzip(buf), useSharp, partIndex); }

/* ===========================================================================
 *  PATH E — Guitar Pro 3 / 4 / 5 (legacy BINARY formats)
 *  --------------------------------------------------------------------------
 *  Unlike GP7/8 (Path D, a ZIP of XML), GP3/4/5 are monolithic little-endian
 *  binary. This is a faithful, zero-dependency port of the documented reading
 *  order (verified against PyGuitarPro on the real corpus): every effect/chord/
 *  mix-table block is fully consumed so the byte cursor stays aligned even
 *  though we only keep each beat's duration and its notes (string+fret → MIDI
 *  via the track tuning). Output is the SAME score shape as parseGPIF /
 *  parseMusicXML (`source:"gp"`), so chart/export/transpose/playback are shared.
 *
 *  Versions diverge in: an extra octave byte + lyrics block (GP4+), 1- vs
 *  2-byte effect flags, the new-chord layout, and the mix-table flags byte.
 *  GP5's container is different enough (directory, RSE, 2 voices) to live in
 *  its own reader, parseGP5.
 * ==========================================================================*/
function _gpReader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = new TextDecoder("latin1");
  let pos = 0;
  const R = {
    get pos() { return pos; }, set pos(p) { pos = p; },
    skip(n) { pos += n; },
    u8() { return dv.getUint8(pos++); },
    i8() { return dv.getInt8(pos++); },
    bool() { return dv.getUint8(pos++) !== 0; },
    i16() { const v = dv.getInt16(pos, true); pos += 2; return v; },
    i32() { const v = dv.getInt32(pos, true); pos += 4; return v; },
    byteString(count) { const size = dv.getUint8(pos++); const s = dec.decode(u8.subarray(pos, pos + Math.min(size, count))); pos += count; return s; },
    intString() { const n = R.i32(); const s = dec.decode(u8.subarray(pos, pos + n)); pos += n; return s; },
    intByteString() { const n = R.i32(); return R.byteString(n - 1); },
    version() { return R.byteString(30); },
  };
  return R;
}
const _GP_TUPLET = { 3: [3, 2], 5: [5, 4], 6: [6, 4], 7: [7, 4], 9: [9, 8], 10: [10, 8], 11: [11, 8], 12: [12, 8], 13: [13, 8] };
// GP alternate-ending byte (bitmask of repeat passes) → a 1-based ending label, or null.
const _gpEndingLabel = (b) => (b ? String(Math.round(Math.log2(b & -b)) + 1) : null);
function _gpReadDuration(r, flags) {
  r._tuplet = 0;                              // side-channel: tuplet group size of this beat (0 = none)
  let q = 4 / (1 << (r.i8() + 2));            // value: -2→whole(4q) … 0→quarter(1q) … 2→16th(.25q)
  if (flags & 0x01) q *= 1.5;                 // dotted
  if (flags & 0x20) { const tv = r.i32(); const t = _GP_TUPLET[tv]; if (t) { q *= t[1] / t[0]; r._tuplet = tv; } } // tuplet (same bytes; capture the group size)
  return q;
}
function _gpReadBend(r) { r.i8(); r.i32(); const n = r.i32(); for (let i = 0; i < n; i++) { r.i32(); r.i32(); r.bool(); } }
function _gpReadGrace(r) { r.i8(); r.u8(); r.u8(); r.i8(); }            // fret, velocity, duration, transition
function _gpReadNoteEffects(r, v) {
  if (v >= 4) {
    const f1 = r.u8(), f2 = r.u8();
    if (f1 & 0x01) _gpReadBend(r);
    if (f1 & 0x10) _gpReadGrace(r);
    if (f2 & 0x04) r.i8();                                             // tremolo picking
    if (f2 & 0x08) r.i8();                                             // slide
    if (f2 & 0x10) r.i8();                                             // harmonic
    if (f2 & 0x20) { r.i8(); r.i8(); }                                 // trill
  } else {
    const f1 = r.u8();
    if (f1 & 0x01) _gpReadBend(r);
    if (f1 & 0x10) _gpReadGrace(r);                                    // 0x04 slide: no bytes in GP3
  }
}
function _gpReadBeatEffects(r, v) {
  if (v >= 4) {
    const f1 = r.u8(), f2 = r.u8();
    if (f1 & 0x20) r.i8();                                             // slap/tap
    if (f2 & 0x04) _gpReadBend(r);                                     // tremolo bar = bend
    if (f1 & 0x40) { r.i8(); r.i8(); }                                 // stroke
    if (f2 & 0x02) r.i8();                                             // pick stroke
  } else {
    const f1 = r.u8();
    if (f1 & 0x20) { const slap = r.u8(); if (slap === 0) r.i32(); else r.i32(); } // tremolo bar / tap value
    if (f1 & 0x40) { r.i8(); r.i8(); }                                 // stroke
  }
}
function _gpReadMixTableChange(r, v) {
  const vals = [r.i8(), r.i8(), r.i8(), r.i8(), r.i8(), r.i8(), r.i8()]; // instr,vol,bal,chorus,reverb,phaser,tremolo
  const tempo = r.i32();
  // durations follow for each changed param among volume..tremolo (vals[1..6]) then tempo
  for (let i = 1; i <= 6; i++) if (vals[i] >= 0) r.i8();
  if (tempo >= 0) r.i8();
  if (v >= 4) r.i8();                                                  // GP4 all-tracks flags byte
}
function _gpReadChord(r, v, stringCount) {
  const newFormat = r.bool();
  if (!newFormat) {                                                   // GP3 old chord
    r.intByteString();                                                // name
    const firstFret = r.i32();
    if (firstFret) for (let i = 0; i < 6; i++) r.i32();
    return;
  }
  if (v >= 4) {                                                       // GP4 new chord
    r.bool(); r.skip(3); r.u8(); r.u8(); r.u8(); r.i32(); r.i32(); r.bool();
    r.byteString(22); r.u8(); r.u8(); r.u8(); r.i32();
    for (let i = 0; i < 7; i++) r.i32();                              // frets
    r.u8();                                                           // barre count
    for (let i = 0; i < 15; i++) r.u8();                              // 5 frets + 5 starts + 5 ends
    for (let i = 0; i < 7; i++) r.bool();                            // omissions
    r.skip(1);
    for (let i = 0; i < 7; i++) r.i8();                              // fingerings
    r.bool();                                                         // show
  } else {                                                            // GP3 new chord
    r.bool(); r.skip(3); r.i32(); r.i32(); r.i32(); r.i32(); r.i32(); r.bool();
    r.byteString(22); r.i32(); r.i32(); r.i32(); r.i32();
    for (let i = 0; i < 6; i++) r.i32();                              // frets
    r.i32();                                                          // barre count
    for (let i = 0; i < 6; i++) r.i32();                              // 2 frets + 2 starts + 2 ends
    for (let i = 0; i < 7; i++) r.bool();                            // omissions
    r.skip(1);
  }
}
function _gpReadNote(r, v, stringNumber, tuning, state) {
  const flags = r.u8();
  let type = 1;
  if (flags & 0x20) type = r.u8();
  if (flags & 0x01) { r.i8(); r.i8(); }                               // time-independent duration
  if (flags & 0x10) r.i8();                                           // dynamic
  let fret = null;
  if (flags & 0x20) fret = r.i8();
  if (flags & 0x80) { r.i8(); r.i8(); }                               // fingering
  if (flags & 0x08) _gpReadNoteEffects(r, v);
  if (type === 2) { fret = state.lastFret[stringNumber]; if (fret == null) return null; } // tie → sustain prior pitch
  else if (type === 3) return null;                                   // dead/muted → no pitch
  if (fret == null) return null;
  fret = Math.min(Math.max(fret, 0), 99);
  state.lastFret[stringNumber] = fret;
  return { fret, midi: tuning[stringNumber - 1] + fret };
}
function _gpReadBeat(r, v, stringCount, tuning, state) {
  const flags = r.u8();
  let empty = false;
  if (flags & 0x40) { const st = r.u8(); empty = st === 0; }          // 0=empty, 2=rest
  const durQuarters = _gpReadDuration(r, flags);
  if (flags & 0x02) _gpReadChord(r, v, stringCount);
  if (flags & 0x04) r.intByteString();                               // text
  if (flags & 0x08) _gpReadBeatEffects(r, v);
  if (flags & 0x10) _gpReadMixTableChange(r, v);
  const stringFlags = r.u8();
  const midis = [], frets = {};
  for (let s = 1; s <= stringCount; s++) {
    if (stringFlags & (1 << (7 - s))) {
      const note = _gpReadNote(r, v, s, tuning, state);
      if (note) { midis.push(note.midi); frets[6 - s] = note.fret; }
    }
  }
  return { durQuarters: empty ? 0 : durQuarters, midis, frets, tuplet: r._tuplet || 0 };
}
function parseGP345(u8, useSharp = true, partIndex = 0) {
  const r = _gpReader(u8);
  const version = r.version();
  const v = /v5/.test(version) ? 5 : /v4/.test(version) ? 4 : /v3/.test(version) ? 3 : 0;
  if (v === 5) return parseGP5(u8, version, useSharp, partIndex);
  if (v !== 3 && v !== 4) throw new Error("Unrecognized Guitar Pro version: " + version);
  // --- song header ---
  for (let i = 0; i < 8; i++) r.intByteString();                     // title…instructions
  const noticeLines = r.i32(); for (let i = 0; i < noticeLines; i++) r.intByteString();
  r.bool();                                                          // triplet feel
  if (v >= 4) { r.i32(); for (let i = 0; i < 5; i++) { r.i32(); r.intString(); } } // lyrics
  const tempo = r.i32();
  r.i32();                                                           // key
  if (v >= 4) r.i8();                                                // octave
  for (let i = 0; i < 64; i++) { r.i32(); r.skip(8); }               // 64 MIDI channels (instr + 6 bytes + 2 blank)
  const measureCount = r.i32();
  const trackCount = r.i32();
  // --- measure headers (timeSig, inherited) ---
  const headers = [], meta = []; let num = 4, den = 4;
  for (let m = 0; m < measureCount; m++) {
    const flags = r.u8();
    if (flags & 0x01) num = r.i8();
    if (flags & 0x02) den = r.i8();
    const repeatStart = !!(flags & 0x04);                           // |: (flag only, no bytes)
    const repeatEnd = (flags & 0x08) ? (r.i8(), true) : false;      // repeat close (count byte)
    const ending = _gpEndingLabel((flags & 0x10) ? r.u8() : 0);     // alternate ending bitmask
    let section = "";
    if (flags & 0x20) { section = (r.intByteString() || "").trim(); r.skip(4); } // marker = section
    if (flags & 0x40) { r.i8(); r.i8(); }                           // key sig change
    headers.push([num, den]);
    meta.push({ section, repeatStart, repeatEnd, ending });
  }
  // --- tracks ---
  const tracks = [];
  for (let t = 0; t < trackCount; t++) {
    r.u8();                                                          // flags
    const name = r.byteString(40);
    const stringCount = r.i32();
    const tuning = [];
    for (let i = 0; i < 7; i++) { const tu = r.i32(); if (i < stringCount) tuning.push(tu); }
    r.i32();                                                         // port
    r.i32(); r.i32();                                                // channel + effect channel
    r.i32();                                                         // fret count
    const capo = r.i32();                                            // capo fret (kept for the export header)
    r.skip(4);                                                       // colour
    tracks.push({ name, stringCount, tuning, capo, measures: [] });
  }
  // --- measures (measure-major, then track) ---
  const state = tracks.map(() => ({ lastFret: {} }));
  for (let m = 0; m < measureCount; m++) {
    for (let t = 0; t < trackCount; t++) {
      const tr = tracks[t];
      const beatCount = r.i32();
      const beats = [];
      for (let b = 0; b < beatCount; b++) beats.push(_gpReadBeat(r, v, tr.stringCount, tr.tuning, state[t]));
      tr.measures.push({ timeSig: headers[m], meta: meta[m], voices: [beats] });
    }
  }
  return _gpBuildScore(tracks, tempo, version, useSharp, partIndex);
}
function _gpBuildScore(tracks, tempo, version, useSharp, partIndex) {
  const idx = Math.max(0, Math.min(tracks.length - 1, partIndex | 0));
  const tr = tracks[idx];
  const parts = tracks.map((t, i) => ({ index: i, id: String(i), name: (t.name || "").trim() || `Track ${i + 1}` }));
  const bars = tr.measures.map((m, mi) => {
    const [bts, btype] = m.timeSig;
    const onsets = new Map();
    m.voices.forEach((beats) => {                                     // GP5 has 2 voices; each restarts at beat 0
      let cursor = 0;
      beats.forEach((b) => {
        if (b.midis.length) { if (!onsets.has(cursor)) onsets.set(cursor, { midis: [], frets: {}, tuplet: b.tuplet || 0 }); const o = onsets.get(cursor); b.midis.forEach((x) => o.midis.push(x)); Object.keys(b.frets).forEach((k) => { if (o.frets[k] === undefined) o.frets[k] = b.frets[k]; }); }
        cursor += b.durQuarters;
      });
    });
    const qPerBeat = 4 / btype;
    const raw = [...onsets.entries()].filter(([, o]) => o.midis.length).sort((a, b) => a[0] - b[0])
      .map(([onset, o]) => ({ symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b) => a - b), frets: o.frets, tuplet: o.tuplet || 0, onset }));
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.qbeat = e.onset / qPerBeat; e.beat = Math.max(0, Math.min(bts - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(bts - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : bts) - e.beat; });
    _fillTrueDur(events, bts);
    const md = m.meta || {};
    return { number: mi + 1, timeSig: [bts, btype], section: md.section || undefined, repeatStart: !!md.repeatStart, repeatEnd: !!md.repeatEnd, ending: md.ending || null, events: events.map(({ onset, ...e }) => e) };
  });
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : [4, 4], tuning: _tuningName(tr.tuning ? [...tr.tuning].reverse() : null), capo: tr.capo || 0, tempo, bars, parts, partIndex: idx };
}
/* ---- GP5: a separate reader (different container: RSE, page setup, directions,
 * 2 voices/measure, wider headers/tracks/notes). gt500 = format > 5.0.0 (v5.10),
 * which adds the RSE master effect, hide-tempo, track EQ and instrument-effect
 * names. Effect/chord/beat blocks reuse the GP4 helpers where identical. */
function _gp5RSEInstrument(r, gt500) { r.i32(); r.i32(); r.i32(); if (gt500) r.i32(); else { r.i16(); r.skip(1); } }
function _gp5Grace(r) { r.u8(); r.u8(); r.u8(); r.u8(); r.u8(); }
function _gp5Harmonic(r) { const t = r.i8(); if (t === 2) { r.u8(); r.i8(); r.u8(); } else if (t === 3) r.u8(); }
function _gp5NoteEffects(r) {
  const f1 = r.u8(), f2 = r.u8();
  if (f1 & 0x01) _gpReadBend(r);
  if (f1 & 0x10) _gp5Grace(r);
  if (f2 & 0x04) r.i8();                                              // tremolo picking
  if (f2 & 0x08) r.u8();                                              // slide flags
  if (f2 & 0x10) _gp5Harmonic(r);
  if (f2 & 0x20) { r.i8(); r.i8(); }                                  // trill
}
function _gp5MixTable(r, gt500) {
  const instrument = r.i8();
  _gp5RSEInstrument(r, gt500);
  if (!gt500) r.skip(1);
  const vals = [r.i8(), r.i8(), r.i8(), r.i8(), r.i8(), r.i8()];      // volume,balance,chorus,reverb,phaser,tremolo
  r.intByteString();                                                 // tempo name
  const tempo = r.i32();
  for (let i = 0; i < 6; i++) if (vals[i] >= 0) r.i8();              // durations
  if (tempo >= 0) { r.i8(); if (gt500) r.bool(); }
  r.i8();                                                            // mix-table flags
  r.i8();                                                            // wah
  if (gt500) { r.intByteString(); r.intByteString(); }              // RSE instrument effect name/category
}
function _gp5Note(r, stringNumber, tuning, state) {
  const flags = r.u8();
  let type = 1;
  if (flags & 0x20) type = r.u8();
  if (flags & 0x10) r.i8();                                          // dynamic
  let fret = null;
  if (flags & 0x20) fret = r.i8();
  if (flags & 0x80) { r.i8(); r.i8(); }                              // fingering
  if (flags & 0x01) r.skip(8);                                       // duration percent (f64)
  r.u8();                                                            // flags2 (always)
  if (flags & 0x08) _gp5NoteEffects(r);
  if (type === 2) { fret = state.lastFret[stringNumber]; if (fret == null) return null; }
  else if (type === 3) return null;
  if (fret == null) return null;
  fret = Math.min(Math.max(fret, 0), 99);
  state.lastFret[stringNumber] = fret;
  return { fret, midi: tuning[stringNumber - 1] + fret };
}
function _gp5Beat(r, stringCount, tuning, state, gt500) {
  const flags = r.u8();
  let empty = false;
  if (flags & 0x40) { const st = r.u8(); empty = st === 0; }
  const durQuarters = _gpReadDuration(r, flags);
  if (flags & 0x02) _gpReadChord(r, 4, stringCount);                 // GP4-format chord
  if (flags & 0x04) r.intByteString();
  if (flags & 0x08) _gpReadBeatEffects(r, 4);                        // GP4-format beat effects
  if (flags & 0x10) _gp5MixTable(r, gt500);
  const stringFlags = r.u8();
  const midis = [], frets = {};
  for (let s = 1; s <= stringCount; s++) {
    if (stringFlags & (1 << (7 - s))) { const note = _gp5Note(r, s, tuning, state); if (note) { midis.push(note.midi); frets[6 - s] = note.fret; } }
  }
  const f2 = r.i16();
  if (f2 & 0x0800) r.u8();                                           // break-secondary-beams count
  return { durQuarters: empty ? 0 : durQuarters, midis, frets, tuplet: r._tuplet || 0 };
}
function parseGP5(u8, version, useSharp = true, partIndex = 0) {
  const r = _gpReader(u8);
  r.version();                                                       // re-read 30-byte version
  const gt500 = !/v5\.00/.test(version);                             // 5.10+ has extra blocks
  for (let i = 0; i < 9; i++) r.intByteString();                     // info: 9 strings (GP5 splits words/music)
  const noticeLines = r.i32(); for (let i = 0; i < noticeLines; i++) r.intByteString();
  r.i32(); for (let i = 0; i < 5; i++) { r.i32(); r.intString(); }   // lyrics
  if (gt500) { r.i32(); r.i32(); for (let i = 0; i < 11; i++) r.i8(); } // RSE master effect (vol + reserved + EQ-11)
  r.skip(8 + 16 + 4); r.i16();                                       // page setup: size, margins, proportion, header/footer
  for (let i = 0; i < 10; i++) r.intByteString();                    // page-setup placeholder strings
  r.intByteString();                                                 // tempo name
  const tempo = r.i32();
  if (gt500) r.bool();                                               // hide tempo
  r.i8();                                                            // key
  r.i32();                                                           // octave
  for (let i = 0; i < 64; i++) { r.i32(); r.skip(8); }               // 64 MIDI channels
  r.skip(38);                                                        // directions: 19 shorts
  r.i32();                                                           // master reverb
  const measureCount = r.i32();
  const trackCount = r.i32();
  // --- measure headers ---
  const headers = [], meta = []; let num = 4, den = 4;
  for (let m = 0; m < measureCount; m++) {
    if (m > 0) r.skip(1);
    const flags = r.u8();
    if (flags & 0x01) num = r.i8();
    if (flags & 0x02) den = r.i8();
    const repeatStart = !!(flags & 0x04);                           // |: (flag only)
    const repeatEnd = (flags & 0x08) ? (r.i8(), true) : false;      // repeat close (count byte)
    let section = "";
    if (flags & 0x20) { section = (r.intByteString() || "").trim(); r.skip(4); } // marker = section
    if (flags & 0x40) { r.i8(); r.i8(); }                           // key sig
    const ending = _gpEndingLabel((flags & 0x10) ? r.u8() : 0);     // alt ending bitmask
    if (flags & 0x03) r.skip(4);                                     // time-sig beams
    if (!(flags & 0x10)) r.skip(1);
    r.u8();                                                          // triplet feel
    headers.push([num, den]);
    meta.push({ section, repeatStart, repeatEnd, ending });
  }
  // --- tracks ---
  const tracks = [];
  for (let t = 0; t < trackCount; t++) {
    if (t === 0 || !gt500) r.skip(1);
    r.u8();                                                          // flags1
    const name = r.byteString(40);
    const stringCount = r.i32();
    const tuning = [];
    for (let i = 0; i < 7; i++) { const tu = r.i32(); if (i < stringCount) tuning.push(tu); }
    r.i32();                                                         // port
    r.i32(); r.i32();                                                // channel
    r.i32(); const capo = r.i32();                                   // fret count, capo (kept for the export header)
    r.skip(4);                                                       // colour
    r.i16();                                                         // flags2
    r.u8(); r.u8(); r.u8();                                          // auto-accent, bank, humanize
    r.i32(); r.i32(); r.i32();                                       // clef transpose ×2 + unknown
    r.skip(12);
    _gp5RSEInstrument(r, gt500);
    if (gt500) { for (let i = 0; i < 4; i++) r.i8(); r.intByteString(); r.intByteString(); } // track EQ-4 + RSE effect names
    tracks.push({ name, stringCount, tuning, capo, measures: [] });
  }
  r.skip(gt500 ? 1 : 2);                                             // blank byte(s) after all tracks
  // --- measures (measure-major, then track; 2 voices each + line break) ---
  const state = tracks.map(() => ({ lastFret: {} }));
  for (let m = 0; m < measureCount; m++) {
    for (let t = 0; t < trackCount; t++) {
      const tr = tracks[t];
      const voices = [];
      for (let vi = 0; vi < 2; vi++) {
        const beatCount = r.i32();
        const beats = [];
        for (let b = 0; b < beatCount; b++) beats.push(_gp5Beat(r, tr.stringCount, tr.tuning, state[t], gt500));
        voices.push(beats);
      }
      if (r.pos < u8.length) r.u8();                                 // line break (absent on a final measure — PyGuitarPro reads default 0)
      tr.measures.push({ timeSig: headers[m], meta: meta[m], voices });
    }
  }
  return _gpBuildScore(tracks, tempo, version, useSharp, partIndex);
}

/* ===========================================================================
 *  PATH F — Guitar Pro 6 (`.gpx`)
 *  --------------------------------------------------------------------------
 *  A `.gpx` is a `BCFZ`-compressed `BCFS` filesystem (Guitar Pro 6's container)
 *  whose `score.gpif` is the SAME GPIF XML that GP7/8 use — so once the
 *  container is unpacked, parseGPIF does the rest (with the String+Fret
 *  fallback above, since GP6 notes carry no direct <Midi>). Zero deps: a
 *  bit-reader + the documented BCFZ LZ scheme + the sector filesystem, ported
 *  from alphaTab's GpxFileSystem. `BCFS` (uncompressed) is handled too.
 * ==========================================================================*/
function _gpxBitReader(u8) {
  let pos = 0, bit = 0;
  function readBit() { if (pos >= u8.length) throw { __gpxEof: true }; const v = (u8[pos] >> (7 - bit)) & 1; if (++bit === 8) { bit = 0; pos++; } return v; }
  function readBits(n) { let v = 0; for (let i = n - 1; i >= 0; i--) v |= readBit() << i; return v; }            // MSB-first
  function readBitsRev(n) { let v = 0; for (let i = 0; i < n; i++) v |= readBit() << i; return v; }              // LSB-first
  const readByte = () => readBits(8);
  const readBytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = readByte(); return a; };
  return { readBits, readBitsRev, readByte, readBytes };
}
const _gpxLE32 = (d, o) => ((d[o + 3] << 24) | (d[o + 2] << 16) | (d[o + 1] << 8) | d[o]) >>> 0;
function _gpxDecompress(br, skipHeader) {                                                                        // BCFZ → raw bytes
  const expected = _gpxLE32(br.readBytes(4), 0);
  const out = [];
  try {
    while (out.length < expected) {
      if (br.readBits(1) === 1) {                                                                                // back-reference
        const wordSize = br.readBits(4);
        const offset = br.readBitsRev(wordSize), size = br.readBitsRev(wordSize);
        const sp = out.length - offset, toRead = Math.min(offset, size);
        for (let i = 0; i < toRead; i++) out.push(out[sp + i]);
      } else { const size = br.readBitsRev(2); for (let i = 0; i < size; i++) out.push(br.readByte()); }         // raw bytes
    }
  } catch (e) { if (!(e && e.__gpxEof)) throw e; }
  const u = new Uint8Array(out);
  return skipHeader ? u.subarray(4) : u;
}
function _gpxReadFS(data) {                                                                                       // BCFS sector filesystem
  const SS = 0x1000, files = [];
  let offset = SS;
  while (offset + 3 < data.length) {
    if (_gpxLE32(data, offset) === 2) {                                                                          // file entry
      let name = ""; for (let i = 0; i < 127; i++) { const c = data[offset + 4 + i]; if (c === 0) break; name += String.fromCharCode(c); }
      const fileSize = _gpxLE32(data, offset + 0x8c);
      const dpo = offset + 0x94; let sc = 0; const chunks = [];
      for (;;) { const sector = _gpxLE32(data, dpo + 4 * sc++); if (sector === 0) break; offset = sector * SS; chunks.push(data.subarray(offset, offset + SS)); }
      let total = 0; chunks.forEach((c) => (total += c.length));
      const buf = new Uint8Array(total); let p = 0; chunks.forEach((c) => { buf.set(c, p); p += c.length; });
      files.push({ name, data: buf.subarray(0, Math.min(fileSize, buf.length)) });
    }
    offset += SS;
  }
  return files;
}
function parseGPX(u8, useSharp = true, partIndex = 0) {
  const br = _gpxBitReader(u8);
  const header = String.fromCharCode(...br.readBytes(4));
  let fs;
  if (header === "BCFZ") fs = _gpxReadFS(_gpxDecompress(br, true));
  else if (header === "BCFS") fs = _gpxReadFS(u8.subarray(4));
  else throw new Error("Not a GP6 .gpx file.");
  const score = fs.find((f) => /score\.gpif$/i.test(f.name)) || fs.find((f) => /\.gpif$/i.test(f.name));
  if (!score) throw new Error("No score.gpif inside the .gpx.");
  return parseGPIF(new TextDecoder("utf-8").decode(score.data), useSharp, partIndex);
}

/* ===========================================================================
 *  PATH G — Power Tab (`.ptb`) import
 *  --------------------------------------------------------------------------
 *  Power Tab Editor's `.ptb` is an MFC-`CArchive`-style binary serialization
 *  (Brad Larsen's format). This is a faithful, zero-dependency port of the
 *  documented `Deserialize` order (from the open-source powertabeditor's
 *  `powertabdocument` classes). Nothing is length-prefixed, so EVERY object —
 *  even effects/diagrams/dynamics we discard — must be consumed exactly to stay
 *  aligned (clean EOF across the corpus is the validation). We keep each
 *  position's duration + its notes (string+fret → MIDI via the guitar tuning)
 *  and emit the SAME `source:"gp"` score shape, so the rest of the app is shared.
 *
 *  Layout: header → Guitar Score + Bass Score (each: guitars, chord diagrams,
 *  floating text, guitar-ins, tempo markers, dynamics, alt endings, SYSTEMS) →
 *  3 fonts → spacing/fade. A System is a staff line holding several measures
 *  delimited by barlines; each Position is a beat, each Note packs string+fret
 *  in one byte (top 3 bits = string from high E, bottom 5 = fret). Targets the
 *  ubiquitous v1.7 (=4) files; the new-format path also covers v1.5 (=3).
 * ==========================================================================*/
function _ptbReader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const dec = new TextDecoder("latin1");
  let p = 0;
  const R = {
    get pos() { return p; }, get left() { return u8.length - p; },
    u8() { return dv.getUint8(p++); }, u16() { const v = dv.getUint16(p, true); p += 2; return v; },
    u32() { const v = dv.getUint32(p, true); p += 4; return v; }, i32() { const v = dv.getInt32(p, true); p += 4; return v; },
    skip(n) { p += n; }, bytes(n) { const a = u8.subarray(p, p + n); p += n; return a; },
    count() { const w = R.u16(); return w !== 0xffff ? w : R.u32(); },
    strLen() { const b = R.u8(); if (b < 0xff) return b; const w = R.u16(); if (w < 0xffff) return w; return R.u32(); },
    str() { const n = R.strLen(); const s = dec.decode(u8.subarray(p, p + n)); p += n; return s; },
    classInfo() { const wt = R.u16(); if (wt === 0x7fff) { R.u32(); return; } const ot = (((wt & 0x8000) << 16) | (wt & ~0x8000)) >>> 0; if (ot < 0x80000000) return; if (wt === 0xffff) { R.u16(); const len = R.u16(); R.skip(len); } },
    vector(fn) { const c = R.count(); const out = []; for (let i = 0; i < c; i++) { R.classInfo(); out.push(fn()); } return out; },
    smallVec(elem) { const n = R.u8(); return R.bytes(n * elem); },
    rect() { R.skip(16); },
  };
  return R;
}
const _ptbNew = (v) => v >= 3;                                                  // 1.5+ uses the modern object layout
const _ptbTuning = (r) => { r.str(); r.u8(); return { notes: [...r.smallVec(1)] }; }; // notes high→low
const _ptbGuitar = (r) => { r.u8(); const name = r.str(); r.skip(8); return { name, tuning: _ptbTuning(r) }; };
const _ptbChordName = (r, v) => { if (!_ptbNew(v)) { r.u8(); r.u8(); r.u16(); r.u8(); } else { r.u16(); r.u8(); r.u16(); r.u8(); } };
const _ptbChordDiagram = (r, v) => { _ptbChordName(r, v); r.u8(); r.smallVec(1); };
const _ptbFont = (r) => { r.str(); r.i32(); r.i32(); r.u8(); r.u8(); r.u8(); r.u32(); };
const _ptbFloatingText = (r, v) => { r.str(); r.rect(); r.u8(); _ptbFont(r); };
const _ptbGuitarIn = (r) => { r.u16(); r.u8(); r.u8(); r.u16(); };
const _ptbDynamic = (r, v) => { if (!_ptbNew(v)) { r.u16(); r.u8(); r.u8(); r.u8(); } else { r.u16(); r.u8(); r.u8(); r.u16(); } };
const _ptbSystemSymbol = (r) => { r.u16(); r.u8(); return r.u32(); };           // returns data (tempo BPM lives in the low word)
const _ptbTempoMarker = (r) => { const data = _ptbSystemSymbol(r); r.str(); return { data }; };
const _ptbDirection = (r) => { r.u8(); r.smallVec(2); };
const _ptbChordText = (r, v) => { r.u8(); _ptbChordName(r, v); };
const _ptbRhythmSlash = (r) => { r.u8(); r.u8(); r.u32(); };
const _ptbRehearsal = (r) => { r.u8(); r.str(); };
const _ptbBarline = (r, v) => { const pos = r.u8(); r.u8(); r.u8() /*keysig*/; const ts = r.u32(); r.u8() /*timesig pulses*/; _ptbRehearsal(r); return { pos, ts }; };
const _ptbNote = (r) => { const sd = r.u8(); r.u16(); r.smallVec(4); return { string: (sd & 0xe0) >> 5, fret: sd & 0x1f }; };
const _ptbPosition = (r, v) => { const pos = r.u8(); r.u16(); const data = r.u32(); r.smallVec(4); const notes = r.vector(() => _ptbNote(r)); return { pos, durType: (data >>> 24) & 0xff, dotted: data & 1, dbl: data & 2, notes }; };
const _ptbStaff = (r, v) => { r.u8(); r.skip(4); return { voices: [r.vector(() => _ptbPosition(r, v)), r.vector(() => _ptbPosition(r, v))] }; };
function _ptbSystem(r, v) {
  r.rect(); r.u8() /*endBar*/; r.skip(4);
  const startBar = _ptbBarline(r, v);
  r.vector(() => _ptbDirection(r)); r.vector(() => _ptbChordText(r, v)); r.vector(() => _ptbRhythmSlash(r));
  const staves = r.vector(() => _ptbStaff(r, v));
  const bars = r.vector(() => _ptbBarline(r, v));
  return { startBar, staves, bars };
}
function _ptbScore(r, v) {
  const guitars = r.vector(() => _ptbGuitar(r));
  r.vector(() => _ptbChordDiagram(r, v)); r.vector(() => _ptbFloatingText(r, v)); r.vector(() => _ptbGuitarIn(r));
  const tempoMarkers = r.vector(() => _ptbTempoMarker(r));
  r.vector(() => _ptbDynamic(r, v)); r.vector(() => _ptbSystemSymbol(r)) /*alt endings*/;
  const systems = r.vector(() => _ptbSystem(r, v));
  return { guitars, tempoMarkers, systems };
}
function _ptbHeader(r) {
  if (r.u32() !== 0x62617470) throw new Error("Not a Power Tab (.ptb) file.");
  const v = r.u16();
  const fileType = r.u8();
  if (fileType === 0) {                                                         // song
    r.u8(); r.str(); r.str();                                                   // contentType, title, artist
    const rel = r.u8();
    if (rel === 0) { r.u8(); r.str(); r.u16(); r.u8(); }                        // audio
    else if (rel === 1) { r.str(); r.u8(); }                                    // video
    else if (rel === 2) { r.str(); r.u16(); r.u16(); r.u16(); }                 // bootleg
    if (r.u8() === 0) { r.str(); r.str(); }                                     // authorType==known → composer, lyricist
    for (let i = 0; i < 7; i++) r.str();                                        // arranger…bassScoreNotes
  } else { r.str(); r.str(); r.u16(); r.u8(); r.str(); r.str(); r.str(); }      // lesson
  return v;
}
function _ptbTimeSig(data) {
  if (data & 0x400000) return { beats: 4, beatType: 4, show: !!(data & 0x100000) }; // common
  if (data & 0x800000) return { beats: 2, beatType: 2, show: !!(data & 0x100000) }; // cut
  return { beats: ((data >>> 27) & 0x1f) + 1, beatType: 1 << ((data >>> 24) & 0x7), show: !!(data & 0x100000) };
}
function parsePowerTab(u8, useSharp = true, partIndex = 0) {
  const r = _ptbReader(u8);
  const v = _ptbHeader(r);
  const guitarScore = _ptbScore(r, v);
  const bassScore = _ptbScore(r, v);
  // (3 document fonts + spacing/fade follow but aren't needed; parse stops here.)
  const all = [
    ...guitarScore.guitars.map((g) => ({ g, score: guitarScore, base: 0 })),
    ...bassScore.guitars.map((g) => ({ g, score: bassScore, base: guitarScore.guitars.length })),
  ];
  if (!all.length) throw new Error("No guitars found in the .ptb file.");
  const parts = all.map((x, i) => ({ index: i, id: String(i), name: (x.g.name || "").trim() || `Guitar ${i + 1}` }));
  const idx = Math.max(0, Math.min(all.length - 1, partIndex | 0));
  const sel = all[idx], staffIdx = idx - sel.base, tuning = sel.g.tuning.notes, tunLen = tuning.length;
  let tempo = null;
  const tm = guitarScore.tempoMarkers[0] || bassScore.tempoMarkers[0];
  if (tm) { const bpm = tm.data & 0xffff; if (bpm >= 20 && bpm <= 400) tempo = bpm; }

  const bars = []; let curTS = [4, 4], barNum = 1;
  for (const sys of sel.score.systems) {
    const staff = sys.staves[staffIdx]; if (!staff) continue;
    const positions = staff.voices[0];
    const barlines = [sys.startBar, ...sys.bars].slice().sort((a, b) => a.pos - b.pos);
    let maxPos = 1; positions.forEach((p) => { if (p.pos + 1 > maxPos) maxPos = p.pos + 1; }); barlines.forEach((b) => { if (b.pos + 1 > maxPos) maxPos = b.pos + 1; });
    for (let i = 0; i < barlines.length; i++) {
      const start = barlines[i].pos, end = i + 1 < barlines.length ? barlines[i + 1].pos : maxPos;
      const ts = _ptbTimeSig(barlines[i].ts); if (ts.show || barNum === 1) curTS = [ts.beats, ts.beatType];
      const [bts, btype] = curTS;
      const onsets = new Map(); let cursor = 0;
      positions.filter((p) => p.pos >= start && p.pos < end).forEach((pp) => {
        const durType = pp.durType >= 1 && pp.durType <= 64 ? pp.durType : 4;
        const durQ = (4 / durType) * (pp.dotted ? 1.5 : pp.dbl ? 1.75 : 1);
        if (pp.notes.length) {
          const o = { midis: [], frets: {} };
          pp.notes.forEach((n) => { const open = tuning[n.string]; if (open !== undefined) { o.midis.push(open + n.fret); const eng = tunLen - 1 - n.string; if (eng >= 0 && eng <= 5 && o.frets[eng] === undefined) o.frets[eng] = n.fret; } });
          if (o.midis.length) onsets.set(cursor, o);
        }
        cursor += durQ;
      });
      const qPerBeat = 4 / btype;
      const raw = [...onsets.entries()].sort((a, b) => a[0] - b[0]).map(([onset, o]) => ({ symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b) => a - b), frets: o.frets, onset }));
      const events = [];
      raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
      events.forEach((e) => { e.qbeat = e.onset / qPerBeat; e.beat = Math.max(0, Math.min(bts - 1, Math.round(e.qbeat))); });
      for (let k = 1; k < events.length; k++) if (events[k].beat <= events[k - 1].beat) events[k].beat = Math.min(bts - 1, events[k - 1].beat + 1);
      events.forEach((e, k) => { e.durBeats = (k + 1 < events.length ? events[k + 1].beat : bts) - e.beat; });
      _fillTrueDur(events, bts);                                     // true qbeat/qdur for ABC + playback (never 0)
      bars.push({ number: barNum++, timeSig: [bts, btype], events: events.map(({ onset, ...e }) => e) });
    }
  }
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : [4, 4], tuning: _tuningName(tuning.length === 6 ? [...tuning].reverse() : null), tempo, bars, parts, partIndex: idx };
}

/* Detect format from the file head and dispatch to the right parser. */
async function parseGuitarProOrXML(buf, fileName, useSharp = true, partIndex = 0) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(u8.subarray(0, 32));
  if (u8[0] === 0x50 && u8[1] === 0x4b) { const xml = await gpUnzip(u8); const sc = parseGPIF(xml, useSharp, partIndex); sc._xml = xml; return sc; }        // GP7/8
  if (head.startsWith("BCFZ") || head.startsWith("BCFS")) { const sc = parseGPX(u8, useSharp, partIndex); sc._gpxbuf = u8; return sc; }                      // GP6 .gpx
  if (head.includes("FICHIER GUITAR PRO")) { const sc = parseGP345(u8, useSharp, partIndex); sc._gpbuf = u8; return sc; }                                  // GP3/4/5
  if (head.startsWith("ptab")) { const sc = parsePowerTab(u8, useSharp, partIndex); sc._ptbbuf = u8; return sc; }                                          // Power Tab .ptb
  const xml = new TextDecoder("utf-8").decode(u8); const sc = parseMusicXML(xml, useSharp, partIndex); sc._xml = xml; return sc;                            // MusicXML
}

/* ---- key + roman-numeral analysis ----------------------------------------
 * Infers the most likely major/minor key by scoring all 24 keys: each chord
 * adds its duration if it's diatonic to that key (a reduced amount if only its
 * root fits — a borrowed quality), with a small cadential bonus for the last/
 * first chord being the tonic. `romanFor` then labels a chord relative to that
 * key; non-diatonic chords fall back to their absolute symbol. Pure + testable.
 * ------------------------------------------------------------------------- */
const _PC_BY_NAME = (() => { const m = {}; NOTE_SHARP.forEach((n, i) => (m[n] = i)); NOTE_FLAT.forEach((n, i) => (m[n] = i)); return m; })();
const _MAJ = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
const _MIN = { 0: 0, 2: 1, 3: 2, 5: 3, 7: 4, 8: 5, 10: 6, 11: 6 }; // 11 = leading-tone vii°
const _MAJ_Q = { 0: "maj", 2: "min", 4: "min", 5: "maj", 7: "maj", 9: "min", 11: "dim" };
const _MIN_Q = { 0: "min", 2: "dim", 3: "maj", 5: "min", 7: "min", 8: "maj", 10: "maj", 11: "dim" };
const _ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
function _classOf(suf) {
  if (suf === "5") return "power";
  if (suf === "m7♭5" || suf === "m7b5") return "dim";
  if (suf === "dim" || suf === "dim7") return "dim";
  if (suf === "aug") return "aug";
  if (/^m(?!aj)/.test(suf)) return "min";        // m, m7, m6 — but not maj7
  if (suf === "7" || suf === "9" || suf === "13" || suf === "7sus4") return "dom";
  if (suf.startsWith("sus")) return "sus";
  return "maj";                                   // "", 6, maj7
}
function _parseSym(symbol) {
  if (!symbol) return { pc: null };
  const head = String(symbol).split("/")[0];
  const mm = head.match(/^([A-G][#b♯♭]?)(.*)$/);
  if (!mm) return { pc: null };
  const root = mm[1].replace("♯", "#").replace("♭", "b");
  const pc = _PC_BY_NAME[root];
  if (pc === undefined) return { pc: null };
  return { pc, suffix: mm[2], cls: _classOf(mm[2]) };
}
function qualCompatible(mode, rel, cls) {
  const exp = (mode === "major" ? _MAJ_Q : _MIN_Q)[rel];
  if (exp === undefined) return false;
  if (cls === "power" || cls === "sus") return true;          // no 3rd → fits either
  if (exp === "maj") return cls === "maj" || cls === "dom";
  if (exp === "min") return cls === "min" || (mode === "minor" && rel === 7 && (cls === "maj" || cls === "dom")); // harmonic V
  if (exp === "dim") return cls === "dim";
  return false;
}
function analyzeKey(score) {
  const parsed = [];
  for (const b of score.bars) for (const e of b.events) { const p = _parseSym(e.symbol); if (p.pc != null) parsed.push({ ...p, dur: Math.max(0.5, e.durBeats || 1) }); }
  if (!parsed.length) return null;
  const total = parsed.reduce((s, p) => s + p.dur, 0);
  const first = parsed[0].pc, last = parsed[parsed.length - 1].pc;
  let best = null;
  for (let tonic = 0; tonic < 12; tonic++) for (const mode of ["major", "minor"]) {
    const idx = mode === "major" ? _MAJ : _MIN;
    let sc = 0;
    for (const p of parsed) { const rel = (p.pc - tonic + 12) % 12; if (rel in idx) sc += qualCompatible(mode, rel, p.cls) ? p.dur : p.dur * 0.3; }
    if (last === tonic) sc += total * 0.08;
    if (first === tonic) sc += total * 0.04;
    if (!best || sc > best.sc) best = { tonic, mode, sc };
  }
  return { tonic: best.tonic, mode: best.mode, confidence: best.sc / (total || 1) };
}
const _romanExt = (suf) => ({ "7": "7", m7: "7", dim7: "7", maj7: "maj7", "6": "6", m6: "6", sus2: "sus2", sus4: "sus4", "7sus4": "7sus4" }[suf] || "");
function romanFor(symbol, key) {
  const p = _parseSym(symbol);
  if (p.pc == null || !key) return symbol;
  const rel = (p.pc - key.tonic + 12) % 12;
  const idx = (key.mode === "major" ? _MAJ : _MIN)[rel];
  if (idx === undefined) return symbol;            // non-diatonic → absolute symbol
  const base = _ROMAN[idx];
  let num;
  if (p.cls === "dim") num = base.toLowerCase() + (p.suffix === "m7♭5" || p.suffix === "m7b5" ? "ø" : "°");
  else if (p.cls === "min") num = base.toLowerCase();
  else if (p.cls === "aug") num = base + "+";
  else num = base;
  return num + _romanExt(p.suffix);
}
function keyName(key, useSharp) {
  if (!key) return null;
  return (useSharp ? NOTE_SHARP : NOTE_FLAT)[key.tonic] + (key.mode === "minor" ? "m" : "");
}
/* describeScore — a local, zero-dep analog of the music skill's `describe` command (which
 * returns a description + tags/genres/instruments for an audio file). The app already
 * computes every ingredient — key, meter, tempo, tuning, chord vocabulary — so this just
 * gathers them into one at-a-glance summary ABOUT a decoded chart. Pure + reads-only, so
 * it can NEVER touch the validated recognition corpus (it's metadata, not recognition).
 * Returns { title, key, keyConfidence, tempo, timeSig, tuning, capo, bars, events,
 * uniqueChords, chords:[{symbol,count}], sections, melodic, complexity, tags }. A natural
 * home for a chart "info" readout and a richer CSMP/handoff header. */
function describeScore(score, opts = {}) {
  const useSharp = opts.useSharp !== false;
  const bars = (score && score.bars) || [];
  const counts = new Map();
  const sections = [];
  let events = 0, ext = 0, sevenths = 0, slashes = 0;
  for (const b of bars) {
    if (b.section) sections.push(b.section);
    for (const e of b.events || []) {
      events++;
      const sym = e.symbol;
      if (!sym || sym === "—") continue;
      counts.set(sym, (counts.get(sym) || 0) + 1);
      if (String(sym).includes("/")) slashes++;
      const suf = (_parseSym(sym).suffix) || "";
      if (/9|11|13|add|maj7|6\/9|m\(maj7\)|♭9|♯9/.test(suf)) ext++;
      if (/7/.test(suf)) sevenths++;
    }
  }
  const chords = [...counts.entries()].map(([symbol, count]) => ({ symbol, count }))
    .sort((a, b) => b.count - a.count || String(a.symbol).localeCompare(String(b.symbol)));
  const uniqueChords = chords.length;
  const key = analyzeKey(score);
  const timeSig = score && score.timeSig ? `${score.timeSig[0]}/${score.timeSig[1]}` : null;
  const melodic = isMelodicScore(score);
  const extRatio = events ? ext / events : 0;
  const complexity = uniqueChords <= 4 && extRatio < 0.1 ? "simple"
    : (uniqueChords <= 8 && extRatio < 0.25 ? "moderate" : "complex");
  const tags = [];
  if (key) tags.push(key.mode === "minor" ? "minor key" : "major key");
  if (timeSig === "3/4") tags.push("waltz (3/4)");
  else if (score && score.timeSig && score.timeSig[1] === 8 && score.timeSig[0] % 3 === 0) tags.push("compound meter");
  else if (timeSig && timeSig !== "4/4") tags.push(`${timeSig} time`);
  if (extRatio >= 0.25) tags.push("jazz / extended harmony");
  else if (events && sevenths / events >= 0.3) tags.push("seventh chords");
  else if (ext === 0 && sevenths === 0 && events) tags.push("triadic");
  if (slashes >= Math.max(2, events * 0.15)) tags.push("slash / inversions");
  if (melodic) tags.push("melodic / single-note line");
  return {
    title: opts.title || null,
    key: keyName(key, useSharp),
    keyConfidence: key ? +key.confidence.toFixed(2) : null,
    tempo: (score && score.tempo) || opts.tempo || null,
    timeSig, tuning: (score && score.tuning) || null, capo: (score && score.capo) || 0,
    bars: bars.length, events, uniqueChords, chords, sections, melodic, complexity, tags,
  };
}
/* scoreToMusicPrompt — the recognize→generate bridge to the ListenHub **music** skill
 * (`@marswave/listenhub-cli`, a Node-only shell CLI: `listenhub music generate`). The app
 * is zero-server / client-side and the CLI needs Node + auth, so it can't run IN the app —
 * instead this turns a decoded chart into a ready-to-run `music generate` command the user
 * pastes into THEIR ListenHub environment. Pure: derives a natural-language `--prompt` from
 * `describeScore` (key / tempo / meter / harmony tags) + a collapsed chord-progression
 * digest, an honest `--style` (only when the harmony signals it), and shell-safe quoting.
 * Returns { prompt, style, title, instrumental, command, describe }. `opts`: title, style,
 * instrumental, maxChords, tempo, useSharp. */
function scoreToMusicPrompt(score, opts = {}) {
  const d = describeScore(score, opts);
  // progression digest: symbols across bars, consecutive duplicates collapsed, capped
  const maxChords = opts.maxChords != null ? opts.maxChords : 24;
  const seq = [];
  for (const b of (score && score.bars) || []) for (const e of b.events || []) {
    const s = e.symbol;
    if (!s || s === "—") continue;
    if (!seq.length || seq[seq.length - 1] !== s) seq.push(s);
  }
  const shown = seq.slice(0, maxChords);
  const progression = shown.join(" ") + (seq.length > maxChords ? " …" : "");
  // honest style: only assert a genre the harmony actually signals
  const style = opts.style != null ? opts.style
    : (d.tags.includes("jazz / extended harmony") ? "jazz" : null);
  const parts = [];
  parts.push(`A ${d.complexity} chord progression`);
  if (d.key) parts.push(`in ${d.key}`);
  const meta = [];
  if (d.tempo) meta.push(`${d.tempo} BPM`);
  if (d.timeSig) meta.push(`${d.timeSig} time`);
  if (meta.length) parts.push(`(${meta.join(", ")})`);
  const descriptors = d.tags.filter((t) => !/^\d+ sections$/.test(t));
  let prompt = parts.join(" ");
  if (descriptors.length) prompt += ` — ${descriptors.join(", ")}`;
  if (progression) prompt += `. Follow these chord changes: ${progression}`;
  prompt += ".";
  const title = opts.title || (score && score.title) || null;
  const instrumental = !!opts.instrumental;
  const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  let command = `listenhub music generate --prompt ${q(prompt)}`;
  if (style) command += ` --style ${q(style)}`;
  if (title) command += ` --title ${q(title)}`;
  if (instrumental) command += ` --instrumental`;
  return { prompt, style, title, instrumental, command, describe: d };
}

/* ---- exporters: a score → ChordPro grid / ABC (chords + playable notes) ----
 * Both accept an `overrides` map ({ "<bar>.<beat>": "Symbol" }) so user edits
 * flow straight into the exported text. ABC emits the actual chord tones as
 * notes (with the symbol as a guitar-chord annotation) so the result is real,
 * playable music — that's what the in-app preview / play-sheet-music consume.
 * ------------------------------------------------------------------------- */
const _ovSym = (bar, e, ov) => (ov && ov[`${bar.number}.${e.beat}`] != null ? ov[`${bar.number}.${e.beat}`] : e.symbol);
const _ABC_LTR = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const _ABC_ACC = ["", "^", "", "^", "", "", "^", "", "^", "", "^", ""];
function midiToAbc(m) {
  const pc = ((m % 12) + 12) % 12, oct = Math.floor(m / 12) - 1;
  let note = _ABC_LTR[pc];
  if (oct >= 5) { note = note.toLowerCase(); for (let o = 6; o <= oct; o++) note += "'"; }
  else { for (let o = oct; o < 4; o++) note += ","; }
  return _ABC_ACC[pc] + note;
}
const _gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = b; b = a % b; a = t; } return a || 1; };
function abcDur(durBeats, beatType) {
  // ABC length multiplier (relative to L:1/4) = durBeats·4/beatType, as a reduced
  // fraction. Scale by 12 so eighths/sixteenths AND triplets stay integer, round
  // away float noise, and NEVER emit 0 — a 0 multiplier is invalid ABC (renderers
  // drop the note or fail to parse). Callers pass the TRUE duration (e.qdur).
  let num = Math.round(durBeats * 4 * 12), den = beatType * 12;
  if (num < 1) num = 1;
  const g = _gcd(num, den); num /= g; den /= g;
  if (den === 1) return num === 1 ? "" : String(num);
  return (num === 1 ? "" : String(num)) + "/" + den;
}
const _abcChordName = (s) => s.replace(/♭/g, "b").replace(/♯/g, "#").replace(/"/g, "");
function scoreToABC(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b0, bt0] = score.timeSig;
  const out = ["X:1", `T:${opts.title || "Tab Decoder chart"}`, `M:${b0}/${bt0}`, "L:1/4"];
  if (opts.tempo) out.push(`Q:1/4=${Math.round(opts.tempo)}`);
  out.push(`K:${keyName(opts.key, opts.useSharp !== false) || "C"}`);
  let curSig = `${b0}/${bt0}`, body = "";
  score.bars.forEach((bar, bi) => {
    const [bb, bt] = bar.timeSig || score.timeSig;
    const sig = `${bb}/${bt}`;
    let cell = "";
    if (sig !== curSig) { cell += `[M:${sig}]`; curSig = sig; }
    bar.events.forEach((e) => {
      const dur = abcDur(e.qdur != null ? e.qdur : e.durBeats, bt); // TRUE duration (never 0)
      const inner = e.midis && e.midis.length ? `[${e.midis.map(midiToAbc).join("")}]${dur}` : `z${dur}`;
      cell += `"${_abcChordName(_ovSym(bar, e, ov))}"${inner} `;
    });
    body += cell.trim() + " |";
    body += (bi + 1) % 4 === 0 ? "\n" : " ";
  });
  out.push(body.trim());
  return out.join("\n") + "\n";
}
function scoreToChordPro(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b, bt] = score.timeSig;
  const out = [`{title: ${opts.title || "Tab Decoder chart"}}`, `{time: ${b}/${bt}}`];
  if (opts.key) out.push(`{key: ${keyName(opts.key, opts.useSharp !== false)}}`);
  out.push("{start_of_grid}");
  let row = [];
  score.bars.forEach((bar, bi) => {
    row.push(bar.events.map((e) => _ovSym(bar, e, ov)).join(" "));
    if ((bi + 1) % 4 === 0) { out.push("| " + row.join(" | ") + " |"); row = []; }
  });
  if (row.length) out.push("| " + row.join(" | ") + " |");
  out.push("{end_of_grid}");
  return out.join("\n") + "\n";
}
/* ---- CSMPN export: Chord Sheet Maker Pro's NATIVE fake-book source ---------
 * CSMPN is the source language of chord-sheet-maker-pro (the "finishing" app):
 * a header block (Title/Composer/Key/Time/Tempo) then `- Section` markers and
 * pipe-delimited bars (`| C | Am F | G |`). Multiple chords in one bar are
 * space-separated (standard fake-book grid); an empty/unrecognised bar becomes
 * `N.C.` (Pro's no-chord token). This is what the cross-app handoff hands over,
 * so Pro receives its own native syntax — no lossy re-parse. Honours overrides,
 * transpose (the score is already transposed by the caller), the ♯/♭ setting,
 * the detected key, and the (possibly user-edited) tempo. Mirrors the
 * scoreToChordPro grid layout (4 bars/row) for readability. */
const _csmpnSym = (s) => (!s || s === "—" ? "N.C." : s);
/* Largest slash-duration letter whose quarter-value is ≤ q. Used so a {hybrid}
 * event's notated duration never exceeds the gap to the next onset — CSMP drops
 * any event that overlaps the previous one (`beat < prevBeat + prevBeats`). */
const _CSMPN_DUR = [["w", 4], ["h", 2], ["q", 1], ["e", 0.5], ["s", 0.25]];
const _csmpnDurLetter = (q) => { for (const [l, v] of _CSMPN_DUR) if (q + 1e-6 >= v) return l; return "s"; };
/* Normal-note count for an N-tuplet (largest power of 2 ≤ N): 3→2, 5/6/7→4, 9→8.
 * Matches CSMP's hrTupletNormal — used to recover a tuplet event's WRITTEN note
 * value from its (shorter) sounding duration so a triplet-eighth notates as `e`. */
const _csmpnTupNormal = (n) => { let p = 1; while (p * 2 <= n) p *= 2; return p; };
/* Cumulative-quarter onset → CSMP hybrid beat position ("1","1&","2",…),
 * mirroring importGuitarPro.js `_cumQToHybridPos` (frac ≥ 0.4 → the "&" off-beat). */
const _csmpnHybridPos = (cumQ) => { const w = Math.floor(cumQ + 1e-6); return (cumQ - w >= 0.4 ? `${w + 1}&` : String(w + 1)); };
/* Event.frets ({engIdx→fret}, 0 = low E … 5 = high e) → CSMP {tab} voicing string,
 * ordered high-e (string 1) → low-E (string 6); a string with no fret is muted "x".
 * The decoder read these frets off the page, so the diagram is the REAL fingering,
 * not a generic shape. Returns null if nothing is fretted (or frets is absent —
 * e.g. after transpose, which drops position-specific frets). */
const _csmpnVoicing = (frets) => {
  if (!frets) return null;
  const out = []; let any = false;
  for (let eng = 5; eng >= 0; eng--) { if (frets[eng] != null) { out.push(String(frets[eng])); any = true; } else out.push("x"); }
  return any ? out.join(",") : null;
};
/* Performance headers shared by CSMPN + CSML: the decoder's detected tuning
 * (e.g. "Standard", "Drop D" — from the file, omitted for PDF charts that carry
 * none) and capo fret (GP3/4/5; 0 → omitted). `opts` overrides the score values.
 * Lets Pro render the right TAB/diagrams instead of assuming standard + no capo. */
function _csmPerfHeaders(score, opts) {
  const lines = [];
  const tuning = opts.tuning != null ? opts.tuning : score.tuning;
  if (tuning) lines.push(`Tuning: ${tuning}`);
  const capo = opts.capo != null ? opts.capo : score.capo;
  if (capo) lines.push(`Capo: ${capo}`);
  return lines;
}
function scoreToCSMPN(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b, bt] = score.timeSig;
  const out = [`Title: ${opts.title || "Tab Decoder chart"}`];
  if (opts.composer) out.push(`Composer: ${opts.composer}`);
  const kn = keyName(opts.key, opts.useSharp !== false);
  if (kn) out.push(`Key: ${kn}`);
  out.push(`Time: ${b}/${bt}`);
  if (opts.tempo) out.push(`Tempo: ${Math.round(opts.tempo)}`);
  _csmPerfHeaders(score, opts).forEach((l) => out.push(l));
  out.push("");
  // CSMPN native (chordsheet.com) grammar: bars are delimited by explicit barline
  // tokens — `|` between bars, `||` a double/section-end bar, `|:`/`:|` a repeat, `|]`
  // a final bar (parseBarStructures filters every barline token and takes each
  // whitespace token between them as a bar). Multiple chords in a bar are joined with
  // `_` (Bb7_A7) — a space would make them separate bars. `1.`/`2.` mark endings; a
  // `- Name` line starts a section; `%` repeats the previous bar (simile); an empty bar
  // is `N.C.`. ~4 bars/row, matching CSMP's own GP-importer house style. This mirrors
  // the finishing app's Sprint 18 native syntax so a decoded chart reads identically to
  // a chart authored by hand in chordsheet.com's language.
  const bars = score.bars;
  const hasSections = bars.some((bar) => bar.section);
  // A bar closes its section when the next bar opens a new one (`section` label rides
  // only on a section's first bar) or it is the last bar → its right barline is `||`.
  const sectionEnd = (idx) => idx === bars.length - 1 || !!(bars[idx + 1] && bars[idx + 1].section);
  let row = [], prevCell = null, curSection = null, n = 0;
  const flush = () => { if (row.length) { out.push(row.join(" ")); row = []; } };
  if (!hasSections) out.push("- Chart");
  bars.forEach((bar, idx) => {
    if (hasSections && bar.section && bar.section !== curSection) { flush(); out.push("- " + bar.section); curSection = bar.section; prevCell = null; n = 0; }
    let cell = bar.events.length ? bar.events.map((e) => _csmpnSym(_ovSym(bar, e, ov))).join("_") : "N.C.";
    if (cell !== "N.C." && cell === prevCell) cell = "%"; else prevCell = cell;
    // one bar segment = optional `|:` open, optional `1.`/`2.` ending, the chord cell,
    // then a right barline (`:|` repeat-close wins, else `||` at a section end, else `|`).
    const seg = [];
    if (bar.repeatStart) seg.push("|:");
    if (bar.ending) seg.push(bar.ending + ".");
    seg.push(cell);
    seg.push(bar.repeatEnd ? ":|" : sectionEnd(idx) ? "||" : "|");
    row.push(seg.join(" "));
    if (++n % 4 === 0) { flush(); }
  });
  flush();

  // {tab} — unique chord voicings read off the page (Event.frets), so CSMP renders
  // the REAL fingering as a TAB staff + chord-diagram grid, not a generic shape.
  // First-seen voicing per chord wins (matches the GP importer). Naturally empty
  // when transposed (transposeScore drops frets), so a wrong fingering is never sent.
  if (opts.tab !== false) {
    const tabLines = [], seen = Object.create(null);
    score.bars.forEach((bar) => bar.events.forEach((e) => {
      const sym = _csmpnSym(_ovSym(bar, e, ov)), v = _csmpnVoicing(e.frets);
      if (v && sym !== "N.C." && !seen[sym]) { seen[sym] = true; tabLines.push(`  ${sym}: ${v}`); }
    }));
    if (tabLines.length) { out.push("{tab"); tabLines.forEach((l) => out.push(l)); out.push("}"); }
  }

  // {hybrid} — the REAL onset rhythm (qbeat/qdur, the decoder's true timing) as one
  // `barN:` line per bar, so CSMP's Slash-Rhythm View shows the actual strum/comp
  // rhythm instead of even slashes. Beat position is in quarter units (matches the GP
  // importer); duration is floor-mapped to the gap so CSMP never drops an event.
  if (opts.hybrid !== false) {
    const hyb = [];
    score.bars.forEach((bar, bi) => {
      const lbt = (bar.timeSig || score.timeSig)[1], evs = bar.events;
      const toks = evs.map((e, ei) => {
        const cumQ = (e.qbeat != null ? e.qbeat : e.beat) * 4 / lbt;
        // `tN` tuplet flag, but only when this event sits in a run of ≥2 same-tuplet
        // events — a lone tagged note would draw a spurious bracket. CSMP brackets
        // the group and skips its overlap check for same-tuplet events.
        const tup = e.tuplet | 0;
        const grouped = tup > 1 && ((ei > 0 && (evs[ei - 1].tuplet | 0) === tup) || (ei + 1 < evs.length && (evs[ei + 1].tuplet | 0) === tup));
        // Tuplet events: recover the WRITTEN note value (sounding × N/normal) so a
        // triplet-eighth notates as `e`, not its 1/3-quarter sounding `s`.
        let durQ = (e.qdur != null ? e.qdur : e.durBeats) * 4 / lbt;
        if (grouped) durQ *= tup / _csmpnTupNormal(tup);
        const pos = _csmpnHybridPos(cumQ), dur = _csmpnDurLetter(durQ), sym = _csmpnSym(_ovSym(bar, e, ov));
        return (e.midis && e.midis.length) ? `${pos}:${dur}(${sym})${grouped ? `t${tup}` : ""}` : `${pos}:r${dur}`;
      });
      if (toks.length) hyb.push(`  bar${bi + 1}: ${toks.join(" ")}`);
    });
    if (hyb.length) { out.push("{hybrid"); hyb.forEach((l) => out.push(l)); out.push("}"); }
  }
  return out.join("\n") + "\n";
}

/* ---- ChordSlashML export: CSMP's beat-slotted notation ----------------------
 * A DIFFERENT format from the CSMPN fakebook: `[Section]` labels and pipe-delimited
 * measures whose beat slots are space-separated. Each measure has `_csmlBeats`
 * slots (4/4→4, 12/8→4, 6/8→2, 9/8→3, 3/4→3); a chord sits on its beat, a bare
 * (space-separated) `_` holds the previous chord, `.` is a rest before the first
 * chord, and `A_B` (joined, no space) is a compound beat (two chords share one
 * slot). Mirrors CSMP's `csmlParse` grammar so it round-trips through the
 * ChordSlashML live editor. Honours overrides/transpose/♯♭/key/tempo via `opts`. */
const _csmlBeats = (num, den) => (den === 8 && num % 3 === 0 ? num / 3 : num);
const _ordinal = (s) => { const k = parseInt(s, 10); return k === 1 ? "1st" : k === 2 ? "2nd" : k === 3 ? "3rd" : k + "th"; };
function scoreToCSML(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b, bt] = score.timeSig;
  const out = [`Title: ${opts.title || "Tab Decoder chart"}`];
  if (opts.composer) out.push(`Composer: ${opts.composer}`);
  const kn = keyName(opts.key, opts.useSharp !== false);
  if (kn) out.push(`Key: ${kn}`);
  out.push(`Time: ${b}/${bt}`);
  if (opts.tempo) out.push(`Tempo: ${Math.round(opts.tempo)}`);
  _csmPerfHeaders(score, opts).forEach((l) => out.push(l));
  out.push("");
  // each bar → its beat-slot string + repeat-barline flags; grouped into `[Section]`
  // (and `[Nth Ending]`) label blocks; rendered 4 measures/row with `|`/`|:`/`:|`.
  const mlist = score.bars.map((bar) => {
    const [num, den] = bar.timeSig || score.timeSig;
    const pulses = Math.max(1, _csmlBeats(num, den));
    const slots = new Array(pulses).fill(null);
    let any = false;
    bar.events.forEach((e) => {
      const sym = _csmpnSym(_ovSym(bar, e, ov));
      if (sym === "N.C.") return;
      const qb = e.qbeat != null ? e.qbeat : e.beat;
      const idx = Math.max(0, Math.min(pulses - 1, Math.round((qb * pulses) / num)));
      if (slots[idx]) slots[idx].push(sym); else slots[idx] = [sym];
      any = true;
    });
    let started = false;
    const cells = slots.map((s) => { if (s) { started = true; return s.join("_"); } return started ? "_" : "."; });
    if (!any) { cells[0] = "N.C."; for (let k = 1; k < cells.length; k++) cells[k] = "_"; }
    return { beats: cells.join(" "), repStart: !!bar.repeatStart, repEnd: !!bar.repeatEnd, section: bar.section || "", ending: bar.ending || null };
  });
  const hasSec = mlist.some((m) => m.section || m.ending);
  if (!hasSec) out.push("[Chart]");
  // render a run of measures as one barlined line (`|: A | B :|`), handling abutting repeats.
  const renderRow = (ms) => {
    const t = [];
    ms.forEach((m, i) => {
      if (i === 0) t.push(m.repStart ? "|:" : "|");
      else { const p = ms[i - 1]; if (p.repEnd) t.push(":|"); if (m.repStart) t.push("|:"); if (!p.repEnd && !m.repStart) t.push("|"); }
      t.push(m.beats);
    });
    t.push(ms[ms.length - 1].repEnd ? ":|" : "|");
    return t.join(" ");
  };
  let curSec = null, curEnd = null, run = [];
  const flush = () => { if (run.length) { out.push(renderRow(run)); run = []; } };
  mlist.forEach((m) => {
    if (m.section && m.section !== curSec) { flush(); out.push("[" + m.section + "]"); curSec = m.section; curEnd = null; }
    if (m.ending && m.ending !== curEnd) { flush(); out.push("[" + _ordinal(m.ending) + " Ending]"); curEnd = m.ending; }
    run.push(m);
    if (run.length === 4) flush();
  });
  flush();
  return out.join("\n") + "\n";
}

/* ---- MusicXML export: a proper round-trippable chord chart -----------------
 * Emits both a <harmony> (chord symbol, so MuseScore / Guitar Pro show it above
 * the staff) AND the voiced <note> pitches (so the staff is real music). Because
 * the notes are present, re-importing through parseMusicXML reconstructs the same
 * symbols — the export/import round-trip is itself a test. Honours overrides +
 * transpose (the score is already transposed by the caller) and per-bar meter. */
const _STEP_ALTER_SHARP = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]];
const _STEP_ALTER_FLAT = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]];
const _pcStepAlter = (pc, useSharp) => (useSharp ? _STEP_ALTER_SHARP : _STEP_ALTER_FLAT)[((pc % 12) + 12) % 12];
const _XML_KIND = { "": "major", m: "minor", "7": "dominant", maj7: "major-seventh", m7: "minor-seventh", m6: "minor-sixth", "6": "major-sixth", dim: "diminished", dim7: "diminished-seventh", "m7♭5": "half-diminished", m7b5: "half-diminished", aug: "augmented", sus2: "suspended-second", sus4: "suspended-fourth", "7sus4": "dominant", "5": "power" };
function _midiToPitchXML(m, useSharp) {
  const [step, alter] = _pcStepAlter(((m % 12) + 12) % 12, useSharp);
  return { step, alter, oct: Math.floor(m / 12) - 1 };
}
function _typeForQuarters(q) {
  const T = { 4: ["whole", 0], 2: ["half", 0], 1: ["quarter", 0], 0.5: ["eighth", 0], 0.25: ["16th", 0], 6: ["whole", 1], 3: ["half", 1], 1.5: ["quarter", 1], 0.75: ["eighth", 1] };
  return T[q] ? { type: T[q][0], dot: T[q][1] } : null;
}
function _harmonyXML(sym, useSharp) {
  const p = _parseSym(sym);
  if (p.pc == null) return "";
  const [rs, ra] = _pcStepAlter(p.pc, useSharp);
  let s = `      <harmony>\n        <root><root-step>${rs}</root-step>${ra ? `<root-alter>${ra}</root-alter>` : ""}</root>\n        <kind>${_XML_KIND[p.suffix] !== undefined ? _XML_KIND[p.suffix] : "major"}</kind>\n`;
  const slash = String(sym).split("/")[1];
  if (slash) { const bp = _PC_BY_NAME[slash.replace("♯", "#").replace("♭", "b")]; if (bp !== undefined) { const [bs, ba] = _pcStepAlter(bp, useSharp); s += `        <bass><bass-step>${bs}</bass-step>${ba ? `<bass-alter>${ba}</bass-alter>` : ""}</bass>\n`; } }
  return s + "      </harmony>";
}
function scoreToMusicXML(score, opts = {}) {
  const ov = opts.overrides || {}, useSharp = opts.useSharp !== false, div = 4;
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<score-partwise version="3.1">',
    "  <part-list><score-part id=\"P1\"><part-name>Chords</part-name></score-part></part-list>", '  <part id="P1">'];
  let prevSig = null, wroteDiv = false;
  score.bars.forEach((bar, bi) => {
    const [bb, bt] = bar.timeSig || score.timeSig;
    L.push(`    <measure number="${bar.number}">`);
    const sigChanged = !prevSig || prevSig[0] !== bb || prevSig[1] !== bt;
    if (!wroteDiv || sigChanged) {
      L.push("      <attributes>");
      if (!wroteDiv) { L.push(`        <divisions>${div}</divisions>`); wroteDiv = true; }
      if (sigChanged) L.push(`        <time><beats>${bb}</beats><beat-type>${bt}</beat-type></time>`);
      L.push("      </attributes>");
    }
    prevSig = [bb, bt];
    if (bi === 0 && opts.tempo) L.push(`      <sound tempo="${opts.tempo}"/>`);
    bar.events.forEach((e) => {
      const sym = ov[`${bar.number}.${e.beat}`] != null ? ov[`${bar.number}.${e.beat}`] : e.symbol;
      const durDiv = Math.max(1, Math.round((e.durBeats * div * 4) / bt));
      const h = _harmonyXML(sym, useSharp); if (h) L.push(h);
      const midis = e.midis && e.midis.length ? e.midis : [];
      if (!midis.length) { L.push(`      <note><rest/><duration>${durDiv}</duration></note>`); return; }
      const ty = _typeForQuarters(durDiv / div);
      midis.forEach((m, ci) => {
        const p = _midiToPitchXML(m, useSharp);
        L.push("      <note>");
        if (ci > 0) L.push("        <chord/>");
        L.push(`        <pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.oct}</octave></pitch>`);
        L.push(`        <duration>${durDiv}</duration>`);
        if (ty) { L.push(`        <type>${ty.type}</type>`); if (ty.dot) L.push("        <dot/>"); }
        L.push("      </note>");
      });
    });
    L.push("    </measure>");
  });
  L.push("  </part>", "</score-partwise>", "");
  return L.join("\n");
}

/* Transpose a whole score by n semitones. Shifts every event's MIDI and lets the
 * engine re-name the chord (so spelling follows the sharp/flat setting for free).
 * Frets are dropped — they're tuning/position-specific — so downstream readouts
 * fall back to the transposed pitches. n === 0 is a no-op passthrough. */
function transposeScore(score, n, useSharp) {
  if (!n) return score;
  const bars = score.bars.map((b) => ({
    ...b,
    events: b.events.map((e) => {
      const midis = (e.midis || []).map((m) => m + n);
      return { ...e, midis, frets: undefined, symbol: midis.length ? symbolForMidis(midis, useSharp) : e.symbol };
    }),
  }));
  return { ...score, bars, transposedBy: n };
}

/* ---- MIDI export: score → Standard MIDI File (format 0) -------------------
 * Deterministic + testable like the other exporters (no deps, no browser API):
 * returns a Uint8Array of a single-track SMF. Same timing model as
 * scoreEventTimes / ABC — a "beat" is one (1/beatType) note = 4/beatType quarters,
 * per-bar timeSig honoured (mid-tune meter changes emit a new time-sig meta). It
 * writes the actual voiced pitches (event.midis); the caller passes the already-
 * transposed score, so the .mid matches what's shown and heard. Tempo from
 * opts.tempo (falls back to score.tempo, then 100). PPQ = 480. */
function _midiVarLen(n) {
  n = n >>> 0;
  const out = [n & 0x7f];
  n >>>= 7;
  while (n > 0) { out.unshift((n & 0x7f) | 0x80); n >>>= 7; }
  return out;
}
function scoreToMidi(score, opts = {}) {
  const PPQ = 480;
  const bpm = Math.max(20, Math.min(400, Math.round(opts.tempo || score.tempo || 100)));
  const evs = []; // { tick, order, bytes } — order breaks ties: meta < noteOff < noteOn < endOfTrack
  const uspq = Math.round(60000000 / bpm);
  evs.push({ tick: 0, order: 0, bytes: [0xFF, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff] });
  let tQ = 0, maxTick = 0, prevSig = null;
  for (const bar of score.bars || []) {
    const sig = bar.timeSig || score.timeSig || [4, 4];
    const bb = sig[0], bt = sig[1];
    const barTick = Math.round(tQ * PPQ);
    if (!prevSig || prevSig[0] !== bb || prevSig[1] !== bt) {
      evs.push({ tick: barTick, order: 0, bytes: [0xFF, 0x58, 0x04, bb & 0xff, Math.max(0, Math.round(Math.log2(bt))) & 0xff, 24, 8] });
      prevSig = [bb, bt];
    }
    const q = (v) => (v * 4) / bt; // beats → quarters
    for (const e of bar.events || []) {
      const startQ = tQ + q(e.qbeat != null ? e.qbeat : e.beat);
      const durQ = Math.max(0.0625, q(e.qdur != null ? e.qdur : e.durBeats));
      const onTick = Math.round(startQ * PPQ);
      const offTick = Math.max(onTick + 1, Math.round((startQ + durQ) * PPQ));
      for (const m of e.midis || []) {
        const note = Math.max(0, Math.min(127, m | 0));
        evs.push({ tick: onTick, order: 2, bytes: [0x90, note, 80] });
        evs.push({ tick: offTick, order: 1, bytes: [0x80, note, 0] });
        if (offTick > maxTick) maxTick = offTick;
      }
    }
    tQ += q(bb);
    if (Math.round(tQ * PPQ) > maxTick) maxTick = Math.round(tQ * PPQ);
  }
  evs.push({ tick: maxTick, order: 3, bytes: [0xFF, 0x2F, 0x00] }); // end of track
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track = [];
  let prevTick = 0;
  for (const ev of evs) { track.push(..._midiVarLen(Math.max(0, ev.tick - prevTick)), ...ev.bytes); prevTick = ev.tick; }
  const tl = track.length;
  const bytes = [
    0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff, // MThd: format 0, 1 track, PPQ
    0x4D, 0x54, 0x72, 0x6B, (tl >>> 24) & 0xff, (tl >>> 16) & 0xff, (tl >>> 8) & 0xff, tl & 0xff, // MTrk + length
    ...track,
  ];
  return new Uint8Array(bytes);
}

/* ---- playback: schedule a score on a wall-clock, then synth it ------------
 * scoreEventTimes is PURE (testable headlessly): it flattens the score into
 * timed chord events in SECONDS at `bpm` (a quarter-note BPM). A "beat" in our
 * model is one (1/beatType) note, so its length in quarters is `4/beatType` —
 * the same conversion the ABC exporter uses. Per-bar timeSig is honoured, so a
 * mid-tune meter change keeps the clock correct. ------------------------------ */
function scoreEventTimes(score, bpm) {
  const secPerQuarter = 60 / bpm;
  let tQ = 0; const events = [];
  for (const bar of score.bars) {
    const [bb, bt] = bar.timeSig || score.timeSig;
    const q = (v) => (v * 4) / bt; // beats → quarters
    bar.events.forEach((e) => {
      const startBeat = e.qbeat != null ? e.qbeat : e.beat;        // TRUE onset (dense lines)
      const durBeats = e.qdur != null ? e.qdur : e.durBeats;       // TRUE duration
      events.push({
        key: `${bar.number}.${e.beat}`, bar: bar.number, midis: e.midis || [],
        start: (tQ + q(startBeat)) * secPerQuarter, dur: Math.max(0.05, q(durBeats) * secPerQuarter),
      });
    });
    tQ += q(bb);
  }
  return { events, duration: tQ * secPerQuarter };
}
// Web Audio synth (browser only; no deps). Returns a controller with stop().
function playScore(score, bpm, { onEvent, onEnd } = {}) {
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  const ctx = new AC();
  const { events, duration } = scoreEventTimes(score, bpm);
  const master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.08;
  const timers = [];
  events.forEach((ev) => {
    const st = t0 + ev.start, en = st + ev.dur, vol = 0.22 / Math.max(1, ev.midis.length);
    ev.midis.forEach((m) => {
      const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(vol, st + 0.012);
      g.gain.setValueAtTime(vol, Math.max(st + 0.012, en - 0.06)); g.gain.linearRampToValueAtTime(0.0001, en);
      o.connect(g); g.connect(master); o.start(st); o.stop(en + 0.03);
    });
    if (onEvent) timers.push(setTimeout(() => onEvent(ev.key), ev.start * 1000 + 80));
  });
  let done = false;
  const endTimer = setTimeout(() => { done = true; if (onEnd) onEnd(); try { ctx.close(); } catch (_) {} }, duration * 1000 + 300);
  return { stop() { timers.forEach(clearTimeout); clearTimeout(endTimer); try { ctx.close(); } catch (_) {} if (!done && onEnd) onEnd(); } };
}

/* ============================================================================
 *  Wave 3 #11 — pitch detection → monophonic transcription (DSP foundation)
 *  ---------------------------------------------------------------------------
 *  PURE DSP (no Web Audio, no DOM → headless-testable with synthesized tones):
 *  a monophonic fundamental-frequency detector (the YIN algorithm) + freq→MIDI
 *  + a frame-by-frame transcriber that groups stable frames into note events.
 *  The browser-only seam is the mic CAPTURE (getUserMedia + AudioContext →
 *  Float32 frames); it feeds these pure functions, exactly like the PDF.js seam
 *  feeds the parser. Practice mode (Wave 3 #12) compares detectPitch() output
 *  against the chart's expected chord tones. iOS-first: zero deps, no WASM.
 *  ------------------------------------------------------------------------- */

/* MIDI ↔ frequency (A4 = 69 = 440 Hz, equal temperament). */
function freqToMidi(freq) { return 69 + 12 * Math.log2(freq / 440); }
function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
/* A MIDI number → scientific note name ("A4", "C#3"). Honours the ♯/♭ table. */
function midiToNoteName(midi, useSharp = true) {
  const m = Math.round(midi);
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/* ---- staff layout (digital staff view) -------------------------------------
 * Pure pitch→staff-position math for the UI's SVG staff renderer (the musician-
 * friendly display of an extracted note line). The spelling tables already
 * encode the letter each pitch class sits on (a sharp keeps its letter's line —
 * C#4 sits on C4's position; a flat keeps ITS letter — Bb3 sits on B3's), so
 * the diatonic index is just octave·7 + letter. */
const _LETTER_DIAT = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
function midiToStaffPos(midi, useSharp = true) {
  const m = Math.round(midi);
  const name = (useSharp ? NOTE_SHARP : NOTE_FLAT)[((m % 12) + 12) % 12];
  const letter = name[0], acc = name.length > 1 ? name[1] : "";
  const octave = Math.floor(m / 12) - 1;
  return { letter, acc, octave, name: name + octave, diat: octave * 7 + _LETTER_DIAT[letter] };
}
/* staffLayout — lay a list of MIDI notes on a treble or bass staff. Picks the
 * clef from the median pitch (below G3 → bass; a vocal/lead line reads treble,
 * a bass stem reads bass) unless opts.clef forces one. Each note's `step` is
 * counted from the clef's BOTTOM LINE (treble E4 / bass G2), +1 per line-or-
 * space up — so staff lines are even steps 0..8 and ledger lines fall out of
 * step < 0 / step > 8. Pure → headless-testable; the SVG glue stays in the UI. */
function staffLayout(midis, useSharp = true, opts = {}) {
  const clean = (midis || []).map((m) => Math.round(m)).filter((m) => Number.isFinite(m));
  const clef = opts.clef || (clean.length && median(clean) < 55 ? "bass" : "treble");
  const refDiat = clef === "bass" ? 2 * 7 + 4 /* G2 */ : 4 * 7 + 2 /* E4 */;
  const notes = clean.map((m) => {
    const p = midiToStaffPos(m, useSharp);
    return { midi: m, step: p.diat - refDiat, acc: p.acc, name: p.name };
  });
  return { clef, notes };
}

/* detectPitch — YIN monophonic pitch detection on one frame of PCM samples.
 * `samples` is a Float32Array / number[] in ~[-1,1]; returns the fundamental as
 * { freq, midi (rounded), note, clarity } or null when no confident pitch.
 * tau search covers ~[minFreq..maxFreq]; window must hold >1 period of minFreq
 * (2048 @ 44.1k reaches down to ~E2). Steps: difference fn → cumulative-mean-
 * normalised difference → absolute-threshold pick → parabolic interpolation. */
function detectPitch(samples, sampleRate, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.12;
  const minFreq = opts.minFreq != null ? opts.minFreq : 65;     // ~C2
  const maxFreq = opts.maxFreq != null ? opts.maxFreq : 1600;   // ~G6
  const N = samples.length;
  const tauMax = Math.min(Math.floor(N / 2), Math.floor(sampleRate / minFreq));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  if (tauMax <= tauMin + 2) return null;
  // 1) difference function d(tau)
  const d = new Float64Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j + tau < N; j++) { const diff = samples[j] - samples[j + tau]; sum += diff * diff; }
    d[tau] = sum;
  }
  // 2) cumulative mean normalised difference d'(tau)
  const dp = new Float64Array(tauMax + 1);
  dp[tauMin] = 1;
  let running = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += d[tau];
    dp[tau] = running > 0 ? d[tau] * (tau - tauMin + 1) / running : 1;
  }
  // 3) absolute threshold: first dip below `threshold` that is a local minimum
  let tau = -1;
  for (let t = tauMin + 1; t < tauMax; t++) {
    if (dp[t] < threshold) { while (t + 1 <= tauMax && dp[t + 1] < dp[t]) t++; tau = t; break; }
  }
  if (tau === -1) {                                             // none below threshold → global min
    let best = tauMin; for (let t = tauMin + 1; t <= tauMax; t++) if (dp[t] < dp[best]) best = t;
    tau = best;
    if (dp[tau] > 0.6) return null;                            // too unvoiced to trust
  }
  // 4) parabolic interpolation around tau for sub-sample precision
  let betterTau = tau;
  const x0 = tau > tauMin ? tau - 1 : tau, x2 = tau + 1 <= tauMax ? tau + 1 : tau;
  if (x0 !== tau && x2 !== tau) {
    const s0 = dp[x0], s1 = dp[tau], s2 = dp[x2], denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) betterTau = tau + (s2 - s0) / denom;
  }
  const freq = sampleRate / betterTau;
  if (freq < minFreq || freq > maxFreq) return null;
  const clarity = Math.max(0, Math.min(1, 1 - dp[tau]));
  const midi = Math.round(freqToMidi(freq));
  return { freq, midi, note: midiToNoteName(midi, opts.useSharp !== false), clarity };
}

/* transcribeMonophonic — slide detectPitch over a whole PCM buffer and group
 * consecutive frames of the same MIDI (above `minClarity`) into note events
 * { midi, note, startSec, durSec }. The MVP of Wave 3 #11 (single line in →
 * notes out). Rests (no confident pitch) break the current note. */
function transcribeMonophonic(samples, sampleRate, opts = {}) {
  const win = opts.window || 2048;
  const hop = opts.hop || Math.floor(win / 2);
  const minClarity = opts.minClarity != null ? opts.minClarity : 0.6;
  const minDurSec = opts.minDurSec != null ? opts.minDurSec : 0.05;
  const notes = [];
  let cur = null;
  for (let start = 0; start + win <= samples.length; start += hop) {
    const frame = samples.subarray ? samples.subarray(start, start + win) : samples.slice(start, start + win);
    const p = detectPitch(frame, sampleRate, opts);
    const t = start / sampleRate;
    const midi = p && p.clarity >= minClarity ? p.midi : null;
    if (midi !== null && cur && cur.midi === midi) { cur.endSec = t + win / sampleRate; }
    else { if (cur) notes.push(cur); cur = midi !== null ? { midi, note: midiToNoteName(midi, opts.useSharp !== false), startSec: t, endSec: t + win / sampleRate } : null; }
  }
  if (cur) notes.push(cur);
  return notes.filter((n) => n.endSec - n.startSec >= minDurSec).map((n) => ({ midi: n.midi, note: n.note, startSec: +n.startSec.toFixed(4), durSec: +(n.endSec - n.startSec).toFixed(4) }));
}

/* ---- audio → chroma → CHORD (for clean isolated chordal stems) -------------
 * Wave 3/4: extract chords from a CLEAN, isolated polyphonic stem (rhythm guitar,
 * piano comping) — NOT a full mix. Pipeline: PCM → FFT → fold the spectrum into a
 * 12-bin chromagram → peak-pick → the SAME chord engine (`recognise`). Pure +
 * headless-testable (synthesized chords); only the MP3→PCM decode is browser-only
 * (Web Audio `decodeAudioData`). HONEST LIMIT: works on clean stems; a full band
 * mix (drums/vocals/bass) muddies the chroma — isolate the instrument first. A
 * monophonic stem (bass/lead) should use `transcribeMonophonic` instead. */
function _fft(re, im) {                                          // in-place iterative radix-2 (len = power of 2)
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half], ai = im[i + k + half];
        const vr = ar * cr - ai * ci, vi = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - vr; im[i + k + half] = im[i + k] - vi;
        re[i + k] += vr; im[i + k] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
/* Inverse FFT via the conjugation trick: ifft(x) = conj(fft(conj(x)))/N. In-place. */
function _ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  _fft(re, im);
  for (let i = 0; i < n; i++) { re[i] = re[i] / n; im[i] = -im[i] / n; }
}
/* Memoised Hann window, keyed by length N. The analysis paths (transcribeChords /
 * harmonicClarity / pcmChromaSequence) call pcmToChroma once per hop — thousands of
 * frames per song — and each call used to recompute N cosines for the window. The
 * window depends only on N, so cache it: byte-identical values, N transcendental calls
 * saved per frame (the dominant cost after the FFT). Guarded by the audio regression
 * tests (C/Am/G7 detection, C-major chroma peaks) — output is unchanged, only faster. */
const _hannCache = new Map();
function _hann(N) {
  let w = _hannCache.get(N);
  if (!w) { w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); _hannCache.set(N, w); }
  return w;
}

/* ---- center-channel (vocal) isolation ------------------------------------
 * Lead + backing vocals are almost always mixed to the CENTER (equal in L and R),
 * while guitars/keys/etc. are panned to the sides — so isolating the center pulls a
 * usable vocal stem with zero deps (no model), the classic karaoke/azimuth trick done
 * right in the spectral domain. Per STFT bin we weight by how "centered" it is:
 *   coherence = 2|L||R| / (|L|²+|R|²)   → 1 when the channel magnitudes match, 0 when
 *                                          the bin lives on one side (panned)
 *   phase     = max(0, Re(L·conj R)/(|L||R|))  → 1 in-phase (mono/center), 0 out-of-phase
 * center_bin = coherence·phase^panExp · (L+R)/2, then overlap-add ISTFT back to time.
 * Pure DSP (reuses _fft/_ifft) → headless-testable with synthesized stereo. HONEST
 * LIMIT: centered NON-vocal content (kick/bass/snare) leaks in — a mild high-pass
 * (opts.minFreq) trims the low end; a real full-mix separator is an ML model (Wave 4).
 * Feeds the SAME transcribeChords/recognise path, so an isolated vocal stem charts its
 * sung harmony with no new plumbing. */
function extractCenter(left, right, sampleRate, opts = {}) {
  const N = opts.fftSize || 4096, hop = opts.hop || (N >> 2);    // 75% overlap
  const panExp = opts.panExp != null ? opts.panExp : 1;
  const minF = opts.minFreq || 0, maxF = opts.maxFreq || sampleRate / 2;
  const len = Math.min(left.length, right.length);
  if (!len) return new Float32Array(0);
  const win = _hann(N);
  const out = new Float64Array(len), wsum = new Float64Array(len);
  const lr = new Float64Array(N), li = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
  const eps = 1e-9;
  for (let s = 0; s + N <= len + hop; s += hop) {
    for (let i = 0; i < N; i++) { const p = s + i; const w = win[i]; lr[i] = p < len ? (left[p] || 0) * w : 0; li[i] = 0; rr[i] = p < len ? (right[p] || 0) * w : 0; ri[i] = 0; }
    _fft(lr, li); _fft(rr, ri);
    for (let k = 0; k < N; k++) {
      const f = (Math.min(k, N - k) * sampleRate) / N;           // fold to real frequency
      let g = 0;
      if (f >= minF && f <= maxF) {
        const magL = Math.hypot(lr[k], li[k]), magR = Math.hypot(rr[k], ri[k]);
        const denom = magL * magR + eps;
        const phase = Math.max(0, (lr[k] * rr[k] + li[k] * ri[k]) / denom);      // cos(Δphase), ≥0
        const coh = (2 * magL * magR) / (magL * magL + magR * magR + eps);      // magnitude match
        g = coh * Math.pow(phase, panExp);
      }
      lr[k] = g * (lr[k] + rr[k]) * 0.5; li[k] = g * (li[k] + ri[k]) * 0.5;     // weighted mid
    }
    _ifft(lr, li);
    for (let i = 0; i < N; i++) { const p = s + i; if (p < len) { out[p] += lr[i] * win[i]; wsum[p] += win[i] * win[i]; } }
  }
  const res = new Float32Array(len);
  for (let i = 0; i < len; i++) res[i] = wsum[i] > eps ? out[i] / wsum[i] : 0;
  return res;
}
/* One frame of PCM → a max-normalised 12-bin chromagram. Hann window + FFT, fold
 * each bin's magnitude into its pitch class; a light harmonic suppression knocks
 * down the octave/fifth/maj-3rd overtone bleed that would fake chord tones. */
function pcmToChroma(samples, sampleRate, opts = {}) {
  let N = opts.fftSize || 4096;
  while (N > samples.length && N > 256) N >>= 1;                 // shrink to fit short frames
  const re = new Float64Array(N), im = new Float64Array(N);
  const win = _hann(N);
  for (let i = 0; i < N; i++) re[i] = (samples[i] || 0) * win[i];
  _fft(re, im);
  const minF = opts.minFreq || 55, maxF = opts.maxFreq || 2000, C0 = 16.351597831287414;
  const raw = new Array(12).fill(0);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sampleRate) / N;
    if (f < minF || f > maxF) continue;
    raw[((Math.round(12 * Math.log2(f / C0)) % 12) + 12) % 12] += Math.hypot(re[k], im[k]);
  }
  // harmonic suppression: a pc lit only because it's the 5th/maj-3rd overtone of a
  // stronger pc below gets damped (its "parent" is a 5th below (p-7) or maj-3rd below
  // (p-4) — those notes' 3rd/5th harmonics land on p).
  const sup = opts.suppress != null ? opts.suppress : 0.3;
  const chroma = raw.map((v, p) => Math.max(0, v - sup * Math.max(raw[((p - 7) % 12 + 12) % 12], raw[((p - 4) % 12 + 12) % 12])));
  const mx = Math.max(...chroma) || 1;
  return chroma.map((v) => v / mx);
}
/* A 12-bin chroma → recognised chord. Peak-picks the chroma to a pitch-class set and
 * runs `recognise`. Returns { symbol, midis, result } or null. `midis` is a clean
 * voicing (root octave 4) so the chart/export/playback work. */
function chordFromChroma(chroma, opts = {}) {
  const thr = opts.pickThreshold != null ? opts.pickThreshold : 0.4;
  const pcs = [];
  for (let p = 0; p < 12; p++) if (chroma[p] >= thr) pcs.push(p);
  if (pcs.length < 2) return null;
  const result = recognise(pcs, makeMask(pcs), null, opts);   // opts.maxRank flows through (triad bias for audio)
  if (!result || result.single || !result.best) return null;
  const rootMidi = 48 + result.best.root;
  const midis = result.best.quality.intervals.map((i) => rootMidi + i);
  return { symbol: symbolOf(result, opts.useSharp !== false), midis, result };
}
/* ============================================================================
 *  BEAT TRACKING — onset envelope → tempo → dynamic-programming beat times
 *  ---------------------------------------------------------------------------
 *  WHY this matters more than any chord-vocabulary work: the decoder had NO tempo
 *  detection at all. `audioEventsToScore` quantises onto a beat grid the user dials
 *  in by hand, so the whole bar structure hangs off a guess — the SAME Peg analysis
 *  produced 5 N.C. bars at 120bpm and 17 at 160bpm, identical audio and identical
 *  chords, purely because the grid didn't line up. Real beats give a real grid, real
 *  downbeats, and chord changes that land ON barlines.
 *
 *  It is also the substrate for beat-synchronous chroma (see transcribeChordsBeatSync),
 *  which is how every published chord-recognition system denoises: average the chroma
 *  BETWEEN beats rather than over an arbitrary sliding window, so a strum or a passing
 *  tone cannot drag the label.
 *
 *  Pure DSP, zero deps, no model — the classic pipeline (Ellis, "Beat Tracking by
 *  Dynamic Programming", 2007): spectral flux → autocorrelation tempo → DP beat path.
 * ------------------------------------------------------------------------- */

/* Spectral-flux onset strength envelope. Log-compressed magnitudes (perceptual, and it
 * stops one loud band dominating), half-wave-rectified frame difference summed over
 * bins, then local-mean-subtracted so a slow level drift (a crescendo) doesn't read as
 * a continuous onset. Returns { odf, frameRate }. */
function onsetEnvelope(samples, sampleRate, opts = {}) {
  const N = opts.onsetFft || 1024;
  const hop = opts.onsetHop || Math.max(1, Math.round(sampleRate * 0.01));   // 10ms → 100 fps
  const frameRate = sampleRate / hop;
  const win = _hann(N);
  const half = N >> 1;
  const odf = [];
  let prev = null;
  for (let s = 0; s + N <= samples.length; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (samples[s + i] || 0) * win[i];
    _fft(re, im);
    const mag = new Float64Array(half);
    for (let k = 0; k < half; k++) mag[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
    let flux = 0;
    if (prev) for (let k = 0; k < half; k++) { const d = mag[k] - prev[k]; if (d > 0) flux += d; }
    odf.push(flux);
    prev = mag;
  }
  if (!odf.length) return { odf: [], frameRate };
  // subtract a local mean (≈0.4s) and rectify → peaks stand out, drift removed
  const w = Math.max(1, Math.round(frameRate * 0.2));
  const out = new Float64Array(odf.length);
  for (let i = 0; i < odf.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(odf.length - 1, i + w); j++) { sum += odf[j]; n++; }
    out[i] = Math.max(0, odf[i] - sum / n);
  }
  // Normalise to unit std. This is NOT cosmetic: `tightness` in trackBeats trades onset
  // strength against tempo steadiness, so the two have to share a scale. Un-normalised,
  // a loud mix makes onset strength dwarf the penalty and the DP happily packs beats at
  // half the period — measured: Peg reported 117bpm but laid 685 beats in 240s (=171bpm).
  let mean = 0; for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length || 1;
  let varSum = 0; for (let i = 0; i < out.length; i++) varSum += (out[i] - mean) ** 2;
  const sd = Math.sqrt(varSum / (out.length || 1)) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return { odf: out, frameRate };
}

/* Global tempo from the onset envelope: autocorrelation over plausible beat periods,
 * weighted by a log-Gaussian prior around `preferBpm` (Ellis's tempo prior — without it
 * autocorrelation happily locks onto half- or double-time, which is the classic failure). */
function estimateTempo(odf, frameRate, opts = {}) {
  const minBpm = opts.minBpm || 50, maxBpm = opts.maxBpm || 210;
  const prefer = opts.preferBpm || 120, spread = opts.tempoSpread || 1.0;
  const minLag = Math.max(2, Math.round((frameRate * 60) / maxBpm));
  const maxLag = Math.min(odf.length - 1, Math.round((frameRate * 60) / minBpm));
  if (maxLag <= minLag) return { bpm: prefer, periodFrames: (frameRate * 60) / prefer, strength: 0 };
  let bestLag = minLag, bestScore = -Infinity, bestAc = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = 0; i + lag < odf.length; i++) ac += odf[i] * odf[i + lag];
    ac /= odf.length - lag;
    const bpm = (frameRate * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prefer) / spread, 2));
    const score = ac * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; bestAc = ac; }
  }
  return { bpm: (frameRate * 60) / bestLag, periodFrames: bestLag, strength: bestAc };
}

/* Ellis dynamic-programming beat tracker. Maximises (onset strength at each beat) +
 * (how close each inter-beat gap is to the estimated period), then backtraces the best
 * path. `tightness` trades beat-to-onset fit against tempo steadiness. */
function trackBeats(odf, frameRate, periodFrames, opts = {}) {
  const n = odf.length;
  if (!n || !(periodFrames > 1)) return [];
  const tightness = opts.tightness != null ? opts.tightness : 100;
  const lo = Math.max(1, Math.round(periodFrames * 0.5));
  const hi = Math.max(lo + 1, Math.round(periodFrames * 2));
  const C = new Float64Array(n), P = new Int32Array(n).fill(-1);
  // precompute the transition penalty for each candidate gap
  const pen = new Float64Array(hi + 1);
  for (let g = lo; g <= hi; g++) pen[g] = -tightness * Math.pow(Math.log(g / periodFrames), 2);
  for (let t = 0; t < n; t++) {
    let best = 0, bestI = -1;                      // 0 = "this is the first beat"
    const from = Math.max(0, t - hi), to = t - lo;
    for (let tau = from; tau <= to; tau++) {
      const v = C[tau] + pen[t - tau];
      if (v > best) { best = v; bestI = tau; }
    }
    C[t] = odf[t] + best;
    P[t] = bestI;
  }
  // start the backtrace from the strongest score in the final period
  let end = n - 1;
  for (let t = Math.max(0, n - Math.round(periodFrames)); t < n; t++) if (C[t] > C[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = P[t]) { beats.push(t / frameRate); if (P[t] < 0) break; }
  return beats.reverse();
}

/* PCM → { bpm, beats[] (seconds), strength }. The one entry point the rest uses. */
function detectBeats(samples, sampleRate, opts = {}) {
  const { odf, frameRate } = onsetEnvelope(samples, sampleRate, opts);
  if (!odf.length) return { bpm: 0, beats: [], strength: 0 };
  const t = estimateTempo(odf, frameRate, opts);
  const beats = trackBeats(odf, frameRate, t.periodFrames, opts);
  return { bpm: +t.bpm.toFixed(2), beats, strength: t.strength, frameRate };
}

/* ============================================================================
 *  BEAT-SYNCHRONOUS CHORD DECODING (chroma between beats + Viterbi)
 *  ---------------------------------------------------------------------------
 *  The sliding-window path labels each window INDEPENDENTLY and then collapses
 *  identical neighbours. Nothing in it knows that chords LAST, which is why an
 *  ambiguous span flips label every 0.26s — measured on a real stem:
 *      Bb7 · C#7 · Bb7 · E7 · Edim · Eb7 · C# · C7 · G7 …
 *  each run ~2 frames long and none of them confident. No confidence floor can
 *  rescue that, because the problem isn't the threshold — it's that the decoder
 *  has no notion of continuity.
 *
 *  Two changes, both standard in published chord-recognition systems:
 *    1. average the chroma BETWEEN BEATS instead of over an arbitrary window, so
 *       a strum or a passing tone cannot drag the label, and every chord boundary
 *       lands on a beat by construction;
 *    2. decode the whole sequence with VITERBI over a chord-state space with a
 *       change penalty — the best PATH, not the best guess per window. Staying on
 *       a chord is free; changing costs. Ambiguous beats inherit their neighbours
 *       instead of collapsing to N.C.
 *
 *  Still pure, still zero-dep, still no model. Opt-in (`beatSync`) so the existing
 *  sliding-window path — and the whole validated corpus that pins it — is untouched.
 * ------------------------------------------------------------------------- */

/* All (root × quality) states as unit-normalised 12-d template vectors. `maxRank`
 * filters to the plain triad/7th vocabulary (Simple mode) exactly as `recognise` does. */
function chordStates(opts = {}) {
  const states = [];
  for (const q of QUALITIES) {
    if (opts.maxRank != null && q.rank > opts.maxRank) continue;
    for (let root = 0; root < 12; root++) {
      const vec = new Float64Array(12);
      for (const iv of q.intervals) vec[(root + iv) % 12] = 1;
      let n = 0; for (let p = 0; p < 12; p++) n += vec[p] * vec[p];
      n = Math.sqrt(n) || 1;
      for (let p = 0; p < 12; p++) vec[p] /= n;
      states.push({ root, quality: q, vec });
    }
  }
  return states;
}

/* Mean chroma between consecutive beats (plus the segment's mean energy, for gating). */
function beatSegments(samples, sampleRate, beats, opts = {}) {
  const win = opts.window || 4096;
  const hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.12));
  const frames = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    const f = samples.subarray ? samples.subarray(s, s + win) : samples.slice(s, s + win);
    let e = 0; for (let i = 0; i < f.length; i++) e += f[i] * f[i];
    // A SECOND chroma restricted to the bass register. The summed full-spectrum chroma
    // says which pitch classes are present but not which is the ROOT; the bass line
    // says exactly that, and it's what a player reads. Keeping them separate lets the
    // emission use each for what it's good at: upper chroma → quality, bass → root.
    frames.push({
      t: s / sampleRate,
      chroma: pcmToChroma(f, sampleRate, opts),
      bass: pcmToChroma(f, sampleRate, { ...opts, minFreq: opts.bassMinFreq || 40, maxFreq: opts.bassMaxFreq || 250, suppress: 0 }),
      energy: Math.sqrt(e / f.length),
    });
  }
  if (!frames.length || beats.length < 2) return [];
  const segs = [];
  let fi = 0;
  for (let b = 0; b + 1 < beats.length; b++) {
    const t0 = beats[b], t1 = beats[b + 1];
    while (fi < frames.length && frames[fi].t < t0) fi++;
    const chroma = new Float64Array(12), bass = new Float64Array(12);
    let n = 0, energy = 0;
    for (let j = fi; j < frames.length && frames[j].t < t1; j++) {
      for (let p = 0; p < 12; p++) { chroma[p] += frames[j].chroma[p]; bass[p] += frames[j].bass[p]; }
      energy += frames[j].energy; n++;
    }
    // a beat shorter than the hop can contain no frame centre — use the nearest
    if (!n) {
      const j = Math.min(frames.length - 1, fi);
      for (let p = 0; p < 12; p++) { chroma[p] = frames[j].chroma[p]; bass[p] = frames[j].bass[p]; }
      energy = frames[j].energy; n = 1;
    }
    for (let p = 0; p < 12; p++) { chroma[p] /= n; bass[p] /= n; }
    segs.push({ t0, t1, chroma, bass, energy: energy / n });
  }
  return segs;
}

/* Viterbi over chord states. Transition is uniform-except-self, so the recursion is
 * O(T·S) not O(T·S²): the best predecessor is either the same state (free) or the
 * global best (minus the change penalty). Emission is cosine similarity to the state
 * template, minus a small prior that keeps uncommon qualities from winning ties — the
 * same intent as `recognise`'s `rank` tie-break. A dedicated NO-CHORD state with a
 * fixed emission absorbs beats nothing fits, so silence/mush stays honest. */
function viterbiChords(segments, states, opts = {}) {
  const T = segments.length;
  if (!T || !states.length) return [];
  const change = opts.changePenalty != null ? opts.changePenalty : 0.08;
  const ncScore = opts.ncScore != null ? opts.ncScore : 0.62;
  const rankBias = opts.rankBias != null ? opts.rankBias : 0.004;
  const S = states.length;                       // index S == the no-chord state
  const prev = new Float64Array(S + 1), cur = new Float64Array(S + 1);
  const back = [];
  const bassW = opts.bassWeight != null ? opts.bassWeight : 0.15;
  /* Optional KEY PRIOR. A tune mostly uses chords built from its scale, so a state whose
   * notes all sit in the key is a better bet than one that needs an accidental. Scored
   * as the FRACTION of the chord's pitch classes that are in the key's scale — no
   * hardcoded chord-function table, so it handles 7ths/extensions and degrades
   * gracefully rather than banning anything (a genuine secondary dominant still wins if
   * the audio supports it). `keyScale` is a 12-bool array; see analyzeAudioChords. */
  const keyW = opts.keyWeight != null ? opts.keyWeight : 0.1;
  const scale = opts.keyScale && opts.keyScale.length === 12 ? opts.keyScale : null;
  const keyFit = new Float64Array(states.length);
  if (scale && keyW) {
    for (let s = 0; s < states.length; s++) {
      const iv = states[s].quality.intervals;
      let inKey = 0;
      for (const i of iv) if (scale[(states[s].root + i) % 12]) inKey++;
      keyFit[s] = inKey / iv.length;
    }
  }
  const emit = (seg, s) => {
    if (s === S) return ncScore;
    const st = states[s], c = seg.chroma;
    let dot = 0, n = 0;
    for (let p = 0; p < 12; p++) { dot += c[p] * st.vec[p]; n += c[p] * c[p]; }
    n = Math.sqrt(n) || 1;
    let score = dot / n - rankBias * st.quality.rank;
    if (scale && keyW) score += keyW * keyFit[s];
    // the bass register votes for the ROOT (see beatSegments) — the upper chroma is
    // ambiguous between a chord and its relative/inversion, the bass usually isn't.
    if (bassW && seg.bass) {
      let bmax = 0; for (let p = 0; p < 12; p++) if (seg.bass[p] > bmax) bmax = seg.bass[p];
      if (bmax > 0) score += bassW * (seg.bass[st.root] / bmax);
    }
    return score;
  };
  for (let s = 0; s <= S; s++) prev[s] = emit(segments[0], s);
  for (let t = 1; t < T; t++) {
    let bestPrev = -Infinity, bestIdx = 0;
    for (let s = 0; s <= S; s++) if (prev[s] > bestPrev) { bestPrev = prev[s]; bestIdx = s; }
    const bp = new Int32Array(S + 1);
    for (let s = 0; s <= S; s++) {
      const stay = prev[s], move = bestPrev - change;
      if (stay >= move) { cur[s] = stay; bp[s] = s; } else { cur[s] = move; bp[s] = bestIdx; }
      cur[s] += emit(segments[t], s);
    }
    back.push(bp);
    prev.set(cur);
  }
  let end = 0;
  for (let s = 1; s <= S; s++) if (prev[s] > prev[end]) end = s;
  const path = new Array(T);
  path[T - 1] = end;
  for (let t = T - 2; t >= 0; t--) path[t] = back[t][path[t + 1]];
  return path;
}

/* PCM → beat-synchronous, Viterbi-decoded chord events (same shape as
 * transcribeChords, so the score/chart/exporters consume it unchanged).
 * Returns [] when no beat grid can be found — the caller falls back. */
function transcribeChordsBeatSync(samples, sampleRate, opts = {}) {
  const bt = opts.beats ? { beats: opts.beats, bpm: opts.bpm || 0 } : detectBeats(samples, sampleRate, opts);
  if (!bt.beats || bt.beats.length < 3) return [];
  const segs = beatSegments(samples, sampleRate, bt.beats, opts);
  if (!segs.length) return [];
  // energy gate, adaptive like the sliding path: quiet ≠ silent
  const maxE = Math.max(...segs.map((s) => s.energy)) || 1;
  const ratio = opts.energyGate != null ? opts.energyGate : 0.08;
  const floorAbs = (opts.energyGateFloor != null ? opts.energyGateFloor : 0.005) * maxE;
  const winSec = opts.energyGateWindowSec != null ? opts.energyGateWindowSec : 15;
  for (let i = 0; i < segs.length; i++) {
    if (winSec <= 0) { segs[i].gate = ratio * maxE; continue; }
    let peak = 0;
    for (let j = 0; j < segs.length; j++) if (Math.abs(segs[j].t0 - segs[i].t0) <= winSec / 2 && segs[j].energy > peak) peak = segs[j].energy;
    segs[i].gate = Math.max(floorAbs, ratio * peak);
  }
  const states = chordStates(opts);
  const path = viterbiChords(segs, states, opts);
  const S = states.length;
  const out = [];
  for (let t = 0; t < segs.length; t++) {
    const gated = segs[t].energy < segs[t].gate;
    const s = gated ? S : path[t];
    if (s === S) { out.push(null); continue; }
    const st = states[s];
    out.push({ root: st.root, quality: st.quality });
  }
  // collapse runs of the same state into events on beat boundaries
  const events = [];
  let cur = null;
  for (let t = 0; t < out.length; t++) {
    const o = out[t];
    if (!o) { if (cur) { events.push(cur); cur = null; } continue; }
    if (cur && cur.root === o.root && cur.quality === o.quality) { cur.endSec = segs[t].t1; continue; }
    if (cur) events.push(cur);
    cur = { root: o.root, quality: o.quality, startSec: segs[t].t0, endSec: segs[t].t1 };
  }
  if (cur) events.push(cur);
  const useSharp = opts.useSharp !== false;
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  return events.map((e) => ({
    symbol: names[e.root] + e.quality.suffix,
    midis: e.quality.intervals.map((i) => 48 + e.root + i),
    startSec: +e.startSec.toFixed(3),
    durSec: +(e.endSec - e.startSec).toFixed(3),
  }));
}

/* The audio panel's one entry point: chords AND the tempo that produced them, so the
 * bpm control can be filled in from the audio instead of guessed. Beat-synchronous by
 * default; falls back to the sliding-window path when no beat grid can be found (very
 * short clips, or material with no discernible pulse — a rubato solo piano intro), so
 * a result is always produced. Returns { events, bpm, beats, method }. */
function analyzeAudioChords(samples, sampleRate, opts = {}) {
  if (opts.beatSync !== false) {
    const bt = detectBeats(samples, sampleRate, opts);
    if (bt.beats && bt.beats.length >= 3) {
      let events = transcribeChordsBeatSync(samples, sampleRate, { ...opts, beats: bt.beats });
      let key = null;
      /* KEY PRIOR, second pass. Decode once, read the key off THAT (via the existing,
       * validated analyzeKey), then re-decode with a diatonic bonus. Two passes because
       * the key isn't known until something has been decoded — and using the first
       * pass's own output is exactly the information we have. Skipped when the key
       * reading is weak, so an ambiguous/modulating tune isn't forced into a key. */
      if (events.length && opts.keyPrior !== false) {
        const bpb = opts.beatsPerBar || 4;
        const probe = { bars: events.map((e, i) => ({ number: i + 1, events: [{ symbol: e.symbol, durBeats: Math.max(1, Math.round(e.durSec / (60 / (bt.bpm || 120)))) }] })), timeSig: [bpb, 4] };
        key = analyzeKey(probe);
        if (key && key.confidence >= (opts.keyMinConfidence != null ? opts.keyMinConfidence : 0.5)) {
          const idx = key.mode === "major" ? _MAJ : _MIN;
          const scale = new Array(12).fill(false);
          for (const rel of Object.keys(idx)) scale[(key.tonic + Number(rel)) % 12] = true;
          const second = transcribeChordsBeatSync(samples, sampleRate, { ...opts, beats: bt.beats, keyScale: scale });
          if (second.length) events = second;
        } else key = null;
      }
      if (events.length) return { events, bpm: bt.bpm, beats: bt.beats, key, method: "beat-sync" };
    }
  }
  return { events: transcribeChords(samples, sampleRate, opts), bpm: 0, beats: [], key: null, method: "sliding" };
}

/* One frame of PCM → recognised chord. (Thin wrapper: chroma → chord.) */
function detectChord(samples, sampleRate, opts = {}) {
  const d = chordFromChroma(pcmToChroma(samples, sampleRate, opts), opts);
  return d ? { ...d, chroma: undefined } : null;
}
/* recoverChordGaps — second look at the spans that produced no label.
 *
 * A decoded chart is littered with N.C. bars, and most of them are NOT silence: the
 * span had sound, but at the default `pickThreshold` (0.4) fewer than two pitch
 * classes cleared the bar, or the sub-`minDurSec` filter dropped a short label. In a
 * real mix a genuine chord's 3rd/5th often sit under 0.4 after harmonic suppression,
 * so the frame is discarded even though the harmony is there.
 *
 * This re-reads the chroma ALREADY MEASURED for those spans at a lower threshold. It
 * re-labels the gap FRAME BY FRAME (the same smoothed sliding window the main pass
 * uses) rather than averaging the gap flat — a gap is often 2–3 s and spans a chord
 * CHANGE, and one average over two chords is mush that no honest confidence floor
 * will ever accept. Per-frame labelling recovers the changes and gives each run a
 * confidence that reflects one chord, not a blend. (Measured on a real stem: the
 * five surviving N.C. bars in Peg averaged to 0.33–0.44 confidence — below any
 * sane floor — while their constituent runs read 0.55–0.75.)
 *
 * It never copies a neighbouring chord and never invents one — the guardrails are
 * the point:
 *   - the span must carry real sound (enough non-gated frames to cover `minVoiced`
 *     of it), so a rest stays a rest;
 *   - the smoothing window is clamped INSIDE the gap, so a neighbouring chord's
 *     chroma can never bleed across the boundary and be re-emitted as "recovered";
 *   - each run must clear `recoverMinConfidence` (mean Jaccard) and last at least
 *     `minDurSec` — the SAME blip filter the main pass applies, so recovery can
 *     never emit a label the primary path would have thrown away;
 *   - only gaps of at least `recoverMinGapSec` are considered. A short gap between
 *     two events just leaves the previous chord ringing — it never strands a bar as
 *     N.C., so filling it buys nothing and costs a spurious chord change. (Without
 *     this, Peg went from 227 to 341 chord slots — bars like
 *     `Bb7_Bb7_A7_A_E7sus4_Bb7_C7` — to remove five N.C. bars. Unusable.)
 * Same shape as the Guitar Pro importer's cross-track recovery: harvest what is
 * actually sounding, recognise tolerantly, then refuse unless it is convincing.
 *
 * Opt-in (`recoverGaps`) so the default behaviour of every existing caller is byte
 * identical. Pure. */
function recoverChordGaps(events, frames, gate, cover, opts = {}) {
  if (!frames.length) return events;
  // frames may carry a per-frame adaptive gate (see transcribeChords); fall back to the scalar.
  const gateOf = (f) => (f.gate != null ? f.gate : gate);
  const thr = opts.recoverThreshold != null ? opts.recoverThreshold : 0.22;
  const minConf = opts.recoverMinConfidence != null ? opts.recoverMinConfidence : 0.45;
  const minVoiced = opts.recoverMinVoiced != null ? opts.recoverMinVoiced : 0.5;
  const minDur = opts.minDurSec != null ? opts.minDurSec : 0.4;
  // A gap shorter than this can't strand a bar as N.C. — see the guardrails above.
  const minGap = opts.recoverMinGapSec != null ? opts.recoverMinGapSec : 1.5;
  const endOf = frames[frames.length - 1].t + cover;
  // same smoothing width as the main pass (frames each side of the centre frame)
  const step = frames.length > 1 ? frames[1].t - frames[0].t : cover;
  const smoothSec = opts.smoothSec != null ? opts.smoothSec : 0.4;
  const half = Math.max(0, Math.round((smoothSec / (step || cover) - 1) / 2));
  const recOpts = { ...opts, pickThreshold: thr };

  // The spans with no label: before the first event, between events, after the last.
  const gaps = [];
  let at = frames[0].t;
  for (const e of events) { if (e.startSec - at >= minGap) gaps.push([at, e.startSec]); at = Math.max(at, e.startSec + e.durSec); }
  if (endOf - at >= minGap) gaps.push([at, endOf]);

  const recovered = [];
  for (const [a, b] of gaps) {
    const idx = [];
    for (let i = 0; i < frames.length; i++) if (frames[i].t >= a && frames[i].t < b) idx.push(i);
    if (!idx.length) continue;
    const voiced = idx.filter((i) => frames[i].energy >= gateOf(frames[i]));
    // Mostly silent → it really is a rest. Leave it alone.
    if (voiced.length < 2 || voiced.length / idx.length < minVoiced) continue;
    const lo = idx[0], hi = idx[idx.length - 1];
    // Per-frame smoothed label, window clamped to [lo, hi] so no neighbour bleeds in.
    let run = null;
    const runs = [];
    const close = () => { if (run) runs.push(run); run = null; };
    for (const i of idx) {
      let d = null;
      if (frames[i].energy >= gateOf(frames[i])) {
        const avg = new Array(12).fill(0); let cnt = 0;
        for (let j = Math.max(lo, i - half); j <= Math.min(hi, i + half); j++) {
          if (frames[j].energy >= gateOf(frames[j])) { for (let p = 0; p < 12; p++) avg[p] += frames[j].chroma[p]; cnt++; }
        }
        if (cnt) { for (let p = 0; p < 12; p++) avg[p] /= cnt; d = chordFromChroma(avg, recOpts); }
      }
      if (!d || !d.result || !d.result.best) { close(); continue; }
      if (run && run.symbol === d.symbol) { run.endSec = frames[i].t + cover; run.conf += d.result.best.confidence; run.n++; }
      else { close(); run = { symbol: d.symbol, midis: d.midis, startSec: frames[i].t, endSec: frames[i].t + cover, conf: d.result.best.confidence, n: 1 }; }
    }
    close();
    for (const r of runs) {
      if (r.endSec - r.startSec < minDur) continue;
      if (r.conf / r.n < minConf) continue;             // unconvincing → stay N.C.
      recovered.push({
        symbol: r.symbol, midis: r.midis,
        startSec: +Math.max(a, r.startSec).toFixed(3),
        durSec: +(Math.min(b, r.endSec) - Math.max(a, r.startSec)).toFixed(3),
        recovered: true,
      });
    }
  }
  if (!recovered.length) return events;

  // Merge back in time order, collapsing a recovered label that just repeats its
  // neighbour into that neighbour (the simile case) rather than adding a change.
  const all = events.concat(recovered).sort((x, y) => x.startSec - y.startSec);
  const out = [];
  for (const e of all) {
    const prev = out[out.length - 1];
    if (prev && prev.symbol === e.symbol && Math.abs(prev.startSec + prev.durSec - e.startSec) < 1e-6) {
      prev.durSec = +(prev.durSec + e.durSec).toFixed(3);
    } else out.push({ ...e });
  }
  return out;
}
/* Slide over a whole (decoded) buffer → timed chord events { symbol, midis, startSec,
 * durSec }. For a REAL stem (esp. rhythm+lead, where transients/lead notes flip the
 * chord every frame) raw per-frame detection is far too noisy, so we:
 *   1) gate out low-energy frames (silence / note decay) → rests, not garbage chords;
 *   2) AVERAGE the chroma over a ~`smoothSec` window before recognising (a strum or a
 *      passing lead note can't flip the chord on its own);
 *   3) collapse consecutive identical labels and drop sub-`minDurSec` blips.
 * `audioEventsToScore` then maps these onto a beat grid. */
function transcribeChords(samples, sampleRate, opts = {}) {
  const win = opts.window || 4096;
  const hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.25));
  const minDur = opts.minDurSec != null ? opts.minDurSec : 0.4;
  const cover = Math.max(win, hop) / sampleRate;
  const smoothSec = opts.smoothSec != null ? opts.smoothSec : 0.4;
  const half = Math.max(0, Math.round((smoothSec / (hop / sampleRate) - 1) / 2));
  // per-frame chroma + energy
  const frames = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    const frame = samples.subarray ? samples.subarray(s, s + win) : samples.slice(s, s + win);
    let e = 0; for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    frames.push({ t: s / sampleRate, chroma: pcmToChroma(frame, sampleRate, opts), energy: Math.sqrt(e / frame.length) });
  }
  if (!frames.length) return [];
  const maxE = Math.max(...frames.map((f) => f.energy)) || 1;
  const ratio = opts.energyGate != null ? opts.energyGate : 0.08;
  const gate = ratio * maxE;
  /* ADAPTIVE energy gate. A gate fixed at a fraction of the GLOBAL peak assumes the
   * whole recording sits at one level — true of a compressed pop stem, false of
   * anything with real dynamics. On a Wagner prelude (peak ~28x the opening) it
   * discarded 42% of the piece as "silence", including 100% of the first 30s — the
   * quiet opening where the harmony actually is. So the reference is a LOCAL peak
   * over a sliding window, floored at a small fraction of the global peak so that
   * genuine silence / room tone still gates out (a silent lead-in's local peak is
   * ~0, so the floor decides). On compressed material the local peak is close to the
   * global peak, so the change there is small and in the right direction — measured
   * on a real rock stem: 113 -> 115 bars (two more bars of quiet material recovered
   * at the edges), same N.C. count, +2 chord slots. On the Wagner prelude: 51% -> 80%
   * of the piece labelled, and the opening decodes at all where it previously produced
   * literally nothing. `energyGateWindowSec: 0` restores the old global-only behaviour. */
  const winSec = opts.energyGateWindowSec != null ? opts.energyGateWindowSec : 15;
  const floorAbs = (opts.energyGateFloor != null ? opts.energyGateFloor : 0.005) * maxE;
  if (winSec > 0) {
    const halfW = Math.max(1, Math.round(winSec / (hop / sampleRate) / 2));
    for (let i = 0; i < frames.length; i++) {
      let peak = 0;
      for (let j = Math.max(0, i - halfW); j <= Math.min(frames.length - 1, i + halfW); j++) if (frames[j].energy > peak) peak = frames[j].energy;
      frames[i].gate = Math.max(floorAbs, ratio * peak);
    }
  } else for (const f of frames) f.gate = gate;
  // smoothed label per frame (averaged chroma over the window; gated frames → rest)
  const events = [];
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    let sym = null, midis = null;
    if (frames[i].energy >= frames[i].gate) {
      const avg = new Array(12).fill(0); let cnt = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(frames.length - 1, i + half); j++) { if (frames[j].energy >= frames[j].gate) { for (let p = 0; p < 12; p++) avg[p] += frames[j].chroma[p]; cnt++; } }
      if (cnt) { for (let p = 0; p < 12; p++) avg[p] /= cnt; const d = chordFromChroma(avg, opts); if (d) { sym = d.symbol; midis = d.midis; } }
    }
    const t = frames[i].t;
    if (sym && cur && cur.symbol === sym) cur.endSec = t + cover;
    else { if (cur) events.push(cur); cur = sym ? { symbol: sym, midis, startSec: t, endSec: t + cover } : null; }
  }
  if (cur) events.push(cur);
  const out = events.filter((e) => e.endSec - e.startSec >= minDur).map((e) => ({ symbol: e.symbol, midis: e.midis, startSec: +e.startSec.toFixed(3), durSec: +(e.endSec - e.startSec).toFixed(3) }));
  // Opt-in second pass over the spans that produced nothing — most "N.C." bars in a
  // decoded chart are unrecognised, not silent. See recoverChordGaps.
  return opts.recoverGaps ? recoverChordGaps(out, frames, gate, cover, opts) : out;
}
/* harmonicClarity — how legible the harmony in a signal is, 0..1. Per energy-gated frame,
 * the chroma's **inverse participation ratio** `pr = (Σc)²/Σc²` is the effective number of
 * lit pitch classes; clarity `(12−pr)/11` → ~1 when energy sits in one/few pcs (a clean
 * chord) and → 0 when it's spread flat across all 12 (drums/bleed/reverb mud). Mean over
 * active frames. This is the A/B yardstick for whether center-extraction actually cleans up
 * a given file (compare the clarity of the raw downmix vs. the isolated center) — and, by
 * extension, whether a heavy ML separator would even be worth its download. It's a RELATIVE
 * gauge: a clean synth triad reads ~0.44 (spectral leakage sets a floor), noise ~0.19, so
 * the DELTA between two versions of the same signal is the read, not the absolute value.
 * Pure (reuses pcmToChroma). */
function harmonicClarity(samples, sampleRate, opts = {}) {
  const win = opts.window || 4096, hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.12));
  const frames = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    const frame = samples.subarray ? samples.subarray(s, s + win) : samples.slice(s, s + win);
    let e = 0; for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    frames.push({ chroma: pcmToChroma(frame, sampleRate, opts), energy: Math.sqrt(e / frame.length) });
  }
  if (!frames.length) return 0;
  const maxE = Math.max(...frames.map((f) => f.energy)) || 1;
  const gate = (opts.energyGate != null ? opts.energyGate : 0.08) * maxE;
  let sum = 0, n = 0;
  for (const f of frames) {
    if (f.energy < gate) continue;
    let s1 = 0, s2 = 0; for (const v of f.chroma) { s1 += v; s2 += v * v; }
    if (s2 <= 1e-12) continue;
    const pr = (s1 * s1) / s2;                          // effective # of active pitch classes
    sum += Math.max(0, Math.min(1, (12 - pr) / 11)); n++;
  }
  return n ? +(sum / n).toFixed(4) : 0;
}
/* Map timed chord events (from `transcribeChords`) onto a beat grid → the SAME score
 * shape every parser emits, so an audio stem flows into the chart, exporters, CSMPN
 * handoff, transpose, etc. Quantises each event's `startSec` to a beat at `bpm`
 * (a "beat" = a quarter note); collapses to bars of `beatsPerBar`. No tempo detection
 * yet — the caller supplies bpm (a tempo control / future beat-tracking). */
function audioEventsToScore(events, opts = {}) {
  const bpm = Math.max(20, Math.min(400, opts.bpm || 120));
  const beatsPerBar = opts.beatsPerBar || 4;
  const beatType = opts.beatType || 4;
  const secPerBeat = 60 / bpm;
  const placed = (events || []).filter((e) => e.symbol).map((e) => {
    const onsetBeat = e.startSec / secPerBeat;                 // global beat position
    return { symbol: e.symbol, midis: e.midis || [], onsetBeat: Math.max(0, onsetBeat), durBeat: Math.max(0.25, (e.durSec || secPerBeat) / secPerBeat) };
  }).sort((a, b) => a.onsetBeat - b.onsetBeat);
  const barsMap = new Map();                                   // barIndex -> events
  for (const p of placed) {
    const bar = Math.floor(p.onsetBeat / beatsPerBar + 1e-6);
    const inBar = p.onsetBeat - bar * beatsPerBar;
    if (!barsMap.has(bar)) barsMap.set(bar, []);
    barsMap.get(bar).push({ symbol: p.symbol, midis: p.midis, qbeat: Math.max(0, Math.min(beatsPerBar - 1e-6, inBar)) });
  }
  const lastBar = barsMap.size ? Math.max(...barsMap.keys()) : -1;
  // A bar with no ONSET is not "no chord" — the previous chord is often still sounding
  // right through it (a whole-bar or multi-bar hold). Keying bars off onsets alone made
  // those bars export as a false `N.C.`; on a real stem at 160 bpm that was 9 of 14 N.C.
  // bars. Seed such a bar with the sustaining event at beat 0 so the exporters emit the
  // ringing chord — which scoreToCSMPN then collapses to `%` (simile) when it matches the
  // bar before — and so playback/MIDI/ABC sustain instead of dropping to silence. Bars
  // that no event covers are left empty: genuinely unlabelled stays honestly N.C.
  let heldEv = null, pi = 0;
  for (let b = 0; b <= lastBar; b++) {
    const barStart = b * beatsPerBar;
    while (pi < placed.length && placed[pi].onsetBeat < barStart - 1e-6) heldEv = placed[pi++];
    if (!barsMap.has(b) && heldEv && heldEv.onsetBeat + heldEv.durBeat > barStart + 1e-6) {
      barsMap.set(b, [{ symbol: heldEv.symbol, midis: heldEv.midis, qbeat: 0, held: true }]);
    }
  }
  const bars = [];
  for (let b = 0; b <= lastBar; b++) {
    const evs = (barsMap.get(b) || []).sort((a, b2) => a.qbeat - b2.qbeat);
    evs.forEach((e, i) => { e.beat = Math.max(0, Math.min(beatsPerBar - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < evs.length; i++) if (evs[i].beat <= evs[i - 1].beat) evs[i].beat = Math.min(beatsPerBar - 1, evs[i - 1].beat + 1);
    evs.forEach((e, i) => { e.durBeats = (i + 1 < evs.length ? evs[i + 1].beat : beatsPerBar) - e.beat; });
    _fillTrueDur(evs, beatsPerBar);
    bars.push({ number: b + 1, timeSig: [beatsPerBar, beatType], events: evs.map((e) => ({ symbol: e.symbol, midis: e.midis, beat: e.beat, durBeats: e.durBeats, qbeat: e.qbeat, qdur: e.qdur, ...(e.held ? { held: true } : {}) })) });
  }
  return { source: "audio", timeSig: [beatsPerBar, beatType], tempo: bpm, bars };
}

/* ============================================================================
 *  ML note transcription (basic-pitch-style) — the drop-in decoder + seam
 *  ---------------------------------------------------------------------------
 *  WHY: pure-JS multi-F0 CANNOT reliably transcribe dense/balanced vocal harmony
 *  (evidenced — see CLAUDE.md "Polyphonic transcription"). The honest path to the
 *  actual per-voice NOTES is a small ML note-transcription model (Spotify's
 *  `basic-pitch`, ~a few MB ONNX — nothing like Demucs's 166 MB). The model itself
 *  is a browser-only, device-only, must-be-hosted seam; but the HALF of the pipeline
 *  that turns its output into notes/score is PURE and headless-testable, so it lives
 *  here, drop-in ready. When a model is hosted + wired, only the inference glue
 *  (audio → the model's harmonic-CQT input → onset/frame matrices) remains.
 *
 *  Contract the model must satisfy (matches basic-pitch's outputs):
 *    model(pcm, sampleRate, opts) → { onsets, frames, frameRate, minMidi }
 *      onsets / frames : T×P activation matrices in [0,1] (T time frames, P pitches
 *                        from `minMidi`); frameRate = frames per second.
 *  ------------------------------------------------------------------------- */

/* Note-creation post-processing (faithful to basic-pitch's output_to_notes_polyphonic):
 * each onset peak above threshold starts a note; it's extended forward while the frame
 * activation stays lit; short blips are dropped. Pure → tested with synthetic matrices. */
function notesFromActivations(onsets, frames, opts = {}) {
  const T = frames.length; if (!T) return [];
  const P = frames[0].length;
  const minMidi = opts.minMidi != null ? opts.minMidi : 21;    // A0 (basic-pitch's lowest)
  const frameRate = opts.frameRate || 100;
  const onsetThr = opts.onsetThresh != null ? opts.onsetThresh : 0.5;
  const frameThr = opts.frameThresh != null ? opts.frameThresh : 0.3;
  const minFrames = Math.max(1, Math.round((opts.minDurSec != null ? opts.minDurSec : 0.12) * frameRate));
  const used = frames.map(() => new Uint8Array(P));
  const notes = [];
  for (let t = 0; t < T; t++) for (let p = 0; p < P; p++) {
    const o = onsets[t][p];
    if (o < onsetThr) continue;
    if ((t > 0 && onsets[t - 1][p] > o) || (t < T - 1 && onsets[t + 1][p] > o)) continue; // local-max onset in time
    if (used[t][p]) continue;
    let e = t;
    while (e < T && frames[e][p] >= frameThr && !used[e][p]) { used[e][p] = 1; e++; }
    const durFrames = e - t;
    if (durFrames >= minFrames) notes.push({ midi: minMidi + p, startSec: +(t / frameRate).toFixed(3), durSec: +(durFrames / frameRate).toFixed(3), amp: +o.toFixed(3) });
  }
  notes.sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
  return notes;
}
/* Note events → the shared score shape (so the ML transcription flows through the chart,
 * all 6 exporters, transpose, playback and the Pro handoff for free). Notes whose onsets
 * fall within `onsetGrid` sec collapse into one simultaneous voicing (a beat's chord). */
function polyNotesToScore(notes, opts = {}) {
  const grid = opts.onsetGrid || 0.12, useSharp = opts.useSharp !== false;
  const cols = [];
  for (const n of (notes || []).slice().sort((a, b) => a.startSec - b.startSec)) {
    let c = cols.length && Math.abs(cols[cols.length - 1].startSec - n.startSec) < grid ? cols[cols.length - 1] : null;
    if (!c) { c = { startSec: n.startSec, midis: [], durSec: 0 }; cols.push(c); }
    c.midis.push(n.midi); c.durSec = Math.max(c.durSec, n.durSec);
  }
  const events = cols.map((c) => ({ symbol: symbolForMidis(c.midis, useSharp), midis: c.midis.slice().sort((a, b) => a - b), startSec: c.startSec, durSec: c.durSec }));
  const score = audioEventsToScore(events, opts);
  score.source = "ml";                                          // tag the provenance
  return score;
}
/* Orchestrator: run a pluggable note MODEL over PCM, decode → notes + score. The model is
 * the ONLY device-only/hosted piece; everything downstream is the pure, tested path. */
async function transcribeWithNoteModel(pcm, sampleRate, model, opts = {}) {
  if (typeof model !== "function") throw new Error("no note model configured");
  const out = await model(pcm, sampleRate, opts);
  if (!out || !out.frames || !out.onsets) return { notes: [], score: null };
  const notes = notesFromActivations(out.onsets, out.frames, { frameRate: out.frameRate, minMidi: out.minMidi, ...opts });
  return { notes, score: polyNotesToScore(notes, opts) };
}

/* ---- audio ↔ score alignment (DTW auto-sync) ------------------------------
 * Line a real recording up to a score automatically (no manual ♩=): match the
 * audio's chroma sequence against the score's expected chroma via Dynamic Time
 * Warping, which finds the lowest-cost MONOTONIC path — so it tracks tempo drift
 * / rubato that a linear tempo map can't. Pure + headless-testable (synthesized
 * audio); only the PCM decode is browser-only. The chart's existing highlight
 * then follows the recording via the returned sec→event-key segments. */
function _cosDist(a, b) {                                     // cosine distance of two chroma vectors (0 = identical)
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 1;                          // no info (rest / silence) → neutral cost
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function _dtw(A, B, dist) {                                   // classic DP; returns { path:[[i,j]…], cost }
  const n = A.length, m = B.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  D[0][0] = 0;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const c = dist(A[i - 1], B[j - 1]);
    D[i][j] = c + Math.min(D[i - 1][j], D[i][j - 1], D[i - 1][j - 1]);
  }
  const path = []; let i = n, j = m;
  while (i > 0 && j > 0) { path.push([i - 1, j - 1]); const a = D[i - 1][j], b = D[i][j - 1], c = D[i - 1][j - 1]; if (c <= a && c <= b) { i--; j--; } else if (a <= b) i--; else j--; }
  path.reverse();
  return { path, cost: D[n][m] };
}
/* Score → chroma columns for the DTW, tagged with each event's chart key. Two priors
 * make the warp match a real recording better:
 *  - EMPHASIS: the bass (lowest midi, usually the root) and its perfect 5th are weighted
 *    up, so the vector looks like a real chord's chroma (root loud, 5th present) instead
 *    of a flat presence mask — sharpens the cosine match.
 *  - DURATION: a longer event spans MORE columns (~1 per beat of its qdur), so DTW lets
 *    it absorb proportionally more audio frames. Without this a whole note and an eighth
 *    each got one column and the warp had no sense of how long a chord should sound —
 *    exactly the rubato/tempo-drift case auto-sync exists for. */
function scoreChromaSequence(score) {
  const seq = [];
  for (const bar of score.bars || []) for (const e of bar.events || []) {
    const ch = new Array(12).fill(0);
    const midis = e.midis || [];
    for (const mm of midis) ch[((mm % 12) + 12) % 12] += 1;
    if (midis.length) {
      const bass = ((Math.min(...midis) % 12) + 12) % 12;
      ch[bass] += 0.6; ch[(bass + 7) % 12] += 0.3;          // root + fifth emphasis
    }
    const mx = Math.max(...ch) || 1;
    const chroma = ch.map((v) => v / mx);
    const key = `${bar.number}.${e.beat}`;
    const dur = e.qdur != null ? e.qdur : (e.durBeats != null ? e.durBeats : 1);
    const reps = Math.max(1, Math.round(dur));               // duration-weight the column count
    for (let r = 0; r < reps; r++) seq.push({ chroma, key });
  }
  return seq;
}
/* PCM → a chroma frame per hop (the audio side of the alignment). Each frame carries
 * its RMS `energy` too, so the aligner can gate silence — pcmToChroma normalises every
 * frame to unit max, which turns silence into a full-magnitude NOISE chroma. */
function pcmChromaSequence(samples, sampleRate, opts = {}) {
  const win = opts.window || 4096, hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.25));
  const seq = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    const frame = samples.subarray ? samples.subarray(s, s + win) : samples.slice(s, s + win);
    let e = 0; for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    seq.push({ chroma: pcmToChroma(frame, sampleRate, opts), energy: Math.sqrt(e / frame.length) });
  }
  return seq;
}
/* Align decoded PCM to a score → { segments: sec→event-key (key changes only), confidence
 * 0..1 }. The chart highlight follows `segments`; the UI reverts to the linear ♩= map when
 * `confidence` is low (wrong stem / bad match). Heavy (FFTs + DTW) → run off-thread. */
function alignPcmToScore(samples, sampleRate, score, opts = {}) {
  const hopSec = opts.hopSec != null ? opts.hopSec : 0.25;
  const audioSeq = pcmChromaSequence(samples, sampleRate, { ...opts, hop: Math.floor(sampleRate * hopSec) });
  const scoreSeq = scoreChromaSequence(score);
  if (!audioSeq.length || !scoreSeq.length) return { segments: [], confidence: 0 };
  const maxE = Math.max(...audioSeq.map((f) => f.energy)) || 1;
  const gate = (opts.energyGate != null ? opts.energyGate : 0.08) * maxE;
  let lo = 0, hi = audioSeq.length - 1;
  while (lo <= hi && audioSeq[lo].energy < gate) lo++;             // trim leading silence
  while (hi >= lo && audioSeq[hi].energy < gate) hi--;            // trim trailing silence
  if (lo > hi) return { segments: [], confidence: 0 };            // all silence -> nothing to align
  const Z = new Array(12).fill(0);                                // gated frame -> neutral (no vote)
  // Smooth the audio chroma over a few frames (kills per-frame jitter at chord edges);
  // only average NON-gated neighbours so silence can't bleed a rest into a chord.
  const half = opts.smoothHalf != null ? opts.smoothHalf : 1;
  const smooth = (f) => {
    if (audioSeq[f].energy < gate) return Z;
    const acc = new Array(12).fill(0); let cnt = 0;
    for (let g = Math.max(lo, f - half); g <= Math.min(hi, f + half); g++) {
      if (audioSeq[g].energy < gate) continue;
      const c = audioSeq[g].chroma; for (let p = 0; p < 12; p++) acc[p] += c[p]; cnt++;
    }
    return cnt ? acc.map((v) => v / cnt) : Z;
  };
  const audioMat = []; for (let f = lo; f <= hi; f++) audioMat.push(smooth(f));
  const scoreMat = scoreSeq.map((s) => s.chroma);
  const { path } = _dtw(audioMat, scoreMat, _cosDist);
  const subKey = new Array(audioMat.length).fill(null);
  // Confidence = mean cosine SIMILARITY over the matched, non-silent frames (silence is
  // excluded so a long lead-out can't tank it). Poor match -> the UI falls back to the map.
  let costSum = 0, costN = 0;
  for (const [ai, sj] of path) {
    if (audioSeq[lo + ai].energy < gate) continue;
    if (subKey[ai] == null) subKey[ai] = scoreSeq[sj].key;       // first (earliest) score match per active frame
    costSum += _cosDist(audioMat[ai], scoreMat[sj]); costN++;
  }
  const confidence = costN ? Math.max(0, 1 - costSum / costN) : 0;
  const segments = []; let last = " ";
  for (let f = 0; f < audioSeq.length; f++) {
    let k;
    if (f < lo || f > hi) k = null;                               // trimmed silence -> no highlight
    else k = subKey[f - lo] != null ? subKey[f - lo] : (segments.length ? segments[segments.length - 1].key : null); // sustain through a brief interior gap
    if (k !== last) { segments.push({ sec: +(f * hopSec).toFixed(3), key: k }); last = k; }
  }
  return { segments, confidence: +confidence.toFixed(3) };
}


/* ---- public surface ------------------------------------------------------
 * Every top-level engine binding is exported so the UI (TabDecoderPro.tsx),
 * the headless tests, and the future parse Web Worker can all import the ONE
 * engine — single source of truth, no copy, no drift. (Roadmap Wave 1 #1.) */
export {
  makeMask,
  popcount,
  rotateRight,
  toBinary12,
  TUNINGS,
  NOTE_SHARP,
  NOTE_FLAT,
  INTERVAL_LABELS,
  QUALITIES,
  PRESETS,
  parseTab,
  fretToMidi,
  normalise,
  recognise,
  CHORD_CLASSIFIER,
  classifyChromaQuality,
  arbitrateChord,
  symbolOf,
  symbolForFrets,
  symbolForMidis,
  fretsToMidis,
  median,
  clusterVals,
  estimateSpacing,
  buildChart,
  _fillTrueDur,
  buildScore,
  simplifyScore,
  melodicFraction,
  isMelodicScore,
  STEP_SEMI,
  _xEls,
  _xFirst,
  _xText,
  _xChildText,
  _pitchToMidi,
  _parseTuning,
  _tuningName,
  parseMusicXML,
  _GP_NV,
  _gpProp,
  _gpById,
  _gpIds,
  _gpRhythmQuarters,
  _gpRhythmTuplet,
  _gpNoteMidi,
  parseGPIF,
  gpUnzip,
  parseGP,
  _gpReader,
  _GP_TUPLET,
  _gpEndingLabel,
  _gpReadDuration,
  _gpReadBend,
  _gpReadGrace,
  _gpReadNoteEffects,
  _gpReadBeatEffects,
  _gpReadMixTableChange,
  _gpReadChord,
  _gpReadNote,
  _gpReadBeat,
  parseGP345,
  _gpBuildScore,
  _gp5RSEInstrument,
  _gp5Grace,
  _gp5Harmonic,
  _gp5NoteEffects,
  _gp5MixTable,
  _gp5Note,
  _gp5Beat,
  parseGP5,
  _gpxBitReader,
  _gpxLE32,
  _gpxDecompress,
  _gpxReadFS,
  parseGPX,
  _ptbReader,
  _ptbNew,
  _ptbTuning,
  _ptbGuitar,
  _ptbChordName,
  _ptbChordDiagram,
  _ptbFont,
  _ptbFloatingText,
  _ptbGuitarIn,
  _ptbDynamic,
  _ptbSystemSymbol,
  _ptbTempoMarker,
  _ptbDirection,
  _ptbChordText,
  _ptbRhythmSlash,
  _ptbRehearsal,
  _ptbBarline,
  _ptbNote,
  _ptbPosition,
  _ptbStaff,
  _ptbSystem,
  _ptbScore,
  _ptbHeader,
  _ptbTimeSig,
  parsePowerTab,
  parseGuitarProOrXML,
  _PC_BY_NAME,
  _MAJ,
  _MIN,
  _MAJ_Q,
  _MIN_Q,
  _ROMAN,
  _classOf,
  _parseSym,
  qualCompatible,
  analyzeKey,
  _romanExt,
  romanFor,
  keyName,
  _ovSym,
  _ABC_LTR,
  _ABC_ACC,
  midiToAbc,
  _gcd,
  abcDur,
  _abcChordName,
  scoreToABC,
  scoreToChordPro,
  _csmpnSym,
  _CSMPN_DUR,
  _csmpnDurLetter,
  _csmpnTupNormal,
  _csmpnHybridPos,
  _csmpnVoicing,
  _csmPerfHeaders,
  scoreToCSMPN,
  _csmlBeats,
  _ordinal,
  scoreToCSML,
  _STEP_ALTER_SHARP,
  _STEP_ALTER_FLAT,
  _pcStepAlter,
  _XML_KIND,
  _midiToPitchXML,
  _typeForQuarters,
  _harmonyXML,
  scoreToMusicXML,
  transposeScore,
  ARRANGE_TEMPLATES,
  arrangeScore,
  _midiVarLen,
  scoreToMidi,
  scoreEventTimes,
  playScore,
  freqToMidi,
  midiToFreq,
  midiToNoteName,
  midiToStaffPos,
  staffLayout,
  detectPitch,
  transcribeMonophonic,
  _fft,
  _ifft,
  _hann,
  extractCenter,
  pcmToChroma,
  onsetEnvelope,
  estimateTempo,
  trackBeats,
  detectBeats,
  chordStates,
  beatSegments,
  viterbiChords,
  transcribeChordsBeatSync,
  analyzeAudioChords,
  chordFromChroma,
  detectChord,
  recoverChordGaps,
  transcribeChords,
  harmonicClarity,
  audioEventsToScore,
  notesFromActivations,
  polyNotesToScore,
  transcribeWithNoteModel,
  _cosDist,
  _dtw,
  scoreChromaSequence,
  pcmChromaSequence,
  alignPcmToScore,
  describeScore,
  scoreToMusicPrompt,
};

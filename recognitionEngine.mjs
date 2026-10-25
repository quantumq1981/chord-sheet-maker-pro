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
  // m11 as charts voice it — 1 ♭3 4(11) 5 ♭7, the 9th omitted (the "So What" chord). Without
  // it C#-E-F#-G#-B could only be named E6/9/C#. Highest rank: it never wins a tie in the
  // oracle (E6/9 still does there); a vocabulary's bass-rooted tie-break picks it (C#m11).
  { name: "Minor 11th",     suffix: "m11",   intervals: [0, 3, 5, 7, 10],  rank: 23 },
].map((q) => ({ ...q, mask: makeMask(q.intervals) }));

/* ---- Chord VOCABULARIES for the AUDIO decoders ---------------------------
 * Which chord names an audio decode is allowed to write, and which slash chords. The
 * tab/PDF/GP/XML oracle never reads this (it names exactly what is written); audio does,
 * because a recording can't tell an arranger's 6/9 from a triad with a ringing overtone,
 * nor a deliberate bass line from the lowest of three singers.
 *
 *   qualities   QUALITIES suffixes the decoder may choose from. A quality left out is
 *               not "mapped" to anything: the decoder picks the best-fitting chord that
 *               IS allowed (C6/9 → C, C#dim7 stays dim7, A7♭9 needs its A in the bass).
 *   inversions  per quality, the bass intervals above the root that are WRITTEN as a
 *               slash (C/E, C/G, C7/Bb).
 *   hidden      per quality, bass intervals that are decoded but written in root position
 *               (Cmaj7 over B reads "Cmaj7"; Dsus4 over A reads "Dsus4"). They exist so a 5th
 *               or 7th in the bass still points at the right ROOT — without them Dsus4/A came
 *               out A7sus4. Deliberately NOT the 3rd of m7/m7♭5 nor the 4th of sus4: there the
 *               bass is itself the natural root (Am7 over C is C6, Bm7♭5 over D is Dm6, Gsus4
 *               over C is Csus2), so the chord must be read FROM the bass. Any bass in neither
 *               list is not a state.
 *   foreign     per triad quality, bass intervals that are NOT chord tones but are
 *               standard chart slash chords: major over the 2nd (F/G, Bb/C — the sus
 *               dominant) and over the ♭7 (D/C); minor over the ♭7 (Am/G).
 *   writeAs     qualities that are DETECTED but written under another chart name — the
 *               tonic-major convention: a heard 6/9 is written maj9 (the 9th really sounds;
 *               the 6 becomes the 7) and a heard 6 is written maj7. Detection still needs
 *               the 6th in the audio, so a plain triad is never promoted. The written
 *               chord's voicing is the written quality's, so transpose/export agree.
 *               `opts.sixNine` overrides: "maj9" | "maj7" | "triad" (= don't detect them).
 *               sus2 and add9 are written as the plain triad (the owner's rule: colour notes
 *               the player adds, not chord names). In `recognise` a writeAs source must be
 *               COMPLETE (no missing tone) — a 6 without its 5th is not renamed maj7.
 *
 * `chart` is the professional lead-sheet set and the Audio panel's default (measured in
 * docs/SYNHARMONICS-V2.md §9). `full` = every quality and every chord-tone inversion
 * (the pre-2026-10-25 behaviour). `basic` = triads and 7ths in root position. */
const CHORD_VOCABULARIES = {
  chart: {
    label: "Pro",
    qualities: ["", "m", "7", "maj7", "m7", "m7♭5", "dim", "dim7", "sus4", "7sus4", "9", "m9", "m11", "maj9", "7♭9"],
    // a minor triad over its 3rd or 5th is just that minor chord on a chart (C#-E-G# over E → C#m,
    // the owner's call); major triads and dominant 7ths keep their bass-line slashes (C/E, C7/Bb)
    inversions: { "": [4, 7], "7": [4, 10] },
    hidden: { m: [3, 7], "7": [7], maj7: [4, 7, 11], m7: [7, 10], "m7♭5": [6, 10], dim: [3, 6], sus4: [7], "7sus4": [7], "6": [4, 7] },
    foreign: { "": [2, 10], m: [10] },
    writeAs: { "6/9": "maj9", "6": "maj7", sus2: "", add9: "" },
  },
  basic: {
    label: "Basic",
    qualities: ["", "m", "7", "maj7", "m7", "m7♭5", "dim7", "sus4"],
    inversions: {},
    hidden: { "": [4, 7], m: [3, 7], "7": [4, 7, 10], maj7: [4, 7, 11], m7: [7, 10], "m7♭5": [6, 10], sus4: [7], "6": [4, 7] },
    foreign: {},
    writeAs: { "6/9": "maj7", "6": "maj7", sus2: "", add9: "" },
  },
  full: { label: "Full", qualities: null, inversions: null, hidden: null, foreign: null, writeAs: null },
};
/* A vocabulary name or object → { allow:Set, inversions, hidden, foreign, writeAs } (null =
 * no limit). `allow` holds every DECODED quality (incl. writeAs sources); `writeAs` maps a
 * decoded suffix to its written QUALITIES entry. `sixNine` ("maj9" | "maj7" | "triad")
 * overrides the 6/9 target; a target the vocabulary doesn't write (maj9 in Basic) becomes
 * maj7. Unknown names fall back to `full` so a typo can never empty the state space. */
function resolveChordVocabulary(v, sixNine) {
  const V = typeof v === "string" ? CHORD_VOCABULARIES[v] : v;
  if (!V || !V.qualities) return null;
  const allow = new Set(V.qualities), writeAs = {};
  const map = { ...(V.writeAs || {}) };
  if (sixNine === "triad") { delete map["6/9"]; delete map["6"]; }
  else if ((sixNine === "maj9" || sixNine === "maj7") && map["6/9"]) map["6/9"] = sixNine;
  for (const [from, to0] of Object.entries(map)) {
    const to = allow.has(to0) ? to0 : "maj7";
    const q = QUALITIES.find((x) => x.suffix === to);
    if (!q || !QUALITIES.some((x) => x.suffix === from)) continue;
    allow.add(from); writeAs[from] = q;
  }
  return { allow, inversions: V.inversions || {}, hidden: V.hidden || {}, foreign: V.foreign || {}, writeAs };
}
/* May quality q on `root` sound over this bass in this vocabulary (`recognise` only)? Root
 * position always; a chord tone only when listed (written or hidden). A non-chord-tone bass
 * under a TRIAD is allowed — written only when listed (F/G, Bb/C, D/C, Am/G), otherwise the
 * triad is named and the unfamiliar bass dropped (F#-A-C# over G → F#m, not A7/G, which
 * would invent an E). Under any other chord a foreign bass must be listed. */
function _vocabBassOK(vocab, q, root, bassPc) {
  const iv = (bassPc - root + 12) % 12;
  if (iv === 0) return true;
  const s = q.suffix;
  if (q.intervals.indexOf(iv) >= 0) return (vocab.inversions[s] || []).indexOf(iv) >= 0 || (vocab.hidden[s] || []).indexOf(iv) >= 0;
  return s === "" || s === "m" || (vocab.foreign[s] || []).indexOf(iv) >= 0;
}

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
  const vocab = resolveChordVocabulary(opts.vocabulary, opts.sixNine);     // audio only; undefined = every quality
  for (const root of chroma) {
    const transposed = rotateRight(chordMask, root);
    for (const q of QUALITIES) {
      if (vocab && !vocab.allow.has(q.suffix)) continue;
      // Opt-in: cap chord complexity by `rank` (basic triads/7ths/6/sus ≤14, jazz
      // extensions add9/9/m9/maj9/6-9/7♭9/7♯9/m(maj7) ≥15). DEFAULT is undefined → no
      // filtering, so the oracle stays byte-identical for tab/PDF/GP/XML recognition;
      // only the audio path opts in (polyphonic vocal/instrument chroma over-labels
      // extensions — the 3 voices light 4+ pcs, so the scorer reaches for a 9th).
      if (opts.maxRank != null && q.rank > opts.maxRank) continue;
      // a vocabulary also limits which bass a chord may have (root, a listed inversion, or a
      // listed foreign bass) — so E6/9 over its 6th (C#) is not a candidate; C#m11 is
      if (vocab && bassPc != null && !_vocabBassOK(vocab, q, root, bassPc)) continue;
      const inter = popcount(transposed & q.mask);
      const extra = popcount(transposed & ~q.mask & 0xfff);
      const missing = popcount(q.mask & ~transposed & 0xfff);
      if (vocab && vocab.writeAs[q.suffix] && missing > 0) continue;   // rename only a complete 6 / 6/9 / sus2 / add9
      const score = inter - 0.8 * extra - 1.2 * missing;       // ranking
      const confidence = inter / (inter + extra + missing);    // displayed (Jaccard)
      candidates.push({ root, quality: q, transposed, inter, extra, missing, score, confidence });
    }
  }
  // with a vocabulary, an equal fit is read FROM THE BASS (C#-E-F#-G#-B over C# → C#m11, not
  // E6/9) before the rarity rank decides; without one the oracle's order is untouched
  /* A vocabulary narrows the names, so a voicing may have no exact match left (C-D-G once sus2 is
   * gone). Then the raw score prefers a big chord missing two notes (C9: C·D·G present, E·B♭
   * missing) over a triad missing one — inventing two notes. Drop candidates missing ≥ 2 tones
   * whenever a closer one exists. */
  if (vocab && candidates.some((c) => c.missing <= 1)) for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].missing > 1) candidates.splice(i, 1);
  candidates.sort((a, b) => (b.score - a.score) || (vocab ? (b.root === bassPc) - (a.root === bassPc) : 0) || (a.quality.rank - b.quality.rank));
  let best = candidates[0];
  /* NARROW bass-priority tie-break: m6 read as m7♭5 when the bass says so.
   *
   * A minor-6 and a half-diminished 7th a minor-3rd below are the SAME four pitch
   * classes (Am6 = A C E F# = F#m7♭5), and `m6` (rank 10) out-ranks `m7♭5` (rank 12),
   * so the m6 reading always won. That is why the Tristan chord (F B D# G#) came out
   * `Abm6/F` instead of `Fø7`, and B D F A came out `Dm6/B` instead of `Bø7`.
   *
   * When the BASS is the m7♭5 root — i.e. the chord is in root position as a half-
   * diminished — that is the reading every lead sheet uses (it is the ii of a minor
   * ii–V–i). Deliberately narrow: it fires only for m6-vs-m7♭5, and only when the bass
   * is exactly root+9, so no other quality's ranking moves. */
  if (opts.halfDimBass !== false && bassPc != null && best && best.quality.suffix === "m6" && ((best.root + 9) % 12) === bassPc) {
    const alt = candidates.find((c) => c.root === bassPc && c.quality.suffix === "m7♭5");
    if (alt) best = alt;
  }
  // a vocabulary's chart convention: a detected 6/9 / 6 is written as its maj9 / maj7
  // a vocabulary writes a slash only where it lists one (C/E, C7/Bb, F/G); a hidden inversion
  // reads in root position (Cmaj7 over B → "Cmaj7")
  let isSlash = bassPc !== null && best.root !== bassPc;
  if (vocab && isSlash) {
    const iv = (bassPc - best.root + 12) % 12, suf = best.quality.suffix;
    isSlash = (vocab.inversions[suf] || []).indexOf(iv) >= 0 || (best.quality.intervals.indexOf(iv) < 0 && (vocab.foreign[suf] || []).indexOf(iv) >= 0);
  }
  if (vocab && best && vocab.writeAs[best.quality.suffix]) best = { ...best, quality: vocab.writeAs[best.quality.suffix], writtenFrom: best.quality.suffix };
  return { best, candidates: candidates.slice(0, 4), isSlash, bassPc };
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
/* Re-name every chord of a score with a chord VOCABULARY (CHORD_VOCABULARIES) — the naming
 * pass for charts the audio decoder didn't name: PDF / Guitar Pro / MusicXML / Power Tab
 * imports, Voices (ML), Guitar → Tab, Simplify, transpose. Each event is re-recognised from
 * its own `midis` (lowest note = bass), so C#-E-F#-G#-B over C# reads C#m11 in Chart instead
 * of the oracle's E6/9/C#. Pure: never mutates, keeps every other field, leaves single notes /
 * rests / events without pitches alone. `full` (or no vocabulary) returns the score as written
 * by the oracle. Idempotent — a chart the audio decoder already named in this vocabulary comes
 * back unchanged (its voicings are the written chords) — so no "already named" flag is needed,
 * and none could survive transposeScore, which re-names from the notes. */
function respellScore(score, vocabulary, opts = {}) {
  if (!score || !score.bars || !resolveChordVocabulary(vocabulary)) return score;
  const useSharp = opts.useSharp !== false;
  const ropts = { vocabulary, sixNine: opts.sixNine };
  const bars = score.bars.map((b) => {
    let changed = false;
    const events = (b.events || []).map((e) => {
      if (!e || e.reviewed) return e;                     // a person chose this name in the review list
      const ms = Array.isArray(e.midis) ? [...new Set(e.midis)].sort((x, y) => x - y) : null;
      if (!ms || new Set(ms.map((m) => ((m % 12) + 12) % 12)).size < 2) return e;
      const norm = normalise(ms.map((m) => ({ midi: m })));
      const sym = symbolOf(recognise(norm.chroma, norm.chordMask, norm.bassPc, ropts), useSharp);
      if (sym === e.symbol) return e;
      changed = true;
      return { ...e, symbol: sym };
    });
    return changed ? { ...b, events } : b;
  });
  return { ...score, bars };
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
/* `opts.systemShifts` — MANUAL per-system string correction (Roadmap Wave 2 #7).
 *
 * `topY` (the high-e line) is anchored to the highest digit row in a system, which is
 * correct only when that system actually plays the high e. When it doesn't, the anchor
 * latches onto a lower string and EVERY note in that system shifts by one or more
 * strings — silently, producing confident wrong chords (Kid Charlemagne bars 26–32 read
 * Fm7 where the truth is C7).
 *
 * This is NOT auto-fixable from the PDF layers and the auto-fix is a documented trap:
 * the correctly-anchored Blue Sky system and the mis-anchored Kid Charlemagne one have
 * near-identical geometry (notation→digit offsets 52.6pt vs 53.3pt), so any rule that
 * shifts the second also breaks the first. The honest escape hatch is a manual override.
 *
 * `systemShifts` is indexed by GLOBAL system index (the order systems are found across
 * pages, matching the `systems` array in the return value). The value is added to the
 * engine string index (0 = low E … 5 = high e), so **−1 moves every note in that system
 * toward the bass** and +1 toward the treble. Default (absent/0) is a no-op, so the
 * validated corpus is untouched. */
function buildChart(tokens, opts = {}) {
  const shifts = opts.systemShifts || {};
  const pages = {};
  tokens.forEach((t) => (pages[t.page] = pages[t.page] || []).push(t));
  const measures = new Map();
  const systems = [];
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
      const sysIndex = systemsFound;                      // global, across pages
      systemsFound++;
      const shift = (shifts[sysIndex] | 0) || 0;
      const sysMeasures = new Set();
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
          const eng = 5 - top + shift;                        // 0 = low E (+ manual shift)
          if (eng < 0 || eng > 5) return;                     // shifted off the neck
          if (frets[eng] === undefined) frets[eng] = d.val;
        });
        if (!Object.keys(frets).length) return;
        let meas = null;
        for (const m of marks) if (cx >= m.x - pad) meas = m.num;
        if (meas == null) return;
        columnsFound++;
        sysMeasures.add(meas);
        if (!measures.has(meas)) measures.set(meas, { number: meas, columns: [] });
        const mo = measures.get(meas);
        mo.columns.push({ x: cx, frets });
        if (mo.startX === undefined && markExt.has(meas)) {
          const e = markExt.get(meas); mo.startX = e.startX; mo.endX = e.endX;
        }
      });
      // report each system + the bars it covers, so the UI can offer a per-system
      // shift control labelled with something the user can actually find on the page
      const nums = [...sysMeasures].sort((a, b) => a - b);
      systems.push({ index: sysIndex, page: ds[0] ? ds[0].page : 0, shift, measures: nums, firstMeasure: nums[0] != null ? nums[0] : null, lastMeasure: nums.length ? nums[nums.length - 1] : null });
    });
  });

  const list = [...measures.values()].sort((a, b) => a.number - b.number);
  list.forEach((m) => m.columns.sort((a, b) => a.x - b.x));
  systems.sort((a, b) => a.index - b.index);
  return { measures: list, systemsFound, columnsFound, systems };
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
/* Open-string MIDI pitches keyed EXACTLY like `event.frets` (engine index 0 = lowest of six
 * slots), with `null` for a slot the instrument does not have — a 4-string bass read from a
 * GP3/4/5 file sits on keys 2…5, because those readers key frets as 6 − string. Built by
 * every parser as `score.tuningMidi`, so fingering and tab export use the real tuning
 * (drop / down-tuned / bass), not the name. `put(key, midi)` ignores keys outside 0…5. */
function _tuningByKey(fill) {
  const tk = [null, null, null, null, null, null];
  fill((k, m) => { if (k >= 0 && k <= 5 && Number.isFinite(m)) tk[k] = m; });
  return tk.some((m) => m != null) ? tk : null;
}
function _tuningName(arr) {
  if (!arr) return "Standard";
  for (const [n, t] of Object.entries(TUNINGS)) if (t.every((v, i) => v === arr[i])) return n;
  return "Custom";
}

// MusicXML <kind> value -> engine QUALITIES suffix (inverse of _XML_KIND, plus
// common synonyms). Used to voice a <harmony> chord symbol into MIDI notes.
const _MXKIND_SUFFIX = {
  "major": "", "minor": "m", "dominant": "7", "dominant-seventh": "7",
  "major-seventh": "maj7", "minor-seventh": "m7", "minor-sixth": "m6",
  "major-sixth": "6", "diminished": "dim", "diminished-seventh": "dim7",
  "half-diminished": "m7♭5", "augmented": "aug", "augmented-seventh": "7",
  "suspended-second": "sus2", "suspended-fourth": "sus4",
  "suspended-fourth-seventh": "7sus4", "power": "5",
  "major-minor": "m(maj7)", "dominant-ninth": "9", "major-ninth": "maj9",
  "minor-ninth": "m9", "major-sixth-ninth": "6/9", "add9": "add9",
};
const _SUFFIX_INTERVALS = QUALITIES.reduce((m, q) => { m[q.suffix] = q.intervals; return m; }, {});

// Turn a <harmony> chord symbol into { symbol, midis }. The symbol is the
// EXPLICIT chord the file already states, so we spell it directly (root + suffix
// + optional /bass) using the engine's note table — more faithful than
// re-inferring it (a non-chord-tone bass like D/E would fold into "Dadd9/E").
// The voicing (root at C3=48; an explicit bass a register below so it stays the
// lowest note) feeds playback / ABC / transpose. Returns null for no chord/N.C.
//
// Accidentals: standard MusicXML uses <root-alter>/<bass-alter>, but some
// exporters (incl. this app family) write a plain <alter> inside <root>/<bass> —
// both are read, scoped to their parent element so root and bass don't collide.
function _harmonyChord(h, useSharp) {
  const rootEl = _xFirst(h, "root");
  if (!rootEl) return null;
  const step = _xChildText(rootEl, "root-step") || _xChildText(rootEl, "step");
  if (!step || !(step in STEP_SEMI)) return null;
  const kind = _xChildText(h, "kind").toLowerCase().trim();
  if (!kind || kind === "none") return null;
  const alter = parseInt(_xChildText(rootEl, "root-alter") || _xChildText(rootEl, "alter") || "0", 10) || 0;
  const rootPc = (STEP_SEMI[step] + alter + 1200) % 12;
  const suffix = kind in _MXKIND_SUFFIX ? _MXKIND_SUFFIX[kind] : "";
  const intervals = _SUFFIX_INTERVALS[suffix] || [0, 4, 7];
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  const rootMidi = 48 + rootPc;
  const midis = intervals.map((iv) => rootMidi + iv);
  let symbol = names[rootPc] + suffix;
  const bassEl = _xFirst(h, "bass");
  if (bassEl) {
    const bstep = _xChildText(bassEl, "bass-step") || _xChildText(bassEl, "step");
    if (bstep && bstep in STEP_SEMI) {
      const balter = parseInt(_xChildText(bassEl, "bass-alter") || _xChildText(bassEl, "alter") || "0", 10) || 0;
      const bassPc = (STEP_SEMI[bstep] + balter + 1200) % 12;
      if (bassPc !== rootPc) { midis.unshift(36 + bassPc); symbol += "/" + names[bassPc]; }
    }
  }
  return { symbol, midis };
}

function parseMusicXML(xml, useSharp = true, partIndex = 0) {
  if (partIndex === HARMONY_PART) {                       // every pitched part read together (see mergePartNotes)
    const head = parseMusicXML(xml, useSharp, 0);
    const notes = head.parts.map((p) => _musicXmlPartNotes(xml, p.index));
    const keep = harmonyPartIndices(head.parts, notes);
    return { ...head, ...mergePartNotes(head.bars, keep.map((i) => notes[i]), useSharp, { names: keep.map((i) => head.parts[i].name) }) };
  }
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
    const harmonies = []; // [{ onset, midis }] from <harmony> chord symbols
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
        // Slash noteheads are rhythm placeholders (fake-book / lead-sheet slash
        // charts), NOT real pitches — the chord lives in <harmony>. Skip them from
        // pitch recognition (cursor already advanced) so onsets stays empty and the
        // <harmony> path below takes over.
        if (_xChildText(node, "notehead").toLowerCase() === "slash") continue;
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
      } else if (tag === "harmony") {
        const hc = _harmonyChord(node, useSharp);
        if (hc) harmonies.push({ onset: cursor, symbol: hc.symbol, midis: hc.midis });
      } else if (tag === "backup") { cursor -= parseInt(_xChildText(node, "duration") || "0", 10) || 0; }
      else if (tag === "forward") { cursor += parseInt(_xChildText(node, "duration") || "0", 10) || 0; }
    }
    const divPerBeat = (divisions * 4) / beatType || divisions;
    // When a measure has explicit <harmony> chord symbols and no real pitched
    // notes (a slash-notation chart), name the bars from the harmony symbols.
    // Otherwise keep the validated note-recognition path unchanged.
    const raw = (harmonies.length && onsets.size === 0)
      ? harmonies.slice().sort((a, b2) => a.onset - b2.onset).map(({ onset, symbol, midis }) => ({
          symbol, midis: [...midis].sort((a, b2) => a - b2), frets: {}, tuplet: 0, onset,
        }))
      : [...onsets.entries()].sort((a, b2) => a[0] - b2[0]).map(([onset, o]) => ({
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
  return { source: "musicxml", timeSig: bars.length ? bars[0].timeSig : [beats, beatType], tuning: _tuningName(tuning), tuningMidi: _tuningByKey((put) => (tuning || []).forEach((m, i) => put(i, m))), tempo, bars, parts, partIndex: idx };
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
// GPIF note techniques: <Property> flags plus a few direct child elements. Accent is a
// bitmask (1 staccato · 4 heavy accent · 8 accent); <AntiAccent> marks a ghost note.
// GPIF bend size: the largest of origin / middle / destination, 25 units per quarter-tone.
function _gpifBendQt(note) {
  if (!_gpProp(note, "Bended")) return 0;
  const val = (n) => { const p = _gpProp(note, n); return p ? Math.abs(parseFloat(_xChildText(p, "Float")) || 0) : 0; };
  return Math.round(Math.max(val("BendOriginValue"), val("BendMiddleValue"), val("BendDestinationValue")) / 25);
}
function _gpifNoteTech(note) {
  const t = [];
  if (_gpProp(note, "Bended")) t.push("bend");
  if (_gpProp(note, "Slide")) t.push("slide");
  if (_gpProp(note, "HopoOrigin") || _gpProp(note, "HopoDestination")) t.push("hammer");
  if (_gpProp(note, "HarmonicType") || _gpProp(note, "HarmonicFret")) t.push("harmonic");
  if (_gpProp(note, "PalmMuted")) t.push("palmMute");
  if (_gpProp(note, "Muted")) t.push("dead");
  if (_gpProp(note, "Tapped")) t.push("tap");
  if (_xFirst(note, "Vibrato")) t.push("vibrato");
  if (_xFirst(note, "LetRing")) t.push("letRing");
  if (_xFirst(note, "Trill")) t.push("trill");
  if (_xFirst(note, "AntiAccent")) t.push("ghost");
  const acc = parseInt(_xChildText(note, "Accent") || "0", 10) || 0;
  if (acc & 1) t.push("staccato");
  if (acc & 12) t.push("accent");
  return t;
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
  let tuningAll = null;
  if (tunProp) { const pit = _gpIds(_xChildText(tunProp, "Pitches")).map(Number); if (pit.every((v) => !isNaN(v))) { tuningAll = pit; if (pit.length === 6) tuning = pit; } } // gpif lists low→high (String 0 = low E)

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
            if (!onsets.has(cursor)) onsets.set(cursor, { midis: [], frets: {}, tech: {}, bends: {}, tuplet: tup });
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
              if (s != null && s >= 0 && s <= 5 && o.frets[s] === undefined) { o.frets[s] = f; const t = _gpifNoteTech(note); if (t.length) o.tech[s] = t; const bq = _gpifBendQt(note); if (bq) o.bends[s] = bq; }
            });
          }
          cursor += q;
        });
      });
    }
    const qPerBeat = 4 / btype; // a "beat" = one 1/beatType note
    const raw = [...onsets.entries()].filter(([, o]) => o.midis.length).sort((a, b) => a[0] - b[0])
      .map(([onset, o]) => _withTech({ symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b) => a - b), frets: o.frets, tuplet: o.tuplet || 0, onset }, o.tech, o.bends));
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
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : lastSig, tuning: _tuningName(tuning), tuningMidi: _tuningByKey((put) => (tuningAll || TUNINGS.Standard).forEach((m, i) => put(i, m))), tempo, bars, parts, partIndex: idx };
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
// Bend: type, total value, then n points (offset, value, vibrato). Returns the largest point
// value in QUARTER-TONES (GP stores 25 units per quarter-tone, the factor alphaTab's importer uses).
function _gpReadBend(r) { r.i8(); r.i32(); const n = r.i32(); let mx = 0; for (let i = 0; i < n; i++) { r.i32(); const v = r.i32(); r.bool(); if (Math.abs(v) > mx) mx = Math.abs(v); } return Math.round(mx / 25); }
function _gpReadGrace(r) { r.i8(); r.u8(); r.u8(); r.i8(); }            // fret, velocity, duration, transition
// Technique tags (`event.tech`) — a fixed vocabulary shared by every reader and exporter.
const TECHNIQUES = ["bend", "slide", "hammer", "harmonic", "palmMute", "vibrato", "letRing", "staccato", "trill", "tremolo", "grace", "ghost", "accent", "dead", "tap"];
// GP3/4 note-effect flags → tags. f1: 0x01 bend · 0x02 hammer/pull · 0x04 slide (GP3) ·
// 0x08 let ring · 0x10 grace; f2 (GP4+): 0x01 staccato · 0x02 palm mute · 0x04 tremolo
// picking · 0x08 slide · 0x10 harmonic · 0x20 trill · 0x40 vibrato.
function _gpEffectTags(f1, f2, v) {
  const t = [];
  if (f1 & 0x01) t.push("bend");
  if (f1 & 0x02) t.push("hammer");
  if (v < 4 && (f1 & 0x04)) t.push("slide");
  if (f1 & 0x08) t.push("letRing");
  if (f1 & 0x10) t.push("grace");
  if (v >= 4) {
    if (f2 & 0x01) t.push("staccato");
    if (f2 & 0x02) t.push("palmMute");
    if (f2 & 0x04) t.push("tremolo");
    if (f2 & 0x08) t.push("slide");
    if (f2 & 0x10) t.push("harmonic");
    if (f2 & 0x20) t.push("trill");
    if (f2 & 0x40) t.push("vibrato");
  }
  return t;
}
function _gpReadNoteEffects(r, v) {
  if (v >= 4) {
    const f1 = r.u8(), f2 = r.u8();
    const bend = (f1 & 0x01) ? _gpReadBend(r) : 0;
    if (f1 & 0x10) _gpReadGrace(r);
    if (f2 & 0x04) r.i8();                                             // tremolo picking
    if (f2 & 0x08) r.i8();                                             // slide
    if (f2 & 0x10) r.i8();                                             // harmonic
    if (f2 & 0x20) { r.i8(); r.i8(); }                                 // trill
    return Object.assign(_gpEffectTags(f1, f2, v), { bend });
  }
  const f1 = r.u8();
  const bend = (f1 & 0x01) ? _gpReadBend(r) : 0;
  if (f1 & 0x10) _gpReadGrace(r);                                      // 0x04 slide: no bytes in GP3
  return Object.assign(_gpEffectTags(f1, 0, v), { bend });
}
// Returns the beat-level technique tags (they apply to every note of the beat).
function _gpReadBeatEffects(r, v) {
  const t = [];
  if (v >= 4) {
    const f1 = r.u8(), f2 = r.u8();
    if (f1 & 0x03) t.push("vibrato");                                  // vibrato / wide vibrato
    if (f1 & 0x20) { if (r.i8() === 1) t.push("tap"); }                // slap effect: 1 = tapping
    if (f2 & 0x04) _gpReadBend(r);                                     // tremolo bar = bend
    if (f1 & 0x40) { r.i8(); r.i8(); }                                 // stroke
    if (f2 & 0x02) r.i8();                                             // pick stroke
  } else {
    const f1 = r.u8();
    if (f1 & 0x03) t.push("vibrato");
    if (f1 & 0x0c) t.push("harmonic");                                 // natural / artificial harmonic
    if (f1 & 0x20) { const slap = r.u8(); r.i32(); if (slap === 1) t.push("tap"); } // tremolo bar (0) / slap value
    if (f1 & 0x40) { r.i8(); r.i8(); }                                 // stroke
  }
  return t;
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
  const tech = (flags & 0x08) ? _gpReadNoteEffects(r, v) : [];
  if (flags & 0x04) tech.push("ghost");
  if (flags & 0x40) tech.push("accent");
  if (type === 2) { fret = state.lastFret[stringNumber]; if (fret == null) return null; } // tie → sustain prior pitch
  else if (type === 3) return null;                                   // dead/muted → no pitch
  if (fret == null) return null;
  fret = Math.min(Math.max(fret, 0), 99);
  state.lastFret[stringNumber] = fret;
  return { fret, midi: tuning[stringNumber - 1] + fret, tech, bend: tech.bend || 0 };
}
function _gpReadBeat(r, v, stringCount, tuning, state) {
  const flags = r.u8();
  let empty = false;
  if (flags & 0x40) { const st = r.u8(); empty = st === 0; }          // 0=empty, 2=rest
  const durQuarters = _gpReadDuration(r, flags);
  if (flags & 0x02) _gpReadChord(r, v, stringCount);
  if (flags & 0x04) r.intByteString();                               // text
  const beatTech = (flags & 0x08) ? _gpReadBeatEffects(r, v) : [];
  if (flags & 0x10) _gpReadMixTableChange(r, v);
  const stringFlags = r.u8();
  const midis = [], frets = {}, tech = {}, bends = {};
  for (let s = 1; s <= stringCount; s++) {
    if (stringFlags & (1 << (7 - s))) {
      const note = _gpReadNote(r, v, s, tuning, state);
      if (note) { midis.push(note.midi); frets[6 - s] = note.fret; _gpAddTech(tech, 6 - s, note.tech, beatTech, note.bend, bends); }
    }
  }
  return { durQuarters: empty ? 0 : durQuarters, midis, frets, tech, bends, tuplet: r._tuplet || 0 };
}
// Merge a note's tags + its beat's tags into a {engIdx → tags} map (only non-empty entries);
// a bend's size goes to the parallel {engIdx → quarter-tones} map. Plain objects and arrays
// only — the GP3/4/5 parse runs in a Worker, and structured clone drops array extras.
function _gpAddTech(map, eng, noteTags, beatTags, bend, bends) {
  const t = [...new Set([...(noteTags || []), ...(beatTags || [])])];
  if (t.length) map[eng] = t;
  if (bend && bends) bends[eng] = bend;
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
// Attach `tech` ({engIdx → tags}) and `bends` ({engIdx → quarter-tones}) to an event only
// when present, so technique-free events stay byte-identical to what every exporter and test
// already sees.
const _withTech = (e, tech, bends) => {
  let out = e;
  if (tech && Object.keys(tech).length) out = { ...out, tech };
  if (bends && Object.keys(bends).length) out = { ...out, bends };
  return out;
};
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
        if (b.midis.length) { if (!onsets.has(cursor)) onsets.set(cursor, { midis: [], frets: {}, tech: {}, bends: {}, tuplet: b.tuplet || 0 }); const o = onsets.get(cursor); b.midis.forEach((x) => o.midis.push(x)); Object.keys(b.frets).forEach((k) => { if (o.frets[k] === undefined) { o.frets[k] = b.frets[k]; if (b.tech && b.tech[k]) o.tech[k] = b.tech[k]; if (b.bends && b.bends[k]) o.bends[k] = b.bends[k]; } }); }
        cursor += b.durQuarters;
      });
    });
    const qPerBeat = 4 / btype;
    const raw = [...onsets.entries()].filter(([, o]) => o.midis.length).sort((a, b) => a[0] - b[0])
      .map(([onset, o]) => _withTech({ symbol: symbolForMidis(o.midis, useSharp), midis: [...o.midis].sort((a, b) => a - b), frets: o.frets, tuplet: o.tuplet || 0, onset }, o.tech, o.bends));
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.qbeat = e.onset / qPerBeat; e.beat = Math.max(0, Math.min(bts - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(bts - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : bts) - e.beat; });
    _fillTrueDur(events, bts);
    const md = m.meta || {};
    return { number: mi + 1, timeSig: [bts, btype], section: md.section || undefined, repeatStart: !!md.repeatStart, repeatEnd: !!md.repeatEnd, ending: md.ending || null, events: events.map(({ onset, ...e }) => e) };
  });
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : [4, 4], tuning: _tuningName(tr.tuning ? [...tr.tuning].reverse() : null), tuningMidi: _tuningByKey((put) => (tr.tuning || []).forEach((m, i) => put(6 - (i + 1), m))), capo: tr.capo || 0, tempo, bars, parts, partIndex: idx };
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
  const bend = (f1 & 0x01) ? _gpReadBend(r) : 0;
  if (f1 & 0x10) _gp5Grace(r);
  if (f2 & 0x04) r.i8();                                              // tremolo picking
  if (f2 & 0x08) r.u8();                                              // slide flags
  if (f2 & 0x10) _gp5Harmonic(r);
  if (f2 & 0x20) { r.i8(); r.i8(); }                                  // trill
  return Object.assign(_gpEffectTags(f1, f2, 5), { bend });
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
  const tech = (flags & 0x08) ? _gp5NoteEffects(r) : [];
  if (flags & 0x04) tech.push("ghost");
  if (flags & 0x42) tech.push("accent");                             // accentuated / heavy accent
  if (type === 2) { fret = state.lastFret[stringNumber]; if (fret == null) return null; }
  else if (type === 3) return null;
  if (fret == null) return null;
  fret = Math.min(Math.max(fret, 0), 99);
  state.lastFret[stringNumber] = fret;
  return { fret, midi: tuning[stringNumber - 1] + fret, tech, bend: tech.bend || 0 };
}
function _gp5Beat(r, stringCount, tuning, state, gt500) {
  const flags = r.u8();
  let empty = false;
  if (flags & 0x40) { const st = r.u8(); empty = st === 0; }
  const durQuarters = _gpReadDuration(r, flags);
  if (flags & 0x02) _gpReadChord(r, 4, stringCount);                 // GP4-format chord
  if (flags & 0x04) r.intByteString();
  const beatTech = (flags & 0x08) ? _gpReadBeatEffects(r, 4) : [];  // GP4-format beat effects
  if (flags & 0x10) _gp5MixTable(r, gt500);
  const stringFlags = r.u8();
  const midis = [], frets = {}, tech = {}, bends = {};
  for (let s = 1; s <= stringCount; s++) {
    if (stringFlags & (1 << (7 - s))) { const note = _gp5Note(r, s, tuning, state); if (note) { midis.push(note.midi); frets[6 - s] = note.fret; _gpAddTech(tech, 6 - s, note.tech, beatTech, note.bend, bends); } }
  }
  const f2 = r.i16();
  if (f2 & 0x0800) r.u8();                                           // break-secondary-beams count
  return { durQuarters: empty ? 0 : durQuarters, midis, frets, tech, bends, tuplet: r._tuplet || 0 };
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
  return { source: "gp", timeSig: bars.length ? bars[0].timeSig : [4, 4], tuning: _tuningName(tuning.length === 6 ? [...tuning].reverse() : null), tuningMidi: _tuningByKey((put) => tuning.forEach((m, i) => put(tuning.length - 1 - i, m))), tempo, bars, parts, partIndex: idx };
}

/* Detect format from the file head and dispatch to the right parser. */
/* ===========================================================================
 *  HARMONY — every pitched part merged into one chord reading (2026-10-25)
 *  --------------------------------------------------------------------------
 *  A multi-instrument transcription (Muscriptor's sheets zip, a band MIDI file)
 *  has no chord symbols: each part holds only its own notes, so the piano alone
 *  reads Dbmaj7 where the bass under it says Bbm9. `mergePartNotes` reads the
 *  parts TOGETHER: at every onset of any part, the chord is the union of what
 *  each part is sounding there, from the notes' REAL written lengths (score
 *  events only keep the gap to the part's next onset, which would cut a chord
 *  held under a moving melody short — measured on the Muscriptor fixture, the
 *  MusicXML and MIDI readings only agree when real lengths are used). Vocal and drum parts are left out by
 *  name (`_HARMONY_EXCLUDE`) — a sung melody fakes extensions and slash basses —
 *  unless nothing else has notes. The result is the shared score shape, flagged
 *  `merged`, and ChartPanel simplifies it to one chord per bar by default.
 *  `partIndex === HARMONY_PART` selects it in parseMusicXML / parseMidiFile.
 * ==========================================================================*/
const HARMONY_PART = -1;
const _HARMONY_EXCLUDE = /\b(voice|vocals?|vox|choir|singers?|soprano|alto|tenor|baritone|drums?|drum\s*kit|percussion|kit)\b/i;
/* Which parts to read together: every part with pitched notes whose name is not a voice or a
 * drum kit; if that leaves nothing, every pitched part. `partNotes[i]` = per-bar note lists. */
function harmonyPartIndices(parts, partNotes) {
  const all = parts.map((p, i) => i).filter((i) => partNotes[i] && partNotes[i].some((b) => b.length));
  const keep = all.filter((i) => !_HARMONY_EXCLUDE.test(parts[i].name || ""));
  return keep.length ? keep : all;
}
/* `barsMeta[b]` = a bar of the shared shape (number, timeSig, section, repeats…; its events are
 * replaced); `partNotes[part][bar]` = [{ midi, q, d }] in beats from the bar start, with the
 * notes' REAL lengths — a held chord under a moving melody is still sounding at every melody
 * onset. At each onset of any part the chord is every note sounding there. */
function mergePartNotes(barsMeta, partNotes, useSharp = true, opts = {}) {
  const EPS = 1e-6;
  const bars = barsMeta.map((ref, bi) => {
    const beats = (ref.timeSig || [4, 4])[0];
    const notes = partNotes.flatMap((pn) => pn[bi] || []).filter((n) => n.d > EPS);
    const points = [...new Set(notes.map((n) => +n.q.toFixed(6)))].sort((a, b) => a - b);
    const raw = [];
    for (const t of points) {
      const ms = [...new Set(notes.filter((n) => n.q <= t + EPS && t < n.q + n.d - EPS).map((n) => n.midi))].sort((a, b) => a - b);
      if (ms.length) raw.push({ symbol: symbolForMidis(ms, useSharp), midis: ms, frets: {}, tuplet: 0, qbeat: t });
    }
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.beat = Math.max(0, Math.min(beats - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(beats - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : beats) - e.beat; });
    _fillTrueDur(events, beats);
    return { ...ref, events };
  });
  return { bars, merged: true, mergedParts: opts.names || [], partIndex: HARMONY_PART };
}
/* Per-bar pitched notes of one MusicXML part, with their written lengths (same cursor /
 * <chord/> / <backup> / <forward> walk as parseMusicXML; grace notes, rests, slash noteheads and
 * unpitched drum notes carry no pitch). A tied continuation is a note of its own bar. */
function _musicXmlPartNotes(xml, partIndex) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const part = _xEls(doc, "part")[partIndex];
  if (!part) return [];
  let divisions = 1, beatType = 4, tuning = null;
  return _xEls(part, "measure").map((measure) => {
    let cursor = 0, lastOnset = 0; const out = [];
    for (let node = measure.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      const tag = node.nodeName;
      if (tag === "attributes") {
        const d = _xChildText(node, "divisions"); if (d) divisions = parseInt(d, 10) || divisions;
        const t = _xFirst(node, "time"); if (t) { const bt = _xChildText(t, "beat-type"); if (bt) beatType = parseInt(bt, 10) || beatType; }
        const sts = _xEls(node, "staff-tuning"); if (sts.length) { const tu = _parseTuning(sts); if (tu) tuning = tu; }
      } else if (tag === "note") {
        if (_xFirst(node, "grace")) continue;
        const dur = parseInt(_xChildText(node, "duration") || "0", 10) || 0;
        const isChord = !!_xFirst(node, "chord");
        const onset = isChord ? lastOnset : cursor;
        if (!isChord) { lastOnset = cursor; cursor += dur; }
        if (_xFirst(node, "rest") || _xChildText(node, "notehead").toLowerCase() === "slash") continue;
        let midi = null; const pe = _xFirst(node, "pitch"); if (pe) midi = _pitchToMidi(pe);
        if (midi == null) { const tech = _xFirst(node, "technical"); if (tech) { const sNum = parseInt(_xChildText(tech, "string"), 10), f = parseInt(_xChildText(tech, "fret"), 10); const open = (tuning || TUNINGS.Standard)[6 - sNum]; if (!isNaN(f) && open != null) midi = open + f; } }
        if (midi == null) continue;
        const dpb = (divisions * 4) / beatType || divisions;
        out.push({ midi, q: onset / dpb, d: dur / dpb });
      } else if (tag === "backup") cursor -= parseInt(_xChildText(node, "duration") || "0", 10) || 0;
      else if (tag === "forward") cursor += parseInt(_xChildText(node, "duration") || "0", 10) || 0;
    }
    return out;
  });
}

/* ===========================================================================
 *  Standard MIDI File import (`parseMidiFile`, 2026-10-25)
 *  --------------------------------------------------------------------------
 *  Zero-dependency SMF reader (format 0/1; running status; sysex skipped) →
 *  the shared score shape, one PART per track (a format-0 file is split by
 *  channel; channel 10 is the drum kit and carries no pitched events, like an
 *  unpitched MusicXML staff). Bars are cut in TICKS from the time-signature
 *  metas (4/4 when none — Muscriptor writes no meter when it can't tell), so a
 *  tempo map can never misplace a bar line; `tempo` is the first tempo meta.
 *  Notes starting within 1/24 beat of each other are one onset; a note held
 *  across a bar line sounds again at the next bar's downbeat (MusicXML would
 *  write it there as a tied note). Built for Muscriptor's `score.mid`, which
 *  is already shifted so bar 1 starts at tick 0.
 * ==========================================================================*/
function _readSmf(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (u8.length < 14 || str(0, 4) !== "MThd") throw new Error("Not a MIDI file (no MThd header).");
  const hlen = dv.getUint32(4), format = dv.getUint16(8), ntrk = dv.getUint16(10), div = dv.getUint16(12);
  const ppq = div & 0x8000 ? 480 : (div || 480);
  const tracks = [], metas = { tempo: [], timeSig: [], keySig: [] };
  let p = 8 + hlen;
  for (let t = 0; t < ntrk && p + 8 <= u8.length; t++) {
    if (str(p, 4) !== "MTrk") break;
    const len = dv.getUint32(p + 4), end = Math.min(u8.length, p + 8 + len);
    let q = p + 8, tick = 0, status = 0, name = "";
    const notes = [], open = new Map(), programs = {};
    const vlq = () => { let v = 0, b; do { b = u8[q++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && q < end); return v; };
    while (q < end) {
      tick += vlq();
      let st = u8[q];
      if (st & 0x80) { q++; if (st < 0xf0) status = st; } else st = status;
      if (st === 0xff) {
        const type = u8[q++], n = vlq(), d = u8.subarray(q, q + n); q += n;
        if (type === 0x03 && !name) name = new TextDecoder("latin1").decode(d).trim();
        else if (type === 0x51 && n === 3) metas.tempo.push({ tick, usq: (d[0] << 16) | (d[1] << 8) | d[2] });
        else if (type === 0x58 && n >= 2) metas.timeSig.push({ tick, num: d[0], den: 1 << d[1] });
        else if (type === 0x59 && n >= 2) metas.keySig.push({ tick, sf: (d[0] << 24) >> 24, minor: d[1] === 1 });
        else if (type === 0x2f) break;
      } else if (st === 0xf0 || st === 0xf7) { q += vlq(); }
      else {
        const kind = st & 0xf0, ch = st & 0x0f, a = u8[q++], b = kind === 0xc0 || kind === 0xd0 ? 0 : u8[q++];
        if (kind === 0x90 && b > 0) { const k = ch * 128 + a; if (!open.has(k)) open.set(k, []); open.get(k).push(notes.length); notes.push({ ch, midi: a, start: tick, end: null }); }
        else if (kind === 0x80 || (kind === 0x90 && b === 0)) { const st2 = open.get(ch * 128 + a); if (st2 && st2.length) notes[st2.shift()].end = tick; }
        else if (kind === 0xc0) { if (programs[ch] == null) programs[ch] = a; }
      }
    }
    notes.forEach((n) => { if (n.end == null || n.end <= n.start) n.end = n.start + ppq / 4; });
    tracks.push({ name, notes, programs });
    p = 8 + p + len;
  }
  return { format, ppq, tracks, metas };
}
function parseMidiFile(bytes, useSharp = true, partIndex = 0) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const smf = _readSmf(u8);
  // parts: one per track with notes; a track holding several channels (format 0) splits by channel
  const partDefs = [];
  smf.tracks.forEach((tr, ti) => {
    const chans = [...new Set(tr.notes.map((n) => n.ch))].sort((a, b) => a - b);
    chans.forEach((ch) => {
      const drum = ch === 9;
      const base = tr.name || (drum ? "Drums" : `Track ${ti + 1}`);
      partDefs.push({ name: chans.length > 1 ? `${base} (ch ${ch + 1})` : base, notes: tr.notes.filter((n) => n.ch === ch), drum });
    });
  });
  if (!partDefs.length) throw new Error("This MIDI file has no notes.");
  const parts = partDefs.map((d, i) => ({ index: i, id: `T${i + 1}`, name: d.drum && !/drum|perc|kit/i.test(d.name) ? `${d.name} (drums)` : d.name }));
  const ppq = smf.ppq;
  // bar grid from the meter metas (ticks), 4/4 by default
  const sigs = smf.metas.timeSig.slice().sort((a, b) => a.tick - b.tick);
  const lastTick = Math.max(...partDefs.flatMap((d) => d.notes.map((n) => n.end)), 1);
  const barStarts = [];
  let t = 0, cur = { num: 4, den: 4 }, si = 0;
  while (t < lastTick && barStarts.length < 4000) {
    while (si < sigs.length && sigs[si].tick <= t) cur = sigs[si++];
    const len = Math.max(1, Math.round((cur.num * ppq * 4) / cur.den));
    barStarts.push({ tick: t, num: cur.num, den: cur.den, len });
    t += len;
  }
  const tol = ppq / 24;
  // every part's notes clipped to each bar, in beats with their real lengths (for HARMONY_PART)
  const barNotes = (def) => barStarts.map((bs) => {
    const tpb = (ppq * 4) / bs.den, endT = bs.tick + bs.len;
    return def.drum ? [] : def.notes.filter((n) => n.start < endT && n.end > bs.tick)
      .map((n) => { const a = Math.max(n.start, bs.tick); return { midi: n.midi, q: (a - bs.tick) / tpb, d: (Math.min(n.end, endT) - a) / tpb }; });
  });
  const tm = smf.metas.tempo.slice().sort((a, b) => a.tick - b.tick)[0];
  const tempo = tm ? Math.round(600000000 / tm.usq) / 10 : null;
  if (partIndex === HARMONY_PART) {
    const notesByPart = partDefs.map(barNotes);
    const keep = harmonyPartIndices(parts, notesByPart);
    const meta = barStarts.map((bs, bi) => ({ number: bi + 1, timeSig: [bs.num, bs.den], repeatStart: false, repeatEnd: false, ending: null, events: [] }));
    return { source: "midi", timeSig: meta.length ? meta[0].timeSig : [4, 4], tuning: _tuningName(null), tuningMidi: null, tempo, parts,
      ...mergePartNotes(meta, keep.map((i) => notesByPart[i]), useSharp, { names: keep.map((i) => parts[i].name) }) };
  }
  const idx = Math.max(0, Math.min(partDefs.length - 1, partIndex | 0));
  const def = partDefs[idx];
  const notes = def.drum ? [] : def.notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
  const bars = barStarts.map((bs, bi) => {
    const tpb = (ppq * 4) / bs.den, endT = bs.tick + bs.len;
    const groups = [];
    const held = notes.filter((n) => n.start < bs.tick && n.end > bs.tick + tol);
    if (held.length) groups.push({ tick: bs.tick, midis: held.map((n) => n.midi) });
    for (const n of notes) {
      if (n.start < bs.tick || n.start >= endT) continue;
      const g = groups[groups.length - 1];
      if (g && n.start - g.tick <= tol) g.midis.push(n.midi); else groups.push({ tick: n.start, midis: [n.midi] });
    }
    const raw = groups.map((g) => { const midis = [...new Set(g.midis)].sort((a, b) => a - b); return { symbol: symbolForMidis(midis, useSharp), midis, frets: {}, tuplet: 0, qbeat: (g.tick - bs.tick) / tpb }; });
    const events = [];
    raw.forEach((e) => { const last = events[events.length - 1]; if (!last || last.symbol !== e.symbol) events.push(e); });
    events.forEach((e) => { e.beat = Math.max(0, Math.min(bs.num - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < events.length; i++) if (events[i].beat <= events[i - 1].beat) events[i].beat = Math.min(bs.num - 1, events[i - 1].beat + 1);
    events.forEach((e, i) => { e.durBeats = (i + 1 < events.length ? events[i + 1].beat : bs.num) - e.beat; });
    _fillTrueDur(events, bs.num);
    return { number: bi + 1, timeSig: [bs.num, bs.den], repeatStart: false, repeatEnd: false, ending: null, events };
  });
  return { source: "midi", timeSig: bars.length ? bars[0].timeSig : [4, 4], tuning: _tuningName(null), tuningMidi: null, tempo, bars, parts, partIndex: idx };
}

/* ---- generic ZIP reading (a Muscriptor sheets zip, or any zip of a score) ----
 * Same central-directory walk as gpUnzip (which stays as it is for .gp), but
 * listing every entry so the dispatcher can pick score.gpif / MusicXML / MIDI. */
function _zipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  for (let i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error("Not a zip file (no ZIP directory).");
  const cdOff = dv.getUint32(eo + 16, true), cdCount = dv.getUint16(eo + 10, true), out = [];
  let p = cdOff;
  for (let n = 0; n < cdCount && p + 46 <= u8.length && dv.getUint32(p, true) === 0x02014b50; n++) {
    const method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    out.push({ name: new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)), method, compSize, lhOff: dv.getUint32(p + 42, true) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
async function _zipRead(u8, entry) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), lh = entry.lhOff;
  if (dv.getUint32(lh, true) !== 0x04034b50) throw new Error("Corrupt zip (bad local header).");
  const dataStart = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
  const comp = u8.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return comp.slice();
  if (entry.method !== 8) throw new Error(`Unsupported zip compression (method ${entry.method}).`);
  const stream = new Response(comp).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/* A zip that is not a .gp: Muscriptor's `<song>_sheets.zip` (score.musicxml + score.mid +
 * PDFs), a compressed MusicXML (.mxl: META-INF/container.xml names the score), or any zip
 * holding one score. MusicXML wins over MIDI (it carries the engraved, quantised rhythm and
 * the meter); with several parts and no part asked for, it lands on HARMONY_PART. */
async function parseScoreZip(u8, useSharp = true, partIndex) {
  const entries = _zipEntries(u8).filter((e) => !e.name.endsWith("/") && !/(^|\/)__MACOSX\//.test(e.name));
  const base = (e) => e.name.split("/").pop().toLowerCase();
  let pick = null;
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  if (container) {
    const m = new TextDecoder().decode(await _zipRead(u8, container)).match(/full-path="([^"]+)"/);
    if (m) pick = entries.find((e) => e.name === m[1]) || null;
  }
  pick = pick || entries.find((e) => base(e) === "score.musicxml")
    || entries.find((e) => /\.(musicxml|xml)$/.test(base(e)) && !e.name.startsWith("META-INF/"));
  if (pick) {
    const xml = new TextDecoder("utf-8").decode(await _zipRead(u8, pick));
    let sc = parseMusicXML(xml, useSharp, partIndex == null ? 0 : partIndex);
    if (partIndex == null && sc.parts.length > 1) sc = parseMusicXML(xml, useSharp, HARMONY_PART);
    sc._xml = xml; return sc;
  }
  const mid = entries.find((e) => base(e) === "score.mid") || entries.find((e) => /\.midi?$/.test(base(e)));
  if (mid) {
    const mb = await _zipRead(u8, mid);
    let sc = parseMidiFile(mb, useSharp, partIndex == null ? 0 : partIndex);
    if (partIndex == null && sc.parts.length > 1) sc = parseMidiFile(mb, useSharp, HARMONY_PART);
    sc._midbuf = mb; return sc;
  }
  throw new Error("This zip holds no score (no score.gpif, MusicXML or MIDI file inside).");
}

/* `partIndex` omitted → part 0, except a zip of a non-GP score or a MIDI file with several
 * parts, which lands on HARMONY_PART (every pitched part read together). */
async function parseGuitarProOrXML(buf, fileName, useSharp = true, partIndexArg) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const partIndex = partIndexArg == null ? 0 : partIndexArg;
  const head = new TextDecoder("latin1").decode(u8.subarray(0, 32));
  if (u8[0] === 0x50 && u8[1] === 0x4b) {
    if (!_zipEntries(u8).some((e) => e.name.endsWith("score.gpif"))) return parseScoreZip(u8, useSharp, partIndexArg);  // Muscriptor sheets / .mxl / zipped score
    const xml = await gpUnzip(u8); const sc = parseGPIF(xml, useSharp, partIndex); sc._xml = xml; return sc;             // GP7/8
  }
  if (head.startsWith("MThd")) { let sc = parseMidiFile(u8, useSharp, partIndex); if (partIndexArg == null && sc.parts.length > 1) sc = parseMidiFile(u8, useSharp, HARMONY_PART); sc._midbuf = u8; return sc; } // Standard MIDI File
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
  const parts = String(symbol).split("/");
  const mm = parts[0].match(/^([A-G][#b♯♭]?)(.*)$/);
  if (!mm) return { pc: null };
  const root = mm[1].replace("♯", "#").replace("♭", "b");
  const pc = _PC_BY_NAME[root];
  if (pc === undefined) return { pc: null };
  /* The SLASH BASS is a real functional cue — the sounding bass note is what tells a
   * player (and the key analysis) where a chord points; `Eb6/9/F` in a B♭ tune is an
   * F13sus by another name, i.e. the dominant. It is carried alongside (never instead
   * of) the root: `bassPc` is null for a root-position chord, and "sus2"/"sus4" are
   * suffixes, not slashes, so only a trailing NOTE name counts. */
  let bassPc = null;
  if (parts.length > 1) {
    const bm = parts[parts.length - 1].match(/^([A-G][#b♯♭]?)$/);
    if (bm) { const b = _PC_BY_NAME[bm[1].replace("♯", "#").replace("♭", "b")]; if (b !== undefined && b !== pc) bassPc = b; }
  }
  return { pc, bassPc, suffix: mm[2], cls: _classOf(mm[2]) };
}
/* Quality compatibility at a scale degree: does the chord's third/fifth match what the
 * key builds on that degree? (power/sus chords have no third → they fit either.) */
function qualCompatible(mode, rel, cls) {
  const exp = (mode === "major" ? _MAJ_Q : _MIN_Q)[rel];
  if (exp === undefined) return false;
  if (cls === "power" || cls === "sus") return true;          // no 3rd → fits either
  if (exp === "maj") return cls === "maj" || cls === "dom";
  if (exp === "min") return cls === "min" || (mode === "minor" && rel === 7 && (cls === "maj" || cls === "dom")); // harmonic V
  if (exp === "dim") return cls === "dim";
  return false;
}
/* ---- key model v2: harmonic FUNCTION weights, not scale membership --------
 * v1 scored a key as "how much duration is diatonic to it". That is degenerate for
 * relative keys (they share a scale, so only the small cadence bonus separated them)
 * and blind to which chord is actually HOME. Two real defects fell out of it:
 *   · "Can't You See" (D · C · G, ♭VII rock) read **E minor** — a key whose tonic
 *     chord is never played — because C is diatonic to Em but only borrowed in D.
 *   · A G-mixolydian vamp (G · F · C) read **C major** for the same reason.
 * v2 replaces the flat 1.0-if-diatonic with three musically-motivated terms:
 *   1. DEGREE WEIGHTS by function — I ≫ V/IV ≫ ii/vi ≫ iii ≫ vii° — so a key wins on
 *      the STRENGTH of the functions its chords fill, not on set membership.
 *   2. A BORROWED table — ♭VII/♭III/♭VI in major (mixolydian/aeolian borrowings that
 *      are ubiquitous in rock) and the dorian ♮6 in minor score well above a random
 *      chromatic chord; a diatonic root with the WRONG quality (a secondary dominant,
 *      D7 in C) keeps a fraction of its degree weight instead of a flat 0.3.
 *   3. TONIC PRESENCE — a key whose tonic triad is never stated takes a haircut, and a
 *      tonic at a phrase boundary (first / last chord) scores a bonus. That is the
 *      "where does it come home" cue, and it is what separates D major from G major
 *      on the very same three chords.
 * Weights are ≤ 1.0 and the result is normalised by total duration, so `confidence`
 * stays a 0..1 read (the audio decoder's key-prior gate reads it at 0.5).
 * ------------------------------------------------------------------------- */
const _KW_MAJ = { 0: 1.00, 2: 0.62, 4: 0.48, 5: 0.80, 7: 0.86, 9: 0.62, 11: 0.36 };
const _KW_MIN = { 0: 1.00, 2: 0.36, 3: 0.62, 5: 0.80, 7: 0.72, 8: 0.62, 10: 0.62, 11: 0.36 };
const _KB_MAJ = { 10: 0.52, 3: 0.34, 8: 0.34 };   // ♭VII (mixolydian) · ♭III · ♭VI
const _KB_MIN = { 9: 0.22 };                       // dorian ♮6
const _K_CHROMATIC = 0.06;                         // anything else — a passing/chromatic chord
const _K_NO_TONIC = 0.80;                          // haircut when the tonic triad never sounds
const _K_BASS = 0.20;                               // an inversion's bass note, as a minority vote
const _K_LAST = 0.10, _K_FIRST = 0.06;             // phrase-boundary tonic bonuses (× total)
/* Weight one chord against one candidate key. Split out so it is testable and so
 * `analyzeKeyCandidates` and `analyzeKey` can never drift apart. */
function _keyChordWeight(mode, rel, cls) {
  const dia = (mode === "major" ? _KW_MAJ : _KW_MIN)[rel];
  if (dia !== undefined) {
    if (qualCompatible(mode, rel, cls)) {
      // a DOMINANT on the 5th degree is the single clearest key signature there is
      return rel === 7 && cls === "dom" ? Math.min(1, dia + 0.06) : dia;
    }
    // diatonic root, wrong quality: a secondary dominant (V/x) keeps more than a
    // modal-mixture swap, because it still points at a diatonic target.
    return dia * (cls === "dom" ? 0.50 : 0.38);
  }
  const bor = (mode === "major" ? _KB_MAJ : _KB_MIN)[rel];
  if (bor === undefined) return _K_CHROMATIC;
  // the borrowing is the MAJOR chord on that degree (♭VII, ♭III, ♭VI); a minor or
  // diminished chord there is a chromatic passing sonority, not the idiom.
  return cls === "maj" || cls === "dom" || cls === "power" || cls === "sus" ? bor : bor * 0.5;
}
/* Every candidate key, scored + ranked. The UI's key picker shows the runners-up so a
 * user correcting a call can see what the analysis actually weighed (and pick the
 * relative major/minor in one tap). `analyzeKey` is just the top of this list. */
function analyzeKeyCandidates(score, opts = {}) {
  const parsed = [];
  for (const b of (score && score.bars) || []) for (const e of b.events || []) {
    const p = _parseSym(e.symbol);
    if (p.pc != null) parsed.push({ ...p, dur: Math.max(0.5, e.durBeats || 1) });
  }
  if (!parsed.length) return [];
  const total = parsed.reduce((s, p) => s + p.dur, 0) || 1;
  const firstC = parsed[0], lastC = parsed[parsed.length - 1];
  const out = [];
  for (let tonic = 0; tonic < 12; tonic++) for (const mode of ["major", "minor"]) {
    let sc = 0, tonicDur = 0;
    for (const p of parsed) {
      const rel = (p.pc - tonic + 12) % 12;
      let w = _keyChordWeight(mode, rel, p.cls);
      // an inversion's bass gets a minority vote at its own degree (quality-agnostic —
      // a bass note has no third), blended so the total normalisation is unchanged.
      if (p.bassPc != null) w = (1 - _K_BASS) * w + _K_BASS * _keyChordWeight(mode, (p.bassPc - tonic + 12) % 12, "power");
      sc += p.dur * w;
      if (rel === 0 && qualCompatible(mode, 0, p.cls)) tonicDur += p.dur;
    }
    if (!tonicDur) sc *= _K_NO_TONIC;                                   // never comes home → unlikely
    if (lastC.pc === tonic && qualCompatible(mode, 0, lastC.cls)) sc += total * _K_LAST;
    if (firstC.pc === tonic && qualCompatible(mode, 0, firstC.cls)) sc += total * _K_FIRST;
    out.push({ tonic, mode, confidence: Math.max(0, Math.min(1, sc / total)), score: sc, tonicShare: tonicDur / total });
  }
  out.sort((a, b) => b.score - a.score || a.tonic - b.tonic);
  const n = opts.limit != null ? opts.limit : out.length;
  return out.slice(0, Math.max(1, n));
}
function analyzeKey(score) {
  const c = analyzeKeyCandidates(score, { limit: 1 })[0];
  return c ? { tonic: c.tonic, mode: c.mode, confidence: c.confidence } : null;
}
/* The 24 keys as pickable names (family-default spelling), and the parser the manual
 * key override uses. Accepts "D", "Dm", "F#m", "Bbm", "Eb major", "c minor" — so a
 * pasted/typed key from anywhere resolves to the same { tonic, mode } the analysis
 * produces, and every exporter (ABC `K:`, ChordPro `{key:}`, CSMPN/CSML `Key:`) gets
 * the corrected key for free. */
const KEY_CHOICES = (() => {
  const out = [];
  for (const mode of ["major", "minor"]) for (let t = 0; t < 12; t++) out.push({ tonic: t, mode, name: NOTE_SHARP[t] + (mode === "minor" ? "m" : "") });
  return out;
})();
function parseKeyName(name) {
  if (!name) return null;
  if (typeof name === "object") return name.tonic != null ? { tonic: ((name.tonic % 12) + 12) % 12, mode: name.mode === "minor" ? "minor" : "major" } : null;
  const s = String(name).trim();
  const m = s.match(/^([A-Ga-g])([#b♯♭]?)\s*(.*)$/);
  if (!m) return null;
  const pc = _PC_BY_NAME[m[1].toUpperCase() + m[2].replace("♯", "#").replace("♭", "b")];
  if (pc === undefined) return null;
  const rest = m[3].toLowerCase().replace(/[\s.]/g, "");
  const minor = rest === "m" || rest === "min" || rest === "minor" || rest === "-";
  if (rest && !minor && rest !== "maj" && rest !== "major") return null;   // "Dsus4" is a chord, not a key
  return { tonic: pc, mode: minor ? "minor" : "major" };
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
  // `opts.key` lets a MANUALLY corrected key (the UI's key picker) drive the
  // description + its tags, instead of the summary contradicting the chart header.
  const key = opts.key || analyzeKey(score);
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

/* ---- Lyrics / ChordPro → clean lyrics-only sheet ---------------------------
 * A pure text transform (NO score, NO DOM): take a "chords-over-lyrics" tab or a
 * ChordPro file — the two things ultimate-guitar.com et al. hand out — and return
 * the LYRICS ONLY, arranged into titled sections and stanzas: a printable lyric
 * sheet like a hymnal page. It is the inverse of an authoring tool — strip the
 * chords, keep the words and the song's structure.
 *
 * Two input dialects, auto-detected LINE BY LINE (a file may even mix them):
 *   - ChordPro           — chords inline in [brackets]; {directives} for title /
 *                          sections; {sot}…{eot} tab blocks (skipped, not lyrics).
 *   - Chords-over-lyrics — a monospace chord LINE sitting above each lyric line;
 *                          `[Verse]`-style section headers.
 *
 * The load-bearing decision is chord-vs-word disambiguation. `_parseSym` is too
 * loose for this (its suffix is `.*`, so it treats the word "Cab" as C+"ab"), so
 * we use a STRICT chord matcher (`_CHORD_RE`, a tight suffix alphabet) and then
 * classify at LINE level: a line is a chord line only when EVERY token is a chord
 * or a repeat/barline marker — so a single ordinary word protects the whole lyric
 * line. Ambiguity note: a lone `[A]`/`[B]` is both a valid chord and a possible
 * sub-section label; we resolve it toward CHORD (drop it). The standard section
 * vocabulary (`[Verse]`, `{soc}`, "Chorus:") is recognised robustly instead.
 *
 * Everything here is pure + headless-testable; the LyricsCapture UI renders the
 * returned structure (centered/underlined section headers, stanza spacing). */

// Strict chord-symbol matcher — root + a suffix built ONLY from real chord-quality
// tokens, optional /bass. The tight suffix alphabet is what stops lyric words
// (Add, Cab, Bad, Fed, Gem, Bee…) reading as chords; line-level classification
// (below) then needs ALL tokens to be chords, so one plain word saves the line.
const _CHORD_RE = /^[A-G][#b♯♭]?(?:maj|min|sus|add|aug|dim|m|M|Δ|ø|°|\+|-|\d|[#b♯♭]|\(|\))*(?:\/[A-G][#b♯♭]?)?$/;
// Tokens allowed to ride ON a chord line without disqualifying it (repeat counts,
// barlines, no-chord) — so "C G Am (x2) |" is still recognised as a chord line.
const _CHORD_LINE_MARK = /^(?:x\d+|\d+x|\(x?\d+x?\)|N\.?C\.?|\||\|\||:\||\|:|:|-|–|—|%|\*|>|\.)$/i;

function isChordToken(tok) {
  if (tok == null) return false;
  const t = String(tok).trim();
  return t !== "" && _CHORD_RE.test(t);
}
// The content of a whole-line bracket is "just chords" (drop it) when every part is
// a chord — including a compound/sequence beat written `G_C` (CSMPN `_`-join) or a
// space-separated run `[C Em Bb F]`. This is what stops a lone `[G_C]` beat being
// mistaken for a section label, while `[Verse A]` (a real word) still isn't chords.
function isChordBracket(inner) {
  const parts = String(inner == null ? "" : inner).trim().split(/[_\s]+/).filter(Boolean);
  return parts.length > 0 && parts.every(isChordToken);
}
// A whole line is a CHORD LINE (drop it) only when it is non-blank and every token
// is a chord or an allowed marker, with at least one real chord present.
function isChordLine(line) {
  if (line == null) return false;
  const s = String(line).trim();
  if (!s) return false;
  const toks = s.split(/\s+/);
  let chords = 0;
  for (const tk of toks) {
    if (isChordToken(tk)) { chords++; continue; }
    if (_CHORD_LINE_MARK.test(tk)) continue;
    return false;                               // a real word → this is a lyric line
  }
  return chords >= 1;
}
// Remove inline [chord] tags from a ChordPro lyric line and close the gap the tag
// left behind (so "There's a [C]bright  [G]haze" → "There's a bright haze").
function stripInlineChords(line) {
  return String(line == null ? "" : line)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

const _SECTION_KEYWORDS = /^(?:intro|verse|pre[\s-]*chorus|chorus|refrain|hook|bridge|interlude|instrumental|solo|outro|ending|coda|tag|vamp|breakdown)\b/i;
const _trimEdges = (s) => String(s == null ? "" : s).replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
// Normalise a section label: drop wrapping brackets/colons, collapse spaces, and
// expand the most common shorthand (v2 → Verse 2, Ch → Chorus, Br → Bridge).
function _cleanLabel(raw) {
  let s = String(raw == null ? "" : raw).replace(/^[\[({<]+/, "").replace(/[\])}>:：]+\s*$/, "").replace(/\s+/g, " ").trim();
  let m;
  if ((m = s.match(/^(?:v|vs)\s*\.?\s*(\d+)?$/i))) return "Verse" + (m[1] ? " " + m[1] : "");
  if ((m = s.match(/^(?:ch|cho)\s*\.?\s*(\d+)?$/i))) return "Chorus" + (m[1] ? " " + m[1] : "");
  if ((m = s.match(/^br\s*\.?\s*(\d+)?$/i))) return "Bridge" + (m[1] ? " " + m[1] : "");
  return s;
}
// A short bare line that names a known section ("Chorus", "Verse 2", "Bridge:") —
// keyword-gated so shouted all-caps LYRICS (e.g. "STOP!") never become headers.
function _isBareSectionLabel(trimmed) {
  const t = String(trimmed == null ? "" : trimmed).replace(/[:：]\s*$/, "").trim();
  if (!t || t.split(/\s+/).length > 4) return false;
  if (isChordLine(t)) return false;                          // don't swallow a chord line
  return _SECTION_KEYWORDS.test(t);
}

// The parser. Returns { title, subtitle, sections:[{label, blocks:[[line…]]}], plain }.
function parseLyrics(text, opts = {}) {
  const meta = { title: null, subtitle: null };
  const sections = [];
  let cur = null, stanza = [], inTab = false;
  const mk = (label) => { const s = { label: label || null, blocks: [] }; sections.push(s); return s; };
  const flushStanza = () => { if (stanza.length) { if (!cur) cur = mk(null); cur.blocks.push(stanza); stanza = []; } };
  const newSection = (label) => {
    flushStanza();
    if (cur && cur.label == null && cur.blocks.length === 0) cur.label = _cleanLabel(label);
    else cur = mk(_cleanLabel(label));
  };

  const rawLines = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  for (const raw of rawLines) {
    const line = raw.replace(/\t/g, "    ");
    const trimmed = line.trim();

    // ChordPro directive line: {name} or {name: value}
    const dir = trimmed.match(/^\{\s*([a-zA-Z_][\w-]*)\s*(?::\s*([\s\S]*?))?\s*\}$/);
    if (dir) {
      const name = dir[1].toLowerCase(), val = (dir[2] || "").trim();
      if (name === "sot" || name === "start_of_tab") inTab = true;
      else if (name === "eot" || name === "end_of_tab") inTab = false;
      else if (name === "title" || name === "t") { if (!meta.title) meta.title = val; }
      else if (name === "subtitle" || name === "st" || name === "artist" || name === "composer") { if (!meta.subtitle) meta.subtitle = val; }
      else if (name === "comment" || name === "c" || name === "ci" || name === "comment_italic" || name === "comment_box" || name === "cb") {
        // {comment}/{c:} is ambiguous in ChordPro: a SHORT section keyword ("Verse 1",
        // "Chorus") is a header, but everything else is CONTENT — and a chord-free song
        // (or an exporter that keeps chords on their own lines) stores its LYRICS here.
        // So: keyword-shaped → section label; otherwise → a lyric line. This is what
        // makes a "lyrics live in {comment}" file (chords on [bracket] lines, words in
        // comments) read as words, not as a pile of empty section headers.
        if (val) { if (_isBareSectionLabel(val)) newSection(val); else stanza.push(_trimEdges(val)); }
      }
      else if (name === "sov" || name === "start_of_verse") newSection(val || "Verse");
      else if (name === "soc" || name === "start_of_chorus") newSection(val || "Chorus");
      else if (name === "sob" || name === "start_of_bridge") newSection(val || "Bridge");
      // start_of_part/eov/eoc/eob/define/key/tempo/… → not lyrics, ignored
      continue;
    }
    if (inTab) continue;                          // ASCII-tab block content is not lyrics

    if (!trimmed) { flushStanza(); continue; }    // blank line → stanza break

    // whole-line bracket: a section header [Verse 1] — but a lone [chord] is dropped
    const brk = trimmed.match(/^\[([^\]]+)\]$/);
    if (brk) {
      const inner = brk[1].trim();
      if (!isChordBracket(inner)) newSection(inner);      // a lone [chord]/[G_C] beat is dropped; [Verse A] is a label
      continue;
    }
    // ChordPro lyric line with inline [chord] tags → strip them, keep the words
    if (/\[[^\]]*\]/.test(line)) {
      const lyric = _trimEdges(stripInlineChords(line));
      if (lyric) stanza.push(lyric);
      continue;
    }
    if (isChordLine(line)) continue;              // chords-over-lyrics chord line → drop
    if (_isBareSectionLabel(trimmed)) { newSection(trimmed); continue; }
    stanza.push(_trimEdges(line));                // a lyric line
  }
  flushStanza();

  const kept = sections.filter((s) => s.blocks.some((b) => b.length));
  const parsed = { title: meta.title || null, subtitle: meta.subtitle || null, sections: kept };
  parsed.plain = lyricsToText(parsed);
  return parsed;
}

// Render a parsed lyric structure to a clean plain-text sheet: optional title,
// UPPERCASE section headers, a blank line between stanzas and between sections.
function lyricsToText(parsed) {
  const out = [];
  if (parsed.title) { out.push(parsed.title); out.push(""); }
  (parsed.sections || []).forEach((sec, si) => {
    if (sec.label) out.push(sec.label.toUpperCase());
    (sec.blocks || []).forEach((blk, bi) => {
      if (bi > 0) out.push("");
      blk.forEach((l) => out.push(l));
    });
    if (si < parsed.sections.length - 1) out.push("");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
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
/* Chord-symbol text for an ABC "..." annotation: ASCII accidentals, no quotes, and the
 * engine's no-chord placeholder "—" as the conventional N.C. */
const _abcChordName = (s) => { const t = String(s == null ? "" : s).replace(/♭/g, "b").replace(/♯/g, "#").replace(/"/g, "").trim(); return !t || t === "—" ? "N.C." : t; };
/* ABC 2.1 FILE HEADER (abc standard v2.1, §2.1–2.2): the file identification line
 * `%abc-2.1` must be the first line (so readers interpret the file strictly by 2.1,
 * and it is the "%abc" magic that identifies the file as ABC *music notation* — not
 * the unrelated Alembic 3D `.abc` format), then file-header fields, then an EMPTY
 * line before the first tune's `X:`. The charset is declared explicitly even though
 * utf-8 is the 2.1 default, because the text (titles, part names such as "B♭
 * Trumpet") may be non-ASCII and older readers default to Latin-1. */
const ABC_MIME = "text/vnd.abc";                                // IANA-registered ABC media type
function _abcFileHeader() {
  return ["%abc-2.1", "I:abc-charset utf-8", "% Generated by Tab Translator Pro", ""];
}
/* The K: value for a key, spelled by the SAME speller that writes the notes, so the
 * key signature ABC derives from K: always matches the accidental bookkeeping (the
 * family-default names "Ebm"/"Abm" have 6/7 flats in ABC, while the notes are spelled
 * against D#m/G#m's 6/5 sharps — mixing the two produced wrong pitches). */
function _abcKeyName(key) {
  if (!key || typeof key.tonic !== "number") return "C";
  const p = _keySpeller(key)(60 + (((key.tonic % 12) + 12) % 12));
  return p.step + (p.alter === 1 ? "#" : p.alter === -1 ? "b" : "") + (key.mode === "minor" ? "m" : "");
}
function scoreToABC(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b0, bt0] = score.timeSig;
  const key = opts.key && typeof opts.key.tonic === "number" ? opts.key : null;
  const out = [..._abcFileHeader(), "X:1", `T:${opts.title || "Tab Decoder chart"}`, `M:${b0}/${bt0}`, "L:1/4"];
  if (opts.tempo) out.push(`Q:1/4=${Math.round(opts.tempo)}`);
  out.push(`K:${_abcKeyName(key)}`);
  /* Pitches are written RELATIVE TO K: with per-bar accidental carry (ABC semantics:
   * an unmarked note takes the key signature, an accidental holds to the end of the
   * bar for that pitch). The old writer emitted K:-blind sharps, so in K:E a G-natural
   * printed as "G" sounded G#, and "^C ... C" in one bar sounded C# twice. */
  const spell = key ? _keySpeller(key) : _keySpeller(null, opts.useSharp !== false);
  const acc = _abcAccidentalTracker(key);
  let curSig = `${b0}/${bt0}`, body = "";
  score.bars.forEach((bar, bi) => {
    const [bb, bt] = bar.timeSig || score.timeSig;
    const sig = `${bb}/${bt}`;
    let cell = "";
    acc.newBar();
    if (sig !== curSig) { cell += `[M:${sig}]`; curSig = sig; }
    bar.events.forEach((e) => {
      const dur = abcDur(e.qdur != null ? e.qdur : e.durBeats, bt); // TRUE duration (never 0)
      const inner = e.midis && e.midis.length ? `[${e.midis.map((m) => _abcPitch(spell(m), acc)).join("")}]${dur}` : `z${dur}`;
      cell += `"${_abcChordName(_ovSym(bar, e, ov))}"${inner} `;
    });
    body += cell.trim() + " |";
    body += (bi + 1) % 4 === 0 ? "\n" : " ";
  });
  out.push(body.trim());
  return out.join("\n") + "\n";
}
/* The key as exporters write it: spelled for itself when the chart's chords are (opts.spellKey —
 * "Db", not "C#", for a 5-flat key), else the ♯/♭ table as before. */
function _exportKeyName(opts) {
  if (!opts.key) return null;
  return opts.spellKey ? keyNameForKey(opts.key) : keyName(opts.key, opts.useSharp !== false);
}
function scoreToChordPro(score, opts = {}) {
  const ov = opts.overrides || {};
  const [b, bt] = score.timeSig;
  const out = [`{title: ${opts.title || "Tab Decoder chart"}}`, `{time: ${b}/${bt}}`];
  if (opts.key) out.push(`{key: ${_exportKeyName(opts)}}`);
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
  const kn = _exportKeyName(opts);
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
  const kn = _exportKeyName(opts);
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
/* MusicXML divisions are per QUARTER note. Keep ordinary charts at four, but
 * increase the resolution when true onsets/durations include tuplets or other
 * fractions; the displayed integer beat grid must never determine playback. */
function _xmlDivisions(score) {
  let div = 4;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  for (const bar of score.bars || []) {
    const bt = (bar.timeSig || score.timeSig || [4, 4])[1];
    for (const e of bar.events || []) {
      for (const beat of [e.qbeat != null ? e.qbeat : e.beat, e.qdur != null ? e.qdur : e.durBeats]) {
        const q = beat * 4 / bt;
        if (!Number.isFinite(q)) continue;
        let den = 1;
        while (den <= 96 && Math.abs(q * den - Math.round(q * den)) > 1e-7) den++;
        if (den > 96) { div = Math.max(div, 480); continue; } // PDF-derived free timing
        const next = div / gcd(div, den) * den;
        div = next <= 10080 ? next : 10080;
      }
    }
  }
  return div;
}
function scoreToMusicXML(score, opts = {}) {
  const ov = opts.overrides || {}, useSharp = opts.useSharp !== false, div = _xmlDivisions(score);
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
    /* Section label → a rehearsal mark, so structure survives the round trip:
     * `parseMusicXML` already READS <rehearsal> into bar.section, and this is the
     * matching write. MuseScore/Guitar Pro draw it as the boxed "Chorus" above the
     * staff — the same marker CSMPN's `- Chorus` and CSML's `[Chorus]` carry. */
    if (bar.section) L.push(`      <direction placement="above"><direction-type><rehearsal>${_xmlEsc(String(bar.section))}</rehearsal></direction-type></direction>`);
    let cursor = 0;
    const barDiv = Math.round(bb * div * 4 / bt);
    const pushRest = (duration) => { if (duration > 0) L.push(`      <note><rest/><duration>${duration}</duration></note>`); };
    bar.events.forEach((e) => {
      const onset = Math.max(cursor, Math.round((e.qbeat != null ? e.qbeat : e.beat) * div * 4 / bt));
      if (onset >= barDiv) return;
      pushRest(onset - cursor);
      const sym = ov[`${bar.number}.${e.beat}`] != null ? ov[`${bar.number}.${e.beat}`] : e.symbol;
      const durDiv = Math.min(barDiv - onset, Math.max(1, Math.round((e.qdur != null ? e.qdur : e.durBeats) * div * 4 / bt)));
      cursor = onset + durDiv;
      const h = _harmonyXML(sym, useSharp); if (h) L.push(h);
      const midis = e.midis && e.midis.length ? e.midis : [];
      if (!midis.length) { L.push(`      <note><rest/><duration>${durDiv}</duration></note>`); return; }
      const tuplet = e.tuplet > 1 ? e.tuplet : 0;
      const normal = tuplet ? _csmpnTupNormal(tuplet) : 0;
      const ty = _typeForQuarters(durDiv / div * (tuplet ? tuplet / normal : 1));
      midis.forEach((m, ci) => {
        const p = _midiToPitchXML(m, useSharp);
        L.push("      <note>");
        if (ci > 0) L.push("        <chord/>");
        L.push(`        <pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.oct}</octave></pitch>`);
        L.push(`        <duration>${durDiv}</duration>`);
        if (ty) { L.push(`        <type>${ty.type}</type>`); if (ty.dot) L.push("        <dot/>"); }
        if (tuplet) L.push(`        <time-modification><actual-notes>${tuplet}</actual-notes><normal-notes>${normal}</normal-notes></time-modification>`);
        L.push("      </note>");
      });
    });
    pushRest(barDiv - cursor);
    L.push("    </measure>");
  });
  L.push("  </part>", "</score-partwise>", "");
  return L.join("\n");
}

/* ============================================================================
 *  VOCAL SCORE — separated vocal parts → a rehearsal-ready choral score
 *  ---------------------------------------------------------------------------
 *  The ML note transcription (basic-pitch) + `splitVoices` yield one MONOPHONIC
 *  line per voice. This turns those lines into a score every singer can read at
 *  rehearsal and every musician can rely on at the gig. One <part>/staff per
 *  voice, sharing key, meter and barlines. It follows standard choral-engraving
 *  practice (Gould, *Behind Bars*, "Vocal music"):
 *
 *   - PART NAMES FROM RANGE, not from slot number. Each line's tessitura is
 *     classified as Soprano / Alto / Tenor / Baritone / Bass (an order-preserving
 *     fit, so an SSA trio reads "Soprano 1 · Soprano 2 · Alto"). Alternative
 *     namings: "harmony" (Lead Vocal on top + High/Low Harmony, how bands talk),
 *     "numbered" (Voice 1–N) and legacy "satb".
 *   - CLEF FROM VOICE TYPE: S/A treble, TENOR treble-8vb (the modern choral
 *     convention; plain treble would sit an octave of ledger lines too low),
 *     Baritone/Bass bass clef.
 *   - Part-group BRACKET with barlines BROKEN between staves (vocal convention:
 *     leaves room for lyrics), part abbreviations on later systems, a per-part
 *     MIDI instrument (Choir Aahs, own channel, spread pan) so notation-app
 *     playback doubles as a rehearsal track.
 *   - KEY-AWARE SPELLING: diatonic notes from the key's scale; chromatic notes by
 *     scale degree (♭3/♭6/♭7/♭2 and ♯4 in major; raised 6th/7th and Picardy 3rd in
 *     minor). Fixes A♯ in F major and D♭ for the leading tone in D minor.
 *     MusicXML carries explicit <accidental>s with per-bar carry; ABC writes
 *     accidentals RELATIVE TO K: and per-bar state (the old writer emitted "B"
 *     for B♮ under K:F, which ABC reads as B♭ — a wrong PITCH).
 *   - METRIC NOTATION: note values are split at the beat hierarchy (show the
 *     beat / half-bar; one-level syncopation like e-q-e or q-h-q allowed; no
 *     dotted rests in simple time) instead of a greedy largest-value fill.
 *   - REHEARSAL STRUCTURE: detected/edited sections become boxed rehearsal marks
 *     with a double barline before them, the last bar gets a final barline, and
 *     optional system breaks every N bars make "from bar 9" findable.
 *
 *  This is ADDITIVE and never touches the single-part `scoreToMusicXML` (which
 *  the whole validated corpus + the MusicXML round-trip test depend on). Pure →
 *  headless-tested (no React, no DOM).
 * ------------------------------------------------------------------------- */

function _xmlEsc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Legacy SATB slot labels (naming:"satb"); voice 0 = highest. Kept for callers
 * that want positional names. A single voice is just the lead vocal. */
const _SATB_NAMES = ["Soprano/Lead", "Alto", "Tenor", "Bass"];
function voicePartNames(voiceCount) {
  const n = Math.max(1, voiceCount | 0);
  if (n === 1) return ["Lead Vocal"];
  const out = [];
  for (let i = 0; i < n; i++) out.push(_SATB_NAMES[i] || ("Voice " + (i + 1)));
  return out;
}

/* Circle-of-fifths accidental count for a key → MusicXML <fifths> (+sharps /
 * −flats). Major C=0 … F♯=+6 / D♭=−5; a minor key uses its relative major. */
const _FIFTHS_MAJOR = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: 6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
function _keyFifths(key) {
  if (!key || typeof key.tonic !== "number") return 0;
  const rel = key.mode === "minor" ? ((key.tonic + 3) % 12) : key.tonic;   // relative major
  const f = _FIFTHS_MAJOR[((rel % 12) + 12) % 12];
  return f == null ? 0 : f;
}

/* Pick a clef for a monophonic line from its median pitch: bass below G3 (55),
 * treble otherwise — the same threshold `staffLayout` uses. (Legacy helper; the
 * vocal score now clefs by VOICE TYPE, see VOICE_TYPES.) */
function _clefForScore(score) {
  const ms = [];
  for (const b of (score && score.bars) || []) for (const e of (b.events || [])) for (const m of (e.midis || [])) ms.push(m);
  if (!ms.length) return "treble";
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)] < 55 ? "bass" : "treble";
}

/* ---- voice types (choral ranges) -----------------------------------------
 * Standard choral ranges (sounding pitch, MIDI): the span a part can be asked to
 * sing in a typical amateur/semi-pro choir. Used to NAME and CLEF a separated line
 * by its tessitura, and to flag notes outside the comfortable range in the range
 * report (so an arranger sees "3 notes above A5" before handing the part out). */
const VOICE_TYPES = [
  { id: "soprano", name: "Soprano", abbr: "S.", low: 60, high: 81, clef: "treble" },     // C4–A5
  { id: "alto", name: "Alto", abbr: "A.", low: 53, high: 74, clef: "treble" },           // F3–D5
  { id: "tenor", name: "Tenor", abbr: "T.", low: 48, high: 69, clef: "treble8vb" },      // C3–A4 (written 8va)
  { id: "baritone", name: "Baritone", abbr: "Bar.", low: 45, high: 65, clef: "bass" },   // A2–F4
  { id: "bass", name: "Bass", abbr: "B.", low: 40, high: 64, clef: "bass" },             // E2–E4
];
const _VT_BY_ID = Object.fromEntries(VOICE_TYPES.map((t) => [t.id, t]));
/* Duration-weighted pitch statistics of a line: { low, high, median, p10, p90, n }.
 * Accepts notes with `midi` (or `midis`) and `durSec`/`durBeat` weights. */
function _lineStats(notes) {
  const pairs = [];
  for (const n of notes || []) {
    const ms = n.midis && n.midis.length ? n.midis : (n.midi != null ? [n.midi] : []);
    const w = Math.max(1e-3, n.durBeat != null ? n.durBeat : (n.durSec != null ? n.durSec : 1));
    for (const m of ms) pairs.push([m, w]);
  }
  if (!pairs.length) return null;
  pairs.sort((a, b) => a[0] - b[0]);
  const tot = pairs.reduce((a, p) => a + p[1], 0);
  const q = (f) => { let acc = 0; for (const p of pairs) { acc += p[1]; if (acc >= f * tot) return p[0]; } return pairs[pairs.length - 1][0]; };
  return { low: pairs[0][0], high: pairs[pairs.length - 1][0], median: q(0.5), p10: q(0.1), p90: q(0.9), n: pairs.length };
}
/* Classify lines (ordered HIGH → LOW) into voice types. An order-preserving DP:
 * the type index never goes back up as the lines descend (a lower line is never
 * labelled higher than the line above it), repeats are allowed (SSA, TTBB). Cost
 * per (line, type) = share of the line's duration outside the type's range ×4 +
 * the tessitura's distance from the range centre in octaves. Returns type ids. */
function classifyVoiceTypes(statsList) {
  const P = statsList.length, T = VOICE_TYPES.length;
  if (!P) return [];
  const cost = (st, t) => {
    if (!st) return 0;
    const vt = VOICE_TYPES[t], centre = (vt.low + vt.high) / 2;
    const out = (st.p10 < vt.low ? 0.1 : 0) + (st.p90 > vt.high ? 0.1 : 0) + (st.median < vt.low || st.median > vt.high ? 0.5 : 0);
    return out * 4 + Math.abs(st.median - centre) / 12;
  };
  const D = Array.from({ length: P }, () => new Array(T).fill(Infinity));
  const B = Array.from({ length: P }, () => new Array(T).fill(-1));
  for (let t = 0; t < T; t++) D[0][t] = cost(statsList[0], t);
  for (let i = 1; i < P; i++) for (let t = 0; t < T; t++) {
    for (let u = 0; u <= t; u++) { const c = D[i - 1][u] + cost(statsList[i], t); if (c < D[i][t]) { D[i][t] = c; B[i][t] = u; } }
  }
  let t = 0;
  for (let u = 1; u < T; u++) if (D[P - 1][u] < D[P - 1][t]) t = u;
  const ids = new Array(P);
  for (let i = P - 1; i >= 0; i--) { ids[i] = VOICE_TYPES[t].id; t = B[i][t]; }
  return ids;
}

/* ---- key from the NOTES (Krumhansl–Kessler) -------------------------------
 * `analyzeKey` reasons about chord FUNCTION, which is the right model for a chord
 * chart but not for a set of sung lines (each "event" is one note). Key finding
 * from note data is the classic Krumhansl–Schmuckler method: correlate the
 * duration-weighted pitch-class histogram with the Krumhansl–Kessler major/minor
 * probe-tone profiles in all 24 rotations. Returns { tonic, mode, confidence
 * (Pearson r, clamped 0..1), candidates:[top 5] } or null for no notes. */
const _KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const _KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function _pearson(a, b) {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}
function keyFromNotes(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes || []) {
    const ms = n.midis && n.midis.length ? n.midis : (n.midi != null ? [n.midi] : []);
    const w = Math.max(0, n.durSec != null ? n.durSec : (n.durBeat != null ? n.durBeat : 1));
    for (const m of ms) h[((Math.round(m) % 12) + 12) % 12] += w;
  }
  if (!h.some((x) => x > 0)) return null;
  const cands = [];
  for (let t = 0; t < 12; t++) for (const [mode, prof] of [["major", _KK_MAJOR], ["minor", _KK_MINOR]]) {
    const rot = h.map((_, i) => h[(i + t) % 12]);
    cands.push({ tonic: t, mode, r: _pearson(rot, prof) });
  }
  cands.sort((a, b) => b.r - a.r);
  const best = cands[0];
  return { tonic: best.tonic, mode: best.mode, confidence: +Math.max(0, Math.min(1, best.r)).toFixed(3),
    candidates: cands.slice(0, 5).map((c) => ({ tonic: c.tonic, mode: c.mode, confidence: +Math.max(0, c.r).toFixed(3) })) };
}

/* ---- key-aware pitch spelling ---------------------------------------------
 * _keySpeller(key) → midi → { step, alter, oct }. Diatonic pitch classes take the
 * key's scale letter; the 5 chromatic ones are spelled by SCALE DEGREE:
 *   major: ♯1 ♭3 ♯4 ♭6 ♭7       minor: ♭2 ♮3(Picardy) ♯4 ♮6 ♮7 (raised 6th/7th)
 * (♯1 not ♭2 in major: V/ii is far commoner than the Neapolitan — E♭ major's
 * chromatic E reads E♮, not F♭) so D minor's leading tone is C♯ (not D♭) and
 * F major's 4th is B♭ (not A♯).
 * Double accidentals fall out naturally where a key needs them (G♯ minor's
 * leading tone is F𝄪). Octave is computed from the LETTER, so B♯3 / C♭4 sit in
 * the right octave. No key → the legacy sharps/flats table. */
const _LETTERS = "CDEFGAB";
const _LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const _REL_MAJOR_LETTER = { 0: 0, 1: 4, 2: 1, 3: 5, 4: 2, 5: 6, 6: 3, "-1": 3, "-2": 6, "-3": 2, "-4": 5, "-5": 1, "-6": 4 };
const _DIA_STEPS = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const _CHROM_DEG = { major: { 1: 0, 3: 2, 6: 3, 8: 5, 10: 6 }, minor: { 1: 1, 4: 2, 6: 3, 9: 5, 11: 6 } };
function _keySpeller(key, fallbackSharp = true) {
  if (!key || typeof key.tonic !== "number") {
    return (m) => { const p = _midiToPitchXML(m, fallbackSharp); return { step: p.step, alter: p.alter, oct: p.oct }; };
  }
  const mode = key.mode === "minor" ? "minor" : "major";
  const relLetter = _REL_MAJOR_LETTER[_keyFifths(key)] || 0;
  const tonicLetter = mode === "minor" ? (relLetter + 5) % 7 : relLetter;
  const tonic = ((key.tonic % 12) + 12) % 12;
  const table = [];
  for (let rel = 0; rel < 12; rel++) {
    const di = _DIA_STEPS[mode].indexOf(rel);
    const deg = di >= 0 ? di : _CHROM_DEG[mode][rel];
    const letter = (tonicLetter + deg) % 7;
    const pc = (tonic + rel) % 12;
    const alter = ((pc - _LETTER_PC[letter] + 18) % 12) - 6;
    table[pc] = [letter, alter];
  }
  return (m) => {
    const [letter, alter] = table[((Math.round(m) % 12) + 12) % 12];
    return { step: _LETTERS[letter], alter, oct: Math.round((m - alter - _LETTER_PC[letter]) / 12) - 1 };
  };
}
/* ---- key-aware chord spelling (2026-10-25) ------------------------------------
 * The family default table (C# Eb F# Ab Bb) ignores the key, so a 4-flat F-minor tune read
 * C#maj7 for Dbmaj7. `spellScoreForKey` re-spells every chord ROOT and slash BASS by scale
 * degree in the given key (`_keySpeller`: diatonic notes by the key's letters; chromatic ones
 * major ♯1 ♭3 ♯4 ♭6 ♭7, minor ♭2 ♮3 ♯4 ♮6 ♮7), so Db in F minor, G# in E major, C# (the
 * leading tone) in D minor. In C major / A minor it is the family table, give or take the
 * minor's leading tone. A double accidental (Fx) is never written as a chord root — it falls
 * back to the family name. Names only: midis, frets and every other field stay. Pure, never
 * mutates; no key → the score unchanged. A display/export transform: parsers keep the family
 * table, so every pinned importer output is unchanged. */
function keyNoteNames(key) {
  if (!key || typeof key.tonic !== "number") return NOTE_SHARP.slice();
  const sp = _keySpeller(key);
  return NOTE_SHARP.map((fam, pc) => { const p = sp(60 + pc); return Math.abs(p.alter) > 1 ? fam : p.step + (p.alter === 1 ? "#" : p.alter === -1 ? "b" : ""); });
}
function keyNameForKey(key) {
  if (!key || typeof key.tonic !== "number") return null;
  return keyNoteNames(key)[((key.tonic % 12) + 12) % 12] + (key.mode === "minor" ? "m" : "");
}
// every single-accidental spelling (the engine tables hold only one name per black key)
const _PC_ANY = { C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, "E#": 5, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
function spellSymbolForKey(symbol, names) {
  if (!symbol || typeof symbol !== "string") return symbol;
  const m = symbol.match(/^([A-G][#b]?)(.*)$/);
  if (!m || _PC_ANY[m[1]] === undefined) return symbol;
  let rest = m[2];
  const bm = rest.match(/^(.*)\/([A-G][#b]?)$/);
  if (bm && _PC_ANY[bm[2]] !== undefined) rest = `${bm[1]}/${names[_PC_ANY[bm[2]]]}`;
  return names[_PC_ANY[m[1]]] + rest;
}
function spellScoreForKey(score, key) {
  if (!score || !score.bars || !key || typeof key.tonic !== "number") return score;
  const names = keyNoteNames(key);
  const bars = score.bars.map((b) => {
    let changed = false;
    const events = (b.events || []).map((e) => {
      const sym = spellSymbolForKey(e && e.symbol, names);
      if (!e || sym === e.symbol) return e;
      changed = true; return { ...e, symbol: sym };
    });
    return changed ? { ...b, events } : b;
  });
  return { ...score, bars };
}
/* The key signature as letter → alter (for accidental bookkeeping). */
function _keySigAlters(key) {
  const f = _keyFifths(key), sig = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  const sharps = "FCGDAEB", flats = "BEADGCF";
  for (let i = 0; i < Math.abs(f); i++) sig[(f > 0 ? sharps : flats)[i]] = f > 0 ? 1 : -1;
  return sig;
}
/* Spelled pitch → display name ("F#4", "Bb3", "Fx4"). */
const _ACC_TXT = { "-2": "bb", "-1": "b", 0: "", 1: "#", 2: "x" };
function _spelledName(p) { return p.step + (_ACC_TXT[p.alter] || "") + p.oct; }

/* ---- splitVoices → labelled parts ------------------------------------------ */
function _notesToBeatNotes(notes, bpm) {
  const spb = 60 / Math.max(20, Math.min(400, bpm || 120));
  return (notes || []).map((n) => ({ midi: n.midi, onsetBeat: (n.startSec || 0) / spb, durBeat: Math.max(1e-3, (n.durSec || spb) / spb) }));
}
/* Names for parts ordered HIGH→LOW. naming:
 *   "range"    (default) voice type from tessitura, numbered when repeated
 *   "harmony"  the lead line (opts.leadVoice = its index HIGH→LOW, default 0)
 *              is "Lead Vocal"; the rest are "Harmony" (one side) or "High/Low
 *              Harmony" (both sides), numbered top-down when repeated
 *   "numbered" "Voice 1" … "Voice N"
 *   "satb"     the legacy positional labels (Soprano/Lead, Alto, Tenor, Bass)
 * Returns [{ name, abbr }]. */
function _partLabels(typeIds, slots, opts = {}) {
  const naming = opts.naming || "range";
  const P = typeIds.length;
  if (naming === "satb") {
    const names = voicePartNames(opts.voices || P);
    return slots.map((v) => ({ name: names[v] || ("Voice " + (v + 1)), abbr: (names[v] || "V").slice(0, 1) + "." }));
  }
  if (naming === "numbered") return typeIds.map((_, i) => ({ name: "Voice " + (i + 1), abbr: "V" + (i + 1) }));
  if (naming === "harmony") {
    const L = Math.max(0, Math.min(P - 1, opts.leadVoice | 0));
    const above = L, below = P - 1 - L;
    return typeIds.map((_, i) => {
      if (i === L) return { name: "Lead Vocal", abbr: "Ld." };
      if (P === 1) return { name: "Lead Vocal", abbr: "Ld." };
      if (!above || !below) {
        const n = above + below, k = i < L ? i + 1 : i - L;
        return n === 1 ? { name: "Harmony", abbr: "Harm." } : { name: "Harmony " + k, abbr: "H" + k };
      }
      if (i < L) return above === 1 ? { name: "High Harmony", abbr: "Hi." } : { name: "High Harmony " + (i + 1), abbr: "Hi" + (i + 1) };
      const k = i - L;
      return below === 1 ? { name: "Low Harmony", abbr: "Lo." } : { name: "Low Harmony " + k, abbr: "Lo" + k };
    });
  }
  const count = {}; typeIds.forEach((t) => { count[t] = (count[t] || 0) + 1; });
  const seen = {};
  return typeIds.map((t) => {
    const vt = _VT_BY_ID[t];
    if (count[t] === 1) return { name: vt.name, abbr: vt.abbr };
    seen[t] = (seen[t] || 0) + 1;
    return { name: vt.name + " " + seen[t], abbr: vt.abbr.replace(/\.$/, "") + seen[t] + "." };
  });
}
/* splitVoices → one labelled, monophonic part per voice. Returns
 *   [{ voice, name, abbr, voiceType, clef, stats, score, beatNotes }]
 * HIGH→LOW, except naming:"harmony" puts the LEAD part first (top staff) and the
 * harmonies below it in descending register. A voice slot with no notes is dropped
 * (the honest "no backing detected → lead only" case); `voices <= 1` returns the
 * single polyphonic line. `score` (integer-beat grid) feeds the on-screen chart +
 * the other exporters; `beatNotes` are the raw onsets/durations in BEATS, which the
 * notation exporters quantise finely. opts: { voices, method, naming, leadVoice,
 * bpm, beatsPerBar, beatType, useSharp }. */
function splitVoicesToScores(notes, opts = {}) {
  const voiceCount = Math.max(1, Math.min(8, opts.voices | 0 || 3));
  const useSharp = opts.useSharp !== false;
  const bpm = opts.bpm || 120;
  const sopts = { bpm, beatsPerBar: opts.beatsPerBar, beatType: opts.beatType, useSharp };
  const groups = [];
  if (voiceCount <= 1) groups.push({ voice: 0, notes: notes || [] });
  else {
    const split = splitVoices(notes || [], { voices: voiceCount, method: opts.method });
    for (let v = 0; v < voiceCount; v++) {
      const forV = split.filter((n) => n.voice === v);
      if (forV.length) groups.push({ voice: v, notes: forV });
    }
    if (!groups.length) groups.push({ voice: 0, notes: notes || [] });
  }
  const stats = groups.map((g) => _lineStats(g.notes));
  const types = classifyVoiceTypes(stats);
  /* one line in = one line out: whatever split was asked for, a stem with a single
   * detected line is the lead vocal (unless a positional naming was requested). */
  const naming = groups.length === 1 && !["numbered", "satb"].includes(opts.naming) ? "single" : (opts.naming || "range");
  const labels = naming === "single"
    ? [{ name: voicePartNames(1)[0], abbr: "Voc." }]
    : _partLabels(types, groups.map((g) => g.voice), { naming, leadVoice: opts.leadVoice, voices: voiceCount });
  let parts = groups.map((g, i) => {
    const vt = _VT_BY_ID[types[i]] || VOICE_TYPES[0];
    return { voice: g.voice, name: labels[i].name, abbr: labels[i].abbr, voiceType: vt.id, clef: vt.clef, stats: stats[i],
      score: polyNotesToScore(g.notes, sopts), beatNotes: _notesToBeatNotes(g.notes, bpm) };
  });
  if (naming === "harmony" && parts.length > 1) {
    const L = Math.max(0, Math.min(parts.length - 1, opts.leadVoice | 0));
    parts = [parts[L], ...parts.filter((_, i) => i !== L)];
  }
  return parts;
}
/* Range check per part against its voice type → what an arranger needs before the
 * parts go out: the actual span, the tessitura, and how many notes sit outside the
 * type's comfortable range (with which way). opts.key spells the note names. */
function vocalRangeReport(parts, opts = {}) {
  const spell = _keySpeller(opts.key || null, opts.useSharp !== false);
  return (parts || []).map((p) => {
    const vt = _VT_BY_ID[p.voiceType] || null;
    const notes = p.beatNotes || _scoreToBeatNotes(p.score);
    const st = _lineStats(notes);
    if (!st) return { name: p.name, voiceType: p.voiceType, empty: true };
    let below = 0, above = 0, total = 0;
    for (const n of notes) {
      const ms = n.midis && n.midis.length ? n.midis : (n.midi != null ? [n.midi] : []);
      for (const m of ms) { total++; if (vt && m < vt.low) below++; if (vt && m > vt.high) above++; }
    }
    const nm = (m) => _spelledName(spell(m));
    return { name: p.name, voiceType: p.voiceType, typeName: vt ? vt.name : "", low: st.low, high: st.high,
      lowName: nm(st.low), highName: nm(st.high), tessitura: [nm(st.p10), nm(st.p90)], median: st.median,
      rangeName: vt ? nm(vt.low) + "–" + nm(vt.high) : "", below, above, total, ok: !below && !above };
  });
}

/* ---- notation quantiser + METRIC note values ------------------------------
 * The score model's integer `beat`/`durBeats` grid is quarter-resolution and can
 * collapse a dense bar's onsets to ZERO-length events — fine for the on-screen
 * chart, invalid for notation. So the notation exporters quantise a voice's real
 * onsets/durations onto a 16th (or 8th) grid, split notes/rests at barlines, and
 * spell each span as standard tied note-values so every measure sums EXACTLY.
 * Everything is measured in "ticks" = a 16th note (_NOTE_GRID per quarter). */
const _NOTE_GRID = 4;                                          // ticks per quarter (16th resolution)
const _NOTE_VALUES = [[24, "whole", true], [16, "whole", false], [12, "half", true], [8, "half", false], [6, "quarter", true], [4, "quarter", false], [3, "eighth", true], [2, "eighth", false], [1, "16th", false]];
const _VALUE_BY_TICKS = Object.fromEntries(_NOTE_VALUES.map((v) => [v[0], { ticks: v[0], type: v[1], dot: v[2] }]));
/* Greedy decomposition of a tick count into standard note-values (largest first),
 * position-blind. Kept as the fallback; notation uses `_metricValues`. */
function _noteValuesFromTicks(t) {
  const out = [];
  let r = Math.max(0, Math.round(t));
  while (r > 0) {
    let picked = _NOTE_VALUES[_NOTE_VALUES.length - 1];
    for (const v of _NOTE_VALUES) { if (v[0] <= r && (v[0] !== 24)) { picked = v; break; } }
    out.push({ ticks: picked[0], type: picked[1], dot: picked[2] });
    r -= picked[0];
  }
  return out;
}
/* The meter's beat hierarchy as tick periods, strongest first:
 *   4/4 → [16 bar, 8 half-bar, 4 beat, 2, 1]   3/4 → [12, 4, 2, 1]
 *   6/8 → [12, 6 dotted-quarter beat, 2, 1]    12/8 → [24, 12, 6, 2, 1]
 *   2/2 → [16, 8, 4, 2, 1]                     x/8 (odd) → eighth beats */
function _meterLevels(bpb, bt) {
  const g = _NOTE_GRID;
  const tpm = Math.round(bpb * (4 / bt) * g);
  const compound = bt === 8 && bpb % 3 === 0 && bpb > 3;
  const beat = compound ? 3 * (g / 2) : (bt === 8 ? g / 2 : Math.round((4 / bt) * g));
  const levels = [tpm];
  const nBeats = Math.round(tpm / beat);
  if (nBeats >= 4 && nBeats % 2 === 0) levels.push(tpm / 2);
  levels.push(beat);
  let sub = compound ? g / 2 : beat;
  if (compound) levels.push(sub);
  while (sub > 1) { sub /= 2; if (Number.isInteger(sub)) levels.push(sub); }
  const out = [];
  for (const L of levels) if (L >= 1 && Number.isInteger(L) && !out.includes(L) && (!out.length || L < out[out.length - 1])) out.push(L);
  if (out[out.length - 1] !== 1) out.push(1);
  return { levels: out, tpm, beat, compound };
}
/* Is [a, a+len) a legible single value at this position? A value may cross a
 * metric boundary only if it STARTS on a boundary at least as strong; the one
 * allowed exception is classic one-level syncopation (an undotted note twice the
 * length of its starting level: 8th-qtr-8th, qtr-half-qtr). Rests get no
 * syncopation and, in simple time, no dots (Gould). */
function _metricOK(a, len, v, meter, isRest) {
  const { levels, beat, compound } = meter;
  const lvl = (pos) => { for (let i = 0; i < levels.length; i++) if (pos % levels[i] === 0) return i; return levels.length; };
  const la = lvl(a);
  if (isRest && v.dot && !(compound && len === beat && a % beat === 0)) return false;
  for (let i = 0; i < levels.length; i++) {
    const L = levels[i];
    const m = (Math.floor(a / L) + 1) * L;
    if (m >= a + len) continue;                                 // no boundary of this level inside
    if (la <= i) continue;                                      // starts at least as strong
    if (!isRest && !v.dot && i === la - 1 && len === 2 * levels[la]) continue;   // one-level syncopation
    return false;
  }
  return true;
}
/* Spell [a, b) (ticks within ONE measure) as tied note values that respect the
 * beat: greedy longest LEGAL value from the start, falling back to the next
 * smaller one. Always terminates (a 16th is always legal). */
function _metricValues(a, b, meter, isRest) {
  const out = [];
  let pos = a;
  while (pos < b) {
    let pick = null;
    for (const v of _NOTE_VALUES) {
      if (v[0] > b - pos) continue;
      const val = _VALUE_BY_TICKS[v[0]];
      if (_metricOK(pos, v[0], val, meter, isRest)) { pick = val; break; }
    }
    if (!pick) pick = _VALUE_BY_TICKS[1];
    out.push(pick);
    pos += pick.ticks;
  }
  return out;
}
/* A voice's notes → per-measure notation cells. Input notes are {midis|midi,
 * onsetBeat, durBeat} in BEATS (1 beat = 1/beatType note). Output: an array of
 * measures, each a list of cells:
 *   { rest, midis, type, dot, divs, tieStart, tieStop, wholeMeasure }
 * with `divs` in MusicXML divisions (opts.div per quarter). opts:
 *   grid        subdivisions per quarter to quantise to: 4 = 16ths (default), 2 = 8ths
 *   legatoBeats close a gap shorter than this (in beats) by holding the previous
 *               note to the next onset — basic-pitch releases sung notes early, so
 *               without it every syllable reads as "16th + 16th rest" (default 0)
 *   minBars     pad to at least this many measures
 * Monophonic: notes are clipped to the next onset. A note shorter than half a grid
 * step is dropped (model blip); one between half and one step is kept at one step. */
function _voiceNotationMeasures(beatNotes, opts = {}) {
  const bpb = opts.beatsPerBar || 4, bt = opts.beatType || 4;
  const div = opts.div || 480;
  const dpt = div / _NOTE_GRID;                                // divisions per tick (16th)
  const q = 4 / bt;                                            // quarters per beat
  const grid = opts.grid === 2 ? 2 : 4;
  const step = _NOTE_GRID / grid;                              // ticks per grid step
  const meter = _meterLevels(bpb, bt);
  const tpm = meter.tpm;
  const toTicks = (beats) => beats * q * _NOTE_GRID;
  const snap = (ticks) => Math.round(ticks / step) * step;
  const src = (beatNotes || []).filter((n) => n).map((n) => ({
    on: n.onsetBeat, off: n.onsetBeat + Math.max(0, n.durBeat),
    midis: n.midis && n.midis.length ? n.midis : (n.midi != null ? [n.midi] : []),
  })).filter((n) => n.midis.length && isFinite(n.on)).sort((a, b) => a.on - b.on || b.off - a.off);
  const legato = Math.max(0, opts.legatoBeats || 0);
  if (legato > 0) {
    for (let i = 0; i + 1 < src.length; i++) {
      const gap = src[i + 1].on - src[i].off;
      if (gap > 0 && gap < legato) src[i].off = src[i + 1].on;
    }
  }
  const raw = src.map((n) => {
    const t0 = toTicks(n.on), t1 = toTicks(n.off);
    const start = snap(t0);
    let end = snap(t1);
    if (end <= start && t1 - t0 >= step / 2) end = start + step;
    return { start, end, midis: n.midis };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const notesQ = [];
  let cursor = 0;
  for (let i = 0; i < raw.length; i++) {
    let s = Math.max(raw[i].start, cursor), e = raw[i].end;
    if (i + 1 < raw.length) e = Math.min(e, Math.max(raw[i + 1].start, s));
    if (e <= s) continue;                                      // coincident / micro → drop
    notesQ.push({ start: s, end: e, midis: raw[i].midis });
    cursor = e;
  }
  const items = [];
  let pos = 0;
  for (const n of notesQ) { if (n.start > pos) items.push({ rest: true, start: pos, end: n.start }); items.push({ rest: false, start: n.start, end: n.end, midis: n.midis }); pos = n.end; }
  let totalBars = Math.max(opts.minBars || 0, Math.ceil(pos / tpm) || 0);
  if (totalBars < 1) totalBars = Math.max(1, opts.minBars || 1);
  const fullEnd = totalBars * tpm;
  if (pos < fullEnd) items.push({ rest: true, start: pos, end: fullEnd });
  const measures = Array.from({ length: totalBars }, () => []);
  const measDiv = Math.round(bpb * q * div);
  for (const it of items) {
    const chunks = [];
    let a = it.start;
    while (a < it.end) {
      const bar = Math.floor(a / tpm);
      const b = Math.min(it.end, (bar + 1) * tpm);
      if (it.rest && a === bar * tpm && b === (bar + 1) * tpm) {
        chunks.push({ bar, type: null, dot: false, divs: measDiv, wholeMeasure: true });
      } else {
        for (const v of _metricValues(a - bar * tpm, b - bar * tpm, meter, it.rest)) chunks.push({ bar, type: v.type, dot: v.dot, divs: v.ticks * dpt });
      }
      a = b;
    }
    chunks.forEach((c, ci) => {
      measures[c.bar].push({
        rest: it.rest, midis: it.midis || null, type: c.type, dot: c.dot, divs: c.divs, wholeMeasure: !!c.wholeMeasure,
        tieStop: !it.rest && ci > 0, tieStart: !it.rest && ci < chunks.length - 1,
      });
    });
  }
  measures.forEach((m) => { if (!m.length) m.push({ rest: true, midis: null, type: null, dot: false, divs: measDiv, wholeMeasure: true }); });
  return { measures, beatsPerBar: bpb, beatType: bt, div, measDiv };
}
/* A per-voice SCORE → notes in BEATS (used when a caller passes { score } but no
 * raw notes — e.g. tests). Uses the true fractional qbeat/qdur where present. */
function _scoreToBeatNotes(score) {
  const bpb = score && score.timeSig ? score.timeSig[0] : 4;
  const out = [];
  (score && score.bars || []).forEach((bar, bi) => {
    const base = bi * bpb;
    for (const e of (bar.events || [])) {
      const midis = e.midis || [];
      if (!midis.length) continue;
      out.push({ midis, onsetBeat: base + (e.qbeat != null ? e.qbeat : e.beat || 0), durBeat: (e.qdur != null ? e.qdur : e.durBeats) || 1 });
    }
  });
  return out;
}
/* Shared layout for the multipart exporters: quantised measures per part, the
 * aligned bar count, rehearsal marks by bar and the speller. */
function _vocalLayout(parts, opts) {
  parts = (parts || []).filter((p) => p && (p.beatNotes || (p.score && p.score.bars)));
  if (!parts.length) return null;
  const sig0 = parts[0].score && parts[0].score.timeSig || [4, 4];
  const bpb = opts.beatsPerBar || sig0[0] || 4;
  const bt = opts.beatType || sig0[1] || 4;
  const div = Math.max(480, opts.divisions | 0 || 480);
  const nopts = { beatsPerBar: bpb, beatType: bt, div, grid: opts.grid, legatoBeats: opts.legatoBeats };
  const perVoice = parts.map((p) => _voiceNotationMeasures(p.beatNotes || _scoreToBeatNotes(p.score), nopts));
  const maxBars = Math.max(1, ...perVoice.map((v) => v.measures.length));
  const measDiv = Math.round(bpb * (4 / bt) * div);
  const key = opts.key || null;
  const spell = opts.spelling === "sharps" || opts.spelling === "flats"
    ? _keySpeller(null, opts.spelling === "sharps")
    : (key ? _keySpeller(key) : _keySpeller(null, opts.useSharp !== false));
  /* sections → rehearsal marks: { bar(0-based) → label }. Time → bar on the same
   * grid the notes were quantised to (bar = startSec / (bpb · 60/bpm)), the mapping
   * applySectionsToScore uses — so marks land on the bars the ChartPanel shows. */
  const marks = new Map();
  for (const r of opts.rehearsal || []) if (r && r.label && r.bar >= 0) marks.set(r.bar | 0, String(r.label));
  if (opts.sections && opts.sections.length) {
    const secPerBar = (60 / Math.max(20, Math.min(400, opts.tempo || 120))) * bpb;
    for (const s of [...opts.sections].sort((a, b) => a.startSec - b.startSec)) {
      if (!s || !s.label || !isFinite(s.startSec)) continue;
      let bi = Math.max(0, Math.min(maxBars - 1, Math.round(s.startSec / secPerBar)));
      while (marks.has(bi) && bi + 1 < maxBars) bi++;
      if (!marks.has(bi)) marks.set(bi, String(s.label));
    }
  }
  return { parts, bpb, bt, div, perVoice, maxBars, measDiv, key, spell, marks };
}
/* Per-measure accidental bookkeeping (standard practice): an accidental holds for
 * the rest of the bar on that letter+octave; the key signature applies otherwise;
 * a note TIED over the barline is not re-inflected (and does not set state). */
function _accidentalTracker(key) {
  const sig = _keySigAlters(key);
  let bar = new Map();
  return {
    newBar() { bar = new Map(); },
    need(p, tieStop) {
      const k = p.step + p.oct;
      const eff = bar.has(k) ? bar.get(k) : sig[p.step];
      if (tieStop) return null;
      if (eff === p.alter) return null;
      bar.set(k, p.alter);
      return p.alter;
    },
  };
}
const _ACC_XML = { "-2": "flat-flat", "-1": "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
const _CLEF_XML = {
  treble: "<clef><sign>G</sign><line>2</line></clef>",
  treble8vb: "<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>",
  bass: "<clef><sign>F</sign><line>4</line></clef>",
};

/* parts: [{ name, abbr?, clef?, score?, beatNotes? }] → ONE valid `score-partwise`
 * MusicXML 3.1 choral score (parts[0] = top staff). opts:
 *   key {tonic,mode}, tempo, title, composer, arranger, beatsPerBar, beatType,
 *   divisions (≥480), grid (4|2), legatoBeats, spelling ("key"|"sharps"|"flats"),
 *   useSharp (spelling when no key), sections [{label,startSec}] | rehearsal
 *   [{bar,label}], barsPerSystem, labelStaves (also print the name above bar 1),
 *   midiProgram (GM 1-based, default 53 Choir Aahs). */
function scoreToMultipartMusicXML(parts, opts = {}) {
  const lay = _vocalLayout(parts, opts);
  if (!lay) throw new Error("scoreToMultipartMusicXML: no parts");
  const { bpb, bt, div, perVoice, maxBars, measDiv, key, spell, marks } = lay;
  parts = lay.parts;
  const fifths = _keyFifths(key);
  const P = parts.length;
  const program = Math.max(1, Math.min(128, opts.midiProgram | 0 || 53));
  const L = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="3.1">'];
  if (opts.title) L.push("  <work><work-title>" + _xmlEsc(opts.title) + "</work-title></work>");
  L.push("  <identification>");
  if (opts.composer) L.push('    <creator type="composer">' + _xmlEsc(opts.composer) + "</creator>");
  if (opts.arranger) L.push('    <creator type="arranger">' + _xmlEsc(opts.arranger) + "</creator>");
  L.push("    <encoding><software>Tab Translator Pro</software></encoding>", "  </identification>");
  L.push("  <part-list>");
  if (P > 1) L.push('    <part-group type="start" number="1"><group-symbol>bracket</group-symbol><group-barline>no</group-barline></part-group>');
  parts.forEach((p, i) => {
    const id = "P" + (i + 1);
    const ch = i + 1 >= 10 ? i + 2 : i + 1;                    // skip GM drum channel 10
    const pan = P > 1 ? Math.round(-45 + (90 * i) / (P - 1)) : 0;
    L.push('    <score-part id="' + id + '">');
    L.push("      <part-name>" + _xmlEsc(p.name || ("Voice " + (i + 1))) + "</part-name>");
    if (p.abbr) L.push("      <part-abbreviation>" + _xmlEsc(p.abbr) + "</part-abbreviation>");
    L.push('      <score-instrument id="' + id + '-I1"><instrument-name>Voice</instrument-name></score-instrument>');
    L.push('      <midi-instrument id="' + id + '-I1"><midi-channel>' + ch + "</midi-channel><midi-program>" + program +
      "</midi-program><volume>80</volume><pan>" + pan + "</pan></midi-instrument>");
    L.push("    </score-part>");
  });
  if (P > 1) L.push('    <part-group type="stop" number="1"/>');
  L.push("  </part-list>");

  const beatUnit = bt === 8 ? "eighth" : bt === 2 ? "half" : "quarter";
  const soundTempo = opts.tempo ? Math.round(opts.tempo * 4 / bt) : 0;
  parts.forEach((p, pi) => {
    const clef = _CLEF_XML[p.clef] ? p.clef : (p.score ? _clefForScore(p.score) : "treble");
    const measures = perVoice[pi].measures;
    const acc = _accidentalTracker(key);
    L.push('  <part id="P' + (pi + 1) + '">');
    for (let bi = 0; bi < maxBars; bi++) {
      const cells = measures[bi] || [{ rest: true, midis: null, type: null, dot: false, divs: measDiv, wholeMeasure: true }];
      acc.newBar();
      L.push('    <measure number="' + (bi + 1) + '">');
      if (bi > 0 && opts.barsPerSystem > 0 && bi % opts.barsPerSystem === 0) L.push('      <print new-system="yes"/>');
      if (bi === 0) {
        L.push("      <attributes>");
        L.push("        <divisions>" + div + "</divisions>");
        L.push("        <key><fifths>" + fifths + "</fifths>" + (key ? "<mode>" + (key.mode || "major") + "</mode>" : "") + "</key>");
        L.push("        <time><beats>" + bpb + "</beats><beat-type>" + bt + "</beat-type></time>");
        L.push("        " + _CLEF_XML[clef]);
        L.push("      </attributes>");
        if (pi === 0 && opts.tempo) {
          L.push('      <direction placement="above"><direction-type><metronome><beat-unit>' + beatUnit + "</beat-unit><per-minute>" + Math.round(opts.tempo) +
            "</per-minute></metronome></direction-type><sound tempo=\"" + soundTempo + "\"/></direction>");
        }
        if (opts.labelStaves) L.push('      <direction placement="above"><direction-type><words>' + _xmlEsc(p.name || ("Voice " + (pi + 1))) + "</words></direction-type></direction>");
      }
      if (pi === 0 && marks.has(bi)) {
        L.push('      <direction placement="above"><direction-type><rehearsal enclosure="rectangle">' + _xmlEsc(marks.get(bi)) + "</rehearsal></direction-type></direction>");
      }
      for (const c of cells) {
        if (c.rest || !c.midis || !c.midis.length) {
          L.push("      <note>" + (c.wholeMeasure ? '<rest measure="yes"/>' : "<rest/>") + "<duration>" + c.divs + "</duration><voice>1</voice>" +
            (c.type && !c.wholeMeasure ? "<type>" + c.type + "</type>" + (c.dot ? "<dot/>" : "") : "") + "</note>");
        } else {
          c.midis.forEach((m, ci) => {
            const pit = spell(m);
            const a = acc.need(pit, c.tieStop);
            L.push("      <note>");
            if (ci > 0) L.push("        <chord/>");
            L.push("        <pitch><step>" + pit.step + "</step>" + (pit.alter ? "<alter>" + pit.alter + "</alter>" : "") + "<octave>" + pit.oct + "</octave></pitch>");
            L.push("        <duration>" + c.divs + "</duration>");
            if (c.tieStop) L.push('        <tie type="stop"/>');
            if (c.tieStart) L.push('        <tie type="start"/>');
            L.push("        <voice>1</voice>");
            if (c.type) { L.push("        <type>" + c.type + "</type>"); if (c.dot) L.push("        <dot/>"); }
            if (a != null) L.push("        <accidental>" + _ACC_XML[a] + "</accidental>");
            if (c.tieStart || c.tieStop) {
              L.push("        <notations>" + (c.tieStop ? '<tied type="stop"/>' : "") + (c.tieStart ? '<tied type="start"/>' : "") + "</notations>");
            }
            L.push("      </note>");
          });
        }
      }
      if (bi === maxBars - 1) L.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
      else if (marks.has(bi + 1)) L.push('      <barline location="right"><bar-style>light-light</bar-style></barline>');
      L.push("    </measure>");
    }
    L.push("  </part>");
  });
  L.push("</score-partwise>", "");
  return L.join("\n");
}

/* Same voices → a multi-voice ABC document (V: per part, bracketed with unjoined
 * barlines — `%%score [1 2 3]`). Same quantisation + rehearsal marks as the
 * MusicXML path. Pitches are written RELATIVE TO THE KEY SIGNATURE with per-bar
 * accidental carry (ABC semantics), so every note sounds and prints as intended;
 * a tied-over note re-states its accidental (ABC has no tie-carry rule). */
const _ABC_ACC_TOK = { "-2": "__", "-1": "_", 0: "=", 1: "^", 2: "^^" };
/* ABC accidental bookkeeping must be correct under EVERY reader's carry rule, because
 * ABC readers disagree on how far an accidental reaches: the 2.1 standard's
 * %%propagate-accidentals has three settings (not / octave / pitch), abcm2ps
 * historically carried per octave, and music21 (measured) does not carry at all. So
 * a note gets an explicit accidental whenever it differs from the KEY SIGNATURE, or
 * from what an earlier accidental in the bar would carry under the pitch-class OR the
 * same-octave rule. A note that matches the key signature and every carried state is
 * left bare. The cost is an occasional courtesy accidental on a repeated chromatic
 * note — the price of a file that sounds the same in every ABC program. (MusicXML
 * pitches are absolute, so it keeps standard engraving via _accidentalTracker.) */
function _abcAccidentalTracker(key) {
  const sig = _keySigAlters(key);
  let byLetter = new Map(), byOctave = new Map();
  return {
    newBar() { byLetter = new Map(); byOctave = new Map(); },
    need(p) {
      const s = sig[p.step], k = p.step + p.oct;
      const effPitch = byLetter.has(p.step) ? byLetter.get(p.step) : s;
      const effOct = byOctave.has(k) ? byOctave.get(k) : s;
      if (p.alter === s && effPitch === s && effOct === s) return null;
      byLetter.set(p.step, p.alter); byOctave.set(k, p.alter);
      return p.alter;
    },
  };
}
function _abcPitch(p, acc) {
  const a = acc.need(p, false);                                  // never "tie-carried": ABC re-reads every note
  let note = p.step;
  if (p.oct >= 5) { note = note.toLowerCase(); for (let o = 6; o <= p.oct; o++) note += "'"; }
  else { for (let o = p.oct; o < 4; o++) note += ","; }
  return (a != null ? _ABC_ACC_TOK[a] : "") + note;
}
function scoreToMultipartABC(parts, opts = {}) {
  const lay = _vocalLayout(parts, opts);
  if (!lay) throw new Error("scoreToMultipartABC: no parts");
  const { bpb, bt, div, perVoice, maxBars, key, spell, marks } = lay;
  parts = lay.parts;
  const out = [..._abcFileHeader(), "X:1", "T:" + (opts.title || "Vocal score")];
  if (opts.composer) out.push("C:" + opts.composer);
  out.push("M:" + bpb + "/" + bt, "L:1/4");
  if (opts.tempo) out.push("Q:1/" + bt + "=" + Math.round(opts.tempo));
  out.push("%%score [" + parts.map((_, i) => i + 1).join(" ") + "]");
  const abcClef = (c) => (c === "bass" ? "bass" : c === "treble8vb" ? "treble-8" : "treble");
  parts.forEach((p, i) => out.push("V:" + (i + 1) + " name=" + JSON.stringify(p.name || ("Voice " + (i + 1))) +
    (p.abbr ? " snm=" + JSON.stringify(p.abbr) : "") + " clef=" + abcClef(p.clef)));
  out.push("K:" + _abcKeyName(key));
  const abcLen = (divs) => {
    let num = Math.round((divs / div) * 12), den = 12;         // 12 keeps triplets/8ths integer
    if (num < 1) num = 1;
    const g = _gcd(num, den); num /= g; den /= g;
    return (num === 1 ? "" : String(num)) + (den === 1 ? "" : "/" + den);
  };
  parts.forEach((p, i) => {
    out.push("V:" + (i + 1));
    const measures = perVoice[i].measures;
    const acc = _abcAccidentalTracker(key);
    let body = "";
    for (let bi = 0; bi < maxBars; bi++) {
      const cells = measures[bi];
      acc.newBar();
      let cell = i === 0 && marks.has(bi) ? '"^' + marks.get(bi).replace(/"/g, "'") + '"' : "";
      if (!cells || !cells.length || (cells.length === 1 && cells[0].wholeMeasure)) { cell += "Z"; }
      else {
        cells.forEach((c) => {
          let tok;
          if (c.rest || !c.midis || !c.midis.length) tok = "z" + abcLen(c.divs);
          else {
            const ps = c.midis.map((m) => _abcPitch(spell(m), acc));
            tok = (ps.length > 1 ? "[" + ps.join("") + "]" : ps[0]) + abcLen(c.divs);
          }
          cell += tok + (c.tieStart ? "-" : "") + " ";
        });
      }
      const bar = bi === maxBars - 1 ? "|]" : (marks.has(bi + 1) ? "||" : "|");
      body += cell.trim() + " " + bar;
      body += (bi + 1) % 4 === 0 ? "\n" : " ";
    }
    out.push(body.trim());
  });
  return out.join("\n") + "\n";
}

/* ---- rehearsal / learning-track MIDI ---------------------------------------
 * Choirs and bands learn parts from "learning tracks": every part audible, YOUR
 * part louder and centred. scoreToVocalMidi writes a format-1 SMF (PPQ 480): a
 * conductor track (tempo, meter, key signature, title) + one named track per part
 * on its own channel (Choir Aahs), timed from the SAME quantised measures as the
 * notation so what you hear is exactly what is printed (tied chunks re-joined).
 * opts: { tempo, key, title, emphasize (part index | null), program (GM 0-based,
 * default 52 = Choir Aahs), grid, legatoBeats, beatsPerBar, beatType }. */
function _smfTrack(evs) {
  evs.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const t = [];
  let prev = 0;
  for (const ev of evs) { t.push(..._midiVarLen(Math.max(0, ev.tick - prev)), ...ev.bytes); prev = ev.tick; }
  const n = t.length;
  return [0x4D, 0x54, 0x72, 0x6B, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...t];
}
function _smfText(type, s) {
  const b = Array.from(String(s || "")).map((ch) => { const c = ch.charCodeAt(0); return c < 128 ? c : 63; }).slice(0, 120);
  return [0xFF, type, ..._midiVarLen(b.length), ...b];
}
function scoreToVocalMidi(parts, opts = {}) {
  const lay = _vocalLayout(parts, { ...opts, divisions: 480 });
  if (!lay) throw new Error("scoreToVocalMidi: no parts");
  const { bpb, bt, perVoice, maxBars, measDiv, key } = lay;
  parts = lay.parts;
  const PPQ = 480, P = parts.length;
  const qbpm = Math.max(20, Math.min(400, Math.round((opts.tempo || 120) * 4 / bt)));
  const uspq = Math.round(60000000 / qbpm);
  const emph = opts.emphasize != null && opts.emphasize >= 0 && opts.emphasize < P ? opts.emphasize | 0 : null;
  const program = Math.max(0, Math.min(127, opts.program != null ? opts.program | 0 : 52));
  const endTick = maxBars * measDiv;
  const cond = [
    { tick: 0, order: 0, bytes: _smfText(0x03, opts.title || "Vocal score") },
    { tick: 0, order: 0, bytes: [0xFF, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff] },
    { tick: 0, order: 0, bytes: [0xFF, 0x58, 0x04, bpb & 0xff, Math.max(0, Math.round(Math.log2(bt))) & 0xff, 24, 8] },
  ];
  if (key) cond.push({ tick: 0, order: 0, bytes: [0xFF, 0x59, 0x02, _keyFifths(key) & 0xff, key.mode === "minor" ? 1 : 0] });
  cond.push({ tick: endTick, order: 3, bytes: [0xFF, 0x2F, 0x00] });
  const tracks = [_smfTrack(cond)];
  parts.forEach((p, pi) => {
    const ch = pi >= 9 ? pi + 1 : pi;                          // skip GM drum channel (index 9)
    const isEmph = emph === pi;
    const vel = emph == null ? 90 : (isEmph ? 112 : 64);
    const vol = emph == null ? 100 : (isEmph ? 127 : 72);
    const pan = emph != null && isEmph ? 64 : (P > 1 ? Math.round(24 + (80 * pi) / (P - 1)) : 64);
    const evs = [
      { tick: 0, order: 0, bytes: _smfText(0x03, p.name || ("Voice " + (pi + 1))) },
      { tick: 0, order: 0, bytes: [0xC0 | ch, program] },
      { tick: 0, order: 0, bytes: [0xB0 | ch, 7, vol] },
      { tick: 0, order: 0, bytes: [0xB0 | ch, 10, pan] },
    ];
    let t = 0, open = null;
    perVoice[pi].measures.forEach((cells) => {
      for (const c of cells) {
        if (!c.rest && c.midis && c.midis.length) {
          if (c.tieStop && open) open.end = t + c.divs;
          else {
            if (open) for (const m of open.midis) { evs.push({ tick: open.start, order: 2, bytes: [0x90 | ch, m & 0x7f, vel] }); evs.push({ tick: open.end, order: 1, bytes: [0x80 | ch, m & 0x7f, 0] }); }
            open = { start: t, end: t + c.divs, midis: c.midis.map((m) => Math.max(0, Math.min(127, Math.round(m)))) };
          }
          if (!c.tieStart) { for (const m of open.midis) { evs.push({ tick: open.start, order: 2, bytes: [0x90 | ch, m & 0x7f, vel] }); evs.push({ tick: open.end, order: 1, bytes: [0x80 | ch, m & 0x7f, 0] }); } open = null; }
        }
        t += c.divs;
      }
    });
    if (open) for (const m of open.midis) { evs.push({ tick: open.start, order: 2, bytes: [0x90 | ch, m & 0x7f, vel] }); evs.push({ tick: open.end, order: 1, bytes: [0x80 | ch, m & 0x7f, 0] }); }
    evs.push({ tick: endTick, order: 3, bytes: [0xFF, 0x2F, 0x00] });
    tracks.push(_smfTrack(evs));
  });
  const nT = tracks.length;
  const head = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (nT >> 8) & 0xff, nT & 0xff, (PPQ >> 8) & 0xff, PPQ & 0xff];
  return new Uint8Array([...head, ...tracks.flat()]);
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
      // frets and the string-keyed techniques are position-specific; fingerScore can re-finger.
      return { ...e, midis, frets: undefined, tech: undefined, bends: undefined, symbol: midis.length ? symbolForMidis(midis, useSharp) : e.symbol };
    }),
  }));
  return { ...score, bars, transposedBy: n };
}

/* ---- Stage 3: fingering — which string plays each note (fingerScore) ---------
 * An audio-, ML- or transpose-derived chart knows its PITCHES but not where they
 * are played: the same E4 is the open 1st string, the 2nd string at fret 5, the
 * 3rd at 9, … This assigns every note a (string, fret) with a Viterbi pass over
 * the event sequence — the DP-first half of docs/AUDIO-TO-TAB-PLAN.md §3.2.
 *
 *  - STATES are "shapes": one assignment of an event's pitches to DISTINCT
 *    strings. Hand span is a HARD constraint (a shape wider than maxSpan frets,
 *    open strings excluded, is never a state), so every emitted chord is
 *    playable by construction, and pitch validity holds for free.
 *  - COSTS (Noise2Fret's playability terms, as costs not losses): span, fret
 *    height, open-string preference, hand movement between consecutive shapes
 *    (cheaper across a rest), string crossing on a single-note line.
 *  - Scored against the WRITTEN fingering of the repo's Guitar Pro corpus
 *    (`tests/bench/fingering.mjs`, dev = even files, test = odd). Weights are
 *    tuned on dev only; see CLAUDE.md for the measured numbers.
 * Pure, deterministic, no deps. Tuning arrays are low→high (engine index 0 = low E). */
/* Learned −log p tables (min-shifted), from the DEV halves only — the GP corpus' even files
 * + GuitarSet players 0–2 (tests/bench/fingering.mjs --learn-prior --prior-parts cell,move).
 * cell[string][fret]: how often each position is written/played; move[d]: hand moves of d
 * frets (window model). Regenerate with the same command; never train on the test halves. */
const FINGER_PRIOR = {
  move: [0.014, 0.24, 0, 1.297, 2.665, 3.007, 4.612, 4.36, 5.613, 5.5, 6.306, 6.306, 5.787],
  cell: [
    [0.426, 1.007, 1.244, 0, 0.755, 1.326, 1.138, 1.455, 1.758, 2.273, 2.383, 3.49, 3.515, 5.792, 5.233, 4.981, 7.179, 6.08, 6.08, 6.485, 7.179, 7.179, 7.179],
    [0.273, 1.393, 0.098, 0, 0.1, 0.377, 0.132, 0.323, 0.786, 1.278, 1.866, 2.249, 2.464, 4.775, 3.928, 4.002, 5.18, 5.314, 5.468, 5.65, 5.65, 5.874, 4.957],
    [0.309, 1.891, 0, 0.329, 0.466, 0.303, 0.082, 0.185, 0.303, 0.554, 0.815, 1.232, 1.534, 2.44, 2.264, 3.346, 3.661, 3.538, 4.157, 4.024, 4.717, 5.092, 4.122],
    [0.409, 1.214, 0, 0.975, 0.426, 0.429, 0.357, 0.143, 0.644, 0.236, 1.027, 0.989, 1.288, 1.805, 2.643, 2.888, 2.807, 3.644, 4.62, 4.497, 4.983, 4.711, 4.118],
    [0.716, 0.68, 0.809, 0, 0.859, 0.348, 0.525, 0.628, 0.239, 0.817, 0.531, 1.373, 0.795, 1.799, 2.046, 2.25, 3.769, 2.729, 4.695, 4.604, 4.695, 6.353, 3.55],
    [0, 0.826, 0.509, 0.152, 0.607, 0.186, 0.686, 0.278, 0.415, 1.086, 0.63, 1.372, 0.951, 1.569, 1.849, 2.046, 2.341, 1.794, 4.105, 1.984, 3.817, 4.51, 2.423],
  ],
};
const FINGER_DEFAULTS = {
  maxFret: 22,     // highest fret considered
  maxSpan: 4,      // fretted span a hand holds (hard)
  beam: 48,        // shapes kept per event (lowest local cost first)
  span: 0.8,       // per fret of span
  fretSum: 0.02,   // per fret of height, summed over fretted notes
  open: 0,         // bonus per open string
  move: 1.2,       // per fret the hand moves between consecutive shapes
  restBeats: 2,    // a gap this long (beats) halves the next move's cost
  cross: 0,        // per string crossed between consecutive single notes
  window: 3,       // the hand covers this many frets; moving within the window is free
  prior: FINGER_PRIOR, // corpus prior (null disables)
  priorWeight: 1,  // scale on the prior tables
};

function fingerCandidates(midi, tuning, maxFret = FINGER_DEFAULTS.maxFret) {
  const out = [];
  for (let s = 0; s < tuning.length; s++) { if (tuning[s] == null) continue; const f = midi - tuning[s]; if (f >= 0 && f <= maxFret) out.push(s, f); }
  return out; // flat [string, fret, string, fret, …]
}

const _fingerHandPos = (shape) => {
  let lo = Infinity;
  for (const n of shape) if (n.fret > 0 && n.fret < lo) lo = n.fret;
  return lo === Infinity ? null : lo;
};
// Fretted extent [lo, hi] of a shape, or null when every note is open.
const _fingerExtent = (shape) => {
  let lo = Infinity, hi = -Infinity;
  for (const n of shape) if (n.fret > 0) { if (n.fret < lo) lo = n.fret; if (n.fret > hi) hi = n.fret; }
  return lo === Infinity ? null : [lo, hi];
};

function _fingerLocalCost(shape, w) {
  let lo = Infinity, hi = -Infinity, sum = 0, open = 0;
  for (const n of shape) {
    if (n.fret === 0) { open++; continue; }
    if (n.fret < lo) lo = n.fret;
    if (n.fret > hi) hi = n.fret;
    sum += n.fret;
  }
  const span = lo === Infinity ? 0 : hi - lo;
  let c = w.span * span + w.fretSum * sum - w.open * open;
  if (w.prior) {
    const pw = w.priorWeight;
    for (const n of shape) {
      if (w.prior.fret) c += pw * (w.prior.fret[Math.min(n.fret, w.prior.fret.length - 1)] || 0);
      if (w.prior.cell && w.prior.cell[n.string]) c += pw * (w.prior.cell[n.string][Math.min(n.fret, w.prior.cell[n.string].length - 1)] || 0);
    }
  }
  return c;
}

/** Every playable assignment of `midis` to distinct strings, best `beam` by local cost.
 *  An event with more notes than strings, or no shape within maxSpan, relaxes the span
 *  (then drops the duplicate pitches) rather than returning nothing. */
function fingerShapes(midis, tuning, opts = {}) {
  const w = { ...FINGER_DEFAULTS, ...opts };
  // Finger the pitches the instrument CAN play. One out-of-range pitch (a bass note under a guitar
  // chord, a model's octave-up ghost) used to leave the whole chord with no shape, so every note in
  // it was lost; now only that pitch is (scoreToAlphaTex counts it). Nothing playable → unplayable.
  const ms = [...midis].filter((m) => fingerCandidates(m, tuning, w.maxFret).length).sort((a, b) => a - b);
  if (!ms.length) return [];
  const enumerate = (notes, maxSpan) => {
    const out = [], used = new Array(tuning.length).fill(false), acc = [];
    const cands = notes.map((m) => fingerCandidates(m, tuning, w.maxFret));
    (function rec(i, lo, hi) {
      if (out.length >= 4096) return;
      if (i === notes.length) { out.push(acc.slice()); return; }
      const c = cands[i];
      for (let k = 0; k < c.length; k += 2) {
        const s = c[k], f = c[k + 1];
        if (used[s]) continue;
        const nlo = f > 0 ? Math.min(lo, f) : lo, nhi = f > 0 ? Math.max(hi, f) : hi;
        if (nhi - nlo > maxSpan) continue;
        used[s] = true; acc.push({ string: s, fret: f, midi: notes[i] });
        rec(i + 1, nlo, nhi);
        acc.pop(); used[s] = false;
      }
    })(0, Infinity, -Infinity);
    return out;
  };
  let shapes = ms.length <= tuning.length ? enumerate(ms, w.maxSpan) : [];
  for (let sp = w.maxSpan + 1; !shapes.length && sp <= w.maxSpan + 3 && ms.length <= tuning.length; sp++) shapes = enumerate(ms, sp);
  if (!shapes.length) {
    const uniq = [...new Set(ms)].slice(-tuning.length);
    for (let sp = w.maxSpan; !shapes.length && sp <= w.maxFret; sp += 2) shapes = enumerate(uniq, sp);
  }
  return shapes
    .map((sh) => ({ notes: sh, cost: _fingerLocalCost(sh, w), pos: _fingerHandPos(sh), ext: _fingerExtent(sh) }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, w.beam);
}

/** Viterbi over a sequence of events `[{ midis, gap? }]` (gap = beats since the
 *  previous event ended). Returns one shape per event (`null` for an unplayable or
 *  empty event) plus the path cost. */
function fingerSequence(events, tuning = TUNINGS.Standard, opts = {}) {
  const w = { ...FINGER_DEFAULTS, ...opts };
  const memo = new Map();
  const sets = events.map((e) => {
    if (!e || !e.midis || !e.midis.length) return [];
    const key = [...e.midis].sort((a, b) => a - b).join(",");
    if (!memo.has(key)) memo.set(key, fingerShapes(e.midis, tuning, w));
    return memo.get(key);
  });
  // Hand movement between consecutive shapes. With `window`, the hand is a span of `window`
  // frets: two shapes whose possible hand placements [hi−window+1, lo] overlap need no move.
  const moveCost = (a, b, gap) => {
    let d;
    if (w.window > 0) {
      if (!a.ext || !b.ext) return 0;
      const aLo = a.ext[1] - w.window + 1, aHi = a.ext[0], bLo = b.ext[1] - w.window + 1, bHi = b.ext[0];
      d = Math.max(0, bLo - aHi, aLo - bHi);
    } else {
      if (a.pos == null || b.pos == null) return 0;
      d = Math.abs(b.pos - a.pos);
    }
    let c = w.move * d;
    if (w.prior && w.prior.move) c += w.priorWeight * (w.prior.move[Math.min(d, w.prior.move.length - 1)] || 0);
    return gap >= w.restBeats ? c * 0.5 : c;
  };
  const crossCost = (a, b) => (w.cross && a.notes.length === 1 && b.notes.length === 1 ? w.cross * Math.abs(a.notes[0].string - b.notes[0].string) : 0);
  const picks = new Array(events.length).fill(null);
  let t0 = 0, total = 0;
  // Each run of playable events is decoded independently (an unplayable event breaks the chain).
  while (t0 < sets.length) {
    if (!sets[t0].length) { t0++; continue; }
    let t1 = t0;
    while (t1 + 1 < sets.length && sets[t1 + 1].length) t1++;
    let prev = sets[t0].map((s) => s.cost);
    const back = [null];
    for (let t = t0 + 1; t <= t1; t++) {
      const gap = events[t].gap || 0, cur = new Array(sets[t].length), bk = new Int32Array(sets[t].length);
      for (let j = 0; j < sets[t].length; j++) {
        const sh = sets[t][j];
        let best = Infinity, bi = 0;
        for (let i = 0; i < sets[t - 1].length; i++) {
          const c = prev[i] + moveCost(sets[t - 1][i], sh, gap) + crossCost(sets[t - 1][i], sh);
          if (c < best) { best = c; bi = i; }
        }
        cur[j] = best + sh.cost; bk[j] = bi;
      }
      back.push(bk); prev = cur;
    }
    let k = 0;
    for (let j = 1; j < prev.length; j++) if (prev[j] < prev[k]) k = j;
    total += prev[k];
    for (let t = t1; t >= t0; t--) { picks[t] = sets[t][k].notes; if (t > t0) k = back[t - t0][k]; }
    t0 = t1 + 1;
  }
  return { shapes: picks, cost: total };
}

/** Fill `frets` ({engIdx → fret}) on every event of a score that lacks them, by
 *  `fingerSequence` over the whole chart. Events that already carry frets (a tab
 *  read off the page / a GP file) keep them unless `opts.overwrite`. Returns a NEW
 *  score; the input is never mutated. Events gain `fingered: true` when the frets
 *  are inferred, so the UI and the exporters can tell a guess from a written tab. */
function fingerScore(score, opts = {}) {
  if (!score || !score.bars) return score;
  const tuning = opts.tuning || score.tuningMidi || TUNINGS[score.tuning] || TUNINGS.Standard;
  const flat = [];
  score.bars.forEach((b, bi) => (b.events || []).forEach((e, ei) => flat.push({ bi, ei, e })));
  const need = (e) => opts.overwrite || !e.frets || !Object.keys(e.frets).length;
  const seq = [];
  let lastEnd = null;
  for (const { bi, e } of flat) {
    const bpb = ((score.bars[bi].timeSig || score.timeSig || [4, 4])[0]);
    const on = bi * bpb + (e.qbeat ?? e.beat ?? 0), dur = e.qdur ?? e.durBeats ?? 1;
    seq.push({ midis: e.midis || [], gap: lastEnd == null ? 0 : Math.max(0, on - lastEnd) });
    lastEnd = on + dur;
  }
  const { shapes } = fingerSequence(seq, tuning, opts);
  const bars = score.bars.map((b) => ({ ...b, events: (b.events || []).map((e) => ({ ...e })) }));
  flat.forEach(({ bi, ei, e }, k) => {
    if (!need(e) || !shapes[k]) return;
    const frets = {};
    for (const n of shapes[k]) frets[n.string] = n.fret;
    bars[bi].events[ei] = { ...bars[bi].events[ei], frets, fingered: true };
  });
  return { ...score, bars };
}

/* ---- AlphaTex export (scoreToAlphaTex) -----------------------------------------
 * AlphaTex is alphaTab's text tab format: it states the STRING of every note, so a tab
 * renders exactly as fingered — no MusicXML→alphaTab string guessing (the proposal's
 * "normalization layer" is unnecessary when the format carries the string). Layout follows
 * alphaTab 1.8's own AlphaTexExporter, and the output is validated by alphaTab's parser in
 * tests: `fret.string{note props}.duration{beat props}`, chords `(f.s f.s).4`, bars `|`.
 *  - Strings: alphaTex counts 1 = highest; engine index 0 = low E, so s = n − engIdx.
 *  - Rhythm: each bar is spelled by the vocal-score quantiser (`_voiceNotationMeasures`,
 *    16th grid, meter-aware note values, ties as `{t}` on the continuation).
 *  - Notes without frets (audio / ML / transposed charts) are fingered by `fingerScore`.
 *  - Techniques (`event.tech`, `event.bends`): h · sl · nh · pm · lr · st · g · ac · x on the
 *    note, `b (0 q)` for a bend of q quarter-tones, `v` vibrato, `tt` tap on the beat.
 * Honest limit: triplets are rounded to the 16th grid (alphaTex `tu` is not emitted yet). */
// GP drum tracks carry an all-zero (or otherwise sub-audio) tuning.
const isPercussionTuning = (tuning) => !!tuning && tuning.filter((m) => m != null).every((m) => m < 20);
const _ATEX_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const _atexPitch = (m) => _ATEX_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const _atexStr = (s) => `"${String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const _ATEX_DUR = { whole: 1, half: 2, quarter: 4, eighth: 8, "16th": 16, "32nd": 32 };
// Key signature in alphaTex's compact form, spelled like the ABC K: line (Db not C#, d#minor not
// ebminor), so the staff's signature agrees with how every other exporter names the key. The
// spaced form "(C# minor)" is NOT safe: alphaTab 1.8 reads it as C# MAJOR (7 sharps).
const _atexKey = (key) => {
  const nm = _abcKeyName(key);
  return key.mode === "minor" ? nm.replace(/m$/, "").toLowerCase() + "minor" : nm;
};
const _ATEX_NOTE_TECH = { hammer: "h", slide: "sl", harmonic: "nh", palmMute: "pm", letRing: "lr", staccato: "st", ghost: "g", accent: "ac", dead: "x" };

function scoreToAlphaTex(score, opts = {}) {
  if (!score || !score.bars) return "";
  const tuning = opts.tuning || score.tuningMidi || TUNINGS[score.tuning] || TUNINGS.Standard;
  // A GP percussion track tunes every "string" to 0 — its numbers are drum keys, not frets.
  if (isPercussionTuning(tuning)) throw new Error("This is a drum/percussion track — it has no strings to write as tab.");
  // alphaTex string 1 = the highest string the instrument HAS (null slots are skipped).
  const keys = tuning.map((m, k) => (m == null ? -1 : k)).filter((k) => k >= 0);
  const atexString = (k) => keys.filter((x) => x > +k).length + 1;
  const sc = opts.finger === false ? score : fingerScore(score, { tuning });
  const refingered = opts.finger === false ? null : fingerScore(score, { tuning, overwrite: true });
  const L = [];
  if (opts.title) L.push(`\\title ${_atexStr(opts.title)}`);
  if (opts.composer) L.push(`\\artist ${_atexStr(opts.composer)}`);
  L.push(`\\track (${_atexStr(opts.trackName || "Guitar")})`);
  L.push(`  \\staff {${opts.notation === false ? "" : "score "}tabs}`);
  L.push(`    \\tuning (${keys.slice().reverse().map((k) => _atexPitch(tuning[k])).join(" ")})`);
  let lastSig = null, dropped = 0;
  sc.bars.forEach((bar, bi) => {
    const sig = bar.timeSig || sc.timeSig || [4, 4];
    const meta = [];
    if (!lastSig || sig[0] !== lastSig[0] || sig[1] !== lastSig[1]) meta.push(`\\ts (${sig[0]} ${sig[1]})`);
    if (bi === 0 && (opts.tempo || sc.tempo)) meta.push(`\\tempo ${Math.round(opts.tempo || sc.tempo)}`);
    if (bi === 0 && opts.key) meta.push(`\\ks ${_atexKey(opts.key)}`);
    if (bar.section) meta.push(`\\section ${_atexStr(bar.section)}`);
    if (bar.repeatStart) meta.push("\\ro");
    if (bar.repeatEnd) meta.push("\\rc 2");
    lastSig = sig;
    // Events that land on the same 16th are ONE tab slot: merge them into a chord (a strum or a
    // fast run would otherwise lose every note after the first — the quantiser keeps one item per
    // slot). A pitch already in the slot, or a slot already as wide as the instrument, is skipped.
    const tick = (x) => Math.round(x * (4 / sig[1]) * 4);
    const slots = new Map();
    (bar.events || []).forEach((e, ei) => {
      if (!e.midis || !e.midis.length) return;
      const on = e.qbeat ?? e.beat ?? 0, end = on + (e.qdur ?? e.durBeats ?? 1), t = tick(on);
      const alt = refingered ? refingered.bars[bi].events[ei] : null;
      const sl = slots.get(t);
      if (!sl) { slots.set(t, { on, end, parts: [{ e, alt }], midis: [...e.midis] }); return; }
      sl.end = Math.max(sl.end, end); sl.parts.push({ e, alt });
      for (const m of e.midis) if (!sl.midis.includes(m) && sl.midis.length < keys.length) sl.midis.push(m);
    });
    // Place every pitch on a string NOW, before the rhythm is spelled: the written fret when it
    // reconstructs the pitch on this tuning, else the re-fingered one, across the slot's events in
    // order (techniques come from the event that supplied the note). A pitch no string can play —
    // below the lowest open string or above the top fret, e.g. a bass note when Guitar → Tab hears a
    // full mix — is LEFT OUT and counted. It used to be dropped only at render time, which turned its
    // cell into a rest of the note's own value: syncopated, dotted rests in the middle of the bar
    // (r.2 r.8 r.4 r.8) where the audio actually had a note.
    for (const sl of slots.values()) {
      const used = new Set(), assign = [];
      for (const midi of sl.midis) {
        let s = null, fret = null, from = null;
        for (const part of sl.parts) {
          for (const src of [part.e, part.alt]) {
            if (!src || s != null) continue;
            for (const [k, f] of Object.entries(src.frets || {})) if (!used.has(k) && tuning[+k] + f === midi) { s = k; fret = f; from = part.e; break; }
          }
          if (s != null) break;
        }
        if (s == null) { dropped++; continue; }
        used.add(s); assign.push({ midi, s, fret, e: from });
      }
      sl.assign = assign; sl.midis = assign.map((a) => a.midi);
    }
    // One notation note per slot that kept a pitch, carrying the slot through the midis reference.
    const byMidis = new Map();
    const beatNotes = [...slots.values()].filter((sl) => sl.midis.length).map((sl) => {
      byMidis.set(sl.midis, sl);
      return { onsetBeat: sl.on, durBeat: sl.end - sl.on, midis: sl.midis };
    });
    const m = _voiceNotationMeasures(beatNotes, { beatsPerBar: sig[0], beatType: sig[1], minBars: 1 }).measures[0] || [];
    const cells = m.map((c) => {
      if (c.rest || c.wholeMeasure) {
        if (c.wholeMeasure) return `r.${sig[1] <= 1 ? 1 : 1}`;  // whole-measure rest
        return `r.${_ATEX_DUR[c.type] || 4}${c.dot ? "{d}" : ""}`;
      }
      const sl = byMidis.get(c.midis) || { parts: [], assign: [] };
      const notes = [];
      for (const { midi, s, fret, e } of sl.assign) {
        if (!c.midis.includes(midi)) continue;
        const props = [];
        if (c.tieStop) props.push("t");
        else {
          const tags = (e.tech && e.tech[s]) || [];
          for (const t of tags) if (_ATEX_NOTE_TECH[t]) props.push(_ATEX_NOTE_TECH[t]);
          if (tags.includes("bend")) props.push(`b (0 ${(e.bends && e.bends[s]) || 4})`);
        }
        notes.push(`${fret}.${atexString(s)}${props.length ? `{${props.join(" ")}}` : ""}`);
      }
      if (!notes.length) return `r.${_ATEX_DUR[c.type] || 4}${c.dot ? "{d}" : ""}`;
      const beatProps = [];
      if (c.dot) beatProps.push("d");
      if (!c.tieStop) {
        const all = sl.parts.flatMap((p) => Object.values(p.e.tech || {}).flat());
        if (all.includes("vibrato")) beatProps.push("v");
        if (all.includes("tap")) beatProps.push("tt");
      }
      const body = notes.length === 1 ? notes[0] : `(${notes.join(" ")})`;
      return `${body}.${_ATEX_DUR[c.type] || 4}${beatProps.length ? `{${beatProps.join(" ")}}` : ""}`;
    });
    L.push(`    ${meta.length ? meta.join(" ") + " " : ""}${cells.join(" ")} |`);
  });
  // Say so in the file (alphaTex comment) rather than leave silent gaps.
  if (dropped) L.unshift(`// ${dropped} note${dropped === 1 ? "" : "s"} outside this instrument's range (no string or fret can play ${dropped === 1 ? "it" : "them"}) left out`);
  return L.join("\n") + "\n";
}

/** Is this text an AlphaTex document (so an uploaded .alphatex opens in the tab viewer instead of
 *  being fed to the MusicXML parser)? Decided by the first real token: AlphaTex opens with a
 *  backslash metadata tag (\title, \track, \staff, \tuning, \tempo, \ts …), optionally after
 *  line or block comments and a BOM. A ChordPro {title:} file, LaTeX (\documentclass), XML and
 *  binary bytes all fail that test. Pure; used by the upload handler and tested headlessly. */
const _ATEX_HEAD = /^\\(title|subtitle|artist|album|words|music|copyright|tab|instructions|notices|tempo|track|staff|tuning|instrument|capo|ts|ks|clef|section|lyrics|chord|bank|defaultsystemslayout|systemslayout|hidedynamics|showdynamics|multibarrest|singletracktracknamepolicy|multitracktracknamepolicy|firstsystemtracknamemode|othersystemstracknamemode|firstsystemtracknameorientation|othersystemstracknameorientation|bracketextendmode|usesystemsignseparator)\b/i;
function isAlphaTexText(text) {
  if (typeof text !== "string" || !text) return false;
  let t = text.replace(/^\uFEFF/, "");
  for (let guard = 0; guard < 64; guard++) {
    t = t.replace(/^\s+/, "");
    if (t.startsWith("//")) { const nl = t.indexOf("\n"); t = nl < 0 ? "" : t.slice(nl + 1); continue; }
    if (t.startsWith("/*")) { const end = t.indexOf("*/"); t = end < 0 ? "" : t.slice(end + 2); continue; }
    break;
  }
  return _ATEX_HEAD.test(t);
}
/** Uploaded bytes → the AlphaTex text, or null when the file is anything else. Binary formats are
 *  rejected by their magic before decoding (zip/GP7-8 `PK`, GP6 `BCF`, GP3-5 `…FICHIER`, Power Tab
 *  `ptab`, `%PDF`), then the text must pass `isAlphaTexText`. */
function alphaTexFromBytes(bytes) {
  if (!bytes || !bytes.length) return null;
  const head = String.fromCharCode(...bytes.subarray(0, 32));
  if (/^(PK|BCF|%PDF|ptab)/.test(head) || /FICHIER GUITAR/.test(head)) return null;
  let text;
  try { text = new TextDecoder("utf-8").decode(bytes); } catch (_) { return null; }
  return isAlphaTexText(text) ? text : null;
}

/* ---- Brass / Horn / Sax section transposition ---------------------------
 * Every transposing instrument reads a written pitch that is SEMITONES ABOVE the
 * concert-pitch source. A Bb trumpet reads concert C as written D (+2). So
 * `transposeSemitones = written − sounding`. `transposeScore` (above) already
 * shifts every event's MIDI + re-labels the symbol, so a brass part is just the
 * concert score run through it, with the part-name and (for bass-clef targets)
 * clef swapped in the export.
 *
 * Standard catalog: the intervals every big-band chart uses. `midiProgram` is a
 * General-MIDI voice for optional playback previews. */
const BRASS_INSTRUMENTS = [
  { id: "trumpet-bb", name: "B♭ Trumpet", family: "brass", transposeSemitones: 2, clef: "treble", midiProgram: 56 },
  { id: "cornet-bb", name: "B♭ Cornet", family: "brass", transposeSemitones: 2, clef: "treble", midiProgram: 56 },
  { id: "flugelhorn-bb", name: "B♭ Flugelhorn", family: "brass", transposeSemitones: 2, clef: "treble", midiProgram: 56 },
  { id: "horn-f", name: "F Horn", family: "brass", transposeSemitones: 7, clef: "treble", midiProgram: 60 },
  { id: "trombone", name: "Trombone", family: "brass", transposeSemitones: 0, clef: "bass", midiProgram: 57 },
  { id: "bass-trombone", name: "Bass Trombone", family: "brass", transposeSemitones: 0, clef: "bass", midiProgram: 57 },
  { id: "euphonium", name: "Euphonium (BC)", family: "brass", transposeSemitones: 0, clef: "bass", midiProgram: 58 },
  { id: "euphonium-tc-bb", name: "B♭ Euphonium (TC)", family: "brass", transposeSemitones: 14, clef: "treble", midiProgram: 58 },
  { id: "tuba", name: "Tuba", family: "brass", transposeSemitones: 0, clef: "bass", midiProgram: 58 },
  { id: "soprano-sax-bb", name: "B♭ Soprano Sax", family: "sax", transposeSemitones: 2, clef: "treble", midiProgram: 64 },
  { id: "alto-sax-eb", name: "E♭ Alto Sax", family: "sax", transposeSemitones: 9, clef: "treble", midiProgram: 65 },
  { id: "tenor-sax-bb", name: "B♭ Tenor Sax", family: "sax", transposeSemitones: 14, clef: "treble", midiProgram: 66 },
  { id: "baritone-sax-eb", name: "E♭ Baritone Sax", family: "sax", transposeSemitones: 21, clef: "treble", midiProgram: 67 },
  { id: "clarinet-bb", name: "B♭ Clarinet", family: "woodwind", transposeSemitones: 2, clef: "treble", midiProgram: 71 },
  { id: "bass-clarinet-bb", name: "B♭ Bass Clarinet", family: "woodwind", transposeSemitones: 14, clef: "treble", midiProgram: 71 },
];

function getBrassInstrument(id) {
  for (let i = 0; i < BRASS_INSTRUMENTS.length; i++) if (BRASS_INSTRUMENTS[i].id === id) return BRASS_INSTRUMENTS[i];
  return null;
}

/* Emit ONE instrument's part as MusicXML. Runs the concert score through
 * `transposeScore` and swaps the <part-name> + (for bass-clef targets) the
 * treble G/2 clef for bass F/4. Any G-clef input becomes a horn-section-ready
 * part with correct written pitches. */
function scoreToBrassMusicXML(score, instrumentId, opts = {}) {
  const inst = getBrassInstrument(instrumentId);
  if (!inst) throw new Error("Unknown brass instrument: " + instrumentId);
  const tscore = transposeScore(score, inst.transposeSemitones, opts.useSharp !== false);
  let xml = scoreToMusicXML(tscore, opts);
  // Rename the part to this instrument.
  xml = xml.replace(/<part-name>[^<]*<\/part-name>/, "<part-name>" + inst.name + "</part-name>");
  // Bass-clef instruments: emit a <clef> in the first measure's attributes.
  // Base exporter writes <attributes> only when meter changes or the first bar
  // — inject a bass clef inside the first attributes block we see.
  if (inst.clef === "bass") {
    xml = xml.replace(/(<attributes>[\s\S]*?)(<\/attributes>)/,
      "$1        <clef><sign>F</sign><line>4</line></clef>\n      $2");
  }
  return xml;
}

/* Same for ABC. Simplest transposition: shift the score, run scoreToABC, adjust
 * the `V:1 clef=bass` line if this is a bass-clef instrument, and inject
 * `%%MIDI program N` so playback previews the right voice. */
function scoreToBrassABC(score, instrumentId, opts = {}) {
  const inst = getBrassInstrument(instrumentId);
  if (!inst) throw new Error("Unknown brass instrument: " + instrumentId);
  const tscore = transposeScore(score, inst.transposeSemitones, opts.useSharp !== false);
  // Transpose the K: too. If the caller supplied opts.key ({tonic, mode}) shift its
  // tonic; else analyze the concert score, shift THAT — so the written K: matches
  // the transposed pitches. `analyzeKey` returns { tonic, mode, confidence } and
  // scoreToABC expects that shape.
  let brassKey = opts.key || (typeof analyzeKey === "function" ? analyzeKey(score) : null);
  if (brassKey && typeof brassKey.tonic === "number") {
    brassKey = { ...brassKey, tonic: ((brassKey.tonic + inst.transposeSemitones) % 12 + 12) % 12 };
  }
  const abcOpts = { ...opts, key: brassKey };
  let abc = scoreToABC(tscore, abcOpts);
  if (inst.midiProgram != null) {
    abc = abc.replace(/(K:[^\n]*\n)/, "$1%%MIDI program " + inst.midiProgram + "\n");
  }
  if (inst.clef === "bass") {
    abc = abc.replace(/(K:[^\n]*\n)/, "$1V:1 clef=bass\n");
  }
  // Header line so the target instrument is visible in the exported file.
  abc = abc.replace(/(T:[^\n]*\n)/, "$1T: " + inst.name + " part\n");
  return abc;
}

/* Convenience: build a full brass section as { instrumentId → xml/abc } for the
 * requested output format. Emits one part per instrument (individual charts);
 * MusicXML full-score assembly is available on the finishing app (CSMP) — the
 * one-part-per-instrument shape is what section players actually rehearse from.
 * Returns [{ id, name, format, filename, content }]. */
function buildBrassSection(score, instrumentIds, opts = {}) {
  const fmt = opts.format === "abc" ? "abc" : "musicxml";
  const title = (opts.title || "part").replace(/[^A-Za-z0-9._\- ]+/g, "").trim() || "part";
  const parts = [];
  for (let i = 0; i < instrumentIds.length; i++) {
    const inst = getBrassInstrument(instrumentIds[i]);
    if (!inst) continue;
    const safeName = inst.name.replace(/[^A-Za-z0-9._\- ]+/g, "");
    const filename = title + "-" + safeName + (fmt === "abc" ? ".abc" : ".xml");
    const content = fmt === "abc" ? scoreToBrassABC(score, inst.id, opts) : scoreToBrassMusicXML(score, inst.id, opts);
    parts.push({ id: inst.id, name: inst.name, format: fmt, filename, content });
  }
  return parts;
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
  // Frames start N−hop before sample 0 and run past the end, so EVERY sample sits under the full
  // 4-frame overlap and wsum is constant. Starting at 0 left the first/last samples under only a
  // window's near-zero tip: dividing by that tiny wsum amplified the masked spectrum's leakage into a
  // burst (2× the input on a sine with minFreq on; ~3× a guitar track's whole energy). Same frame
  // grid, so the interior is unchanged.
  for (let s = -(N - hop); s < len; s += hop) {
    for (let i = 0; i < N; i++) { const p = s + i; const w = win[i]; const inb = p >= 0 && p < len; lr[i] = inb ? (left[p] || 0) * w : 0; li[i] = 0; rr[i] = inb ? (right[p] || 0) * w : 0; ri[i] = 0; }
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
    for (let i = 0; i < N; i++) { const p = s + i; if (p >= 0 && p < len) { out[p] += lr[i] * win[i]; wsum[p] += win[i] * win[i]; } }
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
  const vocab = resolveChordVocabulary(opts.vocabulary, opts.sixNine);
  for (const q of QUALITIES) {
    if (opts.maxRank != null && q.rank > opts.maxRank) continue;
    if (vocab && !vocab.allow.has(q.suffix)) continue;
    const wq = (vocab && vocab.writeAs[q.suffix]) || q;     // scored as q, named + voiced as wq
    for (let root = 0; root < 12; root++) {
      const vec = new Float64Array(12);
      for (const iv of q.intervals) vec[(root + iv) % 12] = 1;
      let n = 0; for (let p = 0; p < 12; p++) n += vec[p] * vec[p];
      n = Math.sqrt(n) || 1;
      for (let p = 0; p < 12; p++) vec[p] /= n;
      states.push({ root, quality: wq, vec });
    }
  }
  return states;
}

/* Mean chroma between consecutive beats (plus the segment's mean energy, for gating). */
/* Harmonic/percussive source separation (Fitzgerald 2010) — median filtering on the
 * magnitude spectrogram. Sustained pitched content forms HORIZONTAL ridges (stable
 * across time), transients form VERTICAL ridges (broadband, one frame). So:
 *   harmonic  ≈ median along TIME, percussive ≈ median along FREQUENCY,
 * and a soft Wiener-style mask splits the two. Standard preprocessing for chord
 * recognition — drums dump broadband energy into every chroma bin, and a kick or snare
 * on the downbeat is exactly where a chord label is most likely to be read.
 *
 * We only ever need the CHROMA, never the audio back, so this skips resynthesis: it
 * masks the magnitudes and folds straight to chroma. That also makes it cheaper than
 * the per-frame path it replaces, which recomputed an FFT per frame anyway.
 *
 * Returns per-frame { t, chroma, bass, energy } — same shape beatSegments consumes.
 * Pure. Opt-in via `hpss` (default on for the beat-sync path). */
function harmonicChromagram(samples, sampleRate, opts = {}) {
  const N = opts.window || 4096;
  const hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.12));
  const maxF = opts.maxFreq || 2000, minF = opts.minFreq || 55;
  const half = N >> 1;
  const topBin = Math.min(half - 1, Math.ceil((maxF * N) / sampleRate) + 2);
  const win = _hann(N);
  // 1) magnitude spectrogram (only the bins we can use)
  const mags = [], times = [], energies = [];
  for (let s = 0; s + N <= samples.length; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    let e = 0;
    for (let i = 0; i < N; i++) { const v = samples[s + i] || 0; re[i] = v * win[i]; e += v * v; }
    _fft(re, im);
    const m = new Float64Array(topBin + 1);
    for (let k = 0; k <= topBin; k++) m[k] = Math.hypot(re[k], im[k]);
    mags.push(m); times.push(s / sampleRate); energies.push(Math.sqrt(e / N));
  }
  const T = mags.length;
  if (!T) return [];
  // 2) median filters. kt spans ~0.4s of frames (harmonic), kf ~17 bins (percussive).
  /* Kernel sizes are SWEPT, not guessed — on the real Peg stem against time-aligned
   * ground truth, the plateau is tk≈21–23 frames / kf≈9 bins (root 53%), while the
   * naive 0.4s / 17-bin defaults gave 42%. The time kernel is expressed in SECONDS so
   * it adapts to `hopSec`: ~2.5s of median is what separates sustained harmony from
   * transients here. Tuned on one file, so treat the exact numbers as a plateau centre
   * rather than a global optimum. */
  const ktSec = opts.hpssTimeSec != null ? opts.hpssTimeSec : 2.5;
  const kt = Math.max(3, (opts.hpssTimeKernel || Math.round(ktSec / (hop / sampleRate))) | 1);
  const kf = Math.max(3, (opts.hpssFreqKernel || 9) | 1);
  /* Median of a small window, hot path: ~1M calls for a 4-minute track. Insertion sort
   * into a preallocated buffer beats slice()+sort(comparator) — no per-call allocation
   * and no comparator dispatch. n ≤ 31 here, where insertion sort is the right choice. */
  const sortBuf = new Float64Array(Math.max(kt, kf));
  const med = (n) => {
    for (let i = 1; i < n; i++) {
      const v = sortBuf[i]; let j = i - 1;
      while (j >= 0 && sortBuf[j] > v) { sortBuf[j + 1] = sortBuf[j]; j--; }
      sortBuf[j + 1] = v;
    }
    return sortBuf[(n - 1) >> 1];
  };
  const power = opts.hpssPower != null ? opts.hpssPower : 2;
  const pow = power === 2 ? (x) => x * x : (x) => Math.pow(x, power);
  const chromas = [], basses = [];
  const C0 = 16.351597831287414;
  const bassMin = opts.bassMinFreq || 40, bassMax = opts.bassMaxFreq || 250;
  for (let t = 0; t < T; t++) {
    const raw = new Array(12).fill(0), bassRaw = new Array(12).fill(0);
    for (let k = 1; k <= topBin; k++) {
      const f = (k * sampleRate) / N;
      const inMain = f >= minF && f <= maxF, inBass = f >= bassMin && f <= bassMax;
      if (!inMain && !inBass) continue;
      // harmonic estimate: median across time at this bin
      let n = 0;
      for (let j = t - (kt >> 1); j <= t + (kt >> 1); j++) sortBuf[n++] = mags[Math.min(T - 1, Math.max(0, j))][k];
      const h = med(n);
      // percussive estimate: median across frequency in this frame
      n = 0;
      for (let j = k - (kf >> 1); j <= k + (kf >> 1); j++) sortBuf[n++] = mags[t][Math.min(topBin, Math.max(0, j))];
      const p = med(n);
      const hp = pow(h), pp = pow(p);
      const mask = hp + pp > 0 ? hp / (hp + pp) : 0;          // soft Wiener mask
      const v = mags[t][k] * mask;
      const pc = ((Math.round(12 * Math.log2(f / C0)) % 12) + 12) % 12;
      if (inMain) raw[pc] += v;
      if (inBass) bassRaw[pc] += v;
    }
    const sup = opts.suppress != null ? opts.suppress : 0.3;
    const ch = raw.map((v, p) => Math.max(0, v - sup * Math.max(raw[((p - 7) % 12 + 12) % 12], raw[((p - 4) % 12 + 12) % 12])));
    const mx = Math.max(...ch) || 1, bmx = Math.max(...bassRaw) || 1;
    chromas.push(ch.map((v) => v / mx));
    basses.push(bassRaw.map((v) => v / bmx));
  }
  return times.map((t, i) => ({ t, chroma: chromas[i], bass: basses[i], energy: energies[i] }));
}

function beatSegments(samples, sampleRate, beats, opts = {}) {
  const win = opts.window || 4096;
  const hop = opts.hop || Math.floor(sampleRate * (opts.hopSec || 0.12));
  /* HPSS-filtered chromagram by default: drums dump broadband energy into every chroma
   * bin, and a kick/snare on the downbeat is exactly where a chord is most likely read.
   * `hpss:false` falls back to the plain per-frame chroma. */
  let frames;
  if (opts.hpss !== false) {
    frames = harmonicChromagram(samples, sampleRate, opts);
  } else {
    frames = [];
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
    // accumulate the run's bass evidence so an inversion can be named (below)
    if (cur && cur.root === o.root && cur.quality === o.quality) {
      cur.endSec = segs[t].t1;
      for (let p = 0; p < 12; p++) cur.bass[p] += segs[t].bass ? segs[t].bass[p] : 0;
      continue;
    }
    if (cur) events.push(cur);
    cur = { root: o.root, quality: o.quality, startSec: segs[t].t0, endSec: segs[t].t1, bass: new Float64Array(12) };
    for (let p = 0; p < 12; p++) cur.bass[p] += segs[t].bass ? segs[t].bass[p] : 0;
  }
  if (cur) events.push(cur);
  const useSharp = opts.useSharp !== false;
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  const slash = opts.slash !== false;
  return events.map((e) => {
    /* Inversions. The sliding path produced slash chords (via `recognise`'s bass rule)
     * and the beat-sync path did not — it emitted plain root-position symbols, which is
     * a real loss of information for a fake book. We already measure a bass-register
     * chroma per beat, so name the inversion when the run's dominant bass pitch class is
     * a CHORD TONE other than the root. Restricting it to chord tones is what keeps a
     * walking/passing bass note from inventing a slash. */
    let bassPc = -1, bMax = 0;
    for (let p = 0; p < 12; p++) if (e.bass[p] > bMax) { bMax = e.bass[p]; bassPc = p; }
    const tones = e.quality.intervals.map((i) => (e.root + i) % 12);
    const inv = slash && bMax > 0 && bassPc !== e.root && tones.indexOf(bassPc) >= 0;
    return {
      symbol: names[e.root] + e.quality.suffix + (inv ? "/" + names[bassPc] : ""),
      midis: e.quality.intervals.map((i) => 48 + e.root + i),
      startSec: +e.startSec.toFixed(3),
      durSec: +(e.endSec - e.startSec).toFixed(3),
    };
  });
}

/* The audio panel's one entry point: chords AND the tempo that produced them, so the
 * bpm control can be filled in from the audio instead of guessed. Beat-synchronous by
 * default; falls back to the sliding-window path when no beat grid can be found (very
 * short clips, or material with no discernible pulse — a rubato solo piano intro), so
 * a result is always produced. Returns { events, bpm, beats, method }. */
function analyzeAudioChords(samples, sampleRate, opts = {}) {
  /* SynHarmonics v2 (NNLS front-end + HMM posteriors) is the default since 2026-10-21:
   * measured on the held-out half of the rendered-stem benchmark (tests/bench), root
   * 54→76%, majmin 47→76%, sevenths 42→70%, bass 43→75% (docs/SYNHARMONICS-V2.md). `engine:"v1"`
   * keeps the original HPSS-chroma + Viterbi path below, unchanged. */
  if (opts.engine !== "v1") {
    const r = analyzeAudioChordsV2(samples, sampleRate, opts);
    if (r.events.length || !samples || samples.length < sampleRate) return r;
  }
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

/* ============================================================================
 *  SYNHARMONICS v2 — isolated-stem chord recognition (Stages A · C · D)
 *  ---------------------------------------------------------------------------
 *  The v2.0 engineering spec (docs/SYNHARMONICS-V2.md) applied to THIS app's
 *  constraints: zero-dep, zero-server, iOS-Safari-first, worker-safe, no training
 *  data → no learned TCN. Every stage below is the published, deterministic MIR
 *  method the spec names as its baseline, and every one was MEASURED on the
 *  rendered-stem benchmark (tests/bench) before it was allowed to stay:
 *
 *   Stage A  front-end   anti-aliased resampling → log-frequency spectrogram
 *                        (3 bins/semitone) → HPSS in log-frequency → GLOBAL TUNING
 *                        (peak-interpolated, reliability-shrunk) + re-centre → NNLS
 *                        approximate note transcription (Mauch & Dixon 2010, "Chordino")
 *                        → BASS from the lowest real note (sub-octave guarded), TREBLE
 *                        from NNLS blended with harmonic salience. Kills the overtone
 *                        bleed that fakes chord tones (Bb's 3rd harmonic F turning Gm/Bb
 *                        into Bb6) without starving a triad's real 5th.
 *   Stage C  posterior   an HMM over (root × quality × bass) states with a no-chord
 *                        state; FORWARD-BACKWARD posteriors per beat; entropy confidence
 *                        `1 − H(p)/log K`; ranked alternatives for ambiguous events.
 *                        Inversions are STATES (C/E ≠ Em because their treble differs),
 *                        not a post-hoc relabel.
 *   Stage D  context     bidirectional context = forward-backward (default); plus OPT-IN
 *                        repetition-aware chroma smoothing (Mauch, Noland & Dixon 2009) —
 *                        v2 §5.3's "structural block conditioning" with no model. Opt-in
 *                        because on held-out data it trades ~+1 sevenths for ~−1.2 seg.
 *
 *  What is deliberately NOT here (and why): a learned TCN/Transformer (no annotated
 *  audio to train on, and the iOS/Pages no-WASM-threads wall); causal/streaming mode
 *  (the app decodes files, not a live feed — display mode only); downbeats (pure-DSP
 *  downbeat cues measured near-chance on real material — see CLAUDE.md).
 * ------------------------------------------------------------------------- */

/* ---- anti-aliased resampling (Kaiser-windowed sinc) -----------------------
 * The Audio panel used to downsample with a box average (`dsChan`): a 2-tap mean has
 * only −3 dB at the new Nyquist, so cymbal/hat energy at 18–22 kHz folds straight down
 * into the 0–4 kHz band the chroma reads. This is a proper low-pass: Kaiser β=8.6
 * (~−80 dB stopband), cutoff at 0.85 × the lower Nyquist, linear-interpolated kernel
 * table. Pure; any ratio. */
function _besselI0(x) {
  let s = 1, t = 1;
  for (let k = 1; k < 40; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-14 * s) break; }
  return s;
}
function resampleTo(samples, srIn, srOut, opts = {}) {
  if (!samples || !samples.length || !(srIn > 0) || !(srOut > 0)) return new Float32Array(0);
  if (Math.abs(srIn - srOut) < 1e-9) return Float32Array.from(samples);
  const ratio = srOut / srIn;
  const cutoff = (opts.cutoff || 0.85) * Math.min(1, ratio);     // fraction of the INPUT Nyquist
  const zc = opts.zeroCrossings || 8, beta = opts.beta || 8.6;
  const width = zc / cutoff;                                      // kernel half-width, input samples
  const RES = 256, tl = Math.ceil(width * RES) + 2, i0b = _besselI0(beta);
  const tab = new Float64Array(tl);
  for (let i = 0; i < tl; i++) {
    const x = i / RES;
    if (x >= width) continue;
    const sx = x * cutoff, r = x / width;
    const sinc = sx === 0 ? 1 : Math.sin(Math.PI * sx) / (Math.PI * sx);
    tab[i] = cutoff * sinc * (_besselI0(beta * Math.sqrt(1 - r * r)) / i0b);
  }
  const outLen = Math.floor(samples.length * ratio), out = new Float32Array(outLen), last = samples.length - 1;
  for (let n = 0; n < outLen; n++) {
    const c = n / ratio, lo = Math.max(0, Math.ceil(c - width)), hi = Math.min(last, Math.floor(c + width));
    let acc = 0;
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(i - c) * RES, k = d | 0;
      acc += samples[i] * (tab[k] + (d - k) * (tab[k + 1] - tab[k]));
    }
    out[n] = acc;
  }
  return out;
}

/* ---- Stage A: log-frequency spectrogram ----------------------------------
 * 3 bins per semitone (Chordino's resolution — enough to MEASURE tuning, which a
 * nearest-semitone fold cannot), from `minMidi` to `maxMidi`. STFT frames are paired
 * into one complex FFT (two real signals for the price of one). Each log bin is the
 * triangular-weighted mean of the FFT bins within ±1/3 semitone of its centre, or a
 * linear interpolation where the FFT grid is coarser than the log grid (the bass). */
const _LF_BPS = 3;
function _lfMap(N, sampleRate, minMidi, J) {
  const map = [];
  const binHz = sampleRate / N;
  for (let j = 0; j < J; j++) {
    const fc = 440 * Math.pow(2, (minMidi + j / _LF_BPS - 69) / 12);
    const fLo = fc * Math.pow(2, -1 / (12 * _LF_BPS)), fHi = fc * Math.pow(2, 1 / (12 * _LF_BPS));
    const k0 = Math.max(1, Math.ceil(fLo / binHz)), k1 = Math.min((N >> 1) - 1, Math.floor(fHi / binHz));
    const idx = [], w = [];
    for (let k = k0; k <= k1; k++) {
      const d = Math.abs(Math.log2((k * binHz) / fc)) * 12 * _LF_BPS;
      if (d < 1) { idx.push(k); w.push(1 - d); }
    }
    let ws = 0; for (const x of w) ws += x;
    if (ws < 1) {                                                // coarse grid → interpolate at fc
      const kf = fc / binHz, kk = Math.floor(kf), fr = kf - kk;
      map.push({ idx: [kk, kk + 1], w: [1 - fr, fr], norm: 1 });
    } else map.push({ idx, w, norm: ws });
  }
  return map;
}
function logFreqSpectrogram(samples, sampleRate, opts = {}) {
  const minMidi = opts.minMidi != null ? opts.minMidi : 26;        // D1 — below the lowest bass partial we use
  const maxMidi = opts.maxMidi != null ? opts.maxMidi : 107;       // B7 (~3.95 kHz): room for treble harmonics
  // nearest power of two to `winSec` (0.25 s → 4096 at both 16 kHz and 22.05 kHz)
  const winSec = opts.winSec || 0.25;
  let N = Math.pow(2, Math.max(9, Math.round(Math.log2(winSec * sampleRate))));
  while (N > samples.length && N > 512) N >>= 1;
  const hop = Math.max(1, Math.round(sampleRate * (opts.hopSec || 0.1)));
  const topMidi = Math.min(maxMidi, 69 + 12 * Math.log2((0.48 * sampleRate) / 440));
  const J = Math.max(1, Math.floor((topMidi - minMidi) * _LF_BPS) + 1);
  const map = _lfMap(N, sampleRate, minMidi, J);
  const win = _hann(N), half = N >> 1;
  const starts = [];
  for (let s = 0; s + N <= samples.length; s += hop) starts.push(s);
  const T = starts.length;
  const spec = new Array(T), energy = new Float64Array(T);
  const re = new Float64Array(N), im = new Float64Array(N), magA = new Float64Array(half), magB = new Float64Array(half);
  /* Tuning evidence, gathered while the linear spectrum is at hand: every clear spectral
   * peak (80 Hz–2 kHz, ≥ −20 dB of the frame's loudest) is located to a fraction of a
   * bin by parabolic interpolation on log-magnitude, and its deviation from the nearest
   * equal-tempered semitone is accumulated as a CIRCULAR mean (±50¢ wraps). Measuring
   * on the linear spectrum is what keeps it unbiased — folding linear bins into log bins
   * first skews a peak's apparent position by ~10¢. */
  let tc = 0, ts = 0, tw = 0;
  const binHz = sampleRate / N, kLo = Math.max(2, Math.ceil(80 / binHz)), kHi = Math.min(half - 2, Math.floor(2000 / binHz));
  const tunePeaks = (mag) => {
    let mx = 0; for (let k = kLo; k <= kHi; k++) if (mag[k] > mx) mx = mag[k];
    if (!(mx > 0)) return;
    for (let k = kLo; k <= kHi; k++) {
      const v = mag[k];
      if (v < 0.1 * mx || v <= mag[k - 1] || v < mag[k + 1]) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(v + 1e-12), c = Math.log(mag[k + 1] + 1e-12), den = a - 2 * b + c;
      const d = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
      const cents = 1200 * Math.log2(((k + d) * binHz) / 440);
      const ph = (2 * Math.PI * (cents - 100 * Math.round(cents / 100))) / 100;
      tc += v * Math.cos(ph); ts += v * Math.sin(ph); tw += v;
    }
  };
  const fold = (mag, t) => {
    const row = new Float32Array(J);
    for (let j = 0; j < J; j++) {
      const m = map[j]; let v = 0;
      for (let q = 0; q < m.idx.length; q++) v += m.w[q] * mag[m.idx[q]];
      row[j] = v / m.norm;
    }
    spec[t] = row;
  };
  for (let t = 0; t < T; t += 2) {
    const a = starts[t], b = t + 1 < T ? starts[t + 1] : -1;
    let ea = 0, eb = 0;
    for (let i = 0; i < N; i++) {
      const va = samples[a + i] || 0; re[i] = va * win[i]; ea += va * va;
      if (b >= 0) { const vb = samples[b + i] || 0; im[i] = vb * win[i]; eb += vb * vb; } else im[i] = 0;
    }
    _fft(re, im);
    for (let k = 1; k < half; k++) {                              // split the two real spectra
      const rk = re[k], ik = im[k], rn = re[N - k], inn = im[N - k];
      magA[k] = 0.5 * Math.hypot(rk + rn, ik - inn);
      magB[k] = 0.5 * Math.hypot(ik + inn, rn - rk);
    }
    fold(magA, t); energy[t] = Math.sqrt(ea / N); tunePeaks(magA);
    if (b >= 0) { fold(magB, t + 1); energy[t + 1] = Math.sqrt(eb / N); tunePeaks(magB); }
  }
  const times = starts.map((s) => (s + N / 2) / sampleRate);   // frame CENTRE
  const tuning = tc || ts ? (100 * Math.atan2(ts, tc)) / (2 * Math.PI) : 0;
  const tuningR = tw > 0 ? Math.hypot(tc, ts) / tw : 0;              // circular resultant: 1 = every peak agrees
  return { spec, times, energy, J, minMidi, bps: _LF_BPS, N, hop, sampleRate, tuning, tuningR };
}

/* Median-filter HPSS on the log-frequency spectrogram (in place). Same idea as
 * `harmonicChromagram`, but in log-frequency it is ~10× cheaper (≈250 bins, not
 * ≈2500) and the frequency kernel spans a fixed MUSICAL width at every register. */
function _hpssLogFreq(spec, opts = {}) {
  const T = spec.length; if (!T) return;
  const J = spec[0].length;
  const kt = Math.max(3, (opts.hpssTimeFrames | 0) | 1), kf = Math.max(3, (opts.hpssFreqBins || 13) | 1);
  const buf = new Float64Array(Math.max(kt, kf));
  const med = (n) => {
    for (let i = 1; i < n; i++) { const v = buf[i]; let j = i - 1; while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; } buf[j + 1] = v; }
    return buf[(n - 1) >> 1];
  };
  const out = new Array(T);
  for (let t = 0; t < T; t++) {
    const row = new Float32Array(J);
    for (let j = 0; j < J; j++) {
      let n = 0;
      for (let q = t - (kt >> 1); q <= t + (kt >> 1); q++) buf[n++] = spec[Math.min(T - 1, Math.max(0, q))][j];
      const h = med(n);
      n = 0;
      for (let q = j - (kf >> 1); q <= j + (kf >> 1); q++) buf[n++] = spec[t][Math.min(J - 1, Math.max(0, q))];
      const p = med(n);
      const hh = h * h, pp = p * p;
      row[j] = hh + pp > 0 ? spec[t][j] * (hh / (hh + pp)) : 0;
    }
    out[t] = row;
  }
  for (let t = 0; t < T; t++) spec[t] = out[t];
}

/* Re-centre the log-frequency grid on the measured tuning: spec[t][j] ← spec[t][j + shift].
 * Real recordings drift (vintage varispeed, a band tuned to a piano, a capo'd guitar a
 * little sharp); at ±40¢ a nearest-semitone fold splits every note across two pitch
 * classes. The tuning itself is measured in logFreqSpectrogram (peak interpolation). */
function _shiftBins(spec, shift) {                                // spec[t][j] ← spec[t][j + shift] (linear interp)
  if (Math.abs(shift) < 1e-3) return;
  for (let t = 0; t < spec.length; t++) {
    const row = spec[t], J = row.length, o = new Float32Array(J);
    for (let j = 0; j < J; j++) {
      const x = j + shift, k = Math.floor(x), f = x - k;
      const a = k >= 0 && k < J ? row[k] : 0, b = k + 1 >= 0 && k + 1 < J ? row[k + 1] : 0;
      o[j] = a + f * (b - a);
    }
    spec[t] = o;
  }
}

/* ---- NNLS approximate transcription --------------------------------------
 * Each note's log-frequency PROFILE is its harmonic series (partial h at
 * 3·12·log2(h) bins above the fundamental, amplitude s^(h−1), s = 0.7 as in Chordino)
 * spread over ±1.5 bins. A frame's whitened spectrum b is explained as A·x with x ≥ 0
 * (Lawson–Hanson active set, on the Gram matrix so each solve is |P|×|P|). Because a
 * note's overtones are part of ITS column, the 3rd harmonic of B♭ is attributed to B♭
 * — it no longer appears as an F. */
const _nnlsDictCache = new Map();
function _nnlsDict(J, minMidi, noteLo, noteHi, s, H) {
  const key = [J, minMidi, noteLo, noteHi, s, H].join(",");
  let d = _nnlsDictCache.get(key);
  if (d) return d;
  const notes = [], cols = [];
  for (let m = noteLo; m <= noteHi; m++) {
    const col = new Float64Array(J);
    for (let h = 1; h <= H; h++) {
      const pos = (m - minMidi + 12 * Math.log2(h)) * _LF_BPS;
      if (pos > J - 1 + 1.5) break;
      const amp = Math.pow(s, h - 1);
      for (let j = Math.max(0, Math.ceil(pos - 1.5)); j <= Math.min(J - 1, Math.floor(pos + 1.5)); j++) {
        const x = (j - pos) / 1.5;
        col[j] += amp * Math.cos((Math.PI / 2) * x) * Math.cos((Math.PI / 2) * x);
      }
    }
    let n = 0; for (let j = 0; j < J; j++) n += col[j] * col[j];
    n = Math.sqrt(n) || 1;
    const idx = [], val = [];
    for (let j = 0; j < J; j++) if (col[j] > 1e-6) { idx.push(j); val.push(col[j] / n); }
    notes.push(m); cols.push({ idx: Int32Array.from(idx), val: Float64Array.from(val) });
  }
  const M = notes.length, G = new Float64Array(M * M);
  for (let a = 0; a < M; a++) {
    const dense = new Float64Array(J);
    for (let q = 0; q < cols[a].idx.length; q++) dense[cols[a].idx[q]] = cols[a].val[q];
    for (let b = a; b < M; b++) {
      let v = 0;
      for (let q = 0; q < cols[b].idx.length; q++) v += dense[cols[b].idx[q]] * cols[b].val[q];
      G[a * M + b] = G[b * M + a] = v;
    }
  }
  d = { notes, cols, G, M };
  _nnlsDictCache.set(key, d);
  return d;
}
/* Lawson–Hanson NNLS given the Gram matrix G (M×M) and c = Aᵀb. Returns x ≥ 0. */
function _nnlsGram(G, c, M, maxIter) {
  const x = new Float64Array(M), inP = new Uint8Array(M), w = new Float64Array(M);
  const P = [];
  const tol = 1e-10;
  const solveP = () => {                                          // Cholesky on G[P,P] z = c[P]
    const n = P.length, L = new Float64Array(n * n), z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let v = G[P[i] * M + P[j]];
        for (let k = 0; k < j; k++) v -= L[i * n + k] * L[j * n + k];
        if (i === j) L[i * n + i] = Math.sqrt(Math.max(v, 1e-12)); else L[i * n + j] = v / L[j * n + j];
      }
    }
    for (let i = 0; i < n; i++) { let v = c[P[i]]; for (let k = 0; k < i; k++) v -= L[i * n + k] * z[k]; z[i] = v / L[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let v = z[i]; for (let k = i + 1; k < n; k++) v -= L[k * n + i] * z[k]; z[i] = v / L[i * n + i]; }
    return z;
  };
  let iter = 0;
  const lim = maxIter || 3 * M;
  for (;;) {
    for (let j = 0; j < M; j++) { let v = c[j]; for (const p of P) v -= G[j * M + p] * x[p]; w[j] = v; }
    let t = -1, best = tol;
    for (let j = 0; j < M; j++) if (!inP[j] && w[j] > best) { best = w[j]; t = j; }
    if (t < 0 || iter++ > lim) break;
    inP[t] = 1; P.push(t);
    for (let inner = 0; inner < 3 * M; inner++) {
      const z = solveP();
      let allPos = true;
      for (let i = 0; i < P.length; i++) if (z[i] <= tol) { allPos = false; break; }
      if (allPos) { for (let i = 0; i < P.length; i++) x[P[i]] = z[i]; break; }
      let alpha = Infinity;
      for (let i = 0; i < P.length; i++) if (z[i] <= tol) { const a = x[P[i]] / (x[P[i]] - z[i]); if (a < alpha) alpha = a; }
      if (!isFinite(alpha)) alpha = 0;
      for (let i = 0; i < P.length; i++) x[P[i]] += alpha * (z[i] - x[P[i]]);
      for (let i = P.length - 1; i >= 0; i--) if (x[P[i]] <= tol) { x[P[i]] = 0; inP[P[i]] = 0; P.splice(i, 1); }
      if (!P.length) break;
    }
  }
  return x;
}

/* Bass / treble pitch profiles (MIDI-weighted, as Chordino's). The bass profile
 * covers the register a bass line or a guitar's low strings live in; treble starts
 * an octave higher and carries the chord colour. Overlap in the middle is deliberate
 * — a guitar's 5th-string root is both. */
function _bassWeight(m) { return m <= 47 ? 1 : m >= 60 ? 0 : (60 - m) / 13; }
function _trebleWeight(m) { return m <= 40 ? 0 : m >= 52 ? (m > 88 ? Math.max(0.3, 1 - (m - 88) / 16) : 1) : (m - 40) / 12; }

/* PCM → NNLS chroma frames { t, chroma (treble), bass, level (dB) } + { tuning }.
 * The frame shape is the one `beatSegments` already consumes (plus `level`), so the
 * downstream segmentation is shared. */
function nnlsChromagram(samples, sampleRate, opts = {}) {
  const lf = logFreqSpectrogram(samples, sampleRate, opts);
  const { spec, times, J, minMidi } = lf;
  const T = spec.length;
  if (!T) return { frames: [], tuning: 0 };
  // raw level per frame (dB), BEFORE any masking — the gate's evidence
  const level = new Float64Array(T);
  for (let t = 0; t < T; t++) { let e = 0; const r = spec[t]; for (let j = 0; j < J; j++) e += r[j] * r[j]; level[t] = 10 * Math.log10(e + 1e-20); }
  if (opts.hpss !== false) {
    const hopS = lf.hop / sampleRate;
    _hpssLogFreq(spec, { hpssTimeFrames: Math.round((opts.hpssTimeSec != null ? opts.hpssTimeSec : 0.6) / hopS), hpssFreqBins: opts.hpssFreqBins });
  }
  /* Compensation is SHRUNK by the estimate's own reliability (the circular resultant R:
   * 1 = every spectral peak agrees on the offset). In-tune instruments read R ≈ 0.6–1;
   * a sung line with vibrato/portamento reads R ≈ 0.04–0.3, where the "offset" is mostly
   * the singer's pitch drift — re-centring the grid on that would mis-place every note. */
  const rel = Math.max(0, Math.min(1, (lf.tuningR - 0.15) / 0.35));
  const tuning = opts.tuning != null ? opts.tuning : opts.estimateTuning === false ? 0 : lf.tuning * rel;
  _shiftBins(spec, (tuning / 100) * _LF_BPS);
  // optional spectral whitening (running mean/std over ±`whitenBins` log bins). OFF by
  // default: Chordino uses it, but here it cost 6–8 majmin points on the dev split.
  const wb = opts.whitenBins != null ? opts.whitenBins : 0, wexp = opts.whitening != null ? opts.whitening : 1;
  const noteLo = opts.noteLo != null ? opts.noteLo : 28, noteHi = opts.noteHi != null ? opts.noteHi : 96;
  const dict = _nnlsDict(J, minMidi, noteLo, noteHi, opts.spectralShape != null ? opts.spectralShape : 0.8, opts.partials || 16);
  const { notes, cols, G, M } = dict;
  const frames = new Array(T);
  const b = new Float64Array(J), c = new Float64Array(M);
  const cs = new Float64Array(J + 1), cs2 = new Float64Array(J + 1);
  for (let t = 0; t < T; t++) {
    const row = spec[t];
    cs[0] = 0; cs2[0] = 0;
    for (let j = 0; j < J; j++) { cs[j + 1] = cs[j] + row[j]; cs2[j + 1] = cs2[j] + row[j] * row[j]; }
    for (let j = 0; j < J; j++) {
      const lo = Math.max(0, j - wb), hi = Math.min(J, j + wb + 1), n = hi - lo;
      const mu = (cs[hi] - cs[lo]) / n, sd = Math.sqrt(Math.max(1e-24, (cs2[hi] - cs2[lo]) / n - mu * mu));
      b[j] = wb > 0 ? (row[j] > mu ? (row[j] - mu) / Math.pow(sd, wexp) : 0) : row[j];
    }
    for (let a = 0; a < M; a++) { let v = 0; const col = cols[a]; for (let q = 0; q < col.idx.length; q++) v += col.val[q] * b[col.idx[q]]; c[a] = v; }
    const x = opts.nnls === false ? Float64Array.from(c, (v) => Math.max(0, v)) : _nnlsGram(G, c, M);
    const tr = new Float64Array(12), bs = new Float64Array(12);
    let xmax = 0;
    for (let a = 0; a < M; a++) if (x[a] > xmax) xmax = x[a];
    /* TREBLE = an even blend of the NNLS activations and the raw harmonic SALIENCE
     * (c = Aᵀb, the energy summed over each note's partials). Measured, not assumed:
     * NNLS alone wins root/majmin but under-weights real chord tones that coincide with
     * another note's overtones (a triad's 5th IS its root's 3rd harmonic), costing the
     * 7th/extension detail — sevenths −2.8 and exact pitch-set −1.6 on the held-out
     * half. The blend keeps most of the root accuracy and recovers the quality. The BASS
     * stays pure NNLS (+6 bass accuracy over salience — overtones must not pick the bass). */
    const trebleSrc = opts.treble || "blend";
    if (trebleSrc === "nnls" || opts.nnls === false) { for (let a = 0; a < M; a++) if (x[a] > 0) tr[notes[a] % 12] += x[a] * _trebleWeight(notes[a]); }
    else {
      let cmax = 0; for (let a = 0; a < M; a++) if (c[a] > cmax) cmax = c[a];
      const blend = trebleSrc === "blend" ? (opts.trebleBlend != null ? opts.trebleBlend : 0.5) : 1;
      for (let a = 0; a < M; a++) {
        const sal = c[a] > 0 && cmax > 0 ? c[a] / cmax : 0, nn = xmax > 0 ? x[a] / xmax : 0;
        const v = blend * sal + (1 - blend) * nn;
        if (v > 0) tr[notes[a] % 12] += v * _trebleWeight(notes[a]);
      }
    }
    /* BASS = the lowest note that is really sounding (≥ `bassRatio` of the frame's
     * strongest note), not a register-weighted sum: a voicing with its 5th on the bottom
     * (C/G) still has its root an octave up, and a summed profile lets that root outvote
     * the true bass. The ear hears the LOWEST note as the bass; so does this. */
    const br = opts.bassRatio != null ? opts.bassRatio : 0.4;
    /* SUB-OCTAVE GUARD. NNLS's classic ambiguity: a note an octave (or a 12th) below a
     * real one shares most of its partials, so a phantom E3 can activate under a
     * B3–E4–G4 voicing — and the phantom is LOWER, so it would be read as the bass. A
     * real note has energy at its OWN fundamental; a phantom does not. Bass evidence is
     * scaled by the spectrum's level at the candidate's fundamental bin. */
    let rmax = 0; for (let j = 0; j < J; j++) if (row[j] > rmax) rmax = row[j];
    const fr0 = opts.fundamentalRatio != null ? opts.fundamentalRatio : 0.05;
    const fund = (m) => {
      if (!(rmax > 0) || fr0 <= 0) return 1;
      const j0 = Math.round((m - minMidi) * _LF_BPS);
      let v = 0; for (let j = Math.max(0, j0 - 1); j <= Math.min(J - 1, j0 + 1); j++) if (row[j] > v) v = row[j];
      return Math.min(1, v / (fr0 * rmax));
    };
    const mode = opts.bassMode || "blend";
    if (mode !== "lowest") for (let a = 0; a < M; a++) if (x[a] > 0 && _bassWeight(notes[a]) > 0) bs[notes[a] % 12] += x[a] * _bassWeight(notes[a]) * fund(notes[a]);
    if (mode !== "profile") {
      let pm = 0; for (let p = 0; p < 12; p++) if (bs[p] > pm) pm = bs[p];
      const lw = mode === "lowest" ? 1 : (opts.lowestWeight != null ? opts.lowestWeight : 1);
      for (let a = 0; a < M; a++) if (x[a] >= br * xmax && x[a] > 0 && notes[a] <= 64 && fund(notes[a]) >= 1) { bs[notes[a] % 12] += lw * (pm || x[a]); break; }
    }
    frames[t] = { t: times[t], chroma: tr, bass: bs, level: level[t], energy: lf.energy[t] };
  }
  return { frames, tuning, tuningMeasured: lf.tuning, tuningReliability: +lf.tuningR.toFixed(3) };
}

/* ---- Stage C: chord states with inversions -------------------------------
 * State = (root, quality, bass pc). Root position for every quality; for the plain
 * triads/7ths (rank ≤ 14, three or four tones, not power/sus) also each NON-root
 * chord tone in the bass. The treble template is the chord's pitch-class set (unit
 * norm); the bass "template" is one pitch class. C/E and Em share a bass but not a
 * treble, so the joint model separates them where the old post-hoc relabel could not. */
function chordStatesV2(opts = {}) {
  const states = [];
  const inv = opts.inversions !== false;
  const vocab = resolveChordVocabulary(opts.vocabulary, opts.sixNine);
  for (const q of QUALITIES) {
    if (opts.maxRank != null && q.rank > opts.maxRank) continue;
    if (vocab && !vocab.allow.has(q.suffix)) continue;
    const invertible = inv && q.rank <= 14 && q.intervals.length >= 3 && q.intervals.length <= 4;
    /* Without a vocabulary every chord tone may be the bass, written as a slash. A vocabulary
     * lists the inversions it writes and the ones it decodes but writes in root position
     * (CHORD_VOCABULARIES `hidden`); every other bass is not a state. */
    const shown = vocab ? (invertible ? vocab.inversions[q.suffix] || [] : []) : null;
    const invIv = !vocab ? (invertible ? q.intervals : [0]) : [0, ...shown, ...(invertible ? vocab.hidden[q.suffix] || [] : [])];
    const foreignIv = vocab ? vocab.foreign[q.suffix] || [] : null;
    const writeQ = vocab && vocab.writeAs[q.suffix] ? vocab.writeAs[q.suffix] : null;   // detected q, written writeQ
    for (let root = 0; root < 12; root++) {
      const vec = new Float64Array(12);
      for (const iv of q.intervals) vec[(root + iv) % 12] = 1;
      const nrm = Math.sqrt(q.intervals.length);
      for (let p = 0; p < 12; p++) vec[p] /= nrm;
      for (const iv of invIv) states.push({ root, quality: q, writeQ, vec, bassPc: (root + iv) % 12, inversion: iv !== 0, showBass: iv !== 0 && (!shown || shown.indexOf(iv) >= 0) });
      /* Triads over a FOREIGN bass — D/C, F/G, Bb/C (the sus-dominant voicing), F#m/G.
       * Everywhere in pop/jazz comping, and unrepresentable as a chord-tone inversion.
       * A separate, larger prior (`slashPenalty`) keeps a passing bass note from
       * inventing one: it must be the bass for long enough to outweigh it. */
      if (opts.slashChords !== false && (q.suffix === "" || q.suffix === "m")) {
        for (let bp = 0; bp < 12; bp++) {
          const iv = (bp - root + 12) % 12;
          if (q.intervals.indexOf(iv) >= 0 || (foreignIv && foreignIv.indexOf(iv) < 0)) continue;
          states.push({ root, quality: q, vec, bassPc: bp, inversion: true, foreign: true, showBass: true });
        }
      }
    }
  }
  return states;
}

/* Emission score per (beat, state). Cosine of the treble chroma to the template, plus
 * the bass register's vote for the state's bass note, minus a rarity prior (`rank`,
 * as in `recognise`) and an inversion prior; optional diatonic key bonus. */
function _emitV2(seg, states, opts, keyFit) {
  const S = states.length, out = new Float64Array(S + 1);
  const c = seg.chroma, b = seg.bass;
  let cn = 0; for (let p = 0; p < 12; p++) cn += c[p] * c[p];
  cn = Math.sqrt(cn) || 1;
  let bmax = 0, bsum = 0; for (let p = 0; p < 12; p++) { if (b[p] > bmax) bmax = b[p]; bsum += b[p]; }
  const bassW = opts.bassWeight != null ? opts.bassWeight : 0.25;
  const rankBias = opts.rankBias != null ? opts.rankBias : 0.007;
  const invPen = opts.inversionPenalty != null ? opts.inversionPenalty : 0.03;
  const keyW = opts.keyWeight != null ? opts.keyWeight : 0.08;
  /* A power chord (root+5th) is a strict SUBSET of every major/minor triad, and a
   * guitar voicing doubles its root and 5th while sounding the 3rd once — so on raw
   * cosine "5" wins whenever the 3rd is a little quiet (measured: 2.7% of all frames on
   * clean comping, 9% under room reverb). It needs evidence of an ABSENT 3rd, not a
   * weak one: hence a prior. */
  const powPen = opts.powerPenalty != null ? opts.powerPenalty : 0.06;
  const slashPen = opts.slashPenalty != null ? opts.slashPenalty : 0.1;
  for (let s = 0; s < S; s++) {
    const st = states[s];
    let dot = 0; for (let p = 0; p < 12; p++) dot += c[p] * st.vec[p];
    let sc = dot / cn - rankBias * st.quality.rank;
    if (bmax > 0) sc += bassW * (b[st.bassPc] / bmax);
    else if (st.inversion) sc -= bassW;                       // no bass evidence → never invent a slash
    if (st.inversion) sc -= st.foreign ? slashPen : invPen;
    if (st.quality.intervals.length === 2) sc -= powPen;
    if (keyFit) sc += keyW * keyFit[s];
    out[s] = sc;
  }
  out[S] = opts.ncScore != null ? opts.ncScore : 0.55;
  return out;
}

/* Forward–backward + Viterbi on the "stay, or jump anywhere" chord HMM. Emissions
 * are exp(score/τ); a jump costs exp(−changePenalty/τ). The Viterbi path is the MAP
 * chord SEQUENCE (consistent labels); the posteriors γ_t are the bidirectional,
 * per-beat belief (v2 Stage C/D) that confidence + alternatives are read from.
 * O(T·S) both ways — the uniform jump lets each step use one running sum. `gated[t]`
 * forces the no-chord state (silence is not a chord). */
function hmmChordDecode(E, gated, opts = {}) {
  const T = E.length;
  if (!T) return { path: [], post: [] };
  const K = E[0].length;                                          // S chord states + no-chord
  const tau = opts.temperature != null ? opts.temperature : 0.05;
  const cp = opts.changePenalty != null ? opts.changePenalty : 0.14;
  const m = Math.exp(-cp / tau);
  const em = new Array(T);
  for (let t = 0; t < T; t++) {
    const e = new Float64Array(K);
    if (gated && gated[t] === "skip") { e.fill(1); e[K - 1] = 0.5; em[t] = e; continue; }
    if (gated && gated[t]) { e[K - 1] = 1; em[t] = e; continue; }
    let mx = -Infinity; for (let k = 0; k < K; k++) if (E[t][k] > mx) mx = E[t][k];
    for (let k = 0; k < K; k++) e[k] = Math.exp((E[t][k] - mx) / tau);
    em[t] = e;
  }
  // forward (scaled)
  const alpha = new Array(T);
  let prev = new Float64Array(K).fill(1 / K);
  for (let t = 0; t < T; t++) {
    const a = new Float64Array(K);
    let tot = 0; for (let k = 0; k < K; k++) tot += prev[k];
    let z = 0;
    for (let k = 0; k < K; k++) { a[k] = em[t][k] * (t ? prev[k] + m * (tot - prev[k]) : prev[k]); z += a[k]; }
    z = z || 1; for (let k = 0; k < K; k++) a[k] /= z;
    alpha[t] = a; prev = a;
  }
  // backward (scaled) → posteriors
  const post = new Array(T);
  let beta = new Float64Array(K).fill(1);
  for (let t = T - 1; t >= 0; t--) {
    const g = new Float64Array(K);
    let z = 0; for (let k = 0; k < K; k++) { g[k] = alpha[t][k] * beta[k]; z += g[k]; }
    z = z || 1; for (let k = 0; k < K; k++) g[k] /= z;
    post[t] = g;
    if (t > 0) {
      const nb = new Float64Array(K);
      let s = 0; for (let k = 0; k < K; k++) s += em[t][k] * beta[k];
      let zz = 0;
      for (let k = 0; k < K; k++) { nb[k] = em[t][k] * beta[k] + m * (s - em[t][k] * beta[k]); zz += nb[k]; }
      zz = zz || 1; for (let k = 0; k < K; k++) nb[k] /= zz;
      beta = nb;
    }
  }
  // Viterbi in the score domain (identical model: Σ score − cp·#changes)
  const path = new Array(T);
  const back = new Array(T);
  let pv = new Float64Array(K);
  const emitAt = (t, k) => gated && gated[t] === "skip" ? (k === K - 1 ? -cp : 0) : gated && gated[t] ? (k === K - 1 ? 0 : -1e9) : E[t][k];
  for (let k = 0; k < K; k++) pv[k] = emitAt(0, k);
  for (let t = 1; t < T; t++) {
    let bi = 0; for (let k = 1; k < K; k++) if (pv[k] > pv[bi]) bi = k;
    const cur = new Float64Array(K), bp = new Int32Array(K);
    for (let k = 0; k < K; k++) {
      const stay = pv[k], move = pv[bi] - cp;
      const base = stay >= move ? stay : move;
      bp[k] = stay >= move ? k : bi;
      cur[k] = base + emitAt(t, k);
    }
    back[t] = bp; pv = cur;
  }
  let end = 0; for (let k = 1; k < K; k++) if (pv[k] > pv[end]) end = k;
  path[T - 1] = end;
  for (let t = T - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
  return { path, post };
}

/* ---- Stage D: repetition-aware smoothing ----------------------------------
 * Mauch, Noland & Dixon (ISMIR 2009): songs repeat, and a chord heard four times is
 * better evidenced than one heard once. Each beat's feature [treble | bass] is
 * stacked over an `embed`-beat window; beats whose CONTEXT recurs elsewhere
 * (cosine ≥ `threshold`, not overlapping) average in their repeats' chroma,
 * weighted by how well the context matches. A one-off beat keeps its own evidence. */
function repetitionSmooth(segs, opts = {}) {
  const T = segs.length;
  const L = opts.embed || 8, thr = opts.threshold != null ? opts.threshold : 0.82, K = opts.maxMatches || 8;
  const lam = opts.strength != null ? opts.strength : 1;
  if (T < 2 * L || T > (opts.maxBeats || 3000)) return segs;
  const D = 24;
  const feat = segs.map((s) => {
    const v = new Float64Array(D);
    let a = 0, b = 0; for (let p = 0; p < 12; p++) { a = Math.max(a, s.chroma[p]); b = Math.max(b, s.bass[p]); }
    for (let p = 0; p < 12; p++) { v[p] = a ? s.chroma[p] / a : 0; v[12 + p] = b ? (0.5 * s.bass[p]) / b : 0; }
    return v;
  });
  const h = L >> 1;
  const emb = new Array(T);
  for (let i = 0; i < T; i++) {
    const v = new Float64Array(D * L);
    for (let k = 0; k < L; k++) { const j = Math.min(T - 1, Math.max(0, i - h + k)); v.set(feat[j], k * D); }
    let n = 0; for (let q = 0; q < v.length; q++) n += v[q] * v[q];
    n = Math.sqrt(n) || 1; for (let q = 0; q < v.length; q++) v[q] /= n;
    emb[i] = v;
  }
  const out = new Array(T);
  for (let i = 0; i < T; i++) {
    const cand = [];
    for (let j = 0; j < T; j++) {
      if (Math.abs(i - j) < L) continue;
      let d = 0; const a = emb[i], b = emb[j];
      for (let q = 0; q < a.length; q++) d += a[q] * b[q];
      if (d >= thr) cand.push([d, j]);
    }
    cand.sort((x, y) => y[0] - x[0]);
    const ch = Float64Array.from(segs[i].chroma), bs = Float64Array.from(segs[i].bass);
    let wsum = 1;
    for (let c = 0; c < Math.min(K, cand.length); c++) {
      const [d, j] = cand[c], w = lam * ((d - thr) / (1 - thr));
      for (let p = 0; p < 12; p++) { ch[p] += w * segs[j].chroma[p]; bs[p] += w * segs[j].bass[p]; }
      wsum += w;
    }
    for (let p = 0; p < 12; p++) { ch[p] /= wsum; bs[p] /= wsum; }
    out[i] = { ...segs[i], chroma: ch, bass: bs, repeats: Math.min(K, cand.length) };
  }
  return out;
}

/* Frames → per-beat (or per-subdivision) segments: mean treble/bass chroma, mean
 * level in dB. Shared by the v2 decoder and testable on its own. */
function _segmentFrames(frames, grid) {
  const segs = [];
  let fi = 0;
  for (let b = 0; b + 1 < grid.length; b++) {
    const t0 = grid[b], t1 = grid[b + 1];
    while (fi < frames.length && frames[fi].t < t0) fi++;
    const chroma = new Float64Array(12), bass = new Float64Array(12);
    let n = 0, lev = 0;
    for (let j = fi; j < frames.length && frames[j].t < t1; j++) {
      for (let p = 0; p < 12; p++) { chroma[p] += frames[j].chroma[p]; bass[p] += frames[j].bass[p]; }
      lev += Math.pow(10, frames[j].level / 10); n++;
    }
    if (!n) {
      const j = Math.max(0, Math.min(frames.length - 1, fi > 0 && fi < frames.length && Math.abs(frames[fi - 1].t - (t0 + t1) / 2) < Math.abs(frames[fi].t - (t0 + t1) / 2) ? fi - 1 : fi));
      if (!frames[j]) continue;
      for (let p = 0; p < 12; p++) { chroma[p] = frames[j].chroma[p]; bass[p] = frames[j].bass[p]; }
      lev = Math.pow(10, frames[j].level / 10); n = 1;
    }
    for (let p = 0; p < 12; p++) { chroma[p] /= n; bass[p] /= n; }
    segs.push({ t0, t1, chroma, bass, level: 10 * Math.log10(lev / n + 1e-20) });
  }
  return segs;
}

/* PCM → v2 chord events. Same event shape as transcribeChords / BeatSync
 * ({ symbol, midis, startSec, durSec }) PLUS { confidence, prob, alternatives[],
 * ambiguous } so the chart/exporters consume it unchanged and the UI can grade it. */
function transcribeChordsV2(samples, sampleRate, opts = {}) {
  const bt = opts.beats ? { beats: opts.beats, bpm: opts.bpm || 0 } : detectBeats(samples, sampleRate, opts);
  const fr = opts._frames || nnlsChromagram(samples, sampleRate, opts);
  const frames = fr.frames;
  if (!frames.length) return { events: [], tuning: fr.tuning, beats: bt.beats || [], bpm: bt.bpm };
  // analysis grid: beats (optionally subdivided), or a fixed 0.25 s grid with no pulse
  let grid = opts.grid !== "fixed" && bt.beats && bt.beats.length >= 3 ? bt.beats.slice() : null;
  if (grid) {
    const sub = Math.max(1, opts.subdivide != null ? opts.subdivide : 2);
    if (sub > 1) { const g = []; for (let i = 0; i + 1 < grid.length; i++) for (let k = 0; k < sub; k++) g.push(grid[i] + ((grid[i + 1] - grid[i]) * k) / sub); g.push(grid[grid.length - 1]); grid = g; }
  } else {
    const step = opts.gridSec || 0.25;
    grid = []; const end = frames[frames.length - 1].t + step;
    for (let t = 0; t <= end; t += step) grid.push(+t.toFixed(4));
  }
  if (grid[0] > 0.05) grid.unshift(0);
  // the beat tracker's last beat is rarely the end of the audio — keep decoding the tail
  const tEnd = frames[frames.length - 1].t + 0.05;
  if (grid.length >= 2) { const step = grid[grid.length - 1] - grid[grid.length - 2]; while (grid[grid.length - 1] + 0.5 * step < tEnd) grid.push(Math.min(tEnd, grid[grid.length - 1] + step)); }
  let segs = _segmentFrames(frames, grid);
  if (!segs.length) return { events: [], tuning: fr.tuning, beats: bt.beats || [], bpm: bt.bpm };
  // gate: a segment far below the recording's loud passages is silence, not a chord.
  // Relative to a high PERCENTILE in dB (not a linear fraction of the peak — a strummed
  // guitar decays 60 dB in ~3 s and is still that chord at −30 dB).
  const lv = segs.map((s) => s.level).sort((a, b) => a - b);
  const ref = lv[Math.min(lv.length - 1, Math.floor(0.95 * lv.length))];
  const gateDb = opts.gateDb != null ? opts.gateDb : 45;
  /* A rest is also "well below the loud passages AND harmonically FLAT". Under a noise
   * floor (hiss, bleed, room tone) a rest is not silent, and its noise chroma still gets
   * a chord name — measured: a pad part that rests 54% of the time read 98% clean but 43%
   * with 20 dB noise, the hiss in every rest decoded as Em7. Noise-only frames read a
   * normalised chroma entropy of 0.99–1.00; real chords 0.68–0.83 (p90 ≤ 0.95 even quiet
   * and noisy), so the flatness test cannot eat a real chord. */
  const flatGate = opts.flatEntropy != null ? opts.flatEntropy : 0.97, flatDb = opts.flatDb != null ? opts.flatDb : 12;
  const entropy = (v) => { let sum = 0; for (let p = 0; p < 12; p++) sum += v[p]; if (!(sum > 0)) return 1; let h = 0; for (let p = 0; p < 12; p++) if (v[p] > 0) { const q = v[p] / sum; h -= q * Math.log(q); } return h / Math.log(12); };
  const quiet = segs.map((s) => s.level < ref - gateDb || (flatGate < 1 && s.level < ref - flatDb && entropy(s.chroma) >= flatGate));
  /* Only a SUSTAINED silence is a rest. A short gap (a staccato chop, a breath between
   * strums) carries no evidence either way — it is marked 'skip' and gets a flat
   * emission, so the HMM carries the surrounding chord across it, the way a chart does. */
  const minRest = opts.minRestSec != null ? opts.minRestSec : 1.0;
  const gated = new Array(segs.length).fill(false);
  for (let i = 0; i < segs.length;) {
    if (!quiet[i]) { i++; continue; }
    let j = i; while (j < segs.length && quiet[j]) j++;
    const long = segs[j - 1].t1 - segs[i].t0 >= minRest || i === 0 || j === segs.length;
    for (let k = i; k < j; k++) gated[k] = long ? true : "skip";
    i = j;
  }
  /* Stage D is OPT-IN. Measured: +1.2 majmin on the dev split, −0.3 on the held-out
   * split (−6 on a 12-bar blues, where bars sharing a groove but not a chord borrow each
   * other's evidence); a longer 4-bar context erased the dev gain. It did not
   * generalise, so it is not a default. */
  if (opts.repetition === true) segs = repetitionSmooth(segs, opts);
  const states = chordStatesV2(opts);
  let keyFit = null;
  if (opts.keyScale && opts.keyScale.length === 12) {
    keyFit = states.map((st) => st.quality.intervals.reduce((a, i) => a + (opts.keyScale[(st.root + i) % 12] ? 1 : 0), 0) / st.quality.intervals.length);
  }
  const E = segs.map((s) => _emitV2(s, states, opts, keyFit));
  const { path, post } = hmmChordDecode(E, gated, opts);
  const S = states.length, K = S + 1;
  const useSharp = opts.useSharp !== false, names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  const symOf = (st) => names[st.root] + (st.writeQ || st.quality).suffix + (st.showBass ? "/" + names[st.bassPc] : "");
  // a playable voicing: chord tones from C3 up, the bass note an octave below when inverted
  // (a hidden inversion carries no bass note, so re-naming the midis — transpose — can't bring the slash back)
  const midisOf = (st) => (st.showBass ? [36 + st.bassPc] : []).concat((st.writeQ || st.quality).intervals.map((i) => 48 + st.root + i));
  const logK = Math.log(K);
  // collapse runs of one state into events
  const events = [];
  let cur = null;
  for (let t = 0; t < segs.length; t++) {
    const s = path[t];
    if (s === S) { if (cur) { events.push(cur); cur = null; } continue; }
    if (cur && cur.state === s) { cur.t1 = segs[t].t1; cur.beats.push(t); continue; }
    if (cur) events.push(cur);
    cur = { state: s, t0: segs[t].t0, t1: segs[t].t1, beats: [t] };
  }
  if (cur) events.push(cur);
  const ambThr = opts.ambiguityThreshold != null ? opts.ambiguityThreshold : 0.4;
  const out = events.map((e) => {
    const st = states[e.state];
    // per-label posterior mass averaged over the event's beats
    const mass = new Map();
    let ent = 0;
    for (const t of e.beats) {
      const g = post[t];
      let H = 0; for (let k = 0; k < K; k++) if (g[k] > 1e-12) H -= g[k] * Math.log(g[k]);
      ent += 1 - H / logK;
      for (let k = 0; k < S; k++) if (g[k] > 1e-4) {
        const lab = symOf(states[k]), prevM = mass.get(lab);
        mass.set(lab, { p: (prevM ? prevM.p : 0) + g[k] / e.beats.length, k });
      }
    }
    const label = symOf(st);
    const prob = mass.has(label) ? mass.get(label).p : 0;
    const alternatives = [...mass.entries()].filter(([l]) => l !== label).sort((a, b) => b[1].p - a[1].p).slice(0, 3)
      .map(([symbol, v]) => ({ symbol, prob: +v.p.toFixed(3), midis: midisOf(states[v.k]) }));
    return {
      symbol: label,
      midis: midisOf(st),
      startSec: +e.t0.toFixed(3),
      durSec: +(e.t1 - e.t0).toFixed(3),
      confidence: +(ent / e.beats.length).toFixed(3),
      prob: +prob.toFixed(3),
      alternatives,
      ambiguous: prob < ambThr,
    };
  });
  return { events: out, tuning: fr.tuning, beats: bt.beats || [], bpm: bt.bpm, segments: segs.length };
}

/* The v2 panel entry point (same contract as analyzeAudioChords, plus `tuning`).
 * Two passes like v1: decode, read the key off the decode, re-decode with the
 * diatonic prior when the key reading is confident. The NNLS front-end is computed
 * ONCE and shared by both passes. */
function analyzeAudioChordsV2(samples, sampleRate, opts = {}) {
  // a caller that already has the beat grid (another stem of the same song) or the NNLS
  // frames passes them in, so every chart of a song shares ONE grid (see chartsFromStems)
  const bt = opts.beats && opts.beats.length >= 3 ? { beats: opts.beats, bpm: opts.bpm || 0 } : detectBeats(samples, sampleRate, opts);
  const fr = opts._frames || nnlsChromagram(samples, sampleRate, opts);
  const base = { ...opts, beats: bt.beats && bt.beats.length >= 3 ? bt.beats : null, bpm: bt.bpm, _frames: fr };
  let r = transcribeChordsV2(samples, sampleRate, base);
  let key = null;
  if (r.events.length && opts.keyPrior !== false) {
    const bpb = opts.beatsPerBar || 4, spb = 60 / (bt.bpm || 120);
    const probe = { bars: r.events.map((e, i) => ({ number: i + 1, events: [{ symbol: e.symbol, durBeats: Math.max(1, Math.round(e.durSec / spb)) }] })), timeSig: [bpb, 4] };
    key = analyzeKey(probe);
    if (key && key.confidence >= (opts.keyMinConfidence != null ? opts.keyMinConfidence : 0.5)) {
      const idx = key.mode === "major" ? _MAJ : _MIN;
      const scale = new Array(12).fill(false);
      for (const rel of Object.keys(idx)) scale[(key.tonic + Number(rel)) % 12] = true;
      const second = transcribeChordsV2(samples, sampleRate, { ...base, keyScale: scale });
      if (second.events.length) r = second;
    } else key = null;
  }
  return { events: r.events, bpm: base.beats ? bt.bpm : 0, beats: bt.beats || [], key, tuning: +fr.tuning.toFixed(1), method: base.beats ? "synharmonics-v2" : "synharmonics-v2-grid" };
}

/* ============================================================================
 *  PER-INSTRUMENT CHARTS FROM STEMS
 *  ---------------------------------------------------------------------------
 *  A full mix → stems (an ML separator, or stems the user already has from Moises /
 *  Demucs / LALAL) → one chart per instrument, all on ONE shared beat grid so bar n is
 *  the same moment in every chart (tracked on the drum stem when there is one — drums
 *  carry the cleanest pulse). Pure + worker-safe; the separator itself is browser glue.
 *
 *   band     chords from the HARMONIC stems (guitar / piano / other), with the BASS
 *            stem's lowest note as the bass evidence — the separated bass is the cleanest
 *            root/inversion signal a chord decoder can get
 *   guitar / piano / other   chords per harmonic stem
 *   bass     the bass line (YIN notes) — the root movement, on a bass staff
 *   vocals   the lead melody (YIN notes); the full harmony split is Voices (ML)
 *   drums    kick / snare / hi-hat hits → a 16th-note groove grid per bar
 * ------------------------------------------------------------------------- */

/* A stem file's instrument from its name — Moises ("Song - Guitar.wav"), Demucs
 * ("vocals.wav"), LALAL ("song_vocals.mp3"), Spleeter ("accompaniment.wav"). Order
 * matters: "bass drum" is drums, "backing vocals" is vocals. null = unknown. */
const _STEM_PATTERNS = [
  ["drums", /drum|percussion|perc\b|kick|snare|beat/i],
  ["vocals", /vocal|voice|vox|lead.?vox|singer|acapella|a cappella/i],
  ["bass", /\bbass(?!oon)|bajo/i],
  ["guitar", /guitar|gtr|guitarra/i],
  ["piano", /piano|keys|keyboard|rhodes|organ|synth/i],
  ["other", /other|instrumental|accompaniment|backing|music|no.?vocals|karaoke|rest/i],
];
function stemRoleFromName(name) {
  const base = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  for (const [role, re] of _STEM_PATTERNS) if (re.test(base)) return role;
  return null;
}
const STEM_ROLE_NAMES = { band: "Full band", guitar: "Guitar", piano: "Keys", other: "Guitar / keys (other)", bass: "Bass", vocals: "Vocals", drums: "Drums" };

/* Drum hits — semi-adaptive NMF drum transcription (after Dittmar & Gärtner 2014;
 * Wu et al. 2018's ADT review). A band-energy detector fails on real kits for a physical
 * reason: a snare's noise reaches below 150 Hz, a kick's beater click above 1 kHz, a hat's
 * sizzle into the snare's band — so every band "hears" every drum (measured: snare
 * precision 27%). NMF instead EXPLAINS the log-band spectrogram V ≈ W·H with one spectral
 * template per drum (kick: a low body; snare: a 150–250 Hz body + broadband wires; hat:
 * high band), so energy two drums share is divided between them, not counted twice.
 * Templates start from those canonical shapes and adapt to the recording, pulled back
 * toward their shape each iteration so a component cannot swap identity. Onsets are peaks
 * of each activation's rise. Run it on a FULL-RATE stem (44.1/48 kHz) — at the 16 kHz
 * chord-analysis rate most of a real hi-hat is above Nyquist. Returns [{ t, type, strength }]. */
function transcribeDrums(samples, sampleRate, opts = {}) {
  let N = 1; while (N < 0.04 * sampleRate) N <<= 1;
  const hop = Math.max(1, Math.round(sampleRate * 0.01)), half = N >> 1, binHz = sampleRate / N;
  const win = _hann(N), fLo = 30, fHi = Math.min(16000, sampleRate / 2 - 1), B = 48;
  const edges = Array.from({ length: B + 1 }, (_, i) => fLo * Math.pow(fHi / fLo, i / B));
  const centres = edges.slice(0, B).map((e, i) => Math.sqrt(e * edges[i + 1]));
  const binBand = new Int16Array(half).fill(-1);
  for (let k = 1; k < half; k++) { const f = k * binHz; for (let b = 0; b < B; b++) if (f >= edges[b] && f < edges[b + 1]) { binBand[k] = b; break; } }
  const V = [], times = [];
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= samples.length; s += hop) {
    for (let i = 0; i < N; i++) { re[i] = (samples[s + i] || 0) * win[i]; im[i] = 0; }
    _fft(re, im);
    const col = new Float64Array(B);
    for (let k = 1; k < half; k++) if (binBand[k] >= 0) col[binBand[k]] += Math.hypot(re[k], im[k]);
    for (let b = 0; b < B; b++) col[b] = Math.sqrt(col[b]);                 // mild compression
    V.push(col); times.push((s + N / 2) / sampleRate);
  }
  const T = V.length;
  if (T < 3) return [];
  const types = ["kick", "snare", "hat"];
  const lg = (f) => Math.log2(f);
  const shape = [
    (f) => Math.exp(-0.5 * Math.pow((lg(f) - lg(65)) / 0.9, 2)) + 0.04,                                  // kick body ~65 Hz
    (f) => 0.9 * Math.exp(-0.5 * Math.pow((lg(f) - lg(200)) / 0.7, 2)) + (f > 1000 ? 0.45 : f > 300 ? 0.25 : 0.05),   // snare body + wires
    (f) => (f > 6000 ? 1 : f > 3000 ? 0.4 : 0.02),                                                         // hats / cymbals
  ];
  const W0 = shape.map((fn) => { const w = centres.map(fn); const n = Math.hypot(...w) || 1; return w.map((x) => x / n); });
  const W = W0.map((w) => w.slice());
  const H = types.map(() => new Float64Array(T).fill(0.1));
  const iters = opts.drumIterations || 30, pull = opts.drumTemplatePull != null ? opts.drumTemplatePull : 0.5, eps = 1e-9;
  const R = new Float64Array(B * T);
  for (let it = 0; it < iters; it++) {
    // R = V / (W·H)   (KL-divergence multiplicative updates)
    for (let t = 0; t < T; t++) for (let b = 0; b < B; b++) { let v = eps; for (let c = 0; c < 3; c++) v += W[c][b] * H[c][t]; R[b * T + t] = V[t][b] / v; }
    for (let c = 0; c < 3; c++) {
      let wsum = 0; for (let b = 0; b < B; b++) wsum += W[c][b];
      for (let t = 0; t < T; t++) { let num = 0; for (let b = 0; b < B; b++) num += W[c][b] * R[b * T + t]; H[c][t] *= num / (wsum + eps); }
    }
    for (let t = 0; t < T; t++) for (let b = 0; b < B; b++) { let v = eps; for (let c = 0; c < 3; c++) v += W[c][b] * H[c][t]; R[b * T + t] = V[t][b] / v; }
    for (let c = 0; c < 3; c++) {
      let hsum = 0; for (let t = 0; t < T; t++) hsum += H[c][t];
      for (let b = 0; b < B; b++) { let num = 0; for (let t = 0; t < T; t++) num += H[c][t] * R[b * T + t]; W[c][b] *= num / (hsum + eps); }
      let n = 0; for (let b = 0; b < B; b++) { W[c][b] = (1 - pull) * W[c][b] + pull * W0[c][b] * (Math.hypot(...W[c]) || 1); n += W[c][b] * W[c][b]; }
      n = Math.sqrt(n) || 1; for (let b = 0; b < B; b++) W[c][b] /= n;
    }
  }
  // onsets: peaks of each component's RISE (rectified first difference of its activation)
  const rel = opts.drumThreshold != null ? opts.drumThreshold : 0.4;
  const gap = Math.round(0.06 / (hop / sampleRate)), Wn = Math.round(1.5 / (hop / sampleRate));
  const hits = [], peak = {};
  types.forEach((type, c) => {
    const d = new Float64Array(T);
    for (let t = 1; t < T; t++) d[t] = Math.max(0, H[c][t] - H[c][t - 1]);
    let gmax = 0; for (let t = 0; t < T; t++) if (d[t] > gmax) gmax = d[t];
    if (!(gmax > 0)) return;
    peak[type] = gmax;
    let last = -1e9;
    for (let t = 1; t + 1 < T; t++) {
      if (!(d[t] > d[t - 1] && d[t] >= d[t + 1]) || d[t] < 0.1 * gmax) continue;
      let lmax = 0; for (let j = Math.max(0, t - Wn); j < Math.min(T, t + Wn + 1); j++) if (d[j] > lmax) lmax = d[j];
      if (d[t] < rel * lmax) continue;
      if (t - last < gap) { if (hits.length && hits[hits.length - 1].type === type && d[t] > hits[hits.length - 1].strength) { hits[hits.length - 1] = { t: +times[t].toFixed(3), type, strength: d[t] }; last = t; } continue; }
      last = t; hits.push({ t: +times[t].toFixed(3), type, strength: d[t] });
    }
  });
  /* A kick's beater click is broadband and a snare's body reaches low, so at a COINCIDENT
   * kick+snare onset NMF still lends the other component a weaker rise (measured on a
   * rendered kit: false snares under kicks at 0.68–0.71 of the snare's peak, real snares
   * 0.87–1.0). Keep the weaker of a coincident kick/snare only at ≥ 0.8 of its own peak.
   * Ghost notes softer than the onset threshold (0.4 of the local loudest) are not drawn. */
  const norm = (h) => h.strength / (peak[h.type] || 1);
  const shadowed = (h) => (h.type === "kick" || h.type === "snare") && norm(h) < 0.8 &&
    hits.some((o) => o !== h && (o.type === "kick" || o.type === "snare") && o.type !== h.type && Math.abs(o.t - h.t) < 0.03 && norm(o) > norm(h));
  return hits.filter((h) => !shadowed(h)).sort((a, b) => a.t - b.t);
}

/* Hits → a groove grid: per bar, `steps` slots (16 = sixteenths in 4/4) for each drum, on
 * the SHARED beat grid when one is given (else a fixed bpm grid from t = 0, the same grid
 * audioEventsToScore uses). Returns { bars:[{ number, kick, snare, hat }] } with each row a
 * string of "x"/"." — readable as a drum chart, exportable as MIDI. */
function drumPattern(hits, opts = {}) {
  const bpb = opts.beatsPerBar || 4, sub = opts.subdivisions || 4, bpm = opts.bpm || 120;
  const beatT = (b) => b * 60 / bpm;
  const slotOf = (t) => {
    const g = t / (60 / bpm);                                      // fractional beat on the chart's grid
    return Math.round(g * sub);
  };
  const bars = new Map();
  for (const h of hits || []) {
    const slot = slotOf(h.t);
    if (slot < 0) continue;
    const bar = Math.floor(slot / (bpb * sub)), pos = slot - bar * bpb * sub;
    if (!bars.has(bar)) bars.set(bar, { kick: new Array(bpb * sub).fill("."), snare: new Array(bpb * sub).fill("."), hat: new Array(bpb * sub).fill(".") });
    bars.get(bar)[h.type][pos] = "x";
  }
  const last = bars.size ? Math.max(...bars.keys()) : -1;
  const out = [];
  for (let b = 0; b <= last; b++) {
    const r = bars.get(b) || { kick: [], snare: [], hat: [] };
    const fill = (a) => (a.length ? a.join("") : ".".repeat(bpb * sub));
    out.push({ number: b + 1, startSec: +beatT(b * bpb).toFixed(3), kick: fill(r.kick), snare: fill(r.snare), hat: fill(r.hat) });
  }
  return { bars: out, beatsPerBar: bpb, subdivisions: sub, bpm };
}

/* Drum hits → a Standard MIDI File on channel 10 (GM: kick 36, snare 38, closed hat 42),
 * format 0, PPQ 480 — the same container scoreToMidi writes. */
function drumHitsToMidi(hits, opts = {}) {
  const PPQ = 480, bpm = Math.max(20, Math.min(400, Math.round(opts.bpm || 120))), uspq = Math.round(60000000 / bpm);
  const note = { kick: 36, snare: 38, hat: 42 };
  const evs = [{ tick: 0, o: 0, b: [0xff, 0x51, 0x03, (uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255] }];
  for (const h of hits || []) {
    const tick = Math.max(0, Math.round((h.t * bpm / 60) * PPQ)), n = note[h.type];
    if (n == null) continue;
    evs.push({ tick, o: 2, b: [0x99, n, 100] }, { tick: tick + 60, o: 1, b: [0x89, n, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick || a.o - b.o);
  const end = (evs.length ? evs[evs.length - 1].tick : 0) + PPQ;
  evs.push({ tick: end, o: 3, b: [0xff, 0x2f, 0x00] });
  const body = []; let t = 0;
  const vlq = (v) => { const st = [v & 0x7f]; while ((v >>= 7)) st.unshift((v & 0x7f) | 0x80); return st; };
  for (const e of evs) { body.push(...vlq(e.tick - t), ...e.b); t = e.tick; }
  const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]);
}

/* Time left on a long job from its progress, for a countdown that stays honest between
 * progress events. prog = { done, total, t0, tAt }: `done` of `total` units COMPLETED as of
 * `tAt` (ms, same clock as `now`), work started at `t0`. The rate is measured up to the last
 * event and the time since it is subtracted, so the display counts down every tick instead
 * of freezing until the next event (a single SCNet chunk is over a minute on WASM).
 * Returns seconds ≥ 0, or null until a unit has finished (no rate to extrapolate). Pure. */
function progressEta(prog, now) {
  if (!prog || !(prog.total > 0) || !(prog.done > 0) || prog.t0 == null) return null;
  const tAt = prog.tAt != null ? prog.tAt : now;
  if (!(tAt > prog.t0)) return null;
  const done = Math.min(prog.done, prog.total);
  const remaining = ((tAt - prog.t0) / done) * (prog.total - done) - (now - tAt);
  return Math.max(0, remaining / 1000);
}

/* PCM → a 16-bit PCM WAV file (RIFF), for downloading separated stems. Channels are
 * Float32Arrays at `sampleRate`, clipped to ±1. Pure. */
function encodeWav16(channels, sampleRate) {
  const chs = (channels || []).filter(Boolean), nc = Math.max(1, chs.length);
  const n = chs.length ? Math.min(...chs.map((c) => c.length)) : 0;
  const data = n * nc * 2, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, data, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const x = Math.max(-1, Math.min(1, chs[c] ? chs[c][i] : 0));
    v.setInt16(o, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true); o += 2;
  }
  return new Uint8Array(buf);
}

function _sumStems(list) {
  const arrs = list.filter((a) => a && a.length);
  if (!arrs.length) return null;
  const n = Math.max(...arrs.map((a) => a.length)), out = new Float32Array(n);
  for (const a of arrs) for (let i = 0; i < a.length; i++) out[i] += a[i];
  return out;
}
const _HARMONIC_ROLES = ["guitar", "piano", "other"];

/* stems: { vocals?, drums?, bass?, guitar?, piano?, other?, mix? } — mono Float32Arrays at
 * `sampleRate`, sample-aligned (as a separator or a stem export delivers them). Returns
 * { bpm, beats, key, tuning, charts:[{ role, name, kind:"chords"|"notes"|"drums", … }] }. */
function chartsFromStems(stems, sampleRate, opts = {}) {
  const S = stems || {};
  const has = (r) => S[r] && S[r].length > 0;
  // ONE grid for every chart: the drum stem's pulse when present, else the whole song
  const gridSrc = has("drums") ? S.drums : S.mix || _sumStems(Object.keys(S).map((k) => S[k]));
  let bt = opts.beats && opts.beats.length >= 3 ? { beats: opts.beats, bpm: opts.bpm || 0 } : gridSrc ? detectBeats(gridSrc, sampleRate, opts) : { beats: [], bpm: 0 };
  if ((!bt.beats || bt.beats.length < 3) && has("drums") && (S.mix || _HARMONIC_ROLES.some(has))) {
    bt = detectBeats(S.mix || _sumStems(_HARMONIC_ROLES.map((r) => S[r])), sampleRate, opts);   // a sparse drum stem: fall back
  }
  const beats = bt.beats && bt.beats.length >= 3 ? bt.beats : null;
  const shared = { ...opts, beats, bpm: bt.bpm };
  const charts = [];
  let key = null, tuning = 0;
  const harmonic = _HARMONIC_ROLES.filter(has);
  // the full band: harmonic stems for the chord, the bass stem for the bass note
  if (harmonic.length || has("bass")) {
    const treble = harmonic.length ? _sumStems(harmonic.map((r) => S[r])) : S.bass;
    const fr = nnlsChromagram(treble, sampleRate, opts);
    /* Bass-stem fusion is OPT-IN: on the stems benchmark it was within ±1 point of no fusion
     * with perfect stems and cost 2–3 points with realistically leaky ones (a walking bass's
     * passing notes pull roots off). The harmonic stems' own lowest notes stay the default. */
    if (has("bass") && harmonic.length && opts.bassFusion === true) {
      const fb = nnlsChromagram(S.bass, sampleRate, { ...opts, tuning: fr.tuning });
      const n = Math.min(fr.frames.length, fb.frames.length);
      for (let i = 0; i < n; i++) {
        const b = fb.frames[i].bass, tb = fr.frames[i].bass;
        let bm = 0, tm = 0; for (let p = 0; p < 12; p++) { if (b[p] > bm) bm = b[p]; if (tb[p] > tm) tm = tb[p]; }
        // the separated bass decides; the harmonic stems' own low notes only break a silence
        const fused = new Float64Array(12);
        const wB = opts.bassFusionWeight != null ? opts.bassFusionWeight : 1;
        for (let p = 0; p < 12; p++) fused[p] = wB * (bm > 0 ? b[p] / bm : 0) + (tm > 0 ? tb[p] / tm : 0);
        fr.frames[i] = { ...fr.frames[i], bass: fused };
      }
    }
    const r = analyzeAudioChordsV2(treble, sampleRate, { ...shared, _frames: fr });
    key = r.key; tuning = r.tuning;
    charts.push({ role: "band", name: STEM_ROLE_NAMES.band, kind: "chords", events: r.events });
  }
  if (opts.perStemChords !== false) for (const role of harmonic) {
    if (harmonic.length === 1 && !has("bass")) break;                      // identical to the band chart
    const r = analyzeAudioChordsV2(S[role], sampleRate, shared);
    charts.push({ role, name: STEM_ROLE_NAMES[role], kind: "chords", events: r.events });
  }
  const yinWin = (minF) => { let w = 512; while (w < (2.2 * sampleRate) / minF) w <<= 1; return w; };
  if (has("bass")) {
    const notes = transcribeMonophonic(S.bass, sampleRate, { minFreq: 36, maxFreq: 420, window: yinWin(36), hop: Math.round(sampleRate * 0.02), minClarity: 0.5, minDurSec: 0.08 });
    charts.push({ role: "bass", name: STEM_ROLE_NAMES.bass, kind: "notes", notes });
  }
  if (has("vocals")) {
    const notes = transcribeMonophonic(S.vocals, sampleRate, { minFreq: 75, maxFreq: 1100, window: yinWin(75), hop: Math.round(sampleRate * 0.02), minClarity: 0.6, minDurSec: 0.08 });
    charts.push({ role: "vocals", name: STEM_ROLE_NAMES.vocals, kind: "notes", notes });
  }
  if (has("drums")) {
    // drums want the FULL-RATE stem (hats live above the 16 kHz analysis Nyquist) when given
    const fr = opts.fullRate && opts.fullRate.drums && opts.fullRate.sampleRate ? opts.fullRate : null;
    const hits = fr ? transcribeDrums(fr.drums, fr.sampleRate, opts) : transcribeDrums(S.drums, sampleRate, opts);
    charts.push({ role: "drums", name: STEM_ROLE_NAMES.drums, kind: "drums", hits });
  }
  return { bpm: beats ? bt.bpm : 0, beats: bt.beats || [], key, tuning, charts };
}

/* ============================================================================
 *  SONG STRUCTURE — sections (intro / verse / chorus / bridge …) from the audio
 *  ---------------------------------------------------------------------------
 *  The decoder produced a flat run of bars with no idea where the song's PARTS
 *  are, so a 5-minute chart is a wall of bars a player has to count through. This
 *  recovers the structure from the recording itself, with the standard MIR
 *  pipeline (Foote 2000 self-similarity + novelty; Paulus/Müller structure
 *  features), pure + zero-dep so it runs in the worker on an iPhone:
 *
 *    beats → beat-synchronous features → time-lag embedding → SSM → novelty →
 *    boundaries → segment clustering (which parts are the SAME part) → naming.
 *
 *  WHY beat-synchronous and WHY embedded: a section is a repeated PROGRESSION, not
 *  a repeated instant. Averaging between beats denoises exactly as it does for the
 *  chord decoder, and stacking `embed` consecutive beats means the similarity matrix
 *  compares phrases, so "C · G · Am · F" matches its later repeat instead of every
 *  isolated C matching every other C.
 *
 *  WHY chroma AND timbre: a verse and its chorus very often share the chord loop
 *  (the whole of "Can't You See" is D · C · G), so chroma alone cannot separate
 *  them. What does change is the ARRANGEMENT — density, brightness, how many
 *  instruments — which is a spectral-shape (timbre) cue. Both go into the feature.
 *
 *  HONEST LIMITS (documented, not bugs): boundaries land on beats, not on a
 *  downbeat grid (pure-DSP downbeat detection does not work — see CLAUDE.md), so a
 *  boundary can sit a beat or two off; the section NAMES are heuristics over the
 *  repetition pattern (most-repeated + loudest = chorus, etc.), not song knowledge,
 *  so a tune that breaks the pop template will be labelled oddly. Both are why the
 *  UI ships a section editor — this is a first draft the user corrects in seconds,
 *  and every label round-trips into CSMPN/CSML/MusicXML through `bar.section`.
 * ------------------------------------------------------------------------- */

/* Per-beat spectral SHAPE: |X| folded into `bands` log-spaced bands, L2-normalised
 * so it describes brightness/density and NOT loudness (loudness is carried
 * separately by the beat energy). This is the timbre half of the feature. */
function _bandFeatures(samples, sampleRate, beats, opts = {}) {
  const B = opts.bands || 8;
  let win = opts.structWindow || 2048;
  while (win > samples.length && win > 256) win >>= 1;
  const hop = Math.max(1, Math.floor(sampleRate * (opts.hopSec || 0.12)));
  const lo = 55, hi = Math.min(sampleRate / 2 - 1, opts.bandMaxFreq || 8000);
  const w = _hann(win);
  const re = new Float64Array(win), im = new Float64Array(win);
  const frames = [];
  const logSpan = Math.log(hi / lo);
  for (let s = 0; s + win <= samples.length; s += hop) {
    for (let i = 0; i < win; i++) { re[i] = (samples[s + i] || 0) * w[i]; im[i] = 0; }
    _fft(re, im);
    const v = new Float64Array(B);
    for (let k = 1; k < win / 2; k++) {
      const f = (k * sampleRate) / win;
      if (f < lo || f > hi) continue;
      let b = Math.floor((B * Math.log(f / lo)) / logSpan);
      if (b < 0) b = 0; else if (b >= B) b = B - 1;
      v[b] += Math.hypot(re[k], im[k]);
    }
    frames.push({ t: s / sampleRate, v });
  }
  const out = [];
  let fi = 0;
  for (let b = 0; b + 1 < beats.length; b++) {
    const t0 = beats[b], t1 = beats[b + 1];
    while (fi < frames.length && frames[fi].t < t0) fi++;
    const acc = new Float64Array(B);
    let n = 0;
    for (let j = fi; j < frames.length && frames[j].t < t1; j++) { for (let p = 0; p < B; p++) acc[p] += frames[j].v[p]; n++; }
    if (!n && frames.length) { const j = Math.min(frames.length - 1, fi); for (let p = 0; p < B; p++) acc[p] = frames[j].v[p]; n = 1; }
    let norm = 0; for (let p = 0; p < B; p++) { acc[p] /= n || 1; norm += acc[p] * acc[p]; }
    norm = Math.sqrt(norm) || 1;
    for (let p = 0; p < B; p++) acc[p] /= norm;
    out.push(acc);
  }
  return out;
}
const _l2 = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };
function _cosSim(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}
/* Foote checkerboard novelty over a self-similarity matrix. The kernel is the
 * classic ±/∓ quadrant pattern with a Gaussian taper: it reads high where the
 * past `L` beats are self-similar, the next `L` beats are self-similar, and the
 * two are UNLIKE each other — i.e. exactly at a section boundary. */
function _footeNovelty(S, L) {
  const T = S.length, nov = new Float64Array(T);
  const K = [];
  const sigma = L / 2 || 1;
  for (let a = -L; a < L; a++) {
    const row = [];
    for (let b = -L; b < L; b++) {
      const sign = (a < 0) === (b < 0) ? 1 : -1;
      row.push(sign * Math.exp(-(a * a + b * b) / (2 * sigma * sigma)));
    }
    K.push(row);
  }
  for (let i = 0; i < T; i++) {
    let s = 0;
    for (let a = -L; a < L; a++) {
      const ia = i + a; if (ia < 0 || ia >= T) continue;
      const row = K[a + L], Srow = S[ia];
      for (let b = -L; b < L; b++) {
        const ib = i + b; if (ib < 0 || ib >= T) continue;
        s += row[b + L] * Srow[ib];
      }
    }
    nov[i] = s;
  }
  return nov;
}
/* Name a clustered structure with the pop/rock template. Pure + separately testable:
 * takes segments that already carry a repetition `letter`, returns them labelled.
 *   · the most-repeated, highest-energy recurring part → CHORUS (it is the hook, it
 *     comes back, and it is nearly always the loudest/densest thing in the song);
 *   · the other recurring part that keeps preceding it → VERSE;
 *   · a short opening part → INTRO; a short closing one → OUTRO;
 *   · a one-off part in the last half, after both verse and chorus exist → BRIDGE;
 *   · any other one-off → INSTRUMENTAL (a solo / a break).
 * Repeats are numbered (Verse 1, Verse 2 …) so a player can call them out. */
function nameSections(segments, opts = {}) {
  const segs = (segments || []).map((s) => ({ ...s }));
  if (!segs.length) return segs;
  const total = segs[segs.length - 1].endSec - segs[0].startSec || 1;
  const byLetter = new Map();
  segs.forEach((s, i) => { if (!byLetter.has(s.letter)) byLetter.set(s.letter, []); byLetter.get(s.letter).push(i); });
  const dur = (i) => segs[i].endSec - segs[i].startSec;
  const meanDur = segs.reduce((a, s) => a + (s.endSec - s.startSec), 0) / segs.length;
  const role = new Map();                                        // letter -> role
  // INTRO: the first part, when it is short and does not come back as a main part
  const firstL = segs[0].letter;
  const shortFirst = dur(0) < meanDur * 0.85 || dur(0) < (opts.introMaxSec || 20);
  if (byLetter.get(firstL).length === 1 && shortFirst) role.set(firstL, "Intro");
  // CHORUS: most repeated recurring part, tie-broken by energy (the hook is loud)
  const recurring = [...byLetter.entries()].filter(([l, ix]) => ix.length >= 2 && role.get(l) !== "Intro");
  // energy normalised across the song, so "loudest" is a real comparison rather than
  // an absolute level that depends on how hot the file was mastered.
  const maxE = Math.max(1e-9, ...segs.map((s) => s.energy || 0));
  const scoreOf = ([l, ix]) => ix.length * (0.6 + 0.4 * (ix.reduce((a, i) => a + (segs[i].energy || 0), 0) / ix.length) / maxE);
  recurring.sort((a, b) => scoreOf(b) - scoreOf(a));
  let chorusL = null, verseL = null;
  if (recurring.length) {
    const top = recurring.slice(0, 2);
    if (top.length === 2 && top[0][1].length === top[1][1].length) {
      // same repeat count → the LOUDER one is the chorus, and the other is the verse
      const e = ([l, ix]) => ix.reduce((a, i) => a + (segs[i].energy || 0), 0) / ix.length;
      const [x, y] = top;
      chorusL = e(x) >= e(y) ? x[0] : y[0];
      verseL = chorusL === x[0] ? y[0] : x[0];
    } else { chorusL = top[0][0]; verseL = top[1] ? top[1][0] : null; }
    role.set(chorusL, "Chorus");
    if (verseL) role.set(verseL, "Verse");
  }
  for (const [l, ix] of byLetter) {
    if (role.has(l)) continue;
    if (ix.length >= 2) { role.set(l, "Section"); continue; }
    const i = ix[0];
    const mid = (segs[i].startSec + segs[i].endSec) / 2 - segs[0].startSec;
    if (i === segs.length - 1 && (dur(i) < meanDur * 0.85 || mid / total > 0.9)) role.set(l, "Outro");
    else if (i === 0) role.set(l, "Intro");
    else if (chorusL && verseL && mid / total > 0.45) role.set(l, "Bridge");
    else role.set(l, "Instrumental");
  }
  const seen = new Map();
  const counts = new Map();
  for (const s of segs) counts.set(role.get(s.letter), (counts.get(role.get(s.letter)) || 0) + 1);
  for (const s of segs) {
    const r = role.get(s.letter) || "Section";
    const n = (seen.get(r) || 0) + 1;
    seen.set(r, n);
    s.role = r;
    s.label = counts.get(r) > 1 ? `${r} ${n}` : r;
  }
  return segs;
}
/* How finely to cut the song. Structure is genuinely subjective — is a pre-chorus its
 * own part? is the solo a section or part of the verse? — so this is a USER control,
 * not a constant to be tuned once. Measured on a real 4-minute stem: `fine` produced
 * 18 parts (unusable), `balanced` 7, `coarse` 5. Shared with the UI so the chips and
 * the engine can never disagree. */
const SECTION_SENSITIVITY = {
  coarse:   { minSectionSec: 20, noveltyThreshold: 0.8, label: "Fewer" },
  balanced: { minSectionSec: 14, noveltyThreshold: 0.5, label: "Balanced" },
  fine:     { minSectionSec: 8,  noveltyThreshold: 0.3, label: "More" },
};
/* The one entry point: PCM → { sections, boundaries, beats, bpm }. Reuses the beat
 * grid the chord decoder already found when the caller passes `beats`/`bpm`, so the
 * panel never tracks beats twice. Every returned time is in seconds. */
function detectSections(samples, sampleRate, opts = {}) {
  const bt = opts.beats && opts.beats.length > 4 ? { beats: opts.beats, bpm: opts.bpm || 0 } : detectBeats(samples, sampleRate, opts);
  const beats = bt.beats || [];
  const empty = { bpm: bt.bpm || 0, beats, boundaries: [], sections: [], novelty: [] };
  if (beats.length < 16) return empty;
  const segs = beatSegments(samples, sampleRate, beats, opts);   // per-beat chroma (HPSS by default) + energy
  if (segs.length < 16) return empty;
  const bands = _bandFeatures(samples, sampleRate, beats, opts);
  const tw = opts.timbreWeight != null ? opts.timbreWeight : 0.35;
  const T = Math.min(segs.length, bands.length);
  // per-beat feature: unit chroma (harmony) ++ unit band shape (arrangement)
  const feat = [];
  for (let i = 0; i < T; i++) {
    const c = segs[i].chroma, n = _l2(c) || 1;
    const v = new Float64Array(12 + bands[i].length);
    for (let p = 0; p < 12; p++) v[p] = ((c[p] / n) * (1 - tw));
    for (let p = 0; p < bands[i].length; p++) v[12 + p] = bands[i][p] * tw;
    feat.push(v);
  }
  // TIME-LAG EMBEDDING — compare phrases, not instants
  const m = Math.max(1, Math.min(opts.embed || 8, Math.floor(T / 4)));
  const emb = [];
  const half = Math.floor(m / 2);                                  // CENTRED: a forward-only
  for (let i = 0; i < T; i++) {                                    // stack shifts every boundary
    const v = new Float64Array(feat[0].length * m);                // half a phrase early.
    for (let k = 0; k < m; k++) { const src = feat[Math.max(0, Math.min(T - 1, i - half + k))]; v.set(src, k * feat[0].length); }
    emb.push(v);
  }
  // SSM (cosine) + Foote novelty
  const S = [];
  for (let i = 0; i < T; i++) { const row = new Float64Array(T); S.push(row); }
  const norms = emb.map((v) => _l2(v) || 1);
  for (let i = 0; i < T; i++) for (let j = i; j < T; j++) {
    let d = 0; const a = emb[i], b = emb[j];
    for (let k = 0; k < a.length; k++) d += a[k] * b[k];
    const s = d / (norms[i] * norms[j]);
    S[i][j] = s; S[j][i] = s;
  }
  const secPerBeat = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.5;
  const minSec = opts.minSectionSec || SECTION_SENSITIVITY.balanced.minSectionSec;
  const minGap = Math.max(2, Math.round(minSec / secPerBeat));
  /* The checkerboard kernel must not be WIDER than the shortest section we accept, or
   * it straddles two boundaries at once and smears both away. */
  const L = Math.max(3, Math.min(Math.round((opts.kernelSec || 4) / secPerBeat), Math.floor(minGap / 2), Math.floor(T / 4)));
  const nov = _footeNovelty(S, L);
  /* Normalise the novelty curve — over the INTERIOR only. At the edges the kernel is
   * truncated (half of it hangs off the matrix), which produces a huge artificial
   * spike; left in, it dominates the mean/σ and crushes every real boundary below the
   * threshold. So the edges are excluded from the statistics AND zeroed outright. */
  const lo = Math.min(L, T - 1), hi = Math.max(lo, T - L);
  let mean = 0, cnt = 0;
  for (let i = lo; i < hi; i++) { mean += nov[i]; cnt++; }
  mean /= cnt || 1;
  let sd = 0; for (let i = lo; i < hi; i++) sd += (nov[i] - mean) * (nov[i] - mean);
  sd = Math.sqrt(sd / (cnt || 1)) || 1;
  const z = Array.from(nov, (v, i) => (i < lo || i >= hi ? 0 : (v - mean) / sd));
  const thr = opts.noveltyThreshold != null ? opts.noveltyThreshold : SECTION_SENSITIVITY.balanced.noveltyThreshold;
  /* Peak-pick in two stages, which is what makes adjacent sections survive: a LOCAL
   * maximum test over a short window (a boundary is a narrow spike), then a GREEDY
   * strongest-first selection that enforces the minimum section length. Testing
   * "is it the max over ±minSection" instead would make two real boundaries one
   * section apart annihilate each other — the whole grid of an 8-bar-per-part song. */
  const peakWin = Math.max(2, Math.round(1.5 / secPerBeat));
  const cands = [];
  for (let i = L; i < T - L; i++) {
    if (z[i] < thr) continue;
    let isMax = true;
    for (let k = Math.max(0, i - peakWin); k <= Math.min(T - 1, i + peakWin); k++) if (z[k] > z[i]) { isMax = false; break; }
    if (isMax) cands.push(i);
  }
  cands.sort((a, b) => z[b] - z[a]);
  const peaks = [];
  for (const i of cands) {
    // a first/last section may legitimately be shorter than the floor (a lead-in, a
    // fade-out), so the edge rule is half the floor — but never a 1-bar sliver.
    if (i < minGap / 2 || T - i < minGap / 2) continue;
    if (peaks.some((p) => Math.abs(p - i) < minGap)) continue;
    peaks.push(i);
  }
  peaks.sort((a, b) => a - b);
  const bounds = [0, ...peaks, T];
  // segment features (unembedded means) → repetition clustering
  const raw = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const i0 = bounds[s], i1 = bounds[s + 1];
    const v = new Float64Array(feat[0].length);
    let energy = 0;
    for (let i = i0; i < i1; i++) { for (let k = 0; k < v.length; k++) v[k] += feat[i][k]; energy += segs[i].energy || 0; }
    const n = i1 - i0 || 1;
    for (let k = 0; k < v.length; k++) v[k] /= n;
    raw.push({ i0, i1, v, energy: energy / n, startSec: beats[i0], endSec: beats[Math.min(beats.length - 1, i1)] });
  }
  // adaptive similarity threshold: sections of the same part are far more alike than
  // the song's typical pair, and how much more is material-dependent — so the cut sits
  // between the median pair and the most-alike pair rather than at a magic constant.
  const sims = [];
  for (let i = 0; i < raw.length; i++) for (let j = i + 1; j < raw.length; j++) sims.push(_cosSim(raw[i].v, raw[j].v));
  sims.sort((a, b) => a - b);
  const q = (p) => (sims.length ? sims[Math.min(sims.length - 1, Math.floor(p * sims.length))] : 1);
  const cut = opts.clusterThreshold != null ? opts.clusterThreshold
    : Math.min(0.995, q(0.5) + (opts.clusterSplit != null ? opts.clusterSplit : 0.5) * (q(0.95) - q(0.5)));
  const clusters = [];
  for (const r of raw) {
    let bestI = -1, bestS = -1;
    clusters.forEach((c, ci) => { const s = _cosSim(r.v, c.centroid); if (s > bestS) { bestS = s; bestI = ci; } });
    if (bestI >= 0 && bestS >= cut) {
      const c = clusters[bestI];
      for (let k = 0; k < c.centroid.length; k++) c.centroid[k] = (c.centroid[k] * c.n + r.v[k]) / (c.n + 1);
      c.n++; r.cluster = bestI;
    } else { clusters.push({ centroid: Float64Array.from(r.v), n: 1 }); r.cluster = clusters.length - 1; }
  }
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const segOut = raw.map((r, i) => ({
    index: i,
    letter: LETTERS[r.cluster % 26],
    startSec: +r.startSec.toFixed(3),
    endSec: +r.endSec.toFixed(3),
    energy: r.energy,
    confidence: i === 0 ? 1 : Math.max(0, Math.min(1, z[bounds[i]] / 3)),
  }));
  return {
    bpm: bt.bpm || (secPerBeat ? 60 / secPerBeat : 0),
    beats,
    boundaries: segOut.slice(1).map((s) => s.startSec),
    sections: nameSections(segOut, opts),
    novelty: Array.from(z),
  };
}
/* Stamp detected sections onto a score's bars, so the label rides in the SAME
 * `bar.section` field the Guitar Pro / MusicXML importers fill — which means the
 * CSMPN (`- Chorus`), ChordSlashML (`[Chorus]`) and handoff exporters carry the
 * structure with ZERO new plumbing. Time → bar uses the score's own grid
 * (bar b starts at b · beatsPerBar · 60/bpm), the same grid `audioEventsToScore`
 * quantised onto, so the mapping is exact rather than a second guess. Returns a NEW
 * score (never mutates), and never puts two labels on one bar. */
function applySectionsToScore(score, sections, opts = {}) {
  if (!score || !score.bars) return score;
  const bars = score.bars.map((b) => { const { section, ...rest } = b; return rest; });
  const list = (sections || []).filter((s) => s && s.label && isFinite(s.startSec));
  if (list.length) {
    const bpm = Math.max(20, Math.min(400, opts.bpm || score.tempo || 120));
    const bpb = opts.beatsPerBar || (score.timeSig ? score.timeSig[0] : 4) || 4;
    const secPerBar = (60 / bpm) * bpb;
    const offset = opts.offsetSec || 0;
    const used = new Set();
    for (const s of [...list].sort((a, b) => a.startSec - b.startSec)) {
      let bi = Math.round((s.startSec - offset) / secPerBar);
      if (!isFinite(bi)) continue;
      bi = Math.max(0, Math.min(bars.length - 1, bi));
      while (used.has(bi) && bi + 1 < bars.length) bi++;             // one label per bar
      if (used.has(bi)) continue;
      used.add(bi);
      bars[bi] = { ...bars[bi], section: s.label };
    }
  }
  return { ...score, bars };
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
/* ---- review: batch commit + auto-resolve (pure; the Audio panel's ChordReview drives it) ----
 * `picks` = [{ index, symbol }] — for each, the event's label becomes `symbol` (one of its own
 * candidates: the detected label or an alternative, whose voicing comes with it) and the
 * event is marked reviewed. A symbol that is not one of the event's candidates is ignored —
 * a batch commit can only choose among what the decoder offered. Returns a NEW array. */
function commitChordChoices(events, picks) {
  const out = (events || []).slice();
  for (const pk of picks || []) {
    const e = out[pk.index];
    if (!e) continue;
    let symbol = e.symbol, midis = e.midis;
    if (pk.symbol != null && pk.symbol !== e.symbol) {
      const alt = (e.alternatives || []).find((a) => a.symbol === pk.symbol);
      if (!alt) continue;
      symbol = alt.symbol; midis = alt.midis || e.midis;
      // the replaced label stays one tap away: it becomes an alternative of the new choice
      const rest = (e.alternatives || []).filter((a) => a.symbol !== pk.symbol);
      out[pk.index] = { ...e, symbol, midis, alternatives: [{ symbol: e.symbol, prob: e.prob, midis: e.midis }, ...rest], prob: alt.prob, ambiguous: false, autoResolved: false, reviewed: true };
      continue;
    }
    out[pk.index] = { ...e, ambiguous: false, autoResolved: false, reviewed: true };
  }
  return out;
}
/* AUTO mode: accept the decoder's own best (posterior-MAP, context-decoded) label for every
 * uncertain chord, so the chart is complete with nothing pending. The events stay marked
 * `autoResolved` (with their alternatives) so the choice is auditable and reversible —
 * `reopenAutoChords` puts them back in the manual review queue. Measured on the benchmark:
 * uncertain chords are ~10% of the timeline and their top choice is right ~40% of the time;
 * the right answer is among the alternatives another ~24% — which is why the review list
 * stays one tap away rather than being hidden. */
function autoResolveChords(events) {
  return (events || []).map((e) => (e && e.ambiguous ? { ...e, ambiguous: false, autoResolved: true } : e));
}
function reopenAutoChords(events) {
  return (events || []).map((e) => (e && e.autoResolved && !e.reviewed ? { ...e, ambiguous: true, autoResolved: false } : e));
}

function audioEventsToScore(events, opts = {}) {
  const bpm = Math.max(20, Math.min(400, opts.bpm || 120));
  const beatsPerBar = opts.beatsPerBar || 4;
  const beatType = opts.beatType || 4;
  const secPerBeat = 60 / bpm;
  const placed = (events || []).filter((e) => e.symbol).map((e) => {
    const onsetBeat = e.startSec / secPerBeat;                 // global beat position
    return { symbol: e.symbol, midis: e.midis || [], onsetBeat: Math.max(0, onsetBeat), durBeat: Math.max(0.25, (e.durSec || secPerBeat) / secPerBeat), uncertain: !!e.ambiguous, reviewed: !!e.reviewed };
  }).sort((a, b) => a.onsetBeat - b.onsetBeat);
  const barsMap = new Map();                                   // barIndex -> events
  for (const p of placed) {
    const bar = Math.floor(p.onsetBeat / beatsPerBar + 1e-6);
    const inBar = p.onsetBeat - bar * beatsPerBar;
    if (!barsMap.has(bar)) barsMap.set(bar, []);
    barsMap.get(bar).push({ symbol: p.symbol, midis: p.midis, qbeat: Math.max(0, Math.min(beatsPerBar - 1e-6, inBar)), uncertain: p.uncertain, reviewed: p.reviewed });
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
      barsMap.set(b, [{ symbol: heldEv.symbol, midis: heldEv.midis, qbeat: 0, held: true, reviewed: heldEv.reviewed }]);
    }
  }
  const bars = [];
  for (let b = 0; b <= lastBar; b++) {
    const evs = (barsMap.get(b) || []).sort((a, b2) => a.qbeat - b2.qbeat);
    evs.forEach((e, i) => { e.beat = Math.max(0, Math.min(beatsPerBar - 1, Math.round(e.qbeat))); });
    for (let i = 1; i < evs.length; i++) if (evs[i].beat <= evs[i - 1].beat) evs[i].beat = Math.min(beatsPerBar - 1, evs[i - 1].beat + 1);
    evs.forEach((e, i) => { e.durBeats = (i + 1 < evs.length ? evs[i + 1].beat : beatsPerBar) - e.beat; });
    _fillTrueDur(evs, beatsPerBar);
    bars.push({ number: b + 1, timeSig: [beatsPerBar, beatType], events: evs.map((e) => ({ symbol: e.symbol, midis: e.midis, beat: e.beat, durBeats: e.durBeats, qbeat: e.qbeat, qdur: e.qdur, ...(e.held ? { held: true } : {}), ...(e.uncertain ? { uncertain: true } : {}), ...(e.reviewed ? { reviewed: true } : {}) })) });
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

/* ---- Guitar note transcription: the Kong high-resolution CRNN (guitar weights) ----
 * The Stage 1–2 model of docs/AUDIO-TO-TAB-PLAN.md: Riley et al.'s guitar retraining
 * (MIT, `xavriley/midi-transcription-models`, GAPS) of Kong et al.'s onset/offset-
 * REGRESSION CRNN. The ONNX graph takes 10 s of 16 kHz audio (log-mel inside) and returns
 * four [1001 × 88] matrices: regressed onset, regressed offset, frame and velocity, at
 * 100 frames/s from A0 (MIDI 21). This is the pure, headless half — a faithful port of
 * piano_transcription_inference's enframe/deframe + RegressionPostProcessor; the
 * browser glue (guitar-model.js) only runs the graph.
 *  - Segments: 10 s windows, hop 5 s, zero-padded to a whole number of windows; deframe
 *    keeps the middle half of each (first: 0–75 %, last: 25 %–end) after dropping the
 *    extra centre=True frame.
 *  - Onsets/offsets: a frame is a peak when it beats `threshold` and rises/falls
 *    monotonically for `neighbour` frames (2 for onsets, 4 for offsets); the sub-frame
 *    shift is Kong's 3-point regression (Section III-D), clamped to ±½ frame (two deliberate
 *    deviations from the Python: equal neighbours → 0 instead of a divide-by-zero, and a
 *    near-flat peak can no longer throw an onset to a negative time).
 *  - Notes: per pitch, onset → the earlier of (offset peak, frame < frameThreshold)
 *    with Kong's tie rule, a repeated onset closes the previous note, 6 s cap.
 * Measured on GuitarSet (360 tracks, mic): see CLAUDE.md "Guitar → TAB". */
const CRNN = { sr: 16000, segment: 160000, fps: 100, classes: 88, minMidi: 21, velocityScale: 128 };

/** Split mono 16 kHz PCM into the model's 10 s windows (hop = half a window). */
function crnnSegments(pcm, segment = CRNN.segment) {
  const n = Math.max(1, Math.ceil(pcm.length / segment)) * segment;
  const x = new Float32Array(n); x.set(pcm.subarray ? pcm.subarray(0, n) : pcm.slice(0, n));
  const out = [];
  for (let p = 0; p + segment <= n; p += segment / 2) out.push(x.subarray(p, p + segment));
  return out;
}

/** Re-join per-window matrices (each Float32Array [framesPerSeg × classes], row-major) into
 *  one [frames × classes] matrix, exactly as Kong's deframe, truncated to `frames`. */
function crnnDeframe(segs, framesPerSeg, classes, frames) {
  let rows = [];
  if (segs.length === 1) rows = [[segs[0], 0, framesPerSeg]];
  else {
    const L = framesPerSeg - 1;                                  // drop the centre=True extra frame
    const q1 = Math.floor(L * 0.25), q3 = Math.floor(L * 0.75);
    rows.push([segs[0], 0, q3]);
    for (let i = 1; i < segs.length - 1; i++) rows.push([segs[i], q1, q3]);
    rows.push([segs[segs.length - 1], q1, L]);
  }
  const total = rows.reduce((s, [, a, b]) => s + (b - a), 0);
  const T = Math.min(frames ?? total, total);
  const out = new Float32Array(T * classes);
  let t = 0;
  for (const [m, a, b] of rows) for (let r = a; r < b && t < T; r++, t++) out.set(m.subarray(r * classes, (r + 1) * classes), t * classes);
  return out;
}

/** Peak-pick a regressed onset/offset matrix → { bin: Uint8Array, shift: Float32Array }. */
function crnnBinarize(reg, frames, classes, threshold, neighbour) {
  const bin = new Uint8Array(frames * classes), shift = new Float32Array(frames * classes);
  for (let k = 0; k < classes; k++) {
    const x = (n) => reg[n * classes + k];
    for (let n = neighbour; n < frames - neighbour; n++) {
      const v = x(n);
      if (!(v > threshold)) continue;
      let mono = true;
      for (let i = 0; i < neighbour && mono; i++) if (x(n - i) < x(n - i - 1) || x(n + i) < x(n + i + 1)) mono = false;
      if (!mono) continue;
      bin[n * classes + k] = 1;
      const a = x(n - 1), b = x(n + 1);
      const den = a > b ? v - b : v - a;
      // Kong's 3-point estimate is a sub-frame correction (±½ frame); a near-flat peak makes the
      // denominator tiny and the Python can then place an onset at a NEGATIVE time (seen on
      // GuitarSet). Clamp to the method's own range; 0 when the denominator is exactly 0.
      shift[n * classes + k] = den !== 0 ? Math.max(-0.5, Math.min(0.5, (b - a) / den / 2)) : 0;
    }
  }
  return { bin, shift };
}

/** Model outputs ({ onset, offset, frame, velocity } as [frames × 88] Float32Arrays) →
 *  notes `{ midi, startSec, durSec, endSec, velocity, amp }`, sorted by time then pitch. */
function crnnNotesFromOutputs(out, opts = {}) {
  const classes = opts.classes || CRNN.classes, fps = opts.fps || CRNN.fps, minMidi = opts.minMidi ?? CRNN.minMidi;
  const frames = Math.floor(out.frame.length / classes);
  const onT = opts.onsetThreshold ?? 0.3, offT = opts.offsetThreshold ?? 0.3, frT = opts.frameThreshold ?? 0.1;
  const on = crnnBinarize(out.onset, frames, classes, onT, 2), off = crnnBinarize(out.offset, frames, classes, offT, 4);
  const notes = [];
  for (let k = 0; k < classes; k++) {
    const at = (arr, i) => arr[i * classes + k];
    // Kong's loop uses Python truthiness (frame 0 counts as "no onset"); peaks never land on
    // frames 0–1 (neighbour ≥ 2), so a null check is equivalent.
    let bgn = null, gone = null, offAt = null;
    const emit = (b, f, offShift) => notes.push({ b, f, ons: at(on.shift, b), offs: offShift, vel: at(out.velocity, b), k });
    for (let i = 0; i < frames; i++) {
      if (at(on.bin, i) === 1) {
        if (bgn != null) { emit(bgn, Math.max(i - 1, 0), 0); gone = offAt = null; }
        bgn = i;
      }
      if (bgn != null && i > bgn) {
        if (at(out.frame, i) <= frT && gone == null) gone = i;
        if (at(off.bin, i) === 1 && offAt == null) offAt = i;
        if (gone != null) {
          const fin = offAt != null && offAt - bgn > gone - offAt ? offAt : gone;
          emit(bgn, fin, at(off.shift, fin)); bgn = gone = offAt = null;
        }
        if (bgn != null && (i - bgn >= 600 || i === frames - 1)) { emit(bgn, i, at(off.shift, i)); bgn = gone = offAt = null; }
      }
    }
  }
  return notes.map((n) => {
    const startSec = (n.b + n.ons) / fps, endSec = (n.f + n.offs) / fps;
    return { midi: minMidi + n.k, startSec: +startSec.toFixed(4), endSec: +endSec.toFixed(4), durSec: +Math.max(0, endSec - startSec).toFixed(4), velocity: Math.trunc(n.vel * CRNN.velocityScale), amp: +n.vel.toFixed(3) };
  }).sort((a, b) => a.startSec - b.startSec || a.midi - b.midi);
}

/** Orchestrator over a pluggable model: `model(segment: Float32Array) →
 *  { onset, offset, frame, velocity }` (each [framesPerSeg × 88]). pcm must be mono 16 kHz.
 *  Returns { notes, score } — the score is fingered (`fingerScore`), so the chart carries a
 *  tab and AlphaTex/CSMPN {tab} export works directly. `opts.onProgress(done, total)`. */
async function transcribeGuitar(pcm, model, opts = {}) {
  if (typeof model !== "function") throw new Error("no guitar model configured");
  const segs = crnnSegments(pcm);
  const per = { onset: [], offset: [], frame: [], velocity: [] };
  let fpsSeg = 0;
  for (let i = 0; i < segs.length; i++) {
    const o = await model(segs[i]);
    for (const k of Object.keys(per)) per[k].push(o[k]);
    fpsSeg = Math.round(o.frame.length / CRNN.classes);
    if (opts.onProgress) opts.onProgress(i + 1, segs.length);
  }
  const frames = Math.floor(pcm.length / (CRNN.sr / CRNN.fps)) + 1;
  const out = {};
  for (const k of Object.keys(per)) out[k] = crnnDeframe(per[k], fpsSeg, CRNN.classes, frames);
  const notes = crnnNotesFromOutputs(out, opts);
  const score = notes.length ? fingerScore(polyNotesToScore(notes, opts), { tuning: opts.tuning }) : null;
  return { notes, score };
}

/* ---- SATB-style voice separation --------------------------------------------
 * The ML note transcription is polyphonic BUT UNLABELED — every simultaneous note
 * is dumped in one bucket. For a vocal-harmony stem the user wants each VOICE as its
 * own line (soprano / alto / tenor / bass, or lead + harmonies) so every singer can
 * read THEIR part. Two methods, same output shape ({ midi, startSec, durSec, voice },
 * voice 0 = highest slot):
 *
 *  - "voiceLeading" (DEFAULT, 2026-10-11) — the contig/voice-leading approach used by
 *    symbolic voice-separation research (Chew & Wu 2004; Kilian & Hoos 2002):
 *      1. Cut the timeline into slices where the active set is constant.
 *      2. LEARN each voice's register from the "full-texture" slices — the moments
 *         where all V voices sound together, so the rank → voice mapping is
 *         unambiguous (weighted median of rank r = voice r's centre).
 *      3. Walk the slices in time order and solve an ORDER-PRESERVING assignment of
 *         the k active notes to the V slots (a tiny DP, O(k·V)): voices never cross
 *         inside a simultaneity, a HELD note keeps its slot (cost 0), and otherwise
 *         a note goes to the slot whose reference pitch — its last sung note,
 *         decaying toward the learned register over `memorySec` of silence — is
 *         nearest. When k > V the DP drops the notes that fit worst (an octave
 *         ghost above the soprano is dropped, not the real bass); when k < V the
 *         unmatched slots simply rest.
 *    Why it exists: the register method put EVERY note into voice 0 whenever only
 *    one part was singing, so on a real 3-part stem ("25 or 6 to 4") voice 1 spanned
 *    MIDI 55–84 with a mean step of 7.6 semitones (37 leaps > a fifth) — not one
 *    singer's line. Measured after: see CLAUDE.md "Vocal score v2".
 *  - "register" (legacy) — per slice, sort by pitch and assign top→bottom to slots
 *    0..V-1. A sustained note whose rank changes is emitted as two runs.
 *
 * Both: each per-voice line is MONOPHONIC (a held note that must change slot is
 * emitted as two runs); notes are never invented. Pure → headless-tested. Composes
 * with polyNotesToScore (filter by `voice`, one score per voice).
 *
 * Honest limits: voices cannot cross inside a simultaneity (ordering is enforced —
 * real choral writing rarely crosses); a part that sings ALONE far outside its
 * learned register can be attributed to the neighbouring voice — ✎ Edit fixes it. */
const _VL_EPS = 1e-4;
function _voiceSlices(notes) {
  const bounds = new Set();
  for (const n of notes) { bounds.add(+n.startSec.toFixed(6)); bounds.add(+(n.startSec + n.durSec).toFixed(6)); }
  const T = [...bounds].sort((a, b) => a - b);
  /* sweep: notes sorted by start, an active list pruned as slices advance — O(N·k)
   * instead of scanning every note per slice. */
  const byStart = notes.slice().sort((a, b) => a.startSec - b.startSec);
  const slices = [];
  let ni = 0, live = [];
  for (let i = 0; i < T.length - 1; i++) {
    const t0 = T[i], t1 = T[i + 1];
    while (ni < byStart.length && byStart[ni].startSec <= t0 + _VL_EPS) live.push(byStart[ni++]);
    live = live.filter((n) => n.startSec + n.durSec >= t1 - _VL_EPS);
    if (t1 - t0 < _VL_EPS || !live.length) continue;
    slices.push({ t0, t1, active: live.slice().sort((a, b) => b.midi - a.midi) });  // pitch DESC
  }
  return slices;
}
/* Duration-weighted median of [value, weight] pairs. */
function _wMedian(pairs) {
  if (!pairs.length) return null;
  const s = pairs.slice().sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((a, p) => a + p[1], 0);
  let acc = 0;
  for (const p of s) { acc += p[1]; if (acc >= tot / 2) return p[0]; }
  return s[s.length - 1][0];
}
/* Each voice's register, learned from the slices where the texture is FULL (exactly V
 * notes; else ≥ V; else the widest texture present, top-aligned). Returns V centres in
 * MIDI (descending), null for a slot the material never defines. */
function _voiceCenters(slices, V) {
  let pool = slices.filter((s) => s.active.length === V);
  if (pool.reduce((a, s) => a + s.t1 - s.t0, 0) < 0.25) pool = slices.filter((s) => s.active.length >= V);
  let width = V;
  if (!pool.length) {
    width = Math.max(0, ...slices.map((s) => s.active.length));
    pool = slices.filter((s) => s.active.length === width);
  }
  const centers = new Array(V).fill(null);
  for (let r = 0; r < Math.min(width, V); r++) centers[r] = _wMedian(pool.map((s) => [s.active[r].midi, s.t1 - s.t0]));
  for (let r = 1; r < V; r++) if (centers[r] != null && centers[r - 1] != null && centers[r] > centers[r - 1]) centers[r] = centers[r - 1];
  return centers;
}
function splitVoices(notes, opts = {}) {
  const V = Math.max(1, Math.min(8, opts.voices | 0 || 3));
  if (!notes || !notes.length) return [];
  const slices = _voiceSlices(notes);
  const assign = opts.method === "register" ? _assignByRegister(slices, V) : _assignByVoiceLeading(slices, V, opts);
  /* Emission — per (source note, voice slot) run tracker: extends the last emitted note
   * when the same source stays in the same voice across adjacent slices (no false
   * split); a slot change starts a new run, keeping every voice line monophonic. */
  const srcIdx = new Map();
  notes.forEach((n, i) => srcIdx.set(n, i));
  const out = [];
  const runs = new Map();
  slices.forEach((sl, si) => {
    for (const [n, v] of assign[si]) {
      const key = srcIdx.get(n) * 8 + v;
      const prev = runs.get(key);
      if (prev && Math.abs(prev.startSec + prev.durSec - sl.t0) < _VL_EPS) {
        prev.durSec = sl.t1 - prev.startSec;
      } else {
        const emit = { midi: n.midi, startSec: sl.t0, durSec: sl.t1 - sl.t0, voice: v };
        if (n.amp != null) emit.amp = n.amp;
        out.push(emit);
        runs.set(key, emit);
      }
    }
  });
  out.sort((a, b) => a.startSec - b.startSec || a.voice - b.voice);
  return out;
}
/* Legacy register split: rank r → slot r. Returns per-slice [[note, slot]…]. */
function _assignByRegister(slices, V) {
  return slices.map((sl) => sl.active.slice(0, V).map((n, v) => [n, v]));
}
/* Voice-leading split (see the block comment above). Costs are in SEMITONES so the
 * knobs read musically: a held note switching slots pays `switchCost` (default 6 —
 * a tritone's worth of evidence is needed to move it), a slot with no reference
 * pitch costs `undefinedCost` (12 — an octave), and a dropped note costs 100 plus
 * its onset strength, which makes "keep as many notes as there are voices" the first
 * priority and "drop the weakest misfit" the tiebreak. */
function _assignByVoiceLeading(slices, V, opts = {}) {
  const centers = _voiceCenters(slices, V);
  const memory = opts.memorySec != null ? opts.memorySec : 2;
  const SWITCH = opts.switchCost != null ? opts.switchCost : 6;
  const UNDEF = opts.undefinedCost != null ? opts.undefinedCost : 12;
  const out = new Array(slices.length).fill(null);
  /* Phase A — POLYPHONIC slices (≥ 2 notes): order-preserving DP, slice by slice. */
  const state = Array.from({ length: V }, () => ({ src: null, last: null, lastEnd: -Infinity }));
  const slotOf = new Map();                                        // source note → slot it currently sings in
  slices.forEach((sl, si) => {
    const A = sl.active, k = A.length;
    if (k < 2 && V > 1) return;                                    // monophonic → phase B
    const refOf = (v) => {
      const st = state[v], c = centers[v];
      if (st.last == null) return c;
      if (c == null) return st.last;
      const w = Math.exp(-Math.max(0, sl.t0 - st.lastEnd) / Math.max(1e-3, memory));
      return w * st.last + (1 - w) * c;
    };
    const refs = Array.from({ length: V }, (_, v) => refOf(v));
    const match = (n, v) => {
      if (state[v].src === n) return 0;                            // held note continues in its slot
      const r = refs[v];
      let c = r == null ? UNDEF : Math.abs(n.midi - r);
      const prevSlot = slotOf.get(n);
      if (prevSlot != null && prevSlot !== v) c += SWITCH;
      return c;
    };
    const drop = (n) => 100 + (n.amp != null ? n.amp : 0.5) * 10;
    // DP over (i notes placed, j slots consumed); 0 = slot rests, 1 = drop note, 2 = match
    const D = Array.from({ length: k + 1 }, () => new Float64Array(V + 1).fill(Infinity));
    const B = Array.from({ length: k + 1 }, () => new Int8Array(V + 1).fill(-1));
    D[0][0] = 0;
    for (let i = 0; i <= k; i++) for (let j = 0; j <= V; j++) {
      if (i === 0 && j === 0) continue;
      let best = Infinity, bp = -1;
      if (j > 0 && D[i][j - 1] < best) { best = D[i][j - 1]; bp = 0; }
      if (i > 0) { const c = D[i - 1][j] + drop(A[i - 1]); if (c < best) { best = c; bp = 1; } }
      if (i > 0 && j > 0) { const c = D[i - 1][j - 1] + match(A[i - 1], j - 1); if (c < best) { best = c; bp = 2; } }
      D[i][j] = best; B[i][j] = bp;
    }
    const pairs = [];
    for (let i = k, j = V; i > 0 || j > 0;) {
      const bp = B[i][j];
      if (bp === 2) { pairs.push([A[i - 1], j - 1]); i--; j--; }
      else if (bp === 1) i--;
      else j--;
    }
    pairs.reverse();
    for (const [n, v] of pairs) { state[v] = { src: n, last: n.midi, lastEnd: sl.t1 }; slotOf.set(n, v); }
    for (let v = 0; v < V; v++) if (state[v].src && !pairs.some((p) => p[1] === v)) state[v] = { ...state[v], src: null };
    out[si] = pairs;
  });
  if (V === 1) return out.map((p, si) => p || [[slices[si].active[0], 0]]);
  /* Phase B — MONOPHONIC runs, assigned WHOLE (Chew & Wu's contig linking). A run is
   * a stretch where one note sounds at a time, broken by a polyphonic slice, a
   * silence longer than `runGapSec`, or a leap wider than `runLeap` semitones (two
   * singers trading phrases). A melody sung alone must not be shredded across
   * staves, so each run goes to the ONE slot that best links to the voices sounding
   * just before and after it (pitch distance, decaying toward register fit over
   * `memorySec` of separation), plus how well the run sits in that slot's register.
   * Measured on a verse-solo → 3-part-chorus arrangement: the per-slice pass split
   * the solo verse 14/15/9 across staves; run linking keeps it on the lead staff. */
  const runGap = opts.runGapSec != null ? opts.runGapSec : 1.0;
  const runLeap = opts.runLeap != null ? opts.runLeap : 9;
  const slotNotes = Array.from({ length: V }, () => []);          // phase-A notes per slot: [t0, t1, midi]
  out.forEach((pairs, si) => { if (pairs) for (const [n, v] of pairs) slotNotes[v].push([slices[si].t0, slices[si].t1, n.midi]); });
  const runs = [];
  let cur = null;
  slices.forEach((sl, si) => {
    if (out[si]) { cur = null; return; }
    const n = sl.active[0];
    const prev = cur && slices[cur.idx[cur.idx.length - 1]];
    const prevN = prev && prev.active[0];
    if (cur && sl.t0 - prev.t1 <= runGap && (prevN === n || Math.abs(prevN.midi - n.midi) <= runLeap)) cur.idx.push(si);
    else { cur = { idx: [si] }; runs.push(cur); }
  });
  const regCost = (m, v) => (centers[v] == null ? UNDEF : Math.abs(m - centers[v]));
  for (const run of runs) {
    const first = slices[run.idx[0]], last = slices[run.idx[run.idx.length - 1]];
    const ms = run.idx.map((i) => [slices[i].active[0].midi, slices[i].t1 - slices[i].t0]);
    const med = _wMedian(ms);
    let bestV = 0, bestC = Infinity;
    for (let v = 0; v < V; v++) {
      const reg = regCost(med, v);
      let before = null, after = null;
      for (const nt of slotNotes[v]) { if (nt[1] <= first.t0 + _VL_EPS) before = nt; else if (nt[0] >= last.t1 - _VL_EPS && !after) after = nt; }
      const side = (nt, pitch, gap) => {
        if (!nt) return reg;
        const w = Math.exp(-Math.max(0, gap) / Math.max(1e-3, memory));
        return w * Math.abs(pitch - nt[2]) + (1 - w) * reg;
      };
      const c = side(before, slices[run.idx[0]].active[0].midi, before ? first.t0 - before[1] : 0)
        + side(after, slices[run.idx[run.idx.length - 1]].active[0].midi, after ? after[0] - last.t1 : 0) + reg;
      if (c < bestC) { bestC = c; bestV = v; }
    }
    for (const i of run.idx) out[i] = [[slices[i].active[0], bestV]];
  }
  return out;
}

/* How many parts does this stem actually have? The largest k such that ≥ k notes
 * sound together for a meaningful share of the sung time (≥ `minSec` AND ≥ `minFrac`
 * of it) — so a single 80 ms chord blip doesn't summon a phantom fourth voice. The UI
 * shows it as the suggested Split. Returns { count, coverage:{k: sec}, sungSec }. */
function suggestVoiceCount(notes, opts = {}) {
  const maxV = opts.maxVoices || 4;
  if (!notes || !notes.length) return { count: 1, coverage: {}, sungSec: 0 };
  const slices = _voiceSlices(notes);
  const sung = slices.reduce((a, s) => a + s.t1 - s.t0, 0);
  const coverage = {};
  for (let k = 1; k <= maxV; k++) coverage[k] = +slices.filter((s) => s.active.length >= k).reduce((a, s) => a + s.t1 - s.t0, 0).toFixed(3);
  const minSec = opts.minSec != null ? opts.minSec : 0.5, minFrac = opts.minFrac != null ? opts.minFrac : 0.05;
  let count = 1;
  for (let k = 2; k <= maxV; k++) if (coverage[k] >= minSec && coverage[k] >= minFrac * sung) count = k;
  return { count, coverage, sungSec: +sung.toFixed(3) };
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
  // Optional HPSS: the same drum-suppressed chroma the chord decoder uses. Opt-in here
  // (`hpss:true`) rather than default-on, because this feeds the Play-Along aligner and
  // its behaviour is pinned by tests — see alignPcmToScore for the measured effect.
  if (opts.hpss) return harmonicChromagram(samples, sampleRate, { ...opts, hop, window: win });
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
/* ============================================================================
 * Chord-voicing library — the lead-sheet "show me the grip" modal (2026-10-24)
 * ----------------------------------------------------------------------------
 * Tap a chord on the lead sheet → a modal of guitar chord diagrams: the
 * dictionary shapes (data/chords.json, tombatossals/chords-db, MIT) plus voicings
 * DERIVED from the chord's interval formula — drop 2, drop 3, close triads, guide-
 * tone shells, slash-bass grips and an exhaustive fretboard search. Everything
 * here is pure (no fetch, no DOM): the UI fetches chords.json once and hands the
 * parsed object in, so the whole voicing pipeline is headless-testable.
 *
 * Pipeline:  symbol → parseChordSymbolForVoicings (aliases, slash bass kept for
 * display, lookup on the main chord) → voicingFormula (interval grammar: every
 * suffix the parser understands has a tone list, so a chord the dictionary lacks
 * still gets voicings) → dictionary positions (looked up by root PITCH CLASS, so
 * Db finds the Csharp entry) + generated groups → one deduped, finger-assigned,
 * pitch-validated list per group.
 *
 * Data model of a voicing (strings by ENGINE index, 0 = low E … 5 = high e, the
 * same convention as TUNINGS/fingerScore):
 *   { frets:[6] (-1 muted, 0 open, absolute fret), fingers:[6] (0 none, 1–4),
 *     baseFret, fretCount, labels:[6] (interval per sounding string), midi:[],
 *     title, group, source:"dict"|"gen", rootless? }
 * Standard tuning only (the dictionary is standard-tuned).
 * ========================================================================== */
const _VC_OPEN = [40, 45, 50, 55, 59, 64];            // E2 A2 D3 G3 B3 E4 — engine idx 0 = low E
const VOICING_DICT_KEYS = ["C", "Csharp", "D", "Eb", "E", "F", "Fsharp", "G", "Ab", "A", "Bb", "B"]; // chords.json key, by pc
const _VC_MAX_FRET = 15;
const _VC_PC = { C: 0, "B#": 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, Fb: 4, "E#": 5, F: 5, "F#": 6, Gb: 6,
  G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11, Cb: 11 };
const _VC_GENERIC_LABEL = ["R", "b9", "9", "b3", "3", "11", "#11", "5", "b13", "6", "b7", "7"];

/* Parser aliases (the lead-sheet spellings a player writes → the parser's canonical
 * suffix). The list the feature was specified with, plus the spellings this engine
 * itself emits (m7♭5, m(maj7), 7♭9 …) and common Real-Book variants. Anything not
 * listed still parses through the interval grammar in voicingFormula. */
const CHORD_SUFFIX_ALIASES = {
  "": "", maj: "", major: "", M: "", Maj: "",
  m: "m", min: "m", "-": "m", minor: "m", mi: "m",
  m7: "m7", min7: "m7", "-7": "m7", mi7: "m7",
  maj7: "maj7", "Δ7": "maj7", "Δ": "maj7", "^7": "maj7", "^": "maj7", M7: "maj7", Maj7: "maj7", ma7: "maj7",
  dim: "dim", "°": "dim", o: "dim",
  dim7: "dim7", "°7": "dim7", o7: "dim7",
  aug: "aug", "+": "aug",
  m7b5: "m7b5", "ø": "m7b5", "ø7": "m7b5", "-7b5": "m7b5", min7b5: "m7b5",
  sus: "sus4", sus4: "sus4", sus2: "sus2",
  "7#5": "aug7", "7+5": "aug7", "+7": "aug7", aug7: "aug7",
  "9#5": "aug9", "9+5": "aug9", "+9": "aug9", aug9: "aug9",
  "6/9": "69", "69": "69", "m6/9": "m69", m69: "m69", "-69": "m69", "-6/9": "m69",
  mmaj7: "mmaj7", "m(maj7)": "mmaj7", mM7: "mmaj7", "-Δ7": "mmaj7", "-Δ": "mmaj7", "m^7": "mmaj7", minmaj7: "mmaj7", "-maj7": "mmaj7",
  "-6": "m6", min6: "m6", "-9": "m9", min9: "m9", "-11": "m11", min11: "m11", "-13": "m13", min13: "m13",
  "Δ9": "maj9", "^9": "maj9", M9: "maj9", "Δ13": "maj13", "^13": "maj13", M13: "maj13",
  "Δ7#11": "maj7#11", "Δ#11": "maj7#11", "^7#11": "maj7#11", "maj7+11": "maj7#11",
  "7alt": "alt", alt: "alt",
  add2: "add9", "m(add9)": "madd9", "-add9": "madd9", add4: "add11",
};
/* canonical suffix → chords.json suffix name, where they differ */
const _VC_DICT_NAME = { "": "major", m: "minor", "7#5": "aug7", "9#5": "aug9",
  alt: null };   // chords.json "alt" files C-E-G♭ (a ♭5 triad), not a 7alt — never route a lead-sheet alt there

function _vcClean(s) {
  return String(s == null ? "" : s)
    .replace(/♭/g, "b").replace(/♯/g, "#").replace(/∆/g, "Δ").replace(/[−–]/g, "-")
    .replace(/[º˚]/g, "°").replace(/Ø/g, "ø").replace(/\s+/g, "");
}

/* Interval grammar: a chord suffix → its tones. Returns
 *   { tones:[{semi,label}], required:[semi], requireAny:[semi]|null, core4:[semi]|null }
 * or null when the suffix isn't a chord this grammar knows. `required` is what a grip
 * must sound to BE the chord (the unaltered 5th and lower extensions are optional,
 * as every voicing book voices them); `core4` is the four-tone set the drop-2/drop-3
 * generator builds from (guide tones first, then colour, then root, then 5th). */
function voicingFormula(suffix) {
  let s = _vcClean(suffix).replace(/[(),]/g, "");
  if (s === "major" || s === "maj" || s === "M" || s === "Maj") s = "";
  else if (s === "minor") s = "m";
  else if (s === "sus") s = "sus4";
  if (s === "Δ" || s === "^") s = "maj7";
  if (s === "alt" || s === "7alt") {
    return _vcBuild({ third: 4, fifth: null, seventh: 10, exts: [[1, "b9"], [3, "#9"], [6, "#11"], [8, "b13"]],
      requireAny: [1, 3, 6, 8], fifthOptional: true });
  }
  if (s === "5") return _vcBuild({ third: null, fifth: 7, power: true });
  const st = { third: 4, fifth: 7, seventh: null, sixth: false, exts: [], majSev: false, dimSev: false,
    sus4: false, sus2: false, no3: false, no5: false, fifthAltered: false, thirdOptional: false };
  let r = s, m;
  if ((m = r.match(/^(m|min|mi|-)(maj|Maj|MAJ|ma(?=\d)|Δ|\^|M)/))) { st.third = 3; st.majSev = true; r = r.slice(m[0].length); if (!/^\d/.test(r)) r = "7" + r; }
  else if ((m = r.match(/^ø/))) { st.third = 3; st.fifth = 6; st.fifthAltered = true; r = r.slice(1); if (!/^\d/.test(r)) r = "7" + r; }
  else if ((m = r.match(/^(dim|°|o(?=7|$))/))) { st.third = 3; st.fifth = 6; st.fifthAltered = true; st.dimSev = true; r = r.slice(m[0].length); }
  else if ((m = r.match(/^(aug|\+)(?!\d\d)/)) && !/^\+(5|9|11|13)/.test(r)) { st.fifth = 8; st.fifthAltered = true; r = r.slice(m[0].length); }
  else if ((m = r.match(/^(maj|Maj|MAJ|ma(?=\d)|Δ|\^|M)/))) { st.majSev = true; r = r.slice(m[0].length); if (!/^\d/.test(r)) r = "7" + r; }
  else if ((m = r.match(/^(min|mi|m|-)/)) && !/^-(5|9|13)/.test(r)) { st.third = 3; r = r.slice(m[0].length); }
  let num = null;
  if ((m = r.match(/^(13|11|69|6\/9|9|7|6)/))) { num = m[1]; r = r.slice(m[0].length); }
  if (num === "6") st.sixth = true;
  else if (num === "69" || num === "6/9") { st.sixth = true; st.exts.push([2, "9"]); }
  else if (num) {
    st.seventh = st.majSev ? 11 : st.dimSev && num === "7" ? 9 : 10;
    if (num === "9" || num === "11" || num === "13") st.exts.push([2, "9", num !== "9"]);
    if (num === "11") { st.exts.push([5, "11"]); if (st.third === 4) st.thirdOptional = true; }
    if (num === "13") { st.exts.push([5, "11", true]); st.exts.push([9, "13"]); }   // 11 optional: dictionaries voice it
  }
  const SEV = () => { if (st.seventh == null && !st.sixth) st.seventh = st.majSev ? 11 : 10; };
  while (r.length) {
    if ((m = r.match(/^sus2sus4|^sus24/))) { st.sus2 = st.sus4 = true; }
    else if ((m = r.match(/^sus4|^sus(?!2)/))) st.sus4 = true;
    else if ((m = r.match(/^sus2/))) st.sus2 = true;
    else if ((m = r.match(/^add(9|2)/))) st.exts.push([2, "9"]);
    else if ((m = r.match(/^add(11|4)/))) st.exts.push([5, "11"]);
    else if ((m = r.match(/^add(13|6)/))) st.exts.push([9, st.seventh != null ? "13" : "6"]);
    else if ((m = r.match(/^(b|-)5/))) { st.fifth = 6; st.fifthAltered = true; }
    else if ((m = r.match(/^(#|\+)5/))) { st.fifth = 8; st.fifthAltered = true; }
    else if ((m = r.match(/^(b|-)9/))) { SEV(); st.exts.push([1, "b9"]); }
    else if ((m = r.match(/^(#|\+)9/))) { SEV(); st.exts.push([3, "#9"]); }
    else if ((m = r.match(/^(#|\+)11/))) { SEV(); st.exts.push([6, "#11"]); }
    else if ((m = r.match(/^(b|-)13/))) { SEV(); st.exts.push([8, "b13"]); }
    else if ((m = r.match(/^(maj7|M7|Δ7|Δ|\^7)/))) { st.seventh = 11; }
    else if ((m = r.match(/^13/))) { SEV(); st.exts.push([9, "13"]); }
    else if ((m = r.match(/^11/))) { SEV(); st.exts.push([5, "11"]); }
    else if ((m = r.match(/^9/))) { SEV(); st.exts.push([2, "9"]); }
    else if ((m = r.match(/^7/))) { SEV(); }
    else if ((m = r.match(/^6/))) { st.sixth = true; }
    else if ((m = r.match(/^(no|omit)3/))) st.no3 = true;
    else if ((m = r.match(/^(no|omit)5/))) st.no5 = true;
    else return null;
    r = r.slice(m[0].length);
  }
  if (st.sus4 || st.sus2 || st.no3) st.third = null;
  return _vcBuild(st);
}
function _vcBuild(st) {
  const tones = [], req = new Set(), has = (semi) => tones.some((t) => t.semi === semi);
  const add = (semi, label, required) => { if (has(semi)) return; tones.push({ semi, label }); if (required) req.add(semi); };
  add(0, "R", true);
  if (st.third != null) add(st.third, st.third === 3 ? "b3" : "3", !st.thirdOptional);
  if (st.sus2) add(2, "2", true);
  if (st.sus4) add(5, "4", true);
  if (st.seventh != null) add(st.seventh, st.seventh === 11 ? "7" : st.seventh === 9 ? "bb7" : "b7", true);
  if (st.sixth) add(9, st.seventh != null ? "13" : "6", true);
  const exts = st.exts || [];
  // highest plain extension required (13 > 11 > 9); alterations always required
  const plain = exts.filter(([semi]) => semi === 2 || semi === 5 || semi === 9).map(([semi]) => semi);
  const top = plain.includes(9) && st.seventh != null ? 9 : plain.includes(5) ? 5 : plain.includes(2) ? 2 : null;
  for (const [semi, label, optional] of exts) {
    const alteration = semi === 1 || semi === 3 || semi === 6 || semi === 8;
    add(semi, label, !st.requireAny && !optional && (alteration || semi === top || st.seventh == null));
  }
  if (st.fifth != null && !st.no5) {
    const lbl = st.fifth === 6 ? "b5" : st.fifth === 8 ? "#5" : "5";
    const triad = tones.length <= 2;          // R + third/sus → the 5th is load-bearing
    add(st.fifth, lbl, st.power || triad || (st.fifthAltered && !st.fifthOptional));
  }
  const requireAny = st.requireAny || null;
  // drop-2/3 core: guide tones → alterations → top colour → root → 5th
  const order = [];
  const push = (semi) => { if (semi != null && has(semi) && !order.includes(semi)) order.push(semi); };
  push(st.thirdOptional ? null : st.third); if (st.third == null) { push(st.sus4 ? 5 : null); push(st.sus2 ? 2 : null); }
  push(st.seventh); if (st.seventh == null && st.sixth) push(9);
  for (const a of [1, 3, 6, 8]) if (exts.some(([x]) => x === a)) push(a);
  if (st.seventh != null) push(9); push(top); push(2); push(5);
  if (st.fifthAltered) push(st.fifth);
  push(0); push(st.fifth); push(9); push(st.sus4 ? 5 : null);
  let core4 = order.length >= 4 ? order.slice(0, 4) : null;
  if (core4 && st.seventh == null && !st.sixth && tones.length > 4) core4 = null;   // add9/add11 triads: no drop form
  if (tones.length < 4) core4 = null;
  return { tones, required: [...req], requireAny, core4 };
}
const _vcTonesSig = (f) => f.tones.map((t) => t.semi).sort((a, b) => a - b).join(",");

/* Lead-sheet symbol → { ok, display, lookup, root, rootPc, suffix, bass, bassPc, formula }.
 * The slash bass is preserved for DISPLAY ("C7/E") while the lookup runs on the main
 * chord ("C7"). `6/9` is a suffix, not an inversion — only a trailing note name is a bass. */
function parseChordSymbolForVoicings(symbol) {
  const original = String(symbol == null ? "" : symbol).trim();
  if (!original || original === "—" || /^N\.?C\.?$/i.test(original)) return { ok: false, original, error: "NO_CHORD" };
  let main = original, bass = null;
  const sm = original.match(/^(.*)\/([A-Ga-g][#b♯♭]?)$/);
  if (sm && sm[1]) { main = sm[1]; bass = sm[2][0].toUpperCase() + _vcClean(sm[2].slice(1)); }
  const rm = main.match(/^([A-Ga-g])([#b♯♭]?)(.*)$/);
  if (!rm) return { ok: false, original, error: "INVALID_ROOT" };
  const root = rm[1].toUpperCase() + _vcClean(rm[2]);
  const rootPc = _VC_PC[root];
  const raw = _vcClean(rm[3]);
  const bare = raw.replace(/[()]/g, "");
  const suffix = CHORD_SUFFIX_ALIASES[raw] ?? CHORD_SUFFIX_ALIASES[bare] ?? CHORD_SUFFIX_ALIASES[raw.toLowerCase()] ?? bare;
  const formula = voicingFormula(suffix);
  const bassPc = bass != null ? _VC_PC[bass] : null;
  if (rootPc == null) return { ok: false, original, error: "INVALID_ROOT" };
  if (!formula) return { ok: false, original, root, rootPc, suffix, error: "UNKNOWN_QUALITY" };
  return { ok: true, original, display: original, lookup: root + rm[3], root, rootPc, suffix,
    bass, bassPc: bassPc === rootPc ? null : bassPc ?? null, formula };
}

/* chords.json suffix for a parsed chord: the exact name, a known rename, else the
 * dictionary suffix with the SAME tone set (so "min7", "-7", "m7" all reach "m7"). */
function _vcDictSuffix(dict, suffix, formula) {
  const names = (dict && dict.suffixes) || [];
  if (_VC_DICT_NAME[suffix] === null) return null;
  const want = _VC_DICT_NAME[suffix] ?? suffix;
  if (names.includes(want)) return want;
  if (!formula) return null;
  const sig = _vcTonesSig(formula);
  for (const n of names) {
    if (n.includes("/") || _VC_DICT_NAME[n] === null) continue;
    const f = voicingFormula(n);
    if (f && _vcTonesSig(f) === sig) return n;
  }
  return null;
}

/* A chords.json position (frets relative to baseFret, 1 = baseFret, 0 open, -1 muted)
 * → absolute frets in engine order (the file already lists low E → high e). */
function normalizeDictPosition(pos) {
  if (!pos || !Array.isArray(pos.frets) || pos.frets.length !== 6) return null;
  const base = pos.baseFret || 1;
  const frets = pos.frets.map((f) => (f > 0 ? f + base - 1 : f < 0 ? -1 : 0));
  const fingers = Array.isArray(pos.fingers) && pos.fingers.length === 6 ? pos.fingers.map((x) => (x > 0 ? x : 0)) : null;
  return { frets, fingers, baseFret: base };
}

/* Fretting-hand fingers for an absolute fret array: index-finger barre across the
 * lowest fret when it holds ≥2 strings and every string between is fretted at or above
 * it, then fingers in fret order (a same-fret group compresses to a mini-barre only
 * when there aren't enough fingers). Returns { fingers:[6], barres:[{fret,from,to}] }
 * or null when the shape needs more than four fingers — i.e. it isn't a grip. */
function assignChordFingers(frets) {
  const fingers = [0, 0, 0, 0, 0, 0], barres = [];
  const fretted = [];
  for (let s = 0; s < 6; s++) if (frets[s] > 0) fretted.push(s);
  if (!fretted.length) return { fingers, barres };
  const minF = Math.min(...fretted.map((s) => frets[s]));
  if (Math.max(...fretted.map((s) => frets[s])) - minF > 4) return null;
  const atMin = fretted.filter((s) => frets[s] === minF);
  let rest = fretted.filter((s) => frets[s] !== minF);
  if (atMin.length >= 2) {
    const lo = atMin[0], hi = atMin[atMin.length - 1];
    let ok = true;
    for (let s = lo; s <= hi; s++) if (!(frets[s] >= minF)) ok = false;
    if (ok) { for (const s of atMin) fingers[s] = 1; if (hi > lo) barres.push({ fret: minF, from: lo, to: hi }); }
    else { fingers[atMin[0]] = 1; rest = rest.concat(atMin.slice(1)); }
  } else fingers[atMin[0]] = 1;
  // group the remaining notes by fret, low fret first; strings low → high inside a fret
  const byFret = new Map();
  for (const s of rest.sort((a, b) => frets[a] - frets[b] || a - b)) {
    if (!byFret.has(frets[s])) byFret.set(frets[s], []);
    byFret.get(frets[s]).push(s);
  }
  const groups = [...byFret.entries()].map(([fret, strings]) => ({ fret, strings, mini: false }));
  const need = () => groups.reduce((n, g) => n + (g.mini ? 1 : g.strings.length), 0);
  // compress the largest contiguous same-fret group(s) until three fingers suffice
  for (const g of [...groups].sort((a, b) => b.strings.length - a.strings.length)) {
    if (need() <= 3) break;
    if (g.strings.length < 2) break;
    const lo = g.strings[0], hi = g.strings[g.strings.length - 1];
    let ok = true;
    for (let s = lo; s <= hi; s++) if (!(frets[s] >= g.fret)) ok = false;
    if (ok) g.mini = true;
  }
  if (need() > 3) return null;
  let next = 2;
  for (const g of groups) {
    const want = Math.min(4, 1 + g.fret - minF);
    const slots = g.mini ? 1 : g.strings.length;
    // a finger number never runs past 4 — keep room for the groups still to come
    const remaining = groups.slice(groups.indexOf(g) + 1).reduce((n, x) => n + (x.mini ? 1 : x.strings.length), 0);
    let f = Math.max(next, Math.min(want, 5 - slots - remaining));
    if (f + slots - 1 > 4) return null;
    if (g.mini) { for (const s of g.strings) fingers[s] = f; barres.push({ fret: g.fret, from: g.strings[0], to: g.strings[g.strings.length - 1] }); next = f + 1; }
    else for (const s of g.strings) { fingers[s] = f; next = ++f; }
  }
  return { fingers, barres };
}

function _vcMakeVoicing(frets, rootPc, formula, meta) {
  const sounding = frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0);
  if (sounding.length < 2) return null;
  let fg = meta.fingers ? { fingers: meta.fingers, barres: [] } : assignChordFingers(frets);
  if (!fg && meta.anyShape) fg = { fingers: [0, 0, 0, 0, 0, 0], barres: [] };   // as written: show it even if our finger model can't
  if (!fg) return null;
  const fr = frets.filter((f) => f > 0);
  const maxF = fr.length ? Math.max(...fr) : 0, minF = fr.length ? Math.min(...fr) : 0;
  const baseFret = meta.baseFret || (maxF <= 4 ? 1 : minF);
  const fretCount = Math.max(4, maxF - baseFret + 1);
  const labels = frets.map((f, s) => (f < 0 ? null : _vcLabel(formula, rootPc, (_VC_OPEN[s] + f) % 12)));
  const midi = sounding.map((s) => _VC_OPEN[s] + frets[s]);
  return { frets: frets.slice(), fingers: fg.fingers.slice(), barres: fg.barres, baseFret, fretCount, labels, midi,
    title: meta.title || "", group: meta.group, source: meta.source || "gen", rootless: !!meta.rootless };
}
function _vcLabel(formula, rootPc, pc) {
  const rel = (pc - rootPc + 12) % 12;
  const t = formula && formula.tones.find((x) => x.semi === rel);
  return t ? t.label : _VC_GENERIC_LABEL[rel];
}
const voicingSignature = (v) => v.frets.join(",");

/* Does a fret array sound this chord? Every pc a chord tone (the slash bass is also
 * allowed on the lowest string), every required tone present, ≥1 of requireAny. */
function _vcValid(frets, rootPc, formula, bassPc) {
  const allowed = new Set(formula.tones.map((t) => (rootPc + t.semi) % 12));
  const sounding = [];
  for (let s = 0; s < 6; s++) if (frets[s] >= 0) sounding.push(s);
  if (sounding.length < Math.min(3, formula.tones.length)) return false;
  const pcs = new Set();
  for (let i = 0; i < sounding.length; i++) {
    const s = sounding[i], pc = (_VC_OPEN[s] + frets[s]) % 12;
    if (!allowed.has(pc) && !(i === 0 && bassPc != null && pc === bassPc)) return false;
    pcs.add((pc - rootPc + 12) % 12);
  }
  if (bassPc != null && (_VC_OPEN[sounding[0]] + frets[sounding[0]]) % 12 !== bassPc) return false;
  for (const r of formula.required) if (!pcs.has(r)) return false;
  if (formula.requireAny && !formula.requireAny.some((x) => pcs.has(x))) return false;
  return true;
}

/* Place an ordered bottom→top list of pitch classes on the given strings (engine idx,
 * ascending), rising in pitch string to string, as compactly as possible. */
function _vcPlace(pcs, strings, { maxSpan = 4, maxFret = _VC_MAX_FRET } = {}) {
  let best = null;
  const cur = new Array(strings.length);
  (function dfs(i, prevMidi) {
    if (i === strings.length) {
      const fr = cur.filter((f) => f > 0);
      const span = fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
      if (span > maxSpan) return;
      const opens = cur.filter((f) => f === 0).length;
      if (opens && fr.length && Math.max(...fr) > 7) return;          // open string under a high grip: not a voicing
      const score = span * 100 + (fr.length ? Math.min(...fr) : 0) + opens * 0.5;
      if (!best || score < best.score) best = { frets: cur.slice(), score };
      return;
    }
    const s = strings[i];
    for (let f = 0; f <= maxFret; f++) {
      const midi = _VC_OPEN[s] + f;
      if (midi % 12 !== pcs[i] || midi <= prevMidi) continue;
      cur[i] = f; dfs(i + 1, midi);
    }
  })(0, -1);
  if (!best) return null;
  const frets = [-1, -1, -1, -1, -1, -1];
  strings.forEach((s, i) => { frets[s] = best.frets[i]; });
  return frets;
}
const _vcStringNums = (strings) => strings.map((s) => 6 - s).join("-");

const DROP_STRING_SETS = { drop2: [[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]], drop3: [[0, 2, 3, 4], [1, 3, 4, 5]] };

/* Drop-2 / drop-3: the four close-position inversions of the chord's core4, the 2nd
 * (drop 2) or 3rd (drop 3) voice from the top dropped an octave, laid on every string
 * set. Extended chords build from a guide-tone core (9ths/13ths replace the 5th, and
 * the root when the core has no room for it — flagged `rootless`). */
function dropVoicings(rootPc, formula, type) {
  if (!formula || !formula.core4) return [];
  const core = formula.core4.slice().sort((a, b) => a - b);
  const rootless = !core.includes(0);
  const out = [];
  for (let inv = 0; inv < 4; inv++) {
    // close position bottom→top as ascending semitone offsets
    const order = []; for (let i = 0; i < 4; i++) order.push(core[(inv + i) % 4]);
    const offs = [0];
    for (let i = 1; i < 4; i++) { let step = (order[i] - order[i - 1] + 12) % 12; if (!step) step = 12; offs.push(offs[i - 1] + step); }
    const v = order.map((semi, i) => ({ semi, off: offs[i] }));
    if (type === "drop2") v[2].off -= 12; else v[1].off -= 12;
    v.sort((a, b) => a.off - b.off);
    const pcs = v.map((x) => (rootPc + x.semi) % 12);
    for (const set of DROP_STRING_SETS[type]) {
      const frets = _vcPlace(pcs, set);
      if (!frets) continue;
      const bassLabel = _vcLabel(formula, rootPc, pcs[0]);
      out.push({ frets, title: `${bassLabel} in bass · ${_vcStringNums(set)}`, rootless, inv });
    }
  }
  return out;
}

/* Close triads (root position + both inversions) on the four adjacent string groups. */
function triadVoicings(rootPc, formula) {
  if (!formula || formula.tones.length !== 3) return [];
  const t = formula.tones.map((x) => x.semi).sort((a, b) => a - b);
  const names = ["Root pos", "1st inv", "2nd inv"], out = [];
  for (let inv = 0; inv < 3; inv++) {
    const pcs = [0, 1, 2].map((i) => (rootPc + t[(inv + i) % 3]) % 12);
    for (const set of [[3, 4, 5], [2, 3, 4], [1, 2, 3], [0, 1, 2]]) {
      const frets = _vcPlace(pcs, set, { maxSpan: 3 });
      if (frets) out.push({ frets, title: `${names[inv]} · ${_vcStringNums(set)}` });
    }
  }
  return out;
}

/* Guide-tone shells (root + 3rd + 7th/6th, the Freddie Green grips) with the root on
 * the 6th or 5th string, plus the same shell with the chord's top colour tone above. */
function shellVoicings(rootPc, formula) {
  if (!formula) return [];
  const has = (x) => formula.tones.some((t) => t.semi === x);
  const third = has(4) ? 4 : has(3) ? 3 : has(5) ? 5 : null;
  const sev = has(10) ? 10 : has(11) ? 11 : has(9) && !formula.tones.some((t) => t.label === "13") ? 9 : null;
  if (third == null || sev == null) return [];
  const colour = [9, 2, 1, 3, 6, 8].find((x) => x !== sev && x !== third && has(x) && formula.tones.find((t) => t.semi === x).label !== "6");
  const pc = (x) => (rootPc + x) % 12, out = [];
  const shapes = [
    { tones: [0, sev, third], sets: [[0, 2, 3], [1, 3, 4]] },
    { tones: [0, third, sev], sets: [[0, 1, 2], [1, 2, 3]] },
  ];
  for (const sh of shapes) for (const set of sh.sets) {
    const frets = _vcPlace(sh.tones.map(pc), set, { maxSpan: 3, maxFret: 12 });
    if (!frets) continue;
    const lbl = sh.tones.map((x) => _vcLabel(formula, rootPc, pc(x))).join("-");
    out.push({ frets, title: `${lbl} · ${_vcStringNums(set)}` });
    if (colour != null) {
      const top = set[set.length - 1] + 1;
      if (top <= 5) {
        const f2 = _vcPlace([...sh.tones, colour].map(pc), [...set, top], { maxSpan: 4, maxFret: 14 });
        if (f2) out.push({ frets: f2, title: `${lbl}-${_vcLabel(formula, rootPc, pc(colour))} · ${_vcStringNums([...set, top])}` });
      }
    }
  }
  return out;
}

/* Exhaustive fretboard search: every grip in a 4-fret window (open strings allowed low
 * on the neck) that sounds the chord, needs ≤ 4 fingers and has at most one interior
 * muted string — ranked complete-first, root-in-bass, fuller, lower — then diversified
 * across the neck. This is the guarantee that ANY chord the parser understands gets a
 * spread of real shapes, whether or not the dictionary has it. */
function enumerateChordGrips(rootPc, formula, { bassPc = null, max = 24, maxBase = 12 } = {}) {
  if (!formula) return [];
  const allowed = new Set(formula.tones.map((t) => (rootPc + t.semi) % 12));
  if (bassPc != null) allowed.add(bassPc);
  const seen = new Set(), found = [];
  for (let base = 1; base <= maxBase; base++) {
    const opts = [];
    for (let s = 0; s < 6; s++) {
      const o = [-1];
      if (base <= 5 && allowed.has(_VC_OPEN[s] % 12)) o.push(0);
      for (let f = base; f < base + 4; f++) if (allowed.has((_VC_OPEN[s] + f) % 12)) o.push(f);
      opts.push(o);
    }
    const cur = new Array(6);
    (function dfs(s) {
      if (s === 6) {
        if (!cur.some((f) => f === base)) return;                       // anchored on this window
        const sounding = []; for (let i = 0; i < 6; i++) if (cur[i] >= 0) sounding.push(i);
        if (sounding.length < Math.min(3, formula.tones.length)) return;
        let interior = 0;
        for (let i = sounding[0]; i <= sounding[sounding.length - 1]; i++) if (cur[i] < 0) interior++;
        if (interior > 1) return;
        const sig = cur.join(",");
        if (seen.has(sig) || !_vcValid(cur, rootPc, formula, bassPc)) return;
        const fg = assignChordFingers(cur);
        if (!fg) return;
        seen.add(sig);
        const pcs = new Set(sounding.map((i) => (_VC_OPEN[i] + cur[i]) % 12));
        const bassIsRoot = (_VC_OPEN[sounding[0]] + cur[sounding[0]]) % 12 === rootPc;
        const fr = cur.filter((f) => f > 0);
        const score = -12 * pcs.size - 3 * sounding.length + (bassIsRoot || bassPc != null ? 0 : 8) + 5 * interior
          + (Math.max(...fr) - Math.min(...fr)) + 0.25 * base + fg.barres.length * 0.5;
        found.push({ frets: cur.slice(), score, base });
        return;
      }
      for (const f of opts[s]) { cur[s] = f; dfs(s + 1); }
    })(0);
  }
  found.sort((a, b) => a.score - b.score || a.base - b.base);
  // diversify: at most 2 per neck region on the first pass, then fill
  const picked = [], perRegion = new Map();
  for (const g of found) {
    const region = Math.floor((g.base - 1) / 3);
    if ((perRegion.get(region) || 0) >= 2) continue;
    perRegion.set(region, (perRegion.get(region) || 0) + 1);
    picked.push(g); if (picked.length >= max) break;
  }
  for (const g of found) { if (picked.length >= max) break; if (!picked.includes(g)) picked.push(g); }
  return picked.sort((a, b) => a.base - b.base || a.score - b.score).map((g) => ({ frets: g.frets }));
}

/* Dictionary positions for a chord: entry by root PITCH CLASS (Db → "Csharp"), suffix
 * via _vcDictSuffix; positions that don't actually sound the chord are dropped. */
function dictVoicings(dict, rootPc, suffix, formula, bassPc = null) {
  if (!dict || !dict.chords) return [];
  const entries = dict.chords[VOICING_DICT_KEYS[rootPc]] || [];
  let ds = _vcDictSuffix(dict, suffix, formula);
  let entry = null;
  if (bassPc != null && ds) {   // the dictionary's own slash entries ("/E", "m/B")
    const head = ds === "major" ? "" : ds === "minor" ? "m" : ds;
    entry = entries.find((e) => { const mm = e.suffix.match(/^(.*?)\/([A-G][#b]?)$/); return mm && mm[1] === head && _VC_PC[mm[2]] === bassPc; }) || null;
  } else if (ds) entry = entries.find((e) => e.suffix === ds) || null;
  if (!entry) return [];
  const out = [];
  for (const p of entry.positions || []) {
    const n = normalizeDictPosition(p);
    if (!n || !_vcValid(n.frets, rootPc, formula, bassPc)) continue;
    out.push({ frets: n.frets, fingers: n.fingers, baseFret: n.baseFret, generated: !!p.generated });
  }
  return out;
}

const VOICING_GROUPS = {
  played: { title: "In this chart", blurb: "The fingering written in the source file." },
  bass: { title: "Slash bass", blurb: "Grips with the written bass note as the lowest sounding string." },
  library: { title: "Library", blurb: "Common dictionary shapes across the neck." },
  drop2: { title: "Drop 2", blurb: "Four-note voicings — 2nd voice from the top dropped an octave (adjacent strings)." },
  drop3: { title: "Drop 3", blurb: "Four-note voicings — 3rd voice from the top dropped an octave (one string skipped)." },
  triads: { title: "Triads", blurb: "Close-position triads and their inversions on each string group." },
  shells: { title: "Shells", blurb: "Guide-tone shells — root, 3rd and 7th (plus a colour tone on top)." },
  more: { title: "More shapes", blurb: "Every other playable grip found on the fretboard, low to high." },
};

/* The modal's data: parse → per-group voicings (validated, fingered, deduped, labelled).
 * opts: { maxMore = 16, maxBass = 8, played } — `played` is the chart's own fingering
 * ([6] frets, or the score's {engIdx: fret} map), shown first exactly as written. A chord the parser can't read returns ok:false;
 * a known quality the dictionary lacks still returns the generated groups. */
function chordVoicings(dict, symbol, opts = {}) {
  const p = parseChordSymbolForVoicings(symbol);
  if (!p.ok) return { ok: false, parsed: p, groups: [], total: 0 };
  const { rootPc, formula, bassPc } = p;
  const seen = new Set(), groups = [];
  const played = _vcPlayedFrets(opts.played);
  if (played) {
    const v = _vcMakeVoicing(played, rootPc, formula, { title: "as written", group: "played", source: "chart", anyShape: true });
    if (v) { groups.push({ id: "played", ...VOICING_GROUPS.played, voicings: [v] }); seen.add(played.join(",")); }
  }
  const take = (id, list, { dedupe = true, source = "gen", cap = Infinity } = {}) => {
    const out = [];
    for (const it of list) {
      if (out.length >= cap) break;
      if (!_vcValid(it.frets, rootPc, formula, id === "bass" ? bassPc : null) && !(it.rootless && _vcValidRootless(it.frets, rootPc, formula))) continue;
      const sig = it.frets.join(",");
      if (dedupe && seen.has(sig)) continue;
      const v = _vcMakeVoicing(it.frets, rootPc, formula, { ...it, group: id, source: it.generated ? "gen" : source });
      if (!v) continue;
      if (dedupe) seen.add(sig);
      out.push(v);
    }
    if (out.length) groups.push({ id, ...VOICING_GROUPS[id], voicings: out });
    return out;
  };
  if (bassPc != null) {
    const fromDict = dictVoicings(dict, rootPc, p.suffix, formula, bassPc);
    const gen = enumerateChordGrips(rootPc, formula, { bassPc, max: opts.maxBass ?? 8 });
    take("bass", [...fromDict, ...gen].map((x, i) => ({ ...x, title: x.title || `with ${p.bass} · ${i + 1}` })), { dedupe: false, source: "dict" });
  }
  const lib = dictVoicings(dict, rootPc, p.suffix, formula);
  take("library", lib, { source: "dict" });
  take("drop2", dropVoicings(rootPc, formula, "drop2"));
  take("drop3", dropVoicings(rootPc, formula, "drop3"));
  take("triads", triadVoicings(rootPc, formula));
  take("shells", shellVoicings(rootPc, formula));
  take("more", enumerateChordGrips(rootPc, formula, { max: (opts.maxMore ?? 16) + 24 }), { cap: opts.maxMore ?? 16 });
  for (const [id, word] of [["library", "pos"], ["more", "shape"]]) {      // numbered after dedupe
    const g = groups.find((x) => x.id === id);
    if (g) g.voicings.forEach((v, i) => { v.title = `${word} ${i + 1}`; });
  }
  const total = groups.reduce((n, g) => n + g.voicings.length, 0);
  return { ok: true, parsed: p, dictSuffix: _vcDictSuffix(dict, p.suffix, formula), groups, total };
}
function _vcPlayedFrets(x) {
  if (!x) return null;
  const f = [-1, -1, -1, -1, -1, -1];
  if (Array.isArray(x)) { if (x.length !== 6) return null; x.forEach((v, i) => { f[i] = v >= 0 ? v : -1; }); }
  else for (const [k, v] of Object.entries(x)) { const i = +k; if (i >= 0 && i < 6 && v >= 0) f[i] = v; }
  return f.filter((v) => v >= 0).length >= 2 ? f : null;
}
/* rootless drop voicings: every pc a chord tone and the required tones bar the root */
function _vcValidRootless(frets, rootPc, formula) {
  const f2 = { ...formula, required: formula.required.filter((x) => x !== 0) };
  return _vcValid(frets, rootPc, f2, null);
}

/* A voicing → the svguitar `chord()` payload. Strings are numbered 1 = high e; frets
 * are RELATIVE to the diagram window when it starts above the nut. mode "fingers"
 * labels each fretted dot with its finger, "intervals" with its chord degree. */
function voicingToSVGuitar(v, mode = "fingers") {
  const fingers = [];
  for (let s = 0; s < 6; s++) {
    const f = v.frets[s], str = 6 - s;
    if (f < 0) { fingers.push([str, "x"]); continue; }
    if (f === 0) { fingers.push([str, 0]); continue; }
    const rel = v.baseFret > 1 ? f - v.baseFret + 1 : f;
    const text = mode === "intervals" ? v.labels[s] : v.fingers[s] ? String(v.fingers[s]) : "";
    fingers.push(text ? [str, rel, text] : [str, rel]);
  }
  return { fingers, barres: [], position: v.baseFret, frets: v.fretCount, title: "" };
}

/* Reharmonisation suggestions (ported from Parker-songbook-tool's chordSubstitutions,
 * MIT) — classified from the TONE SET, not the spelling, so any alias works. */
function chordSubstitutions(symbol, useSharp = true) {
  const p = parseChordSymbolForVoicings(symbol);
  if (!p.ok) return [];
  const names = useSharp ? NOTE_SHARP : NOTE_FLAT;
  const has = (x) => p.formula.tones.some((t) => t.semi === x);
  const at = (n) => names[(p.rootPc + n) % 12];
  const src = p.lookup;
  const R = names[p.rootPc];
  const sub = (n, q, category, reason) => ({ symbol: at(n) + q, root: at(n), quality: q, category, reason });
  const alts = [1, 3, 6, 8].some((x) => has(x) && p.formula.tones.find((t) => t.semi === x).label !== "b5");
  const fam = has(3) && has(6) && has(9) && !has(10) ? "dim7"
    : has(3) && has(6) && has(10) ? "m7b5"
    : has(3) && !has(4) && has(5) && has(10) ? "min11"
    : has(3) && !has(4) ? "min"
    : has(4) && has(10) ? (alts ? "domAlt" : "dom")
    : !has(4) && !has(3) && has(5) && has(10) ? "domSus"
    : has(4) && (has(11) || (has(9) && !has(10))) ? "maj7" : null;
  switch (fam) {
    case "dom": case "domAlt": {
      const out = [
        sub(6, "7", "Tritone", `${src} → ${at(6)}7: shares the 3rd & b7 (guide tones) — the classic bebop reharm.`),
        sub(4, "dim7", "Diminished", `${at(4)}dim7 = rootless ${R}7b9 (the vii°7 on the 3rd) — implies this dominant.`),
        sub(4, "m7b5", "Half-diminished", `${at(4)}m7b5 = rootless ${R}9 — voices this dominant without its root.`),
        sub(7, "m7", "Make it a ii–V", `Precede ${src} with ${at(7)}m7 (a 5th above) for a full ii–V.`),
      ];
      if (fam === "dom") out.push(sub(0, "7b9", "Alteration", `${R}7b9 — add a b9 for tension pulling to a minor target.`),
        sub(0, "7#11", "Alteration", `${R}7#11 — lydian-dominant colour, same function, brighter.`));
      return out;
    }
    case "domSus": return [
      sub(7, "m11", "Modal swap", `${src} = ${at(7)}m11 — the sus is the ii voiced over the V root.`),
      sub(0, "7", "Resolve the sus", `Drop the 4th to the 3rd for the plain ${R}7.`),
      sub(6, "7", "Tritone", `${at(6)}7 — tritone sub of the underlying dominant.`)];
    case "min11": return [
      sub(5, "7sus4", "Sus equivalent", `${src} = ${at(5)}7sus4 — identical pitch collection, a 4th above.`),
      sub(5, "7", "Its ii–V", `As the ii of a ii–V, ${src} leads to ${at(5)}7.`),
      sub(3, "6", "Relative major", `${at(3)}6 — the relative major a minor 3rd up shares its notes.`)];
    case "min": return [
      sub(3, "6", "Relative major", `${src} ≈ ${at(3)}6 — the relative major 6 a minor 3rd up (same notes as the m7).`),
      sub(5, "7", "Its ii–V", `As the ii of a ii–V, ${src} leads to ${at(5)}7.`),
      sub(0, "m11", "Extension", `${R}m11 — stack the 11th for a modern rootless colour.`),
      sub(5, "7sus4", "Sus equivalent", `Voiced a 4th above, ${src} becomes ${at(5)}7sus4.`)];
    case "m7b5": return [
      sub(5, "7b9", "Minor ii–V", `${src} is the ii of a minor key — resolve it to ${at(5)}7b9.`),
      sub(8, "9", "Upper structure", `${src} = rootless ${at(8)}9 — the dominant a major 3rd below.`),
      sub(3, "m6", "Relative minor 6", `${at(3)}m6 a minor 3rd up has the same four notes.`)];
    case "dim7": return [
      sub(8, "7b9", "Dominant function", `${src} = rootless ${at(8)}7b9 — resolves like that dominant.`),
      sub(11, "7b9", "Dominant function", `Also the vii°7 of ${at(11)}7b9 (a half-step above).`),
      sub(1, "m7", "Chromatic target", `Common passing use: resolves up a half-step into ${at(1)}m7.`)];
    case "maj7": {
      const six = !has(11);                                 // a 6 chord IS its relative m7 inverted
      return [
        six ? sub(9, "m7", "Relative minor", `${src} = ${at(9)}m7 — the same four notes, the vi in the bass.`)
          : sub(9, "m7", "Relative minor", `${src} ⇄ ${at(9)}m7 — the relative vi shares three of four notes.`),
        sub(4, "m7", "iii for I", `${at(4)}m7 — the iii substitutes for a tonic major (rootless maj9).`),
        six ? sub(0, "maj7", "Colour swap", `${R}maj7 — trade the 6 for the major 7th: a brighter, more modern tonic.`)
          : sub(0, "6", "Colour swap", `${R}6 — trade the maj7 for a 6 to lose the b2-against-root rub.`),
        sub(2, "7sus4", "Backdoor set-up", `${at(2)}7sus4 — a gospel/backdoor lead-in to ${src}.`)];
    }
    default: return [];
  }
}

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
  CHORD_VOCABULARIES,
  resolveChordVocabulary,
  respellScore,
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
  _keyChordWeight,
  analyzeKeyCandidates,
  KEY_CHOICES,
  parseKeyName,
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
  ABC_MIME,
  _abcFileHeader,
  _abcKeyName,
  _abcAccidentalTracker,
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
  _xmlEsc,
  _SATB_NAMES,
  voicePartNames,
  _FIFTHS_MAJOR,
  _keyFifths,
  _clefForScore,
  _notesToBeatNotes,
  splitVoicesToScores,
  _NOTE_GRID,
  _NOTE_VALUES,
  _noteValuesFromTicks,
  _voiceNotationMeasures,
  _scoreToBeatNotes,
  scoreToMultipartMusicXML,
  scoreToMultipartABC,
  VOICE_TYPES,
  classifyVoiceTypes,
  _lineStats,
  keyFromNotes,
  _keySpeller,
  _keySigAlters,
  vocalRangeReport,
  _meterLevels,
  _metricOK,
  _metricValues,
  scoreToVocalMidi,
  transposeScore,
  FINGER_DEFAULTS,
  FINGER_PRIOR,
  fingerCandidates,
  fingerShapes,
  fingerSequence,
  fingerScore,
  TECHNIQUES,
  scoreToAlphaTex,
  isPercussionTuning,
  isAlphaTexText,
  alphaTexFromBytes,
  _atexKey,
  BRASS_INSTRUMENTS,
  getBrassInstrument,
  scoreToBrassMusicXML,
  scoreToBrassABC,
  buildBrassSection,
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
  harmonicChromagram,
  beatSegments,
  viterbiChords,
  transcribeChordsBeatSync,
  analyzeAudioChords,
  resampleTo,
  logFreqSpectrogram,
  nnlsChromagram,
  chordStatesV2,
  hmmChordDecode,
  repetitionSmooth,
  transcribeChordsV2,
  analyzeAudioChordsV2,
  stemRoleFromName,
  STEM_ROLE_NAMES,
  transcribeDrums,
  drumPattern,
  drumHitsToMidi,
  chartsFromStems,
  encodeWav16,
  progressEta,
  _nnlsGram,
  _bandFeatures,
  _cosSim,
  _footeNovelty,
  nameSections,
  SECTION_SENSITIVITY,
  detectSections,
  applySectionsToScore,
  chordFromChroma,
  detectChord,
  recoverChordGaps,
  transcribeChords,
  harmonicClarity,
  audioEventsToScore,
  commitChordChoices,
  autoResolveChords,
  reopenAutoChords,
  notesFromActivations,
  polyNotesToScore,
  transcribeWithNoteModel,
  CRNN,
  crnnSegments,
  crnnDeframe,
  crnnBinarize,
  crnnNotesFromOutputs,
  transcribeGuitar,
  splitVoices,
  suggestVoiceCount,
  _voiceSlices,
  _voiceCenters,
  _cosDist,
  _dtw,
  scoreChromaSequence,
  pcmChromaSequence,
  alignPcmToScore,
  describeScore,
  scoreToMusicPrompt,
  _CHORD_RE,
  _CHORD_LINE_MARK,
  isChordToken,
  isChordBracket,
  isChordLine,
  stripInlineChords,
  _SECTION_KEYWORDS,
  _trimEdges,
  _cleanLabel,
  _isBareSectionLabel,
  parseLyrics,
  lyricsToText,
  VOICING_DICT_KEYS,
  CHORD_SUFFIX_ALIASES,
  voicingFormula,
  parseChordSymbolForVoicings,
  _vcDictSuffix,
  normalizeDictPosition,
  assignChordFingers,
  voicingSignature,
  DROP_STRING_SETS,
  dropVoicings,
  triadVoicings,
  shellVoicings,
  enumerateChordGrips,
  dictVoicings,
  VOICING_GROUPS,
  chordVoicings,
  voicingToSVGuitar,
  chordSubstitutions,
  HARMONY_PART,
  harmonyPartIndices,
  mergePartNotes,
  _musicXmlPartNotes,
  _readSmf,
  parseMidiFile,
  _zipEntries,
  _zipRead,
  parseScoreZip,
  keyNoteNames,
  keyNameForKey,
  _exportKeyName,
  spellSymbolForKey,
  spellScoreForKey,
};

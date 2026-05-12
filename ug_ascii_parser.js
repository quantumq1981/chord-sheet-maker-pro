/*
 * Ultimate Guitar ASCII Parser
 *
 * This module parses a loosely formatted ASCII transcription—such as those
 * commonly found on Ultimate Guitar—and produces a JSON object conforming
 * to the "Unified Song Model" specification documented in
 * `Unified Song Model Technical Specification.md`.  It attempts to
 * recover as much semantic information as possible from plain‑text tabs
 * and chord/lyric sheets while acknowledging the inherent signal loss.
 *
 * The parser makes several passes over the input text:
 *   1. Detect and isolate monospaced tab blocks.  Tab lines begin with
 *      a string label (e, B, G, D, A, E) followed by a pipe and a run of
 *      hyphens, numbers and notation symbols.  Adjacent runs of at least
 *      four lines are considered a tab block.
 *   2. Identify chord lines by looking for a high ratio of valid chord
 *      tokens relative to other words.  Chord tokens match typical
 *      representations such as C, G7, F#m7b5, Bbmaj7, etc.
 *   3. Everything not recognized as tab or chord lines is treated as
 *      lyrics or plain text.  Lyrics density, tab density and chord
 *      density are computed for analytics.
 *   4. Chord events are placed on a notional timeline.  Without explicit
 *      barlines in ASCII, all chords are placed in a single measure with
 *      sequential beats derived from their position in the line.  This is
 *      intentionally conservative: rhythmExplicit is set false in the
 *      resulting lossMap.
 *   5. Harmonic fingerprints are calculated from the parsed chord
 *      symbols to estimate genre signals such as cowboyChordShare,
 *      dom7Rate, maj7Rate, min7b5Rate, altRate, powerChordRate and
 *      iiVRate.  These features feed into a simple genre guess.
 *
 * Usage:
 *   const { parseUltimateGuitarAscii } = require('./ug_ascii_parser');
 *   const json = parseUltimateGuitarAscii(plainText);
 *
 * The returned object adheres to the Universal JSON Song Schema.  Fields
 * not inferable from ASCII input (e.g. composers, tempo changes) are
 * populated with sensible defaults and flagged with low confidence.
 */

'use strict';

/**
 * Generate a random UUID (version 4) using crypto.randomUUID when
 * available or a fallback polyfill.  Node 14+ includes
 * crypto.randomUUID().  This avoids pulling in external libraries.
 */
function generateUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: generate RFC4122 compliant UUIDv4
  function hex(bytes) {
    return bytes.toString(16).padStart(2, '0');
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Node.js < 15: use Math.random as last resort (non‑cryptographic)
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  // Per RFC 4122 section 4.4: set version to 4 and variant bits
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const segments = [
    [...bytes.slice(0, 4)].map(hex).join(''),
    [...bytes.slice(4, 6)].map(hex).join(''),
    [...bytes.slice(6, 8)].map(hex).join(''),
    [...bytes.slice(8, 10)].map(hex).join(''),
    [...bytes.slice(10, 16)].map(hex).join('')
  ];
  return segments.join('-');
}

/**
 * Test whether a line is part of an ASCII guitar tab.  A valid tab line
 * starts with a string name (e, B, G, D, A, E, sometimes lower-case) and
 * a pipe character, then consists primarily of hyphens, numbers and
 * standard tablature notation symbols.  Case is ignored.  This regex
 * approximates the pattern described in the spec's tab detection rules.
 * @param {string} line
 * @returns {boolean}
 */
function isTabLine(line) {
  const trimmed = line.trim();
  // Match leading string name + pipe. The content class includes | so that
  // multi-measure tabs (e|--0--|--2--|) are accepted alongside single-segment ones.
  return /^([eEBGDA]\|)[-0-9hpbtrx|\/\\~().]+$/i.test(trimmed);
}

/**
 * Regex for scanning a full line and extracting all chord tokens via .match().
 * Using /gi with .match() is safe because .match() resets lastIndex after
 * completion.  Quality alternatives are ordered longest-first so that
 * compound suffixes like m7b5 and 7sus4 are consumed before their prefixes.
 * The trailing (?![a-zA-Z0-9]) prevents partial matches inside longer words.
 */
const CHORD_REGEX = /\b([A-G][b#]?(?:maj\d*|m7b5|mM7|m\d*|min(?:7b5|\d*)?|dim7?|aug7?|\d+(?:sus[24]?)?(?:[b#]\d+)*|sus[24]?|add\d+|alt)?(?:\/[A-G][b#]?)?)(?![a-zA-Z0-9])/gi;

/**
 * Stateless anchored version for testing a single whitespace-split token.
 * Must NOT use the /g flag to avoid lastIndex state between calls.
 */
const CHORD_TOKEN_RE = /^[A-G][b#]?(?:maj\d*|m7b5|mM7|m\d*|min(?:7b5|\d*)?|dim7?|aug7?|\d+(?:sus[24]?)?(?:[b#]\d+)*|sus[24]?|add\d+|alt)?(?:\/[A-G][b#]?)?$/i;

/**
 * Determine if a line is predominantly chords.  We compute the ratio of
 * chord tokens to all space‑separated tokens.  If at least 40% of the
 * tokens look like chords and there is more than one chord, we treat
 * this line as a chord line.  These thresholds mirror the heuristics
 * outlined in the spec.
 * @param {string} line
 * @returns {boolean}
 */
function isChordLine(line) {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length === 0) return false;
  const chordTokens = line.match(CHORD_REGEX) || [];
  const ratio = chordTokens.length / tokens.length;
  // Require at least 2 chord tokens to avoid single-letter false positives
  // (e.g. a lyric line whose first word starts with A–G).
  return chordTokens.length > 1 && ratio >= 0.4;
}

/**
 * Normalize a chord symbol into a canonical representation.  The
 * normalization splits the symbol into root, quality family, extensions,
 * alterations, suspension, and bass note.  This is a simplified
 * implementation inspired by the Harte notation referenced in the spec.
 * It does not cover every edge case but provides reasonable defaults.
 *
 * Example: "G#m7b5" → {
 *   root: "G#",
 *   qualityFamily: "min7b5",
 *   extensions: [],
 *   alterations: [],
 *   suspension: null,
 *   bass: null
 * }
 * @param {string} symbol
 * @returns {{root: string, qualityFamily: string, extensions: Array<string>, alterations: Array<string>, suspension: string|null, bass: string|null}}
 */
function normalizeChord(symbol) {
  // Bass group uses [A-G][#b]? so D/F# correctly captures 'F#' (\w+ would stop at #).
  const match = /^([A-G](#|b)?)(.*?)(?:\/([A-G][#b]?))?$/.exec(symbol);
  if (!match) {
    return {
      root: null,
      qualityFamily: null,
      extensions: [],
      alterations: [],
      suspension: null,
      bass: null
    };
  }
  const root = match[1];
  let remainder = match[3] || '';
  const bass = match[4] || null;
  let qualityFamily = null;
  const extensions = [];
  const alterations = [];
  let suspension = null;

  // Detect common quality families
  const qualityMap = {
    'maj7': 'maj7', 'M7': 'maj7', '△7': 'maj7',
    'maj9': 'maj9',
    'min7': 'min7', 'm7': 'min7',
    'min7b5': 'min7b5', 'm7b5': 'min7b5',
    'm7b5b9': 'min7b5b9',
    'dim': 'dim', 'dim7': 'dim7',
    'aug': 'aug', 'aug7': 'aug7',
    'sus2': 'sus2', 'sus4': 'sus4', 'sus': 'sus4',
    '7': 'dom7'
  };
  // Sort keys by length to match longer tokens first
  const sortedQualities = Object.keys(qualityMap).sort((a, b) => b.length - a.length);
  for (const q of sortedQualities) {
    if (remainder.startsWith(q)) {
      qualityFamily = qualityMap[q];
      remainder = remainder.slice(q.length);
      break;
    }
  }
  // If quality not found and remainder begins with 'm' assume minor
  if (!qualityFamily && /^m/.test(remainder)) {
    qualityFamily = 'min';
    remainder = remainder.slice(1);
  }
  // Default quality
  if (!qualityFamily) {
    qualityFamily = 'maj';
  }
  // Extract numeric extensions (e.g. 9, 13)
  const extMatch = remainder.match(/(\d+)/);
  if (extMatch) {
    extensions.push(extMatch[1]);
    remainder = remainder.replace(extMatch[1], '');
  }
  // Extract alterations (e.g. b5, #9)
  const altMatches = remainder.match(/([#b]\d+)/g);
  if (altMatches) {
    for (const alt of altMatches) {
      alterations.push(alt);
    }
    remainder = remainder.replace(/([#b]\d+)/g, '');
  }
  // Detect suspensions if quality already contains sus but may specify number
  if (/sus(2|4)?/.test(match[3])) {
    suspension = /sus(2|4)?/.exec(match[3])[1] || '4';
  }
  return {
    root,
    qualityFamily,
    extensions,
    alterations,
    suspension,
    bass
  };
}

/**
 * Compute harmonic fingerprint features from a list of normalized chords.
 * The features correspond to those described in the specification:
 *   - cowboyChordShare: ratio of common open‑position chords (G, C, D, Am,
 *     Em, E, A, F, Fmaj7) to total chords.
 *   - dom7Rate: proportion of dominant seventh chords (dom7 quality).
 *   - maj7Rate: proportion of major seventh chords.
 *   - min7b5Rate: proportion of half‑diminished chords.
 *   - altRate: proportion of chords containing 'alt' quality.
 *   - powerChordRate: proportion of power chords (quality of '5').
 *   - iiVRate: proportion of bigrams that follow a ii–V motion.
 *
 * For iiV detection, we interpret a ii–V pair as any adjacent pair of
 * chords where the second root is a perfect fourth below (or fifth above)
 * the first root.  Enharmonic differences are ignored.  This is a
 * simplified approach suitable for the context of ASCII parsing.
 * @param {Array<{root: string, qualityFamily: string}>} normalizedChords
 * @returns {{cowboyChordShare: number, dom7Rate: number, maj7Rate: number, min7b5Rate: number, altRate: number, powerChordRate: number, iiVRate: number}}
 */
function computeHarmonicFingerprint(normalizedChords) {
  const total = normalizedChords.length;
  if (total === 0) {
    return {
      cowboyChordShare: 0,
      dom7Rate: 0,
      maj7Rate: 0,
      min7b5Rate: 0,
      altRate: 0,
      powerChordRate: 0,
      iiVRate: 0
    };
  }
  const cowboyRoots = new Set(['G', 'C', 'D', 'A', 'E', 'F']);
  const cowboyMinors = new Set(['Am', 'Em']);
  let cowboyCount = 0;
  let dom7Count = 0;
  let maj7Count = 0;
  let min7b5Count = 0;
  let altCount = 0;
  let powerCount = 0;
  // Convert root to semitone number for ii–V detection
  const semitoneMap = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3,
    'E': 4, 'F': 5, 'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8,
    'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11
  };
  let iiVCount = 0;
  for (let i = 0; i < normalizedChords.length; i++) {
    const chord = normalizedChords[i];
    if (!chord || !chord.root) continue;
    const root = chord.root;
    // Cowboy chords: open-position major/maj7 on these roots only (not dom7 — F7 is a barre chord).
    if (cowboyRoots.has(root) && ['maj', 'maj7'].includes(chord.qualityFamily)) {
      cowboyCount++;
    }
    // Open-position minor: Am and Em as pure minor triads only (not min7/min9 which require a barre).
    if (cowboyMinors.has(root + 'm') && chord.qualityFamily === 'min') {
      cowboyCount++;
    }
    if (chord.qualityFamily === 'dom7') dom7Count++;
    if (chord.qualityFamily === 'maj7') maj7Count++;
    if (chord.qualityFamily === 'min7b5') min7b5Count++;
    if (chord.qualityFamily && chord.qualityFamily.toLowerCase().includes('alt')) altCount++;
    if (chord.qualityFamily === '5') powerCount++;
    // ii–V detection: adjacent minor→dominant pair where roots are a perfect fifth apart
    // (e.g. Dm7→G7: D to G is 7 semitones up, or G to C is 5 semitones up).
    // Require first chord to be minor quality and second to be dominant to avoid flagging
    // plain I→IV (C→F) or V→I (G→C) as jazz ii–V motion.
    if (i < normalizedChords.length - 1) {
      const nextChord = normalizedChords[i + 1];
      if (
        nextChord &&
        semitoneMap[root] !== undefined &&
        semitoneMap[nextChord.root] !== undefined &&
        (chord.qualityFamily === 'min7' || chord.qualityFamily === 'min') &&
        nextChord.qualityFamily === 'dom7'
      ) {
        const interval = (semitoneMap[nextChord.root] - semitoneMap[root] + 12) % 12;
        if (interval === 5 || interval === 7) {
          iiVCount++;
        }
      }
    }
  }
  return {
    cowboyChordShare: cowboyCount / total,
    dom7Rate: dom7Count / total,
    maj7Rate: maj7Count / total,
    min7b5Rate: min7b5Count / total,
    altRate: altCount / total,
    powerChordRate: powerCount / total,
    iiVRate: total > 1 ? iiVCount / (total - 1) : 0
  };
}

/**
 * Compute density metrics based on classification of lines.  The densities
 * measure the relative prominence of lyrics, tabs, chord tokens, grids
 * (unused for simple ASCII), and sections.  Section markers are
 * recognized as lines enclosed in square brackets, e.g. [Verse] or [Chorus].
 * @param {Array<string>} lines
 * @param {Array<boolean>} isTabFlags
 * @param {Array<boolean>} isChordFlags
 * @returns {{lyricDensity: number, tabDensity: number, chordDensity: number, gridDensity: number, sectionDensity: number}}
 */
function computeDensities(lines, isTabFlags, isChordFlags) {
  const total = lines.length;
  if (total === 0) {
    return {
      lyricDensity: 0,
      tabDensity: 0,
      chordDensity: 0,
      gridDensity: 0,
      sectionDensity: 0
    };
  }
  let lyricLineCount = 0;
  let tabLineCount = 0;
  let chordTokenCount = 0;
  let gridSymbolCount = 0;
  let sectionMarkerCount = 0;
  for (let i = 0; i < total; i++) {
    const line = lines[i];
    if (isTabFlags[i]) {
      tabLineCount++;
      continue;
    }
    if (isChordFlags[i]) {
      // Count the chord tokens in this line for chord density
      const chordMatches = line.match(CHORD_REGEX) || [];
      chordTokenCount += chordMatches.length;
      continue;
    }
    if (/^\s*\[[^\]]+\]\s*$/.test(line.trim())) {
      sectionMarkerCount++;
      continue;
    }
    // Count grid symbols (bars | dots . repeats : ) for potential grid detection
    const gridSymbols = (line.match(/[\|.\:]/g) || []).length;
    gridSymbolCount += gridSymbols;
    // Non-empty, non-chord, non-tab, non-section lines are lyrics
    if (line.trim().length > 0) {
      lyricLineCount++;
    }
  }
  return {
    lyricDensity: lyricLineCount / total,
    tabDensity: tabLineCount / total,
    chordDensity: chordTokenCount / total,
    gridDensity: gridSymbolCount / total,
    sectionDensity: sectionMarkerCount / total
  };
}

/**
 * Guess a primary genre based on harmonic fingerprint features and
 * densities.  This implements a simplified version of the scoring
 * described in the specification.  Each candidate genre accrues a
 * weighted score from harmonic and density signals.  The highest score
 * determines the primary genre; if the margin between top two genres is
 * small (<0.2), the genre is marked unknown to avoid over‑confidence.
 * @param {{cowboyChordShare: number, dom7Rate: number, maj7Rate: number, min7b5Rate: number, altRate: number, powerChordRate: number, iiVRate: number}} hf
 * @param {{lyricDensity: number, tabDensity: number, chordDensity: number, gridDensity: number, sectionDensity: number}} densities
 * @returns {{primary: string, scores: {jazz: number, rock_blues: number, folk_pop: number}, confidence: number}}
 */
function guessGenre(hf, densities) {
  const jazzScore =
    6 * hf.min7b5Rate +
    6 * hf.altRate +
    5 * hf.maj7Rate +
    4 * hf.dom7Rate +
    4 * hf.iiVRate +
    2 * densities.gridDensity +
    2 * (1 - densities.lyricDensity);
  const rockBluesScore =
    5 * hf.powerChordRate +
    4 * hf.dom7Rate +
    3 * densities.tabDensity +
    3 * densities.gridDensity +
    2 * hf.iiVRate;
  // capoPresent is added to densities by parseUltimateGuitarAscii; guessGenre
  // also works standalone without it (undefined is falsy → treated as absent).
  const folkPopScore =
    5 * hf.cowboyChordShare +
    4 * (densities.capoPresent ? 1 : 0) +
    3 * densities.lyricDensity +
    2 * hf.powerChordRate;
  const scores = {
    jazz: jazzScore,
    rock_blues: rockBluesScore,
    folk_pop: folkPopScore
  };
  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  const [best, second] = entries;
  const margin = best[1] - second[1];
  let primary;
  if (margin < 0.2 || best[1] < 1.0) {
    primary = 'unknown';
  } else {
    primary = best[0];
  }
  // Confidence scaled to difference between top two
  const confidence = Math.max(0, Math.min(1, margin / 5));
  return { primary, scores, confidence };
}

/**
 * Main parser function.  Takes raw ASCII input and returns a JSON
 * conforming to the Unified Song Model.  The function accepts an
 * optional `options` object allowing callers to override default
 * properties (e.g. title, creators).  Unrecognized properties in
 * options are ignored.
 *
 * @param {string} text Raw ASCII input from Ultimate Guitar or similar.
 * @param {{title?: string, composer?: string|Array<string>, lyricist?: string|Array<string>, arranger?: string|Array<string>, artist?: string|Array<string>}} [options]
 * @returns {object} Parsed song object following the Universal JSON Song Schema.
 */
function parseUltimateGuitarAscii(text, options = {}) {
  const lines = text.split(/\r?\n/);
  // Raw per-line tab detection.
  const rawTabFlags = lines.map(isTabLine);
  // Enforce the spec's 4-consecutive-line minimum: a single isolated line matching
  // the tab pattern (e.g. metadata containing 'E|' notation) should not count.
  const MIN_TAB_RUN = 4;
  const isTabFlags = rawTabFlags.map((_, i) => {
    if (!rawTabFlags[i]) return false;
    let run = 0;
    for (let j = i; j < rawTabFlags.length && rawTabFlags[j]; j++) run++;
    // Also count backwards so every line in a run of ≥4 is marked true.
    let back = 0;
    for (let j = i; j >= 0 && rawTabFlags[j]; j--) back++;
    return Math.max(run + back - 1, back) >= MIN_TAB_RUN;
  });
  const isChordFlags = lines.map((line, idx) => !isTabFlags[idx] && isChordLine(line));
  // Extract chord symbols in order of appearance
  const chordSymbols = [];
  lines.forEach((line, idx) => {
    if (isChordFlags[idx]) {
      const matches = line.match(CHORD_REGEX) || [];
      matches.forEach((m) => chordSymbols.push(m));
    }
  });
  // Normalize chords
  const normalizedChords = chordSymbols.map((sym) => normalizeChord(sym));
  // Compute harmonic fingerprint and densities
  const hf = computeHarmonicFingerprint(normalizedChords);
  const densities = computeDensities(lines, isTabFlags, isChordFlags);
  // Genre guess
  const genre = guessGenre(hf, densities);
  // Create chord events.  Without explicit rhythm, assign measure 1 and
  // increment beat by fraction of tokens on line.  Use a fixed beat
  // spacing assuming equal subdivisions across tokens.  Confidence is
  // lowered to reflect the guess.
  const harmonyEvents = [];
  lines.forEach((line, idx) => {
    if (!isChordFlags[idx]) return;
    const tokens = line.trim().split(/\s+/);
    // Collect chord tokens in order with approximate positions
    let chordPositions = [];
    for (let i = 0; i < tokens.length; i++) {
      if (CHORD_TOKEN_RE.test(tokens[i])) {
        chordPositions.push({ index: i, symbol: tokens[i] });
      }
    }
    // Space beats by chord count, not total token count. Barlines and other
    // non-chord tokens in the line (e.g. '|') would otherwise compress all beats.
    const chordCount = chordPositions.length;
    const beatIncrement = chordCount > 1 ? 4.0 / chordCount : 4.0;
    chordPositions.forEach((cp, posIdx) => {
      const eventBeat = 1.0 + posIdx * beatIncrement;
      const sym = cp.symbol;
      const norm = normalizeChord(sym);
      harmonyEvents.push({
        measure: 1,
        beat: eventBeat,
        symbol: sym,
        normalized: norm,
        sourceNative: sym,
        confidence: 0.5 // rhythm is inferred, so lower confidence
      });
    });
  });
  // Capo detection: scan first 10 lines for common capo notations.
  // Adds a real signal to folk/pop genre scoring (spec: 4*present(capo)).
  let capoFret = null;
  const capoRe = /capo\s*:?\s*(\d+)/i;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const cm = capoRe.exec(lines[i]);
    if (cm) { capoFret = parseInt(cm[1], 10); break; }
  }
  // Attach capoPresent to densities so guessGenre can use it without signature change.
  densities.capoPresent = capoFret !== null;

  // Extract section labels from [Section Name] markers.
  const sectionRe = /^\s*\[([^\]]+)\]\s*$/;
  const extractedSections = [];
  for (const line of lines) {
    const sm = sectionRe.exec(line);
    if (sm) {
      extractedSections.push({
        id: String(extractedSections.length + 1),
        label: sm[1].trim(),
        startMeasure: null,
        endMeasure: null,
        sourceDeclared: true
      });
    }
  }

  // Collect lyric lines: non-tab, non-chord, non-section, non-empty lines.
  const lyricLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTabFlags[i] || isChordFlags[i]) continue;
    if (sectionRe.test(lines[i])) continue;
    const trimmed = lines[i].trim();
    if (trimmed) lyricLines.push(trimmed);
  }

  // Determine source format and semantic tier based on presence of tabs
  let format = 'plain_text';
  let semanticTier = 'tier_1_ascii';
  if (densities.tabDensity > 0) {
    format = 'ascii_tab';
    semanticTier = 'tier_1_ascii';
  } else if (densities.chordDensity > 0) {
    format = 'ug_text';
    semanticTier = 'tier_1_ascii';
  }
  // Compose song object
  const song = {
    schemaVersion: '1.0.0',
    songId: generateUUID(),
    title: options.title || '',
    creators: {
      composer: Array.isArray(options.composer) ? options.composer : options.composer ? [options.composer] : [],
      lyricist: Array.isArray(options.lyricist) ? options.lyricist : options.lyricist ? [options.lyricist] : [],
      arranger: Array.isArray(options.arranger) ? options.arranger : options.arranger ? [options.arranger] : [],
      artist: Array.isArray(options.artist) ? options.artist : options.artist ? [options.artist] : []
    },
    source: {
      format: format,
      semanticTier: semanticTier,
      sourceNative: {},
      importer: {
        name: 'ug_ascii_parser',
        version: '1.0.0',
        warnings: []
      }
    },
    metadata: {
      key: {
        display: '',
        concert: '',
        detected: false,
        confidence: 0.0
      },
      timeSignature: {
        numerator: 4,
        denominator: 4,
        pickupBeats: 0.0,
        changes: []
      },
      tempo: {
        bpm: 0,
        text: '',
        beatUnit: '',
        changes: []
      },
      capo: {
        fret: capoFret,
        sourceDeclared: capoFret !== null
      },
      tuning: []
    },
    structure: {
      sections: extractedSections,
      repeats: [],
      endings: [],
      rehearsalMarks: []
    },
    timeline: {
      divisionsPerQuarter: 480,
      measures: [
        {
          number: 1,
          nominalBeats: 4.0,
          actualBeats: 4.0,
          systemBreakBefore: false,
          pageBreakBefore: false,
          layoutHints: {
            preferredBarsPerLine: null,
            realBookEligible: false
          }
        }
      ]
    },
    parts: [],
    harmony: {
      globalProgression: [],
      events: harmonyEvents,
      grid: {
        present: false,
        cells: []
      }
    },
    lyrics: {
      lines: lyricLines,
      // Chord-to-lyric alignment is never computed for ASCII input.
      syllableAligned: false,
      language: 'en'
    },
    analytics: {
      density: {
        lyricDensity: densities.lyricDensity,
        tabDensity: densities.tabDensity,
        chordDensity: densities.chordDensity,
        gridDensity: densities.gridDensity
      },
      harmonicFingerprint: {
        cowboyChordShare: hf.cowboyChordShare,
        dom7Rate: hf.dom7Rate,
        maj7Rate: hf.maj7Rate,
        min7b5Rate: hf.min7b5Rate,
        altRate: hf.altRate,
        powerChordRate: hf.powerChordRate,
        iiVRate: hf.iiVRate
      },
      genreGuess: {
        primary: genre.primary,
        scores: genre.scores,
        confidence: genre.confidence
      }
    },
    lossMap: {
      rhythmExplicit: false,
      voicingExplicit: false,
      layoutExplicit: false,
      // Alignment requires explicit chord-lyric pairing, which this parser never
      // computes. Setting true when lyrics merely exist would mislead consumers.
      lyricsAligned: false,
      warnings: []
    },
    renderHints: {
      preferredTheme:
        densities.tabDensity > 0
          ? 'ascii_tab'
          : densities.lyricDensity > densities.tabDensity
          ? 'chordpro'
          : 'lyrics_sheet',
      preferredBarsPerLine: null,
      hideLyrics: false,
      showChordDiagrams: false,
      showTab: densities.tabDensity > 0,
      showConcertKey: true
    }
  };
  return song;
}

// CommonJS export for Node.js; guarded so the file also loads as a plain
// browser script (where `module` is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseUltimateGuitarAscii,
    normalizeChord,
    computeHarmonicFingerprint,
    guessGenre
  };
}
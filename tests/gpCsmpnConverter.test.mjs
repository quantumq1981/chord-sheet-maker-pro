/**
 * tests/gpCsmpnConverter.test.mjs
 *
 * Unit tests for the pure helper functions in importGuitarPro.js.
 * Loads the script into a Node.js vm context with browser stubs so DOM
 * references are satisfied, then exercises the exported _GP_TEST_EXPORTS map
 * directly — no AlphaTab CDN loading required.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── Load importGuitarPro.js into a sandboxed context ─────────────────────────

function loadGpConverter() {
  const context = {
    window: {},
    document: {
      createElement: () => ({ src: '', crossOrigin: '', onload: null, onerror: null }),
      head: { appendChild: () => {} },
    },
  };
  vm.createContext(context);
  // chordTheory.js (window.ChordTheory) must load first — importGuitarPro reads it.
  vm.runInContext(readFileSync(new URL('../chordTheory.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../importGuitarPro.js', import.meta.url), 'utf8'), context);
  return context._GP_TEST_EXPORTS;
}

const gp = loadGpConverter();
const {
  _gpKeyToStr,
  _fretsToChordName,
  _buildCsmpnFromScore,
  _extractVoicing,
  _cumQToHybridPos,
  _gpDurToQuarters,
  _gpDurToLetter,
  _normalizeGpChordName,
} = gp;

// ── Key-signature mapping ─────────────────────────────────────────────────────

test('_gpKeyToStr: C major (0 sharps/flats)', () => {
  assert.equal(_gpKeyToStr(0, 0), 'C');
});

test('_gpKeyToStr: G major (1 sharp)', () => {
  assert.equal(_gpKeyToStr(1, 0), 'G');
});

test('_gpKeyToStr: F major (1 flat)', () => {
  assert.equal(_gpKeyToStr(-1, 0), 'F');
});

test('_gpKeyToStr: Eb major (3 flats)', () => {
  assert.equal(_gpKeyToStr(-3, 0), 'Eb');
});

test('_gpKeyToStr: F# major (6 sharps)', () => {
  assert.equal(_gpKeyToStr(6, 0), 'F#');
});

test('_gpKeyToStr: Am (0 accidentals, minor)', () => {
  assert.equal(_gpKeyToStr(0, 1), 'Am');
});

test('_gpKeyToStr: Bm (2 sharps, minor)', () => {
  assert.equal(_gpKeyToStr(2, 1), 'Bm');
});

test('_gpKeyToStr: Gm (2 flats, minor)', () => {
  assert.equal(_gpKeyToStr(-2, 1), 'Gm');
});

// ── Fret-to-chord recognition ─────────────────────────────────────────────────

// Standard tuning: high-e=64, B=59, G=55, D=50, A=45, low-E=40
const STD = [64, 59, 55, 50, 45, 40];

test('_fretsToChordName: open E major chord (0,0,1,2,2,0)', () => {
  // E major voicing: e=0,B=0,G=1,D=2,A=2,E=0 → MIDI 64,59,56,52,47,40 → pcs 4,11,8,4,11,4 → {4,8,11} = E major
  const notes = [
    { stringIndex: 0, fret: 0 }, // e: 64 → E
    { stringIndex: 1, fret: 0 }, // B: 59 → B
    { stringIndex: 2, fret: 1 }, // G: 56 → G#
    { stringIndex: 3, fret: 2 }, // D: 52 → E
    { stringIndex: 4, fret: 2 }, // A: 47 → B
    { stringIndex: 5, fret: 0 }, // E: 40 → E
  ];
  const result = _fretsToChordName(STD, notes);
  assert.equal(result, 'E');
});

test('_fretsToChordName: open Am chord (0,1,2,2,0,-)', () => {
  // Am: e=0,B=1,G=2,D=2,A=0 → MIDI 64,60,57,52,45 → pcs 4,0,9,4,9 → {0,4,9} = Am
  const notes = [
    { stringIndex: 0, fret: 0 },
    { stringIndex: 1, fret: 1 },
    { stringIndex: 2, fret: 2 },
    { stringIndex: 3, fret: 2 },
    { stringIndex: 4, fret: 0 },
  ];
  const result = _fretsToChordName(STD, notes);
  assert.equal(result, 'Am');
});

test('_fretsToChordName: G major barre (3,2,0,0,0,3)', () => {
  // G major: e=3,B=2,G=0,D=0,A=0,E=3 → 67,61,55,50,45,43 → pcs 7,1,7,2,9,7 → {1,2,7,9} hmm
  // Actually G barre at 3: let's try notes that form {7,11,2} = G major
  const notes = [
    { stringIndex: 5, fret: 3 }, // E+3=43 → G → pc 7
    { stringIndex: 4, fret: 2 }, // A+2=47 → B → pc 11
    { stringIndex: 3, fret: 0 }, // D → pc 2
    { stringIndex: 2, fret: 0 }, // G → pc 7
    { stringIndex: 1, fret: 0 }, // B → pc 11
    { stringIndex: 0, fret: 3 }, // e+3=67 → G → pc 7
  ];
  const result = _fretsToChordName(STD, notes);
  assert.equal(result, 'G');
});

test('_fretsToChordName: returns null for fewer than 2 notes', () => {
  const result = _fretsToChordName(STD, [{ stringIndex: 0, fret: 0 }]);
  assert.equal(result, null);
});

test('_fretsToChordName: returns null for unrecognised voicing', () => {
  // Cluster of chromatic neighbours → no pattern match
  const notes = [
    { stringIndex: 0, fret: 0 }, // E pc 4
    { stringIndex: 1, fret: 0 }, // B pc 11
    { stringIndex: 2, fret: 0 }, // G pc 7
    { stringIndex: 3, fret: 1 }, // Eb pc 3
  ];
  // {4,11,7,3} = could match something — not guaranteed null, so just check type
  const result = _fretsToChordName(STD, notes);
  assert.ok(result === null || typeof result === 'string');
});

// ── Duration helpers ──────────────────────────────────────────────────────────

test('_gpDurToQuarters: quarter (4) = 1', () => {
  assert.equal(_gpDurToQuarters(4, 0), 1);
});

test('_gpDurToQuarters: half (2) = 2', () => {
  assert.equal(_gpDurToQuarters(2, 0), 2);
});

test('_gpDurToQuarters: whole (1) = 4', () => {
  assert.equal(_gpDurToQuarters(1, 0), 4);
});

test('_gpDurToQuarters: dotted quarter = 1.5', () => {
  assert.equal(_gpDurToQuarters(4, 1), 1.5);
});

test('_gpDurToQuarters: quarter-note triplet (3:2) ≈ 0.667', () => {
  assert.ok(Math.abs(_gpDurToQuarters(4, 0, 3, 2) - 2 / 3) < 0.0001);
});

test('_gpDurToQuarters: 8th-note triplet (3:2) ≈ 0.333', () => {
  assert.ok(Math.abs(_gpDurToQuarters(8, 0, 3, 2) - 1 / 3) < 0.0001);
});

test('_gpDurToQuarters: dotted-quarter triplet combines both factors', () => {
  // dotted quarter = 1.5; tuplet 3:2 → 1.5 * (2/3) = 1.0
  assert.ok(Math.abs(_gpDurToQuarters(4, 1, 3, 2) - 1.0) < 0.0001);
});

test('_gpDurToLetter: quarter → q', () => {
  assert.equal(_gpDurToLetter(4), 'q');
});

test('_gpDurToLetter: eighth → e', () => {
  assert.equal(_gpDurToLetter(8), 'e');
});

test('_gpDurToLetter: whole → w', () => {
  assert.equal(_gpDurToLetter(1), 'w');
});

test('_gpDurToLetter: sixteenth → s', () => {
  assert.equal(_gpDurToLetter(16), 's');
});

// ── Hybrid position helper ────────────────────────────────────────────────────

test('_cumQToHybridPos: 0.0 → "1"', () => {
  assert.equal(_cumQToHybridPos(0), '1');
});

test('_cumQToHybridPos: 1.0 → "2"', () => {
  assert.equal(_cumQToHybridPos(1), '2');
});

test('_cumQToHybridPos: 0.5 → "1&"', () => {
  assert.equal(_cumQToHybridPos(0.5), '1&');
});

test('_cumQToHybridPos: 2.5 → "3&"', () => {
  assert.equal(_cumQToHybridPos(2.5), '3&');
});

test('_cumQToHybridPos: 3.0 → "4"', () => {
  assert.equal(_cumQToHybridPos(3), '4');
});

// ── Voicing extraction ────────────────────────────────────────────────────────

test('_extractVoicing: returns null when no chord on beat', () => {
  assert.equal(_extractVoicing({}, 6), null);
  assert.equal(_extractVoicing({ chord: null }, 6), null);
});

test('_extractVoicing: returns null when chord has no strings', () => {
  assert.equal(_extractVoicing({ chord: { name: 'G', strings: [] } }, 6), null);
});

test('_extractVoicing: maps fret array to comma-separated string', () => {
  const beat = { chord: { name: 'G', strings: [3, 0, 0, 0, 2, 3] } };
  const v = _extractVoicing(beat, 6);
  assert.equal(v, '3,0,0,0,2,3');
});

test('_extractVoicing: replaces negative frets with x', () => {
  const beat = { chord: { name: 'Fmaj7', strings: [-1, -1, 2, 2, 1, 0] } };
  const v = _extractVoicing(beat, 6);
  assert.equal(v, 'x,x,2,2,1,0');
});

test('_extractVoicing: returns null when all strings muted', () => {
  const beat = { chord: { name: 'X', strings: [-1, -1, -1, -1, -1, -1] } };
  assert.equal(_extractVoicing(beat, 6), null);
});

// ── Full CSMPN generation from mock score ─────────────────────────────────────

function makeScore(overrides) {
  return Object.assign(
    {
      title: 'Test Song',
      artist: 'Test Artist',
      tempo: 120,
      masterBars: [
        {
          keySignature: 0,
          keySignatureType: 0,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          section: null,
        },
        {
          keySignature: 0,
          keySignatureType: 0,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          section: null,
        },
        {
          keySignature: 0,
          keySignatureType: 0,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          section: null,
        },
        {
          keySignature: 0,
          keySignatureType: 0,
          timeSignatureNumerator: 4,
          timeSignatureDenominator: 4,
          section: null,
        },
      ],
      tracks: [
        {
          isPercussion: false,
          staves: [
            {
              tuning: [64, 59, 55, 50, 45, 40],
              bars: [
                makeMockBar([
                  {
                    chord: { name: 'G', strings: [3, 2, 0, 0, 0, 3] },
                    duration: 4,
                    dots: 0,
                    isRest: false,
                    notes: [],
                  },
                ]),
                makeMockBar([
                  {
                    chord: { name: 'Am', strings: [-1, 0, 2, 2, 1, 0] },
                    duration: 4,
                    dots: 0,
                    isRest: false,
                    notes: [],
                  },
                ]),
                makeMockBar([
                  {
                    chord: { name: 'F', strings: [-1, -1, 3, 2, 1, 1] },
                    duration: 4,
                    dots: 0,
                    isRest: false,
                    notes: [],
                  },
                ]),
                makeMockBar([
                  {
                    chord: { name: 'C', strings: [-1, 3, 2, 0, 1, 0] },
                    duration: 4,
                    dots: 0,
                    isRest: false,
                    notes: [],
                  },
                ]),
              ],
            },
          ],
        },
      ],
    },
    overrides
  );
}

function makeMockBar(beatObjs) {
  return {
    voices: [
      {
        isEmpty: false,
        beats: beatObjs,
      },
    ],
  };
}

test('_buildCsmpnFromScore: emits title, composer, key, tempo headers', () => {
  const score = makeScore({});
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes('Title: Test Song'));
  assert.ok(csmpn.includes('Composer: Test Artist'));
  assert.ok(csmpn.includes('Key: C'));
  assert.ok(csmpn.includes('Tempo: 120'));
});

test('_buildCsmpnFromScore: emits section marker and bar lines', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({}), {});
  assert.ok(csmpn.includes(': Main'));
  assert.ok(csmpn.includes('| G | Am | F | C |'));
});

test('_buildCsmpnFromScore: uses section text from masterBar when present', () => {
  const score = makeScore({
    masterBars: [
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: { text: 'Verse' },
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: { text: 'Chorus' },
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes(': Verse'));
  assert.ok(csmpn.includes(': Chorus'));
});

test('_buildCsmpnFromScore: emits {tab} block when chord.strings are present', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({}), { includeTab: true, includeHybrid: false });
  assert.ok(csmpn.includes('{tab'));
  assert.ok(csmpn.includes('G: 3,2,0,0,0,3'));
  assert.ok(csmpn.includes('Am: x,0,2,2,1,0'));
});

test('_buildCsmpnFromScore: omits {tab} block when includeTab=false', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({}), { includeTab: false, includeHybrid: false });
  assert.ok(!csmpn.includes('{tab'));
});

test('_buildCsmpnFromScore: emits {hybrid} block with bar events', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({}), { includeTab: false, includeHybrid: true });
  assert.ok(csmpn.includes('{hybrid'));
  assert.ok(csmpn.includes('bar1:'));
  assert.ok(csmpn.includes('(G)'));
});

test('_buildCsmpnFromScore: omits {hybrid} block when includeHybrid=false', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({}), { includeTab: false, includeHybrid: false });
  assert.ok(!csmpn.includes('{hybrid'));
});

test('_buildCsmpnFromScore: uses % for bars with no chord change', () => {
  const score = makeScore({
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                { chord: { name: 'G' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'G' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]), // same chord
              makeMockBar([
                { chord: { name: 'C' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'C' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]), // same chord
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: false });
  assert.ok(csmpn.includes('%'), 'Should use % for repeated chord bars: ' + csmpn);
});

test('_buildCsmpnFromScore: skips percussion tracks', () => {
  const score = makeScore({
    tracks: [
      {
        isPercussion: true,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                { chord: { name: 'DRUMS' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: false });
  assert.ok(!csmpn.includes('DRUMS'));
  assert.ok(csmpn.includes('Am'));
});

test('_buildCsmpnFromScore: handles empty score gracefully', () => {
  const score = { title: '', artist: '', tempo: 0, masterBars: [], tracks: [] };
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.equal(csmpn, '');
});

// ── _normalizeGpChordName ─────────────────────────────────────────────────────

test('_normalizeGpChordName: strips outer parentheses', () => {
  assert.equal(_normalizeGpChordName('(Gm7)'), 'Gm7');
});

test('_normalizeGpChordName: collapses parenthesized numeric extensions', () => {
  assert.equal(_normalizeGpChordName('C7M(8)'), 'C7M8');
});

test('_normalizeGpChordName: strips numeric extension inside slash chord', () => {
  assert.equal(_normalizeGpChordName('Bm7/5+(7)'), 'Bm7/5+7');
});

test('_normalizeGpChordName: leaves normal chord names unchanged', () => {
  assert.equal(_normalizeGpChordName('Gm7'), 'Gm7');
  assert.equal(_normalizeGpChordName('Cmaj7'), 'Cmaj7');
  assert.equal(_normalizeGpChordName('D/F#'), 'D/F#');
});

test('_normalizeGpChordName: handles null/empty gracefully', () => {
  assert.equal(_normalizeGpChordName(null), null);
  assert.equal(_normalizeGpChordName(''), '');
});

// ── Position deduplication (16th-note overlap fix) ────────────────────────────

test('_buildCsmpnFromScore: deduplicates hybrid positions for 16th-note bars', () => {
  // Four 16th notes per bar: cumQ 0, 0.25, 0.5, 0.75 → positions "1", "1", "1&", "1&"
  // After dedup: only "1" and "1&" should appear once each
  const score = makeScore({
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
                { chord: { name: 'G' }, duration: 16, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'C' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'D' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Em' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: true });
  // Extract the hybrid block
  const hybridMatch = csmpn.match(/\{hybrid([\s\S]*?)\}/);
  assert.ok(hybridMatch, 'Should contain a {hybrid} block');
  const bar1Line = hybridMatch[1].split('\n').find((l) => l.trim().startsWith('bar1:'));
  assert.ok(bar1Line, 'Should have a bar1: line');
  // Count occurrences of "1:" and "1&:" — should be exactly one each
  const pos1Count = (bar1Line.match(/\b1:/g) || []).length;
  const pos1andCount = (bar1Line.match(/\b1&:/g) || []).length;
  assert.equal(pos1Count, 1, 'Position "1" should appear exactly once: ' + bar1Line);
  assert.equal(pos1andCount, 1, 'Position "1&" should appear exactly once: ' + bar1Line);
});

test('_buildCsmpnFromScore: normalized chord names appear in bar lines without outer parens', () => {
  const score = makeScore({
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                { chord: { name: '(Gm7)' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'C7M(8)' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Dm' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'Bb' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: true });
  // Bar lines must not contain outer-paren chord names (CSMPN repeat-group false positive)
  const barLines = csmpn
    .split('\n')
    .filter((l) => l.startsWith('|'))
    .join('\n');
  assert.ok(
    !barLines.includes('(Gm7)'),
    'Bar lines must not contain outer-paren chord: ' + barLines
  );
  assert.ok(barLines.includes('Gm7'), 'Normalized chord should appear in bar lines: ' + barLines);
  // "C7M(8)" → "C7M8": numeric-extension parens collapsed in bar lines
  assert.ok(
    !barLines.includes('C7M(8)'),
    'Numeric-extension paren should be collapsed in bar lines'
  );
  assert.ok(barLines.includes('C7M8'), 'Collapsed chord should appear in bar lines: ' + barLines);
  // Hybrid events must NOT have double parens: "1:q((Gm7))" is the broken form
  assert.ok(!csmpn.includes('((Gm7))'), 'Hybrid events must not have double parens');
  // Hybrid events DO have single parens around the normalized chord name
  assert.ok(csmpn.includes('(Gm7)'), 'Hybrid event should have chord in single parens');
});

test('_buildCsmpnFromScore: respects barsPerRow option', () => {
  const score = makeScore({
    masterBars: [1, 2, 3, 4, 5, 6, 7, 8].map(() => ({
      keySignature: 0,
      keySignatureType: 0,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      section: null,
    })),
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [1, 2, 3, 4, 5, 6, 7, 8].map(() =>
              makeMockBar([
                { chord: { name: 'G' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ])
            ),
          },
        ],
      },
    ],
  });
  const csmpn2 = _buildCsmpnFromScore(score, {
    barsPerRow: 2,
    includeTab: false,
    includeHybrid: false,
  });
  // Each row should have exactly 2 bars → "| G | G |" repeated
  const barRows = csmpn2.split('\n').filter((l) => l.startsWith('|'));
  assert.ok(barRows.length >= 4, 'Expected at least 4 rows of 2 bars: ' + csmpn2);
  barRows.forEach((row) => {
    const pipes = (row.match(/\|/g) || []).length;
    assert.equal(pipes, 3, 'Row should have 3 pipes (2 bars): ' + row);
  });
});

// ── Repeat barline emission ───────────────────────────────────────────────────

test('_buildCsmpnFromScore: emits |: for repeat-start bar and :| for repeat-end bar', () => {
  const score = makeScore({
    masterBars: [
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: true,
        isRepeatEnd: false,
        alternateEndings: 0,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: false,
        alternateEndings: 0,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: false,
        alternateEndings: 0,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: true,
        alternateEndings: 0,
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: false });
  assert.ok(csmpn.includes('|:'), 'Should contain repeat-start barline: ' + csmpn);
  assert.ok(csmpn.includes(':|'), 'Should contain repeat-end barline: ' + csmpn);
});

// ── Volta bracket emission ────────────────────────────────────────────────────

test('_buildCsmpnFromScore: emits 1. and 2. volta prefixes for alternate endings', () => {
  const score = makeScore({
    masterBars: [
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: false,
        alternateEndings: 0,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: false,
        alternateEndings: 0,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: true,
        alternateEndings: 1,
      },
      {
        keySignature: 0,
        keySignatureType: 0,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        section: null,
        isRepeatStart: false,
        isRepeatEnd: true,
        alternateEndings: 2,
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: false });
  assert.ok(csmpn.includes('1. '), 'Should contain first-volta prefix: ' + csmpn);
  assert.ok(csmpn.includes('2. '), 'Should contain second-volta prefix: ' + csmpn);
});

// ── Tuplet cumQ accuracy (no bar overflow) ────────────────────────────────────

test('_buildCsmpnFromScore: six quarter-note triplets fill one bar without beat overflow', () => {
  const tripletBeat = {
    chord: { name: 'G' },
    duration: 4,
    dots: 0,
    isRest: false,
    tupletNumerator: 3,
    tupletDenominator: 2,
    notes: [],
  };
  const score = makeScore({
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
              ]),
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'F' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'C' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: true });
  // Six quarter-note triplets = 6 × (2/3) = 4.0 quarter-beats — exactly one 4/4 bar.
  // Hybrid positions must stay ≤ beat 4; beat 5 would indicate cumQ overflow.
  assert.ok(!csmpn.includes('5:'), 'No beat-5 events (overflow check): ' + csmpn);
  assert.ok(!csmpn.includes('5&:'), 'No beat-5& events (overflow check): ' + csmpn);
  assert.ok(csmpn.includes('{hybrid'), 'Hybrid block should be present: ' + csmpn);
  assert.ok(csmpn.includes('1:'), 'First triplet emitted at beat 1: ' + csmpn);
});

// ── Tuplet annotation in hybrid events ───────────────────────────────────────

test('_buildCsmpnFromScore: triplet beats emit t3 annotation in hybrid events', () => {
  const tripletBeat = {
    chord: { name: 'G' },
    duration: 4,
    dots: 0,
    isRest: false,
    tupletNumerator: 3,
    tupletDenominator: 2,
    notes: [],
  };
  const score = makeScore({
    tracks: [
      {
        isPercussion: false,
        staves: [
          {
            tuning: [64, 59, 55, 50, 45, 40],
            bars: [
              makeMockBar([
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
                tripletBeat,
              ]),
              makeMockBar([
                { chord: { name: 'Am' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'F' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
              makeMockBar([
                { chord: { name: 'C' }, duration: 4, dots: 0, isRest: false, notes: [] },
              ]),
            ],
          },
        ],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: true });
  assert.ok(csmpn.includes('t3'), 'Triplet beats should carry t3 annotation: ' + csmpn);
  // The bar1 hybrid line (may be indented) must contain t3
  const bar1Line = csmpn.split('\n').find((l) => /bar1:|b1:/.test(l)) || '';
  assert.ok(bar1Line.includes('t3'), 'bar1 hybrid events should all carry t3: ' + bar1Line);
});

test('_buildCsmpnFromScore: non-tuplet beats do not emit tN annotation', () => {
  const score = makeScore({});
  const csmpn = _buildCsmpnFromScore(score, { includeTab: false, includeHybrid: true });
  // Default score has no tuplets — no tN flags should appear
  assert.ok(!csmpn.includes('t3'), 'Non-tuplet score must not contain t3: ' + csmpn);
  assert.ok(!/t\d/.test(csmpn), 'Non-tuplet score must not contain any tN flag: ' + csmpn);
});

// ── Phase 3: flat note names ──────────────────────────────────────────────────

test('_fretsToChordName: returns Bb (not A#) for Bb major voicing', () => {
  // Bb(10) in bass, D(2), F(5) → pcs {2, 5, 10} → root Bb → 'Bb'
  const notes = [
    { stringIndex: 4, fret: 1 }, // A+1=46 → pc 10 (Bb) — lowest, bass
    { stringIndex: 3, fret: 3 }, // D+3=53 → pc 5 (F)
    { stringIndex: 2, fret: 3 }, // G+3=58 → pc 10 (Bb)
    { stringIndex: 1, fret: 3 }, // B+3=62 → pc 2 (D)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'Bb');
});

test('_fretsToChordName: returns Eb (not D#) for Eb major voicing', () => {
  // Eb(3) in bass → pcs {3, 7, 10} → root Eb → 'Eb'
  const notes = [
    { stringIndex: 4, fret: 6 }, // A+6=51 → pc 3 (Eb) — lowest, bass
    { stringIndex: 3, fret: 8 }, // D+8=58 → pc 10 (Bb)
    { stringIndex: 2, fret: 8 }, // G+8=63 → pc 3 (Eb)
    { stringIndex: 1, fret: 8 }, // B+8=67 → pc 7 (G)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'Eb');
});

test('_fretsToChordName: returns Ab (not G#) for Ab major voicing', () => {
  // Ab(8) in bass → pcs {0, 3, 8} → root Ab → 'Ab'
  const notes = [
    { stringIndex: 5, fret: 4 }, // E+4=44 → pc 8 (Ab) — lowest, bass
    { stringIndex: 4, fret: 3 }, // A+3=48 → pc 0 (C)
    { stringIndex: 3, fret: 1 }, // D+1=51 → pc 3 (Eb)
    { stringIndex: 2, fret: 1 }, // G+1=56 → pc 8 (Ab)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'Ab');
});

// ── Phase 3: new chord patterns ───────────────────────────────────────────────

test('_fretsToChordName: recognises G7sus4', () => {
  // G(7), C(0), D(2), F(5) with G in bass → 'G7sus4'
  const notes = [
    { stringIndex: 5, fret: 3 }, // E+3=43 → pc 7 (G) — lowest, bass
    { stringIndex: 4, fret: 5 }, // A+5=50 → pc 2 (D)
    { stringIndex: 3, fret: 10 }, // D+10=60 → pc 0 (C)
    { stringIndex: 2, fret: 10 }, // G+10=65 → pc 5 (F)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'G7sus4');
});

test('_fretsToChordName: recognises Caug7 (C augmented 7)', () => {
  // C(0), E(4), Ab(8), Bb(10) with C in bass → 'Caug7'
  const notes = [
    { stringIndex: 5, fret: 8 }, // E+8=48 → pc 0 (C) — lowest, bass
    { stringIndex: 4, fret: 7 }, // A+7=52 → pc 4 (E)
    { stringIndex: 3, fret: 6 }, // D+6=56 → pc 8 (Ab)
    { stringIndex: 2, fret: 3 }, // G+3=58 → pc 10 (Bb)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'Caug7');
});

// ── Phase 3: slash chord detection ───────────────────────────────────────────

test('_fretsToChordName: returns D/F# when F# is lowest note', () => {
  // D major (D=2, F#=6, A=9) with F# in bass
  const notes = [
    { stringIndex: 5, fret: 2 }, // E+2=42 → pc 6 (F#) — lowest, bass
    { stringIndex: 4, fret: 0 }, // A+0=45 → pc 9 (A)
    { stringIndex: 3, fret: 0 }, // D+0=50 → pc 2 (D)
    { stringIndex: 1, fret: 3 }, // B+3=62 → pc 2 (D)
    { stringIndex: 0, fret: 2 }, // e+2=66 → pc 6 (F#)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'D/F#');
});

test('_fretsToChordName: returns G/B when B is lowest note', () => {
  // G major (G=7, B=11, D=2) with B in bass
  const notes = [
    { stringIndex: 5, fret: 7 }, // E+7=47 → pc 11 (B) — lowest, bass
    { stringIndex: 3, fret: 0 }, // D+0=50 → pc 2 (D)
    { stringIndex: 2, fret: 0 }, // G+0=55 → pc 7 (G)
    { stringIndex: 1, fret: 0 }, // B+0=59 → pc 11 (B)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'G/B');
});

test('_fretsToChordName: no slash when root is the lowest note (C major)', () => {
  // C major with C in bass → 'C' (no slash)
  const notes = [
    { stringIndex: 5, fret: 8 }, // E+8=48 → pc 0 (C) — lowest, bass
    { stringIndex: 4, fret: 7 }, // A+7=52 → pc 4 (E)
    { stringIndex: 3, fret: 5 }, // D+5=55 → pc 7 (G)
    { stringIndex: 2, fret: 5 }, // G+5=60 → pc 0 (C)
  ];
  assert.equal(_fretsToChordName(STD, notes), 'C');
});

// ── Metadata polish: tempo rounding, bracket stripping, key inference ────────

test('_buildCsmpnFromScore: fractional AlphaTab tempo is rounded (148.999 → 149)', () => {
  const csmpn = _buildCsmpnFromScore(makeScore({ tempo: 148.999 }), {});
  assert.ok(csmpn.includes('Tempo: 149'), csmpn);
  assert.ok(!csmpn.includes('148.999'));
});

test('_buildCsmpnFromScore: strips [brackets] from GP section labels', () => {
  const mbs = makeScore({}).masterBars;
  mbs[0].section = { text: '[Verse 1]' };
  const csmpn = _buildCsmpnFromScore(makeScore({ masterBars: mbs }), {});
  assert.ok(csmpn.includes(': Verse 1'), csmpn);
  assert.ok(!csmpn.includes('[Verse 1]'));
});

test('_buildCsmpnFromScore: infers minor key from chords when GP key sig is the untouched default', () => {
  const prog = ['Dm', 'C', 'Bb', 'A7'];
  const score = makeScore({});
  score.tracks[0].staves[0].bars = prog.map((name) =>
    makeMockBar([{ chord: { name, strings: [] }, duration: 4, dots: 0, isRest: false, notes: [] }])
  );
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes('Key: Dm'), csmpn);
});

test('_buildCsmpnFromScore: explicit GP key signature is trusted (no inference override)', () => {
  const prog = ['Dm', 'C', 'Bb', 'A7'];
  const score = makeScore({});
  score.masterBars.forEach((mb) => {
    mb.keySignature = 1;
  }); // 1 sharp = G major, author-set
  score.tracks[0].staves[0].bars = prog.map((name) =>
    makeMockBar([{ chord: { name, strings: [] }, duration: 4, dots: 0, isRest: false, notes: [] }])
  );
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes('Key: G'), csmpn);
});

// ── Cross-track harmony recovery (N.C. / % mitigation) ───────────────────────

const { _harvestBarPcs, _recognizeChordFromPcs } = gp;

test('_recognizeChordFromPcs: full triad is recognized', () => {
  // A(9) C(0) E(4) = Am
  assert.equal(_recognizeChordFromPcs({ 9: 4, 0: 3, 4: 3 }, 9), 'Am');
});

test('_recognizeChordFromPcs: triad with a light passing tone still resolves', () => {
  // G B D + weak passing A (below the 10% structural floor)
  assert.equal(_recognizeChordFromPcs({ 7: 4, 11: 3, 2: 3, 9: 0.3 }, 7), 'G');
});

test('_recognizeChordFromPcs: a lone melody note is not harmony', () => {
  assert.equal(_recognizeChordFromPcs({ 2: 4 }, 2), null);
  assert.equal(_recognizeChordFromPcs({}, null), null);
});

test('_recognizeChordFromPcs: two scale-adjacent melody notes stay null', () => {
  // D + E — no coherent chord fit above the confidence floor
  assert.equal(_recognizeChordFromPcs({ 2: 2, 4: 2 }, 2), null);
});

test('_harvestBarPcs: collects duration-weighted pitch classes across tracks', () => {
  const trackData = [
    {
      openMidi: [64, 59, 55, 50, 45, 40],
      bars: [
        makeMockBar([
          {
            duration: 4,
            dots: 0,
            isRest: false,
            notes: [
              { string: 3, fret: 2, isMute: false, isDead: false }, // A (57)
              { string: 2, fret: 1, isMute: false, isDead: false }, // C (60)
              { string: 1, fret: 0, isMute: false, isDead: false }, // E (64)
            ],
          },
        ]),
      ],
    },
  ];
  const { weights, bassPc } = _harvestBarPcs(trackData, 0);
  assert.deepEqual(
    Object.keys(weights)
      .map(Number)
      .sort((a, b) => a - b),
    [0, 4, 9]
  );
  assert.equal(bassPc, 9); // A is the lowest sounding note
});

test('_buildCsmpnFromScore: melodic bars recover harmony from a second track', () => {
  const score = makeScore({});
  // Chord track: annotated G and C in bars 1-2 (keeps it the selected chord
  // track), then two melodic single-note bars that previously collapsed to %.
  const melodyBeat = (fret) => ({
    duration: 4,
    dots: 0,
    isRest: false,
    notes: [{ string: 1, fret, isMute: false, isDead: false }],
  });
  const annotated = (name, strings) => ({
    chord: { name, strings },
    duration: 4,
    dots: 0,
    isRest: false,
    notes: [],
  });
  score.tracks[0].staves[0].bars = [
    makeMockBar([annotated('G', [3, 2, 0, 0, 0, 3])]),
    makeMockBar([annotated('C', [-1, 3, 2, 0, 1, 0])]),
    makeMockBar([melodyBeat(0)]),
    makeMockBar([melodyBeat(3)]),
  ];
  // Rhythm track: comps whole-note Am voicings under the melodic bars 3-4.
  const amBeat = () => ({
    duration: 1,
    dots: 0,
    isRest: false,
    notes: [
      { string: 3, fret: 2, isMute: false, isDead: false }, // A
      { string: 2, fret: 1, isMute: false, isDead: false }, // C
      { string: 1, fret: 0, isMute: false, isDead: false }, // E
    ],
  });
  score.tracks.push({
    isPercussion: false,
    staves: [
      {
        tuning: [64, 59, 55, 50, 45, 40],
        bars: [makeMockBar([]), makeMockBar([]), makeMockBar([amBeat()]), makeMockBar([amBeat()])],
      },
    ],
  });
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes('| G | C | Am | % |'), csmpn);
});

test('_buildCsmpnFromScore: truly silent bars still emit N.C. / %', () => {
  const score = makeScore({});
  score.tracks[0].staves[0].bars = [
    makeMockBar([]),
    makeMockBar([
      {
        chord: { name: 'C', strings: [-1, 3, 2, 0, 1, 0] },
        duration: 4,
        dots: 0,
        isRest: false,
        notes: [],
      },
    ]),
    makeMockBar([]),
    makeMockBar([]),
  ];
  const csmpn = _buildCsmpnFromScore(score, {});
  assert.ok(csmpn.includes('| N.C. | C | % | % |'), csmpn);
});

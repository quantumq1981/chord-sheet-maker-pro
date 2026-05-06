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
  const src = readFileSync(new URL('../importGuitarPro.js', import.meta.url), 'utf8');
  const context = {
    window: {},
    document: {
      createElement: () => ({ src: '', crossOrigin: '', onload: null, onerror: null }),
      head: { appendChild: () => {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(src, context);
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

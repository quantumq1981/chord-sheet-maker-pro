import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// abcSuite.js pure helpers need no DOM/abcjs. chordTheory.js is loaded first so the
// chord-voicing helpers (chordToAbcChord / csmpnToAbc voiced) find window.ChordTheory.
function loadAbc() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('chordTheory.js'), ctx);
  vm.runInContext(read('abcSuite.js'), ctx);
  return ctx.window.ABCSuite;
}

const A = loadAbc();

test('exposes the expected API surface', () => {
  for (const fn of [
    'extractAbcTitle',
    'abcTempoBpm',
    'sniffIsAbc',
    'defaultAbcExample',
    'ensureAbcHeaders',
    'render',
    'createPlayer',
    'abcjsReady',
  ]) {
    assert.equal(typeof A[fn], 'function', `${fn} is a function`);
  }
  assert.match(A.SOUNDFONT_URL, /cdn\.jsdelivr\.net/); // CSP-allowed host
});

test('extractAbcTitle reads the first T: field', () => {
  assert.equal(A.extractAbcTitle('X:1\nT:Greensleeves\nK:Am\nA'), 'Greensleeves');
  assert.equal(A.extractAbcTitle('X:1\nK:C\nC'), 'Untitled');
});

test('abcTempoBpm parses Q: in both forms', () => {
  assert.equal(A.abcTempoBpm('X:1\nQ:1/4=120\nK:C'), 120);
  assert.equal(A.abcTempoBpm('X:1\nQ:1/4 = 90\nK:C'), 90);
  assert.equal(A.abcTempoBpm('X:1\nQ:144\nK:C'), 144);
  assert.equal(A.abcTempoBpm('X:1\nK:C'), null);
});

test('sniffIsAbc requires both X: and K:', () => {
  assert.equal(A.sniffIsAbc('X:1\nT:T\nK:C\nCDEF'), true);
  assert.equal(A.sniffIsAbc('just some chords G C D'), false);
  assert.equal(A.sniffIsAbc('K:C only'), false);
});

test('defaultAbcExample is a complete, well-formed tune', () => {
  const ex = A.defaultAbcExample();
  assert.equal(A.sniffIsAbc(ex), true);
  // ensureAbcHeaders is a no-op on already-complete input
  assert.equal(A.ensureAbcHeaders(ex), ex);
});

test('ensureAbcHeaders leaves well-formed ABC untouched', () => {
  const ok = 'X:1\nT:Tune\nM:6/8\nL:1/8\nK:G\nGAB cde';
  assert.equal(A.ensureAbcHeaders(ok), ok);
});

test('ensureAbcHeaders injects X:/M:/L:/K: for a bare body', () => {
  const out = A.ensureAbcHeaders('CDEF GABc | c4 z4 |]');
  const lines = out.split('\n');
  assert.equal(lines[0], 'X:1');
  assert.ok(out.includes('M:4/4'));
  assert.ok(out.includes('L:1/8'));
  // K: must be the last header line, immediately before the body
  const kIdx = lines.findIndex((l) => l.startsWith('K:'));
  assert.equal(lines[kIdx], 'K:C');
  assert.equal(lines[kIdx + 1], 'CDEF GABc | c4 z4 |]');
  assert.equal(A.sniffIsAbc(out), true);
});

// ── Tier-2: render options (transpose / guitar tab / instruments) ─────────────

test('clampSemitones rounds and clamps to ±24', () => {
  assert.equal(A.clampSemitones(0), 0);
  assert.equal(A.clampSemitones(2), 2);
  assert.equal(A.clampSemitones(-2), -2);
  assert.equal(A.clampSemitones(99), 24);
  assert.equal(A.clampSemitones(-99), -24);
  assert.equal(A.clampSemitones(1.6), 2);
  assert.equal(A.clampSemitones('x'), 0);
});

test('buildRenderOptions omits visualTranspose at 0 and sets it otherwise', () => {
  assert.equal(A.buildRenderOptions({}).visualTranspose, undefined);
  assert.equal(A.buildRenderOptions({ transpose: 0 }).visualTranspose, undefined);
  assert.equal(A.buildRenderOptions({ transpose: 3 }).visualTranspose, 3);
  assert.equal(A.buildRenderOptions({ transpose: 99 }).visualTranspose, 24); // clamped
});

test('buildRenderOptions enables guitar tablature only when requested', () => {
  assert.equal(A.buildRenderOptions({}).tablature, undefined);
  const tab = A.buildRenderOptions({ guitarTab: true }).tablature;
  // structural (not deepEqual) — vm-realm array prototype differs from this realm
  assert.equal(tab.length, 1);
  assert.equal(tab[0].instrument, 'guitar');
});

test('buildRenderOptions keeps base options and passes unknown keys through', () => {
  const o = A.buildRenderOptions({ scale: 1.2 });
  assert.equal(o.add_classes, true);
  assert.equal(o.responsive, 'resize');
  assert.equal(o.scale, 1.2); // passthrough
});

test('buildRenderOptions does NOT emit program (it is a %%MIDI directive, not a render option)', () => {
  assert.equal(A.buildRenderOptions({ program: 24 }).program, undefined);
});

test('withMidiProgram injects %%MIDI program after the header, before the body', () => {
  const out = A.withMidiProgram('X:1\nT:Tune\nK:C\n"C"z8 |]', 24);
  const lines = out.split('\n');
  const kIdx = lines.findIndex((l) => l.startsWith('K:'));
  assert.equal(lines[kIdx + 1], '%%MIDI program 24'); // right after K:, before the body
  assert.ok(out.includes('"C"z8'));
});

test('withMidiProgram is a no-op when the tune already declares a program, and clamps 0–127', () => {
  const has = 'X:1\nK:C\n%%MIDI program 5\nCDEF';
  assert.equal(A.withMidiProgram(has, 24), has); // unchanged
  assert.ok(A.withMidiProgram('X:1\nK:C\nCDEF', 999).includes('%%MIDI program 127'));
});

test('MELODY_INSTRUMENTS is a non-empty list of {name, program}', () => {
  assert.ok(Array.isArray(A.MELODY_INSTRUMENTS) && A.MELODY_INSTRUMENTS.length >= 4);
  for (const it of A.MELODY_INSTRUMENTS) {
    assert.equal(typeof it.name, 'string');
    assert.equal(typeof it.program, 'number');
  }
  assert.equal(A.MELODY_INSTRUMENTS[0].program, 0); // Piano default
});

test('SOUNDFONTS is a list of {name, url} all on the CSP-allowed jsdelivr host', () => {
  assert.ok(Array.isArray(A.SOUNDFONTS) && A.SOUNDFONTS.length >= 2);
  for (const sf of A.SOUNDFONTS) {
    assert.equal(typeof sf.name, 'string');
    assert.match(sf.url, /^https:\/\/cdn\.jsdelivr\.net\//);
    assert.match(sf.url, /\/$/); // trailing slash (abcjs appends the instrument file)
  }
  assert.equal(A.SOUNDFONTS[0].url, A.SOUNDFONT_URL); // default is the first entry
});

// ── Tune Trainer schedule (pure) ──────────────────────────────────────────────

test('clampPercent clamps to 10–400 and defaults 0 to 100', () => {
  assert.equal(A.clampPercent(60), 60);
  assert.equal(A.clampPercent(5), 10);
  assert.equal(A.clampPercent(999), 400);
  assert.equal(A.clampPercent(0), 100);
  assert.equal(A.clampPercent('x'), 100);
});

test('buildTrainerSteps walks start→end by increment, ending exactly on end', () => {
  assert.deepEqual(
    Array.from(
      A.buildTrainerSteps({
        startPercent: 60,
        endPercent: 100,
        incrementPercent: 20,
        loopsPerStep: 1,
      })
    ),
    [60, 80, 100]
  );
});

test('buildTrainerSteps repeats each tempo loopsPerStep times', () => {
  assert.deepEqual(
    Array.from(
      A.buildTrainerSteps({
        startPercent: 80,
        endPercent: 100,
        incrementPercent: 20,
        loopsPerStep: 2,
      })
    ),
    [80, 80, 100, 100]
  );
});

test('buildTrainerSteps with increment 0 just loops at the start tempo', () => {
  assert.deepEqual(
    Array.from(
      A.buildTrainerSteps({
        startPercent: 70,
        endPercent: 100,
        incrementPercent: 0,
        loopsPerStep: 3,
      })
    ),
    [70, 70, 70]
  );
});

test('buildTrainerSteps clamps a runaway schedule to 200 entries', () => {
  const steps = A.buildTrainerSteps({
    startPercent: 10,
    endPercent: 400,
    incrementPercent: 1,
    loopsPerStep: 10,
  });
  assert.equal(steps.length, 200);
});

test('buildTrainerSteps treats end<start as a single-tempo loop', () => {
  assert.deepEqual(
    Array.from(
      A.buildTrainerSteps({
        startPercent: 100,
        endPercent: 60,
        incrementPercent: 10,
        loopsPerStep: 1,
      })
    ),
    [100]
  );
});

// ── Phase C: csmpnToAbc round-trip (parser injected for a pure test) ──────────

// Minimal stand-in for parseHybridChartFromCSMPN's output shape.
function fakeParse(model) {
  return () => model;
}

test('csmpnToAbc builds a header from chart metadata', () => {
  const abc = A.csmpnToAbc('ignored', {
    parse: fakeParse({
      title: 'Blue Bossa',
      composer: 'Kenny Dorham',
      key: 'Cm',
      time: '4/4',
      tempo: 140,
      sections: [{ label: 'A', bars: [{ chordToken: 'Cm7' }] }],
    }),
  });
  assert.ok(abc.includes('T:Blue Bossa'));
  assert.ok(abc.includes('C:Kenny Dorham'));
  assert.ok(abc.includes('M:4/4'));
  assert.ok(abc.includes('L:1/8'));
  assert.ok(abc.includes('Q:1/4=140'));
  assert.ok(abc.includes('K:Cm'));
  assert.equal(A.sniffIsAbc(abc), true); // round-trips back through the sniffer
});

test('csmpnToAbc emits one chord-annotated whole-bar rest per single-chord bar (4/4 = z8)', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({
      time: '4/4',
      sections: [{ label: '', bars: [{ chordToken: 'C' }, { chordToken: 'G' }] }],
    }),
  });
  assert.ok(abc.includes('"C"z8'));
  assert.ok(abc.includes('"G"z8'));
});

test('csmpnToAbc splits a multi-chord bar across the bar (C_G → "C"z4 "G"z4)', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({ time: '4/4', sections: [{ bars: [{ chordToken: 'C_G' }] }] }),
  });
  assert.ok(abc.includes('"C"z4 "G"z4'), abc);
});

test('csmpnToAbc renders the section label as an above-staff annotation', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({ sections: [{ label: 'Verse', bars: [{ chordToken: 'C' }] }] }),
  });
  assert.ok(abc.includes('"^Verse"'), abc);
});

test('csmpnToAbc carries repeat barlines and voltas', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({
      time: '4/4',
      sections: [
        {
          bars: [
            { chordToken: 'C', leftBar: 'repeat-start' },
            { chordToken: 'Am', endingLabel: '1', rightBar: 'repeat-end' },
            { chordToken: 'F', endingLabel: '2' },
          ],
        },
      ],
    }),
  });
  assert.ok(abc.includes('|:'), abc); // repeat-start
  assert.ok(abc.includes(':|'), abc); // repeat-end
  assert.ok(/\[1/.test(abc), abc); // 1st ending
  assert.ok(/\[2/.test(abc), abc); // 2nd ending
});

test('csmpnToAbc sustains the previous chord through a % simile bar', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({
      time: '4/4',
      sections: [{ bars: [{ chordToken: 'F' }, { chordToken: '%' }] }],
    }),
  });
  // both bars carry an "F" chord (the % repeats it)
  assert.equal((abc.match(/"F"z8/g) || []).length, 2, abc);
});

test('csmpnToAbc normalizes unicode accidentals and closes with a final barline', () => {
  const abc = A.csmpnToAbc('x', {
    parse: fakeParse({ time: '4/4', key: 'B♭', sections: [{ bars: [{ chordToken: 'B♭7' }] }] }),
  });
  assert.ok(abc.includes('K:Bb'));
  assert.ok(abc.includes('"Bb7"'));
  assert.ok(/\|\]\s*$/.test(abc), abc); // ends with a final barline
});

test('csmpnToAbc throws a clear error when no parser is available', () => {
  assert.throws(() => A.csmpnToAbc('x', {}), /CSMPN parser unavailable/);
});

// ── Voiced chords: token → ABC [notes] (staff notation + guitar tab) ──────────

test('chordTokenToMidis voices common qualities to the right pitch classes', () => {
  const pcs = (midis) => Array.from(midis, (m) => ((m % 12) + 12) % 12);
  const CT = {
    CHORD_PATTERNS: [
      { suffix: '', intervals: [0, 4, 7] },
      { suffix: 'm', intervals: [0, 3, 7] },
      { suffix: '7', intervals: [0, 4, 7, 10] },
    ],
  };
  assert.deepEqual(pcs(A.chordTokenToMidis('C', CT.CHORD_PATTERNS)), [0, 4, 7]); // C E G
  assert.deepEqual(pcs(A.chordTokenToMidis('Cm', CT.CHORD_PATTERNS)), [0, 3, 7]); // C Eb G
  assert.deepEqual(
    pcs(A.chordTokenToMidis('Bb7', CT.CHORD_PATTERNS)).sort((a, b) => a - b),
    [2, 5, 8, 10]
  ); // Bb D F Ab
});

test('chordToAbcChord renders an ABC chord bracket from the shared chord DB', () => {
  // window.ChordTheory is loaded in the test context → no args needed.
  assert.equal(A.chordToAbcChord('C'), '[=C,=E,=G,]');
  assert.match(A.chordToAbcChord('Cm'), /_E/); // minor 3rd = Eb
  assert.match(A.chordToAbcChord('Bb7'), /^\[_B/); // Bb is the lowest note
  assert.equal(A.chordToAbcChord('N.C.'), null);
  assert.equal(A.chordToAbcChord('%'), null);
});

test('chordToAbcChord puts the slash bass below the chord', () => {
  const chord = A.chordToAbcChord('D/F#');
  assert.match(chord, /^\[\^F,,/); // F#2 (two commas) is the lowest note
});

test('slash bass stays on/above the guitar low E (40) so it renders in tab', () => {
  const patterns = [
    { suffix: '', intervals: [0, 4, 7] },
    { suffix: 'm', intervals: [0, 3, 7] },
  ];
  for (const t of ['Am/C', 'F/C', 'Dm/C', 'C/E']) {
    const midis = A.chordTokenToMidis(t, patterns);
    assert.ok(midis[0] >= 40, `${t} bass ${midis[0]} below guitar low E`);
  }
});

test('csmpnToAbc voiced=true emits chord brackets (notation + tab) instead of rests', () => {
  const abc = A.csmpnToAbc('x', {
    voiced: true,
    parse: () => ({
      time: '4/4',
      sections: [{ bars: [{ chordToken: 'C' }, { chordToken: 'Bb7' }] }],
    }),
  });
  assert.ok(abc.includes('"C"[=C,=E,=G,]8'), abc); // symbol above + voiced notehead chord
  assert.ok(abc.includes('"Bb7"['), abc);
  assert.ok(!/z8/.test(abc.split('K:')[1]), abc); // no whole-bar rests in the body
});

test('csmpnToAbc voiced default (false) still emits chord-symbol-over-rest', () => {
  const abc = A.csmpnToAbc('x', {
    parse: () => ({ time: '4/4', sections: [{ bars: [{ chordToken: 'C' }] }] }),
  });
  assert.ok(abc.includes('"C"z8'), abc); // unchanged chord-chart behaviour
});

test('csmpnToAbc voiced sustains the previous chord through % (with its notes)', () => {
  const abc = A.csmpnToAbc('x', {
    voiced: true,
    parse: () => ({
      time: '4/4',
      sections: [{ bars: [{ chordToken: 'F' }, { chordToken: '%' }] }],
    }),
  });
  const body = abc.split('K:')[1];
  assert.equal((body.match(/"F"\[/g) || []).length, 2, body); // F voiced twice (the % repeats it)
});

test('csmpnToAbc voiced keeps N.C. bars as rests', () => {
  const abc = A.csmpnToAbc('x', {
    voiced: true,
    parse: () => ({ time: '4/4', sections: [{ bars: [{ chordToken: 'N.C.' }] }] }),
  });
  assert.ok(/z8/.test(abc.split('K:')[1]), abc);
});

test('ensureAbcHeaders preserves present fields and only fills the gaps', () => {
  // Has T:, M:, body — but no X: and no K:
  const out = A.ensureAbcHeaders('T:Partial\nM:3/4\n"Am"A2c2e2');
  assert.ok(out.includes('T:Partial'));
  assert.ok(out.includes('M:3/4')); // not overwritten with the 4/4 default
  assert.ok(/(^|\n)X:1/.test(out));
  assert.ok(/(^|\n)L:1\/8/.test(out)); // missing → default added
  const lines = out.split('\n');
  assert.equal(lines[lines.length - 1], '"Am"A2c2e2'); // body stays last
  assert.ok(lines[lines.length - 2].startsWith('K:')); // K: just above body
});

// ── Integration: csmpnToAbc against the REAL parseHybridChartFromCSMPN ─────────
// Loads the actual CSMPN→model stack so the field-name contract (sections[].bars[]
// .chordToken/leftBar/rightBar/endingLabel) is verified end-to-end, not just mocked.
function loadAbcWithStack() {
  const ctx = {
    window: {},
    console,
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {} }),
      querySelector: () => null,
    },
    fbSettings: { barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'flat',
    CustomEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
  };
  ctx.window.document = ctx.document;
  ctx.window.dispatchEvent = () => {};
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of [
    'utils.js',
    'chordProcessing.js',
    'csmpnParser.js',
    'musicXmlCore.js',
    'renderer.js',
    'importPipeline.js',
    'abcSuite.js',
  ])
    vm.runInContext(read(f), ctx);
  return ctx.window.ABCSuite;
}

test('csmpnToAbc converts a real CSMPN chart via the live parser', () => {
  const AB = loadAbcWithStack();
  const csmpn = [
    'Title: Round Trip',
    'Key: F',
    'Time: 4/4',
    'Tempo: 120',
    '',
    '- Verse',
    '|: Dm7 | G7 | Cmaj7 | A7 :|',
    '',
    '- Chorus',
    'F | Bb_C7 | F | F',
  ].join('\n');
  const abc = AB.csmpnToAbc(csmpn);
  assert.ok(abc.includes('T:Round Trip'), abc);
  assert.ok(abc.includes('M:4/4'));
  assert.ok(abc.includes('K:F'));
  assert.ok(abc.includes('"Dm7"z8'), abc); // chord-annotated whole-bar rest
  assert.ok(abc.includes('"Bb"z4 "C7"z4'), abc); // split multi-chord bar
  assert.ok(abc.includes('|:') && abc.includes(':|'), abc); // repeats survive
  assert.ok(/\|\]\s*$/.test(abc), abc); // final barline
  assert.equal(A.sniffIsAbc(abc), true); // the output is itself valid ABC
});

// ── Print pagination ──────────────────────────────────────────────────────────
//
// abcjs renders one continuous SVG however tall, and a print dialog will slice
// that wherever a sheet ends — through the middle of a staff. These cover the
// geometry that puts each cut between systems instead. The measuring of a live
// SVG (measureStaffBands/buildPrintPages) needs a browser and stays a device check.

test('pageAspect describes the printable area, not the whole sheet', () => {
  // Letter at 0.5in margins is 7.5 × 10in, so a page is taller than it is wide.
  assert.ok(Math.abs(A.pageAspect('letter', 0.5) - 10 / 7.5) < 1e-9);
  assert.ok(Math.abs(A.pageAspect('a4', 0.5) - 10.69 / 7.27) < 1e-9);
  // Bigger margins make the printable area proportionally taller.
  assert.ok(A.pageAspect('letter', 1) > A.pageAspect('letter', 0.5));
  assert.ok(A.pageAspect() > 1, 'portrait by default');
});

test('pageBandHeight scales the page to the content width', () => {
  assert.equal(A.pageBandHeight(750, 2), 1500);
  assert.equal(A.pageBandHeight(0, 2), 0, 'no width, no page');
  assert.equal(A.pageBandHeight(-5, 2), 0);
});

test('a page break never falls inside a staff system', () => {
  // Six 100-tall systems, 250-tall pages: two fit per page, the third would
  // straddle the boundary and must start the next page instead.
  const bands = [0, 100, 200, 300, 400, 500].map((t) => ({ top: t, bottom: t + 100 }));
  const pages = A.paginateBands(bands, 250);
  assert.equal(pages.length, 3);
  assert.deepEqual(
    Array.from(pages, (p) => p.top),
    [0, 200, 400]
  );
  // What matters is what the sheet SHOWS: the page is clipped to contentBottom,
  // so no system may straddle that edge.
  for (const p of pages) {
    const straddles = bands.some((b) => b.top < p.contentBottom && b.bottom > p.contentBottom);
    assert.ok(!straddles, `a system is cut at ${p.contentBottom}`);
    assert.ok(p.contentBottom <= p.top + p.height, 'content stays within the sheet');
  }
});

test('every page is the same height, so sheets scale identically', () => {
  // The "uneven" symptom: a short final page must leave white space, not be
  // blown up to fill the sheet.
  const bands = [
    { top: 0, bottom: 90 },
    { top: 90, bottom: 180 },
    { top: 180, bottom: 200 },
  ];
  const pages = A.paginateBands(bands, 100);
  assert.ok(pages.length > 1);
  for (const p of pages) assert.equal(p.height, 100);
});

test('a system taller than a page gets its own page rather than being clipped', () => {
  const pages = A.paginateBands(
    [
      { top: 0, bottom: 40 },
      { top: 40, bottom: 400 },
    ],
    100
  );
  assert.equal(pages.length, 2);
  assert.equal(pages[1].top, 40, 'the oversized system starts a page');
});

test('paginateBands sorts by position and ignores unusable bands', () => {
  const pages = A.paginateBands(
    [
      { top: 200, bottom: 300 },
      null,
      { top: 0, bottom: 100 },
      { top: 50, bottom: 50 }, // zero height
      { top: 10, bottom: 5 }, // inverted
      { top: NaN, bottom: 10 },
    ],
    1000
  );
  assert.equal(pages.length, 1);
  assert.equal(pages[0].top, 0, 'starts at the topmost real band');
});

test('no bands means no pages — the caller keeps the single-SVG path', () => {
  assert.deepEqual(Array.from(A.paginateBands([], 100)), []);
  assert.deepEqual(Array.from(A.paginateBands(null, 100)), []);
});

test('an unusable page height collapses to one page rather than losing music', () => {
  const bands = [
    { top: 0, bottom: 100 },
    { top: 100, bottom: 250 },
  ];
  for (const bad of [0, -10, NaN, undefined]) {
    const pages = A.paginateBands(bands, bad);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].top, 0);
    assert.equal(pages[0].height, 250, 'the whole tune, uncut');
  }
});

test('the pages cover every band — nothing falls off the end', () => {
  const bands = [];
  for (let i = 0; i < 17; i++) bands.push({ top: i * 60, bottom: i * 60 + 55 });
  const pages = A.paginateBands(bands, 200);
  const last = pages[pages.length - 1];
  assert.ok(
    last.top + last.height >= bands[bands.length - 1].bottom,
    'the final page reaches the end of the music'
  );
  for (const b of bands) {
    assert.ok(
      pages.some((p) => b.top >= p.top && b.bottom <= p.top + p.height),
      `band at ${b.top} is not wholly on any page`
    );
  }
});

test('measureStaffBands and buildPrintPages degrade instead of throwing', () => {
  // No DOM here; they must return empty/null so the print path falls back.
  assert.deepEqual(Array.from(A.measureStaffBands(null)), []);
  assert.deepEqual(Array.from(A.measureStaffBands({})), []);
  assert.equal(A.buildPrintPages(null), null);
});

test('each page reports where its music ends, so the sheet can be clipped', () => {
  // The subtle failure this guards: assigning a system to the next page is not
  // enough. A fixed-height window still SHOWS the space below the last system,
  // so without contentBottom the cut staff reappears at the bottom of the sheet.
  const bands = [0, 100, 200, 300].map((t) => ({ top: t, bottom: t + 100 }));
  const pages = A.paginateBands(bands, 250);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].contentBottom, 200, 'page 1 ends after its second system');
  assert.ok(pages[0].contentBottom < pages[0].top + pages[0].height, 'clipped short of the sheet');
  assert.equal(pages[1].contentBottom, 400, 'page 2 ends after the last system');
});

test('the single-page fallback still reports contentBottom', () => {
  const pages = A.paginateBands(
    [
      { top: 0, bottom: 100 },
      { top: 100, bottom: 250 },
    ],
    0
  );
  assert.equal(pages[0].contentBottom, 250);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// abcSuite.js pure helpers need no DOM/abcjs.
function loadAbc() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
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

test('MELODY_INSTRUMENTS is a non-empty list of {name, program}', () => {
  assert.ok(Array.isArray(A.MELODY_INSTRUMENTS) && A.MELODY_INSTRUMENTS.length >= 4);
  for (const it of A.MELODY_INSTRUMENTS) {
    assert.equal(typeof it.name, 'string');
    assert.equal(typeof it.program, 'number');
  }
  assert.equal(A.MELODY_INSTRUMENTS[0].program, 0); // Piano default
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

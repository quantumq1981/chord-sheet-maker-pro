import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadHybridParser() {
  const src = readFileSync(new URL('../importPipeline.js', import.meta.url), 'utf8');
  const start = src.indexOf('const HYBRID_DURATION_MAP');
  if (start < 0) throw new Error('Hybrid parser block not found in importPipeline.js');
  const chunk = src.slice(start);
  const context = {
    parseCSMPN: () => ({
      title: 'Test Song',
      composer: 'Test Composer',
      key: 'G',
      time: '4/4',
      tempo: '120',
      style: '',
      blocks: [
        { type: 'marker', marker: '-', text: 'Verse' },
        { type: 'bars', tokens: ['|', 'G', '|', 'D', '|', 'Em', '|', 'C', '|'] },
      ],
    }),
    parseBarStructures: () => [{}, {}, {}, {}],
    isBarlineToken: (token) => token === '|',
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(chunk, context);
  return context.parseHybridChartFromCSMPN;
}

test('parses hybrid rhythm block with events, accents, PM and tab', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nbar1: pm 1:q(G)! 2:e 2&:e 3:q 4:rq\nbar2: pm_start 1:h(D) 3:h pm_end\ntab2: x,x,5,4,3,x @ 1\ncue2: tight hits\nsectionCue: Nile-style 16ths\n}`
  );

  assert.equal(out.active, true);
  assert.equal(out.sections[0].bars[0].events.length, 5);
  assert.equal(out.sections[0].bars[0].events[0].accent, true);
  assert.equal(out.sections[0].bars[1].pm.spans.length, 1);
  assert.equal(out.sections[0].bars[1].tabEvents[0].shape, 'x,x,5,4,3,x');
  assert.equal(out.sections[0].cueText, 'Nile-style 16ths');
});

test('returns warnings for invalid beat, duration and malformed tab shape', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nbar1: 6:q(G) 2:z\nbar2: 1:q\ntab2: x,3,2\ncue9: no bar\n}`
  );

  assert.equal(out.active, true);
  assert.ok(out.warnings.some((w) => w.includes('Invalid beat')));
  assert.ok(out.warnings.some((w) => w.includes('Unsupported duration')));
  assert.ok(out.warnings.some((w) => w.includes('Malformed tab shape')));
  assert.ok(out.warnings.some((w) => w.includes('cue9')));
});

test('supports shorthand aliases and compact event tokens for mobile typing', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nsc: tight pocket\nb1: 1q(G)! 2e 2&e 3q 4rq\nt2: x,x,5,4,3,x @ 1\nc2: stop-time\n}`
  );

  assert.equal(out.active, true);
  assert.equal(out.sections[0].cueText, 'tight pocket');
  assert.equal(out.sections[0].bars[0].events.length, 5);
  assert.equal(out.sections[0].bars[1].tabEvents.length, 1);
  assert.equal(out.sections[0].bars[1].cueText, 'stop-time');
});

test('falls back cleanly when hybrid block has no valid entries', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: ???\nt1: x,3\n}`
  );

  assert.equal(out.active, false);
  assert.ok(out.warnings.length >= 2);
});

test('chordToken is captured from CSMPN source for unannotated bars', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  // Only bar1 has hybrid events; bars 2-4 are unannotated chord-only bars
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:q(G) 2:q 3:q 4:q\n}`
  );

  assert.equal(out.active, true);
  assert.equal(out.sections[0].bars[0].chordToken, 'G');
  assert.equal(out.sections[0].bars[1].chordToken, 'D');
  assert.equal(out.sections[0].bars[2].chordToken, 'Em');
  assert.equal(out.sections[0].bars[3].chordToken, 'C');
});

test('chordToken is preserved on bars that have hybrid events', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  // All four bars have explicit hybrid events; chordToken must still reflect source
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:q(G) 2:q 3:q 4:q\nb2: 1:h(D) 3:h\nb3: 1:q 2:q 3:q 4:q\nb4: 1:h 3:h\n}`
  );

  assert.equal(out.active, true);
  assert.equal(out.sections[0].bars[0].chordToken, 'G');
  assert.equal(out.sections[0].bars[1].chordToken, 'D');
  assert.equal(out.sections[0].bars[2].chordToken, 'Em');
  assert.equal(out.sections[0].bars[3].chordToken, 'C');
});

test('drops overlapping events and emits a duration-span overlap warning', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  // whole note (4 beats) at beat 1 + quarter at beat 2 → beat 2 falls inside the whole
  const out = parseHybridChartFromCSMPN(`- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:w(G) 2:q\n}`);

  assert.equal(out.active, true);
  assert.equal(out.sections[0].bars[0].events.length, 1);
  assert.equal(out.sections[0].bars[0].events[0].duration, 'w');
  assert.ok(out.warnings.some((w) => w.includes('overlaps')));
});

test('warns on pm_end without a matching pm_start', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:q(G) pm_end 2:q 3:q 4:q\n}`
  );

  assert.equal(out.active, true);
  assert.ok(out.warnings.some((w) => w.includes('pm_end')));
  assert.equal(out.sections[0].bars[0].events.length, 4);
});

test('returns doc metadata (title, key, time, composer) in parse result', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:q(G) 2:q 3:q 4:q\n}`
  );

  assert.equal(out.title, 'Test Song');
  assert.equal(out.composer, 'Test Composer');
  assert.equal(out.key, 'G');
  assert.equal(out.time, '4/4');
});

test('prefixes validation warnings with section and bar context', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  const out = parseHybridChartFromCSMPN(`- Verse\n| G | D | Em | C |\n{hybrid\nb1: 9:q(G)\n}`);

  // Beat 9 is out of range for 4/4; warning must carry "[Verse bar 1]" prefix
  assert.ok(out.warnings.some((w) => w.startsWith('[Verse bar 1]') && w.includes('Invalid beat')));
});

test('span-level PM spans store startIndex and endIndex into event array', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  // pm_start before event at index 0, pm_end after event at index 1
  const out = parseHybridChartFromCSMPN(
    `- Verse\n| G | D | Em | C |\n{hybrid\nb1: pm_start 1:q(G) 2:q pm_end 3:q 4:q\n}`
  );

  assert.equal(out.active, true);
  const spans = out.sections[0].bars[0].pm.spans;
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startIndex, 0);
  assert.equal(spans[0].endIndex, 1);
  assert.equal(out.sections[0].bars[0].pm.bar, false);
});

test('empty bar (no events, no chordToken) is marked active=false for the chart', () => {
  const parseHybridChartFromCSMPN = loadHybridParser();
  // hybrid block with no valid events → active false
  const out = parseHybridChartFromCSMPN(`- Verse\n| G | D | Em | C |\n{hybrid\nb1: ???\n}`);

  assert.equal(out.active, false);
});

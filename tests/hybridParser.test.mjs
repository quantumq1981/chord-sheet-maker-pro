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
      time: '4/4',
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

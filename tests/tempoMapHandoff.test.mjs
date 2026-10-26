import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// the browser stack the chart, playback and MusicXML export run on (same as audioPlayback.test.mjs)
function loadStack() {
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
    'audioPlayback.js',
    'handoffParts.js',
  ])
    vm.runInContext(read(f), ctx);
  return ctx;
}

const CHART = `Title: Drift
Time: 4/4
Tempo: 100
Tempo Map: 1=100 3=120 4=90.5

- Verse
| C | F | G | C |
`;

test('Tempo Map header → doc.tempoMap (sorted, last entry per bar wins, junk ignored); not a bar', () => {
  const ctx = loadStack();
  const doc = ctx.parseCSMPN(CHART);
  assert.deepEqual(JSON.parse(JSON.stringify(doc.tempoMap)), [
    { bar: 1, bpm: 100 },
    { bar: 3, bpm: 120 },
    { bar: 4, bpm: 90.5 },
  ]);
  assert.equal(doc.tempo, '100');
  const bars = doc.blocks
    .filter((b) => b.type === 'bars')
    .flatMap((b) => b.tokens)
    .filter((t) => !/^\|/.test(t));
  assert.equal(bars.length, 4, 'the Tempo Map line is metadata, not a bar');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseTempoMap('9=119 1=117.5 junk 9=121 0=80'))), [
    { bar: 1, bpm: 117.5 },
    { bar: 9, bpm: 121 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.parseCSMPN('Title: X\n| C |').tempoMap)), []);
});

test('playback follows the tempo map bar by bar; without one, nothing changes', () => {
  const ctx = loadStack();
  const S = ctx.window.AudioPlayback.buildSchedule(CHART);
  const downbeats = Array.from(S.strikes)
    .filter((s) => s.vel === 1)
    .map((s) => +s.t.toFixed(4));
  // bars at 100, 100, 120, 90.5 BPM: 2.4 s, 2.4 s, 2.0 s, then bar 4
  assert.deepEqual(downbeats, [0, 2.4, 4.8, 6.8]);
  assert.ok(Math.abs(S.duration - (2.4 + 2.4 + 2 + 240 / 90.5)) < 1e-9);
  const plain = ctx.window.AudioPlayback.buildSchedule(CHART.replace(/^Tempo Map:.*\n/m, ''));
  assert.deepEqual(
    Array.from(plain.strikes)
      .filter((s) => s.vel === 1)
      .map((s) => +s.t.toFixed(4)),
    [0, 2.4, 4.8, 7.2]
  );
});

test('MusicXML export writes a <sound tempo> where the map changes', () => {
  const ctx = loadStack();
  const xml = ctx.hrBuildMusicXml(CHART);
  const tempos = [...xml.matchAll(/<sound tempo="([\d.]+)"\/>/g)].map((m) => +m[1]);
  assert.deepEqual(tempos, [100, 120, 90.5]);
  assert.match(xml, /<measure number="3">[\s\S]*?<sound tempo="120"\/>/);
  const plain = ctx.hrBuildMusicXml(CHART.replace(/^Tempo Map:.*\n/m, ''));
  assert.deepEqual(
    [...plain.matchAll(/<sound tempo="([\d.]+)"\/>/g)].map((m) => +m[1]),
    [100]
  );
});

test('parts[] handoff: normalised, titled, upserted into the library without mutating it', () => {
  const ctx = loadStack();
  const H = ctx.window.HandoffParts;
  const env = {
    v: 1,
    title: 'Song',
    formats: { csmpn: 'Title: Song — Band\n| C |' },
    parts: [
      { name: 'Band', role: 'band', formats: { csmpn: 'Title: Song — Band\n| C |' } },
      { name: 'Bass', role: 'bass', formats: { csmpn: '| C |' } },
      { name: 'Empty', formats: { csmpn: '  ' } },
      { name: 'Junk' },
    ],
  };
  const parts = Array.from(H.normalizeParts(env));
  assert.deepEqual(
    parts.map((p) => [p.name, p.title]),
    [
      ['Band', 'Song — Band'],
      ['Bass', 'Song — Bass'],
    ]
  );
  const lib = [
    { title: 'Song — Bass', content: 'old', savedAt: 'x' },
    { title: 'Other', content: 'keep', savedAt: 'y' },
  ];
  const { library, titles } = H.mergePartsIntoLibrary(lib, parts, '2026-10-25T00:00:00.000Z');
  assert.equal(lib[0].content, 'old', 'the input library is not mutated');
  assert.deepEqual(
    Array.from(library, (e) => e.title),
    ['Song — Bass', 'Other', 'Song — Band']
  );
  assert.equal(library[0].content, '| C |');
  assert.deepEqual(Array.from(titles), ['Song — Band', 'Song — Bass']);
  assert.deepEqual(Array.from(H.normalizeParts({ v: 1 })), []);
  const many = {
    parts: Array.from({ length: 30 }, (_, i) => ({ name: 'P' + i, formats: { csmpn: '| C |' } })),
  };
  assert.equal(H.normalizeParts(many).length, H.MAX_PARTS);
});

test('the receiver files parts only after the primary chart loaded, and ships the module', () => {
  const html = read('index.html');
  assert.match(html, /<script src="handoffParts\.js"><\/script>/);
  assert.match(html, /if \(loaded && window\.HandoffParts && Array\.isArray\(env\.parts\)/);
  assert.match(html, /mergePartsIntoLibrary\(getSongLibrary\(\), parts\)/);
  assert.match(read('sw.js'), /'\.\/handoffParts\.js'/);
  assert.match(read('.github/workflows/ci.yml'), /handoffParts\.js/);
});

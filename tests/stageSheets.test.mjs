/*
 * stageSheets.test.mjs — lyrics-only running order for a setlist.
 *
 * The extraction itself belongs to lyricsView.js and is tested there, so these
 * tests load the REAL lyricsView into the same context rather than stubbing it —
 * what matters is that the two modules agree, and a stub would hide a drift
 * between them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function load() {
  const ctx = { window: {}, module: { exports: {} }, console };
  vm.createContext(ctx);
  for (const f of ['lyricsView.js', 'stageSheets.js']) {
    vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx);
  }
  return { stage: ctx.window.StageSheets, lyrics: ctx.window.LyricsView };
}

const { stage, lyrics } = load();

const SONG = [
  'Title: Blue Sky',
  'Key: E',
  'Tempo: 120',
  'Capo: 2',
  '',
  '- Verse',
  'E | A |',
  '; You are my blue sky',
  '; You are my sunny day',
].join('\n');

// ── The metadata line ────────────────────────────────────────────────────────

test('stageMetaLine carries only what a player checks before counting in', () => {
  assert.equal(stage.stageMetaLine(SONG), 'Key: E  ·  120 BPM  ·  Capo 2');
});

test('stageMetaLine omits fields that are absent, and a capo of zero', () => {
  assert.equal(stage.stageMetaLine('Title: X\nKey: Bb\n\n- A\nBb |'), 'Key: Bb');
  assert.equal(stage.stageMetaLine('Title: X\nCapo: 0\n\n- A\nC |'), '');
  assert.equal(stage.stageMetaLine(''), '', 'no header is not an error');
  assert.equal(stage.stageMetaLine(null), '');
});

test('stageMetaLine reads the header only, not a colon further down the chart', () => {
  // Bar lines and {hybrid} blocks contain colons; only the leading run of
  // Field: value lines is header.
  const text = 'Title: X\nKey: G\n\n- Verse\nG | C |\n{hybrid\n  bar1: 1:q(G)\n}\nTempo: 999';
  assert.equal(stage.stageMetaLine(text), 'Key: G', 'the trailing Tempo: is not header');
});

// ── Building the running order ───────────────────────────────────────────────

test('a setlist becomes songs with their lyrics and metadata', () => {
  const built = stage.buildSetlistStageSongs([{ title: 'Blue Sky', source: SONG }], lyrics);
  assert.equal(built.songs.length, 1);
  assert.equal(built.songs[0].title, 'Blue Sky');
  assert.equal(built.songs[0].meta, 'Key: E  ·  120 BPM  ·  Capo 2');
  const lines = built.songs[0].sections.flatMap((s) => s.lines).filter(Boolean);
  assert.ok(
    lines.some((l) => l.includes('blue sky')),
    'the words came through'
  );
  assert.ok(!lines.some((l) => l.includes('|')), 'the chart did not');
});

test('an instrumental is skipped and named, not printed as a blank page', () => {
  const built = stage.buildSetlistStageSongs(
    [
      { title: 'Instrumental', source: 'Title: Jam\nKey: A\n\n- Head\nA | D | E | A |' },
      { title: 'Blue Sky', source: SONG },
    ],
    lyrics
  );
  assert.equal(built.songs.length, 1, 'only the song with words survives');
  assert.equal(built.songs[0].title, 'Blue Sky');
  assert.deepEqual(Array.from(built.skipped), ['Instrumental'], 'and the caller can say so');
});

test('an empty setlist and an unusable lyricsView are both handled, not thrown', () => {
  assert.equal(stage.buildSetlistStageSongs([], lyrics).songs.length, 0);
  assert.equal(stage.buildSetlistStageSongs(null, lyrics).songs.length, 0);
  // The parameter is an override; passing nothing falls back to window.LyricsView.
  assert.equal(stage.buildSetlistStageSongs([{ source: SONG }]).songs.length, 1);
  // A LyricsView that has not finished loading yields nothing rather than throwing.
  assert.equal(stage.buildSetlistStageSongs([{ source: SONG }], {}).songs.length, 0);
});

// ── The page ─────────────────────────────────────────────────────────────────

test('the page carries every song, its metadata, and one auto-scroll for the set', () => {
  const built = stage.buildSetlistStageSongs(
    [
      { title: 'Blue Sky', source: SONG },
      { title: 'Second Song', source: 'Title: Second\nKey: C\n\n- V\nC |\n; a second lyric' },
    ],
    lyrics
  );
  const html = stage.buildSetlistStageHtml(built.songs, { title: 'Friday Set' });
  assert.match(html, /<title>Friday Set<\/title>/);
  assert.match(html, /Blue Sky/);
  assert.match(html, /Second Song/);
  assert.ok(html.includes('Key: E  \u00b7  120 BPM'), 'the metadata line is on the page');
  assert.equal((html.match(/Auto-scroll/g) || []).length, 2, 'one control, and its reset label');
  assert.match(html, /requestAnimationFrame/, 'the scroll is real');
});

test('songs after the first break to a new page in print, and the last does not trail one', () => {
  const songs = [
    { title: 'One', meta: '', sections: [{ header: '', lines: ['a'] }] },
    { title: 'Two', meta: '', sections: [{ header: '', lines: ['b'] }] },
  ];
  const html = stage.buildSetlistStageHtml(songs);
  assert.equal((html.match(/data-break="1"/g) || []).length, 1, 'only the second song breaks');
  assert.match(html, /break-before:\s*page/, 'break-before, so no blank trailing page');
});

test('print flips to black on white — a stage sheet is read on a stand and on paper', () => {
  const html = stage.buildSetlistStageHtml([
    { title: 'X', meta: '', sections: [{ header: '', lines: ['a'] }] },
  ]);
  const print = html.slice(html.indexOf('@media print'));
  assert.match(print, /background:#fff/);
  assert.match(print, /color:#000/);
  assert.match(print, /#bar\{display:none/, 'the controls do not print');
});

test('titles and lyrics are escaped — a setlist is user text in a generated document', () => {
  const html = stage.buildSetlistStageHtml([
    {
      title: '<script>alert(1)</script>',
      meta: 'Key: C & D',
      sections: [{ header: '"Verse"', lines: ["it's <b>bold</b>"] }],
    },
  ]);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no injected script tag');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Key: C &amp; D/);
  assert.match(html, /&quot;Verse&quot;/);
  assert.match(html, /it&#39;s &lt;b&gt;bold&lt;\/b&gt;/);
});

test('stageSheets ships — it is in the deploy copy list', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\\\n/g, ' ');
  assert.ok(/cp [^\n]*\bstageSheets\.js\b/s.test(ci), 'stageSheets.js in the cp step');
});

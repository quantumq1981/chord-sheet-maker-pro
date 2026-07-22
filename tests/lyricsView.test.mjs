import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

function loadLV() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('lyricsView.js'), ctx);
  return ctx.window.LyricsView;
}

// Rebuild cross-realm arrays so deepStrictEqual works.
const rsheet = (s) => ({
  title: s.title,
  sections: Array.from(s.sections, (sec) => ({
    header: sec.header,
    lines: Array.from(sec.lines),
  })),
});

// ── detectLyricsFormat ────────────────────────────────────────────────────

test('detectLyricsFormat: CSMPN with Title: header', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('Title: My Song\n| C | Am |'), 'csmpn');
});

test('detectLyricsFormat: CSMPN with ; lyric lines', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('; Hello world\n| C | G |'), 'csmpn');
});

test('detectLyricsFormat: CSMPN with bar lines only', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('| C | Am |\n| F | G |'), 'csmpn');
});

test('detectLyricsFormat: ChordPro with directive', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('{title: Test}\n[Am]Hello'), 'chordpro');
});

test('detectLyricsFormat: ChordPro with inline brackets', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('[Am]Hello [G]world'), 'chordpro');
});

test('detectLyricsFormat: plain text fallback', () => {
  const LV = loadLV();
  assert.equal(LV.detectLyricsFormat('Just some lyrics\nAnother line'), 'plain');
});

// ── stripInlineChords ─────────────────────────────────────────────────────

test('stripInlineChords removes [chord] brackets and collapses spaces', () => {
  const LV = loadLV();
  assert.equal(LV.stripInlineChords('[Am]Hello [G]world'), 'Hello world');
  assert.equal(LV.stripInlineChords('[Dm7]  Sing  [Bb]along'), 'Sing along');
});

test('stripInlineChords returns empty for chord-only bracket line', () => {
  const LV = loadLV();
  assert.equal(LV.stripInlineChords('[Am] [G] [F] [C]'), '');
});

// ── isChordOnlyLine ───────────────────────────────────────────────────────

test('isChordOnlyLine detects chord-only lines', () => {
  const LV = loadLV();
  assert.equal(LV.isChordOnlyLine('Am  G  F  C'), true);
  assert.equal(LV.isChordOnlyLine('Dm7  Bb  C7'), true);
});

test('isChordOnlyLine rejects lyric lines', () => {
  const LV = loadLV();
  assert.equal(LV.isChordOnlyLine('Hello there world'), false);
  assert.equal(LV.isChordOnlyLine(''), false);
});

// ── extractLyricsFromCsmpn ────────────────────────────────────────────────

test('extractLyricsFromCsmpn extracts ; lyric lines and section markers', () => {
  const LV = loadLV();
  const csmpn = [
    'Title: My Song',
    '- Verse 1',
    '| C | Am | F | G |',
    '; Amazing grace how sweet the sound',
    '; That saved a wretch like me',
    '- Chorus',
    '| F | G | C | Am |',
    '; I once was lost but now am found',
  ].join('\n');
  const sheet = rsheet(LV.extractLyricsFromCsmpn(csmpn));
  assert.equal(sheet.title, 'My Song');
  assert.equal(sheet.sections.length, 2);
  assert.equal(sheet.sections[0].header, 'Verse 1');
  assert.deepEqual(sheet.sections[0].lines, [
    'Amazing grace how sweet the sound',
    'That saved a wretch like me',
  ]);
  assert.equal(sheet.sections[1].header, 'Chorus');
  assert.deepEqual(sheet.sections[1].lines, ['I once was lost but now am found']);
});

test('extractLyricsFromCsmpn skips {tab} and {hybrid} blocks', () => {
  const LV = loadLV();
  const csmpn = [
    'Title: Test',
    '- Verse',
    '; First line',
    '{tab',
    '  G: 3,2,0,0,0,3',
    '}',
    '; Second line',
    '{hybrid',
    '  b1: 1:q(G)',
    '}',
    '; Third line',
  ].join('\n');
  const sheet = rsheet(LV.extractLyricsFromCsmpn(csmpn));
  assert.deepEqual(sheet.sections[0].lines, ['First line', 'Second line', 'Third line']);
});

test('extractLyricsFromCsmpn skips # comments and // diagram defs', () => {
  const LV = loadLV();
  const csmpn = ['Title: Test', '# This is a comment', '// C7 x32310', '; Lyrics here'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromCsmpn(csmpn));
  assert.deepEqual(sheet.sections[0].lines, ['Lyrics here']);
});

test('extractLyricsFromCsmpn drops sections with no lyrics', () => {
  const LV = loadLV();
  const csmpn = ['Title: Test', '- Intro', '| C | Am |', '- Verse', '; Hello world'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromCsmpn(csmpn));
  assert.equal(sheet.sections.length, 1);
  assert.equal(sheet.sections[0].header, 'Verse');
});

test('extractLyricsFromCsmpn handles == double section markers', () => {
  const LV = loadLV();
  const csmpn = ['== 1st Ending', '; First time', '== 2nd Ending', '; Second time'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromCsmpn(csmpn));
  assert.equal(sheet.sections.length, 2);
  assert.equal(sheet.sections[0].header, '1st Ending');
  assert.equal(sheet.sections[1].header, '2nd Ending');
});

// ── extractLyricsFromChordPro ─────────────────────────────────────────────

test('extractLyricsFromChordPro strips chord brackets from lyrics', () => {
  const LV = loadLV();
  const cp = [
    '{title: Amazing Grace}',
    '{sov: Verse 1}',
    '[G]Amazing [G7]grace how [C]sweet the [G]sound',
    '[G]That saved a [Em]wretch like [D]me',
  ].join('\n');
  const sheet = rsheet(LV.extractLyricsFromChordPro(cp));
  assert.equal(sheet.title, 'Amazing Grace');
  assert.equal(sheet.sections[0].header, 'Verse 1');
  assert.equal(sheet.sections[0].lines[0], 'Amazing grace how sweet the sound');
  assert.equal(sheet.sections[0].lines[1], 'That saved a wretch like me');
});

test('extractLyricsFromChordPro drops chord-only lines', () => {
  const LV = loadLV();
  const cp = ['{title: Test}', 'Am  G  F  C', 'Hello there my friend'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromChordPro(cp));
  assert.equal(sheet.sections[0].lines.length, 1);
  assert.equal(sheet.sections[0].lines[0], 'Hello there my friend');
});

test('extractLyricsFromChordPro skips {sot}…{eot} tab blocks', () => {
  const LV = loadLV();
  const cp = [
    '{title: Test}',
    '{sot}',
    'e|---0---',
    'B|---1---',
    '{eot}',
    '[Am]Lyrics after tab',
  ].join('\n');
  const sheet = rsheet(LV.extractLyricsFromChordPro(cp));
  assert.equal(sheet.sections[0].lines.length, 1);
  assert.equal(sheet.sections[0].lines[0], 'Lyrics after tab');
});

test('extractLyricsFromChordPro handles {c:} comment directives', () => {
  const LV = loadLV();
  const cp = ['{title: Test}', '{c: Repeat 2x}', '[Am]Singing along'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromChordPro(cp));
  assert.equal(sheet.sections[0].header, 'Repeat 2x');
  assert.equal(sheet.sections[0].lines[0], 'Singing along');
});

// ── extractLyricsFromPlain ────────────────────────────────────────────────

test('extractLyricsFromPlain drops standalone chord-only lines', () => {
  const LV = loadLV();
  const text = [
    'My Song Title',
    '[Verse 1]',
    'Am  G  F  C',
    'Hello there my friend',
    'Dm  Bb  C',
    'Singing all day long',
  ].join('\n');
  const sheet = rsheet(LV.extractLyricsFromPlain(text));
  assert.equal(sheet.title, 'My Song Title');
  assert.equal(sheet.sections[0].header, 'Verse 1');
  assert.deepEqual(sheet.sections[0].lines, ['Hello there my friend', 'Singing all day long']);
});

test('extractLyricsFromPlain handles [Section] UG headers', () => {
  const LV = loadLV();
  const text = ['[Intro]', 'Am  G', '[Verse]', 'Lyrics here', '[Chorus]', 'More lyrics'].join('\n');
  const sheet = rsheet(LV.extractLyricsFromPlain(text));
  assert.ok(sheet.sections.some((s) => s.header === 'Verse'));
  assert.ok(sheet.sections.some((s) => s.header === 'Chorus'));
});

// ── extractLyrics (top-level dispatcher) ──────────────────────────────────

test('extractLyrics auto-detects CSMPN and dispatches', () => {
  const LV = loadLV();
  const csmpn = 'Title: Test\n- Verse\n; Hello world';
  const sheet = rsheet(LV.extractLyrics(csmpn));
  assert.equal(sheet.title, 'Test');
  assert.equal(sheet.sections[0].lines[0], 'Hello world');
});

test('extractLyrics auto-detects ChordPro and dispatches', () => {
  const LV = loadLV();
  const cp = '{title: Test}\n[Am]Hello [G]world';
  const sheet = rsheet(LV.extractLyrics(cp));
  assert.equal(sheet.title, 'Test');
  assert.equal(sheet.sections[0].lines[0], 'Hello world');
});

test('extractLyrics accepts explicit format override', () => {
  const LV = loadLV();
  const text = '[Am]Hello [G]world';
  const sheet = rsheet(LV.extractLyrics(text, 'chordpro'));
  assert.equal(sheet.sections[0].lines[0], 'Hello world');
});

// ── sheetHasLyrics ────────────────────────────────────────────────────────

test('sheetHasLyrics returns true for sheets with lyric lines', () => {
  const LV = loadLV();
  const sheet = { sections: [{ header: 'V', lines: ['Hello'] }] };
  assert.equal(LV.sheetHasLyrics(sheet), true);
});

test('sheetHasLyrics returns false for empty/null sheets', () => {
  const LV = loadLV();
  assert.equal(LV.sheetHasLyrics(null), false);
  assert.equal(LV.sheetHasLyrics({ sections: [] }), false);
  assert.equal(LV.sheetHasLyrics({ sections: [{ header: '', lines: [] }] }), false);
});

// ── buildLyricsHtml ───────────────────────────────────────────────────────

test('buildLyricsHtml produces HTML with section headers and lyrics', () => {
  const LV = loadLV();
  const sheet = {
    title: 'Test Song',
    sections: [
      { header: 'Verse', lines: ['Hello world', 'Goodbye moon'] },
      { header: 'Chorus', lines: ['Sing along'] },
    ],
  };
  const html = LV.buildLyricsHtml(sheet);
  assert.ok(html.includes('Test Song'), 'contains title');
  assert.ok(html.includes('Verse'), 'contains section header');
  assert.ok(html.includes('Hello world'), 'contains lyrics');
  assert.ok(html.includes('Chorus'), 'contains second header');
  assert.ok(html.includes('Sing along'), 'contains second section lyrics');
});

test('buildLyricsHtml includes auto-scroll script', () => {
  const LV = loadLV();
  const sheet = { title: 'T', sections: [{ header: '', lines: ['Hi'] }] };
  const html = LV.buildLyricsHtml(sheet);
  assert.ok(html.includes('Auto-scroll'), 'has scroll control');
});

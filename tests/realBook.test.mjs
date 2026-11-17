/*
 * realBook.test.mjs — Real Book (iGigBook) chart style.
 *
 *   - REAL_BOOK_PRESET / applyPreset: the Fake Book Settings the preset writes
 *   - toRealBookCSMPN: lyric/divider removal, boxed markers, repeat + ending
 *     folding, 4 bars per line, sections that must stay as written
 *   - buildFitLevels / chooseFitLevel / printableHeightPx: one-page print fit
 *   - renderDoc in Real Book style: header, rehearsal letters, opening time sig
 *
 * The transform is driven through the real tokenizeBars / parseBarStructures and
 * its output is re-parsed with the real parser, so a fold that renders or plays
 * differently from the source fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');

function load(fb = {}) {
  const ctx = {
    document: { querySelector: () => null, createElement: () => ({ style: {} }), body: {} },
    console,
    validationWarnings: [],
    notationPreference: 'sharp',
    setStatus() {},
    fbSettings: {
      fontSize: 'M',
      barsPerRow: 4,
      lineSpacing: 8,
      barLines: 'visible',
      chordAlign: 'left',
      maj7Style: 'triangle',
      minorStyle: 'minus',
      dimStyle: 'degree',
      halfDimStyle: 'slashed',
      footer: 'hidden',
      includeLyrics: false,
      chartStyle: 'standard',
      ...fb,
    },
  };
  // In the browser `window` IS the global: realBook.js reads tokenizeBars and
  // parseBarStructures off it.
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of [
    'utils.js',
    'chordProcessing.js',
    'csmpnParser.js',
    'realBook.js',
    'renderer.js',
  ]) {
    vm.runInContext(read(f), ctx);
  }
  return ctx;
}

const ctx = load();
const RB = ctx.RealBook;
const plainBars = (csmpn) => {
  const doc = ctx.parseCSMPN(csmpn);
  const tokens = [];
  for (const b of doc.blocks) if (b.type === 'bars') tokens.push(...b.tokens);
  return Array.from(ctx.parseBarStructures(tokens));
};
const barLines = (csmpn) =>
  csmpn.split('\n').filter((l) => l.trim() && !/^[A-Za-z ]+:\s/.test(l) && !/^[-:=]/.test(l));

// ── Preset ───────────────────────────────────────────────────────────────────

test('preset sets the Real Book chord styles, fonts and layout', () => {
  const p = RB.REAL_BOOK_PRESET;
  assert.equal(p.chartStyle, 'realbook');
  assert.equal(p.maj7Style, 'triangle');
  assert.equal(p.minorStyle, 'minus');
  assert.equal(p.dimStyle, 'degree');
  assert.equal(p.halfDimStyle, 'slashed');
  assert.equal(p.chordAlign, 'left');
  assert.equal(p.barsPerRow, 4);
  assert.equal(p.hybridRhythmMode, false);
  assert.equal(p.includeLyrics, false);
  assert.equal(p.printFit, 'onepage');
  assert.equal(p.footer, 'hidden');
  // A handwritten chord font only applies with the default pack: Pori/Norfolk
  // replace the chord font with an engraved serif.
  assert.equal(p.chordFontPack, 'default');
  assert.equal(p.bodyFont, 'kalam');
});

test('applyPreset writes only keys the settings object has, and does not mutate it', () => {
  const settings = { fontSize: 'S', maj7Style: 'ma', custom: 1 };
  const out = RB.applyPreset(settings);
  assert.deepEqual(settings, { fontSize: 'S', maj7Style: 'ma', custom: 1 });
  assert.equal(out.fontSize, 'M');
  assert.equal(out.maj7Style, 'triangle');
  assert.equal(out.custom, 1);
  assert.ok(!('chartStyle' in out), 'unknown preset key must not be added');
});

test('every preset key exists in settings.js fbSettings', () => {
  const src = read('settings.js');
  const block = src.slice(
    src.indexOf('const fbSettings = {'),
    src.indexOf('};', src.indexOf('const fbSettings = {'))
  );
  for (const k of Object.keys(RB.REAL_BOOK_PRESET)) {
    assert.ok(new RegExp('\\b' + k + ':').test(block), `fbSettings is missing "${k}"`);
  }
});

// ── Transform ────────────────────────────────────────────────────────────────

test('removes lyric and divider lines, keeps the header, boxes section markers', () => {
  const src = 'Title: Song\nKey: C\n\n- Verse\nC F G C\n; la la la\n-----\n: Chorus\nF G C C\n';
  const { csmpn, stats } = RB.toRealBookCSMPN(src);
  assert.ok(csmpn.startsWith('Title: Song\nKey: C\n'));
  assert.ok(!/la la la/.test(csmpn));
  assert.ok(!/-----/.test(csmpn));
  assert.ok(csmpn.includes('= Verse') && csmpn.includes('= Chorus'));
  assert.equal(stats.lyricLinesRemoved, 1);
  assert.equal(stats.dividersRemoved, 1);
});

test('lays a plain section out 4 bars per line', () => {
  const { csmpn } = RB.toRealBookCSMPN('- A\nC F\nG C Am\nDm7 G7 C\n');
  assert.deepEqual(barLines(csmpn), ['C F G C', 'Am Dm7 G7 C']);
});

test('a section whose halves are identical folds into |: … :|', () => {
  const src = '- Verse\n| C | F | G | C |\n| C | F | G | C |\n';
  const { csmpn, stats } = RB.toRealBookCSMPN(src);
  assert.deepEqual(barLines(csmpn), ['|: C F G C :|']);
  assert.equal(stats.sectionsFolded, 1);
  const bars = plainBars(csmpn);
  assert.equal(bars.length, 4);
  assert.equal(bars[0].leftBar, 'repeat-start');
  assert.equal(bars[3].rightBar, 'repeat-end');
});

test('halves that differ only at the end fold into 1st/2nd endings', () => {
  const src = '= A\nDm7 G7 Cmaj7 Cmaj7\nDm7 G7 Em7 A7\nDm7 G7 Cmaj7 Cmaj7\nDm7 G7 Cmaj7 %\n';
  const { csmpn, stats } = RB.toRealBookCSMPN(src);
  assert.deepEqual(barLines(csmpn), [
    '|: Dm7 G7 Cmaj7 Cmaj7',
    'Dm7 G7 1. Em7 A7 :|',
    '2. Cmaj7 % |',
  ]);
  assert.equal(stats.endings, 1);
  const bars = plainBars(csmpn);
  assert.equal(bars.length, 10);
  assert.equal(bars[6].endingLabel, '1.');
  assert.equal(bars[7].rightBar, 'repeat-end');
  assert.equal(bars[8].endingLabel, '2.');
});

test('a 2nd ending that starts with % keeps the chord it meant', () => {
  // Second half "Dm7 G7 % E7": its % repeats G7. Once folded, the 2nd ending no
  // longer follows G7 on the page, so it must spell G7 out.
  const fold = RB.foldRepeats(['Dm7', 'G7', 'C', 'A7', 'Dm7', 'G7', '%', 'E7']);
  assert.deepEqual(Array.from(fold.body), ['Dm7', 'G7']);
  assert.deepEqual(Array.from(fold.end1), ['C', 'A7']);
  assert.deepEqual(Array.from(fold.end2), ['G7', 'E7']);
  const { csmpn } = RB.toRealBookCSMPN('- A\nDm7 G7 C A7\nDm7 G7 % E7\n');
  assert.deepEqual(barLines(csmpn), ['|: Dm7 G7 1. C A7 :|', '2. G7 E7 |']);
});

test('a % compared by the chord it repeats still folds', () => {
  const f = RB.foldRepeats(['F', 'G', 'C', 'C', 'F', 'G', 'C', '%']);
  assert.deepEqual(Array.from(f.body), ['F', 'G', 'C', 'C']);
  assert.equal(f.end1.length, 0);
});

test('does not fold when the shared part is shorter than the endings', () => {
  assert.equal(RB.foldRepeats(['C', 'F', 'G', 'A', 'C', 'Bb', 'D', 'E']), null);
  assert.equal(RB.foldRepeats(['C', 'F', 'G']), null);
});

test('a closing |] or || survives the layout', () => {
  const { csmpn } = RB.toRealBookCSMPN('- A\nC F G C |]\n');
  assert.deepEqual(barLines(csmpn), ['C F G C |]']);
  assert.equal(plainBars(csmpn)[3].rightBar, 'final');
});

test('(A B)x2 becomes |: A B :| when it is the whole section', () => {
  const { csmpn } = RB.toRealBookCSMPN('- Vamp\n(Am7 D7)x2\n');
  assert.deepEqual(barLines(csmpn), ['|: Am7 D7 :|']);
});

test('sections with structure, tab/hybrid blocks or repeat groups are kept as written', () => {
  const src = [
    '- A',
    '|: C F :| G C',
    '- B',
    'Fm7 Bb7 (Am7 D7)x3',
    '- C',
    'G D Em C',
    '{hybrid',
    'b1: 1:q(G) 2:q 3:q 4:q',
    '}',
  ].join('\n');
  const { csmpn, stats } = RB.toRealBookCSMPN(src);
  assert.ok(csmpn.includes('|: C F :| G C'));
  assert.ok(csmpn.includes('Fm7 Bb7 (Am7 D7)x3'));
  assert.ok(csmpn.includes('{hybrid\nb1: 1:q(G) 2:q 3:q 4:q\n}'));
  assert.equal(stats.sectionsKept, 3);
  assert.equal(stats.sectionsFolded, 0);
});

test('three-column marker text and chord-diagram definitions are preserved', () => {
  const src = '- lc Intro cc  rc Fine\nC F G C\n// C7 x32310\n';
  const { csmpn } = RB.toRealBookCSMPN(src);
  assert.ok(csmpn.includes('- lc Intro cc  rc Fine'));
  assert.ok(csmpn.startsWith('// C7 x32310'));
});

test('lyric stripping can be turned off', () => {
  const { csmpn, stats } = RB.toRealBookCSMPN('- A\nC F G C\n; words\n', { stripLyrics: false });
  assert.ok(csmpn.includes('; words'));
  assert.equal(stats.lyricLinesRemoved, 0);
});

test('output parses cleanly and keeps every bar of an unfolded chart', () => {
  const src = 'Title: T\nTime: 4/4\n- A\nC Am F G\nDm G7 C C\nE7\n- B\nE7 Am D7 G7\n';
  const before = plainBars(src).map((b) => b.token);
  const { csmpn } = RB.toRealBookCSMPN(src);
  const after = plainBars(csmpn).map((b) => b.token);
  assert.deepEqual(after, before);
});

// ── One-page fit ─────────────────────────────────────────────────────────────

test('fit levels step down from the user setting and never grow', () => {
  const levels = Array.from(RB.buildFitLevels('M', 12)).map((l) => l.fontSize + l.lineSpacing);
  assert.deepEqual(levels, ['M12', 'M8', 'M4', 'S4', 'S2', 'XS2', 'XS0']);
  const small = Array.from(RB.buildFitLevels('S', 0)).map((l) => l.fontSize + l.lineSpacing);
  assert.deepEqual(small, ['S0', 'XS0']);
});

test('chooseFitLevel picks the largest level that fits, else the smallest', () => {
  const levels = RB.buildFitLevels('M', 8);
  const heights = { M8: 1200, M4: 1100, S4: 950, S2: 900, XS2: 800, XS0: 760 };
  const measure = (l) => heights[l.fontSize + l.lineSpacing];
  const fit = RB.chooseFitLevel(levels, measure, 960);
  assert.equal(fit.fits, true);
  assert.equal(fit.level.fontSize + fit.level.lineSpacing, 'S4');
  const none = RB.chooseFitLevel(levels, measure, 500);
  assert.equal(none.fits, false);
  assert.equal(none.level.fontSize + none.level.lineSpacing, 'XS0');
});

test('printable height follows orientation (US Letter, 0.5in margins)', () => {
  assert.equal(RB.printableHeightPx('portrait'), Math.floor(10 * 96 * 0.97));
  assert.equal(RB.printableHeightPx('landscape'), Math.floor(7.5 * 96 * 0.97));
  assert.equal(RB.printableWidthPx('portrait'), 720);
});

// ── Rendering ────────────────────────────────────────────────────────────────

const CHART =
  'Title: Cherokee\nComposer: Ray Noble\nStyle: Up Tempo Swing\nKey: Bb\nTime: 4/4\n= A\nBb6 % Fm7 Bb7\n= Bridge\nC#m7 F#7 Bmaj7 %\n';

test('Real Book header: composer left, title centre, style right, no key line', () => {
  const rb = load({ chartStyle: 'realbook' });
  const html = rb.renderDoc(rb.parseCSMPN(CHART));
  assert.match(html, /class="sheetHeader rbHeader"/);
  assert.match(html, /class="rbComposer">Ray Noble</);
  assert.match(html, /class="songTitle">Cherokee</);
  assert.match(html, /class="rbStyle">Up Tempo Swing</);
  assert.ok(!html.includes('Key of'));
});

test('Real Book: time signature drawn once, at the first bar row', () => {
  const rb = load({ chartStyle: 'realbook' });
  const html = rb.renderDoc(rb.parseCSMPN(CHART));
  assert.equal((html.match(/class="rbTimeSig"/g) || []).length, 1);
  assert.ok(html.indexOf('rbTimeSig') > html.indexOf('barsBlock'));
});

test('a single-letter section label is the rehearsal letter, not a duplicate box', () => {
  for (const style of ['standard', 'realbook']) {
    const r = load({ chartStyle: style });
    const html = r.renderDoc(r.parseCSMPN(CHART));
    assert.match(html, /class="rehearsalLetter">A</, style);
    assert.ok(!/class="labelBox">A</.test(html), `${style}: no second "A" box`);
    // The named section continues the sequence after A.
    assert.match(html, /class="rehearsalLetter">B</, style);
  }
});

test('Real Book: named sections keep their name as small text', () => {
  const rb = load({ chartStyle: 'realbook' });
  const html = rb.renderDoc(rb.parseCSMPN(CHART));
  assert.match(html, /class="rbSectionName">Bridge</);
});

test('standard style output is unchanged: centered header with key + time sig', () => {
  const std = load();
  const html = std.renderDoc(std.parseCSMPN(CHART));
  assert.ok(!html.includes('rbHeader'));
  assert.ok(!html.includes('rbTimeSig'));
  assert.ok(html.includes('Key of Bb'));
  assert.match(html, /class="timeSig"/);
});

test('chord root accidental gets its own span; text content is unchanged', () => {
  const html = ctx.renderChordToken('Bb6');
  assert.match(html, /<span class="chord-root">B<span class="chord-acc">♭<\/span><\/span>/);
  assert.equal(html.replace(/<[^>]+>/g, ''), 'B♭6');
  assert.ok(!ctx.renderChordToken('C7').includes('chord-acc'));
});

test('an ending bracket stops at the last real bar of a padded row', () => {
  const r = load();
  const html = r.renderDoc(r.parseCSMPN('- A\n|: C F 1. G C :|\n2. Dm G7 |]\n'));
  // Row 2 has 2 real bars + 2 padding: columns 2..5 (bars 0..1), not 2..9.
  assert.match(html, /grid-column:2 \/ 5;/);
  assert.ok(!/grid-column:2 \/ 9;/.test(html));
});

test('rows with an ending bracket are marked so bars and bracket get separate grid rows', () => {
  const r = load();
  const html = r.renderDoc(r.parseCSMPN('- A\n|: C F 1. G C :|\n2. Dm G7 |]\nC F G C\n'));
  assert.equal((html.match(/class="barlineRow hasEnding"/g) || []).length, 2);
  assert.equal((html.match(/class="barlineRow"/g) || []).length, 1);
  const css = read('index.html');
  assert.match(
    css,
    /\.barlineRow\.hasEnding > \.barline,\s*\.barlineRow\.hasEnding > \.measure\{\s*grid-row:2;/
  );
  assert.match(css, /\.barline\.single::after\{\s*display:none;/);
});

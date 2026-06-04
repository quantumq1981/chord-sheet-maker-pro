import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads the full render stack (utils → chordProcessing → csmpnParser →
// importPipeline → renderer) into one sandbox so renderHybridDoc() can be
// exercised directly without a DOM. renderHybridDoc only touches the DOM inside
// updatePreview(), not at module top, so this is safe.
function loadRenderer() {
  const root = new URL('..', import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), 'utf8');

  const context = {
    window: {},
    document: {
      querySelector() {
        return null;
      },
      createElement() {
        return { click() {}, setAttribute() {}, style: {} };
      },
      body: { appendChild() {} },
    },
    fbSettings: { fgColor: '#111', bgColor: '#fff', chordColor: '#0044cc', barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'sharp',
    console,
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context);
  vm.runInContext(read('chordProcessing.js'), context);
  vm.runInContext(read('csmpnParser.js'), context);
  vm.runInContext(read('importPipeline.js'), context);
  vm.runInContext(read('renderer.js'), context);
  return context;
}

test('plain chart (no {hybrid}) renders through the unified SVG engine, not fake-book HTML', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Title: Demo\nTime: 4/4\n\n- Verse\n| G | D | Em | C |\n');

  // Hybrid SVG engine output, not the fake-book HTML renderer
  assert.ok(out.includes('<svg'), 'should emit an <svg> element');
  // Even slash noteheads (filled parallelograms) for the zero-rhythm case
  assert.ok(out.includes('<polygon'), 'should draw slash noteheads');
  // Chord labels carried from the source
  assert.ok(out.includes('>G<'), 'should label the G chord');
  assert.ok(out.includes('>Em<'), 'should label the Em chord');
});

test('{hybrid} chart still renders notated rhythm through the same engine', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc(
    '- Verse\n| G | D | Em | C |\n{hybrid\nb1: 1:q(G) 2:e 2&:e 3:q 4:rq\n}'
  );
  assert.ok(out.includes('<svg'), 'should emit an <svg> element');
  assert.ok(out.includes('<polygon'), 'should draw noteheads for rhythm events');
});

test('empty source falls back to the fake-book renderer (no <svg>)', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('');
  assert.equal(typeof out, 'string');
  assert.ok(!out.includes('<svg'), 'empty chart must not produce a slash/rhythm SVG');
});

test('compound and simple charts both produce a single <svg> document', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\nG D Em C\n');
  assert.equal((out.match(/<svg/g) || []).length, 1, 'one SVG document per chart');
  assert.ok(out.includes('>G<'));
});

// A single chord bar in the no-events (zero-rhythm) path draws one filled
// polygon per slash notehead, so counting <polygon> gives the slash count.
const slashCount = (svg) => (svg.match(/<polygon/g) || []).length;

test('4/4 bar draws 4 slashes (regression)', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Time: 4/4\n\n- Verse\n| G |\n');
  assert.equal(slashCount(out), 4);
});

test('12/8 bar collapses to 4 dotted-quarter slashes, not 12', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Time: 12/8\n\n- Verse\n| G |\n');
  assert.equal(slashCount(out), 4, '12/8 should draw 4 slashes (one per dotted quarter)');
});

test('6/8 bar draws 2 slashes; 9/8 draws 3', () => {
  const ctx = loadRenderer();
  const out68 = ctx.renderHybridDoc('Time: 6/8\n\n- Verse\n| G |\n');
  const out98 = ctx.renderHybridDoc('Time: 9/8\n\n- Verse\n| G |\n');
  assert.equal(slashCount(out68), 2);
  assert.equal(slashCount(out98), 3);
});

test('3/4 simple meter still draws 3 slashes (not collapsed)', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Time: 3/4\n\n- Verse\n| G |\n');
  assert.equal(slashCount(out), 3);
});

// ── 16.2b: treble clef + key signature ──────────────────────────────────────
const sharpCount = (svg) => (svg.match(/♯/g) || []).length;
const flatCount = (svg) => (svg.match(/♭/g) || []).length;

test('renders a real treble clef glyph (U+1D11E)', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| G |\n');
  assert.ok(out.includes('&#x1D11E;'), 'should emit the treble clef glyph');
});

test('key of G renders one sharp; key of D renders two', () => {
  const ctx = loadRenderer();
  const g = ctx.renderHybridDoc('Key: G\n\n- Verse\n| G |\n');
  const d = ctx.renderHybridDoc('Key: D\n\n- Verse\n| D |\n');
  assert.equal(sharpCount(g), 1);
  assert.equal(sharpCount(d), 2);
});

test('key of F renders one flat; key of Eb renders three', () => {
  const ctx = loadRenderer();
  const f = ctx.renderHybridDoc('Key: F\n\n- Verse\n| F |\n');
  const eb = ctx.renderHybridDoc('Key: Eb\n\n- Verse\n| Eb |\n');
  assert.equal(flatCount(f), 1);
  assert.equal(flatCount(eb), 3);
});

test('key of C (and no key) renders no accidentals', () => {
  const ctx = loadRenderer();
  const c = ctx.renderHybridDoc('Key: C\n\n- Verse\n| C |\n');
  const none = ctx.renderHybridDoc('- Verse\n| C |\n');
  assert.equal(sharpCount(c) + flatCount(c), 0);
  assert.equal(sharpCount(none) + flatCount(none), 0);
});

test('minor and worded keys normalize (Em -> 1 sharp, "G major" -> 1 sharp)', () => {
  const ctx = loadRenderer();
  const em = ctx.renderHybridDoc('Key: Em\n\n- Verse\n| Em |\n');
  const gmaj = ctx.renderHybridDoc('Key: G major\n\n- Verse\n| G |\n');
  assert.equal(sharpCount(em), 1);
  assert.equal(sharpCount(gmaj), 1);
});

test('key signature appears once per section first row, not on every row', () => {
  const ctx = loadRenderer();
  // 8 bars at barsPerRow 4 = 2 rows, but one section → clef/keysig only on row 1
  const out = ctx.renderHybridDoc('Key: G\n\n- Verse\n| G | D | Em | C | G | D | Em | C |\n');
  assert.equal(sharpCount(out), 1);
});

// ── 16.2c: navigation markers + capo ────────────────────────────────────────
test('standalone nav marker is carried to the previous section and rendered', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| G | D |\n- D.C. al Fine\n');
  assert.ok(out.includes('D.C. al Fine'), 'nav text should render');
  assert.ok(out.includes('text-anchor="end"'), 'nav text is right-aligned');
});

test('nav text in a section label is detected', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Outro Fine\n| G | C |\n');
  assert.ok(out.includes('text-anchor="end"'));
});

test('Coda / Segno words convert to Unicode musical symbols', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| G |\n- To Coda\n');
  assert.ok(out.includes('𝄌'), 'Coda symbol rendered');
});

test('plain chart with no nav marker renders no right-aligned nav text', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| G | D |\n');
  assert.ok(!out.includes('text-anchor="end"'));
});

test('capo metadata renders a Roman-numeral capo marker on the tab lane', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc(
    'Capo: 2\n\n- Verse\n| G |\n{hybrid\nb1: 1:q(G)\ntab1: 3,2,0,0,0,3 @ 1\n}'
  );
  assert.ok(out.includes('cap.II'), 'capo marker should show fret as Roman numeral');
});

test('capo marker is suppressed when the chart has no tab lane', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Capo: 2\n\n- Verse\n| G | D |\n');
  assert.ok(!out.includes('cap.'), 'no capo marker without a tab staff');
});

// ── 16.2c-2: ending brackets + bar-model refactor ───────────────────────────
test('volta chart renders 1st and 2nd ending brackets', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| 1. C | Am | 2. F | G |\n');
  assert.ok(out.includes('>1.</text>'), 'first ending label rendered');
  assert.ok(out.includes('>2.</text>'), 'second ending label rendered');
});

test('volta prefix no longer leaks into the chord label (refactor regression)', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| 1. C | Am |\n');
  assert.ok(out.includes('>C</text>'), 'chord renders as C');
  assert.ok(!out.includes('1. C'), 'volta prefix is not part of the chord text');
});

test('chart without voltas renders no ending brackets', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('- Verse\n| C | Am | F | G |\n');
  assert.ok(!out.includes('>1.</text>'));
  assert.ok(!out.includes('>2.</text>'));
});

// ── 16.2c-3: strum arrows (Fake Book Settings) ──────────────────────────────
const downs = (svg) => (svg.match(/↓/g) || []).length;
const ups = (svg) => (svg.match(/↑/g) || []).length;

test('strum "down" draws one down-arrow per beat (4/4 bar = 4)', () => {
  const ctx = loadRenderer();
  ctx.fbSettings.strumMode = 'down';
  const out = ctx.renderHybridDoc('Time: 4/4\n\n- Verse\n| G |\n');
  assert.equal(downs(out), 4);
  assert.equal(ups(out), 0);
});

test('strum "alt" alternates down/up across beats', () => {
  const ctx = loadRenderer();
  ctx.fbSettings.strumMode = 'alt';
  const out = ctx.renderHybridDoc('Time: 4/4\n\n- Verse\n| G |\n');
  assert.equal(downs(out), 2);
  assert.equal(ups(out), 2);
});

test('custom strum pattern "D U" cycles across beats', () => {
  const ctx = loadRenderer();
  ctx.fbSettings.strumMode = 'custom';
  ctx.fbSettings.strumPattern = 'D U';
  const out = ctx.renderHybridDoc('Time: 4/4\n\n- Verse\n| G |\n');
  assert.equal(downs(out), 2);
  assert.equal(ups(out), 2);
});

test('strum "none" (default) draws no arrows', () => {
  const ctx = loadRenderer();
  const out = ctx.renderHybridDoc('Time: 4/4\n\n- Verse\n| G |\n');
  assert.equal(downs(out) + ups(out), 0);
});

test('strum arrows suppressed on rows that have a tab lane', () => {
  const ctx = loadRenderer();
  ctx.fbSettings.strumMode = 'down';
  const out = ctx.renderHybridDoc('- Verse\n| G |\n{hybrid\nb1: 1:q(G)\ntab1: 3,2,0,0,0,3 @ 1\n}');
  assert.equal(downs(out), 0, 'no strum arrows over a tab lane');
});

// ── 16.2d: MusicXML export from the unified model ───────────────────────────
test('hrBuildMusicXml emits a score-partwise document with title', () => {
  const ctx = loadRenderer();
  const xml = ctx.hrBuildMusicXml('Title: Demo\n\n- Verse\n| C | Am | F | G |\n');
  assert.ok(xml.includes('<score-partwise version="4.0">'));
  assert.ok(xml.includes('<movement-title>Demo</movement-title>'));
  assert.ok(xml.includes('<measure-style><slash type="start" use-stems="no"/></measure-style>'));
});

test('empty chart exports null', () => {
  const ctx = loadRenderer();
  assert.equal(ctx.hrBuildMusicXml(''), null);
});

test('key signature fifths + mode are emitted (G major -> 1, Am -> minor)', () => {
  const ctx = loadRenderer();
  const g = ctx.hrBuildMusicXml('Key: G\n\n- Verse\n| G |\n');
  assert.ok(g.includes('<fifths>1</fifths><mode>major</mode>'));
  const am = ctx.hrBuildMusicXml('Key: Am\n\n- Verse\n| Am |\n');
  assert.ok(am.includes('<fifths>0</fifths><mode>minor</mode>'));
});

test('harmony root, kind, and slash-chord bass are emitted', () => {
  const ctx = loadRenderer();
  const xml = ctx.hrBuildMusicXml('- Verse\n| Am7 | D/F# |\n');
  assert.ok(xml.includes('<root-step>A</root-step>'));
  assert.ok(xml.includes('<kind>minor-seventh</kind>'));
  assert.ok(xml.includes('<bass><bass-step>F</bass-step><bass-alter>1</bass-alter></bass>'));
});

test('one slash notehead note per visual beat (4/4 -> 4, 12/8 -> 4)', () => {
  const ctx = loadRenderer();
  const four = ctx.hrBuildMusicXml('Time: 4/4\n\n- Verse\n| C |\n');
  assert.equal((four.match(/<notehead>slash<\/notehead>/g) || []).length, 4);
  const twelve = ctx.hrBuildMusicXml('Time: 12/8\n\n- Verse\n| C |\n');
  assert.equal((twelve.match(/<notehead>slash<\/notehead>/g) || []).length, 4);
});

test('repeat barlines and volta endings round-trip into MusicXML', () => {
  const ctx = loadRenderer();
  const xml = ctx.hrBuildMusicXml('- Verse\n|: 1. C | Am :| 2. F | G |\n');
  assert.ok(xml.includes('<repeat direction="forward"/>'), 'repeat start');
  assert.ok(xml.includes('<repeat direction="backward"/>'), 'repeat end');
  assert.ok(xml.includes('<ending number="1" type="start"/>'));
  assert.ok(xml.includes('<ending number="2" type="start"/>'));
});

test('section markers become rehearsal marks (= square, - none); nav suppressed', () => {
  const ctx = loadRenderer();
  const xml = ctx.hrBuildMusicXml('= Intro\n| C |\n- Verse\n| G |\n- D.C. al Fine\n');
  assert.ok(xml.includes('<rehearsal enclosure="square" default-y="40">Intro</rehearsal>'));
  assert.ok(xml.includes('<rehearsal enclosure="none" default-y="40">Verse</rehearsal>'));
  assert.ok(!xml.includes('D.C. al Fine'), 'nav marker is not a rehearsal mark');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// Load performanceLyrics.js the same way the browser does — as a classic script
// that publishes window.PerformanceLyrics. The runtime (openPerformanceLyrics)
// is browser-only and never invoked here; only the pure API is exercised.
function loadPL() {
  const ctx = { window: {}, console, module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(read('performanceLyrics.js'), ctx);
  return ctx.window.PerformanceLyrics;
}

const fixture = (name) => read(`tests/fixtures/perf-lyrics/${name}`);
const labels = (m) => Array.from(m.sections, (s) => s.label);

// ── normalization ────────────────────────────────────────────────────────────

test('normalizeText: CRLF and stray CR become LF', () => {
  const PL = loadPL();
  const out = PL.normalizeText('a\r\nb\rc');
  assert.deepEqual(Array.from(out), ['a', 'b', 'c']);
});

test('normalizeText: strips zero-width characters', () => {
  const PL = loadPL();
  const out = PL.normalizeText('he​llo‍');
  assert.equal(out[0], 'hello');
});

test('normalizeText: decodes common HTML entities', () => {
  const PL = loadPL();
  const out = PL.normalizeText('Rock &amp; Roll &#39;n&#39; soul &quot;live&quot;');
  assert.equal(out[0], 'Rock & Roll \'n\' soul "live"');
});

test('normalizeText: trims trailing whitespace per line', () => {
  const PL = loadPL();
  const out = PL.normalizeText('hello   \nworld\t');
  assert.deepEqual(Array.from(out), ['hello', 'world']);
});

// ── chord detection / stripping ──────────────────────────────────────────────

test('isChordOnlyLine: a chord-above line is detected', () => {
  const PL = loadPL();
  assert.equal(PL.isChordOnlyLine('C          G        Am       F'), true);
  assert.equal(PL.isChordOnlyLine('Bb7  Ebmaj7  C#m7/E  N.C.'), true);
});

test('isChordOnlyLine: a lyric line is NOT a chord line', () => {
  const PL = loadPL();
  assert.equal(PL.isChordOnlyLine('Hello there my old friend'), false);
  // A line that is mostly words with one chord-like token stays lyrics.
  assert.equal(PL.isChordOnlyLine('Am I the only one who feels this way'), false);
});

test('isChordOnlyLine: blank line is not a chord line', () => {
  const PL = loadPL();
  assert.equal(PL.isChordOnlyLine('   '), false);
});

test('stripInlineChords: removes bracketed chords, keeps lyrics', () => {
  const PL = loadPL();
  assert.equal(
    PL.stripInlineChords('[Am]Amazing [G]grace how [C]sweet'),
    'Amazing grace how sweet'
  );
  assert.equal(PL.stripInlineChords('{C#m}Hello {G/B}world'), 'Hello world');
});

test('stripInlineChords: does not eat a chord substring inside a word', () => {
  const PL = loadPL();
  // "Amazing" contains "Am" but must survive (unbracketed strip is token-only).
  assert.equal(PL.stripInlineChords('Amazing grace'), 'Amazing grace');
});

test('stripInlineChords: removes a standalone unbracketed chord token', () => {
  const PL = loadPL();
  assert.equal(PL.stripInlineChords('hello Am world'), 'hello world');
});

// ── boilerplate removal ──────────────────────────────────────────────────────

test('isBoilerplate: Genius/AZLyrics junk lines', () => {
  const PL = loadPL();
  assert.equal(PL.isBoilerplate('You might also like'), true);
  assert.equal(PL.isBoilerplate('Submit Corrections'), true);
  assert.equal(PL.isBoilerplate('Embed'), true);
  assert.equal(PL.isBoilerplate('5Embed'), true);
  assert.equal(PL.isBoilerplate('12 Contributors'), true);
});

test('isBoilerplate: a real lyric line is kept', () => {
  const PL = loadPL();
  assert.equal(PL.isBoilerplate('Sing it out tonight'), false);
});

test('stripBoilerplate: drops the junk, keeps lyrics', () => {
  const PL = loadPL();
  const out = PL.stripBoilerplate([
    'Sing it loud',
    'You might also like',
    'Embed',
    'Sing it proud',
  ]);
  assert.deepEqual(Array.from(out), ['Sing it loud', 'Sing it proud']);
});

// ── metadata ─────────────────────────────────────────────────────────────────

test('detectMetadata: reads labelled title/artist/tempo/time-sig', () => {
  const PL = loadPL();
  const md = PL.detectMetadata(PL.normalizeText(fixture('chord_over_lyrics_sample.txt')));
  assert.equal(md.meta.title, 'Old Friend');
  assert.equal(md.meta.artist, 'The Testers');
  assert.equal(md.meta.bpm, 96);
  assert.equal(md.meta.timeSignature, '4/4');
});

test('detectMetadata: a quoted "… lyrics" page title is consumed', () => {
  const PL = loadPL();
  const md = PL.detectMetadata(
    PL.normalizeText('"Testing Times" lyrics\n\nFirst verse begins here')
  );
  assert.equal(md.meta.title, 'Testing Times');
});

test('detectMetadata: does NOT grab a plain first verse line as a title', () => {
  const PL = loadPL();
  const md = PL.detectMetadata(PL.normalizeText('Hello there my old friend\nGood to see you'));
  assert.equal(md.meta.title, '');
  // Both content lines survive.
  assert.equal(md.lines.length, 2);
});

test('detectMetadata: BPM detected from an inline "120 BPM" annotation', () => {
  const PL = loadPL();
  const md = PL.detectMetadata(PL.normalizeText('Some line\n120 BPM\nAnother line'));
  assert.equal(md.meta.bpm, 120);
});

// ── syllable counting ────────────────────────────────────────────────────────

test('countSyllables: common words', () => {
  const PL = loadPL();
  assert.equal(PL.countSyllables('grace'), 1);
  assert.equal(PL.countSyllables('amazing'), 3);
  assert.equal(PL.countSyllables('the'), 1);
  assert.equal(PL.countSyllables('table'), 2); // -le ending
});

test('countSyllables: floors at 1 and never returns 0 for a word', () => {
  const PL = loadPL();
  assert.equal(PL.countSyllables('rhythm'), 1);
  assert.equal(PL.countSyllables('a'), 1);
});

test('lineSyllables: sums a line', () => {
  const PL = loadPL();
  assert.equal(PL.lineSyllables('Amazing grace how sweet the sound'), 8);
});

// ── fonts + print/PDF ────────────────────────────────────────────────────────

test('FONT_STACKS: every entry has id/label/css and a safe fallback family', () => {
  const PL = loadPL();
  assert.ok(PL.FONT_STACKS.length >= 3);
  for (const f of PL.FONT_STACKS) {
    assert.ok(f.id && f.label && f.css, 'font entry complete');
    assert.ok(/serif|sans-serif|monospace/.test(f.css), 'ends in a generic family');
  }
});

test('fontCssById: known id resolves, unknown falls back to the first stack', () => {
  const PL = loadPL();
  assert.equal(PL.fontCssById('serif'), PL.FONT_STACKS.find((f) => f.id === 'serif').css);
  assert.equal(PL.fontCssById('nope'), PL.FONT_STACKS[0].css);
});

test('buildPrintHtml: emits a standalone doc with title, sections, and lines', () => {
  const PL = loadPL();
  const m = PL.parseLyrics('Test Song Lyrics\n[Verse 1]\nhello world line\n[Chorus]\nsing it loud');
  const html = PL.buildPrintHtml(m, { fontFamily: PL.fontCssById('serif'), fontSize: 18 });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Test Song'));
  assert.ok(html.includes('>Verse 1<'));
  assert.ok(html.includes('>Chorus<'));
  assert.ok(html.includes('hello world line'));
  assert.ok(html.includes('Georgia'), 'chosen font family is applied');
  assert.ok(/@media print/.test(html), 'carries a print stylesheet');
});

test('buildPrintHtml: escapes lyric/section text (no raw HTML injection)', () => {
  const PL = loadPL();
  const m = { title: 'A<b>', artist: '', sections: [{ label: 'V<1>', lines: ['a & <b>'] }] };
  const html = PL.buildPrintHtml(m, {});
  assert.ok(html.includes('A&lt;b&gt;'));
  assert.ok(html.includes('V&lt;1&gt;'));
  assert.ok(html.includes('a &amp; &lt;b&gt;'));
  assert.ok(!html.includes('<b>a'), 'no unescaped tag from lyric text');
});

test('buildPrintHtml: an empty lyric line renders a non-empty paragraph', () => {
  const PL = loadPL();
  const m = { title: 'T', artist: '', sections: [{ label: 'V', lines: ['', 'word'] }] };
  const html = PL.buildPrintHtml(m, {});
  assert.ok(html.includes('&nbsp;'));
});

// ── similarity ───────────────────────────────────────────────────────────────

test('levenshtein / similarity basics', () => {
  const PL = loadPL();
  assert.equal(PL.levenshtein('kitten', 'sitting'), 3);
  assert.equal(PL.similarity('hello world', 'hello world'), 1);
  // A one-character change stays well above the 0.85 repeat threshold.
  assert.ok(PL.similarity('sing it out tonight', 'sing it out tonights') > 0.85);
  assert.ok(PL.similarity('verse one text here', 'totally other words') < 0.5);
});

// ── section detection: explicit (Genius) ─────────────────────────────────────

test('Genius fixture: explicit sections preserved, chords + boilerplate removed', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('genius_sample.txt'));
  assert.equal(m.title, 'Sweet Song');
  const ls = labels(m);
  assert.ok(ls.includes('Verse 1'));
  assert.ok(ls.includes('Chorus'));
  assert.ok(ls.includes('Verse 2'));
  // No chord tokens survive in any lyric line.
  const allText = m.sections.flatMap((s) => Array.from(s.lines)).join('\n');
  assert.ok(!/\[[A-G]/.test(allText), 'no bracketed chords remain');
  assert.ok(!/You might also like/i.test(allText), 'boilerplate removed');
  assert.ok(!/Embed/i.test(allText), 'Embed removed');
});

test('inline-chords fixture: brackets stripped, section kept', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('inline_chords_sample.txt'));
  assert.equal(m.title, 'Amazing Grace');
  const line = m.sections[0].lines[0];
  assert.equal(line, 'Amazing grace how sweet the sound');
});

// ── section detection: inferred (AZLyrics) ───────────────────────────────────

test('AZLyrics fixture: infers Verse + Chorus without headers', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('azlyrics_sample.txt'));
  const ls = labels(m);
  assert.equal(ls[0], 'Verse 1');
  assert.ok(ls.includes('Chorus'), 'repeated block detected as Chorus');
  assert.ok(ls.includes('Verse 2'), 'second distinct block numbered as Verse 2');
  // Exactly the expected V C V C shape.
  assert.deepEqual(ls, ['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);
});

test('inferred: a V-C-V-C-B-C structure names the bridge and keeps verse 1', () => {
  const PL = loadPL();
  const src = [
    'Verse one here',
    'some words to sing',
    '',
    'chorus line we know',
    'chorus line we go',
    '',
    'Verse two here',
    'more words to sing',
    '',
    'chorus line we know',
    'chorus line we go',
    '',
    'Bridge is different now',
    'really quite distinct',
    '',
    'chorus line we know',
    'chorus line we go',
  ].join('\n');
  assert.deepEqual(labels(PL.parseLyrics(src)), [
    'Verse 1',
    'Chorus',
    'Verse 2',
    'Chorus',
    'Bridge',
    'Chorus',
  ]);
});

test('inferred: chord-over-lyrics with no title keeps every lyric line', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('chord_over_lyrics_sample.txt'));
  assert.equal(m.title, 'Old Friend');
  const first = m.sections[0].lines;
  assert.ok(first.includes('Hello there my old friend'));
  assert.ok(first.includes('Good to see you again'));
  // No chord-only line leaked into the lyrics.
  const allText = m.sections.flatMap((s) => Array.from(s.lines)).join('\n');
  assert.ok(!/\bAm\b\s+\bF\b/.test(allText));
});

test('parseLyrics: empty input yields no sections but does not throw', () => {
  const PL = loadPL();
  const m = PL.parseLyrics('');
  assert.deepEqual(Array.from(m.sections), []);
});

test('parseLyrics: non-English lyrics do not crash and keep the lines', () => {
  const PL = loadPL();
  const m = PL.parseLyrics('Título: Canción\n\nHola mundo bonito\nCanto en la mañana');
  assert.ok(m.sections.length >= 1);
  // The heuristic doesn't parse the Spanish "Título:" label, but no lyric line
  // is ever lost — the words survive somewhere in the model.
  const allText = m.sections.flatMap((s) => Array.from(s.lines)).join(' ');
  assert.ok(allText.includes('Hola mundo bonito'));
  assert.ok(allText.includes('Canto en la mañana'));
});

// ── timing engine ────────────────────────────────────────────────────────────

test('parseDuration: mm:ss, m.ss, and bare seconds', () => {
  const PL = loadPL();
  assert.equal(PL.parseDuration('3:45'), 225);
  assert.equal(PL.parseDuration('3.45'), 225);
  assert.equal(PL.parseDuration('225'), 225);
  assert.equal(PL.parseDuration(''), 0);
  assert.equal(PL.parseDuration('garbage'), 0);
});

test('buildTimingPlan: total time matches requested duration within 1s', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('azlyrics_sample.txt'));
  const plan = PL.buildTimingPlan(m, { bpm: 120, duration: '3:00', syllablesPerBeat: 2 });
  assert.ok(Math.abs(plan.totalSeconds - 180) <= 1, `total ${plan.totalSeconds} ≈ 180`);
  assert.equal(plan.durationSeconds, 180);
});

test('buildTimingPlan: line start times are strictly non-decreasing', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('genius_sample.txt'));
  const plan = PL.buildTimingPlan(m, { bpm: 100, duration: '4:00', syllablesPerBeat: 2 });
  const events = PL.flattenPlan(plan);
  for (let i = 1; i < events.length; i++) {
    assert.ok(
      events[i].startTimeSeconds >= events[i - 1].startTimeSeconds,
      `event ${i} start not before ${i - 1}`
    );
  }
  // Every line has a positive duration.
  assert.ok(events.every((e) => e.durationSeconds > 0));
});

test('buildTimingPlan: clamps out-of-range BPM and syllables-per-beat', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('azlyrics_sample.txt'));
  const plan = PL.buildTimingPlan(m, { bpm: 5, syllablesPerBeat: 99 });
  assert.equal(plan.bpm, 20); // clamped to floor
  assert.equal(plan.syllablesPerBeat, 5); // clamped to ceiling
});

test('buildTimingPlan: with no duration, still lays out a positive timeline', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(fixture('azlyrics_sample.txt'));
  const plan = PL.buildTimingPlan(m, { bpm: 120, syllablesPerBeat: 2 });
  assert.ok(plan.totalSeconds > 0);
  assert.equal(plan.durationSeconds, plan.totalSeconds);
});

// ── scroll interpolation ─────────────────────────────────────────────────────

test('interpolatePosition: monotonic, clamped at the ends, no jumps', () => {
  const PL = loadPL();
  const kf = [
    { t: 0, pos: 0 },
    { t: 1, pos: 100 },
    { t: 3, pos: 300 },
  ];
  assert.equal(PL.interpolatePosition(-1, kf, 'linear'), 0);
  assert.equal(PL.interpolatePosition(0.5, kf, 'linear'), 50);
  assert.equal(PL.interpolatePosition(2, kf, 'linear'), 200);
  assert.equal(PL.interpolatePosition(99, kf, 'linear'), 300);
  // Monotonic non-decreasing across a fine sweep.
  let prev = -Infinity;
  for (let t = 0; t <= 3; t += 0.05) {
    const p = PL.interpolatePosition(t, kf, 'smooth');
    assert.ok(p >= prev - 1e-9, `position decreased at t=${t}`);
    prev = p;
  }
});

test('interpolatePosition: smoothstep stays within the segment bounds', () => {
  const PL = loadPL();
  const kf = [
    { t: 0, pos: 0 },
    { t: 2, pos: 200 },
  ];
  const mid = PL.interpolatePosition(1, kf, 'smooth');
  assert.ok(mid >= 0 && mid <= 200);
  assert.equal(PL.smoothstep(0), 0);
  assert.equal(PL.smoothstep(1), 1);
});

// ── edge cases ───────────────────────────────────────────────────────────────

test('parseLyrics: a single block with no blank lines is one Verse', () => {
  const PL = loadPL();
  const m = PL.parseLyrics('line one\nline two\nline three\nline four');
  assert.equal(m.sections.length, 1);
  assert.equal(m.sections[0].label, 'Verse 1');
  assert.equal(m.sections[0].lines.length, 4);
});

test('parseLyrics: verses-only song (no chorus) numbers verses', () => {
  const PL = loadPL();
  const m = PL.parseLyrics(
    'alpha one\nalpha two\n\nbeta three\nbeta four\n\ngamma five\ngamma six'
  );
  assert.deepEqual(labels(m), ['Verse 1', 'Verse 2', 'Verse 3']);
});

test('parseLyrics: an extremely long line is handled and timed', () => {
  const PL = loadPL();
  const longLine = 'word '.repeat(400).trim();
  const m = PL.parseLyrics(longLine);
  const plan = PL.buildTimingPlan(m, { bpm: 120, duration: '2:00', syllablesPerBeat: 2 });
  assert.ok(plan.totalSeconds > 0);
  assert.equal(m.sections[0].lines[0].split(' ').length, 400);
});

test('parseLyrics: 10k-line input parses under 500ms', () => {
  const PL = loadPL();
  const big = Array.from({ length: 10000 }, (_, i) =>
    i % 5 === 4 ? '' : `line number ${i} words here`
  ).join('\n');
  const t0 = Date.now();
  const m = PL.parseLyrics(big);
  const dt = Date.now() - t0;
  assert.ok(m.sections.length > 0);
  assert.ok(dt < 500, `parse took ${dt}ms (budget 500ms)`);
});

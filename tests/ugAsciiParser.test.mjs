/**
 * tests/ugAsciiParser.test.mjs
 *
 * Regression tests for ug_ascii_parser.js covering every bug fixed in the
 * Phase-0 hardening pass.  Runs with Node.js native test runner (no deps).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load ug_ascii_parser.js into a sandboxed vm context with a minimal
// browser-like environment (crypto for UUID generation).
function loadParser() {
  const src = readFileSync(new URL('../ug_ascii_parser.js', import.meta.url), 'utf8');
  const context = {
    // Provide crypto so generateUUID() can use crypto.randomUUID().
    crypto: globalThis.crypto,
    module: { exports: {} },
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context.module.exports;
}

const { parseUltimateGuitarAscii, normalizeChord, computeHarmonicFingerprint, guessGenre } =
  loadParser();

// ─── Bug #1: isTabLine accepts multi-measure tabs ────────────────────────────

describe('isTabLine — multi-measure tab detection', () => {
  it('detects a 6-line tab block with internal barlines', () => {
    const input = [
      'e|--0-2-3--|---------0--|',
      'B|--3---3--|-3------------|',
      'G|--2---2--|-0------------|',
      'D|--0---0--|-2------------|',
      'A|---------|--3------------|',
      'E|---------|--------------|',
      '',
      'Some lyrics here',
    ].join('\n');
    const song = parseUltimateGuitarAscii(input);
    assert.ok(
      song.analytics.density.tabDensity > 0,
      'tabDensity should be > 0 for a real tab block'
    );
    assert.equal(song.source.format, 'ascii_tab');
    assert.equal(song.renderHints.showTab, true);
  });

  it('does NOT count a single isolated tab-looking line as a tab block', () => {
    // Fewer than 4 consecutive lines → should not qualify
    const input = [
      'This is a song title',
      'E|--0--3--|',
      'More prose here',
      'Another lyric line',
    ].join('\n');
    const song = parseUltimateGuitarAscii(input);
    assert.equal(
      song.analytics.density.tabDensity,
      0,
      'single tab-like line should not set tabDensity'
    );
  });
});

// ─── Bug #2: CHORD_REGEX stateful /gi bug ────────────────────────────────────

describe('harmony events — no chord dropout from stateful regex', () => {
  it('captures all four chords from a simple 4-chord line', () => {
    const input = 'G C Am F\nSome lyric words below here yes';
    const song = parseUltimateGuitarAscii(input);
    const symbols = song.harmony.events.map((e) => e.symbol);
    assert.ok(symbols.includes('G'), 'G should be present');
    assert.ok(symbols.includes('C'), 'C should be present');
    assert.ok(symbols.includes('Am'), 'Am should be present');
    assert.ok(symbols.includes('F'), 'F should be present');
  });

  it('captures all chords even when called on the same input repeatedly', () => {
    const input = 'Am G F C\nSome lyric words below here yes';
    const song1 = parseUltimateGuitarAscii(input);
    const song2 = parseUltimateGuitarAscii(input);
    assert.equal(
      song1.harmony.events.length,
      song2.harmony.events.length,
      'consecutive calls must return the same chord count'
    );
  });
});

// ─── Bug #12: CHORD_REGEX handles complex chord types ────────────────────────

describe('CHORD_REGEX — complex chord types captured', () => {
  it('captures F#m7b5 (half-diminished with sharp root)', () => {
    const input = 'F#m7b5 Bm7 E7 Am7\nSome lyric words below yes';
    const song = parseUltimateGuitarAscii(input);
    const symbols = song.harmony.events.map((e) => e.symbol);
    assert.ok(
      symbols.some((s) => s === 'F#m7b5' || s.startsWith('F#m7')),
      'F#m7b5 must be captured'
    );
  });

  it('captures Am7b5 (half-diminished)', () => {
    const input = 'Dm7 G7 Am7b5 Cmaj7\nSome lyric words below yes';
    const song = parseUltimateGuitarAscii(input);
    const symbols = song.harmony.events.map((e) => e.symbol);
    assert.ok(
      symbols.some((s) => s === 'Am7b5' || s.startsWith('Am7')),
      'Am7b5 must be captured'
    );
  });

  it('captures G7sus4 (dominant seventh suspended)', () => {
    const input = 'G7sus4 Csus2 Dm7 G7\nSome lyric words below yes';
    const song = parseUltimateGuitarAscii(input);
    const symbols = song.harmony.events.map((e) => e.symbol);
    assert.ok(
      symbols.some((s) => s.startsWith('G7') || s === 'G7sus4'),
      'G7sus4 must be captured'
    );
  });
});

// ─── Bug #4: normalizeChord bass regex handles sharp bass notes ───────────────

describe('normalizeChord — sharp bass notes', () => {
  it('captures F# bass in D/F#', () => {
    const result = normalizeChord('D/F#');
    assert.equal(result.root, 'D');
    assert.equal(result.bass, 'F#', 'bass should be F# not null');
  });

  it('captures G# bass in C/G#', () => {
    const result = normalizeChord('C/G#');
    assert.equal(result.bass, 'G#');
  });

  it('still captures natural bass notes (G/B)', () => {
    const result = normalizeChord('G/B');
    assert.equal(result.bass, 'B');
  });

  it('still captures flat bass notes (Cm/Bb)', () => {
    const result = normalizeChord('Cm/Bb');
    assert.equal(result.bass, 'Bb');
  });
});

// ─── Bug #11: aug7 gets its own quality family ────────────────────────────────

describe('normalizeChord — aug7 quality family', () => {
  it('maps aug7 to aug7, not aug', () => {
    const result = normalizeChord('Caug7');
    assert.equal(result.qualityFamily, 'aug7');
  });

  it('maps aug to aug', () => {
    const result = normalizeChord('Caug');
    assert.equal(result.qualityFamily, 'aug');
  });
});

// ─── Bug #5: beat positions are chord-spaced not token-spaced ─────────────────

describe('harmony events — beat positions', () => {
  it('places G at beat 1.0 when line is "| G | C | Am | F |"', () => {
    const input = '| G | C | Am | F |\nSome lyric words below yes';
    const song = parseUltimateGuitarAscii(input);
    const gEvent = song.harmony.events.find((e) => e.symbol === 'G');
    assert.ok(gEvent, 'G event must exist');
    assert.equal(gEvent.beat, 1.0, 'G should be at beat 1 when it is the first chord');
  });

  it('places four chords at beats 1, 2, 3, 4 on a simple barred line', () => {
    const input = '| G | C | Am | F |\nSome lyric words below yes';
    const song = parseUltimateGuitarAscii(input);
    // Materialize into the outer realm so deepEqual's instanceof check passes.
    const beats = Array.from(song.harmony.events).map((e) => e.beat);
    assert.deepEqual(beats, [1.0, 2.0, 3.0, 4.0]);
  });
});

// ─── Bug #7: 4-line tab block minimum ────────────────────────────────────────

describe('tab block — minimum 4 consecutive lines', () => {
  it('marks a 6-line tab block as tab (tabDensity > 0)', () => {
    const sixLines = ['e|--0--|', 'B|--0--|', 'G|--0--|', 'D|--0--|', 'A|--0--|', 'E|--0--|'];
    const song = parseUltimateGuitarAscii(sixLines.join('\n'));
    assert.ok(song.analytics.density.tabDensity > 0);
  });

  it('marks a 3-line tab block as non-tab (tabDensity === 0)', () => {
    const threeLines = ['e|--0--|', 'B|--0--|', 'G|--0--|', '', 'Some lyrics here and there'];
    const song = parseUltimateGuitarAscii(threeLines.join('\n'));
    assert.equal(song.analytics.density.tabDensity, 0);
  });
});

// ─── Bug #8: lyricsAligned always false ──────────────────────────────────────

describe('lossMap — lyricsAligned', () => {
  it('is always false even when lyric lines exist', () => {
    const input = 'Am G F C\nThese are my lyrics and they are nice\nMore words here too yes';
    const song = parseUltimateGuitarAscii(input);
    assert.equal(song.lossMap.lyricsAligned, false);
  });
});

// ─── Bug #6: isChordLine requires >1 chord ───────────────────────────────────

describe('isChordLine — single-letter false positives', () => {
  it('does not treat a plain prose sentence starting with G as a chord line', () => {
    // "Good morning everyone" starts with G but has only 1 chord match at ratio < 40%
    const input = 'Good morning everyone today\nAm G F C yes yes yes';
    const song = parseUltimateGuitarAscii(input);
    // Only the second line should contribute chord events
    const symbols = song.harmony.events.map((e) => e.symbol);
    assert.ok(!symbols.includes('Good'), '"Good" should not be captured as a chord');
  });
});

// ─── Bug #3: structure.sections populated from [Section] markers ─────────────

describe('structure.sections — extracted from [Section] markers', () => {
  it('populates sections from [Verse] and [Chorus] markers', () => {
    const input = [
      '[Verse]',
      'Am G F C',
      'Lyric line here for the verse',
      '[Chorus]',
      'F C G Am',
      'Chorus lyric here yes indeed',
    ].join('\n');
    const song = parseUltimateGuitarAscii(input);
    assert.equal(song.structure.sections.length, 2);
    assert.equal(song.structure.sections[0].label, 'Verse');
    assert.equal(song.structure.sections[1].label, 'Chorus');
    assert.equal(song.structure.sections[0].sourceDeclared, true);
  });

  it('returns empty sections when no [Section] markers present', () => {
    const song = parseUltimateGuitarAscii('Am G F C\nLyric words right here yes');
    assert.equal(song.structure.sections.length, 0);
  });
});

// ─── Bug #3: lyrics.lines populated ─────────────────────────────────────────

describe('lyrics.lines — populated from non-chord non-tab lines', () => {
  it('collects lyric lines into lyrics.lines', () => {
    const input = 'Am G F C\nThese are my lyrics for the song\nMore lyrics on this line yes';
    const song = parseUltimateGuitarAscii(input);
    assert.equal(song.lyrics.lines.length, 2);
    assert.equal(song.lyrics.lines[0], 'These are my lyrics for the song');
  });

  it('does not include chord lines or blank lines in lyrics.lines', () => {
    const input = 'Am G F C\n\nDm Em G\nOnly real lyrics here yes';
    const song = parseUltimateGuitarAscii(input);
    assert.ok(
      song.lyrics.lines.every((l) => !l.match(/^[A-G]/)),
      'chord lines must not appear in lyrics'
    );
  });
});

// ─── Bug #9: cowboy chord overcounting ───────────────────────────────────────

describe('computeHarmonicFingerprint — cowboy chord accuracy', () => {
  it('does not count Am7 as a cowboy chord', () => {
    const chords = [normalizeChord('Am7')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.cowboyChordShare, 0, 'Am7 is not an open-position cowboy chord');
  });

  it('does not count F7 (dominant) as a cowboy chord', () => {
    const chords = [normalizeChord('F7')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.cowboyChordShare, 0, 'F7 (barre chord) should not count as cowboy');
  });

  it('counts G major as a cowboy chord', () => {
    const chords = [normalizeChord('G')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.cowboyChordShare, 1, 'G major is a cowboy chord');
  });

  it('counts Am (minor triad) as a cowboy chord', () => {
    const chords = [normalizeChord('Am')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.cowboyChordShare, 1, 'Am minor triad is a cowboy chord');
  });
});

// ─── Bug #10: iiV detection ──────────────────────────────────────────────────

describe('computeHarmonicFingerprint — iiV detection', () => {
  it('counts Dm7→G7 as a ii–V pair', () => {
    const chords = [normalizeChord('Dm7'), normalizeChord('G7')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.iiVRate, 1, 'Dm7→G7 is the canonical ii–V');
  });

  it('does NOT count C→F (I→IV) as a ii–V pair', () => {
    const chords = [normalizeChord('C'), normalizeChord('F')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.iiVRate, 0, 'C→F is I→IV not ii–V');
  });

  it('does NOT count G→C (V→I) as a ii–V pair', () => {
    const chords = [normalizeChord('G'), normalizeChord('C')];
    const hf = computeHarmonicFingerprint(chords);
    assert.equal(hf.iiVRate, 0, 'G→C is V→I not ii–V');
  });
});

// ─── Bug #13: capo detection ─────────────────────────────────────────────────

describe('capo detection', () => {
  it('extracts capo fret from "Capo: 3" header', () => {
    const input = 'Title: My Song\nCapo: 3\nAm G F C\nSome lyric words here yes\nDm Em Am G';
    const song = parseUltimateGuitarAscii(input);
    assert.equal(song.metadata.capo.fret, 3);
    assert.equal(song.metadata.capo.sourceDeclared, true);
  });

  it('extracts capo fret from "Capo 5 fret" notation', () => {
    const input = 'Capo 5 fret\nG C D Em\nSome lyric words here yes indeed';
    const song = parseUltimateGuitarAscii(input);
    assert.equal(song.metadata.capo.fret, 5);
  });

  it('sets capo.fret to null when no capo mentioned', () => {
    const song = parseUltimateGuitarAscii('Am G F C\nLyric words here yes indeed');
    assert.equal(song.metadata.capo.fret, null);
    assert.equal(song.metadata.capo.sourceDeclared, false);
  });

  it('boosts folk_pop score for a capo+cowboy-chord input', () => {
    const withCapo = 'Capo: 2\nG C D Em\nLyric line here and yes\nAm G F C\nMore lyrics yes indeed';
    const withoutCapo = 'G C D Em\nLyric line here and yes\nAm G F C\nMore lyrics yes indeed';
    const songWith = parseUltimateGuitarAscii(withCapo);
    const songWithout = parseUltimateGuitarAscii(withoutCapo);
    assert.ok(
      songWith.analytics.genreGuess.scores.folk_pop >
        songWithout.analytics.genreGuess.scores.folk_pop,
      'capo presence should increase folk_pop score'
    );
  });
});

// ─── General schema integrity ────────────────────────────────────────────────

describe('parseUltimateGuitarAscii — schema integrity', () => {
  it('always returns lossMap.rhythmExplicit === false', () => {
    const song = parseUltimateGuitarAscii('G C Am F\nSome words here yes indeed');
    assert.equal(song.lossMap.rhythmExplicit, false);
  });

  it('always returns lossMap.lyricsAligned === false', () => {
    const song = parseUltimateGuitarAscii('G C Am F\nReal lyrics here yes indeed');
    assert.equal(song.lossMap.lyricsAligned, false);
  });

  it('generates a valid UUID for songId', () => {
    const song = parseUltimateGuitarAscii('G C Am F\nWords here yes indeed');
    assert.match(
      song.songId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('populates creator arrays from options', () => {
    const song = parseUltimateGuitarAscii('G C Am F\nWords here yes indeed', {
      title: 'Test',
      composer: 'Alice',
      artist: ['Bob', 'Carol'],
    });
    assert.equal(song.title, 'Test');
    assert.deepEqual(Array.from(song.creators.composer), ['Alice']);
    assert.deepEqual(Array.from(song.creators.artist), ['Bob', 'Carol']);
  });
});

/**
 * tests/importPipelineUtils.test.mjs
 *
 * Unit tests for the pure utility functions in importPipeline.js.
 * Loads the full browser-global script chain into a vm sandbox:
 *   utils.js → chordProcessing.js → csmpnParser.js → importPipeline.js
 * Stubs: fbSettings, importDiagnostics, validationWarnings, document, window, navigator.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// ── Context factory ───────────────────────────────────────────────────────────

function makeContext(fbOverrides = {}) {
  const context = {
    fbSettings: {
      barsPerRow: 4,
      maj7Style: 'Maj7',
      minorStyle: 'm',
      dimStyle: 'dim',
      halfDimStyle: 'ø',
      barLines: 'visible',
      includeLyrics: true,
      ...fbOverrides,
    },
    importDiagnostics: null,
    validationWarnings: [],
    // Minimal browser stubs so file-level code doesn't throw
    document: {
      getElementById: () => null,
      createElement: () => ({ href: '', download: '', rel: '', click() {}, remove() {} }),
      body: { appendChild: () => {} },
    },
    window: { ABCJS: null },
    navigator: { canShare: null, share: null },
    URL: { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    console,
  };

  const root = new URL('../', import.meta.url).pathname;
  const load = (name) => readFileSync(root + name, 'utf8');

  vm.createContext(context);
  vm.runInContext(load('utils.js'), context);
  vm.runInContext(load('chordProcessing.js'), context);
  vm.runInContext(load('csmpnParser.js'), context);
  vm.runInContext(load('importPipeline.js'), context);
  // SongModel is a class declaration — not auto-bound to the vm global.
  // Expose a factory so tests can create instances from within the vm realm
  // (required for instanceof checks inside countSongModelBars to pass).
  vm.runInContext('globalThis.makeSong = () => new SongModel();', context);
  return context;
}

const ctx = makeContext();

// ── SongModel ─────────────────────────────────────────────────────────────────

describe('SongModel', () => {
  it('constructs with empty meta and sections', () => {
    const song = ctx.makeSong();
    assert.equal(song.meta.title, '');
    assert.equal(song.sections.length, 0);
  });

  it('toCSMPN emits metadata header lines', () => {
    const song = ctx.makeSong();
    song.meta.title = 'My Song';
    song.meta.composer = 'J. Artist';
    song.meta.key = 'G';
    song.sections.push({ label: '- Verse', bars: ['Am', 'F', 'C', 'G'] });
    const out = song.toCSMPN({ barsPerRow: 4 });
    assert.ok(out.includes('Title: My Song'), `missing Title: in:\n${out}`);
    assert.ok(out.includes('Composer: J. Artist'));
    assert.ok(out.includes('Key: G'));
  });

  it('toCSMPN groups bars by barsPerRow', () => {
    const song = ctx.makeSong();
    song.sections.push({ label: '- Main', bars: ['C', 'G', 'Am', 'F', 'C', 'G'] });
    const out2 = song.toCSMPN({ barsPerRow: 2 });
    const lines = out2.split('\n').filter((l) => l.trim() && !l.startsWith('-'));
    // 6 bars ÷ 2 per row = 3 rows
    assert.equal(lines.length, 3);
  });

  it('toCSMPN omits empty metadata fields', () => {
    const song = ctx.makeSong();
    song.meta.title = 'Only Title';
    song.sections.push({ label: '', bars: ['G'] });
    const out = song.toCSMPN({});
    assert.ok(!out.includes('Composer:'));
    assert.ok(!out.includes('Key:'));
  });

  it('toCSMPN emits section label', () => {
    const song = ctx.makeSong();
    song.sections.push({ label: '- Chorus', bars: ['C', 'G'] });
    const out = song.toCSMPN({ barsPerRow: 4 });
    assert.ok(out.includes('- Chorus'));
  });

  it('toCSMPN emits lyrics as ; lines', () => {
    const song = ctx.makeSong();
    song.sections.push({ label: '- V', bars: ['Am'], lyrics: ['Hello world'] });
    const out = song.toCSMPN({ barsPerRow: 4 });
    assert.ok(out.includes('; Hello world'));
  });
});

// ── mapMusicXMLFifthsToKey ────────────────────────────────────────────────────

describe('mapMusicXMLFifthsToKey', () => {
  it('0 fifths major → C', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(0, 'major'), 'C');
  });
  it('1 fifth major → G', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(1, 'major'), 'G');
  });
  it('-1 fifth major → F', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(-1, 'major'), 'F');
  });
  it('-7 fifths major → Cb', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(-7, 'major'), 'Cb');
  });
  it('7 fifths major → C#', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(7, 'major'), 'C#');
  });
  it('0 fifths minor → Am', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(0, 'minor'), 'Am');
  });
  it('1 fifth minor → Em', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(1, 'minor'), 'Em');
  });
  it('-2 fifths minor → Gm', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey(-2, 'minor'), 'Gm');
  });
  it('non-numeric fifths → empty string', () => {
    assert.equal(ctx.mapMusicXMLFifthsToKey('x', 'major'), '');
  });
});

// ── extractHeaderFromText ─────────────────────────────────────────────────────

describe('extractHeaderFromText', () => {
  it('parses Title and Composer', () => {
    const hdr = ctx.extractHeaderFromText('Title: Blue Moon\nComposer: Rogers', false);
    assert.equal(hdr.title, 'Blue Moon');
    assert.equal(hdr.composer, 'Rogers');
  });
  it('parses Key', () => {
    const hdr = ctx.extractHeaderFromText('Key: Bb\nC G Am F', false);
    assert.equal(hdr.key, 'Bb');
  });
  it('parses Tempo (strips non-digit suffix)', () => {
    const hdr = ctx.extractHeaderFromText('Tempo: 120\n', false);
    assert.equal(hdr.tempo, '120');
  });
  it('rejects Tempo out of range', () => {
    const hdr = ctx.extractHeaderFromText('Tempo: 999\n', false);
    assert.equal(hdr.tempo, '');
  });
  it('parses Time signature', () => {
    const hdr = ctx.extractHeaderFromText('Time: 3/4\n', false);
    assert.equal(hdr.time, '3/4');
  });
  it('rejects malformed time signature', () => {
    const hdr = ctx.extractHeaderFromText('Time: waltz\n', false);
    assert.equal(hdr.time, '');
  });
  it('rejects chord-like garbage as title', () => {
    const hdr = ctx.extractHeaderFromText('Am G F C\n', false);
    assert.equal(hdr.title, '');
  });
  it('adopts first plain line as title when no Title: header', () => {
    const hdr = ctx.extractHeaderFromText('Autumn Leaves\nKey: G', false);
    assert.equal(hdr.title, 'Autumn Leaves');
  });
  it('does not promote section label to title', () => {
    const hdr = ctx.extractHeaderFromText('- Verse\nC G Am F', false);
    assert.equal(hdr.title, '');
  });
});

// ── detectChordPro ────────────────────────────────────────────────────────────

describe('detectChordPro', () => {
  it('detects {title: ...} directive', () => {
    assert.ok(ctx.detectChordPro('{title: My Song}\n[G]Hello'));
  });
  it('detects {start_of_chorus}', () => {
    assert.ok(ctx.detectChordPro('{start_of_chorus}\n[Am]text\n{end_of_chorus}'));
  });
  it('detects {capo: 2}', () => {
    assert.ok(ctx.detectChordPro('{capo: 2}'));
  });
  it('returns false for plain chord text', () => {
    assert.ok(!ctx.detectChordPro('G Am F C\nHello world'));
  });
  it('returns false for empty string', () => {
    assert.ok(!ctx.detectChordPro(''));
  });
});

// ── detectChordMark ───────────────────────────────────────────────────────────

describe('detectChordMark', () => {
  it('detects pipe bars + markdown heading', () => {
    const text = '## Verse\n| G | Am | F | C |';
    assert.ok(ctx.detectChordMark(text));
  });
  it('detects pipe bars + bracket section', () => {
    const text = '[Verse]\n| G | Am |';
    assert.ok(ctx.detectChordMark(text));
  });
  it('detects pipe bars + metadata', () => {
    const text = 'key: G\n| G | D | Em | C |';
    assert.ok(ctx.detectChordMark(text));
  });
  it('returns false for plain UG chord text', () => {
    assert.ok(!ctx.detectChordMark('[Verse]\nG Am F C\nHello world'));
  });
  it('returns false for empty input', () => {
    assert.ok(!ctx.detectChordMark(''));
  });
});

// ── normalizeCSMPNSectionLabel ────────────────────────────────────────────────

describe('normalizeCSMPNSectionLabel', () => {
  it('"verse 1" → "Verse"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('verse 1'), 'Verse');
  });
  it('"Chorus" → "Chorus"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('Chorus'), 'Chorus');
  });
  it('"refrain" → "Chorus"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('refrain'), 'Chorus');
  });
  it('"pre-chorus" → "Pre-Chorus"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('pre-chorus'), 'Pre-Chorus');
  });
  it('"bridge" → "Bridge"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('bridge'), 'Bridge');
  });
  it('"intro" → "Intro"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('intro'), 'Intro');
  });
  it('"outro" → "Outro"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('outro'), 'Outro');
  });
  it('"tag" → "Outro"', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('tag'), 'Outro');
  });
  it('unknown label passes through unchanged', () => {
    assert.equal(ctx.normalizeCSMPNSectionLabel('Guitar Solo'), 'Guitar Solo');
  });
});

// ── countSongModelBars ────────────────────────────────────────────────────────

describe('countSongModelBars', () => {
  it('counts bars across multiple sections', () => {
    const song = ctx.makeSong();
    song.sections.push({ bars: ['Am', 'F', 'C', 'G'] });
    song.sections.push({ bars: ['Dm', 'G'] });
    assert.equal(ctx.countSongModelBars(song), 6);
  });
  it('returns 0 for empty SongModel', () => {
    const song = ctx.makeSong();
    assert.equal(ctx.countSongModelBars(song), 0);
  });
  it('returns 0 for non-SongModel', () => {
    assert.equal(ctx.countSongModelBars({}), 0);
  });
  it('ignores falsy bar entries', () => {
    const song = ctx.makeSong();
    song.sections.push({ bars: ['Am', '', null, 'G'] });
    assert.equal(ctx.countSongModelBars(song), 2);
  });
});

// ── _irUnscramble ─────────────────────────────────────────────────────────────

describe('_irUnscramble', () => {
  it('short strings (≤50 chars) returned unchanged', () => {
    assert.equal(ctx._irUnscramble('ABC'), 'ABC');
    assert.equal(ctx._irUnscramble(''), '');
  });
  it('51-char string: second block prepended before first', () => {
    // blocks: [0..49] + [50] → result = [50] + [0..49]
    const first50 = 'A'.repeat(50);
    const extra = 'Z';
    const result = ctx._irUnscramble(first50 + extra);
    assert.equal(result, extra + first50);
  });
  it('100-char string: reverses two 50-char blocks', () => {
    const blockA = 'A'.repeat(50);
    const blockB = 'B'.repeat(50);
    const result = ctx._irUnscramble(blockA + blockB);
    assert.equal(result, blockB + blockA);
  });
});

// ── _irConvertChordName ───────────────────────────────────────────────────────

describe('_irConvertChordName', () => {
  it('^7 → maj7', () => assert.equal(ctx._irConvertChordName('A^7'), 'Amaj7'));
  it('^9 → maj9', () => assert.equal(ctx._irConvertChordName('C^9'), 'Cmaj9'));
  it('^ (bare) → maj', () => assert.equal(ctx._irConvertChordName('G^'), 'Gmaj'));
  it('-7 → m7', () => assert.equal(ctx._irConvertChordName('D-7'), 'Dm7'));
  it('- (bare) → m', () => assert.equal(ctx._irConvertChordName('E-'), 'Em'));
  it('-M7 → mM7', () => assert.equal(ctx._irConvertChordName('C-M7'), 'CmM7'));
  it('h7 → m7b5', () => assert.equal(ctx._irConvertChordName('Bh7'), 'Bm7b5'));
  it('h (bare) → m7b5', () => assert.equal(ctx._irConvertChordName('Bh'), 'Bm7b5'));
  it('o7 → dim7', () => assert.equal(ctx._irConvertChordName('Co7'), 'Cdim7'));
  it('o (bare) → dim', () => assert.equal(ctx._irConvertChordName('Co'), 'Cdim'));
  it('+ → aug', () => assert.equal(ctx._irConvertChordName('F+'), 'Faug'));
  it('sus → sus4', () => assert.equal(ctx._irConvertChordName('Gsus'), 'Gsus4'));
  it('sus2 stays sus2', () => assert.equal(ctx._irConvertChordName('Dsus2'), 'Dsus2'));
  it('"n" → N.C.', () => assert.equal(ctx._irConvertChordName('n'), 'N.C.'));
  it('"NC" → N.C.', () => assert.equal(ctx._irConvertChordName('NC'), 'N.C.'));
  it('"x" → %', () => assert.equal(ctx._irConvertChordName('x'), '%'));
  it('"r" → %', () => assert.equal(ctx._irConvertChordName('r'), '%'));
  it('non-[A-G] start → empty string', () => assert.equal(ctx._irConvertChordName('xyz'), ''));
});

// ── stripTokenDecorators ──────────────────────────────────────────────────────

describe('stripTokenDecorators', () => {
  it('removes wrapping parentheses', () => {
    assert.equal(ctx.stripTokenDecorators('(G)'), 'G');
  });
  it('removes repeat suffix x2', () => {
    assert.equal(ctx.stripTokenDecorators('Gmx2'), 'Gm');
  });
  it('removes trailing caret (tie marker)', () => {
    assert.equal(ctx.stripTokenDecorators('Am^'), 'Am');
  });
  it('removes quoted annotation', () => {
    assert.equal(ctx.stripTokenDecorators('G"slow"'), 'G');
  });
  it('leaves plain chord unchanged', () => {
    assert.equal(ctx.stripTokenDecorators('Cmaj7'), 'Cmaj7');
  });
});

// ── isChordToken / normalizeChordToken ────────────────────────────────────────

describe('isChordToken', () => {
  it('plain major chord → true', () => assert.ok(ctx.isChordToken('G')));
  it('minor seventh → true', () => assert.ok(ctx.isChordToken('Am7')));
  it('% repeat symbol → true', () => assert.ok(ctx.isChordToken('%')));
  it('N.C. → true', () => assert.ok(ctx.isChordToken('N.C.')));
  it('FINE → true', () => assert.ok(ctx.isChordToken('FINE')));
  it('plain lyric word → false', () => assert.ok(!ctx.isChordToken('Hello')));
  it('empty string → false', () => assert.ok(!ctx.isChordToken('')));
  it('flat chord Bb → true', () => assert.ok(ctx.isChordToken('Bb')));
  it('aug chord → true', () => assert.ok(ctx.isChordToken('Caug')));
});

describe('normalizeChordToken', () => {
  it('passes a valid chord through', () => {
    assert.equal(ctx.normalizeChordToken('Am7'), 'Am7');
  });
  it('normalizes unicode flat to b', () => {
    assert.equal(ctx.normalizeChordToken('B♭7'), 'Bb7');
  });
  it('strips parentheses', () => {
    assert.equal(ctx.normalizeChordToken('(G)'), 'G');
  });
  it('returns empty string for garbage', () => {
    assert.equal(ctx.normalizeChordToken('Hello'), '');
  });
  it('returns empty string for null', () => {
    assert.equal(ctx.normalizeChordToken(null), '');
  });
});

// ── parseChordProGridLine ─────────────────────────────────────────────────────

describe('parseChordProGridLine', () => {
  it('single chord per measure', () => {
    const bars = [...ctx.parseChordProGridLine('| [F] . . . | [C] . . . |')];
    assert.deepEqual(bars, ['F', 'C']);
  });
  it('two chords per measure joined with _', () => {
    const bars = [...ctx.parseChordProGridLine('| [Am] . [G] . |')];
    assert.equal(bars[0], 'Am_G');
  });
  it('empty cells are skipped', () => {
    const bars = [...ctx.parseChordProGridLine('| [G] . . . | . . . . |')];
    assert.equal(bars.length, 1);
    assert.equal(bars[0], 'G');
  });
  it('iReal minor notation: E-7b5 → Em7b5', () => {
    const bars = [...ctx.parseChordProGridLine('| [E-7b5] . |')];
    assert.equal(bars[0], 'Em7b5');
  });
  it('returns empty array for line with no chord brackets', () => {
    const bars = [...ctx.parseChordProGridLine('| . . . . |')];
    assert.equal(bars.length, 0);
  });
});

// ── parseHybridBeatPosition ───────────────────────────────────────────────────

describe('parseHybridBeatPosition', () => {
  it('"1" → 1', () => assert.equal(ctx.parseHybridBeatPosition('1', '4/4'), 1));
  it('"3" → 3', () => assert.equal(ctx.parseHybridBeatPosition('3', '4/4'), 3));
  it('"3&" → 3.5 (upbeat)', () => assert.equal(ctx.parseHybridBeatPosition('3&', '4/4'), 3.5));
  it('"1&" → 1.5', () => assert.equal(ctx.parseHybridBeatPosition('1&', '4/4'), 1.5));
  it('beat 5 in 4/4 → null (out of range)', () => {
    assert.equal(ctx.parseHybridBeatPosition('5', '4/4'), null);
  });
  it('beat 0 → null (below range)', () => {
    assert.equal(ctx.parseHybridBeatPosition('0', '4/4'), null);
  });
  it('non-numeric → null', () => {
    assert.equal(ctx.parseHybridBeatPosition('x', '4/4'), null);
  });
  it('3/4 time: beat 3 is valid', () => {
    assert.equal(ctx.parseHybridBeatPosition('3', '3/4'), 3);
  });
  it('3/4 time: beat 4 → null', () => {
    assert.equal(ctx.parseHybridBeatPosition('4', '3/4'), null);
  });
});

// ── isLikelyUGChordLine ───────────────────────────────────────────────────────

describe('isLikelyUGChordLine', () => {
  it('space-separated chord list → true', () => {
    assert.ok(ctx.isLikelyUGChordLine('Am G F C'));
  });
  it('chords with extensions → true', () => {
    assert.ok(ctx.isLikelyUGChordLine('Cmaj7 G7 Am7 Fmaj7'));
  });
  it('barline grid → true', () => {
    assert.ok(ctx.isLikelyUGChordLine('| G | Am | F | C |'));
  });
  it('lyrics line → false', () => {
    assert.ok(!ctx.isLikelyUGChordLine('Hello world how are you today'));
  });
  it('empty string → false', () => {
    assert.ok(!ctx.isLikelyUGChordLine(''));
  });
  it('single chord → true', () => {
    assert.ok(ctx.isLikelyUGChordLine('G'));
  });
});

// ── parseUGSectionHeader ──────────────────────────────────────────────────────

describe('parseUGSectionHeader', () => {
  it('[Verse 1] → "Verse 1"', () => {
    assert.equal(ctx.parseUGSectionHeader('[Verse 1]'), 'Verse 1');
  });
  it('[Chorus] → "Chorus"', () => {
    assert.equal(ctx.parseUGSectionHeader('[Chorus]'), 'Chorus');
  });
  it('[Bridge] → "Bridge"', () => {
    assert.equal(ctx.parseUGSectionHeader('[Bridge]'), 'Bridge');
  });
  it('[Pre-Chorus] → "Pre-Chorus"', () => {
    assert.equal(ctx.parseUGSectionHeader('[Pre-Chorus]'), 'Pre-Chorus');
  });
  it('"Verse:" line → "Verse"', () => {
    assert.equal(ctx.parseUGSectionHeader('Verse:'), 'Verse');
  });
  it('plain chord line → empty string', () => {
    assert.equal(ctx.parseUGSectionHeader('Am G F C'), '');
  });
  it('empty string → empty string', () => {
    assert.equal(ctx.parseUGSectionHeader(''), '');
  });
});

// ── normalizeUGSectionLabel ───────────────────────────────────────────────────

describe('normalizeUGSectionLabel', () => {
  it('"verse 1" → "Verse 1"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('verse 1'), 'Verse 1');
  });
  it('"CHORUS" → "Chorus"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('CHORUS'), 'Chorus');
  });
  it('"refrain" → "Chorus"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('refrain'), 'Chorus');
  });
  it('"pre-chorus 2" → "Pre-Chorus 2"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('pre-chorus 2'), 'Pre-Chorus 2');
  });
  it('"outro" → "Outro"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('outro'), 'Outro');
  });
  it('"tag" → "Outro"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('tag'), 'Outro');
  });
  it('"solo" → "Solo"', () => {
    assert.equal(ctx.normalizeUGSectionLabel('solo'), 'Solo');
  });
  it('unknown label → unchanged', () => {
    assert.equal(ctx.normalizeUGSectionLabel('Interlude A'), 'Interlude A');
  });
});

// ── detectTextSourceFlavor ────────────────────────────────────────────────────

describe('detectTextSourceFlavor', () => {
  it('ChordPro directive text → "chordpro-clean"', () => {
    const text = '{title: Blue Moon}\n{artist: Rogers}\n[G]Hello [Am]world';
    assert.equal(ctx.detectTextSourceFlavor(text), 'chordpro-clean');
  });
  it('iReal Pro URL → "ireal-pro"', () => {
    const text = 'irealb://test=test=Swing=C=n=XyZ';
    assert.equal(ctx.detectTextSourceFlavor(text), 'ireal-pro');
  });
  it('barline grid text → "barline-grid"', () => {
    const text = ['| G | D | Em | C |', '| G | D | Em | C |', '| Am | F | C | G |'].join('\n');
    assert.equal(ctx.detectTextSourceFlavor(text), 'barline-grid');
  });
  it('UG tab text with bracket sections → "ug-text"', () => {
    const text = [
      '[Verse]',
      'Am           G',
      'Hello world here',
      'F            C',
      'Another line here',
    ].join('\n');
    assert.equal(ctx.detectTextSourceFlavor(text), 'ug-text');
  });
  it('ChordMark format → "chordmark"', () => {
    const text = 'title: My Song\n## Verse\n| G | Am | F | C |';
    assert.equal(ctx.detectTextSourceFlavor(text), 'chordmark');
  });
});

// ── importChordMarkToCSMPN ────────────────────────────────────────────────────

describe('importChordMarkToCSMPN', () => {
  it('converts pipe-bar lines to CSMPN token rows', () => {
    const text = '| G | Am | F | C |';
    const out = ctx.importChordMarkToCSMPN(text);
    assert.ok(out.includes('G') && out.includes('Am'), `unexpected output: ${out}`);
  });
  it('extracts metadata from ChordMark header', () => {
    const text = 'title: Blue Moon\nkey: Bb\n| Bbmaj7 | Gm |';
    const out = ctx.importChordMarkToCSMPN(text);
    assert.ok(out.includes('Title: Blue Moon'));
    assert.ok(out.includes('Key: Bb'));
  });
  it('converts ## headings to CSMPN section labels', () => {
    const text = '## Chorus\n| C | G | Am | F |';
    const out = ctx.importChordMarkToCSMPN(text);
    assert.ok(out.includes(': Chorus') || out.includes('- Chorus'), `got: ${out}`);
  });
  it('converts [bracket] headings to CSMPN section labels', () => {
    const text = '[Verse]\n| G | D |';
    const out = ctx.importChordMarkToCSMPN(text);
    assert.ok(out.includes(': Verse') || out.includes('- Verse'), `got: ${out}`);
  });
});

// ── sniffBinaryMusicExt (magic-byte format detection) ─────────────────────────

describe('sniffBinaryMusicExt', () => {
  const sniff = (arr) => ctx.sniffBinaryMusicExt(Uint8Array.from(arr));
  const strBytes = (s) => Array.from(s, (c) => c.charCodeAt(0));

  it('detects GP3/4/5 by the FICHIER GUITAR PRO version string', () => {
    assert.equal(sniff([24, ...strBytes('FICHIER GUITAR PRO v5.10'), 0, 0]), '.gp5');
  });

  it('detects GPX (BCFZ/BCFS) containers', () => {
    assert.equal(sniff(strBytes('BCFZ....')), '.gpx');
    assert.equal(sniff(strBytes('BCFS....')), '.gpx');
  });

  it('detects GP7/8 zip containers via score.gpif', () => {
    assert.equal(sniff(strBytes('PK........Content/score.gpif....')), '.gp');
  });

  it('detects compressed MusicXML zip via container.xml', () => {
    assert.equal(sniff(strBytes('PK....META-INF/container.xml....')), '.mxl');
  });

  it('detects Power Tab, MIDI, PDF, and bare XML', () => {
    assert.equal(sniff(strBytes('ptab....')), '.ptb');
    assert.equal(sniff(strBytes('MThd....')), '.mid');
    assert.equal(sniff(strBytes('%PDF-1.4')), '.pdf');
    assert.equal(sniff(strBytes('<?xml version="1.0"?><score-partwise/>')), '.xml');
  });

  it('returns empty string for unknown or short content', () => {
    assert.equal(sniff(strBytes('hello world this is text')), '');
    assert.equal(sniff([1, 2]), '');
  });
});

// ── UG Pro PDF pure helpers ───────────────────────────────────────────────────

describe('translateChordSymbolGlyphs', () => {
  it('maps SMuFL chord-symbol accidentals to ASCII', () => {
    assert.equal(ctx.translateChordSymbolGlyphs('B\uED60'), 'Bb');
    assert.equal(ctx.translateChordSymbolGlyphs('F\uED62'), 'F#');
    assert.equal(ctx.translateChordSymbolGlyphs('B\uED61'), 'B'); // natural
    assert.equal(ctx.translateChordSymbolGlyphs('B\uED607'), 'Bb7');
  });

  it('leaves plain text and staff accidentals (U+E260 range) untouched', () => {
    assert.equal(ctx.translateChordSymbolGlyphs('Dm7'), 'Dm7');
    assert.equal(ctx.translateChordSymbolGlyphs(''), '');
    assert.equal(ctx.translateChordSymbolGlyphs('\uE262'), '\uE262');
  });
});

describe('extractPdfSectionLabel', () => {
  it('extracts UG Pro bracketed section labels', () => {
    assert.equal(ctx.extractPdfSectionLabel('[Intro]'), 'Intro');
    assert.equal(ctx.extractPdfSectionLabel('[Verse 1]'), 'Verse 1');
    assert.equal(ctx.extractPdfSectionLabel('[Pre-Chorus]'), 'Pre-Chorus');
    assert.equal(ctx.extractPdfSectionLabel(' [First Solo] '), 'First Solo');
  });

  it('rejects inline bracket chords and non-bracketed text', () => {
    assert.equal(ctx.extractPdfSectionLabel('[A7]'), null);
    assert.equal(ctx.extractPdfSectionLabel('[Bb]'), null);
    assert.equal(ctx.extractPdfSectionLabel('Verse 1'), null);
    assert.equal(ctx.extractPdfSectionLabel('[Verse 1] extra'), null);
  });
});

describe('pdfTempoFromText', () => {
  it('captures metronome tempo marks with or without the note glyph', () => {
    assert.equal(ctx.pdfTempoFromText('= 149'), '149');
    assert.equal(ctx.pdfTempoFromText('\uECA5 = 149'), '149');
    assert.equal(ctx.pdfTempoFromText('=120'), '120');
    assert.equal(ctx.pdfTempoFromText('= 148.999'), '148');
  });

  it('rejects non-tempo text and out-of-range BPM', () => {
    assert.equal(ctx.pdfTempoFromText('Dm = good'), null);
    assert.equal(ctx.pdfTempoFromText('= 20'), null);
    assert.equal(ctx.pdfTempoFromText('x = 149'), null);
    assert.equal(ctx.pdfTempoFromText(''), null);
  });
});

describe('detectSmuflTimeSigFromItems', () => {
  const dig = (d, x, y) => ({ str: String.fromCharCode(0xe080 + d), x, y });

  it('reads a stacked 4/4', () => {
    assert.equal(ctx.detectSmuflTimeSigFromItems([dig(4, 100, 500), dig(4, 100, 480)]), '4/4');
  });

  it('reads a multi-digit 12/8', () => {
    assert.equal(
      ctx.detectSmuflTimeSigFromItems([dig(1, 96, 500), dig(2, 104, 500), dig(8, 100, 480)]),
      '12/8'
    );
  });

  it('returns null without at least two stacked digit rows', () => {
    assert.equal(ctx.detectSmuflTimeSigFromItems([dig(4, 100, 500)]), null);
    assert.equal(ctx.detectSmuflTimeSigFromItems([{ str: 'Dm', x: 1, y: 1 }]), null);
    assert.equal(ctx.detectSmuflTimeSigFromItems([]), null);
  });

  it('rejects impossible denominators', () => {
    assert.equal(ctx.detectSmuflTimeSigFromItems([dig(4, 100, 500), dig(5, 100, 480)]), null);
  });
});

// ── readFileBytesReliably (iOS partial-read guard) ────────────────────────────

describe('readFileBytesReliably', () => {
  const fakeFile = (name, size, buffers) => {
    let call = 0;
    return {
      name,
      size,
      arrayBuffer: async () => buffers[Math.min(call++, buffers.length - 1)],
    };
  };

  it('returns the buffer when the read matches file.size', async () => {
    const buf = new ArrayBuffer(8);
    const file = fakeFile('song.gp5', 8, [buf]);
    assert.equal(await ctx.readFileBytesReliably(file), buf);
  });

  it('re-reads once when the first read is short, and returns the full buffer', async () => {
    const short = new ArrayBuffer(0);
    const full = new ArrayBuffer(16);
    const file = fakeFile('song.gp5', 16, [short, full]);
    assert.equal(await ctx.readFileBytesReliably(file), full);
  });

  it('throws an actionable iCloud/download message when reads stay empty', async () => {
    const file = fakeFile('song.gp5', 49255, [new ArrayBuffer(0)]);
    await assert.rejects(
      ctx.readFileBytesReliably(file),
      /empty \(0 bytes\).*iCloud Drive.*Files app/s
    );
  });

  it('throws with byte counts when reads stay incomplete', async () => {
    const file = fakeFile('song.gp5', 49255, [new ArrayBuffer(1024)]);
    await assert.rejects(ctx.readFileBytesReliably(file), /incomplete \(1024 of 49255 bytes\)/);
  });

  it('rejects a zero-byte file even when file.size is also 0', async () => {
    const file = fakeFile('empty.gp5', 0, [new ArrayBuffer(0)]);
    await assert.rejects(ctx.readFileBytesReliably(file), /empty \(0 bytes\)/);
  });
});

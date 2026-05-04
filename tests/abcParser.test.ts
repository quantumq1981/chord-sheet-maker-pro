import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAbcNotation } from '../src/parsers/abcParser.js';

/** Flatten all chord texts across every section and line. */
function allChords(doc: ReturnType<typeof parseAbcNotation>): string[] {
  const out: string[] = [];
  for (const sec of doc.sections) {
    for (const line of sec.lines) {
      for (const tok of line.tokens) {
        if (tok.kind === 'chord') out.push(tok.text);
      }
    }
  }
  return out;
}

describe('parseAbcNotation — key parsing', () => {
  it('plain major key', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:G\n|"G" c|\n');
    assert.equal(doc.key, 'G');
  });
  it('minor key', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:Am\n|"Am" c|\n');
    assert.equal(doc.key, 'Am');
  });
  it('Aeolian mode → minor key', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:AAeo\n|"Am" c|\n');
    assert.equal(doc.key, 'Am');
  });
  it('Ionian mode → major key', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:GIon\n|"G" c|\n');
    assert.equal(doc.key, 'G');
  });

  // ── Modal key → relative major ───────────────────────────────────────────
  it('D Dorian → C (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:DDor\n|"Am" c|\n');
    assert.equal(doc.key, 'C');
  });
  it('E Phrygian → C (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:EPhr\n|"C" c|\n');
    assert.equal(doc.key, 'C');
  });
  it('F Lydian → C (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:FLyd\n|"C" c|\n');
    assert.equal(doc.key, 'C');
  });
  it('G Mixolydian → C (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:GMix\n|"G" c|\n');
    assert.equal(doc.key, 'C');
  });
  it('B Locrian → C (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:BLoc\n|"C" c|\n');
    assert.equal(doc.key, 'C');
  });
  it('A Mixolydian → D (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:AMix\n|"A" c|\n');
    assert.equal(doc.key, 'D');
  });
  it('Bb Dorian → Ab (relative major)', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:BbDor\n|"Cm" c|\n');
    assert.equal(doc.key, 'Ab');
  });
});

describe('parseAbcNotation — chord extraction', () => {
  it('extracts chords from a simple tune', () => {
    const doc = parseAbcNotation(
      'X:1\nT:Test\nM:4/4\nK:C\n|"C" c d e f |"G" g f e d |"C" c2 c2 |\n'
    );
    const chords = allChords(doc);
    assert.ok(chords.includes('C'), 'Should include C');
    assert.ok(chords.includes('G'), 'Should include G');
  });

  it('ignores fingering annotations starting with ^', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:G\n|"^2" c "G" d|\n');
    const chords = allChords(doc);
    assert.deepEqual(chords, ['G']);
  });

  it('converts ABC slash chord % notation to /', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nK:C\n|"G%B" c d|\n');
    const chords = allChords(doc);
    assert.ok(chords.includes('G/B'), 'Slash chord should use /');
  });
});

describe('parseAbcNotation — multi-voice handling', () => {
  it('extracts chords from the richest voice, avoiding doubles', () => {
    // Voice 1 has chords; Voice 2 is bass/melody with none
    const abc = [
      'X:1',
      'T:Multi Voice Test',
      'M:4/4',
      'K:C',
      '[V:1] |"C" c d e f |"G" g f e d |"Am" a2 a2 |',
      '[V:2] | C, D, E, F, | G, F, E, D, | A,2 A,2 |',
    ].join('\n');
    const doc = parseAbcNotation(abc);
    const chords = allChords(doc);
    // Should get 3 chords, not 6 (no doubling from voice 2)
    assert.equal(chords.length, 3, `Expected 3 chords, got: ${chords.join(', ')}`);
    assert.ok(chords.includes('C'));
    assert.ok(chords.includes('G'));
    assert.ok(chords.includes('Am'));
  });

  it('returns full body text when no voice markers present', () => {
    const abc = 'X:1\nT:Simple\nK:G\n|"G" c |"D" d |\n';
    const doc = parseAbcNotation(abc);
    const chords = allChords(doc);
    assert.ok(chords.length >= 2);
  });

  it('picks the voice with the most chords when both have some', () => {
    const abc = [
      'X:1',
      'T:Two Chord Voices',
      'K:C',
      '[V:1] |"C" c |"G" d |"Am" e |"F" f |',
      '[V:2] |"Em" c |"Dm" d |',
    ].join('\n');
    const doc = parseAbcNotation(abc);
    const chords = allChords(doc);
    // Voice 1 has 4 chords, Voice 2 has 2 — should pick Voice 1
    assert.equal(chords.length, 4, `Expected 4 chords (voice 1), got ${chords.length}`);
  });
});

describe('parseAbcNotation — metadata', () => {
  it('parses title and composer', () => {
    const doc = parseAbcNotation('X:1\nT:My Song\nC:J. Composer\nK:G\n|\n');
    assert.equal(doc.title, 'My Song');
    assert.equal(doc.artist, 'J. Composer');
  });

  it('parses time signature M:3/4', () => {
    const doc = parseAbcNotation('X:1\nT:Waltz\nM:3/4\nK:G\n|\n');
    assert.equal(doc.time, '3/4');
  });

  it('converts M:C to 4/4', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nM:C\nK:G\n|\n');
    assert.equal(doc.time, '4/4');
  });

  it('converts M:C| to 2/2', () => {
    const doc = parseAbcNotation('X:1\nT:Test\nM:C|\nK:G\n|\n');
    assert.equal(doc.time, '2/2');
  });
});

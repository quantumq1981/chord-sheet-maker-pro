/**
 * tests/csmpnParserChordsheet.test.mjs
 *
 * Unit tests for the chordsheet.com syntax additions in csmpnParser.js:
 *   - chord-diagram definitions ("// C7 x32310[fingers]")
 *   - leading-"." chord-diagram-throughout bars blocks
 *   - three-column section text ("- lc", "- cc", "- rc", two-space columns)
 *
 * csmpnParser.js depends on tokenizeBars (chordProcessing.js), so both browser
 * scripts are loaded into one sandboxed vm context.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function makeContext() {
  const context = {
    fbSettings: {
      maj7Style: 'Maj7',
      minorStyle: 'm',
      dimStyle: 'dim',
      halfDimStyle: 'ø',
      barLines: 'visible',
    },
    validationWarnings: [],
    normalizeAccidentals: (s) => (s ?? '').replace(/♭/g, 'b').replace(/♯/g, '#').trim(),
    escapeHtml: (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;'),
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../chordProcessing.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../csmpnParser.js', import.meta.url), 'utf8'), context);
  return context;
}

const ctx = makeContext();

// vm-realm arrays/objects have a different prototype than the test realm, so
// assert.deepEqual flags them as "not reference-equal". Normalize via JSON.
const norm = (v) => JSON.parse(JSON.stringify(v));

describe('parseColumnText', () => {
  it('lc keyword places text in the left column', () => {
    assert.deepEqual(norm(ctx.parseColumnText('lc Left side')), ['Left side', '', '']);
  });
  it('cc keyword places text in the center column', () => {
    assert.deepEqual(norm(ctx.parseColumnText('cc Middle')), ['', 'Middle', '']);
  });
  it('rc keyword places text in the right column', () => {
    assert.deepEqual(norm(ctx.parseColumnText('rc Right')), ['', '', 'Right']);
  });
  it('two-or-more spaces split into left / center / right', () => {
    assert.deepEqual(norm(ctx.parseColumnText('A  B  C')), ['A', 'B', 'C']);
  });
  it('a plain single label returns null (normal section name)', () => {
    assert.equal(ctx.parseColumnText('Pre-Chorus'), null);
  });
  it('empty text returns null', () => {
    assert.equal(ctx.parseColumnText('   '), null);
  });
});

describe('parseDiagramDefinition', () => {
  it('parses frets only (low-E → high-e)', () => {
    const d = ctx.parseDiagramDefinition('C7 x32310');
    assert.equal(d.name, 'C7');
    assert.deepEqual(norm(d.frets), ['x', 3, 2, 3, 1, 0]);
    assert.equal(d.fingers, null);
  });
  it('parses frets plus fingering', () => {
    const d = ctx.parseDiagramDefinition('C7 x32310032410');
    assert.deepEqual(norm(d.frets), ['x', 3, 2, 3, 1, 0]);
    assert.deepEqual(norm(d.fingers), [0, 3, 2, 4, 1, 0]);
  });
  it('returns null for malformed input', () => {
    assert.equal(ctx.parseDiagramDefinition('C7'), null);
    assert.equal(ctx.parseDiagramDefinition('x32310'), null);
  });
});

describe('parseCSMPN — chordsheet.com features', () => {
  it('// lines collect chord-diagram definitions onto doc.diagrams', () => {
    const doc = ctx.parseCSMPN('// C7 x32310\n// G 320003\nC7 G');
    assert.ok(doc.diagrams);
    assert.deepEqual(norm(doc.diagrams.C7.frets), ['x', 3, 2, 3, 1, 0]);
    assert.deepEqual(norm(doc.diagrams.G.frets), [3, 2, 0, 0, 0, 3]);
    // // lines are consumed, not emitted as bars
    assert.equal(doc.blocks.filter((b) => b.type === 'bars').length, 1);
  });

  it('a leading "." marks the bars block diagrams=true and strips the dot', () => {
    const doc = ctx.parseCSMPN('. C Am F G');
    const bars = doc.blocks.find((b) => b.type === 'bars');
    assert.ok(bars);
    assert.equal(bars.diagrams, true);
    // dot is not tokenised as a bar
    assert.ok(!bars.tokens.includes('.'));
    assert.ok(bars.tokens.includes('C'));
  });

  it('section markers parse three-column text', () => {
    const doc = ctx.parseCSMPN('- lc Capo 2\n: A  B  C\n- Verse');
    const markers = doc.blocks.filter((b) => b.type === 'marker');
    assert.deepEqual(norm(markers[0].columns), ['Capo 2', '', '']);
    assert.deepEqual(norm(markers[1].columns), ['A', 'B', 'C']);
    // a plain section name keeps no columns (back-compat label box)
    assert.ok(!markers[2].columns);
    assert.equal(markers[2].text, 'Verse');
  });

  it('a plain chart still parses with no diagrams field forced on bars', () => {
    const doc = ctx.parseCSMPN('Title: Song\n- Verse\nC F G C');
    const bars = doc.blocks.find((b) => b.type === 'bars');
    assert.ok(!bars.diagrams);
    assert.equal(doc.title, 'Song');
  });

  it('== double-equals is a boxed section, stripping both leading =', () => {
    const doc = ctx.parseCSMPN('== 1st Ending\nCm7_Dm7 | EbMaj7_Edim7 |');
    const marker = doc.blocks.find((b) => b.type === 'marker');
    assert.equal(marker.marker, '=');
    assert.equal(marker.text, '1st Ending');
  });
});

// ── Real chordsheet.com source: "Sin City Blues" (reference chart) ────────────
// Verifies the parser handles the exact native chordsheet.com export verbatim.

describe('parseCSMPN — real Sin City Blues chordsheet.com source', () => {
  const SRC = [
    'Title: Sin City Blues',
    'Composer: CZemba',
    'Style: Jazz swing',
    'Key: Bb',
    'Tempo: 81',
    '= Intro',
    'Bb7 | Bb7_A7_D7 |',
    'Eb6 | Edim7_Gdim7 |',
    'C7_F9_F7(13) |',
    'Bb7 | Faug ||',
    '= "A"',
    '= Verse 1',
    'Bb7 % | Eb7 % |',
    'Bb7 B7 | Bb7 % ||',
    '= Chorus 1',
    'F9 | F♯9_F9 |',
    '== 1st Ending',
    'Cm7_Dm7 | EbMaj7_Edim7 |',
    'Bb7_A7_Ab7_G7 ||',
    '== 2nd Ending',
    'F9_F13 ||',
    '= CODA',
    'Bb7_Bb6_Eb9 | Bb_B13_Bb7 ||',
  ].join('\n');

  it('extracts header metadata', () => {
    const doc = ctx.parseCSMPN(SRC);
    assert.equal(doc.title, 'Sin City Blues');
    assert.equal(doc.composer, 'CZemba');
    assert.equal(doc.key, 'Bb');
    assert.equal(doc.tempo, '81');
  });

  it('parses all section markers including == endings and "quoted" names', () => {
    const doc = ctx.parseCSMPN(SRC);
    const labels = doc.blocks.filter((b) => b.type === 'marker').map((m) => m.text);
    assert.ok(labels.includes('Intro'));
    assert.ok(labels.includes('"A"'));
    assert.ok(labels.includes('1st Ending'));
    assert.ok(labels.includes('2nd Ending'));
    assert.ok(labels.includes('CODA'));
  });

  it('preserves split bars and parenthesised extensions (F7(13)) without warnings', () => {
    ctx.validationWarnings.length = 0;
    const doc = ctx.parseCSMPN(SRC);
    const introBars = ctx.parseBarStructures(doc.blocks.filter((b) => b.type === 'bars')[0].tokens);
    // "Bb7 | Bb7_A7_D7 |" → two bars; the second is a 3-chord split
    assert.equal(introBars[0].token, 'Bb7');
    assert.equal(introBars[1].token, 'Bb7_A7_D7');
    // the parser leaves the parenthesised extension intact in its bar token
    const allTokens = doc.blocks.filter((b) => b.type === 'bars').flatMap((b) => b.tokens);
    assert.ok(allTokens.some((t) => t.includes('F7(13)')));
    assert.equal(ctx.validationWarnings.length, 0);
  });
});

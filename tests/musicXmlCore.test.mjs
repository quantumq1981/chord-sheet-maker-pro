import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadCore() {
  const src = readFileSync(new URL('../musicXmlCore.js', import.meta.url), 'utf8');
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

test('mxChordKind maps the common qualities', () => {
  const { mxChordKind } = loadCore();
  assert.equal(mxChordKind(''), 'major');
  assert.equal(mxChordKind('m'), 'minor');
  assert.equal(mxChordKind('m7'), 'minor-seventh');
  assert.equal(mxChordKind('maj7'), 'major-seventh');
  assert.equal(mxChordKind('7'), 'dominant');
  assert.equal(mxChordKind('9'), 'dominant');
  assert.equal(mxChordKind('m7b5'), 'half-diminished');
  assert.equal(mxChordKind('dim7'), 'diminished-seventh');
  assert.equal(mxChordKind('o7'), 'diminished-seventh');
  assert.equal(mxChordKind('aug7'), 'augmented-seventh');
  assert.equal(mxChordKind('sus4'), 'suspended-fourth');
  assert.equal(mxChordKind('sus2'), 'suspended-second');
  assert.equal(mxChordKind('6'), 'major-sixth');
});

test('mxKeyFifths returns sharps (+) and flats (-) for major and minor', () => {
  const { mxKeyFifths } = loadCore();
  assert.equal(mxKeyFifths('C'), 0);
  assert.equal(mxKeyFifths('G'), 1);
  assert.equal(mxKeyFifths('D'), 2);
  assert.equal(mxKeyFifths('F'), -1);
  assert.equal(mxKeyFifths('Eb'), -3);
  assert.equal(mxKeyFifths('Am'), 0);
  assert.equal(mxKeyFifths('Em'), 1);
  assert.equal(mxKeyFifths('G major'), 1);
  assert.equal(mxKeyFifths('B♭'), -2);
  assert.equal(mxKeyFifths(''), 0);
  assert.equal(mxKeyFifths('Zphr'), 0);
});

test('mxKeyMode detects minor vs major', () => {
  const { mxKeyMode } = loadCore();
  assert.equal(mxKeyMode('C'), 'major');
  assert.equal(mxKeyMode('G major'), 'major');
  assert.equal(mxKeyMode('Am'), 'minor');
  assert.equal(mxKeyMode('F#m'), 'minor');
  assert.equal(mxKeyMode('D minor'), 'minor');
  assert.equal(mxKeyMode(''), 'major');
});

test('mxHarmony emits root, alter, kind, bass and offset', () => {
  const { mxHarmony } = loadCore();
  assert.ok(mxHarmony('Am7', 0).includes('<root-step>A</root-step>'));
  assert.ok(mxHarmony('Am7', 0).includes('<kind>minor-seventh</kind>'));
  const slash = mxHarmony('D/F#', 8);
  assert.ok(slash.includes('<bass><bass-step>F</bass-step><bass-alter>1</bass-alter></bass>'));
  assert.ok(slash.includes('<offset>8</offset>'));
  assert.ok(mxHarmony('Bb', 0).includes('<alter>-1</alter>'));
  assert.equal(mxHarmony('not-a-chord', 0), '');
});

test('mxScoreDoc wraps measures with title/composer', () => {
  const { mxScoreDoc } = loadCore();
  const doc = mxScoreDoc('Demo', 'Me', '<measure/>');
  assert.ok(doc.includes('<score-partwise version="4.0">'));
  assert.ok(doc.includes('<movement-title>Demo</movement-title>'));
  assert.ok(doc.includes('<creator type="composer">Me</creator>'));
  assert.ok(mxScoreDoc('', '', '').includes('<movement-title>Untitled</movement-title>'));
});

test('mxEsc escapes XML metacharacters', () => {
  const { mxEsc } = loadCore();
  assert.equal(mxEsc('a&b<c>"d\''), 'a&amp;b&lt;c&gt;&quot;d&#039;');
});

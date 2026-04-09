import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVexFlowBlock, supportsEnhancedVexflowSyntax } from '../src/utils/vexflowNotation.js';

test('legacy single-bar snippets stay valid', () => {
  const parsed = parseVexFlowBlock('C4/q, D4/q, E4/q, F4/q');
  assert.equal(parsed.clef, 'treble');
  assert.equal(parsed.timeSig, '4/4');
  assert.equal(parsed.measures.length, 1);
  assert.equal(parsed.measures[0].events.length, 4);
  assert.equal(parsed.measures[0].events[0].type, 'note');
});

test('enhanced syntax parses chords, rests, tempo and ties', () => {
  const parsed = parseVexFlowBlock(
    '[4/4] bass: tempo="Allegro" C3/q[chord="Cm7",dyn="mf"] qr | <C3 E3 G3>/h^ <C3 E3 G3>/h'
  );
  assert.equal(parsed.clef, 'bass');
  assert.equal(parsed.tempo, 'Allegro');
  assert.equal(parsed.measures.length, 2);
  assert.equal(parsed.measures[0].events[0].modifiers.chord, 'Cm7');
  assert.equal(parsed.measures[0].events[0].modifiers.dyn, 'mf');
  assert.equal(parsed.measures[0].events[1].type, 'rest');
  assert.equal(parsed.measures[1].events[0].type, 'chord');
  assert.equal(parsed.measures[1].events[0].tie, true);
});

test('modifiers parse articulations, lyrics, text and grace notes', () => {
  const parsed = parseVexFlowBlock(
    'C4/8[staccato,lyric="Hel",grace="D4/16 E4/16"] D4/8[text="rit."]'
  );
  const [first, second] = parsed.measures[0].events;
  assert.deepEqual(first.modifiers.articulations, ['staccato']);
  assert.equal(first.modifiers.lyric, 'Hel');
  assert.equal(first.modifiers.grace.length, 2);
  assert.equal(second.modifiers.text, 'rit.');
});

test('supportsEnhancedVexflowSyntax rejects malformed tokens', () => {
  assert.equal(supportsEnhancedVexflowSyntax('C4/q'), true);
  assert.equal(supportsEnhancedVexflowSyntax('not-a-note-token'), false);
  assert.throws(() => parseVexFlowBlock('not-a-note-token'), /Unsupported notation token/);
});

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

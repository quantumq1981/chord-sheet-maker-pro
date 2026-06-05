import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads the shared MusicXML core + the ChordSlashML browser bundle into one
// sandbox and returns window.csml. The bundle is an IIFE that only touches the
// DOM through stubs, and dispatches a 'csmlready' event on load.
function loadCsml() {
  const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const ctx = {
    window: { dispatchEvent() {}, addEventListener() {} },
    document: {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(read('musicXmlCore.js'), ctx);
  vm.runInContext(read('chordSlashMLRenderer.js'), ctx);
  return ctx.window.csml;
}

const SAMPLE =
  'Title: My Song\nComposer: Me\nKey: F\nTime: 4/4\nTempo: 120\n\n' +
  '[Verse]\n| Dm7 _ G7 _ | Cmaj7 _ _ _ | Am7 _ D7 _ | Gm7 _ C7 _ |\n\n' +
  '[Chorus]\n|: F _ _ _ | Bb _ _ _ | C7 _ _ _ | F _ _ _ :|\n';

test('csml.toMusicXml emits a score-partwise document with metadata', () => {
  const csml = loadCsml();
  const xml = csml.toMusicXml(SAMPLE);
  assert.ok(xml.includes('<score-partwise version="4.0">'));
  assert.ok(xml.includes('<movement-title>My Song</movement-title>'));
  assert.ok(xml.includes('<creator type="composer">Me</creator>'));
});

test('csml MusicXML uses the shared core for key sig + chord kinds', () => {
  const csml = loadCsml();
  const xml = csml.toMusicXml(SAMPLE);
  // Key of F → 1 flat, major (via mxKeyFifths/mxKeyMode)
  assert.ok(xml.includes('<fifths>-1</fifths><mode>major</mode>'));
  // Chord kinds via mxChordKind
  assert.ok(xml.includes('<kind>minor-seventh</kind>'), 'Dm7 → minor-seventh');
  assert.ok(xml.includes('<kind>major-seventh</kind>'), 'Cmaj7 → major-seventh');
  assert.ok(xml.includes('<kind>dominant</kind>'), 'G7 → dominant');
  // 11 chord changes across the two sections
  assert.equal((xml.match(/<harmony>/g) || []).length, 11);
});

test('csml MusicXML emits repeat barlines for |: :| sections', () => {
  const csml = loadCsml();
  const xml = csml.toMusicXml(SAMPLE);
  assert.ok(xml.includes('<repeat direction="forward"/>'));
  assert.ok(xml.includes('<repeat direction="backward"/>'));
});

test('header-only input still yields a well-formed score with no harmonies', () => {
  const csml = loadCsml();
  const xml = csml.toMusicXml('Title: Nothing\n');
  assert.ok(xml.includes('<score-partwise version="4.0">'));
  assert.equal((xml.match(/<harmony>/g) || []).length, 0);
});

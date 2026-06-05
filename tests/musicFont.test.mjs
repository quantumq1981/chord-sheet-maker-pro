import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');

// Load musicFont.js alone (plus a minimal DOM stub) and return window.MusicFont.
function loadMusicFont() {
  const injected = [];
  const ctx = {
    window: {},
    document: {
      head: { appendChild: (c) => injected.push(c) },
      getElementById: () => null,
      createElement: () => ({
        set textContent(v) {
          this._t = v;
        },
        get textContent() {
          return this._t;
        },
      }),
    },
    console,
  };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(read('musicFont.js'), ctx);
  return { ctx, injected };
}

test('musicFont exposes family, faceCss and a woff2 data URI', () => {
  const { ctx } = loadMusicFont();
  const mf = ctx.window.MusicFont;
  assert.equal(mf.family, 'CSMPN Music');
  assert.equal(ctx.window.MUSIC_FONT_FAMILY, 'CSMPN Music');
  assert.ok(mf.faceCss.includes('@font-face'));
  assert.ok(mf.faceCss.includes("font-family:'CSMPN Music'"));
  assert.ok(mf.dataUri.startsWith('data:font/woff2;base64,'));
  // woff2 files start with the ASCII signature "wOF2" → base64 prefix "d09GMg".
  const b64 = mf.dataUri.split('base64,')[1];
  assert.ok(b64.startsWith('d09GMg'), 'data URI should carry a real woff2 payload');
  assert.ok(b64.length > 1000, 'embedded font should be non-trivial');
});

test('musicFont injects an @font-face <style> into the document head exactly once', () => {
  const { injected } = loadMusicFont();
  const faces = injected.filter((c) => /@font-face/.test(c.textContent || ''));
  assert.equal(faces.length, 1);
});

// Full render stack WITH musicFont.js loaded — both SVG engines must embed the
// @font-face and lead the clef/accidental font-family with the music family so
// the glyphs render in downloads and the iOS print-to-PDF popup.
function loadStack() {
  const ctx = {
    window: {},
    document: {
      head: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({
        click() {},
        setAttribute() {},
        style: {},
        set textContent(v) {
          this._t = v;
        },
        get textContent() {
          return this._t;
        },
      }),
      querySelector: () => null,
      body: { appendChild() {} },
    },
    fbSettings: { fgColor: '#111', bgColor: '#fff', chordColor: '#0044cc', barsPerRow: 4 },
    validationWarnings: [],
    notationPreference: 'sharp',
    CustomEvent: class {
      constructor(t) {
        this.type = t;
      }
    },
    console,
  };
  ctx.window.document = ctx.document;
  ctx.window.dispatchEvent = () => {};
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of [
    'utils.js',
    'chordProcessing.js',
    'csmpnParser.js',
    'settings.js',
    'musicFont.js',
    'musicXmlCore.js',
    'renderer.js',
    'importPipeline.js',
    'chordSlashMLRenderer.js',
  ])
    vm.runInContext(read(f), ctx);
  return ctx;
}

test('Slash-Rhythm View SVG embeds the @font-face and leads the clef with CSMPN Music', () => {
  const ctx = loadStack();
  const svg = ctx.renderHybridDoc('Title: T\nKey: G\nTime: 4/4\n\n- A\n| G | C | D | G |\n');
  assert.ok(svg.includes('@font-face') && svg.includes('data:font/woff2'), 'embeds the font');
  assert.ok(
    svg.includes('font-family=\'"CSMPN Music",') && svg.includes('&#x1D11E;'),
    'clef leads with music font'
  );
  // renderCsmpnToSvg (used by the Setlist printer) must keep the embedded font.
  assert.ok(
    ctx.window.renderCsmpnToSvg('Title: T\nKey: G\n\n- A\n| G | C |\n').includes('@font-face')
  );
});

test('ChordSlashML editor SVG embeds the @font-face and uses CSMPN Music for clef + accidentals', () => {
  const ctx = loadStack();
  const opts = {
    fgColor: '#111',
    bgColor: '#fff',
    chordColor: '#04c',
    chordFont: 'serif',
    chordFontSize: 13,
    stems: true,
    rawChords: false,
    chordAlign: 'center',
    mpr: 4,
    keySig: 'G',
  };
  const svg = ctx.window.csml.toSvg(
    'Title: T\nKey: G\nTime: 4/4\n\n[A]\n| G _ _ _ | C _ _ _ |\n',
    opts
  );
  assert.ok(svg.includes('@font-face') && svg.includes('data:font/woff2'), 'embeds the font');
  assert.ok(
    svg.includes('font-family=\'"CSMPN Music", serif\'') && svg.includes('𝄞'),
    'clef uses music font'
  );
  assert.ok(/CSMPN Music", serif'[^>]*>♯/.test(svg), 'key-sig sharp uses music font');
});

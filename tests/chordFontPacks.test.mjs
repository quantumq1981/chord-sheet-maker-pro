import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Loads the settings stack into one sandbox. CHORD_FONT_PACK_MAP is a top-level
// const (not exposed on the context in vm), so packs are read through the
// getChordFontPackConfig() function declaration, and --fb-chord-font is observed
// by capturing document.documentElement.style.setProperty() during applyFBSettings.
function loadSettings() {
  const root = new URL('..', import.meta.url);
  const read = (f) => readFileSync(new URL(f, root), 'utf8');
  const props = {};
  const ctx = {
    window: {},
    console,
    localStorage: {
      setItem() {},
      getItem() {
        return null;
      },
    },
    document: {
      documentElement: {
        style: {
          setProperty: (k, v) => {
            props[k] = v;
          },
        },
      },
      querySelector: () => null,
      getElementById: () => null,
    },
    updatePreview: () => {},
  };
  vm.createContext(ctx);
  for (const f of [
    'utils.js',
    'chordProcessing.js',
    'csmpnParser.js',
    'settings.js',
    'musicFont.js',
  ])
    vm.runInContext(read(f), ctx);
  return { ctx, props };
}

const PACKS = ['default', 'pori', 'norfolk', 'norfolksans'];
const FIELDS = ['fakeBookChordFont', 'notationFont'];

test('every font pack ends each stack with the embedded music-glyph font (♭/♯ always render)', () => {
  const { ctx } = loadSettings();
  for (const p of PACKS) {
    const cfg = ctx.getChordFontPackConfig(p);
    for (const f of FIELDS) {
      assert.ok(
        cfg[f].endsWith('"CSMPN Music"'),
        `${p}.${f} should end with the music font, got: ${cfg[f]}`
      );
    }
  }
});

test('no font pack references a never-loaded phantom font (FreeSerif / Segoe UI Symbol / Noto Music name)', () => {
  const { ctx } = loadSettings();
  for (const p of PACKS) {
    const blob = JSON.stringify(ctx.getChordFontPackConfig(p));
    assert.doesNotMatch(
      blob,
      /FreeSerif|Segoe UI Symbol|Noto Music/,
      `${p} still references a phantom font`
    );
  }
});

test('every pack falls back to a guaranteed-available base (EB Garamond serif or Helvetica sans)', () => {
  const { ctx } = loadSettings();
  for (const p of PACKS) {
    const cfg = ctx.getChordFontPackConfig(p);
    for (const f of FIELDS) {
      assert.match(
        cfg[f],
        /EB Garamond|Helvetica|Arial/,
        `${p}.${f} lacks a reliable base: ${cfg[f]}`
      );
    }
  }
});

test('Pori/Norfolk packs lead with their installable SIL-OFL chord font (angled slash when present)', () => {
  const { ctx } = loadSettings();
  assert.ok(
    ctx.getChordFontPackConfig('pori').fakeBookChordFont.startsWith('"Pori Chords ASC Std"')
  );
  assert.ok(
    ctx.getChordFontPackConfig('norfolk').fakeBookChordFont.startsWith('"Norfolk Chords ASC Std"')
  );
  assert.ok(
    ctx
      .getChordFontPackConfig('norfolksans')
      .fakeBookChordFont.startsWith('"Norfolk Chords Sans ASC Std"')
  );
});

test('norfolksans is a sans-serif pack; default/pori/norfolk are serif', () => {
  const { ctx } = loadSettings();
  assert.match(ctx.getChordFontPackConfig('norfolksans').fakeBookChordFont, /Helvetica/);
  assert.match(ctx.getChordFontPackConfig('pori').fakeBookChordFont, /EB Garamond/);
  assert.match(ctx.getChordFontPackConfig('norfolk').notationFont, /EB Garamond/);
});

test('applyFBSettings always appends the music font to --fb-chord-font (accidentals covered)', () => {
  const { ctx, props } = loadSettings();
  ctx.applyFBSettings(); // default pack
  assert.ok(
    props['--fb-chord-font'].endsWith('"CSMPN Music"'),
    `--fb-chord-font should end with the music font, got: ${props['--fb-chord-font']}`
  );
});

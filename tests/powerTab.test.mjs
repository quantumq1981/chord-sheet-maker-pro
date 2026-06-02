/**
 * Power Tab (.ptb) importer — Phase A tests.
 *
 * Loads powerTabImporter.js into a vm context (matching the importGuitarPro.js
 * test pattern) and exercises the MFC reader + header parser + tuning
 * extraction against a committed, copyright-safe fixture: "A Major Shape
 * Arpeggio" (a generic scale exercise, not a song transcription).
 *
 * The fixture has empty song title/artist, so those assertions also confirm the
 * MFC CString reader handles zero-length strings correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadPtb() {
  const src = readFileSync(new URL('../powerTabImporter.js', import.meta.url), 'utf8');
  const context = { console };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context._PTB_TEST_EXPORTS;
}

function fixtureBytes() {
  return new Uint8Array(
    readFileSync(new URL('./fixtures/a-major-shape-arpeggio.ptb', import.meta.url))
  );
}

test('PtbReader: MFC primitives (u8/u16/u32, CString, count)', () => {
  const { PtbReader } = loadPtb();
  // Bytes: u8=0x01, u16=0x0302, u32=0x07060504, then CString "Hi" (len 2).
  const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x02, 0x48, 0x69]);
  const r = new PtbReader(buf);
  assert.equal(r.readU8(), 0x01);
  assert.equal(r.readU16(), 0x0302);
  assert.equal(r.readU32(), 0x07060504);
  assert.equal(r.readString(), 'Hi');
  assert.ok(r.eof());
});

test('PtbReader.readCount: extended 0xFF -> u16 length form', () => {
  const { PtbReader } = loadPtb();
  // 0xFF then u16 = 300, so readCount() === 300.
  const buf = new Uint8Array([0xff, 0x2c, 0x01]);
  const r = new PtbReader(buf);
  assert.equal(r.readCount(), 300);
});

test('PtbReader.readClass: new-class descriptor then back-reference', () => {
  const { PtbReader } = loadPtb();
  const loaded = [];
  // new class: FFFF, schema 0001, len 0007, "CGuitar"
  const newClass = [0xff, 0xff, 0x01, 0x00, 0x07, 0x00];
  for (const ch of 'CGuitar') newClass.push(ch.charCodeAt(0));
  // back-reference to class index 1 (low 15 bits = 1)
  const backRef = [0x01, 0x80];
  const r = new PtbReader(new Uint8Array(newClass.concat(backRef)));
  assert.equal(r.readClass(loaded), 'CGuitar');
  assert.deepEqual(loaded, ['CGuitar']);
  assert.equal(r.readClass(loaded), 'CGuitar'); // resolved back-ref
});

test('parsePowerTabHeader: magic + version on the fixture', () => {
  const { parsePowerTabHeader } = loadPtb();
  const h = parsePowerTabHeader(fixtureBytes());
  assert.equal(h.magic, 'ptab');
  assert.equal(h.version, 4); // Power Tab 1.7 file format
  assert.equal(h.fileType, 0); // song
});

test('parsePowerTabHeader: exercise fixture has empty title/artist', () => {
  const { parsePowerTabHeader } = loadPtb();
  const h = parsePowerTabHeader(fixtureBytes());
  assert.equal(h.title, '');
  assert.equal(h.artist, '');
});

test('parsePowerTabHeader: rejects non-ptab data', () => {
  const { parsePowerTabHeader } = loadPtb();
  assert.throws(() => parsePowerTabHeader(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), /Power Tab/);
});

test('extractTunings: finds standard 6-string guitar tuning (E B G D A E)', () => {
  const { extractTunings } = loadPtb();
  const tunings = extractTunings(fixtureBytes());
  assert.ok(tunings.length >= 1, 'at least one tuning');
  const std = tunings.find((t) => t.notes.join(' ') === 'E4 B3 G3 D3 A2 E2');
  assert.ok(std, 'standard guitar tuning present');
  assert.equal(std.strings, 6);
  // std.midi is built inside the vm realm, so compare by value (not deepStrictEqual).
  assert.equal(std.midi.join(','), '64,59,55,50,45,40');
});

test('inspectPowerTab: reports header + at least the core music classes', () => {
  const { inspectPowerTab } = loadPtb();
  const info = inspectPowerTab(fixtureBytes());
  assert.equal(info.header.magic, 'ptab');
  // Core PowerTab classes appear as new-class descriptors.
  assert.ok(info.classes.CGuitar >= 1);
  assert.ok(info.classes.CStaff >= 1);
  assert.ok(info.classes.CPosition >= 1);
});

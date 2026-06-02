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

// ── Phase B: full structural parse ──────────────────────────────────────────

test('parsePowerTab: consumes the whole file (byte alignment is correct)', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  assert.equal(m.version, 4);
  // A correct parse reaches both tracks and leaves only the small fixed trailer.
  assert.ok(m.complete, 'parse should be complete (trailer=' + m.trailerBytes + ')');
  assert.ok(m.trailerBytes >= 0 && m.trailerBytes <= 256);
});

test('parsePowerTab: two tracks (guitar score + bass score) with tunings', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  assert.equal(m.tracks.length, 2);
  assert.ok(m.tracks[0].infos.length >= 1, 'guitar score has >=1 guitar');
  const g = m.tracks[0].infos[0];
  assert.equal(g.tuningNotes.join(','), 'E4,B3,G3,D3,A2,E2'); // standard tuning
  assert.equal(g.capo, 0);
});

test('parsePowerTab: extracts sections, bars, and beats with valid notes', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  let beats = 0;
  let notes = 0;
  let bars = 0;
  for (const tr of m.tracks) {
    for (const s of tr.sections) {
      bars += s.barLines.length;
      for (const b of s.beats) {
        beats++;
        for (const n of b.notes) {
          notes++;
          // Every note must have a valid guitar string and fret.
          assert.ok(n.string >= 1 && n.string <= 7, 'string in range: ' + n.string);
          assert.ok(n.fret >= 0 && n.fret <= 31, 'fret in range: ' + n.fret);
        }
      }
    }
  }
  assert.ok(bars >= 1, 'has bars');
  assert.ok(beats >= 1, 'has beats');
  assert.ok(notes >= 1, 'has notes');
});

test('parsePowerTab: bar lines carry a time signature', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  const firstBar = m.tracks[0].sections.flatMap((s) => s.barLines).find((b) => b.numerator > 0);
  assert.ok(firstBar, 'at least one bar with a time signature');
  assert.ok(firstBar.numerator >= 1 && firstBar.numerator <= 32);
  assert.ok([1, 2, 4, 8, 16, 32].includes(firstBar.denominator));
});

test('parsePowerTab: beats carry tuplet enters/times (1:1 for plain beats)', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  const beats = m.tracks[0].sections.flatMap((s) => s.beats);
  assert.ok(beats.length > 0, 'has beats');
  for (const b of beats) {
    assert.ok(Number.isInteger(b.tupletEnters) && b.tupletEnters >= 1, 'tupletEnters int >=1');
    assert.ok(Number.isInteger(b.tupletTimes) && b.tupletTimes >= 1, 'tupletTimes int >=1');
  }
  // The arpeggio exercise has no tuplets — every beat should decode to 1:1.
  assert.ok(beats.every((b) => b.tupletEnters === 1 && b.tupletTimes === 1));
});

// ── Phase C: clean musical model ─────────────────────────────────────────────

test('powerTabToMeasures: builds measures with tuning, time sig and notes', () => {
  const { parsePowerTab, powerTabToMeasures } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  const model = powerTabToMeasures(m.tracks[0]);
  assert.equal(model.tuningNotes.join(','), 'E4,B3,G3,D3,A2,E2');
  assert.equal(model.capo, 0);
  assert.ok(model.measures.length >= 1, 'has measures');
  const first = model.measures[0];
  assert.equal(first.numerator, 4);
  assert.equal(first.denominator, 4);
  // voices[0] is the primary voice; each note has a valid string/fret/midi.
  const beats = first.voices[0];
  assert.ok(beats.length >= 1, 'first measure has beats');
  for (const beat of beats) {
    assert.ok([1, 2, 4, 8, 16, 32, 64].includes(beat.duration), 'valid duration');
    for (const n of beat.notes) {
      assert.ok(n.string >= 1 && n.string <= 7, 'string in range');
      assert.ok(n.fret >= 0 && n.fret <= 31, 'fret in range');
      assert.ok(typeof n.midi === 'number' && n.midi > 0, 'sounding midi computed');
    }
  }
});

test('beatDurDivisions: quarter/half/dotted/triplet are exact', () => {
  const { beatDurDivisions } = loadPtb();
  const Q = 960;
  assert.equal(beatDurDivisions({ duration: 4 }), Q); // quarter
  assert.equal(beatDurDivisions({ duration: 2 }), 2 * Q); // half
  assert.equal(beatDurDivisions({ duration: 1 }), 4 * Q); // whole
  assert.equal(beatDurDivisions({ duration: 8 }), Q / 2); // eighth
  assert.equal(beatDurDivisions({ duration: 4, dotted: true }), Q * 1.5); // dotted quarter
  // triplet eighth (3 in the time of 2): 480 * 2/3 = 320
  assert.equal(beatDurDivisions({ duration: 8, tupletEnters: 3, tupletTimes: 2 }), 320);
});

test('powerTabToMeasures: fixture measures sum to their time signature', () => {
  const { parsePowerTab, powerTabToMeasures, beatDurDivisions } = loadPtb();
  const model = powerTabToMeasures(parsePowerTab(fixtureBytes()).tracks[0]);
  const Q = 960;
  for (const meas of model.measures) {
    const target = (meas.numerator * Q * 4) / meas.denominator;
    const sum = meas.voices[0].reduce((t, b) => t + beatDurDivisions(b), 0);
    assert.ok(Math.abs(sum - target) < 1, `measure sums to ${target} (got ${sum})`);
  }
});

// ── Phase D: AlphaTex render ─────────────────────────────────────────────────

test('powerTabToAlphaTex: emits tuning, time sig, separators and note tokens', () => {
  const { parsePowerTab, powerTabToMeasures, powerTabToAlphaTex } = loadPtb();
  const model = powerTabToMeasures(parsePowerTab(fixtureBytes()).tracks[0]);
  const tex = powerTabToAlphaTex(model, { title: 'Test', tempo: 120 });
  assert.match(tex, /\\title "Test"/);
  assert.match(tex, /\\tempo 120/);
  assert.match(tex, /\\tuning e4 b3 g3 d3 a2 e2/);
  assert.match(tex, /\n\.\n/); // metadata terminator
  assert.match(tex, /\\ts 4 4/);
  assert.match(tex, /\|/); // bar separators
  assert.match(tex, /\d+\.\d+\.\d+/); // fret.string.duration token
  assert.ok(!/undefined|NaN|null/.test(tex), 'no malformed tokens');
});

test('powerTabToRender: top-level entry produces tex + bar/section counts', () => {
  const { powerTabToRender } = loadPtb();
  const r = powerTabToRender(fixtureBytes(), {});
  assert.ok(r.complete, 'parse complete');
  assert.ok(r.bars >= 1, 'has bars');
  assert.ok(typeof r.tex === 'string' && r.tex.length > 0, 'has tex');
  assert.match(r.tex, /\\tuning/);
});

// ── Phase E: chord-key decode + CSMPN chart ──────────────────────────────────

test('decodeChord: decodes ChordName bitfields to display names', () => {
  const { decodeChord } = loadPtb();
  // Real values observed in the corpus + spec-derived cases.
  assert.equal(decodeChord(0x1919, 0xc1, 0x0000), 'Am');
  assert.equal(decodeChord(0x1b1b, 0xc1, 0x0000), 'Bm');
  assert.equal(decodeChord(0x1717, 0xc0, 0x0000), 'G');
  assert.equal(decodeChord(0x141b, 0xc4, 0x0000), 'E5/B'); // power chord w/ bass
  assert.equal(decodeChord(0x1919, 0xc9, 0x0000), 'Am7');
  assert.equal(decodeChord(0x1010, 0x00, 0x0000), 'C');
  assert.equal(decodeChord(0x1010, 0x08, 0x0000), 'Cmaj7');
  assert.equal(decodeChord(0x1010, 0x0d, 0x0000), 'Cm7b5');
  assert.equal(decodeChord(0x1010, 0x07, 0x0001), 'C9'); // dominant7 + extended9th
  assert.equal(decodeChord(0x1010, 0x07, 0x8000), 'C7sus4'); // + suspended4th
  assert.equal(decodeChord(0x1010, 0x10, 0x0000), 'N.C.'); // noChord flag
});

test('powerTabToChart: builds a CSMPN chart with header and bar rows', () => {
  const { powerTabToChart } = loadPtb();
  const chart = powerTabToChart(fixtureBytes(), { barsPerRow: 4 });
  assert.ok(chart.bars >= 1, 'has bars');
  assert.ok(typeof chart.csmpn === 'string' && chart.csmpn.length > 0);
  assert.match(chart.csmpn, /Time: 4\/4/);
  assert.match(chart.csmpn, /\n- .+\n/); // at least one section marker
  assert.match(chart.csmpn, /\| .* \|/); // at least one bar row
  // The arpeggio exercise has no chord-text annotations → all bars are N.C.
  assert.equal(chart.chordCount, 0);
  assert.match(chart.csmpn, /N\.C\./);
});

// ── Section labels (PowerTab rehearsal signs → CSMPN section headers) ─────────

test('rehearsalLabel: decodes rehearsal signs and ignores unused ones', () => {
  const { rehearsalLabel } = loadPtb();
  assert.equal(rehearsalLabel({ letter: 0x41, desc: 'Intro' }), 'Intro');
  assert.equal(rehearsalLabel({ letter: 0x43, desc: '  Pre-Chorus ' }), 'Pre-Chorus'); // trimmed
  assert.equal(rehearsalLabel({ letter: 0x42, desc: '' }), 'B'); // letter fallback
  assert.equal(rehearsalLabel({ letter: 0x7f, desc: '' }), null); // unused sentinel
  assert.equal(rehearsalLabel(null), null);
});

test('powerTabToChart: emits section headers from rehearsal signs', () => {
  const { powerTabToChart } = loadPtb();
  const chart = powerTabToChart(fixtureBytes(), { barsPerRow: 4 });
  // The exercise fixture labels each position as its own rehearsal section.
  assert.ok(chart.sections >= 2, 'multiple sections detected');
  const headers = chart.csmpn.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(headers.length, chart.sections, 'one header per section');
  assert.ok(
    headers.some((h) => h === '- B') && headers.some((h) => h === '- C'),
    'note-named sections present'
  );
});

// ── Phase F: desync robustness ───────────────────────────────────────────────

test('PtbReader: reading past the end of the stream throws (no silent overrun)', () => {
  const { PtbReader } = loadPtb();
  const r = new PtbReader(new Uint8Array([0x01, 0x02]));
  assert.equal(r.readU16(), 0x0201);
  assert.throws(() => r.readU8(), /past end|desync/);
});

test('parsePowerTab: a truncated body fails cleanly instead of overrunning', () => {
  const { parsePowerTab } = loadPtb();
  const full = fixtureBytes();
  // Keep the valid "ptab" magic + version but cut the structural body short.
  const truncated = full.slice(0, 64);
  assert.throws(() => parsePowerTab(truncated), /past end|desync/);
});

test('parsePowerTab: the good fixture still parses complete (no false desync)', () => {
  const { parsePowerTab } = loadPtb();
  const m = parsePowerTab(fixtureBytes());
  assert.ok(m.complete, 'fixture parse remains complete');
  assert.ok(m.bytesConsumed <= m.fileSize, 'no overrun on a good file');
});

test('powerTabToAlphaTex: dead notes render x.string, tied notes render -.string', () => {
  const { powerTabToAlphaTex } = loadPtb();
  const model = {
    tuningNotes: ['E4', 'B3', 'G3', 'D3', 'A2', 'E2'],
    capo: 0,
    measures: [
      {
        numerator: 4,
        denominator: 4,
        repeatStart: true,
        repeatClose: 0,
        voices: [
          [
            { duration: 4, notes: [{ string: 6, fret: 0, dead: true, tied: false }], rest: false },
            { duration: 4, notes: [{ string: 6, fret: 3, dead: false, tied: true }], rest: false },
            { duration: 2, notes: [], rest: true },
          ],
          [],
        ],
      },
    ],
  };
  const tex = powerTabToAlphaTex(model, {});
  assert.match(tex, /\\ro/); // repeat start
  assert.match(tex, /x\.6\.4/); // dead note
  assert.match(tex, /-\.6\.4/); // tied note
  assert.match(tex, /r\.2/); // rest
});

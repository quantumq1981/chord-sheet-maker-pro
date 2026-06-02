/* ============================================================
   powerTabImporter.js
   Power Tab (.ptb) importer for Chord Sheet Maker Pro
   (index.html ecosystem).

   Power Tab Editor files are "ptab" + an MFC CArchive object
   stream (CGuitar, CSection, CStaff, CPosition, CLineData,
   CMusicBar, CChordText, CChordDiagram, …). AlphaTab cannot read
   .ptb, so we parse the binary ourselves — pure JS, zero deps,
   safe on iOS Safari.

   PHASE A (this file, foundation):
     • PtbReader — MFC CArchive binary reader (LE ints, MFC CString
       length scheme, MFC class-tag scheme with back-references).
     • parsePowerTabHeader — "ptab" magic, version, file/content
       type, song title + artist.
     • extractTunings — locate guitar tunings (string count + MIDI
       notes) from the object stream.
     • inspectPowerTab — convenience summary for diagnostics/tests.

   Later phases will add: full guitar/section/staff/position note
   walking → MusicXML (AlphaTab notation view) + chord extraction
   (CChordText/CChordDiagram) → CSMPN editable chart.

   All logic is pure (no DOM) so it runs under Node vm.runInContext;
   _PTB_TEST_EXPORTS exposes the helpers for tests.
============================================================ */

// ── MIDI helpers ──────────────────────────────────────────────────────────────

const _PTB_MIDI_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function _ptbMidiToName(m) {
  return _PTB_MIDI_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

// ── MFC CArchive binary reader ─────────────────────────────────────────────────

/**
 * Cursor-based reader over a .ptb byte buffer. Implements the MFC CArchive
 * primitives Power Tab Editor used to serialise its document.
 * @param {Uint8Array|ArrayBuffer} bytes
 */
function PtbReader(bytes) {
  this.u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  this.pos = 0;
}

PtbReader.prototype.remaining = function () {
  return this.u8.length - this.pos;
};

PtbReader.prototype.eof = function () {
  return this.pos >= this.u8.length;
};

PtbReader.prototype.readU8 = function () {
  return this.u8[this.pos++];
};

PtbReader.prototype.readU16 = function () {
  const v = this.u8[this.pos] | (this.u8[this.pos + 1] << 8);
  this.pos += 2;
  return v;
};

PtbReader.prototype.readU32 = function () {
  const v =
    (this.u8[this.pos] |
      (this.u8[this.pos + 1] << 8) |
      (this.u8[this.pos + 2] << 16) |
      (this.u8[this.pos + 3] << 24)) >>>
    0;
  this.pos += 4;
  return v;
};

PtbReader.prototype.readI32 = function () {
  return this.readU32() | 0;
};

PtbReader.prototype.readBytes = function (n) {
  const s = this.u8.subarray(this.pos, this.pos + n);
  this.pos += n;
  return s;
};

/**
 * MFC count/length: 1 byte; if 0xFF read a u16; if that is 0xFFFF read a u32.
 * Used both for CString lengths and array counts.
 */
PtbReader.prototype.readCount = function () {
  const b = this.readU8();
  if (b !== 0xff) return b;
  const w = this.readU16();
  if (w !== 0xffff) return w;
  return this.readU32();
};

/**
 * Read an MFC CString (ANSI / Latin-1, length-prefixed via readCount).
 * @returns {string}
 */
PtbReader.prototype.readString = function () {
  const len = this.readCount();
  if (len <= 0) return '';
  const bytes = this.readBytes(len);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

/**
 * Read an MFC object class tag.
 *   0x0000        → null object
 *   0xFFFF        → new class: u16 schema, u16 name length, ANSI name.
 *                   The class is appended to `loadedClasses` (load map).
 *   otherwise     → back-reference: low 15 bits index a previously loaded class.
 * @param {string[]} loadedClasses running MFC load map (mutated)
 * @returns {string|null} the class name, or null
 */
PtbReader.prototype.readClass = function (loadedClasses) {
  const tag = this.readU16();
  if (tag === 0x0000) return null;
  if (tag === 0xffff) {
    /* const schema = */ this.readU16();
    const nameLen = this.readU16();
    let name = '';
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(this.readU8());
    loadedClasses.push(name);
    return name;
  }
  const idx = (tag & 0x7fff) - 1;
  return loadedClasses[idx] || null;
};

// ── Header ──────────────────────────────────────────────────────────────────

/**
 * Parse the Power Tab document header.
 *
 * Layout (verified across exercise + song files):
 *   "ptab"            4 bytes magic
 *   version           u16  (4 = Power Tab 1.7 format)
 *   fileType          u8   (0 = song)
 *   contentType       u8   (song classification)
 *   title             CString
 *   artist            CString
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{magic:string, version:number, fileType:number, contentType:number,
 *            title:string, artist:string, headerEnd:number}}
 */
function parsePowerTabHeader(bytes) {
  const r = new PtbReader(bytes);
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(r.readU8());
  if (magic !== 'ptab') {
    throw new Error('Not a Power Tab file (bad magic: "' + magic + '")');
  }
  const version = r.readU16();
  const fileType = r.readU8();
  const contentType = r.readU8();
  const title = r.readString();
  const artist = r.readString();
  return {
    magic: magic,
    version: version,
    fileType: fileType,
    contentType: contentType,
    title: title,
    artist: artist,
    headerEnd: r.pos,
  };
}

// ── Tuning extraction ─────────────────────────────────────────────────────────

/**
 * Extract guitar/bass tunings from the object stream.
 *
 * A tuning is stored as a 1-byte string count (4–8) followed by that many MIDI
 * note numbers, ordered high string → low string and ending on a low note
 * (E2 = 40 for guitar, E1 = 28 for bass). Phase A locates these structurally;
 * Phase B will read them via proper CGuitar object walking.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Array<{strings:number, midi:number[], notes:string[]}>}
 */
function extractTunings(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const out = [];
  const seen = new Set();
  for (let p = 6; p < u8.length - 9; p++) {
    const n = u8[p];
    if (n < 4 || n > 8) continue;
    const midi = [];
    let ok = true;
    for (let s = 0; s < n; s++) {
      const v = u8[p + 1 + s];
      if (v < 28 || v > 96) {
        ok = false;
        break;
      }
      midi.push(v);
    }
    if (!ok) continue;
    // Tunings are stored high→low and bottom out near a low E (28..52).
    const descending = midi.every((v, k) => k === 0 || v <= midi[k - 1] + 2);
    const last = midi[midi.length - 1];
    if (!descending || last < 28 || last > 52) continue;
    const key = midi.join(',');
    if (seen.has(key)) {
      p += n;
      continue;
    }
    seen.add(key);
    out.push({ strings: n, midi: midi, notes: midi.map(_ptbMidiToName) });
    p += n;
  }
  return out;
}

// ── Class-stream summary ────────────────────────────────────────────────────

/**
 * Scan the MFC stream for new-class descriptors (0xFFFF tags) and tally the
 * distinct object classes present. (Back-referenced instances are not counted
 * here — full counts require object walking in a later phase.)
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Object<string, number>}
 */
function listPowerTabClasses(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const counts = {};
  for (let i = 6; i < u8.length - 8; i++) {
    if (u8[i] !== 0xff || u8[i + 1] !== 0xff) continue;
    const nameLen = u8[i + 4] | (u8[i + 5] << 8);
    if (nameLen < 2 || nameLen > 40 || i + 6 + nameLen > u8.length) continue;
    let name = '';
    let ok = true;
    for (let k = 0; k < nameLen; k++) {
      const c = u8[i + 6 + k];
      if (c < 32 || c > 126) {
        ok = false;
        break;
      }
      name += String.fromCharCode(c);
    }
    if (ok && /^C[A-Za-z0-9]+$/.test(name)) {
      counts[name] = (counts[name] || 0) + 1;
      i += 5 + nameLen;
    }
  }
  return counts;
}

/**
 * Convenience summary used by diagnostics and tests.
 * @param {Uint8Array|ArrayBuffer} bytes
 */
function inspectPowerTab(bytes) {
  const header = parsePowerTabHeader(bytes);
  return {
    header: header,
    tunings: extractTunings(bytes),
    classes: listPowerTabClasses(bytes),
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

// Pure helpers for Node vm.runInContext tests (becomes a context global).
var _PTB_TEST_EXPORTS = {
  PtbReader: PtbReader,
  parsePowerTabHeader: parsePowerTabHeader,
  extractTunings: extractTunings,
  listPowerTabClasses: listPowerTabClasses,
  inspectPowerTab: inspectPowerTab,
  midiToName: _ptbMidiToName,
};

// Browser global (full importer entry points are added in later phases).
if (typeof window !== 'undefined') {
  window.PowerTab = {
    parseHeader: parsePowerTabHeader,
    extractTunings: extractTunings,
    inspect: inspectPowerTab,
  };
}

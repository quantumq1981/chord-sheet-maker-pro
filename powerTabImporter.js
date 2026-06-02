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

// ── Full structural parse (Phase B) ─────────────────────────────────────────
//
// Faithful port of TuxGuitar's PTInputStream (helge17/tuxguitar @1.6.4,
// TuxGuitar-ptb, LGPL) — the read ORDER must match byte-for-byte or the stream
// desyncs. We translate its read* methods 1:1 and collect the data we need
// (track tunings, per-section barlines/time-sigs/tempos, and beats with notes:
// string + fret + duration). A correct parse consumes both tracks and lands at
// (or very near) EOF — `parsePowerTab` reports `bytesConsumed`/`fileSize` so
// alignment is self-checking.

// PowerTab CString: 1 length byte; if 0xFF, a u16 length follows. (Matches
// TuxGuitar's readString() — note it does NOT use the 0xFFFF→u32 extension.)
function _ptbReadStr(r) {
  const len = r.readU8();
  const n = len < 0xff ? len : r.readU16();
  if (n <= 0) return '';
  const bytes = r.readBytes(n);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Array prefix: u16 count; if non-zero, consume the first item's class tag
// (and, when it's a new-class 0xFFFF descriptor, its schema + name). Leaves the
// cursor at the first item's data. Returns the item count.
function _ptbReadHeaderItems(r) {
  const nbItems = r.readU16();
  if (nbItems !== 0) {
    const header = r.readU16();
    if (header === 0xffff) {
      if (r.readU16() !== 1) return -1; // schema must be 1
      const nameLen = r.readU16();
      r.readBytes(nameLen); // class name
    }
  }
  return nbItems;
}

function _ptbMakeSection() {
  return {
    barLines: [], // {position, repeatStart, repeatClose, numerator, denominator}
    directions: 0,
    chordTexts: 0,
    rhythmSlashes: 0,
    staffCount: 0,
    beats: [], // {staff, voice, position, duration, dotted, notes:[{string,fret,tied,dead}]}
    tempos: [], // {position, tempo}
  };
}

// Lazy section accessor mirroring TuxGuitar's track.getSection(n).
function _ptbGetSection(track, n) {
  while (track.sections.length <= n) track.sections.push(_ptbMakeSection());
  return track.sections[n];
}

function _ptbReadTrackInfo(r, track) {
  const info = {};
  info.number = r.readU8();
  info.name = _ptbReadStr(r);
  info.instrument = r.readU8();
  info.volume = r.readU8();
  info.balance = r.readU8();
  info.reverb = r.readU8();
  info.chorus = r.readU8();
  info.tremolo = r.readU8();
  info.phaser = r.readU8();
  info.capo = r.readU8();
  info.tuningName = _ptbReadStr(r);
  r.readU8(); // music-notation offset / sharps-flats flags
  const strings = [];
  const nStrings = r.readU8() & 0xff;
  for (let i = 0; i < nStrings; i++) strings.push(r.readU8());
  info.tuning = strings;
  info.tuningNotes = strings.map(_ptbMidiToName);
  track.infos.push(info);
}

function _ptbReadTimeSignature(r, bar) {
  const data = r.readI32();
  r.readU8(); // measure pulses
  bar.numerator = (((data >> 24) - (((data >> 24) % 8)) ) / 8) + 1;
  bar.denominator = Math.pow(2, (data >> 24) % 8);
}

function _ptbReadKeySignature(r) {
  r.readU8();
}

function _ptbReadRehearsalSign(r) {
  r.readU8();
  _ptbReadStr(r);
}

function _ptbReadBarLine(r, section) {
  const bar = {};
  bar.position = r.readU8();
  const type = r.readU8();
  bar.repeatStart = type >>> 5 === 3;
  bar.repeatClose = type >>> 5 === 4 ? type - 128 : 0;
  _ptbReadKeySignature(r);
  _ptbReadTimeSignature(r, bar);
  _ptbReadRehearsalSign(r);
  section.barLines.push(bar);
}

function _ptbReadNote(r, beat) {
  const note = {};
  const position = r.readU8();
  const simpleData = r.readU16();
  const symbolCount = r.readU8();
  for (let i = 0; i < symbolCount; i++) {
    r.readU8();
    r.readU8();
    r.readU8();
    r.readU8();
  }
  note.fret = position & 0x1f;
  note.string = ((position & 0xe0) >> 5) + 1;
  note.tied = (simpleData & 0x01) !== 0;
  note.dead = (simpleData & 0x02) !== 0;
  beat.notes.push(note);
}

function _ptbReadPosition(r, staff, voice, section) {
  const beat = { staff: staff, voice: voice, notes: [] };
  beat.position = r.readU8();
  r.readU8(); // beaming
  r.readU8();
  const data1 = r.readU8();
  r.readU8();
  r.readU8(); // data3
  beat.duration = r.readU8();
  const complexCount = r.readU8();
  for (let i = 0; i < complexCount; i++) {
    r.readU16();
    r.readU8();
    r.readU8();
  }
  const itemCount = _ptbReadHeaderItems(r);
  for (let j = 0; j < itemCount; j++) {
    _ptbReadNote(r, beat);
    if (j < itemCount - 1) r.readU16();
  }
  beat.dotted = (data1 & 0x01) !== 0;
  beat.doubleDotted = (data1 & 0x02) !== 0;
  section.beats.push(beat);
}

function _ptbReadStaff(r, staff, section) {
  for (let i = 0; i < 5; i++) r.readU8();
  for (let voice = 0; voice < 2; voice++) {
    const itemCount = _ptbReadHeaderItems(r);
    for (let j = 0; j < itemCount; j++) {
      _ptbReadPosition(r, staff, voice, section);
      if (j < itemCount - 1) r.readU16();
    }
  }
}

function _ptbReadDirection(r) {
  r.readU8(); // position
  const symbolCount = r.readU8();
  for (let i = 0; i < symbolCount; i++) r.readU16();
}

function _ptbReadChordText(r) {
  r.readU8();
  r.readU16();
  r.readU8();
  r.readU16();
  r.readU8();
}

function _ptbReadRhythmSlash(r) {
  r.readU8();
  r.readU8();
  r.readI32();
}

function _ptbReadSection(r, section) {
  r.readI32(); // left
  r.readI32(); // top
  r.readI32(); // right
  r.readI32(); // bottom
  r.readU8(); // lastBarData
  r.readU8();
  r.readU8();
  r.readU8();
  r.readU8();
  _ptbReadBarLine(r, section);
  let n = _ptbReadHeaderItems(r);
  section.directions = n;
  for (let j = 0; j < n; j++) {
    _ptbReadDirection(r);
    if (j < n - 1) r.readU16();
  }
  n = _ptbReadHeaderItems(r);
  section.chordTexts = n;
  for (let j = 0; j < n; j++) {
    _ptbReadChordText(r);
    if (j < n - 1) r.readU16();
  }
  n = _ptbReadHeaderItems(r);
  section.rhythmSlashes = n;
  for (let j = 0; j < n; j++) {
    _ptbReadRhythmSlash(r);
    if (j < n - 1) r.readU16();
  }
  section.staffCount = _ptbReadHeaderItems(r);
  for (let staff = 0; staff < section.staffCount; staff++) {
    _ptbReadStaff(r, staff, section);
    if (staff < section.staffCount - 1) r.readU16();
  }
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadBarLine(r, section);
    if (j < n - 1) r.readU16();
  }
}

function _ptbReadChord(r) {
  r.readU16(); // chord key
  r.readU8();
  r.readU16(); // modification
  r.readU8();
  r.readU8();
  const stringCount = r.readU8();
  for (let j = 0; j < stringCount; j++) r.readU8();
}

function _ptbReadFontSetting(r) {
  _ptbReadStr(r);
  r.readI32();
  r.readI32();
  r.readU8(); // italic (bool)
  r.readU8(); // underline
  r.readU8(); // strikeout
  r.readI32();
}

function _ptbReadFloatingText(r) {
  _ptbReadStr(r);
  r.readI32();
  r.readI32();
  r.readI32();
  r.readI32();
  r.readU8();
  _ptbReadFontSetting(r);
}

function _ptbReadGuitarIn(r) {
  r.readU16(); // section
  r.readU8(); // staff
  r.readU8(); // position
  r.readU8(); // skip 1
  r.readU8(); // info
}

function _ptbReadTempoMarker(r, track) {
  const section = r.readU16();
  const position = r.readU8();
  const tempo = r.readU16();
  r.readU16(); // data
  _ptbReadStr(r); // description
  if (tempo > 0) _ptbGetSection(track, section).tempos.push({ position: position, tempo: tempo });
}

function _ptbReadSectionSymbol(r) {
  r.readU16();
  r.readU8();
  r.readI32();
}

function _ptbReadDynamic(r) {
  r.readU16();
  r.readU8();
  r.readU8();
  r.readU16();
}

function _ptbReadDataInstruments(r, track) {
  // Guitars
  let n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadTrackInfo(r, track);
    if (j < n - 1) r.readU16();
  }
  // Chord diagrams
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadChord(r);
    if (j < n - 1) r.readU16();
  }
  // Floating text
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadFloatingText(r);
    if (j < n - 1) r.readU16();
  }
  // Guitar-ins
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadGuitarIn(r);
    if (j < n - 1) r.readU16();
  }
  // Tempo markers
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadTempoMarker(r, track);
    if (j < n - 1) r.readU16();
  }
  // Dynamics
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadDynamic(r);
    if (j < n - 1) r.readU16();
  }
  // Section symbols
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadSectionSymbol(r);
    if (j < n - 1) r.readU16();
  }
  // Sections
  n = _ptbReadHeaderItems(r);
  for (let j = 0; j < n; j++) {
    _ptbReadSection(r, _ptbGetSection(track, j));
    if (j < n - 1) r.readU16();
  }
}

// Full song-info header (port of readSongInfo).
function _ptbReadSongInfo(r) {
  const info = {};
  info.classification = r.readU8();
  if (info.classification === 0) {
    r.readU8(); // skip(1)
    info.title = _ptbReadStr(r);
    info.artist = _ptbReadStr(r);
    info.releaseType = r.readU8();
    if (info.releaseType === 0) {
      info.albumType = r.readU8();
      info.album = _ptbReadStr(r);
      info.year = r.readU16();
      info.live = r.readU8() > 0;
    } else if (info.releaseType === 1) {
      info.album = _ptbReadStr(r);
      info.live = r.readU8() > 0;
    } else if (info.releaseType === 2) {
      info.album = _ptbReadStr(r);
      info.day = r.readU16();
      info.month = r.readU16();
      info.year = r.readU16();
    }
    if (r.readU8() === 0) {
      info.author = _ptbReadStr(r);
      info.lyricist = _ptbReadStr(r);
    }
    info.arranger = _ptbReadStr(r);
    info.guitarTranscriber = _ptbReadStr(r);
    info.bassTranscriber = _ptbReadStr(r);
    info.copyright = _ptbReadStr(r);
    info.lyrics = _ptbReadStr(r);
    info.guitarInstructions = _ptbReadStr(r);
    info.bassInstructions = _ptbReadStr(r);
  } else if (info.classification === 1) {
    info.title = _ptbReadStr(r);
    info.album = _ptbReadStr(r);
    info.style = r.readU16();
    info.level = r.readU8();
    info.author = _ptbReadStr(r);
    info.instructions = _ptbReadStr(r);
    info.copyright = _ptbReadStr(r);
  }
  return info;
}

/**
 * Full Power Tab parse → structured model.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{
 *   version:number, info:object,
 *   tracks: Array<{infos:object[], sections:object[]}>,
 *   bytesConsumed:number, fileSize:number, complete:boolean
 * }}
 */
function parsePowerTab(bytes) {
  const r = new PtbReader(bytes);
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(r.readU8());
  if (magic !== 'ptab') throw new Error('Not a Power Tab file (bad magic: "' + magic + '")');
  const version = r.readU16();
  const info = _ptbReadSongInfo(r);
  const track1 = { infos: [], sections: [] };
  const track2 = { infos: [], sections: [] };
  _ptbReadDataInstruments(r, track1);
  _ptbReadDataInstruments(r, track2);
  return {
    version: version,
    info: info,
    tracks: [track1, track2],
    bytesConsumed: r.pos,
    fileSize: r.u8.length,
    trailerBytes: r.u8.length - r.pos,
    // After track 2, PTB carries a small fixed font/layout trailer (~95 bytes)
    // that TuxGuitar also stops before. A clean parse leaves only that trailer.
    complete: r.u8.length - r.pos <= 256,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

// Pure helpers for Node vm.runInContext tests (becomes a context global).
var _PTB_TEST_EXPORTS = {
  PtbReader: PtbReader,
  parsePowerTabHeader: parsePowerTabHeader,
  parsePowerTab: parsePowerTab,
  extractTunings: extractTunings,
  listPowerTabClasses: listPowerTabClasses,
  inspectPowerTab: inspectPowerTab,
  midiToName: _ptbMidiToName,
};

// Browser global (full importer entry points are added in later phases).
if (typeof window !== 'undefined') {
  window.PowerTab = {
    parseHeader: parsePowerTabHeader,
    parse: parsePowerTab,
    extractTunings: extractTunings,
    inspect: inspectPowerTab,
  };
}

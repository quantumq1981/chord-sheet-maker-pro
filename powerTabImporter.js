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

// Reads past the end of the stream mean the cursor desynced from the real
// structure (a format variant we don't model). Throwing here turns a runaway
// garbage parse into a clean failure the caller can fall back from, instead of
// looping over a bogus item count and emitting nonsense.
PtbReader.prototype._need = function (n) {
  if (this.pos + n > this.u8.length) {
    throw new Error('Power Tab stream desync: read past end of file');
  }
};

PtbReader.prototype.readU8 = function () {
  this._need(1);
  return this.u8[this.pos++];
};

PtbReader.prototype.readU16 = function () {
  this._need(2);
  const v = this.u8[this.pos] | (this.u8[this.pos + 1] << 8);
  this.pos += 2;
  return v;
};

PtbReader.prototype.readU32 = function () {
  this._need(4);
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
  this._need(n);
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
    chordNames: [], // {position, key, formula, mods} — decoded in Phase E
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
  // m_data: bits 0-3 = accidentals (0=none, 1-7 sharps, 8-14 flats),
  // bit 4 = shown, bit 6 = key type (0 major, 1 minor).
  return r.readU8();
}

function _ptbReadRehearsalSign(r) {
  // letter is an ASCII rehearsal letter (A, B, C…) or 0x7F when unused; desc is
  // the human section name ("Intro", "Verse 1", "Chorus") shown in the chart.
  const letter = r.readU8();
  const desc = _ptbReadStr(r);
  return { letter: letter, desc: desc };
}

function _ptbReadBarLine(r, section) {
  const bar = {};
  bar.position = r.readU8();
  const type = r.readU8();
  bar.repeatStart = type >>> 5 === 3;
  bar.repeatClose = type >>> 5 === 4 ? type - 128 : 0;
  bar.keySig = _ptbReadKeySignature(r);
  _ptbReadTimeSignature(r, bar);
  bar.rehearsal = _ptbReadRehearsalSign(r);
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
  // Beaming byte also encodes irregular grouping (tuplets). TuxGuitar derives
  // enters/times from it: clear the high bit, then enters = (b>>3)+1,
  // times = (b&7)+1. A plain (non-tuplet) beat decodes to 1:1.
  let beaming = r.readU8();
  beaming = beaming < 128 ? beaming : beaming - 128;
  beat.tupletEnters = ((beaming - (beaming % 8)) / 8) + 1;
  beat.tupletTimes = (beaming % 8) + 1;
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

function _ptbReadChordText(r, section) {
  // ChordText serialise order: position(u8), key(u16), formula(u8),
  // formulaModifications(u16), extra(u8). The key/formula/mods triple is a
  // PowerTab ChordName bitfield — decoded to a display name in Phase E.
  const position = r.readU8();
  const key = r.readU16();
  const formula = r.readU8();
  const mods = r.readU16();
  r.readU8(); // extra (fret position / type — unused for naming)
  if (section) section.chordNames.push({ position: position, key: key, formula: formula, mods: mods });
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
    _ptbReadChordText(r, section);
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
    // that TuxGuitar also stops before. A clean parse leaves only that trailer —
    // i.e. a small *non-negative* remainder. A negative remainder means the
    // cursor overran (desync) and the parse is not trustworthy.
    complete: r.u8.length - r.pos >= 0 && r.u8.length - r.pos <= 256,
  };
}

// ── Phase C: clean musical model (measures + durations) ─────────────────────
//
// The raw parse stores beats per-section/staff/voice with a layout `position`
// and a note-denominator `duration`. PowerTab places barlines at positions and
// beats at positions, so a beat belongs to the measure whose barline has the
// greatest position ≤ the beat's position. Validated on the user's 3,056-file
// corpus: 96.3% of reconstructed measures sum exactly to their time signature
// (the rest are genuine irregular/pickup bars that still render fine).

// MusicXML-style QUARTER division base — large enough that quarters, dotted
// values, 64ths and common tuplets all stay integers.
var _PTB_QUARTER = 960;
var _PTB_VALID_DENOM = [1, 2, 4, 8, 16, 32, 64];

/** Time (in _PTB_QUARTER units) a beat occupies — folds in dots and tuplets. */
function _ptbBeatDurDivisions(beat) {
  var value = beat.duration && _PTB_VALID_DENOM.indexOf(beat.duration) >= 0 ? beat.duration : 4;
  var d = (_PTB_QUARTER * 4) / value;
  if (beat.dotted) d *= 1.5;
  if (beat.doubleDotted) d *= 1.75;
  if (beat.tupletEnters > 1 && beat.tupletEnters !== beat.tupletTimes) {
    d = (d * beat.tupletTimes) / beat.tupletEnters;
  }
  return d;
}

/** Normalise a raw beat into a render-ready beat (notes carry sounding MIDI). */
function _ptbCleanBeat(b, tuning, capo) {
  var notes = (b.notes || []).map(function (n) {
    var open = tuning && tuning[n.string - 1] != null ? tuning[n.string - 1] : null;
    return {
      string: n.string,
      fret: n.fret,
      tied: !!n.tied,
      dead: !!n.dead,
      midi: open != null ? open + n.fret + (capo || 0) : null,
    };
  });
  return {
    duration: b.duration && _PTB_VALID_DENOM.indexOf(b.duration) >= 0 ? b.duration : 4,
    dotted: !!b.dotted,
    doubleDotted: !!b.doubleDotted,
    tupletEnters: b.tupletEnters || 1,
    tupletTimes: b.tupletTimes || 1,
    rest: !notes.length,
    notes: notes,
  };
}

// ── Phase E: chord-key bitfield → chord name ─────────────────────────────────
//
// PowerTab stores chords as a packed ChordName (key u16 + formula u8 + mods u16),
// not as text. This is a faithful port of Power Tab Editor's ChordName::GetText /
// GetFormulaText / GetKeyText (powertabeditor, BSD) so the names match exactly.

var _PTB_KEY_DEFAULT = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
var _PTB_KEY_DOWN = ['B#', 'Bx', 'Cx', 'D#', 'Dx', 'E#', 'Ex', 'Fx', 'G#', 'Gx', 'A#', 'Ax'];
var _PTB_KEY_UP = ['Dbb', 'Db', 'Ebb', 'Fbb', 'Fb', 'Gbb', 'Gb', 'Abb', '', 'Bbb', 'Cbb', 'Cb'];

// keyVariations: down = 0, default = 1, up = 2.
function _ptbKeyText(key, variation) {
  if (variation === 1) return _PTB_KEY_DEFAULT[key] || '';
  if (variation === 0) return _PTB_KEY_DOWN[key] || '';
  return _PTB_KEY_UP[key] || '';
}

function _ptbFormulaText(formula, mods) {
  // abbr[3] is the degree symbol in PowerTab; we emit "dim" for CSMPN safety.
  var abbr = ['maj', 'm', '+', 'dim', '5', 'add', 'sus2', 'sus4', '#', 'b'];
  var ext = [0x01, 0x02, 0x04];
  var extStr = ['9', '11', '13'];
  var ret = '';
  var f = formula & 0x0f;
  var bExtension = false;
  for (var j = 0; j < 3; j++) {
    if (mods & ext[j]) {
      if (f >= 8) {
        ret +=
          f === 8 ? abbr[0]
          : f === 9 ? abbr[1]
          : f === 10 ? abbr[2]
          : f === 11 ? abbr[3]
          : f === 12 ? abbr[1] + '/' + abbr[0]
          : abbr[1] + extStr[j] + 'b5';
        if (f < 13) ret += extStr[j];
      } else if (f === 7) {
        ret += extStr[j];
      }
      bExtension = true;
    }
  }
  var suffix = [
    '', abbr[1], abbr[2], abbr[3], abbr[4], '6', abbr[1] + '6', '7',
    abbr[0] + '7', abbr[1] + '7', abbr[2] + '7', abbr[3] + '7',
    abbr[1] + '/' + abbr[0] + '7', 'm7' + abbr[9] + '5',
  ];
  if (!bExtension && f !== 0) ret += suffix[f];
  // wFormulaBit order from the spec (sus2, sus4, add2/4/6/9/11, b13, +11, b9, +9, b5, +5).
  var fbit = [0x4000, 0x8000, 0x08, 0x10, 0x20, 0x40, 0x80, 0x2000, 0x1000, 0x400, 0x800, 0x100, 0x200];
  var add = [
    abbr[6], abbr[7], abbr[5] + '2', abbr[5] + '4', abbr[5] + '6', abbr[5] + '9',
    abbr[5] + '11', abbr[9] + '13', abbr[2] + '11', abbr[9] + '9', abbr[2] + '9',
    abbr[9] + '5', abbr[2] + '5',
  ];
  for (var k = 0; k < 13; k++) {
    if (mods & fbit[k]) ret += add[k];
  }
  return ret;
}

/** Decode a {key, formula, mods} ChordName triple → display string ('Am7', 'E5/B', 'N.C.'). */
function _ptbDecodeChord(key, formula, mods) {
  if (formula & 0x10) return 'N.C.'; // noChord flag
  var tonicKey = (key & 0xf00) >> 8;
  var tonicVar = (key & 0x3000) >> 12;
  var bassKey = key & 0xf;
  var bassVar = (key & 0x30) >> 4;
  var name = _ptbKeyText(tonicKey, tonicVar) + _ptbFormulaText(formula, mods);
  // Show the bass note only when tonic and bass differ (key + variation).
  if (((key & 0x3f00) >> 8) !== (key & 0x3f)) {
    name += '/' + _ptbKeyText(bassKey, bassVar);
  }
  return name;
}

// Key-signature decode: accidental count + major/minor → key name. Relative
// majors/minors share an accidental count, so the tables are indexed by it.
var _PTB_MAJOR_SHARP = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
var _PTB_MAJOR_FLAT = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
var _PTB_MINOR_SHARP = ['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
var _PTB_MINOR_FLAT = ['Am', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm'];

/** Decode a PowerTab key-signature byte to a key name ('E', 'Bbm', 'C'). */
function _ptbDecodeKeySig(data) {
  var a = data & 0x0f;
  var minor = ((data >> 6) & 1) === 1;
  var sharps = a >= 1 && a <= 7 ? a : 0;
  var flats = a >= 8 ? a - 7 : 0;
  if (sharps) return minor ? _PTB_MINOR_SHARP[sharps] : _PTB_MAJOR_SHARP[sharps];
  if (flats) return minor ? _PTB_MINOR_FLAT[flats] : _PTB_MAJOR_FLAT[flats];
  return minor ? 'Am' : 'C';
}

/** Does a key-sig byte carry real info (accidentals set, or explicitly shown)? */
function _ptbKeySigHasInfo(data) {
  return (data & 0x0f) !== 0 || (data & 0x10) !== 0;
}

/** Section label from a barline's rehearsal sign, or null when none is set. */
function _ptbRehearsalLabel(reh) {
  if (!reh || reh.letter === 0x7f || reh.letter === 0xff) return null;
  var d = (reh.desc || '').replace(/\s+/g, ' ').trim();
  return d || String.fromCharCode(reh.letter);
}

/** Root note (letter + accidental) of a decoded chord name, for key inference. */
function _ptbChordRoot(name) {
  var m = /^[A-G][#b]?/.exec(name || '');
  return m ? m[0] : '';
}

/**
 * Build a clean measure list for one track (guitar or bass score).
 *
 * @param {{infos:object[], sections:object[]}} track
 * @returns {{tuning:number[], tuningNotes:string[], capo:number, instrument:number,
 *            measures:Array<{numerator:number, denominator:number,
 *              repeatStart:boolean, repeatClose:number, voices:object[][]}>}}
 */
function powerTabToMeasures(track) {
  var info = (track && track.infos && track.infos[0]) || {};
  var tuning = (info.tuning || []).slice(); // high→low MIDI
  var capo = info.capo || 0;

  // 1) Flatten every barline across all sections into an ordered segment chain.
  //    Each segment = the bar that a barline opens + the beats up to the next
  //    barline. The *next* segment's barline is this segment's closing barline,
  //    which is where PowerTab records repeat-close — even across a section break.
  var segments = [];
  for (var si = 0; si < (track.sections || []).length; si++) {
    var sec = track.sections[si];
    if (!sec.barLines || !sec.barLines.length) continue;
    var bls = sec.barLines.slice().sort(function (a, b) {
      return a.position - b.position;
    });
    for (var bi = 0; bi < bls.length; bi++) {
      var start = bls[bi].position;
      var end = bi + 1 < bls.length ? bls[bi + 1].position : Infinity;
      var v0 = [];
      var v1 = [];
      for (var k = 0; k < sec.beats.length; k++) {
        var bt = sec.beats[k];
        if (bt.staff !== 0) continue; // primary staff
        if (bt.position >= start && bt.position < end) {
          (bt.voice === 1 ? v1 : v0).push(_ptbCleanBeat(bt, tuning, capo));
        }
      }
      // Collect chord-text annotations in this barline span (in position order),
      // decode them, and drop consecutive duplicates (fake-book style).
      var chords = [];
      var cns = (sec.chordNames || []).filter(function (c) {
        return c.position >= start && c.position < end;
      });
      cns.sort(function (a, b) {
        return a.position - b.position;
      });
      for (var ci = 0; ci < cns.length; ci++) {
        var name = _ptbDecodeChord(cns[ci].key, cns[ci].formula, cns[ci].mods);
        // Keep only distinct chords within a bar (first-appearance order). A busy
        // strummed measure annotates every hit (e.g. A5 E5 B5 A5 B5); collapsing
        // repeats to A5 E5 B5 reads as a fake-book bar while preserving genuine
        // multi-chord bars like Bb7 G7 C7 F7.
        if (name && chords.indexOf(name) === -1) chords.push(name);
      }
      segments.push({ bar: bls[bi], v0: v0, v1: v1, chords: chords });
    }
  }

  // 2) Emit a measure for every segment that has content. Time signatures carry
  //    forward (PowerTab only re-states them on change); repeat-close is read
  //    from the *following* barline in the chain.
  var measures = [];
  var curNum = 4;
  var curDen = 4;
  var pendingSection = null; // rehearsal label carried over skipped empty barlines
  var keySigByte = 0; // first barline that carries real key info (else 0 = C)
  var keySigFound = false;
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i];
    if (!keySigFound && _ptbKeySigHasInfo(seg.bar.keySig || 0)) {
      keySigByte = seg.bar.keySig;
      keySigFound = true;
    }
    var num = seg.bar.numerator;
    var den = seg.bar.denominator;
    if (num >= 1 && num <= 32 && _PTB_VALID_DENOM.indexOf(den) >= 0) {
      curNum = num;
      curDen = den;
    }
    var segLabel = _ptbRehearsalLabel(seg.bar.rehearsal);
    if (!seg.v0.length && !seg.v1.length && !seg.chords.length) {
      if (segLabel) pendingSection = segLabel; // keep the label for the next real bar
      continue; // barline-only marker
    }
    var next = segments[i + 1];
    var rc = next && next.bar.repeatClose ? next.bar.repeatClose : 0;
    var label = segLabel || pendingSection;
    pendingSection = null;
    measures.push({
      numerator: curNum,
      denominator: curDen,
      repeatStart: !!seg.bar.repeatStart,
      repeatClose: rc,
      voices: [seg.v0, seg.v1],
      chords: seg.chords,
      section: label ? { label: label } : null,
    });
  }

  return {
    tuning: tuning,
    tuningNotes: tuning.map(_ptbMidiToName),
    capo: capo,
    instrument: info.instrument || 0,
    keySig: keySigByte,
    keyName: keySigFound ? _ptbDecodeKeySig(keySigByte) : null,
    measures: measures,
  };
}

// ── Phase D: render input (AlphaTex for the AlphaTab notation view) ──────────
//
// AlphaTab's native AlphaTex importer is the most forgiving renderer. We verified
// the string convention against AlphaTab's source: with `\tuning` listed high→low,
// user string S maps to tuning[S-1], so string 1 = highest — identical to the
// PowerTab model (no string flipping needed).

function _ptbTexEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '').replace(/"/g, "'");
}

/** Octave-correct AlphaTex tuning token, e.g. midi 40 → "e2". */
function _ptbMidiToTexNote(m) {
  return _ptbMidiToName(m).toLowerCase();
}

/** One AlphaTex note token: fret.string, dead = x.string, tie = -.string. */
function _ptbNoteToTex(n) {
  var head = n.dead ? 'x' : n.tied ? '-' : String(n.fret);
  return head + '.' + n.string;
}

/** One AlphaTex beat: note/chord/rest + duration + {dots tuplet} effects. */
function _ptbBeatToTex(beat) {
  var core;
  if (beat.rest || !beat.notes.length) {
    core = 'r';
  } else if (beat.notes.length === 1) {
    core = _ptbNoteToTex(beat.notes[0]);
  } else {
    core = '(' + beat.notes.map(_ptbNoteToTex).join(' ') + ')';
  }
  core += '.' + beat.duration;
  var fx = [];
  if (beat.doubleDotted) fx.push('dd');
  else if (beat.dotted) fx.push('d');
  if (beat.tupletEnters > 1 && beat.tupletEnters !== beat.tupletTimes) {
    fx.push('tu ' + beat.tupletEnters + ' ' + beat.tupletTimes);
  }
  if (fx.length) core += '{' + fx.join(' ') + '}';
  return core;
}

/** Render one voice pass across all measures. Bars are `|`-separated. */
function _ptbRenderVoice(measures, voiceIndex, withMeta) {
  var prevNum = -1;
  var prevDen = -1;
  var bars = [];
  for (var i = 0; i < measures.length; i++) {
    var m = measures[i];
    var pieces = [];
    if (withMeta) {
      if (m.numerator !== prevNum || m.denominator !== prevDen) {
        pieces.push('\\ts ' + m.numerator + ' ' + m.denominator);
        prevNum = m.numerator;
        prevDen = m.denominator;
      }
      if (m.repeatStart) pieces.push('\\ro');
      if (m.repeatClose > 0) {
        var n = m.repeatClose >= 2 && m.repeatClose <= 16 ? m.repeatClose : 2;
        pieces.push('\\rc ' + n);
      }
    }
    var beats = m.voices[voiceIndex] || [];
    if (!beats.length) {
      pieces.push('r.1'); // whole-bar rest keeps both voices bar-aligned
    } else {
      for (var b = 0; b < beats.length; b++) pieces.push(_ptbBeatToTex(beats[b]));
    }
    bars.push(pieces.join(' '));
  }
  return bars.join(' | ');
}

/**
 * Convert a clean measure model to an AlphaTex document string.
 * @param {object} model  output of powerTabToMeasures
 * @param {{title?:string, artist?:string, tempo?:number}} [meta]
 * @returns {string}
 */
function powerTabToAlphaTex(model, meta) {
  meta = meta || {};
  var lines = [];
  if (meta.title) lines.push('\\title "' + _ptbTexEscape(meta.title) + '"');
  if (meta.artist) lines.push('\\artist "' + _ptbTexEscape(meta.artist) + '"');
  if (meta.tempo && meta.tempo > 0) lines.push('\\tempo ' + Math.round(meta.tempo));
  if (model.tuningNotes && model.tuningNotes.length) {
    lines.push('\\tuning ' + model.tuningNotes.map(_ptbMidiToTexNoteFromName).join(' '));
  }
  if (model.capo) lines.push('\\capo ' + model.capo);
  lines.push('.');
  var body = _ptbRenderVoice(model.measures, 0, true);
  var hasV1 = model.measures.some(function (m) {
    return m.voices[1] && m.voices[1].length;
  });
  if (hasV1) body += ' \\voice ' + _ptbRenderVoice(model.measures, 1, false);
  lines.push(body);
  return lines.join('\n');
}

// tuningNotes are already note names (e.g. "E2"); lowercase for AlphaTex.
function _ptbMidiToTexNoteFromName(name) {
  return String(name).toLowerCase();
}

function _ptbFindTempo(track) {
  if (!track || !track.sections) return 0;
  for (var i = 0; i < track.sections.length; i++) {
    var t = track.sections[i].tempos;
    if (t && t.length && t[0].tempo > 0) return t[0].tempo;
  }
  return 0;
}

/**
 * Top-level render entry: parse .ptb bytes → AlphaTex + summary.
 * Prefers the guitar score (track 0); falls back to the bass score if track 0
 * has no measures.
 *
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{title?:string, artist?:string}} [meta]
 * @returns {{tex:string, model:object, bars:number, sections:number,
 *            title:string, artist:string, complete:boolean}}
 */
function powerTabToRender(input, meta) {
  meta = meta || {};
  var parsed = input && input.tracks ? input : parsePowerTab(input);
  var info = parsed.info || {};
  var t0 = powerTabToMeasures(parsed.tracks[0] || { infos: [], sections: [] });
  var t1 = parsed.tracks[1]
    ? powerTabToMeasures(parsed.tracks[1])
    : { measures: [], tuningNotes: [] };
  var chosen = t0.measures.length ? t0 : t1;
  var srcTrack = t0.measures.length ? parsed.tracks[0] : parsed.tracks[1];
  var tempo = _ptbFindTempo(parsed.tracks[0]) || _ptbFindTempo(parsed.tracks[1]) || 0;
  var fullMeta = {
    title: meta.title || info.title || '',
    artist: meta.artist || info.artist || '',
    tempo: tempo,
  };
  return {
    tex: powerTabToAlphaTex(chosen, fullMeta),
    model: chosen,
    bars: chosen.measures.length,
    sections: (srcTrack && srcTrack.sections ? srcTrack.sections.length : 0) || 0,
    title: fullMeta.title,
    artist: fullMeta.artist,
    complete: parsed.complete,
  };
}

/**
 * Build an editable CSMPN fake-book chart from the chord-text annotations.
 * Bars with no chord repeat the previous one (`%`), matching fake-book practice.
 *
 * @param {Uint8Array|ArrayBuffer|object} input  raw bytes or a parsed document
 * @param {{barsPerRow?:number}} [opts]
 * @returns {{csmpn:string, chordCount:number, bars:number}}
 */
function powerTabToChart(input, opts) {
  opts = opts || {};
  var barsPerRow = opts.barsPerRow > 0 ? Math.floor(opts.barsPerRow) : 4;
  var parsed = input && input.tracks ? input : parsePowerTab(input);
  var info = parsed.info || {};
  var t0 = powerTabToMeasures(parsed.tracks[0] || { infos: [], sections: [] });
  var t1 = parsed.tracks[1] ? powerTabToMeasures(parsed.tracks[1]) : { measures: [], capo: 0 };
  var model = t0.measures.length ? t0 : t1;
  var measures = model.measures;

  var chordCount = 0;
  var firstChordRoot = '';
  var lastChord = '';
  var barTokens = [];
  for (var i = 0; i < measures.length; i++) {
    var m = measures[i];
    var token;
    if (m.chords && m.chords.length) {
      chordCount += m.chords.length;
      token = m.chords.join('_');
      lastChord = m.chords[m.chords.length - 1];
      if (!firstChordRoot) firstChordRoot = _ptbChordRoot(m.chords[0]);
    } else {
      token = lastChord ? '%' : 'N.C.';
    }
    barTokens.push({
      token: token,
      repeatStart: m.repeatStart,
      repeatClose: m.repeatClose,
      sectionLabel: m.section ? m.section.label : null,
    });
  }

  var lines = [];
  if (info.title) lines.push('Title: ' + info.title);
  if (info.artist) lines.push('Composer: ' + info.artist);
  // Prefer the file's stated key signature; fall back to the first chord's
  // root only when no key signature is present.
  lines.push('Key: ' + (model.keyName || firstChordRoot || 'C'));
  lines.push('Time: ' + (measures.length ? measures[0].numerator + '/' + measures[0].denominator : '4/4'));
  var tempo = _ptbFindTempo(parsed.tracks[0]) || _ptbFindTempo(parsed.tracks[1]) || 0;
  if (tempo > 0) lines.push('Tempo: ' + tempo);
  if (model.capo) lines.push('Capo: ' + model.capo);
  lines.push('');

  // Group bars under section headers from PowerTab rehearsal signs (Intro,
  // Verse, Chorus…). Files with no rehearsal marks fall back to a single
  // "- Chart" section. Rows break at barsPerRow, repeat boundaries, and at the
  // start of every new section.
  var row = [];
  var sectionCount = 0;
  function flushRow() {
    if (!row.length) return;
    var parts = [];
    for (var r = 0; r < row.length; r++) {
      parts.push((row[r].repeatStart ? '|:' : '|') + ' ' + row[r].token);
    }
    var last = row[row.length - 1];
    lines.push(parts.join(' ') + (last.repeatClose > 0 ? ' :|' : ' |'));
    row = [];
  }
  function startSection(label) {
    flushRow();
    lines.push('- ' + label);
    sectionCount++;
  }
  for (var b = 0; b < barTokens.length; b++) {
    var bt = barTokens[b];
    if (bt.sectionLabel) startSection(bt.sectionLabel);
    else if (sectionCount === 0) startSection('Chart');
    if (bt.repeatStart && row.length > 0) flushRow();
    row.push(bt);
    if (bt.repeatClose > 0 || row.length >= barsPerRow) flushRow();
  }
  flushRow();

  return {
    csmpn: lines.join('\n'),
    chordCount: chordCount,
    bars: measures.length,
    sections: sectionCount,
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
  powerTabToMeasures: powerTabToMeasures,
  powerTabToAlphaTex: powerTabToAlphaTex,
  powerTabToRender: powerTabToRender,
  powerTabToChart: powerTabToChart,
  decodeChord: _ptbDecodeChord,
  decodeKeySig: _ptbDecodeKeySig,
  rehearsalLabel: _ptbRehearsalLabel,
  beatDurDivisions: _ptbBeatDurDivisions,
};

// Browser global.
if (typeof window !== 'undefined') {
  window.PowerTab = {
    parseHeader: parsePowerTabHeader,
    parse: parsePowerTab,
    extractTunings: extractTunings,
    inspect: inspectPowerTab,
    toMeasures: function (input) {
      return powerTabToMeasures(parsePowerTab(input).tracks[0]);
    },
    toAlphaTex: function (input, meta) {
      return powerTabToRender(input, meta).tex;
    },
    toRender: powerTabToRender,
    toChart: powerTabToChart,
    decodeChord: _ptbDecodeChord,
  };
}

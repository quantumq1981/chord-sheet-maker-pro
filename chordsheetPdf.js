/**
 * chordsheetPdf.js — import chordsheet.com fakebook PDFs (browser global +
 * window.ChordsheetPdf).
 *
 * chordsheet.com exports a "barline ASCII" fakebook whose PDF text layer is NOT
 * plain text: it uses a private-use-area (PUA) music font where accidentals,
 * chord-quality superscripts, barlines and similes are custom glyphs. This module
 * maps those glyphs back to text and tokenises the result into CSMPN.
 *
 * The pure functions (decodeChordsheetGlyphs, isChordsheetText, groupItemsIntoText,
 * chordsheetTextToCsmpn) take no DOM/pdfjs and are unit-tested against the real
 * extracted text. importUGProPDF (importPipeline.js) feeds pdfjs text items in.
 *
 * Glyph map verified against "Got it wrong blues" (chordsheet.com/song/339643).
 * Codepoints are referenced via String.fromCharCode so the source stays ASCII.
 */
(function () {
  'use strict';

  var C = String.fromCharCode;
  var FLAT = C(0xe10d),
    SHARP = C(0xe10c), // best-guess sibling codepoint; the sample had no sharps
    SEVEN = C(0xe197),
    NINE = C(0xe199),
    SIX = C(0xe196),
    THIRTEEN = C(0xe183),
    DIM = C(0xe190),
    MAJ = C(0xe180),
    TEMPO = C(0xe1d5), // tempo quarter-note glyph (header)
    METER = C(0xf587), // time-signature glyph (12/8 in the sample)
    SIMILE = C(0xe500), // measure repeat
    BAR = C(0xe030), // barline
    BAR_END = C(0xe032); // final/thick barline

  // PUA codepoint -> text. Verified from the real export.
  var GLYPH = {};
  GLYPH[FLAT] = 'b';
  GLYPH[SHARP] = '#';
  GLYPH[SEVEN] = '7';
  GLYPH[NINE] = '9';
  GLYPH[SIX] = '6';
  GLYPH[THIRTEEN] = '13';
  GLYPH[DIM] = 'o'; // diminished (°)
  GLYPH[MAJ] = 'maj'; // major (MA)
  GLYPH[TEMPO] = '';
  GLYPH[METER] = '';
  GLYPH[SIMILE] = ' \x01 '; // sentinel -> %
  GLYPH[BAR] = ' | ';
  GLYPH[BAR_END] = ' | ';

  // Time-signature glyphs (extend as more meters are seen). U+F587 = 12/8.
  var METER_GLYPHS = {};
  METER_GLYPHS[METER] = '12/8';

  // Glyphs that mark a line as musical content (chords/barlines/quality).
  var MUSIC_GLYPHS = [FLAT, SHARP, SEVEN, NINE, SIX, THIRTEEN, DIM, MAJ, SIMILE, BAR, BAR_END];
  var MUSIC_GLYPH_RE = new RegExp('[' + MUSIC_GLYPHS.join('') + ']');

  function isChordsheetText(text) {
    var t = String(text || '');
    return /chordsheet\.com/i.test(t) || t.indexOf(BAR) >= 0;
  }

  /** Replace every PUA glyph with its text meaning. Pure. */
  function decodeChordsheetGlyphs(text) {
    var s = String(text == null ? '' : text);
    for (var g in GLYPH) {
      if (Object.prototype.hasOwnProperty.call(GLYPH, g)) {
        s = s.split(g).join(GLYPH[g]);
      }
    }
    return s;
  }

  /** Detect the chart meter from a time-signature glyph, default 4/4. Pure. */
  function detectMeter(rawText) {
    var t = String(rawText || '');
    for (var g in METER_GLYPHS) {
      if (Object.prototype.hasOwnProperty.call(METER_GLYPHS, g) && t.indexOf(g) >= 0) {
        return METER_GLYPHS[g];
      }
    }
    return '4/4';
  }

  // Decode one chord-content line -> array of CSMPN bar tokens.
  function barsFromLine(line) {
    var d = decodeChordsheetGlyphs(line).replace(/\x01/g, ' % ');
    d = d.replace(/(\|\s*)+/g, '|'); // collapse barline runs/spacing -> one barline
    return d
      .split('|')
      .map(function (b) {
        return b.trim();
      })
      .filter(Boolean)
      .map(function (b) {
        // multiple chords in one bar -> CSMPN underscore-joined token
        return b.split(/\s+/).join('_');
      });
  }

  var SECTION_RE =
    /^(=\s*)?(intro|verse|chorus|pre[-\s]?chorus|bridge|solo|outro|tag|interlude|coda|\d(?:st|nd|rd|th)\s+ending|turnaround)\b/i;

  function cleanSectionLabel(s) {
    return s
      .replace(/^=\s*/, '')
      .replace(/[“”"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Convert chordsheet.com extracted text (newline-separated lines, glyphs intact)
   * into CSMPN. Pure. `opts.barsPerRow` (default 4) controls line wrapping.
   */
  function chordsheetTextToCsmpn(text, opts) {
    opts = opts || {};
    var bpr = Math.max(1, opts.barsPerRow || 4);
    var lines = String(text || '').split(/\r?\n/);
    var meta = { title: '', tempo: '', style: '', time: detectMeter(text) };
    var sections = [];
    var cur = null;

    function section(label) {
      cur = { label: label, bars: [] };
      sections.push(cur);
    }

    for (var i = 0; i < lines.length; i++) {
      var s = lines[i].replace(/ /g, ' ').trim();
      if (!s) continue;
      if (/chordsheet\.com/i.test(s) || /powered by tcpdf/i.test(s) || /page \d+ of/i.test(s)) {
        continue;
      }

      // tempo / style header line (carries the tempo glyph)
      if (s.indexOf(TEMPO) >= 0) {
        var dec = decodeChordsheetGlyphs(s);
        var mt = dec.match(/=\s*(\d+)/);
        if (mt) meta.tempo = mt[1];
        var st = dec.replace(/^=?\s*\d+\s*/, '').trim();
        if (st) meta.style = st;
        continue;
      }

      // musical content line -> bars
      if (MUSIC_GLYPH_RE.test(s)) {
        if (!cur) section('Chart');
        var bars = barsFromLine(s);
        for (var k = 0; k < bars.length; k++) cur.bars.push(bars[k]);
        continue;
      }

      // no music glyphs: section label, big rehearsal letter, title, or noise
      if (SECTION_RE.test(s)) {
        section(cleanSectionLabel(s));
        continue;
      }
      if (/^[“"]?[A-C][”"]?$/.test(s)) continue; // bare AABA letter -> drop
      if (!meta.title) {
        meta.title = s.replace(/\s{2,}.*$/, '').trim(); // first content line = title
      }
    }

    var out = [];
    if (meta.title) out.push('Title: ' + meta.title);
    if (meta.style) out.push('Style: ' + meta.style);
    out.push('Time: ' + meta.time);
    if (meta.tempo) out.push('Tempo: ' + meta.tempo);
    out.push('');
    if (!sections.length) sections.push({ label: 'Chart', bars: [] });
    for (var s2 = 0; s2 < sections.length; s2++) {
      var sec = sections[s2];
      out.push('- ' + (sec.label || 'Chart'));
      var bb = sec.bars.length ? sec.bars : ['N.C.'];
      for (var j = 0; j < bb.length; j += bpr) out.push(bb.slice(j, j + bpr).join(' '));
      out.push('');
    }
    return out.join('\n').trim() + '\n';
  }

  /**
   * Reconstruct newline-separated text from pdfjs text items, gap-aware so split
   * glyph runs (B + flat + 7) re-join into "Bb7" while real spaces stay spaces.
   * `items`: [{ str, x, y, w, fontSize }]. Browser glue passes pdfjs items here.
   */
  function groupItemsIntoText(items) {
    if (!items || !items.length) return '';
    var rows = [];
    var tol = 3;
    var sorted = items.slice().sort(function (a, b) {
      return b.y - a.y || a.x - b.x;
    });
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var row = null;
      for (var r = 0; r < rows.length; r++) {
        if (Math.abs(rows[r].y - it.y) <= tol) {
          row = rows[r];
          break;
        }
      }
      if (!row) {
        row = { y: it.y, items: [] };
        rows.push(row);
      }
      row.items.push(it);
    }
    rows.sort(function (a, b) {
      return b.y - a.y;
    });
    var out = [];
    for (var j = 0; j < rows.length; j++) {
      var line = '';
      var ri = rows[j].items.sort(function (a, b) {
        return a.x - b.x;
      });
      var prevEnd = null;
      for (var m = 0; m < ri.length; m++) {
        var cell = ri[m];
        var gap = cell.fontSize ? cell.fontSize * 0.28 : 3;
        if (prevEnd != null && cell.x - prevEnd > gap) line += ' ';
        line += cell.str || '';
        prevEnd = cell.x + (cell.w || 0);
      }
      out.push(line);
    }
    return out.join('\n');
  }

  var api = {
    GLYPH: GLYPH,
    METER_GLYPHS: METER_GLYPHS,
    isChordsheetText: isChordsheetText,
    decodeChordsheetGlyphs: decodeChordsheetGlyphs,
    detectMeter: detectMeter,
    chordsheetTextToCsmpn: chordsheetTextToCsmpn,
    groupItemsIntoText: groupItemsIntoText,
  };
  if (typeof window !== 'undefined') window.ChordsheetPdf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

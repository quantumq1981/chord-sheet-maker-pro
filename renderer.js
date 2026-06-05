/* renderer.js — CSMPN fake-book HTML renderer and VexFlow notation renderer
   Extracted from index.html (Sprint 5.3, item 2.1D).
   Loaded after settings.js and chordProcessing.js. All symbols are global.
   Depends on: escapeHtml (utils.js), fbSettings/setStatus (settings.js),
               parseCSMPN (csmpnParser.js), renderChordToken/isBarlineToken (chordProcessing.js)
*/

// Track rehearsal letters for auto-assignment
let rehearsalLetterIndex = 0;
const REHEARSAL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

// Track VexFlow notation block IDs (reset on each updatePreview)
let _vtBlockId = 0;

function renderTimeSig(timeStr){
  // Render time signature as stacked fraction-style
  const m = (timeStr || '').match(/^(\d+)\/(\d+)$/);
  if (!m) return `<div class="timeSig">${escapeHtml(timeStr)}</div>`;
  return `<div class="timeSig" style="display:flex;flex-direction:column;align-items:center;line-height:0.95;font-size:calc(24px * var(--fb-font-scale));">
    <span>${escapeHtml(m[1])}</span>
    <span>${escapeHtml(m[2])}</span>
  </div>`;
}

function renderDoc(doc){
  validationWarnings = [];
  rehearsalLetterIndex = 0;

  let html = '';
  if (doc.title || doc.style || doc.key || doc.time || doc.tempo || doc.composer){
    // ChordSheet.com style: annotation line in parentheses above title
    const metaBits = [];
    if (doc.style) metaBits.push(doc.style);
    if (doc.key) metaBits.push(`Key of ${doc.key}`);
    const metaStr = metaBits.length ? metaBits.join(', ') : '';
    const metaLine = metaStr ? `<div class="headerMeta">(${escapeHtml(metaStr)})</div>` : '';
    const composerLine = doc.composer ? `<div class="headerComposer">${escapeHtml(doc.composer)}</div>` : '';
    const tempoLine = doc.tempo ? `<div class="tempoLine">♩=${escapeHtml(doc.tempo)}</div>` : '';
    const timeSig = doc.time ? renderTimeSig(doc.time) : '';
    html += `
      <div class="sheetHeader">
        <div class="headerInfo">
          ${metaLine}
          ${doc.title ? `<div class="songTitle">${escapeHtml(doc.title)}</div>` : ''}
          ${composerLine}
        </div>
        <div class="headerRight">
          ${tempoLine}
          ${timeSig}
        </div>
      </div>`;
  }

  for (const block of doc.blocks){
    if (block.type === 'pagebreak'){
      html += `<div class="pageBreak"></div>`;
      continue;
    }
    if (block.type === 'marker'){
      html += renderSectionMarker(block);
      continue;
    }
    if (block.type === 'bars'){
      html += renderBars(block.tokens, block.indent || 0);
      continue;
    }
    if (block.type === 'notation'){
      const id = `vt${++_vtBlockId}`;
      html += `<div class="notation-block" id="${escapeHtml(id)}" data-vt="${escapeHtml(block.content)}"></div>`;
      continue;
    }
  }

  if (!doc.blocks.length){
    html += `<div style="color:#666; font-size:14px; text-align:center; padding: 40px 10px;">
      Import a file or paste CSMPN to preview.
    </div>`;
  }

  // Page footer
  if (fbSettings.footer === 'visible' && doc.blocks.length){
    const now = new Date().toISOString().slice(0,10);
    const pageBreaks = doc.blocks.filter(b => b.type === 'pagebreak').length;
    const totalPages = pageBreaks + 1;
    html += `<div class="sheetFooter">
      <span>ChordSheet CSMPN Builder</span>
      <span>page 1 of ${totalPages}</span>
      <span>last edited ${now}</span>
    </div>`;
  }

  if (validationWarnings.length){
    const warnMsg = validationWarnings.join('\n');
    setStatus(warnMsg, 'warning');
  }

  return html;
}

function renderSectionMarker(block){
  const t = escapeHtml(block.text || '');

  if (block.marker === '-' || block.marker === ':'){
    // Fake book style: show rehearsal letter + section name in label boxes
    const letter = REHEARSAL_LETTERS[rehearsalLetterIndex] || '';
    rehearsalLetterIndex++;
    let letterHtml = letter ? `<span class="rehearsalLetter">${letter}</span>` : '';
    return `<div class="sectionBlock">${letterHtml}<span class="labelBox">${t}</span></div>`;
  }

  if (block.marker === '='){
    // Section divider with label - show as = label
    const letter = REHEARSAL_LETTERS[rehearsalLetterIndex] || '';
    rehearsalLetterIndex++;
    let letterHtml = letter ? `<span class="rehearsalLetter">${letter}</span>` : '';
    return `<div class="sectionBlock">${letterHtml}<span class="labelBox">${t}</span></div>`;
  }

  if (block.marker === ';'){
    return `<div class="annotation">${t}</div>`;
  }
  if (block.marker === '#'){
    return `<div class="annotation"><span style="font-size:0.85em">#</span> ${t}</div>`;
  }
  return '';
}

/* Performance: cache grid templates — only 7 possible values (2-8 bars) */
const _gridTemplateCache = {};
function buildGridTemplate(barsPerRow){
  if (_gridTemplateCache[barsPerRow]) return _gridTemplateCache[barsPerRow];
  const cols = ['14px'];
  for (let i = 0; i < barsPerRow; i++){
    cols.push('minmax(0, 1fr)');
    cols.push('14px');
  }
  const result = cols.join(' ');
  _gridTemplateCache[barsPerRow] = result;
  return result;
}

function renderBars(tokens, indent){
  const bars = parseBarStructures(tokens);
  const bpr = fbSettings.barsPerRow;
  const gridTemplate = buildGridTemplate(bpr);
  const alignClass = fbSettings.chordAlign === 'center' ? ' center-align' : '';
  const indentStyle = indent ? ` style="margin-left:${indent * 2}em"` : '';

  let html = `<div class="barsBlock"${indentStyle}>`;
  let activeEnding = null;

  for (let i = 0; i < bars.length; i += bpr){
    const row = bars.slice(i, i + bpr);

    // Pad to barsPerRow
    while (row.length < bpr){
      row.push({ token: '', leftBar: 'single', rightBar: 'single' });
    }

    const segments = [];
    let currentLabel = activeEnding;
    let startIndex = currentLabel ? 0 : null;

    row.forEach((bar, idx) => {
      if (bar.endingLabel){
        if (currentLabel !== null && idx > 0){
          segments.push({ label: currentLabel, start: startIndex, end: idx - 1 });
        }
        currentLabel = bar.endingLabel.replace('.', '').trim();
        startIndex = idx;
      }
    });
    if (currentLabel !== null && startIndex !== null){
      segments.push({ label: currentLabel, start: startIndex, end: row.length - 1 });
    }
    activeEnding = currentLabel;
    if (row.some((bar) => ['repeat-end', 'final'].includes(bar.rightBar))){
      activeEnding = null;
    }

    html += `<div class="barlineRow" style="grid-template-columns:${gridTemplate}">`;
    html += renderBarline(row[0]?.leftBar || 'single');

    row.forEach((bar) => {
      html += renderMeasure(bar.token || '', alignClass);
      html += renderBarline(bar.rightBar || 'single');
    });

    html += renderEndingSegments(segments);
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function renderMeasure(measureText, alignClass){
  const cls = alignClass || '';
  const raw = (measureText || '').trim();
  if(!raw){
    return `<div class="measure${cls}"><div class="beats"><span class="beat"></span></div></div>`;
  }
  const beats = raw.split('_').map(s => s.trim()).filter(Boolean);
  const beatHtml = (beats.length ? beats : [raw]).map((b) => renderBeatContent(b)).join('');
  return `<div class="measure${cls}"><div class="beats">${beatHtml}</div></div>`;
}

// ── Hybrid Rhythm Guitar Chart — SVG Renderer ────────────────────────────
// Pure inline SVG for iOS Safari print-to-PDF stability.
// No Unicode music glyphs, no CSS gradients — all notation as SVG primitives.

const HR_PAGE_W  = 760;
const HR_MARGIN  = 20;
const HR_CLEF_W  = 48; // clef glyph + key-signature accidentals
const HR_BAR_PAD = 7;
const HR_CHORD_H = 28;
const HR_PM_H    = 14;
const HR_LG      = 8;
const HR_STAFF_H = 32;
const HR_MID     = 16;
const HR_STEM_TY = -14;
const HR_TAB_SEP = 12;
const HR_TAB_LG  = 8;
const HR_TAB_H   = 40;
const HR_SYS_BOT   = 22;
const HR_SLBL_H    = 20;
const HR_CUE_H     = 14;
const HR_TUPLET_H  = 14;
const HR_END_H     = 16; // reserved band above the chord area for 1st/2nd ending brackets

const HR_DIAG_STRING_GAP = 9;
const HR_DIAG_FRET_GAP   = 10;
const HR_DIAG_STRINGS    = 6;
const HR_DIAG_FRETS      = 4;
const HR_DIAG_W          = (HR_DIAG_STRINGS - 1) * HR_DIAG_STRING_GAP;

function _hrFont() {
  return (
    window.__SN_NOTATION_FONT_FAMILY ||
    '"EB Garamond", Georgia, "Times New Roman", "CSMPN Music", serif'
  );
}
// Embedded music-glyph font (clef, accidentals, segno/coda). Leads the stack so
// these glyphs always render; falls back to the notation font for everything else.
function _hrMusicFont() {
  const fam = (typeof window !== 'undefined' && window.MUSIC_FONT_FAMILY) || 'CSMPN Music';
  return '"' + fam + '", ' + _hrFont();
}
// <style> carrying the embedded @font-face, injected into each generated <svg>
// so the font travels with downloads + the iOS print-to-PDF popup (a fresh
// document that does not inherit the page stylesheet). Empty if not loaded.
function _hrMusicFontStyle() {
  const css = typeof window !== 'undefined' && window.MUSIC_FONT_FACE;
  return css ? `<defs><style type="text/css">${css}</style></defs>` : '';
}
const HR_DIAG_H          = HR_DIAG_FRETS * HR_DIAG_FRET_GAP;
const HR_DIAG_OUTER_W    = HR_DIAG_W + 22;
const HR_DIAG_OUTER_H    = HR_DIAG_H + 46;

function hrL(x1, y1, x2, y2, col, w) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}"/>`;
}

function hrHead(cx, cy, dur, col, muted) {
  if (muted) {
    const r = 4.5;
    return `<line x1="${cx-r}" y1="${cy-r}" x2="${cx+r}" y2="${cy+r}" stroke="${col}" stroke-width="1.8" stroke-linecap="round"/>` +
           `<line x1="${cx+r}" y1="${cy-r}" x2="${cx-r}" y2="${cy+r}" stroke="${col}" stroke-width="1.8" stroke-linecap="round"/>`;
  }
  const W = 9, H = 5.5, lean = 5;
  const pts = (dx) =>
    `${cx-W+lean+dx},${cy-H} ${cx+W+lean+dx},${cy-H} ${cx+W-lean+dx},${cy+H} ${cx-W-lean+dx},${cy+H}`;
  if (dur === 'w')
    return `<polygon points="${pts(0)}" fill="none" stroke="${col}" stroke-width="1.3"/>` +
           `<polygon points="${pts(4)}" fill="none" stroke="${col}" stroke-width="1.3"/>`;
  if (dur === 'h') return `<polygon points="${pts(0)}" fill="none" stroke="${col}" stroke-width="1.3"/>`;
  return `<polygon points="${pts(0)}" fill="${col}"/>`;
}

function hrStem(cx, staffY, col) {
  return hrL(cx + 6, staffY + HR_MID - 5, cx + 6, staffY + HR_STEM_TY, col, 1.5);
}

function hrFlags(cx, stemTopY, n, col) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const y = stemTopY + i * 7;
    s += `<path d="M${cx+6},${y} Q${cx+17},${y+5} ${cx+10},${y+11}" stroke="${col}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
  }
  return s;
}

function hrBeam(x1, x2, y, col) {
  return `<rect x="${x1+6}" y="${y-2}" width="${x2-x1}" height="3.5" fill="${col}" rx="0.5"/>`;
}

function hrTupletBracket(x1, x2, topY, n, col) {
  const mid = (x1 + x2) / 2;
  return (
    `<text x="${mid}" y="${topY + 3}" font-size="8" fill="${col}" text-anchor="middle" font-family='${_hrFont()}'>${n}</text>` +
    hrL(x1, topY + 5, x2, topY + 5, col, 1) +
    hrL(x1, topY + 5, x1, topY + 10, col, 1) +
    hrL(x2, topY + 5, x2, topY + 10, col, 1)
  );
}

function hrRest(cx, cy, dur, col) {
  switch (dur) {
    case 'w':
      return `<rect x="${cx-7}" y="${cy-2}" width="14" height="5" fill="${col}"/>` +
             hrL(cx - 9, cy - 2, cx + 9, cy - 2, col, 1);
    case 'h':
      return `<rect x="${cx-7}" y="${cy-7}" width="14" height="5" fill="${col}"/>` +
             hrL(cx - 9, cy - 2, cx + 9, cy - 2, col, 1);
    case 'q':
      return (
        `<path d="M${cx-4},${cy-12} L${cx+5},${cy-7} L${cx-3},${cy-1} Q${cx+7},${cy+5} ${cx},${cy+9}" ` +
        `stroke="${col}" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
      );
    default:
      return (
        `<circle cx="${cx}" cy="${cy-3}" r="2.2" fill="${col}"/>` +
        `<path d="M${cx},${cy-1} Q${cx+7},${cy+3} ${cx+2},${cy+9}" stroke="${col}" stroke-width="1.5" fill="none" stroke-linecap="round"/>` +
        hrL(cx + 2, cy + 9, cx + 2, cy + 13, col, 1.5)
      );
  }
}

function hrStaff(x, y, w, col) {
  let s = '';
  for (let i = 0; i < 5; i++) s += hrL(x, y + i * HR_LG, x + w, y + i * HR_LG, col, 1);
  return s;
}

function hrClef(x, y, col) {
  // Treble clef glyph (U+1D11E), matching the slash-notation panel for visual
  // parity. Single-quoted attribute so the inner double-quoted families from
  // _hrFont() stay valid.
  return `<text x="${x}" y="${y + HR_STAFF_H * 0.82}" font-size="40" fill="${col}" font-family='${_hrMusicFont()}' letter-spacing="-1">&#x1D11E;</text>`;
}

// ── Key signature ───────────────────────────────────────────────────────────
// Treble-clef accidental y-offsets from staff top (sharp order F C G D A E B).
// Staff geometry (HR_STAFF_H=32, HR_LG=8) matches the slash panel, so these port directly.
const HR_SHARP_Y = [0, 12, -4, 8, 20, 4, 16];
const HR_FLAT_Y  = [16, 4, 20, 8, 24, 12, 28];

// Fifths count for the visual key signature; delegates to the shared MusicXML core.
function hrKeySigFromKey(keyStr) {
  return mxKeyFifths(keyStr);
}

function hrKeySig(staffY, count, col) {
  if (!count) return '';
  const isSharp = count > 0;
  const n = Math.min(Math.abs(count), 7);
  const sym = isSharp ? '♯' : '♭';
  const yOff = isSharp ? HR_SHARP_Y : HR_FLAT_Y;
  let s = '';
  const x0 = HR_MARGIN + 24; // just right of the clef glyph
  for (let i = 0; i < n; i++)
    s += `<text x="${x0 + i * 6}" y="${staffY + yOff[i] + 7}" font-size="9" font-weight="bold" fill="${col}" font-family='${_hrMusicFont()}'>${sym}</text>`;
  return s;
}

// ── Navigation markers (D.C., D.S., Fine, Coda) ─────────────────────────────
// Ported from the slash-notation panel for parity.
const HR_NAV_RE = /\b(D\.C\.|D\.S\.|FINE|CODA|AL FINE|AL CODA|DAL SEGNO|DA CAPO|TO CODA|SEGNO)\b/i;

function hrExtractNavText(label) {
  return label && HR_NAV_RE.test(label) ? label : null;
}

// Substitute Segno/Coda words with their Unicode musical symbols, then escape.
function hrFormatNavText(text) {
  if (!text) return '';
  const subst = String(text)
    .replace(/\bDAL\s+SEGNO\b/gi, 'D.S.𝄋')
    .replace(/\bDA\s+CAPO\b/gi, 'D.C.')
    .replace(/\bD\.S\.(?=\s|$)/g, 'D.S.𝄋')
    .replace(/\bSEGNO\b/gi, '𝄋')
    .replace(/\bTO\s+CODA\b/gi, 'To 𝄌')
    .replace(/\bAL\s+CODA\b/gi, 'al 𝄌')
    .replace(/\bCODA\b/gi, '𝄌');
  return escapeHtml(subst);
}

// Strum arrow glyph for a beat index, per mode. pattern is an array of D/U/X/V/-.
// Mirrors strumChar() in the slash-notation panel.
function hrStrumChar(beat, mode, pattern) {
  if (!mode || mode === 'none') return null;
  if (mode === 'custom' && pattern && pattern.length) {
    const c = pattern[beat % pattern.length];
    if (c === 'D') return '↓';
    if (c === 'U') return '↑';
    if (c === 'X' || c === 'V') return '×';
    return null; // '-' = rest, no arrow
  }
  if (mode === 'alt') return beat % 2 === 0 ? '↓' : '↑';
  return '↓'; // 'down'
}

// 1st/2nd ending label → "1" | "2" | null. Matches "1.", "[2]", "1st", "2nd".
function hrEndingNumber(label) {
  if (!label) return null;
  const s = String(label).trim();
  const m = s.match(/^[\[(]?\s*([12])\s*[.)]/);
  if (m) return m[1];
  if (/^1\s*st\b/i.test(s)) return '1';
  if (/^2\s*nd\b/i.test(s)) return '2';
  return null;
}

// Integer (1–15) → Roman numeral, for capo markers.
function hrToRoman(n) {
  const pairs = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of pairs) { while (n >= v) { s += r; n -= v; } }
  return s;
}

// Capo indicator below the T/A/B label on the first TAB row.
function hrCapoMarker(capoNum, tabY, col) {
  if (!capoNum || capoNum < 1) return '';
  const cx = HR_MARGIN + HR_CLEF_W / 2;
  const mid = HR_TAB_H / 2;
  return `<text x="${cx}" y="${tabY + mid + 24}" font-size="7.5" font-weight="bold" font-style="italic" fill="${col}" text-anchor="middle" font-family='${_hrFont()}'>cap.${hrToRoman(capoNum)}</text>`;
}

function hrTabStaff(x, y, w, col) {
  let s = '';
  for (let i = 0; i < 6; i++) s += hrL(x, y + i * HR_TAB_LG, x + w, y + i * HR_TAB_LG, col, 0.8);
  return s;
}

function hrTabLabel(marginX, tabY, col) {
  const cx = marginX + HR_CLEF_W / 2;
  const mid = HR_TAB_H / 2;
  return ['T', 'A', 'B']
    .map((ch, i) =>
      `<text x="${cx}" y="${tabY + mid - 12 + i * 12}" font-size="9" font-weight="bold" fill="${col}" text-anchor="middle" font-family='${_hrFont()}'>${ch}</text>`,
    )
    .join('');
}

function hrFret(fret, str, cx, tabY, col, bg) {
  if (fret === '-' || fret == null) return '';
  const ly = tabY + (str - 1) * HR_TAB_LG;
  if (fret === 'x' || fret === 'X')
    return `<text x="${cx}" y="${ly+3}" font-size="7" fill="${col}" text-anchor="middle" font-family="sans-serif">x</text>`;
  const t = String(fret), tw = t.length > 1 ? 12 : 9;
  return (
    `<rect x="${cx - tw / 2}" y="${ly - 4}" width="${tw}" height="8" fill="${bg}"/>` +
    `<text x="${cx}" y="${ly+3}" font-size="7" fill="${col}" text-anchor="middle" font-family="sans-serif">${escapeHtml(t)}</text>`
  );
}

function hrParseVoicing(shapeStr) {
  return String(shapeStr || '').split(',').map((s) => {
    const t = s.trim();
    if (t === 'x' || t === 'X') return 'x';
    if (t === '-') return '-';
    const n = parseInt(t, 10);
    return isNaN(n) ? '-' : n;
  });
}

function hrChordDiagram(name, voicing, ox, oy, fg) {
  let s = '';
  s += `<text x="${ox + HR_DIAG_OUTER_W / 2}" y="${oy + 11}" font-size="10" font-weight="bold" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>${escapeHtml(name)}</text>`;
  const disp = voicing ? [...voicing].reverse() : Array(HR_DIAG_STRINGS).fill('-');
  let minFret = Infinity;
  for (const f of disp) { if (typeof f === 'number' && f > 0 && f < minFret) minFret = f; }
  const atNut    = !isFinite(minFret) || minFret <= 1;
  const baseFret = atNut ? 0 : minFret - 1;
  const gridX = ox + 10;
  const nutY  = oy + 22;
  s += `<line x1="${gridX}" y1="${nutY}" x2="${gridX + HR_DIAG_W}" y2="${nutY}" stroke="${fg}" stroke-width="${atNut ? 3 : 1}"/>`;
  if (!atNut)
    s += `<text x="${gridX + HR_DIAG_W + 3}" y="${nutY + 5}" font-size="7" fill="${fg}" font-family='${_hrFont()}'>${baseFret + 1}fr</text>`;
  for (let i = 0; i < HR_DIAG_STRINGS; i++) {
    const sx = gridX + i * HR_DIAG_STRING_GAP;
    s += `<line x1="${sx}" y1="${nutY}" x2="${sx}" y2="${nutY + HR_DIAG_H}" stroke="${fg}" stroke-width="0.8"/>`;
  }
  for (let fi = 1; fi <= HR_DIAG_FRETS; fi++)
    s += `<line x1="${gridX}" y1="${nutY + fi * HR_DIAG_FRET_GAP}" x2="${gridX + HR_DIAG_W}" y2="${nutY + fi * HR_DIAG_FRET_GAP}" stroke="${fg}" stroke-width="0.8"/>`;
  for (let di = 0; di < HR_DIAG_STRINGS; di++) {
    const sx   = gridX + di * HR_DIAG_STRING_GAP;
    const fret = di < disp.length ? disp[di] : '-';
    if (fret === 'x') {
      s += `<text x="${sx}" y="${nutY - 3}" font-size="7" font-weight="bold" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>x</text>`;
    } else if (fret === 0) {
      s += `<circle cx="${sx}" cy="${nutY - 7}" r="3" fill="none" stroke="${fg}" stroke-width="1"/>`;
    } else if (typeof fret === 'number' && fret > 0) {
      const relFret = fret - baseFret;
      if (relFret >= 1 && relFret <= HR_DIAG_FRETS)
        s += `<circle cx="${sx}" cy="${nutY + (relFret - 0.5) * HR_DIAG_FRET_GAP}" r="3.5" fill="${fg}"/>`;
    }
  }
  return s;
}

function hrBeatX(beat, timeSig, barLeft, barUsableW) {
  const nb = Number(String(timeSig || '4/4').split('/')[0]) || 4;
  return barLeft + ((beat - 1) / nb) * barUsableW;
}

// Number of visual slash beats per bar, following Real Book convention for
// compound meters (6/8 -> 2, 9/8 -> 3, 12/8 -> 4). Mirrors visualBeats() in the
// slash-notation panel so the unified engine draws one slash per dotted-quarter
// pulse instead of one per eighth (which merges into a solid black bar).
function hrVisualBeats(timeSig) {
  const m = String(timeSig || '4/4').match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return 4;
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  if (den === 8 && num >= 6 && num % 3 === 0) return num / 3;
  return Math.max(1, num);
}

// Compound meters (6/8, 9/8, 12/8): each visual beat is a dotted quarter.
function hrIsCompoundMeter(timeSig) {
  const m = String(timeSig || '4/4').match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) return false;
  const num = parseInt(m[1], 10);
  const den = parseInt(m[2], 10);
  return den === 8 && num >= 6 && num % 3 === 0;
}

// Augmentation dot to the right of a slash notehead (dotted-quarter pulse).
function hrAugDot(cx, cy, col) {
  return `<circle cx="${cx + 12}" cy="${cy}" r="1.6" fill="${col}"/>`;
}

function hrBar(bar, barLeft, staffY, barW, fg, cc, bg) {
  const events  = Array.isArray(bar?.events) ? bar.events : [];
  const tabs    = Array.isArray(bar?.tabEvents) ? bar.tabEvents : [];
  const timeSig = bar?.timeSig || '4/4';
  const ul      = barLeft + HR_BAR_PAD;
  const uw      = barW - HR_BAR_PAD * 2;
  const cy      = staffY + HR_MID;
  const stemTopY = staffY + HR_STEM_TY;
  const tabY    = staffY + HR_STAFF_H + HR_TAB_SEP;
  let s = '';

  if (!events.length) {
    // Zero-rhythm case: one slash per visual beat. Compound meters collapse to
    // dotted-quarter pulses via hrVisualBeats() so 12/8 draws 4 slashes, not 12.
    const vb = hrVisualBeats(timeSig);
    const dotted = hrIsCompoundMeter(timeSig);
    if (bar.chordToken) {
      const parts = String(bar.chordToken).replace(/[!~]$/, '').trim().split('_').map(p => p.trim()).filter(Boolean);
      parts.forEach((chord, pi) => {
        const cx = ul + (pi / parts.length) * uw;
        s += `<text x="${cx}" y="${staffY - 12}" font-size="13" fill="${cc}" text-anchor="start" font-weight="bold" font-family='${_hrFont()}'>${escapeHtml(chord)}</text>`;
      });
      for (let b = 1; b <= vb; b++) {
        const ex = ul + ((b - 1) / vb) * uw;
        s += hrHead(ex, cy, 'q', fg);
        s += hrStem(ex, staffY, fg);
        if (dotted) s += hrAugDot(ex, cy, fg);
      }
    } else {
      s += hrRest(barLeft + barW / 2, cy, 'w', fg);
    }
    return s;
  }

  if (bar?.pm?.bar) {
    const pmY = staffY - 2;
    s += `<text x="${ul}" y="${pmY - 3}" font-size="8" fill="${fg}" font-family='${_hrFont()}' font-style="italic">P.M.</text>`;
    s += `<line x1="${ul + 22}" y1="${pmY - 3}" x2="${barLeft + barW - HR_BAR_PAD}" y2="${pmY - 3}" stroke="${fg}" stroke-width="1" stroke-dasharray="3,2"/>`;
  }

  // Beam grouping: consecutive e/s events within the same integer beat are beamed together.
  // Tuplet events (ev.tuplet > 0) beam across beat boundaries within their tuplet group.
  const beamOf = new Array(events.length).fill(-1);
  let gi = 0;
  for (let i = 0; i < events.length; ) {
    if (events[i].type !== 'slash' || !['e', 's'].includes(events[i].duration)) { i++; continue; }
    const isTuplet = events[i].tuplet > 0;
    const tupletN  = events[i].tuplet;
    const beatGrp  = Math.floor(events[i].beat);
    let j = i + 1;
    while (j < events.length && events[j].type === 'slash' && ['e', 's'].includes(events[j].duration)) {
      if (isTuplet) {
        if (events[j].tuplet !== tupletN) break;
      } else {
        if (events[j].tuplet > 0 || Math.floor(events[j].beat) !== beatGrp) break;
      }
      j++;
    }
    if (j - i >= 2) { for (let k = i; k < j; k++) beamOf[k] = gi; gi++; }
    i = j;
  }
  const xs = events.map((ev) => hrBeatX(ev.beat, timeSig, ul, uw));

  // Span-level P.M. — scoped to specific event index range
  if (bar.pm?.spans?.length > 0) {
    const nbPM = Number(String(timeSig).split('/')[0]) || 4;
    const beatW = uw / nbPM;
    for (const span of bar.pm.spans) {
      const si = Math.max(0, Math.min(span.startIndex, events.length - 1));
      const ei = Math.max(si, Math.min(span.endIndex, events.length - 1));
      if (!events[si] || !events[ei]) continue;
      const pmY = staffY - 2;
      const x1 = xs[si];
      const x2 = Math.min(xs[ei] + events[ei].beats * beatW, barLeft + barW - HR_BAR_PAD);
      s += `<text x="${x1}" y="${pmY - 3}" font-size="8" fill="${fg}" font-family='${_hrFont()}' font-style="italic">P.M.</text>`;
      s += `<line x1="${x1 + 22}" y1="${pmY - 3}" x2="${x2}" y2="${pmY - 3}" stroke="${fg}" stroke-width="1" stroke-dasharray="3,2"/>`;
      s += hrL(x2, pmY - 6, x2, pmY, fg, 1);
    }
  }

  const beamGroups = {};
  beamOf.forEach((g, i) => { if (g >= 0) (beamGroups[g] = beamGroups[g] || []).push(i); });
  for (const idxs of Object.values(beamGroups)) {
    const bx1 = xs[idxs[0]], bx2 = xs[idxs[idxs.length - 1]];
    s += hrBeam(bx1, bx2, stemTopY, fg);
    if (events[idxs[0]].duration === 's') s += hrBeam(bx1, bx2, stemTopY + 6, fg);
  }

  const hasTupletEvents = events.some((ev) => ev.tuplet > 0);
  const anyEvChord = events.some((ev) => ev.chord);

  // Tuplet brackets: ⌐ N ¬ above groups of notes sharing the same tuplet value
  if (hasTupletEvents) {
    const bracketY = staffY - 38;
    for (let ti = 0; ti < events.length; ) {
      const n = events[ti].tuplet || 0;
      if (!n) { ti++; continue; }
      let tj = ti + 1;
      while (tj < events.length && events[tj].tuplet === n) tj++;
      // Split into sub-groups of n events each and render a bracket per sub-group
      for (let tk = ti; tk < tj; tk += n) {
        const grpEnd = Math.min(tk + n - 1, tj - 1);
        if (grpEnd > tk)
          s += hrTupletBracket(xs[tk], xs[grpEnd] + 9, bracketY, n, fg);
      }
      ti = tj;
    }
  }

  // Render bar-level chord token when no per-event chord is set; split multi-chord tokens
  if (!anyEvChord && bar.chordToken) {
    const nb2 = Number(String(timeSig).split('/')[0]) || 4;
    const parts2 = String(bar.chordToken).replace(/[!~]$/, '').trim().split('_').map(p => p.trim()).filter(Boolean);
    const step2 = nb2 / parts2.length;
    parts2.forEach((chord, pi) => {
      const cx = hrBeatX(1 + pi * step2, timeSig, ul, uw);
      s += `<text x="${cx}" y="${staffY - 12}" font-size="13" fill="${cc}" text-anchor="start" font-weight="bold" font-family='${_hrFont()}'>${escapeHtml(chord)}</text>`;
    });
  }

  events.forEach((ev, i) => {
    if (!ev.chord) return;
    s += `<text x="${xs[i]}" y="${staffY - 12}" font-size="13" fill="${cc}" text-anchor="middle" font-weight="bold" font-family='${_hrFont()}'>${escapeHtml(String(ev.chord).replace(/[!~]$/, '').trim())}</text>`;
  });

  events.forEach((ev, i) => {
    const ex = xs[i];
    if (ev.type === 'rest') {
      s += hrRest(ex, cy, ev.duration, fg);
    } else {
      s += hrHead(ex, cy, ev.duration, fg, ev.muted);
      if (ev.duration !== 'w') {
        s += hrStem(ex, staffY, fg);
        if (beamOf[i] < 0) {
          if (ev.duration === 'e') s += hrFlags(ex, stemTopY, 1, fg);
          if (ev.duration === 's') s += hrFlags(ex, stemTopY, 2, fg);
        }
      }
    }
    if (ev.accent)
      s += `<text x="${ex}" y="${staffY - 28}" font-size="10" fill="${fg}" text-anchor="middle" font-weight="bold">&gt;</text>`;
  });

  tabs.forEach((te) => {
    const tx = hrBeatX(te.beat, timeSig, ul, uw);
    String(te.shape || '').split(',').forEach((fret, si) => { s += hrFret(fret.trim(), si + 1, tx, tabY, fg, bg); });
  });

  return s;
}

function renderHybridDoc(sourceText) {
  const hybrid =
    typeof parseHybridChartFromCSMPN === 'function'
      ? parseHybridChartFromCSMPN(sourceText || '')
      : null;
  // Unified slash/rhythm engine: a plain chart (no {hybrid} blocks) renders as the
  // zero-rhythm case — even slash noteheads per beat with chord labels — through the
  // same SVG path that draws full rhythm charts. `hrBar()` already handles the
  // no-events bar. Only fall back to the fake-book HTML renderer when there is no
  // chart content at all (e.g. empty source or a parse that yields no sections).
  if (!hybrid || !Array.isArray(hybrid.sections) || hybrid.sections.length === 0)
    return renderDoc(parseCSMPN(sourceText || ''));

  validationWarnings = [];
  rehearsalLetterIndex = 0;
  if (hybrid.warnings?.length) validationWarnings.push(...hybrid.warnings);

  const fg  = fbSettings.fgColor    || '#111111';
  const bg  = fbSettings.bgColor    || '#ffffff';
  const cc  = fbSettings.chordColor || '#0044cc';
  const bpr = Math.max(1, Math.min(8, Number(fbSettings.barsPerRow) || 4));
  const staffX = HR_MARGIN + HR_CLEF_W;
  const staffW = HR_PAGE_W - HR_MARGIN * 2 - HR_CLEF_W;
  const strumMode = fbSettings.strumMode || 'none';
  const strumPattern = (strumMode === 'custom' && fbSettings.strumPattern)
    ? String(fbSettings.strumPattern).toUpperCase().split('').filter((c) => 'DUXV-'.includes(c))
    : null;

  const systems = [];
  for (const sec of hybrid.sections) {
    let firstRow = true;
    for (let i = 0; i < sec.bars.length; i += bpr) {
      const rowBars = sec.bars.slice(i, i + bpr);
      systems.push({
        sec, rowBars, firstRow,
        lastRow:   i + bpr >= sec.bars.length,
        hasTab:    rowBars.some((b) => b.tabEvents?.length > 0),
        hasPM:     rowBars.some((b) => b.pm?.bar || b.pm?.spans?.length > 0),
        hasCue:    rowBars.some((b) => b.cueText),
        hasTuplet: rowBars.some((b) => b.events?.some((e) => e.tuplet > 0)),
        hasEnding: rowBars.some((b) => hrEndingNumber(b.endingLabel)),
        secCue: firstRow ? sec.cueText : '',
      });
      firstRow = false;
    }
  }

  // Collect unique voicings (chord name → voicing array) from all tab events
  const allVoicings = new Map();
  for (const sec of hybrid.sections) {
    for (const bar of sec.bars) {
      if (bar.tabEvents?.length > 0 && bar.chordToken) {
        const name = String(bar.chordToken).replace(/[!~x]$/, '').trim();
        if (name && !allVoicings.has(name))
          allVoicings.set(name, hrParseVoicing(bar.tabEvents[0].shape));
      }
    }
  }
  const hasDiagrams = allVoicings.size > 0;
  const diagMaxPerRow = Math.max(1, Math.floor((HR_PAGE_W - HR_MARGIN * 2) / HR_DIAG_OUTER_W));
  const diagAreaH = hasDiagrams
    ? Math.ceil(allVoicings.size / diagMaxPerRow) * HR_DIAG_OUTER_H + 12
    : 0;

  const { title, composer, key, time: docTime, tempo, style, capo } = hybrid;
  const keySigCount = hrKeySigFromKey(key);
  let firstTabDone = false;
  let curY = 12 + diagAreaH;
  if (title) curY += 30;
  if (composer || key || docTime || tempo || style) curY += 20;
  if (title || composer) curY += 4;

  for (const sys of systems) {
    sys.y = curY;
    let h = HR_CHORD_H + HR_STAFF_H + HR_SYS_BOT;
    if (sys.firstRow)  h += HR_SLBL_H;
    if (sys.secCue)    h += HR_CUE_H;
    if (sys.hasPM)     h += HR_PM_H;
    if (sys.hasTab)    h += HR_TAB_SEP + HR_TAB_H;
    if (sys.hasCue)    h += HR_CUE_H;
    if (sys.hasTuplet) h += HR_TUPLET_H;
    if (sys.hasEnding) h += HR_END_H;
    sys.h = h;
    curY += h;
  }

  const svgH = curY + 10;
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${HR_PAGE_W}" height="${svgH}" viewBox="0 0 ${HR_PAGE_W} ${svgH}"` +
    ` class="hybridSvgOut" style="max-width:100%;display:block;">`;
  svg += _hrMusicFontStyle();
  svg += `<rect width="${HR_PAGE_W}" height="${svgH}" fill="${bg}"/>`;

  if (hasDiagrams) {
    const diagNames = [...allVoicings.keys()];
    let dx = HR_MARGIN, dy = 10;
    diagNames.forEach((nm, ni) => {
      if (ni > 0 && ni % diagMaxPerRow === 0) { dx = HR_MARGIN; dy += HR_DIAG_OUTER_H; }
      svg += hrChordDiagram(nm, allVoicings.get(nm), dx, dy, fg);
      dx += HR_DIAG_OUTER_W;
    });
  }

  let hy = 12 + diagAreaH;
  if (title) {
    svg += `<text x="${HR_PAGE_W/2}" y="${hy+22}" font-size="18" font-weight="bold" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>${escapeHtml(title)}</text>`;
    hy += 30;
  }
  const metaParts = [composer, key && `Key of ${key}`, docTime, tempo && `♪=${tempo}`, style]
    .filter(Boolean).map(escapeHtml);
  if (metaParts.length)
    svg += `<text x="${HR_PAGE_W/2}" y="${hy+14}" font-size="11" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>${metaParts.join('  ·  ')}</text>`;

  for (const sys of systems) {
    let y = sys.y;
    const barW = staffW / sys.rowBars.length;

    if (sys.firstRow) {
      svg += `<text x="${HR_MARGIN}" y="${y+14}" font-size="12" font-weight="bold" font-style="italic" fill="${fg}" font-family='${_hrFont()}'>${escapeHtml(sys.sec.label || '')}</text>`;
      y += HR_SLBL_H;
    }
    if (sys.secCue) {
      svg += `<text x="${HR_MARGIN}" y="${y+11}" font-size="10" font-style="italic" fill="${fg}" font-family='${_hrFont()}'>${escapeHtml(sys.secCue)}</text>`;
      y += HR_CUE_H;
    }

    const staffY = y + HR_CHORD_H + (sys.hasPM ? HR_PM_H : 0) + (sys.hasTuplet ? HR_TUPLET_H : 0) + (sys.hasEnding ? HR_END_H : 0);
    const tabY   = staffY + HR_STAFF_H + HR_TAB_SEP;
    const blBot  = sys.hasTab ? tabY + HR_TAB_H : staffY + HR_STAFF_H;

    if (sys.firstRow) {
      svg += hrClef(HR_MARGIN, staffY, fg);
      svg += hrKeySig(staffY, keySigCount, fg);
    }

    // 1st/2nd ending brackets above the chord area, over each run of bars
    // sharing the same volta endingLabel.
    if (sys.hasEnding) {
      const eb = staffY - HR_CHORD_H - HR_END_H + 4;
      let bi = 0;
      while (bi < sys.rowBars.length) {
        const lbl = sys.rowBars[bi].endingLabel;
        const num = hrEndingNumber(lbl);
        if (!num) { bi++; continue; }
        let bj = bi + 1;
        while (bj < sys.rowBars.length && sys.rowBars[bj].endingLabel === lbl) bj++;
        const x1 = staffX + bi * barW;
        const x2 = staffX + bj * barW;
        svg += hrL(x1, eb, x1, eb + 12, fg, 1.2);                       // left drop
        svg += hrL(x1, eb, x2 + (num === '1' ? 4 : 0), eb, fg, 1.2);    // top line
        if (num !== '1') svg += hrL(x2, eb, x2, eb + 12, fg, 1.2);      // right drop (closed for 2nd)
        svg += `<text x="${x1 + 5}" y="${eb + 11}" font-size="11" font-weight="bold" fill="${fg}" font-family='${_hrFont()}'>${num}.</text>`;
        bi = bj;
      }
    }

    svg += hrStaff(staffX, staffY, staffW, fg);
    svg += hrL(staffX, staffY, staffX, blBot, fg, 2);

    if (sys.hasTab) {
      svg += hrTabStaff(staffX, tabY, staffW, fg);
      svg += hrTabLabel(HR_MARGIN, tabY, fg);
      if (!firstTabDone && capo > 0) { svg += hrCapoMarker(capo, tabY, fg); firstTabDone = true; }
    }

    sys.rowBars.forEach((bar, bi) => {
      const barLeft    = staffX + bi * barW;
      const isVeryLast = bi === sys.rowBars.length - 1 && sys === systems[systems.length - 1];

      svg += hrBar(bar, barLeft, staffY, barW, fg, cc, bg);

      // Strum arrows below the staff (skipped on tab rows, where the lane is occupied)
      if (strumMode !== 'none' && !sys.hasTab) {
        const vb = hrVisualBeats(bar.timeSig || docTime);
        const ul = barLeft + HR_BAR_PAD, uw = barW - HR_BAR_PAD * 2;
        const arrowY = staffY + HR_STAFF_H + 11;
        for (let b = 0; b < vb; b++) {
          const ch = hrStrumChar(b, strumMode, strumPattern);
          if (!ch) continue;
          const ax = ul + (b / vb) * uw;
          svg += `<text x="${ax}" y="${arrowY}" font-size="9" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>${ch}</text>`;
        }
      }

      const blX = barLeft + barW;
      if (isVeryLast) {
        svg += hrL(blX - 4, staffY, blX - 4, blBot, fg, 1);
        svg += hrL(blX, staffY, blX, blBot, fg, 3.5);
      } else {
        svg += hrL(blX, staffY, blX, blBot, fg, 1);
      }

      if (bar.cueText)
        svg += `<text x="${barLeft + barW / 2}" y="${blBot + HR_CUE_H - 2}" font-size="9" font-style="italic" fill="${fg}" text-anchor="middle" font-family='${_hrFont()}'>${escapeHtml(bar.cueText)}</text>`;
    });

    // Navigation text (D.C. al Fine, Coda, …) at the bottom-right of the section's last row
    if (sys.lastRow) {
      const navText = hrExtractNavText(sys.sec.label) || sys.sec.navText;
      if (navText)
        svg += `<text x="${staffX + staffW}" y="${blBot + 16}" font-size="12" font-style="italic" font-weight="bold" fill="${fg}" text-anchor="end" font-family='${_hrMusicFont()}'>${hrFormatNavText(navText)}</text>`;
    }
  }

  svg += `</svg>`;
  if (validationWarnings.length) setStatus(validationWarnings.join('\n'), 'warning');
  return `<div class="hybridSvgWrap"><div class="hybridModeChip">Slash-Rhythm View</div>${svg}</div>`;
}

// ── MusicXML export (unified engine) ─────────────────────────────────────────
// Self-contained so it survives retirement of the slash-notation panel. Driven
// by the same unified model as renderHybridDoc (parseHybridChartFromCSMPN), it
// emits a Real-Book-style slash chart: chord symbols + one slash notehead per
// visual beat, with repeat barlines, volta endings, and section rehearsal marks.

// MusicXML primitives — delegated to the shared core (musicXmlCore.js).
function hrChordKind(quality) { return mxChordKind(quality); }
function hrKeyMode(keyStr) { return mxKeyMode(keyStr); }
function hrHarmonyOne(text, offsetDivs) { return mxHarmony(text, offsetDivs); }
function hrMusicXmlDoc(title, composer, measureXml) { return mxScoreDoc(title, composer, measureXml); }

// One <harmony> per chord in a bar token (split on '_'); offset spaces multiple
// chords evenly across the measure.
function hrHarmonyXml(chordToken, beats, divisions) {
  const parts = String(chordToken || '').replace(/[!~]$/, '').trim().split('_').map((s) => s.trim()).filter(Boolean);
  let xml = '';
  parts.forEach((text, ci) => {
    const offset = Math.round((ci / Math.max(parts.length, 1)) * beats * divisions);
    xml += mxHarmony(text, offset);
  });
  return xml;
}

// Repeat barlines + volta endings for a bar, derived from leftBar/rightBar/endingLabel.
// Returns { left, right }; mutates the caller's volta tracker via the returned nextPrev.
function hrBarlineXml(bar, prevEnding, nextEl) {
  const curEl = bar.endingLabel || null;
  const lBar = bar.leftBar || 'single';
  const rBar = bar.rightBar || 'single';
  const endStart = (curEl && curEl !== prevEnding) ? hrEndingNumber(curEl) : null;
  const endStop = (curEl && nextEl !== curEl) ? hrEndingNumber(curEl) : null;
  let left = '';
  if (lBar === 'repeat-start')
    left += '\n      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>';
  if (endStart)
    left += `\n      <barline location="left"><ending number="${endStart}" type="start"/></barline>`;
  let right = '';
  if (endStop || rBar === 'repeat-end') {
    const bStyle = rBar === 'repeat-end' ? '<bar-style>light-heavy</bar-style>' : '';
    const endXml = endStop ? `<ending number="${endStop}" type="stop"/>` : '';
    const repXml = rBar === 'repeat-end' ? '<repeat direction="backward"/>' : '';
    right = `\n      <barline location="right">${bStyle}${endXml}${repXml}</barline>`;
  }
  return { left, right, nextPrev: curEl };
}

function hrBuildMusicXml(sourceText) {
  const hybrid = (typeof parseHybridChartFromCSMPN === 'function')
    ? parseHybridChartFromCSMPN(sourceText || '') : null;
  if (!hybrid || !Array.isArray(hybrid.sections) || hybrid.sections.length === 0) return null;
  // Duration-aware path when the chart has notated rhythm; otherwise the generic
  // one-slash-per-beat lead-sheet export.
  return hybrid.active ? hrBuildHybridMusicXml(hybrid) : hrBuildSlashMusicXml(hybrid);
}

// Generic slash chart: one quarter slash notehead per visual beat (divisions=1).
function hrBuildSlashMusicXml(hybrid) {
  const timeSig = hybrid.time || '4/4';
  const bpm = hrVisualBeats(timeSig);
  const timeParts = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/) || ['4/4', '4', '4'];
  const beats = timeParts[1];
  const beatType = timeParts[2];
  const divisions = 1;
  const keySig = hrKeySigFromKey(hybrid.key);
  const keyMode = hrKeyMode(hybrid.key);

  let measureXml = '';
  let num = 0;
  let prevEnding = null;

  for (const sec of hybrid.sections) {
    const label = sec.label || '';
    const isNav = HR_NAV_RE.test(label);
    for (let bi = 0; bi < sec.bars.length; bi++) {
      const bar = sec.bars[bi];
      num++;

      let attrs = '';
      if (num === 1) {
        attrs = `\n      <attributes><divisions>${divisions}</divisions>` +
          `<key><fifths>${keySig}</fifths><mode>${keyMode}</mode></key>` +
          `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>` +
          `<clef><sign>G</sign><line>2</line></clef>` +
          `<measure-style><slash type="start" use-stems="no"/></measure-style></attributes>`;
        if (hybrid.tempo) {
          attrs += `\n      <direction placement="above"><direction-type><metronome parentheses="no">` +
            `<beat-unit>quarter</beat-unit><per-minute>${escapeHtml(String(hybrid.tempo))}</per-minute>` +
            `</metronome></direction-type><sound tempo="${escapeHtml(String(hybrid.tempo))}"/></direction>`;
        }
      }

      let rehearsalXml = '';
      if (bi === 0 && label && !isNav) {
        const enclosure = (sec.markerType === ':' || sec.markerType === '=') ? 'square' : 'none';
        rehearsalXml = `\n      <direction placement="above"><direction-type>` +
          `<rehearsal enclosure="${enclosure}" default-y="40">${escapeHtml(label)}</rehearsal>` +
          `</direction-type></direction>`;
      }

      const harmonyXml = hrHarmonyXml(bar.chordToken, parseInt(beats, 10), divisions);

      let notesXml = '';
      for (let b = 0; b < bpm; b++)
        notesXml += `\n      <note><pitch><step>B</step><octave>4</octave></pitch><duration>${divisions}</duration><type>quarter</type><notehead>slash</notehead></note>`;

      const nextEl = bi + 1 < sec.bars.length ? (sec.bars[bi + 1].endingLabel || null) : null;
      const { left, right, nextPrev } = hrBarlineXml(bar, prevEnding, nextEl);
      prevEnding = nextPrev;

      measureXml += `\n    <measure number="${num}">${left}${attrs}${rehearsalXml}${harmonyXml}${notesXml}${right}\n    </measure>`;
    }
  }

  return hrMusicXmlDoc(hybrid.title, hybrid.composer, measureXml);
}

// Normal-notes count for an N-tuplet (largest power of 2 ≤ N): 3→2, 5→4, 6→4, 9→8.
function hrTupletNormal(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

// Duration-aware export: encodes hybrid event durations (w/h/q/e/s + rests),
// accents, muted noteheads, and tuplets at divisions=12 (1 quarter = 12 divs),
// which keeps triplet/sextuplet durations integer-exact. Fixes the slash panel's
// buildHybridMusicXml, which read a non-existent ev.durCode field and so emitted
// every event as a plain quarter slash with no tuplet/time-modification.
function hrBuildHybridMusicXml(hybrid) {
  const divisions = 12; // 1 quarter = 12 divisions (triplet-friendly)
  const Q = divisions;  // divisions per quarter note
  const timeSig = hybrid.time || '4/4';
  const tp = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/) || ['', '4', '4'];
  const tsBeats = parseInt(tp[1] || '4', 10);
  const tsBeatType = parseInt(tp[2] || '4', 10);
  const totalDivs = Math.round((tsBeats * 4 * Q) / tsBeatType);
  const keySig = hrKeySigFromKey(hybrid.key);
  const keyMode = hrKeyMode(hybrid.key);

  const DUR_DIVS = { w: 4 * Q, h: 2 * Q, q: Q, e: Q / 2, s: Q / 4 };
  const DUR_TYPE = { w: 'whole', h: 'half', q: 'quarter', e: 'eighth', s: '16th' };
  const beatDiv = (beat) => Math.round(((beat - 1) * 4 * Q) / tsBeatType);
  const restFill = (rem) => {
    const vals = [4 * Q, 2 * Q, Q, Q / 2, Q / 4];
    const types = ['whole', 'half', 'quarter', 'eighth', '16th'];
    let xml = '';
    while (rem > 0) {
      let i = 0;
      while (i < vals.length - 1 && vals[i] > rem) i++;
      xml += `\n      <note><rest/><duration>${vals[i]}</duration><type>${types[i]}</type></note>`;
      rem -= vals[i];
    }
    return xml;
  };
  const beatNoteType = tsBeatType === 8 ? 'eighth' : tsBeatType === 2 ? 'half' : tsBeatType === 1 ? 'whole' : 'quarter';
  const beatNoteDiv = Math.round((4 * Q) / tsBeatType);

  let measureXml = '';
  let num = 0;
  let prevEnding = null;

  for (const sec of hybrid.sections) {
    const label = sec.label || '';
    const isNav = HR_NAV_RE.test(label);
    for (let bi = 0; bi < sec.bars.length; bi++) {
      const bar = sec.bars[bi];
      num++;

      let attrs = '';
      if (num === 1) {
        attrs = `\n      <attributes><divisions>${divisions}</divisions>` +
          `<key><fifths>${keySig}</fifths><mode>${keyMode}</mode></key>` +
          `<time><beats>${tsBeats}</beats><beat-type>${tsBeatType}</beat-type></time>` +
          `<clef><sign>G</sign><line>2</line></clef>` +
          `<measure-style><slash type="start" use-stems="yes"/></measure-style></attributes>`;
        if (hybrid.tempo) {
          attrs += `\n      <direction placement="above"><direction-type><metronome parentheses="no">` +
            `<beat-unit>quarter</beat-unit><per-minute>${escapeHtml(String(hybrid.tempo))}</per-minute>` +
            `</metronome></direction-type><sound tempo="${escapeHtml(String(hybrid.tempo))}"/></direction>`;
        }
      }

      let directionsXml = '';
      if (bi === 0 && label && !isNav) {
        const enclosure = (sec.markerType === ':' || sec.markerType === '=') ? 'square' : 'none';
        directionsXml += `\n      <direction placement="above"><direction-type>` +
          `<rehearsal enclosure="${enclosure}" default-y="40">${escapeHtml(label)}</rehearsal>` +
          `</direction-type></direction>`;
      }
      if (bi === 0 && sec.cueText)
        directionsXml += `\n      <direction placement="above"><direction-type><words font-style="italic">${escapeHtml(sec.cueText)}</words></direction-type></direction>`;
      if (bar.cueText)
        directionsXml += `\n      <direction placement="below"><direction-type><words font-style="italic" font-size="9">${escapeHtml(bar.cueText)}</words></direction-type></direction>`;

      let harmonyXml = '';
      let notesXml = '';
      const evs = [...(bar.events || [])].sort((a, b) => a.beat - b.beat);

      if (evs.length > 0) {
        let lastChord = null;
        for (const ev of evs) {
          const chord = ev.chord ? ev.chord.replace(/[!^~x]+$/, '').trim() : null;
          if (chord && chord !== lastChord) {
            harmonyXml += hrHarmonyOne(chord, beatDiv(ev.beat));
            lastChord = chord;
          }
        }
        if (!harmonyXml && bar.chordToken)
          harmonyXml = hrHarmonyXml(bar.chordToken, tsBeats, divisions);

        let pos = 0;
        let tIdx = 0;        // running position within the current tuplet group
        let prevTuplet = 0;
        for (let ei = 0; ei < evs.length; ei++) {
          const ev = evs[ei];
          const type = DUR_TYPE[ev.duration] || 'quarter';
          const baseDivs = DUR_DIVS[ev.duration] || Q;

          // Tuplet: integer-exact at divisions=12; emit <time-modification> + brackets.
          const N = ev.tuplet > 1 ? ev.tuplet : 0;
          if (N && prevTuplet !== N) tIdx = 0;
          const groupPos = N ? tIdx % N : 0;

          // Align to the event's beat slot — except for mid-tuplet notes, whose
          // beat slots (1, 1&, 2 …) don't represent true tuplet timing; those are
          // placed contiguously after the group's first note.
          if (!(N && groupPos !== 0)) {
            const evDiv = beatDiv(ev.beat);
            if (evDiv > pos) { notesXml += restFill(evDiv - pos); pos = evDiv; }
          }

          let divs = baseDivs;
          let timeMod = '';
          let tupletNot = '';
          if (N) {
            const normal = hrTupletNormal(N);
            divs = Math.round((baseDivs * normal) / N);
            timeMod = `<time-modification><actual-notes>${N}</actual-notes><normal-notes>${normal}</normal-notes></time-modification>`;
            const nextEv = evs[ei + 1];
            const nextSame = !!(nextEv && nextEv.tuplet === N);
            if (groupPos === 0) tupletNot += '<tuplet type="start"/>';
            if (groupPos === N - 1 || !nextSame) tupletNot += '<tuplet type="stop"/>';
          }

          if (ev.type === 'rest') {
            const notations = tupletNot ? `<notations>${tupletNot}</notations>` : '';
            notesXml += `\n      <note><rest/><duration>${divs}</duration><type>${type}</type>${timeMod}${notations}</note>`;
          } else {
            const head = ev.muted ? 'x' : 'slash';
            const accent = ev.accent ? '<articulations><accent/></articulations>' : '';
            const notations = (accent || tupletNot) ? `<notations>${accent}${tupletNot}</notations>` : '';
            notesXml += `\n      <note><pitch><step>B</step><octave>4</octave></pitch><duration>${divs}</duration><type>${type}</type>${timeMod}<notehead>${head}</notehead>${notations}</note>`;
          }
          pos += divs; // alignment already advanced pos to the event's beat slot
          if (N) { tIdx++; prevTuplet = N; } else { prevTuplet = 0; }
        }
        if (pos < totalDivs) notesXml += restFill(totalDivs - pos);
      } else {
        if (bar.chordToken) harmonyXml = hrHarmonyXml(bar.chordToken, tsBeats, divisions);
        for (let b = 0; b < tsBeats; b++)
          notesXml += `\n      <note><pitch><step>B</step><octave>4</octave></pitch><duration>${beatNoteDiv}</duration><type>${beatNoteType}</type><notehead>slash</notehead></note>`;
      }

      const nextEl = bi + 1 < sec.bars.length ? (sec.bars[bi + 1].endingLabel || null) : null;
      const { left, right, nextPrev } = hrBarlineXml(bar, prevEnding, nextEl);
      prevEnding = nextPrev;

      measureXml += `\n    <measure number="${num}">${left}${attrs}${directionsXml}${harmonyXml}${notesXml}${right}\n    </measure>`;
    }
  }

  return hrMusicXmlDoc(hybrid.title, hybrid.composer, measureXml);
}

function updatePreview(){
  // Determine the text to render. When the user has disabled lyrics via settings,
  // filter out comment lines starting with ';'. Otherwise use the raw source.
  const original = sourceEl.value || '';
  const text = (fbSettings.includeLyrics === false) ? filterLyricsLines(original) : original;
  const keyMatch = text.match(/^Key:\s*(.+)$/im);
  const key = keyMatch ? keyMatch[1].trim() : '';
  notationPreference = detectNotationPreferenceFromKeyOrText(key, text);

  _vtBlockId = 0; // reset notation block counter before render
  // Unified engine: when rhythm mode is on, render every chart through the SVG
  // slash/rhythm engine. Charts with {hybrid} blocks show notated rhythm; plain
  // charts show even slash noteheads (the zero-rhythm case). renderHybridDoc()
  // falls back to the fake-book renderer only when there is no chart content.
  if (fbSettings.hybridRhythmMode){
    previewEl.innerHTML = renderHybridDoc(text);
  } else {
    const doc = parseCSMPN(text);
    previewEl.innerHTML = renderDoc(doc);
  }

  // Render any {vt ...} notation blocks via VexFlow
  renderAllNotationBlocks();

  // Apply custom colors to the rendered sheet
  const sheetEl = document.querySelector('.sheet');
  if (sheetEl){
    sheetEl.style.background = fbSettings.bgColor || '#ffffff';
    sheetEl.style.color = fbSettings.fgColor || '#111111';
  }
}

// Render any CSMPN text to a standalone SVG string (used by the Setlist printer).
// Built on the unified engine; returns just the <svg> without the screen-only
// mode chip / wrapper. Replaces the slash-notation panel's renderCsmpnToSvg.
if (typeof window !== 'undefined') {
  window.renderCsmpnToSvg = function (csmpnText) {
    const html = renderHybridDoc(csmpnText || '');
    const m = html.match(/<svg[\s\S]*<\/svg>/);
    return m ? m[0] : html;
  };
}

/* =========================================================
   VexFlow Notation Block Renderer
   Enhanced phase-1 parser / renderer for {vt ...} blocks.

   Supported syntax (backward-compatible with the older EasyScore-style input):
     {vt C4/q, D4/q, E4/q, F4/q}
     {vt [3/4] bass: C3/h, qr}
     {vt [4/4] <C4 E4 G4>/q <D4 F4 A4>/q qr C5/q}
     {vt C4/q^ C4/q | D4/8[staccato,lyric="Hi"] E4/8[text="rit."]}
     {vt tempo="Allegro" C4/q[chord="Cmaj7", dyn="mf"]}
========================================================= */
function getVtUtils(){
  return window.VTNotationUtils || null;
}

function getMeasureCapacityFromTimeSig(timeSig){
  const m = String(timeSig || '4/4').match(/^(\d+)\/(\d+)$/);
  if (!m) return 4;
  return Number(m[1]) * (4 / Number(m[2]));
}

function makeStaveNoteFromEvent(VF, clef, event){
  const isRest = event.type === 'rest';
  const keys = isRest
    ? ['b/4']
    : event.pitches.map((pitch) => pitch.vexKey);

  const note = new VF.StaveNote({
    clef,
    keys,
    duration: `${event.duration}${isRest ? 'r' : ''}`,
    auto_stem: true,
  });

  if (!isRest){
    event.pitches.forEach((pitch, index) => {
      if (pitch.accidental) note.addModifier(new VF.Accidental(pitch.accidental), index);
    });
  }

  for (let i = 0; i < (event.dots || 0); i += 1) {
    if (typeof note.addDotToAll === 'function') note.addDotToAll();
    else if (typeof VF.Dot?.buildAndAttach === 'function') VF.Dot.buildAndAttach([note], { all: true });
  }

  const modifierPosition = VF.Modifier?.Position || { ABOVE: 3, BELOW: 4 };
  const addAnnotation = (text, vertical) => {
    if (!text) return;
    note.addModifier(
      new VF.Annotation(String(text))
        .setVerticalJustification(vertical)
        .setFont('Arial', 11, ''),
      0,
    );
  };

  const chordText = event.modifiers?.chord;
  const dynText = event.modifiers?.dyn;
  const freeText = event.modifiers?.text;
  const lyricText = event.modifiers?.lyric;
  addAnnotation(chordText, modifierPosition.ABOVE);
  addAnnotation(dynText, modifierPosition.ABOVE);
  addAnnotation(freeText, modifierPosition.ABOVE);
  addAnnotation(lyricText, modifierPosition.BELOW);

  for (const articulation of event.modifiers?.articulations || []) {
    const code = articulation && ({ staccato: 'a.', accent: 'a>', tenuto: 'a-', marcato: 'a^', fermata: 'a@a' }[articulation]);
    if (!code) continue;
    note.addModifier(new VF.Articulation(code).setPosition(modifierPosition.ABOVE), 0);
  }

  if (event.modifiers?.grace?.length) {
    const graceNotes = event.modifiers.grace.map((graceEvent) => new VF.GraceNote({
      keys: graceEvent.pitches.map((pitch) => pitch.vexKey),
      duration: graceEvent.duration,
      slash: false,
    }));
    note.addModifier(new VF.GraceNoteGroup(graceNotes, false), 0);
  }

  return note;
}

function canTieEvents(firstEvent, secondEvent){
  if (!firstEvent || !secondEvent) return false;
  if (firstEvent.type === 'rest' || secondEvent.type === 'rest') return false;
  if ((firstEvent.pitches?.length || 0) !== (secondEvent.pitches?.length || 0)) return false;
  return firstEvent.pitches.every((pitch, index) => {
    const next = secondEvent.pitches[index];
    return next && pitch.vexKey === next.vexKey;
  });
}

function makeTieSpec(VF, firstNote, secondNote, firstEvent, secondEvent){
  const count = Math.max(firstEvent.pitches?.length || 1, secondEvent.pitches?.length || 1);
  return new VF.StaveTie({
    first_note: firstNote,
    last_note: secondNote,
    first_indices: Array.from({ length: count }, (_, i) => i),
    last_indices: Array.from({ length: count }, (_, i) => i),
  });
}

function drawEnhancedVexFlowBlock(el, parsed){
  const VF = Vex.Flow;
  const containerWidth = Math.min(el.offsetWidth || 600, 960);
  const barsPerRow = Math.max(1, Math.min(4, parsed.measures.length || 1));
  const rowCount = Math.max(1, Math.ceil((parsed.measures.length || 1) / barsPerRow));
  const rowHeight = 160;
  const height = 40 + rowCount * rowHeight;
  const factory = new VF.Factory({
    renderer: { elementId: el.id, type: 'svg', width: containerWidth, height }
  });
  const context = factory.getContext();
  const leftPad = 12;
  const topPad = 18;
  const staffWidth = Math.max(120, Math.floor((containerWidth - leftPad * 2) / barsPerRow) - 8);
  const [numBeats, beatValue] = String(parsed.timeSig || '4/4').split('/').map(Number);
  const allNotes = [];
  const ties = [];

  if (parsed.text) {
    context.save();
    context.setFont('Arial', 12, 'italic');
    context.fillText(parsed.text, leftPad, 14);
    context.restore();
  }

  parsed.measures.forEach((measure, measureIndex) => {
    const rowIndex = Math.floor(measureIndex / barsPerRow);
    const colIndex = measureIndex % barsPerRow;
    const x = leftPad + colIndex * staffWidth;
    const y = topPad + rowIndex * rowHeight;
    const stave = new VF.Stave(x, y, staffWidth);
    if (measureIndex === 0) {
      stave.addClef(parsed.clef || 'treble');
      stave.addTimeSignature(parsed.timeSig || '4/4');
      if (parsed.tempo) stave.setText(parsed.tempo, VF.Modifier.Position.ABOVE, { shift_y: -10 });
    }
    if (measureIndex === parsed.measures.length - 1) stave.setEndBarType(VF.Barline.type.END);
    stave.setContext(context).draw();

    const notes = measure.events.map((event) => makeStaveNoteFromEvent(VF, parsed.clef, event));
    const voice = new VF.Voice({ num_beats: numBeats || 4, beat_value: beatValue || 4 }).setStrict(false);
    voice.addTickables(notes);
    new VF.Formatter().joinVoices([voice]).format([voice], staffWidth - 30);
    voice.draw(context, stave);

    const beams = VF.Beam.generateBeams(notes, { groups: [new VF.Fraction(numBeats || 4, beatValue || 4)] });
    beams.forEach((beam) => beam.setContext(context).draw());

    allNotes.push({ notes, events: measure.events });
  });

  allNotes.forEach((measure, measureIndex) => {
    measure.events.forEach((event, eventIndex) => {
      if (!event.tie && !event.tieFromPrevious) return;
      const firstIndex = event.tieFromPrevious ? eventIndex - 1 : eventIndex;
      const secondIndex = event.tieFromPrevious ? eventIndex : eventIndex + 1;
      let fromMeasureIndex = measureIndex;
      let toMeasureIndex = measureIndex;
      let firstEvent = measure.events[firstIndex];
      let secondEvent = measure.events[secondIndex];
      let firstNote = measure.notes[firstIndex];
      let secondNote = measure.notes[secondIndex];

      if (!secondEvent && !event.tieFromPrevious) {
        const nextMeasure = allNotes[measureIndex + 1];
        if (!nextMeasure) return;
        secondEvent = nextMeasure.events[0];
        secondNote = nextMeasure.notes[0];
        toMeasureIndex = measureIndex + 1;
      }
      if (!firstEvent && event.tieFromPrevious) {
        const prevMeasure = allNotes[measureIndex - 1];
        if (!prevMeasure) return;
        firstEvent = prevMeasure.events[prevMeasure.events.length - 1];
        firstNote = prevMeasure.notes[prevMeasure.notes.length - 1];
        fromMeasureIndex = measureIndex - 1;
      }
      if (!firstEvent || !secondEvent || !firstNote || !secondNote) return;
      if (!canTieEvents(firstEvent, secondEvent)) return;
      const key = `${fromMeasureIndex}:${measure.events.indexOf(firstEvent)}>${toMeasureIndex}:${(allNotes[toMeasureIndex]?.events || []).indexOf(secondEvent)}`;
      if (ties.includes(key)) return;
      ties.push(key);
      makeTieSpec(VF, firstNote, secondNote, firstEvent, secondEvent).setContext(context).draw();
    });
  });

  if (parsed.warnings?.length) {
    const warn = document.createElement('div');
    warn.className = 'notation-error';
    warn.style.marginTop = '6px';
    warn.textContent = parsed.warnings.join(' ');
    el.appendChild(warn);
  }
}

function renderLegacyVexFlowBlock(el, content){
  const VF = Vex.Flow;
  let noteStr = (content || '').trim();
  let timeSig = '4/4';
  const timeSigMatch = noteStr.match(/^\[(\d+\/\d+)\]\s*/);
  if (timeSigMatch){
    timeSig = timeSigMatch[1];
    noteStr = noteStr.slice(timeSigMatch[0].length).trim();
  }

  let clef = 'treble';
  const clefMatch = noteStr.match(/^(treble|bass|alto|tenor)\s*:\s*/i);
  if (clefMatch){
    clef = clefMatch[1].toLowerCase();
    noteStr = noteStr.slice(clefMatch[0].length).trim();
  }

  noteStr = noteStr.replace(/\s*\|\s*/g, ', ').trim();
  if (!noteStr) throw new Error('No notes in notation block.');

  const containerWidth = Math.min(el.offsetWidth || 600, 900);
  const staveWidth = containerWidth - 40;
  const height = 160;
  const factory = new VF.Factory({
    renderer: { elementId: el.id, type: 'svg', width: containerWidth, height }
  });
  const score = factory.EasyScore();
  const system = factory.System({ x: 10, y: 10, width: staveWidth });
  system.addStave({ voices: [score.voice(score.notes(noteStr))] }).addClef(clef).addTimeSignature(timeSig);
  factory.draw();
}

function renderVexFlowBlock(el){
  const content = el.dataset.vt || '';
  if (!content){
    el.innerHTML = '<div class="notation-error">Empty notation block.</div>';
    return;
  }
  if (typeof Vex === 'undefined' || !Vex.Flow){
    el.innerHTML = '<div class="notation-error">VexFlow not loaded — check CDN connection.</div>';
    return;
  }

  try {
    const utils = getVtUtils();
    if (!utils?.parseVexFlowBlock) throw new Error('Enhanced notation parser not loaded.');
    const parsed = utils.parseVexFlowBlock(content);
    el.innerHTML = '';
    drawEnhancedVexFlowBlock(el, parsed);
  } catch (enhancedError) {
    console.warn('Enhanced VexFlow render error, falling back to legacy renderer:', enhancedError);
    try {
      el.innerHTML = '';
      renderLegacyVexFlowBlock(el, content);
    } catch(e){
      el.innerHTML = `<div class="notation-error">Notation error: ${escapeHtml(String(enhancedError.message || enhancedError))}</div>`;
      console.warn('VexFlow render error:', e);
    }
  }
}

function renderAllNotationBlocks(){
  const blocks = previewEl.querySelectorAll('.notation-block[data-vt]');
  blocks.forEach(el => renderVexFlowBlock(el));
}

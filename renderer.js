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
const HR_CLEF_W  = 30;
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
const HR_SYS_BOT = 22;
const HR_SLBL_H  = 20;
const HR_CUE_H   = 14;

function hrL(x1, y1, x2, y2, col, w) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w}"/>`;
}

function hrHead(cx, cy, dur, col) {
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

function hrRest(cx, cy, dur, col) {
  switch (dur) {
    case 'w':
      return `<rect x="${cx-7}" y="${cy-2}" width="14" height="5" fill="${col}"/>` +
             hrL(cx - 9, cy - 2, cx + 9, cy - 2, col, 0.8);
    case 'h':
      return `<rect x="${cx-7}" y="${cy-7}" width="14" height="5" fill="${col}"/>` +
             hrL(cx - 9, cy - 2, cx + 9, cy - 2, col, 0.8);
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
  for (let i = 0; i < 5; i++) s += hrL(x, y + i * HR_LG, x + w, y + i * HR_LG, col, 0.8);
  return s;
}

function hrClef(x, y, col) {
  const cy = y + HR_STAFF_H / 2;
  return hrL(x + 8, cy - 11, x + 12, cy + 11, col, 2.5) +
         hrL(x + 16, cy - 11, x + 20, cy + 11, col, 2.5);
}

function hrTabStaff(x, y, w, col) {
  let s = '';
  for (let i = 0; i < 6; i++) s += hrL(x, y + i * HR_TAB_LG, x + w, y + i * HR_TAB_LG, col, 0.7);
  return s;
}

function hrTabLabel(marginX, tabY, col) {
  const cx = marginX + HR_CLEF_W / 2;
  const mid = HR_TAB_H / 2;
  return ['T', 'A', 'B']
    .map((ch, i) =>
      `<text x="${cx}" y="${tabY + mid - 12 + i * 12}" font-size="9" font-weight="bold" fill="${col}" text-anchor="middle" font-family="Georgia,serif">${ch}</text>`,
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

function hrBeatX(beat, timeSig, barLeft, barUsableW) {
  const nb = Number(String(timeSig || '4/4').split('/')[0]) || 4;
  return barLeft + ((beat - 1) / nb) * barUsableW;
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
    if (bar.chordToken) {
      s += `<text x="${barLeft + barW / 2}" y="${staffY - 10}" font-size="13" fill="${cc}" text-anchor="middle" font-weight="bold" font-family="Georgia,serif">${escapeHtml(String(bar.chordToken).replace(/[!~]$/, '').trim())}</text>`;
    }
    const nb = Number(String(timeSig).split('/')[0]) || 4;
    for (let b = 1; b <= nb; b++) {
      const ex = hrBeatX(b, timeSig, ul, uw);
      s += hrHead(ex, cy, 'q', fg);
      s += hrStem(ex, staffY, fg);
    }
    return s;
  }

  const hasPM = bar?.pm?.bar || bar?.pm?.spans?.length > 0;
  if (hasPM) {
    const pmY = staffY - 2;
    s += `<text x="${ul}" y="${pmY - 3}" font-size="8" fill="${fg}" font-family="sans-serif" font-style="italic">P.M.</text>`;
    s += `<line x1="${ul + 22}" y1="${pmY - 3}" x2="${barLeft + barW - HR_BAR_PAD}" y2="${pmY - 3}" stroke="${fg}" stroke-width="0.8" stroke-dasharray="3,2"/>`;
  }

  const beamOf = new Array(events.length).fill(-1);
  let gi = 0;
  for (let i = 0; i < events.length; ) {
    if (events[i].type !== 'slash' || !['e', 's'].includes(events[i].duration)) { i++; continue; }
    let j = i + 1;
    while (j < events.length && events[j].type === 'slash' && ['e', 's'].includes(events[j].duration)) j++;
    if (j - i >= 2) { for (let k = i; k < j; k++) beamOf[k] = gi; gi++; }
    i = j;
  }
  const xs = events.map((ev) => hrBeatX(ev.beat, timeSig, ul, uw));

  const beamGroups = {};
  beamOf.forEach((g, i) => { if (g >= 0) (beamGroups[g] = beamGroups[g] || []).push(i); });
  for (const idxs of Object.values(beamGroups)) {
    const bx1 = xs[idxs[0]], bx2 = xs[idxs[idxs.length - 1]];
    s += hrBeam(bx1, bx2, stemTopY, fg);
    if (events[idxs[0]].duration === 's') s += hrBeam(bx1, bx2, stemTopY + 6, fg);
  }

  events.forEach((ev, i) => {
    if (!ev.chord) return;
    s += `<text x="${xs[i]}" y="${staffY - 12}" font-size="13" fill="${cc}" text-anchor="middle" font-weight="bold" font-family="Georgia,serif">${escapeHtml(String(ev.chord).replace(/[!~]$/, '').trim())}</text>`;
  });

  events.forEach((ev, i) => {
    const ex = xs[i];
    if (ev.type === 'rest') {
      s += hrRest(ex, cy, ev.duration, fg);
    } else {
      s += hrHead(ex, cy, ev.duration, fg);
      if (ev.duration !== 'w') {
        s += hrStem(ex, staffY, fg);
        if (beamOf[i] < 0) {
          if (ev.duration === 'e') s += hrFlags(ex, stemTopY, 1, fg);
          if (ev.duration === 's') s += hrFlags(ex, stemTopY, 2, fg);
        }
      }
    }
    if (ev.accent)
      s += `<text x="${ex}" y="${staffY - 22}" font-size="10" fill="${fg}" text-anchor="middle" font-weight="bold">&gt;</text>`;
  });

  tabs.forEach((te) => {
    const tx = hrBeatX(te.beat, timeSig, ul, uw);
    String(te.shape || '').split(',').forEach((fret, si) => { s += hrFret(fret.trim(), si + 1, tx, tabY, fg, bg); });
  });

  return s;
}

function renderHybridDoc(sourceText) {
  const fallbackDoc = parseCSMPN(sourceText || '');
  const hybrid =
    typeof parseHybridChartFromCSMPN === 'function'
      ? parseHybridChartFromCSMPN(sourceText || '')
      : null;
  if (!hybrid || !hybrid.active) return renderDoc(fallbackDoc);

  validationWarnings = [];
  rehearsalLetterIndex = 0;
  if (hybrid.warnings?.length) validationWarnings.push(...hybrid.warnings);

  const fg  = fbSettings.fgColor    || '#111111';
  const bg  = fbSettings.bgColor    || '#ffffff';
  const cc  = fbSettings.chordColor || '#0044cc';
  const bpr = Math.max(1, Math.min(8, Number(fbSettings.barsPerRow) || 4));
  const staffX = HR_MARGIN + HR_CLEF_W;
  const staffW = HR_PAGE_W - HR_MARGIN * 2 - HR_CLEF_W;

  const systems = [];
  for (const sec of hybrid.sections) {
    let firstRow = true;
    for (let i = 0; i < sec.bars.length; i += bpr) {
      const rowBars = sec.bars.slice(i, i + bpr);
      systems.push({
        sec, rowBars, firstRow,
        hasTab: rowBars.some((b) => b.tabEvents?.length > 0),
        hasPM:  rowBars.some((b) => b.pm?.bar || b.pm?.spans?.length > 0),
        hasCue: rowBars.some((b) => b.cueText),
        secCue: firstRow ? sec.cueText : '',
      });
      firstRow = false;
    }
  }

  const { title, composer, key, time: docTime, tempo, style } = fallbackDoc;
  let curY = 12;
  if (title) curY += 30;
  if (composer || key || docTime || tempo || style) curY += 20;
  if (title || composer) curY += 4;

  for (const sys of systems) {
    sys.y = curY;
    let h = HR_CHORD_H + HR_STAFF_H + HR_SYS_BOT;
    if (sys.firstRow) h += HR_SLBL_H;
    if (sys.secCue)   h += HR_CUE_H;
    if (sys.hasPM)    h += HR_PM_H;
    if (sys.hasTab)   h += HR_TAB_SEP + HR_TAB_H;
    if (sys.hasCue)   h += HR_CUE_H;
    sys.h = h;
    curY += h;
  }

  const svgH = curY + 10;
  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${HR_PAGE_W}" viewBox="0 0 ${HR_PAGE_W} ${svgH}"` +
    ` class="hybridSvgOut" style="max-width:100%;display:block;">`;
  svg += `<rect width="${HR_PAGE_W}" height="${svgH}" fill="${bg}"/>`;

  let hy = 12;
  if (title) {
    svg += `<text x="${HR_PAGE_W/2}" y="${hy+22}" font-size="18" font-weight="bold" fill="${fg}" text-anchor="middle" font-family="Georgia,serif">${escapeHtml(title)}</text>`;
    hy += 30;
  }
  const metaParts = [composer, key && `Key of ${key}`, docTime, tempo && `♪=${tempo}`, style]
    .filter(Boolean).map(escapeHtml);
  if (metaParts.length)
    svg += `<text x="${HR_PAGE_W/2}" y="${hy+14}" font-size="11" fill="${fg}" text-anchor="middle" font-family="Georgia,serif">${metaParts.join('  ·  ')}</text>`;

  for (const sys of systems) {
    let y = sys.y;
    const barW = staffW / sys.rowBars.length;

    if (sys.firstRow) {
      svg += `<text x="${HR_MARGIN}" y="${y+14}" font-size="12" font-weight="bold" font-style="italic" fill="${fg}" font-family="Georgia,serif">${escapeHtml(sys.sec.label || '')}</text>`;
      y += HR_SLBL_H;
    }
    if (sys.secCue) {
      svg += `<text x="${staffX}" y="${y+11}" font-size="10" font-style="italic" fill="${fg}" font-family="sans-serif">${escapeHtml(sys.secCue)}</text>`;
      y += HR_CUE_H;
    }

    const staffY = y + HR_CHORD_H + (sys.hasPM ? HR_PM_H : 0);
    const tabY   = staffY + HR_STAFF_H + HR_TAB_SEP;
    const blBot  = sys.hasTab ? tabY + HR_TAB_H : staffY + HR_STAFF_H;

    if (sys.firstRow) svg += hrClef(HR_MARGIN + 2, staffY, fg);
    svg += hrStaff(staffX, staffY, staffW, fg);
    svg += hrL(staffX, staffY, staffX, blBot, fg, 2);

    if (sys.hasTab) {
      svg += hrTabStaff(staffX, tabY, staffW, fg);
      svg += hrTabLabel(HR_MARGIN, tabY, fg);
    }

    sys.rowBars.forEach((bar, bi) => {
      const barLeft    = staffX + bi * barW;
      const isVeryLast = bi === sys.rowBars.length - 1 && sys === systems[systems.length - 1];

      svg += hrBar(bar, barLeft, staffY, barW, fg, cc, bg);

      const blX = barLeft + barW;
      if (isVeryLast) {
        svg += hrL(blX - 4, staffY, blX - 4, blBot, fg, 1);
        svg += hrL(blX, staffY, blX, blBot, fg, 3.5);
      } else {
        svg += hrL(blX, staffY, blX, blBot, fg, 1);
      }

      if (bar.cueText)
        svg += `<text x="${barLeft + barW / 2}" y="${blBot + HR_CUE_H - 2}" font-size="9" font-style="italic" fill="${fg}" text-anchor="middle" font-family="sans-serif">${escapeHtml(bar.cueText)}</text>`;
    });
  }

  svg += `</svg>`;
  if (validationWarnings.length) setStatus(validationWarnings.join('\n'), 'warning');
  return `<div class="hybridSvgWrap">${svg}</div>`;
}

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
  if (fbSettings.hybridRhythmMode && /\{hybrid\b/i.test(text)){
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

  // Refresh slash notation panel if it is open
  if (typeof updateSlashNotationIfOpen === 'function') updateSlashNotationIfOpen();
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

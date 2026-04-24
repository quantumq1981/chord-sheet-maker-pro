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

function hybridBeatToPercent(beat, timeSig){
  const top = Number(String(timeSig || '4/4').split('/')[0]) || 4;
  return Math.max(0, Math.min(100, ((beat - 1) / Math.max(1, top - 0.5)) * 100));
}

function renderHybridBar(bar){
  const events = Array.isArray(bar?.events) ? bar.events : [];
  const tabs = Array.isArray(bar?.tabEvents) ? bar.tabEvents : [];
  const chordEvents = events.filter((event) => event.chord);
  const rowsByBucket = {};
  const chordHtml = chordEvents.map((event) => {
    const left = hybridBeatToPercent(event.beat, bar.timeSig);
    const bucket = Math.round(left / 8);
    const row = rowsByBucket[bucket] || 0;
    rowsByBucket[bucket] = row + 1;
    const top = row * 14;
    return `<span class="hybridChord" style="left:${left}%; top:${top}px;">${renderChordToken(event.chord)}</span>`;
  }).join('');
  const chordRowCount = Object.values(rowsByBucket).reduce((max, n) => Math.max(max, n), 1);

  const glyphForDuration = (dur) => ({ w: '𝅝╱', h: '𝅗𝅥╱', q: '╱', e: '╲╱', s: '╲╱╲╱' }[dur] || '╱');
  const restForDuration = (dur) => ({ w: '𝄻', h: '𝄼', q: '𝄽', e: '𝄾', s: '𝄿' }[dur] || '𝄽');

  const eventHtml = events.map((event) => {
    const left = hybridBeatToPercent(event.beat, bar.timeSig);
    if (event.type === 'rest'){
      return `<span class="hybridRest" style="left:${left}%">${escapeHtml(restForDuration(event.duration))}</span>`;
    }
    const accent = event.accent ? `<span class="hybridAccent" style="left:${left}%">&gt;</span>` : '';
    const sustain = event.sustain ? '—' : '';
    return `${accent}<span class="hybridEvent" style="left:${left}%">${escapeHtml(glyphForDuration(event.duration))}${escapeHtml(sustain)}</span>`;
  }).join('');

  const tabHtml = tabs.map((tabEvent) => {
    const left = hybridBeatToPercent(tabEvent.beat, bar.timeSig);
    return `<span class="hybridTabEvent" style="left:${left}%">${escapeHtml(tabEvent.shape)}</span>`;
  }).join('');

  const hasPm = bar?.pm?.bar || (Array.isArray(bar?.pm?.spans) && bar.pm.spans.length > 0);
  const pmHtml = hasPm ? `<div class="hybridPmLine">P.M. - - - -</div>` : '';
  const cueHtml = bar?.cueText ? `<div class="hybridCue hybridBarCue">${escapeHtml(bar.cueText)}</div>` : '';

  return `<div class="hybridBar"><div class="hybridChordLane" style="min-height:${Math.max(18, chordRowCount * 14)}px;">${chordHtml}</div><div class="hybridStaff">${pmHtml}${eventHtml}</div>${tabHtml ? `<div class="hybridTab">${tabHtml}</div>` : ''}${cueHtml}</div>`;
}

function renderHybridDoc(sourceText){
  const fallbackDoc = parseCSMPN(sourceText || '');
  const hybrid = (typeof parseHybridChartFromCSMPN === 'function') ? parseHybridChartFromCSMPN(sourceText || '') : null;
  if (!hybrid || !hybrid.active) return renderDoc(fallbackDoc);
  validationWarnings = [];
  rehearsalLetterIndex = 0;
  let html = '';
  if (hybrid.warnings?.length){
    validationWarnings.push(...hybrid.warnings);
  }
  if (fallbackDoc.title || fallbackDoc.style || fallbackDoc.key || fallbackDoc.time || fallbackDoc.tempo || fallbackDoc.composer){
    const metaBits = [];
    if (fallbackDoc.style) metaBits.push(fallbackDoc.style);
    if (fallbackDoc.key) metaBits.push(`Key of ${fallbackDoc.key}`);
    const metaStr = metaBits.length ? metaBits.join(', ') : '';
    const metaLine = metaStr ? `<div class="headerMeta">(${escapeHtml(metaStr)})</div>` : '';
    const composerLine = fallbackDoc.composer ? `<div class="headerComposer">${escapeHtml(fallbackDoc.composer)}</div>` : '';
    const tempoLine = fallbackDoc.tempo ? `<div class="tempoLine">♩=${escapeHtml(fallbackDoc.tempo)}</div>` : '';
    const timeSig = fallbackDoc.time ? renderTimeSig(fallbackDoc.time) : '';
    html += `<div class="sheetHeader"><div class="headerInfo">${metaLine}${fallbackDoc.title ? `<div class="songTitle">${escapeHtml(fallbackDoc.title)}</div>` : ''}${composerLine}</div><div class="headerRight">${tempoLine}${timeSig}</div></div>`;
  }
  html += `<div class="hybridDoc">`;
  for (const section of hybrid.sections){
    html += renderSectionMarker({ marker: '-', text: section.label || 'Section' });
    if (section.cueText) html += `<div class="hybridCue">${escapeHtml(section.cueText)}</div>`;
    const bpr = Math.max(1, Number(fbSettings.barsPerRow) || 4);
    for (let i = 0; i < section.bars.length; i += bpr){
      const row = section.bars.slice(i, i + bpr);
      html += `<div class="hybridSystem"><div class="hybridBarRow" style="grid-template-columns:repeat(${row.length}, minmax(0,1fr));">`;
      html += row.map((bar) => renderHybridBar(bar)).join('');
      html += `</div></div>`;
    }
  }
  html += `</div>`;
  if (validationWarnings.length){
    setStatus(validationWarnings.join('\n'), 'warning');
  }
  return html;
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

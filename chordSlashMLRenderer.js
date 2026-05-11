/**
 * chordSlashMLRenderer.js
 *
 * Browser-compatible bundle exposing:
 *   window.csml.parse(text)         → CSMLDocument
 *   window.csml.toSvg(text, opts)   → SVG string
 *   window.csml.toLilypond(text)    → LilyPond .ly string
 *   window.csml.warnings            → last parse warnings[]
 *
 * Generated from:
 *   src/parsers/chordSlashMLParser.ts
 *   src/renderers/chordSlashMLSvgRenderer.ts
 *   src/converters/chordSlashMLToLilypond.ts
 */
(function () {
  'use strict';

  // ─── Parser ────────────────────────────────────────────────────────────────

  const QUALITY_SUFFIXES = [
    'maj13','maj11','maj9','maj7','maj6','maj',
    'mM7',
    'm7b5','m13','m11','m9','m7','m6','min','m',
    '7#9','7b9','7#5','7b5','7sus4','7sus2','aug7',
    '13','11','9','7',
    'dim7','dim',
    'aug',
    'sus4','sus2',
    '6add9','9sus4','add13','add11','add9',
    '6','5','M',
  ];

  const NOTE_RE = /^[A-G](##|bb|[#b])?/;
  const META_RE = /^(Title|Composer|Key|Time|Tempo|Style)\s*:\s*(.+)$/i;
  const SECTION_LABEL_RE = /^\[([^\]]+)\]$/;
  const COMMENT_RE = /^[#/]{2}/;
  const MEASURE_LINE_RE = /^[|:]/;

  function tokeniseMeasureContent(raw) {
    const tokens = [];
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === ' ' || raw[i] === '\t') { i++; continue; }
      if (raw[i] === '(') { tokens.push({ kind: 'lparen', text: '(' }); i++; continue; }
      if (raw[i] === ')') { tokens.push({ kind: 'rparen', text: ')' }); i++; continue; }
      if (raw[i] === '.') { tokens.push({ kind: 'rest', text: '.' }); i++; continue; }
      const m = NOTE_RE.exec(raw.slice(i));
      if (m) {
        let end = i + m[0].length;
        const afterRoot = raw.slice(end);
        let qualLen = 0;
        for (const q of QUALITY_SUFFIXES) {
          if (afterRoot.startsWith(q)) { qualLen = q.length; break; }
        }
        end += qualLen;
        if (raw[end] === '/' && end + 1 < raw.length && NOTE_RE.test(raw.slice(end + 1))) {
          end++;
          const bassM = NOTE_RE.exec(raw.slice(end));
          if (bassM) {
            end += bassM[0].length;
            const afterBass = raw.slice(end);
            for (const q of QUALITY_SUFFIXES) {
              if (afterBass.startsWith(q)) { end += q.length; break; }
            }
          }
        }
        const chordText = raw.slice(i, end);
        if (end < raw.length && (raw[end] === '_' || raw[end] === '.')) {
          tokens.push({ kind: 'chord', text: chordText });
          tokens.push({ kind: 'compound-sep', text: raw[end] });
          i = end + 1;
          continue;
        }
        tokens.push({ kind: 'chord', text: chordText });
        i = end;
        continue;
      }
      if (raw[i] === '_' || raw[i] === '/') { tokens.push({ kind: 'slash', text: raw[i] }); i++; continue; }
      tokens.push({ kind: 'unknown', text: raw[i] });
      i++;
    }
    return tokens;
  }

  function parseBeats(tokens, warnings) {
    const beats = [];
    let i = 0;
    const consume = () => tokens[i++];
    const peek = () => tokens[i];
    while (i < tokens.length) {
      const tok = peek();
      if (!tok) break;
      if (tok.kind === 'lparen') {
        consume();
        const inner = [];
        while (i < tokens.length && peek() && peek().kind !== 'rparen') {
          const t = peek();
          if (t.kind === 'chord') { consume(); inner.push({ kind: 'chord', text: t.text }); }
          else if (t.kind === 'slash') { consume(); inner.push({ kind: 'slash' }); }
          else if (t.kind === 'rest') { consume(); inner.push({ kind: 'rest' }); }
          else consume();
        }
        if (peek() && peek().kind === 'rparen') consume();
        if (inner.length < 2) {
          warnings.push('Tuplet group has fewer than 2 elements — treated as plain beats');
          beats.push(...inner);
        } else {
          beats.push({ kind: 'tuplet', beats: inner, count: inner.length });
        }
        continue;
      }
      if (tok.kind === 'chord') {
        consume();
        if (peek() && peek().kind === 'compound-sep') {
          const parts = [{ chord: tok.text, separator: '_' }];
          while (peek() && peek().kind === 'compound-sep') {
            const sep = consume();
            const next = peek();
            if (next && next.kind === 'chord') { consume(); parts.push({ chord: next.text, separator: sep.text }); }
          }
          beats.push({ kind: 'compound', parts });
          continue;
        }
        beats.push({ kind: 'chord', text: tok.text });
        continue;
      }
      if (tok.kind === 'slash') { consume(); beats.push({ kind: 'slash' }); continue; }
      if (tok.kind === 'rest') { consume(); beats.push({ kind: 'rest' }); continue; }
      consume();
    }
    return beats;
  }

  function barlineKindLeft(s) {
    if (s === '|:') return 'repeat-start';
    return 'single';
  }

  function barlineKindRight(s) {
    if (s === ':|') return 'repeat-end';
    if (s === '||') return 'final';
    return 'single';
  }

  function parseMeasureLine(line, warnings) {
    const parts = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '|') {
        if (line.slice(i, i + 2) === '|:') { parts.push({ kind: 'bar', text: '|:' }); i += 2; }
        else if (line.slice(i, i + 2) === '||') { parts.push({ kind: 'bar', text: '||' }); i += 2; }
        else { parts.push({ kind: 'bar', text: '|' }); i++; }
      } else if (line[i] === ':' && i + 1 < line.length && line[i + 1] === '|') {
        parts.push({ kind: 'bar', text: ':|' }); i += 2;
      } else {
        let content = '';
        while (i < line.length && line[i] !== '|' && !(line[i] === ':' && line[i + 1] === '|')) {
          content += line[i++];
        }
        const trimmed = content.trim();
        if (trimmed) parts.push({ kind: 'content', text: trimmed });
      }
    }
    const barlines = [];
    const contents = [];
    let expectBar = true;
    for (const p of parts) {
      if (p.kind === 'bar') { barlines.push(p.text); expectBar = false; }
      else {
        if (expectBar) barlines.push('|');
        contents.push(p.text);
        expectBar = true;
      }
    }
    if (contents.length > 0 && barlines.length <= contents.length) barlines.push('|');
    const measures = [];
    for (let mi = 0; mi < contents.length; mi++) {
      const toks = tokeniseMeasureContent(contents[mi]);
      const beats = parseBeats(toks, warnings);
      measures.push({
        beats,
        leftBarline: barlineKindLeft(barlines[mi] || '|'),
        rightBarline: barlineKindRight(barlines[mi + 1] || '|'),
      });
    }
    return measures;
  }

  function csmlParse(text) {
    const doc = { title: '', composer: '', key: '', time: '4/4', tempo: 0, style: '', sections: [], warnings: [] };
    const lines = text.split(/\r?\n/);
    let currentSection = null;

    const flushSection = () => {
      if (currentSection && currentSection.measures.length > 0) doc.sections.push(currentSection);
    };
    const openSection = (label) => { flushSection(); currentSection = { label, measures: [] }; };
    const ensureSection = () => { if (!currentSection) currentSection = { label: '', measures: [] }; };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || COMMENT_RE.test(line)) continue;
      const metaMatch = META_RE.exec(line);
      if (metaMatch) {
        const field = metaMatch[1].toLowerCase();
        const value = metaMatch[2].trim();
        if (field === 'title') doc.title = value;
        else if (field === 'composer') doc.composer = value;
        else if (field === 'key') doc.key = value;
        else if (field === 'time') doc.time = value;
        else if (field === 'tempo') { const n = parseInt(value.replace(/[^\d]/g, ''), 10); doc.tempo = isNaN(n) ? 0 : n; }
        else if (field === 'style') doc.style = value;
        continue;
      }
      const secMatch = SECTION_LABEL_RE.exec(line);
      if (secMatch) { openSection(secMatch[1].trim()); continue; }
      if (MEASURE_LINE_RE.test(line)) {
        ensureSection();
        const measures = parseMeasureLine(line, doc.warnings);
        currentSection.measures.push(...measures);
        continue;
      }
      doc.warnings.push(`Unrecognised line: "${line.slice(0, 60)}"`);
    }
    flushSection();
    if (doc.sections.length === 0) doc.sections.push({ label: '', measures: [] });
    return doc;
  }

  function beatsPerMeasure(time) {
    const m = /^(\d+)\/(\d+)$/.exec(time);
    if (!m) return 4;
    const num = parseInt(m[1], 10);
    const den = parseInt(m[2], 10);
    if (den === 8 && num % 3 === 0) return num / 3;
    return num;
  }

  function beatChordText(beat) {
    if (beat.kind === 'chord') return beat.text;
    if (beat.kind === 'compound') return (beat.parts[0] && beat.parts[0].chord) || null;
    if (beat.kind === 'tuplet') return beatChordText(beat.beats[0]);
    return null;
  }

  // ─── SVG Renderer ──────────────────────────────────────────────────────────

  const PAGE_W = 760, MARGIN_H = 36, CLEF_W = 50;
  const LINE_GAP = 8, STAFF_LINES = 5, STAFF_H = 32;
  const CHORD_AREA_H = 38, SYSTEM_PAD_BOT = 40, SYSTEM_ROW_H = 110;
  const SECTION_LABEL_H = 22, TITLE_AREA_H = 56;
  const SN_W = 9, SN_H = 5.5, SN_LEAN = 5;

  const SHARP_KEY_COUNT = { G:1, D:2, A:3, E:4, B:5, 'F#':6, 'C#':7 };
  const FLAT_KEY_COUNT  = { F:1, Bb:2, Eb:3, Ab:4, Db:5, Gb:6, Cb:7 };
  const SHARP_Y_OFFSETS = [0, 12, -4, 8, 20, 4, 16];
  const FLAT_Y_OFFSETS  = [16, 4, 20, 8, 24, 12, 28];

  function svgEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function svgLine(x1, y1, x2, y2, col, w) {
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${col}" stroke-width="${w||1}"/>`;
  }

  function slashHead(cx, cy, col) {
    const x1=cx-SN_W/2, y1=cy+SN_H/2, x2=cx+SN_W/2, y2=cy+SN_H/2;
    const x3=cx+SN_W/2+SN_LEAN, y3=cy-SN_H/2, x4=cx-SN_W/2+SN_LEAN, y4=cy-SN_H/2;
    return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3} ${x4},${y4}" fill="${col}"/>`;
  }

  function noteStem(cx, cy, col) {
    return svgLine(cx+SN_LEAN/2+4, cy-SN_H/2, cx+SN_LEAN/2+4, cy-22, col, 1.5);
  }

  function staffLinesEl(x, y, w, col) {
    const out = [];
    for (let i = 0; i < STAFF_LINES; i++) out.push(svgLine(x, y+i*LINE_GAP, x+w, y+i*LINE_GAP, col, 1));
    return out.join('');
  }

  function trebleClefEl(x, y, col) {
    return `<text x="${x}" y="${y+STAFF_H+4}" font-size="40" font-family="serif" fill="${col}" dominant-baseline="bottom">𝄞</text>`;
  }

  function keySigEl(x, staffY, keySig, col) {
    if (SHARP_KEY_COUNT[keySig] !== undefined) {
      const count = SHARP_KEY_COUNT[keySig];
      const parts = [];
      for (let i = 0; i < count; i++)
        parts.push(`<text x="${x+i*8}" y="${staffY+SHARP_Y_OFFSETS[i]-4}" font-size="14" font-family="serif" fill="${col}" dominant-baseline="hanging">♯</text>`);
      return { svg: parts.join(''), width: count*8+4 };
    }
    if (FLAT_KEY_COUNT[keySig] !== undefined) {
      const count = FLAT_KEY_COUNT[keySig];
      const parts = [];
      for (let i = 0; i < count; i++)
        parts.push(`<text x="${x+i*8}" y="${staffY+FLAT_Y_OFFSETS[i]-8}" font-size="14" font-family="serif" fill="${col}" dominant-baseline="hanging">♭</text>`);
      return { svg: parts.join(''), width: count*8+4 };
    }
    return { svg: '', width: 0 };
  }

  function timeSigEl(x, staffY, time, col) {
    const m = /^(\d+)\/(\d+)$/.exec(time);
    if (!m) return '';
    return (
      `<text x="${x+6}" y="${staffY+2}" font-size="16" font-weight="bold" font-family="serif" fill="${col}" dominant-baseline="hanging">${m[1]}</text>` +
      `<text x="${x+6}" y="${staffY+16}" font-size="16" font-weight="bold" font-family="serif" fill="${col}" dominant-baseline="hanging">${m[2]}</text>`
    );
  }

  function barlineEl(x, y, h, kind, col) {
    const dotR = 3;
    switch (kind) {
      case 'single':    return svgLine(x, y, x, y+h, col, 1.5);
      case 'double':    return svgLine(x-2,y,x-2,y+h,col,1)+svgLine(x+2,y,x+2,y+h,col,1);
      case 'final':     return svgLine(x-3,y,x-3,y+h,col,1)+svgLine(x,y,x,y+h,col,4);
      case 'repeat-start':
        return svgLine(x,y,x,y+h,col,4)+svgLine(x+4,y,x+4,y+h,col,1)+
          `<circle cx="${x+9}" cy="${y+h*0.33}" r="${dotR}" fill="${col}"/>` +
          `<circle cx="${x+9}" cy="${y+h*0.67}" r="${dotR}" fill="${col}"/>`;
      case 'repeat-end':
        return svgLine(x-9,y,x-9,y+h,col,1)+svgLine(x-5,y,x-5,y+h,col,4)+
          `<circle cx="${x-13}" cy="${y+h*0.33}" r="${dotR}" fill="${col}"/>` +
          `<circle cx="${x-13}" cy="${y+h*0.67}" r="${dotR}" fill="${col}"/>`;
      default: return svgLine(x, y, x, y+h, col, 1.5);
    }
  }

  function buildRows(doc, mpr) {
    const rows = [];
    let current = [], isFirstRow = true;
    const flush = () => {
      if (current.length > 0) { rows.push({ measures: current, isFirstRow }); isFirstRow = false; current = []; }
    };
    for (const sec of doc.sections) {
      for (let mi = 0; mi < sec.measures.length; mi++) {
        const rm = { measure: sec.measures[mi] };
        if (mi === 0 && sec.label) rm.sectionLabel = sec.label;
        if (sec.measures[mi].leftBarline === 'repeat-start' && current.length > 0) flush();
        current.push(rm);
        if (current.length >= mpr || sec.measures[mi].rightBarline === 'repeat-end' || sec.measures[mi].rightBarline === 'final') flush();
      }
    }
    flush();
    return rows;
  }

  function renderBeatNoteheads(beat, cx, cy, subSpacing, fg, withStem, out, depth) {
    if (depth > 3) return;
    switch (beat.kind) {
      case 'chord':
      case 'slash':
        out.push(slashHead(cx, cy, fg));
        if (withStem) out.push(noteStem(cx, cy, fg));
        break;
      case 'rest':
        out.push(`<rect x="${cx-5}" y="${cy-2}" width="10" height="4" fill="${fg}"/>`);
        break;
      case 'compound': {
        const n = Math.min(beat.parts.length, 4);
        for (let i = 0; i < n; i++) {
          const nhX = cx - (subSpacing*(n-1))/2 + i*subSpacing;
          out.push(slashHead(nhX, cy, fg));
          if (withStem) out.push(noteStem(nhX, cy, fg));
        }
        break;
      }
      case 'tuplet': {
        const n = beat.beats.length;
        const sp = subSpacing / Math.max(n, 1);
        for (let i = 0; i < n; i++) {
          const nhX = cx - (subSpacing*(n-1))/2 + i*subSpacing;
          renderBeatNoteheads(beat.beats[i], nhX, cy, sp, fg, withStem, out, depth+1);
        }
        const bx1=cx-(subSpacing*(n-1))/2-4, bx2=cx+(subSpacing*(n-1))/2+4, by=cy-28;
        out.push(
          svgLine(bx1,by,bx2,by,fg,1), svgLine(bx1,by,bx1,by+6,fg,1), svgLine(bx2,by,bx2,by+6,fg,1),
          `<text x="${(bx1+bx2)/2}" y="${by-2}" font-size="9" font-family="Arial,sans-serif" fill="${fg}" text-anchor="middle">${n}</text>`
        );
        break;
      }
    }
  }

  function csmlToSvgDoc(doc, opts) {
    const o = Object.assign({ measuresPerRow:4, fgColor:'#000', bgColor:'#fff', chordColor:'#000', chordFontSize:14, chordFont:'Georgia,serif', labelFont:'Arial,sans-serif', stems:false, keySig:'' }, opts || {});
    const mpr = o.measuresPerRow;
    const { fgColor: fg, bgColor: bg, chordColor: cc } = o;
    const rows = buildRows(doc, mpr);
    const bpm = beatsPerMeasure(doc.time);

    let totalH = TITLE_AREA_H;
    for (const row of rows) {
      const hasLabel = row.measures.some(rm => rm.sectionLabel);
      totalH += (hasLabel ? SECTION_LABEL_H : 0) + SYSTEM_ROW_H;
    }

    const parts = [];
    parts.push(`<rect width="${PAGE_W}" height="${totalH}" fill="${bg}"/>`);

    if (doc.title) parts.push(`<text x="${PAGE_W/2}" y="28" font-size="20" font-weight="bold" font-family="${svgEsc(o.labelFont)}" fill="${fg}" text-anchor="middle">${svgEsc(doc.title)}</text>`);
    const metaParts = [];
    if (doc.composer) metaParts.push(svgEsc(doc.composer));
    if (doc.key)      metaParts.push(`Key: ${svgEsc(doc.key)}`);
    if (doc.tempo)    metaParts.push(`♩= ${doc.tempo}`);
    if (doc.style)    metaParts.push(svgEsc(doc.style));
    if (metaParts.length) parts.push(`<text x="${PAGE_W/2}" y="46" font-size="11" font-family="${svgEsc(o.labelFont)}" fill="${fg}" text-anchor="middle">${metaParts.join('   ')}</text>`);

    let curY = TITLE_AREA_H;
    for (const row of rows) {
      const labelText = (row.measures.find(rm => rm.sectionLabel) || {}).sectionLabel;
      if (labelText) {
        parts.push(`<text x="${MARGIN_H}" y="${curY+16}" font-size="13" font-weight="bold" font-style="italic" font-family="${svgEsc(o.labelFont)}" fill="${fg}">${svgEsc(labelText)}</text>`);
        curY += SECTION_LABEL_H;
      }
      const staffY = curY + CHORD_AREA_H;
      const rowX = MARGIN_H;
      const showClef = row.isFirstRow || Boolean(labelText);
      const clefUsedW = showClef ? CLEF_W : 0;
      if (showClef) {
        parts.push(trebleClefEl(rowX, staffY-8, fg));
        const ks = keySigEl(rowX+28, staffY, o.keySig, fg);
        parts.push(ks.svg);
        parts.push(timeSigEl(rowX+28+ks.width, staffY, doc.time, fg));
      }
      const rowUsableW = PAGE_W - 2*MARGIN_H - clefUsedW;
      const measW = rowUsableW / row.measures.length;
      const staffStartX = rowX + clefUsedW;
      parts.push(staffLinesEl(staffStartX, staffY, rowUsableW, fg));
      const firstBarKind = row.measures[0].measure.leftBarline;
      parts.push(barlineEl(staffStartX, staffY, STAFF_H, firstBarKind === 'repeat-start' ? 'repeat-start' : 'single', fg));
      let mx = staffStartX;
      for (let mi = 0; mi < row.measures.length; mi++) {
        const { measure } = row.measures[mi];
        const measLeft = mx;
        const measRight = mx + measW;
        const beatSpacing = measW / Math.max(bpm, 1);
        const noteCy = staffY + Math.floor(STAFF_H / 2);
        for (let bi = 0; bi < measure.beats.length; bi++) {
          const beat = measure.beats[bi];
          const bx = measLeft + beatSpacing*bi + beatSpacing*0.5;
          const chordTxt = beatChordText(beat);
          if (chordTxt) parts.push(`<text x="${bx}" y="${staffY-10}" font-size="${o.chordFontSize}" font-family="${svgEsc(o.chordFont)}" fill="${cc}" text-anchor="middle">${svgEsc(chordTxt)}</text>`);
          const nh = [];
          renderBeatNoteheads(beat, bx, noteCy, beatSpacing*0.4, fg, o.stems, nh, 0);
          parts.push(...nh);
        }
        for (let bi = measure.beats.length; bi < bpm; bi++) {
          const bx = measLeft + beatSpacing*bi + beatSpacing*0.5;
          parts.push(slashHead(bx, noteCy, fg));
          if (o.stems) parts.push(noteStem(bx, noteCy, fg));
        }
        mx = measRight;
        const isLast = mi === row.measures.length - 1;
        const rk = measure.rightBarline;
        const resolvedRk = (rk === 'final' && isLast) ? 'final' : (rk === 'repeat-end') ? 'repeat-end' : (rk === 'double') ? 'double' : 'single';
        parts.push(barlineEl(measRight, staffY, STAFF_H, resolvedRk, fg));
      }
      curY += SYSTEM_ROW_H;
    }
    return [`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${totalH}" viewBox="0 0 ${PAGE_W} ${totalH}">`, ...parts, '</svg>'].join('\n');
  }

  function csmlToSvg(text, opts) {
    const doc = csmlParse(text);
    if (window.csml) window.csml.warnings = doc.warnings || [];
    return csmlToSvgDoc(doc, opts);
  }

  // ─── LilyPond Converter ─────────────────────────────────────────────────────

  const NOTE_MAP = {
    C:'c','C#':'cis',Db:'des',D:'d','D#':'dis',Eb:'ees',E:'e',F:'f',
    'F#':'fis',Gb:'ges',G:'g','G#':'gis',Ab:'aes',A:'a','A#':'ais',
    Bb:'bes',B:'b','B#':'bis',Cb:'ces',
  };

  const QUALITY_MAP = [
    ['maj13','maj13'],['maj11','maj11'],['maj9','maj9'],['maj7','maj7'],['maj6','6'],['maj',''],
    ['mM7','m7+'],
    ['m7b5','m7.5-'],['m13','m13'],['m11','m11'],['m9','m9'],['m7','m7'],['m6','m6'],['min','m'],['m','m'],
    ['7#9','7.9+'],['7b9','7.9-'],['7#5','7.5+'],['7b5','7.5-'],['7sus4','7sus4'],['7sus2','7sus2'],['aug7','aug7'],
    ['13','13'],['11','11'],['9','9'],['7','7'],
    ['dim7','dim7'],['dim','dim'],
    ['aug','aug'],
    ['sus4','sus4'],['sus2','sus2'],
    ['6add9','6.9'],['9sus4','9sus4'],['add13','add13'],['add11','add11'],['add9','add9'],
    ['6','6'],['5','5'],['M',''],
  ];

  function noteToLy(note) {
    if (NOTE_MAP[note]) return NOTE_MAP[note];
    const m = /^([A-G])(##|bb|[#b])$/.exec(note);
    if (m) {
      const base = NOTE_MAP[m[1]] || m[1].toLowerCase();
      const acc = m[2]==='##'?'isis':m[2]==='bb'?'eses':m[2]==='#'?'is':'es';
      return base+acc;
    }
    return note.toLowerCase();
  }

  function qualityToLy(quality) {
    if (!quality) return '';
    for (const [from, to] of QUALITY_MAP) {
      if (quality === from) return to ? ':'+to : '';
    }
    return ':'+quality.toLowerCase();
  }

  function parseLeadSheetChord(chord) {
    const rootM = /^([A-G])(##|bb|[#b])?/.exec(chord);
    if (!rootM) return null;
    const root = rootM[0];
    let rest = chord.slice(root.length);
    let bass = null;
    const slashIdx = rest.indexOf('/');
    if (slashIdx !== -1) { bass = rest.slice(slashIdx+1); rest = rest.slice(0, slashIdx); }
    let quality = rest;
    if (quality === 'M') quality = '';
    return { root, quality, bass };
  }

  function chordToLy(chord, duration) {
    const parsed = parseLeadSheetChord(chord);
    if (!parsed) return `c${duration}`;
    const rootLy = noteToLy(parsed.root);
    const qualLy = qualityToLy(parsed.quality);
    let result = `${rootLy}${duration}${qualLy}`;
    if (parsed.bass) result += `/+${noteToLy(parsed.bass)}`;
    return result;
  }

  function beatDuration(time) {
    const m = /^(\d+)\/(\d+)$/.exec(time);
    if (!m) return '4';
    const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
    if (den === 8 && num % 3 === 0) return '4.';
    if (den === 2) return '2';
    if (den === 4) return '4';
    if (den === 8) return '8';
    if (den === 16) return '16';
    return '4';
  }

  function beatToLyTokens(beat, dur, halfDur) {
    switch (beat.kind) {
      case 'chord':
      case 'slash':   return [`c${dur}`];
      case 'rest':    return [`r${dur}`];
      case 'compound': return beat.parts.map(() => `c${halfDur}`);
      case 'tuplet': {
        const n = beat.beats.length;
        const inner = beat.beats.map(() => `c${dur}`).join(' ');
        return [`\\tuplet ${n}/2 { ${inner} }`];
      }
    }
    return [`c${dur}`];
  }

  function beatToChordEvent(beat, dur, halfDur) {
    switch (beat.kind) {
      case 'chord':  return [{ chord: beat.text, duration: dur, beats: 1 }];
      case 'slash':
      case 'rest':   return [{ chord: null, duration: dur, beats: 1 }];
      case 'compound': return beat.parts.map(p => ({ chord: p.chord, duration: halfDur, beats: 0.5 }));
      case 'tuplet': return beat.beats.map(b => ({ chord: b.kind === 'chord' ? b.text : null, duration: dur, beats: 1/beat.beats.length }));
    }
    return [{ chord: null, duration: dur, beats: 1 }];
  }

  function measureToChordmode(measure, bpm, dur, halfDur) {
    const events = [];
    for (const beat of measure.beats) events.push(...beatToChordEvent(beat, dur, halfDur));
    for (let i = measure.beats.length; i < bpm; i++) events.push({ chord: null, duration: dur, beats: 1 });

    const tokens = [];
    let lastChord = null, accumulated = 0;
    const flush = (holdDur) => {
      tokens.push(lastChord !== null ? chordToLy(lastChord, holdDur) : `s${holdDur}`);
      accumulated = 0;
    };
    for (const ev of events) {
      if (ev.chord !== null) {
        if (accumulated > 0) flush(dur);
        lastChord = ev.chord;
        accumulated = ev.beats;
      } else {
        accumulated += ev.beats;
      }
    }
    if (accumulated > 0) flush(dur);
    return tokens.join(' ');
  }

  function measureToRhythm(measure, bpm, dur, halfDur) {
    const tokens = [];
    for (const beat of measure.beats) tokens.push(...beatToLyTokens(beat, dur, halfDur));
    for (let i = measure.beats.length; i < bpm; i++) tokens.push(`c${dur}`);
    return tokens.join(' ');
  }

  function leftBarlineLy(kind) {
    return kind === 'repeat-start' ? '\\repeat volta 2 {' : '';
  }
  function rightBarlineLy(kind) {
    if (kind === 'repeat-end') return '}';
    if (kind === 'final' || kind === 'double') return '\\bar "|."';
    return '';
  }

  function csmlToLilypondDoc(doc) {
    const bpm = beatsPerMeasure(doc.time);
    const dur = beatDuration(doc.time);
    const halfDur = dur.endsWith('.') ? dur.slice(0,-1) : String(parseInt(dur,10)*2);

    const chordLines = [], rhythmLines = [];
    for (const sec of doc.sections) {
      if (sec.label) {
        chordLines.push(`  % [${sec.label}]`);
        rhythmLines.push(`  % [${sec.label}]`);
        rhythmLines.push(`  \\mark \\markup { \\box "\\italic { ${sec.label.replace(/"/g,'\\"')} }" }`);
      }
      for (const meas of sec.measures) {
        const leftLy = leftBarlineLy(meas.leftBarline);
        const rightLy = rightBarlineLy(meas.rightBarline);
        const cm = measureToChordmode(meas, bpm, dur, halfDur);
        const rm = measureToRhythm(meas, bpm, dur, halfDur);
        if (leftLy) { chordLines.push(`  ${leftLy}`); rhythmLines.push(`  ${leftLy}`); }
        chordLines.push(`  ${cm} |`);
        rhythmLines.push(`  ${rm} |`);
        if (rightLy) { chordLines.push(`  ${rightLy}`); rhythmLines.push(`  ${rightLy}`); }
      }
    }
    const titleEsc = doc.title.replace(/"/g,'\\"');
    const composerEsc = doc.composer.replace(/"/g,'\\"');
    const keyLy = doc.key ? noteToLy(doc.key.replace(/m$/,'').trim()) : 'c';
    const keyMode = doc.key.endsWith('m') ? 'minor' : 'major';
    const timeLy = doc.time;
    const lines = [
      `\\version "2.24.0"`, ``,
      `\\header {`, `  title = "${titleEsc}"`, `  composer = "${composerEsc}"`, `  tagline = ##f`, `}`, ``,
      `\\score {`, `  \\new StaffGroup <<`,
      `    \\new ChordNames {`, `      \\set chordChanges = ##t`, `      \\chordmode {`,
      `        \\key ${keyLy} \\${keyMode}`, `        \\time ${timeLy}`,
      ...(doc.tempo ? [`        \\tempo 4 = ${doc.tempo}`] : []),
      ...chordLines.map(l => `    ${l}`),
      `      }`, `    }`,
      `    \\new RhythmicStaff {`, `      \\improvisationOn`,
      `      \\key ${keyLy} \\${keyMode}`, `      \\time ${timeLy}`,
      ...rhythmLines.map(l => `    ${l}`),
      `    }`, `  >>`,
      `  \\layout {`, `    \\context {`, `      \\Score`, `      \\omit TimeSignature`, `    }`, `  }`,
      `}`,
    ];
    return lines.join('\n') + '\n';
  }

  function csmlToLilypond(text) {
    return csmlToLilypondDoc(csmlParse(text));
  }

  // ─── MusicXML Exporter ─────────────────────────────────────────────────────

  function xmlEsc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function csmlChordKind(quality) {
    if (!quality) return 'major';
    const q = quality.toLowerCase();
    if (q.startsWith('ø') || q === 'm7b5' || q === 'm7♭5') return 'half-diminished';
    if (q.startsWith('maj') || q.startsWith('ma') || q.startsWith('δ') || q.startsWith('Δ')) return 'major-seventh';
    if (q.startsWith('°7') || q.startsWith('dim7') || q === 'o7') return 'diminished-seventh';
    if (q.startsWith('°') || q.startsWith('dim') || q === 'o') return 'diminished';
    if (q.startsWith('+7') || q.startsWith('aug7') || q.startsWith('7#5') || q.startsWith('7♯5')) return 'augmented-seventh';
    if (q === '+' || q.startsWith('aug')) return 'augmented';
    if (q === 'm' || q === 'min' || q === 'mi' || q === '−') return 'minor';
    if (q.startsWith('m7') || q.startsWith('min7') || q.startsWith('mi7') || q.startsWith('−7')) return 'minor-seventh';
    if (q.startsWith('m') && /\d/.test(q)) return 'minor-seventh';
    if (q.startsWith('−') && /\d/.test(q)) return 'minor-seventh';
    if (q === '6' || q.startsWith('6/9')) return 'major-sixth';
    if (q === '7') return 'dominant';
    if (/^[79]/.test(q) || q.startsWith('13') || q.startsWith('11')) return 'dominant';
    if (q.startsWith('sus4') || q === 'sus') return 'suspended-fourth';
    if (q.startsWith('sus2')) return 'suspended-second';
    return 'major';
  }

  function csmlKeySigFifths(keyStr) {
    const SHARPS = { C:0,G:1,D:2,A:3,E:4,B:5,'F#':6,'C#':7 };
    const FLATS  = { F:-1,Bb:-2,Eb:-3,Ab:-4,Db:-5,Gb:-6,Cb:-7 };
    if (!keyStr) return 0;
    const s = keyStr.trim().replace(/♭/g,'b').replace(/♯/g,'#')
      .replace(/\s*(major|maj)\s*$/i,'').replace(/\s*(minor|min)\s*$/i,'m');
    const root = s.endsWith('m') ? s.slice(0,-1) : s;
    const norm = root[0].toUpperCase() + root.slice(1);
    // For minor keys find relative major
    const MINOR_TO_MAJOR = { Am:'C',Em:'G',Bm:'D','F#m':'A','C#m':'E','G#m':'B','D#m':'F#','A#m':'C#',
      Dm:'F',Gm:'Bb',Cm:'Eb',Fm:'Ab',Bbm:'Db',Ebm:'Gb',Abm:'Cb' };
    if (s.endsWith('m')) {
      const rel = MINOR_TO_MAJOR[s[0].toUpperCase() + s.slice(1)];
      if (rel) return SHARPS[rel] !== undefined ? SHARPS[rel] : (FLATS[rel] || 0);
    }
    if (SHARPS[norm] !== undefined) return SHARPS[norm];
    if (FLATS[norm] !== undefined) return FLATS[norm];
    return 0;
  }

  function csmlKeyMode(keyStr) {
    if (!keyStr) return 'major';
    const s = keyStr.trim().replace(/\s*(minor|min)\s*$/i,'m').replace(/\s*(major|maj)\s*$/i,'');
    return (s.endsWith('m') || /minor/i.test(keyStr)) ? 'minor' : 'major';
  }

  function csmlBeatsPerMeasure(timeSig) {
    // Compound meters: count dotted-quarter groups
    if (timeSig === '12/8') return 4;
    if (timeSig === '9/8')  return 3;
    if (timeSig === '6/8')  return 2;
    const m = (timeSig || '4/4').match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 4;
  }

  // Extract the first chord text from a beat (for harmony elements)
  function csmlBeatChordText(beat) {
    if (beat.kind === 'chord') return beat.text;
    if (beat.kind === 'compound') return beat.parts[0] ? beat.parts[0].chord : null;
    if (beat.kind === 'tuplet') {
      for (const b of beat.beats) { const t = csmlBeatChordText(b); if (t) return t; }
    }
    return null;
  }

  function csmlHarmonyXml(chordText, offset, bpm) {
    if (!chordText) return '';
    const m = chordText.match(/^([A-G])(♭|♯|b|#)?(.*)$/);
    if (!m) return '';
    const rootStep  = m[1];
    const accStr    = m[2] || '';
    const rootAlter = (accStr === '♭' || accStr === 'b') ? -1 : (accStr === '♯' || accStr === '#') ? 1 : 0;
    const rest      = m[3] || '';
    const qualRaw   = rest.replace(/\/.*$/, '').trim();
    const bassMatch = rest.match(/\/([A-G])(♭|♯|b|#)?$/);
    const bassStep  = bassMatch ? bassMatch[1] : '';
    const bassAcc   = bassMatch ? (bassMatch[2] || '') : '';
    const bassAlter = (bassAcc === '♭' || bassAcc === 'b') ? -1 : (bassAcc === '♯' || bassAcc === '#') ? 1 : 0;
    const alterTag  = rootAlter !== 0 ? `<alter>${rootAlter}</alter>` : '';
    const bassXml   = bassStep ? `<bass><bass-step>${xmlEsc(bassStep)}</bass-step>${bassAlter !== 0 ? `<bass-alter>${bassAlter}</bass-alter>` : ''}</bass>` : '';
    const offsetTag = offset > 0 ? `<offset>${offset}</offset>` : '';
    return `\n      <harmony>${offsetTag}<root><root-step>${xmlEsc(rootStep)}</root-step>${alterTag}</root><kind>${csmlChordKind(qualRaw)}</kind>${bassXml}</harmony>`;
  }

  function csmlToMusicXmlDoc(doc) {
    if (!doc.sections.length) return null;

    const timeSig   = doc.time || '4/4';
    const bpm       = csmlBeatsPerMeasure(timeSig);
    const timeParts = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/) || ['4/4','4','4'];
    const beats     = timeParts[1];
    const beatType  = timeParts[2];
    const divisions = 1;
    const fifths    = csmlKeySigFifths(doc.key);
    const mode      = csmlKeyMode(doc.key);
    const title     = xmlEsc(doc.title    || 'Untitled');
    const composer  = xmlEsc(doc.composer || '');

    let measureXml = '';
    let measureIndex = 0;

    for (const sec of doc.sections) {
      const label = sec.label || '';

      for (let mi = 0; mi < sec.measures.length; mi++) {
        const meas = sec.measures[mi];
        const num  = ++measureIndex;

        // ── 1. <attributes> (first measure only) ──────────────────────────
        let attrsXml = '';
        if (num === 1) {
          attrsXml = `
      <attributes>
        <divisions>${divisions}</divisions>
        <key><fifths>${fifths}</fifths><mode>${mode}</mode></key>
        <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
        <measure-style><slash type="start" use-stems="no"/></measure-style>
      </attributes>`;
          if (doc.tempo) {
            attrsXml += `
      <direction placement="above">
        <direction-type><metronome parentheses="no">
          <beat-unit>quarter</beat-unit><per-minute>${xmlEsc(doc.tempo)}</per-minute>
        </metronome></direction-type>
        <sound tempo="${xmlEsc(doc.tempo)}"/>
      </direction>`;
          }
        }

        // ── 2. Rehearsal mark (first measure of each named section) ───────
        let rehearsalXml = '';
        if (mi === 0 && label) {
          rehearsalXml = `
      <direction placement="above">
        <direction-type>
          <rehearsal enclosure="square" default-y="40">${xmlEsc(label)}</rehearsal>
        </direction-type>
      </direction>`;
        }

        // ── 3. <harmony> elements — one per chord-change beat ─────────────
        let harmonyXml = '';
        let lastChord  = null;
        for (let bi = 0; bi < meas.beats.length; bi++) {
          const beat      = meas.beats[bi];
          const chordText = csmlBeatChordText(beat);
          if (chordText && chordText !== lastChord) {
            const offset = Math.round((bi / Math.max(meas.beats.length, 1)) * bpm * divisions);
            harmonyXml += csmlHarmonyXml(chordText, offset, bpm);
            lastChord = chordText;
          }
        }

        // ── 4. <note> slash noteheads ─────────────────────────────────────
        let notesXml = '';
        for (let b = 0; b < bpm; b++) {
          notesXml += `
      <note><pitch><step>B</step><octave>4</octave></pitch><duration>${divisions}</duration><type>quarter</type><notehead>slash</notehead></note>`;
        }

        // ── 5. Barlines ───────────────────────────────────────────────────
        let leftBarlineXml = '';
        if (meas.leftBarline === 'repeat-start') {
          leftBarlineXml = '\n      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>';
        }
        let rightBarlineXml = '';
        if (meas.rightBarline === 'repeat-end') {
          rightBarlineXml = '\n      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>';
        } else if (meas.rightBarline === 'final') {
          rightBarlineXml = '\n      <barline location="right"><bar-style>light-heavy</bar-style></barline>';
        }

        measureXml += `
    <measure number="${num}">${leftBarlineXml}${attrsXml}${rehearsalXml}${harmonyXml}${notesXml}${rightBarlineXml}
    </measure>`;
      }
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <movement-title>${title}</movement-title>${composer ? `\n  <identification><creator type="composer">${composer}</creator></identification>` : ''}
  <part-list>
    <score-part id="P1"><part-name>Rhythm Guitar</part-name></score-part>
  </part-list>
  <part id="P1">${measureXml}
  </part>
</score-partwise>`;
  }

  function csmlToMusicXml(text) {
    return csmlToMusicXmlDoc(csmlParse(text));
  }

  // ─── ChordSlashML → CSMPN Transpiler ──────────────────────────────────────

  // Extract the first chord name from a beat (for bar-level chord tracking).
  function csmlFirstChordOfBeat(beat) {
    if (beat.kind === 'chord') return beat.text;
    if (beat.kind === 'compound') return beat.parts[0] ? beat.parts[0].chord : null;
    if (beat.kind === 'tuplet') {
      for (const b of beat.beats) { const t = csmlFirstChordOfBeat(b); if (t) return t; }
    }
    return null; // slash/rest/continuation
  }

  // Derive the CSMPN bar token from a ChordSlashML measure.
  // Returns a string like "G", "Am_F", or "%" (all-continuation/rest).
  function csmlMeasureToBarToken(meas) {
    const seen = [];
    let last = null;
    for (const beat of meas.beats) {
      const ch = csmlFirstChordOfBeat(beat);
      if (ch && ch !== last) { seen.push(ch); last = ch; }
    }
    if (seen.length === 0) return '%';
    return seen.join('_');
  }

  function csmlToCsmpnDoc(doc) {
    const lines = [];

    // Header — use full-word field names (CSMPN accepts both short and long)
    if (doc.title)    lines.push(`Title: ${doc.title}`);
    if (doc.composer) lines.push(`Composer: ${doc.composer}`);
    if (doc.key)      lines.push(`Key: ${doc.key}`);
    if (doc.time && doc.time !== '4/4') lines.push(`Time: ${doc.time}`);
    if (doc.tempo)    lines.push(`Tempo: ${doc.tempo}`);
    if (doc.style)    lines.push(`Style: ${doc.style}`);

    for (const sec of doc.sections) {
      lines.push('');
      if (sec.label) lines.push(`- ${sec.label}`);

      // Collect bar tokens, tracking repeat groups
      const tokens = sec.measures.map(csmlMeasureToBarToken);
      const lBars  = sec.measures.map(m => m.leftBarline);
      const rBars  = sec.measures.map(m => m.rightBarline);

      // Group into repeat/non-repeat runs, then emit each run on one line.
      // A repeat group spans from a 'repeat-start' left barline to the
      // matching 'repeat-end' right barline.
      let i = 0;
      while (i < tokens.length) {
        if (lBars[i] === 'repeat-start') {
          // Collect until repeat-end
          const group = [];
          while (i < tokens.length) {
            group.push(tokens[i]);
            const isEnd = rBars[i] === 'repeat-end';
            i++;
            if (isEnd) break;
          }
          lines.push(`|: ${group.join(' ')} :|`);
        } else {
          // Plain run until next repeat-start or end
          const group = [];
          while (i < tokens.length && lBars[i] !== 'repeat-start') {
            group.push(tokens[i]);
            const isFinal = rBars[i] === 'final';
            i++;
            if (isFinal) break;
          }
          if (group.length) lines.push(group.join(' '));
        }
      }
    }

    return lines.join('\n');
  }

  function csmlToCsmpn(text) {
    return csmlToCsmpnDoc(csmlParse(text));
  }

  // ─── Export ────────────────────────────────────────────────────────────────

  window.csml = {
    parse:         csmlParse,
    toSvg:         csmlToSvg,
    toSvgDoc:      csmlToSvgDoc,
    toLilypond:    csmlToLilypond,
    toMusicXml:    csmlToMusicXml,
    toMusicXmlDoc: csmlToMusicXmlDoc,
    toCsmpn:       csmlToCsmpn,
    toCsmpnDoc:    csmlToCsmpnDoc,
  };
})();

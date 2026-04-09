/* chordProcessing.js — Chord parsing, transposition, and rendering utilities
   Extracted from index.html (Sprint 3, item 2.1B).
   Depends on: utils.js (normalizeAccidentals, escapeHtml) — must load first.
   Depends on: fbSettings global (defined in inline script, accessed at call-time only).
   Depends on: validationWarnings global (defined in inline script, accessed at call-time only).
*/

function detectNotationPreferenceFromKeyOrText(key, text){
  const k = (key||'').toLowerCase();
  if (k.includes('b')) return 'flat';
  if (k.includes('#')) return 'sharp';
  // fallback: inspect chord tokens (require boundary to avoid matching words like "Above")
  if (/\b[A-G]b(?:[^a-z]|$)/m.test(text)) return 'flat';
  if (/\b[A-G]#/.test(text)) return 'sharp';
  return 'sharp';
}

// ---------------------------------------------------------
// Transposition helpers
// ---------------------------------------------------------
const NOTE_INDEX = new Map([
  ['C',0],['B#',0],
  ['C#',1],['DB',1],
  ['D',2],
  ['D#',3],['EB',3],
  ['E',4],['FB',4],
  ['F',5],['E#',5],
  ['F#',6],['GB',6],
  ['G',7],
  ['G#',8],['AB',8],
  ['A',9],
  ['A#',10],['BB',10],
  ['B',11],['CB',11],
]);

const NOTES_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const NOTES_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

function transposeNote(note, semis, pref){
  const n = normalizeAccidentals(note).toUpperCase().replace(/\s+/g,'');
  const idx = NOTE_INDEX.get(n);
  if (idx === undefined) return note;

  const t = (idx + (semis % 12) + 12) % 12;
  const arr = (pref === 'flat') ? NOTES_FLAT : NOTES_SHARP;
  return arr[t];
}

function normalizeBarlineDelimiters(line){
  // Accept UG/ChordSheet barline characters and normalize for tokenization
  // ǁ / ‖ / ∥ are treated as double barlines
  // Use placeholders to prevent cascade destruction of multi-char barlines
  return (line || '')
    .replace(/[ǁ‖∥]/g, '||')
    .replace(/\|\|:/g, ' \x01RSTART\x01 ')
    .replace(/:\|\|/g, ' \x01REND2\x01 ')
    .replace(/\|:/g, ' \x01RSINGLE\x01 ')
    .replace(/:\|/g, ' \x01REND1\x01 ')
    .replace(/\|\]/g, ' \x01FINAL\x01 ')
    .replace(/\|\|/g, ' \x01DOUBLE\x01 ')
    .replace(/\|/g, ' | ')
    .replace(/\x01RSTART\x01/g, '||:')
    .replace(/\x01REND2\x01/g, ':||')
    .replace(/\x01RSINGLE\x01/g, '|:')
    .replace(/\x01REND1\x01/g, ':|')
    .replace(/\x01FINAL\x01/g, '|]')
    .replace(/\x01DOUBLE\x01/g, '||')
    .replace(/\s+/g, ' ')
    .trim();
}


function normalizeUGProText(text){
  // Normalizes Ultimate Guitar / UG Pro text exports.
  let t = (text ?? "").toString();
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/\u00A0/g, " ");
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, ""); // zero-width
  // Normalize "times" repeat phrasing to xN
  t = t.replace(/\b(times)\s*(two|2)\b/gi, "x2");
  t = t.replace(/\b(times)\s*(three|3)\b/gi, "x3");
  t = t.replace(/\b(times)\s*(four|4)\b/gi, "x4");
  // Normalize unicode bars
  t = t.replace(/[ǁ∥]/g, "||");
  // Collapse duplicate repeat tokens
  t = t.replace(/\b(x[234])(\s+\1)+\b/gi, "$1");
  // UG sometimes emits "x2 x2)" etc
  t = t.replace(/(\)\s*)\b(x[234])\b\s*\b\2\b/gi, "$1$2");
  // Normalize common quote types
  t = t.replace(/[""]/g, "\"").replace(/['']/g, "'");
  return t.trim();
}

function tokenizeBars(line){
  // tokenization: keep quoted annotations intact; also supports UG-style barlines
  const s = normalizeBarlineDelimiters(line);
  if (!s) return [];
  const out = [];
  let cur = '';
  let inQuote = false;

  for (let i=0;i<s.length;i++){
    const ch = s[i];
    if (ch === '"'){
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)){
      if (cur){
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);

  // If any token still contains barlines (rare PDF extraction cases), explode them.
  const exploded = [];
  for (const t of out){
    if (t.includes('|') && !isBarlineToken(t)){
      let buf = '';
      let i = 0;
      while (i < t.length){
        if (t[i] === '|'){
          if (buf){ exploded.push(buf); buf=''; }
          if (i+1 < t.length && t[i+1] === '|'){
            exploded.push('||'); i += 2; continue;
          } else {
            exploded.push('|'); i += 1; continue;
          }
        }
        buf += t[i];
        i++;
      }
      if (buf) exploded.push(buf);
    } else {
      exploded.push(t);
    }
  }

  return exploded;
}

function isBarlineToken(tok){
  return ['|', '||', '|:', ':|', '||:', ':||', '|]'].includes(tok);
}

function mapBarlineToken(tok){
  switch (tok){
    case '||':
      return 'double';
    case '|:':
    case '||:':
      return 'repeat-start';
    case ':|':
    case ':||':
      return 'repeat-end';
    case '|]':
      return 'final';
    default:
      return 'single';
  }
}

function transposeChordToken(tok, semis, pref){
  // structural tokens
  if (!tok) return tok;
  const upper = tok.toUpperCase();
  if (tok === '%' || tok === '%%' || /^%\d+$/.test(tok)) return tok;
  if (tok === '*' || isBarlineToken(tok)) return tok;
  if (upper === 'N.C.' || upper === 'NC') return tok;
  if (/^r[124]$/i.test(tok)) return tok; // rest tokens
  if (upper === 'FINE' || /^D\.?C\.?/i.test(tok) || /^D\.?S\.?/i.test(tok) || /^DACAPO/i.test(tok) || /^DALSEGNO/i.test(tok)) return tok;
  if (/^\d+\.$/.test(tok)) return tok; // endings marker token itself
  if (tok.startsWith('"') && tok.endsWith('"')) return tok; // annotation token

  // handle repeats: keep punctuation
  const mRepeat = tok.match(/^(\()?(.*?)(\))?(x\d+)?$/);
  if (!mRepeat) return tok;

  const preL = mRepeat[1] || '';
  let core = mRepeat[2] || '';
  const preR = mRepeat[3] || '';
  const rep  = mRepeat[4] || '';

  // split by underscores, commas
  const parts = core.split('_').map(seg => {
    return seg.split(',').map(piece => transposeChordSimple(piece, semis, pref)).join(',');
  }).join('_');

  return preL + parts + preR + rep;
}

function transposeChordSimple(ch, semis, pref){
  const s = ch.trim();
  if (!s) return s;
  // allow directives embedded
  const upper = s.toUpperCase();
  if (upper === 'N.C.' || upper === 'NC') return s;

  const prefix = ['$', 'o', 'O'].includes(s[0]) ? s[0] : '';
  const body = prefix ? s.slice(1) : s;

  const m = body.match(/^([A-G])([b#]?)(.*?)(?:\/([A-G])([b#]?))?$/);
  if (!m) return s;

  const root = m[1] + (m[2]||'');
  const qual = m[3]||'';
  const bass = m[4] ? (m[4] + (m[5]||'')) : '';

  const trRoot = transposeNote(root, semis, pref);
  const trBass = bass ? transposeNote(bass, semis, pref) : '';

  const transposed = trBass ? `${trRoot}${qual}/${trBass}` : `${trRoot}${qual}`;
  return `${prefix}${transposed}`;
}

function transposeWholeText(text, semis){
  const keyMatch = text.match(/^Key:\s*(.+)$/im);
  const key = keyMatch ? keyMatch[1].trim() : '';
  const pref = detectNotationPreferenceFromKeyOrText(key, text);

  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines){
    const m = line.match(/^Key:\s*(.+)$/i);
    if (m){
      const oldKey = m[1].trim();
      const trKey = transposeChordSimple(oldKey, semis, pref);
      out.push(`Key: ${trKey}`);
      continue;
    }

    // preserve marker lines and meta lines except chord payload
    if (/^(Title|Composer|Artist|Style|Tempo|Time)\s*:/i.test(line.trim())){
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed){
      out.push(line);
      continue;
    }

    // marker lines
    if (/^[-:=;#\+]/.test(trimmed)){
      out.push(line);
      continue;
    }

    // chord lines: transpose tokens
    const tokens = tokenizeBars(line);
    const t2 = tokens.map(tok => transposeChordToken(tok, semis, pref));
    out.push(t2.join(' '));
  }
  return out.join('\n');
}

/* =========================================================
   Q1 FIX: Repeat Expansion Logic (CRITICAL)
   Expands repeat groups fully to maintain 4-bar-per-row grid
========================================================= */
function parseBarStructures(tokens){
  // Returns flat array of bar objects after expanding repeats.
  // Also consumes UG-style barline tokens: '|' (single) and repeat/final variants.
  const out = [];
  let i = 0;

  let pendingLeft = null;

  const setBoundary = (type) => {
    const prev = out[out.length - 1];
    if (prev && type !== 'repeat-start'){
      prev.rightBar = type;
    }
    pendingLeft = type === 'repeat-end' || type === 'final' ? null : type;
  };

  const readTimes = (tok) => {
    const m = (tok || '').match(/x(\d+)$/i);
    return m ? parseInt(m[1],10) : null;
  };

  const skipBarlines = () => {
    while (i < tokens.length && isBarlineToken(tokens[i])){
      setBoundary(mapBarlineToken(tokens[i]));
      i++;
    }
  };

  while (i < tokens.length){
    let tok = tokens[i];

    if (isBarlineToken(tok)){
      setBoundary(mapBarlineToken(tok));
      i++;
      continue;
    }

    if (/^".*"$/.test(tok) && out.length){
      const prev = out[out.length - 1];
      prev.token = `${prev.token || ''} ${tok}`.trim();
      i++;
      continue;
    }

    // Endings token - associate with next bar (skipping delimiters)
    if (/^\d+\.$/.test(tok)){
      const endingLabel = tok;
      i++;
      skipBarlines();
      if (i < tokens.length){
        const nextTok = tokens[i];
        out.push({
          type:'bar',
          token: nextTok,
          endingLabel,
          leftBar: pendingLeft || 'single',
          rightBar: 'single',
        });
        pendingLeft = null;
        i++;
      }
      continue;
    }

    // Repeat group ( ... )xN
    if (tok.startsWith('(')){
      const groupTokens = [];
      let times = 2;
      let closed = false;

      tok = tok.slice(1);
      if (tok) groupTokens.push(tok);

      i++;
      while (i < tokens.length){
        const t = tokens[i];

        if (isBarlineToken(t)){ i++; continue; }

        if (t.endsWith(')') || /\)x\d+$/i.test(t)){
          const before = t.replace(/\)x\d+$/i,'').replace(/\)$/,'');
          const after = t.match(/\)x(\d+)$/i);
          if (before) groupTokens.push(before);
          if (after) times = parseInt(after[1],10);
          const tIn = readTimes(before) || readTimes(t) || null;
          if (tIn) times = tIn;
          closed = true;
          i++;
          break;
        } else {
          groupTokens.push(t);
          i++;
        }
      }

      if (!closed){
        validationWarnings.push(`⚠️ Unclosed repeat parenthesis - auto-closing`);
      }

      for (let rep=0; rep<times; rep++){
        for (const gt of groupTokens){
          out.push({
            type:'bar',
            token: gt,
            leftBar: pendingLeft || 'single',
            rightBar: 'single',
          });
          pendingLeft = null;
        }
      }
      continue;
    }

    out.push({
      type:'bar',
      token: tok,
      leftBar: pendingLeft || 'single',
      rightBar: 'single',
    });
    pendingLeft = null;
    i++;
  }

  return out;
}


/* =========================================================
   Rendering (ChordSheet-style only)
========================================================= */
function formatChordQuality(quality){
  if (!quality) return '';
  let q = quality;

  // Half-diminished: m7b5 or ø — respect settings
  if (/^m7b5$/i.test(q) || /^ø/i.test(q)){
    if (fbSettings.halfDimStyle === 'm7b5'){
      return 'm7b5';
    }
    return 'ø7';
  }

  // Diminished — respect settings
  if (/^dim/i.test(q)){
    if (fbSettings.dimStyle === 'dim'){
      // keep as-is (dim7, dim, etc.)
    } else {
      q = q.replace(/^dim/i, '°');
    }
  }

  // Augmented
  q = q.replace(/^aug/i, '+');

  // Major 7th / extended major chords - respect settings
  // Accepts: maj7, ma7, Δ7, M7, j7 (all with numeric extension)
  // Case-insensitive for maj/ma, case-sensitive for M/j to avoid conflicts with minor
  const maj7Re = /^(maj|ma|Δ)(\d.*)$/i;
  const maj7Re2 = /^(M|j)(\d.*)$/;
  const maj7Match = q.match(maj7Re) || q.match(maj7Re2);
  if (maj7Match){
    const suffix = maj7Match[2] || '';
    if (fbSettings.maj7Style === 'triangle'){
      return 'Δ' + suffix;
    } else if (fbSettings.maj7Style === 'maj'){
      return 'maj' + suffix;
    } else {
      return 'MA' + suffix;
    }
  }

  // Minor chord - respect settings
  // Accepts: m, mi, min, ami, amin at start (but not maj)
  // Also handles "-" as minor indicator
  if (q === '-' || q.startsWith('-')){
    const suffix = q.length > 1 ? q.slice(1) : '';
    if (fbSettings.minorStyle === 'min'){
      return 'min' + suffix;
    } else if (fbSettings.minorStyle === 'minus'){
      return '−' + suffix;
    } else {
      return 'm' + suffix;
    }
  }
  const minRe = /^(amin|ami|min|mi|m)(\d.*|$)/i;
  const minMatch = q.match(minRe);
  if (minMatch && !/^ma/i.test(q)){
    const suffix = minMatch[2] || '';
    if (fbSettings.minorStyle === 'min'){
      return 'min' + suffix;
    } else if (fbSettings.minorStyle === 'minus'){
      return '−' + suffix;
    } else {
      return 'm' + suffix;
    }
  }

  return q;
}

/* Performance: memoize chord parsing — same token returns cached result */
const _chordParseCache = new Map();
const CHORD_CACHE_MAX = 512;

function parseChordToken(token){
  let raw = token || '';
  const cacheKey = raw + '|' + fbSettings.maj7Style + '|' + fbSettings.minorStyle + '|' + fbSettings.dimStyle + '|' + fbSettings.halfDimStyle;
  if (_chordParseCache.has(cacheKey)) return _chordParseCache.get(cacheKey);

  // Lowercase root = minor: a → Am, bb → Bbm, etc.
  let impliedMinor = false;
  if (/^[a-g]/.test(raw)){
    raw = raw[0].toUpperCase() + raw.slice(1);
    // Only add minor if quality doesn't already start with m/min/dim/aug/etc.
    const rest = raw.slice(1).replace(/^[b#]/, '');
    if (!rest || /^\d/.test(rest) || rest === '-'){
      impliedMinor = true;
    }
  }

  const normalized = normalizeAccidentals(raw);
  // Support */G blank chord with bass
  const blankBassMatch = normalized.match(/^\*(?:\/([A-G])([b#]?))?$/);
  if (blankBassMatch){
    const bass = blankBassMatch[1] ? (blankBassMatch[1] + (blankBassMatch[2] || '')) : '';
    const displayBass = bass.replace(/b/g, '♭').replace(/#/g, '♯');
    const result = { root: '', quality: '', bass: displayBass, isBlank: true };
    _chordParseCache.set(cacheKey, result);
    return result;
  }

  const match = normalized.match(/^([A-G])([b#]?)(.*?)(?:\/([A-G])([b#]?))?$/);
  if (!match){ _chordParseCache.set(cacheKey, null); return null; }
  const root = match[1] + (match[2] || '');
  let quality = match[3] || '';
  // Lowercase root implied minor: prepend 'm' if no quality or numeric-only
  if (impliedMinor && !quality) quality = 'm';
  else if (impliedMinor && /^\d/.test(quality)) quality = 'm' + quality;
  const bass = match[4] ? (match[4] + (match[5] || '')) : '';
  const displayRoot = root.replace(/b/g, '♭').replace(/#/g, '♯');
  const displayBass = bass.replace(/b/g, '♭').replace(/#/g, '♯');
  const result = {
    root: displayRoot,
    quality: formatChordQuality(quality),
    bass: displayBass,
  };
  if (_chordParseCache.size > CHORD_CACHE_MAX) _chordParseCache.clear();
  _chordParseCache.set(cacheKey, result);
  return result;
}

function renderChordToken(token){
  const parsed = parseChordToken(token);
  if (!parsed) return `<span class="chord">${escapeHtml(token)}</span>`;
  // Blank chord with bass (*/G) — show slash only
  if (parsed.isBlank){
    const bass = parsed.bass ? `<span class="chord-bass">${escapeHtml(parsed.bass)}</span>` : '';
    return `<span class="chord">${bass}</span>`;
  }
  const quality = parsed.quality ? `<span class="chord-quality">${escapeHtml(parsed.quality)}</span>` : '';
  const bass = parsed.bass ? `<span class="chord-bass">${escapeHtml(parsed.bass)}</span>` : '';
  return `<span class="chord"><span class="chord-root">${escapeHtml(parsed.root)}</span>${quality}${bass}</span>`;
}

function renderBeatContent(rawBeat){
  const beat = (rawBeat || '').trim();
  if (!beat) return `<span class="beat"><span class="chord">&nbsp;</span></span>`;

  const annotationMatch = beat.match(/"([^"]+)"/);
  const annotation = annotationMatch ? annotationMatch[1] : '';
  const beatWithoutAnnotation = beat.replace(/"[^"]+"/g, '').trim();

  const renderSymbol = (symbol) => `<span class="musicSymbol">${symbol}</span>`;
  const symbolMap = {
    '$': '𝄋',
    'segno': '𝄋',
    'o': '𝄌',
    'O': '𝄌',
    'coda': '𝄌',
    'fermata': '𝄐',
  };

  let chordHtml = '';
  let normalizedBeat = beatWithoutAnnotation.trim();

  // --- Push notation: < or << before a chord ---
  let pushHtml = '';
  if (normalizedBeat.startsWith('<<')){
    pushHtml = '<span class="musicSymbol pushMark">&laquo;</span>';
    normalizedBeat = normalizedBeat.slice(2).trim();
  } else if (normalizedBeat.startsWith('<') && normalizedBeat.length > 1 && normalizedBeat[1] !== '>'){
    pushHtml = '<span class="musicSymbol pushMark">&lsaquo;</span>';
    normalizedBeat = normalizedBeat.slice(1).trim();
  }

  // --- Suffix detection: diamond(<>), fermata, stroke(,), tie(^) ---
  let suffixHtml = '';
  let chordPart = normalizedBeat;

  // Diamond: "Cm7<>" or "Cm7 diamond"
  if (chordPart.endsWith('<>')){
    chordPart = chordPart.slice(0, -2).trim();
    suffixHtml += '<span class="musicSymbol diamondMark">&#9671;</span>';
  } else if (/\s+diamond$/i.test(chordPart)){
    chordPart = chordPart.replace(/\s+diamond$/i, '').trim();
    suffixHtml += '<span class="musicSymbol diamondMark">&#9671;</span>';
  }

  // Fermata suffix: "E7 fermata"
  if (/\s+fermata$/i.test(chordPart)){
    chordPart = chordPart.replace(/\s+fermata$/i, '').trim();
    suffixHtml += '<span class="musicSymbol fermataMark">𝄐</span>';
  }

  // Tie: trailing ^
  if (chordPart.endsWith('^')){
    chordPart = chordPart.slice(0, -1).trim();
    suffixHtml += '<span class="musicSymbol tieMark">&#8978;</span>';
  }

  // Stroke: trailing commas (count them for multiple strokes)
  const strokeMatch = chordPart.match(/(,+)$/);
  if (strokeMatch){
    chordPart = chordPart.slice(0, -strokeMatch[1].length).trim();
    const strokeCount = strokeMatch[1].length;
    suffixHtml += '<span class="strokeMarks">' + '&#x2215;'.repeat(strokeCount) + '</span>';
  }

  normalizedBeat = chordPart;
  const prefixSymbol = normalizedBeat[0];
  const trailingChord = normalizedBeat.slice(1).trim();

  if (!normalizedBeat){
    chordHtml = `<span class="chord">&nbsp;</span>`;
  // --- Rests: r1 (whole), r2 (half), r4 (quarter) ---
  } else if (/^r[124]$/i.test(normalizedBeat)){
    const restMap = { 'r1': '𝄻', 'r2': '𝄼', 'r4': '𝄽' };
    const restSym = restMap[normalizedBeat.toLowerCase()] || '𝄽';
    chordHtml = `<span class="musicSymbol restSymbol">${restSym}</span>`;
  } else if (normalizedBeat === '%'){
    chordHtml = `<span class="musicSymbol repeatSymbol">𝄎</span>`;
  } else if (normalizedBeat === '%%'){
    chordHtml = `<span class="musicSymbol repeatSymbol">𝄏</span>`;
  } else if (/^%\d+$/.test(normalizedBeat)){
    chordHtml = `<span class="musicSymbol repeatSymbol">𝄎<sup>${normalizedBeat.slice(1)}</sup></span>`;
  } else if (symbolMap[normalizedBeat]){
    chordHtml = renderSymbol(symbolMap[normalizedBeat]);
  } else if (symbolMap[prefixSymbol] && trailingChord){
    chordHtml = `${renderSymbol(symbolMap[prefixSymbol])}${renderChordToken(trailingChord)}`;
  } else if (normalizedBeat.toUpperCase() === 'N.C.' || normalizedBeat.toUpperCase() === 'NC'){
    chordHtml = `<span class="chord">${escapeHtml(normalizedBeat)}</span>`;
  } else if (normalizedBeat.toLowerCase() === 'fine'){
    chordHtml = `<span class="musicSymbol"><em>Fine</em></span>`;
  // --- D.C. and D.S. variants ---
  } else if (/^d\.?c\.?(?=\.|al\b|\s|$)/i.test(normalizedBeat) || /^dacapo/i.test(normalizedBeat)){
    chordHtml = `<span class="musicSymbol"><em>${escapeHtml(normalizedBeat)}</em></span>`;
  } else if (/^d\.?s\.?(?=\.|al\b|\s|$)/i.test(normalizedBeat) || /^dalsegno/i.test(normalizedBeat)){
    chordHtml = `<span class="musicSymbol"><em>${escapeHtml(normalizedBeat)}</em></span>`;
  } else {
    chordHtml = renderChordToken(normalizedBeat);
  }

  const annotationHtml = annotation ? `<span class="beatAnnotation">${escapeHtml(annotation)}</span>` : '';
  return `<span class="beat">${annotationHtml}${pushHtml}${chordHtml}${suffixHtml}</span>`;
}

function renderBarline(type){
  const t = type || 'single';
  const hidden = fbSettings.barLines === 'hidden' && t === 'single';
  const cls = hidden ? 'barline hidden' : `barline ${t}`;
  if (t === 'repeat-start' || t === 'repeat-end'){
    return `<div class="${cls}"><span class="dot-top"></span><span class="dot-bot"></span></div>`;
  }
  return `<div class="${cls}"></div>`;
}

function renderEndingSegments(segments){
  return segments.map((segment) => {
    const startCol = 2 + segment.start * 2;
    const endCol = 2 + segment.end * 2 + 1;
    return `
      <div class="endingBracket" style="grid-column:${startCol} / ${endCol};">
        <span class="endingLabel">${escapeHtml(segment.label)}.</span>
      </div>`;
  }).join('');
}

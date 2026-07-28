/* csmpnParser.js — CSMPN text parser for the legacy index.html renderer
   Extracted from index.html (Sprint 4, item 2.1C).
   Loaded as a plain script after chordProcessing.js.
   Depends on: tokenizeBars (chordProcessing.js)
*/

/**
 * Parse a {tab} block body into a voicing map.
 * Each entry: "ChordName: fret1,fret2,fret3,fret4,fret5,fret6"
 * Strings ordered high-e (1) → low-E (6). Fret values: integer, 'x' (muted), '-' (skip).
 * @param {string} text
 * @returns {Object.<string, Array>}
 */
function parseTabVoicings(text){
  const voicings = {};
  for (const entry of text.split(/[\n;]+/)){
    const m = entry.trim().match(/^([A-G][^:]*?)\s*:\s*(.+)$/);
    if (!m) continue;
    const chord = m[1].trim();
    const frets = m[2].split(',').map(f => {
      f = f.trim();
      if (f === 'x' || f === 'X') return 'x';
      if (f === '-' || f === '') return '-';
      const n = parseInt(f, 10);
      return isNaN(n) ? '-' : n;
    });
    if (frets.length >= 4) voicings[chord] = frets;
  }
  return voicings;
}

/**
 * Parse a Roman numeral string (I, II, III, IV…) to an integer.
 * Returns 0 for unrecognised input.
 * @param {string} str
 * @returns {number}
 */
function _parseRoman(str){
  const MAP = {I:1,V:5,X:10,L:50,C:100,D:500,M:1000};
  let result = 0, prev = 0;
  for (const ch of (str || '').toUpperCase().split('').reverse()){
    const v = MAP[ch] || 0;
    result += v >= prev ? v : -v;
    prev = v;
  }
  return result || 0;
}

/**
 * Parse chordsheet.com three-column section text.
 * Forms:
 *   "lc <text>" / "cc <text>" / "rc <text>"  → place text in left/center/right column
 *   "<a>  <b>  <c>" (two-or-more spaces)      → split into left / center / right
 * Returns ['left','center','right'] or null for a plain single-label section name.
 * @param {string} text
 * @returns {?string[]}
 */
function parseColumnText(text){
  const t = (text || '').trim();
  if (!t) return null;
  const kw = t.match(/^(lc|cc|rc)\b\s*(.*)$/i);
  if (kw){
    const code = kw[1].toLowerCase();
    const body = kw[2].trim();
    const cols = ['', '', ''];
    cols[code === 'lc' ? 0 : code === 'cc' ? 1 : 2] = body;
    return cols;
  }
  if (/\s{2,}/.test(t)){
    const parts = t.split(/\s{2,}/).map(s => s.trim());
    return [parts[0] || '', parts[1] || '', parts[2] || ''];
  }
  return null;
}

/**
 * Parse a chordsheet.com chord-diagram definition body: "C7 x32310" or
 * "C7 x32310032410" (frets + fingering). Strings are ordered low-E → high-e.
 * @param {string} str
 * @returns {?{name:string, frets:Array, fingers:?number[]}}
 */
function parseDiagramDefinition(str){
  const m = (str || '').trim().match(/^(\S+)\s+([0-9xX]+)$/);
  if (!m) return null;
  const name = m[1];
  const seq = m[2];
  const fretsStr = seq.slice(0, 6);
  if (fretsStr.length < 6) return null;
  const frets = fretsStr.split('').map(c => (c === 'x' || c === 'X') ? 'x' : parseInt(c, 10));
  let fingers = null;
  if (seq.length >= 12){
    fingers = seq.slice(6, 12).split('').map(c => parseInt(c, 10) || 0);
  }
  return { name, frets, fingers };
}

/**
 * Parse a CSMPN source text into a document object.
 *
 * Returns:
 *   { title, composer, style, tempo, time, key, capo, tuning, blocks[] }
 *
 * Block types:
 *   { type:'pagebreak' }
 *   { type:'notation', content: String }
 *   { type:'tab',      voicings: Object }
 *   { type:'marker',  marker: Char, text: String }
 *   { type:'bars',    tokens: Array, indent: Number }
 */
function parseCSMPN(text){
  const raw = (text || '').replace(/\r/g,'');
  const lines = raw.split('\n');

  const doc = {
    title: '',
    composer: '',
    style: '',
    tempo: '',
    time: '',
    key: '',
    capo: 0,
    tuning: '',
    blocks: []
  };

  // `Tuning` is emitted by the Tab Translator recognition engine alongside `Capo`
  // (both describe how the instrument is set up, not the harmony). Without it here
  // a "Tuning: Standard" line falls through to the content pass and is parsed as a
  // BAR — every handed-off chart grew a spurious leading measure.
  const metaRE = /^(Title|Composer|Artist|Style|Tempo|Time|Key|Capo|Tuning)\s*:\s*(.*)$/i;

  // First pass: meta extraction
  const contentLines = [];
  for (const line of lines){
    const m = line.match(metaRE);
    if (m){
      const field = m[1].toLowerCase();
      const val = m[2].trim();
      if (field === 'title') doc.title = val;
      else if (field === 'composer' || field === 'artist') doc.composer = val;
      else if (field === 'style') doc.style = val;
      else if (field === 'tempo') doc.tempo = val;
      else if (field === 'time') doc.time = val;
      else if (field === 'key') doc.key = val;
      else if (field === 'capo'){
        // Accept integer ("2") or roman numeral ("II")
        const n = parseInt(val, 10);
        doc.capo = !isNaN(n) ? n : _parseRoman(val);
      }
      else if (field === 'tuning') doc.tuning = val;
      continue;
    }
    contentLines.push(line);
  }

  let tabBlockLines = null; // non-null while collecting a multi-line {tab} block
  let hybridSkipActive = false; // true while skipping a multi-line {hybrid} block

  for (const line0 of contentLines){
    const line = line0.trim();

    // Skip {hybrid} block content — parseHybridChartFromCSMPN reads raw text directly
    if (hybridSkipActive){
      if (line === '}') hybridSkipActive = false;
      continue;
    }

    // Collecting a multi-line {tab} block — consume until closing }
    if (tabBlockLines !== null){
      if (line === '}' || line.endsWith('}')){
        if (line !== '}') tabBlockLines.push(line.slice(0, -1).trim());
        const voicings = parseTabVoicings(tabBlockLines.join('\n'));
        if (Object.keys(voicings).length > 0) doc.blocks.push({type:'tab', voicings});
        tabBlockLines = null;
      } else {
        tabBlockLines.push(line);
      }
      continue;
    }

    if (!line) continue;

    // Detect {hybrid} block open — skip single-line too (inline hybrid is unsupported)
    if (line.startsWith('{hybrid')){
      if (!line.endsWith('}')) hybridSkipActive = true;
      continue;
    }

    // page break
    if (line.startsWith('+')){
      doc.blocks.push({type:'pagebreak'});
      continue;
    }

    // VexFlow notation block: {vt notes...}
    if (line.startsWith('{vt')){
      const vtMatch = line.match(/^\{vt\s*(.*?)\}$/);
      if (vtMatch !== null){
        doc.blocks.push({type:'notation', content: vtMatch[1].trim()});
        continue;
      }
    }

    // Guitar TAB voicing block: {tab ChordName: frets ... }
    if (line.startsWith('{tab')){
      if (line.endsWith('}')){
        // Single-line: {tab G:3,2,0,0,0,3 C:x,3,2,0,1,0}
        const inner = line.slice(4, -1).trim().replace(/\s+(?=[A-G])/g, '\n');
        const voicings = parseTabVoicings(inner);
        if (Object.keys(voicings).length > 0) doc.blocks.push({type:'tab', voicings});
      } else {
        // Multi-line block — collect until }
        tabBlockLines = [];
        const afterOpen = line.slice(4).trim();
        if (afterOpen) tabBlockLines.push(afterOpen);
      }
      continue;
    }

    // Chord-diagram definition line: "// C7 x32310" (+ optional fingering digits)
    if (line.startsWith('//')){
      const def = parseDiagramDefinition(line.slice(2).trim());
      if (def){
        if (!doc.diagrams) doc.diagrams = {};
        doc.diagrams[def.name] = { frets: def.frets, fingers: def.fingers };
      }
      continue;
    }

    // Double "==" section marker (chordsheet.com uses it for endings/strong
    // delimiters, e.g. "== 1st Ending"). Treat as a boxed "=" section.
    if (line.startsWith('==')){
      const rest = line.slice(2).trim();
      const block = { type:'marker', marker:'=', text: rest };
      const cols = parseColumnText(rest);
      if (cols) block.columns = cols;
      doc.blocks.push(block);
      continue;
    }

    // marker lines
    const lead = line[0];
    if (lead === '-' || lead === ':' || lead === '=' || lead === ';' || lead === '#'){
      const rest = line.slice(1).trim();
      const block = { type:'marker', marker: lead, text: rest };
      // chordsheet.com three-column text: "- lc …", "- cc …", "- rc …",
      // or two-or-more spaces to split into left / center / right columns.
      if (lead === '-' || lead === ':' || lead === '='){
        const cols = parseColumnText(rest);
        if (cols) block.columns = cols;
      }
      doc.blocks.push(block);
      continue;
    }

    // chord line — a leading "." turns on chord diagrams for every chord on the line
    let diagramsThroughout = false;
    let workLine = line;
    if (/^\.(?:\s|$)/.test(line)){
      diagramsThroughout = true;
      workLine = line.replace(/^\.\s*/, '');
    }

    // chord line — detect leading X for bar indentation
    let indentLevel = 0;
    let chordLine = workLine;
    const indentMatch = workLine.match(/^(X+)\s*(.*)/);
    if (indentMatch){
      indentLevel = indentMatch[1].length;
      chordLine = indentMatch[2];
    }
    const tokens = tokenizeBars(chordLine);
    if (tokens.length){
      const block = { type:'bars', tokens, indent: indentLevel };
      if (diagramsThroughout) block.diagrams = true;
      doc.blocks.push(block);
    }
  }

  return doc;
}

// ── parseCSMPN memoization ────────────────────────────────────────────────
// A single user action (transpose / keystroke) parses the SAME source text
// 2–3×: updatePreview → parseCSMPN, the slash-notation panel → parseCSMPN, and
// the MusicXML exporter → parseCSMPN. Wrap the parser in a small FIFO cache so
// repeated calls on identical text are O(1) instead of re-walking every line
// and token. The parsed `doc` is consumed read-only by all callers (renderers
// read doc.blocks/title/key/...; nothing mutates the returned tree), so caching
// by reference is safe.
(function installParseCsmpnMemo() {
  if (typeof parseCSMPN !== 'function' || parseCSMPN.__memoized) return;
  const _raw = parseCSMPN;
  const _cache = new Map(); // text -> doc
  const MAX = 4; // covers transpose + preview + slash panel + export in one tick
  function parseCSMPNMemoized(text) {
    const key = text || '';
    if (_cache.has(key)) return _cache.get(key);
    const doc = _raw(key);
    if (_cache.size >= MAX) {
      // FIFO eviction (Map preserves insertion order) — avoids a full flush.
      _cache.delete(_cache.keys().next().value);
    }
    _cache.set(key, doc);
    return doc;
  }
  parseCSMPNMemoized.__memoized = true;
  // Reassign the global binding callers already use; no call sites change.
  parseCSMPN = parseCSMPNMemoized;
})();

/**
 * Expand |: ... :| repeat barlines in CSMPN text.
 *
 * Each |: content :| group is played twice by default.
 * An optional xN suffix sets the repeat count: |: C Am :| x3 → three plays.
 * Inner | bar separators within the repeat are preserved in the expanded output.
 * Metadata, section markers, and non-bar lines pass through unchanged.
 *
 * D.C. / D.S. / Coda section-level navigation is not expanded by this function.
 *
 * @param {string} text - CSMPN source text
 * @param {{ barRepeats?: boolean }} [opts]
 * @returns {string}
 */
function expandCSMPNRepeats(text, opts) {
  if ((opts && opts.barRepeats === false) || !text) return text || '';

  return text
    .split('\n')
    .map(_expandBarRepeatLine)
    .join('\n');
}

/**
 * Expand any |: ... :| xN pattern within a single chord-row line.
 * Lines without repeat markers are returned unchanged.
 * @param {string} line
 * @returns {string}
 */
function _expandBarRepeatLine(line) {
  if (!line.includes('|:') && !line.includes(':|')) return line;

  // Match |: content :| optionally followed by xN.
  // Content may contain inner | bar-separator tokens but not |: or :| pairs.
  return line.replace(
    /\|:\s*((?:[^|]|\|(?!:))*?)\s*:\|(?:\s+x(\d+))?/gi,
    function (_match, content, times) {
      const n = times ? Math.max(1, Math.min(16, parseInt(times, 10))) : 2;
      const trimmed = content.trim();
      const parts = [];
      for (let i = 0; i < n; i++) parts.push(trimmed);
      return parts.join(' ');
    }
  );
}

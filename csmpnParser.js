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
 * Parse a CSMPN source text into a document object.
 *
 * Returns:
 *   { title, composer, style, tempo, time, key, blocks[] }
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
    blocks: []
  };

  const metaRE = /^(Title|Composer|Artist|Style|Tempo|Time|Key)\s*:\s*(.*)$/i;

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
      continue;
    }
    contentLines.push(line);
  }

  let tabBlockLines = null; // non-null while collecting a multi-line {tab} block

  for (const line0 of contentLines){
    const line = line0.trim();

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

    // marker lines
    const lead = line[0];
    if (lead === '-' || lead === ':' || lead === '=' || lead === ';' || lead === '#'){
      doc.blocks.push({type:'marker', marker: lead, text: line.slice(1).trim()});
      continue;
    }

    // chord line — detect leading X for bar indentation
    let indentLevel = 0;
    let chordLine = line0;
    const indentMatch = line.match(/^(X+)\s*(.*)/);
    if (indentMatch){
      indentLevel = indentMatch[1].length;
      chordLine = indentMatch[2];
    }
    const tokens = tokenizeBars(chordLine);
    if (tokens.length){
      doc.blocks.push({type:'bars', tokens, indent: indentLevel});
    }
  }

  return doc;
}

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

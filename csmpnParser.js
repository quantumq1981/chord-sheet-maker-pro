/* csmpnParser.js — CSMPN text parser for the legacy index.html renderer
   Extracted from index.html (Sprint 4, item 2.1C).
   Loaded as a plain script after chordProcessing.js.
   Depends on: tokenizeBars (chordProcessing.js)
*/

/**
 * Parse a CSMPN source text into a document object.
 *
 * Returns:
 *   { title, composer, style, tempo, time, key, blocks[] }
 *
 * Block types:
 *   { type:'pagebreak' }
 *   { type:'notation', content: String }
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

  for (const line0 of contentLines){
    const line = line0.trim();
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

/* importPipeline.js — Format-specific import functions and shared text pipeline
   Extracted from index.html (Sprint 5.3, item 2.1E).
   Loaded after settings.js and csmpnParser.js. All symbols are global.
   Depends on: escapeHtml/normalizeAccidentals (utils.js),
               parseCSMPN/isBarlineToken/normalizeBarlineDelimiters (csmpnParser.js + chordProcessing.js),
               fbSettings (settings.js), hdr/sourceEl (main inline script, refs at call time)
*/

class SongModel {
  constructor(){
    this.meta = {
      title: '',
      composer: '',
      style: '',
      key: '',
      tempo: '',
      time: ''
    };
    this.sections = [];
  }

  toCSMPN(options = {}){
    const barsPerRowRaw = Number(options?.barsPerRow ?? fbSettings?.barsPerRow ?? 4);
    const barsPerRow = Number.isFinite(barsPerRowRaw) && barsPerRowRaw > 0 ? Math.floor(barsPerRowRaw) : 4;
    const out = [];

    if (this.meta.title) out.push(`Title: ${this.meta.title}`);
    if (this.meta.composer) out.push(`Composer: ${this.meta.composer}`);
    if (this.meta.style) out.push(`Style: ${this.meta.style}`);
    if (this.meta.key) out.push(`Key: ${this.meta.key}`);
    if (this.meta.tempo) out.push(`Tempo: ${this.meta.tempo}`);
    if (this.meta.time) out.push(`Time: ${this.meta.time}`);

    if (out.length && this.sections.length) out.push('');

    for (const section of this.sections){
      const label = (section?.label || '').trim();
      if (label){
        const lead = label[0];
        out.push(lead === '-' || lead === ':' || lead === '=' ? label : `- ${label}`);
      }

      const bars = Array.isArray(section?.bars)
        ? section.bars.map((bar) => (bar ?? '').toString().trim()).filter(Boolean)
        : [];

      for (let i = 0; i < bars.length; i += barsPerRow){
        out.push(bars.slice(i, i + barsPerRow).join(' '));
      }
      // Output collected lyrics as annotations
      const lyrics = Array.isArray(section?.lyrics) ? section.lyrics.filter(Boolean) : [];
      for (const lyric of lyrics){
        out.push(`; ${lyric}`);
      }
      if (bars.length) out.push('');
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

function mapMusicXMLFifthsToKey(fifthsValue, mode){
  const fifths = Number(fifthsValue);
  if (!Number.isFinite(fifths)) return '';
  const majorMap = {
    '-7':'Cb','-6':'Gb','-5':'Db','-4':'Ab','-3':'Eb','-2':'Bb','-1':'F',
    '0':'C','1':'G','2':'D','3':'A','4':'E','5':'B','6':'F#','7':'C#'
  };
  const minorMap = {
    '-7':'Abm','-6':'Ebm','-5':'Bbm','-4':'Fm','-3':'Cm','-2':'Gm','-1':'Dm',
    '0':'Am','1':'Em','2':'Bm','3':'F#m','4':'C#m','5':'G#m','6':'D#m','7':'A#m'
  };
  const isMinor = (mode || '').trim().toLowerCase() === 'minor';
  return isMinor ? (minorMap[String(fifths)] || '') : (majorMap[String(fifths)] || '');
}

/* =========================================================
   Phase-1 fixes: Header <-> Source bidirectional sync
========================================================= */
function extractHeaderFromText(text, writeToInputs=true){
  // Extracts header metadata from CSMPN-like source and (optionally) syncs the form fields.
  // Defensive: avoids poisoning header fields with chord lines / section labels.
  const norm = (s) => (s ?? "").toString()
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const looksChordy = (s) => {
    const t = norm(s);
    if (!t) return false;
    if (/[|ǁ]/.test(t) || /%/.test(t)) return true;
    const toks = t.split(" ").filter(Boolean);
    let chordCount = 0;
    for (const tok of toks){
      if (isChordToken(tok)) chordCount++;
    }
    // If it contains multiple chord tokens, it's likely not a human header value.
    return chordCount >= 2;
  };

  const normalizeField = (field, raw) => {
    let v = norm(raw);
    if (!v) return "";
    // Strip stray trailing punctuation
    v = v.replace(/^[\-\u2013\u2014]+/, "").trim();

    if (field === "key"){
      // Accept common key spellings: Bb, F#, C#m, Abm, etc.
      v = v.replace(/\s+/g, "");
      v = v.replace(/minor$/i, "m").replace(/min$/i, "m");
      // Reject obviously bad values
      if (!/^[A-G](?:#|b)?(?:m)?$/i.test(v)) return "";
      return v;
    }
    if (field === "time"){
      v = v.replace(/\s+/g, "");
      if (!/^\d{1,2}\/\d{1,2}$/.test(v)) return "";
      return v;
    }
    if (field === "tempo"){
      const m = v.match(/(\d{1,3})/);
      if (!m) return "";
      const n = parseInt(m[1], 10);
      if (!(n >= 20 && n <= 320)) return "";
      return String(n);
    }

    // title/composer/style: reject chord-like garbage or label-only values
    if (/^(title|composer|artist|style|tempo|time|key)\s*:?$/i.test(v)) return "";
    if (looksChordy(v)) return "";
    // Cap ridiculous lengths (often PDF garbage)
    if (v.length > 120) v = v.slice(0, 120).trim();
    return v;
  };

  const getLineValue = (labelRe) => {
    const m = text.match(labelRe);
    return m ? m[1] : "";
  };

  const hdr = {
    title: normalizeField("title", getLineValue(/^\s*Title:\s*(.*)$/im)),
    composer: normalizeField("composer", getLineValue(/^\s*(?:Composer|Artist):\s*(.*)$/im)),
    style: normalizeField("style", getLineValue(/^\s*Style:\s*(.*)$/im)),
    tempo: normalizeField("tempo", getLineValue(/^\s*Tempo:\s*(.*)$/im)),
    time: normalizeField("time", getLineValue(/^\s*Time:\s*(.*)$/im)),
    key: normalizeField("key", getLineValue(/^\s*Key:\s*(.*)$/im)),
  };

  // If no explicit Title: and first non-empty line looks like a title, adopt it.
  if (!hdr.title){
    const first = (text.split(/\r?\n/).map(l => l.trim()).find(l => l) || "");
    // Avoid promoting section/marker lines (e.g., "- Intro", "= Verse") to Title.
    const looksLikeMarker = (s) => /^[-=:#;\[]\s*/.test((s||"").trim());
    if (first && !looksLikeMarker(first) && !first.includes(":") && !looksChordy(first) && first.length <= 80){
      hdr.title = normalizeField("title", first);
    }
  }

  if (writeToInputs){
    // Reference the outer-scope `hdr` DOM element map (defined at top of script).
    // The local `hdr` here holds extracted string values; the outer one holds <input> elements.
    const elMap = {
      title: document.getElementById('hdrTitle'),
      composer: document.getElementById('hdrComposer'),
      style: document.getElementById('hdrStyle'),
      tempo: document.getElementById('hdrTempo'),
      time: document.getElementById('hdrTime'),
      key: document.getElementById('hdrKey'),
    };
    for (const k of Object.keys(elMap)){
      const v = hdr[k] || "";
      if (elMap[k] && elMap[k].value !== v) elMap[k].value = v;
    }
  }
  return hdr;
}

function detectChordPro(text){
  // Classic ChordPro: detect presence of directives, meta data or environment markers.
  // Expanded to include common directives and meta-data names such as subtitle, sorttitle, lyricist,
  // arranger, copyright, album, year, duration, capo, meta and comment variants.
  const proRe = /\{\s*(title|subtitle|sorttitle|artist|composer|lyricist|arranger|copyright|album|year|key|time|tempo|duration|capo|meta|comment|comment_italic|comment_box|highlight|start_of_|end_of_)\s*:?/i;
  if (proRe.test(text)) return true;
  return false;
}

function detectChordMark(text){
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const hasPipeBars = lines.some((line) => /^\|.*\|$/.test(line) || /^\|:/.test(line) || /:\|$/.test(line));
  const hasSectionHeadings = lines.some((line) => /^#{1,6}\s+/.test(line) || /^\[[^\]]+\]$/.test(line));
  const hasMetadata = lines.some((line) => /^(title|artist|composer|key|tempo|time|meter|style)\s*:/i.test(line));
  return (hasPipeBars && (hasSectionHeadings || hasMetadata));
}

function normalizeCSMPNSectionLabel(label){
  const s = String(label || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (/^verse\b/.test(lower)) return 'Verse';
  if (/^pre[-\s]?chorus\b/.test(lower)) return 'Pre-Chorus';
  if (/^chorus\b|^refrain\b|^hook\b/.test(lower)) return 'Chorus';
  if (/^bridge\b/.test(lower)) return 'Bridge';
  if (/^intro\b/.test(lower)) return 'Intro';
  if (/^outro\b|^ending\b|^tag\b|^coda\b/.test(lower)) return 'Outro';
  return s.replace(/\s+/g, ' ').trim();
}

function importChordMarkToCSMPN(text){
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  let hadBars = false;
  const meta = { title:'', composer:'', key:'', time:'', tempo:'' };

  for (const rawLine of lines){
    const line = normalizeAccidentals(rawLine || '').trim();
    if (!line) continue;

    const m = line.match(/^(title|song|artist|composer|key|tempo|bpm|time|meter)\s*:\s*(.+)$/i);
    if (m){
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === 'title' || k === 'song') meta.title = meta.title || v;
      else if (k === 'artist' || k === 'composer') meta.composer = meta.composer || v;
      else if (k === 'key') meta.key = meta.key || v;
      else if (k === 'time' || k === 'meter') meta.time = meta.time || v;
      else if (k === 'tempo' || k === 'bpm') meta.tempo = meta.tempo || v.replace(/\s*bpm\s*$/i, '').trim();
      continue;
    }

    const headingHash = line.match(/^#{1,6}\s+(.+)$/);
    if (headingHash){
      out.push(`: ${normalizeCSMPNSectionLabel(headingHash[1])}`);
      continue;
    }
    const headingBracket = line.match(/^\[([^\]]+)\]$/);
    if (headingBracket){
      out.push(`: ${normalizeCSMPNSectionLabel(headingBracket[1])}`);
      continue;
    }

    if (line.includes('|')){
      const chunks = line
        .replace(/^\|+/, '')
        .replace(/\|+$/, '')
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);

      const tokens = [];
      for (const chunk of chunks){
        if (chunk === ':' || chunk === '|:' || chunk === ':|') continue;
        const inner = chunk.split(/\s+/).map((t) => normalizeChordToken(t)).filter(Boolean);
        if (!inner.length) continue;
        tokens.push(inner.join('_'));
      }
      if (tokens.length){
        out.push(tokens.join(' '));
        hadBars = true;
      }
      continue;
    }

    const toks = line.split(/\s+/).map((t) => normalizeChordToken(t)).filter(Boolean);
    if (toks.length >= 2){
      out.push(toCSMPNBars(toks).trim());
      hadBars = true;
    }
  }

  if (!hadBars) return importUGText(text);

  const metaLines = [];
  if (meta.title) metaLines.push(`Title: ${meta.title}`);
  if (meta.composer) metaLines.push(`Composer: ${meta.composer}`);
  if (meta.key) metaLines.push(`Key: ${meta.key}`);
  if (meta.time) metaLines.push(`Time: ${meta.time}`);
  if (meta.tempo) metaLines.push(`Tempo: ${meta.tempo}`);

  return [...metaLines, metaLines.length ? '' : null, ...out]
    .filter(v => v !== null && String(v).trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countSongModelBars(song){
  if (!(song instanceof SongModel) || !Array.isArray(song.sections)) return 0;
  return song.sections.reduce((sum, sec) => {
    const bars = Array.isArray(sec?.bars) ? sec.bars.filter(Boolean).length : 0;
    return sum + bars;
  }, 0);
}

function preprocessImportedInput(raw, sourceInfo = {}){
  const normalizedText = normalizeUGProText(raw || '');
  const allLines = normalizedText.split('\n').map((line) => (line || '').trim());
  const lines = allLines.filter((line) => line.length > 0);
  const pageChunks = Array.isArray(sourceInfo.pageChunks) ? sourceInfo.pageChunks : [];
  return {
    raw: raw || '',
    text: normalizedText,
    lines,
    allLines,
    sourceInfo,
    pageChunks
  };
}

function preprocessImportedSongText(text){
  return preprocessImportedInput(text, {});
}

function detectSourceFlavor(preprocessed){
  const prep = preprocessed || {};
  const text = prep.text || '';
  const lines = Array.isArray(prep.lines) ? prep.lines : [];
  const sourceInfo = prep.sourceInfo || {};
  if (!lines.length) return { flavor: 'unknown-text', confidence: 'low' };
  const ext = String(sourceInfo.ext || '').toLowerCase();
  const mime = String(sourceInfo.mime || '').toLowerCase();

  if (ext === '.musicxml' || ext === '.mxl' || /musicxml/.test(mime)) return { flavor: 'musicxml', confidence: 'high' };
  if (isOpenSongXML(text)) return { flavor: 'opensong-xml', confidence: 'high' };
  if (isOpenLyricsXML(text)) return { flavor: 'openlyrics-xml', confidence: 'high' };
  if (ext === '.onsong') return { flavor: 'onsong', confidence: 'high' };
  if (ext === '.irealb' || isIRealProURL(text)) return { flavor: 'ireal-pro', confidence: 'high' };
  if (detectChordMark(text)) return { flavor: 'chordmark', confidence: 'high' };

  const hasChordProDirectives = detectChordPro(text);
  const directiveLines = lines.filter((line) => /\{\s*[^}]+\s*\}/.test(line)).length;
  const brokenDirectiveLines = lines.filter((line) => /\{[^}]*$/.test(line) || /^[^{}]*\}/.test(line)).length;
  const bracketInlineLines = lines.filter((line) => hasInlineBracketChords(line)).length;
  const chordLines = lines.filter((line) => isLikelyUGChordLine(line)).length;
  const lyricLines = lines.filter((line) => isLikelyLyricsLine(line)).length;
  const barlineLines = lines.filter((line) => /\|/.test(line) || /:\|/.test(line) || /\|:/.test(line) || /\b%%?\b/.test(line)).length;
  const chordDumpishLines = lines.filter((line) => {
    const toks = tokenizeBars(line).filter((tok) => !isBarlineToken(tok));
    if (toks.length < 4) return false;
    const chordLike = toks.reduce((n, tok) => n + (normalizeChordToken(tok) ? 1 : 0), 0);
    return chordLike / Math.max(1, toks.length) >= 0.85;
  }).length;

  if (hasChordProDirectives && brokenDirectiveLines === 0) return { flavor: 'chordpro-clean', confidence: 'high' };
  if (hasChordProDirectives || (directiveLines >= 1 && (brokenDirectiveLines >= 1 || bracketInlineLines >= 1))) return { flavor: 'chordpro-dirty', confidence: 'medium' };
  if (barlineLines >= Math.max(2, Math.floor(lines.length * 0.3))) return { flavor: 'barline-grid', confidence: 'high' };
  if (isLikelyUGProText(text) && chordLines >= 2 && lyricLines >= 1) return { flavor: 'ug-text', confidence: 'high' };
  if (chordLines >= 1 && lyricLines >= 1) return { flavor: 'chord-over-lyrics', confidence: 'medium' };
  if (chordDumpishLines >= Math.max(1, Math.floor(lines.length * 0.4))) return { flavor: 'chord-dump', confidence: 'medium' };
  if (bracketInlineLines >= 1) return { flavor: 'chordpro-dirty', confidence: 'medium' };
  return { flavor: 'unknown-text', confidence: 'low' };
}

function detectTextSourceFlavor(text){
  return detectSourceFlavor(preprocessImportedInput(text, {})).flavor;
}

function classifyLinesOrEvents(preprocessed, detectedFlavor){
  const lines = Array.isArray(preprocessed?.lines) ? preprocessed.lines : [];
  const out = [];
  const safeLines = Array.isArray(lines) ? lines : [];
  const flavor = detectedFlavor || 'unknown-text';
  for (let i = 0; i < safeLines.length; i++){
    const raw = safeLines[i] || '';
    const line = raw.trim();
    if (!line) continue;
    const entry = {
      index: i,
      raw,
      line,
      type: 'unknown',
      sectionName: '',
      metaMatched: false,
      chords: [],
      lyricsText: '',
      repeatCount: 1,
      tokens: []
    };

    const sectionName = parseUGSectionHeader(line);
    if (sectionName){
      entry.type = 'section';
      entry.sectionName = sectionName;
      out.push(entry);
      continue;
    }
    const genericBracketSection = line.match(/^\[(.+?)\]$/);
    if (genericBracketSection && isLikelyStructuralBracketLabel(genericBracketSection[1])){
      entry.type = 'section-generic';
      entry.sectionName = normalizeUGSectionLabel(genericBracketSection[1]);
      out.push(entry);
      continue;
    }

    if (/^\s*(title|song|artist|composer|key|tempo|bpm|time|time\s*signature)\s*:/i.test(line)){
      entry.type = 'meta';
      entry.metaMatched = true;
      out.push(entry);
      continue;
    }

    if (hasInlineBracketChords(line)){
      const chords = extractBracketChords(line).map((c) => normalizeChordToken(c)).filter(Boolean);
      entry.type = 'inline-bracket';
      entry.chords = chords;
      entry.lyricsText = extractBracketLyrics(line);
      out.push(entry);
      continue;
    }

    const tokens = tokenizeBars(line).filter(Boolean);
    entry.tokens = tokens;
    if (isLikelyUGChordLine(line) || (flavor === 'chord-dump' && tokens.length >= 2)){
      entry.type = 'chord-line';
      const repeatMatch = line.match(/\bx\s*(\d+)\s*$/i);
      entry.repeatCount = repeatMatch ? parseInt(repeatMatch[1], 10) : 1;
      out.push(entry);
      continue;
    }

    if (isLikelyLyricsLine(line)){
      entry.type = 'lyrics-line';
      out.push(entry);
      continue;
    }

    out.push(entry);
  }
  return out;
}

function classifyTextLines(lines){
  return classifyLinesOrEvents({ lines: Array.isArray(lines) ? lines : [] }, 'unknown-text');
}

function buildCanonicalSongModel(classified, detectedFlavor){
  const song = new SongModel();
  song.meta.importFlavor = detectedFlavor || 'unknown-text';
  let currentSection = { label: '- Main', bars: [], lyrics: [] };
  song.sections.push(currentSection);

  const ensureSection = (name) => {
    const clean = (name || '').trim();
    if (!clean) return;
    currentSection = { label: `- ${clean}`, bars: [], lyrics: [] };
    song.sections.push(currentSection);
  };

  for (let i = 0; i < classified.length; i++){
    const entry = classified[i];
    const line = entry.line;
    if (!line) continue;

    if (entry.type === 'meta'){
      parseUGMetaLine(song, line);
      continue;
    }

    if (entry.type === 'section'){
      ensureSection(entry.sectionName);
      continue;
    }

    if (entry.type === 'inline-bracket'){
      if (entry.chords.length){
        currentSection.bars.push(...entry.chords);
        if (entry.lyricsText){
          const prevLyric = currentSection.lyrics[currentSection.lyrics.length - 1] || '';
          if (prevLyric !== entry.lyricsText) currentSection.lyrics.push(entry.lyricsText);
        }
      }
      continue;
    }

    if (entry.type !== 'chord-line') continue;

    const nextEntry = (i + 1 < classified.length) ? classified[i + 1] : null;
    if (nextEntry && nextEntry.type === 'lyrics-line'){
      const prevLyric = currentSection.lyrics[currentSection.lyrics.length - 1] || '';
      if (prevLyric !== nextEntry.line) currentSection.lyrics.push(nextEntry.line);
      i++;
    }

    const tokens = (entry.tokens && entry.tokens.length) ? entry.tokens : tokenizeBars(line).filter(Boolean);
    if (!tokens.length) continue;
    const nonBarTokens = tokens.filter((tok) => !isBarlineToken(tok));
    if (!nonBarTokens.length) continue;

    const repeatCount = entry.repeatCount || 1;
    const contentTokens = repeatCount > 1
      ? tokens.filter((tok) => !/^x\d+$/i.test(tok) && !/^\(x\d+\)$/i.test(tok))
      : tokens;
    const hasBarlines = contentTokens.some((tok) => isBarlineToken(tok));
    const minedBars = [];

    if (hasBarlines){
      let segment = [];
      const flushSegment = () => {
        if (!segment.length) return;
        const segmentChords = segment.map((tok) => normalizeChordToken(tok)).filter(Boolean);
        if (!segmentChords.length){
          segment = [];
          return;
        }
        minedBars.push(segmentChords.length >= 2 ? segmentChords.join('_') : segmentChords[0]);
        segment = [];
      };
      for (const tok of contentTokens){
        if (isBarlineToken(tok)){
          flushSegment();
          continue;
        }
        segment.push(tok);
      }
      flushSegment();
    } else {
      const normalizedTokens = contentTokens.map((tok) => normalizeChordToken(tok)).filter(Boolean);
      if ((detectedFlavor === 'chord-dump' || detectedFlavor === 'ug-text') && normalizedTokens.length >= 4){
        for (let t = 0; t < normalizedTokens.length; t += 2){
          const pair = normalizedTokens.slice(t, t + 2);
          minedBars.push(pair.length === 2 ? pair.join('_') : pair[0]);
        }
      } else {
        minedBars.push(...normalizedTokens);
      }
    }

    if (!minedBars.length) continue;
    if (Number.isFinite(repeatCount) && repeatCount > 1){
      for (let r = 0; r < repeatCount; r++) currentSection.bars.push(...minedBars);
    } else {
      currentSection.bars.push(...minedBars);
    }
  }

  song.sections = song.sections.filter((section, idx) => section.bars.length || idx === 0 || section.label);
  if (song.sections.length > 1 && !song.sections[0].bars.length && song.sections[0].label === '- Main'){
    song.sections.shift();
  }
  return song;
}

function buildSongModelFromClassifiedText(classified){
  return buildCanonicalSongModel(classified, 'unknown-text');
}

function normalizeCanonicalSongModel(song, context = {}){
  const out = song instanceof SongModel ? song : new SongModel();
  const flavor = context.flavor || out.meta.importFlavor || 'unknown-text';
  out.sections = (out.sections || []).map((section) => {
    const bars = Array.isArray(section.bars) ? section.bars.filter(Boolean) : [];
    const normalizedBars = bars.map((bar) => {
      if (!bar) return '';
      if (/%{2,}/.test(bar)) return '%';
      return String(bar).replace(/\s+/g, '').replace(/__+/g, '_');
    }).filter(Boolean);
    return { ...section, bars: normalizedBars };
  }).filter((section, idx) => section.bars.length || idx === 0);
  if (flavor === 'chord-dump' && out.sections[0] && out.sections[0].bars.length >= 8){
    out.meta.groupingInferred = true;
  }
  return out;
}

function emitCSMPNFromStructuredText(classified){
  const repeatTokenToN = (t) => {
    if (!t) return null;
    const s = String(t).trim();
    let m = s.match(/^\(\s*x\s*(\d+)\s*\)$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^x\s*(\d+)$/i);
    if (m) return parseInt(m[1], 10);
    m = s.match(/^(\d+)\s*x$/i);
    if (m) return parseInt(m[1], 10);
    return null;
  };

  const parseTimesPhrase = (tokens) => {
    if (!tokens || tokens.length < 2) return null;
    if (String(tokens[0]).toLowerCase() !== "times") return null;
    const v = String(tokens[1]).toLowerCase();
    const map = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
    if (v in map) return map[v];
    if (/^\d+$/.test(v)) return parseInt(v, 10);
    return null;
  };

  const out = [];
  for (let i = 0; i < classified.length; i++){
    const entry = classified[i];
    const raw = entry.line;
    if (!raw) continue;

    if (entry.type === 'section'){
      out.push(`= ${entry.sectionName}`);
      continue;
    }
    if (entry.type === 'section-generic'){
      out.push(`= ${entry.sectionName}`);
      continue;
    }

    if (/^([-=])\s*(.+)$/.test(raw)){
      const m = raw.match(/^([-=])\s*(.+)$/);
      out.push(`${m[1]} ${m[2].trim()}`);
      continue;
    }
    if (/^(#{1,6})\s*(.+)$/.test(raw)){
      const m = raw.match(/^(#{1,6})\s*(.+)$/);
      out.push(`= ${m[2].trim()}`);
      continue;
    }

    if (entry.type === 'inline-bracket'){
      const normalized = entry.chords.map((c) => normalizeChordToken(c)).filter(Boolean);
      if (normalized.length){
        out.push(toCSMPNBars(normalized).trim());
        if (entry.lyricsText){
          const prev = (out[out.length - 1] || '').trim();
          if (prev !== `; ${entry.lyricsText}`) out.push(`; ${entry.lyricsText}`);
        }
      }
      continue;
    }

    const standaloneN = repeatTokenToN(raw) || parseTimesPhrase(raw.split(/\s+/));
    if (standaloneN && out.length){
      const prev = (out[out.length - 1] || '').trim();
      if (prev && !/^[=:#;]/.test(prev) && !/^\(.*\)x\d+$/i.test(prev)){
        out[out.length - 1] = `(${prev})x${standaloneN}`;
      }
      continue;
    }

    if (entry.type === 'lyrics-line' && out.length){
      const prev = (out[out.length - 1] || '').trim();
      if (prev && !/^[=\-:#;+]/.test(prev)) out.push(`; ${raw}`);
      continue;
    }

    if (entry.type !== 'chord-line') continue;
    let toks = (entry.tokens && entry.tokens.length) ? [...entry.tokens] : raw.split(/\s+/).filter(Boolean);
    let repeatN = repeatTokenToN(toks[toks.length-1]);
    if (!repeatN && toks.length >= 2) repeatN = parseTimesPhrase(toks.slice(-2));
    if (repeatN){
      if (repeatTokenToN(toks[toks.length-1])) toks = toks.slice(0, -1);
      else if (parseTimesPhrase(toks.slice(-2))) toks = toks.slice(0, -2);
    }

    const nextEntry = (i + 1 < classified.length) ? classified[i + 1] : null;
    const hasNextLyric = !!(nextEntry && nextEntry.type === 'lyrics-line');

    const chordLike = toks.reduce((acc, t) => acc + (isChordLikeToken(t) ? 1 : 0), 0);
    if (!toks.length || (chordLike / toks.length) < 0.6) continue;

    const hasBarlines = toks.some((t) => isBarlineToken(t));
    const bars = [];
    if (hasBarlines){
      let seg = [];
      const flushSeg = () => {
        if (!seg.length) return;
        const segChords = seg.map((t) => normalizeChordToken(t)).filter(Boolean);
        if (segChords.length){
          bars.push(segChords.length > 1 ? segChords.join('_') : segChords[0]);
        }
        seg = [];
      };
      for (const tok of toks){
        if (isBarlineToken(tok)) { flushSeg(); continue; }
        seg.push(tok);
      }
      flushSeg();
    } else {
      bars.push(...toks.map((t) => normalizeChordToken(t)).filter(Boolean));
    }
    if (!bars.length) continue;

    let block = toCSMPNBars(bars).trim();
    if (repeatN && repeatN > 1){
      block = block.replace(/\n+/g, " ").trim();
      out.push(`(${block})x${repeatN}`);
    } else {
      out.push(block);
    }
    if (hasNextLyric){
      const lyricLine = `; ${nextEntry.line}`;
      const prev = (out[out.length - 1] || '').trim();
      if (prev !== lyricLine) out.push(lyricLine);
      i++;
    }
  }

  return out.join('\n').trim();
}

function emitCSMPN(songModel, context = {}){
  if (!(songModel instanceof SongModel)) return '';
  return songModel.toCSMPN({ barsPerRow: context.barsPerRow || fbSettings.barsPerRow });
}

function attachImportDiagnostics(diagPatch = {}){
  if (!importDiagnostics) return;
  importDiagnostics.miner = diagPatch.miner || importDiagnostics.miner;
  importDiagnostics.sourceFlavor = diagPatch.sourceFlavor || importDiagnostics.sourceFlavor;
  importDiagnostics.confidence = diagPatch.confidence || importDiagnostics.confidence || 'high';
  importDiagnostics.fallbackUsed = !!(diagPatch.fallbackUsed || importDiagnostics.fallbackUsed);
  importDiagnostics.groupingInferred = !!(diagPatch.groupingInferred || importDiagnostics.groupingInferred);
  importDiagnostics.omrRequired = !!(diagPatch.omrRequired || importDiagnostics.omrRequired);
  if (Number.isFinite(diagPatch.pagesProcessed)) importDiagnostics.pagesProcessed = diagPatch.pagesProcessed;
  if (Number.isFinite(diagPatch.ignoredLines)) importDiagnostics.ignoredLines = diagPatch.ignoredLines;
  if (Array.isArray(diagPatch.warnings) && diagPatch.warnings.length){
    importDiagnostics.warnings.push(...diagPatch.warnings);
  }
}

function runSharedTextImportPipeline(text){
  const prep = preprocessImportedInput(text, { kind: 'text' });
  const detected = detectSourceFlavor(prep);
  const flavor = detected.flavor;
  const classified = classifyLinesOrEvents(prep, flavor);
  const canonicalSong = buildCanonicalSongModel(classified, flavor);
  const minedSong = normalizeCanonicalSongModel(canonicalSong, { flavor });
  const minedBars = countSongModelBars(minedSong);
  const csmpnFromSong = emitCSMPN(minedSong, { barsPerRow: fbSettings.barsPerRow });
  const csmpnLegacy = csmpnFromSong || emitCSMPNFromStructuredText(classified);
  const ignoredLines = classified.filter((entry) => entry.type === 'unknown').length;
  const groupingInferred = !!(minedSong?.meta?.groupingInferred) || flavor === 'chord-dump';
  const warnings = [];
  if (groupingInferred){
    warnings.push('Bar grouping inferred from dense chord text.');
  }
  if (/\|\:|\:\|/.test(prep.text) && !/\b(repeat|x\d+)\b/i.test(prep.text)){
    warnings.push('Repeat barlines detected; advanced repeat endings may need manual verification.');
  }
  if (/\b%%?\b/.test(prep.text)){
    warnings.push('Percent-repeat tokens detected; verify intended repeated harmony.');
  }
  if (/\b(1st|2nd|ending)\b/i.test(prep.text)){
    warnings.push('Alternate ending markers detected; unsupported endings kept as text context only.');
  }
  if (flavor === 'unknown-text'){
    warnings.push('Unknown text flavor; best-effort parser path used.');
  }
  return {
    preprocessed: prep,
    flavor,
    confidence: detected.confidence,
    classified,
    minedSong,
    minedBars,
    ignoredLines,
    csmpnLegacy,
    groupingInferred,
    warnings
  };
}

function addImportConfidenceWarnings(pipeline, opts = {}){
  if (!pipeline || !importDiagnostics) return;
  const ignored = Number(importDiagnostics.ignoredLines || 0);
  const total = Array.isArray(pipeline?.preprocessed?.lines) ? pipeline.preprocessed.lines.length : 0;
  const bars = Number(importDiagnostics.bars || pipeline.minedBars || 0);
  const sections = Number(importDiagnostics.sections || 0);
  const fallbackUsed = !!opts.fallbackUsed;
  const context = opts.context ? ` (${opts.context})` : '';

  if (fallbackUsed){
    importDiagnostics.warnings.push(`Fallback parser path used${context}.`);
  }
  if (total >= 8 && ignored >= Math.ceil(total * 0.45)){
    importDiagnostics.warnings.push(`Low-confidence import${context}: ignored ${ignored}/${total} non-empty lines.`);
  }
  if (bars > 0 && sections > 0 && bars / Math.max(1, sections) <= 1){
    importDiagnostics.warnings.push(`Low-confidence structure${context}: very sparse section-to-bar ratio.`);
  }
  if (bars <= 2 && total >= 6){
    importDiagnostics.warnings.push(`Low-confidence import${context}: extracted only ${bars} bars from ${total} lines.`);
  }
}

function isLikelyUGProText(text){
  const lines = (text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const hasBracketSections = lines.some((line) => /^\[(verse|chorus|bridge|intro|interlude|solo|outro|pre-?chorus|refrain|hook|coda|breakdown|instrumental|tag|ending|vamp)[^\]]*\]$/i.test(line));
  let chordLikeLines = 0;
  let bracketChordLines = 0;
  for (const line of lines){
    if (/^\[.+\]$/.test(line)) continue;
    if (isLikelyUGChordLine(line)) chordLikeLines++;
    else if (hasInlineBracketChords(line)) bracketChordLines++;
  }
  return hasBracketSections || chordLikeLines >= 2 || bracketChordLines >= 2;
}

function parseUGMetaLine(song, line){
  const m = line.match(/^\s*(title|song|artist|composer|key|tempo|bpm|time|time\s*signature)\s*:\s*(.+)\s*$/i);
  if (!m) return false;
  const label = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const value = m[2].trim();
  if (!value) return true;
  if (label === 'title' || label === 'song') song.meta.title = song.meta.title || value;
  else if (label === 'artist' || label === 'composer') song.meta.composer = song.meta.composer || value;
  else if (label === 'key') song.meta.key = song.meta.key || value;
  else if (label === 'tempo' || label === 'bpm') song.meta.tempo = song.meta.tempo || value.replace(/\s*bpm\s*$/i, '').trim();
  else if (label === 'time' || label === 'time signature') song.meta.time = song.meta.time || value;
  return true;
}

function parseUGSectionHeader(line){
  const sectionWords = '(verse|chorus|bridge|intro|interlude|solo|outro|pre-?chorus|refrain|hook|coda|breakdown|instrumental|tag|ending|vamp)';
  // [Verse 1], [Chorus], [Bridge 2], etc.
  let m = line.match(new RegExp('^\\s*\\[' + sectionWords + '(?:\\s*[0-9a-zA-Z\\-]*)?\\]\\s*$', 'i'));
  if (m) return normalizeUGSectionLabel(line.replace(/^\s*\[|\]\s*$/g, ''));
  // "Verse:", "Chorus 2:", "Bridge", with optional leading punctuation
  m = line.match(new RegExp('^\\s*[-=:>#]*\\s*' + sectionWords + '(?:\\s+\\d+)?\\s*:?\\s*$', 'i'));
  if (m) return normalizeUGSectionLabel(line.replace(/^[-=:>#\s]+/, '').replace(/:?\s*$/, ''));
  return '';
}

function normalizeUGSectionLabel(label){
  const s = String(label || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (/^pre[-\s]?chorus\b/.test(lower)) return s.replace(/^pre[-\s]?chorus/i, 'Pre-Chorus');
  if (/^verse\b/.test(lower)) return s.replace(/^verse/i, 'Verse');
  if (/^chorus\b|^refrain\b|^hook\b/.test(lower)) return s.replace(/^(chorus|refrain|hook)/i, 'Chorus');
  if (/^bridge\b/.test(lower)) return s.replace(/^bridge/i, 'Bridge');
  if (/^intro\b/.test(lower)) return s.replace(/^intro/i, 'Intro');
  if (/^outro\b|^ending\b|^tag\b|^coda\b/.test(lower)) return s.replace(/^(outro|ending|tag|coda)/i, 'Outro');
  if (/^solo\b/.test(lower)) return s.replace(/^solo/i, 'Solo');
  if (/^interlude\b/.test(lower)) return s.replace(/^interlude/i, 'Interlude');
  return s;
}

function isLikelyStructuralBracketLabel(innerLabel){
  const s = String(innerLabel || '').trim();
  if (!s) return false;
  if (s.length > 32) return false;
  if (isChordLikeToken(s)) return false;
  if (/[?!]/.test(s)) return false;
  if (/[\.,].+\s/.test(s)) return false;
  if (/^(verse|chorus|bridge|intro|outro|tag|solo|interlude|pre-?chorus|ending|refrain|hook|coda)(\s+\d+)?$/i.test(s)) return true;
  if (/^(section|part)\s+[a-z0-9]+$/i.test(s)) return true;
  return /^[A-Z][A-Za-z0-9\s\-]{1,24}$/.test(s) && s.split(/\s+/).length <= 3;
}

const RE_UG_STRUCTURAL_TOKEN = /^([\|\/\\\[\]\(\)\{\}\.,:;%\-]+|x\d+|\(x\d+\)|n\.c\.?|stop|break)$/i;

/* Detect UG inline bracket chord lines like "[Am]I'm walking [G]home" */
function hasInlineBracketChords(line){
  const s = (line || '').trim();
  // Must contain [chord] followed by non-bracket text (lyrics)
  const re = /\[([A-G][^\]]{0,12})\]/g;
  let count = 0;
  let m;
  while ((m = re.exec(s)) !== null){
    // Verify it looks like a chord, not a section header
    const inner = m[1].trim();
    if (/^(verse|chorus|bridge|intro|solo|outro|pre-?chorus|refrain)/i.test(inner)) continue;
    if (isChordLikeToken(inner)) count++;
  }
  return count >= 1;
}

/* Extract chords from bracket notation: "[Am]word [G]word" → ["Am","G"] */
function extractBracketChords(line){
  const chords = [];
  const re = /\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(line)) !== null){
    const c = m[1].trim();
    if (c && isChordLikeToken(c)) chords.push(c);
  }
  return chords;
}

/* Extract lyrics from bracket notation: "[Am]word [G]here" → "word here" */
function extractBracketLyrics(line){
  return (line || '').replace(/\[([^\]]*)\]/g, '').trim();
}

/* Detect whether a line is purely lyrics (non-chord, non-section, has alpha text) */
function isLikelyLyricsLine(line){
  const s = (line || '').trim();
  if (!s) return false;
  // Not a section header
  if (parseUGSectionHeader(s)) return false;
  // Not a chord line
  if (isLikelyUGChordLine(s)) return false;
  // Not a meta line
  if (/^\s*(title|song|artist|composer|key|tempo|bpm|time)\s*:/i.test(s)) return false;
  // Must contain reasonable text (letters)
  if (!/[a-zA-Z]{2,}/.test(s)) return false;
  // Not too long (avoid paragraph dumps)
  if (s.length > 200) return false;
  return true;
}

function isLikelyUGChordLine(line){
  const text = (line || '').trim();
  if (!text) return false;

  const tokens = tokenizeBars(text).filter(Boolean);
  if (!tokens.length) return false;
  if (tokens.length > 18 && /[a-z]{4,}/i.test(text)) return false;

  let validCount = 0;
  let chordCount = 0;

  for (const tok of tokens){
    if (isBarlineToken(tok)){
      validCount++;
      continue;
    }
    if (normalizeChordToken(tok)){
      chordCount++;
      validCount++;
      continue;
    }
    if (RE_UG_STRUCTURAL_TOKEN.test(tok)){
      validCount++;
    }
  }

  if (!chordCount) return false;
  if (text.length > 28 && chordCount <= 2 && /[a-z]{4,}/i.test(text)) return false;

  const validityRatio = validCount / tokens.length;
  if (validityRatio >= 0.9) return true;
  if (validityRatio === 1 && chordCount >= 1) return true;
  if (chordCount >= 2 && validityRatio >= 0.5) return true;
  if (chordCount === 1 && text.length < 10 && validityRatio >= 0.8) return true;
  return false;
}

function mineUGProTextToSongModel(text){
  const pipeline = runSharedTextImportPipeline(text);
  return pipeline.minedSong;
}

function importUGText(text){
  const pipeline = runSharedTextImportPipeline(text);
  return pipeline.csmpnLegacy;
}

function importChordPro(text){
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  let inGrid = false; // true while inside {start_of_grid} / {end_of_grid}
  // Process each line and build output; header entries are prepended via unshift.
  for (const line0 of lines) {
    const line = normalizeAccidentals(line0);
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Grid lines: while inside {start_of_grid}, parse | [chord] . | rows
    if (inGrid && trimmed.includes('|')) {
      const bars = parseChordProGridLine(trimmed);
      if (bars.length) out.push(toCSMPNBars(bars));
      continue;
    }

    // Match standard {name: value} directives
    const m = trimmed.match(/^\{\s*([a-z_]+)\s*:\s*(.*?)\s*\}$/i);
    if (m) {
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      // Handle environment directives of the form {start_of_xxx: ...} and {end_of_xxx}
      if (k.startsWith('start_of_')) {
        const envName = k.substring('start_of_'.length);
        if (envName === 'grid') inGrid = true;
        let label = v || '';
        // allow optional label="..." or label=...
        const labelMatch = label.match(/^label\s*=\s*(.*)/i);
        if (labelMatch) {
          label = labelMatch[1].trim();
        }
        // Strip surrounding quotes
        label = label.replace(/^['"]|['"]$/g, '');
        // Replace underscores with spaces and title-case
        label = label.replace(/_/g, ' ').trim();
        label = label.split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ');
        // Only push a section label if there's a meaningful label (not generic "grid")
        if (label && label.toLowerCase() !== 'grid') out.push(`: ${label}`);
        continue;
      }
      if (k.startsWith('end_of_')) {
        if (k === 'end_of_grid') inGrid = false;
        // Ignore end-of environment directives
        continue;
      }
      // Handle meta directive (e.g. {meta: name value})
      if (k === 'meta') {
        const m2 = v.match(/^([a-z_]+)\s+(.*)$/i);
        if (m2) {
          const metaName = m2[1].toLowerCase();
          const metaVal = m2[2].trim();
          if (metaName === 'title') {
            out.unshift(`Title: ${metaVal}`);
          } else if (['artist', 'composer', 'lyricist', 'arranger'].includes(metaName)) {
            out.unshift(`Composer: ${metaVal}`);
          } else if (metaName === 'key') {
            out.unshift(`Key: ${metaVal}`);
          } else if (metaName === 'time') {
            out.unshift(`Time: ${metaVal}`);
          } else if (metaName === 'tempo') {
            out.unshift(`Tempo: ${metaVal}`);
          } else {
            const nameUC = metaName.charAt(0).toUpperCase() + metaName.slice(1);
            out.push(`; ${nameUC}: ${metaVal}`);
          }
        }
        continue;
      }
      // Title directive
      if (k === 'title') {
        out.unshift(`Title: ${v}`);
        continue;
      }
      // Subtitle directive -> store as comment
      if (k === 'subtitle') {
        out.push(`; Subtitle: ${v}`);
        continue;
      }
      // Sorttitle directive -> treat same as title
      if (k === 'sorttitle') {
        out.unshift(`Title: ${v}`);
        continue;
      }
      // Artist/Composer/Lyricist/Arranger -> unify under Composer header
      if (['artist', 'composer', 'lyricist', 'arranger'].includes(k)) {
        out.unshift(`Composer: ${v}`);
        continue;
      }
      // Key directive
      if (k === 'key') {
        out.unshift(`Key: ${v}`);
        continue;
      }
      // Time directive
      if (k === 'time') {
        out.unshift(`Time: ${v}`);
        continue;
      }
      // Tempo directive
      if (k === 'tempo') {
        out.unshift(`Tempo: ${v}`);
        continue;
      }
      // Duration or Capo or Album or Year or Copyright directives -> comment lines
      if (['duration', 'capo', 'album', 'year', 'copyright'].includes(k)) {
        const nameUC = k.charAt(0).toUpperCase() + k.slice(1);
        out.push(`; ${nameUC}: ${v}`);
        continue;
      }
      // Comment directives
      if (['comment', 'comment_italic', 'comment_box', 'highlight'].includes(k)) {
        out.push(`; ${v}`);
        continue;
      }
      // Unhandled directives: preserve content as comment
      out.push(`; ${k}: ${v}`);
      continue;
    }

    // Environment start directives {start_of_X ...}
    const startMatch = trimmed.match(/^\{\s*start_of_([a-z0-9_]+)\s*(?::\s*(.*?))?\s*\}$/i);
    if (startMatch) {
      const envName = startMatch[1].toLowerCase();
      if (envName === 'grid') inGrid = true;
      let label = startMatch[2] ? startMatch[2].trim() : '';
      const labelMatch = label.match(/^label\s*=\s*(.*)/i);
      if (labelMatch) {
        label = labelMatch[1].trim();
      }
      label = label.replace(/^['"]|['"]$/g, '');
      label = label.replace(/_/g, ' ').trim();
      label = label.split(/\s+/).map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ');
      // Only emit a section marker for non-grid environments, or grid with an explicit label
      if (label && label.toLowerCase() !== 'grid') out.push(`: ${label}`);
      else if (envName !== 'grid') {
        // Generic non-grid environment: use the env name as label
        const fallbackLabel = envName.replace(/_/g, ' ').split(/\s+/)
          .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '').join(' ');
        out.push(`: ${fallbackLabel}`);
      }
      continue;
    }
    // Environment end directives {end_of_X}
    const endMatch = trimmed.match(/^\{\s*end_of_([a-z0-9_]+)\s*\}$/i);
    if (endMatch) {
      if (endMatch[1].toLowerCase() === 'grid') inGrid = false;
      continue;
    }
    // Lines starting with hash (#) are comments -> preserve as comment line
    if (trimmed.startsWith('#')) {
      const cv = trimmed.slice(1).trim();
      if (cv) out.push(`; ${cv}`);
      continue;
    }

    // UG-style section headers in bracket format: [Verse 1], [Chorus]
    const ugSectionName = parseUGSectionHeader(trimmed);
    if (ugSectionName) {
      out.push(`: ${ugSectionName}`);
      continue;
    }

    // Extract chords in [] and separate from lyrics
    const chords = [];
    const re = /\[([^\]]+)\]/g;
    let mm;
    while ((mm = re.exec(line)) !== null) {
      const c = mm[1].trim();
      if (c && isChordLikeToken(c)) chords.push(c);
    }
    if (chords.length) {
      // Remove chord annotations (text in square brackets) to leave only lyrics.
      const lyricsText = line.replace(/\[([^\]]*)\]/g, '').trim();
      out.push(toCSMPNBars(chords));
      if (lyricsText) out.push(`; ${lyricsText}`);
    }
  }
  setStatus(`Imported ChordPro.`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}


function mineABCToSongModel(abcText){
  const song = new SongModel();
  const text = (abcText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n');

  song.meta.title = firstABCHeaderValue(lines, 'T');
  song.meta.composer = firstABCHeaderValue(lines, 'C');
  song.meta.time = firstABCHeaderValue(lines, 'M') || '4/4';
  song.meta.key = normalizeABCKey(firstABCHeaderValue(lines, 'K'));
  song.meta.tempo = parseABCTempo(firstABCHeaderValue(lines, 'Q'));

  const sectionMap = new Map();
  let currentSection = ensureABCSection(sectionMap, 'Main');

  const hasMusicLikeContent = lines.some((line) => {
    const trimmed = (line || '').trim();
    if (!trimmed) return false;
    if (/^[A-Za-z]:/.test(trimmed)) return false;
    return /[A-Ga-gz"|]/.test(trimmed);
  });

  for (const line0 of lines){
    const line = (line0 || '').trim();
    if (!line || line.startsWith('%')) continue;

    const partMatch = line.match(/^P\s*:\s*(.+)$/i);
    if (partMatch){
      currentSection = ensureABCSection(sectionMap, partMatch[1]);
      continue;
    }

    if (/^[A-Za-z]\s*:/.test(line)) continue;

    const measures = line.split(/\|+/).map((m) => m.trim());
    for (const measure of measures){
      if (!measure) continue;
      const chordMatches = [...measure.matchAll(/"([^"]+)"/g)]
        .map((m) => normalizeChordToken(m[1] || ''))
        .filter(Boolean);
      if (!chordMatches.length){
        if ((/\|\s*:\s*$/.test(line) || /^\s*:\s*\|/.test(line)) && currentSection.bars.length){
          currentSection.bars.push('%');
        }
        continue;
      }
      currentSection.bars.push(chordMatches.length === 1 ? chordMatches[0] : chordMatches.join('_'));
    }

    if (/\|:/.test(line)) currentSection.bars.push('|:');
    if (/:\|/.test(line)) currentSection.bars.push(':|');
  }

  let totalBars = 0;
  for (const sec of sectionMap.values()) totalBars += sec.bars.length;

  if (totalBars < 4 && hasMusicLikeContent){
    try {
      const parsedBars = fallbackMineABCWithAbcjs(text);
      if (parsedBars.length){
        if (!currentSection.bars.length) currentSection = ensureABCSection(sectionMap, 'Main');
        currentSection.bars.push(...parsedBars);
      }
    } catch (err) {
      console.warn('ABCJS parse fallback warning:', err);
    }
  }

  song.sections = [...sectionMap.values()].filter((sec) => sec.bars.length);
  if (!song.sections.length){
    song.sections = [{ label: '- Main', bars: [] }];
  }
  return song;
}

function firstABCHeaderValue(lines, letter){
  const re = new RegExp(`^${letter}\\s*:\\s*(.+)$`, 'i');
  for (const line0 of lines){
    const line = (line0 || '').trim();
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return '';
}

function normalizeABCKey(rawKey){
  const key = (rawKey || '').trim();
  if (!key) return '';
  const m = key.match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!m) return key;
  const root = m[1].toUpperCase();
  const acc = m[2] || '';
  const rest = (m[3] || '').trim();
  if (!rest) return `${root}${acc}`;
  if (/^(m|min|minor)$/i.test(rest)) return `${root}${acc}m`;
  return `${root}${acc}${rest}`;
}

function parseABCTempo(qValue){
  const q = (qValue || '').trim();
  if (!q) return '';
  const m = q.match(/=\s*(\d{2,3})/);
  if (m) return String(parseInt(m[1], 10));
  const n = q.match(/\b(\d{2,3})\b/);
  return n ? String(parseInt(n[1], 10)) : '';
}

function ensureABCSection(sectionMap, labelRaw){
  const cleaned = (labelRaw || 'Main').replace(/^[-:=]+\s*/, '').trim() || 'Main';
  const key = cleaned.toLowerCase();
  if (!sectionMap.has(key)){
    sectionMap.set(key, { label: `- ${cleaned}`, bars: [] });
  }
  return sectionMap.get(key);
}

function fallbackMineABCWithAbcjs(abcText){
  const bars = [];
  if (!window.ABCJS || typeof window.ABCJS.renderAbc !== 'function') return bars;

  const hidden = document.getElementById('abc-hidden');
  if (!hidden) return bars;

  const tunes = window.ABCJS.renderAbc('abc-hidden', abcText, { add_classes: true });
  if (!Array.isArray(tunes)) return bars;

  for (const tune of tunes){
    const lines = tune?.lines || [];
    for (const line of lines){
      const staffs = line?.staff || [];
      for (const staff of staffs){
        const voices = staff?.voices || [];
        for (const voice of voices){
          for (const event of voice){
            const chord = event?.chord?.find((c) => c?.name)?.name || event?.gchord;
            if (chord){
              bars.push(normalizeChordToken(String(chord)));
            }
          }
        }
      }
    }
  }

  if (!bars.length){
    console.warn('ABCJS fallback parse produced no chord annotations; proceeding with text-mined ABC bars.');
  }
  return bars.filter(Boolean);
}

function normalizeMusicXMLText(rawText){
  if (typeof rawText !== 'string') return '';
  // UTF-16 MusicXML can appear as UTF-8-decoded text with interleaved NULs.
  return rawText.includes('\u0000') ? rawText.replace(/\u0000/g, '') : rawText;
}

/* =========================================================
   MXL Import — Compressed MusicXML (ZIP container)
   Uses JSZip (BSD-3-Clause) to decompress the archive,
   reads META-INF/container.xml to find the rootfile,
   then feeds the XML to the existing importMusicXML parser.
========================================================= */
async function importMXL(arrayBuffer){
  if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded — check CDN connection.');

  const zip = await JSZip.loadAsync(arrayBuffer);

  // Prefer META-INF/container.xml to find the rootfile path
  let rootFilePath = null;
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerText = await containerFile.async('text');
    const m = containerText.match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (m) rootFilePath = m[1];
  }

  // Fallback: find the first .musicxml or .xml file at the root level
  if (!rootFilePath) {
    const candidates = Object.keys(zip.files).filter(name =>
      !name.startsWith('META-INF') &&
      (name.endsWith('.musicxml') || name.endsWith('.xml')) &&
      !zip.files[name].dir
    );
    if (!candidates.length) throw new Error('No MusicXML file found inside the .mxl archive.');
    // Prefer the file with the shortest path (most likely root level)
    candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    rootFilePath = candidates[0];
  }

  const xmlFile = zip.file(rootFilePath);
  if (!xmlFile) throw new Error(`Cannot read "${rootFilePath}" from MXL archive.`);

  const xmlText = await xmlFile.async('text');
  return importMusicXML(xmlText);
}

/* =========================================================
   OnSong Format Import
   OnSong is used widely by gigging musicians on iOS/iPad.
   Format: bare title on line 1, optional artist on line 2,
   then optional key/bpm/capo metadata, then body with
   [Section] headers and [Chord]lyric bracket notation —
   largely compatible with ChordPro after minor pre-processing.
========================================================= */
function importOnSong(text){
  const lines = (text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const converted = [];
  let titleCaptured = false;
  let artistCaptured = false;
  let headerBlockDone = false;

  for (let i = 0; i < lines.length; i++){
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed){ converted.push(''); continue; }

    // Once we have body content, pass lines through unchanged
    if (headerBlockDone){ converted.push(raw); continue; }

    // ChordPro directive — preserve as-is
    if (trimmed.startsWith('{') && trimmed.includes(':') && trimmed.endsWith('}')){
      headerBlockDone = true;
      converted.push(raw);
      continue;
    }

    // Explicit metadata keywords common in OnSong (Key, BPM, Tempo, Time, Capo, Tuning, Style)
    const metaMatch = trimmed.match(/^(Key|BPM|Bpm|Tempo|Time|Capo|Tuning|Style|Artist|Composer)\s*:\s*(.+)$/i);
    if (metaMatch){
      const k = metaMatch[1].toLowerCase();
      const v = metaMatch[2].trim();
      if (k === 'bpm' || k === 'tempo') converted.push(`{tempo: ${v}}`);
      else if (k === 'artist' || k === 'composer') converted.push(`{artist: ${v}}`);
      else converted.push(`{${k}: ${v}}`);
      continue;
    }

    // Section headers [Verse], [Chorus], etc. — start body
    if (/^\[[^\]]+\]$/.test(trimmed)){
      headerBlockDone = true;
      converted.push(raw);
      continue;
    }

    // Inline bracket chords or chord-only line — start of body
    if (hasInlineBracketChords(trimmed) || isLikelyUGChordLine(trimmed)){
      headerBlockDone = true;
      converted.push(raw);
      continue;
    }

    // Capture bare title (first non-empty non-directive line)
    if (!titleCaptured){
      converted.push(`{title: ${trimmed}}`);
      titleCaptured = true;
      continue;
    }

    // Capture bare artist (second non-empty non-directive line, if it doesn't look like a chord line)
    if (!artistCaptured && !isLikelyUGChordLine(trimmed)){
      converted.push(`{artist: ${trimmed}}`);
      artistCaptured = true;
      continue;
    }

    // Anything else goes to body
    headerBlockDone = true;
    converted.push(raw);
  }

  // Feed the normalised text to the ChordPro importer
  return importChordPro(converted.join('\n'));
}

/* =========================================================
   OpenSong XML Import
   OpenSong is an XML worship-song application format.
   Chords appear on lines starting with '.' in <lyrics>,
   or inline as [Chord] bracket notation.
========================================================= */
// Shared helper: parse OpenSong <lyrics> text into a SongModel
function _parseOpenSongLyricsIntoSong(song, lyricsText){
  const lines = (lyricsText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let currentSection = { label: '- Main', bars: [], lyrics: [] };
  song.sections.push(currentSection);

  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Section markers: [verse], [chorus], [bridge], etc.
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch){
      const name = normalizeCSMPNSectionLabel(sectionMatch[1]);
      currentSection = { label: `- ${name}`, bars: [], lyrics: [] };
      song.sections.push(currentSection);
      continue;
    }

    // OpenSong chord lines start with '.'
    if (trimmed.startsWith('.')){
      const chordLine = trimmed.slice(1).trim();
      const tokens = chordLine.split(/\s+/).filter(Boolean);
      const chords = tokens.map(t => normalizeChordToken(t)).filter(Boolean);
      if (chords.length){
        const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
        if (nextLine && !nextLine.startsWith('.') && !nextLine.startsWith('[') && !isLikelyUGChordLine(nextLine)){
          currentSection.lyrics.push(nextLine);
          i++;
        }
        currentSection.bars.push(...chords);
      }
      continue;
    }

    // Inline bracket chords: [Am]lyrics [G]here
    if (hasInlineBracketChords(trimmed)){
      const chords = extractBracketChords(trimmed).map(c => normalizeChordToken(c)).filter(Boolean);
      const lyricText = extractBracketLyrics(trimmed);
      if (chords.length) currentSection.bars.push(...chords);
      if (lyricText) currentSection.lyrics.push(lyricText);
      continue;
    }

    // Plain chord line
    if (isLikelyUGChordLine(trimmed)){
      const tokens = tokenizeBars(trimmed).filter(t => !isBarlineToken(t));
      const chords = tokens.map(t => normalizeChordToken(t)).filter(Boolean);
      if (chords.length) currentSection.bars.push(...chords);
    }
  }

  song.sections = song.sections.filter((s, idx) => s.bars.length || idx === 0);
  if (!song.sections.length) song.sections.push({ label: '- Main', bars: [] });
  return song;
}

function importOpenSong(xmlText){
  const song = new SongModel();

  // Helper: regex-based tag content extraction (for fallback when DOMParser unavailable)
  const tagContent = (src, name) => {
    const re = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i');
    const m = src.match(re);
    return m ? m[1].trim() : '';
  };

  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');

    if (xml.querySelector('parsererror')){
      throw new Error('DOMParser error — using regex fallback');
    }

    const root = xml.querySelector('song') || xml.documentElement;
    const titleText    = (root.querySelector('title')?.textContent    || '').trim();
    const authorText   = (root.querySelector('author')?.textContent   || '').trim();
    const keyText      = (root.querySelector('key')?.textContent      || '').trim();
    const tempoText    = (root.querySelector('tempo')?.textContent    || '').trim();
    const timeSigText  = (root.querySelector('time_sig')?.textContent || '').trim();
    const lyricsText   = (root.querySelector('lyrics')?.textContent   || '').trim();

    // Fall through to regex if DOM gave empty results (e.g. stripped DOMParser stub)
    if (!titleText && !lyricsText){
      throw new Error('DOM gave empty results — using regex fallback');
    }

    song.meta.title    = titleText;
    song.meta.composer = authorText;
    song.meta.key      = keyText;
    song.meta.tempo    = tempoText;
    if (timeSigText) song.meta.time = timeSigText;

    return _parseOpenSongLyricsIntoSong(song, lyricsText);
  } catch(_domErr){
    // Regex fallback — works without a browser DOMParser
    const newSong = new SongModel();
    newSong.meta.title    = tagContent(xmlText, 'title');
    newSong.meta.composer = tagContent(xmlText, 'author');
    newSong.meta.key      = tagContent(xmlText, 'key');
    newSong.meta.tempo    = tagContent(xmlText, 'tempo');
    const timeSig = tagContent(xmlText, 'time_sig');
    if (timeSig) newSong.meta.time = timeSig;
    const lyricsText = tagContent(xmlText, 'lyrics');
    return _parseOpenSongLyricsIntoSong(newSong, lyricsText);
  }
}

/* =========================================================
   OpenLyrics XML Import
   OpenLyrics (openlyrics.info) is an open XML standard for
   worship songs with <chord name="G"/> elements embedded in
   <lines> inside <verse> blocks.
========================================================= */
// Map OpenLyrics verse name abbreviations to human labels
function _openLyricsVerseLabel(rawName){
  const n = (rawName || 'v').trim().toLowerCase();
  if (/^v\d*$/.test(n)) return 'Verse';
  if (/^c\d*$/.test(n)) return 'Chorus';
  if (/^b\d*$/.test(n)) return 'Bridge';
  if (/^p\d*$/.test(n)) return 'Pre-Chorus';
  if (/^e\d*$/.test(n)) return 'Ending';
  if (/^i\d*$/.test(n)) return 'Intro';
  return rawName;
}

// Regex-based OpenLyrics extraction — works without DOMParser
function importOpenLyricsRegex(xmlText){
  const song = new SongModel();
  const t = xmlText || '';

  // Simple tag text helper
  const tagText = (src, name) => {
    const re = new RegExp('<' + name + '[^>]*>([\\s\\S]*?)<\\/' + name + '>', 'i');
    const m = src.match(re);
    return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  };

  // Extract metadata
  song.meta.title    = tagText(t, 'title');
  song.meta.composer = tagText(t, 'author');
  song.meta.key      = tagText(t, 'key');

  const tempoMatch = t.match(/<tempo[^>]*bpm=["'](\d+)["']/i) ||
                     t.match(/<tempo[^>]*>(\d+)<\/tempo>/i);
  if (tempoMatch) song.meta.tempo = tempoMatch[1];

  // Extract verses
  const verseRe = /<verse\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/verse>/gi;
  let verseMatch;
  while ((verseMatch = verseRe.exec(t)) !== null){
    const verseName = verseMatch[1];
    const verseContent = verseMatch[2];
    const label = _openLyricsVerseLabel(verseName);
    const section = { label: `- ${label}`, bars: [], lyrics: [] };
    song.sections.push(section);

    // Extract chord names from <chord name="G"/>
    const chordRe = /<chord\s+name=["']([^"']+)["'][^>]*\/?>/gi;
    let chordMatch;
    while ((chordMatch = chordRe.exec(verseContent)) !== null){
      const norm = normalizeChordToken(chordMatch[1]);
      if (norm) section.bars.push(norm);
    }

    // If no chord elements found, try plain text chord lines in <lines>
    if (!section.bars.length){
      const linesRe = /<lines>([\s\S]*?)<\/lines>/gi;
      let linesMatch;
      while ((linesMatch = linesRe.exec(verseContent)) !== null){
        const lineText = linesMatch[1].replace(/<[^>]+>/g, ' ').trim();
        if (lineText && isLikelyUGChordLine(lineText)){
          const tokens = tokenizeBars(lineText).filter(tok => !isBarlineToken(tok));
          const chords = tokens.map(tok => normalizeChordToken(tok)).filter(Boolean);
          section.bars.push(...chords);
        }
      }
    }
  }

  if (!song.sections.length) song.sections.push({ label: '- Main', bars: [] });
  return song;
}

function importOpenLyrics(xmlText){
  try {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');

    if (xml.querySelector('parsererror')){
      throw new Error('DOMParser error — using regex fallback');
    }

    const root = xml.documentElement;

    const song = new SongModel();
    song.meta.title    = (root.querySelector('properties titles title')?.textContent ||
                          root.querySelector('title')?.textContent || '').trim();
    song.meta.composer = (root.querySelector('properties authors author')?.textContent ||
                          root.querySelector('author')?.textContent || '').trim();
    song.meta.key      = (root.querySelector('properties key')?.textContent || '').trim();

    const tempoEl = root.querySelector('properties tempo');
    if (tempoEl){
      const bpmAttr = tempoEl.getAttribute('bpm');
      const tempoText = (bpmAttr || tempoEl.textContent || '').trim();
      const bpmNum = parseInt(tempoText, 10);
      if (Number.isFinite(bpmNum) && bpmNum > 0) song.meta.tempo = String(bpmNum);
    }
    const timeEl = root.querySelector('properties timeSignature');
    if (timeEl) song.meta.time = timeEl.textContent.trim();

    // Fall back to regex if DOM produced no useful results
    if (!song.meta.title && !root.querySelectorAll('verse').length){
      throw new Error('DOM gave empty results — using regex fallback');
    }

    const verses = root.querySelectorAll('lyrics verse, verse');
    for (const verse of verses){
      const rawName = verse.getAttribute('name') || 'v';
      const label = _openLyricsVerseLabel(rawName);
      const section = { label: `- ${label}`, bars: [], lyrics: [] };
      song.sections.push(section);

      const lineEls = verse.querySelectorAll('lines');
      for (const lineEl of lineEls){
        const chordEls = lineEl.querySelectorAll('chord');
        for (const chordEl of chordEls){
          const chordName = (chordEl.getAttribute('name') || '').trim();
          const norm = normalizeChordToken(chordName);
          if (norm) section.bars.push(norm);
        }

        if (!chordEls.length){
          const rawText = (lineEl.textContent || '').trim();
          if (rawText && isLikelyUGChordLine(rawText)){
            const tokens = tokenizeBars(rawText).filter(t => !isBarlineToken(t));
            const chords = tokens.map(t => normalizeChordToken(t)).filter(Boolean);
            section.bars.push(...chords);
          }
        }
      }
    }

    if (!song.sections.length) song.sections.push({ label: '- Main', bars: [] });
    return song;
  } catch(_domErr){
    return importOpenLyricsRegex(xmlText);
  }
}

/* =========================================================
   Format Detection Helpers (XML-based formats)
========================================================= */
function isOpenLyricsXML(text){
  return /openlyrics\.info/i.test(text) ||
    (/<song\b/.test(text) && /<verse\b/.test(text) && /<lines\b/.test(text));
}

function isOpenSongXML(text){
  return /<song>/.test(text) && /<lyrics>/.test(text) && !isOpenLyricsXML(text);
}

/* =========================================================
   iReal Pro Import — irealb:// URL scheme
   Parses iReal Pro chord charts exported as irealb:// links.
   Supports single-song URLs and multi-song playlist URLs.
   Uses 50-char block unscrambling for newer exports.
   No external library required — pure JS.
========================================================= */

// Unscramble iReal Pro chord strings (50-char block reversal)
function _irUnscramble(s) {
  if (s.length <= 50) return s;
  let result = '';
  let pos = 0;
  while (pos < s.length) {
    const end = Math.min(pos + 50, s.length);
    result = s.slice(pos, end) + result; // prepend each block — reverses order
    pos += 50;
  }
  return result;
}

// Convert an iReal Pro chord token to CSMPN notation
function _irConvertChordName(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (s === 'n' || s === 'NC' || s === 'N.C.') return 'N.C.';
  if (s === 'x' || s === 'r') return '%';
  if (s === 'p' || s === 'W') return '';
  if (!/^[A-G]/.test(s)) return '';

  return s
    // Major 7th variants (longest first to avoid partial match)
    .replace(/\^13/g, 'maj13')
    .replace(/\^9/g,  'maj9')
    .replace(/\^7/g,  'maj7')
    .replace(/\^/g,   'maj')
    // Minor variants (longest specific first)
    .replace(/^([A-G][b#]?)-M7/, '$1mM7')
    .replace(/^([A-G][b#]?)-13/, '$1m13')
    .replace(/^([A-G][b#]?)-11/, '$1m11')
    .replace(/^([A-G][b#]?)-9/,  '$1m9')
    .replace(/^([A-G][b#]?)-6/,  '$1m6')
    .replace(/^([A-G][b#]?)-7/,  '$1m7')
    .replace(/^([A-G][b#]?)-/,   '$1m')
    // Half-diminished: h → m7b5
    .replace(/^([A-G][b#]?)h7?/, '$1m7b5')
    // Diminished (o7 before o)
    .replace(/^([A-G][b#]?)o7/,  '$1dim7')
    .replace(/^([A-G][b#]?)o/,   '$1dim')
    // Augmented
    .replace(/^([A-G][b#]?)\+/,  '$1aug')
    // Suspended: sus (not sus2) → sus4
    .replace(/sus(?!2)/g, 'sus4');
}

// Parse one iReal Pro song string (URL-encoded, = delimited) into a SongModel
function _irParseSong(raw) {
  const song = new SongModel();
  let decoded;
  try { decoded = decodeURIComponent(raw.replace(/\+/g, ' ')); }
  catch(_) { decoded = raw; }

  // Format: Title=Composer=Style=Key=n=ChordString[=...]
  const eqIdx = [];
  for (let k = 0; k < decoded.length; k++) { if (decoded[k] === '=') eqIdx.push(k); }
  if (eqIdx.length < 5) return song;

  song.meta.title    = decoded.slice(0, eqIdx[0]).trim();
  song.meta.composer = decoded.slice(eqIdx[0] + 1, eqIdx[1]).trim();
  const style        = decoded.slice(eqIdx[1] + 1, eqIdx[2]).trim();
  song.meta.key      = decoded.slice(eqIdx[2] + 1, eqIdx[3]).trim();
  // eqIdx[3]+1..eqIdx[4] = literal 'n'
  let chordStr = decoded.slice(eqIdx[4] + 1).replace(/=\s*$/, '').trim();

  if (style) song.meta.style = style;

  chordStr = _irUnscramble(chordStr);

  const TIME_SIG_MAP = {
    '44':'4/4','34':'3/4','64':'6/4','54':'5/4','24':'2/4',
    '22':'2/2','12':'12/8','98':'9/8','38':'3/8','58':'5/8'
  };
  const SECTION_LABELS = {
    A:'Section A', B:'Section B', C:'Section C', D:'Section D',
    i:'Intro', v:'Verse', T:'Tag'
  };

  let currSection = { label: '- Main', bars: [] };
  song.sections.push(currSection);
  let pendingChords = [];

  const flushChords = () => {
    if (!pendingChords.length) return;
    currSection.bars.push(...pendingChords);
    pendingChords = [];
  };
  const addBarline = () => {
    flushChords();
    if (currSection.bars.length && currSection.bars[currSection.bars.length - 1] !== '|') {
      currSection.bars.push('|');
    }
  };

  let i = 0;
  const cs = chordStr;
  const n = cs.length;

  while (i < n) {
    // Time signature: T + 2 digits
    if (cs[i] === 'T' && i + 2 < n && /\d/.test(cs[i+1]) && /\d/.test(cs[i+2])) {
      const ts = TIME_SIG_MAP[cs[i+1] + cs[i+2]];
      if (ts) song.meta.time = ts;
      i += 3; continue;
    }

    // Section marker: *A..*D, *i, *v, *T
    if (cs[i] === '*' && i + 1 < n && /[A-DivT]/.test(cs[i+1])) {
      addBarline();
      // Remove trailing barline from section if it's empty
      if (currSection.bars.length === 1 && currSection.bars[0] === '|') currSection.bars = [];
      const labelText = SECTION_LABELS[cs[i+1]] || ('Section ' + cs[i+1].toUpperCase());
      currSection = { label: `- ${labelText}`, bars: [] };
      song.sections.push(currSection);
      i += 2; continue;
    }

    // Numbered endings N1/N2/N3 — flush and skip
    if (cs[i] === 'N' && i + 1 < n && /[123]/.test(cs[i+1])) {
      addBarline(); i += 2; continue;
    }

    // Barline tokens: | { } [ ]
    if ('|{}[]'.includes(cs[i])) { addBarline(); i++; continue; }

    // Final barline Z
    if (cs[i] === 'Z') { addBarline(); i++; continue; }

    // Control tokens to skip: S (segno), Q (coda), f (fermata)
    if (cs[i] === 'S' || cs[i] === 'Q' || cs[i] === 'f') { i++; continue; }

    // W (whole-bar fill) — skip
    if (cs[i] === 'W') { i++; continue; }

    // p (pause) — skip
    if (cs[i] === 'p') { i++; continue; }

    // x (bar repeat) — only when not part of a chord root
    if (cs[i] === 'x' && (i === 0 || !/[A-G]/.test(cs[i-1]))) {
      pendingChords.push('%'); i++; continue;
    }

    // r (2-bar repeat)
    if (cs[i] === 'r') { pendingChords.push('%'); i++; continue; }

    // n (no chord) — only when not part of a chord quality
    if (cs[i] === 'n' && (i === 0 || !/[A-G]/.test(cs[i-1]))) {
      pendingChords.push('N.C.'); i++; continue;
    }

    // Alternate chord in parentheses — skip
    if (cs[i] === '(') {
      const close = cs.indexOf(')', i);
      i = close === -1 ? i + 1 : close + 1; continue;
    }

    // Space — beat separator
    if (cs[i] === ' ') { i++; continue; }

    // Chord token: starts with A-G
    if (/[A-G]/.test(cs[i])) {
      let chord = cs[i]; i++;
      // Accidental: flat (b) for valid flat roots Bb/Eb/Ab/Db/Gb, or any sharp
      if (i < n && cs[i] === '#') { chord += cs[i]; i++; }
      else if (i < n && cs[i] === 'b' && 'BEADG'.includes(chord)) { chord += cs[i]; i++; }

      // Collect quality until next chord root, barline, or control token
      let quality = '';
      while (i < n) {
        const c = cs[i];
        if ('|{}[]Z*SQf '.includes(c)) break;
        // Stop at next chord root (uppercase A-G) when quality is non-empty and ends with
        // a char that typically concludes a quality (digit, lowercase letter)
        if (/[A-G]/.test(c) && quality.length > 0) break;
        quality += c; i++;
      }
      const converted = _irConvertChordName(chord + quality.trimEnd());
      if (converted === 'N.C.' || converted === '%') { pendingChords.push(converted); }
      else if (converted) { pendingChords.push(normalizeChordToken(converted) || converted); }
      continue;
    }

    i++; // skip unknown chars
  }

  // Flush any remaining pending chords
  flushChords();

  // Clean up sections: remove leading/trailing barlines
  for (const sec of song.sections) {
    while (sec.bars.length && sec.bars[0] === '|') sec.bars.shift();
    while (sec.bars.length && sec.bars[sec.bars.length - 1] === '|') sec.bars.pop();
  }

  // Drop empty sections (keep at least one)
  const nonEmpty = song.sections.filter(s => s.bars.length > 0);
  song.sections = nonEmpty.length ? nonEmpty : [{ label: '- Main', bars: [] }];

  return song;
}

// Detect whether text is an iReal Pro URL
function isIRealProURL(text) {
  return /^irealb:\/\//i.test((text || '').trim());
}

// Import one or more songs from an irealb:// URL.
// Returns a SongModel (single song or merged playlist).
function importIRealPro(text) {
  const url = (text || '').trim();
  if (!isIRealProURL(url)) throw new Error('Not an iReal Pro URL (must start with irealb://)');
  const body = url.replace(/^irealb:\/\//i, '');

  // Songs separated by ===; playlist title may appear as a plain segment
  const parts = body.split('===');
  const songs = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    // Valid song parts have at least 5 = delimiters
    if ((trimmed.match(/=/g) || []).length < 5) continue;
    const song = _irParseSong(trimmed);
    if (song.meta.title || song.sections.some(s => s.bars.length > 0)) songs.push(song);
  }

  if (!songs.length) return null;
  if (songs.length === 1) return songs[0];

  // Playlist: merge into one SongModel with labelled sections per song
  const merged = new SongModel();
  merged.meta.title    = 'iReal Pro Playlist';
  merged.meta.composer = '';
  merged.meta.key      = songs[0].meta.key || '';
  for (const song of songs) {
    for (const sec of song.sections) {
      merged.sections.push({
        ...sec,
        label: `- ${song.meta.title || 'Song'}: ${sec.label.replace(/^-\s*/, '')}`
      });
    }
  }
  return merged;
}

async function readImportedTextFile(file){
  if (!file) return '';
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) return '';

  // BOM-aware decode for MusicXML and other text imports.
  if (bytes.length >= 2){
    if (bytes[0] === 0xFF && bytes[1] === 0xFE){
      return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF){
      return new TextDecoder('utf-16be').decode(bytes);
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF){
    return new TextDecoder('utf-8').decode(bytes);
  }

  const utf8Text = new TextDecoder('utf-8').decode(bytes);
  return normalizeMusicXMLText(utf8Text);
}

/* Regex-based MusicXML fallback — used when DOMParser is unavailable (Node.js / tests). */
// ── MusicXML regex caches ─────────────────────────────────────────────────
// importMusicXMLRegex loops over measures × harmonies and previously compiled
// a fresh RegExp on every tag()/attr() call (~M×H×T compilations on a large
// score). There are only ~12 distinct patterns, so compile each once and reuse
// it for the lifetime of the page/process.
const _mxTagRe = new Map(); // name -> RegExp
const _mxAttrRe = new Map(); // `${tagName}\x00${attrName}` -> RegExp

function _mxGetTagRe(name) {
  let re = _mxTagRe.get(name);
  if (!re) {
    re = new RegExp('<' + name + '[^>]*>([^<]*)</' + name + '>', 'i');
    _mxTagRe.set(name, re);
  }
  return re;
}

function _mxGetAttrRe(tagName, attrName) {
  const key = tagName + '\x00' + attrName;
  let re = _mxAttrRe.get(key);
  if (!re) {
    re = new RegExp('<' + tagName + '[^>]*\\b' + attrName + '=["\']([^"\']*)["\']', 'i');
    _mxAttrRe.set(key, re);
  }
  return re;
}

function importMusicXMLRegex(xmlText){
  const song = new SongModel();
  const t = xmlText || '';

  // Helper: extract text content of a tag (regex compiled once, then cached)
  const tag = (src, name) => {
    const m = src.match(_mxGetTagRe(name));
    return m ? m[1].trim() : '';
  };

  // Helper: extract an attribute value (regex compiled once, then cached)
  const attr = (src, tagName, attrName) => {
    const m = src.match(_mxGetAttrRe(tagName, attrName));
    return m ? m[1].trim() : '';
  };

  // Meta
  song.meta.title = tag(t, 'work-title') || tag(t, 'movement-title') || '';
  const creatorMatch = t.match(/<creator[^>]*type=["']composer["'][^>]*>([^<]*)<\/creator>/i);
  song.meta.composer = creatorMatch ? creatorMatch[1].trim() : (tag(t, 'creator') || '');

  // Time signature
  const attrBlock = t.match(/<attributes>([\s\S]*?)<\/attributes>/i);
  if (attrBlock){
    const beats = tag(attrBlock[1], 'beats');
    const beatType = tag(attrBlock[1], 'beat-type');
    if (beats && beatType) song.meta.time = `${beats}/${beatType}`;
    const fifths = tag(attrBlock[1], 'fifths');
    const mode = tag(attrBlock[1], 'mode');
    song.meta.key = mapMusicXMLFifthsToKey(fifths, mode);
  }

  // Tempo
  const tempoMatch = t.match(/<sound[^>]*tempo=["']([^"']+)["']/i);
  if (tempoMatch){
    const tempoNum = Number(tempoMatch[1]);
    song.meta.tempo = Number.isFinite(tempoNum) ? String(Math.round(tempoNum)) : '';
  }

  // Measures → bars
  const measureRe = /<measure\b[^>]*>([\s\S]*?)<\/measure>/gi;
  const bars = [];
  let mm;
  while ((mm = measureRe.exec(t)) !== null){
    const mContent = mm[1];
    // Extract <harmony> blocks
    const harmRe = /<harmony>([\s\S]*?)<\/harmony>/gi;
    const chords = [];
    let hm;
    while ((hm = harmRe.exec(mContent)) !== null){
      const hBlock = hm[1];
      const step = tag(hBlock, 'root-step');
      const alterRaw = tag(hBlock, 'root-alter');
      if (!step) continue;
      const acc = alterRaw === '1' ? '#' : (alterRaw === '-1' ? 'b' : '');
      let qual = attr(hBlock, 'kind', 'text') || tag(hBlock, 'kind') || '';
      const kindMap = {
        'major':'', 'minor':'m', 'dominant':'7', 'major-seventh':'maj7',
        'minor-seventh':'m7', 'diminished':'dim', 'diminished-seventh':'dim7',
        'augmented':'aug', 'half-diminished':'m7b5'
      };
      if (qual in kindMap) qual = kindMap[qual];
      let chord = `${step}${acc}${qual}`;
      const bassStep = tag(hBlock, 'bass-step');
      const bassAlter = tag(hBlock, 'bass-alter');
      if (bassStep){
        const bassAcc = bassAlter === '1' ? '#' : (bassAlter === '-1' ? 'b' : '');
        chord += `/${bassStep}${bassAcc}`;
      }
      const norm = normalizeChordToken(chord);
      if (norm) chords.push(norm);
    }
    if (!chords.length) bars.push('N.C.');
    else if (chords.length === 1) bars.push(chords[0]);
    else bars.push(chords.join('_'));
  }

  song.sections.push({ label: '- Main', bars });
  return song;
}

function importMusicXML(xmlText){
  try{
    const normalizedText = normalizeMusicXMLText(xmlText || '');
    const parser = new DOMParser();
    const xml = parser.parseFromString(normalizedText, 'application/xml');
    const parseError = xml.querySelector('parsererror');
    // Fallback: if DOMParser doesn't produce useful results (e.g. Node.js stub),
    // use regex-based extraction instead.
    const hasMeasures = xml.querySelectorAll('measure').length > 0;
    if (parseError || !hasMeasures){
      return importMusicXMLRegex(normalizedText);
    }

    const song = new SongModel();
    song.meta.title =
      xml.querySelector('work > work-title')?.textContent?.trim() ||
      xml.querySelector('movement-title')?.textContent?.trim() ||
      xml.querySelector('credit credit-words')?.textContent?.trim() ||
      '';

    song.meta.composer =
      xml.querySelector("identification creator[type='composer']")?.textContent?.trim() ||
      xml.querySelector('identification creator')?.textContent?.trim() ||
      '';

    const firstAttributes = xml.querySelector('measure attributes');
    const timeBeats = firstAttributes?.querySelector('time beats')?.textContent?.trim();
    const timeBeatType = firstAttributes?.querySelector('time beat-type')?.textContent?.trim();
    if (timeBeats && timeBeatType){
      song.meta.time = `${timeBeats}/${timeBeatType}`;
    }

    const keyFifths = firstAttributes?.querySelector('key fifths')?.textContent?.trim();
    const keyMode = firstAttributes?.querySelector('key mode')?.textContent?.trim();
    song.meta.key = mapMusicXMLFifthsToKey(keyFifths, keyMode);

    const tempoNode = xml.querySelector('sound[tempo]') || xml.querySelector('direction sound[tempo]');
    const tempoValue = tempoNode?.getAttribute('tempo');
    if (tempoValue){
      const tempoNum = Number(tempoValue);
      song.meta.tempo = Number.isFinite(tempoNum) ? String(Math.round(tempoNum)) : '';
    }

    const measures = [...xml.querySelectorAll('measure')];
    const bars = [];
    for (const meas of measures){
      const harmonies = [...meas.querySelectorAll('harmony')];
      const chords = harmonies.map((h) => normalizeChordToken(harmonyToChord(h))).filter(Boolean);
      if (!chords.length){
        bars.push('N.C.');
      } else if (chords.length === 1){
        bars.push(chords[0]);
      } else {
        bars.push(chords.join('_'));
      }
    }

    song.sections.push({ label: '- Main', bars });
    setStatus(`Imported MusicXML: ${measures.length} measure(s).`);
    return song;
  }catch(err){
    // Attempt regex fallback before giving up
    try { return importMusicXMLRegex(normalizeMusicXMLText(xmlText)); } catch(_){}
    console.warn('MusicXML import failed:', err);
    setStatus(`MusicXML import failed: ${err?.message || err}`, 'error');
    throw err;
  }
}

function harmonyToChord(h){
  const step = h.querySelector("root root-step")?.textContent?.trim();
  const alter = h.querySelector("root root-alter")?.textContent?.trim();
  if (!step) return '';
  const acc = alter === '1' ? '#' : (alter === '-1' ? 'b' : '');
  const kindText = h.querySelector("kind")?.getAttribute("text")?.trim() || '';
  const kind = h.querySelector("kind")?.textContent?.trim() || '';
  const bassStep = h.querySelector("bass bass-step")?.textContent?.trim();
  const bassAlter = h.querySelector("bass bass-alter")?.textContent?.trim();
  const bassAcc = bassAlter === '1' ? '#' : (bassAlter === '-1' ? 'b' : '');

  // Prefer the text attribute (display hint) when set; fall back to element content
  let qual = kindText || kind || '';
  // Full MusicXML 4.0 kind → CSMPN quality reverse mapping
  const map = {
    'major':              '',
    'minor':              'm',
    'dominant':           '7',
    'major-seventh':      'maj7',
    'minor-seventh':      'm7',
    'diminished':         'dim',
    'diminished-seventh': 'dim7',
    'augmented':          'aug',
    'augmented-seventh':  'aug7',
    'half-diminished':    'm7b5',
    'major-sixth':        '6',
    'minor-sixth':        'm6',
    'dominant-ninth':     '9',
    'major-ninth':        'maj9',
    'minor-ninth':        'm9',
    'dominant-11th':      '11',
    'major-11th':         'maj11',
    'minor-11th':         'm11',
    'dominant-13th':      '13',
    'major-13th':         'maj13',
    'minor-13th':         'm13',
    'suspended-second':   'sus2',
    'suspended-fourth':   'sus4',
    'power':              '5',
    'none':               '',
  };
  if (qual in map) qual = map[qual];

  let chord = `${step}${acc}${qual}`;
  if (bassStep) chord += `/${bassStep}${bassAcc}`;
  return chord;
}

function stripTokenDecorators(t){
  return (t || '')
    .replace(/^\(+/,'')
    .replace(/\)+$/,'')
    .replace(/x\d+$/i,'')
    .replace(/^<{1,2}/,'')       // push notation prefix
    .replace(/<>$/,'')            // diamond suffix
    .replace(/\s+diamond$/i,'')   // diamond word suffix
    .replace(/\s+fermata$/i,'')   // fermata suffix
    .replace(/\^$/,'')            // tie suffix
    .replace(/,+$/,'')            // stroke suffixes
    .replace(/"[^"]*"/g,'')       // annotations
    .trim();
}

// isChordToken: alias used throughout for basic chord detection.
function isChordToken(tok){
  return isChordLikeToken(tok);
}

// Stricter chord token detection to avoid false positives from PDF text (e.g., section labels).
function isChordLikeToken(tok){
  if (!tok) return false;
  let t = normalizeAccidentals(tok)
    .replace(/\u200B/g,'')
    .trim();

  if (t === '%' || t === '%%' || /^%\d+$/.test(t)) return true;
  if (t === '*') return true;
  if (/^r[124]$/i.test(t)) return true;
  const upper = t.toUpperCase();
  if (upper === 'N.C.' || upper === 'NC') return true;
  if (upper === 'FINE' || /^D\.?C\.?/i.test(t) || /^D\.?S\.?/i.test(t) || /^DACAPO/i.test(t) || /^DALSEGNO/i.test(t)) return true;

  t = stripTokenDecorators(t);
  if (!t) return false;

  // Lowercase root = minor (e.g., a, bb, eb7)
  if (/^[a-g]/.test(t)) t = t[0].toUpperCase() + t.slice(1);

  const m = t.match(/^([A-G])([b#]?)(.*)$/);
  if (!m) return false;

  const rest = m[3] || '';
  if (!rest) return true;

  const rl = rest.toLowerCase();

  const startsOk =
    /^[0-9#b\/()+.,-]/.test(rest) ||
    rl.startsWith('m') ||
    rl.startsWith('maj') ||
    rl.startsWith('min') ||
    rl.startsWith('ami') ||
    rl === '-' || rl.startsWith('-') ||
    rl.startsWith('dim') ||
    rl.startsWith('aug') ||
    rl.startsWith('sus') ||
    rl.startsWith('add') ||
    rl.startsWith('alt') ||
    rl.startsWith('omit') ||
    rl.startsWith('no');

  if (!startsOk) return false;

  if (/^[a-z]+$/i.test(rest) && rest.length > 3){
    if (!/^(maj|min|ami|amin|dim|aug|sus|add|alt|omit|no|m)$/.test(rl)) return false;
  }

  return /^[A-Za-z0-9#b\/()+.,\-ΔøØ°º]*$/.test(rest);
}

function isChordLikeTokenPDF(tok){
  if (!isChordLikeToken(tok)) return false;
  const t = stripTokenDecorators(normalizeAccidentals(tok));
  if (/^[A-G][a-z]{4,}$/i.test(t) && !/[0-9#b]/.test(t)) return false;
  return true;
}



// normalizeChordToken: clean up a raw chord token for CSMPN output.
function normalizeChordToken(tok){
  if (!tok) return '';
  let t = normalizeAccidentals(tok).trim();
  t = stripTokenDecorators(t);
  if (!t) return '';
  if (!isChordLikeToken(t) && t !== '%' && t !== '%%') return '';
  return t;
}

function toCSMPNBars(chords){
  // chords array -> lines of 4 bars
  const toks = chords.map(c => normalizeAccidentals(c)).filter(Boolean);
  const out = [];
  for (let i=0;i<toks.length;i+=4){
    out.push(toks.slice(i,i+4).join(' '));
  }
  return out.join('\n');
}

/* =========================================================
   ChordPro {start_of_grid} line parser
   Converts one grid row like:
     | [F] . . . | [E-7b5] . [A7] . | [Dm] . [G7] . |
   into an array of CSMPN bar tokens: ['F', 'Em7b5_A7', 'Dm_G7']
   Multiple chords in one measure are joined with _ (split-bar).
   Handles iReal-style minor (-7, -) and half-dim (h) notation.
========================================================= */
function parseChordProGridLine(line) {
  const measures = line.split('|');
  const bars = [];
  for (const cell of measures) {
    const cellTrimmed = cell.trim();
    if (!cellTrimmed) continue; // skip empty before first | and after last |
    const chordRe = /\[([^\]]+)\]/g;
    const chords = [];
    let m;
    while ((m = chordRe.exec(cellTrimmed)) !== null) {
      const raw = normalizeAccidentals(m[1].trim());
      if (!raw) continue;
      // _irConvertChordName handles iReal-style: E-7b5→Em7b5, Dh→Dm7b5, etc.
      const converted = /^[A-G]/.test(raw) ? _irConvertChordName(raw) : raw;
      const tok = normalizeChordToken(converted || raw);
      if (tok && isChordLikeToken(tok)) chords.push(tok);
    }
    if (!chords.length) continue;
    // 1 chord: whole measure; 2+ chords: split-bar with _
    bars.push(chords.join('_'));
  }
  return bars;
}


/* =========================================================
   PDF Import (UG Pro / ChordSheet PDFs)
   - Uses PDF.js text extraction
   - Prefers barline reconstruction when PDFs contain | / ‖ / ǁ
   - Falls back to spatial clustering for "floating chord glyph" PDFs
========================================================= */

// ── Binary format sniffing ────────────────────────────────────────────────────
// Files from the UG app / iOS share sheet sometimes arrive without a useful
// extension. Identify the real format from magic bytes so the file input can
// route them exactly as if they were named correctly.
// Returns '.gp' | '.gp5' | '.gpx' | '.ptb' | '.mid' | '.mxl' | '.pdf' | '.xml' | ''.
function sniffBinaryMusicExt(bytes){
  if (!bytes || bytes.length < 4) return '';
  const ascii = (start, len) => {
    let s = '';
    const end = Math.min(start + len, bytes.length);
    for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
    return s;
  };
  const head4 = ascii(0, 4);
  if (head4 === 'BCFZ' || head4 === 'BCFS') return '.gpx'; // GP6 container
  if (head4 === 'ptab') return '.ptb'; // Power Tab
  if (head4 === 'MThd') return '.mid'; // Standard MIDI File
  if (head4 === '%PDF') return '.pdf';
  // GP3/4/5: a length-prefixed "FICHIER GUITAR PRO vX.XX" version string
  if (ascii(1, 18) === 'FICHIER GUITAR PRO') return '.gp5';
  if (head4.slice(0, 2) === 'PK'){
    // ZIP container: GP7/8 (.gp) holds Content/score.gpif (stored first);
    // compressed MusicXML (.mxl) must lead with META-INF/container.xml.
    const probe = ascii(0, 65536);
    if (probe.includes('score.gpif')) return '.gp';
    if (probe.includes('container.xml') || probe.includes('META-INF')) return '.mxl';
    return '';
  }
  const textHead = ascii(0, 256).replace(/^\xEF\xBB\xBF/, '').trimStart();
  if (/^<\?xml|^<score-partwise|^<opus/i.test(textHead)) return '.xml';
  return '';
}

// ── Reliable binary file reads (iOS Safari) ───────────────────────────────────
// iOS Safari can hand the page an empty or partial buffer for a file that has
// not finished downloading to the device (iCloud Drive placeholders, lazy
// Files-app providers). The resulting truncated bytes then fail deep inside a
// parser with a cryptic error that blames the file. Read once, re-read if the
// buffer is visibly short of file.size, and fail with an actionable message
// instead of letting the parser crash.
async function readFileBytesReliably(file){
  let buf = await file.arrayBuffer();
  if (file.size && buf.byteLength < file.size){
    buf = await file.arrayBuffer(); // one retry usually settles a lazy provider
  }
  if (buf.byteLength === 0 || (file.size && buf.byteLength < file.size)){
    throw new Error(
      `"${file.name}" arrived ${buf.byteLength === 0 ? 'empty (0 bytes)' : `incomplete (${buf.byteLength} of ${file.size} bytes)`}. ` +
        'The file has probably not downloaded to this device yet — if it is in iCloud Drive, ' +
        'open it in the Files app first so it downloads, then import it again.'
    );
  }
  return buf;
}

// ── UG Pro (Guitar Pro–rendered) PDF pure helpers ────────────────────────────

// SMuFL chord-symbol accidentals (the "csym" range MuseScore/UG Pro engraving
// uses INSIDE chord symbol text — distinct from the staff accidentals at
// U+E260-E262, which we leave alone so notation glyphs can't pollute chords).
// "B" + U+ED60 is how a UG Pro PDF spells "Bb"; without this translation the
// flat glyph is dropped and every Bb imports as a plain B.
function translateChordSymbolGlyphs(s){
  return (s ?? '')
    .replace(/\uED60/g, 'b') // csym flat
    .replace(/\uED61/g, '') // csym natural (chord "B-natural" -> "B")
    .replace(/\uED62/g, '#') // csym sharp
    .replace(/\uED63/g, '##') // csym double sharp
    .replace(/\uED64/g, 'bb'); // csym double flat
}

// "[Verse 1]" / "[Pre-Chorus]" / "[First Solo]" section labels as UG Pro PDFs
// print them. Returns the inner label, or null when the text isn't a bracketed
// section (inline bracket chords like "[A7]" stay chords).
function extractPdfSectionLabel(s){
  const m = (s ?? '').trim().match(/^\[([A-Za-z][A-Za-z0-9 .'&\/-]{0,38})\]$/);
  if (!m) return null;
  const inner = m[1].trim();
  if (!inner || isChordLikeToken(inner)) return null;
  return inner;
}

// Metronome tempo marks: a metronome-note SMuFL glyph (e.g. U+ECA5) followed by
// "= 149", or the "= 149" span alone. Returns the integer BPM string or null.
function pdfTempoFromText(s){
  const m = (s ?? '').trim().match(/^[\uE000-\uF8FF\s]*=\s*(\d{2,3})(?:\.\d+)?$/);
  if (!m) return null;
  const bpm = Number(m[1]);
  return bpm >= 30 && bpm <= 300 ? String(bpm) : null;
}

// SMuFL time-signature digits (U+E080–E089) are stacked at the same x on the
// staff. Group them into rows by y, read multi-digit rows left-to-right, and
// return "num/den" from the top two rows (e.g. "4/4", "12/8") or null.
function detectSmuflTimeSigFromItems(items){
  const digits = [];
  for (const it of items || []){
    const t = (it.str ?? '').trim();
    if (t.length !== 1) continue;
    const c = t.codePointAt(0);
    if (c >= 0xe080 && c <= 0xe089) digits.push({ d: c - 0xe080, x: it.x, y: it.y });
  }
  if (digits.length < 2) return null;
  // Cluster into y-rows (±4 pt of the row's first digit)
  digits.sort((a, b) => b.y - a.y);
  const rows = [];
  for (const g of digits){
    const row = rows.length ? rows[rows.length - 1] : null;
    if (!row || row.y - g.y > 4) rows.push({ y: g.y, digits: [g] });
    else row.digits.push(g);
  }
  if (rows.length < 2) return null;
  const readRow = (row) => Number(row.digits.sort((a, b) => a.x - b.x).map((g) => g.d).join(''));
  const num = readRow(rows[0]);
  const den = readRow(rows[1]);
  if (!(num >= 1 && num <= 32)) return null;
  if (![1, 2, 4, 8, 16, 32].includes(den)) return null;
  return num + '/' + den;
}
// A printed chord symbol in a PDF text layer. Deliberately strict: it decides
// whether a PDF states its harmony in words (the two chord-text importers) or
// only as fret numbers (the tab-geometry path), so a stray "A" of lyric text
// must not read as a chord.
const CHORD_TEXT_RE =
  /^[A-G][b#♭♯]?(maj|min|dim|aug|sus|add|m|M|Δ|°|ø|\+|-)?\d*(sus\d?|add\d+|b\d+|#\d+)*(\/[A-G][b#♭♯]?)?$/;

async function importUGProPDF(file){
  if (!window.pdfjsLib) throw new Error("PDF.js not loaded.");
  statusEl.textContent = "Reading PDF…";
  const arrayBuffer = await file.arrayBuffer();
  const pdfOpts = { data: arrayBuffer };
  // If the worker cannot be configured (common on iOS Safari), fall back to no-worker mode.
  try {
    if (!pdfjsLib?.GlobalWorkerOptions?.workerSrc) pdfOpts.disableWorker = true;
  } catch (e) {
    pdfOpts.disableWorker = true;
  }
  const loadingTask = pdfjsLib.getDocument(pdfOpts);
  const pdf = await loadingTask.promise;

  // chordsheet.com fakebook PDFs use a private-use music font (not plain text) —
  // detect and decode them directly into CSMPN before the UG-Pro geometry path.
  if (window.ChordsheetPdf) {
    try {
      const csParts = [];
      for (let cp = 1; cp <= pdf.numPages; cp++) {
        const ctc = await (await pdf.getPage(cp)).getTextContent();
        const cits = ctc.items.map((it) => ({
          str: (it.str ?? "").toString(),
          x: it.transform?.[4] ?? 0,
          y: it.transform?.[5] ?? 0,
          w: Math.abs(it.width ?? 0),
          fontSize: Math.hypot(it.transform?.[0] ?? 12, it.transform?.[1] ?? 0) || 12,
        }));
        csParts.push(window.ChordsheetPdf.groupItemsIntoText(cits));
      }
      const csText = csParts.join("\n");
      if (window.ChordsheetPdf.isChordsheetText(csText)) {
        statusEl.textContent = "Importing chordsheet.com fakebook…";
        return window.ChordsheetPdf.chordsheetTextToCsmpn(csText, {
          barsPerRow: fbSettings.barsPerRow,
        });
      }
    } catch (csErr) {
      /* not a chordsheet.com PDF — fall through to the UG-Pro importer */
    }
  }

  // A tab PDF (alphaTab / Guitar Pro export) prints notation and TAB but NO
  // chord symbols — the harmony only exists as fret numbers. Both importers
  // below look for chord text, so they can only ever fail on one. The engine's
  // geometry parser reads the digits instead and names what each column sounds.
  // Runs only when the page really has no chord symbols, so no PDF that imports
  // today changes route.
  if (window.RecognitionBridge && window.RecognitionBridge.importTabPdf) {
    try {
      const tabTokens = [];
      let sawChordText = false;
      for (let tp = 1; tp <= pdf.numPages; tp++) {
        const page = await pdf.getPage(tp);
        const base = page.getViewport({ scale: 1 });
        // Raw page coordinates: the engine derives its thresholds from the modal
        // gap between string lines, so it reads a 4209pt Guitar Pro export and a
        // 792pt page alike. (Coordinates used to be pre-scaled here to work around
        // an engine that only measured gaps under 20pt; that is fixed upstream.)
        const height = base.height;
        const items = (await page.getTextContent()).items;
        for (const it of items) {
          const str = (it.str ?? '').trim();
          if (!str) continue;
          if (/^\d+$/.test(str)) {
            tabTokens.push({
              page: tp,
              x: it.transform?.[4] ?? 0,
              y: height - (it.transform?.[5] ?? 0), // parser wants y downward
              val: parseInt(str, 10),
            });
          } else if (CHORD_TEXT_RE.test(str)) {
            sawChordText = true;
          }
        }
      }
      if (!sawChordText && tabTokens.length >= 12) {
        statusEl.textContent = 'Reading tab geometry…';
        const tab = await window.RecognitionBridge.importTabPdf(tabTokens, {
          title: (file.name || '').replace(/\.[A-Za-z0-9]{1,6}$/, ''),
        });
        if (tab) {
          if (importDiagnostics) {
            importDiagnostics.miner = 'Tab PDF';
            importDiagnostics.sourceFlavor = 'tabpdf';
            importDiagnostics.confidence = 'medium';
            importDiagnostics.sections = tab.summary.sections;
            importDiagnostics.bars = tab.summary.bars;
            importDiagnostics.warnings.push(
              'This PDF prints tab but no chord symbols, so the chords were read from the ' +
                'fret numbers. Partial voicings name what is written (F5, Fdim/B), which is ' +
                'not always the chord the band plays — worth a pass before you gig it.'
            );
          }
          return tab.csmpn;
        }
      }
    } catch (tabErr) {
      /* not readable as a tab PDF — fall through to the UG-Pro importer */
    }
  }

  const meta = { title:"", composer:"", style:"", tempo:"", time:"", key:"" };
  const bodyLines = [];
  const extractedTextLines = [];
  const pageBoundaries = [];
  let pendingBars = [];
  let usedSharedTextFallback = false;
  let inferredGrouping = false;
  let totalTextItems = 0;
  // UG Pro (Guitar Pro–rendered) PDFs: state for title→artist capture and
  // "this is really a tab PDF" guidance.
  let awaitComposerLine = false;
  let sawGpNotationGlyphs = false;

  const flushBars = () => {
    while (pendingBars.length){
      bodyLines.push(pendingBars.splice(0,4).join(" "));
    }
  };

  const normLine = (s) => (s ?? "").toString()
    .replace(/\u00A0/g, " ")
    .replace(/[ǁ∥]/g, "||")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const isBarToken = (t) => /^(\|{1,2})$/.test(t);

  const splitTokens = (line) => {
    // Ensure barlines are tokenized
    let s = normLine(line);
    s = s.replace(/(\|{1,2})/g, " $1 ");
    return s.split(" ").filter(Boolean);
  };

  const looksLikeSection = (line, tokens, chordCount) => {
    if (!line) return false;
    if (chordCount > 0) return false;
    if (line.length > 48) return false;
    // UG Pro PDFs bracket their markers: "[Verse 1]", "[Pre-Chorus]"
    line = line.replace(/^\[(.+)\]$/, '$1').trim();
    // common section words or "Chorus1" style
    if (/^(intro|verse|chorus|bridge|solo|tag|ending|outro|interlude|pre[-\s]?chorus|turnaround)\b/i.test(line)) return true;
    if (/\b(solo|breakdown|refrain|instrumental)\b/i.test(line) && line.length <= 32) return true;
    if (/^(chorus|verse|bridge|solo)\s*\d+$/i.test(line)) return true;
    // ALL CAPS markers like DOUBLE-TIME
    if (/^[A-Z][A-Z0-9\-\s]{3,}$/.test(line) && !/TITLE|COMPOSER|STYLE|TEMPO|TIME|KEY/.test(line)) return true;
    // "ENDXXXX" marker
    if (/^END[A-Z0-9\-]+$/.test(line)) return true;
    return false;
  };

  const parseHeaderFromLine = (line) => {
    const m1 = line.match(/^\s*Title:\s*(.*)$/i);
    if (m1) { meta.title = m1[1].trim(); return true; }
    const m2 = line.match(/^\s*(Composer|Artist):\s*(.*)$/i);
    if (m2) { meta.composer = m2[2].trim(); return true; }
    const m3 = line.match(/^\s*Style:\s*(.*)$/i);
    if (m3) { meta.style = m3[1].trim(); return true; }
    const m4 = line.match(/^\s*Tempo:\s*(.*)$/i);
    if (m4) { meta.tempo = m4[1].trim(); return true; }
    const m5 = line.match(/^\s*Time:\s*(.*)$/i);
    if (m5) { meta.time = m5[1].trim(); return true; }
    const m6 = line.match(/^\s*Key:\s*(.*)$/i);
    if (m6) { meta.key = m6[1].trim(); return true; }
    return false;
  };

  for (let p = 1; p <= pdf.numPages; p++){
    statusEl.textContent = `Parsing PDF… page ${p}/${pdf.numPages}`;
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    // Pre-filter metadata spans so they don't pollute chord detection.
    // "Tuning : E A D G B E" in UG Pro PDFs matches isChordToken for each
    // string-name letter (E, A, D, G, B, E), producing 6 garbage bars.
    const PDF_META_SKIP_RE = /^\s*(Tuning|Capo|Difficulty|Transcribed|Transcription|Author|Arranger|Engraved?r?)\s*[:\s]/i;
    const allPageItems = tc.items
      .map(it => ({
        // Translate SMuFL chord-symbol accidentals up front so "B"+flat-glyph
        // clusters into "Bb" instead of dropping the flat.
        str: translateChordSymbolGlyphs((it.str ?? "").toString()),
        x: it.transform[4] ?? 0,
        y: it.transform[5] ?? 0,
        w: Math.abs(it.width ?? 0),
        fontSize: Math.hypot(it.transform[0], it.transform[1]) || 12
      }))
      .filter(it => it.str && it.str.trim());
    totalTextItems += allPageItems.length;
    pageBoundaries.push({ page: p, startLine: extractedTextLines.length });

    // Detect Guitar Pro–style engraving (clef / notehead SMuFL glyphs) so we
    // can suggest importing the original .gp file instead of its printout.
    if (!sawGpNotationGlyphs) {
      sawGpNotationGlyphs = allPageItems.some(it => {
        const c = it.str.trim().codePointAt(0);
        return it.str.trim().length === 1 && c >= 0xe050 && c <= 0xe0ff;
      });
    }

    // Metronome tempo marks ("<note-glyph> = 149") — first one wins.
    for (const it of allPageItems) {
      if (meta.tempo) break;
      const bpm = pdfTempoFromText(it.str);
      if (bpm) meta.tempo = bpm;
    }

    // SMuFL time-signature digits stacked on the staff (e.g. 4 over 4).
    if (!meta.time) {
      const ts = detectSmuflTimeSigFromItems(allPageItems);
      if (ts) meta.time = ts;
    }

    // Strip metadata spans before clustering (tuning lines, capo lines, etc.),
    // plus tempo marks so "= 149" never lands in a chord line.
    const metaFiltered = allPageItems.filter(it =>
      !PDF_META_SKIP_RE.test(it.str) && !pdfTempoFromText(it.str));

    // Pull out "[Verse 1]"-style section labels before clustering — they sit
    // on the same y-band as the first chords of their system, so they must be
    // interleaved by position rather than parsed as text lines.
    const pageSectionMarks = [];
    const sectionFiltered = [];
    for (const it of metaFiltered) {
      const label = extractPdfSectionLabel(it.str);
      if (label) pageSectionMarks.push({ y: it.y, label });
      else sectionFiltered.push(it);
    }
    pageSectionMarks.sort((a, b) => b.y - a.y);

    // Detect and remove guitar tab string-label columns.
    // In tab PDFs the string names (e B G D A E) appear as a vertical column
    // of single [A-G] letters at the same x-position — each passes isChordToken
    // as a single-letter chord, inflating bar counts by ~6 per system.
    // Heuristic: if 5+ single [A-G] letters share an x-bucket (±10 pt) and
    // any 5 consecutive ones (by y) span ≤ 30 pt, treat that x as a string-
    // label column and remove its single-letter items.
    const _xBuckets = new Map();
    for (const it of sectionFiltered) {
      const s = it.str.trim();
      if (s.length === 1 && /^[A-Ga-g]$/.test(s)) {
        const xk = Math.round(it.x / 10) * 10;
        if (!_xBuckets.has(xk)) _xBuckets.set(xk, []);
        _xBuckets.get(xk).push(it.y);
      }
    }
    const _tabLabelXSet = new Set();
    for (const [xk, ys] of _xBuckets) {
      const sorted = ys.slice().sort((a, b) => a - b);
      for (let i = 0; i <= sorted.length - 5; i++) {
        if (sorted[i + 4] - sorted[i] <= 30) { _tabLabelXSet.add(xk); break; }
      }
    }
    let items = _tabLabelXSet.size > 0
      ? sectionFiltered.filter(it => {
          const s = it.str.trim();
          if (s.length !== 1 || !/^[A-Ga-g]$/.test(s)) return true;
          return !_tabLabelXSet.has(Math.round(it.x / 10) * 10);
        })
      : sectionFiltered;

    // Font-size floor: chord symbols are in a noticeably larger font than
    // measure numbers, fret numbers, and small annotations (fingerings, bowing
    // marks, etc.). Use 65% of the median 1-3-char chord-root span size as the
    // floor and discard everything below it.
    let _medianRootSize = 0;
    {
      const _rootSamples = items.filter(it => {
        const s = it.str.trim();
        return /^[A-Ga-g]/.test(s) && s.length <= 3;
      });
      if (_rootSamples.length >= 3) {
        const _sizes = _rootSamples.map(it => it.fontSize).sort((a, b) => a - b);
        const _median = _sizes[Math.floor(_sizes.length / 2)];
        _medianRootSize = _median;
        const _floor = _median * 0.65;
        items = items.filter(it => it.fontSize >= _floor);
      }
    }

    // Threshold-based y-clustering replaces the old 0.5pt fixed-bucket approach.
    // MuseScore chord symbols in the same staff system can sit at slightly
    // different heights (up to ~15 pt due to collision avoidance), causing
    // 0.5pt buckets to produce separate lines with wrong chord ordering.
    // Group all spans within the threshold of the first span in each group,
    // then sort each group by x (left-to-right) for correct reading order.
    // The threshold scales with the chord font: UG Pro exports render at a
    // large user-unit scale (chord font ≈ 40) where collision-avoidance
    // offsets exceed a fixed 20 pt and scramble the chord order.
    const CHORD_Y_THRESHOLD = Math.max(20, _medianRootSize * 1.25);
    items.sort((a, b) => b.y - a.y); // descending: top of page first
    const lineGroups = [];
    for (const it of items) {
      const last = lineGroups.length ? lineGroups[lineGroups.length - 1] : null;
      if (!last || (last.refY - it.y) > CHORD_Y_THRESHOLD) {
        lineGroups.push({ refY: it.y, items: [] });
      }
      lineGroups[lineGroups.length - 1].items.push(it);
    }

    let sectionMarkIdx = 0;
    const flushSectionMarksAbove = (yLimit) => {
      while (
        sectionMarkIdx < pageSectionMarks.length &&
        pageSectionMarks[sectionMarkIdx].y >= yLimit
      ) {
        flushBars();
        bodyLines.push(`- ${pageSectionMarks[sectionMarkIdx].label}`);
        sectionMarkIdx++;
      }
    };

    for (const lg of lineGroups) {
      // Emit any section label sitting above (or within the band of) this
      // line group before its chords, preserving chart order.
      flushSectionMarksAbove(lg.refY - CHORD_Y_THRESHOLD);
      const lineItems = lg.items.slice().sort((a, b) => a.x - b.x);

      // Two-phase chord-fragment reconstruction:
      //
      // Phase 1 — tight clustering (≤ 5 pt gap): group spans that are
      // physically adjacent into raw clusters. This captures all the pieces
      // of a single chord symbol even when individual pieces happen to be
      // standalone valid chords (e.g. "G"+"a"+"d"+"d"+"9" for Gadd9, or
      // "E"+"b"+"7M" for Eb7M where "b" alone would be "B minor").
      //
      // Phase 2 — cluster validation: if the cluster's combined text is a
      // valid chord token, emit it as one token. If not (two genuinely
      // separate chords happened to land within 5pt), fall back to a greedy
      // left-to-right merge of the cluster's individual parts using the
      // original suffix-only rule (don't merge if the suffix is itself a
      // valid standalone chord at > 5pt gap).
      const INTRA_GAP = 5;
      const rawClusters = [];
      for (const it of lineItems) {
        const s = it.str.trim();
        if (!s) continue;
        const prev = rawClusters[rawClusters.length - 1];
        const gap = prev ? it.x - (prev.x + prev.w) : Infinity;
        if (prev && gap < INTRA_GAP) {
          prev.str += s;
          prev.w = it.x + it.w - prev.x;
          prev.parts.push(s);
        } else {
          rawClusters.push({ str: s, x: it.x, w: it.w, parts: [s] });
        }
      }

      const mergedSpans = [];
      for (const cl of rawClusters) {
        if (cl.parts.length === 1 || isChordLikeTokenPDF(cl.str)) {
          mergedSpans.push({ str: cl.str });
        } else {
          // Cluster as a whole is not a valid chord — greedy sub-merge
          let acc = null;
          for (const part of cl.parts) {
            if (acc === null) {
              acc = part;
            } else {
              const combined = acc + part;
              if (!isChordLikeTokenPDF(part) && isChordLikeTokenPDF(combined)) {
                acc = combined;
              } else {
                mergedSpans.push({ str: acc });
                acc = part;
              }
            }
          }
          if (acc !== null) mergedSpans.push({ str: acc });
        }
      }

      const rawLine = mergedSpans.map(sp => sp.str).join(' ');
      const line = normLine(rawLine);
      if (!line) continue;
      extractedTextLines.push(line);

      // header lines
      if (parseHeaderFromLine(line)) continue;

      const tokens = splitTokens(line);
      const chordTokens = tokens.filter(t => isChordToken(t));
      const chordCount = chordTokens.length;

      // If line has no chords: maybe title / artist / section / ignore
      if (chordCount === 0){
        // candidate title line near top of doc
        if (!meta.title && line.length <= 80 && !line.includes(":") && !/^(page\s*\d+)/i.test(line)){
          meta.title = line;
          // UG Pro layout puts the artist directly under the title on page 1.
          awaitComposerLine = p === 1;
          continue;
        }
        // "Words and Music by …" credit lines anywhere on page 1
        if (!meta.composer && p === 1){
          const credit = line.match(/^(?:words\s+(?:and|&)\s+music\s+by|music\s+by|written\s+by)\s+(.{2,60})$/i);
          if (credit){
            meta.composer = credit[1].trim();
            awaitComposerLine = false;
            continue;
          }
        }
        if (looksLikeSection(line, tokens, chordCount)){
          awaitComposerLine = false;
          flushBars();
          let label = line.replace(/^\[(.+)\]$/, '$1').trim();
          if (/^END([A-Z0-9\-]+)$/.test(label)){
            label = "End " + label.replace(/^END/i,"").replace(/_/g," ");
          }
          bodyLines.push(`- ${label}`);
          continue;
        }
        // The first plain line after the title on page 1 is the artist
        // (UG Pro prints "Sultans Of Swing" / "Dire Straits" stacked).
        if (awaitComposerLine){
          awaitComposerLine = false;
          if (
            !meta.composer &&
            line.length <= 60 &&
            !line.includes(":") &&
            !/^[\[=\d(]/.test(line) &&
            !/^(page|http|www\.)/i.test(line) &&
            /[A-Za-z]{2}/.test(line)
          ){
            meta.composer = line;
          }
          continue;
        }
        continue;
      }
      awaitComposerLine = false;

      // chord line: build bars
      let bars = [];
      if (tokens.some(t => isBarToken(t))){
        let seg = [];
        for (const t of tokens){
          if (isBarToken(t)){
            if (seg.length){
              bars.push(seg.join("_"));
              seg = [];
            } else {
              // consecutive bars -> empty bar; skip
            }
            continue;
          }
          if (isChordToken(t)) seg.push(t);
        }
        if (seg.length) bars.push(seg.join("_"));
      } else {
        // No explicit bars: assume each chord is a bar
        bars = chordTokens.slice();
        if (bars.length >= 3) inferredGrouping = true;
      }

      // Append bars
      for (const b of bars){
        if (!b) continue;
        pendingBars.push(b);
      }
    }

    // A section label at the very bottom of the page (bars continue on the
    // next page) still needs to be emitted.
    flushSectionMarksAbove(-Infinity);
  }

  flushBars();
  attachImportDiagnostics({ pagesProcessed: pdf.numPages });

  // No key in the text layer (typical for tab PDFs): infer it from the chords.
  if (!meta.key){
    const keyChords = [];
    for (const bl of bodyLines){
      if (bl.startsWith('- ')) continue;
      for (const tok of bl.split(/\s+/)){
        for (const part of tok.split('_')){
          if (part && part !== '%' && /^[A-G]/.test(part) && isChordToken(part)){
            keyChords.push(normalizeAccidentals(part));
          }
        }
      }
    }
    const CT = typeof window !== 'undefined' ? window.ChordTheory : null;
    if (CT && typeof CT.inferKeyFromChords === 'function' && keyChords.length >= 4){
      const inferredKey = CT.inferKeyFromChords(keyChords);
      if (inferredKey) meta.key = inferredKey;
    }
  }

  if (sawGpNotationGlyphs){
    importDiagnostics.warnings.push(
      'This PDF looks like a rendered Guitar Pro tab. Importing the original ' +
      'Guitar Pro file (Import ▾ → Guitar Pro, .gp/.gpx) gives an exact conversion.'
    );
  }

  if (!totalTextItems || !extractedTextLines.length){
    attachImportDiagnostics({
      sourceFlavor: 'pdf-omr-needed',
      confidence: 'high',
      omrRequired: true,
      warnings: ['Image-only / OMR-required PDF. Text-layer chord extraction unavailable.']
    });
    throw new Error('Image-only / OMR-required PDF. Text-layer chord extraction unavailable.');
  }

  // Apply normalization / validation to meta and sync UI
  const hdrText = [
    meta.title ? `Title: ${meta.title}` : "",
    meta.composer ? `Composer: ${meta.composer}` : "",
    meta.style ? `Style: ${meta.style}` : "",
    meta.tempo ? `Tempo: ${meta.tempo}` : "",
    meta.time ? `Time: ${meta.time}` : "",
    meta.key ? `Key: ${meta.key}` : ""
  ].filter(Boolean).join("\n");

  // This will sanitize and populate form fields.
  extractHeaderFromText(hdrText, true);

  const hdrVals = readHeaderInputs();
  const hdrLines = [];
  if (hdrVals.title) hdrLines.push(`Title: ${hdrVals.title}`);
  if (hdrVals.composer) hdrLines.push(`Composer: ${hdrVals.composer}`);
  if (hdrVals.style) hdrLines.push(`Style: ${hdrVals.style}`);
  if (hdrVals.tempo) hdrLines.push(`Tempo: ${hdrVals.tempo}`);
  if (hdrVals.time) hdrLines.push(`Time: ${hdrVals.time}`);
  if (hdrVals.key) hdrLines.push(`Key: ${hdrVals.key}`);
  let out = hdrLines.join("\n");
  if (out) out += "\n\n";
  out += bodyLines.join("\n");

  let chordBars = bodyLines.join(" ").split(/\s+/).filter(t => isChordToken(t) || t.includes("_") || t === "%");
  if (!chordBars.length && extractedTextLines.length){
    const filteredFallbackLines = extractedTextLines.filter((line) => {
      const s = (line || '').trim();
      if (!s) return false;
      if (/^(page\s+\d+|\d+\s*\/\s*\d+)$/i.test(s)) return false;
      if (/^(copyright|all rights reserved|ultimate-guitar\.com)/i.test(s)) return false;
      if (s.length > 140) return false;
      if (/[a-z]{8,}\s+[a-z]{8,}\s+[a-z]{8,}/i.test(s) && !hasInlineBracketChords(s) && !isLikelyUGChordLine(s)) return false;
      return true;
    });
    const pageAwareLines = [];
    for (let bi = 0; bi < pageBoundaries.length; bi++){
      const boundary = pageBoundaries[bi];
      const nextBoundary = pageBoundaries[bi + 1];
      const start = boundary.startLine;
      const end = nextBoundary ? nextBoundary.startLine : extractedTextLines.length;
      const perPageLines = extractedTextLines.slice(start, end).filter((line) => filteredFallbackLines.includes(line));
      if (!perPageLines.length) continue;
      pageAwareLines.push(`[Page ${boundary.page}]`);
      pageAwareLines.push(...perPageLines.slice(0, 250));
    }
    const sharedText = pageAwareLines.join('\n');
    const pipeline = runSharedTextImportPipeline(sharedText);
    const fallbackCsmpn = pipeline.csmpnLegacy || '';
    if (fallbackCsmpn){
      usedSharedTextFallback = true;
      out = [hdrLines.join('\n'), fallbackCsmpn].filter(Boolean).join('\n\n').trim();
      chordBars = fallbackCsmpn.split(/\s+/).filter((t) => isChordToken(t) || t.includes('_') || t === '%');
      inferredGrouping = inferredGrouping || !!pipeline.groupingInferred;
      attachImportDiagnostics({
        sourceFlavor: 'pdf-extracted-text-noisy',
        confidence: 'medium',
        groupingInferred: inferredGrouping,
        fallbackUsed: true,
        warnings: pipeline.warnings
      });
    }
  }
  if (usedSharedTextFallback){
    importDiagnostics.warnings.push('PDF spatial extraction weak; used shared-text fallback recovery.');
  }
  if (!usedSharedTextFallback){
    const noisy = extractedTextLines.length > 180 || (chordBars.length / Math.max(1, extractedTextLines.length)) < 0.35;
    attachImportDiagnostics({
      sourceFlavor: noisy ? 'pdf-extracted-text-noisy' : 'pdf-extracted-text-clean',
      confidence: noisy ? 'medium' : 'high',
      groupingInferred: inferredGrouping
    });
    if (noisy){
      importDiagnostics.warnings.push('Noisy PDF text layer detected; some lines were ignored during chord mining.');
    }
  }
  statusEl.textContent = `PDF import: ${chordBars.length} bar(s) extracted from ${pdf.numPages} page(s).` +
    (sawGpNotationGlyphs ? ' Tip: importing the original Guitar Pro file gives an exact conversion.' : '');

  return out.trim();
}

const HYBRID_DURATION_MAP = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };
const HYBRID_SYNTAX_SPEC = Object.freeze({
  block: '{hybrid ... }',
  barLine: 'barN: <event...>  (alias: bN:)',
  event: '<beat>:<duration>(<chord>)<flags>  flags: ! accent  ~ sustain  x muted  tN tuplet-group',
  eventShorthand: '<beat><duration>(<chord>)<flags>',
  rest: 'duration can be r, rw, rh, rq, re, rs',
  pm: 'pm (bar-level), pm_start, pm_end',
  tab: 'tabN: <s1,s2,s3,s4,s5,s6> @ <beat>  (alias: tN:)',
  cue: 'cueN: <text> (alias: cN:)',
  sectionCue: 'sectionCue: <text> (alias: sc:)'
});

function parseHybridBeatPosition(rawPos, barTime = '4/4'){
  const m = String(rawPos || '').trim().match(/^(\d+)(?:(&))?$/);
  if (!m) return null;
  const beat = Number(m[1]);
  const beatVal = beat + (m[2] ? 0.5 : 0);
  const top = Number(String(barTime).split('/')[0]) || 4;
  if (beatVal < 1 || beatVal > top + 0.5) return null;
  return beatVal;
}

function countBarsInDocBlock(block){
  if (!block || block.type !== 'bars') return 0;
  if (typeof parseBarStructures === 'function'){
    try {
      const bars = parseBarStructures(block.tokens || []);
      return Array.isArray(bars) ? bars.length : 0;
    } catch (_err){
      return 0;
    }
  }
  const tokens = Array.isArray(block.tokens) ? block.tokens : [];
  return Math.max(0, tokens.filter((t) => !isBarlineToken(t)).length);
}

function buildDocSectionMap(text, _doc){
  const doc = _doc || parseCSMPN(text || '');
  const sections = [];
  let current = { label: 'Main', bars: [], markerType: '-' };
  for (const block of doc.blocks || []){
    if (block.type === 'marker' && ['-', ':', '='].includes(block.marker)){
      if (current.bars.length || sections.length === 0) sections.push(current);
      current = { label: block.text || 'Section', bars: [], markerType: block.marker };
      continue;
    }
    if (block.type !== 'bars') continue;
    const tokens = Array.isArray(block.tokens) ? block.tokens : [];
    // Source bars from the canonical bar parser so each bar carries clean chord
    // text plus volta endingLabel and repeat-barline state. (countBarsInDocBlock
    // already used parseBarStructures, so bar counts are unchanged — this also
    // fixes the prior "1." volta prefix leaking into the chord and multi-token
    // bars being mis-joined.)
    let bars = null;
    if (typeof parseBarStructures === 'function') {
      try { bars = parseBarStructures(tokens); } catch (_e) { bars = null; }
    }
    if (Array.isArray(bars) && bars.length) {
      for (const b of bars) {
        current.bars.push({
          timeSig: doc.time || '4/4',
          chordToken: b.token || '',
          endingLabel: b.endingLabel || null,
          leftBar: b.leftBar || 'single',
          rightBar: b.rightBar || 'single',
        });
      }
    } else {
      // Fallback when parseBarStructures is unavailable: scan tokens directly.
      const barChords = [];
      const hasBarlines = tokens.some((t) => isBarlineToken(t));
      if (hasBarlines) {
        let buf = [];
        for (const t of tokens) {
          if (isBarlineToken(t)) {
            if (buf.length) { barChords.push(buf.join(' ')); buf = []; }
          } else {
            buf.push(t);
          }
        }
        if (buf.length) barChords.push(buf.join(' '));
      } else {
        for (const t of tokens) {
          if (t && t.trim()) barChords.push(t);
        }
      }
      for (const chord of barChords) {
        current.bars.push({ timeSig: doc.time || '4/4', chordToken: chord || '' });
      }
    }
  }
  sections.push(current);
  // Standalone navigation markers (e.g. a "- D.C. al Fine" line with no bars) are
  // dropped by the bars>0 filter; carry their text onto the previous bar-bearing
  // section so the renderer can show it at that section's last row.
  const NAV = /\b(D\.C\.|D\.S\.|FINE|CODA|AL FINE|AL CODA|DAL SEGNO|DA CAPO|TO CODA|SEGNO)\b/i;
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    if (!sec.bars.length && sec.label && NAV.test(sec.label)) {
      for (let pj = si - 1; pj >= 0; pj--) {
        if (sections[pj].bars.length) {
          if (!sections[pj].navText) sections[pj].navText = sec.label;
          break;
        }
      }
    }
  }
  return sections.filter((sec) => sec.bars.length > 0);
}

function parseHybridBarLine(raw, barTime, warnings){
  const out = { timeSig: barTime || '4/4', events: [], tabEvents: [], cueText: '', pm: { bar: false, spans: [] } };
  const line = String(raw || '').trim();
  if (!line) return out;
  const tokens = line.split(/\s+/).filter(Boolean);
  let pmOpen = null;

  for (const token of tokens){
    if (/^pm$/i.test(token)){ out.pm.bar = true; continue; }
    if (/^pm_start$/i.test(token)){ pmOpen = out.events.length; continue; }
    if (/^pm_end$/i.test(token)){
      if (pmOpen !== null){
        out.pm.spans.push({ startIndex: pmOpen, endIndex: Math.max(pmOpen, out.events.length - 1) });
        pmOpen = null;
      } else {
        warnings.push('pm_end without a matching pm_start.');
      }
      continue;
    }
    const m = token.match(/^([^:]+):(r[whqes]?|[whqes])(?:\((.+)\))?([!~xt0-9]*)$/)
      || token.match(/^(\d+&?)(r[whqes]?|[whqes])(?:\((.+)\))?([!~xt0-9]*)$/);
    if (!m){
      warnings.push(`Unrecognized hybrid token "${token}" in "${line}".`);
      continue;
    }
    const beat = parseHybridBeatPosition(m[1], barTime);
    if (beat === null){
      warnings.push(`Invalid beat "${m[1]}" for time ${barTime}.`);
      continue;
    }
    const durRaw = String(m[2] || '').toLowerCase();
    let type = 'slash';
    let durationKey = durRaw;
    if (/^r/.test(durRaw)){
      type = 'rest';
      durationKey = durRaw.length > 1 ? durRaw.slice(1) : 'q';
    }
    if (!HYBRID_DURATION_MAP[durationKey]){
      warnings.push(`Unsupported duration "${durRaw}" in token "${token}".`);
      continue;
    }
    const tupletMatch = (m[4] || '').match(/t(\d+)/);
    out.events.push({
      type,
      duration: durationKey,
      beats: HYBRID_DURATION_MAP[durationKey],
      beat,
      chord: (m[3] || '').trim(),
      accent: m[4].includes('!'),
      sustain: m[4].includes('~'),
      muted: m[4].includes('x'),
      tuplet: tupletMatch ? parseInt(tupletMatch[1], 10) : 0,
    });
  }
  if (pmOpen !== null){
    out.pm.spans.push({ startIndex: pmOpen, endIndex: Math.max(pmOpen, out.events.length - 1) });
  }
  out.events.sort((a, b) => a.beat - b.beat);
  for (let i = 1; i < out.events.length; i++) {
    const prev = out.events[i - 1];
    // Tuplet notes within the same tuplet group legitimately occupy sub-beat positions;
    // skip duration-span overlap check so they are not incorrectly dropped.
    if (prev.tuplet > 0 && out.events[i].tuplet === prev.tuplet) continue;
    if (out.events[i].beat < prev.beat + prev.beats) {
      warnings.push(
        `Event at beat ${out.events[i].beat} overlaps with ${prev.duration} at beat ${prev.beat}; dropping later event.`,
      );
      out.events.splice(i, 1);
      i--;
    }
  }
  return out;
}

function parseHybridChartFromCSMPN(text){
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const warnings = [];
  const doc = parseCSMPN(text || '');
  const docSections = buildDocSectionMap(text, doc);
  const sectionModels = docSections.map((sec, i) => ({
    label: sec.label || `Section ${i + 1}`,
    bars: sec.bars.map((bar) => ({ ...bar, events: [], tabEvents: [], cueText: '', pm: { bar: false, spans: [] }, chordToken: bar.chordToken || '' })),
    cueText: '',
    navText: sec.navText || null,
    markerType: sec.markerType || '-',
  }));
  let activeHybrid = null;
  let targetSection = -1;

  for (const rawLine of lines){
    const line = String(rawLine || '').trim();
    if (!line) continue;
    if (/^\{hybrid\b/i.test(line)){ activeHybrid = []; continue; }
    if (line === '}' && activeHybrid){
      targetSection += 1;
      const section = sectionModels[targetSection];
      if (!section){
        warnings.push('Hybrid block references a nonexistent section.');
        activeHybrid = null;
        continue;
      }
      for (const entry of activeHybrid){
        const mBar = entry.match(/^(?:bar|b)(\d+)\s*:\s*(.+)$/i);
        if (mBar){
          const barIndex = Number(mBar[1]) - 1;
          if (!section.bars[barIndex]){
            warnings.push(`[${section.label}] bar${mBar[1]} does not exist.`);
            continue;
          }
          const prevBar = section.bars[barIndex];
          const prevWarnLen = warnings.length;
          section.bars[barIndex] = parseHybridBarLine(mBar[2], prevBar.timeSig || '4/4', warnings);
          // Preserve structural fields from the source bar (events replace only the
          // rhythm content, not the chord text / repeat barlines / volta endings).
          section.bars[barIndex].chordToken = prevBar.chordToken || '';
          section.bars[barIndex].endingLabel = prevBar.endingLabel || null;
          section.bars[barIndex].leftBar = prevBar.leftBar || 'single';
          section.bars[barIndex].rightBar = prevBar.rightBar || 'single';
          for (let wi = prevWarnLen; wi < warnings.length; wi++) {
            warnings[wi] = `[${section.label} bar ${mBar[1]}] ${warnings[wi]}`;
          }
          continue;
        }
        const mTab = entry.match(/^(?:tab|t)(\d+)\s*:\s*([^@]+)(?:\s*@\s*([0-9&]+))?$/i);
        if (mTab){
          const barIndex = Number(mTab[1]) - 1;
          const bar = section.bars[barIndex];
          if (!bar){
            warnings.push(`[${section.label}] tab${mTab[1]} references a missing bar.`);
            continue;
          }
          const tabShape = mTab[2].trim();
          if (!/^([xX\-]|\d{1,2})(\s*,\s*([xX\-]|\d{1,2})){5}$/.test(tabShape)){
            warnings.push(`[${section.label} bar ${mTab[1]}] Malformed tab shape "${tabShape}". Expected six comma-separated values.`);
            continue;
          }
          const beat = parseHybridBeatPosition(mTab[3] || '1', bar.timeSig || '4/4');
          if (beat === null){
            warnings.push(`[${section.label} bar ${mTab[1]}] Invalid tab beat "${mTab[3]}".`);
            continue;
          }
          bar.tabEvents.push({ type: 'tab_note_or_shape', beat, shape: tabShape });
          continue;
        }
        const mCue = entry.match(/^(?:cue|c)(\d+)\s*:\s*(.+)$/i);
        if (mCue){
          const barIndex = Number(mCue[1]) - 1;
          if (!section.bars[barIndex]){
            warnings.push(`[${section.label}] cue${mCue[1]} references a missing bar.`);
            continue;
          }
          section.bars[barIndex].cueText = mCue[2].trim();
          continue;
        }
        const secCue = entry.match(/^(?:sectionCue|sc)\s*:\s*(.+)$/i);
        if (secCue){
          section.cueText = secCue[1].trim();
          continue;
        }
      }
      activeHybrid = null;
      continue;
    }
    if (activeHybrid) activeHybrid.push(line);
  }
  const hasHybridContent = sectionModels.some((sec) => sec.bars.some((bar) => bar.events.length || bar.tabEvents.length || bar.cueText) || sec.cueText);
  return {
    mode: 'hybrid-v1',
    active: hasHybridContent,
    sections: sectionModels,
    warnings,
    title: doc.title || '',
    key: doc.key || '',
    time: doc.time || '4/4',
    tempo: doc.tempo || null,
    composer: doc.composer || '',
    style: doc.style || '',
    capo: doc.capo || 0,
  };
}

if (typeof window !== 'undefined'){
  window.parseHybridChartFromCSMPN = parseHybridChartFromCSMPN;
  window.HYBRID_SYNTAX_SPEC = HYBRID_SYNTAX_SPEC;
}

// ── Hybrid Scaffolder ──────────────────────────────────────────────────────────

const HYBRID_PRESET_PATTERNS = {
  quarter:      { '4/4':'1:q 2:q 3:q 4:q',              '3/4':'1:q 2:q 3:q',                 '2/4':'1:q 2:q',       '12/8':'1:q 4:q 7:q 10:q',                                              '6/8':'1:q 4:q',             '9/8':'1:q 4:q 7:q'              },
  eighth:       { '4/4':'1:q 2:e 2&:e 3:q 4:e 4&:e',    '3/4':'1:q 2:e 2&:e 3:e 3&:e',       '2/4':'1:q 2:e 2&:e', '12/8':'1:e 2:e 3:e 4:e 5:e 6:e 7:e 8:e 9:e 10:e 11:e 12:e',          '6/8':'1:e 2:e 3:e 4:e 5:e 6:e','9/8':'1:e 2:e 3:e 4:e 5:e 6:e 7:e 8:e 9:e' },
  swing:        { '4/4':'1:q! 2:e 2&:e 3:q! 4:e 4&:e',  '3/4':'1:q! 2:e 2&:e 3:q!',          '2/4':'1:q! 2:e 2&:e','12/8':'1:q! 4:q 7:q! 10:q',                                            '6/8':'1:q! 4:q',            '9/8':'1:q! 4:q 7:q!'            },
  'funk-16':    { '4/4':'1:q! 2:e 2&:e 3:e 3&:e 4:q',   '3/4':'1:q! 2:e 2&:e 3:e 3&:e',      '2/4':'1:q! 2:e 2&:e','12/8':'1:e! 2:e 3:e 4:e! 5:e 6:e 7:e! 8:e 9:e 10:e! 11:e 12:e',                           '6/8':'1:e! 2:e 3:e 4:e! 5:e 6:e',    '9/8':'1:e! 2:e 3:e 4:e! 5:e 6:e 7:e! 8:e 9:e' },
  bossa:        { '4/4':'1:q 2&:e 3:q 4&:e',             '3/4':'1:q 2&:e 3:q',                '2/4':'1:q 2&:e',     '12/8':'1:q 3:e 4:q 7:q 9:e 10:q',                                      '6/8':'1:q 3:e 4:q',         '9/8':'1:q 3:e 4:q 7:q 9:e'     },
  waltz:        { '4/4':'1:q! 2:q 3:q 4:q',              '3/4':'1:q! 2:q 3:q',                '2/4':'1:q! 2:q',     '12/8':'1:q! 4:q 7:q 10:q',                                             '6/8':'1:q! 4:q',            '9/8':'1:q! 4:q 7:q'             },
  'slow-blues': { '4/4':'1:q 2:e 2&:e 3:q 4:e',         '3/4':'1:q 2:q 3:e',                 '2/4':'1:q 2:e',      '12/8':'1:q 4:q 7:q 10:q',                                              '6/8':'1:q 4:q',             '9/8':'1:q 4:q 7:q'              },
};

function _hybridBarsInLine(line) {
  // Normalise multi-char barline tokens before splitting so || doesn't double-count
  const s = line
    .trim()
    .replace(/:\|{1,2}/g, '|')
    .replace(/\|{2}:?/g, '|')
    .replace(/\|:/g, '|')
    .replace(/\|]/g, '|');
  const inner = s.split('|').slice(1, -1);
  return inner.filter(p => p.trim().length > 0).length;
}

function toHybridCSMPN(text, preset, _opts) {
  preset = preset || 'quarter';
  const timeMatch = text.match(/^(?:time|ti)\s*:\s*(\d+\/\d+)/im);
  const timeSig = timeMatch ? timeMatch[1] : '4/4';
  const presetMap = HYBRID_PRESET_PATTERNS[preset] || HYBRID_PRESET_PATTERNS.quarter;
  const pattern = presetMap[timeSig] || presetMap['4/4'] || '1:q 2:q 3:q 4:q';

  // Use the canonical parser for exact bar counts — eliminates all line-scan counting heuristics
  const docSections = buildDocSectionMap(text);
  let docSecIdx = 0;

  const lines = text.split('\n');
  // Only '-' ':' '=' start new sections in buildDocSectionMap; ';'/'#' are annotations within a section
  const MARKER_CHARS = new Set(['-', ':', '=']);
  const insertAfter = new Map();

  let hybridSkip = false;
  let tabSkip = false;
  let sectionHasHybrid = false;
  let lastBarLine = -1;

  const flush = () => {
    if (sectionHasHybrid) {
      // Section already has a {hybrid} block — advance index but don't insert
      docSecIdx++;
    } else if (lastBarLine >= 0 && docSecIdx < docSections.length) {
      const barCount = docSections[docSecIdx].bars.length;
      if (barCount > 0) insertAfter.set(lastBarLine, barCount);
      docSecIdx++;
    }
    lastBarLine = -1;
    sectionHasHybrid = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (hybridSkip) { if (t === '}') { hybridSkip = false; sectionHasHybrid = true; } continue; }
    if (tabSkip)    { if (t === '}') tabSkip = false; continue; }
    if (t.startsWith('{hybrid')) { sectionHasHybrid = true; if (!t.endsWith('}')) hybridSkip = true; continue; }
    if (t.startsWith('{tab'))    { if (!t.endsWith('}')) tabSkip = true; continue; }
    if (t.startsWith('{vt'))     { continue; }
    if (t && MARKER_CHARS.has(t[0])) { flush(); continue; }
    // Track last bar-content line (insertion point); counting is handled by docSections.
    // A bar line may end in a repeat barline (`:|`) which contains a colon, so we
    // exclude only `Field: value` metadata lines — not every line with a colon —
    // otherwise the closing `… :|` bar of a section is missed and the {hybrid} block
    // gets inserted mid-section.
    const isMetaLine = /^[A-Za-z][A-Za-z ]*:\s/.test(t);
    if (t.startsWith('|') || (t && /^[A-G]/.test(t) && !isMetaLine)) {
      lastBarLine = i;
    }
  }
  flush();

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (insertAfter.has(i)) {
      const barCount = insertAfter.get(i);
      out.push('{hybrid');
      for (let b = 1; b <= barCount; b++) out.push(`b${b}: ${pattern}`);
      out.push('}');
    }
  }
  return out.join('\n');
}

/**
 * Reduce a CSMPN chart to PURE FAKE BOOK style: header metadata, section markers
 * and the bar grid — nothing else.
 *
 * A fake book chart is chord symbols over bars. It is NOT ChordPro (which threads
 * chords into the lyric line), and it carries no rhythm notation or fingering. So
 * three kinds of content come out:
 *
 *   ';' lyric lines        — rendered as lyrics beneath the bars
 *   '{hybrid …}' blocks    — notated rhythm for the Slash-Rhythm view
 *   '{tab …}' blocks       — fingering, which drives the TAB staff + chord diagrams
 *
 * Header fields, '- : =' section markers, '//' diagram definitions and the bar
 * lines themselves are all kept, so the result still parses through parseCSMPN
 * and still renders — it is a narrower chart, not a different format.
 *
 * This is DESTRUCTIVE by design and is meant for export ("give me a clean fake
 * book chart to hand someone"). The in-app view hides lyrics non-destructively
 * via fbSettings.includeLyrics instead, so nothing is lost from the source.
 *
 * @param {string} text CSMPN source.
 * @returns {string} CSMPN containing only fake-book content.
 */
function toPureFakeBook(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let blockDepth = 0; // inside a {tab …} / {hybrid …} / {notation …} block

  for (const line of lines) {
    const t = line.trim();

    if (blockDepth > 0) {
      // Brace-counting rather than "ends with }" — a block's closing brace can
      // share a line with content (e.g. a single-line `{tab G: 3,2,0,0,0,3}`).
      blockDepth += (t.match(/\{/g) || []).length;
      blockDepth -= (t.match(/\}/g) || []).length;
      if (blockDepth < 0) blockDepth = 0;
      continue;
    }

    // Open a strippable block. Only these three are non-fake-book.
    if (/^\{(tab|hybrid|notation)\b/i.test(t)) {
      blockDepth = (t.match(/\{/g) || []).length - (t.match(/\}/g) || []).length;
      if (blockDepth < 0) blockDepth = 0;
      continue;
    }

    if (t.startsWith(';')) continue; // lyric line

    out.push(line);
  }

  // Collapse the blank-line runs the removals leave behind, and trim the tail.
  const collapsed = [];
  for (const line of out) {
    if (!line.trim() && collapsed.length && !collapsed[collapsed.length - 1].trim()) continue;
    collapsed.push(line);
  }
  while (collapsed.length && !collapsed[collapsed.length - 1].trim()) collapsed.pop();

  return collapsed.join('\n');
}

if (typeof window !== 'undefined'){
  window.toHybridCSMPN = toHybridCSMPN;
  window.HYBRID_PRESET_PATTERNS = HYBRID_PRESET_PATTERNS;
  window.toPureFakeBook = toPureFakeBook;
}

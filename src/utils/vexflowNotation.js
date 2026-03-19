const CLEF_NAMES = new Set(['treble', 'bass', 'alto', 'tenor', 'percussion']);
const ARTICULATION_CODES = {
  staccato: 'a.',
  accent: 'a>',
  tenuto: 'a-',
  marcato: 'a^',
  fermata: 'a@a',
};
const TEXT_DIRECTIVE_RE = /^(tempo|text)\s*=\s*(.+)$/i;
const REST_RE = /^(?:(w|h|q|8|16|32|64)r|r\/(w|h|q|8|16|32|64))(\.{1,2})?(\^)?$/i;
const NOTE_RE = /^([A-Ga-g])([#bn]?)(\d)\/(w|h|q|8|16|32|64)(\.{1,2})?(\^)?$/;
const CHORD_RE = /^<([^>]+)>\/(w|h|q|8|16|32|64)(\.{1,2})?(\^)?$/;
const DURATION_BEATS = { w: 4, h: 2, q: 1, 8: 0.5, 16: 0.25, 32: 0.125, 64: 0.0625 };

function splitTopLevel(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  let angleDepth = 0;
  let bracketDepth = 0;

  const push = () => {
    const value = current.trim();
    if (value) tokens.push(value);
    current = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = input[i - 1];
    if (quote) {
      current += ch;
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '<') {
      angleDepth += 1;
      current += ch;
      continue;
    }
    if (ch === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
      current += ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += ch;
      continue;
    }
    if (angleDepth === 0 && bracketDepth === 0 && ch === '|') {
      push();
      tokens.push('|');
      continue;
    }
    if (angleDepth === 0 && bracketDepth === 0 && (ch === ',' || /\s/.test(ch))) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function splitCommaAware(input) {
  const values = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const prev = input[i - 1];
    if (quote) {
      current += ch;
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      if (current.trim()) values.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function unquote(value) {
  if (!value) return '';
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\([\\"'])/g, '$1');
  }
  return trimmed;
}

function parseModifierBlock(source) {
  const modifiers = {
    articulations: [],
    lyric: undefined,
    text: undefined,
    dyn: undefined,
    chord: undefined,
    grace: [],
  };
  if (!source) return modifiers;

  for (const part of splitCommaAware(source)) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      const art = part.trim().toLowerCase();
      if (ARTICULATION_CODES[art]) modifiers.articulations.push(art);
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    const rawValue = part.slice(eq + 1).trim();
    const value = unquote(rawValue);
    if (key === 'lyric') modifiers.lyric = value;
    else if (key === 'text') modifiers.text = value;
    else if (key === 'dyn' || key === 'dynamic') modifiers.dyn = value;
    else if (key === 'chord') modifiers.chord = value;
    else if (key === 'grace') modifiers.grace = parseGraceSequence(value);
  }

  return modifiers;
}

function stripModifiers(token) {
  let base = token.trim();
  const blocks = [];
  while (base.endsWith(']')) {
    const open = findMatchingBracket(base);
    if (open === -1) break;
    blocks.unshift(base.slice(open + 1, -1));
    base = base.slice(0, open).trim();
  }
  const modifiers = blocks.reduce((acc, block) => mergeModifiers(acc, parseModifierBlock(block)), parseModifierBlock(''));
  return { base, modifiers };
}

function findMatchingBracket(token) {
  let quote = null;
  let depth = 0;
  for (let i = token.length - 1; i >= 0; i -= 1) {
    const ch = token[i];
    const prev = token[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ']') depth += 1;
    else if (ch === '[') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function mergeModifiers(a, b) {
  return {
    articulations: [...(a.articulations || []), ...(b.articulations || [])],
    lyric: b.lyric ?? a.lyric,
    text: b.text ?? a.text,
    dyn: b.dyn ?? a.dyn,
    chord: b.chord ?? a.chord,
    grace: b.grace?.length ? b.grace : (a.grace || []),
  };
}

function parseGraceSequence(source) {
  return splitTopLevel(source)
    .filter((token) => token !== '|')
    .map((token) => parseSingleEvent(token, { allowGrace: true }))
    .filter((event) => event && event.type !== 'rest');
}

function parsePitchToken(token) {
  const match = token.trim().match(/^([A-Ga-g])([#bn]?)(\d)$/);
  if (!match) throw new Error(`Invalid pitch \"${token}\".`);
  const [, stepRaw, accidental, octaveRaw] = match;
  const step = stepRaw.toUpperCase();
  return {
    step,
    accidental: accidental || '',
    octave: Number(octaveRaw),
    vexKey: `${step.toLowerCase()}${accidental || ''}/${octaveRaw}`,
  };
}

function parseSingleEvent(token, options = {}) {
  const { allowGrace = false } = options;
  const { base, modifiers } = stripModifiers(token);
  if (!base) throw new Error('Empty notation token.');

  const restMatch = base.match(REST_RE);
  if (restMatch) {
    const duration = restMatch[1] || restMatch[2];
    return {
      type: 'rest',
      duration,
      dots: (restMatch[3] || '').length,
      tie: Boolean(restMatch[4]),
      modifiers,
      source: token,
    };
  }

  const chordMatch = base.match(CHORD_RE);
  if (chordMatch) {
    const pitches = splitTopLevel(chordMatch[1]).map(parsePitchToken);
    if (pitches.length === 0) throw new Error(`Chord token \"${token}\" is empty.`);
    return {
      type: 'chord',
      pitches,
      duration: chordMatch[2],
      dots: (chordMatch[3] || '').length,
      tie: Boolean(chordMatch[4]),
      modifiers,
      source: token,
      isGrace: allowGrace,
    };
  }

  const noteMatch = base.match(NOTE_RE);
  if (noteMatch) {
    return {
      type: 'note',
      pitches: [parsePitchToken(`${noteMatch[1]}${noteMatch[2]}${noteMatch[3]}`)],
      duration: noteMatch[4],
      dots: (noteMatch[5] || '').length,
      tie: Boolean(noteMatch[6]),
      modifiers,
      source: token,
      isGrace: allowGrace,
    };
  }

  throw new Error(`Unsupported notation token \"${token}\".`);
}

function eventBeats(event) {
  const base = DURATION_BEATS[event.duration];
  if (!base) return 0;
  if (event.dots === 1) return base * 1.5;
  if (event.dots === 2) return base * 1.75;
  return base;
}

export function parseVexFlowBlock(content) {
  const raw = (content || '').trim();
  const parsed = {
    raw,
    clef: 'treble',
    timeSig: '4/4',
    tempo: undefined,
    text: undefined,
    measures: [],
    totalBeats: 0,
    warnings: [],
  };

  let working = raw;

  const timeMatch = working.match(/^\[(\d+\/\d+)\]\s*/);
  if (timeMatch) {
    parsed.timeSig = timeMatch[1];
    working = working.slice(timeMatch[0].length).trim();
  }

  const clefMatch = working.match(/^(treble|bass|alto|tenor|percussion)\s*:\s*/i);
  if (clefMatch) {
    parsed.clef = clefMatch[1].toLowerCase();
    working = working.slice(clefMatch[0].length).trim();
  }

  const tokens = splitTopLevel(working);
  let currentMeasure = { events: [] };
  let pendingTie = false;

  const pushMeasure = () => {
    if (currentMeasure.events.length > 0 || parsed.measures.length === 0) {
      parsed.measures.push(currentMeasure);
    }
    currentMeasure = { events: [] };
  };

  for (const token of tokens) {
    if (token === '|') {
      pushMeasure();
      pendingTie = false;
      continue;
    }

    const directiveMatch = token.match(TEXT_DIRECTIVE_RE);
    if (directiveMatch) {
      const key = directiveMatch[1].toLowerCase();
      const value = unquote(directiveMatch[2]);
      if (key === 'tempo') parsed.tempo = value;
      if (key === 'text') parsed.text = value;
      continue;
    }

    const lowerToken = token.toLowerCase();
    if (lowerToken.startsWith('clef=')) {
      const value = unquote(token.slice(5)).toLowerCase();
      if (!CLEF_NAMES.has(value)) throw new Error(`Unsupported clef \"${value}\".`);
      parsed.clef = value;
      continue;
    }
    if (lowerToken.startsWith('time=')) {
      parsed.timeSig = unquote(token.slice(5));
      continue;
    }
    if (token === '^') {
      pendingTie = true;
      continue;
    }

    const event = parseSingleEvent(token);
    event.tieFromPrevious = pendingTie;
    pendingTie = Boolean(event.tie);
    currentMeasure.events.push(event);
    parsed.totalBeats += eventBeats(event);
  }

  if (currentMeasure.events.length > 0 || parsed.measures.length === 0) {
    parsed.measures.push(currentMeasure);
  }

  const [beatsPerBar, beatValue] = parsed.timeSig.split('/').map(Number);
  const expectedPerBar = beatsPerBar * (4 / beatValue);

  parsed.measures.forEach((measure, index) => {
    const beats = measure.events.reduce((sum, event) => sum + eventBeats(event), 0);
    measure.beats = beats;
    if (Math.abs(beats - expectedPerBar) > 0.001) {
      parsed.warnings.push(`Bar ${index + 1} totals ${beats} beats; expected ${expectedPerBar} for ${parsed.timeSig}.`);
    }
  });

  return parsed;
}

export function supportsEnhancedVexflowSyntax(content) {
  try {
    parseVexFlowBlock(content);
    return true;
  } catch {
    return false;
  }
}

function attachToWindow() {
  if (typeof window === 'undefined') return;
  window.VTNotationUtils = {
    parseVexFlowBlock,
    supportsEnhancedVexflowSyntax,
    splitTopLevel,
  };
}

attachToWindow();

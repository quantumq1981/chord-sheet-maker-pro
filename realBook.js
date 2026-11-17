/* realBook.js — Real Book / iGigBook chart style: preset, CSMPN layout transform,
 * and the one-page print-fit solver.
 *
 * Browser global `window.RealBook`; also loadable in a Node `vm` context for tests.
 * The pure core has no DOM access. It reuses tokenizeBars / parseBarStructures from
 * chordProcessing.js (loaded earlier as a classic script) through `root`, so the
 * transform reads bars exactly the way the renderer does.
 *
 * Three parts:
 *   1. REAL_BOOK_PRESET + applyPreset — the Fake Book Settings for a staff-free
 *      Real Book chart. Data only; settings.js applies it to fbSettings.
 *   2. toRealBookCSMPN — an explicit, user-invoked source transform: removes lyric
 *      and decorative-divider lines, boxes the section markers, folds a section
 *      whose second half repeats its first into |: … :| (with 1st/2nd endings when
 *      only the tail differs), and lays every plain section out 4 bars per line.
 *      It is NOT run on import: lyric lines are kept in the source on purpose so
 *      Perform Lyrics / Stage Sheets can read them (see CLAUDE.md, 2026-08-18).
 *   3. buildFitLevels / chooseFitLevel / printableHeightPx — pick the largest
 *      font-size + line-spacing step at which the chart fits one printed page.
 *      printWithAutoFit is the browser glue around them.
 */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- preset */

  // Real Book (iGigBook) chart: chord symbols over barlines, no staff, no lyrics.
  // chordFontPack stays 'default' on purpose: the Pori/Norfolk packs REPLACE the
  // chord font with an engraved serif, so a handwritten chord font only takes
  // effect with the default pack.
  const REAL_BOOK_PRESET = Object.freeze({
    chartStyle: 'realbook',
    printFit: 'onepage',
    fontSize: 'M',
    barsPerRow: 4,
    lineSpacing: 12,
    barLines: 'visible',
    chordAlign: 'left',
    chordFontPack: 'default',
    hybridRhythmMode: false,
    includeLyrics: false,
    strumMode: 'none',
    maj7Style: 'triangle',
    minorStyle: 'minus',
    dimStyle: 'degree',
    halfDimStyle: 'slashed',
    headlineFont: 'patrickhand',
    bodyFont: 'kalam',
    pageOrientation: 'portrait',
    footer: 'hidden',
    bgColor: '#ffffff',
    fgColor: '#111111',
    chordColor: '#111111',
  });

  // Copy the preset's values onto a settings object. Only keys the settings
  // object already has are written, so a preset can never add stray fields.
  function applyPreset(settings, preset) {
    const out = Object.assign({}, settings);
    const p = preset || REAL_BOOK_PRESET;
    for (const k of Object.keys(p)) {
      if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = p[k];
    }
    return out;
  }

  /* ------------------------------------------------------- line classifier */

  // Same header fields csmpnParser.js extracts (metaRE there).
  const META_RE = /^(Title|Composer|Artist|Style|Tempo Map|Tempo|Time|Key|Capo|Tuning)\s*:/i;
  // A line made only of rule characters: "-----", "=====", "___", "* * *".
  const DIVIDER_RE = /^[-=_*~\s]+$/;

  function isDividerLine(line) {
    const t = line.trim();
    return t.replace(/\s/g, '').length >= 3 && DIVIDER_RE.test(t);
  }

  // Three-column section text ("- lc …" or columns split by 2+ spaces) is laid
  // out by the renderer as columns, so it is left exactly as written.
  function isColumnMarkerText(text) {
    return /^(lc|cc|rc)\b/i.test(text) || /\S\s{2,}\S/.test(text);
  }

  function classifyLine(raw) {
    const t = raw.trim();
    if (!t) return 'blank';
    if (META_RE.test(t)) return 'meta';
    if (isDividerLine(t)) return 'divider';
    if (t.startsWith(';')) return 'lyric';
    if (t.startsWith('//')) return 'diagram';
    if (t.startsWith('{')) return 'brace';
    if (t.startsWith('+')) return 'pagebreak';
    if (t.startsWith('#')) return 'comment';
    if (t[0] === '-' || t[0] === ':' || t[0] === '=') return 'marker';
    return 'bars';
  }

  // "- Verse" / ": Verse" / "== Verse" → "= Verse" (boxed rehearsal mark; MusicXML
  // export gives "=" a square enclosure). Column text is returned unchanged.
  function normalizeMarker(raw) {
    const t = raw.trim();
    const text = t.replace(/^(==|[-:=])\s*/, '');
    if (isColumnMarkerText(text)) return t;
    return text ? '= ' + text : t;
  }

  /* ------------------------------------------------------------- folding */

  // Resolve '%' (repeat previous bar) to the bar it repeats, for comparison only.
  function resolveSimiles(tokens, before) {
    let prev = before || null;
    return tokens.map((tok) => {
      if (/^%+\d*$/.test(tok) && prev) return prev;
      prev = tok;
      return tok;
    });
  }

  /**
   * Detect a section whose second half repeats its first.
   *   ABCD ABCD           → { body:[A,B,C,D], end1:[], end2:[] }       (|: … :|)
   *   ABCDEF GH ABCDEF IJ → { body:[A..F], end1:[G,H], end2:[I,J] }   (1st/2nd endings)
   * Returns null when the bars do not split that way. Comparison resolves '%'
   * similes; the emitted tokens keep the source spelling, except that a 2nd ending
   * starting with '%' is resolved (it no longer follows the bar it repeated).
   */
  function foldRepeats(tokens) {
    const n = tokens.length;
    if (n < 4 || n % 2 !== 0) return null;
    const half = n / 2;
    const resolved = resolveSimiles(tokens);
    let p = 0;
    while (p < half && resolved[p] === resolved[half + p]) p++;
    if (p === half) {
      return { body: tokens.slice(0, half), end1: [], end2: [] };
    }
    const k = half - p; // bars in each ending
    if (p < 2 || k > p) return null; // too little in common to be one phrase played twice
    const end2 = tokens.slice(half + p);
    if (/^%+\d*$/.test(end2[0])) end2[0] = resolved[half + p];
    return { body: tokens.slice(0, p), end1: tokens.slice(p, half), end2 };
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  const CLOSING_TOKEN = { final: '|]', double: '||' };

  // Bars of a plain section, or null when the section has structure (repeats,
  // endings, per-bar meters, inner double bars) that must be kept as written.
  function readPlainBars(barLines) {
    const tokenize = root.tokenizeBars;
    const parseBars = root.parseBarStructures;
    if (typeof tokenize !== 'function' || typeof parseBars !== 'function') return null;
    const tokens = [];
    for (const line of barLines) tokens.push(...tokenize(line));
    if (!tokens.length) return null;
    // A (…)xN group with N > 2 cannot be shown as a plain |: :| repeat.
    if (tokens.some((t) => /\)(?:x(\d+)|(\d+)x)$/i.test(t) && !/\)(?:x2|2x)$/i.test(t))) return null;
    // Source repeat groups "(A B)x2" are expanded by parseBarStructures; they are
    // only rewritten when the whole section folds into |: … :|.
    const hadGroup = tokens.some((t) => t.startsWith('('));
    const bars = parseBars(tokens);
    if (!bars.length) return null;
    let closing = '';
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const last = i === bars.length - 1;
      if (b.endingLabel || b.timeSig) return null;
      if (b.leftBar && b.leftBar !== 'single') return null;
      if (b.rightBar && b.rightBar !== 'single') {
        if (last && CLOSING_TOKEN[b.rightBar]) closing = CLOSING_TOKEN[b.rightBar];
        else return null;
      }
    }
    return { tokens: bars.map((b) => b.token), closing, hadGroup };
  }

  // Lay out one plain section's bars as CSMPN lines, perLine bars each.
  // Returns null when the section should be kept exactly as written.
  function layoutSection(plain, opts, stats) {
    const perLine = opts.perLine;
    const fold = opts.foldRepeats ? foldRepeats(plain.tokens) : null;
    const lines = [];
    if (!fold) {
      if (plain.hadGroup) return null;
      const rows = chunk(plain.tokens, perLine).map((r) => r.join(' '));
      if (plain.closing && rows.length) rows[rows.length - 1] += ' ' + plain.closing;
      return rows;
    }
    stats.sectionsFolded++;
    const first = fold.body.concat(fold.end1);
    const units = first.slice();
    units[0] = '|: ' + units[0];
    if (fold.end1.length) {
      stats.endings++;
      units[fold.body.length] = '1. ' + units[fold.body.length];
    }
    units[units.length - 1] += ' :|';
    for (const r of chunk(units, perLine)) lines.push(r.join(' '));
    if (fold.end2.length) {
      const second = fold.end2.slice();
      second[0] = '2. ' + second[0];
      const rows = chunk(second, perLine).map((r) => r.join(' '));
      rows[rows.length - 1] += ' ' + (plain.closing || '|');
      lines.push(...rows);
    } else if (plain.closing) {
      lines[lines.length - 1] += ' ' + plain.closing;
    }
    return lines;
  }

  /**
   * Rewrite a CSMPN chart for a Real Book layout. See the file header for what it
   * does and why it is an explicit action rather than an import step.
   * @param {string} text
   * @param {{perLine?:number, foldRepeats?:boolean, stripLyrics?:boolean, boxSections?:boolean}} [options]
   * @returns {{csmpn:string, stats:{sectionsFolded:number, endings:number,
   *   lyricLinesRemoved:number, dividersRemoved:number, sectionsKept:number}}}
   */
  function toRealBookCSMPN(text, options) {
    const opts = Object.assign(
      { perLine: 4, foldRepeats: true, stripLyrics: true, boxSections: true },
      options || {},
    );
    opts.perLine = Math.max(1, Math.min(8, opts.perLine | 0 || 4));
    const stats = { sectionsFolded: 0, endings: 0, lyricLinesRemoved: 0, dividersRemoved: 0, sectionsKept: 0 };

    const meta = [];
    const defs = []; // "// C7 x32310" chord-diagram definitions apply chart-wide
    const sections = []; // { marker: string|null, lines: [{kind, text}] }
    let cur = { marker: null, lines: [] };
    let braceOpen = false;

    for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (braceOpen) {
        cur.lines.push({ kind: 'brace', text: raw });
        if (raw.trim() === '}' || raw.trim().endsWith('}')) braceOpen = false;
        continue;
      }
      const kind = classifyLine(raw);
      if (kind === 'meta') { meta.push(raw.trim()); continue; }
      if (kind === 'diagram') { defs.push(raw.trim()); continue; }
      if (kind === 'blank') continue;
      if (kind === 'divider') { stats.dividersRemoved++; continue; }
      if (kind === 'lyric' && opts.stripLyrics) { stats.lyricLinesRemoved++; continue; }
      if (kind === 'marker') {
        if (cur.marker !== null || cur.lines.length) sections.push(cur);
        cur = { marker: opts.boxSections ? normalizeMarker(raw) : raw.trim(), lines: [] };
        continue;
      }
      if (kind === 'brace' && !raw.trim().endsWith('}')) braceOpen = true;
      cur.lines.push({ kind, text: raw.trim() });
    }
    if (cur.marker !== null || cur.lines.length) sections.push(cur);

    const out = meta.concat(defs);
    for (const sec of sections) {
      if (out.length) out.push('');
      if (sec.marker !== null) out.push(sec.marker);
      const onlyBars = sec.lines.length && sec.lines.every((l) => l.kind === 'bars');
      // ".", "X" indentation and brace blocks ({tab}, {hybrid} bN: numbering) depend
      // on the exact source lines, so those sections are kept as written.
      const special = sec.lines.some((l) => /^(\.(\s|$)|X+\s)/.test(l.text));
      const plain = onlyBars && !special ? readPlainBars(sec.lines.map((l) => l.text)) : null;
      const laid = plain ? layoutSection(plain, opts, stats) : null;
      if (laid) {
        out.push(...laid);
      } else {
        if (sec.lines.length) stats.sectionsKept++;
        out.push(...sec.lines.map((l) => l.text));
      }
    }
    return { csmpn: out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', stats };
  }

  /* -------------------------------------------------------- one-page fit */

  const FONT_STEPS = ['M', 'S', 'XS'];
  // Largest → smallest. Line spacing gives way before the font does.
  const FIT_LADDER = [
    ['M', 16], ['M', 12], ['M', 8], ['M', 4],
    ['S', 4], ['S', 2],
    ['XS', 2], ['XS', 0],
  ];

  /**
   * Font-size / line-spacing steps from the current settings downward, largest
   * first (the user's own setting is step 0). Spacing is capped at the current
   * value, so no step is ever larger than what the user chose.
   */
  function buildFitLevels(fontSize, lineSpacing) {
    const f0 = Math.max(0, FONT_STEPS.indexOf(fontSize));
    const s0 = Number.isFinite(+lineSpacing) ? Math.max(0, +lineSpacing) : 8;
    const levels = [{ fontSize: FONT_STEPS[f0], lineSpacing: s0 }];
    for (const [f, s] of FIT_LADDER) {
      const fi = FONT_STEPS.indexOf(f);
      const sp = Math.min(s, s0);
      if (fi < f0) continue;
      if (fi === f0 && sp >= s0) continue;
      if (levels.some((l) => l.fontSize === f && l.lineSpacing === sp)) continue;
      levels.push({ fontSize: f, lineSpacing: sp });
    }
    return levels;
  }

  /**
   * First level whose measured height fits `availablePx`.
   * @param {Array<{fontSize:string,lineSpacing:number}>} levels largest first
   * @param {(level:object)=>number} measure height in CSS px at that level
   * @returns {{index:number, level:object, height:number, fits:boolean}}
   *   When nothing fits, the smallest level with fits:false.
   */
  function chooseFitLevel(levels, measure, availablePx) {
    let last = null;
    for (let i = 0; i < levels.length; i++) {
      const height = measure(levels[i]);
      last = { index: i, level: levels[i], height, fits: height <= availablePx };
      if (last.fits) return last;
    }
    return last || { index: -1, level: null, height: 0, fits: false };
  }

  // Printable page height in CSS px (96/in) on US Letter with the fake-book
  // 0.5in @page margin, less a small safety allowance for browser rounding.
  function printableHeightPx(orientation, marginIn) {
    const m = marginIn == null ? 0.5 : marginIn;
    const pageIn = orientation === 'landscape' ? 8.5 : 11;
    return Math.floor((pageIn - 2 * m) * 96 * 0.97);
  }
  function printableWidthPx(orientation, marginIn) {
    const m = marginIn == null ? 0.5 : marginIn;
    const pageIn = orientation === 'landscape' ? 11 : 8.5;
    return Math.floor((pageIn - 2 * m) * 96);
  }

  /* ------------------------------------------------------- browser glue */

  /**
   * Print the fake-book sheet, stepping font size / line spacing down until the
   * chart fits one page. Only CSS custom properties change (the renderer sizes
   * everything from --fb-font-scale / --fb-line-spacing), so nothing re-renders
   * and nothing is saved; the user's settings come back after printing.
   * @param {{sheet:HTMLElement, settings:object, fontScaleMap:object,
   *   print?:()=>void, onStatus?:(msg:string)=>void}} ctx
   */
  function printWithAutoFit(ctx) {
    const doc = root.document;
    const sheet = ctx.sheet;
    const s = ctx.settings;
    const print = ctx.print || (() => root.print());
    const html = doc.documentElement;
    const setVars = (lv) => {
      html.style.setProperty('--fb-font-scale', ctx.fontScaleMap[lv.fontSize] || 1);
      html.style.setProperty('--fb-font-scale-base', ctx.fontScaleMap[lv.fontSize] || 1);
      html.style.setProperty('--fb-line-spacing', lv.lineSpacing + 'px');
    };
    const original = { fontSize: s.fontSize, lineSpacing: s.lineSpacing };
    const hasPageBreaks = !!sheet.querySelector('.pageBreak');
    if (s.printFit !== 'onepage' || s.hybridRhythmMode || hasPageBreaks) {
      print();
      return null;
    }

    // Measure at the printed width with the print-width bar grid (body.exporting
    // turns off the phone's 2-bars-per-row screen layout).
    const saved = { width: sheet.style.width, maxWidth: sheet.style.maxWidth, padding: sheet.style.padding };
    const hadExporting = doc.body.classList.contains('exporting');
    doc.body.classList.add('exporting');
    sheet.style.maxWidth = 'none';
    sheet.style.width = printableWidthPx(s.pageOrientation) + 'px';
    sheet.style.padding = '24px 36px';
    const levels = buildFitLevels(s.fontSize, s.lineSpacing);
    const choice = chooseFitLevel(
      levels,
      (lv) => { setVars(lv); return sheet.scrollHeight; },
      printableHeightPx(s.pageOrientation),
    );
    sheet.style.width = saved.width;
    sheet.style.maxWidth = saved.maxWidth;
    sheet.style.padding = saved.padding;
    if (!hadExporting) doc.body.classList.remove('exporting');
    setVars(choice.level || original);

    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      setVars(original);
      root.removeEventListener('afterprint', restore);
    };
    root.addEventListener('afterprint', restore);
    if (ctx.onStatus) {
      const lv = choice.level || original;
      ctx.onStatus(
        choice.fits
          ? `Fitting to one page (font ${lv.fontSize}, spacing ${lv.lineSpacing}) — opening print dialog…`
          : 'Chart is longer than one page even at the smallest size — printing at the smallest size.',
      );
    }
    print();
    return choice;
  }

  const api = {
    REAL_BOOK_PRESET,
    applyPreset,
    classifyLine,
    normalizeMarker,
    foldRepeats,
    toRealBookCSMPN,
    buildFitLevels,
    chooseFitLevel,
    printableHeightPx,
    printableWidthPx,
    printWithAutoFit,
  };
  root.RealBook = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

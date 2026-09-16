/**
 * lyricsView.js — "Lyrics View": chord-free lyric sheets for stage reading.
 *
 * Strips ALL chords / musical markup from the current chart and renders a
 * dark, large-type, scrollable lyrics-only page. Section headers (Verse /
 * Chorus / Bridge / …) are preserved so the singer keeps their place.
 *
 * Supports every text format the app authors and imports:
 *   • CSMPN  — reads `;`-prefixed lyric lines (Pro's canonical lyric syntax,
 *     see `filterLyricsLines` in settings.js), keeps `- : = ==` section markers.
 *   • ChordPro — strips `[Chord]lyric` brackets, converts {soc}/{sov}/{sob}/
 *     {c:…} directives to section headers, drops {sot}…{eot} tabs.
 *   • Plain / UG chord-over-lyrics — drops standalone chord-only lines
 *     (≥70% chord tokens), keeps lyrics, treats `[Section]` on its own line
 *     as a header.
 *
 * This is a PURE, DOM-free extraction library (unit-tested): it turns any
 * chart the app authors/imports into a `{ title, sections:[{header, lines}] }`
 * sheet. Consumers: Setlist → Stage Sheets (`stageSheets.js`) and Perform
 * Lyrics' "⬆ Load current chart" (both call `extractLyrics`).
 *
 * The former standalone "Lyrics" modal view (`openLyricsView` + its scroll/
 * print runtime) was retired 2026-09-16 — Perform Lyrics (performanceLyrics.js)
 * is the single, superior stage view, and it now reads the current chart via
 * this library, so the redundant button/modal was removed.
 */
(function () {
  // ── Format detection ─────────────────────────────────────────────────────
  var CSMPN_META_RE =
    /^(Title|Composer|Artist|Style|Time|Tempo|Key|Capo|Album|Year|CCLI)\s*:/i;
  // Chord line heuristic: tokens that look like chord symbols
  var CHORD_TOKEN_RE =
    /^\(?[A-G][#♯b♭]?(?:m|maj|min|dim|aug|sus|add|Δ|°|ø)?[0-9]*(?:[#♯b♭][0-9]+)*(?:\/[A-G][#♯b♭]?)?\)?$/;
  var UG_SECTION_RE = /^\[([^\]]+)\]$/;

  function isCsmpnLike(text) {
    if (!text) return false;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length && i < 20; i++) {
      if (CSMPN_META_RE.test(lines[i].trim())) return true;
    }
    // `;` lyric lines OR `|`-bar chord lines are strong CSMPN signals
    var barLines = 0;
    var lyricLines = 0;
    for (var j = 0; j < lines.length; j++) {
      var t = lines[j].trim();
      if (t.startsWith(';')) lyricLines++;
      if (t.startsWith('|') || /\|\s*$/.test(t)) barLines++;
    }
    return lyricLines > 0 || barLines >= 2;
  }

  function isChordProLike(text) {
    if (!text) return false;
    // Any {directive:value} OR any inline [Chord]word bracket
    return /\{[a-z_]+(?::[^}]*)?\}/i.test(text) || /\[[A-Ga-g][^\]]*\][^\s\[\]]/.test(text);
  }

  /** 'csmpn' | 'chordpro' | 'plain'. Order matters: CSMPN wins over ChordPro. */
  function detectLyricsFormat(text) {
    if (isCsmpnLike(text)) return 'csmpn';
    if (isChordProLike(text)) return 'chordpro';
    return 'plain';
  }

  // ── Shared helpers ───────────────────────────────────────────────────────
  function trimBlankEdges(lines) {
    var s = 0;
    var e = lines.length;
    while (s < e && lines[s] === '') s++;
    while (e > s && lines[e - 1] === '') e--;
    return lines.slice(s, e);
  }

  function dropEmptySections(sections) {
    return sections.filter(function (sec) {
      return sec.lines.length > 0;
    });
  }

  function makeSheet(title, sections) {
    return {
      title: title || '',
      sections: dropEmptySections(
        sections.map(function (s) {
          return { header: s.header || '', lines: trimBlankEdges(s.lines) };
        }),
      ),
    };
  }

  // ── CSMPN extraction ─────────────────────────────────────────────────────
  // CSMPN lyric lines start with ';'. Section markers start with '-', ':',
  // '=', or '=='. Everything else (bar lines with `|`, chord tokens,
  // `{tab}`/`{hybrid}` blocks, `#` comments, `//` diagram defs) is skipped.
  function extractLyricsFromCsmpn(text) {
    var lines = String(text || '').split(/\r?\n/);
    var title = '';
    var sections = [{ header: '', lines: [] }];
    var inBlock = 0; // depth counter for `{...}` blocks (tab / hybrid / etc.)

    function last() {
      return sections[sections.length - 1];
    }
    function startSection(header) {
      sections.push({ header: header, lines: [] });
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = raw.trim();

      // Multi-line {tab …} / {hybrid …} blocks — skip content between { and }
      // (matched at line start; the CSMPN parser treats these as bar-decoration).
      if (inBlock > 0) {
        for (var c = 0; c < t.length; c++) {
          if (t[c] === '{') inBlock++;
          else if (t[c] === '}') inBlock--;
        }
        continue;
      }
      if (/^\{[a-z]+\b/i.test(t) && !/\}\s*$/.test(t)) {
        // opening a multi-line block
        inBlock = 0;
        for (var c2 = 0; c2 < t.length; c2++) {
          if (t[c2] === '{') inBlock++;
          else if (t[c2] === '}') inBlock--;
        }
        if (inBlock < 0) inBlock = 0;
        continue;
      }
      if (/^\{[a-z]+\b[^}]*\}\s*$/i.test(t)) continue; // one-line block

      if (!t) {
        var s = last();
        if (s.lines.length && s.lines[s.lines.length - 1] !== '') s.lines.push('');
        continue;
      }

      // # comment
      if (t.charAt(0) === '#') continue;
      // // chord diagram definition
      if (t.slice(0, 2) === '//') continue;

      // Header metadata: Title:, Composer:, etc.
      if (CSMPN_META_RE.test(t)) {
        var mm = t.match(/^([A-Za-z]+)\s*:\s*(.*)$/);
        if (mm && mm[1].toLowerCase() === 'title') title = mm[2].trim();
        continue;
      }

      // Lyric line: ';' prefix
      if (t.charAt(0) === ';') {
        var lyric = t.slice(1).trim();
        // A `; ` line with nothing after is a paragraph break.
        if (!lyric) {
          var s2 = last();
          if (s2.lines.length && s2.lines[s2.lines.length - 1] !== '') s2.lines.push('');
        } else {
          last().lines.push(lyric);
        }
        continue;
      }

      // Section marker: '==' first (before '=' single)
      if (t.slice(0, 2) === '==') {
        startSection(t.slice(2).trim());
        continue;
      }
      var lead = t.charAt(0);
      if (lead === '-' || lead === ':' || lead === '=') {
        startSection(t.slice(1).trim());
        continue;
      }

      // Everything else is chord / bar content — drop.
    }

    return makeSheet(title, sections);
  }

  // ── ChordPro extraction (also used for MusicXML/GP-derived ChordPro) ─────
  var CP_DIRECTIVE_RE = /^\{([^:}]+)(?::([^}]*))?\}$/;
  var CP_META = {
    title: 1,
    t: 1,
    artist: 1,
    a: 1,
    subtitle: 1,
    st: 1,
    composer: 1,
    key: 1,
    tempo: 1,
    time: 1,
    capo: 1,
    album: 1,
    year: 1,
    ccli: 1,
    columns: 1,
    col: 1,
    colb: 1,
  };

  function cpHeaderFromDirective(k, v) {
    var key = k.toLowerCase();
    if (key === 'comment' || key === 'c' || key === 'comment_italic' || key === 'ci' ||
        key === 'comment_box' || key === 'cb') {
      return (v && v.trim()) || null;
    }
    if (key === 'soc' || key === 'start_of_chorus') return (v && v.trim()) || 'Chorus';
    if (key === 'sov' || key === 'start_of_verse') return (v && v.trim()) || 'Verse';
    if (key === 'sob' || key === 'start_of_bridge') return (v && v.trim()) || 'Bridge';
    return null;
  }

  function stripInlineChords(line) {
    return line
      .replace(/\[[^\]]*\]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  /** Test whether a line is a chord-only line (≥70% chord-looking tokens). */
  function isChordOnlyLine(line) {
    var toks = line.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) return false;
    var hits = 0;
    for (var i = 0; i < toks.length; i++) if (CHORD_TOKEN_RE.test(toks[i])) hits++;
    return hits / toks.length >= 0.7;
  }

  function extractLyricsFromChordPro(text) {
    var lines = String(text || '').split(/\r?\n/);
    var title = '';
    var sections = [{ header: '', lines: [] }];
    var inTab = false;

    function last() {
      return sections[sections.length - 1];
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var t = raw.trim();

      var dir = t.match(CP_DIRECTIVE_RE);
      if (dir) {
        var k = dir[1].trim().toLowerCase();
        var v = dir[2] != null ? dir[2].trim() : '';
        if (k === 'sot' || k === 'start_of_tab') { inTab = true; continue; }
        if (k === 'eot' || k === 'end_of_tab') { inTab = false; continue; }
        if (k === 'title' || k === 't') { title = v; continue; }
        if (CP_META[k]) continue;
        var header = cpHeaderFromDirective(k, v);
        if (header) sections.push({ header: header, lines: [] });
        continue;
      }
      if (inTab) continue;

      if (!t) {
        var s = last();
        if (s.lines.length && s.lines[s.lines.length - 1] !== '') s.lines.push('');
        continue;
      }
      if (t.charAt(0) === '#' || t.charAt(0) === '%') continue;

      // UG-style section header
      var ug = t.match(UG_SECTION_RE);
      if (ug) {
        sections.push({ header: ug[1].trim(), lines: [] });
        continue;
      }

      // Standalone chord-only line — drop (chords-over-words dialect)
      if (t.indexOf('[') === -1 && isChordOnlyLine(t)) continue;

      var lyric = stripInlineChords(t);
      if (!lyric) continue;
      last().lines.push(lyric);
    }
    return makeSheet(title, sections);
  }

  // ── Plain / chord-over-lyrics extraction ─────────────────────────────────
  // Same rules as ChordPro but without directive handling.
  function extractLyricsFromPlain(text) {
    var lines = String(text || '').split(/\r?\n/);
    var title = '';
    var sections = [{ header: '', lines: [] }];

    function last() {
      return sections[sections.length - 1];
    }

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();

      if (!t) {
        var s = last();
        if (s.lines.length && s.lines[s.lines.length - 1] !== '') s.lines.push('');
        continue;
      }
      if (t.charAt(0) === '#') continue;

      var ug = t.match(UG_SECTION_RE);
      if (ug) {
        sections.push({ header: ug[1].trim(), lines: [] });
        continue;
      }

      // First non-directive line with no chord chars — treat as title (once)
      if (!title && t.indexOf('[') === -1 && !isChordOnlyLine(t) &&
          t.length < 80 && !/[.!?]$/.test(t) && sections.length === 1 &&
          sections[0].lines.length === 0) {
        title = t;
        continue;
      }

      // Chord-only line (with brackets or bare) — drop
      var stripped = stripInlineChords(t);
      if (!stripped) continue;
      if (t.indexOf('[') === -1 && isChordOnlyLine(t)) continue;

      last().lines.push(stripped);
    }
    return makeSheet(title, sections);
  }

  // ── Top-level dispatcher ─────────────────────────────────────────────────
  function extractLyrics(text, format) {
    var f = format || detectLyricsFormat(text);
    if (f === 'csmpn') return extractLyricsFromCsmpn(text);
    if (f === 'chordpro') return extractLyricsFromChordPro(text);
    return extractLyricsFromPlain(text);
  }

  function sheetHasLyrics(sheet) {
    if (!sheet || !sheet.sections) return false;
    for (var i = 0; i < sheet.sections.length; i++) {
      var s = sheet.sections[i];
      for (var j = 0; j < s.lines.length; j++) if (s.lines[j] !== '') return true;
    }
    return false;
  }

  var api = {
    detectLyricsFormat: detectLyricsFormat,
    extractLyricsFromCsmpn: extractLyricsFromCsmpn,
    extractLyricsFromChordPro: extractLyricsFromChordPro,
    extractLyricsFromPlain: extractLyricsFromPlain,
    extractLyrics: extractLyrics,
    sheetHasLyrics: sheetHasLyrics,
    stripInlineChords: stripInlineChords,
    isChordOnlyLine: isChordOnlyLine,
  };
  if (typeof window !== 'undefined') window.LyricsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

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
 * The pure functions (extractLyricsFromCsmpn / …ChordPro / …Plain /
 * extractLyrics / detectLyricsFormat) take no DOM and are unit-tested.
 * The `openLyricsView` runtime is the only browser-only part — builds a
 * full-screen modal on demand, wires ▶ Auto-scroll, ⎙ Print, ↓ HTML.
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

  // ── HTML export (self-contained, iOS-safe) ───────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Build a standalone auto-scrolling HTML page for the sheet. `opts` may
   * carry `secondsPerLine` (default 4), `fontSize` (default 32), and
   * `textColor`/`bgColor` (defaults white on black).
   */
  function buildLyricsHtml(sheet, opts) {
    opts = opts || {};
    var sec = opts.secondsPerLine == null ? 4 : Number(opts.secondsPerLine);
    var fs = opts.fontSize == null ? 32 : Number(opts.fontSize);
    var fg = opts.textColor || '#FFFFFF';
    var bg = opts.bgColor || '#000000';
    var docTitle = sheet && sheet.title ? sheet.title : 'Lyrics';

    var parts = [];
    parts.push('<div id="lv-scroll" style="padding: 5vh 6vw 70vh;">');
    parts.push('<div class="lv-song">');
    if (sheet.title) parts.push('<h1 class="lv-title">' + escapeHtml(sheet.title) + '</h1>');
    for (var i = 0; i < sheet.sections.length; i++) {
      var s = sheet.sections[i];
      parts.push('<section class="lv-section">');
      if (s.header) parts.push('<h2 class="lv-header">' + escapeHtml(s.header) + '</h2>');
      for (var j = 0; j < s.lines.length; j++) {
        var ln = s.lines[j];
        parts.push(ln === '' ? '<div class="lv-break"></div>'
          : '<div class="lv-line">' + escapeHtml(ln) + '</div>');
      }
      parts.push('</section>');
    }
    parts.push('</div></div>');

    return [
      '<!DOCTYPE html>',
      '<html lang="en"><head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
      '<title>' + escapeHtml(docTitle) + '</title>',
      '<style>',
      ':root { --fg: ' + fg + '; --bg: ' + bg + '; }',
      '* { box-sizing: border-box; -webkit-text-size-adjust: 100%; }',
      'html,body { margin:0; padding:0; background:var(--bg); color:var(--fg);',
      '  font-family: -apple-system, "SF Pro Text", Arial, Helvetica, sans-serif; }',
      '.lv-song { max-width: 1100px; margin: 0 auto; line-height: 1.5; }',
      '.lv-title { text-align:center; font-size: ' + Math.round(fs * 1.6) + 'px; font-weight: 800; margin: 0 0 .4em; }',
      '.lv-section { margin-top: 1.3em; }',
      '.lv-header { font-size: ' + Math.round(fs * 1.05) + 'px; font-weight: 800; letter-spacing: .06em;',
      '  text-transform: uppercase; opacity: .85; margin: .8em 0 .3em; border-bottom: 1px solid currentColor;',
      '  padding-bottom: .1em; }',
      '.lv-line { font-size: ' + fs + 'px; font-weight: 700; }',
      '.lv-break { height: ' + Math.round(fs * 0.6) + 'px; }',
      '#lv-controls { position: fixed; left:0; right:0; bottom:0; display:flex; gap:1rem;',
      '  align-items:center; padding:.5rem 1rem; background:rgba(0,0,0,.85); border-top:1px solid var(--fg);',
      '  font-size:14px; z-index:10; }',
      '#lv-controls button { font-size:16px; padding:.35rem 1rem; background: var(--fg); color: var(--bg);',
      '  border:none; border-radius:6px; font-weight:800; cursor:pointer; }',
      '#lv-controls label { display:flex; align-items:center; gap:.4rem; flex:1; }',
      '#lv-controls input[type=range] { flex:1; }',
      '@media print { #lv-controls { display:none; } #lv-scroll { padding-bottom: 4vh; } }',
      '</style></head><body>',
      parts.join('\n'),
      '<div id="lv-controls">',
      '  <button id="lv-toggle" type="button">▶ Auto-scroll</button>',
      '  <label>Speed <input id="lv-speed" type="range" min="1" max="10" step="0.5" value="' + sec + '">',
      '    <span id="lv-speedval">' + sec + 's/line</span></label>',
      '</div>',
      '<script>',
      '(function(){var running=false,raf=null,last=null,accum=0;',
      'var toggle=document.getElementById("lv-toggle"),speed=document.getElementById("lv-speed"),',
      'sv=document.getElementById("lv-speedval");',
      'function lh(){var el=document.querySelector(".lv-line");return el?el.getBoundingClientRect().height:' + fs * 1.5 + ';}',
      'function pps(){return lh()/parseFloat(speed.value);}',
      'function step(ts){if(!running)return;if(last==null){last=ts;raf=requestAnimationFrame(step);return;}',
      'var dt=(ts-last)/1000;last=ts;accum+=pps()*dt;window.scrollTo(0,accum);',
      'if((window.innerHeight+window.scrollY)>=(document.body.scrollHeight-2)){stop();return;}',
      'raf=requestAnimationFrame(step);}',
      'function start(){running=true;last=null;accum=window.scrollY;toggle.textContent="❚❚ Pause";raf=requestAnimationFrame(step);}',
      'function stop(){running=false;toggle.textContent="▶ Auto-scroll";if(raf)cancelAnimationFrame(raf);}',
      'toggle.addEventListener("click",function(){running?stop():start();});',
      'speed.addEventListener("input",function(){sv.textContent=speed.value+"s/line";});',
      'document.getElementById("lv-scroll").addEventListener("click",function(){if(running)stop();});',
      '})();',
      '</script></body></html>',
    ].join('\n');
  }

  // ── Browser modal runtime ────────────────────────────────────────────────
  var modalOpen = false;
  var autoScrollRaf = null;

  function loadFont(size) {
    var saved = null;
    try {
      saved = localStorage.getItem('lyricsView.fontSize');
    } catch (_) {
      // noop
    }
    var n = saved ? Number(saved) : NaN;
    if (!isFinite(n) || n < 18 || n > 80) return size || 32;
    return n;
  }
  function saveFont(size) {
    try {
      localStorage.setItem('lyricsView.fontSize', String(size));
    } catch (_) {
      // noop
    }
  }

  function renderSheetInto(el, sheet, fontSize) {
    // The container `el` styles set the background + text color; sizes are
    // per-element so the font slider is live-adjustable without a re-render.
    var html = [];
    html.push('<div class="lv-inner">');
    if (sheet.title) {
      html.push('<h1 class="lv-title" style="font-size:' + Math.round(fontSize * 1.6) + 'px">'
        + escapeHtml(sheet.title) + '</h1>');
    }
    if (!sheet.sections.length) {
      html.push('<p class="lv-empty">No lyrics found in this chart.</p>');
      html.push('<p class="lv-empty-hint">Add lyric lines starting with <code>;</code> in your CSMPN source, e.g. <code>; When I find myself in times of trouble</code>.</p>');
    }
    for (var i = 0; i < sheet.sections.length; i++) {
      var s = sheet.sections[i];
      html.push('<section class="lv-section">');
      if (s.header) {
        html.push('<h2 class="lv-header" style="font-size:' + Math.round(fontSize * 1.05) + 'px">'
          + escapeHtml(s.header) + '</h2>');
      }
      for (var j = 0; j < s.lines.length; j++) {
        var ln = s.lines[j];
        if (ln === '') {
          html.push('<div class="lv-break" style="height:' + Math.round(fontSize * 0.6) + 'px"></div>');
        } else {
          html.push('<div class="lv-line" style="font-size:' + fontSize + 'px">' + escapeHtml(ln) + '</div>');
        }
      }
      html.push('</section>');
    }
    html.push('</div>');
    el.innerHTML = html.join('\n');
  }

  function updateSizes(el, fontSize) {
    // Live font-size update without re-rendering the whole tree.
    var lines = el.querySelectorAll('.lv-line');
    for (var i = 0; i < lines.length; i++) lines[i].style.fontSize = fontSize + 'px';
    var headers = el.querySelectorAll('.lv-header');
    for (var j = 0; j < headers.length; j++) headers[j].style.fontSize = Math.round(fontSize * 1.05) + 'px';
    var title = el.querySelector('.lv-title');
    if (title) title.style.fontSize = Math.round(fontSize * 1.6) + 'px';
    var breaks = el.querySelectorAll('.lv-break');
    for (var k = 0; k < breaks.length; k++) breaks[k].style.height = Math.round(fontSize * 0.6) + 'px';
  }

  function stopAutoScroll() {
    if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
    }
  }

  function startAutoScroll(scrollEl, getSpeed, onEnd) {
    stopAutoScroll();
    var last = null;
    var accum = scrollEl.scrollTop;
    function step(ts) {
      if (last == null) { last = ts; autoScrollRaf = requestAnimationFrame(step); return; }
      var dt = (ts - last) / 1000;
      last = ts;
      var spl = typeof getSpeed === 'function' ? getSpeed() : getSpeed;
      var line = scrollEl.querySelector('.lv-line');
      var lh = line ? line.getBoundingClientRect().height : 40;
      accum += (lh / spl) * dt;
      scrollEl.scrollTop = accum;
      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2) {
        stopAutoScroll();
        if (onEnd) onEnd();
        return;
      }
      autoScrollRaf = requestAnimationFrame(step);
    }
    autoScrollRaf = requestAnimationFrame(step);
  }

  function ensureModalStyle() {
    if (document.getElementById('lyricsView-style')) return;
    var css = [
      '.lv-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;',
      '  display:flex;align-items:stretch;justify-content:center;}',
      '.lv-modal{position:relative;background:#000;color:#fff;width:100vw;height:100vh;',
      '  display:flex;flex-direction:column;font-family:-apple-system,"SF Pro Text",Arial,Helvetica,sans-serif;}',
      '.lv-bar{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;padding:.5rem .8rem;',
      '  background:#111;border-bottom:1px solid #333;font-size:14px;position:sticky;top:0;z-index:2;}',
      '.lv-bar h2{margin:0;font-size:15px;font-weight:800;flex:0 0 auto;color:#fff;}',
      '.lv-bar button{background:#fff;color:#000;border:none;border-radius:6px;padding:.35rem .8rem;',
      '  font-weight:700;cursor:pointer;font-size:14px;}',
      '.lv-bar button.lv-secondary{background:transparent;color:#fff;border:1px solid #666;}',
      '.lv-bar label{display:flex;align-items:center;gap:.35rem;color:#ccc;}',
      '.lv-bar input[type=range]{width:120px;}',
      '.lv-bar .lv-spacer{flex:1;}',
      '.lv-scroll{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;',
      '  background:#000;color:#fff;padding:4vh 6vw 40vh;}',
      '.lv-inner{max-width:1100px;margin:0 auto;line-height:1.5;}',
      '.lv-title{text-align:center;font-weight:800;margin:0 0 .4em;}',
      '.lv-section{margin-top:1.2em;}',
      '.lv-header{font-weight:800;letter-spacing:.06em;text-transform:uppercase;opacity:.85;',
      '  margin:.7em 0 .3em;border-bottom:1px solid currentColor;padding-bottom:.1em;}',
      '.lv-line{font-weight:700;}',
      '.lv-empty{opacity:.75;font-size:16px;}',
      '.lv-empty-hint{opacity:.6;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}',
      '.lv-empty code{background:#222;padding:.1em .35em;border-radius:4px;}',
      '@media print { .lv-bar { display:none !important; } .lv-scroll { padding: 0 !important;',
      '  overflow:visible !important; height:auto !important; } .lv-backdrop { position:static;',
      '  background:#fff; } .lv-modal { background:#fff !important; color:#000 !important;',
      '  width:auto !important; height:auto !important; } .lv-line, .lv-title, .lv-header {',
      '  color:#000 !important; } .lv-header { border-bottom-color:#000 !important; } }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'lyricsView-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function downloadText(text, filename, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function safeFilename(name) {
    return String(name || 'lyrics').replace(/[^\w\-.]+/g, '_').slice(0, 60) || 'lyrics';
  }

  /**
   * Open the full-screen Lyrics View modal. `getSource()` is called each
   * time the modal opens so the freshest CSMPN source is used (works with
   * the app's transpose-in-place editing model, though Lyrics View itself
   * has no chord notion — transpose is irrelevant to lyrics).
   */
  function openLyricsView(getSource, getTitle) {
    if (modalOpen) return;
    modalOpen = true;
    ensureModalStyle();

    var text = typeof getSource === 'function' ? getSource() : String(getSource || '');
    var sheet = extractLyrics(text);
    // Fall back to the source's own title if the extractor couldn't find one.
    if (!sheet.title && typeof getTitle === 'function') sheet.title = getTitle() || '';

    var fontSize = loadFont(32);

    var backdrop = document.createElement('div');
    backdrop.className = 'lv-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'Lyrics View');
    var modal = document.createElement('div');
    modal.className = 'lv-modal';

    var bar = document.createElement('div');
    bar.className = 'lv-bar';
    bar.innerHTML = [
      '<h2>🎤 Lyrics</h2>',
      '<button type="button" class="lv-toggle">▶ Auto-scroll</button>',
      '<label>Speed <input type="range" class="lv-speed" min="1" max="10" step="0.5" value="4">',
      '<span class="lv-speedval">4s/line</span></label>',
      '<label>Text <input type="range" class="lv-font" min="18" max="72" step="2" value="' + fontSize + '">',
      '<span class="lv-fontval">' + fontSize + 'px</span></label>',
      '<span class="lv-spacer"></span>',
      '<button type="button" class="lv-secondary lv-print">⎙ Print / Save PDF</button>',
      '<button type="button" class="lv-secondary lv-html">↓ HTML</button>',
      '<button type="button" class="lv-close">✕ Close</button>',
    ].join('');

    var scroll = document.createElement('div');
    scroll.className = 'lv-scroll';
    renderSheetInto(scroll, sheet, fontSize);

    modal.appendChild(bar);
    modal.appendChild(scroll);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    function close() {
      stopAutoScroll();
      backdrop.remove();
      modalOpen = false;
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);

    bar.querySelector('.lv-close').addEventListener('click', close);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });

    var toggle = bar.querySelector('.lv-toggle');
    var speed = bar.querySelector('.lv-speed');
    var speedval = bar.querySelector('.lv-speedval');
    var font = bar.querySelector('.lv-font');
    var fontval = bar.querySelector('.lv-fontval');

    toggle.addEventListener('click', function () {
      if (autoScrollRaf) {
        stopAutoScroll();
        toggle.textContent = '▶ Auto-scroll';
      } else {
        toggle.textContent = '❚❚ Pause';
        startAutoScroll(scroll, function () { return parseFloat(speed.value); }, function () {
          toggle.textContent = '▶ Auto-scroll';
        });
      }
    });
    speed.addEventListener('input', function () {
      speedval.textContent = speed.value + 's/line';
    });
    // Tap the lyrics area to pause auto-scroll.
    scroll.addEventListener('click', function () {
      if (autoScrollRaf) {
        stopAutoScroll();
        toggle.textContent = '▶ Auto-scroll';
      }
    });

    font.addEventListener('input', function () {
      fontSize = Number(font.value);
      fontval.textContent = fontSize + 'px';
      updateSizes(scroll, fontSize);
      saveFont(fontSize);
    });

    bar.querySelector('.lv-html').addEventListener('click', function () {
      var html = buildLyricsHtml(sheet, { secondsPerLine: parseFloat(speed.value), fontSize: fontSize });
      downloadText(html, safeFilename(sheet.title) + '-lyrics.html', 'text/html;charset=utf-8');
    });

    bar.querySelector('.lv-print').addEventListener('click', function () {
      // iOS Safari: native print dialog turns the modal (with the CSS @media
      // print rules in ensureModalStyle) into a lyrics-only PDF via
      // Share → Print → pinch-out.
      window.print();
    });
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
    buildLyricsHtml: buildLyricsHtml,
    openLyricsView: openLyricsView,
  };
  if (typeof window !== 'undefined') window.LyricsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

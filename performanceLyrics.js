/**
 * performanceLyrics.js — "Performance Lyrics Mode" (browser global + window.PerformanceLyrics).
 *
 * The inverse of the app's chord-centric pipeline. Instead of turning a source
 * into a chord chart, this takes a RAW external lyric page — a chord-over-lyrics
 * sheet, an AZLyrics-style plain page, or a Genius-style page with [Section]
 * headers — and turns it into a clean, structured, AUTO-SCROLLING lyric sheet for
 * on-stage use, timed to the song's BPM and duration.
 *
 * This is deliberately SEPARATE from lyricsView.js. `LyricsView` strips chords
 * from the app's own CSMPN chart and scrolls by a manual speed slider.
 * `PerformanceLyrics` ingests raw pasted/pasted-from-the-web lyric text (which
 * the app never authored), infers sections when the page has none, and computes a
 * per-line TIMING PLAN from BPM + duration so the scroll follows the song.
 *
 * Everything above `openPerformanceLyrics` is PURE (no DOM, no browser globals)
 * and unit-tested in tests/performanceLyrics.test.mjs. `openPerformanceLyrics`
 * (and its helpers below the `── runtime ──` divider) is the only browser-only
 * part — it builds a full-screen stage modal on demand.
 *
 * ASSUMPTION (no CLAUDE.md guidance for a whole new top-level mode): rather than
 * add a new mode tab to the 318 KB index.html monolith, this ships as a modal
 * launched from a button, exactly like LyricsView/StageSheets — self-contained,
 * zero risk to the existing chord-chart workflows, offline after first load.
 */
(function () {
  'use strict';

  // ── constants ──────────────────────────────────────────────────────────────

  // A chord token: optional bracket, root A–G, accidental, quality, extensions,
  // optional slash bass. Mirrors the family chord grammar (see lyricsView.js /
  // chordProcessing.js) so the same symbols read as chords everywhere.
  var CHORD_TOKEN_RE =
    /^\(?(?:N\.C\.|[A-G][#♯b♭]?(?:m|maj|min|Maj|M|dim|aug|sus|add|Δ|°|o|ø)?[0-9]*(?:[#♯b♭+\-][0-9]+)*(?:sus[0-9]*)?(?:add[0-9]+)?(?:\/[A-G][#♯b♭]?)?)\)?$/;

  // Bracketed inline chord: [Am7], {C#m}, {C#m/E}. Kept narrow so a bracketed
  // lyric aside ("[chorus]") isn't stripped as a chord.
  var INLINE_CHORD_RE = /[\[{]\s*(?:N\.C\.|[A-G][#♯b♭]?[^\]}\s]*)\s*[\]}]/g;

  // Explicit Genius-style section header on its own line: [Verse 1], [Chorus], …
  // Also accepts a bare "Verse 1:" / "Chorus" line (some pages drop the brackets).
  var SECTION_WORDS =
    'intro|verse|pre-?chorus|chorus|bridge|outro|hook|instrumental|refrain|tag|solo|interlude|coda|vamp|breakdown|ending|chant';
  var BRACKET_SECTION_RE = new RegExp('^\\[\\s*((?:' + SECTION_WORDS + ')[^\\]]*)\\]\\s*$', 'i');
  var BARE_SECTION_RE = new RegExp('^\\s*((?:' + SECTION_WORDS + ')(?:\\s*\\d+)?)\\s*:?\\s*$', 'i');

  // Zero-width and BOM characters that survive a copy/paste from the web.
  var ZERO_WIDTH_RE = /[​‌‍﻿⁠]/g;

  // Boilerplate lines injected by lyric sites. Matched case-insensitively against
  // the whole trimmed line (some are substrings — see BOILERPLATE_SUBSTR).
  var BOILERPLATE_EXACT = [
    'edit lyrics',
    'edit',
    'submit corrections',
    'you might also like',
    'embed',
    'share',
    'share url',
    'print',
    'add to playlist',
    'more on genius',
    'about',
    'lyrics',
    'advertisement',
    'see live',
    'get tickets as low as $',
  ];
  var BOILERPLATE_SUBSTR = [
    'you might also like',
    'submit corrections',
    'lyrics licensed',
    'lyrics provided',
    'all rights reserved',
    'azlyrics.com',
    'genius.com',
    'contributed by',
    'translations',
    'read more',
    'embed',
  ];
  // Copyright / credit lines — a © or "Writer(s):" / "Producer:" credit line.
  var CREDIT_RE =
    /^\s*(?:©|\(c\)|copyright\b|writ(?:er|ten by|ers?)\b|producer\b|produced by\b|\d+\s+contributors?\b|\d+\s+embed\b)/i;
  // A line that is only an ad/embed placeholder or a naked view count.
  var AD_RE = /^\s*(?:\[?advertisement\]?|\d[\d,.]*\s*(?:views?|contributors?)|embed)\s*$/i;

  // Metadata patterns.
  var BPM_RE = /\b(\d{2,3})\s*(?:BPM|bpm)\b/;
  var TEMPO_LABEL_RE = /\btempo\s*[:=]\s*(\d{2,3})\b/i;
  var TIMESIG_LABEL_RE = /\btime\s*signature\s*[:=]\s*(\d{1,2}\s*\/\s*\d{1,2})\b/i;
  var TIMESIG_BARE_RE = /(?:^|\s)(\d{1,2}\/\d{1,2})(?:\s|$)/;
  var DURATION_RE = /\b(\d{1,2})\s*[:.]\s*([0-5]?\d)\b/;

  // HTML entities that commonly survive a copy from a rendered lyric page.
  var ENTITIES = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&#039;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&rsquo;': '’',
    '&lsquo;': '‘',
    '&rdquo;': '”',
    '&ldquo;': '“',
  };

  // ── normalization ──────────────────────────────────────────────────────────

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s
      .replace(/&amp;|&lt;|&gt;|&quot;|&#0?39;|&apos;|&nbsp;|&mdash;|&ndash;|&hellip;|&rsquo;|&lsquo;|&rdquo;|&ldquo;/g, function (m) {
        return ENTITIES[m] || m;
      })
      .replace(/&#(\d+);/g, function (_m, n) {
        var code = parseInt(n, 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : _m;
      });
  }

  /**
   * CRLF→LF, strip zero-width chars, decode HTML entities, and trim trailing
   * whitespace per line. Leading whitespace is preserved on non-empty lines only
   * enough to keep intentional indentation out (lyric pages have none) — we trim
   * both ends per line since raw lyric pages carry no meaningful indent.
   */
  function normalizeText(raw) {
    var text = String(raw == null ? '' : raw);
    text = text.replace(/\r\n?/g, '\n').replace(ZERO_WIDTH_RE, '');
    text = decodeEntities(text);
    var lines = text.split('\n').map(function (l) {
      return l.replace(/\s+$/, '').replace(/^\s+/, '');
    });
    return lines;
  }

  // ── chord detection / stripping ────────────────────────────────────────────

  function isChordToken(tok) {
    return CHORD_TOKEN_RE.test(tok);
  }

  // Does this line have alphabetic "words" that clearly aren't chords? Used to
  // stop a lyric line ("A day in the life") reading as an all-chord line.
  function hasLyricWords(line) {
    var words = line.split(/\s+/).filter(Boolean);
    for (var i = 0; i < words.length; i++) {
      if (!isChordToken(words[i]) && /[A-Za-z]{2,}/.test(words[i])) {
        // A 2+ letter word that isn't a chord token is a lyric word — unless it
        // is itself a bare chord like "Am"/"maj7" fragments handled above.
        return true;
      }
    }
    return false;
  }

  /**
   * A chord-above line: >60% of its whitespace tokens parse as chords AND it
   * contains no alphabetic lyric words. Blank lines are not chord lines.
   */
  function isChordOnlyLine(line) {
    var t = String(line || '').trim();
    if (!t) return false;
    var tokens = t.split(/\s+/).filter(Boolean);
    if (!tokens.length) return false;
    var chordCount = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (isChordToken(tokens[i])) chordCount++;
    }
    if (chordCount / tokens.length <= 0.6) return false;
    return !hasLyricWords(t);
  }

  /**
   * Strip inline chords from a lyric line while preserving the words.
   *  - bracketed tokens [Am7] / {C#m} are always removed;
   *  - an unbracketed chord-like token is removed ONLY when it is a standalone
   *    whitespace-delimited token (never a substring of a word). "Amazing" keeps
   *    its "Am"; a lone "Am" between spaces goes.
   */
  function stripInlineChords(line) {
    var s = String(line || '').replace(INLINE_CHORD_RE, ' ');
    var tokens = s.split(/(\s+)/); // keep the separators
    var out = tokens.map(function (tok) {
      if (/^\s+$/.test(tok) || tok === '') return tok;
      return isChordToken(tok) ? '' : tok;
    });
    // Collapse the runs of whitespace we may have opened up.
    return out.join('').replace(/[ \t]{2,}/g, ' ').trim();
  }

  // ── metadata ───────────────────────────────────────────────────────────────

  function isSectionHeader(line) {
    return BRACKET_SECTION_RE.test(line) || BARE_SECTION_RE.test(line);
  }

  function sectionLabelOf(line) {
    var m = BRACKET_SECTION_RE.exec(line);
    if (m) return tidyLabel(m[1]);
    m = BARE_SECTION_RE.exec(line);
    if (m) return tidyLabel(m[1]);
    return null;
  }

  function tidyLabel(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  var TITLE_LABEL_RE = /^\s*title\s*[:=]\s*(.+)$/i;
  var ARTIST_LABEL_RE = /^\s*(?:artist|by)\s*[:=]\s*(.+)$/i;
  // A copied page title: quoted, or "… lyrics" — strong enough to consume.
  var STRONG_TITLE_RE = /^\s*(?:"([^"]+)"|“([^”]+)”)\s*(?:lyrics)?\s*$|^\s*(.+?)\s+lyrics\s*$/i;
  var BY_LINE_RE = /^\s*by\s+(.+)$/i;

  /**
   * Pull title/artist/bpm/time-signature off the page. Returns { meta, lines }
   * with the consumed metadata lines removed.
   *
   * Title/artist are consumed ONLY on a strong, unambiguous signal — a
   * `Title:`/`Artist:`/`By:` label, a quoted or "… lyrics" page title, or a
   * `by <name>` line right under a title. A plain content line is NEVER grabbed
   * as a title, so an untitled raw paste keeps its first verse intact (the UI
   * shows "Untitled"). BPM/time-signature are read anywhere.
   */
  function detectMetadata(lines) {
    var meta = { title: '', artist: '', bpm: null, timeSignature: '' };
    var consumed = {};

    // BPM / time-sig can appear anywhere (a "120 BPM" annotation line).
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (meta.bpm == null) {
        var mb = TEMPO_LABEL_RE.exec(line) || BPM_RE.exec(line);
        if (mb) meta.bpm = parseInt(mb[1], 10);
      }
      if (!meta.timeSignature) {
        var mt = TIMESIG_LABEL_RE.exec(line);
        if (mt) meta.timeSignature = mt[1].replace(/\s+/g, '');
      }
      // A line that is ONLY a bpm/tempo/time annotation is consumed.
      if (
        /^\s*(?:tempo\s*[:=]\s*)?\d{2,3}\s*bpm\s*$/i.test(line) ||
        /^\s*tempo\s*[:=]\s*\d{2,3}\s*$/i.test(line) ||
        /^\s*time\s*signature\s*[:=]/i.test(line)
      ) {
        consumed[i] = true;
      }
    }

    // Explicit labels anywhere near the top.
    for (var j = 0; j < lines.length && j < 8; j++) {
      if (consumed[j]) continue;
      var t = lines[j].trim();
      if (!meta.title) {
        var mtl = TITLE_LABEL_RE.exec(t);
        if (mtl) { meta.title = stripTitleNoise(mtl[1]); consumed[j] = true; continue; }
      }
      if (!meta.artist) {
        var mal = ARTIST_LABEL_RE.exec(t);
        if (mal) { meta.artist = mal[1].trim(); consumed[j] = true; continue; }
      }
    }

    // Strong page-title at the very top (first non-empty, non-consumed line).
    var firstIdx = -1;
    for (var f = 0; f < lines.length; f++) {
      if (consumed[f]) continue;
      if (!lines[f].trim()) continue;
      firstIdx = f;
      break;
    }
    if (!meta.title && firstIdx >= 0) {
      var ft = lines[firstIdx].trim();
      var st = STRONG_TITLE_RE.exec(ft);
      if (st && !isSectionHeader(ft) && !isChordOnlyLine(ft)) {
        meta.title = stripTitleNoise(st[1] || st[2] || st[3] || ft);
        consumed[firstIdx] = true;
        // A "by <artist>" line immediately below a consumed title.
        for (var n = firstIdx + 1; n < lines.length && n < firstIdx + 3; n++) {
          if (consumed[n]) continue;
          var nt = lines[n].trim();
          if (!nt) break;
          var by = BY_LINE_RE.exec(nt);
          if (by && !meta.artist) { meta.artist = by[1].trim(); consumed[n] = true; }
          break;
        }
      }
    }

    var kept = [];
    for (var k = 0; k < lines.length; k++) {
      if (!consumed[k]) kept.push(lines[k]);
    }
    return { meta: meta, lines: kept };
  }

  function stripTitleNoise(s) {
    return s.replace(/\s*lyrics\s*$/i, '').replace(/^["“]|["”]$/g, '').trim();
  }

  // ── syllable counting ──────────────────────────────────────────────────────

  /**
   * Lightweight English syllable heuristic (vowel groups, silent trailing e,
   * common -le ending, floor of 1). Not linguistically exact — good enough to
   * apportion scroll time. Non-English words fall back to vowel-group count and
   * never crash.
   */
  function countSyllables(word) {
    var w = String(word || '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    if (!w) return 0;
    if (w.length <= 3) return 1;
    // Count vowel groups (y counts as a vowel here — "rhythm" → 1).
    var groups = w.match(/[aeiouy]+/g);
    var n = groups ? groups.length : 0;
    // Silent trailing 'e' (e.g. "grace" → 1). Skipped for a "-le" ending, where
    // the e is the syllable nucleus ("table" → 2), and when a vowel precedes it
    // ("sweet"/"blue" — the e is already inside a counted group).
    if (/e$/.test(w) && !/le$/.test(w) && !/[aeiou]e$/.test(w)) n -= 1;
    return n < 1 ? 1 : n;
  }

  function lineSyllables(text) {
    var words = String(text || '')
      .split(/\s+/)
      .filter(Boolean);
    var total = 0;
    for (var i = 0; i < words.length; i++) total += countSyllables(words[i]);
    return total < 1 && words.length ? 1 : total;
  }

  // ── fingerprint / similarity (for inferring repeated choruses) ──────────────

  function fingerprint(lines) {
    return lines
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Levenshtein distance, capped iteration (block strings are short).
  function levenshtein(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    var prev = new Array(b.length + 1);
    var cur = new Array(b.length + 1);
    for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (var k = 1; k <= b.length; k++) {
        var cost = a.charCodeAt(i - 1) === b.charCodeAt(k - 1) ? 0 : 1;
        cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
      }
      var tmp = prev;
      prev = cur;
      cur = tmp;
    }
    return prev[b.length];
  }

  // Normalized similarity 0..1 (1 = identical).
  function similarity(a, b) {
    var fa = fingerprint([a]);
    var fb = fingerprint([b]);
    var max = Math.max(fa.length, fb.length);
    if (!max) return 1;
    return 1 - levenshtein(fa, fb) / max;
  }

  // ── section detection ──────────────────────────────────────────────────────

  function trimBlankEdges(lines) {
    var s = 0;
    var e = lines.length;
    while (s < e && !lines[s].trim()) s++;
    while (e > s && !lines[e - 1].trim()) e--;
    return lines.slice(s, e);
  }

  // Remove chord-only lines from a body, keeping lyric text and stripping any
  // inline chords that survive.
  function cleanLyricBody(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      if (isChordOnlyLine(raw)) continue;
      if (isBoilerplate(raw)) continue;
      var cleaned = stripInlineChords(raw);
      out.push(cleaned);
    }
    return out;
  }

  /**
   * Explicit-header path: the page already carries [Verse]/[Chorus]/… markers.
   * Returns an array of { label, lines } or null when no explicit header exists.
   */
  function detectExplicitSections(lines) {
    var hasHeader = false;
    for (var i = 0; i < lines.length; i++) {
      if (BRACKET_SECTION_RE.test(lines[i])) {
        hasHeader = true;
        break;
      }
    }
    if (!hasHeader) return null;

    var sections = [];
    var cur = null;
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      var label = BRACKET_SECTION_RE.test(line) ? sectionLabelOf(line) : null;
      if (label) {
        cur = { label: label, lines: [] };
        sections.push(cur);
        continue;
      }
      if (!cur) {
        cur = { label: 'Intro', lines: [] };
        sections.push(cur);
      }
      cur.lines.push(line);
    }
    // Clean bodies and drop empties.
    return sections
      .map(function (s) {
        return { label: s.label, lines: trimBlankEdges(cleanLyricBody(s.lines)) };
      })
      .filter(function (s) {
        return s.lines.length > 0;
      });
  }

  /**
   * Inferred path (AZLyrics-style, no headers): split the cleaned lyric body into
   * blocks on blank lines (or chord-only separators), find repeated blocks
   * (exact or ≥0.85 similar) → label them Chorus, and label the rest Verse 1..n,
   * with a short repeated pre-chorus and a distinct final Outro.
   */
  function detectInferredSections(lines) {
    // First, split into blocks by blank lines; drop chord-only + boilerplate.
    var blocks = [];
    var cur = [];
    function flush() {
      var body = trimBlankEdges(cleanLyricBody(cur));
      if (body.length) blocks.push(body);
      cur = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) {
        flush();
        continue;
      }
      cur.push(line);
    }
    flush();

    if (!blocks.length) return [];
    if (blocks.length === 1) {
      // No blank-line structure at all — one block. Keep as a single verse; the
      // caller's timing still works line-by-line.
      return [{ label: 'Verse 1', lines: blocks[0] }];
    }

    // Cluster blocks so repeats share a cluster id. Exact fingerprints match via
    // a hash map (O(1)) — identical repeated choruses hit this fast path. Only
    // when no exact match exists do we fall back to a fuzzy ≥0.85 Levenshtein
    // scan, and only while the distinct-cluster count is small (a real song has
    // a handful of section shapes). Past FUZZY_CLUSTER_CAP distinct clusters the
    // input is a document, not a song, so fuzzy matching is skipped and the pass
    // stays O(n) — this is what keeps a 10k-line paste under budget.
    var FUZZY_CLUSTER_CAP = 40;
    // Fuzzy (near-duplicate) matching only makes sense for a song-sized input; a
    // paste with hundreds of blocks is a document, and running an O(blocks·reps)
    // Levenshtein scan over it is both meaningless and slow. Past MAX_INFER_BLOCKS
    // we rely on exact-fingerprint matching only, keeping the whole pass O(n).
    var MAX_INFER_BLOCKS = 120;
    var doFuzzy = blocks.length <= MAX_INFER_BLOCKS;
    var clusterOf = new Array(blocks.length);
    var clusters = []; // { fp, count, lines }
    var byExactFp = Object.create(null);
    for (var b = 0; b < blocks.length; b++) {
      var fp = fingerprint(blocks[b]);
      var found = -1;
      if (byExactFp[fp] !== undefined) {
        found = byExactFp[fp];
      } else if (doFuzzy && clusters.length <= FUZZY_CLUSTER_CAP) {
        for (var c = 0; c < clusters.length; c++) {
          if (blockSimilarity(fp, clusters[c].fp) >= 0.85) {
            found = c;
            break;
          }
        }
      }
      if (found === -1) {
        clusters.push({ fp: fp, count: 0, lines: blocks[b] });
        found = clusters.length - 1;
        byExactFp[fp] = found;
      }
      clusters[found].count++;
      clusterOf[b] = found;
    }

    // The most-repeated cluster with >1 occurrence is the Chorus.
    var chorusCluster = -1;
    var bestCount = 1;
    for (var cc = 0; cc < clusters.length; cc++) {
      if (clusters[cc].count > bestCount) {
        bestCount = clusters[cc].count;
        chorusCluster = cc;
      }
    }

    // Label pass. The reliable calls are Chorus (the most-repeated block) and
    // Verse N (distinct blocks, numbered in order) — these drive the >80%
    // Verse/Chorus accuracy target. Bridge/Pre-Chorus/Outro are best-effort
    // refinements applied only when their structural signature is unambiguous, so
    // a plain Verse–Chorus–Verse–Chorus song never mislabels its second verse.
    var labelForCluster = {}; // non-chorus repeated cluster → its assigned label
    var verseNum = 0;
    var choruslabelled = false;
    var bridgeUsed = false;
    var out = [];
    for (var k = 0; k < blocks.length; k++) {
      var cid = clusterOf[k];
      var label;
      if (cid === chorusCluster) {
        label = 'Chorus';
        choruslabelled = true;
      } else if (labelForCluster[cid]) {
        // A previously-seen distinct-but-repeated block reuses its label.
        label = labelForCluster[cid];
      } else {
        var isShort = blocks[k].length < 4;
        var nextIsChorus = k + 1 < blocks.length && clusterOf[k + 1] === chorusCluster;
        var isLast = k === blocks.length - 1;
        var repeats = clusters[cid].count > 1;
        if (isShort && repeats && nextIsChorus) {
          // A short block that recurs immediately before the chorus = Pre-Chorus.
          label = 'Pre-Chorus';
          labelForCluster[cid] = label;
        } else if (isLast && choruslabelled && !repeats) {
          // A distinct final block after a chorus reads as an Outro.
          label = 'Outro';
        } else if (choruslabelled && verseNum >= 2 && !repeats && !isLast && !bridgeUsed) {
          // A single distinct block appearing only after ≥2 verses and a chorus,
          // and not final, is the classic bridge. Applied once.
          label = 'Bridge';
          bridgeUsed = true;
        } else {
          label = 'Verse ' + ++verseNum;
          if (repeats) labelForCluster[cid] = label; // a repeated verse keeps its number
        }
      }
      out.push({ label: label, lines: blocks[k] });
    }
    return out;
  }

  function blockSimilarity(fpA, fpB) {
    var max = Math.max(fpA.length, fpB.length);
    if (!max) return 1;
    // A length gap wider than 15% cannot reach 0.85 similarity — skip the
    // (relatively expensive) Levenshtein for those pairs.
    if (Math.abs(fpA.length - fpB.length) / max > 0.15) return 0;
    return 1 - levenshtein(fpA, fpB) / max;
  }

  function isBoilerplate(line) {
    var t = String(line || '').trim().toLowerCase();
    if (!t) return false;
    if (AD_RE.test(line)) return true;
    if (CREDIT_RE.test(line)) return true;
    for (var i = 0; i < BOILERPLATE_EXACT.length; i++) {
      if (t === BOILERPLATE_EXACT[i]) return true;
    }
    // "You might also like" often prefixes a real line — only drop when the whole
    // line is (close to) the phrase.
    if (t === 'you might also like') return true;
    for (var j = 0; j < BOILERPLATE_SUBSTR.length; j++) {
      if (t.length < 40 && t.indexOf(BOILERPLATE_SUBSTR[j]) !== -1) return true;
    }
    return false;
  }

  /** Remove obvious boilerplate lines up front (before metadata detection). */
  function stripBoilerplate(lines) {
    return lines.filter(function (l) {
      return !isBoilerplate(l);
    });
  }

  // ── top-level parse ────────────────────────────────────────────────────────

  /**
   * Full pipeline: raw text → structured model.
   *   { title, artist, bpm, timeSignature, sections:[{ label, lines:[text] }] }
   * `bpm`/`timeSignature` may be null/'' when the page carries no annotation.
   */
  function parseLyrics(raw) {
    var lines = normalizeText(raw);
    lines = stripBoilerplate(lines);
    var md = detectMetadata(lines);
    var body = md.lines;

    var sections = detectExplicitSections(body);
    if (!sections) sections = detectInferredSections(body);
    if (!sections.length) {
      // Nothing survived — keep whatever lyric lines exist as one section so the
      // stage view is never empty.
      var fallback = trimBlankEdges(cleanLyricBody(body));
      if (fallback.length) sections = [{ label: 'Lyrics', lines: fallback }];
    }

    return {
      title: md.meta.title || '',
      artist: md.meta.artist || '',
      bpm: md.meta.bpm,
      timeSignature: md.meta.timeSignature || '',
      sections: sections,
    };
  }

  // ── timing engine ──────────────────────────────────────────────────────────

  /** "3:45" | "3.45" | "225" → seconds. Returns 0 for unparseable input. */
  function parseDuration(str) {
    if (str == null) return 0;
    if (typeof str === 'number') return str > 0 ? str : 0;
    var s = String(str).trim();
    if (!s) return 0;
    var m = /^(\d{1,3})\s*[:.]\s*([0-5]?\d)$/.exec(s);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    var n = parseFloat(s);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function timeSigNumer(ts) {
    var m = /^(\d{1,2})\s*\/\s*\d{1,2}$/.exec(String(ts || '').trim());
    return m ? parseInt(m[1], 10) : 4;
  }

  /**
   * Compute a per-line timing plan and fold it into a copy of the model.
   *
   *   total_beats     = (BPM/60) * durationSeconds
   *   line beats      = ceil(lineSyllables / syllablesPerBeat)  (>=1)
   *   plan            = each line/section given startTimeSeconds + durationSeconds
   *
   * If the summed line beats exceed total_beats they are scaled to fit, so the
   * plan's end never overshoots the song. If total_beats is unknown (no
   * duration), times are laid out at the raw beat estimate (BPM only) so scroll
   * still runs; `durationSeconds` in the result reflects that.
   *
   * opts: { bpm, durationSeconds|duration, timeSignature, syllablesPerBeat }
   */
  function buildTimingPlan(model, opts) {
    opts = opts || {};
    var bpm = clampNum(opts.bpm != null ? opts.bpm : model.bpm, 20, 300, 100);
    var spb = clampNum(opts.syllablesPerBeat, 0.5, 5, 2);
    var ts = opts.timeSignature || model.timeSignature || '4/4';
    var durationSeconds =
      opts.durationSeconds != null ? opts.durationSeconds : parseDuration(opts.duration);
    var secondsPerBeat = 60 / bpm;

    // First pass: estimate beats per line.
    var sections = model.sections.map(function (sec) {
      return {
        label: sec.label,
        lines: sec.lines.map(function (text) {
          var syll = lineSyllables(text);
          var beats = Math.max(1, Math.ceil(syll / spb));
          return { text: text, syllableCount: syll, beats: beats };
        }),
      };
    });

    var totalLineBeats = 0;
    sections.forEach(function (sec) {
      sec.lines.forEach(function (ln) {
        totalLineBeats += ln.beats;
      });
    });
    if (totalLineBeats === 0) totalLineBeats = 1;

    var targetBeats = null;
    if (durationSeconds > 0) targetBeats = (bpm / 60) * durationSeconds;

    // Scale so the plan fills (and never overshoots) the target duration.
    var scale = 1;
    if (targetBeats && targetBeats > 0) scale = targetBeats / totalLineBeats;

    // Second pass: assign absolute times.
    var cursorBeats = 0;
    sections.forEach(function (sec) {
      sec.startTimeSeconds = round3(cursorBeats * scale * secondsPerBeat);
      var secBeats = 0;
      sec.lines.forEach(function (ln) {
        ln.startTimeSeconds = round3(cursorBeats * scale * secondsPerBeat);
        var scaledBeats = ln.beats * scale;
        ln.durationSeconds = round3(scaledBeats * secondsPerBeat);
        cursorBeats += ln.beats;
        secBeats += ln.beats;
      });
      sec.durationSeconds = round3(secBeats * scale * secondsPerBeat);
    });

    var totalSeconds = round3(cursorBeats * scale * secondsPerBeat);

    return {
      title: model.title,
      artist: model.artist,
      bpm: bpm,
      durationSeconds: durationSeconds > 0 ? durationSeconds : totalSeconds,
      timeSignature: ts,
      timeSigNumerator: timeSigNumer(ts),
      syllablesPerBeat: spb,
      totalSeconds: totalSeconds,
      sections: sections,
    };
  }

  /** Flatten a timing plan into an ordered list of line events (for the scroller). */
  function flattenPlan(plan) {
    var out = [];
    plan.sections.forEach(function (sec, si) {
      sec.lines.forEach(function (ln, li) {
        out.push({
          sectionIndex: si,
          sectionLabel: sec.label,
          lineIndex: li,
          text: ln.text,
          startTimeSeconds: ln.startTimeSeconds,
          durationSeconds: ln.durationSeconds,
        });
      });
    });
    return out;
  }

  // ── scroll interpolation (pure, testable) ──────────────────────────────────

  function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /**
   * Given keyframes [{ t (seconds), pos (px) }, …] sorted by t, and a time,
   * return an interpolated position. Monotonic non-decreasing in `time` when the
   * keyframe positions are non-decreasing (they always are — cumulative line
   * offsets). `easing` = 'linear' | 'smooth'. Used by the rAF scroller so the
   * scroll never jumps discretely between lines.
   */
  function interpolatePosition(time, keyframes, easing) {
    if (!keyframes || !keyframes.length) return 0;
    if (time <= keyframes[0].t) return keyframes[0].pos;
    var last = keyframes[keyframes.length - 1];
    if (time >= last.t) return last.pos;
    // Binary-ish linear scan (keyframe counts are small — one per line).
    for (var i = 1; i < keyframes.length; i++) {
      if (time <= keyframes[i].t) {
        var a = keyframes[i - 1];
        var b = keyframes[i];
        var span = b.t - a.t;
        var frac = span > 0 ? (time - a.t) / span : 1;
        if (easing === 'smooth') frac = smoothstep(frac);
        return a.pos + (b.pos - a.pos) * frac;
      }
    }
    return last.pos;
  }

  // ── small helpers ──────────────────────────────────────────────────────────

  function clampNum(v, lo, hi, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function round3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Public pure API (also used by the runtime below).
  var api = {
    normalizeText: normalizeText,
    isChordToken: isChordToken,
    isChordOnlyLine: isChordOnlyLine,
    stripInlineChords: stripInlineChords,
    isSectionHeader: isSectionHeader,
    sectionLabelOf: sectionLabelOf,
    isBoilerplate: isBoilerplate,
    stripBoilerplate: stripBoilerplate,
    detectMetadata: detectMetadata,
    countSyllables: countSyllables,
    lineSyllables: lineSyllables,
    fingerprint: fingerprint,
    levenshtein: levenshtein,
    similarity: similarity,
    detectExplicitSections: detectExplicitSections,
    detectInferredSections: detectInferredSections,
    parseLyrics: parseLyrics,
    parseDuration: parseDuration,
    buildTimingPlan: buildTimingPlan,
    flattenPlan: flattenPlan,
    interpolatePosition: interpolatePosition,
    smoothstep: smoothstep,
    escapeHtml: escapeHtml,
  };

  // ── runtime (browser-only; not headless-tested) ────────────────────────────
  // Everything below builds/drives the full-screen stage modal. Guarded so the
  // module stays import-safe in Node (the pure API above is what tests load).

  var STORAGE_KEY = 'csmpn_perfLyrics_v1';

  function loadState() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveState(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      /* quota / private mode — non-fatal */
    }
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;
    }
  }

  function el(tag, attrs, html) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'style') node.setAttribute('style', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (html != null) node.innerHTML = html;
    return node;
  }

  function ensureStyle() {
    if (document.getElementById('plm-style')) return;
    var css = [
      '.plm-backdrop{position:fixed;inset:0;z-index:100000;background:#000;color:#fff;',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'display:flex;flex-direction:column;overflow:hidden;}',
      '.plm-bar{flex:0 0 auto;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;',
      'padding:.5rem .7rem;background:#111;border-bottom:1px solid #333;}',
      '.plm-bar button,.plm-bar select{background:#222;color:#fff;border:1px solid #444;',
      'border-radius:8px;padding:.4rem .7rem;font-size:15px;cursor:pointer;min-height:40px;}',
      '.plm-bar button:hover{background:#333;}',
      '.plm-bar input{background:#222;color:#fff;border:1px solid #444;border-radius:8px;',
      'padding:.4rem .5rem;font-size:15px;min-height:36px;}',
      '.plm-bar label{font-size:12px;color:#aaa;display:flex;flex-direction:column;gap:2px;}',
      '.plm-spacer{flex:1 1 auto;}',
      '.plm-setup{flex:1 1 auto;overflow:auto;padding:1rem;max-width:900px;margin:0 auto;width:100%;box-sizing:border-box;}',
      '.plm-setup textarea{width:100%;min-height:220px;background:#0c0c0c;color:#eee;border:1px solid #333;',
      'border-radius:10px;padding:.7rem;font-size:15px;line-height:1.5;box-sizing:border-box;font-family:inherit;}',
      '.plm-setup h2{margin:.2rem 0 .6rem;font-size:20px;}',
      '.plm-setup .plm-fields{display:flex;flex-wrap:wrap;gap:.8rem;margin:.8rem 0;}',
      '.plm-preview{margin-top:1rem;}',
      '.plm-preview .plm-sec{margin:.4rem 0;padding:.5rem .7rem;background:#141414;border:1px solid #2a2a2a;border-radius:8px;}',
      '.plm-preview .plm-sec-hd{display:flex;gap:.5rem;align-items:center;margin-bottom:.3rem;}',
      '.plm-preview .plm-sec-hd input{flex:1 1 auto;font-weight:600;}',
      '.plm-preview .plm-sec p{margin:.1rem 0;color:#ccc;font-size:14px;}',
      '.plm-stage{flex:1 1 auto;overflow:hidden;position:relative;}',
      '.plm-scroller{position:absolute;left:0;right:0;top:0;will-change:transform;padding:50vh 6vw;box-sizing:border-box;}',
      '.plm-sticky{position:absolute;top:0;left:0;right:0;z-index:5;background:linear-gradient(#000 60%,rgba(0,0,0,0));',
      'padding:.5rem .8rem;font-size:16px;font-weight:700;color:#6cf;text-transform:uppercase;letter-spacing:.05em;}',
      '.plm-hd{color:#6cf;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:1.6em 0 .3em;opacity:.9;}',
      '.plm-line{margin:.15em 0;line-height:1.35;color:#888;transition:color .25s;}',
      '.plm-line.plm-cur{color:#fff;}',
      '.plm-line.plm-next{color:#bbb;}',
      '.plm-blank{height:.6em;}',
      '@media print{.plm-bar,.plm-sticky{display:none!important;}.plm-backdrop{position:static;color:#000;background:#fff;}',
      '.plm-scroller{position:static;transform:none!important;padding:0;}.plm-line{color:#000!important;}.plm-hd{color:#000;}}',
    ].join('');
    var style = el('style', { id: 'plm-style' });
    style.textContent = css;
    document.head.appendChild(style);
  }

  // The single browser entry point.
  function openPerformanceLyrics(initialText, initialTitle) {
    ensureStyle();
    var saved = loadState() || {};
    var backdrop = el('div', { class: 'plm-backdrop', role: 'dialog', 'aria-label': 'Performance Lyrics' });

    var state = {
      model: null,
      plan: null,
      fontSize: saved.fontSize || 34,
      easing: prefersReducedMotion() ? 'linear' : 'smooth',
      reduced: prefersReducedMotion(),
      playing: false,
      startClock: 0,
      pausedAt: 0,
      raf: 0,
      keyframes: [],
      lineEls: [],
      curIdx: -1,
    };

    // ---- setup view ----
    function buildSetup() {
      backdrop.innerHTML = '';
      var bar = el('div', { class: 'plm-bar' });
      var titleSpan = el('strong', null, 'Performance Lyrics');
      bar.appendChild(titleSpan);
      bar.appendChild(el('span', { class: 'plm-spacer' }));
      var closeBtn = el('button', { type: 'button', 'aria-label': 'Close' }, '✕ Close');
      bar.appendChild(closeBtn);
      backdrop.appendChild(bar);

      var setup = el('div', { class: 'plm-setup' });
      setup.appendChild(el('h2', null, 'Paste lyrics, or import a file'));
      setup.appendChild(
        el(
          'p',
          { style: 'color:#aaa;font-size:14px;margin:.2rem 0 .6rem;' },
          'Accepts chord-over-lyrics sheets, AZLyrics-style plain pages, and Genius-style pages with [Section] headers. Chords and page boilerplate are removed automatically.'
        )
      );
      var ta = el('textarea', {
        id: 'plm-input',
        'aria-label': 'Lyric text',
        placeholder: 'Paste lyrics here…',
      });
      ta.value = initialText || saved.rawText || '';
      setup.appendChild(ta);

      var fileRow = el('div', { style: 'margin:.6rem 0;' });
      var fileInput = el('input', {
        type: 'file',
        accept: '.txt,.md,text/plain,text/markdown',
        id: 'plm-file',
        'aria-label': 'Import lyric file',
      });
      fileRow.appendChild(fileInput);
      setup.appendChild(fileRow);

      var fields = el('div', { class: 'plm-fields' });
      fields.appendChild(field('BPM', 'plm-bpm', 'number', saved.bpm || '', 'e.g. 120'));
      fields.appendChild(field('Duration (mm:ss)', 'plm-dur', 'text', saved.duration || '', '3:45'));
      fields.appendChild(field('Time sig', 'plm-ts', 'text', saved.timeSignature || '4/4', '4/4'));
      fields.appendChild(field('Syllables / beat', 'plm-spb', 'number', saved.spb || '2', '2'));
      setup.appendChild(fields);

      var tapRow = el('div', { style: 'margin:.4rem 0;display:flex;gap:.6rem;align-items:center;' });
      var tapBtn = el('button', { type: 'button', class: 'plm-tap' }, '🥁 Tap tempo');
      var tapOut = el('span', { style: 'color:#aaa;font-size:13px;' }, '');
      tapRow.appendChild(tapBtn);
      tapRow.appendChild(tapOut);
      setup.appendChild(tapRow);

      var actions = el('div', { style: 'margin:1rem 0;display:flex;gap:.6rem;' });
      var buildBtn = el('button', { type: 'button', style: 'background:#0a5;border-color:#0a5;font-weight:700;' }, '▶ Build & Perform');
      actions.appendChild(buildBtn);
      setup.appendChild(actions);

      var preview = el('div', { class: 'plm-preview', id: 'plm-preview' });
      setup.appendChild(preview);

      backdrop.appendChild(setup);

      // Tap tempo.
      var taps = [];
      tapBtn.addEventListener('click', function () {
        var now = Date.now();
        taps.push(now);
        if (taps.length > 6) taps.shift();
        if (taps.length >= 2) {
          var intervals = [];
          for (var i = 1; i < taps.length; i++) intervals.push(taps[i] - taps[i - 1]);
          var avg = intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length;
          var bpm = Math.round(60000 / avg);
          if (bpm >= 20 && bpm <= 300) {
            document.getElementById('plm-bpm').value = bpm;
            tapOut.textContent = bpm + ' BPM';
          }
        }
        // Reset the tap window if the user pauses > 2s.
        clearTimeout(tapBtn._t);
        tapBtn._t = setTimeout(function () { taps = []; }, 2000);
      });

      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          ta.value = String(reader.result || '');
          renderPreview();
        };
        reader.readAsText(f);
      });

      ta.addEventListener('input', debounce(renderPreview, 400));
      buildBtn.addEventListener('click', doBuild);
      closeBtn.addEventListener('click', close);

      // Auto-fill BPM/time-sig from the pasted text when the fields are empty.
      renderPreview();

      function renderPreview() {
        var model = api.parseLyrics(ta.value);
        state.model = model;
        var bpmField = document.getElementById('plm-bpm');
        var tsField = document.getElementById('plm-ts');
        if (bpmField && !bpmField.value && model.bpm) bpmField.value = model.bpm;
        if (tsField && (!tsField.value || tsField.value === '4/4') && model.timeSignature)
          tsField.value = model.timeSignature;
        preview.innerHTML = '';
        if (!model.sections.length) {
          preview.appendChild(el('p', { style: 'color:#c66;' }, 'No lyrics detected yet.'));
          return;
        }
        var meta = el('p', { style: 'color:#8c8;font-size:13px;' },
          api.escapeHtml((model.title || 'Untitled') + (model.artist ? ' — ' + model.artist : '')) +
          ' · ' + model.sections.length + ' section' + (model.sections.length === 1 ? '' : 's'));
        preview.appendChild(meta);
        model.sections.forEach(function (sec, i) {
          var box = el('div', { class: 'plm-sec' });
          var hd = el('div', { class: 'plm-sec-hd' });
          var labelInput = el('input', { type: 'text', value: sec.label, 'aria-label': 'Section label' });
          labelInput.addEventListener('input', function () { model.sections[i].label = labelInput.value; });
          hd.appendChild(labelInput);
          box.appendChild(hd);
          sec.lines.slice(0, 3).forEach(function (ln) {
            box.appendChild(el('p', null, api.escapeHtml(ln)));
          });
          if (sec.lines.length > 3) box.appendChild(el('p', { style: 'color:#666;' }, '… +' + (sec.lines.length - 3) + ' more'));
          preview.appendChild(box);
        });
      }

      function doBuild() {
        if (!state.model || !state.model.sections.length) {
          renderPreview();
          if (!state.model || !state.model.sections.length) return;
        }
        var opts = {
          bpm: parseFloat(document.getElementById('plm-bpm').value) || state.model.bpm || 100,
          duration: document.getElementById('plm-dur').value,
          timeSignature: document.getElementById('plm-ts').value || '4/4',
          syllablesPerBeat: parseFloat(document.getElementById('plm-spb').value) || 2,
        };
        state.plan = api.buildTimingPlan(state.model, opts);
        saveState({
          rawText: ta.value,
          bpm: opts.bpm,
          duration: opts.duration,
          timeSignature: opts.timeSignature,
          spb: opts.syllablesPerBeat,
          fontSize: state.fontSize,
        });
        buildStage();
      }
    }

    function field(labelText, id, type, value, placeholder) {
      var lab = el('label', null, api.escapeHtml(labelText));
      var input = el('input', { type: type, id: id, value: value == null ? '' : String(value) });
      if (placeholder) input.setAttribute('placeholder', placeholder);
      if (type === 'number') input.setAttribute('inputmode', 'decimal');
      lab.appendChild(input);
      return lab;
    }

    // ---- stage view ----
    function buildStage() {
      backdrop.innerHTML = '';
      var plan = state.plan;
      var bar = el('div', { class: 'plm-bar' });
      var playBtn = el('button', { type: 'button', class: 'plm-play', 'aria-label': 'Play or pause' }, '▶ Play');
      var restartBtn = el('button', { type: 'button', 'aria-label': 'Restart' }, '⟲ Restart');
      var editBtn = el('button', { type: 'button', 'aria-label': 'Edit' }, '✎ Edit');
      var minusBtn = el('button', { type: 'button', 'aria-label': 'Smaller font' }, 'A−');
      var plusBtn = el('button', { type: 'button', 'aria-label': 'Larger font' }, 'A+');
      var jump = el('select', { 'aria-label': 'Jump to section' });
      jump.appendChild(el('option', { value: '-1' }, 'Jump to…'));
      plan.sections.forEach(function (sec, i) {
        jump.appendChild(el('option', { value: String(i) }, sec.label));
      });
      var closeBtn = el('button', { type: 'button', 'aria-label': 'Close' }, '✕');
      bar.appendChild(playBtn);
      bar.appendChild(restartBtn);
      bar.appendChild(jump);
      bar.appendChild(el('span', { class: 'plm-spacer' }));
      bar.appendChild(minusBtn);
      bar.appendChild(plusBtn);
      bar.appendChild(editBtn);
      bar.appendChild(closeBtn);
      backdrop.appendChild(bar);

      var stage = el('div', { class: 'plm-stage' });
      var sticky = el('div', { class: 'plm-sticky', id: 'plm-sticky' }, plan.sections.length ? api.escapeHtml(plan.sections[0].label) : '');
      var scroller = el('div', { class: 'plm-scroller', id: 'plm-scroller', style: 'font-size:' + state.fontSize + 'px;' });

      // Build DOM + record each line element and its flattened event.
      var events = api.flattenPlan(plan);
      state.lineEls = [];
      var meta = el('div', { class: 'plm-hd', style: 'margin-top:0;color:#9df;' },
        api.escapeHtml((plan.title || 'Untitled') + (plan.artist ? ' — ' + plan.artist : '')));
      scroller.appendChild(meta);
      plan.sections.forEach(function (sec, si) {
        scroller.appendChild(el('div', { class: 'plm-hd' }, api.escapeHtml(sec.label)));
        sec.lines.forEach(function (ln, li) {
          var lineEl = el('div', { class: 'plm-line' }, api.escapeHtml(ln.text || ' '));
          lineEl.dataset.si = String(si);
          lineEl.dataset.li = String(li);
          scroller.appendChild(lineEl);
          state.lineEls.push(lineEl);
        });
      });
      stage.appendChild(sticky);
      stage.appendChild(scroller);
      backdrop.appendChild(stage);

      state.events = events;
      state.playing = false;
      state.pausedAt = 0;
      state.curIdx = -1;
      state.scroller = scroller;
      state.stage = stage;
      state.sticky = sticky;

      // Compute keyframes (time → scroll offset in px) once the DOM is laid out.
      requestAnimationFrame(function () {
        recomputeKeyframes();
        applyScrollForTime(0);
      });

      playBtn.addEventListener('click', function () { togglePlay(playBtn); });
      restartBtn.addEventListener('click', function () { restart(playBtn); });
      editBtn.addEventListener('click', function () { stopScroll(); buildSetup(); });
      closeBtn.addEventListener('click', close);
      minusBtn.addEventListener('click', function () { setFont(state.fontSize - 3); });
      plusBtn.addEventListener('click', function () { setFont(state.fontSize + 3); });
      jump.addEventListener('change', function () {
        var i = parseInt(jump.value, 10);
        if (i >= 0) jumpToSection(i);
        jump.value = '-1';
      });
      window.addEventListener('resize', debounce(function () { recomputeKeyframes(); applyScrollForTime(currentTime()); }, 200));
    }

    function recomputeKeyframes() {
      // Keyframe per line: time = line.startTimeSeconds, pos = offset that centers
      // the line in the stage viewport.
      var stageH = state.stage ? state.stage.clientHeight : window.innerHeight;
      var kf = [];
      var events = state.events || [];
      for (var i = 0; i < events.length; i++) {
        var lineEl = state.lineEls[i];
        if (!lineEl) continue;
        var center = lineEl.offsetTop + lineEl.offsetHeight / 2;
        kf.push({ t: events[i].startTimeSeconds, pos: center - stageH / 2 });
      }
      // Guarantee a final keyframe at the plan end so scroll finishes smoothly.
      if (kf.length) {
        var lastEnd = events[events.length - 1].startTimeSeconds + (events[events.length - 1].durationSeconds || 0);
        var lastPos = kf[kf.length - 1].pos;
        if (lastEnd > kf[kf.length - 1].t) kf.push({ t: lastEnd, pos: lastPos });
      }
      state.keyframes = kf;
    }

    function currentTime() {
      if (state.playing) return (performance.now() - state.startClock) / 1000;
      return state.pausedAt;
    }

    function applyScrollForTime(t) {
      var pos = api.interpolatePosition(t, state.keyframes, state.easing);
      if (state.scroller) state.scroller.style.transform = 'translateY(' + -Math.max(0, pos) + 'px)';
      // Highlight the active line.
      var events = state.events || [];
      var idx = -1;
      for (var i = 0; i < events.length; i++) {
        if (t >= events[i].startTimeSeconds) idx = i;
        else break;
      }
      if (idx !== state.curIdx) {
        if (state.curIdx >= 0 && state.lineEls[state.curIdx]) {
          state.lineEls[state.curIdx].classList.remove('plm-cur');
        }
        if (state.curIdx + 1 >= 0 && state.lineEls[state.curIdx + 1]) {
          state.lineEls[state.curIdx + 1].classList.remove('plm-next');
        }
        state.curIdx = idx;
        if (idx >= 0 && state.lineEls[idx]) {
          state.lineEls[idx].classList.add('plm-cur');
          if (state.sticky) state.sticky.textContent = events[idx].sectionLabel;
        }
        if (idx + 1 < state.lineEls.length && state.lineEls[idx + 1]) {
          state.lineEls[idx + 1].classList.add('plm-next');
        }
      }
    }

    function frame() {
      if (!state.playing) return;
      var t = currentTime();
      applyScrollForTime(t);
      var end = state.plan.totalSeconds || 0;
      if (t >= end) {
        state.playing = false;
        var pb = backdrop.querySelector('.plm-play');
        if (pb) pb.textContent = '▶ Play';
        state.pausedAt = end;
        return;
      }
      if (state.reduced) {
        // Reduced-motion: step to the next line's time rather than animate.
        state.raf = window.setTimeout(function () { requestAnimationFrame(frame); }, 120);
      } else {
        state.raf = requestAnimationFrame(frame);
      }
    }

    function togglePlay(btn) {
      if (state.playing) {
        state.playing = false;
        state.pausedAt = currentTime();
        stopScroll();
        btn.textContent = '▶ Play';
      } else {
        state.playing = true;
        state.startClock = performance.now() - state.pausedAt * 1000;
        btn.textContent = '❚❚ Pause';
        frame();
      }
    }

    function stopScroll() {
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        clearTimeout(state.raf);
        state.raf = 0;
      }
    }

    function restart(btn) {
      stopScroll();
      state.playing = false;
      state.pausedAt = 0;
      applyScrollForTime(0);
      if (btn) btn.textContent = '▶ Play';
    }

    function jumpToSection(i) {
      var events = state.events || [];
      for (var e = 0; e < events.length; e++) {
        if (events[e].sectionIndex === i) {
          state.pausedAt = events[e].startTimeSeconds;
          if (state.playing) state.startClock = performance.now() - state.pausedAt * 1000;
          applyScrollForTime(state.pausedAt);
          return;
        }
      }
    }

    function setFont(px) {
      state.fontSize = Math.min(80, Math.max(20, px));
      if (state.scroller) state.scroller.style.fontSize = state.fontSize + 'px';
      var saved2 = loadState() || {};
      saved2.fontSize = state.fontSize;
      saveState(saved2);
      requestAnimationFrame(function () { recomputeKeyframes(); applyScrollForTime(currentTime()); });
    }

    function close() {
      stopScroll();
      document.removeEventListener('keydown', onKey);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }

    function onKey(e) {
      if (e.key === 'Escape') { close(); return; }
      if (e.key === ' ') {
        var pb = backdrop.querySelector('.plm-play');
        if (pb) { e.preventDefault(); togglePlay(pb); }
      } else if (e.key === '+' || e.key === '=') {
        setFont(state.fontSize + 3);
      } else if (e.key === '-' || e.key === '_') {
        setFont(state.fontSize - 3);
      }
    }

    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    if (initialText && initialText.trim()) {
      // Pre-seed and go straight to the section preview.
      buildSetup();
    } else {
      buildSetup();
    }
    return { close: close };
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments;
      var self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 300);
    };
  }

  api.openPerformanceLyrics = openPerformanceLyrics;

  if (typeof window !== 'undefined') window.PerformanceLyrics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

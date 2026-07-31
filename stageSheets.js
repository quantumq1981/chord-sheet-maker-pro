/**
 * stageSheets.js — lyrics-only stage sheets for a whole setlist
 * (browser global + `window.StageSheets`).
 *
 * The setlist could already print every chart as one PDF. What it could not do
 * is the other half of a gig: a lyrics-only running order for the singer, or for
 * the player who knows the changes and needs the words. `lyricsView.js` does
 * that for ONE song; this does it for the set.
 *
 * It deliberately does not re-implement lyric extraction — `window.LyricsView`
 * owns that, handles CSMPN / ChordPro / plain, and is already tested. This
 * module adds what a set needs on top: the per-song metadata a player checks
 * before counting in (key, tempo, capo), page breaks between songs, and one
 * auto-scroll that runs the whole running order.
 *
 * Everything here is pure and unit-tested; the caller opens the returned HTML
 * in a window, which is the only browser-dependent step.
 */
(function () {
  // Header fields worth carrying onto a stage sheet. Everything else on a CSMPN
  // header is for the printed chart, not for someone about to sing.
  var META_FIELDS = ['Key', 'Tempo', 'Capo'];

  /**
   * The one line a player reads before counting in: `Key: Bb · 120 BPM · Capo 2`.
   * Reads the CSMPN header directly rather than parsing the whole document —
   * a stage sheet must survive a chart that does not fully parse.
   */
  function stageMetaLine(source) {
    var text = String(source || '');
    var found = {};
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      var m = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.+)$/.exec(line);
      if (!m) break; // the header is a run of Field: value lines at the top
      var field = m[1].trim();
      for (var f = 0; f < META_FIELDS.length; f++) {
        if (field.toLowerCase() === META_FIELDS[f].toLowerCase()) {
          found[META_FIELDS[f]] = m[2].trim();
        }
      }
    }
    var parts = [];
    if (found.Key) parts.push('Key: ' + found.Key);
    if (found.Tempo) parts.push(found.Tempo + ' BPM');
    if (found.Capo && found.Capo !== '0') parts.push('Capo ' + found.Capo);
    return parts.join('  ·  ');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      }
    );
  }

  /**
   * Turn setlist items into the song models the sheet renders.
   *
   * A song with no lyrics at all (an instrumental, a chord-only chart) is
   * dropped rather than printed as an empty page — a running order with blank
   * pages in it is worse than a shorter one, and `skipped` reports which so the
   * caller can say so out loud.
   */
  function buildSetlistStageSongs(items, lyricsView) {
    var lv = lyricsView || (typeof window !== 'undefined' ? window.LyricsView : null);
    var songs = [];
    var skipped = [];
    if (!lv || typeof lv.extractLyrics !== 'function') return { songs: songs, skipped: skipped };

    for (var i = 0; i < (items || []).length; i++) {
      var item = items[i] || {};
      var sheet = null;
      try {
        sheet = lv.extractLyrics(item.source || '');
      } catch (_e) {
        sheet = null;
      }
      var hasLyrics = sheet && (lv.sheetHasLyrics ? lv.sheetHasLyrics(sheet) : true);
      if (!hasLyrics) {
        skipped.push(item.title || 'Untitled');
        continue;
      }
      songs.push({
        title: item.title || (sheet && sheet.title) || 'Untitled',
        meta: stageMetaLine(item.source || ''),
        sections: (sheet && sheet.sections) || [],
      });
    }
    return { songs: songs, skipped: skipped };
  }

  function songHtml(song, index) {
    var out = [];
    // break-before rather than break-after: no trailing blank page at the end.
    out.push('<section class="song"' + (index > 0 ? ' data-break="1"' : '') + '>');
    out.push('<h1>' + esc(song.title) + '</h1>');
    if (song.meta) out.push('<p class="meta">' + esc(song.meta) + '</p>');
    for (var s = 0; s < song.sections.length; s++) {
      var sec = song.sections[s];
      if (sec.header) out.push('<h2>' + esc(sec.header) + '</h2>');
      for (var l = 0; l < sec.lines.length; l++) {
        var line = sec.lines[l];
        out.push(line === '' ? '<p class="gap"></p>' : '<p class="line">' + esc(line) + '</p>');
      }
    }
    out.push('</section>');
    return out.join('');
  }

  /**
   * A standalone HTML page for the whole running order: dark for the stand,
   * one auto-scroll for the set, and a print stylesheet that flips to black on
   * white with a page per song (iOS print-to-PDF is the export path here, same
   * as everywhere else in this app).
   */
  function buildSetlistStageHtml(songs, opts) {
    opts = opts || {};
    var sec = opts.secondsPerLine == null ? 4 : Number(opts.secondsPerLine);
    var fs = opts.fontSize == null ? 32 : Number(opts.fontSize);
    var fg = opts.textColor || '#FFFFFF';
    var bg = opts.bgColor || '#000000';
    var docTitle = opts.title || 'Setlist';
    var body = [];
    for (var i = 0; i < (songs || []).length; i++) body.push(songHtml(songs[i], i));

    return [
      '<!DOCTYPE html><html><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>' + esc(docTitle) + '</title><style>',
      '*{box-sizing:border-box}',
      'body{margin:0;background:' + bg + ';color:' + fg + ';',
      '  font-family:-apple-system,"SF Pro Text",Arial,Helvetica,sans-serif;}',
      '#bar{position:sticky;top:0;z-index:2;display:flex;gap:10px;align-items:center;',
      '  padding:10px 14px;background:#111;border-bottom:1px solid #333;font-size:14px;}',
      '#bar button{font:inherit;font-weight:700;padding:8px 14px;border:none;border-radius:8px;',
      '  background:#b8350f;color:#fff;cursor:pointer;min-height:44px;}',
      '#bar label{opacity:.8}',
      '#scroll{padding:4vh 6vw 60vh;font-size:' + fs + 'px;line-height:1.45;}',
      '.song{margin:0 0 8vh;}',
      'h1{font-size:1.25em;margin:0 0 .1em;}',
      '.meta{margin:0 0 1em;font-size:.55em;opacity:.75;letter-spacing:.02em;}',
      'h2{font-size:.7em;text-transform:uppercase;letter-spacing:.06em;opacity:.75;',
      '  margin:1.1em 0 .35em;border-bottom:1px solid currentColor;padding-bottom:.1em;}',
      '.line{margin:0 0 .18em;}',
      '.gap{margin:0 0 .7em;}',
      '@media print{',
      '  #bar{display:none !important;}',
      '  body{background:#fff !important;color:#000 !important;}',
      '  #scroll{padding:0;font-size:15pt;}',
      '  .song[data-break]{break-before:page;page-break-before:always;}',
      '  .song{margin:0;}',
      '  h2{opacity:1;}',
      '}',
      '</style></head><body>',
      '<div id="bar">',
      '<button id="go" type="button">&#9654; Auto-scroll</button>',
      '<label>sec/line <input id="spd" type="number" min="1" max="30" value="' + sec + '" ',
      '  style="width:4em;font:inherit;padding:4px;border-radius:6px;border:1px solid #444;',
      '  background:#000;color:#fff"></label>',
      '<button id="pr" type="button">&#x2399; Print</button>',
      '</div>',
      '<div id="scroll">' + body.join('') + '</div>',
      '<scr' + 'ipt>',
      'var running=false,raf=null,last=null;',
      'var go=document.getElementById("go"),spd=document.getElementById("spd");',
      'function step(ts){',
      '  if(!running)return;',
      '  if(last==null){last=ts;raf=requestAnimationFrame(step);return;}',
      '  var dt=(ts-last)/1000;last=ts;',
      '  var perLine=Math.max(1,Number(spd.value)||4);',
      // One text line is ~1.45em at the body font size; scrolling by that per
      // `perLine` seconds keeps the pace the musician actually set.
      '  window.scrollBy(0,(parseFloat(getComputedStyle(document.getElementById("scroll")).fontSize)*1.45/perLine)*dt);',
      '  if(window.scrollY+window.innerHeight>=document.body.scrollHeight-2){stop();return;}',
      '  raf=requestAnimationFrame(step);',
      '}',
      'function stop(){running=false;last=null;if(raf)cancelAnimationFrame(raf);raf=null;',
      '  go.innerHTML="&#9654; Auto-scroll";}',
      'go.addEventListener("click",function(){',
      '  if(running){stop();return;}',
      '  running=true;go.innerHTML="&#9632; Stop";raf=requestAnimationFrame(step);',
      '});',
      'document.getElementById("pr").addEventListener("click",function(){stop();window.print();});',
      '</scr' + 'ipt></body></html>',
    ].join('\n');
  }

  var api = {
    stageMetaLine: stageMetaLine,
    buildSetlistStageSongs: buildSetlistStageSongs,
    buildSetlistStageHtml: buildSetlistStageHtml,
  };
  if (typeof window !== 'undefined') window.StageSheets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

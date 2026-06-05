/**
 * musicFont.js — embedded music-glyph font (browser global + window.MusicFont).
 *
 * The SVG renderers emit a small, fixed set of Unicode music glyphs — treble
 * clef (U+1D11E), sharp/flat/natural (U+266F/266D/266E), segno/coda
 * (U+1D10B/1D10C), double accidentals (U+1D12A/1D12B), and note heads
 * (U+2669/266A/266B). The only text font the app actually loads is EB Garamond,
 * which contains NONE of these, so on iOS Safari they fell back to whatever the
 * system had (often tofu / wrong glyphs).
 *
 * This module embeds a 3.8 KB subset of Noto Music (SIL OFL 1.1) covering
 * exactly those glyphs, inlined as a data: URI. It is injected into the page
 * (for the live preview) AND exposed as a raw `@font-face` CSS string so each
 * generated <svg> can carry the font with it — critical for the primary export
 * path, iOS print-to-PDF, where the print popup is a fresh document that does
 * not inherit the page's stylesheet.
 *
 * Font: Noto Music, Copyright 2022 The Noto Project Authors
 * (https://github.com/notofonts/music), licensed under SIL OFL 1.1.
 * Subset to the glyphs above; no other modifications.
 */
(function () {
  var FAMILY = 'CSMPN Music';
  var DATA_URI = 'data:font/woff2;base64,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';
  var FACE_CSS =
    "@font-face{font-family:'" + FAMILY + "';font-style:normal;font-weight:400;" +
    "src:url(" + DATA_URI + ") format('woff2');}";

  // Inject once into the document head so the live preview renders the glyphs.
  function inject(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.head || d.getElementById('csmpnMusicFontFace')) return;
    var st = d.createElement('style');
    st.id = 'csmpnMusicFontFace';
    st.textContent = FACE_CSS;
    d.head.appendChild(st);
  }

  var api = { family: FAMILY, faceCss: FACE_CSS, dataUri: DATA_URI, inject: inject };
  if (typeof window !== 'undefined') {
    window.MusicFont = api;
    window.MUSIC_FONT_FAMILY = FAMILY;
    window.MUSIC_FONT_FACE = FACE_CSS;
    inject();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

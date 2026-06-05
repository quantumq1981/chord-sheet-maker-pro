/* settings.js — Fake Book Settings state and functions
   Extracted from index.html (Sprint 5.3, item 2.1F).
   Loaded as a plain script after chordProcessing.js. All symbols are global.
*/

/* =========================================================
   Fake Book Settings State
========================================================= */
const fbSettings = {
  fontSize: 'M',       // M, S, XS
  barsPerRow: 4,       // 2-8
  lineSpacing: 8,      // 0, 2, 4, 8, 12, 16
  barLines: 'visible', // visible, hidden
  chordAlign: 'left',  // left, center
  chordFontPack: 'default', // default, pori, norfolk, norfolksans
  maj7Style: 'ma',     // ma, maj, triangle
  minorStyle: 'm',     // m, min, minus
  dimStyle: 'degree',  // degree (°), dim
  halfDimStyle: 'slashed', // slashed (ø), m7b5
  footer: 'visible',   // visible, hidden
  pageOrientation: 'portrait', // portrait, landscape
  bgColor: '#ffffff',  // sheet background
  fgColor: '#111111',  // font/foreground color
  chordColor: '#0044cc', // chord color
  headlineFont: 'patrickhand', // font for song title
  bodyFont: 'helvetica',       // font for body/chords/section headers
  // Whether to include lyrics lines (prefixed with ';') in the CSMPN output.
  // True = keep lyrics as comment lines; False = omit lyrics completely.
  includeLyrics: true,
  hybridRhythmMode: false,
  hybridScaffoldPreset: 'quarter',
  // Strum direction arrows below the staff: 'none' | 'down' | 'alt' | 'custom'
  strumMode: 'none',
  // Custom strum pattern string (chars D U X V -) used when strumMode === 'custom'
  strumPattern: '',
};

const FONT_SCALE_MAP = { M: 1, S: 0.85, XS: 0.72 };

/* Font family maps — key: setting value, value: CSS font-family string */
const HEADLINE_FONT_MAP = {
  patrickhand: '"Patrick Hand SC", Georgia, cursive',
  caveat: '"Caveat", cursive',
  kalam: '"Kalam", cursive',
  architects: '"Architects Daughter", cursive',
  permanent: '"Permanent Marker", cursive',
  handlee: '"Handlee", cursive',
  freeserif: '"FreeSerif", Georgia, serif',
};
const BODY_FONT_MAP = {
  helvetica: 'Helvetica, Arial, "Helvetica Neue", sans-serif',
  kalam: '"Kalam", cursive',
  caveat: '"Caveat", cursive',
  handlee: '"Handlee", cursive',
  architects: '"Architects Daughter", cursive',
  freesans: '"FreeSans", Helvetica, Arial, sans-serif',
  freeserif: '"FreeSerif", Georgia, serif',
};
/* Chord/notation font packs.
 *
 * Every stack ends in a font that is GUARANTEED to be present so a pack can never
 * silently collapse to an undefined system fallback:
 *   - "EB Garamond" is loaded from Google Fonts (engraved Real-Book serif).
 *   - Helvetica/Arial is a system sans, always available.
 *   - "CSMPN Music" is the embedded music-glyph font (musicFont.js) — appended last
 *     so the ♭/♯ accidentals in chord symbols (B♭, F♯m, 7♭9 …) always render even
 *     if the chosen text font lacks them. CSS font fallback is per-glyph, so the
 *     text font draws the letters and "CSMPN Music" only catches the accidentals.
 *
 * The leading commercial font names (Pori / Norfolk "ASC", SIL Open Font License)
 * are honoured when a user has installed them on their device — that enables true
 * angled slash chords via the `ss01` OpenType feature — and are harmlessly skipped
 * otherwise, falling through to the guaranteed serif/sans base. So the `pori` /
 * `norfolk` packs render as a clean engraved serif out of the box and upgrade to
 * angled slash chords automatically once the font is installed; `norfolksans` is a
 * reliable sans-serif look with or without the Norfolk Sans font. */
const _CHORD_SERIF = '"EB Garamond", Georgia, "Times New Roman", serif';
const _CHORD_SANS = 'Helvetica, Arial, "Helvetica Neue", sans-serif';
const _CHORD_GLYPH = '"CSMPN Music"'; // embedded — covers ♭/♯ accidentals

const CHORD_FONT_PACK_MAP = {
  default: {
    fakeBookChordFont: `${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    slashChordFont: `${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    notationFont: `${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
  },
  pori: {
    fakeBookChordFont: `"Pori Chords ASC Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    slashChordFont: `"Pori Chords ASC Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    notationFont: `"Pori Text ASL Std", "Pori Text ASC Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
  },
  norfolk: {
    fakeBookChordFont: `"Norfolk Chords ASC Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    slashChordFont: `"Norfolk Chords ASC Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
    notationFont: `"Norfolk Text ASC Std", "Norfolk Text ASL Std", ${_CHORD_SERIF}, ${_CHORD_GLYPH}`,
  },
  norfolksans: {
    fakeBookChordFont: `"Norfolk Chords Sans ASC Std", ${_CHORD_SANS}, ${_CHORD_GLYPH}`,
    slashChordFont: `"Norfolk Chords Sans ASC Std", ${_CHORD_SANS}, ${_CHORD_GLYPH}`,
    notationFont: `"Norfolk Text Sans ASC Std", ${_CHORD_SANS}, ${_CHORD_GLYPH}`,
  },
};

function getChordFontPackConfig(pack){
  return CHORD_FONT_PACK_MAP[pack] || CHORD_FONT_PACK_MAP.default;
}

/* Performance: persist settings to localStorage so users don't reconfigure each visit */
function saveFBSettings(){
  try { localStorage.setItem('csmpn_settings', JSON.stringify(fbSettings)); } catch(_){}
}
function loadFBSettings(){
  try {
    const saved = localStorage.getItem('csmpn_settings');
    if (saved){
      const parsed = JSON.parse(saved);
      for (const k of Object.keys(fbSettings)){
        if (parsed[k] !== undefined) fbSettings[k] = parsed[k];
      }
      // Sync UI controls
      const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
      setEl('setFontSize', fbSettings.fontSize);
      setEl('setBarsPerRow', String(fbSettings.barsPerRow));
      setEl('setLineSpacing', String(fbSettings.lineSpacing));
      setEl('setBarLines', fbSettings.barLines);
      setEl('setChordAlign', fbSettings.chordAlign);
      setEl('setChordFontPack', fbSettings.chordFontPack);
      setEl('setMaj7Style', fbSettings.maj7Style);
      setEl('setMinorStyle', fbSettings.minorStyle);
      setEl('setDimStyle', fbSettings.dimStyle);
      setEl('setHalfDimStyle', fbSettings.halfDimStyle);
      setEl('setPageOrientation', fbSettings.pageOrientation);
      setEl('setFooter', fbSettings.footer);
      setEl('setBgColor', fbSettings.bgColor);
      setEl('setFgColor', fbSettings.fgColor);
      setEl('setChordColor', fbSettings.chordColor);
      setEl('setHeadlineFont', fbSettings.headlineFont);
      setEl('setBodyFont', fbSettings.bodyFont);
      setEl('setIncludeLyrics', String(fbSettings.includeLyrics));
      setEl('setHybridRhythmMode', String(fbSettings.hybridRhythmMode));
      setEl('setHybridScaffoldPreset', fbSettings.hybridScaffoldPreset || 'quarter');
      setEl('setStrumMode', fbSettings.strumMode || 'none');
      setEl('setStrumPattern', fbSettings.strumPattern || '');
    }
  } catch(_){}
}

function applyFBSettings(){
  const root = document.documentElement;
  root.style.setProperty('--fb-font-scale', FONT_SCALE_MAP[fbSettings.fontSize] || 1);
  root.style.setProperty('--fb-line-spacing', fbSettings.lineSpacing + 'px');
  root.style.setProperty('--fb-bars-per-row', fbSettings.barsPerRow);
  root.style.setProperty('--fb-chord-color', fbSettings.chordColor || '#0044cc');
  const chordPack = getChordFontPackConfig(fbSettings.chordFontPack);
  const isAscPack = ['pori', 'norfolk', 'norfolksans'].includes(fbSettings.chordFontPack);
  // Apply font families via CSS custom properties
  const bodyFontStr = BODY_FONT_MAP[fbSettings.bodyFont] || BODY_FONT_MAP.helvetica;
  root.style.setProperty('--fb-headline-font', HEADLINE_FONT_MAP[fbSettings.headlineFont] || HEADLINE_FONT_MAP.patrickhand);
  root.style.setProperty('--fb-body-font', bodyFontStr);
  // For licensed ASC/ASL packs: use the pack's chord font.
  // For the default (free) pack: wire --fb-chord-font to the Body/Chord Font selector
  // so the user's font choice actually affects chord rendering.
  // Always append the embedded music-glyph font so ♭/♯ accidentals render even when
  // the chord font is the user-selected body font (the non-ASC default path).
  root.style.setProperty(
    '--fb-chord-font',
    (isAscPack ? chordPack.fakeBookChordFont : bodyFontStr) + ', ' + _CHORD_GLYPH,
  );
  window.__SLASH_FONT_FAMILY = chordPack.slashChordFont;
  window.__SN_NOTATION_FONT_FAMILY = chordPack.notationFont;
  window.__SLASH_FONT_PACK_ID = fbSettings.chordFontPack;
  root.style.setProperty('--fb-chord-features', isAscPack ? '"ss01" 1' : 'normal');
  // Apply custom colors to the sheet
  const sheetEl = document.querySelector('.sheet');
  if (sheetEl){
    sheetEl.style.background = fbSettings.bgColor || '#ffffff';
    sheetEl.style.color = fbSettings.fgColor || '#111111';
  }
  // Apply page orientation to print style
  const orientStyle = document.getElementById('dynamicPageStyle');
  if (orientStyle){
    orientStyle.textContent = `@media print { @page { size: letter ${fbSettings.pageOrientation || 'portrait'}; margin: 0.5in; } }`;
  }
  _chordParseCache.clear(); // Invalidate cache when chord style settings change
  _chordStyleSig = null; // Force the cached chord-style signature to recompute
  saveFBSettings();
  updatePreview();
}

function setStatus(msg, type='info'){
  // Back-compat: older call sites passed boolean (true=error)
  if (type === true) type = 'error';
  if (type === false) type = 'info';

  try{
    window.__csmpnLog = window.__csmpnLog || [];
    window.__csmpnLog.push({ t: new Date().toISOString(), type, msg: String(msg), ua: navigator.userAgent });
    // Keep last ~500 entries
    if (window.__csmpnLog.length > 500) window.__csmpnLog = window.__csmpnLog.slice(-500);
  }catch(e){}

  statusEl.textContent = msg;
  statusEl.classList.remove('err', 'warn');
  if (type === 'error') statusEl.classList.add('err');
  if (type === 'warning') statusEl.classList.add('warn');
}

/**
 * Remove comment lines (lyrics) from a CSMPN string if the includeLyrics setting is false.
 * Lyrics lines in CSMPN are prefixed with ';'. When the includeLyrics setting is
 * enabled (true), the original CSMPN is returned unchanged. When disabled, all
 * lines starting with ';' (ignoring leading whitespace) are stripped out. This
 * function does not modify bar/section content.
 *
 * @param {string} csmpn The chord sheet in CSMPN format.
 * @returns {string} Filtered CSMPN based on fbSettings.includeLyrics.
 */
function filterLyricsLines(csmpn){
  // Only filter if includeLyrics is explicitly set to false
  if (fbSettings.includeLyrics !== false) return csmpn;
  const lines = String(csmpn || '').split(/\r?\n/);
  // Keep lines that do not begin with ';' after trimming whitespace
  return lines.filter(l => !l.trim().startsWith(';')).join('\n');
}

/* =========================================================
   MusicXML Core — shared low-level primitives
   Single source of truth for the chord-quality → kind map, key
   signature (fifths + mode), the per-chord <harmony> element, and
   the score-partwise wrapper. Consumed by the browser emitters
   (renderer.js hr*, chordSlashMLRenderer.js csml*) so they no longer
   drift. Plain global function declarations — usable in classic
   scripts and Node vm test contexts alike.
========================================================= */

// Minimal XML escape (matches utils.js escapeHtml so output is identical).
function mxEsc(s) {
  return (s ?? '')
    .toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Chord quality → MusicXML <kind>. Merged superset of the former hr*/csml*
// versions (handles ø, m7b5, maj/ma/Δ, °7/dim7/o7, aug7/7#5, minor variants,
// 6/6-9, dominant extensions, sus2/sus4).
function mxChordKind(quality) {
  if (!quality) return 'major';
  const q = quality.toLowerCase();
  if (q.startsWith('ø') || q === 'm7b5' || q === 'm7♭5') return 'half-diminished';
  if (q.startsWith('maj') || q.startsWith('ma') || q.startsWith('δ')) return 'major-seventh';
  if (q.startsWith('°7') || q.startsWith('dim7') || q === 'o7' || q.startsWith('o7')) return 'diminished-seventh';
  if (q.startsWith('°') || q.startsWith('dim') || q === 'o' || q.startsWith('o ')) return 'diminished';
  if (q.startsWith('+7') || q.startsWith('aug7') || q.startsWith('7#5') || q.startsWith('7♯5')) return 'augmented-seventh';
  if (q === '+' || q.startsWith('aug')) return 'augmented';
  if (q === 'm' || q === 'min' || q === 'mi' || q === '−') return 'minor';
  if (q.startsWith('m7') || q.startsWith('min7') || q.startsWith('mi7') || q.startsWith('−7')) return 'minor-seventh';
  if (q.startsWith('m') && /\d/.test(q)) return 'minor-seventh';
  if (q.startsWith('−') && /\d/.test(q)) return 'minor-seventh';
  if (q === '6' || q.startsWith('6/9')) return 'major-sixth';
  if (q === '7') return 'dominant';
  if (/^[79]/.test(q) || q.startsWith('13') || q.startsWith('11')) return 'dominant';
  if (q.startsWith('sus4') || q === 'sus') return 'suspended-fourth';
  if (q.startsWith('sus2')) return 'suspended-second';
  return 'major';
}

// Key string → MusicXML <fifths> (+sharps / -flats). Direct major+minor table.
function mxKeyFifths(keyStr) {
  const FIFTHS = {
    C: 0, Am: 0, G: 1, Em: 1, D: 2, Bm: 2, A: 3, 'F#m': 3,
    E: 4, 'C#m': 4, B: 5, 'G#m': 5, 'F#': 6, 'D#m': 6, 'C#': 7,
    F: -1, Dm: -1, Bb: -2, Gm: -2, Eb: -3, Cm: -3,
    Ab: -4, Fm: -4, Db: -5, Bbm: -5, Gb: -6, Ebm: -6, Cb: -7,
  };
  if (!keyStr) return 0;
  let s = String(keyStr).trim()
    .replace(/♭/g, 'b').replace(/♯/g, '#')
    .replace(/\s*(major|maj)\s*$/i, '')
    .replace(/\s*(minor|min)\s*$/i, 'm');
  if (!s) return 0;
  s = s[0].toUpperCase() + s.slice(1);
  return FIFTHS[s] !== undefined ? FIFTHS[s] : 0;
}

// Key string → 'major' | 'minor'.
function mxKeyMode(keyStr) {
  const MINOR = new Set(['Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm']);
  const s = String(keyStr || '').trim()
    .replace(/♭/g, 'b').replace(/♯/g, '#')
    .replace(/\s*(major|maj)\s*$/i, '')
    .replace(/\s*(minor|min)\s*$/i, 'm');
  if (!s) return 'major';
  const norm = s[0].toUpperCase() + s.slice(1);
  return (norm.endsWith('m') && MINOR.has(norm)) ? 'minor' : 'major';
}

// One <harmony> element for a single chord text at a division offset.
function mxHarmony(text, offsetDivs) {
  const root = String(text || '').match(/^([A-G])(♭|♯|b|#)?/);
  if (!root) return '';
  const rootStep = root[1];
  const accStr = root[2] || '';
  const rootAlter = (accStr === '♭' || accStr === 'b') ? -1 : (accStr === '♯' || accStr === '#') ? 1 : 0;
  const afterRoot = text.slice(root[0].length);
  const qualRaw = afterRoot.replace(/\/.*$/, '').trim();
  const bassMatch = afterRoot.match(/\/([A-G])(♭|♯|b|#)?$/);
  const bassStep = bassMatch ? bassMatch[1] : '';
  const bassAcc = bassMatch ? (bassMatch[2] || '') : '';
  const bassAlter = (bassAcc === '♭' || bassAcc === 'b') ? -1 : (bassAcc === '♯' || bassAcc === '#') ? 1 : 0;
  const alterTag = rootAlter !== 0 ? `<alter>${rootAlter}</alter>` : '';
  const bassXml = bassStep ? `<bass><bass-step>${mxEsc(bassStep)}</bass-step>${bassAlter !== 0 ? `<bass-alter>${bassAlter}</bass-alter>` : ''}</bass>` : '';
  const offsetTag = offsetDivs > 0 ? `<offset>${offsetDivs}</offset>` : '';
  return `\n      <harmony>${offsetTag}<root><root-step>${mxEsc(rootStep)}</root-step>${alterTag}</root><kind>${mxChordKind(qualRaw)}</kind>${bassXml}</harmony>`;
}

// MusicXML 4.0 score-partwise wrapper around a measures string.
function mxScoreDoc(title, composer, measureXml, partName) {
  const name = partName || 'Rhythm Guitar';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <movement-title>${mxEsc(title || 'Untitled')}</movement-title>${composer ? `\n  <identification><creator type="composer">${mxEsc(composer)}</creator></identification>` : ''}
  <part-list>
    <score-part id="P1"><part-name>${mxEsc(name)}</part-name></score-part>
  </part-list>
  <part id="P1">${measureXml}
  </part>
</score-partwise>`;
}

if (typeof window !== 'undefined') {
  window.MusicXmlCore = { mxEsc, mxChordKind, mxKeyFifths, mxKeyMode, mxHarmony, mxScoreDoc };
}

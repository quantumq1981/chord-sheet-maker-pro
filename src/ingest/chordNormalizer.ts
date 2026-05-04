/**
 * chordNormalizer.ts — Pure chord-symbol normalisation utilities.
 * No browser / PDF dependencies; safe to import in Node.js tests.
 */

/**
 * Regex to match a plausible chord symbol rooted on a note name.
 * The quality group is optional so plain major chords (G, D, A) match.
 * `maj[0-9]*` covers maj, maj7, maj9, maj11, maj13 in one alternative.
 * `[0-9]+sus[24]?` precedes bare `[0-9]+` so "7sus4" resolves correctly.
 */
export const CHORD_REGEX =
  /^[A-G][b#]?(?:maj[0-9]*|m7b5|m7|m6|m9|m11|m13|mM7|m|dim7|dim|aug7|aug|sus[24](?:add\d+)?|sus|add9|add11|add13|add|7M|[Øø]7?|°7?|Δ7?|M7?|[0-9]+sus[24]?(?:[b#][0-9]+)*|[0-9]+(?:[b#][0-9]+)*)?(?:\/[A-G][b#]?)?$/;

/**
 * Central normalisation function for chord symbols extracted from UG Pro PDFs.
 * Converts various unicode and informal notations to canonical CSMPN form.
 *
 * Handles:
 *  - Unicode accidentals ♭/♯ → b/#
 *  - Greek omicron ο (U+03BF) → ASCII o  (MuseScore diminished)
 *  - Half-diminished Ø/ø → m7b5
 *  - Diminished °/o → dim
 *  - dim+b7 → dim7  (MuseScore "dim with added flat 7" notation)
 *  - Δ / j7 / 7M / M7 / Maj7 / Maj9 → maj7/maj9 (European and jazz shorthand)
 *  - European extension suffix: 9- → b9, 5+ → #5 (e.g. D79- → D7b9)
 *  - Parenthesised and bare omit qualifiers (no5) → stripped
 *  - Pseudo-slash alterations /#5 /b5 /5+ /add13 → stripped (not real bass notes)
 *  - Minor "min" → "m"
 */
export function normalizeChordSymbol(raw: string): string {
  let s = raw.trim();

  // Strip internal whitespace (PDF can split "C maj7" as one span with a space)
  s = s.replace(/\s+/g, '');

  // 1. Unicode accidentals
  s = s.replace(/♭/g, 'b').replace(/♯/g, '#');

  // 1b. Greek omicron ο (U+03BF) → ASCII o — MuseScore uses it for diminished (e.g. E♭ο7)
  s = s.replace(/ο/g, 'o');

  // 1c. European extension suffix: trailing N- means flat-N, N+ means sharp-N.
  //     Single-extension form with no 7: F9- → F7b9 (dominant implied by convention).
  //     Must run before root uppercasing so [A-G] anchoring is reliable.
  s = s.replace(/^([A-G][b#]?m?)(9|11|13)-$/, '$17b$2');
  //     General form: last digit followed by - or + → prepend b or #.
  //     Handles D79- → D7b9, F7/5+ (after slash strip), etc.
  s = s.replace(/([0-9])-(?=[^0-9A-Za-z(]|$)/g, 'b$1');
  s = s.replace(/([0-9])\+(?=[^0-9A-Za-z(]|$)/g, '#$1');

  // 2. Root note: uppercase first letter
  if (s.length === 0) return s;
  s = s[0].toUpperCase() + s.slice(1);

  // 3. Half-diminished: Ø / ø → m7b5
  s = s.replace(/([A-G][b#]?)([Øø])7?/g, '$1m7b5');

  // 4. Diminished with 7: o7 / °7 → dim7
  s = s.replace(/([A-G][b#]?)(o7|°7)/g, '$1dim7');
  // Bare diminished: o / ° → dim (but not if already 'dim')
  s = s.replace(/([A-G][b#]?)(°|(?<![a-z])o(?!7|[a-z]))/g, '$1dim');
  // dim+b7 → dim7 (MuseScore "Bdim +b7" after space-strip becomes "Bdim+b7")
  s = s.replace(/dim\+b7\b/g, 'dim7');
  // Non-standard: digit followed by "dim" suffix (e.g. E7dim → E7).
  // Appears when MuseScore splits chord runs across text spans and they get
  // reconstructed; strip the trailing dim qualifier rather than discard the chord.
  s = s.replace(/(\d)dim\b/g, '$1');

  // 5. Major seventh/ninth/etc: Δ / 7M / M7 / Maj7 / MajN → maj7 / majN
  s = s.replace(/Δ7?/g, 'maj7');
  s = s.replace(/7M\b/g, 'maj7');
  s = s.replace(/M7\b/g, 'maj7');
  s = s.replace(/[Mm][Aa][Jj]([0-9]+)/g, 'maj$1'); // Maj7 → maj7, Maj9 → maj9, etc.
  // Bare "maj" alone does not imply maj7: Cmaj → C
  s = s.replace(/([A-G][b#]?)maj\b/g, '$1');

  // 5b. Jazz triangle shorthand: j7 → maj7 (MuseScore PDF exports Δ as "j" in text layer)
  //     Anchored to root+quality so it doesn't fire on 'j7' inside 'maj7'.
  s = s.replace(/([A-G][b#]?m?)j7/g, '$1maj7');

  // 6. Minor: "min" → "m" (but not "diminished")
  s = s.replace(/min(?!or)/g, 'm');

  // 7. Omitted-fifth / parenthesised qualifiers: strip (no5), (no3), (add9), etc.
  s = s.replace(/\(no\d+\)/g, '');
  s = s.replace(/\(add(\w+)\)/g, 'add$1');
  // Bare "no5" / "no3" without parens (e.g. "G6no5" after space-strip)
  s = s.replace(/no\d+/g, '');

  // 7b. Combined sus notation: sus2/4 or sus4/2 (e.g. Fsus2/4) → keep first variant.
  s = s.replace(/sus([24])\/[24]/g, 'sus$1');

  // 8. Pseudo-slash: strip qualifiers that follow a slash but are NOT a real bass note.
  //    Real slash chords like G/B have a note letter (A-G) after the slash.
  s = s.replace(/\/[b#]\d+/g, ''); // /b5, /#5, /b9
  s = s.replace(/\/\d+[+\-]/g, ''); // /5+, /5-  (European augmented/flat on interval)
  s = s.replace(/\/add\w+/g, ''); // /add13, /add9

  // 9. Strip parenthesised tension/voicing decorators that appear in some UG Pro
  //    exports (e.g. Bm7/5+(7) → Bm7 after pseudo-slash removal; C7M(8) → Cmaj7).
  s = s.replace(/\(\d+\)/g, '');

  return s;
}

/**
 * If a raw span looks like two or more space-separated chord names (e.g. "Gm7 C7"
 * as a single MuseScore text span), returns an array of the individual chord strings.
 * Returns null if the text is a single chord or does not split cleanly.
 *
 * Omit-qualifier tokens like "no5" / "no3" are filtered from the part list before
 * validation, so "Dm7 G6 no5" correctly splits into ["Dm7", "G6"].
 */
export function splitMultiChordSpan(raw: string): string[] | null {
  if (!raw.includes(' ')) return null;
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  // Strip bare omit-qualifier tokens ("no5", "no3", etc.) — they annotate the
  // preceding chord and are not standalone chord names.
  const chordParts = parts.filter((p) => !/^no\d+$/i.test(p));
  if (chordParts.length < 2) return null;
  const allValid = chordParts.every((p) => {
    const n = normalizeChordSymbol(p);
    return CHORD_REGEX.test(n) || CHORD_REGEX.test(p);
  });
  return allValid ? chordParts : null;
}

/**
 * chordNormalizer.ts — Pure chord-symbol normalisation utilities.
 * No browser / PDF dependencies; safe to import in Node.js tests.
 */

/** Regex to match a plausible chord symbol rooted on a note name. */
export const CHORD_REGEX =
  /^[A-G][b#]?(?:maj7|maj|m7b5|m7|m6|m9|m11|m13|mM7|m|dim7|dim|aug7|aug|sus4|sus2|sus|add9|add11|add13|add|7M|[Øø]7?|°7?|Δ7?|M7?|[0-9]+(?:[b#][0-9]+)*)(?:\/[A-G][b#]?)?$/;

/**
 * Central normalisation function for chord symbols extracted from UG Pro PDFs.
 * Converts various unicode and informal notations to canonical CSMPN form.
 *
 * Handles:
 *  - Unicode accidentals ♭/♯ → b/#
 *  - Greek omicron ο (U+03BF) → ASCII o  (MuseScore diminished)
 *  - Half-diminished Ø/ø → m7b5
 *  - Diminished °/o → dim
 *  - Δ / j7 / 7M / M7 / Maj7 → maj7  (including European and jazz shorthand)
 *  - Parenthesised omit qualifiers (no5) → stripped
 *  - Pseudo-slash alterations /#5 /b5 → stripped (not real bass notes)
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

  // 2. Root note: uppercase first letter
  if (s.length === 0) return s;
  s = s[0].toUpperCase() + s.slice(1);

  // 3. Half-diminished: Ø / ø → m7b5
  s = s.replace(/([A-G][b#]?)([Øø])7?/g, '$1m7b5');

  // 4. Diminished with 7: o7 / °7 → dim7
  s = s.replace(/([A-G][b#]?)(o7|°7)/g, '$1dim7');
  // Bare diminished: o / ° → dim (but not if already 'dim')
  s = s.replace(/([A-G][b#]?)(°|(?<![a-z])o(?!7|[a-z]))/g, '$1dim');

  // 5. Major seventh: Δ / 7M / M7 / Maj7 / MAJ7 → maj7
  s = s.replace(/Δ7?/g, 'maj7');
  s = s.replace(/7M\b/g, 'maj7');
  s = s.replace(/M7\b/g, 'maj7');
  s = s.replace(/[Mm][Aa][Jj]7/g, 'maj7');
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

  // 8. Pseudo-slash: /b5, /#5, /b9 etc. where the "bass" is a chromatic alteration,
  //    not a real bass note. Strip the slash + qualifier.
  //    Real slash chords like G/B have a note letter (A-G) after the slash.
  s = s.replace(/\/[b#]\d+/g, '');

  return s;
}

/**
 * If a raw span looks like two or more space-separated chord names (e.g. "Gm7 C7"
 * as a single MuseScore text span), returns an array of the individual chord strings.
 * Returns null if the text is a single chord or does not split cleanly.
 */
export function splitMultiChordSpan(raw: string): string[] | null {
  if (!raw.includes(' ')) return null;
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const allValid = parts.every((p) => {
    const n = normalizeChordSymbol(p);
    return CHORD_REGEX.test(n) || CHORD_REGEX.test(p);
  });
  return allValid ? parts : null;
}

import type { HarmonyEvent } from './types';

const KIND_SUFFIX_MAP: Record<string, string> = {
  // Triads
  major: '',
  minor: 'm',
  diminished: 'dim',
  augmented: 'aug',
  // Suspended
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  // Sixths
  'major-sixth': '6',
  'minor-sixth': 'm6',
  // Seventh family
  dominant: '7',
  'major-seventh': 'maj7',
  'augmented-major-seventh': 'augmaj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'augmented-seventh': 'aug7',
  'half-diminished': 'm7b5',
  'major-minor': 'mmaj7',
  // Ninths
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  // Elevenths
  'dominant-11th': '11',
  'major-11th': 'maj11',
  'minor-11th': 'm11',
  // Thirteenths
  'dominant-13th': '13',
  'major-13th': 'maj13',
  'minor-13th': 'm13',
  // Power / pedal
  power: '5',
  pedal: 'ped',
  // No quality (root only)
  none: '',
  // Classical augmented-sixth chords (some notation apps emit these)
  Neapolitan: 'N6',
  Italian: 'It+6',
  French: 'Fr+6',
  German: 'Gr+6',
  Tristan: 'Tr',
};

export function collectHarmoniesForMeasure(
  allPartsMeasures: Element[][],
  measureIndex: number,
  divisions: number
): HarmonyEvent[] {
  const dedupe = new Map<string, HarmonyEvent>();

  for (const partMeasures of allPartsMeasures) {
    const measure = partMeasures[measureIndex];
    if (!measure) {
      continue;
    }

    let cursor = 0;
    for (const child of [...measure.children]) {
      if (child.tagName === 'backup') {
        const shift = parseIntText(child.querySelector('duration')?.textContent, 0);
        cursor = Math.max(0, cursor - shift);
      } else if (child.tagName === 'forward') {
        const shift = parseIntText(child.querySelector('duration')?.textContent, 0);
        cursor += shift;
      } else if (child.tagName === 'note') {
        cursor += parseIntText(child.querySelector('duration')?.textContent, 0);
      } else if (child.tagName === 'harmony') {
        const offsetRaw = child.querySelector(':scope > offset')?.textContent;
        const offset =
          offsetRaw != null ? Math.max(0, Math.round(parseFloat(offsetRaw) * divisions)) : cursor;
        const chordText = harmonyToChordText(child);
        if (!chordText) {
          continue;
        }
        const key = `${offset}__${chordText}`;
        if (!dedupe.has(key)) {
          dedupe.set(key, {
            measureIndex,
            offsetDivisions: offset,
            chordText,
          });
        }
      }
    }
  }

  return [...dedupe.values()].sort((a, b) => a.offsetDivisions - b.offsetDivisions);
}

export function harmonyToChordText(harmonyEl: Element): string {
  const rootStep = harmonyEl.querySelector(':scope > root > root-step')?.textContent?.trim() ?? '';
  if (!rootStep) {
    return '';
  }
  const rootAlter = parseIntText(
    harmonyEl.querySelector(':scope > root > root-alter')?.textContent,
    0
  );
  const root = `${rootStep}${accidentalFromAlter(rootAlter)}`;

  const kindEl = harmonyEl.querySelector(':scope > kind');
  const kindText = kindEl?.getAttribute('text')?.trim();
  const kindValue = kindEl?.textContent?.trim() ?? 'major';
  const suffix =
    kindText && kindText.length > 0 ? kindText : (KIND_SUFFIX_MAP[kindValue] ?? kindValue);

  const degreeStr = parseDegreeModifications(harmonyEl);

  const bassStep = harmonyEl.querySelector(':scope > bass > bass-step')?.textContent?.trim();
  const bassAlter = parseIntText(
    harmonyEl.querySelector(':scope > bass > bass-alter')?.textContent,
    0
  );
  const bass = bassStep ? `${bassStep}${accidentalFromAlter(bassAlter)}` : '';

  return `${root}${suffix}${degreeStr}${bass ? `/${bass}` : ''}`;
}

/**
 * Parse `<degree>` children of a `<harmony>` element and return a string
 * representing added or altered chord tones, e.g. "add9", "b5", "#11".
 *
 * MusicXML degree types:
 *   add      — adds a tone not implied by the chord quality (e.g., Cadd9)
 *   alter    — modifies an existing tone (e.g., C7b5, C7#11)
 *   subtract — removes a tone; not representable in plain text notation, skipped
 */
export function parseDegreeModifications(harmonyEl: Element): string {
  const degrees = [...harmonyEl.querySelectorAll(':scope > degree')];
  if (degrees.length === 0) {
    return '';
  }

  const parts: string[] = [];
  for (const degree of degrees) {
    const value = parseIntText(degree.querySelector('degree-value')?.textContent, 0);
    const alter = parseIntText(degree.querySelector('degree-alter')?.textContent, 0);
    const type = degree.querySelector('degree-type')?.textContent?.trim() ?? 'add';

    if (value <= 0 || type === 'subtract') {
      continue;
    }

    const acc = alter > 0 ? '#'.repeat(alter) : alter < 0 ? 'b'.repeat(-alter) : '';

    if (type === 'add') {
      parts.push(`add${acc}${value}`);
    } else if (type === 'alter') {
      parts.push(`${acc}${value}`);
    }
  }

  return parts.join('');
}

export function accidentalFromAlter(alter: number): string {
  if (alter > 0) {
    return '#'.repeat(alter);
  }
  if (alter < 0) {
    return 'b'.repeat(Math.abs(alter));
  }
  return '';
}

function parseIntText(text: string | null | undefined, fallback: number): number {
  if (!text) {
    return fallback;
  }
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : fallback;
}

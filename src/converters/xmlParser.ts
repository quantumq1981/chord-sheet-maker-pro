import type { LyricEvent, MeasureData } from './types';
import { collectHarmoniesForMeasure } from './chordExtractor';

interface ParsedMetadata {
  title?: string;
  composer?: string;
  key?: string;
  time?: string;
  tempo?: string;
}

export function parseMetadata(xmlDoc: Document): ParsedMetadata {
  const title = textAt(xmlDoc, 'work > work-title') ?? textAt(xmlDoc, 'movement-title');

  const composerNode = [...xmlDoc.querySelectorAll('identification > creator')].find(
    (creator) => (creator.getAttribute('type') ?? '').toLowerCase() === 'composer'
  );
  const composer = composerNode?.textContent?.trim() || undefined;

  const firstAttributes =
    xmlDoc.querySelector('part > measure > attributes') ?? xmlDoc.querySelector('attributes');
  const fifthsRaw = firstAttributes?.querySelector('key > fifths')?.textContent?.trim();
  const modeRaw = firstAttributes?.querySelector('key > mode')?.textContent?.trim();

  const key = buildKeySignature(fifthsRaw, modeRaw);
  const beats = firstAttributes?.querySelector('time > beats')?.textContent?.trim();
  const beatType = firstAttributes?.querySelector('time > beat-type')?.textContent?.trim();
  const time = beats && beatType ? `${beats}/${beatType}` : undefined;

  let tempo: string | undefined;
  const soundEls = xmlDoc.querySelectorAll('direction > sound[tempo], sound[tempo]');
  for (const el of soundEls) {
    const raw = el.getAttribute('tempo');
    if (raw) {
      const bpm = Math.round(Number(raw));
      if (Number.isFinite(bpm) && bpm > 0) {
        tempo = String(bpm);
        break;
      }
    }
  }

  return {
    title: title?.trim() || undefined,
    composer,
    key,
    time,
    tempo,
  };
}

export function selectLyricPart(xmlDoc: Document): string | undefined {
  const parts = [...xmlDoc.querySelectorAll('score-partwise > part')];
  let bestId: string | undefined;
  let bestCount = -1;

  for (const part of parts) {
    const id = part.getAttribute('id') || undefined;
    const count = part.querySelectorAll('lyric > text').length;
    if (count > bestCount) {
      bestCount = count;
      bestId = id;
    }
  }

  return bestId;
}

export function buildMeasureData(
  xmlDoc: Document,
  selectedLyricPartId: string | undefined
): MeasureData[] {
  const parts = [...xmlDoc.querySelectorAll('score-partwise > part')];
  const lyricPart =
    parts.find((part) => part.getAttribute('id') === selectedLyricPartId) ?? parts[0];
  const lyricMeasures = lyricPart ? [...lyricPart.querySelectorAll(':scope > measure')] : [];

  const allPartsMeasures = parts.map((part) => [...part.querySelectorAll(':scope > measure')]);

  let divisions = 1;
  const result: MeasureData[] = [];

  lyricMeasures.forEach((measureEl, measureIndex) => {
    const divisionsText = measureEl.querySelector('attributes > divisions')?.textContent?.trim();
    if (divisionsText) {
      const parsed = Number.parseInt(divisionsText, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        divisions = parsed;
      }
    }

    let cursor = 0;
    let durationDivisions = 0;
    const lyricsByVerse: Record<string, LyricEvent[]> = {};

    for (const child of [...measureEl.children]) {
      if (child.tagName === 'backup') {
        const shift = parseIntText(child.querySelector('duration')?.textContent, 0);
        cursor = Math.max(0, cursor - shift);
        continue;
      }
      if (child.tagName === 'forward') {
        const shift = parseIntText(child.querySelector('duration')?.textContent, 0);
        cursor += shift;
        durationDivisions = Math.max(durationDivisions, cursor);
        continue;
      }
      if (child.tagName !== 'note') {
        continue;
      }

      const noteStart = cursor;
      const duration = parseIntText(child.querySelector('duration')?.textContent, 0);
      cursor += duration;
      durationDivisions = Math.max(durationDivisions, cursor);

      const lyricNodes = [...child.querySelectorAll(':scope > lyric')];
      for (const lyricEl of lyricNodes) {
        const text = lyricEl.querySelector('text')?.textContent?.trim();
        if (!text) {
          continue;
        }

        const verse = lyricEl.getAttribute('number')?.trim() || '1';
        const syllabicText = lyricEl.querySelector('syllabic')?.textContent?.trim();
        const syllabic = normalizeSyllabic(syllabicText);
        const event: LyricEvent = {
          verse,
          measureIndex,
          offsetDivisions: noteStart,
          text,
          syllabic,
          extend: Boolean(lyricEl.querySelector('extend')),
        };
        (lyricsByVerse[verse] ??= []).push(event);
      }
    }

    Object.values(lyricsByVerse).forEach((events) => {
      events.sort((a, b) => a.offsetDivisions - b.offsetDivisions);
    });

    const harmonies = collectHarmoniesForMeasure(allPartsMeasures, measureIndex, divisions);

    const repeatStart = [...measureEl.querySelectorAll('barline repeat')].some(
      (repeat) => (repeat.getAttribute('direction') ?? '') === 'forward'
    );
    const repeatEnd = [...measureEl.querySelectorAll('barline repeat')].some(
      (repeat) => (repeat.getAttribute('direction') ?? '') === 'backward'
    );

    const endings = parseEndings(measureEl);
    const sectionLabel = parseDirectionLabel(measureEl);

    result.push({
      measureIndex,
      durationDivisions,
      harmonies,
      lyricsByVerse,
      repeatStart: repeatStart || undefined,
      repeatEnd: repeatEnd || undefined,
      endings: endings.length > 0 ? endings : undefined,
      sectionLabel,
    });
  });

  return result;
}

export function detectAttributeChanges(xmlDoc: Document): {
  keyChanges: number;
  timeChanges: number;
} {
  const allAttributes = [...xmlDoc.querySelectorAll('part > measure > attributes')];
  let lastKey: string | undefined;
  let lastTime: string | undefined;
  let keyChanges = 0;
  let timeChanges = 0;

  for (const attrs of allAttributes) {
    const fifthsText = attrs.querySelector('key > fifths')?.textContent?.trim();
    const modeText = attrs.querySelector('key > mode')?.textContent?.trim();
    const beatsText = attrs.querySelector('time > beats')?.textContent?.trim();
    const beatTypeText = attrs.querySelector('time > beat-type')?.textContent?.trim();

    if (fifthsText !== undefined) {
      const key = buildKeySignature(fifthsText, modeText) ?? fifthsText;
      if (lastKey !== undefined && key !== lastKey) {
        keyChanges++;
      }
      lastKey = key;
    }

    if (beatsText !== undefined && beatTypeText !== undefined) {
      const time = `${beatsText}/${beatTypeText}`;
      if (lastTime !== undefined && time !== lastTime) {
        timeChanges++;
      }
      lastTime = time;
    }
  }

  return { keyChanges, timeChanges };
}

/**
 * Return true when the first measure is a pickup/anacrusis — i.e. its total
 * duration is meaningfully shorter than the second measure's duration.
 */
export function detectPickupBar(measures: MeasureData[]): boolean {
  if (measures.length < 2) {
    return false;
  }
  const first = measures[0];
  const second = measures[1];
  return (
    second.durationDivisions > 0 &&
    first.durationDivisions > 0 &&
    first.durationDivisions < second.durationDivisions * 0.75
  );
}

/**
 * Return a section label for a measure when it contains a rehearsal mark or a
 * direction `<words>` element that matches a well-known section keyword.
 *
 * Rehearsal marks (e.g. "A", "B", "Verse", "Chorus") are always captured.
 * Direction words are captured only when they start with a recognised keyword
 * so that tempo/dynamic markings ("Slowly", "mf") are ignored.
 */
export function parseDirectionLabel(measureEl: Element): string | undefined {
  const rehearsalEl = measureEl.querySelector('direction direction-type rehearsal');
  if (rehearsalEl) {
    const text = rehearsalEl.textContent?.trim();
    if (text && text.length > 0 && text.length <= 32) {
      return text;
    }
  }

  const wordEls = [...measureEl.querySelectorAll('direction direction-type words')];
  for (const wordEl of wordEls) {
    const text = wordEl.textContent?.trim();
    if (!text || text.length > 40) {
      continue;
    }
    if (
      /^(verse|chorus|refrain|bridge|intro|outro|coda|tag|hook|vamp|interlude|pre.?chorus|break|solo|ending)/i.test(
        text
      )
    ) {
      return text;
    }
  }

  return undefined;
}

export function parseEndings(measureEl: Element): number[] {
  const endings = new Set<number>();
  const endingNodes = [...measureEl.querySelectorAll('barline ending')];

  for (const endingEl of endingNodes) {
    const numberText = endingEl.getAttribute('number')?.trim();
    if (!numberText) {
      continue;
    }
    const parts = numberText.split(',').map((token) => Number.parseInt(token.trim(), 10));
    for (const value of parts) {
      if (Number.isFinite(value)) {
        endings.add(value);
      }
    }
  }

  return [...endings].sort((a, b) => a - b);
}

export function buildKeySignature(
  fifthsRaw: string | undefined,
  modeRaw: string | undefined
): string | undefined {
  if (fifthsRaw == null) {
    return undefined;
  }
  const fifths = Number.parseInt(fifthsRaw, 10);
  if (!Number.isFinite(fifths)) {
    return undefined;
  }

  const majorByFifths = [
    'Cb',
    'Gb',
    'Db',
    'Ab',
    'Eb',
    'Bb',
    'F',
    'C',
    'G',
    'D',
    'A',
    'E',
    'B',
    'F#',
    'C#',
  ];
  const idx = fifths + 7;
  if (idx < 0 || idx >= majorByFifths.length) {
    return undefined;
  }
  const major = majorByFifths[idx];
  const mode = (modeRaw ?? 'major').toLowerCase();

  if (mode === 'minor') {
    const notes = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
    const majorSemitone = noteToSemitone(major);
    if (majorSemitone === undefined) {
      return `${major}m`;
    }
    const minorSemitone = (majorSemitone + 9) % 12;
    const minorNote = notes[minorSemitone] ?? `${major}m`;
    return `${minorNote}m`;
  }

  return major;
}

function normalizeSyllabic(input: string | undefined): LyricEvent['syllabic'] | undefined {
  if (!input) {
    return undefined;
  }
  if (input === 'single' || input === 'begin' || input === 'middle' || input === 'end') {
    return input;
  }
  return undefined;
}

function noteToSemitone(note: string): number | undefined {
  const table: Record<string, number> = {
    C: 0,
    'B#': 0,
    'C#': 1,
    Db: 1,
    D: 2,
    'D#': 3,
    Eb: 3,
    E: 4,
    Fb: 4,
    'E#': 5,
    F: 5,
    'F#': 6,
    Gb: 6,
    G: 7,
    'G#': 8,
    Ab: 8,
    A: 9,
    'A#': 10,
    Bb: 10,
    B: 11,
    Cb: 11,
  };
  return table[note];
}

function parseIntText(text: string | null | undefined, fallback: number): number {
  if (!text) {
    return fallback;
  }
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : fallback;
}

function textAt(root: ParentNode, selector: string): string | undefined {
  return root.querySelector(selector)?.textContent?.trim() || undefined;
}

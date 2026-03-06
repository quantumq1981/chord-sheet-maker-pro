export type MusicXmlMetadata = {
  title?: string;
  composer?: string;
  key?: string;
  time?: string;
};

export type ParsedMusicXmlMeasure = {
  number: number;
  harmonies: string[];
};

export type ParsedMusicXml = {
  metadata: MusicXmlMetadata;
  measures: ParsedMusicXmlMeasure[];
};

export function parseMusicXmlForFakebook(xmlText: string): ParsedMusicXml {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`MusicXML parse error: ${parserError.textContent?.trim() ?? 'Invalid XML'}`);
  }

  const score = doc.querySelector('score-partwise, score-timewise');
  if (!score) {
    throw new Error('Input is not a MusicXML score-partwise/score-timewise document.');
  }

  const title =
    score.querySelector('work > work-title')?.textContent?.trim()
    || score.querySelector('movement-title')?.textContent?.trim()
    || undefined;

  const composer =
    Array.from(score.querySelectorAll('identification > creator')).find((el) =>
      (el.getAttribute('type') ?? '').toLowerCase() === 'composer',
    )?.textContent?.trim()
    || undefined;

  const measures = Array.from(score.querySelectorAll('part > measure'));
  const parsedMeasures: ParsedMusicXmlMeasure[] = [];

  let keyFifths: number | undefined;
  let keyMode: string | undefined;
  let timeBeats: string | undefined;
  let timeBeatType: string | undefined;

  for (let i = 0; i < measures.length; i += 1) {
    const measure = measures[i];
    const number = Number.parseInt(measure.getAttribute('number') ?? `${i + 1}`, 10);

    const attributes = measure.querySelector('attributes');
    if (attributes) {
      const fifthsText = attributes.querySelector('key > fifths')?.textContent?.trim();
      const parsedFifths = Number.parseInt(fifthsText ?? '', 10);
      if (!Number.isNaN(parsedFifths)) {
        keyFifths = parsedFifths;
      }

      const modeText = attributes.querySelector('key > mode')?.textContent?.trim();
      if (modeText) {
        keyMode = modeText;
      }

      const beatsText = attributes.querySelector('time > beats')?.textContent?.trim();
      if (beatsText) {
        timeBeats = beatsText;
      }

      const beatTypeText = attributes.querySelector('time > beat-type')?.textContent?.trim();
      if (beatTypeText) {
        timeBeatType = beatTypeText;
      }
    }

    const harmonies = Array.from(measure.querySelectorAll('harmony')).map(formatHarmony).filter(Boolean);
    parsedMeasures.push({ number: Number.isNaN(number) ? i + 1 : number, harmonies });
  }

  return {
    metadata: {
      title,
      composer,
      key: typeof keyFifths === 'number' ? keyFromFifths(keyFifths, keyMode) : undefined,
      time: timeBeats && timeBeatType ? `${timeBeats}/${timeBeatType}` : undefined,
    },
    measures: parsedMeasures,
  };
}

export function emitCsmpnFakebook(parsed: ParsedMusicXml): string {
  const lines: string[] = [];
  lines.push(`Title: ${parsed.metadata.title ?? 'Untitled'}`);
  if (parsed.metadata.composer) lines.push(`Composer: ${parsed.metadata.composer}`);
  if (parsed.metadata.key) lines.push(`Key: ${parsed.metadata.key}`);
  if (parsed.metadata.time) lines.push(`Time: ${parsed.metadata.time}`);
  lines.push('');
  lines.push('- Chords');

  let sawFirstEmptyMeasure = false;
  const measureTokens = parsed.measures.map((measure) => {
    if (measure.harmonies.length > 0) {
      return measure.harmonies.join('_');
    }
    if (!sawFirstEmptyMeasure) {
      sawFirstEmptyMeasure = true;
      return 'N.C.';
    }
    return '%';
  });

  lines.push(measureTokens.join(' | '));
  return lines.join('\n');
}

function formatHarmony(harmonyNode: Element): string {
  const rootStep = harmonyNode.querySelector('root > root-step')?.textContent?.trim() ?? '';
  const rootAlter = harmonyNode.querySelector('root > root-alter')?.textContent?.trim() ?? '';
  if (!rootStep) return '';

  const alter = rootAlter === '1' ? '#' : rootAlter === '-1' ? 'b' : '';
  const kind = harmonyNode.querySelector('kind')?.textContent?.trim() ?? '';
  const degree = Array.from(harmonyNode.querySelectorAll('degree')).map((node) => {
    const value = node.querySelector('degree-value')?.textContent?.trim() ?? '';
    const type = node.querySelector('degree-type')?.textContent?.trim() ?? '';
    if (!value || !type) return '';
    if (type === 'add') return `add${value}`;
    if (type === 'alter') return `#${value}`;
    if (type === 'subtract') return `no${value}`;
    return '';
  }).filter(Boolean).join('');

  const bassStep = harmonyNode.querySelector('bass > bass-step')?.textContent?.trim() ?? '';
  const bassAlter = harmonyNode.querySelector('bass > bass-alter')?.textContent?.trim() ?? '';
  const bass = bassStep ? `/${bassStep}${bassAlter === '1' ? '#' : bassAlter === '-1' ? 'b' : ''}` : '';

  return `${rootStep}${alter}${normalizeKind(kind)}${degree}${bass}`;
}

function normalizeKind(kind: string): string {
  const value = kind.toLowerCase();
  if (!value || value === 'major') return '';
  if (value === 'minor') return 'm';
  if (value === 'dominant') return '7';
  if (value === 'major-seventh') return 'maj7';
  if (value === 'minor-seventh') return 'm7';
  if (value === 'half-diminished') return 'm7b5';
  if (value === 'diminished') return 'dim';
  if (value === 'augmented') return 'aug';
  return kind;
}

function keyFromFifths(fifths: number, mode?: string): string {
  const majorKeys = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const minorKeys = ['Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m'];
  const index = Math.max(0, Math.min(14, fifths + 7));
  return (mode ?? '').toLowerCase() === 'minor' ? minorKeys[index] : majorKeys[index];
}

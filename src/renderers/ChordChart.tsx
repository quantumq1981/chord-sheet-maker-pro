/**
 * ChordChart.tsx
 *
 * React component that renders a normalized ChordChartDocument in the classic
 * "chord name above lyric" style used by lead-sheet apps.
 *
 * Layout model
 * ─────────────
 * Each ChartLine is rendered as a horizontal row of "pairs".  A pair is one
 * optional chord name stacked above one optional lyric segment:
 *
 *   ┌───────┐ ┌────────┐ ┌──────┐
 *   │  Am   │ │        │ │  G   │
 *   │ Hello │ │  there │ │ world│
 *   └───────┘ └────────┘ └──────┘
 *
 * Chord-only lines (no lyrics) are rendered as a row of coloured chord names.
 * Comment tokens are rendered as a full-width italic annotation row.
 *
 * Transpose
 * ─────────
 * Pass `transposeSteps` (positive = up, negative = down) to shift every chord
 * root by that many semitones.  The key shown in the header is transposed too.
 */

import type {
  ChordChartDocument,
  ChartSection,
  ChartLine,
  ChartToken,
  TabColumn,
  BarlineToken,
} from '../models/ChordChartModel';

// ─── Transpose helpers ────────────────────────────────────────────────────────

const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Normalise enharmonic equivalents to the nearest sharp for lookup. */
const ENHARMONIC: Record<string, string> = {
  // Flats → sharps
  Db: 'C#', Eb: 'D#', Fb: 'E',  Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B',
  // Double-sharps / theoretical sharps → naturals
  'B#': 'C', 'E#': 'F',
};

function transposeRoot(root: string, steps: number): string {
  if (steps === 0) return root;
  const normalized = ENHARMONIC[root] ?? root;
  const idx = CHROMATIC.indexOf(normalized as (typeof CHROMATIC)[number]);
  if (idx === -1) return root;
  return CHROMATIC[((idx + steps) % 12 + 12) % 12];
}

/**
 * Transpose a chord name by `steps` semitones.
 * Handles slash chords (Am/G) by transposing both root and bass separately.
 */
export function transposeChord(chord: string, steps: number): string {
  if (steps === 0) return chord;

  // Split on the last "/" that looks like a bass note separator
  const slashIdx = chord.lastIndexOf('/');
  if (slashIdx > 0) {
    const upper = chord.slice(0, slashIdx);
    const bass = chord.slice(slashIdx + 1);
    return `${transposeChord(upper, steps)}/${transposeChord(bass, steps)}`;
  }

  const match = chord.match(/^([A-G][#b]?)(.*)$/);
  if (!match) return chord;
  const [, root, rest] = match;
  return `${transposeRoot(root, steps)}${rest}`;
}

// ─── Line-level rendering helpers ─────────────────────────────────────────────

interface Pair {
  chord?: string;
  lyric?: string;
}

/**
 * Group a mixed chord+lyric token list into (chord, lyric) display pairs.
 * Each chord is paired with the lyric text that immediately follows it.
 */
function tokensToPairs(tokens: ChartToken[]): Pair[] {
  const pairs: Pair[] = [];

  for (const token of tokens) {
    if (token.kind === 'chord') {
      pairs.push({ chord: token.text });
    } else if (token.kind === 'lyric') {
      const last = pairs[pairs.length - 1];
      if (last && last.lyric === undefined) {
        last.lyric = token.text;
      } else {
        pairs.push({ lyric: token.text });
      }
    }
    // comment tokens are handled separately before this helper is called
  }

  return pairs;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** The Unicode simile / repeat-last-bar symbol used in fake-book notation. */
const SIMILE = '\u00B7/\u00B7';

function ChordSpan({ text, steps }: { text: string; steps: number }) {
  return <span className="cc-chord">{transposeChord(text, steps)}</span>;
}

// ─── Fake-book grid rendering ─────────────────────────────────────────────────

/**
 * Render one bar row from fake-book notation.
 *
 * The token stream is structured as:
 *   barline(|:)  chord …  barline(|)  chord …  barline(:|)
 *
 * We group chords between barlines into "bar cells" and render each cell as a
 * bordered box.  |: and :| receive thicker purple borders (repeat signs).
 * The ·/· simile marker gets a lighter italic style.
 */
function FakeBookRow({ tokens, steps }: { tokens: ChartToken[]; steps: number }) {
  interface Bar {
    chords: ChartToken[];
    repeatStart: boolean;
    repeatEnd: boolean;
  }

  const bars: Bar[] = [];
  let chords: ChartToken[] = [];
  let repeatStart = false;
  let pendingRepeatEnd = false;

  const flushBar = (repeatEnd = false) => {
    if (chords.length > 0 || repeatStart || repeatEnd) {
      bars.push({ chords, repeatStart, repeatEnd });
      chords = [];
      repeatStart = false;
    }
  };

  for (const token of tokens) {
    if (token.kind === 'barline') {
      const bl = (token as BarlineToken).text;
      if (bl === '|:') {
        flushBar(pendingRepeatEnd);
        pendingRepeatEnd = false;
        repeatStart = true;
      } else if (bl === ':|') {
        flushBar(true);
        pendingRepeatEnd = false;
      } else if (bl === '||') {
        flushBar(true);
        repeatStart = true;
      } else {
        // single |
        flushBar(pendingRepeatEnd);
        pendingRepeatEnd = false;
      }
    } else {
      chords.push(token);
    }
  }
  flushBar(pendingRepeatEnd);

  return (
    <div className="cc-grid-row">
      {bars.map((bar, i) => (
        <div
          key={i}
          className={[
            'cc-grid-bar',
            bar.repeatStart ? 'cc-grid-bar--repeat-start' : '',
            bar.repeatEnd   ? 'cc-grid-bar--repeat-end'   : '',
          ].filter(Boolean).join(' ')}
        >
          {bar.chords.map((t, j) => {
            if (t.kind !== 'chord') return null;
            if (t.text === SIMILE) {
              return <span key={j} className="cc-simile">{SIMILE}</span>;
            }
            return <ChordSpan key={j} text={t.text} steps={steps} />;
          })}
        </div>
      ))}
    </div>
  );
}

interface LineProps {
  line: ChartLine;
  steps: number;
}

function LineRow({ line, steps }: LineProps) {
  const { tokens } = line;
  if (tokens.length === 0) return null;

  // Single comment token
  if (tokens.length === 1 && tokens[0].kind === 'comment') {
    return <div className="cc-line cc-comment">{tokens[0].text}</div>;
  }

  // Fake-book grid line (contains barline tokens)
  if (tokens.some((t) => t.kind === 'barline')) {
    return <FakeBookRow tokens={tokens} steps={steps} />;
  }

  const hasChord = tokens.some((t) => t.kind === 'chord');
  const hasLyric = tokens.some((t) => t.kind === 'lyric');

  // Chord-only line (no lyrics)
  if (hasChord && !hasLyric) {
    return (
      <div className="cc-line cc-chords-only">
        {tokens.filter((t) => t.kind === 'chord').map((t, i) => (
          <span key={i} className="cc-chords-only__cell">
            <ChordSpan text={t.text} steps={steps} />
          </span>
        ))}
      </div>
    );
  }

  // Lyric-only line
  if (!hasChord && hasLyric) {
    return (
      <div className="cc-line cc-lyrics-only">
        {tokens.filter((t) => t.kind === 'lyric').map((t, i) => (
          <span key={i}>{t.text}</span>
        ))}
      </div>
    );
  }

  // Mixed chord + lyric → pair layout
  const pairs = tokensToPairs(tokens);
  return (
    <div className="cc-line cc-mixed">
      {pairs.map((pair, i) => (
        <span key={i} className="cc-pair">
          <span className="cc-pair__chord">
            {pair.chord ? <ChordSpan text={pair.chord} steps={steps} /> : '\u00A0'}
          </span>
          <span className="cc-pair__lyric">{pair.lyric ?? ''}</span>
        </span>
      ))}
    </div>
  );
}

// ─── Tab section rendering ────────────────────────────────────────────────────

/**
 * Number of beat-columns to pack into one visual tab row.
 * 16 columns ≈ 2 bars of 4/4 at quarter-note resolution.
 */
const TAB_COLS_PER_ROW = 16;

/**
 * Standard string label order for a 6-string guitar (high → low).
 * Extended with numbers for 7-/8-string instruments.
 */
const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E', '7', '8', '9'] as const;

/**
 * Build one ASCII tab row (6+ string lines) from a slice of TabColumns.
 *
 * Column width is determined by the widest fret number in that column so
 * every line stays aligned.  The right edge of each cell is padded with '-'.
 */
function buildTabRow(columns: TabColumn[], stringCount: number): string[] {
  if (columns.length === 0 || stringCount === 0) return [];

  // Pre-compute the character width of each column
  const colWidths = columns.map((col) =>
    col.strings.reduce((w: number, f: number | null) => {
      if (f === null || f === -1) return Math.max(w, 1);
      return Math.max(w, String(f).length);
    }, 1),
  );

  const lines: string[] = [];
  for (let s = 0; s < stringCount; s++) {
    const name = STRING_LABELS[s] ?? `S${s + 1}`;
    let line = `${name}|`;
    for (let c = 0; c < columns.length; c++) {
      const fret: number | null = columns[c].strings[s] ?? null;
      let cell: string;
      if (fret === null) {
        cell = '-'.repeat(colWidths[c]);
      } else if (fret === -1) {
        cell = 'x' + '-'.repeat(Math.max(0, colWidths[c] - 1));
      } else {
        const fs = String(fret);
        cell = fs + '-'.repeat(Math.max(0, colWidths[c] - fs.length));
      }
      line += cell;
    }
    line += '|';
    lines.push(line);
  }
  return lines;
}

interface TabSectionProps {
  section: ChartSection;
  steps: number;
}

function TabSectionBlock({ section, steps }: TabSectionProps) {
  const rawColumns = section.tabColumns ?? [];
  if (rawColumns.length === 0) return null;

  const stringCount = rawColumns.reduce((m, c) => Math.max(m, c.strings.length), 0);

  // Apply transposition: shift every non-null, non-muted fret by `steps`.
  // Fret numbers are clamped to ≥ 0 (can't go below the nut).
  const columns: TabColumn[] = steps === 0
    ? rawColumns
    : rawColumns.map((col) => ({
        strings: col.strings.map((f) =>
          f !== null && f >= 0 ? Math.max(0, f + steps) : f,
        ),
      }));

  // Slice into rows
  const rows: TabColumn[][] = [];
  for (let i = 0; i < columns.length; i += TAB_COLS_PER_ROW) {
    rows.push(columns.slice(i, i + TAB_COLS_PER_ROW));
  }

  const label = section.label ?? 'Tab';

  return (
    <div className="cc-section cc-tab" data-type="tab">
      <div className="cc-section-label">{label}</div>
      {rows.map((row, ri) => (
        <pre key={ri} className="cc-tab-row">
          {buildTabRow(row, stringCount).join('\n')}
        </pre>
      ))}
    </div>
  );
}

// ─── Section block ─────────────────────────────────────────────────────────────

function SectionBlock({ section, steps }: { section: ChartSection; steps: number }) {
  // Tab sections have their own specialised renderer
  if (section.type === 'tab' && section.tabColumns?.length) {
    return <TabSectionBlock section={section} steps={steps} />;
  }

  const label = section.label ?? (section.type !== 'unknown' ? section.type : undefined);
  return (
    <div className="cc-section" data-type={section.type}>
      {label && <div className="cc-section-label">{label}</div>}
      {section.lines.map((line, i) => (
        <LineRow key={i} line={line} steps={steps} />
      ))}
    </div>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface ChordChartProps {
  document: ChordChartDocument;
  /** Semitones to shift every chord (positive = up, negative = down). */
  transposeSteps?: number;
}

export default function ChordChart({ document: doc, transposeSteps = 0 }: ChordChartProps) {
  const displayKey =
    doc.key ? transposeChord(doc.key, transposeSteps) : undefined;

  return (
    <div className="chord-chart">
      {(doc.title || doc.artist) && (
        <div className="cc-header">
          {doc.title && <h2 className="cc-title">{doc.title}</h2>}
          {doc.artist && <p className="cc-artist">{doc.artist}</p>}
          {doc.subtitle && <p className="cc-subtitle">{doc.subtitle}</p>}
          {(displayKey || doc.capo || doc.tempo || doc.time || doc.genre) && (
            <div className="cc-meta">
              {displayKey && <span>Key: {displayKey}</span>}
              {doc.capo && <span>Capo: {doc.capo}</span>}
              {doc.tempo && <span>♩= {doc.tempo}</span>}
              {doc.time && <span>Time: {doc.time}</span>}
              {doc.genre && <span>{doc.genre}</span>}
            </div>
          )}
        </div>
      )}

      {doc.sections.length === 0 && (
        <p className="cc-empty">No content found in this chord chart.</p>
      )}

      {doc.sections.map((section, i) => (
        <SectionBlock key={i} section={section} steps={transposeSteps} />
      ))}
    </div>
  );
}

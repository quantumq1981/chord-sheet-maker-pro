/**
 * SlashNotationView.tsx
 *
 * Renders a ChordChartDocument as classic slash rhythm notation on a staff —
 * the style used in Real Book / fake book lead sheets:
 *
 *   Bbm7          Ebm7   F7
 *   ////  |  //// | //// ||
 *
 * One forward-slash parallelogram notehead appears per beat, grouped into
 * barred measures.  Chord symbols float above the staff at the beat where
 * the chord changes.  Section labels (Verse, Chorus, …) appear above each
 * new system row.
 *
 * Rendering is pure SVG — no VexFlow or canvas dependency needed.
 */

import { useMemo } from 'react';
import type {
  ChordChartDocument,
  ChartSection,
  ChartToken,
  BarlineToken,
} from '../models/ChordChartModel';
import { transposeChord } from './ChordChart';

// ─── Internal data model ──────────────────────────────────────────────────────

/** One chord event inside a measure, anchored to a beat (0-based). */
interface ChordEvent {
  beat: number;
  name: string;
}

interface SlashMeasure {
  chords: ChordEvent[];
  repeatStart: boolean;
  repeatEnd: boolean;
  doubleBar: boolean;
  beatsPerMeasure: number;
}

interface SlashSection {
  label?: string;
  measures: SlashMeasure[];
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const STAFF_LINES = 5;
const LINE_GAP = 8;                          // px between staff lines
const STAFF_H = (STAFF_LINES - 1) * LINE_GAP; // 32 px
const CHORD_AREA_H = 30;                     // space above staff for chord names
const SYSTEM_PAD_BOTTOM = 30;               // breathing room beneath staff

// Height of one system row (no section label — label handled separately)
const SYSTEM_ROW_H = CHORD_AREA_H + STAFF_H + SYSTEM_PAD_BOTTOM;
const SECTION_LABEL_H = 20;                  // height reserved for label row

const PAGE_W = 760;
const MARGIN_H = 36;
const CLEF_W = 46;                           // space for clef glyph + time sig
const USABLE_W = PAGE_W - MARGIN_H * 2 - CLEF_W;

// ─── Parse helpers ────────────────────────────────────────────────────────────

function beatsFromTimeSig(time?: string): number {
  if (!time) return 4;
  const m = time.match(/^(\d+)\s*\/\s*\d+$/);
  return m ? Math.max(1, parseInt(m[1], 10)) : 4;
}

/**
 * Distribute N chords evenly across M beats, assigning each chord to the
 * closest beat: chord[i] → beat floor(i * M / N).
 */
function distributeBeats(chords: string[], beatsPerMeasure: number): ChordEvent[] {
  if (chords.length === 0) return [];
  return chords.map((name, i) => ({
    beat: Math.floor((i * beatsPerMeasure) / chords.length),
    name,
  }));
}

/** Extract measures from a line that contains barline tokens (grid / fakebook format). */
function measuresFromGridLine(tokens: ChartToken[], bpm: number): SlashMeasure[] {
  const measures: SlashMeasure[] = [];
  let chords: string[] = [];
  let repeatStart = false;
  let pendingRepeatEnd = false;

  const flush = (repeatEnd: boolean, doubleBar: boolean) => {
    if (chords.length > 0 || repeatStart || repeatEnd) {
      measures.push({
        chords: distributeBeats(chords, bpm),
        repeatStart,
        repeatEnd,
        doubleBar,
        beatsPerMeasure: bpm,
      });
      chords = [];
      repeatStart = false;
    }
  };

  for (const tok of tokens) {
    if (tok.kind === 'barline') {
      const bl = (tok as BarlineToken).text;
      if (bl === '|:') {
        flush(pendingRepeatEnd, false);
        pendingRepeatEnd = false;
        repeatStart = true;
      } else if (bl === ':|') {
        flush(true, false);
        pendingRepeatEnd = false;
      } else if (bl === '||') {
        flush(pendingRepeatEnd, true);
        pendingRepeatEnd = false;
      } else {
        // plain '|'
        flush(pendingRepeatEnd, false);
        pendingRepeatEnd = false;
      }
    } else if (tok.kind === 'chord') {
      chords.push(tok.text);
    }
  }
  flush(pendingRepeatEnd, false);
  return measures;
}

/** Build SlashMeasures from a whole section, handling both grid and lyric formats. */
function measuresFromSection(section: ChartSection, bpm: number): SlashMeasure[] {
  const result: SlashMeasure[] = [];
  let pending: string[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    // Group accumulated chords into measures of `bpm` chords each
    for (let i = 0; i < pending.length; i += bpm) {
      const slice = pending.slice(i, i + bpm);
      result.push({
        chords: distributeBeats(slice, bpm),
        repeatStart: false,
        repeatEnd: false,
        doubleBar: false,
        beatsPerMeasure: bpm,
      });
    }
    pending = [];
  };

  for (const line of section.lines) {
    const hasBarline = line.tokens.some((t) => t.kind === 'barline');
    if (hasBarline) {
      flushPending();
      result.push(...measuresFromGridLine(line.tokens, bpm));
    } else {
      for (const tok of line.tokens) {
        if (tok.kind === 'chord') pending.push(tok.text);
      }
    }
  }

  flushPending();
  return result;
}

// ─── SVG sub-components ───────────────────────────────────────────────────────

/** Five horizontal staff lines. */
function StaffLines({ x, y, width }: { x: number; y: number; width: number }) {
  return (
    <>
      {Array.from({ length: STAFF_LINES }, (_, i) => (
        <line
          key={i}
          x1={x} y1={y + i * LINE_GAP}
          x2={x + width} y2={y + i * LINE_GAP}
          stroke="#4a4a4a" strokeWidth={0.75}
        />
      ))}
    </>
  );
}

/**
 * Classic slash notehead — a leaning parallelogram, centred on (cx, cy).
 * Matches the Real Book style illustrated in the user screenshots.
 */
function SlashHead({ cx, cy }: { cx: number; cy: number }) {
  const w = 7.5;   // half-width
  const h = 4.5;   // half-height
  const lean = 4;  // horizontal lean (right-up slant)
  const pts = [
    `${cx - w + lean},${cy - h}`,
    `${cx + w + lean},${cy - h}`,
    `${cx + w - lean},${cy + h}`,
    `${cx - w - lean},${cy + h}`,
  ].join(' ');
  return <polygon points={pts} fill="#1a1a1a" />;
}

/** Single, double, repeat-start, or repeat-end barline. */
function Barline({
  x, y, h,
  double: isDouble = false,
  repeatStart = false,
  repeatEnd = false,
}: {
  x: number; y: number; h: number;
  double?: boolean; repeatStart?: boolean; repeatEnd?: boolean;
}) {
  if (repeatStart) {
    return (
      <g>
        <line x1={x} y1={y} x2={x} y2={y + h} stroke="#222" strokeWidth={3.5} />
        <line x1={x + 5} y1={y} x2={x + 5} y2={y + h} stroke="#222" strokeWidth={1} />
        <circle cx={x + 10} cy={y + LINE_GAP * 1.5} r={2.8} fill="#222" />
        <circle cx={x + 10} cy={y + LINE_GAP * 2.5} r={2.8} fill="#222" />
      </g>
    );
  }
  if (repeatEnd) {
    return (
      <g>
        <circle cx={x - 10} cy={y + LINE_GAP * 1.5} r={2.8} fill="#222" />
        <circle cx={x - 10} cy={y + LINE_GAP * 2.5} r={2.8} fill="#222" />
        <line x1={x - 5} y1={y} x2={x - 5} y2={y + h} stroke="#222" strokeWidth={1} />
        <line x1={x} y1={y} x2={x} y2={y + h} stroke="#222" strokeWidth={3.5} />
      </g>
    );
  }
  if (isDouble) {
    return (
      <g>
        <line x1={x - 2} y1={y} x2={x - 2} y2={y + h} stroke="#222" strokeWidth={1} />
        <line x1={x + 2} y1={y} x2={x + 2} y2={y + h} stroke="#222" strokeWidth={1} />
      </g>
    );
  }
  return <line x1={x} y1={y} x2={x} y2={y + h} stroke="#333" strokeWidth={1} />;
}

// ─── System row ───────────────────────────────────────────────────────────────

interface SystemRowProps {
  measures: SlashMeasure[];
  sectionLabel?: string;
  systemY: number;
  measureWidth: number;
  transposeSteps: number;
  timeSig: string;
  showClef: boolean;
}

function SystemRow({
  measures, sectionLabel, systemY, measureWidth,
  transposeSteps, timeSig, showClef,
}: SystemRowProps) {
  const staffX = MARGIN_H + CLEF_W;
  const staffY = systemY + (sectionLabel ? SECTION_LABEL_H : 0) + CHORD_AREA_H;
  const totalStaffW = measureWidth * measures.length;

  // Beat X within a measure: beat 0…n-1 placed at equal subdivisions
  function beatX(mX: number, beat: number, bpm: number): number {
    const pad = 10;
    const available = measureWidth - 2 * pad;
    return mX + pad + (beat / bpm) * available + available / bpm / 2;
  }

  return (
    <g className="sn-system">
      {/* Section label */}
      {sectionLabel && (
        <text
          x={MARGIN_H}
          y={systemY + SECTION_LABEL_H - 4}
          fontSize={11.5}
          fontWeight="bold"
          fontStyle="italic"
          fill="#3a3a3a"
          fontFamily="Georgia, 'Times New Roman', serif"
        >
          {sectionLabel}
        </text>
      )}

      {/* Treble clef */}
      {showClef && (
        <text
          x={MARGIN_H}
          y={staffY + STAFF_H * 0.82}
          fontSize={42}
          fill="#2a2a2a"
          fontFamily="'Noto Serif', Georgia, serif"
          letterSpacing={-1}
        >
          𝄞
        </text>
      )}

      {/* Time signature */}
      {showClef && timeSig && (
        (() => {
          const parts = timeSig.match(/^(\d+)\s*\/\s*(\d+)$/);
          if (!parts) return null;
          return (
            <g fontFamily="Georgia, serif" fontWeight="bold" fill="#2a2a2a" fontSize={13}>
              <text x={MARGIN_H + 34} y={staffY + 12}>{parts[1]}</text>
              <text x={MARGIN_H + 34} y={staffY + 26}>{parts[2]}</text>
            </g>
          );
        })()
      )}

      {/* Staff lines */}
      <StaffLines x={staffX} y={staffY} width={totalStaffW} />

      {/* Left system barline */}
      <line
        x1={staffX} y1={staffY}
        x2={staffX} y2={staffY + STAFF_H}
        stroke="#2a2a2a" strokeWidth={1.5}
      />

      {/* Measures */}
      {measures.map((m, mi) => {
        const mX = staffX + mi * measureWidth;
        const rightX = mX + measureWidth;
        // Middle of staff = 3rd line (index 2, 0-based)
        const midY = staffY + 2 * LINE_GAP;

        return (
          <g key={mi}>
            {/* Repeat-start decoration before this measure */}
            {m.repeatStart && (
              <Barline x={mX} y={staffY} h={STAFF_H} repeatStart />
            )}

            {/* Beat slashes */}
            {Array.from({ length: m.beatsPerMeasure }, (_, beat) => {
              const sx = beatX(mX, beat, m.beatsPerMeasure);
              return <SlashHead key={beat} cx={sx} cy={midY} />;
            })}

            {/* Chord symbols above staff */}
            {m.chords.map((c, ci) => {
              const cx = beatX(mX, c.beat, m.beatsPerMeasure);
              const name = transposeChord(c.name, transposeSteps);
              return (
                <text
                  key={ci}
                  x={cx}
                  y={staffY - 8}
                  fontSize={11.5}
                  fontFamily="Georgia, 'Times New Roman', serif"
                  fontWeight="bold"
                  fill="#0a0a0a"
                  textAnchor="middle"
                >
                  {name}
                </text>
              );
            })}

            {/* Right barline / repeat-end */}
            {m.repeatEnd ? (
              <Barline x={rightX} y={staffY} h={STAFF_H} repeatEnd />
            ) : m.doubleBar ? (
              <Barline x={rightX} y={staffY} h={STAFF_H} double />
            ) : (
              <Barline x={rightX} y={staffY} h={STAFF_H} />
            )}
          </g>
        );
      })}
    </g>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

export interface SlashNotationViewProps {
  document: ChordChartDocument;
  transposeSteps?: number;
  measuresPerRow?: number;
}

export default function SlashNotationView({
  document: doc,
  transposeSteps = 0,
  measuresPerRow = 4,
}: SlashNotationViewProps) {
  const bpm = beatsFromTimeSig(doc.time);
  const timeSig = doc.time ?? `${bpm}/4`;

  // Build normalised sections → measures
  const sections: SlashSection[] = useMemo(() => {
    return doc.sections
      .filter((s) => s.type !== 'tab')
      .map((s) => {
        const label =
          s.label ?? (s.type !== 'unknown' ? s.type : undefined);
        return { label, measures: measuresFromSection(s, bpm) };
      })
      .filter((s) => s.measures.length > 0);
  }, [doc, bpm]);

  // Flatten sections into system rows
  interface SystemDef {
    measures: SlashMeasure[];
    sectionLabel?: string;
  }
  const rows: SystemDef[] = useMemo(() => {
    const result: SystemDef[] = [];
    for (const sec of sections) {
      for (let i = 0; i < sec.measures.length; i += measuresPerRow) {
        result.push({
          measures: sec.measures.slice(i, i + measuresPerRow),
          sectionLabel: i === 0 ? sec.label : undefined,
        });
      }
    }
    return result;
  }, [sections, measuresPerRow]);

  // Compute total SVG height
  let svgH = 16;
  for (const row of rows) {
    svgH += (row.sectionLabel ? SECTION_LABEL_H : 0) + SYSTEM_ROW_H;
  }
  svgH += 16;

  const measureW = USABLE_W / measuresPerRow;

  // Accumulate Y positions per row
  let curY = 16;
  const rowYs: number[] = [];
  for (const row of rows) {
    rowYs.push(curY);
    curY += (row.sectionLabel ? SECTION_LABEL_H : 0) + SYSTEM_ROW_H;
  }

  const displayKey = doc.key
    ? transposeChord(doc.key, transposeSteps)
    : undefined;

  return (
    <div className="sn-view">
      {/* Song header */}
      {(doc.title || doc.artist) && (
        <div className="sn-header">
          {doc.title && <h2 className="sn-title">{doc.title}</h2>}
          {doc.artist && <p className="sn-artist">{doc.artist}</p>}
          <div className="sn-meta">
            {displayKey && <span>Key: {displayKey}</span>}
            {doc.capo && <span>Capo {doc.capo}</span>}
            {doc.tempo && <span>♩= {doc.tempo}</span>}
          </div>
        </div>
      )}

      <svg
        width="100%"
        viewBox={`0 0 ${PAGE_W} ${svgH}`}
        className="sn-svg"
        aria-label="Slash rhythm notation"
        style={{ maxWidth: PAGE_W }}
      >
        {rows.map((row, ri) => (
          <SystemRow
            key={ri}
            measures={row.measures}
            sectionLabel={row.sectionLabel}
            systemY={rowYs[ri]}
            measureWidth={measureW}
            transposeSteps={transposeSteps}
            timeSig={timeSig}
            showClef={ri === 0 || row.sectionLabel !== undefined}
          />
        ))}
      </svg>
    </div>
  );
}

---
name: chordpro
description: ChordPro format reference (.pro, .cho, .chopro, .crd) and how it maps to this app's native CSMPN fake-book format. Use when importing or exporting ChordPro, working with chord/lyric sheets, metadata directives, sections, transposition, or deciding between a lyric chart and a pure fake book chart.
---

# ChordPro — reference, and how it relates to CSMPN

Official spec: https://www.chordpro.org/chordpro/

## Read this first: ChordPro is not fake book

The two formats answer different questions, and this app supports both.

**ChordPro** puts chords *inside* the lyric line. It answers "what do I sing, and
what chord is under this syllable?"

```
A[G]mazing [G7]grace, how [C]sweet the [G]sound
```

**Fake book** (this app's native **CSMPN**) is a bar grid. It answers "what are the
changes?" There are no lyrics threaded through it.

```
- Verse
G | G7 | C | G |
```

So a ChordPro file is **not** a fake book chart, and converting one to the other is
lossy in both directions: ChordPro → fake book drops the lyric/syllable alignment;
fake book → ChordPro has no lyrics to align to. Never describe a ChordPro export as
a fake book chart, or vice versa.

**Pure fake book output** in this repo means CSMPN with lyric lines, `{hybrid}`
rhythm blocks and `{tab}` fingering blocks removed — see `toPureFakeBook` below.

## Where this lives in the repo

| Direction | Function | File |
|---|---|---|
| ChordPro → CSMPN | `importChordPro(text)` | `importPipeline.js` |
| CSMPN → ChordPro | `exportToChordPro(text)` | `index.html` (`#btnExportChordPro`) |
| CSMPN → pure fake book | `toPureFakeBook(text)` | `importPipeline.js` (`#btnExportFakeBook`) |
| Parser (React track) | `parseChordPro` | `src/parsers/chordProParser.ts` |
| Serializer (React track) | `serializeChordPro` | `src/parsers/serializeChordPro.ts` |

Lyrics inside CSMPN are `;`-prefixed lines. `fbSettings.includeLyrics` (default
**false**) hides them at render time without removing them from the source, so a
freshly imported chart reads as a pure fake book chart and the lyrics are one
toggle away. `filterLyricsLines()` in `settings.js` does that filtering.

## File extensions

`.pro` · `.cho` · `.crd` · `.chopro` · `.chord`

## Line types

```
# Comment (ignored by processors)
{directive: value}            # metadata or formatting control
Lyrics with [C]inline [G]chords
                              # blank line = section separator
```

## Chord syntax

```
[C]        Basic major
[Am]       Minor
[Am7]      With extension
[C/B]      With bass note (slash chord)
[F#m]      With accidental
[Bbmaj7]   Flat + extension
[*Coda]    Annotation — asterisk prefix means "not a chord"
[*N.C.]    "No chord" annotation
```

Structure: **Root + Qualifier + Extension + /Bass**

| Component | Examples |
|---|---|
| Root | `C D E F G A B`, with `#` or `b` |
| Qualifier | `m` (minor), `dim`, `aug`, `sus` |
| Extension | `7 maj7 m7 sus4 add9 6 9 11 13` |
| Bass | `/E /G /B` — any note after the slash |

Also supported by the reference implementation: Nashville (`[1] [4] [5] [b7]`) and
Roman (`[I] [IV] [V] [bVII]`).

**Enharmonic spelling in this app:** the family default is **Bb · C# · Eb · F# · Ab**
— never A#/Db/D#/Gb/G#. It lives in `chordTheory.js` (`NOTE_NAMES`). Honour it when
generating or transposing chords so output matches the rest of the app.

## Metadata directives

```
{title: Song Title}            {t: ...}
{subtitle: ...}                {st: ...}
{artist: Artist Name}
{composer: Writer Name}
{lyricist: ...}
{album: ...}
{year: 2024}
{key: G}
{time: 4/4}
{tempo: 120}
{capo: 2}
```

`{meta: title X}` and `{title: X}` are functionally equivalent per the spec; either
parses. Custom fields use an `x_` prefix (`{meta: x_difficulty intermediate}`) —
unknown keys are carried through rather than rejected.

CSMPN's header is the flat `Field: value` form instead — `Title:`, `Composer:`,
`Artist:`, `Style:`, `Tempo:`, `Time:`, `Key:`, `Capo:`, `Tuning:`. Those are the
only recognised header fields (`csmpnParser.js` `metaRE`); anything else falls
through and is parsed as chart content.

## Environment directives (sections)

| Long form | Short | Purpose |
|---|---|---|
| `{start_of_verse}` / `{end_of_verse}` | `{sov}` / `{eov}` | Verse |
| `{start_of_chorus}` / `{end_of_chorus}` | `{soc}` / `{eoc}` | Chorus |
| `{start_of_bridge}` / `{end_of_bridge}` | `{sob}` / `{eob}` | Bridge |
| `{start_of_tab}` / `{end_of_tab}` | `{sot}` / `{eot}` | Tablature |
| `{start_of_grid}` / `{end_of_grid}` | `{sog}` / `{eog}` | Chord grid |
| `{start_of_abc}` / `{end_of_abc}` | — | ABC notation |

With labels:

```
{start_of_verse: Verse 1}
{start_of_verse: label="Verse 2"}
```

Custom sections take any name of letters/digits/underscores (`{start_of_intro}`).

CSMPN section markers are the leading-character form instead: `-` plain, `:` boxed,
`=` boxed, `==` boxed ending. So `{start_of_verse: Verse 1}` → `- Verse 1`.

**`{start_of_grid}` is the closest ChordPro construct to a fake book chart** — it is
the right target when exporting bar-grid content to ChordPro.

## Formatting directives

```
{comment: Instrumental break}     {c: ...}
{comment_italic: Softly}          {ci: ...}
{comment_box: Important}          {cb: ...}
{highlight: Key change!}
{chorus}                          repeat the last chorus
```

## Output control

```
{new_song}     {ns}
{new_page}     {np}
{column_break} {colb}
```

## Chord definitions and diagrams

```
{define: Asus4 base-fret 1 frets x 0 2 2 3 0}
{chord: Asus4}
```

CSMPN's equivalents are `// Name frets[fingers]` diagram definitions and `{tab}`
voicing blocks (strings ordered high-e → low-E).

## Transposition

```
{transpose: +2}
{transpose: -3}
```

In-app transposition goes through `transposeWholeText` in `chordProcessing.js`,
which applies the family enharmonic default.

## Complete example

```
# Amazing Grace - traditional hymn
{title: Amazing Grace}
{artist: Traditional}
{composer: John Newton}
{key: G}
{time: 3/4}
{tempo: 80}

{start_of_verse: Verse 1}
A[G]mazing [G7]grace, how [C]sweet the [G]sound
That [G]saved a [Em]wretch like [D]me
I [G]once was [G7]lost, but [C]now I'm [G]found
Was [G]blind but [D]now I [G]see
{end_of_verse}

{comment: Repeat Verse 1}
```

The same song as a **pure fake book** CSMPN chart:

```
Title: Amazing Grace
Composer: John Newton
Key: G
Time: 3/4
Tempo: 80

- Verse
G | G7 | C | G |
G | Em | D | D |
G | G7 | C | G |
G | D | G | G |
```

## Checklist when producing ChordPro

- `{title: ...}` present; `{artist: ...}` / `{composer: ...}` where known
- `{key: ...}` matches the arrangement
- Every `[chord]` sits immediately **before** its syllable, never after
- Chord spellings use the family default (Bb C# Eb F# Ab)
- Sections wrapped in `{start_of_*}` / `{end_of_*}`
- Annotations that aren't chords use the `[*...]` form
- File ends with a newline

## Checklist when producing a pure fake book chart

- Header uses CSMPN fields only (`Title:`, `Key:`, `Time:`, …)
- Sections use `-` / `:` / `=` markers, not `{start_of_*}`
- Bars delimited by explicit barline tokens; multiple chords in one bar joined with
  `_` (`Bb7_A7`) — a space would split them into separate bars
- No `;` lyric lines, no `{hybrid}`, no `{tab}`
- It parses through `parseCSMPN` with zero warnings

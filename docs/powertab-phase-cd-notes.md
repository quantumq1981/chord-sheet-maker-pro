# Power Tab (.ptb) import — handoff for Phases C–F

Status as of Phase B (merged): the **parser works**. This note carries the
context a fresh session needs to build the render (C+D) without re-deriving
anything. Power Tab support exists because the user has a ~3,055-file `.ptb`
library and Guitar Pro replaced Power Tab — AlphaTab cannot read `.ptb`, so we
parse it ourselves (pure JS, iOS-safe).

## Done (merged)
- **Phase A** (PR #273): `powerTabImporter.js` — MFC `CArchive` reader
  (`PtbReader`: LE ints, `readString`/`readCount`, class tags) + header parse.
- **Phase B** (PR #274): `parsePowerTab(bytes)` — faithful port of TuxGuitar
  `PTInputStream`, full document → model. Validated on the **whole 3,056-file
  corpus: 98.7% parse complete, 4,044,804 notes, ZERO invalid string/fret**.
- **Phase C+D** (this branch): clean measure model + AlphaTex render, wired into
  the existing AlphaTab notation view.
  - Parser now captures the `beaming` byte → `beat.tupletEnters`/`tupletTimes`
    (was read-and-discarded). Plain beats decode to 1:1.
  - `powerTabToMeasures(track)` — position-based barline grouping (a beat joins
    the measure of the greatest barline position ≤ its position). Carries time
    sigs forward; reads repeat-close from the *next* barline in a flattened
    cross-section segment chain. Notes carry sounding `midi`. **Validated: 96.3%
    of reconstructed measures sum exactly to their time signature** (rest are
    genuine irregular/pickup bars). The notes' "position is layout only" caution
    turned out to be over-cautious — barline positions delimit measures cleanly.
  - `powerTabToAlphaTex(model, meta)` + `powerTabToRender(bytes, meta)`. Went with
    **AlphaTex** over MusicXML: confirmed from AlphaTab source that with `\tuning`
    high→low, user string S maps to `tuning[S-1]`, so string 1 = highest =
    identical to the PowerTab model (no string flipping). Emits `\tuning` (octave
    numbering matches our `_ptbMidiToName`), `\capo`, `\ts`, `\ro`/`\rc`,
    chords `(f.s f.s)`, rests `r.d`, dead `x.s`, ties `-.s`, dotted `{d}/{dd}`,
    tuplets `{tu e t}`, and a second voice via `\voice`.
  - **Corpus render check: 3018/3056 files → AlphaTex with no malformed tokens,
    216,948 bars, 1,228 multi-voice files.** The ~38 failures are the known
    all-zero corrupt files (correctly rejected → TuxGuitar fallback message).
  - `importGuitarPro.js`: `window.renderAlphaTex(container, tex, opts)` (shares
    `_buildGpApi` with `renderGpNotation`; calls `api.tex()`).
  - `index.html`: `tryImportPowerTab` now parses natively → sets
    `window._ptbAlphaTex`, dispatches `gpbytesready` to auto-open the Tab View.
    The notation panel renders `_ptbAlphaTex` via `renderAlphaTex` when set,
    else GP bytes via `renderGpNotation`. GP imports clear `_ptbAlphaTex`.
  - Tests: `tests/powerTab.test.mjs` 12 → 19 (model, durations, tex, render).

## The parsed model (`window.PowerTab.parse(bytes)` / `_PTB_TEST_EXPORTS.parsePowerTab`)
```
{ version, info:{title, artist, album, year, author, copyright, ...},
  tracks: [ track1(guitar score), track2(bass score) ],
  bytesConsumed, fileSize, trailerBytes, complete }
track = { infos:[ {number,name,instrument,volume,capo,tuningName,
                   tuning:[midi…high→low], tuningNotes:[…]} ],
          sections:[ section ] }
section = { barLines:[ {position, repeatStart, repeatClose, numerator, denominator} ],
            beats:[ {staff, voice, position, duration, dotted, doubleDotted,
                     notes:[ {string(1=high E), fret, tied, dead} ]} ],
            tempos:[ {position, tempo} ], staffCount, directions, chordTexts, rhythmSlashes }
```
A correct parse leaves only a ~95-byte fixed font/layout trailer after track 2
(`complete === trailerBytes <= 256`). Self-checking — use it.

## Phase C — clean musical model (measures + durations)
Reference: TuxGuitar `PTSongParser.parseTrack/parsePosition/parseBar/parseBeat`.
Key facts (verified):
- **`beat.duration` is the note denominator directly**: 1=whole, 2=half,
  4=quarter, 8=eighth, 16=16th, 32=32nd, 64=64th. Plus `dotted`/`doubleDotted`.
- **Tuplets**: TuxGuitar derives `enters`/`times` from the `beaming` byte that
  Phase B currently reads-and-discards in `_ptbReadPosition`. Capture it:
  `enters = ((beaming - beaming%8)/8)+1; times = (beaming%8)+1` (after the
  `beaming = beaming<128 ? beaming : beaming-128` adjustment). Add to the model.
- **Measures are time-driven, not position-driven**: walk sections in order;
  a barline sets `barLength = numerator * QUARTER_TIME * (4/denominator)` and
  resets bar start; each beat advances a running `start` by its duration-time;
  measure boundaries fall where accumulated time crosses `barLength`. The
  `position` field is layout only — don't use it for bar grouping.
- Note pitch: `openMidi = tuning[string-1]` (model tuning is high→low, matching
  MusicXML string 1 = highest), `noteMidi = openMidi + fret`.

## Phase D — render (the visible payoff)
Target the **existing AlphaTab notation view** (`renderGpNotation` in
`importGuitarPro.js`, panel in `index.html` ~line 7193). AlphaTab can load:
- **MusicXML** — emit a guitar part with `<staff-details><staff-lines>6</…>` +
  `<staff-tuning>` and per-note `<pitch>` + `<notations><technical><string>/<fret>`.
  Bonus: MusicXML also feeds the existing MusicXML→CSMPN chord path.
- **AlphaTex** (`api.tex(str)`) — much simpler/forgiving: `\tuning …` then
  beats `fret.string:dur` separated by spaces, measures by `|`. Recommended to
  try first for a fast visible result.

Wiring: replace the `.ptb` branch (currently `tryImportPowerTab` →
best-effort GP convert → TuxGuitar guidance) so it calls `window.PowerTab.parse`,
builds the render input, and feeds AlphaTab. Keep the graceful "convert with
TuxGuitar" fallback for corrupt/variant files.

## Phase E — editable chart (chords → CSMPN) ✅ DONE (this branch)
PowerTab stores chords as a **ChordName bitfield**, not text. `_ptbReadChordText`
now captures `{position, key(u16), formula(u8), mods(u16)}` into
`section.chordNames` (was discarded). `_ptbDecodeChord(key, formula, mods)` is a
faithful port of Power Tab Editor's `ChordName::GetText/GetFormulaText/GetKeyText`
(BSD) — exact name match (`Am`, `E5/B`, `Cm7b5`, `C7sus4`, `N.C.`). Bitfield:
tonic key = `(key&0xf00)>>8`, variation `(key&0x3000)>>12`; bass key `key&0xf`,
variation `(key&0x30)>>4`; formula low nibble = core quality, `mods` = extension
bits. `powerTabToChart(bytes|doc, {barsPerRow})` groups chord-texts by barline
(same position grouping as beats), dedupes consecutive, and emits a CSMPN
fake-book chart (header + `- Chart` + `|`-rows, `%` for unannotated bars,
`chord1_chord2` for multi-chord bars). **58% of the corpus carries chord texts
(171,986 total).** Wired into `tryImportPowerTab`: parses once, renders notation
*and* loads the chart into `sourceEl` when `chordCount > 0`. `window.PowerTab`
gains `toChart` + `decodeChord`.

## Section labels ✅ DONE (follow-up)
PowerTab stores a **rehearsal sign** on each barline: an ASCII letter (A/B/C…,
`0x7F` = unused) + a description CString ("Intro", "Verse 1", "Chorus"). These
were read-and-discarded; now `_ptbReadRehearsalSign` returns `{letter, desc}`
onto `bar.rehearsal`, `_ptbRehearsalLabel` turns it into a label (desc, else the
letter), and `powerTabToMeasures` attaches `measure.section` (carrying the label
forward over skipped empty barlines). `powerTabToChart` groups bars under `- Label`
headers instead of one flat `- Chart` (which remains the fallback for files with
no rehearsal marks). **82% of chord-bearing files now come in multi-sectioned** —
real labels: Chorus, Intro, Verse, Outro, Interlude, Guitar Solo, Bridge,
Pre-Chorus. No parse regression (still 3,011 complete). `toChart` returns a
`sections` count; the import status shows it. Tests +2 (24→26).

## Phase F — robustness ✅ DONE (this branch)
The ~37 all-zero corrupt files are rejected by the `ptab` magic check (graceful
fallback). The **6 overruns** were a real bug: they desync mid-stream, read far
past EOF, and — because the trailer went *negative* — falsely reported
`complete: true`, so they'd feed garbage to the renderer. Fix: `PtbReader._need(n)`
bounds-checks every `readU8/16/32/Bytes`, so a desync throws
`"Power Tab stream desync: read past end of file"` immediately (no runaway loop
over a bogus item count); `complete` now also requires a non-negative remainder.
**Corpus after fix: 3,011 complete, 6 clean desync rejects, 37 magic rejects, 0
overruns returned, 0 regressions** (the old "3,017 complete" had wrongly counted
the 6 garbage parses). The 6 variant files now fall through to the TuxGuitar
message — investigating each variant's exact layout is deferred (0.2%, and each
looks distinct; not worth the risk to the 98.7% that parse cleanly).

## References & samples
- TuxGuitar reference (raw.githubusercontent is reachable; api.github.com is
  rate-limited from this env): `helge17/tuxguitar` @ `1.6.4`,
  `common/TuxGuitar-ptb/src/org/herac/tuxguitar/io/ptb/` →
  `PTInputStream.java`, `PTSongParser.java`, `base/PTBeat.java`.
- Committed fixture: `tests/fixtures/a-major-shape-arpeggio.ptb` (copyright-safe
  scale exercise). The user's song `.ptb` files are NOT committed — ask them to
  re-upload a few samples (or the `guitartabpowertab.zip`) for dev/validation.
- Tests: `tests/powerTab.test.mjs` (12 tests); add to it for C/D/E.

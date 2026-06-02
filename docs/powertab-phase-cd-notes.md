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

## Phase E — editable chart (chords → CSMPN)
PowerTab stores chords as a **chord-key bitfield** (root + formula), not text:
`_ptbReadChord` reads `chordKey`(u16) + modifications; `_ptbReadChordText` reads
position/key bytes. Decode the chord-key → chord name (like the GP chord
decoder), map sections/bars → CSMPN, populate the editable fake-book chart.

## Phase F — robustness
Corpus: 98.7% clean. The ~38 "errors" are **all-zero corrupt files** in the
collection (correctly rejected — leave as graceful error). **6 overruns** are
real format-variant edge cases to investigate (`bytesConsumed > fileSize`).

## References & samples
- TuxGuitar reference (raw.githubusercontent is reachable; api.github.com is
  rate-limited from this env): `helge17/tuxguitar` @ `1.6.4`,
  `common/TuxGuitar-ptb/src/org/herac/tuxguitar/io/ptb/` →
  `PTInputStream.java`, `PTSongParser.java`, `base/PTBeat.java`.
- Committed fixture: `tests/fixtures/a-major-shape-arpeggio.ptb` (copyright-safe
  scale exercise). The user's song `.ptb` files are NOT committed — ask them to
  re-upload a few samples (or the `guitartabpowertab.zip`) for dev/validation.
- Tests: `tests/powerTab.test.mjs` (12 tests); add to it for C/D/E.

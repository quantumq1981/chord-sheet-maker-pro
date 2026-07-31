# One App — merge progress

Running record of the three-repo merge (Tab-Translator-Pro + chord-sheet-maker →
chord-sheet-maker-pro). Plan: `/root/.claude/plans/i-require-your-expert-cuddly-swan.md`.
Read this first when picking the work back up.

**Branch:** `claude/chord-sheet-maker-integration-7lyvm9` (all three repos)
**Gates, every commit:** `npm run lint · format:check · build · test:all`
**Test count:** 1,189 (703 `npm test` + 486 `test:parsers`) — was 1,068 at merge start.

---

## Status

| Phase | What | State |
|---|---|---|
| 0 | Vendor the recognition engine + parity/ground-truth tests | ✅ merged (PR #349) |
| 1a | Capture / Prepare / Perform shell + `ui.css` | ✅ merged (PR #351) |
| 1a-fix | iPad regressions (float button, breakpoint, overflow) | ✅ committed |
| 1b | Per-stage disclosure + stage-scoped advanced tools | ✅ committed |
| 2 | Recognition merge — GP/PTB/MusicXML through the engine | ✅ committed |
| 3 | Notation (OSMD/AlphaTab/VexFlow) + Stage Mode from chord-sheet-maker | ⬜ next |
| 4 | Audio suite (tuner, stem→chart, DTW sync, vocal isolation) | ⬜ |
| 5 | Consolidate: CSM + TTP become redirects; PWA + IndexedDB | ⬜ |

---

## Phase 0 — Foundation (merged)

- **`recognitionEngine.mjs`** — `Tab-Translator-Pro/engine.tsx` vendored verbatim
  (172,159 bytes, 2,843 lines, sha256 `bac36788…`, 177 exports). It is plain ES with
  no TS or JSX, so it loads as a native ES module with no bundler. **Never edit it in
  this repo** — upstream is the source of truth.
- **`recognitionEngine.provenance.json`** — upstream repo/path/commit
  (`c03a3ecec7eb842c6996d7a50ee47240ea0a1b63`), sha256, byte and line counts.
- **`tests/recognitionEngineParity.test.mjs`** — drift guard, same pattern as the
  existing `chordTheoryParity.test.ts`.
- **`tests/recognitionEngine.test.mjs`** — ground truth re-asserted in this repo
  (Blue Sky verse, Kid Charlemagne bars 27–28 → `C7`, Peg's changes, a `.ptb`) plus the
  CSMPN seam.
- **Live bug fixed while proving the seam:** `parseCSMPN` did not know the `Tuning:`
  header the engine emits, so every handed-off chart grew a spurious leading bar. Fixed
  in `csmpnParser.js` *and* `src/parsers/csmpnParser.ts` (which knew neither `Tuning`
  nor `Capo`).

## Phase 1a — The workflow shell (merged)

Three destinations — **Capture / Prepare / Perform** — around the existing app.

Two rules kept this safe in a 6,900-line `index.html` with no browser tests:

1. **Nothing moves in the DOM.** Stage membership is an attribute (`data-stage-item`)
   on nodes already where they are, so every id, listener and test keeps working. The
   router only toggles visibility.
2. **Stage rules only hide.** Elements are flex, grid, inline-flex and block; forcing
   `display:block` on show would flatten them. The selector hides what does *not*
   belong to the active stage, so the natural display survives.

- **`ui.css`** (new) — the app's token + component layer, seeded from the shipped
  Family 1 desk palette. Adds `--ui-touch: 44px` (iOS HIG floor) and the nav/rail/
  disclosure components. No second palette.
- Bottom tab bar on phone/tablet, left rail ≥1000px.
- The binary User/Power switch became an **Advanced disclosure**; `body.power-mode`
  still gates all 41 `.power-only` elements, so nothing downstream changed.
- **`tests/uiShell.test.mjs`** — contract guards for the parts that can silently break
  (unknown stage name → element vanishes everywhere; nav parsed after the script that
  wires it → zero listeners; stale mode-switch reference → blank page; `ui.css` missing
  from the deploy list → 404 in production only).
- The deploy guard was extended to check `<link rel=stylesheet>`, which it had never
  done — a gap that had already caused one production failure.

### Phase 1a fixes (from iPad photos)

- The floating ⎙ Print button sat on the stage nav and showed in every stage: its
  IntersectionObserver watches the toolbar Print button, which is stage-hidden outside
  Perform, so "not visible" read as "scrolled away". Now a Perform item, offset by the
  nav height + safe-area inset; on the wide layout the nav is a rail so the offset drops.
- The rail breakpoint never fired on iPad. Portrait iPad is 744–1024 CSS px, so 900px
  gave it the phone layout on a desktop-width page. Raised to **1000px**.
- Horizontal overflow: a `.toolbar-group` is one flex item, so without `flex-wrap` a
  five-button group cannot break and pushes the page sideways.

## Phase 1b — Per-stage disclosure (committed)

- **Advanced is remembered per stage** (`csmpn_appMode:<stage>`). Mechanism unchanged;
  `applyStage` re-reads it after setting `data-stage`. A pre-split saved mode falls back
  to the old key, so existing Power Mode users keep it everywhere.
- **The advanced tools row is chrome; each group declares a stage.** Capture gets
  ChordMark → CSMPN and Import Details; Prepare gets CSML/ABC/Tab View; Perform gets the
  exports and Setlist. ~5 buttons in context instead of 11 at once.
- **Pure fake book export moved out of the advanced row** into the everyday exports. The
  row is `.power-only`, so the headline first-stage output was sitting behind a disclosure.
- Each stage gets the heading `ui.css` was already styling.
- The per-stage keys and the active stage joined the backup whitelist.

## Phase 2 — Recognition merge (committed)

Binary files now go through the engine first, with the old paths as fallbacks.

**`recognitionBridge.js`** (new) is the seam. `index.html` and the root modules are
classic scripts and cannot `import` an ES module, so this is the one file that crosses
that line — via a **lazy dynamic import**, because the engine is ~170 KB of binary
parsers that a user who never opens a Guitar Pro file should not pay for on boot.

- `chartTitleFromFilename` — the engine's score shape carries no title, so the filename is it.
- `partHarmonyScore` — events sounding 3+ notes (comping) ×2, plus distinct chord symbols.
  Bass, lead and percussion score ~0 on the first term, which is what keeps them from winning.
- `pickChordPart` — strongest part; ties keep file order.
- `importBinary` — parse part 0 → learn parts → re-parse and choose → simplify if melodic
  → `scoreToCSMPN`. `opts.partIndex` skips the choosing step (that is the picker's path).

**In `index.html`:** `importViaRecognitionEngine()` is called from all three binary
sites (main file input, the dedicated Guitar Pro input, `tryImportPowerTab`). Returning
`false` on any failure means the caller runs what worked before. `powerTabImporter.js`
still runs under it, but only for the AlphaTex the Tab View renders — it never
overwrites the engine's chart. The "Guitar Pro importer not loaded" guard now requires
*both* readers to be absent.

**Part picker** — a "Chart read from" row (Capture) appears after a multi-track import
and re-reads on change. A file often has two parts that legitimately state the changes;
the choice is now visible and reversible rather than silent.

**Deploy guard** — the engine is reached by dynamic import, invisible to a `<script src>`
scan, so it could have been dropped from the copy list and 404'd in production on the
first import. `verify-deploy-assets.mjs` now follows dynamic imports out of the scripts
it already checks. Verified by deleting the engine from `dist/` and watching it fail.
The specifier is written as a literal (the guard can only read a string) and a test pins
it to `ENGINE_URL`.

**Not done in Phase 2:** surfacing `arbitrateChord` as an "alternate reading" chip. It
arbitrates a single chord from a chroma vector, which needs a chord-inspection surface
this app does not have.

---

## Standing decisions

- **Do not merge the two chord recognizers.** Each is pinned by its own validated corpus
  (this repo: Sultans of Swing PDF/GP pair, 1,068 tests; the engine: Blue Sky, Peg,
  Anthropology, Yardbird, Kid Charlemagne). `chordTheory.js` stays the oracle; the
  engine's recogniser is a confidence-gated second opinion via its own `arbitrateChord`,
  surfaced in the UI, never silently overriding.
- **Keep both PDF importers.** They target different PDF species (UG Pro geometry vs
  chordsheet.com PUA glyphs); route by sniff.
- **AlphaTab stays** — for `window.renderGpNotation` (Tab View), not for import.
- **BandMgtPro is removed** by owner decision. Its one contribution, the burnt orange
  `#b8350f`, is a literal in each app.
- **Never edit `recognitionEngine.mjs` here.** Change it upstream in Tab-Translator-Pro,
  re-vendor, update the provenance file.

## Device pass still owed

Everything browser-only needs a real iOS Safari check on iPhone *and* iPad — there is no
substitute and no local console:

- Phase 1a/1b: stage switching, per-stage Advanced persistence, the part picker row,
  the floating print button at each stage, the 1000px rail on iPad landscape.
- Phase 2: a real `.gp`/`.gp5`/`.gpx`/`.ptb` import, the part picker re-read, Tab View
  still opening after a Power Tab import, and print-to-PDF unchanged.

## Next: Phase 3

Vendor from chord-sheet-maker into this repo's existing Vite track (`app.html` + `src/`),
mounted into Prepare's view switcher with the lazy-panel pattern `#gpNotationPanel` uses:

- `src/hooks/useOsmd.ts`, `src/renderers/{AlphaTabRenderer,VexFlowTabRenderer}.tsx`
- `src/converters/{musicXMLtochordpro,transposeMusicXML,musicXMLtoVexFlow}.ts`
- `src/stage/stageMode.ts` + `stageBatch.ts` (pure, already tested) behind Perform's
  stage view; `lyricsView.js` becomes its presenter.

Then resolve the drifted twins — `sniffFormat`, `chordProParser`, `ChordChartModel` exist
in two apps and disagree. Pick one owner each and delete the loser. That is where the
drift actually dies.

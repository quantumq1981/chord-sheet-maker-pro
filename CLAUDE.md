# SESSION START — PRIORITY REFERENCE
> Read this section first every session. Full roadmap: `OPP_ROADMAP.md`

## Project Identity
- **App:** Chord Sheet Maker Pro — music finishing app (not a primary converter)
- **Developer:** iOS 16+ (iPhone/iPad) — no local console. GitHub Actions = the CI console.
- **Branch:** `claude/chord-syntax-converter-P1unR` — all work goes here
- **Optimization persona:** Opp the CoderOptimizer — prioritize clean architecture, performance, correctness

## Sprint 1 — Foundation Hardening ✅ COMPLETE
| # | Task | Status |
|---|------|--------|
| 1.1 | GitHub Actions CI/CD (`.github/workflows/ci.yml`) | ✅ DONE |
| 1.2 | ESLint + Prettier setup | ✅ DONE |
| 1.3 | Parse cache audit | ✅ N/A — already correct |
| 1.4 | Source maps in `vite.config.ts` | ✅ DONE |
| 1.5 | `tsconfig.test.json` covering `src/` + `tests/` | ✅ DONE |

## Sprint 2 — Mobile & Performance ✅ COMPLETE
| # | Task | Status |
|---|------|--------|
| 4.4 | Font loading fix (`preconnect` + `swap`) | ✅ DONE |
| 4.5 | Lazy-load CDN libs (abcjs, VexFlow) | ✅ DONE |
| 4.1 | Responsive breakpoints (`ug-pro-importer.html`, `validate.html`) | ✅ DONE |
| 4.2 | Print stylesheet hardening (slash notation SVG, section orphans) | ✅ DONE |
| 4.3 | iOS Safari SVG export fix (replace html2canvas for slash notation) | ✅ DONE |

## Current State (2026-05-17)
- **484 tests passing** (`npm run test:all`) — 306 npm-test + 371 parser/exporter/utils; Sprint 13 Phase 3+4+5 + all ChordSlashML phases + Sprint 15 + PR #250 bug fixes complete
- `tests/gpCsmpnConverter.test.mjs` — 53 tests for GP→CSMPN pure helpers (flat names, new patterns, slash chords, tuplets, repeats, voltas)
- `tests/musicXmlExport.test.ts` — 8 new repeat/volta tests (51 total); `musicXmlExporter.ts` now emits repeat barlines + ending brackets
- `tests/chordProcessingUtils.test.mjs` — 4 new `parseBarStructures` volta tests
- `tests/abcParser.test.ts` added — 21 new tests for modal key conversion + multi-voice extraction
- **CI now syntax-checks root JS files** (`node --check`) — catches browser SyntaxErrors before GitHub Pages deploy
- **Primary app track: `index.html`** — the developer uses iOS/iPad exclusively; all active feature work goes here
- **`app.html` + `src/`** — React/TypeScript track (secondary); `src/export/` and `src/parsers/` used for unit tests only
- **App.tsx:** 1,145 lines — OSMD renderer, export actions, and utilities extracted to hooks/utils
- **0 type errors**
- **iOS-only usage:** All features must work in Mobile Safari (iPhone/iPad). Primary export path is iOS Safari print-to-PDF.

## Architectural Principles (enforce on every change)
1. `src/ingest/ugProPdfImporter.ts` is the **canonical** PDF importer — `ug-pro-importer.html` (root) is the Vite shell; `public/ug-pro-importer.html` has been deleted
2. **`index.html` is the canonical location for all slash notation + MusicXML export work** — the developer uses iOS/iPad only; never add app features to the React track in parallel. Feature logic lives in `settings.js`, `renderer.js`, or `importPipeline.js` — not inline in `index.html`.
3. All dynamic HTML in `index.html` must pass through `escapeHtml()` — no raw interpolation
4. Tests before features — every new exported function gets a corresponding test
5. iOS Safari is the **primary browser** — always verify `.xml` (not `.musicxml`) download extension and `text/xml` MIME type so iOS opens the file in notation apps
6. Lazy-load heavy CDN libs (abcjs, VexFlow) — they cost ~180 KB+ on initial iOS parse
7. **Before every commit run all four:** `npm run lint` · `npm run format:check` · `npm run build` · `npm run test:all` — GitHub Actions is the only CI console (no local terminal on iOS)

## Quick Reference: Key Files
| File | Purpose |
|------|---------|
| `index.html` | Legacy monolith — fake-book shell, event wiring, slash notation IIFE, self-tests |
| `settings.js` | Fake Book Settings state: `fbSettings`, font maps, `applyFBSettings`, `setStatus`, `filterLyricsLines` |
| `renderer.js` | CSMPN HTML renderer: `renderDoc`, `updatePreview`, VexFlow notation helpers |
| `importPipeline.js` | All format importers: `SongModel`, `extractHeaderFromText`, `importUGText`, `importChordPro`, `importMusicXML`, `importIRealPro`, `importUGProPDF`, etc. |
| `chordSlashMLRenderer.js` | Browser IIFE bundle: ChordSlashML parser + SVG renderer + LilyPond + MusicXML + CSMPN transpiler; exposes `window.csml` |
| `app.html` + `src/` | React app — importers, OSMD notation, chord chart view |
| `ug-pro-importer.html` | Vite HTML shell for the PDF importer page (multi-page build entry) |
| `ug-txt-importer.html` | Standalone dark-UI page: paste UG text → convert to CSMPN → copy/download |
| `src/pages/ugProImporterPage.tsx` | React bootstrap for the importer page — renders `UGProImporterPanel` |
| `src/ingest/ugProPdfImporter.ts` | Canonical PDF importer (TypeScript module; drives the Vite build page) |
| `src/ingest/ugProPdfUtils.ts` | Pure span utilities (no pdfjs-dist): TextSpan, SMuFL constants, `detectTimeSigSpans`, `detectKeySig`, `mergeFragmentSpans` — safe to import in Node.js tests |
| `src/parsers/` | Zero-dependency TypeScript parsers (chordPro, csmpn, abc, gp, musicXml, chordSlashML) |
| `src/renderers/chordSlashMLSvgRenderer.ts` | TypeScript SVG renderer for ChordSlashML (source of truth; browser IIFE mirrors it) |
| `src/converters/chordSlashMLToLilypond.ts` | TypeScript LilyPond exporter for ChordSlashML |
| `src/converters/types.ts` | All public types for the MusicXML→ChordPro converter |
| `src/converters/chordExtractor.ts` | KIND_SUFFIX_MAP + harmony→chord text functions |
| `src/converters/xmlParser.ts` | MusicXML DOM parsing (metadata, measures, lyrics, key, repeats) |
| `src/converters/formatter.ts` | ChordPro rendering (grid, lyrics-inline, repeat unroll, section groups) |
| `src/converters/pipeline.ts` | Orchestrator — `convertMusicXmlToChordPro`, `extractMusicXmlTextFromFile` |
| `src/converters/musicXMLtochordpro.ts` | Barrel re-export (`export * from './pipeline'`) — preserves import paths |
| `src/hooks/useOsmdRenderer.ts` | OSMD renderer state + effects extracted from App.tsx |
| `src/hooks/useExportActions.ts` | All export callbacks + PDF/ChordPro state extracted from App.tsx |
| `src/utils/osmdHelpers.ts` | Pure OSMD/SVG/canvas utilities extracted from App.tsx |
| `src/types/appTypes.ts` | Shared UI types: AppMode, ExportFeedback, ChordProUiState |
| `src/components/ErrorBoundary.tsx` | ImportErrorBoundary + SlashNotationBoundary class components |
| `importGuitarPro.js` | Guitar Pro binary importer (browser module): lazy AlphaTab CDN load, GP→CSMPN with {tab} + {hybrid} blocks |
| `tests/` | Node.js native test runner + tsx loader for TypeScript tests |
| `OPP_ROADMAP.md` | Full 7-phase optimization roadmap with sprint tracker — update it as work completes |

## Sprint 3 — index.html Decomposition (Part 1) ✅ COMPLETE
| # | Task | Status |
|---|------|--------|
| 2.1A | Extract utils.js (debounce, escapeHtml, SongModel, etc.) | ✅ DONE — 6 pure fns, index.html −60 lines |
| 2.1B | Extract chordProcessing.js (~800 lines) | ✅ DONE — 18 fns, index.html −659 lines total |
| — | Fix 2 react-hooks/exhaustive-deps warnings in App.tsx | ✅ DONE |
| 5.1 | Add error-path + edge-case tests for parsers | ✅ DONE — 21 new edge-case tests (51 total) |

## Sprint 4 — React App Optimization ✅ COMPLETE
| # | Task | Status |
|---|------|--------|
| 2.1C | Extract csmpnParser.js from index.html | ✅ DONE — index.html 7,299 lines (−74) |
| 3.1 | App.tsx decomposition → hooks + views | ✅ DONE — 1,145 lines (was 1,598 after merge); `useOsmdRenderer` + `useExportActions` + `osmdHelpers` + `appTypes` extracted |
| 3.3 | React error boundaries (ImportErrorBoundary, SlashNotationBoundary) | ✅ DONE |

## Sprint 8 — Guitar TAB Staff ✅ COMPLETE (tasks 8.1–8.5)
| # | Task | Status |
|---|------|--------|
| 8.1 | `csmpnParser.js`: `parseTabVoicings()` + `{tab}` block parsing (single-line and multi-line) | ✅ DONE — 2026-04-21; emits `{type:'tab', voicings}` blocks |
| 8.2 | `buildSnSections()`: `pendingTabVoicings` state; `{type:'tab'}` forwarded to section objects | ✅ DONE — 2026-04-21 |
| 8.3 | New SVG primitives: `tabStaffLines`, `tabClefLabel`, `tabFretNum`, `tabSlashMark`, `lookupTabVoicing`; TAB layout constants | ✅ DONE — 2026-04-21; TAB_GAP=10px, TAB_STAFF_H=50px, TAB_SEP=14px |
| 8.4 | `renderRow()`: `tabVoicings` param; `barH` extends barlines through TAB staff; TAB staff renders below slash staff | ✅ DONE — 2026-04-21 |
| 8.5 | `renderSlashNotationHtml()`: `rawChords` + `tabVoicings` in row objects; variable row heights | ✅ DONE — 2026-04-21 |
| 8.6 | Capo marker on TAB nut line | ✅ DONE — 2026-04-21; `toRoman()` + `tabCapoMarker()` in IIFE; `Capo` meta field parsed in `csmpnParser.js` (int + Roman numeral); `renderRow` 12th param `capoNum`; `renderSlashNotationHtml` tracks `firstTabRowDone` |
| 8.7 | Chord diagram grids above first system | ✅ DONE — 2026-04-21; `chordDiagramSvg()` renders 6-string fingering boxes (nut/fret-shift, open/muted indicators, finger dots); `allVoicings` Map collects unique voicings; `diagAreaH` computed dynamically; diagrams flow across the top of the SVG |
| 8.8 | MusicXML export extended with TAB frame data | ✅ DONE — 2026-04-21; `buildFrameXml(voicing)` generates `<frame>` elements (6 strings, 4 frets, `<first-fret>` when not at nut); `buildMusicXml()` extracts `rawTokens` per bar and injects `<frame>` inside each `<harmony>` when a voicing is available |

### Sprint 8 TAB Syntax
Add a `{tab}` block directly after (or before) any section's bar content:
```
- Verse
| G | G | C | D |
{tab
  G: 3,2,0,0,0,3
  C: x,3,2,0,1,0
  D: x,x,0,2,3,2
}
```
Strings ordered high-e (string 1, top line) → low-E (string 6, bottom line).
Values: integer fret, `x` (muted), `-` (not played/skip).
Sections without a `{tab}` block render as normal slash notation.

## Sprint 6 — Standalone Pages, Repeat Expansion & Security ✅ COMPLETE
| # | Task | Status |
|---|------|--------|
| 6.1 | `ug-txt-importer.html` — standalone UG text → CSMPN converter page | ✅ DONE — 2026-04-21; dark UI, Convert/Copy/Download, loads `utils.js`/`chordProcessing.js`/`importPipeline.js` |
| 6.2 | D.C./D.S./Coda repeat expansion in `csmpnParser.js` + `src/parsers/csmpnParser.ts` | ✅ DONE — 2026-04-21; `expandCSMPNRepeats` / `expandCsmpnRepeats` + 8 new tests (176 total) |
| 6.3 | `scripts/oemer_helper.py` security hardening | ✅ DONE — 2026-04-21; rate limiting (10 req/min), image count (max 20), file size (max 10 MB), CORS after_request hook, path sanitization |

## Sprint 5 — Converter Decomposition & Unification (In Progress)
| # | Task | Status |
|---|------|--------|
| 5.1 | Split `musicXMLtochordpro.ts` (1,309 lines → 5 modules) | ✅ DONE — `types` · `chordExtractor` · `xmlParser` · `formatter` · `pipeline`; barrel re-export preserves all importers |
| 5.2A | Port HTML v1.2 algorithm improvements to `ugProPdfImporter.ts` | ✅ DONE — PR #145 (2026-04-20) |
| 5.2B | Create Vite build artifact: `ug-pro-importer.html` root shell + `src/pages/ugProImporterPage.tsx` entry | ✅ DONE — 2026-04-20 |
| 5.2C | Update `vite.config.ts` multi-page input; remove `public/ug-pro-importer.html` | ✅ DONE — 2026-04-20 |
| 5.3 | Remaining `index.html` extractions (renderer, importPipeline, settings) — items 2.1D–F | ✅ DONE — 2026-04-20; index.html 7,764 → 4,601 lines (−3,163) |

## ugProPdfImporter.ts v1.3 Changes (2026-04-20, PR #145)
- **`extractPageSpans()`** — viewport-transform matrix multiply (`mul2d`) for accurate span coords on rotated pages; font-size via `Math.hypot` of transformed matrix columns
- **`classifyPageSpans()`** — replaces `isChordCandidate`/`isRehearsalMarker`; adds header exclusion (`headerExclusionRatio=0.13`, top N% of page), `HEADER_KW_PAT` keyword filter, median font-size filter (2.5× cap)
- **`filterDensestSystems()`** — drops span groups with < 50% of densest group's span count (for multi-track PDFs)
- **`longestDarkRun()`** — continuous dark-pixel run check; rejects false barline peaks from dense chord text
- **`computeStemDensity()`** — overall dark-pixel density of band; drives auto preset selection
- **`detectBarlinesInBand()`** — now takes `BarlinePresetConfig` (`stemRunRatio`, `minSpacingPx`, `minHeightRatio`); uses `longestDarkRun` to filter false positives
- **`BARLINE_PRESETS`** — `sparse` (stemRunRatio=0.65, spacing=18px, heightRatio=0.55) and `tab-heavy` (0.80, 28px, 0.65)
- **Stable staff envelope** — `staffLeft = pageW * 0.05`, `staffRight = pageW * 0.95` instead of deriving from span extents
- **Two-pass tab-heavy** — if auto-detected as tab-heavy, expands vertical band from 80 → 280 pts below chord Y and re-runs barline detection
- **`MIN_TOTAL_CHORD_SPANS = 6`** — hard fail-safe; throws clear error for vector-only PDFs
- **Section deduplication** — `seen` Set with `label@measOffset` key prevents duplicate section markers
- **`normalizeChordSymbol`** — adds `M7` → `maj7`, strips internal whitespace (handles PDF-split spans like `"C maj7"`)
- **`barToken`** — returns `'N.C.'` for empty measures when no prior chord is known (vs. `'%'`)
- **`UGProImporterConfig`** — new fields: `headerExclusionRatio: number` (default 0.13), `barlinePreset: 'auto'|'sparse'|'tab-heavy'` (default `'auto'`)
- **`SystemDebug`** — new optional fields: `preset?: string`, `stemDensity?: number`

---

# CSMPN Builder — Slash Notation Feature Guide

**File:** `index.html` (CSMPN Builder, Power Mode only)  
**Engine:** Pure SVG, inline IIFE at end of `<script>` block (~line 7410)  
**Entry point:** `window.updateSlashNotationIfOpen` — called by `updatePreview()` on every source change

---

## Activation

The **𝄞 Slash Notation** button appears in Power Mode only (`class="power-only"`). Clicking it opens a collapsible panel (`#slashNotationPanel`) below the main button row. The panel auto-refreshes whenever the source chart changes or any panel control is adjusted.

---

## How It Works

The engine reads the current CSMPN source from `sourceEl.value` (already transposed by `doTranspose()`), parses it with the global `parseCSMPN()` function, then renders a **Real Book–style SVG** showing slash noteheads on a 5-line staff with chord symbols above.

**Rendering pipeline:**
1. `getSnRenderSettings()` — snapshots `fbSettings` + all panel controls into `_snCfg`
2. `parseCSMPN(text)` — produces `doc` with `blocks`, `key`, `time`, `tempo`, `title`, `composer`
3. `buildSnSections(doc)` — groups bars under section markers, captures nav text
4. `chordsFromToken(bar.token)` — formats chords via `parseChordToken()` (respects all style settings)
5. `renderRow(...)` — generates SVG `<g>` for one staff row
6. Rows are assembled into a single `<svg id="snSvgOutput">` with a background `<rect>`

---

## Panel Controls

| Control | ID | Description |
|---|---|---|
| **Measures / row** | `snMeasuresPerRow` | Global default rows per line (2–8) |
| **Section overrides** | `snSectionOverrides` | Per-section MPR: `Intro:5, Chorus:2` |
| **Strum** | `snStrumArrows` | None / ↓↑ Alternating / ↓↓ All down / Custom… |
| **Custom pattern** | `snStrumPattern` | e.g. `D U D U` — only visible when Strum = Custom |
| **Stems** | `snStems` | Adds quarter-note stems above slash noteheads |
| **P.M.** | `snPalmMute` | Adds `P.M. ------` dashed-line marking above staff |
| **Key sig** | `snKeySig` | Auto (from chart key) or manual override (C through G♭) |
| **↓ SVG** | `btnSnSvg` | Downloads the SVG file |
| **↓ PNG** | `btnSnPng` | Renders to canvas @ 2× and downloads PNG |
| **↓ MusicXML** | `btnSnXml` | Exports MusicXML 4.0 (.xml) with chords + section rehearsal marks |
| **⎙ Print** | `btnSnPrint` | Opens print-ready popup with auto-print |

---

## Feature Reference

### Fake Book Style Sync

All visual settings from the Fake Book Style panel carry through to slash notation automatically. Whenever `applyFBSettings()` runs it clears the chord cache and calls `updateSlashNotationIfOpen()`.

| Setting | Effect on slash notation |
|---|---|
| **Chord Color** | Fill color for all chord symbols above staff |
| **Background Color** | SVG `<rect>` fill; also used in PNG/print background |
| **Foreground Color** | Staff lines, barlines, clef, time sig, section labels, strum arrows |
| **Font Size** (M/S/XS) | Scales SN chord font: M=14px, S≈11.9px, XS≈10.1px (updated for stage readability) |
| **Chord Alignment** | Center = `text-anchor="middle"`, Left = `text-anchor="start"` |
| **Music/Chord Font Pack** | Sets Fake Book chord stack + Slash chord + Slash notation/staff text families together. For non-ASC packs, `--fb-chord-font` is wired to the Body/Chord Font selector so free font choices take effect. |
| **Bar Lines** | Hidden = suppress regular single barlines (repeat/double/final always shown) |
| **Maj7 / Minor / Dim / Half-dim style** | Applied via `parseChordToken()` in `chordsFromToken()` |

---

### Compound Meter (12/8, 9/8, 6/8)

`visualBeats(timeSig)` converts compound meters to the correct number of visual beat groups per bar, following Real Book convention:

| Time Sig | Slashes per Bar |
|---|---|
| 12/8 | 4 (one per dotted quarter) |
| 9/8  | 3 |
| 6/8  | 2 |
| 4/4  | 4 |
| 3/4  | 3 |

This prevents the "solid black bar" artifact caused by 12 packed noteheads merging.

---

### Bar / Simile Repeat (`%`)

When a bar token is `%`, `%%`, or `%N` (CSMPN repeat syntax), the measure renders a **`%` symbol** above the staff instead of repeating the previous chord label. Slash noteheads still appear (time continues). This matches the standard "simile" notation used in Real Books.

---

### Strum Direction Arrows

Rendered below the staff at `staffY + STAFF_H + 12`.

| Mode | Behavior |
|---|---|
| **None** | No arrows |
| **↓↑ Alternating** | Beat 0 = ↓, beat 1 = ↑, alternating |
| **↓↓ All down** | All beats show ↓ |
| **Custom…** | Text field accepts a pattern string |

**Custom pattern syntax:** Uppercase or lowercase characters, spaces ignored.
- `D` = downstroke ↓
- `U` = upstroke ↑
- `X` or `V` = muted strum ×
- `-` = rest (no arrow for that beat)

Example: `D U D U` for a basic 4/4 strum; `D D U U D U` for a common 6-feel pattern. The pattern cycles if shorter than the number of beats.

---

### Angled Slash Chords (ASC/ASL Support)

Slash chords (for example `D/F#`) can render with a diagonal slash when compatible ASC/ASL fonts are installed.

- **In-app selector:** `Fake Book Settings → Music/Chord Font Pack` (Power Mode) routes font stacks to:
  - Fake Book chord rendering (`--fb-chord-font`)
  - Slash chord symbols (`window.__SLASH_FONT_FAMILY`)
  - Slash notation/staff labels (`window.__SN_NOTATION_FONT_FAMILY`)
- **Pack options:** Default, Pori ASC/ASL, Norfolk ASC/ASL, Norfolk Sans ASC/ASL.

- **Default syntax:** Standard `Chord/Bass` (e.g., `Ebm7/F`) enables angled slash features.
- **Legacy syntax:** `?` can be used as the slash separator (e.g., `Ebm7?F#`) and is normalized to `/` at render time.
- **Advanced suffixes (legacy mode):**
  - `z` → flatter slash angle (`ss02`)
  - `` ` `` → small-caps bass rendering (`smcp`)
  - `~` → end-of-chord slash position (`ss03`)
- **Accent compatibility:** trailing `!` / `^` remains reserved for chord accents in Slash Notation.
- **Font requirement:** install licensed fonts on the device/profile for the selected pack. If unavailable, output falls back to system families automatically.

---

### Rhythmic Stems

When **Stems** is checked, a vertical line is drawn above each slash notehead (`cx+5.5, cy-7` to `cy-26`, stroke-width 1.5), giving a quarter-note appearance common in professional guitar rhythm charts.

---

### Palm Muting (P.M.)

When **P.M.** is checked, every staff row renders:
- `P.M.` 10px bold italic text at the top of the chord area (just below the system top)
- A dashed line (`stroke-dasharray="4,2"`, stroke-width 1px) extending across the full row width

This indicates palm muting for the entire chart. For section-specific P.M., mark the section label accordingly in the source and toggle the control manually.

---

### Key Signature

Displayed to the right of the treble clef on every row that shows a clef.

**Auto mode** (default): The key is detected from `doc.key` in the parsed CSMPN header (`t: Title`, `k: Key` fields or first key-like token). Uses `keySigFromKey()` which normalises common formats (`"G major"`, `"F#m"`, `"Bb"`, etc.).

**Manual override**: The dropdown lists all major/relative minor keys from C (0 accidentals) through F# (6♯) and Gb (6♭).

**Staff positions**: Treble clef canonical positions are used:
- Sharps: F C G D A E B (y-offsets `[0, 12, -4, 8, 20, 4, 16]` from staff top)
- Flats:  B E A D G C F (y-offsets `[16, 4, 20, 8, 24, 12, 28]` from staff top)

---

### Accent Marks

Append `!` or `^` to any chord token in the CSMPN source to mark it as accented.

**Example:** `G! Am! F C` → G and Am get a `>` accent symbol above their chord label.

The accent mark is drawn at `staffY - 10 - chordFontSize - 2` (above the chord symbol, auto-adjusting for font size). The chord symbol baseline is at `staffY - 10`. The chord symbol itself renders normally with the `!`/`^` stripped.

---

### Navigation Markers (D.C., D.S., Fine, Coda)

Navigation text is detected and rendered at the **bottom-right of the last measure** in a section, below the closing barline.

**Auto-detection:** The regex `/\b(D\.C\.|D\.S\.|FINE|CODA|AL FINE|AL CODA|DAL SEGNO|DA CAPO|TO CODA|SEGNO)\b/i` matches common navigation markers in section labels. Two cases are handled:

1. **Section label is a nav marker** (e.g., `= D.C. al Fine` with no following bars) — attached to the previous section's last row
2. **Section label contains nav text** with its own bars — nav text is extracted and shown at the last row of that section

**Render position:** `text-anchor="end"` at `x = staffX + totalW`, `y = staffY + STAFF_H + 18`, font-size 12px bold italic.

---

### 1st / 2nd Ending Brackets

Sections whose label matches an ending pattern automatically receive a bracket above their first row. No extra markup needed in the source.

**Detected patterns:**
- `1.` `2.` — period after number
- `[1]` `[2]` — square brackets
- `(1)` `(2)` — round brackets
- `1st` `2nd` — word form

**Rendering:**
- Both endings: left-side drop + top line + number label (`1.` or `2.`)
- **1st ending**: open on right (top line extends 4px past last barline)
- **2nd ending**: closed on right (right-side drop added)

Ending sections suppress the italic section-label text (the bracket serves as the label). The treble clef is shown at the start of each ending section.

---

### Per-Section Measures Per Row

The **Section overrides** field accepts a comma- or semicolon-separated list:

```
Intro:5, Verse:4, Chorus:2, Bridge:3
```

Matching is case-insensitive and partial (so `chorus` matches `Chorus 1`, `Pre-Chorus`, etc.). The default MPR is used for any unmatched section.

---

## Export

| Format | Function | Implementation |
|---|---|---|
| **SVG** | `downloadSvg()` | `XMLSerializer.serializeToString(svg)` → Blob → `<a download>` |
| **PNG** | `downloadPng()` | Canvas 2× scale, SVG data-URL → `canvas.toDataURL('image/png')` (data-URL avoids iOS canvas taint) |
| **MusicXML** | `downloadMusicXml()` → `buildMusicXml()` | MusicXML 4.0 Partwise; `.xml` + `text/xml` MIME type (iOS Safari won't open `.musicxml`) |
| **Print** | `printSlashNotation()` | `window.open` popup with `svg.outerHTML` + `window.print()` on load |

All exports use `_snCfg.bgColor` as the background and `safeFilename(doc.title)` for the file name.

### MusicXML Export Detail (`buildMusicXml()`)

Generates a complete MusicXML 4.0 score from the current CSMPN source:

1. Reads `sourceEl.value` (already transposed), runs `parseCSMPN()` + `buildSnSections()`
2. First measure: `<attributes>` (key sig via `keySigFromKey()`, time sig, treble clef, slash measure-style) + optional tempo `<direction>`
3. **Each section's first measure:** `<rehearsal>` direction — enclosure is `"square"` for `:` and `=` CSMPN markers (boxed rehearsal marks), `"none"` for `-` markers (plain text); `buildSnSections()` stores `markerType` for this purpose
4. Each measure: `<harmony>` elements (one per chord, with root/kind/bass) then slash `<note>` elements (one per visual beat)
5. Navigation labels (D.C., D.S., Fine, Coda) detected via `NAV_RE` — suppressed from rehearsal marks
6. Chord qualities mapped via `chordKind()` — covers all MusicXML 4.0 kinds including half-diminished, augmented-seventh, suspended, major-sixth, and all minor/major-7th extended forms
7. Download as `{title}.xml` with `text/xml;charset=utf-8`

---

## Layout Constants (IIFE top — update here when changing geometry)

| Constant | Value | Notes |
|---|---|---|
| `STAFF_LINES` | 5 | |
| `LINE_GAP` | 8px | Space between staff lines |
| `STAFF_H` | 32px | `(STAFF_LINES-1) * LINE_GAP` |
| `CHORD_AREA_H` | 36px | Space above staff for chord labels |
| `SYSTEM_PAD_BOT` | 36px | Space below staff between systems |
| `SYSTEM_ROW_H` | 104px | `CHORD_AREA_H + STAFF_H + SYSTEM_PAD_BOT` |
| `SECTION_LABEL_H` | 20px | Extra height when a section label is present |
| `PAGE_W` | 760px | |
| `MARGIN_H` | 36px | Left/right margin |
| `CLEF_W` | 46px | Width reserved for treble clef + key sig |
| `USABLE_W` | 642px | `PAGE_W - 2*MARGIN_H - CLEF_W` |

**Slash notehead** (`slashHead`): parallelogram w=9, h=5.5, lean=5, filled with `fgColor`.  
**Stem** (`stemSvg`): x=cx+5.5, y1=cy-7, y2=cy-26, stroke-width=1.5.  
**Staff lines**: stroke-width=1.0px.  
**Chord baseline**: `staffY - 10`.  
**Opening barline**: stroke-width=2.

---

## Architecture Notes

- **`_snCfg`**: Module-level config object, rebuilt on every render by `getSnRenderSettings()`. Never mutated between `getSnRenderSettings()` and end of `renderSlashNotationHtml()`.
- **`ACCENT_FLAG` (`\x01`)**: Internal SOH character prefixed to chord strings that carry an accent mark. Stripped before `escapeHtml()` renders the text.
- **`window.updateSlashNotationIfOpen`**: Hook exposed to the outer `updatePreview()` function. Only re-renders if the panel is open, keeping idle cost zero.
- **DOM references** (`snStrumEl`, `snStrumPatEl`, `snStemsEl`, `snPalmMuteEl`, `snKeySigEl`) are captured once at IIFE execution time and reused across all renders.
- **`debounce()`** (global utility) is used for the section-overrides text field and custom strum pattern field to avoid re-rendering on every keystroke.

---

## What Remains (Planned Features)

| Feature | Notes |
|---|---|
| ~~Guitar TAB staff~~ | ✅ Done — `{tab}` voicing blocks + 6-line SVG staff in slash notation engine (2026-04-21, Sprint 8) |
| ~~Capo marker on TAB nut line~~ | ✅ Done — `tabCapoMarker()` in IIFE; `Capo:` meta field in `csmpnParser.js` (2026-04-21, Sprint 8.6) |
| ~~Chord diagram grids~~ | ✅ Done — `chordDiagramSvg()` renders above first system when `{tab}` blocks present (2026-04-21, Sprint 8.7) |
| ~~MusicXML with TAB frames~~ | ✅ Done — `buildFrameXml()` + `<frame>` injection in `buildMusicXml()` (2026-04-21, Sprint 8.8) |
| ~~Guitar Pro import (.gp/.gp3/.gp4/.gp5/.gpx)~~ | ✅ Done — `importGuitarPro.js` lazy-loads AlphaTab CDN; emits CSMPN + `{tab}` + `{hybrid}` blocks for all three render modes (2026-05-06, Sprint 12, PR #204) |
| Ghost notes / muted noteheads | Needs per-beat token syntax extension in CSMPN parser |
| Hammer-on / Pull-off slurs | Requires note-pair coordinates — needs richer data model |
| VexFlow integration | Full renderer rewrite; deferred pending need |
| ~~Dedicated TXT importer page~~ | ✅ Done — `ug-txt-importer.html` at repo root (2026-04-21, Sprint 6.1) |
| ~~CI/CD pipeline~~ | ✅ Done — `.github/workflows/ci.yml` (Sprint 1) |
| ~~Importer fixture tests~~ | ✅ Done — `tests/sniffFormat.test.ts`, `tests/chordProParser.test.ts`, `tests/csmpnParser.test.ts` (2026-04-09) |
| ~~MusicXML export~~ | ✅ Done — `btnSnXml` + `buildMusicXml()` in `index.html` IIFE (2026-04-16 PRs #135/#136) |
| ~~MusicXML section rehearsal marks~~ | ✅ Done — `buildMusicXml()` per-section loop + `<rehearsal>` directions (2026-04-18 PR #137) |
| ~~MusicXML key mode (major/minor)~~ | ✅ Done — `buildMusicXml()` detects minor keys; emits `<mode>minor</mode>` correctly (2026-04-19 PR #143) |
| ~~MusicXML rehearsal enclosure~~ | ✅ Done — `buildSnSections()` stores `markerType`; `:` / `=` → `enclosure="square"`, `-` → `enclosure="none"` (2026-04-19 PR #143) |
| ~~Fake Book chord font selector~~ | ✅ Done — `applyFBSettings()` wires `--fb-chord-font` to Body/Chord Font for non-ASC packs; free font options now active (2026-04-19 PR #143) |

## SPRINT 4 PROGRESS NOTES

**2026-04-10 (CI stabilization update):**
- Resolved 4 failing CI checks reported on PR #120 (`Lint & Format` + `Type-check & Build` on both push and pull_request).
- Fixed `react-hooks/exhaustive-deps` warnings in `src/App.tsx`.
- Verified locally: `npm run lint`, `npm run format:check`, `npm run build`, and `npm run test:all` all pass.

## SLASH NOTATION RECENT CHANGES (2026-04-16 to 2026-04-19)

**PR #135 — `fix(musicxml): correct chordKind mapping and export extension for iOS`**
- Added `chordKind()` function covering full MusicXML 4.0 quality set (letter-o dim, aug7, maj7 variants, minus-style minor, major-sixth, 7♯5)
- Changed MusicXML download to `.xml` + `text/xml` MIME type — iOS Safari won't open `.musicxml`
- Added `btnSnXml` (↓ MusicXML) export button to the slash notation panel
- Added `buildMusicXml()` and `downloadMusicXml()` functions to the slash notation IIFE

**PR #136 — `fix(musicxml): full kind round-trip + stage-ready slash notation visuals`**
- Extended `harmonyToChord()` with full MusicXML 4.0 → CSMPN reverse quality map (fixes round-trip export)
- Stage-readability visual upgrades: notehead w→9/h→5.5/lean→5, stem top cy-26, staff lines 1.0px, chord font 14px base, `CHORD_AREA_H` 36px

**PR #137 — `feat: MusicXML export with section rehearsal marks`**
- `buildMusicXml()` refactored from flat `allBars[]` loop to per-section iteration
- First measure of each named CSMPN section emits `<direction placement="above"><rehearsal enclosure="none">Label</rehearsal></direction>`
- Navigation labels (D.C., D.S., Fine, Coda) suppressed from rehearsal marks via `NAV_RE`
- `src/export/musicXmlExporter.ts` — standalone TypeScript module (test coverage only; not imported by the app)
- `tests/musicXmlExport.test.ts` — 43 unit tests; total now 168 (4 VexFlow + 164 parser/exporter)

**PR #143 — `fix: MusicXML key mode, rehearsal enclosure, and Fake Book chord font`**
- `buildMusicXml()`: detects minor keys from `doc.key`; emits `<mode>minor</mode>` (was hardcoded `major`) — fixes Gm/Am/Bbm etc. mapping to wrong key in MuseScore/Dorico/Sibelius
- `buildMusicXml()`: chord root regex upgraded to handle both unicode (♭/♯) and ASCII (b/#) accidentals — flat/sharp chords now export correctly
- `buildSnSections()`: stores `markerType` (`-`/`:`/`=`) on each section object
- `buildMusicXml()`: uses `markerType` to set `enclosure="square"` for `:` and `=` sections, `enclosure="none"` for `-` sections
- `applyFBSettings()`: `--fb-chord-font` now wired to Body/Chord Font selector for non-ASC packs; free font options reactivated
- `musicXmlExporter.ts`: added `keyModeStr()` function; `buildFirstMeasureAttributes()` accepts `mode` param
- `tests/musicXmlExport.test.ts`: 4 new minor-key tests + 2 existing tests updated to assert `<mode>major</mode>`

## SPRINT 6 CHANGES (2026-04-21)

**Sprint 6.1 — `ug-txt-importer.html` standalone page**
- New file at repo root: dark-background UI matching the app aesthetic
- Input textarea for raw UG/plain-text chord sheets; Convert button calls `importUGText()`
- Read-only output textarea; Copy (with clipboard API + `execCommand` fallback) and Download `.csmpn` buttons
- Script load order: `utils.js` → `chordProcessing.js` → `csmpnParser.js` → `settings.js` → `importPipeline.js`
- Inline stubs: `let importDiagnostics = null;` and `const fbSettings = { barsPerRow: 4, includeLyrics: true };` before the script tags — makes `importPipeline.js` safe outside `index.html`
- Back link to `index.html`; responsive layout via `max-width: 860px`; status messages styled `.ok`/`.err`

**Sprint 6.2 — CSMPN repeat expansion**
- `csmpnParser.js`: added `expandCSMPNRepeats(text, opts)` + `_expandBarRepeatLine(line)` — plain-JS versions for `index.html` ecosystem
- `src/parsers/csmpnParser.ts`: added exported `expandCsmpnRepeats(text, opts)` + private `expandBarRepeatLine(line)` — TypeScript module versions
- Regex: `\|:\s*((?:[^|]|\|(?!:))*?)\s*:\|(?:\s+x(\d+))?` — preserves inner `|` bar separators; clamps repeat count 1–16; defaults to 2 plays
- `tests/csmpnParser.test.ts`: 8 new tests for `expandCsmpnRepeats`; total now 176 (was 168)

**Sprint 6.3 — `oemer_helper.py` security hardening**
- Rate limiting: in-memory sliding-window bucket per IP, 10 req/min, returns HTTP 429
- Image count: rejects requests with >20 images (HTTP 400)
- File size: rejects individual images >10 MB (HTTP 400) using seek/tell rather than reading into memory
- Path sanitization: `Path(filename).name` strips any directory traversal component
- CORS: `_add_cors()` after_request hook allows only `127.0.0.1`, `localhost`, and `file://` origins

## SPRINT 8 CHANGES (2026-04-21)

**Sprint 8.6 — Capo marker on first TAB row**
- `csmpnParser.js`: added `_parseRoman(str)` helper (Roman numeral → integer, supports `Capo: II` format)
- `csmpnParser.js`: `doc.capo` field + `Capo` in `metaRE`; accepts integer (`Capo: 2`) or Roman numeral (`Capo: II`)
- `index.html` IIFE: `toRoman(n)` converts integer 1–15 to Roman numeral string
- `index.html` IIFE: `tabCapoMarker(capoNum, tabY)` renders `cap.II` italic bold text below T/A/B label in the clef area
- `renderRow()` gains 12th param `capoNum` (integer, 0 = no marker); marker renders inside `if (tabVoicings)` block
- `renderSlashNotationHtml()`: reads `doc.capo`; `firstTabRowDone` flag ensures capo appears exactly once per chart

**Sprint 8.7 — Chord diagram grids above first system**
- New layout constants: `DIAG_STRING_GAP=9`, `DIAG_FRET_GAP=10`, `DIAG_STRINGS=6`, `DIAG_FRETS=4`, `DIAG_W=45`, `DIAG_H=40`, `DIAG_OUTER_W=67`, `DIAG_OUTER_H=86`
- New function `chordDiagramSvg(name, voicing, ox, oy)`: 6-string fingering box with nut/fret-shift detection, ×/○ above-nut indicators, filled finger dots on correct string+fret cells; diagram orientation follows standard guitar convention (low-E left, high-e right)
- `renderSlashNotationHtml()`: builds `allVoicings` Map (first-appearance order across all sections); computes `diagAreaH` dynamically based on chord count and page width; adds diagram band above first row; `svgH` and `curY` adjusted accordingly

**Sprint 8.8 — MusicXML `<frame>` TAB data**
- New function `buildFrameXml(voicing)`: generates MusicXML 4.0 `<frame>` element; muted strings use `<fingering>0</fingering>`; `<first-fret>` emitted when diagram window is above fret 1; skips `-` (not-played) strings entirely
- `buildMusicXml()`: extracts `rawTokens` from each bar token for voicing lookup; calls `lookupTabVoicing(sec.tabVoicings, rawChord)` per chord; injects `${frameXml}` inside `<harmony>` elements when voicing is found

## Sprint 9 — Hybrid Rhythm Guitar Chart v1 ✅ COMPLETE (2026-04-24, PR #154)
| # | Task | Status |
|---|------|--------|
| 9.1 | `importPipeline.js`: `parseHybridChartFromCSMPN()` + beat/duration helpers | ✅ DONE |
| 9.2 | `renderer.js`: `renderHybridDoc()` + `renderHybridBar()` mode-gated render path | ✅ DONE |
| 9.3 | `settings.js` + `index.html`: `hybridRhythmMode` / `hybridPreset` UI + persistence | ✅ DONE |
| 9.4 | Hybrid CSS in `index.html` (layout, print-safe `break-inside` guards) | ✅ DONE |
| 9.5 | `tests/hybridParser.test.mjs` — 4 parser unit tests | ✅ DONE |
| 9.6 | Demo fixtures: `hybrid-pop-strum.csmpn`, `hybrid-muted-funk.csmpn`, `hybrid-guitar-cue.csmpn` | ✅ DONE |
| 9.7 | `docs/hybrid-rhythm-v1-spec.md` — syntax spec document | ✅ DONE |
| 9.8 | `Codex.md` — codex agent session log | ✅ DONE |
| 9.fix | Prettier format fix on `tests/hybridParser.test.mjs` (CI was red) | ✅ DONE |
| 9.r | SVG renderer rework: replace HTML/CSS glyphs with inline SVG (iOS print-to-PDF stable) | ✅ DONE |
| 9.p3 | Phase 3 parser hardening: true overlap detection, doc metadata, warning context, 10 tests | ✅ DONE |
| 9.p4 | Phase 4 renderer hardening: chord at beat 1, empty-bar rest, span-level PM, accent offset | ✅ DONE |
| 9.p6 | Phase 6 print/iOS hardening: safe stroke widths, SVG height attr, hybridModeChip, print CSS | ✅ DONE — 2026-04-25, PR #159 |
| 9.p7 | Phase 7: muted `x` notehead + chord diagram grids above first system | ✅ DONE — 2026-04-25, PR #160 |

## SPRINT 9 CHANGES (2026-04-24)

**Hybrid Rhythm Guitar Chart v1 — `{hybrid ...}` block syntax**

Adds a musician-first beat-positioned rendering mode that sits alongside (not replacing) the existing fake-book/slash-notation paths. Hybrid mode activates only when `Hybrid Rhythm Guitar Mode` is ON **and** the source contains at least one valid `{hybrid ...}` block.

### `importPipeline.js` additions
- `HYBRID_DURATION_MAP` — `{ w:4, h:2, q:1, e:0.5, s:0.25 }` — beat values per duration glyph
- `parseHybridBeatPosition(rawPos, barTime)` — parses `"3"` or `"3&"` into a float beat value; range-checks against time signature numerator
- `countBarsInDocBlock(block)` — counts bars in a parsed CSMPN bar block (uses `parseBarStructures` when available)
- `buildDocSectionMap(text)` — maps sections → bar arrays from the CSMPN parse tree; feeds section ordering to the hybrid parser
- `parseHybridBarLine(raw, barTime, warnings)` — tokenises a `barN:` line into events; handles `pm`/`pm_start`/`pm_end`, canonical `beat:dur(chord)flag` form, and compact mobile shorthand `beatdur(chord)flag`; emits validation warnings for bad beats, unknown durations, overlapping events
- `parseHybridChartFromCSMPN(text)` — top-level entry; returns `{ mode, active, sections[], warnings[] }`; `active=false` when no valid hybrid content survives parsing
- `window.parseHybridChartFromCSMPN` + `window.HYBRID_SYNTAX_SPEC` exposed for `renderer.js`

**Block syntax quick reference:**
```
{hybrid
  sectionCue: / sc:  — section-level cue text
  barN: / bN:        — rhythmic events for bar N
  tabN: / tN:        — tab shape for bar N  (shape @ beat)
  cueN: / cN:        — bar-level cue text
}
```
Event token: `beat:duration(chord)flag` or compact `beatduration(chord)flag`
- Durations: `w h q e s` (slash) · `r rw rh rq re rs` (rest)
- Flags: `!` accent · `~` sustain

### `renderer.js` additions
- `hybridBeatToPercent(beat, timeSig)` — maps a beat float to a 0–100% horizontal position within a bar
- `renderHybridBar(bar)` — returns HTML string for one hybrid bar: stacked chord lane, 3-line staff with beat-positioned glyphs, optional tab lane, P.M. dashed indicator, bar cue; uses `escapeHtml()` throughout
- `renderHybridDoc(sourceText)` — builds full hybrid preview HTML; falls back to `renderDoc()` when `active=false`; integrates with `validationWarnings` and `setStatus()`
- `updatePreview()` — gated branch: `fbSettings.hybridRhythmMode && /\{hybrid\b/i.test(text)` routes to `renderHybridDoc`; otherwise legacy path unchanged

### `settings.js` additions
- `fbSettings.hybridRhythmMode` (default `false`) — master on/off
- `fbSettings.hybridPreset` (default `'default'`) — `'v1'` preset auto-enables hybrid mode and caps `barsPerRow` at 4
- `loadFBSettings()` updated to restore both fields

### `index.html` additions
- CSS classes: `.hybridDoc`, `.hybridSystem`, `.hybridBar`, `.hybridBarRow`, `.hybridCue`, `.hybridChordLane`, `.hybridChord`, `.hybridStaff`, `.hybridEvent`, `.hybridRest`, `.hybridAccent`, `.hybridPmLine`, `.hybridTab`, `.hybridTabEvent`
- Print media: `break-inside: avoid` / `page-break-inside: avoid` on `.hybridSystem` and `.hybridBar`; tighter spacing in `@media print`
- Settings UI: `#setHybridRhythmMode` select + `#setHybridPreset` select in Fake Book Settings panel; `'v1'` preset listener auto-sets `barsPerRow` to 4

### v1 Known Limitations (deferred to future sprints)
- PM spans parsed but rendered as bar-level dashed indicator only (no per-span start/end marks)
- No engraved beaming engine for 16th-note grouping
- Hybrid parser maps `{hybrid}` blocks to sections in source order; non-linear references need future section IDs
- MusicXML export parity for hybrid events deferred

### Sprint 9 Refinement — SVG Renderer Rework (2026-04-24)

**Root cause:** The codex-agent v1 rendered hybrid bars as HTML `<div>` trees with CSS `linear-gradient` staff lines, Unicode music glyphs (`𝅗𝅥╱`, `𝄻`), and percentage-positioned `<span>` elements. This approach fails under iOS Safari print-to-PDF: CSS gradients don't print reliably, Unicode glyph fonts aren't guaranteed, and `position:absolute` percentage layout collapses inside flex containers at print scale.

**Fix:** Complete SVG-based renderer replacing all three old functions:

#### `renderer.js` — SVG atom helpers (new)
- `HR_*` layout constants: `HR_PAGE_W=760`, `HR_MARGIN=20`, `HR_CLEF_W=30`, `HR_BAR_PAD=7`, `HR_CHORD_H=28`, `HR_PM_H=14`, `HR_LG=8` (staff line gap), `HR_STAFF_H=32`, `HR_MID=16`, `HR_STEM_TY=-14`, `HR_TAB_SEP=12`, `HR_TAB_LG=8`, `HR_TAB_H=40`, `HR_SYS_BOT=22`, `HR_SLBL_H=20`, `HR_CUE_H=14`
- `hrL(x1,y1,x2,y2,col,w)` — SVG `<line>` fragment
- `hrHead(cx,cy,dur,col)` — slash notehead parallelogram: filled (q/e/s), hollow outline (h), double-hollow (w); pure SVG `<polygon>`/`<path>` — no Unicode
- `hrStem(cx,cy,col)` — quarter-note stem above notehead
- `hrFlags(cx,cy,dur,col)` — eighth/sixteenth flags as SVG paths (unused when beamed)
- `hrBeam(x1,x2,y,col)` — horizontal beam rectangle for beamed e/s groups
- `hrRest(cx,cy,dur,col)` — SVG-drawn rests (whole=rectangle, half=hat, quarter=zigzag line, eighth=hook); replaces Unicode rest glyphs
- `hrStaff(x,y,w,fg)` — 5 staff lines via `hrL()`
- `hrClef(x,y,fg)` — treble clef as italic `𝄞` text element (readable at all sizes)
- `hrTabStaff(x,y,w,fg)` — 6 TAB staff lines
- `hrTabLabel(x,y,fg)` — stacked `T A B` text
- `hrFret(cx,cy,fret,fg)` — fret number label on TAB staff
- `hrBeatX(beat,timeSig,barLeft,barUsableW)` — exact pixel position for a beat float; replaces CSS `%`

#### `renderer.js` — bar and doc renderer (new)
- `hrBar(bar,barLeft,staffY,barW,fg,cc,bg)` — renders one bar: chord label at beat 0, beamed e/s groups, per-event noteheads + stems + flags + rests, accent `>` marks, PM dashed line, optional TAB lane, bar cue text; all output is SVG string fragments
- `renderHybridDoc(sourceText)` — assembles full inline SVG; groups bars into rows by section; title + composer/key/tempo metadata above first row; section labels before each new section; returns `<div class="hybridSvgWrap"><svg …>…</svg></div>`

#### `importPipeline.js` — chordToken propagation (new)
- `buildDocSectionMap(text)` extracts per-bar chord text by scanning `block.tokens` with `isBarlineToken()`, buffering non-barline tokens per bar slot; stored as `bar.chordToken`
- `parseHybridChartFromCSMPN` spreads `chordToken` when initialising section bar models and restores it after `parseHybridBarLine` replaces a bar's event structure — ensures unannotated (chord-only) bars still display the source chord name

#### `index.html` — CSS cleanup
- Removed ~57 lines of HTML-layout hybrid CSS (`.hybridDoc`, `.hybridSystem`, `.hybridBar`, `.hybridBarRow`, `.hybridCue`, `.hybridChordLane`, `.hybridChord`, `.hybridStaff`, `.hybridEvent`, `.hybridRest`, `.hybridAccent`, `.hybridPmLine`, `.hybridTab`, `.hybridTabEvent`) — all layout now handled by SVG geometry
- Added `.hybridSvgWrap { display:block; overflow:visible; }` + `@media print { break-inside:avoid; page-break-inside:avoid; }`

#### `tests/hybridParser.test.mjs` — extended coverage
- 2 new tests: `chordToken is captured from CSMPN source for unannotated bars` and `chordToken is preserved on bars that have hybrid events`
- `package.json`: added `tests/hybridParser.test.mjs` to the `test` script so all 6 hybrid tests run in `npm run test:all`
- Total tests: 186 (10 `npm test` + 176 `test:parsers`)

### Sprint 9 Phase 3 — Parser Hardening (2026-04-25)

#### `importPipeline.js` improvements
- `buildDocSectionMap(text, _doc)` — accepts pre-parsed doc to avoid redundant `parseCSMPN` call
- `parseHybridBarLine` — true duration-span overlap detection: checks `event.beat < prev.beat + prev.beats` (not just same-beat equality); overlapping events are dropped with a warning; `pm_end` without a matching `pm_start` now emits a warning instead of silently discarding
- `parseHybridChartFromCSMPN` — calls `parseCSMPN` once and passes result to `buildDocSectionMap`; prefixes all `parseHybridBarLine` warnings with `[SectionLabel bar N]` context; return value now includes `title`, `key`, `time`, `tempo`, `composer`, `style` from the parsed doc

#### `renderer.js` improvement
- `renderHybridDoc` — removed redundant second `parseCSMPN` call; metadata now read directly from `hybrid.title/key/time/tempo/composer/style`; fallback path (`!hybrid.active`) still calls `parseCSMPN` for `renderDoc`

#### `tests/hybridParser.test.mjs` — 4 new tests (10 total)
- `drops overlapping events and emits a duration-span overlap warning`
- `warns on pm_end without a matching pm_start`
- `returns doc metadata (title, key, time, composer) in parse result`
- `prefixes validation warnings with section and bar context`
- Mock updated to include `title`, `composer`, `key`, `tempo`, `style` fields
- Total: 190 tests (14 `npm test` + 176 `test:parsers`)

### Sprint 9 Phase 4 — Renderer Hardening (2026-04-25)

#### `renderer.js` — `hrBar()` improvements
- **Chord-only bars**: chord label now at beat-1 X-position (`text-anchor="start"`) instead of centered; consistent with event-based chord placement
- **Empty measures** (no events, no chordToken): renders an SVG whole rest centred in the bar instead of plain quarter slashes
- **Span-level P.M.**: `bar.pm.spans[]` now rendered as individual dashed lines scoped from `xs[span.startIndex]` to `xs[span.endIndex] + duration_width`, with a closing end-tick; previously all PM was forced to bar-width
- **Accent offset**: `>` glyph moved from `staffY - 22` to `staffY - 28` to clear chord symbol cap-height and avoid visual collision

#### `tests/hybridParser.test.mjs` — 2 new tests (12 total)
- `span-level PM spans store startIndex and endIndex into event array` — verifies `pm.spans[0].startIndex/endIndex` and `pm.bar === false`
- `empty bar (no events, no chordToken) is marked active=false for the chart` — confirms graceful fallback
- Total: 192 tests (16 `npm test` + 176 `test:parsers`)

### Sprint 9 Phase 6 — Print & iOS Safari Hardening + UX Integration (2026-04-25, PR #159)

#### `renderer.js` — stroke-width safety
- `hrRest` whole/half hat lines: `0.8` → `1` — prevents hairline loss in iOS PDF
- `hrStaff` 5-line staff: `0.8` → `1`
- `hrTabStaff` 6-line TAB staff: `0.7` → `0.8`
- Bar-level P.M. dash: `stroke-width="0.8"` → `"1"`
- Span-level P.M. dash + end-tick: `0.8` → `1`

#### `renderer.js` — SVG geometry + UX chip
- SVG element gains explicit `height="${svgH}"` attribute — required for correct iOS Safari pre-print layout
- `renderHybridDoc` return now wraps the SVG in `<div class="hybridModeChip">Hybrid Rhythm Guitar v1</div>` + SVG; chip is screen-only

#### `index.html` — CSS
- New `.hybridModeChip` screen style: blue pill badge (`#0044cc`, border-radius 12px, 11px bold sans-serif)
- `@media print` additions: `.hybridSvgWrap svg { width:100% !important; height:auto !important; }` (letter-size scaling) + `.hybridModeChip { display:none !important; }` (suppressed in print/PDF)

### Sprint 9 Phase 7 — Muted Noteheads + Chord Diagram Grids (2026-04-25, PR #160)

Answers "How should I articulate it?" and "Where do I play it?" from the 5 performance questions.

#### `importPipeline.js` — muted `x` flag
- Event token regex tightened: duration group changed from `([A-Za-z]+)` to `(r[whqes]?|[whqes])` — prevents `x` flag from being absorbed into the duration string
- Flags group expanded from `([!~]?)` to `([!~x]*)` — supports multiple combined flags
- `ev.muted` set when flags string includes `'x'`; works in both canonical (`1:q(G)x`) and compact (`1qx`) syntax
- Combined flags work: `1:q(G)!x` = accented muted strum

#### `renderer.js` — muted X notehead
- `hrHead(cx, cy, dur, col, muted)` gains `muted` param; when true renders `×` (two SVG lines crossing at 45°, stroke-width 1.8, round caps) instead of slash parallelogram

#### `renderer.js` — chord diagram grids
- New constants: `HR_DIAG_STRING_GAP=9`, `HR_DIAG_FRET_GAP=10`, `HR_DIAG_W=45`, `HR_DIAG_H=40`, `HR_DIAG_OUTER_W=67`, `HR_DIAG_OUTER_H=86`
- `hrParseVoicing(shapeStr)` — splits comma-separated tab shape into typed voicing array (`number | 'x' | '-'`)
- `hrChordDiagram(name, voicing, ox, oy, fg)` — port of slash notation `chordDiagramSvg()`; nut/fret-shift detection, ×/○ open/muted string indicators, filled finger dots
- `renderHybridDoc()` — collects `allVoicings` Map (chordToken → first tab shape) from all bars; computes `diagAreaH`; offsets `curY`/`hy` by diagram band height; renders grids before title/meta text

#### `tests/hybridParser.test.mjs` — 2 new tests (18 total)
- `muted flag (x) sets muted:true on the event`
- `compact muted token (1qx) is parsed correctly`
- Total: 194 tests (18 `npm test` + 176 `test:parsers`)

## Sprint 10 — PDF Importer Hardening ✅ COMPLETE (2026-04-29, PRs #180, #182, #183)
| # | Task | Status |
|---|------|--------|
| 10.1 | `mergeFragmentSpans()` — reconstruct chord names split across PDF text runs | ✅ DONE — PR #180 |
| 10.2 | Normalizer: `sus2/4`→`sus2`, `7dim`→`7`, `N.C` (no period) direction detection | ✅ DONE — PR #180 |
| 10.3 | SMuFL time-sig backfill into `metadata.time` when header text has none | ✅ DONE — PR #180 |
| 10.4 | `detectKeySig()` — count SMuFL flat/sharp glyphs → major key name | ✅ DONE — PR #182 |
| 10.5 | `metadata.key` backfill from SMuFL key-sig detection | ✅ DONE — PR #182 |
| 10.6 | Repeat barline emission — SMuFL U+E044/E045/E046 → `\|:` / `:\|` in CSMPN | ✅ DONE — PR #182 |
| 10.7 | Extract `ugProPdfUtils.ts` — zero-dep module for pure span utilities | ✅ DONE — PR #183 |
| 10.8 | `tests/ugProPdfUtils.test.ts` — 33 unit tests for `detectTimeSigSpans`, `detectKeySig`, `mergeFragmentSpans` | ✅ DONE — PR #183 |

## SPRINT 10 CHANGES (2026-04-29)

**PR #180 — `feat(importer): merge split chord fragments + fix N.C/sus2-4/7dim edge cases`**
- `mergeFragmentSpans()` — new pre-classification pass; reconstructs chord symbols split across multiple PDF text runs. Greedy left-to-right: merges consecutive same-Y spans when right span does not start with `[A-G]` and combined text passes `CHORD_REGEX` after normalisation. Fixes "I Ain't Got Nothin' But The Blues" PDF where `D9/F`, `Bb7/A`, `Edim7`, `Gm11` were dropped.
- `normalizeChordSymbol`: `sus2/4`→`sus2` (combined sus notation); `(\d)dim`→`\1` strips non-standard dim suffix after digit (`E7dim`→`E7`); `N.C` (without trailing period) added to `DIRECTION_TEXTS`.
- `metadata.time` backfill from first SMuFL `detectTimeSigSpans` result when header text has no time sig.

**PR #182 — `feat(importer): key-sig from SMuFL + repeat barline emission`**
- `detectKeySig(spans, pageW)` — counts SMuFL flat (U+E260) and sharp (U+E262) glyphs in the left 25% of the page; maps count to major key name via `KEY_FROM_SHARPS`/`KEY_FROM_FLATS` tables; returns `KeySigRecord | null`.
- `metadata.key` backfill from SMuFL detection when header text has no key.
- Repeat barlines: `SMUFL_REPEAT_START` (U+E044), `SMUFL_REPEAT_END` (U+E045), `SMUFL_REPEAT_BOTH` (U+E046) detected in text layer → `repeat-start`/`repeat-end` `Marker` objects → `repeatStart`/`repeatEnd` on `MeasureDebug` → `\|: … :\|` emitted in CSMPN on clean line breaks in both fakebook and barlines-style modes.
- `MeasureDebug` and `DebugJson.linear` gain optional `repeatStart?`/`repeatEnd?` fields.

**PR #183 — `feat(importer): extract ugProPdfUtils + SMuFL detector tests`**
- New `src/ingest/ugProPdfUtils.ts` — zero-dependency module exporting `TextSpan`, `TimeSigRecord`, `KeySigRecord`, all `SMUFL_*` constants, `detectTimeSigSpans`, `detectKeySig`, `mergeFragmentSpans`.
- `ugProPdfImporter.ts` now imports from `ugProPdfUtils.js` (no duplication); re-exports for backward compat.
- `tests/ugProPdfUtils.test.ts` — 33 tests: 9 `detectTimeSigSpans` + 12 `detectKeySig` + 12 `mergeFragmentSpans`.
- Total: **264 tests** (18 `npm test` + 246 `test:parsers`)

## Sprint 11 — Parser Quality Hardening ✅ COMPLETE (2026-05-04)
| # | Task | Status |
|---|------|--------|
| 11.1 (T2.7) | Per-page adaptive header exclusion: 0.02 for pages 2+ in `ugProPdfImporter.ts` | ✅ DONE |
| 11.2 (T4.5) | Sparse-page median font-size fallback: use 7pt when `sizes.length < 3` | ✅ DONE |
| 11.3 (T1.2) | Cross-page chord fragment stitching: carry last span across page turns | ✅ DONE |
| 11.4 (T3.3) | GP chord-track selection: density-score all tracks (+2 chord, +1 multi-note) | ✅ DONE |
| 11.5 (T2.3) | ABC modal key → relative major: Dor/Phr/Lyd/Mix/Loc → correct key sig | ✅ DONE |
| 11.6 (T3.5) | ABC multi-voice: `[V:N]` voice-priority extraction (richest chord voice wins) | ✅ DONE |
| 11.7 | `tests/abcParser.test.ts` — 21 new tests; total now 291 | ✅ DONE |

## SPRINT 11 CHANGES (2026-05-04)

**`src/ingest/ugProPdfImporter.ts`**
- **T2.7 Per-page header exclusion**: pages 2+ use `headerRatio=0.02` (vs 0.13 for page 1). Prevents the first chord row from being clipped on continuation pages where there is no title/header area.
- **T4.5 Sparse median guard**: `medianFontSize` falls back to `7` when fewer than 3 `[A-G]`-starting multi-char spans exist (was `12`). Keeps font-size filtering correct on sparse pages.
- **T1.2 Cross-page fragment stitching**: `crossPageCarry` variable threads the last merged span across page turns. If the first span of page N+1 doesn't start with `[A-G]` and combining with the carry produces a valid chord, a synthetic merged span replaces the first span, reconstructing chords split at a physical page boundary.

**`src/parsers/gpParser.ts`**
- **T3.3 Chord-track selection**: new `findChordTrack(tracks)` function replaces the old `tracks.find((t) => !t.isPercussion)` call. Scores every non-percussion track by harmonic content (+2 per explicit `beat.chord.name`, +1 per beat with ≥3 sounding notes) and picks the highest-scoring track. Falls back to the old heuristic if no track scores > 0.

**`src/parsers/abcParser.ts`**
- **T2.3 Modal key → relative major**: `parseAbcKey()` now computes the relative major key for modal ABC keys instead of appending display suffixes like " Dor", " Mix". Adds `ROOT_TO_SEMI`, `SEMI_TO_NOTE`, and `MODE_TO_REL_MAJOR_OFFSET` lookup tables. Examples: `K:DDor → C`, `K:GMix → C`, `K:FLyd → C`, `K:AMix → D`, `K:BbDor → Ab`. Aeolian/Ionian handled as minor/major respectively (unchanged semantics, cleaner code path).
- **T3.5 Multi-voice chord extraction**: new `extractRichestVoice(bodyText)` function. When body contains `[V:N]` inline voice markers, segments the body by voice, scores each by chord count, and returns the richest voice's text. `extractBarChords` calls this before processing, preventing doubled bar counts from interleaved melody+comping voices.

**`tests/abcParser.test.ts`** (new file, 21 tests)
- Modal key tests: D/E/F/G/B Dorian-through-Locrian → correct relative major
- Multi-voice tests: richest-voice selection, single-voice fallback, tie-breaking
- Metadata: title, composer, time signature, M:C/M:C| conversion
- Chord extraction: slash chord `%` → `/`, fingering annotation filtering

Total: **291 tests** (18 `npm test` + 273 `test:parsers`)

## Sprint 12 — Guitar Pro Format Support ✅ COMPLETE (2026-05-06, PR #204)
| # | Task | Status |
|---|------|--------|
| 12.1 | `importGuitarPro.js` — lazy AlphaTab CDN load + GP→CSMPN conversion | ✅ DONE |
| 12.2 | `{tab}` voicing blocks from `beat.chord.strings` fingering frames | ✅ DONE |
| 12.3 | `{hybrid}` blocks with beat-level duration + chord events (all positions) | ✅ DONE |
| 12.4 | `index.html` wiring — button, file input, handler, auto-detect in main importer | ✅ DONE |
| 12.5 | `tests/gpCsmpnConverter.test.mjs` — 42 new pure-function tests via vm.runInContext | ✅ DONE |

## SPRINT 12 CHANGES (2026-05-06)

**`importGuitarPro.js`** (new file, browser module)
- Lazy CDN load: `https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.1/dist/alphaTab.min.js` — 0 cost until first GP file opened. Defensive API probe supports both CDN UMD (`window.alphaTab.Settings` / `window.alphaTab.importer.ScoreLoader`) and variant builds.
- `_findChordTrack(tracks)` — scores all non-percussion tracks (+2 per `beat.chord.name`, +1 per beat with ≥3 sounding notes); identical algorithm to `src/parsers/gpParser.ts` T3.3 update.
- `_extractChord(beat, openMidi)` — explicit annotation → fret-to-chord fallback. Fret-to-chord uses the same `_CHORD_PATTERNS` table as `src/utils/fretToChord.ts`, inlined for browser-global compatibility.
- `_extractVoicing(beat, nStrings)` — reads `beat.chord.strings[]` for fingering frames; negative/null entries → `'x'`; returns `null` when all strings muted.
- `_buildCsmpnFromScore(score, opts)` — emits `Title:/Composer:/Key:/Time:/Tempo:` header + section markers from `masterBar.section.text`, bar lines (`| chord1 | chord2 | … |`), optional `{tab}` voicing block per section (unique chords only, first-seen voicing wins), optional `{hybrid}` block per section with beat-level events at correct beat positions (`1`, `1&`, `2`, …) using `_cumQToHybridPos(cumQ)`.
- `_gpKeyToStr(keySig, keyType)` — maps AlphaTab keySignature (−7…+7) + keySignatureType (0=Major, 1=Minor) to CSMPN key string (Eb, F#m, etc.).
- `window.importGuitarProToCSMPN(bytes, opts)` — public async entry; calls `_loadAlphaTab()` then `_buildCsmpnFromScore()`.
- `_GP_TEST_EXPORTS` object exposes all pure helpers to `vm.runInContext` tests.

**`index.html` changes**
- `<script defer src="importGuitarPro.js">` after VexFlow CDN script
- `<input id="fileInputGuitarPro" type="file" accept=".gp,.gp3,.gp4,.gp5,.gpx" style="display:none">`
- "Import Guitar Pro" button (`power-only`) in the button row after iReal Pro button
- GP extension detection (`['.gp','.gp3','.gp4','.gp5','.gpx'].some(ext => name.endsWith(ext))`) inserted before PDF check in the main `fileInput` change handler — reads `arrayBuffer()`, calls `importGuitarProToCSMPN(buf, {barsPerRow})`, pipes through `parseCSMPN` for diagnostics, sets `sourceEl.value`, calls `updatePreview()`
- Dedicated `fileInputGuitarPro.change` handler mirrors the main handler with explicit error messaging
- General `fileInput` accept extended to include GP extensions

**`tests/gpCsmpnConverter.test.mjs`** (new, 42 tests)
- 8 key-signature mapping tests (major/minor, sharps/flats)
- 5 fret-to-chord recognition tests (E, Am, G major; edge cases)
- 4 duration-to-quarters tests (w/h/q/dotted-q)
- 4 duration-to-letter tests
- 5 hybrid beat-position tests (0→"1", 0.5→"1&", 2.5→"3&", etc.)
- 5 voicing-extraction tests (null guards, negative-fret→x, all-muted→null)
- 11 full CSMPN generation tests (header content, section labels, {tab}, {hybrid}, %, percussion skip, empty score, barsPerRow)

Total: **333 tests** (103 `npm test` + 196 `test:parsers`; +42 vs Sprint 11 baseline)

## Sprint 13 — GP Format Optimization (In Progress)
| # | Task | Status |
|---|------|--------|
| 13.P1 | Tuplet-aware cumQ, repeat barlines, volta brackets + 3 new tests | ✅ DONE — 2026-05-06, PR #211 |
| 13.P2 | Hybrid renderer visual quality (beat-boundary beaming, tuplet brackets, tN flag) | ✅ DONE — 2026-05-06, PR #213 |
| 13.P3 | Chord recognition quality improvements | ✅ DONE — 2026-05-08, PR #215 |
| 13.P4 | Fake book polish (slash notation from GP output) | ✅ DONE — 2026-05-08, PR #216 |
| 13.P5 | Round-trip export (GP→CSMPN→MusicXML) | ✅ DONE — 2026-05-08, PR #219 |

## SPRINT 13 CHANGES (2026-05-06, PR #211)

**Phase 1 — Tuplet cumQ, repeat barlines, volta brackets**

**`importGuitarPro.js`**
- `_gpDurToQuarters(durVal, dots, tupletNum, tupletDen)` — new optional `tupletNum`/`tupletDen` params; applies `× (tupletDen / tupletNum)` factor. Quarter-note triplets (3:2) produce 0.667 beats instead of 1.0; six of them fill exactly one 4/4 bar (cumQ=4.0), eliminating hybrid beat-overflow on shuffle/triplet-feel GP files.
- Beat loop: reads `beat.tupletNumerator`/`beat.tupletDenominator` from AlphaTab model; `> 0` guard safely handles AlphaTab's -1 default (no tuplet) and 0 (invalid).
- `measures.push` — now records `repeatStart: !!(mb && mb.isRepeatStart)`, `repeatEnd: !!(mb && mb.isRepeatEnd)`, `alternateEndings: (mb && mb.alternateEndings) || 0` from each `MasterBar`.
- **Repeat-aware row generation** — replaced simple `barsPerRow` loop with a two-pass grouping strategy: rows break at `repeatStart` boundaries (avoids `:|:` which CSMPN doesn't support) and close after `repeatEnd` bars; left barline `|:` / right barline `:|` emitted accordingly.
- **Volta prefixes** — `alternateEndings` bitmask: bit 0 → `1. ` prefix, bit 1 → `2. ` prefix, placed before chord content token.

**`tests/gpCsmpnConverter.test.mjs`** — 3 new tests (45 total)
- `_buildCsmpnFromScore: emits |: for repeat-start bar and :| for repeat-end bar`
- `_buildCsmpnFromScore: emits 1. and 2. volta prefixes for alternate endings`
- `_buildCsmpnFromScore: six quarter-note triplets fill one bar without beat overflow`

Total: **657 tests** (294 `npm test` + 363 `test:parsers`)

## SPRINT 13 CHANGES — Phase 2 (2026-05-06, PR #213)

**Phase 2 — Tuplet brackets, beat-boundary beaming, tN flag**

**`importGuitarPro.js`**
- Hybrid event tokens carry `tN` suffix (e.g. `t3`) when `beat.tupletNumerator > 1`, passing tuplet group membership through the CSMPN text format to the renderer.

**`importPipeline.js`**
- Flags regex expanded from `([!~x]*)` to `([!~xt0-9]*)` — captures `tN` annotations alongside `!` accent, `~` sustain, `x` muted.
- `ev.tuplet` field added to every parsed hybrid event (0 = no tuplet, N = member of N-tuplet group).
- Overlap check now bypasses same-tuplet consecutive events — prevents valid triplet/quintuplet sub-beat positions from being incorrectly dropped.

**`renderer.js`**
- `HR_TUPLET_H = 14` — extra vertical space allocated per row when any bar has tuplet events; `renderHybridDoc` extends `staffY` and row `h` accordingly.
- `hrTupletBracket(x1, x2, topY, n, col)` — renders `⌐ N ¬` bracket (number + horizontal bar + left/right drops) above each tuplet sub-group at `staffY - 38`.
- Beam grouping is **beat-boundary-aware**: consecutive 8th/16th notes beam within the same integer beat; separate beams for each beat pair (1-1&, 2-2&, etc.). Tuplet 8th/16th notes beam across beat boundaries within their own tuplet group.
- `hrBar` groups consecutive same-tuplet events into sets of N and renders a bracket above each set.

**`tests/hybridParser.test.mjs`** — 2 new tests
- `tN flag on events sets ev.tuplet to the tuplet group size`
- `tN flag combines correctly with accent and muted flags`

**`tests/gpCsmpnConverter.test.mjs`** — 2 new tests
- `_buildCsmpnFromScore: triplet beats emit t3 annotation in hybrid events`
- `_buildCsmpnFromScore: non-tuplet beats do not emit tN annotation`

Total: **657 tests** (294 `npm test` + 363 `test:parsers`)

## SPRINT 13 CHANGES — Phase 3 (2026-05-08, PR #215)

**Phase 3 — Chord recognition quality improvements**

**`importGuitarPro.js`** and **`src/utils/fretToChord.ts`** (synced changes in both files)
- **Flat note names**: `_NOTE_NAMES` / `NOTE_NAMES` updated — index 3: `D#`→`Eb`, index 8: `G#`→`Ab`, index 10: `A#`→`Bb`. Guitar musicians read Bb/Eb/Ab; sharps only for C#/F#/G# which are common in guitar keys.
- **9 new chord patterns** appended to `_CHORD_PATTERNS` / `CHORD_PATTERNS`:
  - `7sus4` [0,5,7,10], `aug7` [0,4,8,10], `7b5` [0,4,6,10]
  - `7#9` [0,3,4,7,10] (Hendrix chord), `7b9` [0,1,4,7,10]
  - `maj9` [0,2,4,7,11], `m9` [0,2,3,7,10], `9sus4` [0,2,5,7,10], `6add9` [0,2,4,7,9]
  - Note: `6add9` not `6/9` — avoids CSMPN slash-chord parse ambiguity
- **Slash chord detection**: `_fretsToChordName` / `fretsToChordName` tracks `lowestMidi`/`lowestPc` while building the pitch-class set. After match: if `lowestPc !== root`, appends `'/' + NOTE_NAMES[lowestPc]` (e.g. `D/F#`, `G/B`). Root = bass → unchanged output.

**`tests/gpCsmpnConverter.test.mjs`** — 8 new tests (53 total in that file)
- Flat names: `Bb`, `Eb`, `Ab` — verify correct enharmonic output
- New patterns: `G7sus4`, `Caug7`
- Slash chords: `D/F#`, `G/B`
- No-slash baseline: `C` (root in bass)

Total: **665 tests** (302 `npm test` + 363 `test:parsers`)

## SPRINT 13 CHANGES — Phase 4 (2026-05-08, PR #216)

**Phase 4 — Fake book polish: slash notation from GP output**

**Root cause:** GP-imported CSMPN uses `bar.endingLabel` (e.g. `'1.'`, `'2.'`) on individual bars for volta endings. The slash notation renderer only checked `endingNumber(sec.label)` (the section-level label) for ending bracket detection — so GP volta endings were never rendered as 1st/2nd ending brackets.

**`index.html`** (slash notation IIFE)
- `processedSections` mapping (line ~4591): adds `endingLabel: bar.endingLabel || null` to each measure object, propagating the per-bar ending info into the render pipeline.
- Row-building loop (~line 4600): replaced simple `i += mpr` chunking with an **ending-group-splitting** pass. For each section, measures are partitioned into consecutive groups on `endingLabel` transitions; each group with `ending !== null` gets a 1st/2nd bracket on its first row. Backward-compatible: the `sec.ending` (section-label) path is unchanged.

**`tests/chordProcessingUtils.test.mjs`** — 4 new tests (`parseBarStructures — volta endingLabel` suite)
- `1. prefix sets endingLabel on the bar and token on the chord`
- `2. prefix sets endingLabel on the bar`
- `volta prefix only affects its own bar, not subsequent bars`
- `volta prefix with repeat barlines preserves leftBar/rightBar`

Total: **669 tests** (306 `npm test` + 363 `test:parsers`)

## SPRINT 13 CHANGES — Phase 5 (2026-05-08, PR #219)

**Phase 5 — Round-trip export: GP→CSMPN→MusicXML repeat barlines and volta brackets**

**`index.html`** (`buildMusicXml()`)
- **Step 5** added to measure loop: `prevBarEndingLabel` state tracker threads volta state across bars
- `<barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>` emitted when `bar.leftBar === 'repeat-start'` (`|:` barlines from GP importer output)
- `<barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>` emitted when `bar.rightBar === 'repeat-end'` (`:|`)
- `<ending number="N" type="start"/>` on the left barline when a new volta label begins; `<ending number="N" type="stop"/>` on the right barline when the volta label group ends — same detection logic as slash notation renderer's ending-group-splitting (Phase 4)
- Combined repeat-end + volta-stop merges `<bar-style>`, `<ending type="stop">`, and `<repeat direction="backward">` into a single `<barline location="right">` element

**`src/export/musicXmlExporter.ts`**
- `Bar` interface extended: `leftBar: string`, `rightBar: string`, `endingLabel: string | null`
- New helpers: `endingNumber()`, `rightBarKind()`, `nextLeftBarKind()`, `ENDING_LABEL_RE`
- `extractBars()` refactored: `pendingLeftBar` tracks the left barline type for the next bar; updated in the main loop (not inside `closeBar`) so the very first `|:` barline correctly sets `leftBar='repeat-start'` on bar 1; lyric tokens matching `ENDING_LABEL_RE` (`1.`, `2.`, `1st`, `2nd`, `[1]`, `[2]`) become `endingLabel`
- `generateMusicXml()`: `prevBarEndingLabel` tracker + step-5 repeat/volta block mirrors `buildMusicXml()` exactly

**`tests/musicXmlExport.test.ts`** — 8 new tests (51 total)
- `|:` emits `<repeat direction="forward"/>` on left barline
- `:|` emits `<repeat direction="backward"/>` on right barline
- Both repeat barlines together in one chart
- Plain `|` separators produce no `<barline>` elements
- `1.` prefix emits `<ending number="1" type="start"/>` and `type="stop"`
- `2.` prefix emits ending-2 brackets
- Full 4-measure repeat+volta round-trip (`|: 1. C | Am :| 2. F | G |`)
- Consecutive same-label bars emit exactly one `type="start"/>` bracket

Total: **677 tests** (306 `npm test` + 371 `test:parsers`)

## Sprint 14 — ChordSlashML Authoring Suite ✅ COMPLETE (2026-05-11)
| # | Task | Status |
|---|------|--------|
| 14.0 | ChordSlashML syntax help panel (collapsible reference, Power Mode) | ✅ DONE — PR #227 |
| 14.UI | Toolbar redesign: two-row layout, import dropdown, `.btn-pill`, `.toolbar-sep` | ✅ DONE — PR #229 |
| 14.A | ChordSlashML Live Editor: two-pane panel, debounced SVG preview, `chordSlashMLRenderer.js` | ✅ DONE — PR #231 |
| 14.B | MusicXML export from Live Editor (`↓ MusicXML`, `text/xml`, iOS-compatible) | ✅ DONE — PR #232 |
| 14.C | `.csml` file import (dropdown + auto-detect) + `↓ Save .csml` export | ✅ DONE — PR #234 |
| 14.D | ChordSlashML → CSMPN transpiler; `← Convert & Load` button transpiles before loading | ✅ DONE — PR #235 |

## SPRINT 14 CHANGES (2026-05-11)

### Sprint 14.0 — ChordSlashML Syntax Help Panel (PR #227)
- `#btnCsmlHelp` (Power Mode) opens collapsible `#csmlHelpPanel` with full syntax reference tables: header fields, beat tokens, barlines, section labels, example, supported chord qualities
- JS IIFE toggle + smooth scroll into view

### Sprint 14.UI — Toolbar Redesign (PR #229)
- Two-row `.toolbar` layout: Row 1 = primary workflow (all users), Row 2 = power tools (`toolbar-row--tools power-only`)
- Import consolidated into `⬇ Import` + `▾` dropdown (`#importMenu`) — all 9 format buttons inside, power-only ones hidden in user mode
- `.btn-pill` grouping for transpose controls; `.toolbar-sep` dividers between groups
- `button.cta` accent class for Print/PDF; `.outline` for Save/Load/Settings
- Import dropdown closes on outside-click, item-click, and scroll (IIFE)
- Title updated to include `v1.10.0` version chip

### Sprint 14.A — ChordSlashML Live Editor (PR #231)

**`chordSlashMLRenderer.js`** (new, ~680 lines — browser IIFE)
- Translates `src/parsers/chordSlashMLParser.ts` → `csmlParse(text)` → `CSMLDocument`
- Translates `src/renderers/chordSlashMLSvgRenderer.ts` → `csmlToSvg(text, opts)` / `csmlToSvgDoc(doc, opts)`
- Translates `src/converters/chordSlashMLToLilypond.ts` → `csmlToLilypond(text)`
- Exposes `window.csml = { parse, toSvg, toSvgDoc, toLilypond, warnings }` — `warnings` updated after every `toSvg()` call from `doc.warnings`

**`index.html`** — new panel and script tag
- `<script defer src="chordSlashMLRenderer.js">` in `<head>`
- `.csmlEditorPanel` CSS: two-column grid (textarea + preview), monospace editor, warning strip, action buttons; responsive stack on mobile < 700 px
- `#btnCsmlEditor` in power-tools row; toggles panel open/closed
- Panel pre-seeded with a starter example; renders immediately on open
- Controls: Rows/line select (2–6), Stems checkbox
- 300 ms debounced re-render on every keypress via `debounce()` (global util)
- Parse warnings displayed below the textarea
- Export: `↓ SVG` (SVG Blob download), `↓ LilyPond (.ly)` (text/plain)
- `↓ Save .csml` (text/plain, `.csml` extension — added in 14.C)
- `← Convert & Load` transpiles to CSMPN then loads (updated in 14.D)

### Sprint 14.B — MusicXML Export from Live Editor (PR #232)

**`chordSlashMLRenderer.js`** additions
- `csmlChordKind(quality)` — MusicXML 4.0 chord kind mapping (mirrors `chordKind()` in CSMPN engine)
- `csmlKeySigFifths(keyStr)` — maps key string to MusicXML `<fifths>` (includes minor → relative major lookup)
- `csmlKeyMode(keyStr)` — `'major'` | `'minor'` detection
- `csmlBeatsPerMeasure(timeSig)` — compound meter support (12/8→4, 9/8→3, 6/8→2)
- `csmlBeatChordText(beat)` — extracts first chord text from any beat kind
- `csmlHarmonyXml(chordText, offset, bpm)` — full `<harmony>` element with root, alter, kind, bass
- `csmlToMusicXmlDoc(doc)` — complete MusicXML 4.0 Partwise generator: attributes, tempo, section rehearsal marks (`enclosure="square"`), harmonies per chord-change, slash noteheads, repeat barlines
- `csmlToMusicXml(text)` — parse + export entry point; exposed as `window.csml.toMusicXml` / `window.csml.toMusicXmlDoc`

**`index.html`** — `↓ MusicXML` button + download handler (`.xml` + `text/xml` MIME, iOS-compatible)

### Sprint 14.C — `.csml` File Import & Save (PR #234)

**`index.html`** changes
- `"ChordSlashML (.csml)"` entry added to Import dropdown (power-only, after Guitar Pro)
- `<input id="fileInputCsml" type="file" accept=".csml,.csm,text/plain">` hidden input
- `.csml` / `.csm` added to main `fileInput` accept list
- Auto-detect in main `fileInput` change handler: `.csml`/`.csm` files bypass CSMPN pipeline, open directly in Live Editor panel
- `window._openCsmlEditor(text, filename)` shared helper (IIFE-scoped, exposed on window) used by both handlers
- `↓ Save .csml` button downloads current editor content as `{title}.csml` (`text/plain`, UTF-8)

### Sprint 14.D — ChordSlashML → CSMPN Transpiler (PR #235)

**`chordSlashMLRenderer.js`** additions
- `csmlFirstChordOfBeat(beat)` — extracts first chord from any beat kind (chord / compound / tuplet)
- `csmlMeasureToBarToken(meas)` — derives CSMPN bar token: single chord, `chord1_chord2` split, or `%` (all-continuation / rest)
- `csmlToCsmpnDoc(doc)` — full transpiler: CSMPN header lines, `- Section` markers, bar tokens grouped into plain runs or `|: … :|` repeat groups, final barlines respected
- `csmlToCsmpn(text)` — entry point; exposed as `window.csml.toCsmpn` / `window.csml.toCsmpnDoc`

**`index.html`** — `← Convert & Load` button now calls `window.csml.toCsmpn(text)` before setting `sourceEl.value`, so fake-book / slash notation / hybrid mode all render the converted chart correctly. Button label and tooltip updated.

### `window.csml` API Summary (after Sprint 15)
| Method | Description |
|--------|-------------|
| `csml.parse(text)` | Parse ChordSlashML → `CSMLDocument` |
| `csml.toSvg(text, opts)` | Render → SVG string; stores warnings in `csml.warnings` |
| `csml.toSvgDoc(text)` | Parse only, returns `CSMLDocument` (for title/metadata) |
| `csml.toLilypond(text)` | Export → LilyPond `.ly` string |
| `csml.toMusicXml(text)` | Export → MusicXML 4.0 string (`.xml`, `text/xml`) |
| `csml.toMusicXmlDoc(doc)` | Same but accepts pre-parsed doc |
| `csml.toCsmpn(text)` | Transpile ChordSlashML → CSMPN string |
| `csml.toCsmpnDoc(doc)` | Same but accepts pre-parsed doc |
| `csml.toHybridText(text)` | Transpile ChordSlashML → CSMPN + `{hybrid}` blocks (beat-exact positions) |
| `csml.toHybridTextDoc(doc)` | Same but accepts pre-parsed doc |
| `csml.warnings` | Last parse warning array (updated by `toSvg`) |

## Sprint 15 — CSML Authoring Completion ✅ COMPLETE (2026-05-17)
| # | Task | Status |
|---|------|--------|
| 15.1 | `csmpnToCsml()` reverse transpiler — CSMPN → ChordSlashML (beat-slotted measures, repeat barlines, section labels) | ✅ DONE — PR #241 |
| 15.2 | `⬆ From Source` button — loads current CSMPN chart into CSML editor in one click | ✅ DONE — PR #241 |
| 15.3 | `★ CSML Quick Start` guide panel — 5 progressive steps with "Try this →" buttons that load examples into the live editor | ✅ DONE — PR #241 |
| 15.4 | `⎙ Print` button in CSML editor — popup + `window.print()` for iOS print-to-PDF | ✅ DONE — PR #243 |
| 15.5 | `csmlToHybridText()` — CSML → CSMPN + `{hybrid}` blocks preserving beat positions; `← Convert & Load` auto-routes when Hybrid mode ON | ✅ DONE — PR #245 |

## Post-Sprint 15 Bug Fixes (2026-05-17, PR #247 + PR #250)

**PR #247 — `fix(csml): live preview never renders + dangerous load fallback + UX clarity`**
- `chordSlashMLRenderer.js`: dispatches `csmlready` custom event after `window.csml` is set — editor IIFE listens and retriggers `renderPreview()` when panel is open (race-condition fix for `defer` timing)
- `index.html`: `← Load into Chart` fallback removed — now shows error status if `window.csml` not ready; prevents raw ChordSlashML being loaded into CSMPN source
- Workflow hint bar added above action buttons; button renamed `← Load into Chart`

**PR #250 — `fix: split multi-chord bar tokens + CSML preview always renders`**
- `renderer.js` `hrBar()`: splits `bar.chordToken` on `_` and distributes each chord at evenly-spaced beat positions — `Bb_Bb7` now renders `Bb` at beat 1 and `Bb7` at beat 3 instead of the literal string; fix in both no-events path and `anyEvChord` fallback
- `index.html`: moved `chordSlashMLRenderer.js` from `<head defer>` to end of `<body>` — guarantees synchronous execution after all other scripts; added 250ms auto-retry loop (up to 20 attempts / 5 seconds) in `renderPreview()` for iOS Safari edge cases

## SPRINT 15 CHANGES (2026-05-17)

### PR #241 — CSMPN→ChordSlashML reverse transpiler + Quick Start guide

**`index.html`** additions:
- `csmpnToCsml(csmpnText)` global function: reads `parseCSMPN()` + `parseBarStructures()`, emits ChordSlashML with header fields, `[Section]` labels, beat-slotted measures (`C _ _ _`, `Am _ G _`), `|: :|` repeat groups, `%`/`N.C.` handling, bpr-aware row grouping
- `⬆ From Source` button in CSML editor: calls `csmpnToCsml(sourceEl.value)` → populates editor → triggers live preview
- `★ CSML Quick Start` guide panel: 5 numbered steps from bare header to full Autumn Leaves chart; each step has a "Try this →" button calling `window._openCsmlEditor(example, 'guide-example.csml')`
- CSS: `.csmlGuidePanel`, `.guide-hdr`, `.guide-steps`, `.guide-step`, `.step-num` (blue circle 26×26px), `.step-body`, `.step-example` (monospace pre), `.try-it-btn` (outlined accent button)

### PR #243 — Print button for CSML editor

**`index.html`** — `⎙ Print` button + handler:
- Uses `lastSvg` from the IIFE closure (already rendered SVG)
- `window.open()` popup with the SVG + `window.print()` on load
- Chart title from `csml.parse(text).title` used as popup window title
- Graceful error for pop-up blocked + empty-preview states

### PR #245 — CSML → Hybrid direct-render

**`chordSlashMLRenderer.js`** additions:
- `_SPAN_DUR` map: `{1:'q', 2:'h', 4:'w'}` — slot span → duration letter
- `csmlMeasureToHybridEvents(meas)` — converts `meas.beats[]` to hybrid event strings: each chord beat gets `beatNum:dur(chord)` based on how many `slash` beats follow it; all-empty measures → `['1:rq']`
- `csmlToHybridTextDoc(doc)` — emits CSMPN bar lines (same repeat-group logic as `csmlToCsmpnDoc`) followed by a `{hybrid}…}` block per section; bar numbers are 1-based and match the section's measure count
- `csmlToHybridText(text)` — parse + export entry point; exposed as `window.csml.toHybridText` / `window.csml.toHybridTextDoc`

**`index.html`** — `← Convert & Load` handler updated:
- Detects `fbSettings.hybridRhythmMode && window.csml.toHybridText`
- When hybrid mode ON: calls `toHybridText()` → CSMPN with beat-positioned `{hybrid}` blocks
- When hybrid mode OFF: existing `toCsmpn()` path unchanged
- Status message distinguishes the two paths

## Sprint 16 — Slash / Hybrid Engine Unification (In Progress)

**Goal:** collapse the two overlapping SVG slash renderers — the slash-notation panel
engine (`index.html` IIFE) and the hybrid rhythm engine (`renderer.js`) — into a
single engine where **plain even slashes are the zero-rhythm case of the hybrid model**.

| # | Task | Status |
|---|------|--------|
| 16.1 | Unified render routing: plain charts render through the hybrid SVG engine | ✅ DONE |
| 16.2 | Port slash-panel-only features into the unified engine | 🚧 IN PROGRESS |
| 16.2a | `visualBeats` compound-meter slash count (6/8→2, 9/8→3, 12/8→4) | ✅ DONE |
| 16.2b | Treble clef + key signature on the unified staff | ✅ DONE |
| 16.2c | Nav markers (D.C./D.S./Fine/Coda) + capo on the unified staff | ✅ DONE |
| 16.2c-2 | Ending brackets + bar-model refactor (`endingLabel`/`leftBar`/`rightBar`) | ✅ DONE |
| 16.2c-3 | Strum arrows (Fake Book Settings UI config) | ✅ DONE |
| 16.2d | MusicXML export from the unified engine (generic slash) | ✅ DONE |
| 16.2d-2 | MusicXML export of hybrid rhythm durations | ✅ DONE |
| 16.3a | SVG download parity on the main toolbar (export gap before retiring panel) | ✅ DONE |
| 16.3b | Reimplement `renderCsmpnToSvg` on the unified engine + delete the slash-panel IIFE | ✅ DONE |

### Hybrid Scaffolder (previously undocumented — added ~PR #215)
- `importPipeline.js` → `toHybridCSMPN(text, preset)` + `HYBRID_PRESET_PATTERNS`
  (7 presets: `quarter`, `eighth`, `swing`, `funk-16`, `bossa`, `waltz`, `slow-blues`;
  each maps `4/4 3/4 2/4 12/8 6/8 9/8` → an event pattern string).
- Wired in `index.html`: `#setHybridScaffoldPreset` selector + `#btnToHybrid`
  ("→ Scaffold Hybrid Blocks") — injects a `{hybrid}` block per section using the
  chosen preset, then auto-enables rhythm mode.
- Tested by `tests/hybridScaffolder.test.mjs` (uses `parseCSMPN`/`buildDocSectionMap`
  for exact bar counts; never double-inserts when a `{hybrid}` block already exists).

### SPRINT 16 CHANGES — Phase 1 (Unified render routing)

**Root cause of "hybrid does nothing":** `renderHybridDoc()` bailed to the fake-book
HTML renderer whenever `parseHybridChartFromCSMPN().active` was false (i.e. no
`{hybrid}` blocks), and `updatePreview()` only routed to it when the source already
contained `{hybrid}`. So toggling **Hybrid Rhythm Guitar Mode** on a plain chart did
nothing visible, and the scaffolder's default `quarter` preset produced output
indistinguishable from the older slash-notation panel.

**Key insight:** `parseHybridChartFromCSMPN()` *already* builds a full section model
(bars carry `chordToken`, with empty `events[]`) for plain charts, and `hrBar()`
*already* renders an empty-events bar as even slash noteheads. The engine was already
a superset — only the routing prevented it from rendering plain charts.

**`renderer.js`**
- `renderHybridDoc()` — fallback condition changed from `!hybrid.active` to
  `!hybrid.sections.length`. Plain charts now render through the SVG slash/rhythm
  engine (even slashes per beat + chord labels); fake-book fallback only fires when
  there is no chart content at all.
- `updatePreview()` — routing gate relaxed from
  `fbSettings.hybridRhythmMode && /\{hybrid\b/i.test(text)` to just
  `fbSettings.hybridRhythmMode`. Rhythm mode now renders every chart through one
  engine; `{hybrid}` blocks add notated rhythm on top of the slash baseline.

**`index.html`** — rhythm-mode hint updated to reflect that the chart renders
immediately (scaffolding/`bN:` editing now *adds* rhythm rather than being required).

**`tests/hybridRenderer.test.mjs`** (new, 4 tests; added to `npm test`)
- plain chart (no `{hybrid}`) renders `<svg>` + slash noteheads + chord labels
- `{hybrid}` chart still renders notated rhythm through the same engine
- empty source falls back to the fake-book renderer (no `<svg>`)
- simple (space-separated) chart produces exactly one `<svg>` document

Known follow-up (16.2): `hrBar()`'s no-events path draws one slash per time-sig
numerator beat; compound meters (6/8, 9/8, 12/8) need the slash-panel's `visualBeats()`
grouping ported over to avoid over-dense bars.

### SPRINT 16 CHANGES — Phase 2a (Compound-meter slash count)

**`renderer.js`**
- New `hrVisualBeats(timeSig)` helper — mirrors `visualBeats()` in the slash-notation
  panel: compound meters collapse to dotted-quarter pulses (6/8→2, 9/8→3, 12/8→4);
  simple meters use the numerator. Prevents the "solid black bar" artifact where a
  12/8 bar rendered 12 packed slash noteheads.
- `hrBar()` no-events (zero-rhythm) path now draws `hrVisualBeats(timeSig)` slashes,
  evenly spaced across the bar (`ul + ((b-1)/vb) * uw`), instead of one per numerator
  beat. Multi-chord token labels are positioned by even fraction (`pi/parts.length`),
  unchanged in effect for simple meters.

**`tests/hybridRenderer.test.mjs`** — 4 new tests (8 total)
- 4/4 → 4 slashes (regression), 12/8 → 4 (not 12), 6/8 → 2, 9/8 → 3, 3/4 → 3

### SPRINT 16 CHANGES — Phase 2b (Treble clef + key signature)

**`renderer.js`**
- `HR_CLEF_W` 30 → 48 — reserves room for clef glyph + key-signature accidentals
  (staffX/staffW recompute from it automatically).
- `hrClef()` rewritten: crude two-line mark → real treble-clef glyph (U+1D11E) in a
  single-quoted `font-family='Noto Serif, …'` attribute, matching the slash-notation
  panel for visual parity.
- New key-signature port from the slash panel (identical staff geometry, so offsets
  transfer directly): `HR_KEY_SIG_DATA`, `HR_SHARP_Y` `[0,12,-4,8,20,4,16]`,
  `HR_FLAT_Y` `[16,4,20,8,24,12,28]`, `hrKeySigFromKey(keyStr)` (handles ♭/♯, worded
  major/minor, minor keys), `hrKeySig(staffY, count, col)` (draws ♯/♭ accidentals
  right of the clef).
- `renderHybridDoc()`: computes `keySigCount = hrKeySigFromKey(key)` once; draws the
  clef **and** key signature on each section's first row (where the clef already showed).

**`tests/hybridRenderer.test.mjs`** — 6 new tests (14 total)
- treble clef glyph present; G→1♯, D→2♯, F→1♭, Eb→3♭, C/none→0; Em & "G major"
  normalize to 1♯; key sig appears once per section first row (not every row).

### SPRINT 16 CHANGES — Phase 2c (Nav markers + capo)

**`renderer.js`**
- Ported nav helpers: `HR_NAV_RE`, `hrExtractNavText(label)`, `hrFormatNavText(text)`
  (substitutes Segno/Coda/D.S. words → Unicode musical symbols 𝄋 𝄌 before escaping).
- `hrToRoman(n)` + `hrCapoMarker(capoNum, tabY, col)` — capo indicator below the
  T/A/B label on the first TAB row.
- `renderHybridDoc()`: systems gain a `lastRow` flag; nav text (from
  `hrExtractNavText(sec.label) || sec.navText`) renders bottom-right of each section's
  last row; capo (from `hybrid.capo`) renders once on the first row that has a tab lane.

**`importPipeline.js`**
- `buildDocSectionMap()`: standalone navigation markers (a `- D.C. al Fine` line with
  no bars, dropped by the bars>0 filter) now carry their text onto the previous
  bar-bearing section as `navText` (additive field; counts unchanged).
- `parseHybridChartFromCSMPN()`: section models carry `navText`; return object adds
  `capo: doc.capo || 0`.

**`tests/hybridRenderer.test.mjs`** — 6 new tests (20 total): standalone nav carry,
nav-in-label detection, Coda→𝄌 substitution, no-nav charts stay clean, capo Roman
numeral on tab lane, capo suppressed without a tab lane.

Deferred: ending brackets (16.2c-2) need a `buildDocSectionMap` refactor to source bars
from `parseBarStructures` (captures `endingLabel`/`leftBar`/`rightBar` and fixes the
volta-prefix-in-chord leak + multi-token bar mis-split). Strum arrows (16.2c-3) need a
config source decision (no panel controls exist in the main-preview context).

### SPRINT 16 CHANGES — Phase 2c-2 (Ending brackets + bar-model refactor)

**`importPipeline.js` — `buildDocSectionMap()` refactor**
- Per-block bars are now sourced from `parseBarStructures(tokens)` (with a legacy
  token-scan fallback when it is unavailable). Each bar carries `chordToken`,
  `endingLabel`, `leftBar`, `rightBar`. Bar counts are unchanged (`countBarsInDocBlock`
  already used `parseBarStructures`).
- Fixes two latent bugs: the `1.`/`2.` volta prefix leaking into the chord label, and
  multiple tokens between barlines (`| C Am |`) being mis-joined into one bar.

**`renderer.js`**
- `hrEndingNumber(label)` — "1."/"[2]"/"1st"/"2nd" → "1"|"2"|null.
- `HR_END_H = 16` — reserved band above the chord area when a row has endings;
  added to row height and `staffY`.
- `renderHybridDoc()`: systems gain a `hasEnding` flag; each run of consecutive bars
  sharing the same volta `endingLabel` gets a bracket (left drop + top line + number;
  right drop closed for 2nd endings, open for 1st).

**`tests/hybridParser.test.mjs`** — mock `parseBarStructures` now returns token-bearing
bars to match the new contract (`chordToken` is sourced from `bar.token`).

**`tests/hybridRenderer.test.mjs`** — 3 new tests (23 total): 1st/2nd ending brackets
render; volta prefix no longer leaks into the chord (refactor regression); non-volta
charts render no brackets.

### SPRINT 16 CHANGES — Phase 2c-3 (Strum arrows via Fake Book Settings)

Config home: **Fake Book Settings** (not a CSMPN source field) — mirrors the slash
panel's strum UX, persists via `saveFBSettings()`, and is a global toggle for the
main-preview unified engine.

**`settings.js`**
- `fbSettings.strumMode` (`'none'|'down'|'alt'|'custom'`, default `'none'`) +
  `fbSettings.strumPattern` (custom pattern string). `loadFBSettings()` syncs both
  controls (restored automatically by the existing `Object.keys(fbSettings)` loop).

**`index.html`**
- Fake Book Settings panel: `#setStrumMode` select (None / ↓↓ All down / ↓↑ Alternating
  / Custom…) + `#setStrumPattern` text field (`#strumPatternField`, shown only for
  Custom). Change/`input` listeners update fbSettings, save, and re-render;
  `_syncStrumPatternVis()` toggles the custom field.

**`renderer.js`**
- `hrStrumChar(beat, mode, pattern)` — mirrors the slash panel's `strumChar`
  (`D→↓`, `U→↑`, `X`/`V→×`, `-`→none; alt = ↓↑ by beat parity).
- `renderHybridDoc()`: reads `fbSettings.strumMode`/`strumPattern` (custom parsed to a
  `DUXV-` char array); draws arrows below the staff at `hrVisualBeats()` positions,
  skipped on rows with a tab lane.

**`tests/hybridRenderer.test.mjs`** — 5 new tests (28 total): down = 4 arrows/4-4 bar,
alt = 2↓/2↑, custom `D U` cycles, none = 0, tab rows suppress strum.

With 16.2c-3 done, the unified engine has parity for slash count, clef, key sig, nav,
capo, endings, and strum. Remaining for retiring the slash panel: 16.2d (MusicXML
export from the unified engine) and 16.3 (remove the panel IIFE).

### SPRINT 16 CHANGES — Phase 2d (MusicXML export from the unified model)

A self-contained MusicXML exporter that does **not** depend on the slash-notation
panel IIFE, so the panel can be retired (16.3). Driven by `parseHybridChartFromCSMPN`.

**`importPipeline.js`**
- `buildDocSectionMap()` stores `markerType` (`-`/`:`/`=`) on each section;
  `parseHybridChartFromCSMPN()` carries it into section models (for rehearsal-mark
  enclosure: `:`/`=` → square, `-` → none).

**`renderer.js`**
- `hrChordKind(quality)` — quality → MusicXML `<kind>` (mirrors the panel's `chordKind`).
- `hrKeyMode(keyStr)` — major/minor detection.
- `hrHarmonyXml(chordToken, beats, divisions)` — `<harmony>` per chord (splits `_`,
  parses root/alter/quality/bass, spaces multiple chords with `<offset>`).
- `hrBuildMusicXml(sourceText)` — full MusicXML 4.0 Partwise: attributes (divisions,
  key fifths+mode, time, G clef, slash measure-style), tempo, per-section rehearsal
  marks (nav-suppressed), harmonies, one slash notehead per `hrVisualBeats()` beat,
  repeat barlines + volta endings (from `leftBar`/`rightBar`/`endingLabel`).

**`index.html`**
- `#btnExportMusicXml` ("↓ MusicXML") in the power-tools toolbar row; handler calls
  `hrBuildMusicXml()` and downloads `{title}.xml` as `text/xml` (iOS-friendly).

**`tests/hybridRenderer.test.mjs`** — 7 new tests (35 total): score-partwise + title,
empty→null, key fifths+mode (G→1 major, Am→minor), harmony root/kind/slash-bass, slash
note count per visual beat (4/4→4, 12/8→4), repeat+volta round-trip, rehearsal
enclosure (= square / - none) with nav suppressed.

Note (16.2d-2): this emits the generic one-slash-per-beat chart (parity with the panel's
`buildMusicXml`). The panel additionally has `buildHybridMusicXml` which encodes hybrid
event durations; porting that is the remaining step before the panel's `↓ MusicXML` can
be removed in 16.3.

### SPRINT 16 CHANGES — Phase 2d-2 (Hybrid rhythm durations in MusicXML)

**`renderer.js`**
- `hrBuildMusicXml()` is now a dispatcher: `hybrid.active` → `hrBuildHybridMusicXml`
  (duration-aware), else `hrBuildSlashMusicXml` (the generic one-slash-per-beat path).
- Shared helpers factored out: `hrHarmonyOne(text, offsetDivs)` (single `<harmony>`),
  `hrMusicXmlDoc(title, composer, measureXml)` (score wrapper), `hrBarlineXml(bar,
  prevEnding, nextEl)` (repeat barlines + voltas).
- `hrBuildHybridMusicXml()` — divisions=4 (16th resolution); maps `w/h/q/e/s` + rests to
  `<type>`/`<duration>`; muted → `x` notehead; accents → `<accent/>`; harmony placed at
  each event's beat offset; section + bar cue text → `<words>`; rest-fills gaps and the
  measure tail; includes repeat barlines + voltas (which the panel's hybrid export omitted).
- **Fixes the slash panel's `buildHybridMusicXml` bug**: it read a non-existent
  `ev.durCode` field (the model uses `ev.duration` + `ev.type==='rest'`), so it emitted
  every event as a plain quarter slash and never encoded rests. The unified exporter uses
  the real fields, so it is strictly more correct.

**`importPipeline.js`**
- `parseHybridChartFromCSMPN()` now preserves `endingLabel`/`leftBar`/`rightBar` (not just
  `chordToken`) when a `bN:` event line replaces a bar's structure — so repeat barlines
  and voltas survive on bars that also carry hybrid rhythm.

**`tests/hybridRenderer.test.mjs`** — 6 new tests (41 total): divisions=4 + stemmed
slashes; duration→type mapping (q/e/h); rests as `<rest>`; muted `x` + `<accent/>`;
harmony at event-beat offset; repeats + voltas survive in the hybrid path.

The unified engine now matches (and exceeds) the slash panel's MusicXML export — the last
functional dependency. **16.3** (audit `↓ SVG`/`↓ PNG`/`⎙ Print` parity, then remove the
slash-panel IIFE) is now unblocked.

### SPRINT 16 CHANGES — Phase 3a (SVG download parity)

Pre-work for retiring the slash-notation panel. Audit of the panel's exports vs the main
toolbar found that **PNG, PDF, Print, and MusicXML already have main-toolbar equivalents**
that capture the unified preview (`previewEl`), but **raw SVG download existed only in the
panel** (`btnSnSvg`). This PR closes that gap so nothing is lost when the panel is removed.

**`index.html`**
- `#btnExportSvg` ("↓ SVG") in the power-tools toolbar row, next to MusicXML.
- Handler serializes the unified preview's `<svg>` (Rhythm mode) via `XMLSerializer` and
  downloads `{title}.svg`; if no SVG is present (Rhythm mode off), shows a hint.

Remaining (16.3b): the **Setlist** feature still calls `window.renderCsmpnToSvg` (defined
inside the panel IIFE). 16.3b reimplements that on `renderHybridDoc` (extracting the
`<svg>`), removes the now-dead `updateSlashNotationIfOpen` call in renderer.js, and deletes
the panel IIFE (index.html ~5343–6852), its HTML (~2186–2287), the `btnSlashNotation`
button, and the `.slashNotationPanel` CSS. The panel's `window.__*` font globals are
already set independently by `applyFBSettings()` in settings.js, so they survive.

### SPRINT 16 CHANGES — Phase 3b (Retire the slash-notation panel) ✅ SPRINT 16 COMPLETE

The unified engine (`renderer.js`) now fully supersedes the legacy slash-notation panel,
so the panel is removed. **index.html shrank by 1,773 lines.**

**`renderer.js`**
- `window.renderCsmpnToSvg(csmpnText)` reimplemented on the unified engine: calls
  `renderHybridDoc()` and returns just the `<svg>…</svg>` (strips the screen-only mode
  chip / wrapper). The Setlist printer (`printAll`) consumes this unchanged.
- Removed the now-dead `updateSlashNotationIfOpen()` call at the end of `updatePreview()`.

**`index.html`** — deleted:
- The slash-notation panel IIFE (~1,516 lines): `renderSlashNotationHtml`, `renderRow`,
  `buildSnSections`, `buildMusicXml`, `buildHybridMusicXml`, `download{Svg,Png,MusicXml}`,
  `printSlashNotation`, `getSnRenderSettings`, `_snCfg`, all `sn*`/slash helpers, and the
  panel's control + export event listeners.
- The `#slashNotationPanel` HTML markup, the `𝄞 Slash Notation` toolbar button, and the
  `.slashNotationPanel` / `.sn-*` / `#slashNotationOutput` CSS (incl. the print rule).

**Preserved (verified):**
- `window.__SLASH_FONT_FAMILY` / `__SN_NOTATION_FONT_FAMILY` / `__SLASH_FONT_PACK_ID` are
  set independently by `applyFBSettings()` in settings.js (renderer.js reads the notation
  font global), so font behavior is unchanged.
- `parseChordToken` lives in chordProcessing.js (shared), not the panel.
- Setlist still works via the new `renderCsmpnToSvg`.

**Verification:** `npm run lint` · `npm run format:check` · `npm run build` (vite parses the
inline script) · `npm run test:all` (380 + 484, 0 failures) all green; grep confirms zero
orphaned references to panel ids/functions; a vm probe confirms `renderCsmpnToSvg` returns a
bare `<svg>`.

**Sprint 16 outcome:** one SVG slash/rhythm engine. Plain charts render as even slashes
(zero-rhythm case); `{hybrid}` blocks add notated rhythm; full feature set (compound-meter
slash count, clef, key sig, nav markers, capo, ending brackets, strum arrows) and all
exports (SVG/PNG/PDF/Print/MusicXML, generic + hybrid-duration) live on the unified engine.

### SPRINT 16 — Post-unification polish (Slash-Rhythm View)

**UI rename:** "Hybrid Rhythm Guitar Mode" → **Slash-Rhythm View** across all user-facing
strings (labels, mode chip, status messages, help/tooltips). Internal identifiers
(`fbSettings.hybridRhythmMode`, `renderHybridDoc`, the `{hybrid}` block syntax, CSS
classes, localStorage key) are unchanged — preserves the documented `{hybrid}` format that
GP/CSML import emit and existing users' saved settings.

**Polish (#1 + #2):**
- **Retired the vestigial `hybridPreset` "Slash-Rhythm Preset" (Default/v1) control.** Post-
  unification the `v1` option only re-enabled the view + capped bars/row (already covered by
  the on/off toggle). Removed the field, listener, and `fbSettings.hybridPreset` plumbing in
  `index.html` + `settings.js`.
- **Augmentation dots on compound-meter slashes.** `hrIsCompoundMeter(timeSig)` +
  `hrAugDot(cx, cy, col)` in renderer.js; the zero-rhythm slash loop now draws a dot per
  slash in 6/8, 9/8, 12/8 (each visual beat is a dotted quarter). Simple meters unchanged.
- `tests/hybridRenderer.test.mjs` — 2 new tests (43 total): compound meters add one dot per
  slash (12/8→4, 6/8→2); simple meters add none.

**Remaining recommendations (next):** #3 proper tuplets in MusicXML (`<time-modification>`);
#4 collapse the three MusicXML emitters (`renderer.js` `hr*`, `chordSlashMLRenderer.js`
`csml*`, `src/export/musicXmlExporter.ts`) into a shared core. Bigger bet: audio playback.

### SPRINT 16 — #3: Tuplets in MusicXML export (time-modification)

`hrBuildHybridMusicXml` previously emitted tuplet events at their base duration with no
`<time-modification>`, so triplets didn't round-trip into notation apps. Fixed:

**`renderer.js`**
- Export resolution raised to **divisions=12** (1 quarter = 12 divs) so triplet/sextuplet
  durations are integer-exact (triplet eighth = 6 × 2/3 = 4 divs). All duration/rest/offset
  math rescaled via a `Q` constant.
- `hrTupletNormal(n)` — normal-notes for an N-tuplet (largest power of 2 ≤ N: 3→2, 5→4, 9→8).
- Tuplet events now emit `<time-modification><actual-notes>N</actual-notes><normal-notes>M
  </normal-notes></time-modification>` plus `<tuplet type="start"/>` on the first and
  `type="stop"` on the last note of each group.
- Mid-tuplet notes are placed **contiguously** (their `1 1& 2` beat slots don't represent
  true triplet timing — they're authored in regular slots + tagged `tN`); only the group's
  first note aligns to its beat slot. This eliminates spurious inter-note rests and makes the
  measure fill exactly (verified: a triplet + quarter-rest + half = 48 divs in 4/4).

**`tests/hybridRenderer.test.mjs`** — updated 4 existing tests for divisions=12 (12/6/24 +
offset 24); 3 new tuplet tests (46 total): 3:2 time-modification on all three triplet notes,
start/stop brackets, integer-exact durations filling the bar, and no time-modification on
straight rhythms.

**Limitation:** non-3-based tuplets (5,7) at divisions=12 round their per-note duration
(rare; triplets/sextuplets are exact). Remaining: #4 — collapse the three MusicXML emitters
into a shared core.

### SPRINT 16 — #4 (step 1): shared MusicXML core + renderer.js migration

First step of consolidating the browser MusicXML emitters (which had begun to drift — e.g.
`hrChordKind` matched `o7` by prefix while `csmlChordKind` matched it exactly).

**New `musicXmlCore.js`** (browser global + `window.MusicXmlCore`): single source of truth for
the low-level primitives — `mxEsc`, `mxChordKind` (merged superset of the hr/csml maps),
`mxKeyFifths` (major+minor table), `mxKeyMode`, `mxHarmony` (one `<harmony>`), `mxScoreDoc`
(score-partwise wrapper). Plain function declarations so it works in classic scripts and the
Node `vm` test context.

**`renderer.js`** — `hrChordKind`/`hrKeyMode`/`hrHarmonyOne`/`hrMusicXmlDoc`/`hrKeySigFromKey`
are now thin delegations to the core; `hrHarmonyXml` calls `mxHarmony`. Removed the duplicated
`HR_KEY_SIG_DATA` table and chord/harmony/score bodies (the visual `HR_SHARP_Y`/`HR_FLAT_Y`
offset tables stay).

**`index.html`** — loads `musicXmlCore.js` before `renderer.js`.
**`.github/workflows/ci.yml`** — `musicXmlCore.js` added to the root-JS `node --check` list and
the static-file deploy `cp` (so GitHub Pages serves it; `verify-deploy-assets.mjs` confirms).
**Tests** — new `tests/musicXmlCore.test.mjs` (6 tests, direct unit coverage); `hybridRenderer`
test harness loads the core; total npm tests 385 → 391.

Step 2 (next): migrate `chordSlashMLRenderer.js`'s `csml*` MusicXML functions to the core (with a
new vm test for `csmlToMusicXml`), removing the last duplication.

### SPRINT 16 — #4 (step 2): migrate chordSlashMLRenderer.js to the shared core ✅ #4 COMPLETE

Second/final step of consolidating the browser MusicXML emitters.

**`chordSlashMLRenderer.js`**
- Deleted the duplicated `csmlChordKind`, `csmlKeySigFifths`, `csmlKeyMode`, and
  `csmlHarmonyXml`; their call sites now use the shared core (`mxChordKind` indirectly via
  `mxHarmony`, plus `mxKeyFifths` / `mxKeyMode` / `mxHarmony`).
- The score-partwise return delegates to `mxScoreDoc(doc.title, doc.composer, measureXml)`
  (passes raw title/composer — the core escapes once, no double-escape). The local
  pre-escaped `title`/`composer` vars were removed; `xmlEsc` stays for section-label/tempo.
- musicXmlCore.js loads before chordSlashMLRenderer.js in index.html (verified).

**Verification:** captured `csml.toMusicXml(sample)` output **before and after** the migration
and diffed — **byte-identical**. So the refactor is provably behavior-preserving.

**Tests** — new `tests/csmlMusicXml.test.mjs` (4 tests) loads the core + CSML bundle in a vm
and asserts score-partwise, key fifths/mode, chord kinds, harmony count, and repeat barlines —
the browser CSML exporter had **no** prior test. `chordSlashMLRenderer.js` added to CI
`node --check`. Total npm tests 391 → 395.

**#4 outcome:** both live browser MusicXML emitters (`renderer.js` `hr*`,
`chordSlashMLRenderer.js` `csml*`) now share one core (`musicXmlCore.js`) — the chord-kind /
key-sig / harmony / score logic exists once, ending the drift. (The tests-only
`src/export/musicXmlExporter.ts` was intentionally left out of scope.)

### Post-Sprint 16 — ChordSlashML 12/8 compound-meter augmentation dots

**Bug:** the ChordSlashML editor rendered compound meters (6/8, 9/8, 12/8) as plain
slashes — `beatsPerMeasure('12/8')`=4 dotted-quarter pulses, but with no augmentation
dot, so a 12/8 bar looked identical to 4/4. (The Slash-Rhythm View already got dots in
SPRINT 16 #2; the CSML editor was the inconsistent one.)

**`chordSlashMLRenderer.js`**
- `csmlIsCompound(time)` (den===8 && num%3===0 && num>=6) + `augDot(cx, cy, col)`
  (small filled circle right of the slash notehead).
- `renderBeatNoteheads()` gains a `dotted` param; chord/slash beats draw a dot when set.
  Sub-noteheads inside compound/tuplet groups are not dotted (only the top-level pulse).
- Both `csmlToSvgDoc()` and `csmlToSvgPages()` compute `dotted = csmlIsCompound(doc.time)`
  and pass it through the explicit-beat path and the padding-slash loop.

**`tests/csmlMusicXml.test.mjs`** — 3 new tests (7 total): 12/8→4 dots, 6/8→2 / 9/8→3 /
padded→4, simple meters→0.

Known follow-up (not in this change): the CSML beat-slot model needs the slot count to
match the meter's pulse count (12/8→4 slots, 6/8→2, 9/8→3); writing more slots than the
pulse count overflows the measure. A future change could clamp `beatSpacing` to
`max(bpm, beats.length)` so over-filled measures don't run past the barline.

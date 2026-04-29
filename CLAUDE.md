# SESSION START — PRIORITY REFERENCE
> Read this section first every session. Full roadmap: `OPP_ROADMAP.md`

## Project Identity
- **App:** Chord Sheet Maker Pro — music finishing app (not a primary converter)
- **Developer:** iOS 16+ (iPhone/iPad) — no local console. GitHub Actions = the CI console.
- **Branch:** `claude/fix-codex-agent-error-hy7VN` — all work goes here
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

## Current State (2026-04-29)
- **264 tests passing** (`npm run test:all`) — 18 hybrid parser + 246 parser/exporter/utils tests
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
| `index.html` | Legacy monolith — fake-book shell, event wiring, slash notation IIFE, self-tests (4,601 lines) |
| `settings.js` | Fake Book Settings state: `fbSettings`, font maps, `applyFBSettings`, `setStatus`, `filterLyricsLines` |
| `renderer.js` | CSMPN HTML renderer: `renderDoc`, `updatePreview`, VexFlow notation helpers |
| `importPipeline.js` | All format importers: `SongModel`, `extractHeaderFromText`, `importUGText`, `importChordPro`, `importMusicXML`, `importIRealPro`, `importUGProPDF`, etc. |
| `app.html` + `src/` | React app — importers, OSMD notation, chord chart view |
| `ug-pro-importer.html` | Vite HTML shell for the PDF importer page (multi-page build entry) |
| `ug-txt-importer.html` | Standalone dark-UI page: paste UG text → convert to CSMPN → copy/download |
| `src/pages/ugProImporterPage.tsx` | React bootstrap for the importer page — renders `UGProImporterPanel` |
| `src/ingest/ugProPdfImporter.ts` | Canonical PDF importer (TypeScript module; drives the Vite build page) |
| `src/ingest/ugProPdfUtils.ts` | Pure span utilities (no pdfjs-dist): TextSpan, SMuFL constants, `detectTimeSigSpans`, `detectKeySig`, `mergeFragmentSpans` — safe to import in Node.js tests |
| `src/parsers/` | Zero-dependency TypeScript parsers (chordPro, csmpn, abc, gp, musicXml) |
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

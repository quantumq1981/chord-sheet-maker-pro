# SESSION START — PRIORITY REFERENCE
> Read this section first every session. Full roadmap: `OPP_ROADMAP.md`

## Project Identity
- **App:** Chord Sheet Maker Pro — music finishing app (not a primary converter)
- **Developer:** iOS 16+ (iPhone/iPad) — no local console. GitHub Actions = the CI console.
- **Branch:** `claude/update-claude-docs-IKErW` — all work goes here
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

## Current State (2026-04-20)
- **168 tests passing** (`npm run test:all`) — 4 VexFlow + 164 parser/exporter tests
- **Primary app track: `index.html`** — the developer uses iOS/iPad exclusively; all active feature work goes here
- **`app.html` + `src/`** — React/TypeScript track (secondary); `src/export/` and `src/parsers/` used for unit tests only
- **App.tsx:** 1,145 lines — OSMD renderer, export actions, and utilities extracted to hooks/utils
- **0 type errors**
- **iOS-only usage:** All features must work in Mobile Safari (iPhone/iPad). Primary export path is iOS Safari print-to-PDF.

## Architectural Principles (enforce on every change)
1. `src/ingest/ugProPdfImporter.ts` is the **canonical** PDF importer — `ug-pro-importer.html` (root) is the Vite shell; `public/ug-pro-importer.html` has been deleted
2. **`index.html` is the canonical location for all slash notation + MusicXML export work** — the developer uses iOS/iPad only; never add app features to the React track in parallel
3. All dynamic HTML in `index.html` must pass through `escapeHtml()` — no raw interpolation
4. Tests before features — every new exported function gets a corresponding test
5. iOS Safari is the **primary browser** — always verify `.xml` (not `.musicxml`) download extension and `text/xml` MIME type so iOS opens the file in notation apps
6. Lazy-load heavy CDN libs (abcjs, VexFlow) — they cost ~180 KB+ on initial iOS parse
7. **Before every commit run all four:** `npm run lint` · `npm run format:check` · `npm run build` · `npm run test:all` — GitHub Actions is the only CI console (no local terminal on iOS)

## Quick Reference: Key Files
| File | Purpose |
|------|---------|
| `index.html` | Legacy monolith — fake-book renderer, slash notation IIFE, self-tests |
| `app.html` + `src/` | React app — importers, OSMD notation, chord chart view |
| `ug-pro-importer.html` | Vite HTML shell for the importer page (multi-page build entry) |
| `src/pages/ugProImporterPage.tsx` | React bootstrap for the importer page — renders `UGProImporterPanel` |
| `src/ingest/ugProPdfImporter.ts` | Canonical PDF importer (TypeScript module; drives the Vite build page) |
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

## Sprint 5 — Converter Decomposition & Unification (In Progress)
| # | Task | Status |
|---|------|--------|
| 5.1 | Split `musicXMLtochordpro.ts` (1,309 lines → 5 modules) | ✅ DONE — `types` · `chordExtractor` · `xmlParser` · `formatter` · `pipeline`; barrel re-export preserves all importers |
| 5.2A | Port HTML v1.2 algorithm improvements to `ugProPdfImporter.ts` | ✅ DONE — PR #145 (2026-04-20) |
| 5.2B | Create Vite build artifact: `ug-pro-importer.html` root shell + `src/pages/ugProImporterPage.tsx` entry | ✅ DONE — 2026-04-20 |
| 5.2C | Update `vite.config.ts` multi-page input; remove `public/ug-pro-importer.html` | ✅ DONE — 2026-04-20 |
| 5.3 | Remaining `index.html` extractions (renderer, importPipeline, settings) — items 2.1D–F | ⏳ PENDING |

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
| Guitar TAB staff | Requires actual fret numbers — not representable in chord-symbol notation alone |
| Ghost notes / muted noteheads | Needs per-beat token syntax extension in CSMPN parser |
| Hammer-on / Pull-off slurs | Requires note-pair coordinates — needs richer data model |
| VexFlow integration | Full renderer rewrite; deferred pending need |
| Dedicated TXT importer page | `public/ug-txt-importer.html` — separate deliverable |
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

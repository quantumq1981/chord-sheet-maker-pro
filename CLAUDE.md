# SESSION START — PRIORITY REFERENCE
> Read this section first every session. Full roadmap: `OPP_ROADMAP.md`

## Project Identity
- **App:** Chord Sheet Maker Pro — music finishing app (not a primary converter)
- **Developer:** iOS 16+ (iPhone/iPad) — no local console. GitHub Actions = the CI console.
- **Branch:** `claude/review-claude-md-1mvan` — all work goes here
- **Optimization persona:** Opp the CoderOptimizer — prioritize clean architecture, performance, correctness

## Active Sprint: Sprint 1 — Foundation Hardening
| # | Task | Status |
|---|------|--------|
| 1.1 | GitHub Actions CI/CD (`.github/workflows/ci.yml`) | ⬜ TODO |
| 1.2 | ESLint + Prettier setup | ⬜ TODO |
| 1.3 | Parse cache audit | ✅ N/A — already correct |
| 1.4 | Source maps in `vite.config.ts` | ⬜ TODO |
| 1.5 | `tsconfig.test.json` covering `src/` + `tests/` | ⬜ TODO |

## Current State (2026-04-09)
- **30 tests passing** (`npm run test:all`) — 4 VexFlow + 26 parser/format fixture tests
- **Two active app tracks:** `index.html` (8,032-line monolith) + `app.html` React/TypeScript
- **Critical gap:** No CI/CD, no linting, no source maps yet

## Architectural Principles (enforce on every change)
1. `src/ingest/ugProPdfImporter.ts` is the **canonical** PDF importer — `ug-pro-importer.html` must not diverge from it
2. Never add features to both tracks simultaneously — pick canonical location, update one
3. All dynamic HTML in `index.html` must pass through `escapeHtml()` — no raw interpolation
4. Tests before features — every new exported function gets a corresponding test
5. iOS Safari print-to-PDF is the **primary export path** — optimize for it, not canvas rasterization
6. Lazy-load heavy CDN libs (abcjs, VexFlow) — they cost ~180 KB+ on initial iOS parse

## Quick Reference: Key Files
| File | Purpose |
|------|---------|
| `index.html` | Legacy monolith — fake-book renderer, slash notation IIFE, self-tests |
| `app.html` + `src/` | React app — importers, OSMD notation, chord chart view |
| `src/ingest/ugProPdfImporter.ts` | Canonical PDF importer (not the standalone HTML) |
| `src/parsers/` | Zero-dependency TypeScript parsers (chordPro, csmpn, abc, gp, musicXml) |
| `tests/` | Node.js native test runner + tsx loader for TypeScript tests |
| `OPP_ROADMAP.md` | Full 7-phase optimization roadmap with sprint tracker — update it as work completes |

## Next Immediate Actions (pick up where left off)
```
1. Create .github/workflows/ci.yml  → enables automated testing on every push
2. Add ESLint config                 → stops code style drift
3. Add source maps to vite.config.ts → 1-line change, makes debugging possible
```

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
| **Font Size** (M/S/XS) | Scales chord font: M=11.5px, S=9.8px, XS=8.3px |
| **Chord Alignment** | Center = `text-anchor="middle"`, Left = `text-anchor="start"` |
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

### Rhythmic Stems

When **Stems** is checked, a vertical line is drawn above each slash notehead (`cx+4.5, cy-6` to `cy-22`), giving a quarter-note appearance common in professional guitar rhythm charts.

---

### Palm Muting (P.M.)

When **P.M.** is checked, every staff row renders:
- `P.M.` italic text at the top of the chord area (just below the system top)
- A dashed line (`stroke-dasharray="3,2"`) extending across the full row width

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

The accent mark is drawn at `staffY - 8 - chordFontSize - 2` (above the chord symbol, auto-adjusting for font size). The chord symbol itself renders normally with the `!`/`^` stripped.

---

### Navigation Markers (D.C., D.S., Fine, Coda)

Navigation text is detected and rendered at the **bottom-right of the last measure** in a section, below the closing barline.

**Auto-detection:** The regex `/\b(D\.C\.|D\.S\.|FINE|CODA|AL FINE|AL CODA|DAL SEGNO|DA CAPO|TO CODA|SEGNO)\b/i` matches common navigation markers in section labels. Two cases are handled:

1. **Section label is a nav marker** (e.g., `= D.C. al Fine` with no following bars) — attached to the previous section's last row
2. **Section label contains nav text** with its own bars — nav text is extracted and shown at the last row of that section

**Render position:** `text-anchor="end"` at `x = staffX + totalW`, `y = staffY + STAFF_H + 16`

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

| Format | Implementation |
|---|---|
| **SVG** | `XMLSerializer.serializeToString(svg)` → Blob → `<a download>` |
| **PNG** | Canvas 2× scale, `ctx.drawImage` from SVG Blob URL → `canvas.toDataURL('image/png')` |
| **Print** | `window.open` popup with `svg.outerHTML` + `window.print()` on load |

All exports use `_snCfg.bgColor` as the background and `safeFilename(doc.title)` for the file name.

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
| CI/CD pipeline | No `.github/workflows` yet — add GitHub Actions for lint/test/build |
| ~~Importer fixture tests~~ | ✅ Done — `tests/sniffFormat.test.ts`, `tests/chordProParser.test.ts`, `tests/csmpnParser.test.ts` (2026-04-09) |

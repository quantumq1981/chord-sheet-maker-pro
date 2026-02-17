# AGENT REPORT — Codex Agent Prompt #4 (Updated)

## Summary of Changes

Three UI-only enhancements added to `index.html` without modifying rendering logic (`renderDoc`, Fake Book layout, or export/print/PDF/PNG functionality):

### 1. Import Diagnostics Surfacing Panel
- **Global state object** `importDiagnostics` tracks: miner type, sections detected, total bars, ignored lines, warnings array, and import duration (ms).
- **Collapsible panel** (`#diagnosticsPanel`) with smooth CSS transition, initially hidden.
- **Toggle button** ("Import Details") appears in the button row only after a successful import (Power mode only).
- Each miner path (PDF, MusicXML, ABC, ChordPro, UG Pro Text, Plain Text) is instrumented with `performance.now()` timing and post-import counting.
- Panel displays diagnostics in a clean grid layout with optional warnings list.
- Mobile-friendly: small font, responsive grid, iOS tap-safe.

### 2. Feature Info Pop-Up System
- **Single reusable modal** (`#feature-modal`) with backdrop overlay, centered content, and close button.
- **`featureInfo` content map** with musician-friendly explanations for: Bars Per Row, Major 7th Style, Minor Chord Style, Fake Book Layout, Import, Import Details, and User/Power Mode.
- **Info buttons** added next to: Import button, Bars Per Row, Major 7th Style, Minor Chord Style, Fake Book Settings heading, and the mode toggle.
- Modal closes via: Close button, backdrop click, or Escape key.
- No external libraries used. Pure CSS + vanilla JS.

### 3. User Mode / Power Mode Toggle
- **Toggle switch** at the top of the interface, below the app title.
- **User mode (default):** Clean, simplified interface showing only essential controls:
  - Core settings: Font Size, Bars Per Row, Major 7th Style, Minor Chord Style
  - All import/export/print/transpose buttons (except ChordPro export)
  - Info pop-ups remain available
- **Power mode:** Full interface with everything visible:
  - Advanced settings: Line Spacing, Bar Lines, Chord Alignment, Page Footer
  - Import Diagnostics panel toggle and panel
  - Syntax tips reference
  - ChordPro Export button
- **Persisted to localStorage** (`csmpn_appMode`) — survives page reloads.
- Clickable labels ("User" / "Power") in addition to the toggle knob.
- Hidden during print and export.

## Anchors (function names / sections)

| What | Location |
|------|----------|
| CSS: `.diagnosticsToggle`, `.diagnosticsPanel` | Style block (after `@media print`) |
| CSS: `#feature-modal`, `.info-btn` | Style block (after diagnostics CSS) |
| CSS: `.mode-toggle-wrap`, `.mode-switch` | Style block (after info-btn CSS) |
| CSS: `body.user-mode .power-only` | Mode visibility rules |
| CSS: export/print hiding rules | `body.exporting` and `@media print` rules |
| HTML: mode toggle | `.mode-toggle-wrap` div (below title) |
| HTML: diagnostics toggle button | Button row (`#btnDiagnostics`, `power-only`) |
| HTML: diagnostics panel | `#diagnosticsPanel` div (`power-only`) |
| HTML: feature modal | `#feature-modal` div (before `<script>`) |
| HTML: info buttons | Settings labels, import button, mode toggle |
| HTML: `power-only` tagged elements | Tips, diagnostics, advanced settings fields, ChordPro export |
| JS: `importDiagnostics` state | After `validationWarnings` declaration |
| JS: `resetDiagnostics()` | Resets state before each import |
| JS: `updateDiagnosticsPanel()` | Renders diagnostics HTML into panel |
| JS: `featureInfo` map | Feature explanation content (7 entries) |
| JS: `openFeatureInfo(key)` | Opens modal with content for given key |
| JS: `closeFeatureInfo()` | Closes modal |
| JS: `appMode`, `applyAppMode()` | Mode state + DOM class toggling |
| JS: `loadAppMode()` | Reads persisted mode from localStorage |
| JS: mode switch event wiring | Click handlers for switch + labels |
| JS: miner instrumentation | `fileInput` change handler |

## How to Test

### User / Power Mode Toggle
1. **Default state**: Page loads in User mode — tips, diagnostics, advanced settings (Line Spacing, Bar Lines, Chord Alignment, Footer), and ChordPro Export are hidden.
2. **Switch to Power**: Click the toggle or "Power" label — all hidden elements appear.
3. **Switch back**: Click toggle or "User" label — elements hide again.
4. **Persistence**: Reload page — mode persists from previous session.
5. **Info button**: Tap the info button next to the toggle — modal explains both modes.

### Import Diagnostics (Power Mode)
1. Switch to Power mode.
2. **UG Pro Text import**: Import a `.txt` file. "Import Details" button appears. Click to expand panel showing: miner = "UG Pro Text", section count, bar count, ignored lines > 0, duration in ms.
3. **MusicXML import**: Diagnostics show miner = "MusicXML", ignored lines = 0.
4. **ABC import**: Miner = "ABC Notation".
5. **PDF import**: Miner = "PDF".
6. **ChordPro import**: Miner = "ChordPro".

### Feature Info Pop-Ups (Both Modes)
1. Tap/click any info button next to settings labels or the Import button.
2. Modal opens with title and explanation text.
3. Close via: "Close" button, clicking backdrop, or pressing Escape.
4. On iOS: tap opens cleanly, no scroll lock issues.

### Non-Regression
1. **Export/Print/PDF/PNG**: All export buttons still work. Mode toggle, diagnostics panel, and modal are hidden during export/print.
2. **Fake Book preview**: No layout shifts.
3. **Settings**: All settings function in both modes. Hidden settings retain their values when toggling modes.
4. **User mode completeness**: All core functionality (import, transpose, print, PDF, PNG, copy, save, load) remains accessible in User mode.

## Edge Cases
- If user imports a file while in User mode, diagnostics are still collected internally — switching to Power mode after import reveals the data.
- Advanced settings values persist even when hidden in User mode (they're just CSS-hidden, not removed).
- The mode toggle itself is always visible (never gated by either mode).
- `power-only` CSS class uses `display:none !important` to ensure clean hiding regardless of element's default display type.

## Performance Impact
- **Negligible.** Mode toggle adds/removes a single CSS class on `<body>`. All visibility is handled by CSS, not JS DOM manipulation.
- No new external libraries. No new network requests.

## No Changes To
- `renderDoc()` — untouched
- Fake Book layout logic — untouched
- Export/Print/PDF/PNG handlers — untouched (only CSS hiding rules added)
- `parseCSMPN()`, `parseBarStructures()`, `renderBars()` — untouched
- Mining logic internals — untouched (only wrapped with timing/counting)

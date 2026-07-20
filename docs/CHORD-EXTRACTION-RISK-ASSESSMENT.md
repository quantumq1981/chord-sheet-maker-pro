# Chord Extraction – Risk Assessment & Game Plan

**Feature:** Browser-based chord-name extraction from scanned sheet-music images
(Tesseract.js, fully client-side, iPad-Safari-first)
**Status:** Pre-build review document — no implementation code exists yet
**Home:** `chord-sheet-maker-pro` (standalone page, `ug-txt-importer.html` precedent)
**Date:** 2026-07-20

---

## 0. The panel

This document simulates a focused brainstorming session between three specialist
personas, moderated by the lead developer:

| Persona | Focus |
|---|---|
| **STAVE** — staff-detection algorithm specialist | Image analysis: projections, thresholding, skew, slicing |
| **TESS** — Tesseract.js performance & accuracy expert | OCR engine behavior, WASM, worker lifecycle, char whitelists |
| **SAFARI** — mobile Safari constraints tester | iPadOS canvas/memory limits, CSP, CDN loading, touch UI |

Each risk below is attributed to the persona who raised it; mitigations were
agreed by the panel.

---

## 1. What we are building (scope recap)

Extract **chord names only** (e.g. `D7`, `Cmaj7`, `F#m`, `Bb`, `N.C.`) from
high-resolution scanned songbook pages (PNG/JPEG, often 300 DPI+), **without**
full optical music recognition. Chords sit as plain text above the top staff of
each system. Output: a positional timeline (`{chord, measure, beat, staffIndex}`
JSON) — and, because this repo's lingua franca is CSMPN, a CSMPN chart alongside
it so the result flows straight into the fake-book pipeline.

Explicitly out of scope: notation, lyrics, dynamics, raster OMR of noteheads
(that remains "Path B" territory, kept separate by family convention).

---

## 2. High-level game plan (integration-aware)

The panel's unanimous framing: **this is a new importer, and the repo already
has most of the non-OCR machinery.** Build the thin new part (image slicing +
OCR), reuse everything downstream.

### Step-by-step

1. **Standalone spike page first — `sheet-ocr-importer.html`** at repo root,
   following the `ug-txt-importer.html` standalone-page precedent (dark UI,
   back-link, self-contained). This sidesteps `index.html`'s CSP and its
   3-second-parse budget while the algorithm is unproven. Wire it into the main
   Import menu only after the spike passes its gate.

2. **Image intake** — `<input type="file">` (no over-restrictive `accept` —
   the family learned on iOS that aggressive accept filters grey out valid
   files) → `createImageBitmap`/`Image` → **two canvases**:
   - a **downscaled analysis canvas** (~1500 px wide, grayscale) for all
     detection math, and
   - the original-resolution source, from which chord strips are cropped at
     full fidelity for OCR.

3. **Staff detection (STAVE)** — horizontal row-intensity projection on the
   analysis canvas: sum dark pixels per row (after Otsu-style thresholding),
   find peak rows (staff lines), group peaks into 5-line staves by spacing
   regularity, group staves into systems. This is the same dark-pixel-analysis
   family as `ugProPdfImporter.ts`'s `detectBarlinesInBand`/`longestDarkRun` —
   proven approach, new axis.

4. **Chord-strip isolation** — for each system, crop the band **above the top
   staff**: from (previous system bottom + margin, or a cap of ~1.5× staff
   height) down to just above the top staff line. Crop from the full-res
   source, scaled to Tesseract's sweet spot (~20–40 px x-height).

5. **OCR (TESS)** — one long-lived Tesseract.js v5 worker (`eng`), strips fed
   **strictly sequentially**. PSM tuned per findings (see Risk 2/3 — PSM 7 is
   the spec's suggestion but likely not the winner). Read **word-level bboxes**
   from the result — they give chord x-positions for free.

6. **Post-filter & normalize** — do NOT trust the whitelist or raw OCR text.
   Every candidate token passes through:
   - a chord regex (the repo already maintains battle-tested ones in
     `importPipeline.js` / `src/ingest/ugProPdfUtils.ts`),
   - `normalizeChordSymbol`-style alias cleanup (`M7`→`maj7`, `sus2/4`,
     unicode ♭/♯ → `b`/`#`, `N.C` handling — all already written),
   - an OCR confusion-repair map (`0↔o`, `8↔B`, `6↔G`, `l/1/I`, `S↔5`),
   - a plausibility score via `chordTheory.js`'s `inferKeyFromChords` —
     chords that don't fit the inferred key get flagged low-confidence in the
     UI rather than silently accepted.

7. **Timeline mapping** — v1: relative x-position within the strip → measure
   estimate under a user-adjustable "bars per system" control (default 4,
   honestly labeled approximate). v2: detect real barlines inside each staff
   band via vertical projection (direct port of the `detectBarlinesInBand`
   idea) and snap chords to actual measures.

8. **UI** — image preview with overlay rectangles for detected staves + chord
   strips (so failures are *visible*), scrollable chord list with confidence
   flags, **Copy JSON** + **Copy/Download CSMPN** buttons, and (later) a
   one-tap `csm:handoff:v1` load into the main app.

9. **Architecture rule** — extract all pure logic (projection math, peak
   grouping, chord token repair, measure mapping) into a root module
   (`sheetOcr.js`, `window.SheetOcr`) that is `vm`-testable in Node with fake
   pixel arrays, exactly like `chordsheetPdf.js`/`chordTheory.js`. Only the
   canvas/Tesseract glue stays browser-only. Tests before features — the
   repo's standing rule.

---

## 3. Top risks & mitigations

### Risk 1 — Staff detection fragility on real-world scans *(STAVE)*
Faded ink, uneven lighting, page curvature/skew, lyrics and titles between
systems, grand staves (piano = 2 joined staves), and 6-line TAB staves all
break a naive "find 5 dark rows" projector. Skew is the killer: at 300 DPI,
0.5° of tilt smears a staff line across ~25 rows, flattening the projection
peaks entirely.

**Mitigations**
- Adaptive (Otsu) threshold computed from the page histogram, optionally per
  horizontal band, before projecting — handles fade/lighting.
- **Deskew estimate**: try a small set of rotation angles (±2° in 0.25° steps)
  on the downscaled canvas and keep the angle that maximizes projection-peak
  sharpness (variance). Cheap at analysis resolution.
- Group line peaks by **spacing regularity** (5 peaks with near-equal gaps),
  not just darkness — lyrics/title rows don't produce 5 evenly-spaced peaks.
- Grand staff / TAB: treat vertically close staff groups as **one system** and
  take only the topmost staff's upper band as the chord strip; a 6-peak group
  is a TAB staff, still valid as a system anchor.
- **Always render the overlay.** The user seeing wrong boxes is a recoverable
  UX moment; silent mis-slicing is not.

### Risk 2 — The `tessedit_char_whitelist` trap *(TESS)*
The spec asks for a character whitelist, but in Tesseract 4/5's **LSTM engine
the whitelist is unreliable / historically ignored** — it only fully works in
the legacy (OEM 0) engine. A build that leans on the whitelist will silently
pass garbage.

**Mitigations**
- Set the whitelist as best-effort, but make the **post-OCR regex + normalizer
  + confusion map the actual filter** (step 6 above). This is also where the
  repo's existing chord-vocabulary code pays off.
- Keep an optional legacy-OEM fallback pass for strips whose LSTM output
  scores poorly (slower, but per-strip and rare).
- Never emit a token that fails the chord regex after repair — collect it into
  a diagnostics list instead (same philosophy as the PDF importer's
  Import Details panel).

### Risk 3 — Chord typography & vocabulary variance *(TESS)*
Engraved chord fonts (Opus Text, MuseJazz, jazz "handwritten" faces),
superscript qualities (`C^MA7`, `⁷`), slash chords (`C/G`), `F#m7b5`, `N.C.`,
and glyph accidentals (♭/♯ as separate glyphs or PUA codepoints) are exactly
where generic English OCR is weakest. The family has already met this class of
problem twice (SMuFL csym glyphs in UG Pro PDFs; PUA glyphs in chordsheet.com
PDFs).

**Mitigations**
- PSM experimentation is a **first-class spike task**: PSM 7 (single line) can
  merge widely-spaced chords or hallucinate between them; PSM 11 (sparse text)
  or per-word connected-component sub-slicing may win. Decide from data, not
  the spec's suggestion.
- Reuse the alias/normalization maps from Sprint 10/18 and `chordsheetPdf.js`
  (`MA7`→`maj7`, `°`→`dim`, `ø`→`m7b5`, etc.).
- Slash-chord and `N.C.` handling are explicit regex cases, not whitelist
  hopes.
- Key-plausibility scoring (`inferKeyFromChords`) to rank ambiguous repairs
  (e.g. `Gm7` vs `6m7`).

### Risk 4 — iPad Safari canvas & memory ceilings *(SAFARI)*
iOS Safari historically caps canvases around **16.7 M pixels** (≈4096×4096);
a 300 DPI letter page (2550×3300 ≈ 8.4 M px) fits, but 600 DPI scans, A3
pages, or a stitched multi-page canvas do not — the canvas silently renders
blank. Each full-page RGBA `ImageData` is ~34 MB, and the Tesseract WASM heap
adds ~100–150 MB; a few careless copies will get the tab killed.

**Mitigations**
- Cap the working resolution: if the source exceeds a safe pixel budget,
  downscale with a visible notice ("processed at N% of original resolution").
- All detection math on the ~1500 px analysis canvas; only **strips** (small)
  are materialized at high resolution.
- **Sequential** strip OCR, one worker created once and reused, terminated on
  page exit. Never one worker per strip, never parallel strips.
- Release references between strips (null out ImageData, reuse one crop
  canvas) so GC can keep up.
- The 4000 px-tall requirement in the spec is comfortably inside budget with
  this scheme; document the actual ceiling in the page's help text.

### Risk 5 — CDN loading, CSP, and offline behavior *(SAFARI)*
Tesseract.js pulls four remote artifacts: the library, `worker.min.js`, the
WASM core, and `eng.traineddata` (~2–12 MB; default `langPath` is
`tessdata.projectnaptha.com`). The main app's CSP (`index.html`) allows
workers only from `'self' blob: cdnjs.cloudflare.com` — the Tesseract defaults
would be **blocked the moment this is merged into `index.html`**. GitHub Pages
also can't set COOP/COEP, so no multithreaded WASM (fine — we don't need it).

**Mitigations**
- Spike as a standalone page with its own minimal meta CSP — decoupled from
  `index.html`'s policy.
- Pin **all** paths explicitly (`workerPath`, `corePath`, `langPath`) to one
  already-allowlisted CDN (cdnjs/jsdelivr are both in the family CSP), never
  rely on Tesseract defaults.
- Tesseract.js caches traineddata in IndexedDB — first run needs network,
  later runs are warm; surface a "downloading language data (~xx MB, once)"
  progress state so a slow first run doesn't look like a hang.
- Fallback error handling per the spec: if the library or traineddata fails to
  load, show a clear message with a retry button — never a dead page.
- Document the exact CSP directive additions required before any
  `index.html` integration (Phase 3), following `docs/security-hardening.md`.

### Risk 6 — Timeline/measure mapping is honestly approximate *(STAVE + lead)*
"Assume 4 bars per system" is false often enough (5- and 3-bar systems are
routine in songbooks) that emitting confident measure numbers from it would
poison downstream use (player sync, lead-sheet mapping).

**Mitigations**
- v1 output labels measure/beat as **estimated**, exposes a per-page
  "bars per system" control, and always includes the raw
  `staffIndex` + normalized x-position so nothing is lost.
- v2 detects actual barlines inside each staff band (vertical dark-run
  projection — the `detectBarlinesInBand`/`longestDarkRun` approach ported to
  raster), then snaps chords to real measures and derives beats from position
  within the measure.
- CSMPN output degrades gracefully: with unknown bar boundaries, emit
  chords-in-system-order (`| C | G | …` per detected system row) — still a
  usable fake-book starting chart, per the GP/MIDI importer philosophy of
  "a starting chart to clean up".

### Risk 7 — Multi-page songbooks & the empty-result cliff *(all)*
Songs span pages; measure numbering must continue across them. And some inputs
will yield nothing: photographed (not scanned) pages, vector-only rasters,
lyric-only pages, or a detection whiff — the tool must not return a silent
empty array.

**Mitigations**
- Multi-image queue processed sequentially with a running measure offset
  (mirrors the PDF importer's cross-page fragment carry); per-page failures
  collected, never aborting the batch (the `stageBatch` pattern).
- **Fallback ladder** when no staves/chords are found:
  1. whole-page sparse-text OCR (PSM 11) + chord regex — catches pages where
     staff detection failed but chords are legible;
  2. **manual strip mode** — user drags a horizontal band on the preview to
     define a chord strip (touch-friendly; also the escape hatch for weird
     layouts);
  3. explicit "no chords detected" diagnostics with the overlay shown, in the
     spirit of `MIN_TOTAL_CHORD_SPANS`'s hard fail-safe — a clear error beats
     an empty success.
- Fixture-loop principle (Sprint 19): every real page that converts badly
  becomes a committed fixture + regression test.

---

## 4. Roadmap & go/no-go gates

- **Phase 0 — This document.**
  ▸ *Gate G0:* owner reviews & approves the plan. **No code before G0.**

- **Phase 1 — Spike (`sheet-ocr-importer.html`).** Self-contained page
  implementing intake → projection staff detection → strip isolation →
  sequential OCR → regex/normalize → overlay UI → JSON + CSMPN output.
  Validated against **2–3 real songbook scans supplied by the owner** (which
  become fixtures).
  ▸ *Gate G1 (go/no-go for the feature):* ≥ ~80% chord recall after
  normalization on the real pages, staff detection visibly correct on the
  overlay, and no crash/reload on iPad Safari with a 300 DPI page. If OCR
  accuracy is unsalvageable here, stop — the honest alternatives (better
  source formats: GP/MusicXML/PDF-text importers) already exist in the family.

- **Phase 2 — Hardening.** Deskew, adaptive threshold, barline detection
  (v2 measure mapping), confusion-repair map, fallback ladder, extraction of
  pure logic into `sheetOcr.js` + vm unit tests, CI wiring (`node --check`
  list + deploy `cp` + `verify-deploy-assets`).
  ▸ *Gate G2:* all four repo gates green (`lint` · `format:check` · `build` ·
  `test:all`) + iOS Safari smoke test of the full flow.

- **Phase 3 — Family integration.** Import-menu entry (power-only) or link
  from the main app; CSMPN emission + `csm:handoff:v1` one-tap load; CSP
  additions to `index.html` **only if** the tool moves in-page (else it stays
  a linked standalone page and no CSP change is needed).
  ▸ *Gate G3:* zero regressions in the existing 1,068-test suite; handoff
  round-trip verified.

- **Phase 4 (optional, demand-driven).** Multi-page batching UI, manual-ROI
  editor polish, per-chord confidence display, PDF-page rasterization intake
  (pdf.js render → same pipeline).

---

## 5. Panel's closing consensus

The riskiest link is **OCR accuracy on engraved chord fonts** (Risks 2–3), and
it is exactly the link that cannot be de-risked on paper — hence the tight
Phase 1 spike against real scans with a hard G1 gate. Everything around it
(slicing, normalization, timeline, UI, family integration) is either
well-understood image math or code this repo already owns. Build the thin new
part, measure it honestly, and let the gate decide.

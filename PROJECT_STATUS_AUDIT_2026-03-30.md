# Project Status Audit — UG → CSMPN Importer Suite

**Audit date:** 2026-03-30  
**Repo:** `chord-sheet-maker-pro`  
**Scope reviewed:** app entrypoints, import pipelines, parser stack, importer UI, standalone UG importer page, tests, docs.

---

## Executive Findings

The repository contains a **working UG Pro PDF importer** in two forms:
1. A standalone HTML tool (`public/ug-pro-importer.html`) with rich debug UX.
2. A React-integrated importer (`src/components/UGProImporterPanel.tsx` + `src/ingest/ugProPdfImporter.ts`) routed by the main app.

However, the repo **does not contain the claimed dedicated `ug-txt-importer.html` v1.1 converter deliverable**. TXT/UG-style text is currently handled by the shared parser pipeline (`sniffFormat` + `parseChordChart`) rather than a standalone TXT converter with explicit median-gap spacing inference controls.

Bottom line: the “Phase 1 complete, both importers production-ready” claim is **partially true for PDF**, but **not fully supported for a separate TXT importer deliverable as described**.

---

## Checklist Validation Against Provided Criteria

## 1) Deliverables Status

### PDF Importer (`ug-importer.html` equivalent)
- [x] PDF.js extraction with coordinate-based processing exists.
- [x] Chord classification and normalization exist.
- [x] Y-based system clustering exists (configurable threshold).
- [x] Image-based barline detection exists.
- [x] Chord-to-measure mapping exists.
- [x] Debug JSON output exists.
- [x] Visual debug overlay exists.
- [x] Configurable parameters with reprocessing exist.
- [~] Section naming from rehearsal marks exists; fallback differs by implementation (`Chords` in standalone vs `Chorus 1` in TS importer).
- [ ] DS/DC/Coda expansion not implemented (markers only).
- [ ] 1st/2nd ending expansion not implemented.

### TXT Converter (`ug-txt-importer.html`)
- [ ] Dedicated standalone TXT converter file not found in repo.
- [x] UG/chord text ingestion exists via shared parser (`ultimateguitar`, `chordpro`, `chords-over-words`, `fakebook`).
- [ ] No evidence of the claimed standalone v1.1 feature set (filename schema parsing, explicit median-gap UI knobs, section-reference repeat expansion workflow as a dedicated tool).

---

## 2) Technical Architecture Claims

- [x] Deterministic parsing approach is consistent with implementation style.
- [x] Stateless client-side architecture is true (no backend required for core import path).
- [x] Visual validation is present for UG Pro PDF flow.
- [~] “Single-file HTML deployment” is true for standalone importer, but app also ships as Vite React app.

---

## 3) Progress by Component (Reality Check)

- [x] PDF extraction + mapping pipeline is implemented and integrated.
- [x] Chord normalization exists.
- [x] Section splitting/parsing exists for text formats.
- [~] Repeat handling: parser supports repeat barline tokens in fake-book parsing, but full roadmap jump-resolution/graph expansion is not implemented.
- [x] Debug overlays available for PDF importer.
- [x] UI controls for parameters and output are present.

---

## 4) Risks / Gaps Found in Current Codebase

### High-priority gap
- Missing dedicated TXT importer deliverable as described in the status narrative.

### Medium-priority
- Divergence between standalone importer (`public/ug-pro-importer.html`) and TS/React importer (`src/ingest/ugProPdfImporter.ts`) can cause behavioral mismatch over time.
- No automated tests currently cover UG PDF importer correctness or parser edge cases; only VexFlow notation tests are present.

### Low-priority
- Some roadmap claims in docs are ahead of what is concretely test-validated in this repo (accuracy percentages are not backed by test fixtures/benchmarks in-tree).

---

## Quick Fixes Applied Immediately (this audit)

1. **Chord normalization correction** in TS UG PDF importer: bare `maj` no longer auto-upgrades to `maj7` (now strips optional `maj`, e.g. `Cmaj → C`).
   - This aligns behavior with stated intent and avoids harmonic inflation.

---

## What You Can Realistically Do Right Now

- Import UG Pro PDFs through the integrated panel and inspect overlays/debug JSON.
- Import `.txt/.pro/.cho/.abc` as chord-chart text through shared parser routes.
- Export/continue chart finishing workflow inside app.

## What You Cannot Reliably Claim Yet

- That a standalone, production-ready TXT importer v1.1 (as described) is present in this repository.
- That stated PDF/TXT accuracy percentages are validated by reproducible in-repo benchmark tests.

---

## Recommended Next Actions (Priority Order)

1. **Create or restore dedicated TXT importer deliverable** (`public/ug-txt-importer.html`) if that product promise must be kept.
2. **Add importer fixture tests** for UG PDF and UG TXT real-world samples with expected CSMPN outputs.
3. **Unify logic** between standalone and TS importer to reduce divergence.
4. **Document actual shipped capability vs roadmap** in README/release notes to avoid status mismatch.


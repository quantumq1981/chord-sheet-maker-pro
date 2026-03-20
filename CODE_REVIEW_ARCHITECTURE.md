# Architecture Code Review — Chord Sheet Maker Pro

**Branch:** `claude/code-review-architecture-iXCuJ`
**Date:** 2026-03-20
**Reviewer:** Claude (Sonnet 4.6)

---

## 1. Executive Summary

Chord Sheet Maker Pro is a browser-based React + TypeScript + Vite application for importing, displaying, transposing, and exporting chord charts. The codebase is well-intentioned and covers an impressive range of input formats, but has accumulated significant architectural debt. The primary concern is a bifurcated codebase with two parallel UIs (`index.html` vanilla JS and the `src/` React app) that are not reconciled. Secondary concerns include a monolithic `App.tsx`, weak type safety in critical paths, and a scattered data-flow model. The recommendations below are ordered by impact.

---

## 2. High-Level Architecture Map

```
┌──────────────────────────────────────────────────────────────────┐
│                        Browser Entry Points                       │
│  index.html (vanilla JS, ~self-contained)                        │
│  app.html   (React SPA via src/main.tsx → src/App.tsx)           │
└────────────────────┬─────────────────────────────────────────────┘
                     │
         ┌───────────▼───────────┐
         │   Format Detection    │
         │  src/ingest/sniffFormat.ts  │
         └───────────┬───────────┘
      ┌──────────────┼──────────────────┐
      ▼              ▼                  ▼
  PDF path      MusicXML path     Text chart path
  (pdf.js)      (OSMD + converter) (ChordPro/ABC/UG/CSMPN)
      │              │                  │
  extractTextFromPdf │          ┌───────┴────────┐
  ugProPdfImporter   │          │  parsers/       │
  oemerBridge        │          │  chordProParser │
      │         musicXML        │  abcParser      │
      │         tochordpro      │  csmpnParser    │
      │              │          │  gpParser       │
      └──────────────┴──────────┘
                     │
         ┌───────────▼───────────┐
         │  ChordChartDocument   │  ← normalized model
         │  (ChordChartModel.ts) │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────────┐
         │  ChordChart.tsx       │  ← React renderer
         │  (chord-over-lyric)   │
         └───────────────────────┘
                     │
         Export: PDF (jsPDF), PNG (canvas), print, ChordPro text
```

---

## 3. Findings

### 3.1 Two Parallel UIs — Critical

**File:** `index.html` (vanilla JS) vs `src/App.tsx` (React)

`index.html` is a self-contained ~2500-line vanilla JS application with its own parsers, renderers, export logic, and import pipeline baked in. `src/App.tsx` is a separate React app with its own equivalent pipeline. They share no code, evolve independently, and carry duplicate logic (e.g., ChordPro parsing, transpose, PDF export).

**Impact:** Every feature or bug fix must be applied twice. The vanilla app already has capabilities (User/Power mode, diagnostics panel, feature modals) not present in the React app, and vice versa.

**Recommendation:** Designate one as the canonical product. Given that `src/` uses proper TypeScript, a normalized model, and a component architecture, it should be the target. `index.html` should be ported or deprecated. If the vanilla app must remain as a fallback, extract shared logic into a published package.

---

### 3.2 `App.tsx` Is a God Component — High

**File:** `src/App.tsx` — **1,375 lines**

`App.tsx` contains: file ingestion, format sniffing, all parser invocations, OSMD lifecycle management, PDF export, PNG export, print logic, transpose state, ChordPro conversion UI state, and layout. This violates single-responsibility and makes the file difficult to test, reason about, or extend.

**Recommendation:** Extract into focused modules:
- `useFileIngestion` hook — format sniffing + parser dispatch
- `useOsmdRenderer` hook — OSMD lifecycle (load, resize, print profile)
- `useExport` hook — PDF, PNG, print handlers
- `<SettingsPanel>` component — all conversion/display settings
- `<ToolbarActions>` component — button row

---

### 3.3 `ugProPdfImporter.ts` Is a Standalone Pipeline — High

**File:** `src/ingest/ugProPdfImporter.ts` — **914 lines**

This file re-implements its own PDF loading (separate `GlobalWorkerOptions.workerSrc` assignment from `extractTextFromPdf.ts`), its own chord detection regex, its own page rendering, and returns a bespoke `{ csmpnText, debugJson, pageRenders }` shape that bypasses the normalized `ChordChartDocument` model. The `UGProImporterPanel.tsx` component is a 678-line self-contained widget that manages its own state, config, and output display.

**Impact:** UG Pro import results cannot be composed with the generic transpose, export, or rendering pipeline without a conversion step.

**Recommendation:** Emit a `ChordChartDocument` directly from the importer instead of CSMPN text, or at minimum run the CSMPN text through `csmpnParser` immediately and discard the intermediate string at the pipeline boundary. Unify PDF worker initialization into a single shared module.

---

### 3.4 `ChordChartModel.ts` Is Underused — Medium

**File:** `src/models/ChordChartModel.ts` — 102 lines

The model is clean and well-typed. However, several parsers and converters bypass it:
- `musicXmlToCsmpnFakebook.ts` (159 lines) produces raw CSMPN text, not a `ChordChartDocument`.
- `converters/musicXMLtochordpro.ts` (1,291 lines) produces ChordPro text, not a `ChordChartDocument`.
- `ugProPdfImporter.ts` produces CSMPN text.

Only `chordProParser.ts`, `abcParser.ts`, and `csmpnParser.ts` produce the model. The model therefore only covers part of the pipeline, reducing its value.

**Recommendation:** Make `ChordChartDocument` the universal output contract for all parsers and converters. The serializers (`serializeChordPro.ts`) can convert it outward to text formats.

---

### 3.5 `sniffFormat.ts` Has a Detection Gap — Medium

**File:** `src/ingest/sniffFormat.ts` — 302 lines

The `SourceFormat` type exported by `sniffFormat.ts` includes `'oemer-image'`, but `DetectedFormat` does not include `{ format: 'oemer-image' }`. This means the format is never returned by `sniffFormatFromBytes` or `sniffFormatFromText`, making OEMER image input only reachable via the dedicated `OemerImageImporterPanel` side-path. If a user drops an image file on the main file input, it will fall through to `unknown` and fail silently.

**Recommendation:** Add image MIME/extension detection (`image/png`, `image/jpeg`, `.png`, `.jpg`, `.jpeg`) to `sniffFormat.ts` and route the result to the OEMER bridge from `App.tsx`.

---

### 3.6 Duplicate PDF Worker Initialization — Medium

**Files:** `src/ingest/extractTextFromPdf.ts` and `src/ingest/ugProPdfImporter.ts`

Both files independently set `GlobalWorkerOptions.workerSrc`. If both are imported (which they are in `App.tsx`), the second assignment silently wins. If module order changes, behavior may differ.

**Recommendation:** Centralize `GlobalWorkerOptions.workerSrc` in a single `src/ingest/pdfWorker.ts` init module and import it once from `src/main.tsx`.

---

### 3.7 `musicXMLtochordpro.ts` Is Disproportionately Large — Medium

**File:** `src/converters/musicXMLtochordpro.ts` — **1,291 lines**

This converter is the largest source file. It is structured as a monolithic function with many nested helpers. While its internal comments are good, the size makes the harmony-extraction and repeat-expansion logic hard to audit.

**Recommendation:** Split into sub-modules: `src/converters/musicxml/harmonies.ts`, `src/converters/musicxml/repeats.ts`, `src/converters/musicxml/formatter.ts`.

---

### 3.8 Source PDF Files in `src/` — Low

**Files:** `src/*.pdf` (6 files — Al Green, Charlie Parker, Robben Ford, etc.)

Six PDF files are stored directly in the `src/` directory, which is processed by Vite as source code. These are test fixtures/samples but are treated as source assets. They will be included in builds unnecessarily.

**Recommendation:** Move to `public/samples/` (served statically) or `tests/fixtures/` (not bundled at all).

---

### 3.9 TypeScript Strictness — Low

**File:** `tsconfig.app.json`

The `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` options are not enabled. Several files use `as unknown as X` casts (e.g., `App.tsx:115-121`, engraving rules workarounds), indicating places where the type model is fighting the OSMD API surface.

**Recommendation:** Enable stricter options incrementally and replace unsafe casts with proper type guards where OSMD types permit.

---

## 4. Positive Observations

- **`ChordChartModel.ts`** is clean, well-documented, and covers the key concepts (tokens, lines, sections, tab columns). It's a solid foundation.
- **`sniffFormat.ts`** has clear detection priority ordering, good comments, and handles edge cases (GP binary magic, MXL ZIP detection).
- **`ChordChart.tsx`** is a focused, single-responsibility rendering component with a clear layout model documented at the top.
- **`chordProParser.ts`** and **`abcParser.ts`** are well-structured parsers that correctly target the normalized model.
- **`ugProPdfImporter.ts`** shows sophisticated image analysis thinking (vertical projection, Y-cluster barline detection) — the algorithm is good even if the integration is not.
- All parsers include inline documentation headers describing their pipeline stages.

---

## 5. Priority Action List

| # | Issue | File(s) | Priority |
|---|-------|---------|----------|
| 1 | Reconcile two parallel UIs | `index.html` / `src/` | Critical |
| 2 | Break up `App.tsx` | `src/App.tsx` | High |
| 3 | Route UG Pro output through `ChordChartDocument` | `ugProPdfImporter.ts` | High |
| 4 | Make `ChordChartDocument` the universal output | All parsers/converters | Medium |
| 5 | Add image format detection to `sniffFormat.ts` | `sniffFormat.ts` | Medium |
| 6 | Centralize PDF worker init | `extractTextFromPdf.ts`, `ugProPdfImporter.ts` | Medium |
| 7 | Split `musicXMLtochordpro.ts` | `converters/` | Medium |
| 8 | Move sample PDFs out of `src/` | `src/*.pdf` | Low |
| 9 | Enable stricter TypeScript options | `tsconfig.app.json` | Low |

---

## 6. File-Level Summary

| File | Lines | Role | Health |
|------|-------|------|--------|
| `src/App.tsx` | 1,375 | Entry component + all logic | ⚠ Too large |
| `src/converters/musicXMLtochordpro.ts` | 1,291 | MusicXML → ChordPro text | ⚠ Too large |
| `src/ingest/ugProPdfImporter.ts` | 914 | UG Pro PDF → CSMPN | ⚠ Bypasses model |
| `src/components/UGProImporterPanel.tsx` | 678 | UG Pro import UI | ⚠ Too much state |
| `src/parsers/chordProParser.ts` | 546 | ChordPro → ChordChartDocument | ✓ Good |
| `src/parsers/abcParser.ts` | 485 | ABC → ChordChartDocument | ✓ Good |
| `src/parsers/gpParser.ts` | 422 | Guitar Pro binary → ChordChartDocument | ✓ Good |
| `src/renderers/ChordChart.tsx` | 412 | React chord renderer | ✓ Good |
| `src/ingest/sniffFormat.ts` | 302 | Format detection | ✓ Good, minor gap |
| `src/parsers/musicXmlToCsmpnFakebook.ts` | 159 | MusicXML → CSMPN text | ⚠ Bypasses model |
| `src/components/OemerImageImporterPanel.tsx` | 140 | OEMER image import UI | ✓ Acceptable |
| `src/ingest/oemerBridge.ts` | 81 | OEMER Python bridge | ✓ Focused |
| `src/ingest/extractTextFromPdf.ts` | 85 | PDF text extraction | ✓ Focused |
| `src/models/ChordChartModel.ts` | 102 | Normalized data model | ✓ Clean |
| `src/parsers/csmpnParser.ts` | 179 | CSMPN → ChordChartDocument | ✓ Good |
| `src/parsers/serializeChordPro.ts` | 107 | ChordChartDocument → ChordPro text | ✓ Good |
| `src/utils/fretToChord.ts` | 122 | Fret → chord name lookup | ✓ Focused |
| `src/utils/sectionUtils.ts` | 32 | Section label helpers | ✓ Trivial |

---

*End of report.*

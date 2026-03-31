# NotaGen Integration Opportunities for chord-sheet-maker-pro

Date: 2026-03-31

## Why NotaGen is relevant

NotaGen is primarily an **ABC-centric symbolic music generation stack** that also provides tooling around **ABC ⇄ MusicXML conversion** and demo workflows that can output rendered assets such as score previews/audio in companion integrations.

Your app is already a strong **finishing app** with broad import support (MusicXML, ABC, Guitar Pro, PDF/OEMER, SVG, and chord/text formats), so the biggest value is not replacing existing importers, but adding a **normalization layer** that improves conversion reliability and format portability.

## High-impact features to integrate first

### 1) ABC normalization profile (pre-ingest clean pass)

What to borrow from NotaGen ecosystem behavior:
- Its training/inference pipelines depend on predictable ABC structure.
- Its post-processing emphasizes consistency before downstream conversion/scoring.

What to add in this repo:
- A new `normalizeAbcForImport(text)` step before `abcParser`.
- Canonicalize headers (`X:`, `T:`, `M:`, `K:`, `L:`), barline spacing, tuplet/slur artifacts, and chord-annotation quoting.
- Preserve original text + normalized text so users can diff/revert.

Why it helps:
- Better parse stability on messy ABC from generators/tools.
- Fewer dropped chords/lyrics during `extractBarChords` and lyric alignment.

### 2) Round-trip converter pipeline (ABC ⇄ MusicXML ⇄ CSMPN)

What to borrow:
- NotaGen documents ABC↔MusicXML workflow as a core preprocessing/postprocessing path.

What to add:
- A selectable import strategy:
  1. direct ABC parse (fast path)
  2. ABC→MusicXML→existing `convertMusicXmlToChordPro` (fallback path)
- Automatic fallback when direct ABC parse confidence is low.

Why it helps:
- Improves interoperability with generated ABC that is syntactically valid but semantically odd for your current parser.
- Lets OSMD/MusicXML diagnostics path catch structural errors earlier.

### 3) Structured quality score for imports

What to borrow:
- NotaGen’s RL stage relies on model-quality signals (CLaMP-based ranking).

What to add (lightweight, deterministic):
- Import-quality heuristic score (0–100) based on:
  - chord token coverage
  - lyric alignment success
  - measure continuity/repeat validity
  - section-label confidence
- Show score and warnings before final “Use This Chart”.

Why it helps:
- Gives users immediate signal on whether they should use Power Mode cleanup or switch parser strategy.

### 4) Batch ingest mode for setlist workflows

What to borrow:
- NotaGen tooling expects dataset-scale processing and index files.

What to add:
- Batch importer that accepts many source files and emits:
  - normalized CSMPN/chord chart artifacts
  - import diagnostics JSONL index
  - **setlist-ready CSV** rows (title, key, tempo, time, source format, confidence, warnings)

Why it helps:
- Directly aligns with your setlist-generator requirement.
- Turns one-off song import into predictable library/setlist preparation.

### 5) Prompt-to-template “style starter” (optional)

What to borrow:
- NotaGen uses `Period-Composer-Instrumentation` conditioning.

What to add:
- Not full generation, but a template assistant that maps style prompts to chart defaults:
  - default key handling rules
  - preferred bars-per-line
  - section naming conventions
  - swing/feel metadata labels

Why it helps:
- Faster first draft formatting for fake-book output without introducing heavy model inference requirements.

## Format optimization opportunities (specific to your current code)

1. **Unify semi-structured text and ABC cleanup in one staged parser**
   - You already detect UG/chords-over-words/chordpro/abc in `sniffFormatFromBytes`.
   - Add a shared preprocessor stage so every text-based format benefits from normalization.

2. **Dual-path PDF extraction confidence**
   - Keep current PDF text extraction and OEMER image path.
   - Add retry pipeline: PDF text → staged parser; if low confidence, OCR/OMR pass and merge best result.

3. **Canonical internal song schema before rendering/export**
   - Normalize every source into one strict intermediate schema (sections/measures/chords/lyrics/metadata).
   - Then emit CSMPN, ChordPro, CSV, and future JSON export from the same canonical model.

4. **CSV-first metadata guarantees**
   - Require non-empty title + normalized key/time for CSV export.
   - Add deterministic fallback values and warning flags for missing metadata.

## Implementation order (practical roadmap)

1. Add import confidence scoring + warnings.
2. Add shared normalization layer for ABC and text-like inputs.
3. Add batch mode with diagnostics index + setlist CSV output.
4. Add ABC→MusicXML fallback pipeline.
5. Add optional style-template assistant.

## What *not* to do first

- Don’t attempt to run large NotaGen model inference inside this app initially.
- Don’t couple UI rendering to external GPU/model availability.
- Don’t add many new one-off format importers before the shared normalization pipeline exists.

## Success metrics

- Higher percentage of imports that produce usable charts without manual edits.
- Lower user time from source file → printable fake-book output.
- Fewer CSV rows with missing key/tempo/time metadata.
- Better consistency across mixed setlist source formats.

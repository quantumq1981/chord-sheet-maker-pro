# Codex Session Log

## Session Date
2026-04-24

## Completed Work

### Hybrid Rhythm Guitar Chart v1 (initial implementation)
- Added **Hybrid Rhythm Guitar Mode** and **Hybrid Rhythm Preset** settings controls in `index.html` and persisted values in `settings.js`.
- Implemented a new parser path in `importPipeline.js`:
  - `parseHybridChartFromCSMPN(text)`
  - Beat parsing and duration normalization helpers
  - Hybrid bar event parsing for slash/rest, accents, sustain, PM markers, tab shape cues, and cue text
  - Validation warnings for invalid beats, unsupported durations, malformed tab data, and out-of-range cue/tab/bar references
- Implemented hybrid render path in `renderer.js`:
  - Mode-gated rendering in `updatePreview()`
  - New hybrid-system rendering with beat-positioned chord symbols, slash/rest glyphs, accent marks, PM dashed line, optional tab events, and section/bar cues
- Added hybrid CSS styles in `index.html` for layout/readability and print-friendly break control (`break-inside` / `page-break-inside` guards).

### Tests and fixtures
- Added parser-focused test file: `tests/hybridParser.test.mjs`.
- Added three demo fixtures:
  - `tests/fixtures/txt/hybrid-pop-strum.csmpn`
  - `tests/fixtures/txt/hybrid-muted-funk.csmpn`
  - `tests/fixtures/txt/hybrid-guitar-cue.csmpn`

## Fully Implemented
- Data model for hybrid bars/events (slash, rest, accent, sustain/hold proxy, PM span/bar, tab cue, cue text).
- Human-editable `{hybrid ...}` block syntax.
- Parser validation and warning collection.
- Renderer support for beat placement, slash durations (w/h/q/e/s), explicit rests, accent symbols, PM indicator, selective tab rows, section/bar cues.
- Backward-compatible fallback: legacy rendering remains unchanged when hybrid mode is off or hybrid block is absent.

## Partially Implemented
- PM spans are parsed but rendered as a bar-level dashed PM indicator for v1 clarity.
- Slash notation rendering uses a lightweight HTML glyph approach rather than full engraved SVG beaming logic.
- Sixteenth-note support is accepted in parser/renderer glyph mapping but without advanced beaming/grouping semantics.

## Intentionally Deferred (v1)
- Tuplets/swing interpretation engine.
- Full engraved rhythmic beaming and advanced articulation grammar.
- Automatic fingering and dense transcription/tab authoring workflows.
- Deep MusicXML export parity for hybrid rhythm events.

## Known Limitations
- Hybrid parser currently maps each `{hybrid}` block to sections in order; if section ordering is heavily non-linear this may require a future explicit section binding key.
- Existing slash-notation panel/export path is unchanged; hybrid rendering is currently integrated in the main preview/print path.

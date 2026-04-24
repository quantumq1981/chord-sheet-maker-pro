# Codex Session Log

## Session Date
2026-04-24

## Completed Work

### Hybrid Rhythm Guitar Chart v1 (initial implementation)
- Added **Hybrid Rhythm Guitar Mode** and **Hybrid Rhythm Preset** settings controls in `index.html` and persisted values in `settings.js`.
- Implemented a parser path in `importPipeline.js`:
  - `parseHybridChartFromCSMPN(text)`
  - Beat parsing and duration normalization helpers
  - Hybrid bar event parsing for slash/rest, accents, sustain, PM markers, tab shape cues, and cue text
  - Validation warnings for invalid beats, unsupported durations, malformed tab data, and out-of-range cue/tab/bar references
- Implemented hybrid render path in `renderer.js`:
  - Mode-gated rendering in `updatePreview()`
  - Hybrid-system rendering with beat-positioned chord symbols, slash/rest glyphs, accent marks, PM dashed line, optional tab events, and section/bar cues
- Added hybrid CSS styles in `index.html` for layout/readability and print-friendly break control (`break-inside` / `page-break-inside` guards).

### Follow-up hardening (this session)
- Improved **syntax ergonomics** with aliases and shorthand tokens:
  - `bN:` for bars, `tN:` for tabs, `cN:` for bar cue, `sc:` for section cue
  - compact event form support (`1q(G)!`) in addition to canonical `1:q(G)!`
- Added an explicit syntax spec document: `docs/hybrid-rhythm-v1-spec.md`.
- Improved **visual collision handling** in renderer:
  - stacked chord rows when events are rhythmically dense
  - bar cue placement moved below rhythmic/tab lanes to reduce collision with chord line
- Added **print-specific hybrid CSS tightening** for system spacing/readability.
- Expanded parser tests to cover shorthand ergonomics and malformed-block graceful fallback (`active: false` when no valid entries survive).

### Tests and fixtures
- Parser tests: `tests/hybridParser.test.mjs`.
- Demo fixtures:
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
- Hybrid parser maps `{hybrid}` blocks to sections in source order; non-linear section references need explicit section IDs in a future revision.
- Existing slash-notation panel/export path is unchanged; hybrid rendering is integrated in main preview/print path.
- No iOS device-lab screenshot artifacts were generated in this environment due unavailable browser-container tooling.

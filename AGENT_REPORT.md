# AGENT_REPORT

## What changed
- Added `abcjs` CDN dependency and a hidden parse container (`#abc-hidden`) so ABC can be parsed/mined without touching the visible renderer.
- Extended file import acceptance/routing to detect `.abc` and `text/plain` with a `K:` header, then route through a new ABC miner and existing `SongModel -> toCSMPN -> textarea -> preview` flow.
- Implemented `mineABCToSongModel(abcText)` and helper functions to mine ABC metadata (`T`, `C`, `M`, `K`, `Q`) and bar-level chords from quoted tokens (`"Am"` etc.), grouped by `P:` section labels (or `- Main` fallback).
- Added a layered ABC extraction fallback with `ABCJS.renderAbc(...)` to try mining chord annotations when text-scan bars are too sparse, while warning and proceeding safely if no reliable chord data is exposed.
- Added explicit ABC import error reporting (`console.warn` + user-facing `ABC import failed: ...`) without changing fake-book rendering/layout logic.

## Anchors (functions + approximate line ranges)
- `fileInput.addEventListener('change', ...)` import router updates: ~1958-2021
- `mineABCToSongModel(abcText)`: ~2160-2236
- `firstABCHeaderValue(lines, letter)`: ~2238-2246
- `normalizeABCKey(rawKey)`: ~2248-2259
- `parseABCTempo(qValue)`: ~2261-2268
- `ensureABCSection(sectionMap, labelRaw)`: ~2270-2276
- `fallbackMineABCWithAbcjs(abcText)`: ~2278-2310

## How to test
1. Open the app in a browser.
2. Click **Import File** and choose a file named `test-blues.abc` with this exact content:

   ```abc
   X:1
   T:Test Blues
   C:Chris
   M:4/4
   Q:1/4=120
   K:Bb
   P:Intro
   "Bb7" B2 B2 | "Eb7" e2 e2 | "Bb7" B2 B2 | "F7" F2 F2 |
   P:Verse
   "Bb7" B2 B2 | "Eb7" e2 e2 | "Bb7" B2 B2 | "F7" F2 F2 |
   ```
3. Confirm metadata fields populate as expected: Title `Test Blues`, Composer `Chris`, Time `4/4`, Key `Bb`, Tempo near `120`.
4. Confirm generated CSMPN appears in source textarea with section labels and bars.
5. Confirm preview updates in existing fake-book grid (no layout/render behavior changes expected).
6. Re-test imports for `.pdf`, `.txt`, and `.musicxml`/`.xml` to ensure existing routes still function.

## Risks / known limitations
- ABC chord mining is intentionally pragmatic: it primarily extracts quoted chord symbols per measure; files without quoted chords may yield sparse bars.
- `P:` handling maps to simple section labels and does not implement full multi-part ABC playback semantics.
- Repeat handling is minimal and marker-preserving only; no full repeat expansion engine is added.
- `abcjs` fallback chord extraction depends on internal object shape and may not expose all chord annotations consistently across ABC variants.

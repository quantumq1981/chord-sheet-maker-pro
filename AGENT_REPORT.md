# AGENT REPORT

## Summary of changes
- Refined the UG Pro text miner to replace strict density-only gating with a **strict validity** chord-line classifier:
  - Added `isLikelyUGChordLine(line)` that scores each token as chord, structural, or noise.
  - Structural tokens include UG/tab notation like barlines, separators, parens, `%`, `xN`, `N.C.`, `stop`, `break`.
  - Accepts lines primarily composed of chords + structure and avoids lyric/noise lines.
- Added explicit structural-token regex constant: `RE_UG_STRUCTURAL_TOKEN`.
- Updated `mineUGProTextToSongModel(text)` to:
  - Use strict-validity chord-line gating instead of raw `density >= 0.75`.
  - Support sparse valid lines (including short single-chord lines) through classifier rules.
  - Keep barline-aware segmentation for `| ... |` and `_` joins for multi-chord segments.
  - Expand trailing `xN` repeats into concrete bars (e.g., `C G x2` => `C G C G`) instead of preserving symbolic repeats.
- Router refinement:
  - Retained fallback to legacy `importUGText` on sparse output/errors.
  - Kept fallback warning in console but removed user-facing error status for UG miner fallback failures to keep it quiet in normal usage.

## Anchors (function names + approx line ranges)
- Text router integration (`// txt` block): ~2009-2033
- `RE_UG_STRUCTURAL_TOKEN`: ~2093
- `isLikelyUGChordLine`: ~2095-2130
- `mineUGProTextToSongModel`: ~2132-2220

## Test steps + sample UG text cases
1. Ran a Node VM harness (with DOM stubs) that executes the page script, then calls `mineUGProTextToSongModel` directly and serializes via `toCSMPN({barsPerRow:4})`.

### Case 1 — Standard UG chord block
Input:
```
[Intro]
Am  D7  G  C

[Verse]
Am  D7  G  C
F   G   C  C
```
Observed:
- Sections: `- Intro`, `- Verse`
- Correct bars mined and grouped in CSMPN output.

### Case 2 — Barline separated
Input:
```
[Chorus]
| Am  D7 | G  C |
| F  G | C |
```
Observed:
- Segments mined as bars with split chords joined: `Am_D7`, `G_C`, `F_G`, `C`.

### Case 3 — Lyrics ignored
Input:
```
[Verse]
Am D7 G C
I woke up this morning feeling fine
F G C C
```
Observed:
- Lyric line rejected by strict validity classifier; chord lines mined.

### Case 4 — Sparse chord line with structural text
Input:
```
[Verse]
C (stop) Am
G
```
Observed:
- Line accepted; bars mined as `C`, `Am`, `G`.

### Case 5 — Trailing multiplier
Input:
```
[Outro]
C G Am F x2
```
Observed:
- Repeat expanded in model to 8 bars: `C G Am F C G Am F`.

## Edge cases / risks
- Structural whitelist is intentionally permissive for tab notation and could still admit some non-musical short marker lines; chord requirement mitigates this.
- `xN` expansion currently duplicates the entire mined phrase from that line; phrase-local repeat semantics beyond line scope are intentionally not inferred.
- If UG text has very unconventional section labels, they may be ignored and mined under the current section.

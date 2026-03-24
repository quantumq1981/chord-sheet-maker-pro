# Agent.MD — chord-sheet-maker-pro

Last updated: 2026-03-24

## Repo role

This repo is the **presentation / finishing app** for CSMP fake-book output.

Primary responsibilities:
- Render native CSMPN fake-book charts cleanly
- Provide final-user formatting controls
- Support gig-ready print / PDF / PNG output
- Offer Power Mode settings for layout cleanup after import/conversion

This repo should remain the place where a converted chart gets **finished and performance-ready**.

## Confirmed current strengths

- Fake-book rendering is already gig-usable
- Power Mode and Settings are valuable and should be preserved
- Landscape output is especially useful for dense harmonic material
- iOS / iPad / iPhone print-to-PDF workflow is practical and currently part of the real user workflow
- Successful real-world example: "Confirmation" chart was converted, adjusted in Pro, used on a gig

## Important workflow insight

Best current workflow:
1. Use the converter / normalizer app to ingest MusicXML or other structured notation
2. Convert into CSMPN
3. Move result into **Chord Sheet Maker Pro**
4. Use Settings / Power Mode / print sizing to finalize layout

This division of labor is working and should be strengthened, not blurred.

## Strategic direction agreed in session

### Keep stable
- Rendering engine
- Power Mode
- Settings / layout controls
- Export / Print / PDF / PNG workflow
- Final chart finishing behavior

### Deprioritize for now
These already exist but are not the main roadmap focus:
- iReal Pro polish
- OnSong polish
- OpenSong / OpenLyrics polish

They may remain supported, but they are not the highest-value formats for the real target workflow.

### Prioritize next
Build a **unified semi-structured chart parser** for:
- UG text
- copied chord-over-lyrics text
- chord-over-measure text
- chord dumps
- PDF-extracted text
- lightly messy plain-text song charts

Goal: reduce duplicated one-off import logic and improve real-world ingestion quality.

## Architecture decision

This repo should be treated as the **finishing app**.

The companion repo `chord-sheet-maker` should be treated as the **normalizer / converter workbench**.

That means:
- new parsing experiments should mature in the converter repo first when practical
- successful normalized CSMPN can then be moved into Pro for final layout
- Pro should avoid becoming a dumping ground for too many niche format-specific import branches

## Existing code paths worth reusing/refactoring

The current codebase already contains useful intake logic that should be refactored instead of replaced blindly:
- `importUGText`
- `mineUGProTextToSongModel`
- `isLikelyUGProText`
- `isLikelyUGChordLine`
- `hasInlineBracketChords`
- `extractBracketChords`
- `extractBracketLyrics`
- `isLikelyLyricsLine`

These form the starting point for the future unified parser.

## Mobile / environment constraints

Current primary user environment:
- iPhone iOS
- iPad / tablet iOS
- no reliable console/dashboard workflow right now
- print → Save as PDF is part of the real acceptance path

This means:
- visible outcomes matter more than terminal-only assurances
- export and layout must remain mobile-friendly
- regressions in print/PDF behavior are high priority

## Next implementation priorities

1. Document repo roles clearly across both repos
2. Audit duplicated import heuristics and identify consolidation points
3. Refactor UG / text parsing into a staged shared parser instead of more bolt-on import branches
4. Route PDF-extracted text into the same parser wherever possible
5. Keep renderer and Power Mode stable while ingestion is improved
6. Continue updating Agent.MD after meaningful sessions/tasks

## Guardrails

- Do not break the current fake-book layout success path
- Do not remove Power Mode or Settings
- Do not chase niche ecosystem formats at the expense of universal text/chart intake
- Favor refactoring shared helpers over adding more parallel import code
- Preserve iOS print/PDF usability

## Resume point for next session

Start by mapping the current importer architecture into three buckets:
- leave alone
- refactor / consolidate
- next-priority build

Primary build target: **UG / semi-structured text parser upgrade**

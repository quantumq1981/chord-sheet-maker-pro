# Muscriptor v0.4.0 — what it means for Chord Sheet Maker Pro (2026-10-25)

The full review, licence analysis and measurements are in the Tab Translator Pro repo:
`Tab-Translator-Pro/docs/MUSCRIPTOR-REVIEW.md`. This page covers only what lands here (the finish stage).

## Findings that bind

- **Muscriptor has no stem splitter.** Its per-instrument output comes from a multi-instrument
  *transcription* model (one MIDI track per instrument). The "zip of ~10 documents" is MuseScore 4
  engraving on their server: `score.mid`, `score.musicxml`, `full_score.pdf`, one PDF per part and a
  `_tab.pdf` per fretted part.
- **Code MIT, weights CC BY-NC 4.0** → the model can't ship in the family (owner rule: no
  non-commercial licences). It also could not run here: 412 MB fp32 for the *small* model,
  autoregressive decoding, no WASM threads on Pages.
- The parts we can use: the MIT beat/downbeat tracker (`beat_this`), Muscriptor's MIT
  post-processing algorithms (onset-delay/grid detection, tempo map, quantise strength, gap fill),
  and its output UX. Recognition work belongs in Tab Translator Pro; this app receives the result.

## Integration items for this repo

1. **Read Muscriptor's files directly** (a license-clean bridge: the user brings files made on
   muscriptor.kyutai.org, and we never call their service).
   - `.mid`: `midiImport.js` should already handle a Muscriptor MIDI. Bars are cut in **ticks**, so a
     tempo map cannot misplace bar lines, and channel 10 drums are dropped. Gaps: it reports only
     the *first* tempo (a tempo-mapped performance should show a median ♩=, or "rubato"); with no
     time-signature meta it assumes 4/4 (Muscriptor writes none when the meter is unclear, by design);
     every pitched track is merged for chord recognition, so a lead line can colour the chord.
     **Untested — needs one real Muscriptor `.mid` from the owner as a fixture**, per the fixture-loop rule.
   - `_sheets.zip`: unpack it (DecompressionStream, or STORED entries read directly) and route
     `score.musicxml` → `importMusicXML` (the part picker already selects written harmony / chordal
     parts) and `score.mid` → `midiImport`.
2. **Multi-part handoff from Tab Translator** (follows its P4 "All parts (zip)"): an optional,
   versioned `parts[]` addition to the `csm:handoff:v1` envelope (one CSMPN per instrument; old
   receivers ignore it) → land as a song with a part switcher, or one setlist entry per part.
   The contract change goes in `chord-sheet-maker/docs/HANDOFF-CONTRACT.md` first.
3. **Tempo-mapped charts**: when a chart arrives from Tab Translator with a tempo map, the playback
   scheduler (`audioPlayback.js buildSchedule`) and the MusicXML export should honour it. Until
   Tab Translator emits one, the data model only needs to *carry* it.

## Not for this repo

Beat/downbeat tracking, quantisation and audio transcription stay in Tab Translator Pro (one
engine, one place). Stereo-split "check by ear" playback needs the original recording, which
only Tab Translator has.

## Update 2026-10-25 — item 1 built

Muscriptor's `_sheets.zip` and `score.mid` now import through the re-vendored recognition engine on a
Harmony reading (every instrument except voice and drums), Pro chord names, spelled for the key —
F minor `Fm9 | Bbm9 | Fm7 | Bbm7 | Eb/F | Bbm7 | Db | Bb7/Ab | …` on the owner's file, the same chart Tab
Translator Pro gives. `midiImport.js` (fallback) now drops voice tracks, infers the key and spells for
it. Items 2 (multi-part handoff) and 3 (tempo map) remain.

## Update 2026-10-25 — items 2 and 3 built

- **Item 2, multi-part handoff.** `csm:handoff:v1` gains an optional `parts[]`
  (`[{ name, role, formats: { csmpn } }]`, at most 16). The envelope stays `v:1` and keeps `formats`
  (the band chart), so an older receiver just loads that. This receiver (`handoffParts.js`) files every
  part in the song library by its `Title:` line (replacing an entry with the same title), after the
  primary chart has loaded, and says so in the status line. Sender: Tab Translator Pro's stems panel,
  "→ Chord Sheet Maker Pro (all parts)". Checked end to end in a browser across both apps on one origin.
  The canonical `chord-sheet-maker/docs/HANDOFF-CONTRACT.md` (third repo) still needs the same note.
- **Item 3, tempo map.** CSMPN header `Tempo Map: 1=117.6 9=119.2 …` (bar=♩, written by Tab
  Translator Pro when the performance tempo moves) → `doc.tempoMap` (`csmpnParser.js` + the TS twin)
  → `parseHybridChartFromCSMPN().tempoMap` → playback (`audioPlayback.js`, per-bar seconds-per-quarter,
  clamped 30–300) and MusicXML export (`renderer.js`, a `<sound tempo>` direction where it changes).
  Charts without the line behave exactly as before.

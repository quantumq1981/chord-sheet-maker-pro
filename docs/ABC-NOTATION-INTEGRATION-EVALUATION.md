# ABC Notation Integration — Evaluation & Roadmap

**Status:** Evaluation / proposal (no app code changed yet)
**Date:** 2026-06-14
**Branch:** `claude/abc-notation-integration-wdbmga`
**Scope:** Bring a comprehensive ABC notation solution to **Chord Sheet Maker Pro**
— rendering, editing, exporting, and playback — informed by (a) the *ABC
Transcription Tools User Guide* PDF and (b) the [RiffScore](https://github.com/joekotvas/RiffScore)
project.

---

## 1. Executive summary & recommendation

**Recommendation: build the ABC suite on [abcjs](https://www.abcjs.net/) inside the
canonical `index.html` track. Treat RiffScore as inspiration and an optional
future experiment on the secondary React (`app.html`) track — not as the core
dependency.**

Why, in one breath: the Pro app's primary surface is a **vanilla-JS, iOS-Safari-first,
zero-server static page**; abcjs is **already loaded** here (`abcjs@6.2.2`, lazy CDN),
is the exact engine the reference PDF tool is built on, and natively covers all four
requested pillars (render + edit + export + playback) with no framework. RiffScore is
a **React component library**, still **alpha** (`v1.0.0-alpha.16`), whose ABC/MusicXML
**import is "coming soon"** — an architectural and maturity mismatch for the primary
track.

| Pillar | abcjs (recommended) | RiffScore |
|---|---|---|
| **Render** | `ABCJS.renderAbc()` → SVG, mature, mobile-proven | SMuFL/Bravura, React-only, Page View has known multi-system defects |
| **Edit** | `ABCJS.Editor` (textarea ⇄ notation, bidirectional highlight) | WYSIWYG note entry (great UX) but React + alpha |
| **Export** | SVG/PNG, MIDI, plays-to-WAV via synth; MusicXML out via our own core | JSON / MusicXML / **ABC** export (ABC export is the useful bit) |
| **Playback** | `ABCJS.synth` (Web Audio + soundfonts), proven on iOS | Tone.js sampler |
| **Fits `index.html` (vanilla, iOS)** | ✅ already a dependency | ❌ React, needs build/bundle |
| **Maturity / license** | Stable, MIT/GPL dual | MIT, **alpha**, import not ready |

The PDF (Michael Eskin's *ABC Transcription Tools*) is the **north star for features**,
not for code: it's a closed, single-author app, but it proves what an abcjs-based ABC
workbench can do (tune trainer, transpose, tablature injection, soundfont selection,
PDF tunebooks, MusicXML/MIDI import). We mine it for a **feature backlog**, not a
codebase.

---

## 2. Where ABC stands in the family today

ABC is currently a **one-way import-only** citizen across the family — there is no
ABC *rendering*, *editing*, or *playback* surface anywhere yet.

| Repo | Current ABC support | Files |
|---|---|---|
| **Tab-Translator-Pro** | ABC **export** (`scoreToABC`) — emits real, playable ABC (chord tones + guitar-chord annotation, `Q:`/`K:`/`[M:]`), validated audibly. | `TabDecoderPro.tsx` |
| **chord-sheet-maker** | (none specific — MusicXML/GP focused) | — |
| **chord-sheet-maker-pro** | ABC **import** → CSMPN (`mineABCToSongModel` path in `index.html`; zero-dep `src/parsers/abcParser.ts` w/ modal-key + multi-voice handling, 21 tests). abcjs CDN already loaded as an import fallback but **not used for rendering/playback**. | `index.html` (line ~4129), `src/parsers/abcParser.ts`, `src/ingest/sniffFormat.ts` |

**Key existing assets we can reuse:**
- `abcjs@6.2.2` is **already in the CSP allow-list and the page** (lazy `defer` CDN
  script) — render + synth are essentially free to switch on.
- CSP already permits `cdn.jsdelivr.net` for `script-src`/`connect-src` and `data:`/`blob:`
  for `font-src`/`img-src` — abcjs soundfont fetch + SVG/PNG export work without CSP edits.
- `musicXmlCore.js` (`window.MusicXmlCore`) — shared MusicXML emitter, reusable for
  ABC→MusicXML.
- `audioPlayback.js` — existing Web-Audio synth (chart playback) gives us a fallback
  and a UX precedent for a Play button.

---

## 3. What the reference PDF proves is possible (feature backlog)

The *ABC Transcription Tools* guide is an exhaustive tour of a mature abcjs app. The
features worth porting, ranked by value-for-effort for **our** use case (chord charts
+ lead sheets, not a 75k-tune Irish session library):

**Tier 1 — core, high value, low/medium effort (all native abcjs):**
- ABC → standard-notation **rendering** (side-by-side editor + notation).
- **Bidirectional highlighting** — select ABC text ↔ highlight notes (abcjs built-in).
- **Playback** with transport (play/pause/seek/loop, tempo %) via `ABCJS.synth`.
- **Transpose** up/down semitone/step/octave (abcjs supports visual transposition).
- **Export**: SVG, PNG, MIDI, and audio (WAV) from the rendered tune.

**Tier 2 — strong differentiators, medium effort:**
- **Instrument tablature injection** (guitar/DADGAD/mandolin/uke/whistle…) — abcjs
  renders tab; aligns beautifully with our existing `{tab}` voicing work.
- **MusicXML / MIDI import** → ABC (the PDF converts MIDI→MusicXML→ABC). We already
  have MusicXML in both directions; MIDI is the new piece.
- **Soundfont / GM-instrument selection** for melody/bass/chords (the `%%MIDI program`
  directives) — maps cleanly onto a playback-settings panel.
- **Tune Trainer** (start slow → speed up, count-in, loop, phrase-by-phrase) — a real
  practice feature; pure transport logic over the synth.

**Tier 3 — nice-to-have / niche, defer:**
- PDF *tunebook* generation (title pages, TOC, QR codes), website export, 75k-tune
  search, tuning utilities, bagpipe/bodhran sound mapping. These are Eskin-specific;
  out of scope for a chord-chart finishing app.

**Adoption note:** the PDF's app is **not open source for reuse** — use it strictly as
a UX/feature reference. The reusable engine underneath it is **abcjs (MIT/GPL)**, which
we already ship.

---

## 4. RiffScore evaluation

**What it is:** a self-hostable, embeddable **React** sheet-music *editor* component.
TypeScript (~98%), `Tonal.js` (theory) + `Tone.js` (audio) + **Bravura/SMuFL**
engraving, `tsup` library build, Jest/Playwright tests, command-pattern core with
transaction batching and a fluent imperative API (`window.riffScore.get()`). **MIT.**

**Strengths:**
- Genuinely nice **WYSIWYG note-entry editing** (durations, accidentals, ties,
  transpose, Web-MIDI input) — better *authoring* UX than a raw ABC textarea.
- Click-to-edit **chord symbols** with letter / Roman / Nashville / solfège display —
  directly relevant to our chord-chart mission.
- **Exports ABC** (and MusicXML, JSON) — could be a clean ABC *producer*.

**Risks / blockers for our primary track:**
1. **React-only.** The Pro app's canonical surface is `index.html` (vanilla JS, iOS
   Safari, no build at runtime). RiffScore can only live on the **secondary**
   `app.html` + `src/` React track, which CLAUDE.md designates as secondary/test-only.
   Putting a flagship feature there violates Architectural Principle #2.
2. **Alpha maturity.** `v1.0.0-alpha.16` ("pre-release QA hardening"); **ABC & MusicXML
   import are "coming soon"**, clipboard + drag-move not done, Page View has "known
   layout defects on multi-system grand-staff scores." We'd be depending on unfinished
   surface area for exactly the import path we need.
3. **Bundle weight & two audio stacks.** Tone.js + Tonal + Bravura is a heavy add on
   top of abcjs; we'd run two synths (Tone.js vs abcjs/our Web-Audio) — divergent
   tuning, double the iOS audio-unlock edge cases.

**Verdict:** **Do not make RiffScore the core.** Keep it on the radar as a future
React-track *authoring* experiment once it hits a stable release **and** ABC import
ships. If we ever want a true WYSIWYG note editor (beyond text-ABC), revisit it then.
For now, abcjs delivers all four pillars on the right architecture today.

---

## 5. Recommended architecture (abcjs on `index.html`)

Follow the established module pattern (cf. `audioPlayback.js`, `musicFont.js`,
`chordSlashMLRenderer.js`): a **new root browser module** with a small, testable pure
core + a thin browser runtime, loaded `defer`/lazy, exposed on `window`.

```
abcSuite.js          (new) window.ABCSuite
  ├─ pure (unit-testable, no DOM/abcjs):
  │    abcHeader(meta)            build X:/T:/M:/L:/Q:/K: header
  │    csmpnToAbc(csmpn)          our chart → ABC (chord-symbol + slash/voiced notes)
  │    abcToCsmpn(abc)            reuse/share logic with src/parsers/abcParser.ts
  │    abcTranspose(abc, n)       text-level safety net (abcjs does visual transpose)
  └─ runtime (browser-only, lazy-loads abcjs if not present):
       renderAbc(el, abc, opts)   ABCJS.renderAbc → SVG
       attachEditor(taEl, paper)  ABCJS.Editor (bidirectional highlight)
       createAbcPlayer(visualObj) ABCJS.synth transport (play/pause/seek/loop/tempo)
       exportAbc{Svg,Png,Midi,Wav}()
```

**UI:** a Power-Mode **"𝄞 ABC Notation"** panel (mirrors the existing CSML Live Editor
panel): left = ABC textarea, right = live SVG notation, a transport bar, and an export
row. Wire **`← Convert & Load`** (ABC → CSMPN into the main chart) and **`⬆ From Source`**
(current CSMPN/CSML → ABC) so ABC joins the existing CSMPN ⇄ CSML ⇄ MusicXML round-trip
web. Reuse `musicXmlCore.js` for any ABC→MusicXML path.

**iOS / CSP / performance constraints (non-negotiable, per CLAUDE.md):**
- **Lazy-load abcjs** only on first ABC-panel open (it's already CDN-defer; keep idle
  cost zero). No new CSP rules needed (verified: `cdn.jsdelivr.net` + `data:`/`blob:`
  already allowed for script/connect/font/img).
- **iOS audio unlock**: resume `AudioContext` from the user gesture (same pattern as
  `audioPlayback.js`).
- **Print/PDF**: embed fonts in exported SVG (we already do this in `musicFont.js`);
  abcjs SVG is print-friendly. Primary export path stays iOS Safari print-to-PDF.
- **Tests-before-features**: every pure function (`csmpnToAbc`, `abcToCsmpn`,
  `abcHeader`, `abcTranspose`) gets a Node test under `tests/`. abcjs DOM/synth glue is
  browser-only smoke-tested (same category as the OSMD/Web-Audio glue).

---

## 6. Phased roadmap

| Phase | Deliverable | Effort | Notes |
|---|---|---|---|
| **A — Render** | `abcSuite.js` + ABC panel renders ABC → SVG (live, debounced); `.abc` files open in the panel (not just silently converted to CSMPN). | S | abcjs already loaded; mostly wiring + a panel. |
| **B — Playback** | Transport bar over `ABCJS.synth` (play/pause/seek/loop, tempo %), iOS audio-unlock. | S–M | Reuses our gesture/unlock precedent. |
| **C — Round-trip** | `csmpnToAbc` + `← Convert & Load` / `⬆ From Source`; ABC joins CSMPN⇄CSML⇄MusicXML. Share parsing with `abcParser.ts`. | M | Pure, fully unit-tested. |
| **D — Export** | ABC panel exports SVG / PNG / MIDI / WAV; ABC→MusicXML via `musicXmlCore.js`; `↓ Save .abc`. | M | Mirrors CSML editor export row. |
| **E — Editing polish** | Bidirectional highlight (`ABCJS.Editor`), transpose buttons, syntax help panel (like CSML help). | M | abcjs built-ins. |
| **F — Differentiators** | Instrument **tablature** rendering, **soundfont/GM** instrument picker, **Tune Trainer** (slow→fast, count-in, loop), **MIDI import**. | L | Tier-2 from §3; pick by demand. |
| **(Deferred)** | PDF tunebooks, website export, tune-library search, RiffScore React editor. | — | Tier-3 / out of scope for now. |

Phases A–C are the minimum for "comprehensive ABC" parity with the rest of the family's
formats; D–E make it first-class; F is where the PDF's standout features land.

---

## 7. Open decision for the maintainer

The one fork in the road worth confirming before building:

- **(Recommended) abcjs on `index.html`** — ships all four pillars on the iOS-first
  vanilla track today; RiffScore stays a future React-track experiment.
- **RiffScore on the React (`app.html`) track** — only if you specifically want
  WYSIWYG note-entry authoring and are willing to (a) wait for its stable release +
  ABC import, and (b) run a flagship feature off the secondary track.

Everything in §5–§6 assumes the recommended path. If you'd prefer the RiffScore route
(or a hybrid: abcjs for render/play on `index.html`, RiffScore for authoring on the
React track), say so and this plan is re-scoped accordingly.

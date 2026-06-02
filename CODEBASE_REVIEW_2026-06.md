# Chord Sheet Maker Pro — Deep Codebase Review

**Reviewer role:** Senior software architect / performance engineer
**Date:** 2026-06-02
**Branch:** `claude/chord-sheet-codebase-review-uHnjO`
**Scope:** Full repository, excluding `node_modules`, build output, `tests/` fixtures, and bundled binary sample files (`*.gp*`, `*.pdf`, `*.zip`).

> **Note on `CLAUDE.md`:** This repo carries an extensive `CLAUDE.md` with hard architectural rules. The most relevant constraints for this review are:
> 1. **`index.html` is the canonical app track** — the developer uses iOS/iPad only and has *no local console*; all feature work lives in the root vanilla-JS files (`index.html`, `settings.js`, `renderer.js`, `importPipeline.js`), **not** the React `src/` track (which exists for unit tests + a secondary `app.html`).
> 2. **All dynamic HTML must pass through `escapeHtml()`** — no raw interpolation.
> 3. iOS Safari is the primary browser; the only "CI console" is GitHub Actions.
> 4. Lazy-load heavy CDN libs.
>
> This review **respects these constraints**: recommendations target the vanilla `index.html` track, keep changes iOS-Safari-safe, and do not propose migrating the app to React. Where a recommendation appears to conflict with a rule (e.g. "split index.html"), the deviation is justified and kept compatible with the no-build, no-console workflow.

---

## 1. Tech Stack & Codebase Map

| Aspect | Finding |
|---|---|
| **Language** | JavaScript (ES2020+, browser globals, no modules in the root track) + TypeScript (`src/`) |
| **Primary app** | A single static HTML file, `index.html` (**7,328 lines / 295 KB**), loaded directly in the browser — no bundler in the runtime path for the canonical track |
| **Secondary app** | React 18 + TypeScript (`src/`, `app.html`) — used mainly for unit tests and the PDF-importer Vite page |
| **Build tools** | Vite 5 + `tsc -b` (TypeScript project references); ESLint 9 + Prettier 3 |
| **Test runner** | Node native `node --test` (`.mjs`) + `tsx` loader for `.ts` tests; ~677 tests |
| **Runtime deps** | `@coderline/alphatab`, `jspdf`, `jszip`, `opensheetmusicdisplay`, `pdfjs-dist`, `react`/`react-dom` |
| **CDN (runtime)** | pdf.js, html2canvas, jsPDF, abcjs, jszip, VexFlow — all loaded from `cdnjs`/`jsdelivr` via `<script>` tags |
| **Backend** | None in production. A single optional local helper exists: `scripts/oemer_helper.py` (Flask, localhost-only OMR bridge) |
| **Persistence** | Browser `localStorage` only (settings, song library, setlist, PIN, CSML styles) |

**Architecture summary:** This is a **purely client-side static application**. There is no server, no database, and no network API in the hot path. "Data-handling routes" in this review therefore map to **parse → transform → DOM/SVG render** pipelines, and "database calls" map to **`localStorage` reads/writes** and **`parseCSMPN()` re-parses**.

The codebase has a notable **dual-track duplication**: the canonical vanilla files (`csmpnParser.js`, `chordProcessing.js`, `chordSlashMLRenderer.js`, `importGuitarPro.js`) each have a near-twin in `src/parsers/` / `src/renderers/` / `src/utils/`. This is intentional per `CLAUDE.md` (TS twins exist for testability), but it is the single largest maintenance liability (see §2).

---

## 2. Critical Structural Issues, Security Risks & Legacy Anti-Patterns

### 2.1 Security

#### S-1 — No Subresource Integrity (SRI) on CDN scripts · **Security** · HIGH
- **Location:** `index.html:17–32` (6 `<script src="https://…">` tags)
- **Description:** Every third-party library (pdf.js, html2canvas, jsPDF, abcjs, jszip, VexFlow) is loaded from a public CDN with `crossorigin="anonymous"` and `referrerpolicy="no-referrer"` but **no `integrity=` hash**. `grep -c "integrity="` over `index.html` returns **0**.
- **Potential impact:** If `cdnjs.cloudflare.com` or `cdn.jsdelivr.net` (or a pinned package version) is compromised or hijacked, arbitrary JavaScript executes in the user's browser with full access to the editor contents and `localStorage`. For an app whose users paste/import copyrighted chart material, this is a real supply-chain XSS vector.

#### S-2 — No Content-Security-Policy · **Security** · HIGH
- **Location:** `<head>` of `index.html` (no `<meta http-equiv="Content-Security-Policy">`; `grep` for `content-security-policy` returns nothing)
- **Description:** There is no CSP meta tag. Combined with ~15 `innerHTML` assignments and 6 remote scripts, there is no defense-in-depth layer limiting script origins or inline execution.
- **Potential impact:** A single missed `escapeHtml()` (see S-3) becomes a fully exploitable stored-XSS, because nothing constrains where scripts may load from or whether inline event handlers run. A CSP would turn most such bugs into no-ops.

#### S-3 — Large `innerHTML` attack surface in a paste/import app · **Security** · MEDIUM
- **Location:** `index.html` (15 `innerHTML` sites, e.g. `2958`, `6470`, `6828`, `7213`), `renderer.js` (7 sites, e.g. `708`, `711`).
- **Description:** The app's core action is rendering **user-supplied / imported** content (UG text, MusicXML, ChordPro, Guitar Pro, `.csml`) into HTML/SVG via `innerHTML`. Audit shows the *sampled* sites correctly route dynamic text through `escapeHtml()` (e.g. setlist titles at `7213`, diagnostics at `2932`, chord tokens via `renderChordToken`). The risk is **structural, not a single confirmed hole**: with 22+ `innerHTML` sinks spread across two files and a stated rule that *all* dynamic HTML must be escaped, the invariant is enforced only by manual discipline. `renderSlashNotationHtml` builds a multi-kilobyte SVG string by hand and `innerHTML`s it at `6470`; any future contributor adding an un-escaped field re-opens XSS.
- **Potential impact:** Stored XSS via a malicious import file or a shared `.csml`/setlist entry. Impact is amplified by the absence of CSP (S-2).

#### S-4 — Plaintext PIN in `localStorage` · **Security** · MEDIUM
- **Location:** `index.html:3529–3535` (`PIN_STORAGE_KEY` get/set/remove)
- **Description:** A user "PIN" is stored verbatim in `localStorage` (`localStorage.setItem(PIN_STORAGE_KEY, pin)`). `localStorage` is readable by any script on the origin and persists indefinitely.
- **Potential impact:** If the PIN gates anything meaningful (lock screen / mode), it offers no real protection — it is trivially read from devtools or by any injected script. Storing a secret client-side in plaintext is a misleading security control.

#### S-5 — Silent `localStorage` write failures / no quota handling · **Security/Robustness** · LOW–MEDIUM
- **Location:** `saveSetlist` (`try{…}catch(e){}`), `saveLibrary` (`index.html:4562`), `settings.js:85`
- **Description:** Every `localStorage.setItem` is wrapped in a `try/catch` that **silently swallows** the error. The song library serializes **entire chart sources** to `localStorage` (`csmpn_library`) with no size budget. iOS Safari has a ~5 MB origin quota and is aggressive about evicting it.
- **Potential impact:** Silent data loss. A user saves several large imported charts, hits the quota, and the save fails with no feedback — they believe their setlist/library is persisted when it is not.

### 2.2 Structural

#### ST-1 — `index.html` is a 7,328-line God object · **Structural** · HIGH
- **Location:** `index.html` (markup + a single enormous `<script>` containing the app, the slash-notation IIFE, self-tests, and event wiring)
- **Description:** Despite Sprints 3–5 extracting `utils.js`/`chordProcessing.js`/`csmpnParser.js`/`renderer.js`/`importPipeline.js`, the main file still holds ~7.3k lines including the entire slash-notation engine (`renderRow`, `renderSlashNotationHtml`, `buildMusicXml`, `chordDiagramSvg`, …), the setlist manager, CSML editor wiring, and inline self-tests. There are **191 `getElementById` calls** in this one file.
- **Potential impact:** Very high cognitive load; merge conflicts; near-impossible to unit-test the slash engine (it lives in a closure). Any edit risks unrelated breakage, and the iOS-only developer cannot run a debugger.

#### ST-2 — Dual-track duplicated logic (vanilla ↔ TypeScript) · **Structural** · HIGH
- **Location:** `csmpnParser.js` ↔ `src/parsers/csmpnParser.ts`; `chordProcessing.js` ↔ `src/parsers/`; `chordSlashMLRenderer.js` ↔ `src/renderers/chordSlashMLSvgRenderer.ts`; `importGuitarPro.js` `_CHORD_PATTERNS` ↔ `src/utils/fretToChord.ts` (the latter explicitly documented as "inlined for browser-global compatibility").
- **Description:** Core algorithms exist twice — once as the browser source of truth, once as a TS twin "mirrored" by hand. `CLAUDE.md` itself repeatedly notes "browser IIFE mirrors it." There is no codegen or shared module guaranteeing the two stay in sync.
- **Potential impact:** Logic drift. A bug fixed in the TS test-covered copy can silently remain in the shipped vanilla copy (or vice-versa). Tests pass against code that is *not what users run*. This is the highest-leverage maintainability risk.

#### ST-3 — `importPipeline.js` is a 3,016-line, 71-function module · **Structural** · MEDIUM
- **Location:** `importPipeline.js` (71 top-level functions: every format importer + the canonical Song model + diagnostics)
- **Description:** All importers (UG, ChordPro, ABC, MusicXML, OnSong, OpenSong, OpenLyrics, iRealPro, ChordMark) plus the canonical model and diagnostics live in one file sharing mutable module state (`importDiagnostics`).
- **Potential impact:** Tight coupling through shared globals; hard to reason about which importer mutates diagnostics; difficult to lazy-load a single format.

#### ST-4 — Browser engine logic is untestable (lives in closures) · **Structural** · MEDIUM
- **Location:** `index.html` slash-notation IIFE (`chordsFromToken`, `buildSnSections`, `renderRow`, `renderSlashNotationHtml`, `buildMusicXml`)
- **Description:** The functions that actually render what users see are closure-scoped inside `index.html` and tested only indirectly via inline self-tests + TS twins. Per `CLAUDE.md` rule 4 ("tests before features — every new exported function gets a test"), this engine violates the spirit of the rule because it is not exported.

### 2.3 Legacy Anti-Patterns

#### A-1 — Pervasive `var` in `importGuitarPro.js` · **Anti-pattern** · LOW
- **Location:** `importGuitarPro.js` (**145** `var` declarations; it is the only file with significant `var` usage)
- **Description:** Function-scoped `var` throughout a 709-line module invites hoisting/TDZ confusion and accidental re-declaration. The rest of the codebase uses `const`/`let`.
- **Potential impact:** Subtle scoping bugs; inconsistent with the project style and ESLint config.

#### A-2 — RegExp recompiled inside nested loops · **Anti-pattern/Perf** · MEDIUM
- **Location:** `importPipeline.js:1957–1969` (`tag()`/`attr()` helpers inside `importMusicXMLRegex`)
- **Description:** `tag()` and `attr()` call `new RegExp(...)` **on every invocation**, and they are called inside `while` loops over measures × harmonies. (See §4/§5 for full analysis.)
- **Potential impact:** Thousands of redundant regex compilations on large scores; also brittle regex-based XML parsing where `DOMParser` exists.

#### A-3 — Manual DOM mutation + uncached element lookups · **Anti-pattern** · MEDIUM
- **Location:** `index.html` (191 `getElementById`), `renderer.js` (`document.querySelector('.sheet')` on every `updatePreview`)
- **Description:** Element handles are re-queried on every render rather than cached once. Full-subtree replacement via `innerHTML =` discards and rebuilds the DOM on each keystroke instead of patching.
- **Potential impact:** Extra reflows and GC churn on every preview update, most painful on lower-powered iPads.

#### A-4 — Full cache flush on chord-style change · **Anti-pattern/Perf** · LOW
- **Location:** `chordProcessing.js:517` (`_chordParseCache.clear()`), `settings.js:153`
- **Description:** When the cache exceeds 512 entries it is **fully cleared** (not LRU-evicted), and any Fake-Book style change calls `_chordParseCache.clear()`. The cache key is also rebuilt by string-concatenating 5 settings on *every* call.
- **Potential impact:** Cache thrash — a single style tweak throws away all parsed chords, forcing a full re-parse of the chart.

---

## 3. Prioritized Architectural Recommendations

### R-1 — Lock down the client: add CSP + SRI + a single sanitizing render helper
- **Addresses:** S-1, S-2, S-3.
- **Proposed solution:**
  1. Add a `<meta http-equiv="Content-Security-Policy">` to `index.html` restricting `script-src` to `'self'` + the two pinned CDNs, `object-src 'none'`, `base-uri 'none'`. Validate it does not break iOS Safari inline handlers (move any inline `onclick` to `addEventListener`, which the codebase largely already uses).
  2. Add `integrity="sha384-…"` + `crossorigin` to all six CDN `<script>` tags (hashes are deterministic for pinned versions).
  3. Introduce one audited helper, e.g. `setHTML(el, htmlString)`, and a `safeText()` wrapper, so the "everything goes through `escapeHtml`" rule is enforced in *one* place instead of 22 call sites. Add an ESLint `no-restricted-properties` rule flagging raw `.innerHTML =` outside that helper.
- **LOE:** ~2 days (1 day CSP/SRI + iOS regression testing on real device via GitHub Pages; 1 day to funnel `innerHTML` sites through the helper + lint rule).
- **Risk reduction / value:** Eliminates the supply-chain XSS vector (S-1), adds defense-in-depth (S-2), and makes the escaping invariant machine-enforced rather than manual (S-3). Highest security ROI.

### R-2 — De-duplicate the engine: make the TS parsers/renderers the single source, ship them to the browser
- **Addresses:** ST-2, ST-4, A-2 (indirectly).
- **Proposed solution:** Stop hand-mirroring. Build the canonical engine **once** in `src/` (TypeScript, fully unit-tested) and produce the browser globals (`window.parseCSMPN`, `window.csml`, GP converter, chord patterns) as a small Vite/`tsc` IIFE bundle that `index.html` loads via `<script>` — preserving the no-build *runtime* (the artifact is committed/deployed by CI, the iOS developer never runs a build). Delete the duplicated `.js` twins once parity tests pass. This keeps `CLAUDE.md`'s "no local console / GitHub Actions is CI" rule intact: the bundle is produced by the existing GitHub Actions pipeline.
- **LOE:** ~5–8 days (careful: requires byte-for-byte behavioral parity, golden-file tests comparing old vanilla output vs. new bundle output before deletion).
- **Risk reduction / value:** Removes the #1 maintainability liability — no more silent drift between tested code and shipped code. Makes the slash-notation engine genuinely unit-testable (ST-4) and lets the regex/perf fixes live in one place.

### R-3 — Decompose `index.html`'s script into feature modules + cache the parse layer
- **Addresses:** ST-1, ST-3, A-3, A-4, and the §4 hot paths.
- **Proposed solution:** Continue the Sprint-3/4 extraction: lift the slash-notation engine, setlist manager, and CSML-editor wiring out of `index.html` into named `<script>` files (e.g. `slashNotation.js`, `setlist.js`), exposing only the few `window.*` hooks `index.html` needs. As part of this, introduce a **memoized `parseCSMPN`** (last-text cache) and a cached DOM-handle registry, eliminating the repeated re-parsing and re-querying documented in §4–§5.
- **LOE:** ~4–5 days (mechanical extraction + the small memo/cache layer; lower risk than R-2 and can ship first).
- **Risk reduction / value:** Cuts the God-object cognitive load (ST-1), removes redundant full-document re-parses on every keystroke/transpose (perf), and reduces reflow/GC churn on iPad (A-3). Improves maintainability and the day-to-day perceived responsiveness of the editor.

---

## 4. Three Slowest / Most Bloated Data-Handling Routes (static analysis)

> Reminder: no backend exists, so these are **parse + render** paths. "Typical input" = a real chord sheet: ~40–200 bars, ~1–4 chords/bar, often imported.

### H-1 — `importMusicXMLRegex(xmlText)`
- **Location:** `importPipeline.js:1952–2034`
- **What it does:** Parses a MusicXML document with regular expressions: extracts metadata, then loops over every `<measure>`, and inside each measure loops over every `<harmony>` to build chord tokens.
- **Evidence of bloat / slowness:**
  - The `tag(src, name)` and `attr(src, tagName, attrName)` helpers call **`new RegExp(...)` on every call** (lines 1958, 1965) — i.e. a regex is *compiled* rather than reused.
  - These helpers are invoked inside the `while ((mm = measureRe.exec(t)))` loop and the inner `while ((hm = harmRe.exec(mContent)))` loop. Each harmony triggers ~6–8 `tag`/`attr` calls (`root-step`, `root-alter`, `kind`, `bass-step`, `bass-alter`, …).
  - Net: regex **recompilation count ≈ measures × harmonies × tagLookups**, plus repeated full-string scans. Regex-based XML parsing is also O(text length) per scan.

### H-2 — `doTranspose(delta)` → `transposeWholeText` → `updatePreview` → `renderSlashNotationHtml` (re-parse chain)
- **Location:** `doTranspose` `index.html:4332`; `transposeWholeText` `chordProcessing.js:221`; `updatePreview` `renderer.js:697`; `renderSlashNotationHtml` `index.html:5766`
- **What it does:** On each transpose button press it (a) re-transposes the entire source text, (b) re-extracts the header, (c) calls `updatePreview()` which **`parseCSMPN(text)`** and rebuilds the whole preview DOM, then (d) the slash panel hook re-runs `renderSlashNotationHtml` which calls **`parseCSMPN(text)` again** on the *same* text, and `buildMusicXml` would parse it a *third* time on export.
- **Evidence of bloat / slowness:**
  - `parseCSMPN` runs **2–3× on identical text** per single user action (confirmed: call sites at `renderer.js:710` and `index.html:5775`/`6011`, plus diagnostics). There is **no memoization** of the parse result.
  - `updatePreview` re-queries `document.querySelector('.sheet')` and replaces `previewEl.innerHTML` wholesale (full DOM teardown/rebuild) every time.
  - Each re-parse re-walks every line and token of the document.

### H-3 — `renderSlashNotationHtml(...)` multi-pass SVG build
- **Location:** `index.html:5766–5935`, plus `renderRow` (`5574`), `chordsFromToken` (`5479`), `chordDiagramSvg`
- **What it does:** Rebuilds the entire slash-notation SVG **as a string** on every preview refresh and every panel-control change.
- **Evidence of bloat / slowness:**
  - Multiple sequential passes over the data: `parseCSMPN` → `buildSnSections` → `processedSections.map` (per bar) → a separate loop building the `allVoicings` Map over **all** sections (`Object.entries(sec.tabVoicings)`) → row-grouping loop → a per-row `renderRow` loop that itself loops measures × beats.
  - For every chord in every bar it calls `chordsFromToken` → `parseChordToken` → `getChordFontFeatures` (the chord cache mitigates re-parse but the per-chord function-call + string-concat work is repeated each render).
  - The whole SVG is assembled by **string concatenation** (`svgContent += …`) and then `innerHTML`-assigned — O(total glyphs) string building + a full DOM parse of the resulting markup on each keystroke (debounced, but still a full rebuild).

---

## 5. Mathematical & Operational Analysis ("Why")

Let:
- **M** = number of measures/bars in a chart (typical 40, large 200+),
- **H** = harmonies (chords) per measure (typical 1–2, up to 4),
- **C = M × H** = total chords (typical ~80, large ~400),
- **T** = tag/attribute lookups per harmony (~8 for MusicXML),
- **L** = source length in characters.

### H-1 `importMusicXMLRegex` — **Time: O(M × H × T × L_local)** with a hidden compile cost
- The dominant cost is not just the loop count but that **each `tag`/`attr` call compiles a new RegExp** (`new RegExp(...)`) and then scans a substring. Regex *compilation* is far more expensive than execution; doing it `M × H × T` times is the core waste.
- For a 200-measure piece with 2 chords/measure and 8 lookups each: `200 × 2 × 8 = 3,200` regex **compilations** that should have been ~12 (one per distinct pattern, compiled once).
- **Space:** O(M) for the `bars` array — fine. The waste is purely CPU on the main thread, which on iOS Safari blocks the UI during import.
- **Operational reason:** No regex hoisting/caching; regex-as-XML-parser instead of the available `DOMParser` (used elsewhere in `src/`). Missing early exit and reuse.

### H-2 Re-parse chain — **Time: O(k × P)** where k = redundant parses (2–3), P = O(lines + tokens) of one parse
- `parseCSMPN` is **O(P)** where P ≈ total lines + total tokens. Running it **2–3× on the identical string** per transpose means **2–3× the necessary work** for zero benefit — a textbook redundant-computation smell, equivalent to "re-fetching the same row from the database three times in one request."
- A 200-bar chart with ~400 chord tokens and ~120 lines costs ~520 unit operations per parse; doing it thrice = ~1,560, two-thirds of which are pure waste. Multiply by every transpose press and every keystroke (when the slash panel is open) and the editor feels laggy on iPad.
- **Space:** Each parse allocates a fresh `doc` object graph (blocks/bars) that is immediately discarded — needless GC pressure.
- **Operational reason:** No single-entry memo cache keyed on the source text; the preview path and the slash-notation path independently parse the same `sourceEl.value`. Full `innerHTML` replacement also forces the browser to re-parse the generated markup and re-layout the whole `.sheet` subtree (reflow), rather than patching.

### H-3 `renderSlashNotationHtml` — **Time: O(C + M + V)** per render, repeated on every change
- One render is roughly linear: `O(C)` for chord formatting + `O(M)` for rows + `O(V)` to build the voicings Map (V = total `{tab}` voicing entries across sections). That is acceptable *per render*; the problem is **frequency × constant factor**:
  - It re-parses (`parseCSMPN`, see H-2) and re-walks all sections **on every keystroke** (debounced) and every control toggle.
  - String concatenation to build a multi-kB SVG, then `innerHTML` parse, is a large constant factor executed on the main thread.
- **Space:** Transient — the full SVG string + intermediate `processedSections`/`allVoicings`/`rows` arrays are allocated each render and discarded.
- **Operational reason:** No render-result memoization (the SVG depends only on `text` + settings snapshot; identical inputs reproduce identical SVG but are recomputed). The `allVoicings` Map is rebuilt from scratch each pass even though it only changes when the source changes. Using `Object.entries(...)` + `Map` per render rather than computing voicings once per parse.

**Scaling intuition:** For a typical 80-chord sheet the absolute times are small (single-digit ms), so the app feels fine on desktop. The pain emerges at the **upper end** — a 200–400-chord imported Guitar Pro / MusicXML chart on a mid-range iPad, where H-1 (import) blocks for tens of ms per redundant pass and H-2/H-3 multiply per-keystroke cost by 2–3×.

---

## 6. Refactored Code

> All refactors are written to drop into the **canonical vanilla track** (`CLAUDE.md` rule 2) and remain iOS-Safari-safe. They are additive and preserve existing function signatures.

### 6.1 — H-1: `importMusicXMLRegex` (hoist regex compilation + cache patterns)

**Original (`importPipeline.js:1952–1969`):**
```js
function importMusicXMLRegex(xmlText){
  const song = new SongModel();
  const t = xmlText || '';

  // Helper: extract text content of a tag
  const tag = (src, name) => {
    const re = new RegExp('<' + name + '[^>]*>([^<]*)</' + name + '>', 'i'); // ← compiled EVERY call
    const m = src.match(re);
    return m ? m[1].trim() : '';
  };

  // Helper: extract an attribute value
  const attr = (src, tagName, attrName) => {
    const re = new RegExp('<' + tagName + '[^>]*\\b' + attrName + '=["\']([^"\']*)["\']', 'i'); // ← compiled EVERY call
    const m = src.match(re);
    return m ? m[1].trim() : '';
  };
  /* …measures × harmonies loop calls tag()/attr() ~8× each… */
}
```

**Refactored:** compile each distinct pattern **once** and reuse via a module-level cache. Same behavior, no recompilation.
```js
// ── Module-level regex caches: a given (tagName)/(tagName,attrName) pattern
//    is compiled at most once for the entire app lifetime, not per call. ──
const _mxTagRe = new Map();   // name            -> RegExp
const _mxAttrRe = new Map();  // tag\x00attr     -> RegExp

function _mxGetTagRe(name){
  let re = _mxTagRe.get(name);
  if (!re){
    re = new RegExp('<' + name + '[^>]*>([^<]*)</' + name + '>', 'i');
    _mxTagRe.set(name, re);
  }
  return re;
}
function _mxGetAttrRe(tagName, attrName){
  const key = tagName + '\x00' + attrName;
  let re = _mxAttrRe.get(key);
  if (!re){
    re = new RegExp('<' + tagName + '[^>]*\\b' + attrName + '=["\']([^"\']*)["\']', 'i');
    _mxAttrRe.set(key, re);
  }
  return re;
}

function importMusicXMLRegex(xmlText){
  const song = new SongModel();
  const t = xmlText || '';

  // Helpers now LOOK UP a cached, pre-compiled regex instead of building one.
  const tag  = (src, name)            => { const m = src.match(_mxGetTagRe(name));            return m ? m[1].trim() : ''; };
  const attr = (src, tagName, aName)  => { const m = src.match(_mxGetAttrRe(tagName, aName)); return m ? m[1].trim() : ''; };

  /* …rest of the function is UNCHANGED — same loops, same output… */
}
```
*Why it works:* there are only ~12 distinct tag/attr patterns, so after the first measure every subsequent lookup is a `Map.get` (O(1)) returning an already-compiled `RegExp`. Compilation count drops from `M×H×T` to ~12.

---

### 6.2 — H-2: Memoize `parseCSMPN` (eliminate redundant re-parses)

**Problem:** `parseCSMPN(text)` runs 2–3× on identical text per user action across `renderer.js:710`, `index.html:5775`, `index.html:6011`.

**Refactored:** wrap the existing parser with a tiny last-result memo. Drop this immediately **after** the `parseCSMPN` definition in `csmpnParser.js` (it re-binds the global the rest of the app already calls — no call-site changes needed).
```js
// ── parseCSMPN memoization ────────────────────────────────────────────────
// parseCSMPN is pure w.r.t. its text argument, but the preview path, the
// slash-notation panel, and the MusicXML exporter each call it on the SAME
// source string within a single user action. Cache the last N parses so
// repeated calls on identical text are O(1) instead of O(lines + tokens).
//
// We freeze the returned doc shallowly is NOT done (callers read/extend it),
// so we cache by reference and trust callers not to mutate the parse tree.
// A small ring buffer (size 4) covers transpose + preview + slash + export.
(function installParseCsmpnMemo(){
  const _raw = parseCSMPN;            // keep the original implementation
  const _cache = new Map();           // text -> doc
  const MAX = 4;
  parseCSMPN = function parseCSMPN(text){
    const key = text || '';
    if (_cache.has(key)) return _cache.get(key);
    const doc = _raw(key);
    if (_cache.size >= MAX){
      // FIFO eviction (oldest key) — avoids the full-flush thrash seen in
      // _chordParseCache; Map preserves insertion order.
      _cache.delete(_cache.keys().next().value);
    }
    _cache.set(key, doc);
    return doc;
  };
})();
```
> **Caveat & safer variant:** a few call sites read mutable fields off the returned `doc` (e.g. `_snCfg.keySig` derivation reads `doc.key`; none observed to *write* into `doc`). The memo above caches by reference. If any caller is later found to mutate the doc, switch to caching a **structuredClone(doc)** on read, or scope the cache to a single `updatePreview` tick. Given current usage (read-only consumption of `doc.title/key/time/tempo/blocks`), reference caching is safe and is the cheapest win.

---

### 6.3 — H-3 / A-4: LRU eviction for the chord parse cache (stop full-flush thrash)

**Original (`chordProcessing.js:472–518`):**
```js
const _chordParseCache = new Map();
const CHORD_CACHE_MAX = 512;

function parseChordToken(token){
  let raw = token || '';
  const cacheKey = raw + '|' + fbSettings.maj7Style + '|' + fbSettings.minorStyle + '|' + fbSettings.dimStyle + '|' + fbSettings.halfDimStyle;
  if (_chordParseCache.has(cacheKey)) return _chordParseCache.get(cacheKey);
  /* …parse… */
  if (_chordParseCache.size > CHORD_CACHE_MAX) _chordParseCache.clear(); // ← throws away EVERYTHING
  _chordParseCache.set(cacheKey, result);
  return result;
}
```

**Refactored:** evict the **oldest single entry** instead of clearing the whole cache, and reuse one cached "style signature" string instead of re-concatenating 5 fields per call.
```js
const _chordParseCache = new Map();
const CHORD_CACHE_MAX = 512;

// Cache the style portion of the key; recompute only when settings change.
// settings.js already calls _chordParseCache.clear() on style change — we
// piggy-back on that by recomputing the signature lazily.
let _chordStyleSig = null;
function _styleSig(){
  if (_chordStyleSig === null){
    _chordStyleSig = '|' + fbSettings.maj7Style + '|' + fbSettings.minorStyle +
                     '|' + fbSettings.dimStyle + '|' + fbSettings.halfDimStyle;
  }
  return _chordStyleSig;
}

function parseChordToken(token){
  let raw = token || '';
  const cacheKey = raw + _styleSig();              // one concat, signature reused
  if (_chordParseCache.has(cacheKey)) return _chordParseCache.get(cacheKey);
  /* …parse (unchanged)… */

  // LRU-style eviction: drop the single oldest entry (Map keeps insertion
  // order) instead of clearing all 512 — preserves the hot working set.
  if (_chordParseCache.size >= CHORD_CACHE_MAX){
    _chordParseCache.delete(_chordParseCache.keys().next().value);
  }
  _chordParseCache.set(cacheKey, result);
  return result;
}
```
And in `settings.js:153`, invalidate the signature alongside the cache:
```js
_chordParseCache.clear();   // existing line
_chordStyleSig = null;      // ← add: force signature recompute after style change
```

---

## 7. Before-vs-After Performance Validation

### H-1 — `importMusicXMLRegex`
| | Before | After |
|---|---|---|
| **Time complexity** | O(M·H·T) regex **compilations** + O(M·H·T·L) scans | ~12 compilations total + O(M·H·T·L) scans |
| **Operational cost** | ~3,200 `new RegExp` for a 200-measure / 2-chord chart | ~12 `new RegExp`; thereafter `Map.get` (O(1)) |
| **Est. execution** | Tens of ms main-thread block on iPad for large scores | Dominated by scans; compile overhead ≈ eliminated |
| **Speedup** | — | **~10–50× less compile work**; import no longer stutters |
| **Memory trade-off** | — | Two small `Map`s holding ~12 compiled regexes (negligible) |
| **Verification** | Import a 200-measure MusicXML file (`xmlsamples.zip` has candidates); compare wall-clock import time and chart-`performance.now()` around `importMusicXMLRegex` before/after. |

### H-2 — Re-parse chain (memoized `parseCSMPN`)
| | Before | After |
|---|---|---|
| **Time complexity** | O(k·P), k = 2–3 redundant parses per action | O(P) once; subsequent identical-text calls O(1) |
| **Operational cost** | ~1,560 parse-ops for a 200-bar chart per transpose (3 parses) | ~520 parse-ops (1 parse) + 2 cache hits |
| **Est. execution** | Per-keystroke / per-transpose lag on iPad with slash panel open | ~⅓ the parse work; preview feels snappier |
| **Speedup** | — | **~2–3× fewer parses** on the hot path; less GC from discarded doc graphs |
| **Memory trade-off** | — | Ring buffer of 4 parsed docs (~tens of KB); bounded, acceptable |
| **Verification** | Temporarily increment a counter inside the original `parseCSMPN` and log it per transpose; confirm it drops from 2–3 to 1 with the memo. Or wrap `doTranspose` in `performance.now()` on a 200-bar chart. |

### H-3 / A-4 — Chord cache LRU
| | Before | After |
|---|---|---|
| **Time complexity** | Amortized O(1) hit, but **full O(n) flush** every 512nd miss and on every style change | O(1) hit; O(1) single-entry eviction; no flush |
| **Operational cost** | One style tweak ⇒ re-parse the *entire* chart's chords from cold cache | Hot working set survives; only overflow evicts one entry |
| **Est. execution** | Visible re-render cost right after any Fake-Book style change | Style change still clears (correctly), but overflow no longer thrashes |
| **Speedup** | — | Eliminates worst-case cliff for charts with >512 distinct chord+style keys; steadier render times |
| **Memory trade-off** | Same bound (≤512 entries) | Same bound; slightly better hit-rate |
| **Verification** | Render a synthetic chart with >512 unique chord tokens; measure render time of the 513th+ token region before/after (before shows a spike at each flush). |

---

## Appendix — Issue Index

| ID | Category | Severity | Location |
|---|---|---|---|
| S-1 | Security (supply chain) | HIGH | `index.html:17–32` |
| S-2 | Security (CSP) | HIGH | `index.html` `<head>` |
| S-3 | Security (XSS surface) | MEDIUM | `index.html`/`renderer.js` `innerHTML` sites |
| S-4 | Security (client secret) | MEDIUM | `index.html:3529–3535` |
| S-5 | Robustness (storage) | LOW–MED | `saveSetlist`/`saveLibrary`/`settings.js:85` |
| ST-1 | Structural (God object) | HIGH | `index.html` (7,328 lines) |
| ST-2 | Structural (duplication) | HIGH | vanilla ↔ `src/` twins |
| ST-3 | Structural (large module) | MEDIUM | `importPipeline.js` (3,016 lines) |
| ST-4 | Structural (untestable) | MEDIUM | slash IIFE in `index.html` |
| A-1 | Anti-pattern (`var`) | LOW | `importGuitarPro.js` (145×) |
| A-2 | Anti-pattern (regex in loop) | MEDIUM | `importPipeline.js:1957–1969` |
| A-3 | Anti-pattern (DOM churn) | MEDIUM | `index.html` (191 `getElementById`), `renderer.js` |
| A-4 | Anti-pattern (cache flush) | LOW | `chordProcessing.js:517` |

*End of review.*

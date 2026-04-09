# OPP ROADMAP — Chord-Sheet-Maker-Pro
## Expert Refactor, Optimize & Rewrite Roadmap
### Analyst: Opp the CoderOptimizer | Generated: 2026-04-09 | Branch: claude/review-claude-md-1mvan

---

## PROJECT SNAPSHOT

| Track | File | Size | Status |
|-------|------|------|--------|
| Legacy Monolith | `index.html` | 8,032 lines / 296 KB | Active production |
| React App | `app.html` + `src/` | ~8,750 lines TypeScript | Active, parallel |

**Developer context:** All development on iOS 16+ (iPhone/iPad). No local console.
GitHub Actions = the CI console. Every workflow must be browser or GitHub-hosted.

**Central tension:** Two parallel implementations of the same features (dual-track architecture). Resolution is the top strategic priority.

---

## ARCHITECTURE SCORECARD

| Domain | Score | Finding |
|--------|-------|---------|
| Modularity | 2/10 | index.html = 8K-line global soup; App.tsx = 1,563-line monolith |
| Test Coverage | 3/10 | 30 tests, 0 integration tests, 0 error-path tests |
| Mobile Readiness | 5/10 | Print workflow works; canvas/fixed-width panels break narrow screens |
| Build Pipeline | 4/10 | No linting, no CI/CD, no source maps, no audit hooks |
| Performance | 6/10 | Code splitting good; 296 KB index.html destroys initial load |
| Security | 7/10 | Hardened March 2026; oemer_helper.py has no auth/rate-limiting |
| Code Quality | 6/10 | TypeScript src/ clean; index.html unmaintainable |
| Documentation | 8/10 | Excellent docs; CLAUDE.md is a model reference |

---

## CRITICAL FINDINGS

### Finding 1 — The Divergence Bomb 💣
`public/ug-pro-importer.html` (CDN PDF.js, standalone) and `src/ingest/ugProPdfImporter.ts`
(TypeScript, npm) are two implementations of the same feature already diverging.
**Resolution:** `src/ingest/ugProPdfImporter.ts` is canonical. Standalone page becomes a build artifact.

### Finding 2 — index.html Is Still The Real App
The React app (`app.html`) cannot yet do: full fake-book rendering, slash notation IIFE,
self-test suite, VexFlow blocks, or all import formats. index.html is a first-class citizen,
not something to abandon.

### Finding 3 — Parse Cache ✅ VERIFIED CORRECT (No Fix Needed)
`parseChordToken()` cache key already includes ALL style settings:
`cacheKey = raw + '|' + maj7Style + '|' + minorStyle + '|' + dimStyle + '|' + halfDimStyle`
Additionally, `applyFBSettings()` explicitly calls `_chordParseCache.clear()` on every
settings change. The cache is both key-differentiated AND aggressively cleared. This was
flagged as a bug in initial analysis — code review confirmed it is correct.

### Finding 4 — iOS Print-to-PDF Is The Real Export
The developer's actual workflow is print → Save as PDF from iOS Safari. Entire export
infrastructure should optimize around this, not canvas-based rasterization.

---

## SPRINT EXECUTION PLAN

### ✅ SPRINT 1 — Foundation (COMPLETE)
| Item | Task | Status |
|------|------|--------|
| 1.1 | GitHub Actions CI/CD (.github/workflows/ci.yml) | ✅ DONE |
| 1.2 | ESLint + Prettier setup | ⬜ TODO (Sprint 2 prep) |
| 1.3 | Parse cache audit → verified correct, no fix needed | ✅ N/A |
| 1.4 | Source maps in vite.config.ts | ✅ DONE |
| 1.5 | tsconfig.test.json for test files | ✅ DONE |
| +   | engines field in package.json (node >=22) | ✅ DONE |

### SPRINT 2 — Mobile & Performance (CURRENT)
| Item | Task | Status |
|------|------|--------|
| 1.2 | ESLint + Prettier (carried) | ✅ DONE — 0 errors, 2 warnings (exhaustive-deps in App.tsx) |
| 4.4 | Font loading fix (preconnect + swap) | ✅ DONE — FreeSerif CDN preconnect added; 5 CDN scripts deferred |
| 4.5 | Lazy-load CDN libs (abcjs ~180 KB, VexFlow) | ✅ DONE — html2canvas, jsPDF, abcjs, JSZip, VexFlow all `defer` |
| 4.1 | Responsive breakpoints (ug-pro-importer.html, validate.html) | ✅ DONE — @media 767px stack + 1024px narrow panels |
| 4.2 | Print stylesheet hardening (slash notation SVG, section orphans) | ⬜ TODO |
| 4.3 | iOS Safari SVG export fix (replace html2canvas for slash notation) | ⬜ TODO |

### SPRINT 3 — index.html Decomposition (Part 1)
| Item | Task | Status |
|------|------|--------|
| 2.1A | Extract utils.js (debounce, escapeHtml, SongModel, etc.) | ⬜ TODO |
| 2.1B | Extract chordProcessing.js (~800 lines) | ⬜ TODO |
| 5.1 | Add error-path + edge-case tests for parsers | ⬜ TODO |

### SPRINT 4 — React App Optimization
| Item | Task | Status |
|------|------|--------|
| 2.1C | Extract csmpnParser.js from index.html | ⬜ TODO |
| 3.1 | App.tsx decomposition → hooks + views (~300 line target) | ⬜ TODO |
| 3.3 | React error boundaries (ImportErrorBoundary, SlashNotationBoundary) | ⬜ TODO |

### SPRINT 5 — Unification
| Item | Task | Status |
|------|------|--------|
| 3.2 | Split musicXMLtochordpro.ts (1,291 lines → 4 modules) | ⬜ TODO |
| 3.4 | Unify ugProPdfImporter (standalone → build artifact) | ⬜ TODO |
| 2.1D-F | Remaining index.html extractions (renderer, importPipeline, settings) | ⬜ TODO |

### SPRINT 6+ — Feature Completion
| Item | Task | Status |
|------|------|--------|
| 3.5 | SlashNotationView.tsx feature parity with index.html IIFE | ⬜ TODO |
| 6.1 | public/ug-txt-importer.html standalone page | ⬜ TODO |
| 6.2 | D.C./D.S./Coda repeat expansion in csmpnParser | ⬜ TODO |
| 6.3 | oemer_helper.py security hardening (CORS, rate limiting, file size) | ⬜ TODO |

---

## QUICK WINS (Zero-Risk, High-Value)

These can be done in a single commit with no risk of regression:

1. **Parse cache** — ✅ verified already correct; no change needed
2. **Source maps** — 1-line vite.config.ts change
3. **Lazy-load abcjs** — saves ~180 KB initial parse on iOS
4. **`engines` in package.json** — `"engines": { "node": ">=22.0.0" }`
5. **oemer_helper.py file size guard** — 3 lines, security improvement
6. **Font preconnect tags** — prevents FOUT on iOS print

---

## ANTI-PATTERNS TO ELIMINATE

| Anti-Pattern | Correct Pattern |
|---|---|
| `window.X = function()` for cross-scope | Module exports |
| `innerHTML` with unescaped content | Always use `escapeHtml()` |
| Nested ternaries >2 deep | Extract named conditions |
| Magic numbers in renderer (pixel values) | Named constants (STAFF_H, LINE_GAP) |
| `console.log` in production paths | Gate behind `DEBUG` flag |
| `any` type in TypeScript | Proper type stubs |
| DOM refs queried every call | Cache at init |

---

## TEST COVERAGE TARGETS

| Module | Current | Target |
|--------|---------|--------|
| chordProParser | 8 | 20 |
| csmpnParser | 8 | 20 |
| sniffFormat | 10 | 20 |
| chordProcessing | 0 | 30 |
| importPipeline | 0 | 25 |
| transposition | 0 | 20 |
| canonicalChart | 0 | 10 |
| importQuality | 0 | 10 |
| abcNormalization | 0 | 10 |
| musicXmlToCsmpn | 0 | 15 |
| **Total** | **30** | **180+** |

---

## CONVERGENCE ENDGAME (Year 1-2)

```
Year 1:
  React app gains all import capabilities (Phase 3)
  React app gains full slash notation (Phase 3.5)
  React app gains fake-book layout renderer
  index.html becomes print-stylesheet-only

Year 2:
  index.html deprecated as handwritten file
  All features in React app
  index.html generated as build artifact
```

---

## KEY COMMANDS

```bash
npm run test:all          # Run all 30+ tests (vexflow + parser fixture tests)
npm run test:parsers      # Run TypeScript parser tests only
npm run build             # tsc -b && vite build
npm run lint              # ESLint (once configured)
npm run typecheck         # tsc --noEmit
```

---

*Last updated: 2026-04-09 | Maintain this file as a living document — check off items as completed*

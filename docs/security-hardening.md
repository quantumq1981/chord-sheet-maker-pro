# Security Hardening

This document tracks the client-side security posture of Chord Sheet Maker Pro
(a static, no-backend app deployed to GitHub Pages) and the steps applied.

## 1. Content-Security-Policy (DONE)

A CSP is shipped as a `<meta http-equiv="Content-Security-Policy">` tag at the
top of `index.html` (it must appear before any resource loads).

Because the app is static (no server to mint per-request nonces) and ships
inline `<script>`/`<style>` blocks, inline event handlers, and CDN libraries
that use `eval`, the policy keeps `'unsafe-inline'`/`'unsafe-eval'`. It still
provides real defense-in-depth by:

- **Origin-allowlisting scripts** — an injected `<script src="https://evil…">`
  is blocked; only `cdnjs.cloudflare.com` and `cdn.jsdelivr.net` are allowed.
- **`object-src 'none'`** — blocks `<object>`/`<embed>` plugin vectors.
- **`base-uri 'self'`** — blocks `<base>`-tag hijacking of relative URLs.

Allowed origins are the only five the app contacts at runtime:

| Origin | Used for |
|---|---|
| `cdnjs.cloudflare.com` | pdf.js + its worker, html2canvas, jsPDF |
| `cdn.jsdelivr.net` | abcjs, jszip, vexflow, AlphaTab + its SMuFL font |
| `fonts.googleapis.com` | Google Fonts stylesheet |
| `fonts.gstatic.com` | Google Fonts font files |
| `fonts.cdnfonts.com` | FreeSerif stylesheet + font files |

### ⚠️ Device verification required

This change cannot be exercised in CI (which only lints/builds/tests `src/` +
`tests/`). After deploy, verify on **iOS Safari** (the primary target) that the
following still work — each touches a CSP-governed resource:

1. App loads, fonts render (style/font-src).
2. **Import a UG Pro PDF** (pdf.js worker from cdnjs → `worker-src`).
3. **Import a Guitar Pro file** (AlphaTab + SMuFL font from jsdelivr).
4. **Import an ABC / .mxl file** (abcjs / jszip from jsdelivr).
5. **Export PDF / PNG** (html2canvas + jsPDF; canvas `data:`/`blob:` URLs).

If any feature breaks, the browser console will name the blocked URL and the
violated directive — add that origin to the matching directive in `index.html`.

## 2. Subresource Integrity (SRI) — TODO (one command)

The six CDN `<script>` tags currently have no `integrity=` hash. Hashes can't be
generated in the offline CI sandbox, so run, on a networked machine:

```bash
bash scripts/compute-sri.sh
```

Paste each printed `integrity="sha384-…" crossorigin="anonymous"` onto the
matching `<script>` tag in `index.html`. Re-run whenever a pinned version
changes. (The pdf.js **worker** URL is set in JS, not a `<script>` tag, so it is
covered by `worker-src` in the CSP rather than SRI.)

## 3. Other client-side notes

- **PIN in `localStorage`** (`index.html`, `PIN_STORAGE_KEY`) is stored in
  plaintext and is readable by any script on the origin — it is a UX lock, not a
  security control. Do not gate anything sensitive on it.
- **`localStorage` writes** (settings, library, setlist) swallow quota errors
  silently. Consider surfacing a "couldn't save — storage full" status on a
  caught `QuotaExceededError` so users aren't misled into thinking large
  imported charts were persisted.

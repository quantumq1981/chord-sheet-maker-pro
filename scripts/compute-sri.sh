#!/usr/bin/env bash
#
# compute-sri.sh — generate Subresource Integrity (SRI) attributes for the
# pinned CDN <script> tags in index.html.
#
# WHY: index.html loads six third-party libraries from public CDNs with no
# `integrity=` hash. If a CDN (or a pinned package version) is compromised,
# arbitrary JS would run in the user's browser. SRI makes the browser refuse
# any script whose contents don't match the expected hash.
#
# These hashes cannot be produced in an offline CI sandbox (no outbound network
# to the CDNs), so this script is run on a machine WITH network access; paste
# the printed `integrity="…"` value into the matching <script> tag, keeping the
# existing `crossorigin="anonymous"` attribute (required for SRI on cross-origin
# resources).
#
# Usage:  bash scripts/compute-sri.sh
#
# Re-run whenever a pinned CDN version in index.html changes.

set -euo pipefail

urls=(
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js"
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
  "https://cdn.jsdelivr.net/npm/abcjs@6.2.2/dist/abcjs-basic-min.js"
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"
  "https://cdn.jsdelivr.net/npm/vexflow@3.0.9/releases/vexflow-min.js"
  "https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.1/dist/alphaTab.min.js"
)

for url in "${urls[@]}"; do
  hash="$(curl -sfL "$url" | openssl dgst -sha384 -binary | openssl base64 -A)"
  echo "$url"
  echo "  integrity=\"sha384-${hash}\" crossorigin=\"anonymous\""
  echo
done

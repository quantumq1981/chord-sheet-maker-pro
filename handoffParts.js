/* =========================================================
   handoffParts.js — the optional `parts[]` addition to the csm:handoff:v1 envelope
   (window.HandoffParts). Pure (no DOM), unit-tested in tests/tempoMapHandoff.test.mjs.

   Tab Translator Pro's "→ Chord Sheet Maker Pro (all parts)" sends one CSMPN chart per
   instrument (the band chart, guitar, bass, vocals …) charted from the same recording on one
   beat grid. The envelope stays v:1 and keeps `formats` (the primary chart — the band chart),
   so an older receiver simply loads that one. This receiver additionally files every part in
   the song library, so each instrument's chart is one Load away:

     env.parts = [{ name: "Guitar", role: "other", formats: { csmpn: "Title: Song — Guitar\n…" } }, …]

   Rules: parts without a CSMPN string are skipped; at most 16; a part's library title is the
   `Title:` line of its CSMPN, else "<song> — <part name>"; an existing library entry with the
   same title is replaced (as the Save button does).
========================================================= */
(function () {
  var MAX_PARTS = 16;

  function titleOf(csmpn) {
    var m = String(csmpn || '').match(/^\s*Title\s*:\s*(.+)$/im);
    return m ? m[1].trim() : '';
  }

  /** env → [{ name, role, csmpn, title }] (validated, in order). */
  function normalizeParts(env) {
    if (!env || !Array.isArray(env.parts)) return [];
    var out = [];
    for (var i = 0; i < env.parts.length && out.length < MAX_PARTS; i++) {
      var p = env.parts[i];
      var csmpn = p && p.formats && typeof p.formats.csmpn === 'string' ? p.formats.csmpn : '';
      if (!csmpn.trim()) continue;
      var name = String((p && p.name) || 'Part ' + (out.length + 1)).slice(0, 80);
      var title = titleOf(csmpn) || ((env.title ? env.title + ' — ' : '') + name);
      out.push({ name: name, role: String((p && p.role) || ''), csmpn: csmpn, title: title });
    }
    return out;
  }

  /** A new library with every part upserted by title. → { library, titles } (never mutates). */
  function mergePartsIntoLibrary(library, parts, nowIso) {
    var lib = Array.isArray(library) ? library.slice() : [];
    var titles = [];
    for (var i = 0; i < (parts || []).length; i++) {
      var p = parts[i];
      var entry = { title: p.title, content: p.csmpn, savedAt: nowIso || new Date().toISOString() };
      var at = -1;
      for (var j = 0; j < lib.length; j++) if (lib[j] && lib[j].title === p.title) { at = j; break; }
      if (at >= 0) lib[at] = entry; else lib.push(entry);
      titles.push(p.title);
    }
    return { library: lib, titles: titles };
  }

  var api = { MAX_PARTS: MAX_PARTS, titleOf: titleOf, normalizeParts: normalizeParts, mergePartsIntoLibrary: mergePartsIntoLibrary };
  if (typeof window !== 'undefined') window.HandoffParts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

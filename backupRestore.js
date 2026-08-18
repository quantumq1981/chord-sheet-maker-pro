/**
 * backupRestore.js — whole-library backup & restore (browser global + window.BackupRestore).
 *
 * Everything the app remembers lives in localStorage, which iOS Safari can evict
 * (7-day inactivity), clear ("Clear Website Data"), or lose on a device change —
 * with no escape hatch. This module serializes the user-data keys into a single
 * portable JSON file (download) and restores them back (upload), so a musician's
 * songbook + setlists + settings survive and can move between iPhone/iPad.
 *
 * Pure functions take a `storage` interface ({ getItem, setItem }) so they unit-test
 * without a real localStorage. `applyBackup` only writes whitelisted keys, so an
 * imported file can never inject arbitrary localStorage entries.
 */
(function () {
  var APP_ID = 'chord-sheet-maker-pro';
  var VERSION = 1;

  // User-data localStorage keys to back up. Keep in sync with the literals in
  // index.html / settings.js (each noted). Intentionally EXCLUDES the power-mode
  // PIN ('csmpn_powerPin') and the transient handoff key ('csm:handoff:v1').
  var BACKUP_KEYS = [
    'csmpn_library', // song library (index.html)
    'csmp_setlist_v1', // setlists (SETLIST_KEY)
    'csmpn_settings', // Fake Book settings (settings.js)
    'csml_editor_settings', // ChordSlashML editor style (CSML_STYLE_KEY)
    'csmpn_appMode', // legacy single UI mode, pre per-stage split
    'csmpn_appMode:capture', // Advanced disclosure, per stage (index.html modeKey)
    'csmpn_appMode:prepare',
    'csmpn_appMode:perform',
    'csmpn_stage', // last workflow stage (index.html)
    'csmpn_draft', // current editor draft (_SOURCE_DRAFT_KEY)
    'csmpn_perfLyrics_v1', // Performance Lyrics last paste + timing settings (performanceLyrics.js)
  ];

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // YYYY-MM-DD for the download filename.
  function dateStamp(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function backupFilename(d) {
    return 'chord-sheet-backup-' + dateStamp(d) + '.json';
  }

  // Read the whitelisted keys from `storage` into a versioned envelope. Only keys
  // that are actually present (non-null) are included.
  function buildBackup(storage, nowISO) {
    var data = {};
    for (var i = 0; i < BACKUP_KEYS.length; i++) {
      var k = BACKUP_KEYS[i];
      var v = null;
      try {
        v = storage.getItem(k);
      } catch (_) {
        v = null;
      }
      if (v !== null && v !== undefined) data[k] = v;
    }
    return {
      app: APP_ID,
      version: VERSION,
      exportedAt: nowISO || new Date().toISOString(),
      data: data,
    };
  }

  function serializeBackup(storage, nowISO) {
    return JSON.stringify(buildBackup(storage, nowISO), null, 2);
  }

  // Human-readable counts for the restore confirmation dialog.
  function backupSummary(envelope) {
    var out = { songs: 0, setlistCharts: 0, hasSettings: false, keys: 0 };
    if (!envelope || !envelope.data) return out;
    var data = envelope.data;
    out.keys = Object.keys(data).length;
    try {
      var lib = JSON.parse(data['csmpn_library'] || 'null');
      if (Array.isArray(lib)) out.songs = lib.length;
      else if (lib && typeof lib === 'object') out.songs = Object.keys(lib).length;
    } catch (_) {
      /* ignore */
    }
    try {
      var sl = JSON.parse(data['csmp_setlist_v1'] || '[]');
      if (Array.isArray(sl)) out.setlistCharts = sl.length;
    } catch (_) {
      /* ignore */
    }
    out.hasSettings = !!data['csmpn_settings'];
    return out;
  }

  // Parse + validate an uploaded backup file. Returns { ok, envelope, error }.
  function parseBackup(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: 'Not a valid JSON file.' };
    }
    if (!obj || typeof obj !== 'object' || obj.app !== APP_ID || typeof obj.data !== 'object') {
      return { ok: false, error: 'This is not a Chord Sheet Maker backup file.' };
    }
    return { ok: true, envelope: obj };
  }

  // Write a parsed envelope's data back into `storage`. Only whitelisted keys are
  // written; everything else in the file is ignored. Returns the count restored.
  function applyBackup(envelope, storage) {
    if (!envelope || !envelope.data) return 0;
    var n = 0;
    for (var i = 0; i < BACKUP_KEYS.length; i++) {
      var k = BACKUP_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(envelope.data, k)) {
        var v = envelope.data[k];
        if (typeof v !== 'string') continue; // values are stored as raw strings
        try {
          storage.setItem(k, v);
          n++;
        } catch (_) {
          /* ignore individual failures */
        }
      }
    }
    return n;
  }

  var api = {
    APP_ID: APP_ID,
    VERSION: VERSION,
    BACKUP_KEYS: BACKUP_KEYS.slice(),
    buildBackup: buildBackup,
    serializeBackup: serializeBackup,
    backupSummary: backupSummary,
    backupFilename: backupFilename,
    parseBackup: parseBackup,
    applyBackup: applyBackup,
  };
  if (typeof window !== 'undefined') window.BackupRestore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

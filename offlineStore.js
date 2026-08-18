/*
 * offlineStore.js — keep the songbook when iOS throws localStorage away.
 *
 * The problem this solves is real and specific: everything the user owns (song
 * library, setlists, settings, the current draft) lives in localStorage, and
 * mobile Safari evicts that after ~7 days of not visiting, on "Clear Website
 * Data", and whenever it feels storage pressure. Backup/Restore exists for this,
 * but it only helps the user who remembered to press it.
 *
 * WHY MIRROR INSTEAD OF MIGRATE. The app reads localStorage synchronously in
 * dozens of places (`localStorage.getItem` inline in render paths). IndexedDB is
 * asynchronous, so *moving* to it would mean rewriting every one of those call
 * sites and every function that leads to them — a large, risky change to code
 * that currently works. So localStorage stays exactly as it is, and IndexedDB
 * becomes a shadow copy:
 *
 *   - **Mirror** the whitelisted keys into IndexedDB when the app backgrounds
 *     (the moment before the eviction window opens) and on demand.
 *   - **Recover** on boot: any whitelisted key MISSING from localStorage but
 *     present in the mirror is written back. That is precisely the eviction case.
 *   - **Ask to persist** via navigator.storage.persist(), which on supporting
 *     browsers exempts the origin from routine eviction in the first place.
 *
 * Two rules make this safe:
 *   1. **localStorage always wins while it is alive.** Recovery only FILLS GAPS;
 *      it never overwrites a key that already has a value, so a stale mirror can
 *      never clobber current work.
 *   2. **Whitelist only.** Same guard as backupRestore — the mirror cannot
 *      introduce arbitrary keys, and it never carries the power-mode PIN.
 *
 * The pure half takes a `storage` interface so it tests without a browser; the
 * IndexedDB half is feature-detected and try/catch'd throughout, because a
 * storage failure must never be the reason the app fails to start.
 */
(function () {
  var DB_NAME = 'csmp-offline';
  var DB_VERSION = 1;
  var STORE = 'kv';

  /*
   * The keys worth preserving. Sourced from BackupRestore so there is ONE list:
   * a key added to the backup is mirrored automatically, and the two can't drift.
   * The inline fallback exists only for load-order safety and is asserted equal
   * to the backup list by tests/offlineStore.test.mjs.
   */
  var FALLBACK_KEYS = [
    'csmpn_library',
    'csmp_setlist_v1',
    'csmpn_settings',
    'csml_editor_settings',
    'csmpn_appMode',
    'csmpn_appMode:capture',
    'csmpn_appMode:prepare',
    'csmpn_appMode:perform',
    'csmpn_stage',
    'csmpn_draft',
    'csmpn_perfLyrics_v1',
  ];

  function mirroredKeys() {
    var br = typeof window !== 'undefined' && window.BackupRestore;
    return br && Array.isArray(br.BACKUP_KEYS) && br.BACKUP_KEYS.length
      ? br.BACKUP_KEYS.slice()
      : FALLBACK_KEYS.slice();
  }

  // ── Pure core ─────────────────────────────────────────────────────────────

  /** The whitelisted keys that currently hold a value, as a plain object. */
  function snapshot(storage, keys) {
    var out = {};
    if (!storage) return out;
    keys = keys || mirroredKeys();
    for (var i = 0; i < keys.length; i++) {
      var v = null;
      try {
        v = storage.getItem(keys[i]);
      } catch (_e) {
        v = null;
      }
      if (v != null) out[keys[i]] = v;
    }
    return out;
  }

  /**
   * Whitelisted keys the mirror has but storage has lost — the recovery set.
   * A key that still has a value in storage is never listed: live data wins.
   */
  function missingKeys(storage, mirrored, keys) {
    keys = keys || mirroredKeys();
    var out = [];
    if (!mirrored) return out;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(mirrored, k)) continue;
      if (mirrored[k] == null) continue;
      var cur = null;
      try {
        cur = storage ? storage.getItem(k) : null;
      } catch (_e) {
        cur = null;
      }
      if (cur == null) out.push(k);
    }
    return out;
  }

  /**
   * Write the recovery set back into storage. Returns the keys actually
   * restored, so the caller can tell the user something true happened.
   */
  function restoreMissing(storage, mirrored, keys) {
    var todo = missingKeys(storage, mirrored, keys);
    var done = [];
    for (var i = 0; i < todo.length; i++) {
      try {
        storage.setItem(todo[i], mirrored[todo[i]]);
        done.push(todo[i]);
      } catch (_e) {
        /* quota or private mode — skip this key, keep going */
      }
    }
    return done;
  }

  /** Songs/setlists in a snapshot, for an honest status message. */
  function snapshotSummary(snap) {
    var songs = 0;
    var setlists = 0;
    try {
      var lib = snap && snap['csmpn_library'] ? JSON.parse(snap['csmpn_library']) : null;
      if (Array.isArray(lib)) songs = lib.length;
      else if (lib && typeof lib === 'object') songs = Object.keys(lib).length;
    } catch (_e) {
      /* unreadable — report 0 rather than guess */
    }
    try {
      var sl = snap && snap['csmp_setlist_v1'] ? JSON.parse(snap['csmp_setlist_v1']) : null;
      if (Array.isArray(sl)) setlists = sl.length;
      else if (sl && typeof sl === 'object') setlists = Object.keys(sl).length;
    } catch (_e) {
      /* same */
    }
    return { songs: songs, setlists: setlists };
  }

  // ── IndexedDB (browser only) ──────────────────────────────────────────────

  function idb() {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  }

  function supported() {
    return !!idb();
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var api = idb();
      if (!api) return reject(new Error('IndexedDB unavailable'));
      var req;
      try {
        req = api.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return reject(e);
      }
      req.onupgradeneeded = function () {
        try {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        } catch (_e) {
          /* handled by onerror */
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error || new Error('IndexedDB open failed'));
      };
      // Safari can leave a request pending forever in private mode.
      setTimeout(function () {
        reject(new Error('IndexedDB open timed out'));
      }, 4000);
    });
  }

  function readAll() {
    return openDb()
      .then(function (db) {
        return new Promise(function (resolve) {
          var out = {};
          var tx;
          try {
            tx = db.transaction(STORE, 'readonly');
          } catch (_e) {
            return resolve(out);
          }
          var store = tx.objectStore(STORE);
          var keys = mirroredKeys();
          var left = keys.length;
          if (!left) return resolve(out);
          keys.forEach(function (k) {
            var r = store.get(k);
            r.onsuccess = function () {
              if (r.result != null) out[k] = r.result;
              if (--left === 0) resolve(out);
            };
            r.onerror = function () {
              if (--left === 0) resolve(out);
            };
          });
        });
      })
      .catch(function () {
        return {};
      });
  }

  function writeAll(snap) {
    return openDb()
      .then(function (db) {
        return new Promise(function (resolve) {
          var tx;
          try {
            tx = db.transaction(STORE, 'readwrite');
          } catch (_e) {
            return resolve(false);
          }
          var store = tx.objectStore(STORE);
          var allowed = mirroredKeys();
          for (var i = 0; i < allowed.length; i++) {
            var k = allowed[i];
            try {
              if (Object.prototype.hasOwnProperty.call(snap, k)) store.put(snap[k], k);
              else store.delete(k); // cleared in the app → clear in the mirror
            } catch (_e) {
              /* skip this key */
            }
          }
          tx.oncomplete = function () {
            resolve(true);
          };
          tx.onerror = function () {
            resolve(false);
          };
          tx.onabort = function () {
            resolve(false);
          };
        });
      })
      .catch(function () {
        return false;
      });
  }

  /** Copy the current localStorage state into the mirror. */
  function sync(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage || !supported()) return Promise.resolve(false);
    return writeAll(snapshot(storage));
  }

  /**
   * Fill any gap localStorage has from the mirror. Resolves with the restored
   * keys (empty when there was nothing to recover, which is the normal case).
   */
  function recover(storage) {
    storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!storage || !supported()) return Promise.resolve([]);
    return readAll().then(function (mirrored) {
      return restoreMissing(storage, mirrored);
    });
  }

  /**
   * Ask the browser to exempt this origin from routine eviction. Best-effort and
   * silent: Safari may grant it outright, prompt, or ignore it entirely.
   */
  function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return navigator.storage.persist().catch(function () {
          return false;
        });
      }
    } catch (_e) {
      /* fall through */
    }
    return Promise.resolve(false);
  }

  /**
   * Wire the lifecycle: recover now, mirror when the app goes to the background.
   * `pagehide` and the hidden `visibilitychange` are the two events iOS reliably
   * delivers before it suspends a tab — the last moment to write anything down.
   */
  function install(opts) {
    opts = opts || {};
    if (!supported()) return Promise.resolve({ supported: false, restored: [] });
    var storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);

    var onHide = function () {
      sync(storage);
    };
    try {
      window.addEventListener('pagehide', onHide);
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') onHide();
      });
    } catch (_e) {
      /* no window/document — nothing to hook */
    }

    requestPersistence();
    return recover(storage).then(function (restored) {
      // Mirror immediately so a first-ever visit is protected without waiting
      // for a backgrounding that might not come before eviction.
      sync(storage);
      if (restored.length && typeof opts.onRestore === 'function') {
        try {
          opts.onRestore(restored, snapshotSummary(snapshot(storage, restored)));
        } catch (_e) {
          /* a reporting failure must not break recovery */
        }
      }
      return { supported: true, restored: restored };
    });
  }

  var api = {
    DB_NAME: DB_NAME,
    STORE: STORE,
    FALLBACK_KEYS: FALLBACK_KEYS.slice(),
    mirroredKeys: mirroredKeys,
    snapshot: snapshot,
    missingKeys: missingKeys,
    restoreMissing: restoreMissing,
    snapshotSummary: snapshotSummary,
    supported: supported,
    sync: sync,
    recover: recover,
    requestPersistence: requestPersistence,
    install: install,
  };
  if (typeof window !== 'undefined') window.OfflineStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

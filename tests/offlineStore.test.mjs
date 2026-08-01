/*
 * offlineStore.test.mjs — the IndexedDB mirror that survives Safari's eviction.
 *
 * The pure half is all of the risk, so it is all tested here: what gets mirrored,
 * what counts as "lost", and — most importantly — the two rules that stop the
 * mirror doing harm. `sync`/`recover`/`install` need a real IndexedDB and are the
 * only functions left to a device check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load offlineStore with an optional pre-seeded window (for BackupRestore). */
function load(win) {
  const ctx = { window: win || {}, module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'offlineStore.js'), 'utf8'), ctx);
  return ctx.window.OfflineStore;
}

/** A localStorage stand-in — the same shape backupRestore.js tests against. */
function fakeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

const os = load();
const arr = (x) => Array.from(x);

// ── What gets mirrored ───────────────────────────────────────────────────────

test('the mirror list comes from BackupRestore so the two cannot drift', () => {
  // A key added to the backup must be mirrored automatically — one list, not two.
  const backup = { BACKUP_KEYS: ['csmpn_library', 'a_new_key'] };
  const withBr = load({ BackupRestore: backup });
  assert.deepEqual(arr(withBr.mirroredKeys()), ['csmpn_library', 'a_new_key']);
});

test('the inline fallback list matches backupRestore.js, for load-order safety', () => {
  // offlineStore.js can be evaluated before backupRestore.js in some contexts;
  // its fallback must not silently protect a smaller set than the backup does.
  const ctx = { window: {}, module: { exports: {} }, console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'backupRestore.js'), 'utf8'), ctx);
  const backupKeys = arr(ctx.window.BackupRestore.BACKUP_KEYS);
  assert.deepEqual(arr(os.FALLBACK_KEYS), backupKeys);
});

test('snapshot captures only keys that hold a value', () => {
  const s = fakeStorage({ csmpn_library: '[1]', csmpn_stage: 'perform' });
  const snap = os.snapshot(s);
  assert.equal(snap.csmpn_library, '[1]');
  assert.equal(snap.csmpn_stage, 'perform');
  assert.ok(!('csmpn_draft' in snap), 'an absent key is not mirrored as null');
});

test('snapshot never carries the power-mode PIN or any unlisted key', () => {
  const s = fakeStorage({ csmpn_library: '[]', csmpn_powerPin: '1234', random_key: 'x' });
  const snap = os.snapshot(s);
  assert.ok(!('csmpn_powerPin' in snap), 'the PIN is not user data to mirror');
  assert.ok(!('random_key' in snap), 'the whitelist bounds what leaves localStorage');
});

// ── The two safety rules ─────────────────────────────────────────────────────

test('live data always wins: a key that still has a value is never overwritten', () => {
  // The failure this prevents: a stale mirror clobbering the song you just wrote.
  const s = fakeStorage({ csmpn_library: '["current"]' });
  const mirrored = { csmpn_library: '["stale"]' };
  assert.deepEqual(arr(os.missingKeys(s, mirrored)), [], 'nothing is missing');
  assert.deepEqual(arr(os.restoreMissing(s, mirrored)), []);
  assert.equal(s.getItem('csmpn_library'), '["current"]', 'untouched');
});

test('recovery fills only the gaps — the eviction case', () => {
  // Safari cleared the library but the settings survived.
  const s = fakeStorage({ csmpn_settings: '{"live":1}' });
  const mirrored = { csmpn_library: '["song"]', csmpn_settings: '{"old":1}' };
  assert.deepEqual(arr(os.missingKeys(s, mirrored)), ['csmpn_library']);
  assert.deepEqual(arr(os.restoreMissing(s, mirrored)), ['csmpn_library']);
  assert.equal(s.getItem('csmpn_library'), '["song"]', 'restored');
  assert.equal(s.getItem('csmpn_settings'), '{"live":1}', 'the survivor is left alone');
});

test('recovery cannot inject an unlisted key from a tampered mirror', () => {
  const s = fakeStorage({});
  const mirrored = { csmpn_library: '["ok"]', csmpn_powerPin: '9999', evil: 'x' };
  assert.deepEqual(arr(os.restoreMissing(s, mirrored)), ['csmpn_library']);
  assert.equal(s.getItem('csmpn_powerPin'), null, 'the PIN is never restored');
  assert.equal(s.getItem('evil'), null);
});

test('a storage that throws on write loses that key, not the whole recovery', () => {
  // Quota or private mode: keep going rather than abandoning the rest.
  const s = fakeStorage({});
  const realSet = s.setItem;
  s.setItem = (k, v) => {
    if (k === 'csmpn_library') throw new Error('QuotaExceeded');
    realSet(k, v);
  };
  const done = arr(os.restoreMissing(s, { csmpn_library: '[]', csmpn_stage: 'perform' }));
  assert.deepEqual(done, ['csmpn_stage'], 'the writable key still got through');
});

test('missingKeys ignores a mirror entry that is explicitly null', () => {
  assert.deepEqual(arr(os.missingKeys(fakeStorage({}), { csmpn_library: null })), []);
});

// ── Reporting ────────────────────────────────────────────────────────────────

test('snapshotSummary counts songs and setlists for an honest message', () => {
  const snap = { csmpn_library: '[{"t":"a"},{"t":"b"}]', csmp_setlist_v1: '[{"n":"set"}]' };
  const sum = os.snapshotSummary(snap);
  assert.equal(sum.songs, 2);
  assert.equal(sum.setlists, 1);
});

test('snapshotSummary reports 0 rather than guessing on unreadable data', () => {
  const sum = os.snapshotSummary({ csmpn_library: 'not json' });
  assert.equal(sum.songs, 0);
  assert.equal(os.snapshotSummary({}).songs, 0);
  assert.equal(os.snapshotSummary(null).setlists, 0);
});

// ── Environment ──────────────────────────────────────────────────────────────

test('supported() is false without IndexedDB rather than throwing', () => {
  assert.equal(os.supported(), false, 'no indexedDB in the vm');
});

test('sync and recover degrade to a no-op when there is no IndexedDB', async () => {
  // The app must boot identically on a browser that refuses storage.
  assert.equal(await os.sync(fakeStorage({})), false);
  assert.deepEqual(arr(await os.recover(fakeStorage({}))), []);
  assert.equal(await os.requestPersistence(), false);
});

test('offlineStore ships — it is in the deploy copy list', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\\\n/g, ' ');
  assert.ok(/cp [^\n]*\bofflineStore\.js\b/s.test(ci), 'offlineStore.js in the cp step');
});

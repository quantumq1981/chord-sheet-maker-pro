import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadBackup() {
  const root = new URL('..', import.meta.url);
  const ctx = { window: {}, console, module: { exports: {} } };
  ctx.module = { exports: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('backupRestore.js', root), 'utf8'), ctx);
  return ctx.window.BackupRestore;
}

// Minimal in-memory localStorage stand-in.
function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
}

test('buildBackup captures only present whitelisted keys in a versioned envelope', () => {
  const B = loadBackup();
  const store = memStorage({
    csmpn_library: '[{"title":"A"}]',
    csmpn_settings: '{"fontSize":"M"}',
    somethingElse: 'should not be backed up',
  });
  const env = B.buildBackup(store, '2026-06-07T00:00:00.000Z');
  assert.equal(env.app, 'chord-sheet-maker-pro');
  assert.equal(env.version, 1);
  assert.equal(env.exportedAt, '2026-06-07T00:00:00.000Z');
  assert.ok('csmpn_library' in env.data);
  assert.ok('csmpn_settings' in env.data);
  assert.ok(!('somethingElse' in env.data), 'non-whitelisted keys excluded');
  assert.ok(!('csmp_setlist_v1' in env.data), 'absent keys are omitted, not null');
});

test('backupSummary reports song and setlist counts', () => {
  const B = loadBackup();
  const env = B.buildBackup(
    memStorage({
      csmpn_library: JSON.stringify([{ title: 'A' }, { title: 'B' }, { title: 'C' }]),
      csmp_setlist_v1: JSON.stringify([{ id: 1 }, { id: 2 }]),
      csmpn_settings: '{"fontSize":"M"}',
    })
  );
  const s = B.backupSummary(env);
  assert.equal(s.songs, 3);
  assert.equal(s.setlistCharts, 2);
  assert.equal(s.hasSettings, true);
});

test('parseBackup rejects non-JSON and foreign files, accepts a real envelope', () => {
  const B = loadBackup();
  assert.equal(B.parseBackup('not json{').ok, false);
  assert.equal(B.parseBackup('{"app":"something-else","data":{}}').ok, false);
  assert.equal(B.parseBackup('{"foo":1}').ok, false);
  const good = B.serializeBackup(memStorage({ csmpn_library: '[]' }));
  assert.equal(B.parseBackup(good).ok, true);
});

test('round-trip: serialize then restore reproduces the user-data keys', () => {
  const B = loadBackup();
  const src = memStorage({
    csmpn_library: '[{"title":"Song"}]',
    csmp_setlist_v1: '[{"id":7}]',
    csmpn_settings: '{"barsPerRow":4}',
    csmpn_appMode: 'power',
  });
  const json = B.serializeBackup(src);
  const parsed = B.parseBackup(json);
  assert.equal(parsed.ok, true);
  const dest = memStorage();
  const n = B.applyBackup(parsed.envelope, dest);
  assert.equal(n, 4);
  assert.equal(dest.getItem('csmpn_library'), '[{"title":"Song"}]');
  assert.equal(dest.getItem('csmp_setlist_v1'), '[{"id":7}]');
  assert.equal(dest.getItem('csmpn_appMode'), 'power');
});

test('applyBackup never writes keys outside the whitelist (injection guard)', () => {
  const B = loadBackup();
  const dest = memStorage();
  const malicious = {
    app: 'chord-sheet-maker-pro',
    version: 1,
    data: { csmpn_library: '[]', evilKey: 'pwned', csmpn_powerPin: '0000' },
  };
  const n = B.applyBackup(malicious, dest);
  assert.equal(dest.getItem('csmpn_library'), '[]');
  assert.equal(dest.getItem('evilKey'), null, 'arbitrary keys are ignored');
  assert.equal(dest.getItem('csmpn_powerPin'), null, 'PIN is intentionally not restorable');
  assert.equal(n, 1);
});

test('backupFilename is date-stamped', () => {
  const B = loadBackup();
  assert.match(
    B.backupFilename(new Date('2026-06-07T12:00:00Z')),
    /^chord-sheet-backup-2026-06-07\.json$/
  );
});

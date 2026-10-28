import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { resolvePaths } from '../../src/infra/paths.js';
import { PluginStore, type PluginRow } from '../../src/plugins/store.js';

/**
 * PluginStore（D104 P0a-2 步骤 1）：`plugins` 行的增删改查往返、`plugin_items`
 * 账本的插入顺序 / 幂等 / 级联删除 / ownerOf 查询、enabled 的布尔 ↔ 整数转换。
 */

const root = mkdtempSync(path.join(tmpdir(), 'plugin-store-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRig(): {
  store: PluginStore;
  db: SqliteDatabase;
  paths: ReturnType<typeof resolvePaths>;
} {
  const home = path.join(root, `home-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(home, { recursive: true });
  const paths = resolvePaths(home);
  const db = openDatabase({
    path: path.join(home, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return { store: new PluginStore(db), db, paths };
}

function row(id: string, patch: Partial<PluginRow> = {}): PluginRow {
  return {
    id,
    version: '1.0.0',
    origin: 'local',
    tier: 'developer',
    state: 'installing',
    enabled: true,
    packageSha256: 'a'.repeat(64),
    marketplace: null,
    dir: `${id.split('/')[0]}/${id.split('/')[1]}@1.0.0`.toLowerCase(),
    updateTo: null,
    updateSnapshot: null,
    configJson: '{}',
    installedAt: 1000,
    updatedAt: 1000,
    ...patch,
  };
}

describe('PluginStore', () => {
  it('round-trips rows (list / get / insert / update / delete)', () => {
    const { store } = makeRig();
    expect(store.list()).toEqual([]);
    expect(store.get('io.github.tester/one')).toBeNull();

    store.insert(row('io.github.tester/one'));
    store.insert(row('io.github.tester/two', { installedAt: 500 }));
    // order by installed_at, id
    expect(store.list().map((entry) => entry.id)).toEqual([
      'io.github.tester/two',
      'io.github.tester/one',
    ]);

    const got = store.get('io.github.tester/one');
    expect(got).toMatchObject({
      id: 'io.github.tester/one',
      version: '1.0.0',
      origin: 'local',
      tier: 'developer',
      state: 'installing',
      enabled: true,
      dir: 'io.github.tester/one@1.0.0',
    });

    store.update('io.github.tester/one', { state: 'installed', updatedAt: 2000 });
    expect(store.get('io.github.tester/one')).toMatchObject({
      state: 'installed',
      updatedAt: 2000,
    });
    // An empty patch is a no-op (no SQL).
    store.update('io.github.tester/one', {});
    expect(store.get('io.github.tester/one')?.updatedAt).toBe(2000);

    store.delete('io.github.tester/one');
    expect(store.get('io.github.tester/one')).toBeNull();
  });

  it('converts the enabled boolean to the integer column and back', () => {
    const { store } = makeRig();
    store.insert(row('io.github.tester/on', { enabled: true }));
    store.insert(row('io.github.tester/off', { enabled: false }));
    expect(store.get('io.github.tester/on')?.enabled).toBe(true);
    expect(store.get('io.github.tester/off')?.enabled).toBe(false);
    store.update('io.github.tester/on', { enabled: false });
    store.update('io.github.tester/off', { enabled: true });
    expect(store.get('io.github.tester/on')?.enabled).toBe(false);
    expect(store.get('io.github.tester/off')?.enabled).toBe(true);
  });

  it('round-trips the update journal columns and lists updating rows', () => {
    const { store } = makeRig();
    store.insert(row('io.github.tester/still'));
    store.insert(row('io.github.tester/updating'));
    expect(store.listUpdating().map((entry) => entry.id)).toEqual([]);

    const snapshot = JSON.stringify({ mcp: '{"servers":[]}' });
    store.update('io.github.tester/updating', {
      updateTo: '2.0.0',
      updateSnapshot: snapshot,
      updatedAt: 3000,
    });
    const got = store.get('io.github.tester/updating');
    expect(got).toMatchObject({ updateTo: '2.0.0', updateSnapshot: snapshot });
    expect(store.listUpdating().map((entry) => entry.id)).toEqual(['io.github.tester/updating']);
    expect(store.get('io.github.tester/still')).toMatchObject({
      updateTo: null,
      updateSnapshot: null,
    });

    // The commit / rollback path clears both columns again.
    store.update('io.github.tester/updating', { updateTo: null, updateSnapshot: null });
    expect(store.listUpdating()).toEqual([]);
    expect(store.get('io.github.tester/updating')).toMatchObject({
      updateTo: null,
      updateSnapshot: null,
      updatedAt: 3000,
    });
  });

  it('keeps ledger insertion order, is idempotent on addItem, and cascades on delete', () => {
    const { store } = makeRig();
    store.insert(row('io.github.tester/one'));
    store.addItem('io.github.tester/one', 'skill', 'alpha');
    store.addItem('io.github.tester/one', 'mcp', 'plg_abc');
    store.addItem('io.github.tester/one', 'skill', 'beta');
    store.addItem('io.github.tester/one', 'skill', 'alpha'); // idempotent
    expect(store.items('io.github.tester/one')).toEqual([
      { kind: 'skill', ref: 'alpha' },
      { kind: 'mcp', ref: 'plg_abc' },
      { kind: 'skill', ref: 'beta' },
    ]);
    expect(store.refs('io.github.tester/one', 'skill')).toEqual(['alpha', 'beta']);
    expect(store.refs('io.github.tester/one', 'mail')).toEqual([]);

    store.removeItem('io.github.tester/one', 'skill', 'alpha');
    expect(store.refs('io.github.tester/one', 'skill')).toEqual(['beta']);
    // Removing again is a no-op.
    store.removeItem('io.github.tester/one', 'skill', 'alpha');

    store.delete('io.github.tester/one');
    expect(store.items('io.github.tester/one')).toEqual([]);
  });

  it('ownerOf hits only what the ledger registered', () => {
    const { store } = makeRig();
    store.insert(row('io.github.tester/one'));
    store.insert(row('io.github.tester/two'));
    store.addItem('io.github.tester/one', 'skill', 'shared-name');
    store.addItem('io.github.tester/two', 'connector', 'slug-a');
    expect(store.ownerOf('skill', 'shared-name')).toBe('io.github.tester/one');
    expect(store.ownerOf('connector', 'slug-a')).toBe('io.github.tester/two');
    expect(store.ownerOf('mail', 'nope')).toBeNull();
    expect(store.ownerOf('skill', 'slug-a')).toBeNull();
    store.removeItem('io.github.tester/one', 'skill', 'shared-name');
    expect(store.ownerOf('skill', 'shared-name')).toBeNull();
  });
});

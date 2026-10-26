import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';

/**
 * 0053_plugins (D104, docs/design/51-plugin-system.md §7): the plugin ledger pair.
 * Built-in plugins never get a row; `plugin_items` is the projection ledger that
 * uninstall / rollback / conflict checks read, so deleting a plugin row cascades it.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'plugins-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

const insertPlugin = (db: SqliteDatabase, id = 'io.github.alice/doc-tools') =>
  db
    .prepare(
      "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at) values (?, '1.0.0', 'local', 'developer', 'installed', 1, ?, NULL, 'io.github.alice/doc-tools@1.0.0', 1, 1)",
    )
    .run(id, 'a'.repeat(64));

describe('0053 plugins migration', () => {
  it('creates the tables, the ledger index and reaches the target version', () => {
    const db = openMainDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );
    for (const name of ['plugins', 'plugin_items']) {
      expect(
        db.prepare('select 1 from sqlite_master where type = ? and name = ?').get('table', name),
      ).toBeDefined();
    }
    expect(
      db
        .prepare("select 1 from sqlite_master where type = 'index' and name = 'plugin_items_ref'")
        .get(),
    ).toBeDefined();
    closeDatabase(db);
  });

  it('rejects local origin with a non-developer tier', () => {
    const db = openMainDb();
    expect(() =>
      db
        .prepare(
          "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at) values ('io.github.a/b', '1.0.0', 'local', 'verified', 'installed', 1, ?, NULL, 'io.github.a/b@1.0.0', 1, 1)",
        )
        .run('a'.repeat(64)),
    ).toThrow();
    closeDatabase(db);
  });

  it('requires the marketplace column for marketplace origin', () => {
    const db = openMainDb();
    expect(() =>
      db
        .prepare(
          "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at) values ('io.github.a/b', '1.0.0', 'marketplace', 'verified', 'installed', 1, ?, NULL, 'io.github.a/b@1.0.0', 1, 1)",
        )
        .run('a'.repeat(64)),
    ).toThrow();
    closeDatabase(db);
  });

  it('rejects an unknown state', () => {
    const db = openMainDb();
    expect(() =>
      db
        .prepare(
          "insert into plugins (id, version, origin, tier, state, enabled, package_sha256, marketplace, dir, installed_at, updated_at) values ('io.github.a/b', '1.0.0', 'local', 'developer', 'paused', 1, ?, NULL, 'io.github.a/b@1.0.0', 1, 1)",
        )
        .run('a'.repeat(64)),
    ).toThrow();
    closeDatabase(db);
  });

  it('cascades plugin_items when the plugin row goes', () => {
    const db = openMainDb();
    insertPlugin(db);
    db.prepare("insert into plugin_items (plugin_id, kind, ref) values ('io.github.alice/doc-tools', 'skill', 'docx')").run();
    db.prepare("insert into plugin_items (plugin_id, kind, ref) values ('io.github.alice/doc-tools', 'mcp', 'plg_abc123456789')").run();
    expect(
      db.prepare('select count(*) as n from plugin_items').get() as { n: number },
    ).toEqual({ n: 2 });
    db.prepare('delete from plugins').run();
    expect(
      db.prepare('select count(*) as n from plugin_items').get() as { n: number },
    ).toEqual({ n: 0 });
    closeDatabase(db);
  });

  it('enforces the (plugin_id, kind, ref) ledger primary key', () => {
    const db = openMainDb();
    insertPlugin(db);
    const insert = db.prepare(
      "insert into plugin_items (plugin_id, kind, ref) values ('io.github.alice/doc-tools', 'skill', 'docx')",
    );
    insert.run();
    expect(() => insert.run()).toThrow();
    closeDatabase(db);
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * 0024_app_connections（D73 P0）：app_connections 表 + 部分唯一索引。升级路径
 * 用「真实迁移目录截到 0023」建旧库再跑全量迁移（真库，不用 stub）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'app-connections-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
}

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('main');
  const target = mkdtempSync(path.join(dir, 'migrations-'));
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

function insertConnection(
  db: SqliteDatabase,
  id: string,
  connectorId: string,
  accountSub: string | null,
): void {
  db.prepare(
    "insert into app_connections (id, connector_id, label, account_sub, status, created_at, updated_at) values (?, ?, 'label', ?, 'connected', 1, 1)",
  ).run(id, connectorId, accountSub);
}

describe('0024 app_connections 迁移', () => {
  it('旧库（0023）升级后出现 app_connections，列与默认值符合设计 29 §12', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(23));
    expect(
      db.prepare("select 1 from sqlite_master where name = 'app_connections'").get(),
    ).toBeUndefined();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied[0]?.version).toBe(24);
    expect(applied[0]?.file).toBe('0024_app_connections.sql');

    const columns = (
      db.prepare('pragma table_info(app_connections)').all() as Array<{
        name: string;
        notnull: number;
      }>
    ).map((c) => c.name);
    expect(columns).toEqual([
      'id',
      'connector_id',
      'connector_ver',
      'label',
      'account_sub',
      'server_url',
      'issuer',
      'scopes',
      'token_expires_at',
      'discovery_json',
      'status',
      'created_at',
      'updated_at',
      'last_used_at',
      // 0025_app_tools 追加（ALTER TABLE ADD COLUMN）：存量基线标记。
      'baseline_pending',
    ]);
    // 没有任何令牌 / 密钥列（令牌只在 secrets 表）。
    expect(columns.some((c) => /token(?!_expires)|secret|refresh|access/.test(c))).toBe(false);

    insertConnection(db, 'custom:srv_a', 'custom:srv_a', null);
    const row = db.prepare('select * from app_connections where id = ?').get('custom:srv_a') as
      Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      scopes: '',
      connector_ver: null,
      server_url: null,
      issuer: null,
      token_expires_at: null,
      discovery_json: null,
      last_used_at: null,
    });
    const clientColumns = (
      db.prepare('pragma table_info(oauth_clients)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(clientColumns).toEqual([
      'issuer_hash',
      'issuer',
      'source',
      'redirect_uris',
      'created_at',
      'updated_at',
    ]);
    closeDatabase(db);
  });

  it('(connector_id, account_sub) 部分唯一：account_sub 为 NULL 的行不参与去重', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));

    insertConnection(db, 'conn_1', 'com.notion/mcp', 'user-1');
    expect(() => insertConnection(db, 'conn_2', 'com.notion/mcp', 'user-1')).toThrow(/UNIQUE/);
    // 同账号不同 Connector、同 Connector 不同账号都允许。
    insertConnection(db, 'conn_3', 'com.linear/mcp', 'user-1');
    insertConnection(db, 'conn_4', 'com.notion/mcp', 'user-2');
    // NULL account_sub：同一 Connector 可有多行。
    insertConnection(db, 'conn_5', 'com.notion/mcp', null);
    insertConnection(db, 'conn_6', 'com.notion/mcp', null);
    // 主键仍唯一。
    expect(() => insertConnection(db, 'conn_1', 'x', null)).toThrow(/UNIQUE|PRIMARY/);
    closeDatabase(db);
  });
});

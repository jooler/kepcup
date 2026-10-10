import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/**
 * 0027_egress_approval（D73 P2）：approvals.kind 增 'egress'（重建表，带全现有 kind，旧行与
 * 索引保留）+ 新表 app_taint。升级路径用「真实迁移目录截到 0025」建旧库再跑全量迁移。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'egress-migration-'));
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

const ALL_KINDS = [
  'access',
  'unsandboxed',
  'command',
  'git_remote',
  'environment',
  'skill_import',
  'profile_change',
  'skill_preset',
  'mcp_tool',
  'butler_proposal',
  'agent_tool',
  'egress',
];

function insertApproval(db: SqliteDatabase, id: string, kind: string, status = 'pending'): void {
  db.prepare(
    "insert into approvals (id, kind, payload_json, status, created_at) values (?, ?, '{}', ?, 1)",
  ).run(id, kind, status);
}

describe('0027 egress_approval 迁移', () => {
  it('旧库（0026，含已有审批行）升级：旧行保留，egress 可写，app_taint 出现', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(26));
    insertApproval(db, 'apr_old1', 'mcp_tool', 'approved');
    insertApproval(db, 'apr_old2', 'agent_tool');
    expect(() => insertApproval(db, 'apr_x', 'egress')).toThrow(/CHECK/);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((entry) => entry.version)).toEqual(mainVersionsAfter(26));
    expect(applied[0]?.file).toBe('0027_egress_approval.sql');

    expect(db.prepare('select id, kind, status from approvals order by id').all()).toEqual([
      { id: 'apr_old1', kind: 'mcp_tool', status: 'approved' },
      { id: 'apr_old2', kind: 'agent_tool', status: 'pending' },
    ]);
    insertApproval(db, 'apr_new', 'egress');
    closeDatabase(db);
  });

  it('CHECK 带全现有 kind 且仍拒绝未知 kind / status；索引保留', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    for (const kind of ALL_KINDS) insertApproval(db, `apr_${kind}`, kind);
    expect(() => insertApproval(db, 'apr_bad', 'not_a_kind')).toThrow(/CHECK/);
    expect(() => insertApproval(db, 'apr_bad2', 'egress', 'maybe')).toThrow(/CHECK/);
    const index = db
      .prepare("select sql from sqlite_master where type = 'index' and name = 'approvals_pending'")
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/approvals\(status, conversation_id\)/);
    closeDatabase(db);
  });

  it('app_taint：主键 (bot_id, conversation_id)；列与非空约束', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const columns = db.prepare('pragma table_info(app_taint)').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map((c) => c.name)).toEqual([
      'bot_id',
      'conversation_id',
      'first_at',
      'expires_at',
    ]);
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      'bot_id',
      'conversation_id',
    ]);
    expect(columns.every((c) => c.notnull === 1)).toBe(true);
    const insert = () => db.prepare("insert into app_taint values ('b', 'c', 1, 2)").run();
    insert();
    expect(insert).toThrow(/UNIQUE|PRIMARY/);
    db.prepare("insert into app_taint values ('b', 'c2', 1, 2)").run();
    closeDatabase(db);
  });
});

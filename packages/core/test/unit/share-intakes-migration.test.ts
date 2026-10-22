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
 * 0047_share_intakes（D94）：新增 share_intakes 表。附件表与消息表结构不变。
 * 升级路径用「真实迁移目录截到 0046」建旧库再跑全量迁移。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'share-intakes-migration-'));
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

function insertIntake(
  db: SqliteDatabase,
  id: string,
  state: string,
  extra: { targetKind?: string; targetId?: string; conversationId?: string | null } = {},
): void {
  db.prepare(
    'insert into share_intakes (id, state, target_kind, target_id, conversation_id, attempts, created_at, updated_at) values (?, ?, ?, ?, ?, 0, 1, 1)',
  ).run(
    id,
    state,
    extra.targetKind ?? 'bot',
    extra.targetId ?? 'bot_x',
    extra.conversationId ?? null,
  );
}

describe('0047 share_intakes 迁移', () => {
  it('旧库（0046）升级：只新增表，旧数据不变', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(46));
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((entry) => entry.version)).toEqual(mainVersionsAfter(46));
    expect(applied[0]?.file).toBe('0047_share_intakes.sql');
    // 附件表结构不变（D94-12：不改 attachments）。
    const columns = db.prepare('pragma table_info(attachments)').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'conversation_id',
      'message_id',
      'file_name',
      'mime',
      'size',
      'sha256',
      'rel_path',
      'created_at',
    ]);
    closeDatabase(db);
  });

  it('列与约束齐全', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const columns = db.prepare('pragma table_info(share_intakes)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'state',
      'target_kind',
      'target_id',
      'conversation_id',
      'message_id',
      'attempts',
      'error_code',
      'error_message',
      'created_at',
      'updated_at',
    ]);
    const notNull = new Set(columns.filter((c) => c.notnull === 1).map((c) => c.name));
    expect([...notNull].sort()).toEqual([
      'attempts',
      'created_at',
      'state',
      'target_id',
      'target_kind',
      'updated_at',
    ]);
    closeDatabase(db);
  });

  it('state / target_kind 的 CHECK 拒绝非法值', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertIntake(db, 'shr_ok', 'received');
    expect(() => insertIntake(db, 'shr_bad', 'unknown')).toThrow(/CHECK/);
    expect(() => insertIntake(db, 'shr_bad2', 'received', { targetKind: 'group' })).toThrow(
      /CHECK/,
    );
    for (const state of ['received', 'processing', 'done', 'failed_target', 'failed']) {
      insertIntake(db, `shr_${state}`, state);
    }
    const rows = db.prepare('select state from share_intakes order by id').all() as Array<{
      state: string;
    }>;
    expect(rows.map((r) => r.state)).toContain('failed_target');
    closeDatabase(db);
  });

  it('待处理索引在 (state, updated_at) 上', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const index = db
      .prepare(
        "select sql from sqlite_master where type = 'index' and name = 'share_intakes_pending'",
      )
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/share_intakes\(state, updated_at\)/);
    closeDatabase(db);
  });

  it('迁移可重复执行（幂等）', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    expect(runMigrations(db, migrationsUrl('main'))).toEqual([]);
    closeDatabase(db);
  });
});

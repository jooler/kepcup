import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter, runsVersionsAfter } from '../support/migration-versions.js';

/**
 * D140（todo/agent-autonomy-and-parallel-tasks.md §3.2）：main 0083 重建 grants
 * （duration CHECK 增 'task'）与 approvals（kind CHECK 增 'worktree_apply'，带全现有
 * kind）；runs 0018 增 task_isolation / task_worktree_path / task_worktree_base 三列。
 * 升级路径用「真实迁移目录截到 0082 / 0017」建旧库、预置各 duration / kind 的行，再跑
 * 全量迁移（真库），断言行不丢、CHECK 生效。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'd140-migrations-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
}

function openRunsDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.runsDb),
  });
}

function migrationsUpTo(kind: 'main' | 'runs', maxVersion: number): string {
  const source = migrationsUrl(kind);
  const target = mkdtempSync(path.join(dir, `migrations-${kind}-`));
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

function insertGrant(db: SqliteDatabase, id: string, duration: string, revokedAt: number | null) {
  db.prepare(
    "insert into grants (id, bot_id, conversation_id, path, access, duration, run_id, approval_id, created_at, revoked_at) values (?, 'bot_1', 'conv_1', '/tmp/x', 'write', ?, 'run_1', NULL, 1, ?)",
  ).run(id, duration, revokedAt);
}

function insertApproval(db: SqliteDatabase, id: string, kind: string, status = 'pending'): void {
  db.prepare(
    "insert into approvals (id, kind, payload_json, status, created_at) values (?, ?, '{}', ?, 1)",
  ).run(id, kind, status);
}

describe('main 0083 d140 approvals_grants 迁移', () => {
  it('旧库（0082，含各 duration 的 grants 与各 kind 的 approvals）升级：行不丢，新枚举可写', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo('main', 82));
    db.prepare("insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1)").run();
    insertGrant(db, 'grt_once', 'once', null);
    insertGrant(db, 'grt_conv', 'conversation', null);
    insertGrant(db, 'grt_revoked', 'conversation', 2);
    insertApproval(db, 'apr_access', 'access', 'approved');
    insertApproval(db, 'apr_egress', 'egress');
    insertApproval(db, 'apr_cc', 'computer_control');
    expect(() => insertGrant(db, 'grt_task', 'task', null)).toThrow(/CHECK/);
    expect(() => insertApproval(db, 'apr_wt', 'worktree_apply')).toThrow(/CHECK/);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((entry) => entry.version)).toEqual(mainVersionsAfter(82));
    expect(applied[0]?.file).toBe('0083_d140_approvals_grants.sql');

    // Rows survive the rebuilds with their values (incl. the revoked grant).
    expect(db.prepare('select id, duration, revoked_at from grants order by id').all()).toEqual([
      { id: 'grt_conv', duration: 'conversation', revoked_at: null },
      { id: 'grt_once', duration: 'once', revoked_at: null },
      { id: 'grt_revoked', duration: 'conversation', revoked_at: 2 },
    ]);
    expect(db.prepare('select id, kind, status from approvals order by id').all()).toEqual([
      { id: 'apr_access', kind: 'access', status: 'approved' },
      { id: 'apr_cc', kind: 'computer_control', status: 'pending' },
      { id: 'apr_egress', kind: 'egress', status: 'pending' },
    ]);

    // The widened CHECKs accept the new values and still reject unknown ones.
    insertGrant(db, 'grt_task', 'task', null);
    expect(() => insertGrant(db, 'grt_bad', 'forever', null)).toThrow(/CHECK/);
    insertApproval(db, 'apr_wt', 'worktree_apply');
    expect(() => insertApproval(db, 'apr_bad', 'not_a_kind')).toThrow(/CHECK/);
    // The partial index was recreated (the grants "active" lookup path).
    const index = db
      .prepare("select sql from sqlite_master where type = 'index' and name = 'grants_active'")
      .get() as { sql: string } | undefined;
    expect(index?.sql).toMatch(/grants\(conversation_id, bot_id\)/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });

  it('新库全量迁移成功：两 CHECK 直接接受 task / worktree_apply', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    db.prepare("insert into conversations (id, type, created_at) values ('conv_1', 'direct', 1)").run();
    insertGrant(db, 'grt_task', 'task', null);
    insertApproval(db, 'apr_wt', 'worktree_apply');
    expect(db.prepare('select count(*) as n from grants').get()).toEqual({ n: 1 });
    expect(db.prepare("select kind from approvals where id = 'apr_wt'").get()).toEqual({
      kind: 'worktree_apply',
    });
    closeDatabase(db);
  });
});

describe('runs 0018 task_worktree 迁移', () => {
  it('0017 库升级：三列出现、旧行为 NULL、可写', () => {
    const db = openRunsDb();
    runMigrations(db, migrationsUpTo('runs', 17));
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_old', 'bot_x', 'conv_a', 'task', 'completed', 1)",
    );

    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((m) => m.version)).toEqual(runsVersionsAfter(17));
    expect(applied[0]?.file).toBe('0018_task_worktree.sql');

    const columns = db.prepare('pragma table_info(runs)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain('task_isolation');
    expect(names).toContain('task_worktree_path');
    expect(names).toContain('task_worktree_base');

    expect(
      db.prepare('select task_isolation, task_worktree_path, task_worktree_base from runs where id = ?').get(
        'run_old',
      ),
    ).toEqual({ task_isolation: null, task_worktree_path: null, task_worktree_base: null });

    db.prepare(
      "update runs set task_isolation = 'worktree', task_worktree_path = '/x/.worktree/kepcup-3f9a1c2d', task_worktree_base = 'abc123' where id = 'run_old'",
    ).run();
    expect(
      db.prepare('select task_isolation, task_worktree_path, task_worktree_base from runs where id = ?').get(
        'run_old',
      ),
    ).toEqual({
      task_isolation: 'worktree',
      task_worktree_path: '/x/.worktree/kepcup-3f9a1c2d',
      task_worktree_base: 'abc123',
    });
    closeDatabase(db);
  });
});

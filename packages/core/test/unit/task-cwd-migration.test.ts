import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { runsVersionsAfter } from '../support/migration-versions.js';

/**
 * runs 0013_task_cwd（D92 T0-1，D75「任务执行根目录」workdir → cwd）：仓库第一次
 * 用 `ALTER TABLE … RENAME COLUMN`。升级路径用「真实迁移目录截到 0012」建旧库、
 * 写入带 `task_workdir` 值的 run 行，再跑全量迁移（真库）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'task-cwd-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(info: string): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), info),
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

describe('runs 0013 task_cwd 迁移', () => {
  it('0012 库升级：task_workdir 改名 task_cwd，既有值保留，旧列名不存在', () => {
    const db = openDb(KEY_INFO.runsDb);
    runMigrations(db, migrationsUpTo('runs', 12));
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, task_title, task_writes, task_workdir, created_at) values ('run_w', 'bot_x', 'conv_a', 'task', 'completed', '写文件', 1, '/proj/root', 1)",
    );
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_r', 'bot_x', 'conv_a', 'turn', 'completed', 2)"
    );

    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((m) => m.version)).toEqual(runsVersionsAfter(12));

    // The column is renamed: the stored value survives, the old name is gone.
    expect(db.prepare('select task_cwd from runs where id = ?').get('run_w')).toEqual({
      task_cwd: '/proj/root',
    });
    expect(db.prepare('select task_cwd from runs where id = ?').get('run_r')).toEqual({
      task_cwd: null,
    });
    const columns = db.prepare('pragma table_info(runs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('task_cwd');
    expect(columns.map((column) => column.name)).not.toContain('task_workdir');
    // Writing through the old name no longer works.
    expect(() =>
      db.prepare("update runs set task_workdir = '/x' where id = 'run_w'").run(),
    ).toThrow(/no such column/i);
    closeDatabase(db);
  });
});

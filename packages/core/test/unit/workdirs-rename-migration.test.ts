import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main 0038_workdirs_rename（D92 T0-2，D28「共享目录」project → workdir）：
 * 表 `projects` 改名 `workdirs`，`conversations.project_id` / `run_changes.project_id`
 * 改名 `workdir_id`。SQLite 的 RENAME 会同步改写 `run_changes` 指向 `projects` 的
 * 外键。旧行、外键与值都必须原样保留。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'workdirs-rename-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
}

/** Migrations up to `maxVersion` (inclusive) in a fresh directory. */
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

describe('main 0038 workdirs rename', () => {
  it('renames the table and columns, keeps rows, values and the run_changes foreign key', () => {
    const db = openMainDb();
    // Build to 0037 (pre-rename shape) and seed one row of each kind.
    const upTo37 = migrationsUpTo(37);
    runMigrations(db, upTo37);
    db.prepare(
      "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_1', 'a', '{}', 'active', 0, 0)",
    ).run();
    db.prepare(
      "insert into projects (id, path, name, protect_rules_json, status, created_at, last_used_at) values ('prj_1', '/tmp/dir-a', 'dir-a', '{}', 'available', 10, 10)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, project_id, read_only, created_at) values ('conv_1', 'direct', 'bot_1', 'prj_1', 0, 0)",
    ).run();
    db.prepare(
      "insert into run_changes (run_id, project_id, conversation_id, before_oid, created_at) values ('run_1', 'prj_1', 'conv_1', 'oid-1', 0)",
    ).run();

    // Apply 0038 (and everything after it).
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([38, 39, 40]);

    // Table renamed, row preserved, old name gone.
    const tables = (
      db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toContain('workdirs');
    expect(tables).not.toContain('projects');
    expect(
      db.prepare("select id, path, name, status from workdirs").all(),
    ).toEqual([{ id: 'prj_1', path: '/tmp/dir-a', name: 'dir-a', status: 'available' }]);

    // Column renames with values preserved.
    expect(
      db.prepare('select workdir_id from conversations where id = ?').get('conv_1'),
    ).toEqual({ workdir_id: 'prj_1' });
    expect(
      db.prepare('select workdir_id, before_oid from run_changes where run_id = ?').get('run_1'),
    ).toEqual({ workdir_id: 'prj_1', before_oid: 'oid-1' });

    // The run_changes foreign key was rewritten to point at workdirs.
    const fks = db.pragma('foreign_key_list(run_changes)') as Array<{ table: string }>;
    expect(fks.map((fk) => fk.table)).toContain('workdirs');
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Cascade delete through the renamed table still works.
    db.prepare("delete from workdirs where id = 'prj_1'").run();
    expect(db.prepare('select count(*) as n from run_changes').get()).toEqual({ n: 0 });
    db.close();
  });
});

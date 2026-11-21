import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/**
 * 0082 personal-domain ownership (62.11 C13): todos / memos / memo_groups /
 * schedules / watches / stickies gain a nullable owner_principal_id plus owner
 * indexes (stickies' partial, global-only). Upgrade a version-81 database
 * seeded with rows in every table: each row must survive with the new column
 * NULL (single-user status quo), the column must be writable, the indexes must
 * exist, and the upgraded database must satisfy its foreign keys.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'personal-domain-owner-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 21), KEY_INFO.mainDb),
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

function insertBot(db: SqliteDatabase, id: string): void {
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values (?, 'Bot', '{}', 'active', 0, 0)",
  ).run(id);
}

function upgraded(): SqliteDatabase {
  const db = openMainDb();
  runMigrations(db, migrationsUpTo(81));
  return db;
}

function indexNames(db: SqliteDatabase, table: string): string[] {
  return (
    db
      .prepare(
        `select name from sqlite_master where type = 'index' and tbl_name = '${table}' and name not like 'sqlite_autoindex%' order by name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function seedPersonalDomain(db: SqliteDatabase): void {
  insertBot(db, 'bot_a');
  db.prepare(
    "insert into conversations (id, type, direct_bot_id, created_at) values ('conv_1', 'direct', 'bot_a', 1)",
  ).run();
  db.prepare(
    `insert into todos (id, title, notes, status, source, created_at, updated_at, position)
     values ('todo_1', '旧事项', '', 'draft', 'user', 1, 1, 1024)`,
  ).run();
  db.prepare(
    `insert into memos (id, body, pinned, source, created_at, updated_at, sort_at, position)
     values ('memo_1', '旧备忘', 0, 'user', 1, 1, 1, 1024)`,
  ).run();
  db.prepare(
    `insert into memo_groups (id, title, position, created_at, updated_at) values ('mmg_1', '旧分组', 1024, 1, 1)`,
  ).run();
  db.prepare(
    `insert into schedules (id, bot_id, conversation_id, kind, timezone, note, title, origin, status, next_fire_at, created_at)
     values ('sch_1', 'bot_a', 'conv_1', 'once', 'UTC', '旧排期', '', 'tool', 'active', 100, 1)`,
  ).run();
  db.prepare(
    `insert into watches (id, bot_id, conversation_id, source_json, condition_json, interval_sec, status, next_check_at, created_at, updated_at)
     values ('wat_1', 'bot_a', 'conv_1', '{}', '{}', 600, 'active', 100, 1, 1)`,
  ).run();
  db.prepare(
    `insert into stickies (id, conversation_id, scope, text, z, created_at, updated_at)
     values ('stc_1', 'conv_1', 'global', '旧便签', 1, 1, 1)`,
  ).run();
  db.prepare(
    `insert into stickies (id, conversation_id, scope, text, z, created_at, updated_at)
     values ('stc_2', 'conv_1', 'conversation', '旧会话便签', 2, 1, 1)`,
  ).run();
}

describe('0082 personal-domain owner migration (main)', () => {
  it('keeps every seeded row with the new column NULL, makes it writable, and adds the owner indexes', () => {
    const db = upgraded();
    seedPersonalDomain(db);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toEqual(mainVersionsAfter(81));
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );

    // (a) 行原样保留，新列 NULL（单用户现状）。
    expect(
      db.prepare('select title, status, owner_principal_id from todos where id = ?').get('todo_1'),
    ).toEqual({ title: '旧事项', status: 'draft', owner_principal_id: null });
    expect(
      db.prepare('select body, owner_principal_id from memos where id = ?').get('memo_1'),
    ).toEqual({ body: '旧备忘', owner_principal_id: null });
    expect(
      db.prepare('select title, owner_principal_id from memo_groups where id = ?').get('mmg_1'),
    ).toEqual({ title: '旧分组', owner_principal_id: null });
    expect(
      db.prepare('select note, status, owner_principal_id from schedules where id = ?').get('sch_1'),
    ).toEqual({ note: '旧排期', status: 'active', owner_principal_id: null });
    expect(
      db.prepare('select interval_sec, owner_principal_id from watches where id = ?').get('wat_1'),
    ).toEqual({ interval_sec: 600, owner_principal_id: null });
    expect(
      db.prepare('select scope, text, owner_principal_id from stickies order by id').all(),
    ).toEqual([
      { scope: 'global', text: '旧便签', owner_principal_id: null },
      { scope: 'conversation', text: '旧会话便签', owner_principal_id: null },
    ]);

    // (b) 新列可写、可查（团队路径按主体归属）。
    for (const [table, id] of [
      ['todos', 'todo_1'],
      ['memos', 'memo_1'],
      ['memo_groups', 'mmg_1'],
      ['schedules', 'sch_1'],
      ['watches', 'wat_1'],
      ['stickies', 'stc_1'],
    ] as const) {
      db.prepare(`update ${table} set owner_principal_id = 'pr_1' where id = ?`).run(id);
      expect(
        db.prepare(`select owner_principal_id as owner from ${table} where id = ?`).get(id),
      ).toEqual({ owner: 'pr_1' });
    }

    // (c) 索引存在；stickies 的是 partial（只覆盖 scope='global' 行）。
    expect(indexNames(db, 'todos')).toContain('todos_owner');
    expect(indexNames(db, 'memos')).toContain('memos_owner');
    expect(indexNames(db, 'memo_groups')).toContain('memo_groups_owner');
    expect(indexNames(db, 'schedules')).toContain('schedules_owner');
    expect(indexNames(db, 'watches')).toContain('watches_owner');
    expect(indexNames(db, 'stickies')).toContain('stickies_global_owner');
    const stickieIndexSql = (
      db
        .prepare("select sql from sqlite_master where type = 'index' and name = 'stickies_global_owner'")
        .get() as { sql: string }
    ).sql;
    expect(stickieIndexSql).toMatch(/scope = 'global'/i);
    // partial 索引不覆盖会话作用域行：查 stc_2 的 owner 走不了该索引也无妨（断言仅核对可更新）。
    db.prepare("update stickies set owner_principal_id = 'pr_2' where id = 'stc_2'").run();

    // (d) 全库外键干净。
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });
});

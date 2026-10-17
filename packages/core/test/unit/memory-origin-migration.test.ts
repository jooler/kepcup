import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { memoryMigrationsUrl } from '../../src/memory/manager.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * memory 0003（D92 T1a，WP4 §3.E）：`memory_items` 重建，`origin` 取值
 * `('private','project')`，旧 `'group'` 行转 `'project'`、`'private'` 保留；
 * FTS 行（`item_id` 非外键）与 `memory_active` 索引保留，新 CHECK 拒绝 `'group'`。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'memory-origin-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMemoryDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `memory-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
}

function memoryMigrationsUpTo(maxVersion: number): string {
  const source = memoryMigrationsUrl();
  const target = mkdtempSync(path.join(dir, 'migrations-'));
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    copyFileSync(path.join(source, name), path.join(target, name));
  }
  return target;
}

function insertItem(
  db: SqliteDatabase,
  id: string,
  origin: string,
  content: string,
): void {
  db.prepare(
    `insert into memory_items
       (id, kind, content, subject, source, evidence_json, origin, origin_conversation_id,
        confidence, sensitivity, private_to_bot, status, created_at, updated_at)
     values (?, 'fact', ?, null, 'explicit', '[]', ?, 'conv_1', 1, 'normal', 0, 'active', 0, 0)`,
  ).run(id, content, origin);
}

describe('memory 0003 origin project (WP4 §3.E)', () => {
  it("'group' 行转 'project'，'private' 保留，FTS 行与索引保留，CHECK 拒绝 'group'", () => {
    const db = openMemoryDb();
    const appliedOld = runMigrations(db, memoryMigrationsUpTo(2));
    expect(appliedOld.map((m) => m.version)).toEqual([1, 2]);

    insertItem(db, 'mem_group', 'group', '项目里约定周四站会');
    insertItem(db, 'mem_private', 'private', '用户偏好简洁回复');
    // 两种 origin 各补一行 FTS（0003 重建表后必须还在）。
    db.prepare(
      "insert into memory_fts (segmented_text, item_id) values ('站会', 'mem_group')",
    ).run();
    db.prepare(
      "insert into memory_fts (segmented_text, item_id) values ('简洁', 'mem_private')",
    ).run();

    const applied = runMigrations(db, memoryMigrationsUrl());
    expect(applied.map((m) => m.version)).toEqual([3]);

    const rows = db
      .prepare('select id, origin, content from memory_items order by id')
      .all() as Array<{ id: string; origin: string; content: string }>;
    expect(rows).toEqual([
      { id: 'mem_group', origin: 'project', content: '项目里约定周四站会' },
      { id: 'mem_private', origin: 'private', content: '用户偏好简洁回复' },
    ]);

    // FTS 行保留（按 item_id 关联，不经外键）。
    const fts = db
      .prepare('select item_id from memory_fts order by item_id')
      .all() as Array<{ item_id: string }>;
    expect(fts.map((row) => row.item_id)).toEqual(['mem_group', 'mem_private']);
    expect(
      (db.prepare("select item_id from memory_fts where memory_fts match '站会'").all() as unknown[])
        .length,
    ).toBe(1);

    // 索引重建。
    const indexes = db.prepare("pragma index_list('memory_items')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((index) => index.name)).toContain('memory_active');

    // 新 CHECK：'group' 再也写不进去。
    expect(() => insertItem(db, 'mem_bad', 'group', 'x')).toThrow(/CHECK|constraint/i);
    db.close();
  });

  it('全新库直接跑全量迁移：origin 取值只有 private / project', () => {
    const db = openMemoryDb();
    const applied = runMigrations(db, memoryMigrationsUrl());
    expect(applied.map((m) => m.version)).toEqual([1, 2, 3]);
    const check = (
      db
        .prepare(
          "select sql from sqlite_master where type = 'table' and name = 'memory_items'",
        )
        .get() as { sql: string }
    ).sql;
    expect(check).toContain("origin IN ('private', 'project')");
    expect(check).not.toContain('group');
    db.close();
  });
});

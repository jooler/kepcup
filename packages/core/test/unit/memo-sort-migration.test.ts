import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import type { Clock } from '../../src/infra/clock.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { MemoStore } from '../../src/workbench/memo-store.js';

/**
 * main 0046_memo_sort_at：备忘列表的排序键从「最后修改时间」里独立出来。
 * 旧行回填 created_at（既有备忘保持相对次序），索引改按 sort_at 排序。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'memo-sort-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  return db;
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

describe('main 0046 memo sort key', () => {
  it('旧行回填 created_at，索引改为按 sort_at 排序', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(45));
    // 0046 之前的老行：没有 sort_at。
    db.prepare(
      `insert into memos (id, body, pinned, source, created_at, updated_at, deleted_at)
       values ('memo_old', '老备忘', 0, 'user', 100, 500, null)`,
    ).run();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(46);

    const row = db.prepare('select * from memos where id = ?').get('memo_old') as Record<
      string,
      unknown
    >;
    // 回填创建时间：既有备忘改按记录时间排（被改过的退回原本的位置）。
    expect(row.sort_at).toBe(100);
    expect(row.updated_at).toBe(500);

    const indexSql = (
      db.prepare("select sql from sqlite_master where type = 'index' and name = 'memos_live'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(indexSql).toContain('sort_at');
    db.close();
  });

  it('迁移后新备忘按排序键排序，改正文不换位', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    let now = 1_000;
    const clock: Clock = { now: () => now };
    const store = new MemoStore(db, clock);

    const a = store.insert({ body: 'a', source: 'user' });
    now = 2_000;
    const b = store.insert({ body: 'b', source: 'user' });
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]);

    now = 3_000;
    store.update(a.id, { body: 'a 改过' });
    // 改正文只动 updated_at，排序键不动 → 位置不变。
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]);
    expect(store.get(a.id)).toMatchObject({ updatedAt: 3_000, sortAt: 1_000 });

    // 置顶才动排序键：提到置顶组最前。
    now = 4_000;
    store.update(a.id, { pinned: true });
    expect(store.list().map((m) => m.id)).toEqual([a.id, b.id]);
    expect(store.get(a.id)?.sortAt).toBe(4_000);
    db.close();
  });
});

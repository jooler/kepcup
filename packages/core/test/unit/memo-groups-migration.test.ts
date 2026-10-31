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
 * main 0063_memo_groups：备忘分组（memo_groups + memos.group_id）与备忘/事项的手动
 * 拖拽排序键 position。回填按改动前的显示顺序展开——拖动之前看到的一切不变。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'memo-groups-migration-'));
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

describe('main 0063 memo groups', () => {
  it('旧行回填 position：按旧显示顺序（置顶在前，其余 sort_at 倒序）展开；索引改按 position', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(62));
    // 0063 之前的行（旧显示顺序 = 置顶在前，其余 sort_at 倒序）：
    // pinned p1 → b(900) → a(500) → c(100)。
    const insert = db.prepare(
      `insert into memos (id, body, pinned, source, created_at, updated_at, sort_at, deleted_at)
       values (?, ?, ?, 'user', 0, 0, ?, null)`,
    );
    insert.run('memo_p1', '置顶', 1, 800);
    insert.run('memo_a', 'a', 0, 500);
    insert.run('memo_b', 'b', 0, 900);
    insert.run('memo_c', 'c', 0, 100);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(63);

    const rows = db
      .prepare('select id, group_id, position from memos order by position asc')
      .all() as Array<{ id: string; group_id: string | null; position: number }>;
    // position 升序 = 旧显示顺序；group_id 全空（未分组）。
    expect(rows.map((r) => r.id)).toEqual(['memo_p1', 'memo_b', 'memo_a', 'memo_c']);
    expect(rows.map((r) => r.group_id)).toEqual([null, null, null, null]);
    // position 单调递增且留有步长间隙。
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.position).toBeGreaterThan(rows[i - 1]!.position);
    }

    const indexSql = (
      db.prepare("select sql from sqlite_master where type = 'index' and name = 'memos_live'").get() as
        | { sql: string }
        | undefined
    )?.sql;
    expect(indexSql).toContain('position');
    db.close();
  });

  it('事项回填：道序 = 未指派 → Bot → 项目组，道内按状态 + 更新时间展开', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(62));
    const insert = db.prepare(
      `insert into todos (id, title, notes, assignee_bot_id, assignee_project_id, status,
                          source, memo_id, blocked_reason, pending_when, created_at, updated_at, closed_at)
       values (?, '', '', ?, ?, ?, 'user', null, null, null, 0, ?, null)`,
    );
    // 未指派草案（新改动在前）→ bot_2 的已排期 → bot_2 的草案 → 项目组待验收。
    insert.run('todo_u2', null, null, 'draft', 50);
    insert.run('todo_u1', null, null, 'draft', 40);
    insert.run('todo_b1', 'bot_2', null, 'scheduled', 10);
    insert.run('todo_b2', 'bot_2', null, 'draft', 20);
    insert.run('todo_g1', null, 'conv_g', 'delivered', 30);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(63);

    const rows = db
      .prepare('select id, position from todos order by position asc')
      .all() as Array<{ id: string; position: number }>;
    // 道序 = 未指派 → Bot → 项目组；未指派道内草案按新改动在前，Bot 道内已排期在草案前。
    expect(rows.map((r) => r.id)).toEqual(['todo_u2', 'todo_u1', 'todo_b1', 'todo_b2', 'todo_g1']);
    db.close();
  });

  it('迁移后：分组与拖拽可用，新备忘仍插到未分组顶', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    let now = 1_000;
    const clock: Clock = { now: () => now };
    const store = new MemoStore(db, clock);

    const a = store.insert({ body: 'a', source: 'user' });
    now = 2_000;
    const b = store.insert({ body: 'b', source: 'user' });
    expect(store.list().map((m) => m.id)).toEqual([b.id, a.id]);

    const g = store.insertGroup('工作');
    now = 3_000;
    store.move(a.id, g.id, null);
    expect(store.listInGroup(g.id).map((m) => m.id)).toEqual([a.id]);
    expect(store.listInGroup(null).map((m) => m.id)).toEqual([b.id]);
    expect(store.listGroups().map((item) => item.title)).toEqual(['工作']);

    // 新备忘插到未分组顶，不影响分组内的 a。
    now = 4_000;
    const c = store.insert({ body: 'c', source: 'user' });
    expect(store.listInGroup(null).map((m) => m.id)).toEqual([c.id, b.id]);
    db.close();
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main 0037_workbench（D90，todo/workbench.md §4.1 / §4.2）：新表 todos /
 * todo_runs / memos；schedules 重建（bot_id 可空、origin 加 'workbench'、
 * 增 todo_id）。旧行原样保留，索引与外键完好。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'workbench-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
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

/**
 * Seeds one direct chat plus a second conversation. `legacy` = pre-0040 shape
 * ('group', seeded before the 0039/0040 migrations run, so it must carry a
 * member row to survive 0039's lead-candidate check); otherwise the current
 * 'project' shape with a lead.
 */
function seedBotAndConversation(db: SqliteDatabase, legacy: boolean): void {
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_1', 'a', '{}', 'active', 0, 0)",
  ).run();
  db.prepare(
    "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_1', 'direct', 'bot_1', 0, 0)",
  ).run();
  if (legacy) {
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_2', 'group', null, 0, 0)",
    ).run();
    db.prepare(
      "insert into conversation_members (conversation_id, bot_id, joined_at) values ('conv_2', 'bot_1', 0)",
    ).run();
  } else {
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, lead_bot_id, read_only, created_at) values ('conv_2', 'project', null, 'bot_1', 0, 0)",
    ).run();
  }
}

interface ScheduleSeed {
  id: string;
  bot_id: string | null;
  conversation_id?: string;
  kind?: 'once' | 'cron';
  origin?: string;
  commitment_id?: string | null;
  todo_id?: string | null;
  status?: string;
  next_fire_at?: number | null;
  last_fired_at?: number | null;
}

/** Inserts a schedules row; `todo_id` only exists from 0037 on. */
function insertSchedule(db: SqliteDatabase, seed: ScheduleSeed, withTodoId: boolean): void {
  const row = {
    conversation_id: 'conv_1',
    kind: 'once',
    origin: 'tool',
    commitment_id: null,
    todo_id: null,
    status: 'active',
    next_fire_at: 100,
    last_fired_at: null,
    ...seed,
  };
  db.prepare(
    `insert into schedules
       (id, bot_id, conversation_id, kind, run_at, cron, timezone, note, title, origin,
        commitment_id, ${withTodoId ? 'todo_id,' : ''} status, next_fire_at, last_fired_at, created_at)
     values (@id, @bot_id, @conversation_id, @kind, 1, null, 'UTC', 'note', 'title', @origin,
        @commitment_id, ${withTodoId ? '@todo_id,' : ''} @status, @next_fire_at, @last_fired_at, 0)`,
  ).run(withTodoId ? row : { ...row, todo_id: undefined });
}

describe('main 0037 workbench', () => {
  it('creates the todos / todo_runs / memos tables with their indexes', () => {
    const db = openMainDb();
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toContain(37);

    const tables = (
      db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['todos', 'todo_runs', 'memos']));

    const indexes = (
      db.prepare("select name from sqlite_master where type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'todos_status',
        'todo_runs_todo',
        'memos_live',
        'schedules_next',
        'schedules_todo',
      ]),
    );

    // status / source CHECKs.
    const insertTodo = db.prepare(
      "insert into todos (id, title, status, source, created_at, updated_at) values (?, 't', ?, ?, 0, 0)",
    );
    insertTodo.run('todo_ok', 'draft', 'user');
    expect(() => insertTodo.run('todo_bad_status', 'running', 'user')).toThrow(/CHECK/);
    expect(() => insertTodo.run('todo_bad_source', 'draft', 'bot')).toThrow(/CHECK/);
    const insertRun = db.prepare(
      "insert into todo_runs (id, todo_id, conversation_id, status, dispatched_at) values (?, 'todo_ok', 'conv_gone', ?, 0)",
    );
    insertRun.run('tdr_ok', 'dispatched');
    expect(() => insertRun.run('tdr_bad', 'ok')).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "insert into memos (id, body, source, created_at, updated_at) values ('memo_bad', 'b', 'bot', 0, 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    // Deleting a todo cascades its runs.
    db.prepare("delete from todos where id = 'todo_ok'").run();
    expect(db.prepare('select count(*) as n from todo_runs').get()).toEqual({ n: 0 });
    db.close();
  });

  it('rebuilds schedules keeping every old row, index and foreign key', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(36));
    seedBotAndConversation(db, true);
    insertSchedule(db, { id: 'sch_tool', bot_id: 'bot_1' }, false);
    insertSchedule(
      db,
      {
        id: 'sch_commit',
        bot_id: 'bot_1',
        kind: 'cron',
        origin: 'commitment',
        commitment_id: 'mem_1',
        last_fired_at: 150,
      },
      false,
    );
    insertSchedule(
      db,
      {
        id: 'sch_offer',
        bot_id: 'bot_1',
        conversation_id: 'conv_2',
        origin: 'offer',
        status: 'done',
        next_fire_at: null,
      },
      false,
    );
    const before = db.prepare('select * from schedules order by id').all() as Array<
      Record<string, unknown>
    >;
    expect(before).toHaveLength(3);
    // Pre-0037 shape has no todo_id column.
    expect(before[0]).not.toHaveProperty('todo_id');

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([37, 38, 39, 40, 41, 42]);

    const after = db.prepare('select * from schedules order by id').all() as Array<
      Record<string, unknown>
    >;
    expect(after).toEqual(before.map((row) => ({ ...row, todo_id: null })));

    // Indexes survive / are rebuilt.
    const indexes = db.prepare("pragma index_list('schedules')").all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining(['schedules_next', 'schedules_todo']),
    );
    // The foreign key to conversations is intact: cascade delete still removes rows.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare("delete from conversations where id = 'conv_2'").run();
    expect(db.prepare('select id from schedules order by id').all()).toEqual([
      { id: 'sch_commit' },
      { id: 'sch_tool' },
    ]);
    db.close();
  });

  it("accepts origin 'workbench', rejects unknown origins, allows a null bot_id", () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    seedBotAndConversation(db, false);
    db.prepare(
      "insert into todos (id, title, status, source, created_at, updated_at) values ('todo_1', 't', 'scheduled', 'user', 0, 0)",
    ).run();
    // Group todo without a lead bot: bot_id null.
    insertSchedule(
      db,
      {
        id: 'sch_wb',
        bot_id: null,
        conversation_id: 'conv_2',
        origin: 'workbench',
        todo_id: 'todo_1',
      },
      true,
    );
    expect(
      db.prepare("select bot_id, origin, todo_id from schedules where id = 'sch_wb'").get(),
    ).toEqual({ bot_id: null, origin: 'workbench', todo_id: 'todo_1' });
    expect(() =>
      insertSchedule(db, { id: 'sch_bogus', bot_id: 'bot_1', origin: 'bogus' }, true),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("update schedules set origin = 'bogus' where id = 'sch_wb'").run(),
    ).toThrow(/CHECK/);
    // bot_id may only be null for a workbench row; todo_id only belongs on a workbench row.
    expect(() =>
      insertSchedule(db, { id: 'sch_nobot', bot_id: null, origin: 'tool' }, true),
    ).toThrow(/CHECK/);
    expect(() =>
      insertSchedule(db, { id: 'sch_tool_todo', bot_id: 'bot_1', origin: 'tool', todo_id: 'todo_1' }, true),
    ).toThrow(/CHECK/);
    // todo_id must reference an existing todo.
    expect(() =>
      insertSchedule(
        db,
        { id: 'sch_nofk', bot_id: 'bot_1', origin: 'workbench', todo_id: 'todo_missing' },
        true,
      ),
    ).toThrow(/FOREIGN KEY/);
    // Deleting the todo keeps the schedule and nulls the link (the one-way CHECK allows it).
    db.prepare("delete from todos where id = 'todo_1'").run();
    expect(db.prepare("select todo_id from schedules where id = 'sch_wb'").get()).toEqual({
      todo_id: null,
    });
    db.close();
  });
});

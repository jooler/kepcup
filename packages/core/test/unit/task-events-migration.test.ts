import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main 0018_task_events / runs 0006_tasks（D75，docs/design/30 §2.4.2 / §3.4）。
 * messages 被 attachments.message_id ON DELETE CASCADE 引用，而迁移在
 * foreign_keys=ON 的事务内执行——重建必须不经级联删掉附件。升级路径用「真实
 * 迁移目录截到 0017 / 0005」建旧库、写入历史行，再跑全量迁移（真库）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'task-events-migration-'));
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

function indexNames(db: SqliteDatabase, table: string): string[] {
  return (
    db
      .prepare("select name from sqlite_master where type = 'index' and tbl_name = ?")
      .all(table) as Array<{ name: string }>
  ).map((row) => row.name);
}

function seedOldMainDb(db: SqliteDatabase): void {
  db.exec(`
    insert into conversations (id, type, last_seq, created_at) values ('conv_a', 'group', 3, 1);
    insert into messages (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, reply_to, mentions_json, batch_id, run_id, status, edited_at, created_at)
      values ('msg_1', 'conv_a', 1, 'user', null, 'text', '{"text":"你好 世界"}', null, '["bot_x"]', 'bat_1', null, 'edited', 7, 2),
             ('msg_2', 'conv_a', 2, 'bot', 'bot_x', 'text', '{"text":"收到"}', 'msg_1', '[]', null, 'run_1', 'normal', null, 3),
             ('msg_3', 'conv_a', 3, 'system', null, 'card', '{"cardType":"environment","approvalId":"apr_1"}', null, '[]', null, null, 'normal', null, 4);
    insert into messages_fts (segmented_text, message_id, conversation_id) values ('你好 世界', 'msg_1', 'conv_a');
    insert into attachments (id, conversation_id, message_id, draft_id, file_name, mime, size, sha256, rel_path, created_at)
      values ('att_1', 'conv_a', 'msg_1', null, 'a.png', 'image/png', 10, 'h1', 'a.png', 5),
             ('att_2', 'conv_a', null, 'drf_1', 'b.txt', 'text/plain', 20, 'h2', 'b.txt', 6);
  `);
}

describe('main 0018 task_events 迁移', () => {
  it('0017 库升级：messages / attachments / FTS 原样保留，外键与级联仍指向 messages', () => {
    const db = openDb(KEY_INFO.mainDb);
    runMigrations(db, migrationsUpTo('main', 17));
    seedOldMainDb(db);
    const before = db.prepare('select * from messages order by seq').all();
    const attachmentsBefore = db.prepare('select * from attachments order by id').all();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([18, 19, 20, 21, 22, 23]);

    // Every old column survives; the new columns are NULL on existing rows.
    const after = db.prepare('select * from messages order by seq').all() as Array<
      Record<string, unknown>
    >;
    expect(after).toEqual(
      (before as Array<Record<string, unknown>>).map((row) => ({
        ...row,
        owner_bot_id: null,
        task_id: null,
      })),
    );
    expect(db.prepare('select * from attachments order by id').all()).toEqual(attachmentsBefore);
    expect(
      db.prepare("select message_id from messages_fts where messages_fts match '世界'").all(),
    ).toEqual([{ message_id: 'msg_1' }]);

    // FK still references messages (rename carried over), integrity intact.
    const fks = db.prepare('pragma foreign_key_list(attachments)').all() as Array<{
      table: string;
      from: string;
      on_delete: string;
    }>;
    expect(fks).toContainEqual(
      expect.objectContaining({ table: 'messages', from: 'message_id', on_delete: 'CASCADE' }),
    );
    expect(db.prepare('pragma foreign_key_check').all()).toEqual([]);
    expect(
      (
        db.prepare("select sql from sqlite_master where name = 'attachments'").get() as {
          sql: string;
        }
      ).sql,
    ).not.toContain('messages_new');
    db.prepare("delete from messages where id = 'msg_1'").run();
    expect(db.prepare('select id from attachments order by id').all()).toEqual([{ id: 'att_2' }]);
    // Conversation cascade still reaches messages.
    db.prepare("delete from conversations where id = 'conv_a'").run();
    expect(db.prepare('select count(*) as n from messages').get()).toEqual({ n: 0 });

    expect(indexNames(db, 'messages')).toEqual(
      expect.arrayContaining([
        'messages_conv_seq',
        'messages_conv_owner_seq',
        'messages_task',
        'messages_task_terminal',
      ]),
    );
    closeDatabase(db);
  });

  it('kind CHECK 接受 task_event；终态条目每任务至多一条（非终态不受限）', () => {
    const db = openDb(KEY_INFO.mainDb);
    runMigrations(db, migrationsUrl('main'));
    db.exec(
      "insert into conversations (id, type, last_seq, created_at) values ('conv_a', 'direct', 0, 1)",
    );
    let seq = 0;
    const insert = (kind: string, taskId: string | null, phase: string | null) =>
      db
        .prepare(
          "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at, owner_bot_id, task_id) values (?, 'conv_a', ?, 'system', ?, ?, 1, 'bot_x', ?)",
        )
        .run(`msg_${++seq}`, seq, kind, JSON.stringify({ taskId, phase, text: 'x' }), taskId);
    insert('task_event', 'run_t1', 'brief');
    insert('task_event', 'run_t1', 'inject');
    insert('task_event', 'run_t1', 'inject');
    insert('task_event', 'run_t1', 'result');
    expect(() => insert('task_event', 'run_t1', 'failure')).toThrow(/UNIQUE/);
    expect(() => insert('task_event', 'run_t1', 'result')).toThrow(/UNIQUE/);
    insert('task_event', 'run_t2', 'failure');
    expect(() => insert('no_such_kind', 'run_t3', 'brief')).toThrow(/CHECK/);
    closeDatabase(db);
  });
});

describe('runs 0006 tasks 迁移', () => {
  it('0005 库升级：既有 run 保留，新列取默认值，索引就位', () => {
    const db = openDb(KEY_INFO.runsDb);
    runMigrations(db, migrationsUpTo('runs', 5));
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_old', 'bot_x', 'conv_a', 'response', 'completed', 1)",
    );
    const applied = runMigrations(db, migrationsUrl('runs'));
    // 0007 (D75 W2) renames the old 'response' loop type to 'turn'.
    expect(applied.map((m) => m.version)).toEqual([6, 7, 8, 9, 10]);
    expect(db.prepare("select * from runs where id = 'run_old'").get()).toMatchObject({
      loop_type: 'turn',
      engine: 'builtin',
      task_title: null,
      task_writes: null,
      task_workdir: null,
      origin_run_id: null,
      result_consumed_at: null,
      awaiting_input: 0,
    });
    expect(indexNames(db, 'runs')).toContain('runs_by_conv_loop_status');
    closeDatabase(db);
  });
});

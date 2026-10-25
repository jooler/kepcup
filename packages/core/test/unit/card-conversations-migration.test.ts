import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { insertProjectConversation } from '../support/projects.js';

/**
 * 0051_card_conversations: rebuild conversations with type 'card',
 * parent_project_id / card_todo_id, and one open conversation per card.
 * Upgrade from a version-50 database so existing rows and indexes are proven
 * to survive the rebuild.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'card-conversations-'));
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

function insertBot(db: SqliteDatabase, id: string): void {
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values (?, 'Bot', '{}', 'active', 0, 0)",
  ).run(id);
}

function indexNames(db: SqliteDatabase): string[] {
  return (
    db
      .prepare(
        "select name from sqlite_master where type = 'index' and tbl_name = 'conversations' and name not like 'sqlite_autoindex%' order by name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

describe('0051 card conversations migration', () => {
  it('keeps existing direct, project, and archived rows and their indexes', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(50));
    insertBot(db, 'bot_a');
    insertBot(db, 'bot_b');
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, title, read_only, summary, summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at, archived_at) values ('conv_direct', 'direct', 'bot_a', null, 0, 'sum', 1, 4, 2, 9, 3, null)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at, archived_at) values ('conv_archived', 'direct', 'bot_b', 0, 5, 8)",
    ).run();
    insertProjectConversation(db, {
      id: 'conv_project',
      title: '项目组',
      goal: '交付',
      leadBotId: 'bot_a',
    });
    db.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at) values ('msg_1', 'conv_direct', 1, 'user', 'text', '{}', 9)",
    ).run();
    const beforeIndexes = indexNames(db);
    expect(beforeIndexes).toEqual(['conversations_archived', 'conversations_one_direct_per_bot']);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toEqual([51]);
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );

    const direct = db.prepare('select * from conversations where id = ?').get('conv_direct') as Record<
      string,
      unknown
    >;
    expect(direct).toMatchObject({
      id: 'conv_direct',
      type: 'direct',
      direct_bot_id: 'bot_a',
      lead_bot_id: null,
      title: null,
      read_only: 0,
      summary: 'sum',
      summary_upto_seq: 1,
      last_seq: 4,
      last_read_seq: 2,
      last_message_at: 9,
      created_at: 3,
      archived_at: null,
      parent_project_id: null,
      card_todo_id: null,
    });
    expect(
      db.prepare('select id, type, archived_at, parent_project_id, card_todo_id from conversations where id = ?').get(
        'conv_archived',
      ),
    ).toEqual({
      id: 'conv_archived',
      type: 'direct',
      archived_at: 8,
      parent_project_id: null,
      card_todo_id: null,
    });
    expect(
      db
        .prepare(
          'select id, type, title, goal, lead_bot_id, parent_project_id, card_todo_id from conversations where id = ?',
        )
        .get('conv_project'),
    ).toEqual({
      id: 'conv_project',
      type: 'project',
      title: '项目组',
      goal: '交付',
      lead_bot_id: 'bot_a',
      parent_project_id: null,
      card_todo_id: null,
    });
    expect(db.prepare('select id from messages where conversation_id = ?').get('conv_direct')).toEqual({
      id: 'msg_1',
    });
    expect(indexNames(db)).toEqual([
      'conversations_archived',
      'conversations_one_direct_per_bot',
      'conversations_one_open_per_card',
    ]);
    const triggers = db
      .prepare("select name from sqlite_master where type = 'trigger' and tbl_name = 'conversations'")
      .all();
    expect(triggers).toEqual([]);

    const fks = db.prepare('pragma foreign_key_list(conversations)').all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    expect(fks.find((fk) => fk.from === 'parent_project_id')).toMatchObject({
      table: 'conversations',
      on_delete: 'CASCADE',
    });
    closeDatabase(db);
  });

  it('rejects a card missing any of the three fields, and direct or project rows that set the new columns', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertBot(db, 'bot_a');
    insertProjectConversation(db, { id: 'conv_project', leadBotId: 'bot_a' });
    const insert = db.prepare(
      `insert into conversations
         (id, type, direct_bot_id, lead_bot_id, parent_project_id, card_todo_id, created_at)
       values (?, ?, ?, ?, ?, ?, 1)`,
    );

    expect(() => insert.run('conv_c1', 'card', 'bot_a', null, null, 'todo_1')).toThrow();
    expect(() => insert.run('conv_c2', 'card', 'bot_a', null, 'conv_project', null)).toThrow();
    expect(() => insert.run('conv_c3', 'card', null, null, 'conv_project', 'todo_1')).toThrow();
    insert.run('conv_card', 'card', 'bot_a', null, 'conv_project', 'todo_1');

    expect(() =>
      insert.run('conv_direct_bad', 'direct', 'bot_a', null, 'conv_project', 'todo_1'),
    ).toThrow();
    expect(() => insert.run('conv_direct_one', 'direct', 'bot_a', null, 'conv_project', null)).toThrow();
    expect(() =>
      insert.run('conv_project_bad', 'project', null, 'bot_a', 'conv_project', 'todo_2'),
    ).toThrow();
    expect(() =>
      insert.run('conv_project_bot', 'project', 'bot_a', 'bot_a', 'conv_project', 'todo_2'),
    ).toThrow();

    expect(
      db.prepare('select type, parent_project_id, card_todo_id, direct_bot_id from conversations where id = ?').get(
        'conv_card',
      ),
    ).toEqual({
      type: 'card',
      parent_project_id: 'conv_project',
      card_todo_id: 'todo_1',
      direct_bot_id: 'bot_a',
    });
    closeDatabase(db);
  });

  it('allows at most one read_only=0 row per card, and cascades when the parent project is deleted', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertBot(db, 'bot_a');
    insertBot(db, 'bot_b');
    insertProjectConversation(db, { id: 'conv_project', leadBotId: 'bot_a' });
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, created_at) values ('conv_other', 'direct', 'bot_b', 1)",
    ).run();
    const insertCard = db.prepare(
      `insert into conversations
         (id, type, direct_bot_id, parent_project_id, card_todo_id, read_only, created_at)
       values (?, 'card', ?, 'conv_project', ?, ?, 1)`,
    );
    insertCard.run('conv_open', 'bot_a', 'todo_1', 0);
    expect(() => insertCard.run('conv_open_2', 'bot_b', 'todo_1', 0)).toThrow();
    insertCard.run('conv_closed', 'bot_b', 'todo_1', 1);
    insertCard.run('conv_other_card', 'bot_a', 'todo_2', 0);

    db.prepare('delete from conversations where id = ?').run('conv_project');
    const remaining = (
      db.prepare('select id from conversations order by id').all() as Array<{ id: string }>
    ).map((row) => row.id);
    expect(remaining).toEqual(['conv_other']);
    closeDatabase(db);
  });
});

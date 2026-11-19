import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter, runsVersionsAfter } from '../support/migration-versions.js';

/**
 * 0077–0080 principal seams (main) + runs 0017 run_principal. Upgrade a
 * version-76 main database seeded with direct / project / card / bot_direct
 * conversations, user and bot messages, a composer draft and a usage row:
 * every row must survive the conversations and composer_drafts rebuilds with
 * the new columns NULL / '', the old direct-chat uniqueness must keep working
 * (the index keeps its name, the key gains ifnull(owner_principal_id, '')),
 * dm rows must satisfy the CHECKs, the new tables must enforce their composite
 * primary keys, and messages.updated_at must follow AFTER UPDATE OF trigger
 * semantics. The runs library gains runs.principal_id plus its index.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'principal-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 11), KEY_INFO.mainDb),
  });
}

function openRunsDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `runs-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 12), KEY_INFO.runsDb),
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

function insertBot(db: SqliteDatabase, id: string): void {
  db.prepare(
    "insert into bots (id, name, profile_json, status, created_at, updated_at) values (?, 'Bot', '{}', 'active', 0, 0)",
  ).run(id);
}

function upgradeMain(): SqliteDatabase {
  const db = openMainDb();
  runMigrations(db, migrationsUpTo('main', 76));
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

function columnNames(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe('0077–0080 principal seams migration (main)', () => {
  it('keeps every seeded row across the rebuilds, with new columns empty, and the old uniqueness intact', () => {
    const db = upgradeMain();
    insertBot(db, 'bot_a');
    insertBot(db, 'bot_b');
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, title, read_only, summary, summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at) values ('conv_direct', 'direct', 'bot_a', null, 0, 'sum', 1, 4, 2, 9, 3)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, lead_bot_id, title, goal, last_seq, created_at) values ('conv_project', 'project', 'bot_a', 'P', 'G', 7, 4)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, parent_project_id, card_todo_id, created_at) values ('conv_card', 'card', 'bot_b', 'conv_project', 'todo_1', 5)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, from_bot_id, to_bot_id, created_at) values ('conv_x', 'bot_direct', 'bot_a', 'bot_b', 6)",
    ).run();
    db.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at) values ('msg_1', 'conv_direct', 1, 'user', 'text', '{\"type\":\"text\",\"text\":\"hi\"}', 100)",
    ).run();
    db.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, sender_bot_id, kind, content_json, created_at) values ('msg_2', 'conv_project', 1, 'bot', 'bot_a', 'text', '{\"type\":\"text\",\"text\":\"hello\"}', 110)",
    ).run();
    db.prepare(
      "insert into composer_drafts (conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at) values ('conv_direct', '{\"doc\":1}', '[]', null, '[]', 3, 200)",
    ).run();
    db.prepare(
      `insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model,
                                  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                  cost_usd, created_at)
       values ('use_1', 'run_1', 'bot_a', 'conv_direct', 'turn', 'mock', 'm-1', 10, 2, 0, 0, null, 300)`,
    ).run();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toEqual(mainVersionsAfter(76));
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );

    // (a) Row-by-row preservation across the conversations rebuild.
    expect(
      db
        .prepare(
          'select id, type, direct_bot_id, title, read_only, summary, summary_upto_seq, last_seq, last_read_seq, last_message_at, created_at, owner_principal_id from conversations where id = ?',
        )
        .get('conv_direct'),
    ).toEqual({
      id: 'conv_direct',
      type: 'direct',
      direct_bot_id: 'bot_a',
      title: null,
      read_only: 0,
      summary: 'sum',
      summary_upto_seq: 1,
      last_seq: 4,
      last_read_seq: 2,
      last_message_at: 9,
      created_at: 3,
      owner_principal_id: null,
    });
    expect(
      db
        .prepare('select type, lead_bot_id, title, goal, last_seq, owner_principal_id from conversations where id = ?')
        .get('conv_project'),
    ).toEqual({ type: 'project', lead_bot_id: 'bot_a', title: 'P', goal: 'G', last_seq: 7, owner_principal_id: null });
    expect(
      db
        .prepare('select type, direct_bot_id, parent_project_id, card_todo_id, owner_principal_id from conversations where id = ?')
        .get('conv_card'),
    ).toEqual({ type: 'card', direct_bot_id: 'bot_b', parent_project_id: 'conv_project', card_todo_id: 'todo_1', owner_principal_id: null });
    expect(
      db.prepare('select type, from_bot_id, to_bot_id, owner_principal_id from conversations where id = ?').get('conv_x'),
    ).toEqual({ type: 'bot_direct', from_bot_id: 'bot_a', to_bot_id: 'bot_b', owner_principal_id: null });

    // (a) Messages survive the untouched-shape table with the new columns NULL.
    expect(
      db.prepare('select sender_type, sender_bot_id, kind, content_json, status, created_at, sender_principal_id, sender_name, updated_at from messages where id = ?').get('msg_1'),
    ).toEqual({
      sender_type: 'user',
      sender_bot_id: null,
      kind: 'text',
      content_json: '{"type":"text","text":"hi"}',
      status: 'normal',
      created_at: 100,
      sender_principal_id: null,
      sender_name: null,
      updated_at: null,
    });
    expect(
      db.prepare('select sender_type, sender_bot_id, sender_principal_id, sender_name, updated_at from messages where id = ?').get('msg_2'),
    ).toEqual({ sender_type: 'bot', sender_bot_id: 'bot_a', sender_principal_id: null, sender_name: null, updated_at: null });

    // (a) Draft and usage rows survive their respective rebuild / column addition.
    expect(
      db.prepare('select conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at, principal_key from composer_drafts').get(),
    ).toEqual({
      conversation_id: 'conv_direct',
      doc_json: '{"doc":1}',
      mentions_json: '[]',
      reply_to: null,
      attachments_json: '[]',
      version: 3,
      updated_at: 200,
      principal_key: '',
    });
    expect(
      db.prepare('select id, run_id, bot_id, conversation_id, loop_type, provider, model, input_tokens, output_tokens, cost_usd, created_at, principal_id from usage_ledger where id = ?').get('use_1'),
    ).toEqual({
      id: 'use_1',
      run_id: 'run_1',
      bot_id: 'bot_a',
      conversation_id: 'conv_direct',
      loop_type: 'turn',
      provider: 'mock',
      model: 'm-1',
      input_tokens: 10,
      output_tokens: 2,
      cost_usd: null,
      created_at: 300,
      principal_id: null,
    });

    // (b) The renamed unique index still enforces one open direct chat per bot.
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_dup', 'direct', 'bot_a', 0, 7)",
      ).run(),
    ).toThrow(/UNIQUE/);
    // Read-only direct chats stay exempt, and other bots are unaffected.
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_ro', 'direct', 'bot_a', 1, 7)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_direct_b', 'direct', 'bot_b', 0, 7)",
    ).run();

    // (d) The whole upgraded database satisfies its foreign keys.
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Schema shape: the three conversations indexes keep their names, the
    // unique one carries the new key, and the new columns / trigger exist.
    expect(indexNames(db, 'conversations')).toEqual([
      'conversations_archived',
      'conversations_one_direct_per_bot',
      'conversations_one_open_per_card',
    ]);
    const uniqueSql = (
      db.prepare("select sql from sqlite_master where type = 'index' and name = 'conversations_one_direct_per_bot'").get() as { sql: string }
    ).sql;
    expect(uniqueSql).toMatch(/ifnull\(owner_principal_id/);
    expect(columnNames(db, 'conversations')).toContain('owner_principal_id');
    expect(columnNames(db, 'messages')).toEqual(
      expect.arrayContaining(['sender_principal_id', 'sender_name', 'updated_at']),
    );
    expect(columnNames(db, 'usage_ledger')).toContain('principal_id');
    expect(indexNames(db, 'conversation_principals')).toEqual(['conversation_principals_by_principal']);
    expect(
      db.prepare("select name from sqlite_master where type = 'trigger' and tbl_name = 'messages'").all(),
    ).toEqual([{ name: 'messages_touch_updated_at' }]);
    closeDatabase(db);
  });

  it('partitions direct chats per owner and accepts dm rows', () => {
    const db = upgradeMain();
    insertBot(db, 'bot_a');
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, created_at) values ('conv_direct', 'direct', 'bot_a', 1)",
    ).run();
    runMigrations(db, migrationsUrl('main'));

    // (c) Directs of the same bot with different owners coexist.
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, owner_principal_id, created_at) values ('conv_own_1', 'direct', 'bot_a', 'pr_1', 2)",
    ).run();
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, owner_principal_id, created_at) values ('conv_own_2', 'direct', 'bot_a', 'pr_2', 3)",
    ).run();
    // Same owner (or the NULL owner) collides again.
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, direct_bot_id, owner_principal_id, created_at) values ('conv_own_1b', 'direct', 'bot_a', 'pr_1', 4)",
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_dup', 'direct', 'bot_a', 0, 5)",
      ).run(),
    ).toThrow(/UNIQUE/);

    // (e) A dm row (no lead, no bot columns) passes every CHECK.
    db.prepare("insert into conversations (id, type, created_at) values ('conv_dm', 'dm', 6)").run();
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, lead_bot_id, created_at) values ('conv_dm_lead', 'dm', 'bot_a', 7)",
      ).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, from_bot_id, to_bot_id, created_at) values ('conv_dm_bot', 'dm', 'bot_a', 'bot_b', 8)",
      ).run(),
    ).toThrow(/CHECK/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });

  it('stores participants and read state under composite primary keys', () => {
    const db = upgradeMain();
    insertBot(db, 'bot_a');
    db.prepare(
      "insert into conversations (id, type, lead_bot_id, created_at) values ('conv_project', 'project', 'bot_a', 1)",
    ).run();
    runMigrations(db, migrationsUrl('main'));

    // (f) Participants insert cleanly; the composite key and the role CHECK hold.
    db.prepare(
      "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values ('conv_project', 'pr_a', 'lead', 2)",
    ).run();
    db.prepare(
      "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values ('conv_project', 'pr_b', 'member', 3)",
    ).run();
    expect(() =>
      db.prepare(
        "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values ('conv_project', 'pr_a', 'member', 4)",
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values ('conv_project', 'pr_c', 'owner', 5)",
      ).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(
        "insert into conversation_principals (conversation_id, principal_id, role, joined_at) values ('conv_missing', 'pr_a', 'member', 6)",
      ).run(),
    ).toThrow(/FOREIGN KEY/);

    // (f) Read state inserts cleanly; one row per (conversation, principal).
    db.prepare(
      'insert into conversation_reads (conversation_id, principal_id, last_read_seq) values (?, ?, ?)',
    ).run('conv_project', 'pr_a', 5);
    db.prepare(
      'insert into conversation_reads (conversation_id, principal_id, last_read_seq) values (?, ?, ?)',
    ).run('conv_project', 'pr_b', 7);
    expect(() =>
      db.prepare(
        'insert into conversation_reads (conversation_id, principal_id, last_read_seq) values (?, ?, ?)',
      ).run('conv_project', 'pr_a', 9),
    ).toThrow(/UNIQUE/);

    // The participant index serves principal lookups; FKs stay clean.
    expect(indexNames(db, 'conversation_principals')).toEqual(['conversation_principals_by_principal']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });

  it('maintains messages.updated_at with AFTER UPDATE OF semantics', () => {
    const db = upgradeMain();
    insertBot(db, 'bot_a');
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, created_at) values ('conv_direct', 'direct', 'bot_a', 1)",
    ).run();
    db.prepare(
      "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at) values ('msg_1', 'conv_direct', 1, 'user', 'text', '{}', 100)",
    ).run();
    runMigrations(db, migrationsUrl('main'));

    // (g) Inserts leave updated_at NULL (the reader coalesces to created_at).
    expect(db.prepare('select updated_at from messages where id = ?').get('msg_1')).toEqual({
      updated_at: null,
    });

    // A content rewrite (listed column) stamps updated_at.
    db.prepare("update messages set content_json = '{\"type\":\"text\",\"text\":\"edited\"}' where id = 'msg_1'").run();
    const stamped = db.prepare('select updated_at from messages where id = ?').get('msg_1') as {
      updated_at: number;
    };
    expect(stamped.updated_at).not.toBeNull();

    // An update touching only a non-listed column does not restamp.
    db.prepare("update messages set batch_id = 'b1' where id = 'msg_1'").run();
    expect(db.prepare('select updated_at from messages where id = ?').get('msg_1')).toEqual(stamped);

    // Clearing updated_at itself is not a listed column, so it stays cleared…
    db.prepare('update messages set updated_at = null where id = ?').run('msg_1');
    expect(db.prepare('select updated_at from messages where id = ?').get('msg_1')).toEqual({
      updated_at: null,
    });

    // …and a status change (also listed) stamps it again.
    db.prepare("update messages set status = 'recalled' where id = 'msg_1'").run();
    expect((db.prepare('select updated_at from messages where id = ?').get('msg_1') as { updated_at: number }).updated_at).not.toBeNull();
    closeDatabase(db);
  });

  it('keys composer drafts per principal with migrated rows on the empty key', () => {
    const db = upgradeMain();
    insertBot(db, 'bot_a');
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, created_at) values ('conv_direct', 'direct', 'bot_a', 1)",
    ).run();
    db.prepare(
      "insert into composer_drafts (conversation_id, doc_json, mentions_json, reply_to, attachments_json, version, updated_at) values ('conv_direct', '{}', '[]', null, '[]', 2, 50)",
    ).run();
    runMigrations(db, migrationsUrl('main'));

    // (h) The migrated row keeps its data on the empty principal key, and the
    // primary key is (conversation_id, principal_key).
    expect(db.prepare('select doc_json, version, updated_at, principal_key from composer_drafts').get()).toEqual({
      doc_json: '{}',
      version: 2,
      updated_at: 50,
      principal_key: '',
    });
    const pkOrder = (
      db.prepare('pragma table_info(composer_drafts)').all() as Array<{ name: string; pk: number }>
    ).filter((column) => column.pk > 0);
    expect(pkOrder.map((column) => column.name)).toEqual(['conversation_id', 'principal_key']);

    // A second principal gets its own row; duplicates of either key fail.
    db.prepare(
      "insert into composer_drafts (conversation_id, principal_key, doc_json, updated_at) values ('conv_direct', 'pr_1', '{}', 60)",
    ).run();
    expect(() =>
      db.prepare(
        "insert into composer_drafts (conversation_id, principal_key, doc_json, updated_at) values ('conv_direct', '', '{}', 70)",
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        "insert into composer_drafts (conversation_id, principal_key, doc_json, updated_at) values ('conv_direct', 'pr_1', '{}', 80)",
      ).run(),
    ).toThrow(/UNIQUE/);

    // The cascade from conversations survived the rebuild for both keys.
    db.prepare('delete from conversations where id = ?').run('conv_direct');
    expect(db.prepare('select count(*) as n from composer_drafts').get()).toEqual({ n: 0 });
    closeDatabase(db);
  });
});

describe('runs 0017 run_principal 迁移', () => {
  it('adds runs.principal_id, keeps existing rows NULL, and creates the principal index', () => {
    const db = openRunsDb();
    runMigrations(db, migrationsUpTo('runs', 16));
    db.prepare(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_1', 'bot_x', 'conv_a', 'turn', 'completed', 1)",
    ).run();
    db.prepare(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_2', 'bot_x', 'conv_a', 'task', 'completed', 2)",
    ).run();

    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((row) => row.version)).toEqual(runsVersionsAfter(16));
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('runs')),
    );

    // Old rows read NULL and stay intact; the new column is writable.
    expect(db.prepare('select id, status, created_at, principal_id from runs order by id').all()).toEqual([
      { id: 'run_1', status: 'completed', created_at: 1, principal_id: null },
      { id: 'run_2', status: 'completed', created_at: 2, principal_id: null },
    ]);
    db.prepare("update runs set principal_id = 'pr_1' where id = 'run_1'").run();
    db.prepare(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, principal_id, created_at) values ('run_3', 'bot_x', 'conv_a', 'turn', 'completed', 'pr_2', 3)",
    ).run();
    expect(db.prepare('select principal_id from runs where id = ?').get('run_1')).toEqual({
      principal_id: 'pr_1',
    });

    // The new index exists over (principal_id, created_at).
    expect(indexNames(db, 'runs')).toContain('runs_by_principal');
    expect(
      (
        db.prepare('pragma index_info(runs_by_principal)').all() as Array<{ name: string }>
      ).map((row) => row.name),
    ).toEqual(['principal_id', 'created_at']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });
});

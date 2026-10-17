import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main 0039 + 0040（D92 T1a，todo/project/WP1-schema-and-domain.md 步骤 2）：
 * 无法转换的旧群（D60 创建残留 / 无合格负责人候选）在 FK 开启下删除；
 * `conversations` 在 FK 关闭下重建（type 'group'→'project'、description→goal、
 * 删 setup_state、必有 lead_bot_id），旧群转换、项目会话里的管家成员行删除。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'project-conversations-'));
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

interface Seed {
  db: SqliteDatabase;
}

/** A database at version 38 with butler / botA / botB / inactive bot and four conversations. */
function seedLegacyDb(): Seed {
  const db = openMainDb();
  runMigrations(db, migrationsUpTo(38));

  const insertBot = db.prepare(
    "insert into bots (id, name, profile_json, status, system_role, created_at, updated_at) values (?, ?, '{}', ?, ?, 0, 0)",
  );
  insertBot.run('bot_butler', '管家', 'active', 'butler');
  insertBot.run('bot_a', 'A', 'active', null);
  insertBot.run('bot_b', 'B', 'active', null);
  insertBot.run('bot_gone', 'Gone', 'deleted', null);

  const insertConv = db.prepare(
    "insert into conversations (id, type, title, description, setup_state, direct_bot_id, read_only, created_at) values (?, ?, ?, ?, ?, ?, 0, 0)",
  );
  // 1) direct chat with botA.
  insertConv.run('conv_direct', 'direct', null, null, null, 'bot_a');
  // 2) convertible group: butler joined first, then botA, then botB; description set.
  insertConv.run('conv_group', 'group', '旧群', '旧定位', null, null);
  // 3) D60 leftover stuck in the creation flow.
  insertConv.run('conv_creating', 'group', null, null, 'creating', null);
  // 4) group whose only non-butler member is not active.
  insertConv.run('conv_orphan', 'group', '无成员群', null, null, null);

  const insertMember = db.prepare(
    'insert into conversation_members (conversation_id, bot_id, joined_at) values (?, ?, ?)',
  );
  insertMember.run('conv_direct', 'bot_a', 10);
  // Join order matters: the butler is the earliest member and must NOT become
  // the lead — botA (earliest active non-butler) should.
  insertMember.run('conv_group', 'bot_butler', 20);
  insertMember.run('conv_group', 'bot_a', 30);
  insertMember.run('conv_group', 'bot_b', 40);
  insertMember.run('conv_creating', 'bot_butler', 50);
  insertMember.run('conv_orphan', 'bot_butler', 60);
  insertMember.run('conv_orphan', 'bot_gone', 70);

  const insertMessage = db.prepare(
    "insert into messages (id, conversation_id, seq, sender_type, kind, content_json, created_at) values (?, ?, 1, 'user', 'text', '{}', 0)",
  );
  const insertFts = db.prepare(
    "insert into messages_fts (rowid, segmented_text, message_id, conversation_id) values (?, 'x', ?, ?)",
  );
  const insertGrant = db.prepare(
    "insert into grants (id, bot_id, conversation_id, path, access, duration, created_at) values (?, 'bot_a', ?, '/tmp', 'read', 'conversation', 0)",
  );
  const insertSchedule = db.prepare(
    "insert into schedules (id, bot_id, conversation_id, kind, run_at, timezone, note, status, next_fire_at, created_at) values (?, 'bot_a', ?, 'once', 1, 'UTC', '', 'active', 1, 0)",
  );
  const insertChain = db.prepare(
    "insert into chains (id, conversation_id, root_batch_id, max_depth_seen, created_at) values (?, ?, 'batch', 0, 0)",
  );
  let rowid = 0;
  for (const conversationId of ['conv_direct', 'conv_group', 'conv_creating', 'conv_orphan']) {
    insertMessage.run(`msg_${conversationId}`, conversationId);
    insertFts.run(++rowid, `msg_${conversationId}`, conversationId);
    insertGrant.run(`grt_${conversationId}`, conversationId);
    insertSchedule.run(`sch_${conversationId}`, conversationId);
    insertChain.run(`chn_${conversationId}`, conversationId);
  }
  return { db };
}

describe('main 0039 + 0040 project conversations', () => {
  it('converts legacy groups and deletes unconvertible ones without losing child rows', () => {
    const { db } = seedLegacyDb();
    const before = {
      messages: db
        .prepare("select count(*) as n from messages where conversation_id = 'conv_group'")
        .get() as { n: number },
      grants: db
        .prepare("select count(*) as n from grants where conversation_id = 'conv_group'")
        .get() as { n: number },
      schedules: db
        .prepare("select count(*) as n from schedules where conversation_id = 'conv_group'")
        .get() as { n: number },
      chains: db
        .prepare("select count(*) as n from chains where conversation_id = 'conv_group'")
        .get() as { n: number },
    };

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([39, 40]);

    // Direct chat untouched: type direct, no lead.
    const direct = db
      .prepare("select type, goal, lead_bot_id from conversations where id = 'conv_direct'")
      .get();
    expect(direct).toEqual({ type: 'direct', goal: null, lead_bot_id: null });

    // The convertible group became a project: lead = earliest active non-butler
    // member (botA), goal = old description, title kept.
    const project = db
      .prepare("select type, title, goal, lead_bot_id from conversations where id = 'conv_group'")
      .get();
    expect(project).toEqual({ type: 'project', title: '旧群', goal: '旧定位', lead_bot_id: 'bot_a' });

    // The butler's membership row is gone; the other members stay.
    const members = db
      .prepare(
        "select bot_id from conversation_members where conversation_id = 'conv_group' order by joined_at",
      )
      .all() as Array<{ bot_id: string }>;
    expect(members.map((m) => m.bot_id)).toEqual(['bot_a', 'bot_b']);
    // Butler memberships dropped from other converted projects too (none here),
    // and the unconvertible groups are gone entirely.
    const remaining = db.prepare('select id from conversations order by id').all() as Array<{
      id: string;
    }>;
    expect(remaining.map((r) => r.id)).toEqual(['conv_direct', 'conv_group']);

    // Their child rows and FTS rows are gone too.
    for (const conversationId of ['conv_creating', 'conv_orphan']) {
      expect(
        db.prepare('select count(*) as n from messages where conversation_id = ?').get(conversationId),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare('select count(*) as n from messages_fts where conversation_id = ?')
          .get(conversationId),
      ).toEqual({ n: 0 });
      expect(
        db.prepare('select count(*) as n from grants where conversation_id = ?').get(conversationId),
      ).toEqual({ n: 0 });
      expect(
        db
          .prepare('select count(*) as n from schedules where conversation_id = ?')
          .get(conversationId),
      ).toEqual({ n: 0 });
      expect(
        db.prepare('select count(*) as n from chains where conversation_id = ?').get(conversationId),
      ).toEqual({ n: 0 });
    }

    // The kept conversation's child rows all survived (same counts as before).
    expect(
      db.prepare("select count(*) as n from messages where conversation_id = 'conv_group'").get(),
    ).toEqual(before.messages);
    expect(
      db.prepare("select count(*) as n from grants where conversation_id = 'conv_group'").get(),
    ).toEqual(before.grants);
    expect(
      db.prepare("select count(*) as n from schedules where conversation_id = 'conv_group'").get(),
    ).toEqual(before.schedules);
    expect(
      db.prepare("select count(*) as n from chains where conversation_id = 'conv_group'").get(),
    ).toEqual(before.chains);
    expect(
      db
        .prepare("select count(*) as n from messages_fts where conversation_id = 'conv_group'")
        .get(),
    ).toEqual({ n: 1 });

    // The rebuilt database is clean and the pragma is back on.
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // setup_state is gone for good.
    const columns = db.prepare('pragma table_info(conversations)').all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).not.toContain('setup_state');
    expect(columns.map((c) => c.name)).toContain('goal');
    expect(columns.map((c) => c.name)).toContain('lead_bot_id');
    db.close();
  });

  it('enforces the project/direct CHECK on lead_bot_id', () => {
    const { db } = seedLegacyDb();
    runMigrations(db, migrationsUrl('main'));
    expect(() =>
      db
        .prepare(
          "insert into conversations (id, type, created_at) values ('conv_bad', 'project', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "insert into conversations (id, type, direct_bot_id, lead_bot_id, created_at) values ('conv_bad2', 'direct', 'bot_a', 'bot_a', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    // And the type CHECK rejects the legacy value.
    expect(() =>
      db
        .prepare(
          "insert into conversations (id, type, created_at) values ('conv_bad3', 'group', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
    db.close();
  });

  it('keeps conversations_one_direct_per_bot working after the rebuild', () => {
    const { db } = seedLegacyDb();
    runMigrations(db, migrationsUrl('main'));
    // bot_b has no direct chat yet (seed only opened one with bot_a).
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_dup', 'direct', 'bot_b', 0, 0)",
    ).run();
    expect(() =>
      db.prepare(
        "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_dup2', 'direct', 'bot_b', 0, 0)",
      ).run(),
    ).toThrow(/UNIQUE/);
    // Read-only direct chats stay exempt.
    db.prepare(
      "insert into conversations (id, type, direct_bot_id, read_only, created_at) values ('conv_dup3', 'direct', 'bot_b', 1, 0)",
    ).run();
    db.close();
  });
});

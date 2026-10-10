import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * 0016_butler_and_delegation（D70 / D71）：bots.system_role + 唯一 active 管家
 * 索引、delegations 表、approvals 重建（kind CHECK 增 butler_proposal）。
 * 升级路径用「真实迁移目录截到 0015」建旧库、写入历史审批行，再跑全量迁移。
 * 0021_delegation_intent（W6）：delegations 重建（status 增 awaiting_tasks，
 * 新增 intent / task_ids_json），旧行全列保留。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'butler-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
}

/** Real main migrations up to (and including) `maxVersion`, copied to a temp dir. */
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

const OLD_KINDS = [
  'access',
  'unsandboxed',
  'command',
  'git_remote',
  'environment',
  'skill_import',
  'profile_change',
  'skill_preset',
  'mcp_tool',
];

function insertApproval(db: SqliteDatabase, id: string, kind: string): void {
  db.prepare(
    "insert into approvals (id, kind, bot_id, conversation_id, run_id, payload_json, status, created_at) values (?, ?, null, null, null, '{}', 'approved', 1)",
  ).run(id, kind);
}

function insertBot(db: SqliteDatabase, id: string, role: string | null, status = 'active'): void {
  db.prepare(
    "insert into bots (id, name, bio, profile_json, status, system_role, created_at, updated_at) values (?, 'x', '', '{}', ?, ?, 1, 1)",
  ).run(id, status, role);
}

describe('0016 butler_and_delegation 迁移', () => {
  it('旧库升级：历史审批行（全部旧 kind）原样保留，新 kind 可写入', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(15));
    OLD_KINDS.forEach((kind, index) => insertApproval(db, `apr_old_${index}`, kind));
    // 0015 的 CHECK 拒绝新 kind（说明重建确有必要）。
    expect(() => insertApproval(db, 'apr_too_early', 'butler_proposal')).toThrow(/CHECK/);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24]);

    const kinds = (
      db.prepare('select kind from approvals order by id').all() as Array<{ kind: string }>
    ).map((row) => row.kind);
    expect(kinds.sort()).toEqual([...OLD_KINDS].sort());
    insertApproval(db, 'apr_butler', 'butler_proposal');
    expect(() => insertApproval(db, 'apr_bad', 'no_such_kind')).toThrow(/CHECK/);
    // 索引随重建恢复。
    const indexes = (
      db.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'approvals'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(indexes).toContain('approvals_pending');
    closeDatabase(db);
  });

  it('至多一个 active 管家；已删除占位行不占名额', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertBot(db, 'bot_a', 'butler');
    expect(() => insertBot(db, 'bot_b', 'butler')).toThrow(/UNIQUE/);
    insertBot(db, 'bot_c', 'butler', 'deleted');
    insertBot(db, 'bot_d', null);
    insertBot(db, 'bot_e', null);
    closeDatabase(db);
  });

  it('delegations 表：status CHECK 生效', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const insert = (id: string, status: string) =>
      db
        .prepare(
          "insert into delegations (id, from_bot_id, to_bot_id, from_conversation_id, task_text, status, created_at, updated_at) values (?, 'bot_a', 'bot_b', 'conv_a', 'task', ?, 1, 1)",
        )
        .run(id, status);
    for (const status of ['submitted', 'working', 'awaiting_tasks', 'completed', 'failed', 'cancelled']) {
      insert(`dlg_${status}`, status);
    }
    expect(() => insert('dlg_bad', 'paused')).toThrow(/CHECK/);
    closeDatabase(db);
  });
});

describe('0021 delegation_intent 迁移（W6）', () => {
  it('旧库升级：在途 / 已结束的委派行全列保留，intent 补 request、task_ids_json 补 []，新状态可写', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(20));
    const insertOld = db.prepare(
      "insert into delegations (id, from_bot_id, to_bot_id, from_conversation_id, to_conversation_id, task_text, status, depth, from_run_id, sent_message_id, to_message_id, run_id, result_excerpt, result_message_id, result_card_id, error_text, created_at, updated_at) values (?, 'bot_a', 'bot_b', 'conv_a', 'conv_b', ?, ?, 1, 'run_a', 'msg_sent', 'msg_to', ?, ?, ?, ?, ?, 5, 6)",
    );
    insertOld.run('dlg_working', '在途任务', 'working', 'run_b1', null, null, null, null);
    insertOld.run('dlg_done', '已完成任务', 'completed', 'run_b2', '结果', 'msg_reply', 'msg_card', null);
    insertOld.run('dlg_failed', '失败任务', 'failed', 'run_b3', null, null, 'msg_card2', '出错了');
    // 0016 的 CHECK 拒绝新状态（说明重建确有必要）。
    expect(() =>
      insertOld.run('dlg_too_early', 'x', 'awaiting_tasks', null, null, null, null, null),
    ).toThrow(/CHECK/);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([21, 22, 23, 24]);

    const rows = db.prepare('select * from delegations order by id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((row) => [row['id'], row]));
    expect(byId.get('dlg_working')).toMatchObject({
      status: 'working',
      task_text: '在途任务',
      from_conversation_id: 'conv_a',
      to_conversation_id: 'conv_b',
      depth: 1,
      from_run_id: 'run_a',
      sent_message_id: 'msg_sent',
      to_message_id: 'msg_to',
      run_id: 'run_b1',
      created_at: 5,
      updated_at: 6,
      intent: 'request',
      task_ids_json: '[]',
    });
    expect(byId.get('dlg_done')).toMatchObject({
      status: 'completed',
      result_excerpt: '结果',
      result_message_id: 'msg_reply',
      result_card_id: 'msg_card',
      intent: 'request',
    });
    expect(byId.get('dlg_failed')).toMatchObject({ status: 'failed', error_text: '出错了' });

    db.prepare(
      "insert into delegations (id, from_bot_id, to_bot_id, from_conversation_id, task_text, status, intent, task_ids_json, created_at, updated_at) values ('dlg_new', 'bot_a', 'bot_b', 'conv_a', 't', 'awaiting_tasks', 'fyi', '[\"run_t1\"]', 1, 1)",
    ).run();
    expect(() =>
      db
        .prepare(
          "insert into delegations (id, from_bot_id, to_bot_id, from_conversation_id, task_text, status, created_at, updated_at) values ('dlg_bad', 'a', 'b', 'c', 't', 'paused', 1, 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
    const indexes = (
      db
        .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'delegations'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'delegations_to_bot_status',
        'delegations_run',
        'delegations_from_conversation',
        'delegations_status',
      ]),
    );
    expect(db.prepare("select name from sqlite_master where name = 'delegations_new'").get()).toBeUndefined();
    closeDatabase(db);
  });
});

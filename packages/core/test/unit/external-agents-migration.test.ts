import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/**
 * 0017_external_agents（D72 P3）：approvals 重建（kind CHECK 增 agent_tool，
 * 旧 kind 全部保留）+ agent_sessions 表。升级路径用「真实迁移目录截到 0016」
 * 建旧库、写入历史行，再跑全量迁移（真库，不用 stub）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'ext-agents-migration-'));
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
  'butler_proposal',
];

function insertApproval(db: SqliteDatabase, id: string, kind: string): void {
  db.prepare(
    "insert into approvals (id, kind, bot_id, conversation_id, run_id, payload_json, status, decision_json, auto_approved, message_id, created_at, decided_at) values (?, ?, 'bot_a', 'conv_a', 'run_a', '{\"x\":1}', 'approved', '{\"duration\":\"once\"}', 1, 'msg_a', 5, 6)",
  ).run(id, kind);
}

describe('0017 external_agents 迁移', () => {
  it('旧库升级：历史审批行（全部旧 kind）原样保留，agent_tool 可写入', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(16));
    OLD_KINDS.forEach((kind, index) => insertApproval(db, `apr_old_${index}`, kind));
    expect(() => insertApproval(db, 'apr_too_early', 'agent_tool')).toThrow(/CHECK/);

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual(mainVersionsAfter(16));

    const rows = db
      .prepare('select * from approvals order by id')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row['kind']).sort()).toEqual([...OLD_KINDS].sort());
    // Every column survives the rebuild.
    expect(rows[0]).toMatchObject({
      bot_id: 'bot_a',
      conversation_id: 'conv_a',
      run_id: 'run_a',
      payload_json: '{"x":1}',
      status: 'approved',
      decision_json: '{"duration":"once"}',
      auto_approved: 1,
      message_id: 'msg_a',
      created_at: 5,
      decided_at: 6,
    });
    insertApproval(db, 'apr_agent', 'agent_tool');
    expect(() => insertApproval(db, 'apr_bad', 'no_such_kind')).toThrow(/CHECK/);
    const indexes = (
      db
        .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'approvals'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toContain('approvals_pending');
    closeDatabase(db);
  });

  it('agent_sessions：(bot, 对话, Agent) 唯一', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const insert = (id: string, agentId: string) =>
      db
        .prepare(
          "insert into agent_sessions (id, bot_id, conversation_id, agent_id, agent_session_id, fingerprint, last_run_id, last_used_at, created_at) values (?, 'bot_a', 'conv_a', ?, 'sess', 'fp', null, 1, 1)",
        )
        .run(id, agentId);
    insert('ags_1', 'claude-acp');
    insert('ags_2', 'codex-acp');
    expect(() => insert('ags_3', 'claude-acp')).toThrow(/UNIQUE/);
    closeDatabase(db);
  });
});

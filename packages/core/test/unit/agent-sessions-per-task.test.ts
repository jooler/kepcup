import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { AgentSessionsStore, type AgentSessionRow } from '../../src/domain/agent-sessions.js';

/**
 * main 0019_agent_sessions_per_task（D75，docs/design/30 §8.5）：agent_sessions
 * 唯一键加 task_id；D72 期的旧行清空。AgentSessionsStore 按任务读写、
 * `inheritTask` 单条 UPDATE 继承（目标已有行 / 来源无行 → null）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'agent-sessions-per-task-'));
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

function row(id: string, overrides: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id,
    botId: 'bot_a',
    conversationId: 'conv_a',
    agentId: 'claude-acp',
    taskId: null,
    agentSessionId: `sess_${id}`,
    fingerprint: 'fp',
    lastRunId: null,
    lastUsedAt: 1,
    createdAt: 1,
    ...overrides,
  };
}

describe('main 0019 agent_sessions per task', () => {
  it('upgrading from 0018 clears the D72 rows and keys the table by task', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(18));
    db.exec(
      "insert into agent_sessions (id, bot_id, conversation_id, agent_id, agent_session_id, fingerprint, last_run_id, last_used_at, created_at) values ('ags_old', 'bot_a', 'conv_a', 'claude-acp', 'sess', 'fp', null, 1, 1)",
    );
    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual([19, 20, 21, 22]);
    expect(db.prepare('select count(*) as n from agent_sessions').get()).toEqual({ n: 0 });
    const columns = (
      db.prepare('pragma table_info(agent_sessions)').all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).toContain('task_id');
    closeDatabase(db);
  });

  it('one row per (bot, conversation, agent, task); non-task rows stay unique by the triple', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const store = new AgentSessionsStore(db);
    store.upsert(row('ags_1'));
    store.upsert(row('ags_2', { taskId: 'run_t1' }));
    store.upsert(row('ags_3', { taskId: 'run_t2' }));
    // Same key again: replaced, not added.
    store.upsert(row('ags_4', { taskId: 'run_t1', agentSessionId: 'sess_new' }));
    store.upsert(row('ags_5'));
    expect(
      store
        .listByConversation('conv_a')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['ags_3', 'ags_4', 'ags_5']);
    expect(store.get('bot_a', 'conv_a', 'claude-acp', null)?.id).toBe('ags_5');
    expect(store.get('bot_a', 'conv_a', 'claude-acp', 'run_t1')).toMatchObject({
      id: 'ags_4',
      taskId: 'run_t1',
      agentSessionId: 'sess_new',
    });
    expect(store.get('bot_a', 'conv_a', 'claude-acp', 'run_tx')).toBeNull();
    expect(
      store
        .listTaskSessions()
        .map((r) => r.taskId)
        .sort(),
    ).toEqual(['run_t1', 'run_t2']);
    closeDatabase(db);
  });

  it('inheritTask moves the source row to the new task; refuses when there is nothing to move or a clash', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const store = new AgentSessionsStore(db);
    store.upsert(row('ags_a', { taskId: 'run_a' }));
    store.upsert(row('ags_c', { taskId: 'run_c' }));

    const inherited = store.inheritTask('bot_a', 'conv_a', 'claude-acp', 'run_a', 'run_b');
    expect(inherited).toMatchObject({ id: 'ags_a', taskId: 'run_b', agentSessionId: 'sess_ags_a' });
    expect(store.get('bot_a', 'conv_a', 'claude-acp', 'run_a')).toBeNull();
    // The source has no row any more.
    expect(store.inheritTask('bot_a', 'conv_a', 'claude-acp', 'run_a', 'run_d')).toBeNull();
    // The target already has a row: both stay as they are.
    expect(store.inheritTask('bot_a', 'conv_a', 'claude-acp', 'run_b', 'run_c')).toBeNull();
    expect(store.get('bot_a', 'conv_a', 'claude-acp', 'run_b')?.id).toBe('ags_a');
    expect(store.get('bot_a', 'conv_a', 'claude-acp', 'run_c')?.id).toBe('ags_c');
    // Other agents / conversations are never matched.
    expect(store.inheritTask('bot_a', 'conv_a', 'codex-acp', 'run_b', 'run_e')).toBeNull();
    closeDatabase(db);
  });
});

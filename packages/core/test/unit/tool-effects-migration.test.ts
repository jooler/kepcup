import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * runs 0009_tool_effects（W2 外部副作用台账，todo/borrowings-from-personal-agents.md）：
 * 0008 库升级后既有 run / 步骤原样保留、新表与索引就位；status CHECK、
 * (run_id, tool_call_id) 唯一、删除 run 级联删除台账行。真实迁移目录截到 0008
 * 建旧库（真库，加密 SQLite）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'tool-effects-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.runsDb),
  });
}

function migrationsUpTo(maxVersion: number): string {
  const source = migrationsUrl('runs');
  const target = mkdtempSync(path.join(dir, 'migrations-runs-'));
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

describe('runs 0009 tool_effects 迁移', () => {
  it('0008 库升级：既有 run 与步骤保留，表、约束与索引就位', () => {
    const db = openDb();
    runMigrations(db, migrationsUpTo(8));
    db.exec(`
      insert into runs (id, bot_id, conversation_id, loop_type, status, created_at)
        values ('run_old', 'bot_x', 'conv_a', 'task', 'interrupted', 1);
      insert into run_steps (id, run_id, seq, type, payload_json, created_at)
        values ('stp_1', 'run_old', 0, 'tool_call', '{"toolCallId":"t1","toolName":"browser_click","args":{}}', 2);
    `);
    const runsBefore = db.prepare('select * from runs').all();
    const stepsBefore = db.prepare('select * from run_steps').all();

    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((m) => m.version)).toEqual([9, 10]);
    expect(db.prepare('select * from runs').all()).toEqual(runsBefore);
    expect(db.prepare('select * from run_steps').all()).toEqual(stepsBefore);
    // Forward-only, no backfill: old runs have no ledger rows.
    expect(db.prepare('select count(*) as n from tool_effects').get()).toEqual({ n: 0 });
    expect(indexNames(db, 'tool_effects')).toEqual(
      expect.arrayContaining(['tool_effects_by_run', 'tool_effects_by_key']),
    );
    expect(indexNames(db, 'runs')).toContain('runs_by_parent');

    const insert = (id: string, runId: string, callId: string, status: string) =>
      db
        .prepare(
          `insert into tool_effects (id, run_id, tool_call_id, tool_name, effect_key, args_hash, summary, status, created_at)
           values (?, ?, ?, 'browser_click', 'k', 'h', 's', ?, 3)`,
        )
        .run(id, runId, callId, status);
    for (const [i, status] of (
      ['intended', 'executing', 'completed', 'failed', 'uncertain', 'denied'] as const
    ).entries()) {
      insert(`eff_${i}`, 'run_old', `t${i}`, status);
    }
    expect(() => insert('eff_bad', 'run_old', 't_bad', 'started')).toThrow(/CHECK/);
    expect(() => insert('eff_dup', 'run_old', 't0', 'executing')).toThrow(/UNIQUE/);
    expect(() => insert('eff_orphan', 'run_none', 'tx', 'executing')).toThrow(/FOREIGN KEY/);

    db.prepare("delete from runs where id = 'run_old'").run();
    expect(db.prepare('select count(*) as n from tool_effects').get()).toEqual({ n: 0 });
    closeDatabase(db);
  });
});

describe('runs 0010 tool_effects approval index', () => {
  it('0009 库升级：既有台账行保留，approval_id 部分索引就位并被反查使用', () => {
    const db = openDb();
    runMigrations(db, migrationsUpTo(9));
    db.exec(`
      insert into runs (id, bot_id, conversation_id, loop_type, status, created_at)
        values ('run_old', 'bot_x', 'conv_a', 'task', 'completed', 1);
      insert into tool_effects (id, run_id, tool_call_id, tool_name, effect_key, args_hash, summary, approval_id, status, created_at)
        values ('eff_a', 'run_old', 't1', 'mcp_s_send', 'k', 'h', 's', 'apr_1', 'completed', 2),
               ('eff_b', 'run_old', 't2', 'browser_click', 'k2', 'h2', 's', null, 'completed', 3);
    `);
    const before = db.prepare('select * from tool_effects order by id').all();
    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((m) => m.version)).toEqual([10]);
    expect(db.prepare('select * from tool_effects order by id').all()).toEqual(before);
    expect(indexNames(db, 'tool_effects')).toContain('tool_effects_by_approval');
    const plan = db
      .prepare("explain query plan select * from tool_effects where approval_id in ('apr_1')")
      .all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain('tool_effects_by_approval');
    // Idempotent re-run: nothing left to apply.
    expect(runMigrations(db, migrationsUrl('runs'))).toEqual([]);
    closeDatabase(db);
  });
});

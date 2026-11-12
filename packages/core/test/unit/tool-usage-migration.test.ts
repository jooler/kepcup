import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/** 0073_tool_usage：按工具的任务上下文消耗表（纯新增），版本推进到目标。 */

const dir = mkdtempSync(path.join(tmpdir(), 'tool-usage-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function openMainDb(): SqliteDatabase {
  seq += 1;
  return openDatabase({
    path: path.join(dir, `main-${seq}.db`),
    key: deriveKey(Buffer.alloc(32, 41), KEY_INFO.mainDb),
  });
}

describe('0073 tool_usage_ledger migration', () => {
  it('creates the table, its day index, and advances the schema version', () => {
    const db = openMainDb();
    try {
      const applied = runMigrations(db, migrationsUrl('main'));
      expect(applied.map((row) => row.version)).toContain(73);
      expect(db.pragma('user_version', { simple: true })).toBe(
        migrationTargetVersion(migrationsUrl('main')),
      );
      expect(
        db
          .prepare(
            "select name from sqlite_master where type = 'table' and name = 'tool_usage_ledger'",
          )
          .get(),
      ).toEqual({ name: 'tool_usage_ledger' });
      const columns = db.prepare('pragma table_info(tool_usage_ledger)').all() as Array<{
        name: string;
        dflt_value: string | null;
        notnull: number;
      }>;
      expect(columns.map((column) => column.name)).toEqual([
        'id',
        'run_id',
        'bot_id',
        'conversation_id',
        'loop_type',
        'tool_name',
        'call_tokens',
        'result_tokens',
        'calls',
        'created_at',
      ]);
      expect(columns.find((column) => column.name === 'calls')).toMatchObject({
        dflt_value: '1',
        notnull: 1,
      });
      // 只按日期窗口查询：不建没有读方的 run_id 索引。
      const indexes = db
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'tool_usage_ledger' and name not like 'sqlite_autoindex_%' order by name",
        )
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toEqual(['tool_usage_by_day']);
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades a version-72 database and preserves existing usage rows', () => {
    const db = openMainDb();
    try {
      runMigrations(db, migrationsUrl('main'));
      // 回拨到 0072：0073 之后新增的表摘除，既有账本行保留。
      db.exec('drop table tool_usage_ledger;');
      db.exec('drop table conversation_notes;');
      db.pragma('user_version = 72');
      db.prepare(
        `insert into usage_ledger (id, run_id, bot_id, conversation_id, loop_type, provider, model,
                                   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                                   cost_usd, created_at)
         values ('use_seed', 'run_seed', null, null, 'task', 'mock', 'm', 10, 2, 0, 0, null, 1000)`,
      ).run();

      const applied = runMigrations(db, migrationsUrl('main'));
      expect(applied.map((row) => row.version)).toEqual(mainVersionsAfter(72));
      expect(db.pragma('user_version', { simple: true })).toBe(
        migrationTargetVersion(migrationsUrl('main')),
      );
      expect(db.prepare('select count(*) as n from usage_ledger').get()).toEqual({ n: 1 });

      db.prepare(
        `insert into tool_usage_ledger (id, run_id, bot_id, conversation_id, loop_type, tool_name,
                                        call_tokens, result_tokens, calls, created_at)
         values ('tus_seed', 'run_seed', null, null, 'task', 'read', 3, 10, 1, 1000)`,
      ).run();
      expect(db.prepare('select tool_name, result_tokens from tool_usage_ledger').get()).toEqual({
        tool_name: 'read',
        result_tokens: 10,
      });
    } finally {
      closeDatabase(db);
    }
  });
});

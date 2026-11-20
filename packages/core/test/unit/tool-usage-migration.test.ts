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
      // 回拨到 0072：0073 之后新增的表摘除，既有账本行保留。0075 给 usage_ledger
      // 加的两列也一并摘除（ADD COLUMN 不可原样重放），0075 本体可重放。
      db.exec('drop table tool_usage_ledger;');
      db.exec('drop table conversation_notes;');
      // 0076（D125 插件运行时）的 plugin_storage 同样摘除，否则回放到 0076 时建表冲突。
      db.exec('drop table plugin_storage;');
      db.exec('alter table usage_ledger drop column capability;');
      db.exec('alter table usage_ledger drop column model_entry_id;');
      // 0077–0080（团队服务器主体缝）的新增物同样摘除：conversation_principals /
      // conversation_reads 纯新增表摘除（回放 0077 时重建）；messages 的三列与
      // 触发器摘除（触发器先删——列被触发器引用时 DROP COLUMN 会失败）；
      // conversations 摘掉 owner_principal_id（先删引用它的唯一索引再删列，再按
      // 0067 原定义重建索引；type CHECK 里的 'dm' 对回放无害，0077 重放重建时
      // 还原）；composer_drafts 本夹具无行，直接按 0072 原形态重建（回放 0079
      // 的显式列拷贝需要旧主键形状）；usage_ledger 的 principal_id 同为增量列。
      db.exec('drop table conversation_principals;');
      db.exec('drop table conversation_reads;');
      db.exec('drop trigger messages_touch_updated_at;');
      db.exec('alter table messages drop column sender_principal_id;');
      db.exec('alter table messages drop column sender_name;');
      db.exec('alter table messages drop column updated_at;');
      db.exec('drop index conversations_one_direct_per_bot;');
      db.exec('alter table conversations drop column owner_principal_id;');
      db.exec(
        "create unique index conversations_one_direct_per_bot on conversations(direct_bot_id) where type = 'direct' and read_only = 0;",
      );
      db.exec('drop table composer_drafts;');
      db.exec(`create table composer_drafts (
  conversation_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  doc_json         TEXT NOT NULL,
  mentions_json    TEXT NOT NULL DEFAULT '[]',
  reply_to         TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);`);
      db.exec('alter table usage_ledger drop column principal_id;');
      // 0081（画像主体分桶）同样摘除：两个增量列直接 drop；profile_card 重建
      // 回 0008 的单行形状（本夹具无画像行，回放 0081 时再重建）。
      db.exec('alter table profile_items drop column principal_key;');
      db.exec('alter table profile_proposals drop column principal_key;');
      db.exec('drop table profile_card;');
      db.exec(`create table profile_card (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  content     TEXT NOT NULL,
  compiled_at INTEGER NOT NULL
);`);
      // 0082（个人域归属）同样摘除：六个 owner 索引先删（列被索引引用时
      // DROP COLUMN 会失败），再摘六表的 owner_principal_id 增量列。
      // stickies 的部分索引与各表同名列一并摘除，0082 重放时原样重建。
      db.exec('drop index todos_owner;');
      db.exec('drop index memos_owner;');
      db.exec('drop index memo_groups_owner;');
      db.exec('drop index schedules_owner;');
      db.exec('drop index watches_owner;');
      db.exec('drop index stickies_global_owner;');
      db.exec('alter table todos drop column owner_principal_id;');
      db.exec('alter table memos drop column owner_principal_id;');
      db.exec('alter table memo_groups drop column owner_principal_id;');
      db.exec('alter table schedules drop column owner_principal_id;');
      db.exec('alter table watches drop column owner_principal_id;');
      db.exec('alter table stickies drop column owner_principal_id;');
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

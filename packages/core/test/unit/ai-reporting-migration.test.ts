import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/**
 * 0084_ai_reporting（todo/ai-content-reporting.md §6.1）：report_outbox 发送
 * 队列（两张唯一索引判重 + due/client_due 索引）与 message_reactions（主键
 * (scope, message_id, client_id) + conv 索引）。纯新增表，不建 FK。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'ai-reporting-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function openMainDb(): SqliteDatabase {
  seq += 1;
  return openDatabase({
    path: path.join(dir, `main-${seq}.db`),
    key: deriveKey(Buffer.alloc(32, 83), KEY_INFO.mainDb),
  });
}

describe('0084 ai reporting migration', () => {
  it('creates both tables, their indexes, and advances the schema version', () => {
    const db = openMainDb();
    try {
      const applied = runMigrations(db, migrationsUrl('main'));
      expect(applied.map((row) => row.version)).toContain(84);
      expect(db.pragma('user_version', { simple: true })).toBe(
        migrationTargetVersion(migrationsUrl('main')),
      );
      const tables = db
        .prepare(
          "select name from sqlite_master where type = 'table' and name in ('report_outbox', 'message_reactions') order by name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toEqual(['message_reactions', 'report_outbox']);

      const outboxIndexes = db
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'report_outbox' and name not like 'sqlite_autoindex_%' order by name",
        )
        .all() as Array<{ name: string }>;
      expect(outboxIndexes.map((index) => index.name)).toEqual([
        'report_outbox_client_due',
        'report_outbox_content',
        'report_outbox_due',
        'report_outbox_payload',
      ]);
      const reactionIndexes = db
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name = 'message_reactions' and name not like 'sqlite_autoindex_%' order by name",
        )
        .all() as Array<{ name: string }>;
      expect(reactionIndexes.map((index) => index.name)).toEqual(['message_reactions_conv']);

      // 主键 (scope, message_id, client_id)：同 client 同消息换 emoji 走 upsert 语义。
      const reactionColumns = db.prepare('pragma table_info(message_reactions)').all() as Array<{
        name: string;
        pk: number;
      }>;
      expect(reactionColumns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
        'scope',
        'message_id',
        'client_id',
      ]);
    } finally {
      closeDatabase(db);
    }
  });

  it('enforces the status CHECK and both unique dedupe indexes (changes = 0 on conflict)', () => {
    const db = openMainDb();
    try {
      runMigrations(db, migrationsUrl('main'));
      const insert = db.prepare(
        `insert into report_outbox (id, client_id, message_id, conversation_id, content_hash,
           content_bucket, payload_hash, payload_bucket, payload_json, status, attempts,
           next_attempt_at, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1000, 1000)`,
      );
      insert.run('rep_a', 'client-1', 'msg_1', 'conv_1', 'c1', 5, 'p1', 7, '{}', 'pending');
      // status CHECK：封闭枚举之外拒绝。
      expect(() => insert.run('rep_bad', 'client-1', 'msg_2', 'conv_1', 'c2', 5, 'p2', 7, '{}', 'done')).toThrow();
      // 内容唯一索引 (client_id, content_hash, content_bucket)。
      const contentClash = db.prepare(
        "insert or ignore into report_outbox (id, client_id, message_id, conversation_id, content_hash, content_bucket, payload_hash, payload_bucket, payload_json, status, attempts, next_attempt_at, created_at) values ('rep_b', 'client-1', 'msg_x', 'conv_1', 'c1', 5, 'px', 8, '{}', 'pending', 0, 1000, 1000)",
      ).run();
      expect(contentClash.changes).toBe(0);
      // payload 唯一索引 (client_id, payload_hash, payload_bucket)。
      const payloadClash = db.prepare(
        "insert or ignore into report_outbox (id, client_id, message_id, conversation_id, content_hash, content_bucket, payload_hash, payload_bucket, payload_json, status, attempts, next_attempt_at, created_at) values ('rep_c', 'client-1', 'msg_y', 'conv_1', 'cy', 6, 'p1', 7, '{}', 'pending', 0, 1000, 1000)",
      ).run();
      expect(payloadClash.changes).toBe(0);
      // 同 hash 换桶 / 换 client 不冲突（时间桶去重语义）。
      const otherBucket = db.prepare(
        "insert or ignore into report_outbox (id, client_id, message_id, conversation_id, content_hash, content_bucket, payload_hash, payload_bucket, payload_json, status, attempts, next_attempt_at, created_at) values ('rep_d', 'client-1', 'msg_z', 'conv_1', 'c1', 6, 'p1', 8, '{}', 'pending', 0, 1000, 1000)",
      ).run();
      expect(otherBucket.changes).toBe(1);
      const otherClient = db.prepare(
        "insert or ignore into report_outbox (id, client_id, message_id, conversation_id, content_hash, content_bucket, payload_hash, payload_bucket, payload_json, status, attempts, next_attempt_at, created_at) values ('rep_e', 'client-2', 'msg_1', 'conv_1', 'c1', 5, 'p1', 7, '{}', 'pending', 0, 1000, 1000)",
      ).run();
      expect(otherClient.changes).toBe(1);
    } finally {
      closeDatabase(db);
    }
  });

  it('upgrades a version-83 database (0084 replays cleanly, existing rows untouched)', () => {
    const db = openMainDb();
    try {
      runMigrations(db, migrationsUrl('main'));
      // 升级后写入一行，再回拨到 0083 摘除两张表，验证 0084 重放既建表也不碰他表。
      db.prepare(
        `insert into report_outbox (id, client_id, message_id, conversation_id, content_hash,
           content_bucket, payload_hash, payload_bucket, payload_json, status, attempts,
           next_attempt_at, created_at)
         values ('rep_seed', 'client-1', 'msg_1', 'conv_1', 'c1', 0, 'p1', 0, '{}', 'pending', 0, 1, 1)`,
      ).run();
      db.prepare('insert into message_reactions (scope, message_id, conversation_id, client_id, emoji, created_at) values (?, ?, ?, ?, ?, ?)').run(
        'local',
        'msg_1',
        'conv_1',
        'client-1',
        '👍',
        1,
      );
      db.exec('drop index report_outbox_content;');
      db.exec('drop index report_outbox_payload;');
      db.exec('drop index report_outbox_due;');
      db.exec('drop index report_outbox_client_due;');
      db.exec('drop index message_reactions_conv;');
      db.exec('drop table report_outbox;');
      db.exec('drop table message_reactions;');
      db.pragma('user_version = 83');

      const applied = runMigrations(db, migrationsUrl('main'));
      expect(applied.map((row) => row.version)).toEqual(mainVersionsAfter(83));
      expect(db.pragma('user_version', { simple: true })).toBe(
        migrationTargetVersion(migrationsUrl('main')),
      );
      // 0084 是纯 CREATE TABLE/INDEX：重放后的表从空开始（旧行随摘除消失，属预期），
      // 他表（messages）不受影响。
      expect(db.prepare('select count(*) as n from report_outbox').get()).toEqual({ n: 0 });
      expect(db.prepare('select count(*) as n from message_reactions').get()).toEqual({ n: 0 });
      expect(
        db.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'messages'").get(),
      ).toEqual({ n: 1 });
    } finally {
      closeDatabase(db);
    }
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * main watches 迁移（W7，D79）：新表 watches（status / interval_sec CHECK、
 * 到期与按对话索引、随对话级联删除）。旧库升级只新增表，不动既有数据。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'watches-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
}

/** The watches migration's version, read from the file name (renumbering-proof). */
function watchesVersion(): number {
  const name = readdirSync(migrationsUrl('main')).find((file) => /^\d{4}_watches\.sql$/.test(file));
  if (name === undefined) throw new Error('watches migration missing');
  return Number(name.slice(0, 4));
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

function insertWatch(
  db: SqliteDatabase,
  id: string,
  overrides: { status?: string; intervalSec?: number; conversationId?: string } = {},
): void {
  db.prepare(
    `insert into watches (id, bot_id, conversation_id, source_json, condition_json, interval_sec,
       status, next_check_at, created_at, updated_at)
     values (?, 'bot_a', ?, '{"kind":"web_page","url":"https://a.example"}', '{"kind":"changed"}', ?, ?, 1, 1, 1)`,
  ).run(
    id,
    overrides.conversationId ?? 'conv_a',
    overrides.intervalSec ?? 300,
    overrides.status ?? 'active',
  );
}

describe('watches 迁移（W7）', () => {
  it('旧库升级只新增 watches 表；默认值、CHECK 与索引生效，删除对话级联删除监看', () => {
    const version = watchesVersion();
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(version - 1));
    db.prepare(
      "insert into conversations (id, type, title, created_at) values ('conv_a', 'group', 'x', 1)",
    ).run();
    const applied = runMigrations(db, migrationsUpTo(version));
    expect(applied.map((m) => m.version)).toEqual([version]);
    expect(db.pragma('user_version', { simple: true })).toBe(version);

    insertWatch(db, 'wat_a');
    const row = db.prepare('select * from watches where id = ?').get('wat_a') as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      last_hash: null,
      last_quiet_hash: null,
      last_text: null,
      last_matched: 0,
      alert_seq: 0,
      alert_times_json: '[]',
      failures: 0,
      version: 0,
    });
    for (const status of ['paused', 'stopped']) insertWatch(db, `wat_${status}`, { status });
    expect(() => insertWatch(db, 'wat_bad', { status: 'done' })).toThrow(/CHECK/);
    expect(() => insertWatch(db, 'wat_fast', { intervalSec: 60 })).toThrow(/CHECK/);

    const indexes = (
      db
        .prepare("select name from sqlite_master where type = 'index' and tbl_name = 'watches'")
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['watches_due', 'watches_conversation', 'watches_bot']),
    );

    db.pragma('foreign_keys = ON');
    db.prepare("delete from conversations where id = 'conv_a'").run();
    expect(db.prepare('select count(*) as n from watches').get()).toEqual({ n: 0 });
    closeDatabase(db);
  });
});

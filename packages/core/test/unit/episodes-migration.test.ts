import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter, runsVersionsAfter } from '../support/migration-versions.js';

/**
 * main 0041_episodes + runs 0014_episode_columns（D92 T1a WP2，todo/project/
 * WP2-episodes.md 步骤 1）：chains 删除、episodes 建立（status CHECK、
 * conversation_id FK 级联），runs 的 chain_id / chain_depth 改名
 * episode_id / episode_hop 且既有值原样保留。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'episodes-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openDb(info: typeof KEY_INFO.mainDb | typeof KEY_INFO.runsDb): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `db-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 7), info),
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

describe('main 0041 episodes 迁移', () => {
  it('0040 库升级：chains 删除，episodes 建立且约束生效', () => {
    const db = openDb(KEY_INFO.mainDb);
    runMigrations(db, migrationsUpTo('main', 40));
    db.exec(
      "insert into bots (id, name, profile_json, status, system_role, created_at, updated_at) values ('bot_a', 'A', '{}', 'active', null, 0, 0)",
    );
    db.exec(
      "insert into conversations (id, type, lead_bot_id, created_at) values ('conv_p', 'project', 'bot_a', 0)",
    );
    db.exec(
      "insert into conversation_members (conversation_id, bot_id, joined_at) values ('conv_p', 'bot_a', 0)",
    );
    db.exec(
      "insert into chains (id, conversation_id, root_batch_id, max_depth_seen, tokens_used, created_at) values ('chn_legacy', 'conv_p', 'batch_1', 2, 5000, 1)",
    );

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((m) => m.version)).toEqual(mainVersionsAfter(40));

    // The legacy chains table is gone; episodes exists in its place.
    expect(
      db.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'chains'").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("select count(*) as n from sqlite_master where type = 'table' and name = 'episodes'").get(),
    ).toEqual({ n: 1 });

    // The status CHECK rejects unknown values.
    expect(() =>
      db
        .prepare(
          "insert into episodes (id, conversation_id, root_batch_id, status, created_at) values ('epi_x', 'conv_p', 'batch_x', 'zombie', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);

    // The conversation_id FK cascades on conversation deletion.
    db.prepare(
      "insert into episodes (id, conversation_id, root_batch_id, created_at) values ('epi_a', 'conv_p', 'batch_1', 0)",
    ).run();
    db.prepare('pragma foreign_keys = on').run();
    db.prepare("delete from conversations where id = 'conv_p'").run();
    expect(db.prepare("select count(*) as n from episodes where id = 'epi_a'").get()).toEqual({
      n: 0,
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });
});

describe('runs 0014 episode_columns 迁移', () => {
  it('0013 库升级：chain 列改名 episode，既有值保留，旧列名不存在', () => {
    const db = openDb(KEY_INFO.runsDb);
    runMigrations(db, migrationsUpTo('runs', 13));
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, trigger_reason, chain_id, chain_depth, created_at) values ('run_c', 'bot_x', 'conv_a', 'turn', 'completed', 'chain', 'chn_legacy', 2, 1)",
    );
    db.exec(
      "insert into runs (id, bot_id, conversation_id, loop_type, status, created_at) values ('run_free', 'bot_x', 'conv_a', 'turn', 'completed', 2)",
    );

    const applied = runMigrations(db, migrationsUrl('runs'));
    expect(applied.map((m) => m.version)).toEqual(runsVersionsAfter(13));

    // Values survive the rename; rows without a binding stay null.
    expect(db.prepare('select episode_id, episode_hop from runs where id = ?').get('run_c')).toEqual(
      { episode_id: 'chn_legacy', episode_hop: 2 },
    );
    expect(
      db.prepare('select episode_id, episode_hop from runs where id = ?').get('run_free'),
    ).toEqual({ episode_id: null, episode_hop: null });
    const columns = db.prepare('pragma table_info(runs)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('episode_id');
    expect(columns.map((column) => column.name)).toContain('episode_hop');
    expect(columns.map((column) => column.name)).not.toContain('chain_id');
    expect(columns.map((column) => column.name)).not.toContain('chain_depth');
    expect(() =>
      db.prepare("update runs set chain_id = 'chn_z' where id = 'run_c'").run(),
    ).toThrow(/no such column/i);
    closeDatabase(db);
  });
});

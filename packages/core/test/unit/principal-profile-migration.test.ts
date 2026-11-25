import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { memoryMigrationsUrl } from '../../src/memory/manager.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { mainVersionsAfter } from '../support/migration-versions.js';

/**
 * 0081 principal profile (main) + memory 0005 source_principal. Upgrade a
 * version-76 main database seeded with profile items (plus their FTS rows), a
 * pending proposal and the compiled single-row card: every row must survive
 * with the new principal_key on the single-user '' bucket, the card must be
 * re-keyed by principal_key with the old id=1 row migrated onto '', the FTS
 * index and the proposals index must keep working, and fresh inserts must
 * default to ''. The per-bot memory library gains memory_items
 * .source_principal_id with existing rows NULL.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'principal-profile-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 13), KEY_INFO.mainDb),
  });
}

function openMemoryDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `memory-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 14), KEY_INFO.mainDb),
  });
}

function migrationsUpTo(kind: 'main' | 'memory', maxVersion: number): string {
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

function indexNames(db: SqliteDatabase, table: string): string[] {
  return (
    db
      .prepare(
        `select name from sqlite_master where type = 'index' and tbl_name = '${table}' and name not like 'sqlite_autoindex%' order by name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function columnNames(db: SqliteDatabase, table: string): string[] {
  return (db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function primaryKeyColumns(db: SqliteDatabase, table: string): string[] {
  return (
    db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string; pk: number }>
  )
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
}

describe('0081 principal profile migration (main)', () => {
  it('keeps every profile row on the empty principal key and re-keys the card', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo('main', 76));

    db.prepare(
      "insert into profile_items (id, category, content, source, evidence_json, contributed_by, confidence, valid_until, status, supersedes, created_at, updated_at) values ('prf_1', 'basic', '用户偏好简洁回复', 'explicit', '[]', null, 1, null, 'active', null, 10, 10)",
    ).run();
    db.prepare(
      "insert into profile_items (id, category, content, source, evidence_json, contributed_by, confidence, valid_until, status, supersedes, created_at, updated_at) values ('prf_2', 'work', '项目里的站会在周四', 'inferred', '[]', 'bot_a', 0.8, null, 'retracted', null, 20, 30)",
    ).run();
    // Both items get an FTS row: the virtual table is keyed by item_id and
    // must keep answering match queries across the migration.
    db.prepare(
      "insert into profile_fts (segmented_text, item_id) values ('用户偏好简洁回复', 'prf_1')",
    ).run();
    db.prepare(
      "insert into profile_fts (segmented_text, item_id) values ('项目里的站会在周四', 'prf_2')",
    ).run();
    db.prepare(
      "insert into profile_proposals (id, bot_id, op, target_item_id, payload_json, status, created_at) values ('prp_1', null, 'add', null, '{\"category\":\"basic\",\"content\":\"x\"}', 'pending', 40)",
    ).run();
    db.prepare(
      "insert into profile_card (id, content, compiled_at) values (1, '已编译的画像卡', 50)",
    ).run();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toEqual(mainVersionsAfter(76));
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );

    // (a) Items and proposals keep their data on the single-user '' key.
    expect(
      db
        .prepare(
          'select id, category, content, source, contributed_by, confidence, status, created_at, updated_at, principal_key from profile_items order by id',
        )
        .all(),
    ).toEqual([
      {
        id: 'prf_1',
        category: 'basic',
        content: '用户偏好简洁回复',
        source: 'explicit',
        contributed_by: null,
        confidence: 1,
        status: 'active',
        created_at: 10,
        updated_at: 10,
        principal_key: '',
      },
      {
        id: 'prf_2',
        category: 'work',
        content: '项目里的站会在周四',
        source: 'inferred',
        contributed_by: 'bot_a',
        confidence: 0.8,
        status: 'retracted',
        created_at: 20,
        updated_at: 30,
        principal_key: '',
      },
    ]);
    expect(
      db
        .prepare(
          'select id, bot_id, op, target_item_id, payload_json, status, created_at, processed_at, principal_key from profile_proposals where id = ?',
        )
        .get('prp_1'),
    ).toEqual({
      id: 'prp_1',
      bot_id: null,
      op: 'add',
      target_item_id: null,
      payload_json: '{"category":"basic","content":"x"}',
      status: 'pending',
      created_at: 40,
      processed_at: null,
      principal_key: '',
    });

    // (b) profile_card is rebuilt onto principal_key; the old id=1 row
    // migrates onto '' with content and compiled_at intact, and the old
    // single-row CHECK is gone.
    expect(db.prepare('select * from profile_card').all()).toEqual([
      { principal_key: '', content: '已编译的画像卡', compiled_at: 50 },
    ]);
    expect(primaryKeyColumns(db, 'profile_card')).toEqual(['principal_key']);
    const cardSql = (
      db.prepare("select sql from sqlite_master where type = 'table' and name = 'profile_card'").get() as { sql: string }
    ).sql;
    expect(cardSql).toContain('principal_key TEXT PRIMARY KEY');
    expect(cardSql).not.toContain('CHECK');

    // A second principal gets its own card; the '' key collides again.
    db.prepare(
      "insert into profile_card (principal_key, content, compiled_at) values ('pr_1', '成员画像卡', 60)",
    ).run();
    expect(() =>
      db.prepare(
        "insert into profile_card (principal_key, content, compiled_at) values ('', 'x', 70)",
      ).run(),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        "insert into profile_card (principal_key, content, compiled_at) values ('pr_1', 'y', 80)",
      ).run(),
    ).toThrow(/UNIQUE/);

    // (c) Fresh items default to the '' key, and explicit NULLs are rejected.
    db.prepare(
      "insert into profile_items (id, category, content, source, evidence_json, confidence, status, created_at, updated_at) values ('prf_3', 'interests', '喜欢爬山', 'explicit', '[]', 1, 'active', 60, 60)",
    ).run();
    expect(db.prepare('select principal_key from profile_items where id = ?').get('prf_3')).toEqual({
      principal_key: '',
    });
    expect(() =>
      db.prepare(
        "insert into profile_items (id, category, content, source, evidence_json, confidence, status, principal_key, created_at, updated_at) values ('prf_4', 'basic', 'x', 'explicit', '[]', 1, 'active', null, 70, 70)",
      ).run(),
    ).toThrow(/NOT NULL/);

    // (d) FTS rows survive untouched and still answer match queries.
    expect(
      (db.prepare("select item_id from profile_fts where profile_fts match '用户偏好简洁回复'").all() as Array<{ item_id: string }>).map(
        (row) => row.item_id,
      ),
    ).toEqual(['prf_1']);

    // (e) The proposals index keeps its name and key; FKs stay clean.
    expect(indexNames(db, 'profile_proposals')).toEqual(['profile_proposals_pending']);
    expect(
      (db.prepare('pragma index_info(profile_proposals_pending)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    ).toEqual(['status', 'created_at']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });
});

describe('memory 0005 source_principal migration', () => {
  it('adds memory_items.source_principal_id, keeps existing rows NULL and FTS intact', () => {
    const db = openMemoryDb();
    const appliedOld = runMigrations(db, migrationsUpTo('memory', 4));
    expect(appliedOld.map((row) => row.version)).toEqual([1, 2, 3, 4]);

    db.prepare(
      "insert into memory_items (id, kind, content, subject, source, evidence_json, origin, origin_conversation_id, confidence, sensitivity, status, created_at, updated_at) values ('mem_1', 'fact', '项目部署在周五', null, 'explicit', '[]', 'project', 'conv_1', 1, 'normal', 'active', 0, 0)",
    ).run();
    db.prepare(
      "insert into memory_fts (segmented_text, item_id) values ('项目部署在周五', 'mem_1')",
    ).run();

    const applied = runMigrations(db, memoryMigrationsUrl());
    const latest = migrationTargetVersion(memoryMigrationsUrl());
    expect(applied.map((row) => row.version)).toEqual(
      Array.from({ length: latest - 4 }, (_, index) => 5 + index),
    );
    expect(db.pragma('user_version', { simple: true })).toBe(latest);

    // (a) The column exists; the old row keeps its data with NULL source.
    expect(columnNames(db, 'memory_items')).toContain('source_principal_id');
    expect(
      db.prepare('select id, content, origin, source_principal_id from memory_items where id = ?').get('mem_1'),
    ).toEqual({ id: 'mem_1', content: '项目部署在周五', origin: 'project', source_principal_id: null });

    // (b) New rows can carry the producing principal.
    db.prepare(
      "insert into memory_items (id, kind, content, source, evidence_json, origin, confidence, sensitivity, status, source_principal_id, created_at, updated_at) values ('mem_2', 'preference', '成员 A 偏好邮件同步', 'explicit', '[]', 'private', 1, 'normal', 'active', 'pr_1', 5, 5)",
    ).run();
    expect(db.prepare('select source_principal_id from memory_items where id = ?').get('mem_2')).toEqual({
      source_principal_id: 'pr_1',
    });

    // (c) A plain ADD COLUMN leaves the FTS table and the status index alone.
    expect(
      (db.prepare("select item_id from memory_fts where memory_fts match '项目部署在周五'").all() as unknown[]).length,
    ).toBe(1);
    expect(indexNames(db, 'memory_items')).toContain('memory_active');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    closeDatabase(db);
  });
});

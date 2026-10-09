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
 * 0023_app_tools（D73 P1）：app_connection_tools / app_tool_grants 与
 * app_connections.baseline_pending。升级路径用「真实迁移目录截到 0022」建旧库再跑全量
 * 迁移（真库，不用 stub）。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'app-tools-migration-'));
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

interface Column {
  name: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

function columnsOf(db: SqliteDatabase, table: string): Column[] {
  return db.prepare(`pragma table_info(${table})`).all() as Column[];
}

function insertConnection(db: SqliteDatabase, id: string): void {
  db.prepare(
    "insert into app_connections (id, connector_id, label, status, created_at, updated_at) values (?, ?, 'label', 'connected', 1, 1)",
  ).run(id, id.startsWith('custom:') ? id : `x/${id}`);
}

function insertConversation(db: SqliteDatabase, id: string): void {
  db.prepare("insert into conversations (id, type, created_at) values (?, 'group', 1)").run(id);
}

describe('0023 app_tools 迁移', () => {
  it('旧库（0022，含已有连接行）升级：新表与列出现，老行 baseline_pending 默认 0', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(22));
    insertConnection(db, 'custom:old');
    expect(
      db.prepare("select 1 from sqlite_master where name = 'app_connection_tools'").get(),
    ).toBeUndefined();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((entry) => entry.version)).toEqual(mainVersionsAfter(22));
    expect(applied[0]?.file).toBe('0023_app_tools.sql');

    expect(columnsOf(db, 'app_connection_tools').map((c) => c.name)).toEqual([
      'connection_id',
      'tool_name',
      'approved_hash',
      'current_hash',
      'risk',
      'user_policy',
      'definition_json',
      'approved_definition_json',
    ]);
    const tools = columnsOf(db, 'app_connection_tools');
    // 主键 (connection_id, tool_name)；approved_hash / user_policy 可空，其余非空。
    expect(tools.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
      'connection_id',
      'tool_name',
    ]);
    expect(Object.fromEntries(tools.map((c) => [c.name, c.notnull === 1]))).toMatchObject({
      approved_hash: false,
      user_policy: false,
      approved_definition_json: false,
      current_hash: true,
      risk: true,
      definition_json: true,
    });

    expect(columnsOf(db, 'app_tool_grants').map((c) => c.name)).toEqual([
      'id',
      'bot_id',
      'connection_id',
      'tool_name',
      'conversation_id',
      'approval_id',
      'created_at',
      'revoked_at',
    ]);
    const baseline = columnsOf(db, 'app_connections').find((c) => c.name === 'baseline_pending');
    expect(baseline).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(
      db.prepare("select baseline_pending as v from app_connections where id = 'custom:old'").get(),
    ).toEqual({ v: 0 });
    closeDatabase(db);
  });

  it('app_tool_grants 上有「未撤销」的部分索引 (bot_id, connection_id, tool_name)', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    const index = db
      .prepare(
        "select name, sql from sqlite_master where type = 'index' and name = 'app_tool_grants_live'",
      )
      .get() as { name: string; sql: string } | undefined;
    expect(index?.sql).toMatch(/\(bot_id, connection_id, tool_name\)/);
    expect(index?.sql).toMatch(/WHERE revoked_at IS NULL/i);
    // 查询计划用到它。
    const plan = db
      .prepare(
        'explain query plan select * from app_tool_grants where bot_id = ? and connection_id = ? and tool_name = ? and revoked_at is null',
      )
      .all('b', 'c', 't') as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join('\n')).toMatch(/app_tool_grants_live/);
    closeDatabase(db);
  });

  it('工具行：主键唯一；连接删除时级联删除工具行与授权', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertConnection(db, 'conn_1');
    insertConnection(db, 'conn_2');
    const insertTool = (connection: string, name: string) =>
      db
        .prepare(
          "insert into app_connection_tools (connection_id, tool_name, approved_hash, current_hash, risk, definition_json) values (?, ?, null, 'h', 'read', '{}')",
        )
        .run(connection, name);
    insertTool('conn_1', 'a');
    insertTool('conn_1', 'b');
    insertTool('conn_2', 'a'); // 同名工具在不同连接下并存
    expect(() => insertTool('conn_1', 'a')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => insertTool('conn_missing', 'a')).toThrow(/FOREIGN KEY/);
    db.prepare(
      "insert into app_tool_grants (id, bot_id, connection_id, tool_name, created_at) values ('g1', 'bot_1', 'conn_1', 'a', 1)",
    ).run();

    db.prepare('delete from app_connections where id = ?').run('conn_1');
    expect(
      db
        .prepare("select count(*) as n from app_connection_tools where connection_id = 'conn_1'")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare("select count(*) as n from app_connection_tools where connection_id = 'conn_2'")
        .get(),
    ).toEqual({ n: 1 });
    expect(db.prepare('select count(*) as n from app_tool_grants').get()).toEqual({ n: 0 });
    closeDatabase(db);
  });

  it('授权行：conversation_id 为 NULL 表示 Bot 级；对话删除时级联；撤销不删行', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUrl('main'));
    insertConnection(db, 'conn_1');
    insertConversation(db, 'conv_1');
    const insertGrant = (id: string, conversation: string | null) =>
      db
        .prepare(
          "insert into app_tool_grants (id, bot_id, connection_id, tool_name, conversation_id, approval_id, created_at) values (?, 'bot_1', 'conn_1', 'a', ?, null, 1)",
        )
        .run(id, conversation);
    insertGrant('g_conv', 'conv_1');
    insertGrant('g_bot', null);
    expect(() => insertGrant('g_bad', 'conv_missing')).toThrow(/FOREIGN KEY/);
    expect(() => insertGrant('g_conv', null)).toThrow(/UNIQUE|PRIMARY/);

    db.prepare("update app_tool_grants set revoked_at = 2 where id = 'g_bot'").run();
    expect(
      db.prepare("select revoked_at as r from app_tool_grants where id = 'g_bot'").get(),
    ).toEqual({ r: 2 });

    db.prepare('delete from conversations where id = ?').run('conv_1');
    expect(db.prepare('select id from app_tool_grants order by id').all()).toEqual([
      { id: 'g_bot' },
    ]);
    closeDatabase(db);
  });
});

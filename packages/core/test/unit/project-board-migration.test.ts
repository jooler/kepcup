import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openDatabase, closeDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { migrationsUrl } from '../../src/start.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { insertProjectConversation } from '../support/projects.js';

/**
 * 0050_project_board: board_columns and board_cards. Upgrade from a fully
 * migrated database (the files are the source of truth for user_version).
 */

const dir = mkdtempSync(path.join(tmpdir(), 'project-board-migration-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  const db = openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 9), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  return db;
}

describe('0050 project board migration', () => {
  it('creates the tables, indexes, REAL positions, and foreign keys', () => {
    const db = openMainDb();
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );
    for (const name of ['board_columns', 'board_cards']) {
      expect(
        db.prepare('select 1 from sqlite_master where type = ? and name = ?').get('table', name),
      ).toBeDefined();
    }
    const indexes = (
      db
        .prepare(
          "select name from sqlite_master where type = 'index' and tbl_name in ('board_columns', 'board_cards')",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'board_columns_project',
        'board_cards_column',
        'board_cards_project',
      ]),
    );
    for (const table of ['board_columns', 'board_cards']) {
      const columns = db.prepare(`pragma table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>;
      expect(columns.find((column) => column.name === 'position')?.type).toBe('REAL');
    }

    const fks = db.prepare('pragma foreign_key_list(board_cards)').all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    expect(fks.find((fk) => fk.from === 'column_id')).toMatchObject({
      table: 'board_columns',
      on_delete: 'NO ACTION',
    });
    expect(fks.find((fk) => fk.from === 'todo_id')).toMatchObject({
      table: 'todos',
      on_delete: 'CASCADE',
    });
    expect(fks.find((fk) => fk.from === 'project_id')).toMatchObject({
      table: 'conversations',
      on_delete: 'CASCADE',
    });

    db.prepare(
      "insert into bots (id, name, profile_json, status, created_at, updated_at) values ('bot_1', 'A', '{}', 'active', 0, 0)",
    ).run();
    insertProjectConversation(db, { id: 'conv_p', leadBotId: 'bot_1' });
    db.prepare(
      "insert into todos (id, title, notes, status, source, created_at, updated_at) values ('todo_1', 't', 'n', 'draft', 'user', 1, 1)",
    ).run();
    db.prepare(
      "insert into board_columns (id, project_id, title, position, created_at) values ('bcol_1', 'conv_p', 'Todo', 1024, 1)",
    ).run();
    db.prepare(
      "insert into board_cards (todo_id, project_id, column_id, position, created_at) values ('todo_1', 'conv_p', 'bcol_1', 1024, 1)",
    ).run();

    expect(() => db.prepare('delete from board_columns where id = ?').run('bcol_1')).toThrow();
    expect(() =>
      db
        .prepare(
          "insert into board_columns (id, project_id, title, position, created_at) values ('bcol_bad', 'conv_p', '', 1, 1)",
        )
        .run(),
    ).toThrow();

    db.prepare('delete from todos where id = ?').run('todo_1');
    expect(db.prepare('select count(*) as n from board_cards').get() as { n: number }).toEqual({
      n: 0,
    });

    db.prepare(
      "insert into todos (id, title, notes, status, source, created_at, updated_at) values ('todo_2', 't', 'n', 'draft', 'user', 1, 1)",
    ).run();
    db.prepare(
      "insert into board_cards (todo_id, project_id, column_id, position, created_at) values ('todo_2', 'conv_p', 'bcol_1', 2048, 1)",
    ).run();
    db.prepare('delete from conversations where id = ?').run('conv_p');
    expect(db.prepare('select count(*) as n from board_columns').get() as { n: number }).toEqual({
      n: 0,
    });
    expect(db.prepare('select count(*) as n from board_cards').get() as { n: number }).toEqual({
      n: 0,
    });
    // The todo itself is not removed by a foreign key.
    expect(db.prepare('select id from todos where id = ?').get('todo_2')).toEqual({ id: 'todo_2' });
    closeDatabase(db);
  });
});

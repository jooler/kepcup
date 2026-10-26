import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

/**
 * 0052_todo_pending_when: an additive nullable column, so upgrading a live
 * database must leave existing todos untouched (pending_when = NULL).
 */

const dir = mkdtempSync(path.join(tmpdir(), 'todo-pending-when-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openMainDb(): SqliteDatabase {
  return openDatabase({
    path: path.join(dir, `main-${Math.random().toString(36).slice(2, 8)}.db`),
    key: deriveKey(Buffer.alloc(32, 11), KEY_INFO.mainDb),
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

describe('0052 todo pending_when migration', () => {
  it('adds the column without touching existing rows', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(51));
    db.prepare(
      "insert into todos (id, title, notes, status, source, created_at, updated_at) values ('todo_1', 't', '', 'draft', 'user', 0, 0)",
    ).run();

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toContain(52);
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );
    expect(db.prepare('select pending_when from todos where id = ?').get('todo_1')).toEqual({
      pending_when: null,
    });

    db.prepare(
      "update todos set pending_when = '2026-12-01T09:00:00.000Z' where id = 'todo_1'",
    ).run();
    expect(db.prepare('select pending_when from todos where id = ?').get('todo_1')).toEqual({
      pending_when: '2026-12-01T09:00:00.000Z',
    });
  });
});

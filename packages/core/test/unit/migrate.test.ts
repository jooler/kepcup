import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { runMigrations } from '../../src/infra/migrate.js';

const tempDirs: string[] = [];

function makeTempDb(name: string, files: Array<[string, string]>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-test-'));
  tempDirs.push(dir);
  const migrationsDir = path.join(dir, 'migrations');
  mkdirSync(migrationsDir);
  for (const [file, sql] of files) writeFileSync(path.join(migrationsDir, file), sql);
  const db = new Database(path.join(dir, name));
  return { db, migrationsDir, dir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runMigrations', () => {
  it('applies migrations in order and records user_version', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_create_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
      ['0002_create_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);'],
    ]);
    const applied = runMigrations(db, migrationsDir);
    expect(applied.map((m) => m.version)).toEqual([1, 2]);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    const tables = db.prepare("select name from sqlite_master where type='table'").all() as Array<{
      name: string;
    }>;
    expect(tables.map((t) => t.name).sort()).toEqual(['a', 'b']);
    db.close();
  });

  it('is idempotent', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_create_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
    ]);
    runMigrations(db, migrationsDir);
    const second = runMigrations(db, migrationsDir);
    expect(second).toEqual([]);
    db.close();
  });

  it('applies nothing on an already migrated database', () => {
    const { db, migrationsDir, dir } = makeTempDb('test.db', [
      ['0001_create_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
      ['0002_create_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);'],
    ]);
    runMigrations(db, migrationsDir);
    db.close();

    const db2 = new Database(path.join(dir, 'test.db'));
    const applied = runMigrations(db2, migrationsDir);
    expect(applied).toEqual([]);
    db2.close();
  });

  it('rejects version gaps', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_create_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
      ['0003_create_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);'],
    ]);
    expect(() => runMigrations(db, migrationsDir)).toThrowError(/contiguous/);
    db.close();
  });

  it('refuses a database created by a newer build instead of running stale SQL', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_create_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
      ['0002_create_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);'],
    ]);
    db.pragma('user_version = 3');
    let error: unknown;
    try {
      runMigrations(db, migrationsDir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'MIGRATION_FAILED',
      details: { currentVersion: 3, targetVersion: 2 },
    });
    expect((error as Error).message).toContain('此数据库由更新版本的 KepCup 写入');
    // The refusal leaves the database untouched (no migration is attempted).
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    db.close();
  });

  it('reports missing migration files separately from a newer database', () => {
    const { db, migrationsDir } = makeTempDb('test.db', []);
    // A fresh database with no files is a no-op (nothing to apply) …
    expect(runMigrations(db, migrationsDir)).toEqual([]);
    // … but an existing database must not be misreported as "newer build".
    db.pragma('user_version = 1');
    let error: unknown;
    try {
      runMigrations(db, migrationsDir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'MIGRATION_FAILED',
      details: { currentVersion: 1, targetVersion: 0 },
    });
    expect((error as Error).message).toContain('迁移文件缺失');
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('leaves user_version untouched when a migration fails', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_ok.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
      ['0002_bad.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);'],
    ]);
    expect(() => runMigrations(db, migrationsDir)).toThrowError(/0002_bad\.sql/);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('supports the empty placeholder migration used by runs.db', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_init.sql', '-- placeholder\nSELECT 1;\n'],
    ]);
    expect(runMigrations(db, migrationsDir)).toHaveLength(1);
    db.close();
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/infra/migrate.js';

/**
 * The `-- kepcup:foreign-keys=off` first-line directive (D92 T1a, WP1):
 * rebuilding `conversations` — the parent of a dozen ON DELETE CASCADE child
 * tables — requires dropping it with FKs off (the pragma is a no-op inside a
 * transaction, and with FKs on the DROP cascade-deletes every child row).
 */

const tempDirs: string[] = [];

function makeTempDb(name: string, files: Array<[string, string]>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-fk-off-'));
  tempDirs.push(dir);
  const migrationsDir = path.join(dir, 'migrations');
  mkdirSync(migrationsDir);
  for (const [file, sql] of files) writeFileSync(path.join(migrationsDir, file), sql);
  const db = new Database(path.join(dir, name));
  // Mirror infra/db.ts: migrations always run on an FK-on connection.
  db.pragma('foreign_keys = ON');
  return { db, migrationsDir, dir };
}

/** A copy of the migrations dir with only files up to `maxVersion` (staging). */
function migrationsUpTo(migrationsDir: string, maxVersion: number): string {
  const target = mkdtempSync(path.join(path.dirname(migrationsDir), 'stage-'));
  tempDirs.push(target);
  for (const name of readdirSync(migrationsDir)) {
    if (!/^\d{4}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 4)) > maxVersion) continue;
    writeFileSync(path.join(target, name), readFileSync(path.join(migrationsDir, name)));
  }
  return target;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SCHEMA =
  'CREATE TABLE parent (id TEXT PRIMARY KEY);\n' +
  'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE);\n';

describe('runMigrations with the foreign-keys=off directive', () => {
  it('keeps child rows across the rebuild and restores foreign_keys=ON', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_schema.sql', SCHEMA],
      [
        '0002_rebuild.sql',
        [
          '-- kepcup:foreign-keys=off',
          'CREATE TABLE parent_new (id TEXT PRIMARY KEY, extra TEXT);',
          'INSERT INTO parent_new (id, extra) SELECT id, NULL FROM parent;',
          'DROP TABLE parent;',
          'ALTER TABLE parent_new RENAME TO parent;',
        ].join('\n'),
      ],
    ]);
    // Stage 1 applies only the schema; seed rows must predate the rebuild.
    const stage1 = migrationsUpTo(migrationsDir, 1);
    runMigrations(db, stage1);
    db.prepare("INSERT INTO parent (id) VALUES ('p1')").run();
    db.prepare("INSERT INTO child (id, parent_id) VALUES ('c1', 'p1')").run();

    const applied = runMigrations(db, migrationsDir);
    expect(applied.map((m) => m.version)).toEqual([2]);
    // Child row still there — with FKs on, the DROP would have removed it.
    expect(db.prepare('select id, parent_id from child').all()).toEqual([
      { id: 'c1', parent_id: 'p1' },
    ]);
    // Parent rebuilt with the new shape and the row copied.
    expect(db.prepare('select id, extra from parent').all()).toEqual([{ id: 'p1', extra: null }]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('fails with MIGRATION_FAILED on foreign-key violations and rolls back', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_schema.sql', SCHEMA],
      [
        '0002_violating.sql',
        [
          '-- kepcup:foreign-keys=off',
          'CREATE TABLE other (id TEXT PRIMARY KEY);',
          "INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing');",
        ].join('\n'),
      ],
    ]);
    const stage1 = migrationsUpTo(migrationsDir, 1);
    runMigrations(db, stage1);
    db.prepare("INSERT INTO parent (id) VALUES ('p1')").run();
    let failure: unknown;
    try {
      runMigrations(db, migrationsDir);
      expect.unreachable('migration should have failed');
    } catch (error) {
      failure = error;
    }
    expect((failure as { message: string }).message).toMatch(/0002_violating\.sql/);
    expect((failure as { details?: { reason?: string } }).details?.reason ?? '').toMatch(
      /foreign_key_check failed/,
    );
    // user_version did not advance and the violating insert rolled back.
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.prepare('select count(*) as n from child').get()).toEqual({ n: 0 });
    expect(
      db.prepare("select count(*) as n from sqlite_master where name = 'other'").get(),
    ).toEqual({ n: 0 });
    // The pragma is restored even after the failure.
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('restores foreign_keys=ON after a failing fk-off migration', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      ['0001_schema.sql', SCHEMA],
      [
        '0002_bad.sql',
        [
          '-- kepcup:foreign-keys=off',
          'CREATE TABLE parent_new (id TEXT PRIMARY KEY);',
          'THIS IS NOT SQL;',
        ].join('\n'),
      ],
    ]);
    expect(() => runMigrations(db, migrationsDir)).toThrowError(/0002_bad\.sql/);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();
  });

  it('runs directive-free migrations with foreign_keys still ON', () => {
    const { db, migrationsDir } = makeTempDb('test.db', [
      [
        '0001_probe.sql',
        [
          SCHEMA,
          'CREATE TABLE probe (fk INTEGER);',
          // Records the pragma value seen while the migration runs.
          'INSERT INTO probe (fk) SELECT foreign_keys FROM pragma_foreign_keys;',
        ].join('\n'),
      ],
    ]);
    runMigrations(db, migrationsDir);
    expect(db.prepare('select fk from probe').get()).toEqual({ fk: 1 });
    // And a directive-free migration that violates a foreign key fails.
    const { db: db2, migrationsDir: dir2 } = makeTempDb('fk-on.db', [
      ['0001_schema.sql', SCHEMA],
      ['0002_violating.sql', "INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing');"],
    ]);
    expect(() => runMigrations(db2, dir2)).toThrowError(/0002_violating\.sql/);
    expect(db2.pragma('user_version', { simple: true })).toBe(1);
    db2.close();
  });
});

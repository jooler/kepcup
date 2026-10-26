import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { migrationTargetVersion, runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

/**
 * 0054_plugin_skill_source (D104 P0b): preset skills are now the builtin
 * `com.kepcup/starter-skills` plugin, so `skill_library.source_url` markers are
 * rewritten `preset://{id}` → `plugin://com.kepcup/starter-skills/{id}`. A pure
 * UPDATE — every other row (git imports, already-rewritten plugin markers) is
 * untouched, and a replay (upgrade → already applied) is a no-op.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'plugin-skill-source-'));
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

const SCAN_JSON = JSON.stringify({ compatibility: 'compatible' });

function insertLibrary(
  db: SqliteDatabase,
  id: string,
  name: string,
  sourceUrl: string,
): void {
  db.prepare(
    `insert into skill_library (id, name, source_url, commit_oid, content_hash, rel_path, scan_json, imported_at)
     values (?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, name, sourceUrl, 'a'.repeat(40), `hash-${id}`, `skills-library/${name}@hash-${id}`, SCAN_JSON);
}

describe('0054 plugin skill source migration', () => {
  it('rewrites only preset:// rows to the builtin plugin marker', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(53));
    insertLibrary(db, 'skl_1', 'docx', 'preset://docx');
    insertLibrary(db, 'skl_2', 'git-import', 'https://github.com/x/y');
    insertLibrary(db, 'skl_3', 'already-plugin', 'plugin://io.github.a/b/c');

    const applied = runMigrations(db, migrationsUrl('main'));
    expect(applied.map((row) => row.version)).toContain(54);
    expect(db.pragma('user_version', { simple: true })).toBe(
      migrationTargetVersion(migrationsUrl('main')),
    );

    const rows = db
      .prepare('select id, source_url from skill_library order by id')
      .all() as Array<{ id: string; source_url: string }>;
    expect(rows).toEqual([
      { id: 'skl_1', source_url: 'plugin://com.kepcup/starter-skills/docx' },
      { id: 'skl_2', source_url: 'https://github.com/x/y' },
      { id: 'skl_3', source_url: 'plugin://io.github.a/b/c' },
    ]);
  });

  it('is a pure UPDATE: replaying on an already-migrated database changes nothing', () => {
    const db = openMainDb();
    runMigrations(db, migrationsUpTo(53));
    insertLibrary(db, 'skl_1', 'docx', 'preset://docx');
    runMigrations(db, migrationsUrl('main'));
    // Replay (fresh migration dir sees user_version already at target → no-op; force a
    // second pass by running the same statement via a second runMigrations call).
    const appliedAgain = runMigrations(db, migrationsUrl('main'));
    expect(appliedAgain).toHaveLength(0);
    expect(
      (db.prepare('select source_url from skill_library where id = ?').get('skl_1') as {
        source_url: string;
      }).source_url,
    ).toBe('plugin://com.kepcup/starter-skills/docx');
  });
});

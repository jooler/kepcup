import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { SqliteDatabase } from './db.js';

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface AppliedMigration {
  version: number;
  file: string;
}

/**
 * Highest version present in a migration directory (0 when empty). Compared
 * against `PRAGMA user_version` to decide whether a pre-migration backup is
 * needed (P13 任务 5) — before `runMigrations` validates contiguity.
 */
export function migrationTargetVersion(dir: string): number {
  const versions = readdirSync(dir)
    .map((name) => {
      const match = MIGRATION_FILE_PATTERN.exec(name);
      return match !== null ? Number(match[1]) : null;
    })
    .filter((entry): entry is number => entry !== null);
  return versions.length > 0 ? Math.max(...versions) : 0;
}

/** Current schema version of an open database (`PRAGMA user_version`). */
export function readUserVersion(db: SqliteDatabase): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * Applies `NNNN_name.sql` files from `dir` in order, tracking progress in
 * `PRAGMA user_version`. Idempotent: files at or below the current version
 * are skipped. Version numbers must be contiguous starting at 1.
 */
export function runMigrations(
  db: SqliteDatabase,
  dir: string,
  options: { logger?: { info: (obj: object, msg: string) => void } } = {},
): AppliedMigration[] {
  const files = readdirSync(dir)
    .map((name) => {
      const match = MIGRATION_FILE_PATTERN.exec(name);
      return match ? { version: Number(match[1]), name } : null;
    })
    .filter((entry): entry is { version: number; name: string } => entry !== null)
    .sort((a, b) => a.version - b.version);

  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new AppError(
        'MIGRATION_FAILED',
        `Migration versions must be contiguous starting at 1; got gap at ${file.name}`,
      );
    }
  });

  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const applied: AppliedMigration[] = [];

  for (const file of files) {
    if (file.version <= currentVersion) continue;
    const sql = readFileSync(path.join(dir, file.name), 'utf8');
    const run = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${file.version}`);
    });
    try {
      run.immediate();
    } catch (error) {
      throw new AppError('MIGRATION_FAILED', `Migration ${file.name} failed`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    applied.push({ version: file.version, file: file.name });
    options.logger?.info({ file: file.name, version: file.version }, 'migration applied');
  }

  return applied;
}

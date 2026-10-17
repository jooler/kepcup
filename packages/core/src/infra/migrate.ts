import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AppError } from '@kepcup/shared';
import type { SqliteDatabase } from './db.js';

const MIGRATION_FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * First-line directive: the file must run with `PRAGMA foreign_keys = OFF`
 * (SQLite's official 12-step rebuild flow for a parent table referenced by
 * many children — with FKs on, `DROP TABLE` cascade-deletes every child row,
 * and the pragma is a no-op inside a transaction).
 */
const FK_OFF_DIRECTIVE = '-- kepcup:foreign-keys=off';

function isFkOffMigration(sql: string): boolean {
  const firstLine = sql.split('\n', 1)[0] ?? '';
  return firstLine.trim() === FK_OFF_DIRECTIVE;
}

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
 *
 * A file whose first line is exactly `-- kepcup:foreign-keys=off` runs with
 * `PRAGMA foreign_keys = OFF` (toggled outside the transaction) and must
 * leave the database free of foreign-key violations (`foreign_key_check`
 * runs inside the transaction; failures roll back). The pragma is restored
 * to ON afterwards whether the file succeeded or failed.
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
    if (isFkOffMigration(sql)) {
      // FK-off migrations turn the pragma off OUTSIDE the transaction (it is a
      // no-op inside one), run the SQL inside it, then verify the whole
      // database still satisfies its foreign keys before committing.
      db.pragma('foreign_keys = OFF');
      try {
        const run = db.transaction(() => {
          db.exec(sql);
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) {
            throw new Error(
              `foreign_key_check failed: ${JSON.stringify(violations.slice(0, 5))}`,
            );
          }
          db.pragma(`user_version = ${file.version}`);
        });
        try {
          run.immediate();
        } catch (error) {
          throw new AppError('MIGRATION_FAILED', `Migration ${file.name} failed`, {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
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
    }
    applied.push({ version: file.version, file: file.name });
    options.logger?.info({ file: file.name, version: file.version }, 'migration applied');
  }

  return applied;
}

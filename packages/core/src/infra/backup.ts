import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { AppError, MAIN_DB_BACKUPS_TO_KEEP } from '@kepcup/shared';
import type { SqliteDatabase } from './db.js';

/**
 * Pre-migration backup of main.db (P13 任务 5, docs/dev/phases/P13-release.md):
 * "需要迁移时先备份 main.db（保留最近 3 份）；迁移失败时恢复备份并显示错误".
 *
 * Scope rationale (docs/dev/03-data-model.md 迁移):
 * - main.db holds every structured user datum (settings, bots, conversations,
 *   approvals, projects, skills, schedules) and migrates in the startup
 *   sequence — it is the one database backed up, BEFORE any migration runs.
 * - runs.db holds execution history only (run rows + redacted steps) —
 *   log-like, rebuildable data; a failed migration fails closed (per-migration
 *   transactions leave nothing half-applied) without destroying user data.
 * - memory.db is opened lazily per bot (never in the startup sequence); its
 *   migrations are equally transactional and its wiki/profile git stores live
 *   outside the database.
 */

export interface DbBackupRecord {
  /** Absolute path of the created backup file. */
  path: string;
  /** user_version the database had when the backup was taken. */
  fromVersion: number;
}

/** Backup file name: `main.db.v2.1780000000000.bak` (epoch ms sorts lexically). */
export function backupFileName(dbFileName: string, fromVersion: number, nowMs: number): string {
  return `${dbFileName}.v${fromVersion}.${nowMs}.bak`;
}

/**
 * Lists existing backups for `dbFileName` in a backups dir, oldest first.
 * Files that do not match the naming scheme are ignored (never pruned).
 */export function listBackups(backupsDir: string, dbFileName: string): string[] {
  if (!existsSync(backupsDir)) return [];
  const prefix = `${dbFileName}.v`;
  const pattern = new RegExp(`^${dbFileName}\\.v\\d+\\.\\d+\\.bak$`);
  return readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix) && pattern.test(name))
    .sort((a, b) => backupEpochMs(a) - backupEpochMs(b));
}

function backupEpochMs(name: string): number {
  const match = /\.v\d+\.(\d+)\.bak$/.exec(name);
  return match !== null ? Number(match[1]) : -1;
}

/** Removes the oldest backups beyond `keep` (MAIN_DB_BACKUPS_TO_KEEP). */
export function pruneBackups(backupsDir: string, dbFileName: string, keep: number): number {
  const backups = listBackups(backupsDir, dbFileName);
  let pruned = 0;
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    rmSync(path.join(backupsDir, name), { force: true });
    pruned += 1;
  }
  return pruned;
}

/**
 * Consistent snapshot of an OPEN database. SQLite's online backup API cannot
 * copy between differently-configured cipher connections (better-sqlite3
 * opens the target without our cipher pragmas), so instead: checkpoint the
 * WAL into the main file (TRUNCATE), then copy the file bytes. Safe here
 * because core startup is single-process/single-threaded — nothing can write
 * between the synchronous checkpoint and the synchronous copy. The copy is
 * raw encrypted pages and restores with the same master key.
 *
 * BR-P13-008: the checkpoint's `busy` flag is honoured — a busy checkpoint
 * means a concurrent reader/writer still holds the WAL, so the main file may
 * lag the WAL and a byte copy would NOT be a consistent snapshot. Fail loudly
 * (caller wraps it into MIGRATION_BACKUP_FAILED) instead of copying.
 */
export function backupDatabase(db: SqliteDatabase, sourcePath: string, destination: string): void {
  const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
    busy: number | bigint;
    log: number | bigint;
    checkpointed: number | bigint;
  }>;
  if (checkpoint.length > 0 && Number(checkpoint[0]?.busy ?? 0) !== 0) {
    throw new AppError(
      'MIGRATION_BACKUP_FAILED',
      'wal_checkpoint(TRUNCATE) is busy — the WAL is still in use and a raw file copy would be inconsistent',
    );
  }
  copyFileSync(sourcePath, destination);
}

/**
 * Takes one backup of `dbPath` (currently open as `db`) when a migration is
 * pending (`currentVersion < targetVersion`), into `backupsDir`, then prunes
 * to `keep` copies. Returns null when the database is already at the target.
 */
export async function backupBeforeMigration(
  db: SqliteDatabase,
  options: {
    dbPath: string;
    backupsDir: string;
    currentVersion: number;
    targetVersion: number;
    nowMs: number;
    keep?: number;
    logger?: { info: (obj: object, msg: string) => void };
  },
): Promise<DbBackupRecord | null> {
  // A fresh database (version 0 = never migrated) has nothing worth
  // preserving — first boots do not leave empty backups behind.
  if (options.currentVersion === 0 || options.currentVersion >= options.targetVersion) {
    return null;
  }
  mkdirSync(options.backupsDir, { recursive: true });
  const dbFileName = path.basename(options.dbPath);
  const fileName = backupFileName(dbFileName, options.currentVersion, options.nowMs);
  const destination = path.join(options.backupsDir, fileName);
  if (existsSync(destination)) {
    // Same-millisecond re-run (tests): never overwrite a previous backup.
    throw new AppError('MIGRATION_BACKUP_FAILED', `Backup already exists: ${fileName}`);
  }
  try {
    backupDatabase(db, options.dbPath, destination);
  } catch (error) {
    throw new AppError('MIGRATION_BACKUP_FAILED', 'Cannot back up main.db before migrating', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const size = statSync(destination).size;
  options.logger?.info(
    { from: options.currentVersion, to: options.targetVersion, file: fileName, size },
    'pre-migration backup created',
  );
  pruneBackups(options.backupsDir, dbFileName, options.keep ?? MAIN_DB_BACKUPS_TO_KEEP);
  return { path: destination, fromVersion: options.currentVersion };
}

/**
 * Restores a pre-migration backup over `dbPath`. The caller must have closed
 * the database handle first; WAL sidecars are removed so a failed migration's
 * write-ahead log cannot resurrect partial state over the restored file.
 */
export function restoreDatabaseBackup(options: {
  dbPath: string;
  backupPath: string;
  logger?: { warn: (obj: object, msg: string) => void };
}): void {
  for (const sidecar of ['-wal', '-shm']) {
    rmSync(options.dbPath + sidecar, { force: true });
  }
  copyFileSync(options.backupPath, options.dbPath);
  options.logger?.warn({ backup: options.backupPath }, 'database restored from pre-migration backup');
}

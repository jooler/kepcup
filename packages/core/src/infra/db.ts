import Database from 'better-sqlite3-multiple-ciphers';
import { Buffer } from 'node:buffer';
import { AppError } from '@kepcup/shared';

export type SqliteDatabase = InstanceType<typeof Database>;

export interface OpenDatabaseOptions {
  path: string;
  /** Raw 32-byte database key (derived from the master key per database). */
  key: Uint8Array;
  readonly?: boolean;
  busyTimeoutMs?: number;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Opens a ChaCha20-Poly1305 encrypted database. The cipher pragma must run
 * before the key pragma (better-sqlite3-multiple-ciphers requirement).
 * The count query forces key validation: a wrong key fails here, not later.
 */
export function openDatabase(options: OpenDatabaseOptions): SqliteDatabase {
  let db: SqliteDatabase;
  try {
    db = new Database(options.path, { readonly: options.readonly === true });
  } catch (error) {
    throw new AppError('DB_OPEN_FAILED', `Cannot open database file at ${options.path}`, {
      reason: errorMessage(error),
    });
  }

  try {
    db.pragma("cipher='chacha20'");
    db.pragma(`key="x'${Buffer.from(options.key).toString('hex')}'"`);
    db.pragma('journal_mode = WAL');
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    db.prepare('select count(*) as n from sqlite_master').get();
    return db;
  } catch (error) {
    db.close();
    throw new AppError(
      'DB_OPEN_FAILED',
      `Cannot decrypt database at ${options.path} (wrong key or corrupted file)`,
      { reason: errorMessage(error) },
    );
  }
}

export function closeDatabase(db: SqliteDatabase): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

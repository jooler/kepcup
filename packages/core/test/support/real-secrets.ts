import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SecretsService } from '../../src/domain/secrets.js';
import { deriveKey, KEY_INFO } from '../../src/infra/crypto.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/infra/db.js';
import { runMigrations } from '../../src/infra/migrate.js';
import { migrationsUrl } from '../../src/start.js';

const LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

export interface RealMainDb {
  db: SqliteDatabase;
  /** A fresh SecretsService over `db` (same master key; new redact caches). */
  makeSecrets(): SecretsService;
  secrets: SecretsService;
  clock: { now(): number; set(value: number): void };
  dispose(): void;
}

/** A real encrypted main.db with all migrations applied, plus a real SecretsService. */
export function openRealMainDb(): RealMainDb {
  const dir = mkdtempSync(path.join(tmpdir(), 'real-main-db-'));
  const db = openDatabase({
    path: path.join(dir, 'main.db'),
    key: deriveKey(Buffer.alloc(32, 7), KEY_INFO.mainDb),
  });
  runMigrations(db, migrationsUrl('main'));
  const masterKey = Buffer.alloc(32, 5);
  let nowValue = 1_000;
  const clock = {
    now: () => nowValue,
    set: (value: number) => {
      nowValue = value;
    },
  };
  const makeSecrets = (): SecretsService =>
    new SecretsService({ db, masterKey, clock, logger: LOGGER });
  return {
    db,
    makeSecrets,
    secrets: makeSecrets(),
    clock,
    dispose: () => {
      closeDatabase(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

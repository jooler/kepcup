import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_DB_POOL_MAX } from '@kepcup/shared';
import { deriveKey, memoryDbKeyInfo } from '../infra/crypto.js';
import { openDatabase, type SqliteDatabase } from '../infra/db.js';
import { runMigrations } from '../infra/migrate.js';
import { botMemoryDbPath, type AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import { MemoryStore } from './store.js';

export interface MemoryDbManagerDeps {
  paths: AppPaths;
  masterKey: Buffer;
  clock: () => number;
  logger: CoreLogger;
}

/**
 * Opens per-bot memory.db on demand (encrypted with the `db:memory:<botId>`
 * derived key, migrated from migrations/memory/) and keeps at most
 * MEMORY_DB_POOL_MAX connections, closing the least recently used one
 * (docs/dev/phases/P07-memory.md 范围).
 */
export class MemoryDbManager {
  readonly #deps: MemoryDbManagerDeps;
  /** Insertion order = LRU order (Map semantics); newest last. */
  readonly #open = new Map<string, MemoryStore>();

  constructor(deps: MemoryDbManagerDeps) {
    this.#deps = deps;
  }

  /** Store for one bot; opening creates `bots/{id}/memory.db` on demand. */
  for(botId: string): MemoryStore {
    const existing = this.#open.get(botId);
    if (existing) {
      this.#open.delete(botId);
      this.#open.set(botId, existing); // bump LRU position
      return existing;
    }
    const dbPath = botMemoryDbPath(this.#deps.paths, botId);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase({
      path: dbPath,
      key: deriveKey(this.#deps.masterKey, memoryDbKeyInfo(botId)),
    });
    runMemoryMigrations(db);
    const store = new MemoryStore({ db, clock: this.#deps.clock, logger: this.#deps.logger });
    store.setBot(botId);
    this.#open.set(botId, store);
    this.#evict();
    return store;
  }

  /** True when the bot's memory database file exists on disk (no open). */
  exists(botId: string): boolean {
    return existsSync(botMemoryDbPath(this.#deps.paths, botId));
  }

  /** Currently open connections (pool cap observable for tests/ops). */
  get openCount(): number {
    return this.#open.size;
  }

  /** Closes one bot's connection (bot deletion cascade). */
  closeBot(botId: string): void {
    const store = this.#open.get(botId);
    if (!store) return;
    this.#open.delete(botId);
    store.close();
  }

  closeAll(): void {
    for (const [botId, store] of [...this.#open.entries()]) {
      this.#open.delete(botId);
      store.close();
    }
  }

  #evict(): void {
    while (this.#open.size > MEMORY_DB_POOL_MAX) {
      const oldest = this.#open.keys().next();
      if (oldest.done === true) break;
      const botId = oldest.value;
      const store = this.#open.get(botId);
      this.#open.delete(botId);
      store?.close();
      this.#deps.logger.debug({ botId }, 'evicted memory db from pool');
    }
  }
}

let memoryMigrationsUrlCache: string | null = null;

/** migrations/memory/ next to the compiled module (src/ or dist/). */
export function memoryMigrationsUrl(): string {
  if (memoryMigrationsUrlCache === null) {
    memoryMigrationsUrlCache = fileURLToPath(new URL('../../migrations/memory/', import.meta.url));
  }
  return memoryMigrationsUrlCache;
}

export function runMemoryMigrations(db: SqliteDatabase): void {
  runMigrations(db, memoryMigrationsUrl());
}

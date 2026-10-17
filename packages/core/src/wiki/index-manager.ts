import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { MEMORY_DB_POOL_MAX } from '@kepcup/shared';
import { deriveKey, wikiDbKeyInfo } from '../infra/crypto.js';
import { openDatabase } from '../infra/db.js';
import { projectWikiDbPath, type AppPaths } from '../infra/paths.js';
import type { CoreLogger } from '../infra/logger.js';
import { WikiIndexStore } from './index-store.js';

/**
 * The project wiki FTS table, embedded at open time (D92 T1b WP9). The DDL is
 * identical to `migrations/memory/0002_p09_wiki_fts.sql` — no separate
 * migration directory (it would risk being missed by packaging); the two are
 * kept consistent by `test/unit/wiki-index-store.test.ts`.
 */
export const WIKI_FTS_DDL = [
  'CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(',
  '  segmented_text, page_path UNINDEXED, title UNINDEXED, tokenize = \'unicode61\'',
  ')',
].join('\n');

const WIKI_DB_USER_VERSION = 1;

export interface WikiIndexManagerDeps {
  paths: AppPaths;
  masterKey: Buffer;
  clock: () => number;
  logger: CoreLogger;
}

/**
 * Opens a project wiki's `wiki.db` on demand (encrypted with the
 * `db:wiki:<projectId>` derived key; the database holds only `wiki_fts` —
 * design 41 §8.3) and keeps at most MEMORY_DB_POOL_MAX connections, closing
 * the least recently used one (same pooling shape as MemoryDbManager).
 */
export class WikiIndexManager {
  readonly #deps: WikiIndexManagerDeps;
  /** Insertion order = LRU order (Map semantics); newest last. */
  readonly #open = new Map<string, WikiIndexStore>();

  constructor(deps: WikiIndexManagerDeps) {
    this.#deps = deps;
  }

  /** Index of one project wiki; opening creates `projects/{id}/wiki.db` on demand. */
  forProject(projectId: string): WikiIndexStore {
    const existing = this.#open.get(projectId);
    if (existing) {
      this.#open.delete(projectId);
      this.#open.set(projectId, existing); // bump LRU position
      return existing;
    }
    const dbPath = projectWikiDbPath(this.#deps.paths, projectId);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = openDatabase({
      path: dbPath,
      key: deriveKey(this.#deps.masterKey, wikiDbKeyInfo(projectId)),
    });
    db.exec(WIKI_FTS_DDL);
    db.pragma(`user_version = ${WIKI_DB_USER_VERSION}`);
    const store = new WikiIndexStore(db);
    this.#open.set(projectId, store);
    this.#evict();
    return store;
  }

  /** True when the project's wiki index database file exists on disk (no open). */
  exists(projectId: string): boolean {
    return existsSync(projectWikiDbPath(this.#deps.paths, projectId));
  }

  /** Currently open connections (pool cap observable for tests/ops). */
  get openCount(): number {
    return this.#open.size;
  }

  /** Closes one project's connection (project deletion cascade: close BEFORE the directory goes). */
  closeProject(projectId: string): void {
    const store = this.#open.get(projectId);
    if (!store) return;
    this.#open.delete(projectId);
    store.close();
  }

  closeAll(): void {
    for (const [projectId, store] of [...this.#open.entries()]) {
      this.#open.delete(projectId);
      store.close();
    }
  }

  #evict(): void {
    while (this.#open.size > MEMORY_DB_POOL_MAX) {
      const oldest = this.#open.keys().next();
      if (oldest.done === true) break;
      const projectId = oldest.value;
      const store = this.#open.get(projectId);
      this.#open.delete(projectId);
      store?.close();
      this.#deps.logger.debug({ projectId }, 'evicted project wiki db from pool');
    }
  }
}

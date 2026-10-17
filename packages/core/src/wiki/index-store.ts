import type { SqliteDatabase } from '../infra/db.js';
import { segmentForFts, buildFtsOrQuery } from '../infra/text-segment.js';

/**
 * The `wiki_fts` index of one wiki owner (D92 T1b WP9). Bots keep theirs in
 * `memory.db` (MemoryStore delegates to one of these); every project wiki owns
 * a dedicated encrypted `wiki.db` holding only this table (design 41 §8.3 —
 * the project index must never land in a member bot's private memory.db).
 * Every write segments text through infra/text-segment.ts; the SQL and the
 * tokenizer calls are extracted verbatim from the former MemoryStore methods
 * (docs/dev/03-data-model.md "wiki_fts").
 */
export class WikiIndexStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  /** Replaces the index row of one wiki page (incremental maintenance update). */
  wikiUpsertPage(pagePath: string, title: string, content: string): void {
    this.#db.prepare('delete from wiki_fts where page_path = ?').run(pagePath);
    this.#db
      .prepare('insert into wiki_fts (segmented_text, page_path, title) values (?, ?, ?)')
      .run(segmentForFts(`${title}\n${content}`), pagePath, title);
  }

  wikiDeletePage(pagePath: string): void {
    this.#db.prepare('delete from wiki_fts where page_path = ?').run(pagePath);
  }

  /** Drops every wiki page row (rollback / full reindex). */
  wikiClearPages(): void {
    this.#db.prepare('delete from wiki_fts').run();
  }

  /**
   * Wiki page search (wiki_search tool / wiki.search RPC): OR composition +
   * bm25 ranking (same Chinese-recall rationale as memory retrieval, P07) with
   * an FTS5 snippet as the hit preview.
   */
  wikiSearch(
    queryText: string,
    limit: number,
  ): Array<{ path: string; title: string; snippet: string }> {
    const query = buildFtsOrQuery(queryText);
    if (query === null) return [];
    const rows = this.#db
      .prepare(
        `select page_path, title, snippet(wiki_fts, 0, '「', '」', ' … ', 24) as snippet
         from wiki_fts where wiki_fts match ? order by bm25(wiki_fts) limit ?`,
      )
      .all(query, limit) as Array<{ page_path: string; title: string; snippet: string }>;
    return rows.map((row) => ({ path: row.page_path, title: row.title, snippet: row.snippet }));
  }

  /** Distinct indexed page count (bot-deletion dialog preview). */
  wikiPageCount(): number {
    const row = this.#db.prepare('select count(distinct page_path) as n from wiki_fts').get() as {
      n: number;
    };
    return row.n;
  }

  /** All indexed page paths (startup FTS reconciliation, BR-P09-009). */
  wikiPagePaths(): string[] {
    const rows = this.#db.prepare('select distinct page_path from wiki_fts').all() as Array<{
      page_path: string;
    }>;
    return rows.map((row) => row.page_path);
  }

  /** Closes the underlying connection (pool eviction / project deletion / shutdown). */
  close(): void {
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
    this.#db.close();
  }
}

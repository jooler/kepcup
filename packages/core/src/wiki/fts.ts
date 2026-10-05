/**
 * The slice of the per-bot memory store the wiki module consumes. memory.db
 * owns `wiki_fts` (docs/dev/03-data-model.md); MemoryStore implements this
 * interface and every write segments text through infra/text-segment.ts.
 */
export interface WikiFtsStore {
  wikiUpsertPage(pagePath: string, title: string, content: string): void;
  wikiDeletePage(pagePath: string): void;
  wikiClearPages(): void;
  wikiSearch(
    queryText: string,
    limit: number,
  ): Array<{ path: string; title: string; snippet: string }>;
  wikiPageCount(): number;
  /** All indexed page paths (startup FTS reconciliation, BR-P09-009). */
  wikiPagePaths(): string[];
}

/** Per-bot access to the FTS store (MemoryService satisfies this). */
export interface WikiFtsFacade {
  storeFor(botId: string): WikiFtsStore;
}

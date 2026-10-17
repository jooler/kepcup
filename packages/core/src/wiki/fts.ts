import type { WikiOwner } from '@kepcup/shared';

/**
 * The FTS slice every wiki index implements (P09, extracted from MemoryStore
 * in D92 T1b WP9). Bots keep `wiki_fts` in their `memory.db` (MemoryStore
 * satisfies this structurally); every project wiki owns a dedicated
 * `wiki.db` (WikiIndexStore). All writes segment text through
 * infra/text-segment.ts (docs/dev/03-data-model.md "wiki_fts").
 */
export interface WikiIndex {
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

/** Resolves the FTS index of one wiki owner (bot → memory.db, project → wiki.db). */
export type WikiIndexFor = (owner: WikiOwner) => WikiIndex;

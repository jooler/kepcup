import { createRequire } from 'node:module';
import type {
  MemoryEvidence,
  MemoryItem,
  MemoryKind,
  MemorySensitivity,
  MemorySource,
  MemoryStatus,
} from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { CoreLogger } from '../infra/logger.js';
import { segmentForFts, buildFtsOrQuery } from '../infra/text-segment.js';

const require = createRequire(import.meta.url);

/**
 * sqlite-vec loads lazily, per connection, and degrades to full-text search
 * when it cannot (P13). The module is a devDependency, so packaged builds may
 * not contain it, and win32-arm64 has no upstream extension — a static import
 * would crash core at module-load time.
 *
 * The load has to be synchronous and happen before every vec0 statement.
 * memory_vec survives process restarts; a fresh connection that selects from
 * it before load() throws SQLite's "no such module: vec0". A dynamic import
 * cannot run on the sync query paths (findSimilar / knn / retract).
 */
type VecLoad = (db: SqliteDatabase) => void;
let vecLoader: VecLoad | null | undefined; // undefined = not tried; null = unavailable
let vecLoaderError: unknown = null;
let vecUnavailableLogged = false;

function resolveVecLoader(): VecLoad | null {
  if (vecLoader !== undefined) return vecLoader;
  try {
    const mod = require('sqlite-vec') as { load?: VecLoad };
    if (typeof mod.load === 'function') {
      vecLoader = mod.load;
    } else {
      vecLoader = null;
      vecLoaderError = new Error('sqlite-vec did not export load()');
    }
  } catch (error) {
    vecLoader = null;
    vecLoaderError = error;
  }
  return vecLoader;
}

interface MemoryItemRow {
  id: string;
  kind: MemoryKind;
  content: string;
  subject: string | null;
  source: MemorySource;
  evidence_json: string;
  origin: 'private' | 'group';
  origin_conversation_id: string | null;
  confidence: number;
  sensitivity: MemorySensitivity;
  private_to_bot: number;
  due_at: number | null;
  valid_until: number | null;
  status: MemoryStatus;
  supersedes: string | null;
  last_used_at: number | null;
  use_count: number;
  created_at: number;
  updated_at: number;
}

function rowToItem(botId: string, row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    botId,
    kind: row.kind,
    content: row.content,
    subject: row.subject,
    source: row.source,
    evidence: JSON.parse(row.evidence_json) as MemoryEvidence[],
    origin: row.origin,
    originConversationId: row.origin_conversation_id,
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    privateToBot: row.private_to_bot === 1,
    dueAt: row.due_at,
    validUntil: row.valid_until,
    status: row.status,
    supersedes: row.supersedes,
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewMemoryItem {
  kind: MemoryKind;
  content: string;
  subject?: string | null;
  source: MemorySource;
  evidence: MemoryEvidence[];
  origin: 'private' | 'group';
  originConversationId?: string | null;
  confidence: number;
  sensitivity: MemorySensitivity;
  privateToBot: boolean;
  dueAt?: number | null;
  validUntil?: number | null;
  supersedes?: string | null;
}

export interface MemoryStoreDeps {
  db: SqliteDatabase;
  clock: () => number;
  logger?: CoreLogger;
}

/**
 * One bot's private memory (memory_items / memory_fts / memory_vec in
 * memory.db). All FTS writes go through text-segment; memory_vec (sqlite-vec
 * vec0) is created lazily once an embedding dimension is known and rebuilt
 * when it changes (docs/dev/03-data-model.md "memory.db").
 */
export class MemoryStore {
  readonly #db: SqliteDatabase;
  readonly #clock: () => number;
  readonly #logger: CoreLogger | undefined;
  #botId: string | null = null;
  /** sqlite-vec is load-once per connection. */
  #vecLoaded = false;
  /** load() failed on this connection; do not touch memory_vec again. */
  #vecLoadFailed = false;

  constructor(deps: MemoryStoreDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#logger = deps.logger;
  }

  /** The owning bot (set by MemoryDbManager.for via withBot). */
  get botId(): string {
    if (this.#botId === null) throw new Error('MemoryStore used before setBot');
    return this.#botId;
  }

  setBot(botId: string): void {
    this.#botId = botId;
  }

  get #id(): string {
    return this.botId;
  }

  // --- basic CRUD -----------------------------------------------------------

  getItem(id: string): MemoryItem | null {
    const row = this.#db.prepare('select * from memory_items where id = ?').get(id) as
      MemoryItemRow | undefined;
    return row ? rowToItem(this.#id, row) : null;
  }

  list(
    options: { status?: MemoryStatus | undefined; kind?: MemoryKind | undefined } = {},
  ): MemoryItem[] {
    const clauses: string[] = [];
    const params: Array<string> = [];
    if (options.status !== undefined) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.kind !== undefined) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : '';
    const rows = this.#db
      .prepare(`select * from memory_items ${where} order by created_at desc`)
      .all(...params) as MemoryItemRow[];
    return rows.map((row) => rowToItem(this.#id, row));
  }

  activeItems(): MemoryItem[] {
    return this.list({ status: 'active' });
  }

  /**
   * Similarity dedupe (docs/dev/phases/P07-memory.md 写入校验 rule 6): with
   * vectors, cosine > 0.92 against active items; without, exact full-text
   * match. Returns the similar active item so the caller refreshes it instead
   * of inserting.
   */
  findSimilar(content: string, embedding: Float32Array | null): MemoryItem | null {
    // Cosine only when THIS connection has vec0 loaded. Otherwise exact text:
    // querying a leftover memory_vec throws "no such module: vec0".
    if (embedding !== null && this.#vecQueryable()) {
      const best = this.#bestCosine(embedding);
      if (best !== null) return this.getItem(best);
      return null;
    }
    return this.#exactActive(content);
  }

  #exactActive(content: string): MemoryItem | null {
    const row = this.#db
      .prepare(
        "select id from memory_items where status = 'active' and trim(content) = trim(?) order by rowid limit 1",
      )
      .get(content) as { id: string } | undefined;
    return row ? this.getItem(row.id) : null;
  }

  #bestCosine(embedding: Float32Array): string | null {
    if (!this.#vecLoaded || !this.#vecTableExists()) return null;
    const rows = this.#db
      .prepare('select item_rowid, distance from memory_vec where embedding match ? and k = 1')
      .all(this.#toBlob(embedding)) as Array<{ item_rowid: number; distance: number }>;
    const best = rows[0];
    if (!best) return null;
    // vec0 default distance is L2; cosine > 0.92 ⇔ L2² < 2 - 2·0.92 = 0.16
    // for unit-normalized vectors, which every embedder input is normalized to.
    if (best.distance * best.distance >= 0.16) return null;
    const item = this.#db
      .prepare('select id from memory_items where rowid = ?')
      .get(best.item_rowid) as { id: string } | undefined;
    if (!item) return null;
    const full = this.getItem(item.id);
    return full !== null && full.status === 'active' ? full.id : null;
  }

  /** Inserts an item; FTS via text-segment. Returns the created row. */
  insert(input: NewMemoryItem): MemoryItem {
    const now = this.#clock();
    const id = newId('mem');
    this.#db
      .prepare(
        'insert into memory_items (id, kind, content, subject, source, evidence_json, origin, origin_conversation_id, confidence, sensitivity, private_to_bot, due_at, valid_until, status, supersedes, use_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
      )
      .run(
        id,
        input.kind,
        input.content,
        input.subject ?? null,
        input.source,
        JSON.stringify(input.evidence),
        input.origin,
        input.originConversationId ?? null,
        input.confidence,
        input.sensitivity,
        input.privateToBot ? 1 : 0,
        input.dueAt ?? null,
        input.validUntil ?? null,
        'active',
        input.supersedes ?? null,
        now,
        now,
      );
    this.#writeFts(id, input.content);
    return this.getItem(id)!;
  }

  /** User edit / curation content update: rewrites FTS, marks updated. */
  updateContent(id: string, content: string): MemoryItem {
    this.#db
      .prepare('update memory_items set content = ?, updated_at = ? where id = ?')
      .run(content, this.#clock(), id);
    this.#db.prepare('delete from memory_fts where item_id = ?').run(id);
    this.#writeFts(id, content);
    return this.getItem(id)!;
  }

  /** UI「只属于该 Bot」toggle（任务书任务 13；用户显式操作）。 */
  setPrivateToBot(id: string, privateToBot: boolean): MemoryItem {
    this.#db
      .prepare('update memory_items set private_to_bot = ?, updated_at = ? where id = ?')
      .run(privateToBot ? 1 : 0, this.#clock(), id);
    return this.getItem(id)!;
  }

  /** Only refreshes updated_at (similarity dedupe hit). */
  touch(id: string): void {
    this.#db.prepare('update memory_items set updated_at = ? where id = ?').run(this.#clock(), id);
  }

  retract(id: string): void {
    this.#db
      .prepare("update memory_items set status = 'retracted', updated_at = ? where id = ?")
      .run(this.#clock(), id);
    this.#deleteFts(id);
    this.#deleteVecRow(id);
  }

  supersede(id: string): void {
    this.#db
      .prepare("update memory_items set status = 'superseded', updated_at = ? where id = ?")
      .run(this.#clock(), id);
    this.#deleteFts(id);
    this.#deleteVecRow(id);
  }

  /**
   * Commitments voided by conversation deletion / group removal (P07 级联).
   * Returns the voided ids so the schedule linkage (P10) can cancel the
   * corresponding定时任务.
   */
  voidCommitmentsOfConversation(conversationId: string): string[] {
    const affected = this.#db
      .prepare(
        "select id from memory_items where kind = 'commitment' and origin_conversation_id = ? and status = 'active'",
      )
      .all(conversationId) as Array<{ id: string }>;
    if (affected.length === 0) return [];
    const placeholders = affected.map(() => '?').join(',');
    this.#db
      .prepare(
        `update memory_items set status = 'void', updated_at = ? where id in (${placeholders})`,
      )
      .run(this.#clock(), ...affected.map((row) => row.id));
    return affected.map((row) => row.id);
  }

  /** Injected entries get their usage counters bumped (P07 任务 3). */
  markUsed(ids: string[]): void {
    const now = this.#clock();
    const stmt = this.#db.prepare(
      'update memory_items set last_used_at = ?, use_count = use_count + 1 where id = ?',
    );
    for (const id of ids) stmt.run(now, id);
  }

  commitments(): MemoryItem[] {
    const rows = this.#db
      .prepare(
        "select * from memory_items where kind = 'commitment' and status = 'active' order by due_at is null, due_at",
      )
      .all() as MemoryItemRow[];
    return rows.map((row) => rowToItem(this.#id, row));
  }

  /** Batches of one kind for consolidation (docs 任务 9, ≤50 per batch). */
  activeByKind(kind: MemoryKind, limit: number): MemoryItem[] {
    const rows = this.#db
      .prepare(
        "select * from memory_items where status = 'active' and kind = ? order by created_at limit ?",
      )
      .all(kind, limit) as MemoryItemRow[];
    return rows.map((row) => rowToItem(this.#id, row));
  }

  /** Expired entries (valid_until passed) become superseded directly. */
  expirePastValidUntil(now: number): number {
    return this.#db
      .prepare(
        "update memory_items set status = 'superseded', updated_at = ? where status = 'active' and valid_until is not null and valid_until <= ?",
      )
      .run(this.#clock(), now).changes;
  }

  // --- retrieval -------------------------------------------------------------

  /** FTS candidates (bm25-ranked, OR composition), active & unexpired only. */
  searchFts(queryText: string, limit: number): MemoryItem[] {
    const query = buildFtsOrQuery(queryText);
    if (query === null) return [];
    const rows = this.#db
      .prepare(
        `select m.* from memory_fts f join memory_items m on m.id = f.item_id
         where memory_fts match ? and m.status = 'active'
           and (m.valid_until is null or m.valid_until > ?)
         order by bm25(memory_fts) limit ?`,
      )
      .all(query, this.#clock(), limit) as MemoryItemRow[];
    return rows.map((row) => rowToItem(this.#id, row));
  }

  // --- meta ------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.#db.prepare('select value from meta where key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare(
        'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
      )
      .run(key, value);
  }

  // --- vectors (sqlite-vec, created when an embedder is ready) -----------------

  vecDim(): number | null {
    const stored = this.getMeta('embedding_dim');
    return stored !== null ? Number(stored) : null;
  }

  vecModelId(): string | null {
    return this.getMeta('embedding_model');
  }

  #vecTableExists(): boolean {
    const row = this.#db
      .prepare("select name from sqlite_master where type = 'table' and name = 'memory_vec'")
      .get() as { name: string } | undefined;
    return row !== undefined;
  }

  /**
   * Creates / recreates memory_vec at the given dimension (vec0, docs 原文).
   * Recomputing existing rows is the caller's (rebuild job's) job. Returns
   * 'unavailable' when sqlite-vec cannot be loaded (packaged devDependency
   * exclusion, win32-arm64) — callers then degrade to full-text search.
   */
  async ensureVecTable(
    modelId: string,
    dim: number,
  ): Promise<'created' | 'exists' | 'recreated' | 'unavailable'> {
    if (!this.#ensureVecLoaded()) return 'unavailable';
    const currentDim = this.vecDim();
    const currentModel = this.vecModelId();
    if (this.#vecTableExists() && currentDim === dim && currentModel === modelId) {
      return 'exists';
    }
    const firstCreation = currentDim === null;
    if (this.#vecTableExists()) {
      // Model/dim changed: drop everything, the rebuild job recomputes.
      this.#db.exec('drop table memory_vec');
    }
    this.#db.exec(
      `create virtual table memory_vec using vec0(item_rowid integer primary key, embedding float[${dim}])`,
    );
    this.setMeta('embedding_dim', String(dim));
    this.setMeta('embedding_model', modelId);
    return firstCreation ? 'created' : 'recreated';
  }

  upsertVec(itemRowid: number, embedding: Float32Array): void {
    if (!this.#vecQueryable()) return;
    this.#db.prepare('delete from memory_vec where item_rowid = ?').run(BigInt(itemRowid));
    this.#db
      .prepare('insert into memory_vec(item_rowid, embedding) values (?, ?)')
      .run(BigInt(itemRowid), this.#toBlob(embedding));
  }

  /** KNN over memory_vec; returns item ids ordered by distance. */
  knn(query: Float32Array, k: number): MemoryItem[] {
    if (!this.#vecQueryable()) return [];
    const rows = this.#db
      .prepare(
        `select m.* from memory_vec v join memory_items m on m.rowid = v.item_rowid
         where v.embedding match ? and k = ? and m.status = 'active'
           and (m.valid_until is null or m.valid_until > ?)
         order by v.distance`,
      )
      .all(this.#toBlob(query), k, this.#clock()) as MemoryItemRow[];
    return rows.map((row) => rowToItem(this.#id, row));
  }

  /** rowid of an item (vec0 PK space). */
  rowidOf(id: string): number | null {
    const row = this.#db.prepare('select rowid from memory_items where id = ?').get(id) as
      { rowid: number } | undefined;
    return row?.rowid ?? null;
  }

  allActiveWithRowids(): Array<{ item: MemoryItem; rowid: number }> {
    const rows = this.#db
      .prepare("select *, rowid as _rowid from memory_items where status = 'active'")
      .all() as Array<MemoryItemRow & { _rowid: number }>;
    return rows.map((row) => ({ item: rowToItem(this.#id, row), rowid: row._rowid }));
  }

  /**
   * Loads sqlite-vec into this connection before any vec0 statement.
   * Failure is sticky for the connection and degrades to full text; it must
   * not escape into a conversation run.
   */
  #ensureVecLoaded(): boolean {
    if (this.#vecLoaded) return true;
    if (this.#vecLoadFailed) return false;
    const load = resolveVecLoader();
    if (load === null) {
      this.#vecLoadFailed = true;
      this.#noteVecUnavailable(vecLoaderError ?? new Error('sqlite-vec is not installed'));
      return false;
    }
    try {
      // Loading into the encrypted (chacha20) connection is verified in PROGRESS.md P07.
      load(this.#db);
    } catch (error) {
      this.#vecLoadFailed = true;
      this.#noteVecUnavailable(error);
      return false;
    }
    this.#vecLoaded = true;
    return true;
  }

  /** True only when this connection can execute vec0 SQL against memory_vec. */
  #vecQueryable(): boolean {
    return this.#ensureVecLoaded() && this.#vecTableExists();
  }

  #noteVecUnavailable(error: unknown): void {
    if (vecUnavailableLogged) return;
    vecUnavailableLogged = true;
    this.#logger?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      'sqlite-vec unavailable; vector search falls back to full text',
    );
  }

  #toBlob(vector: Float32Array): Buffer {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  }

  #writeFts(id: string, content: string): void {
    this.#db
      .prepare('insert into memory_fts (segmented_text, item_id) values (?, ?)')
      .run(segmentForFts(content), id);
  }

  #deleteFts(id: string): void {
    this.#db.prepare('delete from memory_fts where item_id = ?').run(id);
  }

  #deleteVecRow(id: string): void {
    if (!this.#vecQueryable()) return;
    const rowid = this.rowidOf(id);
    if (rowid === null) return;
    this.#db.prepare('delete from memory_vec where item_rowid = ?').run(BigInt(rowid));
  }

  // --- wiki_fts (P09; every write goes through text-segment) -------------------

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

  /** Test/IPC surface: the raw connection stays internal otherwise. */
  close(): void {
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
    this.#db.close();
  }
}

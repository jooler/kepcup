import type { ProfileCard, ProfileCategory, ProfileItem, ProfileProposal } from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import { segmentForFts } from '../infra/text-segment.js';
import type { SqliteDatabase } from '../infra/db.js';

interface ProfileItemRow {
  id: string;
  category: ProfileCategory;
  content: string;
  source: 'explicit' | 'inferred';
  evidence_json: string;
  contributed_by: string | null;
  confidence: number;
  valid_until: number | null;
  status: 'active' | 'superseded' | 'retracted';
  supersedes: string | null;
  principal_key: string;
  created_at: number;
  updated_at: number;
}

interface ProposalRow {
  id: string;
  bot_id: string | null;
  op: 'add' | 'retract';
  target_item_id: string | null;
  payload_json: string;
  status: 'pending' | 'applied' | 'rejected';
  result_json: string | null;
  principal_key: string;
  created_at: number;
  processed_at: number | null;
}

/**
 * A profile entry with its principal bucket (62.11 C11, docs/design/
 * 62-team-server/05-profile-and-memory.md §2). The shared `ProfileItem` type
 * stays untouched (packages/shared is a fixed RPC contract); the key travels
 * as a core-local extension (`''` = the single-user bucket).
 */
export type KeyedProfileItem = ProfileItem & { principalKey: string };
/** A profile proposal with its principal bucket (same extension as above). */
export type KeyedProfileProposal = ProfileProposal & { principalKey: string };

function rowToItem(row: ProfileItemRow): KeyedProfileItem {
  return {
    id: row.id,
    category: row.category,
    content: row.content,
    source: row.source,
    evidence: JSON.parse(row.evidence_json) as Array<{
      messageId: string | null;
      conversationId: string | null;
    }>,
    contributedBy: row.contributed_by,
    confidence: row.confidence,
    validUntil: row.valid_until,
    status: row.status,
    supersedes: row.supersedes,
    principalKey: row.principal_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewProfileItem {
  category: ProfileCategory;
  content: string;
  source: 'explicit' | 'inferred';
  evidence: Array<{ messageId: string | null; conversationId: string | null }>;
  contributedBy: string | null;
  confidence: number;
  validUntil?: number | null;
  supersedes?: string | null;
}

export interface ProfileStoreDeps {
  db: SqliteDatabase;
  clock: () => number;
}

/**
 * Shared user profile storage (profile_items / profile_fts / profile_card /
 * profile_proposals in main.db). This module is the ONLY code that writes
 * profile_items (docs/dev/phases/P07-memory.md 注意事项): the profile
 * curation job and the user's direct edits (profile.update/retract RPC) both
 * go through these methods.
 *
 * Every read/write is scoped by `principalKey` (62.11 C11): one profile domain
 * per human principal, `''` = the single-user bucket. Defaults keep the
 * pre-principal call sites byte-compatible.
 */
export class ProfileStore {
  readonly #db: SqliteDatabase;
  readonly #clock: () => number;

  constructor(deps: ProfileStoreDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  // --- items -----------------------------------------------------------------

  /** One entry by unique id (unscoped — callers compare `principalKey`). */
  getItem(id: string): KeyedProfileItem | null {
    const row = this.#db.prepare('select * from profile_items where id = ?').get(id) as
      ProfileItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(
    status: ProfileItem['status'] = 'active',
    category?: ProfileCategory,
    principalKey = '',
  ): KeyedProfileItem[] {
    const rows = (
      category !== undefined
        ? this.#db
            .prepare(
              'select * from profile_items where status = ? and category = ? and principal_key = ? order by created_at',
            )
            .all(status, category, principalKey)
        : this.#db
            .prepare('select * from profile_items where status = ? and principal_key = ? order by created_at')
            .all(status, principalKey)
    ) as ProfileItemRow[];
    return rows.map(rowToItem);
  }

  /** Curation `add` / user edit insertion (prf_ ids, FTS via text-segment). */
  insert(input: NewProfileItem, principalKey = ''): KeyedProfileItem {
    const now = this.#clock();
    const id = newId('prf');
    this.#db
      .prepare(
        'insert into profile_items (id, category, content, source, evidence_json, contributed_by, confidence, valid_until, status, supersedes, principal_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.category,
        input.content,
        input.source,
        JSON.stringify(input.evidence),
        input.contributedBy,
        input.confidence,
        input.validUntil ?? null,
        'active',
        input.supersedes ?? null,
        principalKey,
        now,
        now,
      );
    this.#db
      .prepare('insert into profile_fts (segmented_text, item_id) values (?, ?)')
      .run(segmentForFts(input.content), id);
    return this.getItem(id)!;
  }

  /** User edit / curation `update`: content rewrite + FTS resync (key-scoped). */
  updateContent(id: string, content: string, principalKey = ''): KeyedProfileItem {
    this.#db
      .prepare(
        'update profile_items set content = ?, updated_at = ? where id = ? and principal_key = ?',
      )
      .run(content, this.#clock(), id, principalKey);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
    this.#db
      .prepare('insert into profile_fts (segmented_text, item_id) values (?, ?)')
      .run(segmentForFts(content), id);
    return this.getItem(id)!;
  }

  /** User edit / curation category move (key-scoped). */
  updateCategory(id: string, category: ProfileCategory, principalKey = ''): KeyedProfileItem {
    this.#db
      .prepare(
        'update profile_items set category = ?, updated_at = ? where id = ? and principal_key = ?',
      )
      .run(category, this.#clock(), id, principalKey);
    return this.getItem(id)!;
  }

  supersede(id: string, principalKey = ''): void {
    this.#db
      .prepare(
        "update profile_items set status = 'superseded', updated_at = ? where id = ? and principal_key = ?",
      )
      .run(this.#clock(), id, principalKey);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
  }

  retract(id: string, principalKey = ''): void {
    this.#db
      .prepare(
        "update profile_items set status = 'retracted', updated_at = ? where id = ? and principal_key = ?",
      )
      .run(this.#clock(), id, principalKey);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
  }

  // --- card ------------------------------------------------------------------

  /** The compiled card of one principal bucket (`''` = single user). */
  getCard(principalKey = ''): ProfileCard {
    const row = this.#db.prepare('select * from profile_card where principal_key = ?').get(
      principalKey,
    ) as { content: string; compiled_at: number } | undefined;
    return row
      ? { content: row.content, compiledAt: row.compiled_at }
      : { content: null, compiledAt: null };
  }

  setCard(content: string, principalKey = ''): void {
    this.#db
      .prepare(
        'insert into profile_card (principal_key, content, compiled_at) values (?, ?, ?) on conflict(principal_key) do update set content = excluded.content, compiled_at = excluded.compiled_at',
      )
      .run(principalKey, content, this.#clock());
  }

  /**
   * True when the compiled card no longer reflects the entries: it was never
   * compiled, or any entry changed after the last compilation. Every status is
   * considered, not just active ones — a retraction / supersede must also make
   * the card stale, otherwise the removed constraint stays injected. Direct
   * user edits bump `updated_at`, so no extra column is needed
   * (docs/design/04-memory.md 画像整理).
   */
  cardIsStale(principalKey = ''): boolean {
    const card = this.getCard(principalKey);
    const row = this.#db
      .prepare('select max(updated_at) as updated_at from profile_items where principal_key = ?')
      .get(principalKey) as { updated_at: number | null };
    if (row.updated_at === null) return false;
    if (card.compiledAt === null) return true;
    return row.updated_at > card.compiledAt;
  }

  /**
   * True when the compiled card no longer reflects the entries: it was never
   * compiled, or any entry changed after the last compilation. Every status is
   * considered, not just active ones — a retraction / supersede must also make
   * the card stale, otherwise the removed constraint stays injected. Direct
   * user edits bump `updated_at`, so no extra column is needed
   * (docs/design/04-memory.md 画像整理).
   */
  cardIsStale(): boolean {
    const card = this.getCard();
    const row = this.#db
      .prepare('select max(updated_at) as updated_at from profile_items')
      .get() as { updated_at: number | null };
    if (row.updated_at === null) return false;
    if (card.compiledAt === null) return true;
    return row.updated_at > card.compiledAt;
  }

  // --- proposals ---------------------------------------------------------------

  insertProposal(
    input: {
      botId: string | null;
      op: 'add' | 'retract';
      targetItemId?: string | null;
      payload: Record<string, unknown>;
    },
    principalKey = '',
  ): KeyedProfileProposal {
    const id = newId('prp');
    const now = this.#clock();
    this.#db
      .prepare(
        "insert into profile_proposals (id, bot_id, op, target_item_id, payload_json, status, principal_key, created_at) values (?, ?, ?, ?, ?, 'pending', ?, ?)",
      )
      .run(
        id,
        input.botId,
        input.op,
        input.targetItemId ?? null,
        JSON.stringify(input.payload),
        principalKey,
        now,
      );
    return this.getProposal(id)!;
  }

  /** One proposal by unique id (unscoped — callers compare `principalKey`). */
  getProposal(id: string): KeyedProfileProposal | null {
    const row = this.#db.prepare('select * from profile_proposals where id = ?').get(id) as
      ProposalRow | undefined;
    return row ? this.#toProposal(row) : null;
  }

  /** Pending proposals of one principal bucket (curation job input). */
  pendingProposals(principalKey = ''): KeyedProfileProposal[] {
    const rows = this.#db
      .prepare(
        "select * from profile_proposals where status = 'pending' and principal_key = ? order by created_at",
      )
      .all(principalKey) as ProposalRow[];
    return rows.map((row) => this.#toProposal(row));
  }

  markProposal(id: string, status: 'applied' | 'rejected', result: Record<string, unknown>): void {
    this.#db
      .prepare(
        'update profile_proposals set status = ?, result_json = ?, processed_at = ? where id = ?',
      )
      .run(status, JSON.stringify(result), this.#clock(), id);
  }

  #toProposal(row: ProposalRow): KeyedProfileProposal {
    return {
      id: row.id,
      botId: row.bot_id,
      op: row.op,
      targetItemId: row.target_item_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status,
      result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
      principalKey: row.principal_key,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}

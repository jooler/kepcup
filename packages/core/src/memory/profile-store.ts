import type {
  ProfileCard,
  ProfileCategory,
  ProfileItem,
  ProfileProposal,
} from '@kepcup/shared';
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
  created_at: number;
  processed_at: number | null;
}

function rowToItem(row: ProfileItemRow): ProfileItem {
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
 */
export class ProfileStore {
  readonly #db: SqliteDatabase;
  readonly #clock: () => number;

  constructor(deps: ProfileStoreDeps) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  // --- items -----------------------------------------------------------------

  getItem(id: string): ProfileItem | null {
    const row = this.#db.prepare('select * from profile_items where id = ?').get(id) as
      ProfileItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(status: ProfileItem['status'] = 'active', category?: ProfileCategory): ProfileItem[] {
    const rows = (
      category !== undefined
        ? this.#db
            .prepare(
              'select * from profile_items where status = ? and category = ? order by created_at',
            )
            .all(status, category)
        : this.#db
            .prepare('select * from profile_items where status = ? order by created_at')
            .all(status)
    ) as ProfileItemRow[];
    return rows.map(rowToItem);
  }

  /** Curation `add` / user edit insertion (prf_ ids, FTS via text-segment). */
  insert(input: NewProfileItem): ProfileItem {
    const now = this.#clock();
    const id = newId('prf');
    this.#db
      .prepare(
        'insert into profile_items (id, category, content, source, evidence_json, contributed_by, confidence, valid_until, status, supersedes, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        now,
        now,
      );
    this.#db
      .prepare('insert into profile_fts (segmented_text, item_id) values (?, ?)')
      .run(segmentForFts(input.content), id);
    return this.getItem(id)!;
  }

  /** User edit / curation `update`: content rewrite + FTS resync. */
  updateContent(id: string, content: string): ProfileItem {
    this.#db
      .prepare('update profile_items set content = ?, updated_at = ? where id = ?')
      .run(content, this.#clock(), id);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
    this.#db
      .prepare('insert into profile_fts (segmented_text, item_id) values (?, ?)')
      .run(segmentForFts(content), id);
    return this.getItem(id)!;
  }

  /** User edit / curation category move. */
  updateCategory(id: string, category: ProfileCategory): ProfileItem {
    this.#db
      .prepare('update profile_items set category = ?, updated_at = ? where id = ?')
      .run(category, this.#clock(), id);
    return this.getItem(id)!;
  }

  supersede(id: string): void {
    this.#db
      .prepare("update profile_items set status = 'superseded', updated_at = ? where id = ?")
      .run(this.#clock(), id);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
  }

  retract(id: string): void {
    this.#db
      .prepare("update profile_items set status = 'retracted', updated_at = ? where id = ?")
      .run(this.#clock(), id);
    this.#db.prepare('delete from profile_fts where item_id = ?').run(id);
  }

  // --- card ------------------------------------------------------------------

  getCard(): ProfileCard {
    const row = this.#db.prepare('select * from profile_card where id = 1').get() as
      { content: string; compiled_at: number } | undefined;
    return row
      ? { content: row.content, compiledAt: row.compiled_at }
      : { content: null, compiledAt: null };
  }

  setCard(content: string): void {
    this.#db
      .prepare(
        'insert into profile_card (id, content, compiled_at) values (1, ?, ?) on conflict(id) do update set content = excluded.content, compiled_at = excluded.compiled_at',
      )
      .run(content, this.#clock());
  }

  // --- proposals ---------------------------------------------------------------

  insertProposal(input: {
    botId: string | null;
    op: 'add' | 'retract';
    targetItemId?: string | null;
    payload: Record<string, unknown>;
  }): ProfileProposal {
    const id = newId('prp');
    const now = this.#clock();
    this.#db
      .prepare(
        "insert into profile_proposals (id, bot_id, op, target_item_id, payload_json, status, created_at) values (?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        id,
        input.botId,
        input.op,
        input.targetItemId ?? null,
        JSON.stringify(input.payload),
        now,
      );
    return this.getProposal(id)!;
  }

  getProposal(id: string): ProfileProposal | null {
    const row = this.#db.prepare('select * from profile_proposals where id = ?').get(id) as
      ProposalRow | undefined;
    return row ? this.#toProposal(row) : null;
  }

  pendingProposals(): ProfileProposal[] {
    const rows = this.#db
      .prepare("select * from profile_proposals where status = 'pending' order by created_at")
      .all() as ProposalRow[];
    return rows.map((row) => this.#toProposal(row));
  }

  markProposal(id: string, status: 'applied' | 'rejected', result: Record<string, unknown>): void {
    this.#db
      .prepare(
        'update profile_proposals set status = ?, result_json = ?, processed_at = ? where id = ?',
      )
      .run(status, JSON.stringify(result), this.#clock(), id);
  }

  #toProposal(row: ProposalRow): ProfileProposal {
    return {
      id: row.id,
      botId: row.bot_id,
      op: row.op,
      targetItemId: row.target_item_id,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      status: row.status,
      result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    };
  }
}

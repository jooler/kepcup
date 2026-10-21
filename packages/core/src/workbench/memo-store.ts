import type { Memo, TodoSource } from '@kepcup/shared';
import { newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import { likePattern } from './todo-store.js';

interface MemoRow {
  id: string;
  body: string;
  pinned: number;
  source: TodoSource;
  created_at: number;
  updated_at: number;
  sort_at: number;
  deleted_at: number | null;
}

export function rowToMemo(row: MemoRow): Memo {
  return {
    id: row.id,
    body: row.body,
    pinned: row.pinned !== 0,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortAt: row.sort_at,
    deletedAt: row.deleted_at,
  };
}

export interface InsertMemoInput {
  body: string;
  source: TodoSource;
  pinned?: boolean | undefined;
}

export interface UpdateMemoPatch {
  body?: string;
  pinned?: boolean;
}

export interface ListMemosFilter {
  /** Substring match on the body (LIKE). */
  query?: string | undefined;
  /** true = 最近删除 (soft-deleted); default = live memos. */
  trashed?: boolean | undefined;
}

/**
 * Data access for the memos table (main.db, docs/dev/03-data-model.md "memos").
 * Pure persistence — length limits, events and the startup purge schedule live
 * in MemoService. Delete is soft (`deleted_at`) so butler mistakes are
 * recoverable; `purgeTrashed` removes rows for good.
 */
export class MemoStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  insert(input: InsertMemoInput): Memo {
    const id = newId('memo');
    const now = this.clock.now();
    this.db
      .prepare(
        `insert into memos (id, body, pinned, source, created_at, updated_at, sort_at, deleted_at)
         values (?, ?, ?, ?, ?, ?, ?, null)`,
      )
      .run(id, input.body, input.pinned === true ? 1 : 0, input.source, now, now, now);
    const memo = this.get(id);
    if (memo === null) throw new Error(`memo ${id} disappeared after insert`);
    return memo;
  }

  /** Any memo by id, trashed or not. */
  get(id: string): Memo | null {
    const row = this.db.prepare('select * from memos where id = ?').get(id) as MemoRow | undefined;
    return row ? rowToMemo(row) : null;
  }

  /**
   * Live memos: pinned first, then by sort key (`sort_at` — creation time, only
   * refreshed when the pin state changes, so editing the body never reorders
   * the list). Trashed memos: most recently deleted first.
   */
  list(filter: ListMemosFilter = {}): Memo[] {
    const trashed = filter.trashed === true;
    const where = [trashed ? 'deleted_at is not null' : 'deleted_at is null'];
    const params: string[] = [];
    if (filter.query !== undefined && filter.query.trim() !== '') {
      where.push("body like ? escape '\\'");
      params.push(likePattern(filter.query.trim()));
    }
    const order = trashed ? 'deleted_at desc, id desc' : 'pinned desc, sort_at desc, id desc';
    return (
      this.db
        .prepare(`select * from memos where ${where.join(' and ')} order by ${order}`)
        .all(...params) as MemoRow[]
    ).map(rowToMemo);
  }

  /**
   * Edit body and / or pin state. `updated_at` always moves (it is the real
   * "last modified" time shown on the card); `sort_at` only moves when the pin
   * state actually changes, so editing the body keeps the card in place.
   * Null when the memo does not exist.
   */
  update(id: string, patch: UpdateMemoPatch): Memo | null {
    const current = this.get(id);
    if (current === null) return null;
    const pinned = (patch.pinned ?? current.pinned) ? 1 : 0;
    const now = this.clock.now();
    this.db
      .prepare(
        'update memos set body = ?, pinned = ?, updated_at = ?, sort_at = ? where id = ?',
      )
      .run(
        patch.body ?? current.body,
        pinned,
        now,
        pinned === (current.pinned ? 1 : 0) ? current.sortAt : now,
        id,
      );
    return this.get(id);
  }

  /** Move to 最近删除. Keeps `sort_at` so a restore returns the memo to its place. */
  softDelete(id: string): Memo | null {
    const changed = this.db
      .prepare('update memos set deleted_at = ? where id = ? and deleted_at is null')
      .run(this.clock.now(), id).changes;
    return changed > 0 ? this.get(id) : null;
  }

  /** Back from 最近删除. Null when the memo does not exist or is not trashed. */
  restore(id: string): Memo | null {
    const changed = this.db
      .prepare('update memos set deleted_at = null where id = ? and deleted_at is not null')
      .run(id).changes;
    return changed > 0 ? this.get(id) : null;
  }

  /** Permanently removes memos trashed before `before` (UTC ms); returns how many. */
  purgeTrashed(before: number): number {
    return this.db
      .prepare('delete from memos where deleted_at is not null and deleted_at < ?')
      .run(before).changes;
  }
}

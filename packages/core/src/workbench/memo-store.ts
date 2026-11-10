import type { Memo, MemoGroup, TodoSource } from '@kepcup/shared';
import { WORKBENCH_POSITION_MIN_GAP, WORKBENCH_POSITION_STEP, newId } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import { placeItem } from '../board/positions.js';
import { likePattern } from './todo-store.js';

/** 备忘 position 算法参数（与看板同款 placeItem，步长用工作台自己的常量）。 */
const POSITION_OPTS = { step: WORKBENCH_POSITION_STEP, minGap: WORKBENCH_POSITION_MIN_GAP };

interface MemoRow {
  id: string;
  body: string;
  pinned: number;
  source: TodoSource;
  created_at: number;
  updated_at: number;
  sort_at: number;
  deleted_at: number | null;
  group_id: string | null;
  position: number;
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
    groupId: row.group_id,
    position: row.position,
  };
}

interface MemoGroupRow {
  id: string;
  title: string;
  position: number;
  created_at: number;
  updated_at: number;
}

function rowToMemoGroup(row: MemoGroupRow): MemoGroup {
  return {
    id: row.id,
    title: row.title,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertMemoInput {
  body: string;
  source: TodoSource;
  pinned?: boolean | undefined;
  /**
   * Target group; absent = 未分组伪分组（group_id 为 null）。存在性校验在 MemoService，
   * 这里只负责落位：新备忘插到所属组的顶部（取组内最小 position 之前）。
   */
  groupId?: string | undefined;
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
 * Data access for the memos / memo_groups tables (main.db, docs/dev/03-data-model.md
 * "memos"). Pure persistence — length limits, events and the startup purge schedule
 * live in MemoService. Delete is soft (`deleted_at`) so butler mistakes are
 * recoverable; `purgeTrashed` removes rows for good.
 *
 * Ordering (D90 §5.4): live memos are `pinned desc, position asc, id desc` — pinned
 * cards float to the top of their group, otherwise the manual drag order wins. A
 * fresh memo lands on top of 未分组 (`position` below the group minimum).
 */
export class MemoStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  insert(input: InsertMemoInput): Memo {
    const id = newId('memo');
    const now = this.clock.now();
    const min = this.db
      .prepare(
        `select min(position) as m from memos
         where deleted_at is null and group_id ${input.groupId === undefined ? 'is null' : '= ?'}`,
      )
      .get(...(input.groupId === undefined ? [] : [input.groupId])) as { m: number | null };
    const position = min.m === null ? POSITION_OPTS.step : min.m - POSITION_OPTS.step;
    this.db
      .prepare(
        `insert into memos (id, body, pinned, source, created_at, updated_at, sort_at, deleted_at, group_id, position)
         values (?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
      )
      .run(
        id,
        input.body,
        input.pinned === true ? 1 : 0,
        input.source,
        now,
        now,
        now,
        input.groupId ?? null,
        position,
      );
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
   * Live memos: pinned first, then the manual drag order (`position`, backfilled
   * from the old `sort_at` order so nothing moves until the first drag). Trashed
   * memos: most recently deleted first.
   */
  list(filter: ListMemosFilter = {}): Memo[] {
    const trashed = filter.trashed === true;
    const where = [trashed ? 'deleted_at is not null' : 'deleted_at is null'];
    const params: string[] = [];
    if (filter.query !== undefined && filter.query.trim() !== '') {
      where.push("body like ? escape '\\'");
      params.push(likePattern(filter.query.trim()));
    }
    const order = trashed ? 'deleted_at desc, id desc' : 'pinned desc, position asc, id desc';
    return (
      this.db
        .prepare(`select * from memos where ${where.join(' and ')} order by ${order}`)
        .all(...params) as MemoRow[]
    ).map(rowToMemo);
  }

  /**
   * Edit body and / or pin state. `updated_at` always moves (it is the real
   * "last modified" time shown on the card); `sort_at` only moves when the pin
   * state actually changes (legacy sync — live ordering uses `position`, and
   * pinned cards float via the `pinned desc` order, so pin toggles never touch
   * the drag position). Null when the memo does not exist.
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

  /** Move to 最近删除. Keeps `position` so a restore returns the memo to its place. */
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

  // --- 分组与拖拽（D90 §5.4） -------------------------------------------------

  /** One group's live memos in display order (`pinned desc, position asc, id desc`). */
  listInGroup(groupId: string | null): Memo[] {
    return (
      this.db
        .prepare(
          `select * from memos where deleted_at is null and group_id ${groupId === null ? 'is null' : '= ?'}
           order by pinned desc, position asc, id desc`,
        )
        .all(...(groupId === null ? [] : [groupId])) as MemoRow[]
    ).map(rowToMemo);
  }

  /**
   * Move a memo into `groupId` (`null` = 未分组), placing it before `beforeId`
   * (`null` = end). Throws when the anchor is missing or is the moved memo.
   * Does not touch `updated_at` (a reorder is not a content edit); `changed`
   * is false when the memo already sat in the requested slot.
   */
  move(id: string, groupId: string | null, beforeId: string | null): { memo: Memo; changed: boolean } | null {
    const current = this.get(id);
    if (current === null) return null;
    const placed = placeItem(
      this.listInGroup(groupId).map((memo) => ({ id: memo.id, position: memo.position })),
      id,
      beforeId,
      POSITION_OPTS,
    );
    const moved = placed.items.find((item) => item.id === id);
    if (moved === undefined) throw new Error(`memo ${id} missing after placeItem`);
    if (placed.changed) {
      this.db.transaction(() => {
        this.db
          .prepare('update memos set group_id = ?, position = ? where id = ?')
          .run(groupId, moved.position, id);
        if (placed.renumbered) {
          const stmt = this.db.prepare('update memos set position = ? where id = ?');
          for (const item of placed.items) stmt.run(item.position, item.id);
        }
      })();
    }
    const memo = this.get(id);
    return memo === null ? null : { memo, changed: placed.changed };
  }

  /** All groups in display order (`position asc`). */
  listGroups(): MemoGroup[] {
    return (
      this.db.prepare('select * from memo_groups order by position asc, id asc').all() as MemoGroupRow[]
    ).map(rowToMemoGroup);
  }

  getGroup(id: string): MemoGroup | null {
    const row = this.db.prepare('select * from memo_groups where id = ?').get(id) as
      | MemoGroupRow
      | undefined;
    return row ? rowToMemoGroup(row) : null;
  }

  /** New groups append at the end. */
  insertGroup(title: string): MemoGroup {
    const id = newId('mmg');
    const now = this.clock.now();
    const max = this.db.prepare('select max(position) as m from memo_groups').get() as {
      m: number | null;
    };
    const position = (max.m ?? 0) + POSITION_OPTS.step;
    this.db
      .prepare('insert into memo_groups (id, title, position, created_at, updated_at) values (?, ?, ?, ?, ?)')
      .run(id, title, position, now, now);
    const group = this.getGroup(id);
    if (group === null) throw new Error(`memo group ${id} disappeared after insert`);
    return group;
  }

  renameGroup(id: string, title: string): MemoGroup | null {
    const changed = this.db
      .prepare('update memo_groups set title = ?, updated_at = ? where id = ?')
      .run(title, this.clock.now(), id).changes;
    return changed > 0 ? this.getGroup(id) : null;
  }

  /**
   * Drag-reorder groups: place `id` before `beforeId` (`null` = end). Throws when
   * the anchor is missing or is the moved group. Does not touch `updated_at`;
   * `changed` is false when the group already sat in the requested slot.
   */
  moveGroup(id: string, beforeId: string | null): { group: MemoGroup; changed: boolean } | null {
    if (this.getGroup(id) === null) return null;
    const placed = placeItem(
      this.listGroups().map((group) => ({ id: group.id, position: group.position })),
      id,
      beforeId,
      POSITION_OPTS,
    );
    const moved = placed.items.find((item) => item.id === id);
    if (moved === undefined) throw new Error(`memo group ${id} missing after placeItem`);
    if (placed.changed) {
      this.db.transaction(() => {
        this.db
          .prepare('update memo_groups set position = ? where id = ?')
          .run(moved.position, id);
        if (placed.renumbered) {
          const stmt = this.db.prepare('update memo_groups set position = ? where id = ?');
          for (const item of placed.items) stmt.run(item.position, item.id);
        }
      })();
    }
    const group = this.getGroup(id);
    return group === null ? null : { group, changed: placed.changed };
  }

  /**
   * Deletes a group; its memos fall back to 未分组 (they keep their positions, so
   * they re-enter the ungrouped list at a stable spot). False when it does not exist.
   */
  deleteGroup(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('update memos set group_id = null where group_id = ?').run(id);
      return this.db.prepare('delete from memo_groups where id = ?').run(id).changes > 0;
    })();
  }
}

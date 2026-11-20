import {
  AppError,
  MEMO_BODY_MAX_CHARS,
  MEMO_GROUP_TITLE_MAX_CHARS,
  MEMO_TRASH_RETENTION_MS,
  type Memo,
  type MemoGroup,
  type TodoSource,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ListMemosFilter, MemoStore, StoredMemo, StoredMemoGroup } from './memo-store.js';

export interface MemoServiceDeps {
  store: MemoStore;
  clock: Clock;
  logger: CoreLogger;
  /** RPC events (memos.changed). */
  publish?: ((event: string, payload: unknown) => void) | undefined;
}

/**
 * Workbench memos (D90, docs/design/39-workbench.md §2.4): plain-text flash notes that live
 * outside every conversation. Delete is soft (最近删除, 30 days) so a mistaken butler delete
 * can be undone; every change publishes `memos.changed`.
 *
 * 分组与拖拽（§5.4）：分组只是标题 + 排序键的行；「未分组」是 `group_id is null`。拖拽 =
 * `move`（换组 + placeItem 落 position）。删组不删备忘，组内备忘回到未分组。
 */
export class MemoService {
  readonly #deps: MemoServiceDeps;

  constructor(deps: MemoServiceDeps) {
    this.#deps = deps;
  }

  list(filter: ListMemosFilter = {}): Memo[] {
    return this.#deps.store.list(filter);
  }

  /** 62.11 C13：传入主体时只列该主体的组；缺省 = 全部（单用户现状）。 */
  listGroups(ownerPrincipalId?: string): MemoGroup[] {
    return this.#deps.store.listGroups(ownerPrincipalId);
  }

  get(id: string): Memo {
    return this.#getOrThrow(id);
  }

  create(input: {
    body: string;
    source?: TodoSource | undefined;
    groupId?: string | undefined;
    /** 62.11 C13：归属主体（调用者）。缺省 / null = 单用户现状（NULL 行）。 */
    ownerPrincipalId?: string | null | undefined;
  }): Memo {
    const groupId = input.groupId;
    if (groupId !== undefined && this.#groupVisibleTo(groupId, input.ownerPrincipalId) === false) {
      throw new AppError('NOT_FOUND', `备忘分组 ${groupId} 不存在`);
    }
    const memo = this.#deps.store.insert({
      body: cleanBody(input.body),
      source: input.source ?? 'user',
      ...(groupId !== undefined ? { groupId } : {}),
      ...(input.ownerPrincipalId != null ? { ownerPrincipalId: input.ownerPrincipalId } : {}),
    });
    this.#changed(memo.id, memo.ownerPrincipalId);
    return memo;
  }

  update(
    id: string,
    patch: { body?: string | undefined; pinned?: boolean | undefined },
    ownerPrincipalId?: string | null,
  ): Memo {
    this.#assertOwned(id, ownerPrincipalId);
    const current = this.#getOrThrow(id);
    if (current.deletedAt !== null) {
      throw new AppError('INVALID_INPUT', '备忘在「最近删除」里，请先恢复再修改');
    }
    const memo = this.#deps.store.update(id, {
      ...(patch.body !== undefined ? { body: cleanBody(patch.body) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id, memo.ownerPrincipalId);
    return memo;
  }

  /**
   * Drag a memo into another group (or within one): `groupId` null = 未分组,
   * `beforeId` null = end of the target group. Only live memos can move; a drop
   * at the memo's current slot publishes nothing.
   */
  move(id: string, groupId: string | null, beforeId: string | null, ownerPrincipalId?: string | null): Memo {
    this.#assertOwned(id, ownerPrincipalId);
    const current = this.#getOrThrow(id);
    if (current.deletedAt !== null) {
      throw new AppError('INVALID_INPUT', '备忘在「最近删除」里，请先恢复再移动');
    }
    if (groupId !== null && this.#groupVisibleTo(groupId, ownerPrincipalId) === false) {
      throw new AppError('NOT_FOUND', `备忘分组 ${groupId} 不存在`);
    }
    let moved: { memo: StoredMemo; changed: boolean } | null;
    try {
      moved = this.#deps.store.move(id, groupId, beforeId);
    } catch (error) {
      // placeItem 校验锚点（missing / self）；换成人能看懂的输入错误。
      throw new AppError('INVALID_INPUT', '备忘拖拽位置无效', { reason: String(error) });
    }
    if (moved === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    if (moved.changed) this.#changed(id, moved.memo.ownerPrincipalId);
    return moved.memo;
  }

  createGroup(title: string, ownerPrincipalId?: string | null): MemoGroup {
    const group = this.#deps.store.insertGroup(
      cleanGroupTitle(title),
      ownerPrincipalId != null ? ownerPrincipalId : null,
    );
    this.#changed(undefined, group.ownerPrincipalId);
    return group;
  }

  renameGroup(id: string, title: string, ownerPrincipalId?: string | null): MemoGroup {
    this.#assertGroupOwned(id, ownerPrincipalId);
    if (this.#deps.store.getGroup(id) === null) {
      throw new AppError('NOT_FOUND', `备忘分组 ${id} 不存在`);
    }
    const group = this.#deps.store.renameGroup(id, cleanGroupTitle(title));
    if (group === null) throw new AppError('NOT_FOUND', `备忘分组 ${id} 不存在`);
    this.#changed(undefined, group.ownerPrincipalId);
    return group;
  }

  /** Drag-reorder groups (`beforeId` null = end); a drop at the current slot publishes nothing. */
  moveGroup(id: string, beforeId: string | null, ownerPrincipalId?: string | null): MemoGroup {
    this.#assertGroupOwned(id, ownerPrincipalId);
    let moved: { group: StoredMemoGroup; changed: boolean } | null;
    try {
      moved = this.#deps.store.moveGroup(id, beforeId);
    } catch (error) {
      // placeItem 校验锚点（missing / self）；换成人能看懂的输入错误。
      throw new AppError('INVALID_INPUT', '分组拖拽位置无效', { reason: String(error) });
    }
    if (moved === null) throw new AppError('NOT_FOUND', `备忘分组 ${id} 不存在`);
    if (moved.changed) this.#changed(undefined, moved.group.ownerPrincipalId);
    return moved.group;
  }

  /** Deletes the group; its memos go back to 未分组 (memos themselves are untouched). */
  deleteGroup(id: string, ownerPrincipalId?: string | null): void {
    this.#assertGroupOwned(id, ownerPrincipalId);
    const owner = this.#deps.store.getGroup(id)?.ownerPrincipalId ?? null;
    if (!this.#deps.store.deleteGroup(id)) {
      throw new AppError('NOT_FOUND', `备忘分组 ${id} 不存在`);
    }
    this.#changed(undefined, owner);
  }

  /** Moves a memo to 最近删除 (idempotent: an already trashed memo is returned as is). */
  delete(id: string, ownerPrincipalId?: string | null): Memo {
    this.#assertOwned(id, ownerPrincipalId);
    const current = this.#getOrThrow(id);
    if (current.deletedAt !== null) return current;
    const memo = this.#deps.store.softDelete(id);
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id, memo.ownerPrincipalId);
    return memo;
  }

  /** Back from 最近删除 (idempotent: a live memo is returned as is). */
  restore(id: string, ownerPrincipalId?: string | null): Memo {
    this.#assertOwned(id, ownerPrincipalId);
    const current = this.#getOrThrow(id);
    if (current.deletedAt === null) return current;
    const memo = this.#deps.store.restore(id);
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id, memo.ownerPrincipalId);
    return memo;
  }

  /** Startup: removes memos trashed longer than the retention window ago; returns how many. */
  purgeExpired(): number {
    const purged = this.#deps.store.purgeTrashed(this.#deps.clock.now() - MEMO_TRASH_RETENTION_MS);
    if (purged > 0) this.#deps.logger.info({ purged }, 'expired trashed memos purged');
    return purged;
  }

  #getOrThrow(id: string): Memo {
    const memo = this.#deps.store.get(id);
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    return memo;
  }

  /**
   * 62.11 C13：按 id 写操作的归属校验（传入且不符 → NOT_FOUND，不泄露存在性）；
   * 不传 / null = 现状零校验。
   */
  #assertOwned(id: string, ownerPrincipalId?: string | null): void {
    if (ownerPrincipalId == null || ownerPrincipalId.length === 0) return;
    const row = this.#deps.store.get(id);
    if (row === null || row.ownerPrincipalId !== ownerPrincipalId) {
      throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    }
  }

  /** 分组的归属校验（同 {@link #assertOwned} 的口径）。 */
  #assertGroupOwned(id: string, ownerPrincipalId?: string | null): void {
    if (ownerPrincipalId == null || ownerPrincipalId.length === 0) return;
    const row = this.#deps.store.getGroup(id);
    if (row === null || row.ownerPrincipalId !== ownerPrincipalId) {
      throw new AppError('NOT_FOUND', `备忘分组 ${id} 不存在`);
    }
  }

  /**
   * 归属主体 P 能否使用分组 `groupId`：无校验主体（单用户路径）= 只看存在性；
   * 有主体 = 分组必须存在且归属 P（别人的组对 P 不存在，NOT_FOUND 口径）。
   */
  #groupVisibleTo(groupId: string, ownerPrincipalId?: string | null): boolean {
    const group = this.#deps.store.getGroup(groupId);
    if (group === null) return false;
    if (ownerPrincipalId == null || ownerPrincipalId.length === 0) return true;
    return group.ownerPrincipalId === ownerPrincipalId;
  }

  /** 62.11 C13：有归属才带 ownerPrincipalId；无归属 = 单用户现状载荷不变。 */
  #changed(memoId?: string, ownerPrincipalId?: string | null): void {
    this.#deps.publish?.(
      'memos.changed',
      memoId === undefined
        ? (ownerPrincipalId != null ? { ownerPrincipalId } : {})
        : {
            memoId,
            ...(ownerPrincipalId != null ? { ownerPrincipalId } : {}),
          },
    );
  }
}

function cleanBody(body: string): string {
  const cleaned = body.trim();
  if (cleaned.length === 0) throw new AppError('INVALID_INPUT', '备忘内容不能为空');
  if (cleaned.length > MEMO_BODY_MAX_CHARS) {
    throw new AppError('INVALID_INPUT', `备忘最多 ${MEMO_BODY_MAX_CHARS} 字`);
  }
  return cleaned;
}

function cleanGroupTitle(title: string): string {
  const cleaned = title.trim();
  if (cleaned.length === 0) throw new AppError('INVALID_INPUT', '分组名称不能为空');
  if (cleaned.includes('\0')) throw new AppError('INVALID_INPUT', '分组名称不能包含空字符');
  if (cleaned.length > MEMO_GROUP_TITLE_MAX_CHARS) {
    throw new AppError('INVALID_INPUT', `分组名称最多 ${MEMO_GROUP_TITLE_MAX_CHARS} 字`);
  }
  return cleaned;
}

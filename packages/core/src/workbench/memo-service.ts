import {
  AppError,
  MEMO_BODY_MAX_CHARS,
  MEMO_TRASH_RETENTION_MS,
  type Memo,
  type TodoSource,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ListMemosFilter, MemoStore } from './memo-store.js';

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
 */
export class MemoService {
  readonly #deps: MemoServiceDeps;

  constructor(deps: MemoServiceDeps) {
    this.#deps = deps;
  }

  list(filter: ListMemosFilter = {}): Memo[] {
    return this.#deps.store.list(filter);
  }

  get(id: string): Memo {
    return this.#getOrThrow(id);
  }

  create(input: { body: string; source?: TodoSource | undefined }): Memo {
    const memo = this.#deps.store.insert({ body: cleanBody(input.body), source: input.source ?? 'user' });
    this.#changed(memo.id);
    return memo;
  }

  update(id: string, patch: { body?: string | undefined; pinned?: boolean | undefined }): Memo {
    const current = this.#getOrThrow(id);
    if (current.deletedAt !== null) {
      throw new AppError('INVALID_INPUT', '备忘在「最近删除」里，请先恢复再修改');
    }
    const memo = this.#deps.store.update(id, {
      ...(patch.body !== undefined ? { body: cleanBody(patch.body) } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    });
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id);
    return memo;
  }

  /** Moves a memo to 最近删除 (idempotent: an already trashed memo is returned as is). */
  delete(id: string): Memo {
    const current = this.#getOrThrow(id);
    if (current.deletedAt !== null) return current;
    const memo = this.#deps.store.softDelete(id);
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id);
    return memo;
  }

  /** Back from 最近删除 (idempotent: a live memo is returned as is). */
  restore(id: string): Memo {
    const current = this.#getOrThrow(id);
    if (current.deletedAt === null) return current;
    const memo = this.#deps.store.restore(id);
    if (memo === null) throw new AppError('NOT_FOUND', `备忘 ${id} 不存在`);
    this.#changed(id);
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

  #changed(memoId: string): void {
    this.#deps.publish?.('memos.changed', { memoId });
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

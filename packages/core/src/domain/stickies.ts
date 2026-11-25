import { AppError, newId, type Stickie } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface StickieRow {
  id: string;
  conversation_id: string;
  scope: string;
  text: string;
  pos_x: number | null;
  pos_y: number | null;
  z: number;
  created_at: number;
  updated_at: number;
  owner_principal_id: string | null;
}

/**
 * A stickie row plus the ownership column that stays out of the shared RPC
 * shape (62.11 C13). The column only means anything on `scope='global'` rows:
 * conversation-scoped stickies follow their conversation's visibility, so they
 * carry NULL and are neither filtered nor ownership-checked.
 */
export interface StoredStickie extends Stickie {
  ownerPrincipalId?: string | null;
}

function rowToStickie(row: StickieRow): StoredStickie {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    scope: row.scope as Stickie['scope'],
    text: row.text,
    position: row.pos_x !== null && row.pos_y !== null ? { x: row.pos_x, y: row.pos_y } : null,
    z: row.z,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.owner_principal_id !== null ? { ownerPrincipalId: row.owner_principal_id } : {}),
  };
}

/**
 * 辅助阅读便签（docs/dev/03-data-model.md「stickies」）：渲染层乐观更新
 * 即时上屏，行经本服务落 main.db；删除对话时随 conversations 行 FK 级联
 * 删除，无需额外生命周期钩子。
 *
 * 62.11 C13：`scope='global'` 的便签带归属（创建落调用者、列表按调用者过滤、
 * 按 id 写操作校验归属）；会话作用域便签随会话可见性，不加归属过滤。缺省
 * （无主体参数）= 单用户现状。
 */
export class StickiesService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  /**
   * 传入主体时：全局便签只返回该主体拥有的行；会话作用域行照旧全量返回
   * （它们随各自会话的可见性走）。缺省 = 不过滤（单用户现状）。
   */
  list(ownerPrincipalId?: string): StoredStickie[] {
    const rows =
      ownerPrincipalId === undefined
        ? (this.db.prepare('select * from stickies order by z').all() as StickieRow[])
        : (this.db
            .prepare(
              "select * from stickies where scope != 'global' or owner_principal_id = ? order by z",
            )
            .all(ownerPrincipalId) as StickieRow[]);
    return rows.map(rowToStickie);
  }

  create(input: {
    /** 渲染层乐观上屏时已生成的 id；缺省时由 core 生成（后续 update/delete 按它定位）。 */
    id?: string;
    text: string;
    scope: Stickie['scope'];
    position: Stickie['position'];
    z: number;
    conversationId: string;
    /**
     * 62.11 C13：归属主体（调用者）。只对 `scope='global'` 生效（会话作用域
     * 便签随会话可见性，不落归属）；缺省 / null = 单用户现状（NULL 行）。
     */
    ownerPrincipalId?: string | null | undefined;
  }): StoredStickie {
    const now = this.clock.now();
    const id = input.id ?? newId('stc');
    this.db
      .prepare(
        'insert into stickies (id, conversation_id, scope, text, pos_x, pos_y, z, created_at, updated_at, owner_principal_id) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.conversationId,
        input.scope,
        input.text,
        input.position?.x ?? null,
        input.position?.y ?? null,
        input.z,
        now,
        now,
        input.scope === 'global' ? (input.ownerPrincipalId ?? null) : null,
      );
    return this.getOrThrow(id);
  }

  update(
    id: string,
    patch: { position?: Stickie['position']; scope?: Stickie['scope']; z?: number },
    ownerPrincipalId?: string | null,
  ): StoredStickie {
    const current = this.getOrThrow(id);
    this.#assertOwned(current, id, ownerPrincipalId);
    const position = patch.position !== undefined ? patch.position : current.position;
    const scope = patch.scope ?? current.scope;
    const z = patch.z ?? current.z;
    this.db
      .prepare(
        'update stickies set pos_x = ?, pos_y = ?, scope = ?, z = ?, updated_at = ? where id = ?',
      )
      .run(position?.x ?? null, position?.y ?? null, scope, z, this.clock.now(), id);
    return this.getOrThrow(id);
  }

  /** Delete keeps its historical silent no-op on a missing row. */
  remove(id: string, ownerPrincipalId?: string | null): void {
    const current = this.#get(id);
    if (current === null) return;
    this.#assertOwned(current, id, ownerPrincipalId);
    this.db.prepare('delete from stickies where id = ?').run(id);
  }

  /**
   * 62.11 C13：全局便签的归属校验（传入且不符 → NOT_FOUND，不泄露存在性）。
   * 会话作用域便签不校验（随会话可见性）；不传 / null = 现状零校验。
   */
  #assertOwned(stickie: StoredStickie, id: string, ownerPrincipalId?: string | null): void {
    if (ownerPrincipalId == null || ownerPrincipalId.length === 0) return;
    if (stickie.scope !== 'global') return;
    if (stickie.ownerPrincipalId !== ownerPrincipalId) {
      throw new AppError('NOT_FOUND', '该便签不存在或已被删除');
    }
  }

  getOrThrow(id: string): StoredStickie {
    const row = this.#get(id);
    if (row === null) {
      throw new AppError('NOT_FOUND', '该便签不存在或已被删除');
    }
    return row;
  }

  #get(id: string): StoredStickie | null {
    const row = this.db.prepare('select * from stickies where id = ?').get(id) as
      | StickieRow
      | undefined;
    return row === undefined ? null : rowToStickie(row);
  }
}

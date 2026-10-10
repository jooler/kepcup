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
}

function rowToStickie(row: StickieRow): Stickie {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    scope: row.scope as Stickie['scope'],
    text: row.text,
    position: row.pos_x !== null && row.pos_y !== null ? { x: row.pos_x, y: row.pos_y } : null,
    z: row.z,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 辅助阅读便签（docs/dev/03-data-model.md「stickies」）：渲染层乐观更新
 * 即时上屏，行经本服务落 main.db；删除对话时随 conversations 行 FK 级联
 * 删除，无需额外生命周期钩子。
 */
export class StickiesService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  list(): Stickie[] {
    const rows = this.db.prepare('select * from stickies order by z').all() as StickieRow[];
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
  }): Stickie {
    const now = this.clock.now();
    const id = input.id ?? newId('stc');
    this.db
      .prepare(
        'insert into stickies (id, conversation_id, scope, text, pos_x, pos_y, z, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      );
    return this.getOrThrow(id);
  }

  update(
    id: string,
    patch: { position?: Stickie['position']; scope?: Stickie['scope']; z?: number },
  ): Stickie {
    const current = this.getOrThrow(id);
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

  remove(id: string): void {
    this.db.prepare('delete from stickies where id = ?').run(id);
  }

  getOrThrow(id: string): Stickie {
    const row = this.db.prepare('select * from stickies where id = ?').get(id) as
      StickieRow | undefined;
    if (row === undefined) {
      throw new AppError('NOT_FOUND', '该便签不存在或已被删除');
    }
    return rowToStickie(row);
  }
}

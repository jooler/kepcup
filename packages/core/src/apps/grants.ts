import { newId } from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import { assertGrantAllowedForTier } from './tier.js';

/**
 * 应用工具的持续授权（D73 P1，design 29 §8.1 / 执行方案 §5.3、§5.6）：写工具的「本对话内
 * 一直允许」与「对该 Bot 总是允许」。键为 **(Bot, 连接, 工具)**，不跨 Bot 共享；
 * `conversationId` 为 null = 对该 Bot 总是允许，否则只在该对话内有效。现有 `grants`
 * 表按路径设计，不复用。
 *
 * 撤销 = 写 `revoked_at`（保留行作审计）。清理：
 * - Bot 删除 → {@link AppToolGrants.revokeForBot}（`LifecycleService.deleteBot`）；
 * - Bot 被移出群 → {@link AppToolGrants.revokeForBotInConversation}（`removeGroupMember`）；
 * - 对话删除 / 连接删除 → 外键 `ON DELETE CASCADE`。
 */

export interface AppToolGrant {
  id: string;
  botId: string;
  connectionId: string;
  toolName: string;
  /** null = 对该 Bot 总是允许。 */
  conversationId: string | null;
  approvalId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface AppToolGrantKey {
  botId: string;
  connectionId: string;
  toolName: string;
}

export interface NewAppToolGrant extends AppToolGrantKey {
  /** 缺省 / null = 对该 Bot 总是允许。 */
  conversationId?: string | null;
  approvalId?: string | null;
  /** 连接的信任分级（D73 P3 §7.2）：受限分级（`community`）拒绝创建 Bot 级授权。缺省 = 不核对。 */
  connectionTier?: string | undefined;
}

interface GrantRow {
  id: string;
  bot_id: string;
  connection_id: string;
  tool_name: string;
  conversation_id: string | null;
  approval_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

function toGrant(row: GrantRow): AppToolGrant {
  return {
    id: row.id,
    botId: row.bot_id,
    connectionId: row.connection_id,
    toolName: row.tool_name,
    conversationId: row.conversation_id,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class AppToolGrants {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /** 创建授权；同一 (Bot, 连接, 工具, 范围) 已有未撤销的授权则直接返回它（幂等）。 */
  create(input: NewAppToolGrant): AppToolGrant {
    const conversationId = input.conversationId ?? null;
    // 网关总会带分级；直接调用（测试 / 管理路径）不带 = 不核对。
    if (input.connectionTier !== undefined) {
      assertGrantAllowedForTier({ tier: input.connectionTier, conversationId });
    }
    const existing = this.#db
      .prepare(
        `select * from app_tool_grants
          where bot_id = ? and connection_id = ? and tool_name = ? and conversation_id is ?
            and revoked_at is null`,
      )
      .get(input.botId, input.connectionId, input.toolName, conversationId) as GrantRow | undefined;
    if (existing !== undefined) return toGrant(existing);
    const id = newId('atg');
    this.#db
      .prepare(
        `insert into app_tool_grants
           (id, bot_id, connection_id, tool_name, conversation_id, approval_id, created_at, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, null)`,
      )
      .run(
        id,
        input.botId,
        input.connectionId,
        input.toolName,
        conversationId,
        input.approvalId ?? null,
        this.#clock.now(),
      );
    return this.getRequired(id);
  }

  get(id: string): AppToolGrant | null {
    const row = this.#db.prepare('select * from app_tool_grants where id = ?').get(id) as
      GrantRow | undefined;
    return row ? toGrant(row) : null;
  }

  getRequired(id: string): AppToolGrant {
    const grant = this.get(id);
    if (grant === null) throw new Error(`app tool grant ${id} not found`);
    return grant;
  }

  /**
   * 命中的有效授权：该 Bot 对该连接该工具的、对本对话有效（对话级且 conversation 相同，或 Bot
   * 级）且未撤销的授权；两种都有时返回 Bot 级。`conversationId` 为 null（没有对话上下文）只
   * 匹配 Bot 级。
   */
  find(
    input: AppToolGrantKey & {
      conversationId: string | null;
      /** 忽略 Bot 级授权（受限分级的连接：此前留下的 Bot 级授权不再生效，D73 P3 §7.2）。 */
      excludeBotLevel?: boolean | undefined;
    },
  ): AppToolGrant | null {
    const row = this.#db
      .prepare(
        `select * from app_tool_grants
          where bot_id = ? and connection_id = ? and tool_name = ? and revoked_at is null
            and ((conversation_id is null and ? = 0) or conversation_id = ?)
          order by conversation_id is null desc, created_at, id
          limit 1`,
      )
      .get(
        input.botId,
        input.connectionId,
        input.toolName,
        input.excludeBotLevel === true ? 1 : 0,
        input.conversationId,
      ) as GrantRow | undefined;
    return row ? toGrant(row) : null;
  }

  list(
    filter: { connectionId?: string; botId?: string; includeRevoked?: boolean } = {},
  ): AppToolGrant[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.connectionId !== undefined) {
      where.push('connection_id = ?');
      values.push(filter.connectionId);
    }
    if (filter.botId !== undefined) {
      where.push('bot_id = ?');
      values.push(filter.botId);
    }
    if (filter.includeRevoked !== true) where.push('revoked_at is null');
    const rows = this.#db
      .prepare(
        `select * from app_tool_grants ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
          order by created_at, id`,
      )
      .all(...values) as GrantRow[];
    return rows.map(toGrant);
  }

  /** 撤销一条授权；已撤销 / 不存在返回 false。 */
  revoke(id: string): boolean {
    return (
      this.#db
        .prepare('update app_tool_grants set revoked_at = ? where id = ? and revoked_at is null')
        .run(this.#clock.now(), id).changes > 0
    );
  }

  /** Bot 删除：撤销它的全部授权（返回撤销条数）。 */
  revokeForBot(botId: string): number {
    return this.#db
      .prepare('update app_tool_grants set revoked_at = ? where bot_id = ? and revoked_at is null')
      .run(this.#clock.now(), botId).changes;
  }

  /** Bot 被移出群：撤销它在该对话的授权（Bot 级授权不受影响）。 */
  revokeForBotInConversation(botId: string, conversationId: string): number {
    return this.#db
      .prepare(
        `update app_tool_grants set revoked_at = ?
          where bot_id = ? and conversation_id = ? and revoked_at is null`,
      )
      .run(this.#clock.now(), botId, conversationId).changes;
  }

  /** 某工具的全部授权（例如工具被停用 / 重新复核时收回）。 */
  revokeForTool(connectionId: string, toolName: string): number {
    return this.#db
      .prepare(
        `update app_tool_grants set revoked_at = ?
          where connection_id = ? and tool_name = ? and revoked_at is null`,
      )
      .run(this.#clock.now(), connectionId, toolName).changes;
  }
}

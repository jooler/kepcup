import { AppError, APP_TAINT_TTL_MS, type EgressChannel } from '@kepcup/shared';
import type { ToolResult } from '../agent/types.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { SettingsService } from '../domain/settings.js';

/**
 * 污点外发控制的状态（D73 P2，design 29 §8.3 / §12）。
 *
 * Bot 在某对话里**成功读取过连接应用（目录连接）的数据**后，该 (Bot, 对话) 进入污点状态，
 * 持续 {@link APP_TAINT_TTL_MS}（24 小时），每次成功读取续期。按 (Bot, 对话) 计而不按 run
 * 计：`runs.retry` 的新 run、该对话后续的对话轮与任务（D75）自然共用同一行，无法绕过。
 *
 * 来源只有目录连接的应用工具（`app_*`，`wrapMcpTool` 在成功返回后置位）；自定义 MCP 工具
 * 是**通道**不是来源——它们由用户自己配置，读它们不算「读取过连接应用数据」，但它们的非只读
 * 工具在污点期间是外发通道（网关 `mcpToolCall`）。
 *
 * 状态只在这里读写；是否生效还受 `settings.apps.taintGuard`（默认开）约束——关闭时仍会置位
 * （重新打开后立即生效，且关闭期间的读取不丢），只是 `guard()` 不再报告污点。
 */

/** 污点期间的外发确认写进审计的 action（无人值守自动批准时尤其重要）。 */
export const EGRESS_TAINTED_AUDIT_ACTION = 'egress_tainted';

export interface TaintState {
  /** 本次污点首次置位的时间（毫秒）。 */
  firstAt: number;
  expiresAt: number;
}

interface TaintRow {
  first_at: number;
  expires_at: number;
}

export interface TaintDeps {
  db: SqliteDatabase;
  clock: Clock;
  settings: Pick<SettingsService, 'get'>;
}

export class TaintService {
  readonly #deps: TaintDeps;

  constructor(deps: TaintDeps) {
    this.#deps = deps;
  }

  /**
   * 置位 / 续期：已有未过期的行保留 `first_at` 并顺延 `expires_at`；过期的行当作新的污点
   * 重新开始。顺带清掉所有已过期的行（有索引，便宜）。
   */
  mark(botId: string, conversationId: string): void {
    const now = this.#deps.clock.now();
    this.sweepExpired();
    this.#deps.db
      .prepare(
        `insert into app_taint (bot_id, conversation_id, first_at, expires_at) values (?, ?, ?, ?)
         on conflict(bot_id, conversation_id) do update set
           first_at = case when app_taint.expires_at > ? then app_taint.first_at else excluded.first_at end,
           expires_at = excluded.expires_at`,
      )
      .run(botId, conversationId, now, now + APP_TAINT_TTL_MS, now);
  }

  /** 该 (Bot, 对话) 此刻是否处于未过期的污点状态（不看开关）。 */
  isTainted(botId: string, conversationId: string, now: number = this.#deps.clock.now()): boolean {
    return this.state(botId, conversationId, now) !== null;
  }

  /** 未过期的污点状态；没有 / 已过期 = null（不看开关）。 */
  state(
    botId: string,
    conversationId: string,
    now: number = this.#deps.clock.now(),
  ): TaintState | null {
    const row = this.#deps.db
      .prepare(
        'select first_at, expires_at from app_taint where bot_id = ? and conversation_id = ? and expires_at > ?',
      )
      .get(botId, conversationId, now) as TaintRow | undefined;
    return row === undefined ? null : { firstAt: row.first_at, expiresAt: row.expires_at };
  }

  /**
   * 对话级污点：该对话里**任一** Bot 的行未过期即算（最早的 `first_at`、最晚的 `expires_at`）。
   * 群聊里 Bot B 会读到 Bot A 的输出（上下文、@ 转交），按 (Bot, 对话) 单看会被「洗掉」污点；
   * 私聊只有一个 Bot，两者等价。
   */
  conversationState(
    conversationId: string,
    now: number = this.#deps.clock.now(),
  ): TaintState | null {
    const row = this.#deps.db
      .prepare(
        'select min(first_at) as first_at, max(expires_at) as expires_at from app_taint where conversation_id = ? and expires_at > ?',
      )
      .get(conversationId, now) as { first_at: number | null; expires_at: number | null };
    return row.first_at === null || row.expires_at === null
      ? null
      : { firstAt: row.first_at, expiresAt: row.expires_at };
  }

  /**
   * 外发拦截点的统一入口：开关开着且该对话处于污点状态才返回状态，否则 null。判定按**对话**
   * （见 {@link conversationState}）：群里任一成员读过应用数据，所有成员的外发都要确认。
   */
  guard(botId: string | null, conversationId: string | null): TaintState | null {
    if (botId === null || conversationId === null) return null;
    if (!this.#deps.settings.get().apps.taintGuard) return null;
    return this.conversationState(conversationId);
  }

  /**
   * 污点随跨 Bot 交接传递（委派投递 / 结果贴回）：来源对话此刻有污点 → 目标 (Bot, 对话) 继承它
   * （保留来源的 `first_at`，`expires_at` 取两者较晚者——不因传递而延长）。不看开关。
   */
  inherit(
    from: { botId: string; conversationId: string },
    to: { botId: string; conversationId: string },
  ): boolean {
    const source =
      this.state(from.botId, from.conversationId) ?? this.conversationState(from.conversationId);
    if (source === null) return false;
    this.#deps.db
      .prepare(
        `insert into app_taint (bot_id, conversation_id, first_at, expires_at) values (?, ?, ?, ?)
         on conflict(bot_id, conversation_id) do update set
           first_at = min(app_taint.first_at, excluded.first_at),
           expires_at = max(app_taint.expires_at, excluded.expires_at)`,
      )
      .run(to.botId, to.conversationId, source.firstAt, source.expiresAt);
    return true;
  }

  /** 对话删除：该对话所有 Bot 的行一并删除。 */
  deleteForConversation(conversationId: string): number {
    return this.#deps.db
      .prepare('delete from app_taint where conversation_id = ?')
      .run(conversationId).changes;
  }

  /**
   * Bot 删除：只删它在 `conversationIds`（它自己的私聊）里的行。它在群聊里的行保留到过期——
   * 群里其他成员读到过它的输出，对话级污点不能因它被删而消失。
   */
  deleteForBotInConversations(botId: string, conversationIds: readonly string[]): number {
    let removed = 0;
    for (const conversationId of conversationIds) {
      removed += this.#deps.db
        .prepare('delete from app_taint where bot_id = ? and conversation_id = ?')
        .run(botId, conversationId).changes;
    }
    return removed;
  }

  /** 删除已过期的行，返回删除数。 */
  sweepExpired(now: number = this.#deps.clock.now()): number {
    return this.#deps.db.prepare('delete from app_taint where expires_at <= ?').run(now).changes;
  }
}

/**
 * 外发闸门（`ToolGateway.egressCheck` 绑定了身份后的形态）：没有污点 → 立即返回；有污点 →
 * 等用户确认，拒绝 / 取消 / 对话轮不能等待时抛 `AppError`。工具层只依赖这个函数类型。
 */
export type EgressCheck = (
  input: { channel: EgressChannel; target: string; summary: string },
  options?: { signal?: AbortSignal | undefined },
) => Promise<unknown>;

/** 外发闸门抛出的错误 → 工具失败结果（拒绝要可继续：模型能调整做法）。 */
export function egressFailureResult(error: unknown): ToolResult {
  const code = error instanceof AppError ? error.code : undefined;
  if (code === 'APPROVAL_DENIED') {
    return {
      ok: false,
      content:
        '用户拒绝或取消了这次外发操作（本对话读取过连接应用的数据，外发需要逐次确认）。不要反复重试；调整做法或询问用户。',
      errorCode: 'APPROVAL_DENIED',
      outcome: 'not_started',
    };
  }
  return {
    ok: false,
    content: error instanceof Error ? error.message : String(error),
    errorCode: code ?? 'INTERNAL',
    outcome: 'not_started',
  };
}

import { AppError, MESSAGE_REACTION_EMOJIS, MESSAGE_REACTION_SCOPE_PATTERN } from '@kepcup/shared';
import type { ReactionSummary } from '@kepcup/shared';

import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface ReactionRow {
  message_id: string;
  emoji: string;
  count: number;
  mine: number;
}

/** 长度上限（§6.6）：只防滥用（任意长字符串进 DB），不是内容契约。 */
const SCOPE_MAX = 64;
const ID_MAX = 128;

function assertId(value: string, label: string): void {
  if (value.length < 1 || value.length > ID_MAX) {
    throw new AppError('INVALID_INPUT', `${label} 长度必须在 1–${ID_MAX} 之间`);
  }
}

/**
 * 消息 emoji reaction（AI 内容举报 §5.6 / §6.6）：只存本机 main.db，不进消息
 * 内容、不进 Bot 上下文、不参与团队同步；事件总线也不发 reaction 事件（其他
 * 标签页 / 客户端刷新后才看到）。scope（'local' / 'team:<serverHash>'）隔离
 * 本机与团队会话 id；每条 (scope, message_id, client_id) 最多一个 emoji，再点
 * 同一个即取消（emoji=null）。
 *
 * 不校验消息是否存在（团队消息可能不在本机库）；消息删除 / 撤回不级联清理
 * reaction——本期有意保留（撤回的消息原内容仍可被追诉），需要时再加清理。
 */
export class ReactionsService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(db: SqliteDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * 设置 / 取消当前 client 对一条消息的 reaction（upsert / delete）。emoji 必须
   * 属于 MESSAGE_REACTION_EMOJIS 固定集合（服务端二次校验；RPC schema 已挡一层），
   * null = 取消。
   */
  set(
    scope: string,
    conversationId: string,
    messageId: string,
    clientId: string,
    emoji: string | null,
  ): void {
    this.#assertScope(scope);
    assertId(conversationId, 'conversationId');
    assertId(messageId, 'messageId');
    assertId(clientId, 'clientId');
    if (emoji === null) {
      this.#db
        .prepare('delete from message_reactions where scope = ? and message_id = ? and client_id = ?')
        .run(scope, messageId, clientId);
      return;
    }
    if (!(MESSAGE_REACTION_EMOJIS as readonly string[]).includes(emoji)) {
      throw new AppError('INVALID_INPUT', '不支持的 reaction 表情');
    }
    this.#db
      .prepare(
        `insert into message_reactions (scope, message_id, conversation_id, client_id, emoji, created_at)
         values (?, ?, ?, ?, ?, ?)
         on conflict(scope, message_id, client_id)
         do update set emoji = excluded.emoji, conversation_id = excluded.conversation_id,
                       created_at = excluded.created_at`,
      )
      .run(scope, messageId, conversationId, clientId, emoji, this.#clock.now());
  }

  /**
   * 整个 conversation 的聚合（§6.6）：按 (message_id, emoji) GROUP BY，count +
   * mine（当前 client 是否点过，chip 高亮用）。
   */
  list(scope: string, conversationId: string, clientId: string): ReactionSummary[] {
    this.#assertScope(scope);
    assertId(conversationId, 'conversationId');
    assertId(clientId, 'clientId');
    const rows = this.#db
      .prepare(
        `select message_id, emoji, count(*) as count, max(client_id = ?) as mine
         from message_reactions where scope = ? and conversation_id = ?
         group by message_id, emoji order by message_id asc, emoji asc`,
      )
      .all(clientId, scope, conversationId) as ReactionRow[];
    return rows.map((row) => ({
      messageId: row.message_id,
      emoji: row.emoji,
      count: row.count,
      mine: row.mine === 1,
    }));
  }

  /** scope 形状校验（§5.6：'local' 或 'team:<16 位 hex>'）。 */
  #assertScope(scope: string): void {
    if (scope.length > SCOPE_MAX || !MESSAGE_REACTION_SCOPE_PATTERN.test(scope)) {
      throw new AppError('INVALID_INPUT', 'reaction scope 不合法');
    }
  }
}

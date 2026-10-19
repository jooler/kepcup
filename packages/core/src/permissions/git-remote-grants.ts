import { newId } from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';

/**
 * git 远程操作的持续授权（docs/design/13-permissions.md）：`git_remote` 审批卡上
 * 「本对话内一直允许」与「对该 Bot 总是允许」落库的授权。键为 (Bot, 操作, 远端)，
 * 不跨 Bot 共享；`conversationId` 为 null = 对该 Bot 总是允许，否则只在该对话内有效。
 * 只有 push / pull / fetch 且参数不带选项时才可授权（`gitRemoteGrantTarget` 返回 null =
 * 每次弹卡）。撤销 = 写 revoked_at（保留行作审计）。
 */

export type GitRemoteGrantOperation = 'push' | 'pull' | 'fetch';

export interface GitRemoteGrant {
  id: string;
  botId: string;
  /** null = 对该 Bot 总是允许。 */
  conversationId: string | null;
  operation: GitRemoteGrantOperation;
  remote: string;
  approvalId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

/** 可持续授权的目标：push / pull / fetch + 第一个参数为远端，且其余参数不带任何选项。 */
export function gitRemoteGrantTarget(
  operation: string,
  args: readonly string[],
): { operation: GitRemoteGrantOperation; remote: string } | null {
  if (operation !== 'push' && operation !== 'pull' && operation !== 'fetch') return null;
  const remote = args[0];
  if (remote === undefined || remote.length === 0) return null;
  // 选项语义可变（--force / --delete / -o …）：fail closed，不匹配持续授权。
  if (args.slice(1).some((arg) => arg.startsWith('-'))) return null;
  return { operation, remote };
}

interface GrantRow {
  id: string;
  bot_id: string;
  conversation_id: string | null;
  operation: string;
  remote: string;
  approval_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

function toGrant(row: GrantRow): GitRemoteGrant {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    operation: row.operation as GitRemoteGrantOperation,
    remote: row.remote,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class GitRemoteGrants {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  /** 创建授权；同一 (Bot, 操作, 远端, 范围) 已有未撤销的授权则直接返回它（幂等）。 */
  create(input: {
    botId: string;
    /** 缺省 / null = 对该 Bot 总是允许。 */
    conversationId?: string | null;
    operation: GitRemoteGrantOperation;
    remote: string;
    approvalId?: string | null;
  }): GitRemoteGrant {
    const conversationId = input.conversationId ?? null;
    const existing = this.#db
      .prepare(
        `select * from git_remote_grants
          where bot_id = ? and operation = ? and remote = ? and conversation_id is ?
            and revoked_at is null`,
      )
      .get(input.botId, input.operation, input.remote, conversationId) as GrantRow | undefined;
    if (existing !== undefined) return toGrant(existing);
    const id = newId('grg');
    this.#db
      .prepare(
        `insert into git_remote_grants
           (id, bot_id, conversation_id, operation, remote, approval_id, created_at, revoked_at)
         values (?, ?, ?, ?, ?, ?, ?, null)`,
      )
      .run(
        id,
        input.botId,
        conversationId,
        input.operation,
        input.remote,
        input.approvalId ?? null,
        this.#clock.now(),
      );
    return this.getRequired(id);
  }

  get(id: string): GitRemoteGrant | null {
    const row = this.#db.prepare('select * from git_remote_grants where id = ?').get(id) as
      | GrantRow
      | undefined;
    return row ? toGrant(row) : null;
  }

  getRequired(id: string): GitRemoteGrant {
    const grant = this.get(id);
    if (grant === null) throw new Error(`git remote grant ${id} not found`);
    return grant;
  }

  /**
   * 命中的有效授权：该 Bot 对该操作该远端的、对本对话有效（对话级且 conversation 相同，或
   * Bot 级）且未撤销的授权；两种都有时返回 Bot 级。`conversationId` 为 null（没有对话上下文）
   * 只匹配 Bot 级。
   */
  find(input: {
    botId: string;
    conversationId: string | null;
    operation: GitRemoteGrantOperation;
    remote: string;
  }): GitRemoteGrant | null {
    const row = this.#db
      .prepare(
        `select * from git_remote_grants
          where bot_id = ? and operation = ? and remote = ? and revoked_at is null
            and ((conversation_id is null and ? = 0) or conversation_id = ?)
          order by conversation_id is null desc, created_at, id
          limit 1`,
      )
      .get(
        input.botId,
        input.operation,
        input.remote,
        // Bot 级授权始终参与匹配（没有 excludeBotLevel 的场景）。
        0,
        input.conversationId,
      ) as GrantRow | undefined;
    return row ? toGrant(row) : null;
  }

  /** 撤销一条授权；已撤销 / 不存在返回 false。 */
  revoke(id: string): boolean {
    return (
      this.#db
        .prepare('update git_remote_grants set revoked_at = ? where id = ? and revoked_at is null')
        .run(this.#clock.now(), id).changes > 0
    );
  }

  /** Bot 删除：撤销它的全部授权（返回撤销条数）。 */
  revokeForBot(botId: string): number {
    return this.#db
      .prepare('update git_remote_grants set revoked_at = ? where bot_id = ? and revoked_at is null')
      .run(this.#clock.now(), botId).changes;
  }

  /** Bot 被移出项目组：撤销它在该对话的授权（Bot 级授权不受影响）。 */
  revokeForBotInConversation(botId: string, conversationId: string): number {
    return this.#db
      .prepare(
        `update git_remote_grants set revoked_at = ?
          where bot_id = ? and conversation_id = ? and revoked_at is null`,
      )
      .run(this.#clock.now(), botId, conversationId).changes;
  }
}

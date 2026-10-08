import { GRANT_ABSOLUTE_TTL_MS, newId, type Grant, type GrantAccess } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import { currentToolCall } from './tool-call-scope.js';
import type { Clock } from '../infra/clock.js';
import type { RunIdentity } from '../agent/types.js';

interface GrantRow {
  id: string;
  bot_id: string;
  conversation_id: string;
  path: string;
  access: 'read' | 'write';
  duration: 'once' | 'conversation';
  run_id: string | null;
  approval_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

function rowToGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    path: row.path,
    access: row.access,
    duration: row.duration,
    runId: row.run_id,
    approvalId: row.approval_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Path grants (docs/design/13-permissions.md "授权"). A grant belongs to one
 * bot in one conversation; there is no authorization beyond "conversation":
 * nothing persists.
 *
 * `once`（「仅这一次」，D75 收紧 D37，docs/design/30 §7.3）= 单次工具调用:
 * - only its own run sees it (listEffective);
 * - it is consumed by the tool call that uses it — `noteOnceUse` binds it to
 *   the current tool call and revokes it when that call returns (outside any
 *   tool call the use itself was the single call: revoked on the spot);
 * - an unused one (request_access pre-authorization) and every other `once`
 *   grant also dies after GRANT_ABSOLUTE_TTL_MS, and with its run
 *   (expireForRun) — whichever comes first.
 */
export class GrantsService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  create(input: {
    botId: string;
    conversationId: string;
    path: string;
    access: GrantAccess;
    duration: Grant['duration'];
    runId?: string | null;
    approvalId?: string | null;
  }): Grant {
    const id = newId('grt');
    this.#db
      .prepare(
        'insert into grants (id, bot_id, conversation_id, path, access, duration, run_id, approval_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.botId,
        input.conversationId,
        input.path,
        input.access,
        input.duration,
        input.runId ?? null,
        input.approvalId ?? null,
        this.#clock.now(),
      );
    return this.getOrThrow(id);
  }

  getOrThrow(id: string): Grant {
    const grant = this.get(id);
    if (!grant) throw new Error(`Grant ${id} does not exist`);
    return grant;
  }

  get(id: string): Grant | null {
    const row = this.#db.prepare('select * from grants where id = ?').get(id) as
      | GrantRow
      | undefined;
    return row ? rowToGrant(row) : null;
  }

  /** Active grants of one conversation, newest first (right panel). */
  listActive(conversationId: string): Grant[] {
    this.#expireOverdueOnce();
    const rows = this.#db
      .prepare(
        'select * from grants where conversation_id = ? and revoked_at is null order by created_at desc',
      )
      .all(conversationId) as GrantRow[];
    return rows.map(rowToGrant);
  }

  /**
   * Distinct paths of every active grant across conversations (P12: the WSL
   * mount registration source — only these may ever be mounted into the
   * sandbox VM).
   */
  listActivePaths(): string[] {
    this.#expireOverdueOnce();
    const rows = this.#db
      .prepare('select distinct path from grants where revoked_at is null')
      .all() as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /**
   * Active grants that apply to this identity: same bot + conversation, and
   * `once` grants only while their own run is executing. The single predicate
   * for both the file-path check and the sandbox policy (BR-P03-003).
   */
  listEffective(identity: RunIdentity): Grant[] {
    if (identity.botId === null || identity.conversationId === null) return [];
    return this.listActive(identity.conversationId).filter(
      (g) => g.botId === identity.botId && (g.duration === 'conversation' || g.runId === identity.runId),
    );
  }

  /**
   * True when one of the bot's active grants in the conversation covers
   * `resolvedPath` (grant path is the target's ancestor or the target itself)
   * with enough access. Write grants satisfy reads; read grants never
   * satisfy writes.
   */
  hasEffectiveGrant(
    identity: RunIdentity,
    resolvedPath: string,
    mode: 'read' | 'write',
    matches: (grantPath: string, candidate: string) => boolean,
  ): Grant | null {
    // Longest covering path wins so nested grants report precisely.
    const covering = this.listEffective(identity)
      .filter((g) => matches(g.path, resolvedPath))
      .sort((a, b) => b.path.length - a.path.length);
    if (mode === 'read') return covering[0] ?? null;
    return covering.find((g) => g.access === 'write') ?? null;
  }

  /**
   * D75「仅这一次」= 单次工具调用: the once grant is being used right now.
   * Inside a tool call it stays usable for the rest of that call and is
   * revoked when the call returns; outside any tool call (or after the call
   * already returned) it is revoked immediately. No-op for conversation
   * grants and already revoked ones.
   */
  noteOnceUse(grant: Grant): void {
    if (grant.duration !== 'once' || grant.revokedAt !== null) return;
    const scope = currentToolCall();
    if (scope === undefined || scope.ended) {
      this.revoke(grant.id);
      return;
    }
    scope.onEnd.set(`grant:${grant.id}`, () => {
      this.revoke(grant.id);
    });
  }

  revoke(id: string): Grant | null {
    const grant = this.get(id);
    if (!grant || grant.revokedAt !== null) return grant;
    this.#db
      .prepare('update grants set revoked_at = ? where id = ?')
      .run(this.#clock.now(), id);
    return this.get(id);
  }

  /**
   * Absolute TTL backstop of `once` grants (GRANT_ABSOLUTE_TTL_MS): lazily
   * revoked (revoked_at = the moment they expired) before every listing, so
   * the right panel, the sandbox mounts and the effective set agree.
   */
  #expireOverdueOnce(): void {
    this.#db
      .prepare(
        "update grants set revoked_at = created_at + ? where duration = 'once' and revoked_at is null and created_at + ? <= ?",
      )
      .run(GRANT_ABSOLUTE_TTL_MS, GRANT_ABSOLUTE_TTL_MS, this.#clock.now());
  }

  /** `once` grants (still unused ones included) expire when their run ends. */
  expireForRun(runId: string): number {
    const result = this.#db
      .prepare("update grants set revoked_at = ? where run_id = ? and revoked_at is null and duration = 'once'")
      .run(this.#clock.now(), runId);
    return result.changes;
  }

  revokeForConversation(conversationId: string): void {
    this.#db
      .prepare('update grants set revoked_at = ? where conversation_id = ? and revoked_at is null')
      .run(this.#clock.now(), conversationId);
  }

  revokeForBot(botId: string): void {
    this.#db
      .prepare('update grants set revoked_at = ? where bot_id = ? and revoked_at is null')
      .run(this.#clock.now(), botId);
  }

  /** Bot removed from one conversation (P05 group cascade): revoke that pair only. */
  revokeForBotInConversation(botId: string, conversationId: string): number {
    const result = this.#db
      .prepare(
        'update grants set revoked_at = ? where bot_id = ? and conversation_id = ? and revoked_at is null',
      )
      .run(this.#clock.now(), botId, conversationId);
    return result.changes;
  }

  deleteForConversation(conversationId: string): void {
    this.#db.prepare('delete from grants where conversation_id = ?').run(conversationId);
  }

  deleteForBot(botId: string): void {
    this.#db.prepare('delete from grants where bot_id = ?').run(botId);
  }
}

import { GRANT_ABSOLUTE_TTL_MS, newId, type Grant, type GrantAccess } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import { currentToolCall, type ToolCallScope } from './tool-call-scope.js';
import type { Clock } from '../infra/clock.js';
import type { RunIdentity } from '../agent/types.js';
import type { PermissionRevocations } from './revocations.js';

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
 * - only its own run sees it (listEffective), and inside that run only the
 *   tool call that owns it: the call it was approved in, or — for a
 *   request_access pre-authorization — the first call that uses it (claims
 *   it). Parallel tool calls of the same run never share a once grant;
 * - it is consumed by the owning call — `noteOnceUse` binds it to the current
 *   tool call and revokes it when that call returns (outside any tool call the
 *   use itself was the single call: revoked on the spot);
 * - an unused one (request_access pre-authorization) and every other `once`
 *   grant also dies after GRANT_ABSOLUTE_TTL_MS, and with its run
 *   (expireForRun) — whichever comes first.
 *
 * Revocations the service makes on its own (consumed, TTL, run end) are
 * reported through `onAutoRevoke` (coalesced per conversation) so the right
 * panel can refresh; user revocations publish at the RPC layer.
 */
export class GrantsService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;
  /** Owning tool call of each claimed once grant (in memory; cleared on revoke). */
  readonly #onceOwners = new Map<string, ToolCallScope>();
  readonly #autoRevokeListeners = new Set<(conversationId: string) => void>();
  /** Conversations with an auto revocation not yet reported (flushed in a microtask). */
  readonly #pendingAutoRevoke = new Set<string>();

  /** W3: user revocations are announced here (TaskHost interrupts running tasks). */
  readonly #revocations: PermissionRevocations | null;

  constructor(deps: { db: SqliteDatabase; clock: Clock; revocations?: PermissionRevocations }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#revocations = deps.revocations ?? null;
  }

  /**
   * Subscribes to revocations the service makes on its own (once grants
   * consumed by their tool call, TTL expiry, run end). Bursts are coalesced:
   * one call per conversation per microtask. Returns the unsubscribe.
   */
  onAutoRevoke(listener: (conversationId: string) => void): () => void {
    this.#autoRevokeListeners.add(listener);
    return () => {
      this.#autoRevokeListeners.delete(listener);
    };
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
    if (input.duration === 'once') {
      // Push the TTL expiry to listeners even when nothing lists grants then
      // (listings expire lazily too). Best effort: the core may be closed.
      setTimeout(() => {
        try {
          this.#expireOverdueOnce();
        } catch {
          // database closed (core shut down) — nothing left to refresh
        }
      }, GRANT_ABSOLUTE_TTL_MS + 1_000).unref?.();
    }
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
   * `once` grants only while their own run is executing — and, within the
   * run, only in the tool call that owns them (or any call while unclaimed:
   * the first one to use it claims it via noteOnceUse). The single predicate
   * for both the file-path check and the sandbox policy (BR-P03-003).
   */
  listEffective(identity: RunIdentity): Grant[] {
    if (identity.botId === null || identity.conversationId === null) return [];
    const scope = currentToolCall();
    return this.listActive(identity.conversationId).filter(
      (g) =>
        g.botId === identity.botId &&
        (g.duration === 'conversation' ||
          (g.runId === identity.runId && this.#onceUsableIn(g.id, scope))),
    );
  }

  /** An unclaimed once grant is usable by any call; a claimed one only by its owner. */
  #onceUsableIn(grantId: string, scope: ToolCallScope | undefined): boolean {
    const owner = this.#onceOwners.get(grantId);
    return owner === undefined || owner === scope;
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
   * D75「仅这一次」= 单次工具调用: the once grant is being used right now by
   * the current tool call, which becomes its owner (claiming an unclaimed
   * request_access pre-authorization). It stays usable for the rest of that
   * call — and only there — and is revoked when the call returns; outside any
   * tool call (or after the call already returned) it is revoked immediately.
   * No-op for conversation grants, already revoked ones and once grants owned
   * by another call (listEffective never hands those out).
   */
  noteOnceUse(grant: Grant): void {
    if (grant.duration !== 'once' || grant.revokedAt !== null) return;
    const scope = currentToolCall();
    const owner = this.#onceOwners.get(grant.id);
    if (owner !== undefined && owner !== scope) return;
    if (scope === undefined || scope.ended) {
      this.#autoRevoke(grant.id);
      return;
    }
    if (owner === scope) return;
    this.#onceOwners.set(grant.id, scope);
    scope.onEnd.set(`grant:${grant.id}`, () => {
      this.#autoRevoke(grant.id);
    });
  }

  revoke(id: string): Grant | null {
    this.#onceOwners.delete(id);
    const grant = this.get(id);
    if (!grant || grant.revokedAt !== null) return grant;
    this.#db
      .prepare('update grants set revoked_at = ? where id = ?')
      .run(this.#clock.now(), id);
    return this.get(id);
  }

  /**
   * W3（D78）: the user revoked the grant (grants.revoke) — unlike the
   * service's own revocations (once grants consumed by their call, TTL
   * expiry, run end), this announces `permission.revoked` so the grant's
   * bot's running tasks in that conversation are interrupted. Returns the
   * grant and how many tasks were interrupted (0 when it was not active).
   */
  revokeByUser(id: string): { grant: Grant | null; interruptedTasks: number } {
    const before = this.get(id);
    const grant = this.revoke(id);
    if (before === null || before.revokedAt !== null || grant === null) {
      return { grant, interruptedTasks: 0 };
    }
    const interruptedTasks =
      this.#revocations?.emit({
        scope: 'path',
        conversationId: grant.conversationId,
        botIds: [grant.botId],
        // A once grant belongs to one run: only that run's task is affected.
        ...(grant.duration === 'once' && grant.runId !== null ? { runId: grant.runId } : {}),
      }) ?? 0;
    return { grant, interruptedTasks };
  }

  /** Revocation by the service itself: reported to onAutoRevoke listeners. */
  #autoRevoke(id: string): void {
    const before = this.get(id);
    const after = this.revoke(id);
    if (before !== null && before.revokedAt === null && after !== null) {
      this.#noteAutoRevoked(after.conversationId);
    }
  }

  #noteAutoRevoked(conversationId: string): void {
    if (this.#autoRevokeListeners.size === 0) return;
    const scheduled = this.#pendingAutoRevoke.size > 0;
    this.#pendingAutoRevoke.add(conversationId);
    if (scheduled) return;
    queueMicrotask(() => {
      const conversations = [...this.#pendingAutoRevoke];
      this.#pendingAutoRevoke.clear();
      for (const conversation of conversations) {
        for (const listener of this.#autoRevokeListeners) {
          try {
            listener(conversation);
          } catch {
            // A listener failure must never break a revocation.
          }
        }
      }
    });
  }

  /**
   * Absolute TTL backstop of `once` grants (GRANT_ABSOLUTE_TTL_MS): lazily
   * revoked (revoked_at = the moment they expired) before every listing, so
   * the right panel, the sandbox mounts and the effective set agree.
   */
  #expireOverdueOnce(): void {
    const now = this.#clock.now();
    const overdue = this.#db
      .prepare(
        "select id, conversation_id from grants where duration = 'once' and revoked_at is null and created_at + ? <= ?",
      )
      .all(GRANT_ABSOLUTE_TTL_MS, now) as Array<{ id: string; conversation_id: string }>;
    if (overdue.length === 0) return;
    this.#db
      .prepare(
        "update grants set revoked_at = created_at + ? where duration = 'once' and revoked_at is null and created_at + ? <= ?",
      )
      .run(GRANT_ABSOLUTE_TTL_MS, GRANT_ABSOLUTE_TTL_MS, now);
    for (const row of overdue) {
      this.#onceOwners.delete(row.id);
      this.#noteAutoRevoked(row.conversation_id);
    }
  }

  /** `once` grants (still unused ones included) expire when their run ends. */
  expireForRun(runId: string): number {
    const live = this.#db
      .prepare("select id, conversation_id from grants where run_id = ? and revoked_at is null and duration = 'once'")
      .all(runId) as Array<{ id: string; conversation_id: string }>;
    if (live.length === 0) return 0;
    const result = this.#db
      .prepare("update grants set revoked_at = ? where run_id = ? and revoked_at is null and duration = 'once'")
      .run(this.#clock.now(), runId);
    for (const row of live) {
      this.#onceOwners.delete(row.id);
      this.#noteAutoRevoked(row.conversation_id);
    }
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

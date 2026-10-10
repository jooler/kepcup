import { newId, type AuditEntry } from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { RunIdentity } from '../agent/types.js';

interface AuditRow {
  id: string;
  run_id: string | null;
  bot_id: string | null;
  conversation_id: string | null;
  action: string;
  detail_json: string;
  created_at: number;
}

function rowToEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    runId: row.run_id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    action: row.action,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

/**
 * Append-only audit trail for gateway side effects (exec / fs_write).
 * Detail payloads must already be redacted by the caller.
 */
export class AuditService {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(deps: { db: SqliteDatabase; clock: Clock }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
  }

  record(identity: RunIdentity, action: string, detail: Record<string, unknown>): AuditEntry {
    const id = newId('aud');
    const now = this.#clock.now();
    this.#db
      .prepare(
        'insert into audit_log (id, run_id, bot_id, conversation_id, action, detail_json, created_at) values (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        identity.runId,
        identity.botId,
        identity.conversationId,
        action,
        JSON.stringify(detail),
        now,
      );
    return {
      id,
      runId: identity.runId,
      botId: identity.botId,
      conversationId: identity.conversationId,
      action,
      detail,
      createdAt: now,
    };
  }

  /** Audit entry with no run context (user-initiated, e.g. connected-app connect / disconnect). */
  recordSystem(action: string, detail: Record<string, unknown>): AuditEntry {
    const id = newId('aud');
    const now = this.#clock.now();
    this.#db
      .prepare(
        'insert into audit_log (id, run_id, bot_id, conversation_id, action, detail_json, created_at) values (?, null, null, null, ?, ?, ?)',
      )
      .run(id, action, JSON.stringify(detail), now);
    return { id, runId: null, botId: null, conversationId: null, action, detail, createdAt: now };
  }

  /**
   * D73 P2: the `egress_tainted` audits of one Bot (unattended auto-approvals of outbound actions
   * while tainted by connected-app data) — total count and the most recent entries.
   */
  egressTainted(
    botId: string,
    limit = 10,
  ): { total: number; refused: number; recent: AuditEntry[] } {
    // `total` counts what was let through; `refused` the unattended floor's refusals
    // (`approved: false`, e.g. a tainted command that touches the data directory).
    const counts = this.#db
      .prepare(
        `select
           coalesce(sum(case when json_extract(detail_json, '$.approved') = 0 then 0 else 1 end), 0) as total,
           coalesce(sum(case when json_extract(detail_json, '$.approved') = 0 then 1 else 0 end), 0) as refused
         from audit_log where bot_id = ? and action = 'egress_tainted'`,
      )
      .get(botId) as { total: number; refused: number };
    const rows = this.#db
      .prepare(
        "select * from audit_log where bot_id = ? and action = 'egress_tainted' order by created_at desc limit ?",
      )
      .all(botId, limit) as AuditRow[];
    return { total: counts.total, refused: counts.refused, recent: rows.map(rowToEntry) };
  }

  listByConversation(conversationId: string, limit = 100): AuditEntry[] {
    const rows = this.#db
      .prepare('select * from audit_log where conversation_id = ? order by created_at desc limit ?')
      .all(conversationId, limit) as AuditRow[];
    return rows.map(rowToEntry);
  }
}

import { newId, type EffectReceipt, type EffectStatus, type ToolEffect } from '@kepcup/shared';
import type { SqliteDatabase } from '../../infra/db.js';
import type { Clock } from '../../infra/clock.js';
import { effectKeyOf } from './key.js';

/**
 * runs.db `tool_effects`（migrations/runs/0009_tool_effects.sql）的读写：外部
 * 副作用台账（W2 / D78）。写入都是同步的小语句（better-sqlite3），由
 * EffectRecorder 在工具执行前后各调一次；读取给 W3 检查后重试面板（RPC
 * `effects.list`）与续接摘要。
 */

/** Terminal statuses a call settles into. */
export type SettledEffectStatus = Extract<
  EffectStatus,
  'completed' | 'failed' | 'uncertain' | 'denied'
>;

interface EffectRow {
  id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  effect_key: string;
  args_hash: string;
  summary: string;
  approval_id: string | null;
  status: EffectStatus;
  receipt_json: string | null;
  created_at: number;
  settled_at: number | null;
}

function rowToEffect(row: EffectRow): ToolEffect {
  let receipt: EffectReceipt | null = null;
  if (row.receipt_json !== null) {
    try {
      receipt = JSON.parse(row.receipt_json) as EffectReceipt;
    } catch {
      receipt = null;
    }
  }
  return {
    id: row.id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    effectKey: row.effect_key,
    argsHash: row.args_hash,
    summary: row.summary,
    approvalId: row.approval_id,
    status: row.status,
    receipt,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

/** Bound on the continuation / sub-run walk (a corrupt chain cannot loop forever). */
const CHAIN_MAX_RUNS = 500;

export class ToolEffectsStore {
  readonly #db: SqliteDatabase;
  readonly #clock: Clock;

  constructor(db: SqliteDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /**
   * Writes the `executing` row before an external call runs. The occurrence
   * (and so the effect key) counts earlier rows of the run with the same tool
   * and args hash. A tool-call id already used in the run (providers that
   * reuse ids across turns) gets a `#n` suffix instead of failing the insert.
   */
  open(input: {
    runId: string;
    toolCallId: string;
    toolName: string;
    argsHash: string;
    summary: string;
    approvalId?: string | null;
  }): ToolEffect {
    const insert = this.#db.transaction((): string => {
      const { n } = this.#db
        .prepare(
          'select count(*) as n from tool_effects where run_id = ? and tool_name = ? and args_hash = ?',
        )
        .get(input.runId, input.toolName, input.argsHash) as { n: number };
      const taken = this.#db.prepare(
        'select 1 from tool_effects where run_id = ? and tool_call_id = ?',
      );
      let toolCallId = input.toolCallId;
      for (let suffix = 2; taken.get(input.runId, toolCallId) !== undefined; suffix += 1) {
        toolCallId = `${input.toolCallId}#${suffix}`;
      }
      const id = newId('eff');
      this.#db
        .prepare(
          `insert into tool_effects (id, run_id, tool_call_id, tool_name, effect_key, args_hash, summary, approval_id, status, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'executing', ?)`,
        )
        .run(
          id,
          input.runId,
          toolCallId,
          input.toolName,
          effectKeyOf({
            runId: input.runId,
            toolName: input.toolName,
            argsHash: input.argsHash,
            occurrence: n + 1,
          }),
          input.argsHash,
          input.summary,
          input.approvalId ?? null,
          this.#clock.now(),
        );
      return id;
    });
    return this.getOrThrow(insert.immediate());
  }

  /**
   * Settles a row. Only `executing` rows — and `uncertain` ones a recovery /
   * interruption marked while the call was still running (the real result is
   * better information) — change; anything else is left as is (idempotent).
   */
  settle(
    id: string,
    outcome: {
      status: SettledEffectStatus;
      receipt?: EffectReceipt | null;
      summary?: string;
      approvalId?: string | null;
    },
  ): ToolEffect | null {
    this.#db
      .prepare(
        `update tool_effects
            set status = ?, settled_at = ?,
                receipt_json = coalesce(?, receipt_json),
                summary = coalesce(?, summary),
                approval_id = coalesce(?, approval_id)
          where id = ? and status in ('executing', 'uncertain')`,
      )
      .run(
        outcome.status,
        this.#clock.now(),
        outcome.receipt !== undefined && outcome.receipt !== null
          ? JSON.stringify(outcome.receipt)
          : null,
        outcome.summary ?? null,
        outcome.approvalId ?? null,
        id,
      );
    return this.get(id);
  }

  /**
   * Links the row to an approval created during the call — only while the
   * call is still executing (a settled row's approval never changes).
   */
  noteApproval(id: string, approvalId: string): void {
    this.#db
      .prepare("update tool_effects set approval_id = ? where id = ? and status = 'executing'")
      .run(approvalId, id);
  }

  get(id: string): ToolEffect | null {
    const row = this.#db.prepare('select * from tool_effects where id = ?').get(id) as
      EffectRow | undefined;
    return row !== undefined ? rowToEffect(row) : null;
  }

  getOrThrow(id: string): ToolEffect {
    const effect = this.get(id);
    if (effect === null) throw new Error(`tool effect ${id} not found`);
    return effect;
  }

  /** One run's rows, oldest first. */
  listForRun(runId: string): ToolEffect[] {
    return this.listForRuns([runId]);
  }

  /** Rows of several runs, oldest first. */
  listForRuns(runIds: readonly string[]): ToolEffect[] {
    if (runIds.length === 0) return [];
    const rows: EffectRow[] = [];
    // SQLite caps bound parameters; chains are short, chunk anyway.
    for (let start = 0; start < runIds.length; start += 200) {
      const chunk = runIds.slice(start, start + 200);
      rows.push(
        ...(this.#db
          .prepare(
            `select * from tool_effects where run_id in (${chunk.map(() => '?').join(', ')})`,
          )
          .all(...chunk) as EffectRow[]),
      );
    }
    return rows
      .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
      .map(rowToEffect);
  }

  /**
   * The runs whose effects belong to a task: the task, every run it continues
   * (`continued_from_run_ids_json`, transitively — a retry of a retry) and the
   * SubAgent sub runs (`parent_run_id`) of all of them. Task first, then in
   * discovery order. Unknown task id → [].
   */
  chainRunIds(taskId: string): string[] {
    const exists = this.#db.prepare('select 1 from runs where id = ?').get(taskId);
    if (exists === undefined) return [];
    const seen = new Set<string>([taskId]);
    const queue = [taskId];
    const continued = this.#db.prepare(
      'select continued_from_run_ids_json as ids from runs where id = ?',
    );
    const children = this.#db.prepare('select id from runs where parent_run_id = ?');
    while (queue.length > 0 && seen.size < CHAIN_MAX_RUNS) {
      const current = queue.shift()!;
      const row = continued.get(current) as { ids: string | null } | undefined;
      const previous = parseIds(row?.ids ?? null);
      const subRuns = (children.all(current) as Array<{ id: string }>).map((r) => r.id);
      for (const id of [...previous, ...subRuns]) {
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
      }
    }
    return [...seen];
  }

  /** The task's rows along its continuation chain (see chainRunIds), oldest first. */
  listForTask(taskId: string): ToolEffect[] {
    return this.listForRuns(this.chainRunIds(taskId));
  }

  /**
   * W3 interrupt: `executing` rows whose (latest) approval was just cancelled
   * never got past their approval gate — nothing reached the outside. They
   * settle as `denied` before the remaining executing rows turn `uncertain`
   * (a later settle by the unwinding call leaves them as they are). Returns
   * the rows changed.
   */
  settleUnapproved(runIds: readonly string[], approvalIds: readonly string[]): number {
    if (runIds.length === 0 || approvalIds.length === 0) return 0;
    const now = this.#clock.now();
    let changed = 0;
    for (let start = 0; start < approvalIds.length; start += 200) {
      const chunk = approvalIds.slice(start, start + 200);
      changed += this.#db
        .prepare(
          `update tool_effects set status = 'denied', settled_at = ?
            where status = 'executing'
              and approval_id in (${chunk.map(() => '?').join(', ')})
              and run_id in (${runIds.map(() => '?').join(', ')})`,
        )
        .run(now, ...chunk, ...runIds).changes;
    }
    return changed;
  }

  /**
   * Recovery: `executing` rows → `uncertain` (the process that ran them is
   * gone, or the run was interrupted). Without `runIds`: every executing row
   * (startup — nothing is live yet). Idempotent. Returns the rows changed.
   */
  markExecutingUncertain(runIds?: readonly string[]): number {
    const now = this.#clock.now();
    if (runIds === undefined) {
      return this.#db
        .prepare(
          "update tool_effects set status = 'uncertain', settled_at = ? where status = 'executing'",
        )
        .run(now).changes;
    }
    let changed = 0;
    for (let start = 0; start < runIds.length; start += 200) {
      const chunk = runIds.slice(start, start + 200);
      changed += this.#db
        .prepare(
          `update tool_effects set status = 'uncertain', settled_at = ?
            where status = 'executing' and run_id in (${chunk.map(() => '?').join(', ')})`,
        )
        .run(now, ...chunk).changes;
    }
    return changed;
  }
}

function parseIds(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

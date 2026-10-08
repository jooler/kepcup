import {
  AppError,
  BUILTIN_ENGINE,
  newId,
  runStepSchema,
  type LoopType,
  type Run,
  type RunStatus,
  type RunStep,
  type SetupRequirement,
  type TriggerReason,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';

interface RunRow {
  id: string;
  bot_id: string | null;
  conversation_id: string | null;
  loop_type: LoopType;
  status: RunStatus;
  trigger_reason: TriggerReason | null;
  trigger_message_ids_json: string;
  chain_id: string | null;
  chain_depth: number | null;
  parent_run_id: string | null;
  engine: string;
  agent_session_id: string | null;
  provider: string | null;
  model: string | null;
  output_message_ids_json: string;
  summary: string | null;
  continued_from_run_ids_json: string | null;
  error_json: string | null;
  task_title: string | null;
  task_writes: number | null;
  task_workdir: string | null;
  origin_run_id: string | null;
  result_consumed_at: number | null;
  awaiting_input: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const ACTIVE_STATUSES_SQL = "('queued', 'running', 'waiting_approval', 'waiting_lease')";
const TERMINAL_STATUSES_SQL = "('completed', 'failed', 'cancelled', 'interrupted')";

interface StepRow {
  id: string;
  run_id: string;
  seq: number;
  type: RunStep['type'];
  payload_json: string;
  created_at: number;
}

/** error_json 落盘形态：错误文案 + 结构化的设置前置需求（docs/design/18-inline-setup.md）。 */
interface RunErrorJson {
  message?: string;
  setup?: SetupRequirement;
}

/**
 * error_json 的下一个值：error / setup 任一被补丁触及即整体重写（未触及的
 * 一侧沿用已存值）；两者都未触及且本无错误时保持 null（不无中生有）。
 */
function nextErrorJson(
  patch: { error?: string | null; setup?: SetupRequirement },
  existing: Run,
): string | null {
  if (patch.error === undefined && patch.setup === undefined) {
    return existing.error !== null
      ? JSON.stringify(
          existing.setup !== null
            ? { message: existing.error, setup: existing.setup }
            : { message: existing.error },
        )
      : null;
  }
  const message = (patch.error !== undefined ? patch.error : existing.error) ?? '';
  const setup = patch.setup ?? existing.setup ?? null;
  return JSON.stringify(setup !== null ? { message, setup } : { message });
}

function rowToRun(row: RunRow): Run {
  const error = row.error_json ? (JSON.parse(row.error_json) as RunErrorJson) : null;
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    loopType: row.loop_type,
    status: row.status,
    triggerReason: row.trigger_reason,
    triggerMessageIds: JSON.parse(row.trigger_message_ids_json) as string[],
    chainId: row.chain_id,
    chainDepth: row.chain_depth,
    parentRunId: row.parent_run_id,
    engine: row.engine,
    agentSessionId: row.agent_session_id,
    provider: row.provider,
    model: row.model,
    outputMessageIds: JSON.parse(row.output_message_ids_json) as string[],
    summary: row.summary,
    continuedFromRunIds:
      row.continued_from_run_ids_json !== null
        ? (JSON.parse(row.continued_from_run_ids_json) as string[])
        : [],
    error: error?.message ?? null,
    setup: error?.setup ?? null,
    taskTitle: row.task_title,
    taskWrites: row.task_writes === null ? null : row.task_writes === 1,
    taskWorkdir: row.task_workdir,
    originRunId: row.origin_run_id,
    resultConsumedAt: row.result_consumed_at,
    awaitingInput: row.awaiting_input === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/**
 * One source part of a supervisor turn's trigger batch as stored on its run
 * (`trigger_parts_json`, D75 审查 L3): enough to rebuild the batch on retry.
 */
export interface StoredTriggerPart {
  reason: TriggerReason;
  messageIds: string[];
  extraAttributes?: Record<string, string | number>;
}

/** runs.db persistence: run rows and their (redacted) steps. */
export class RunsService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly clock: Clock,
  ) {}

  create(input: {
    botId: string | null;
    conversationId: string | null;
    loopType: LoopType;
    triggerReason: TriggerReason | null;
    triggerMessageIds: string[];
    chainId?: string | null;
    chainDepth?: number | null;
    /** SubAgent ownership (D66/D67): the delegating parent run, sub runs only. */
    parentRunId?: string | null;
    provider?: string | null;
    model?: string | null;
    /** D72: 'builtin' (default) | 'agent:{id}'. */
    engine?: string;
    /** Task fields (D75 §3.4, loop_type 'task'); a task's submitted state is `queued`. */
    taskTitle?: string | null;
    taskWrites?: boolean | null;
    taskWorkdir?: string | null;
    /** The supervisor turn that started the task. */
    originRunId?: string | null;
    /** Replay sources (`start_task({continues_task_id})`, D56). */
    continuedFromRunIds?: string[];
    /** A turn's trigger parts (D75 审查 L3); omitted = single part. */
    triggerParts?: StoredTriggerPart[];
    /** A retried turn: the failed turn it re-runs (D75 审查 L6). */
    retryOfRunId?: string | null;
  }): Run {
    const id = newId('run');
    const now = this.clock.now();
    this.db
      .prepare(
        'insert into runs (id, bot_id, conversation_id, loop_type, status, trigger_reason, trigger_message_ids_json, chain_id, chain_depth, parent_run_id, provider, model, engine, task_title, task_writes, task_workdir, origin_run_id, continued_from_run_ids_json, trigger_parts_json, retry_of_run_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.botId,
        input.conversationId,
        input.loopType,
        'queued',
        input.triggerReason,
        JSON.stringify(input.triggerMessageIds),
        input.chainId ?? null,
        input.chainDepth ?? null,
        input.parentRunId ?? null,
        input.provider ?? null,
        input.model ?? null,
        input.engine ?? BUILTIN_ENGINE,
        input.taskTitle ?? null,
        input.taskWrites === undefined || input.taskWrites === null
          ? null
          : input.taskWrites
            ? 1
            : 0,
        input.taskWorkdir ?? null,
        input.originRunId ?? null,
        input.continuedFromRunIds !== undefined && input.continuedFromRunIds.length > 0
          ? JSON.stringify(input.continuedFromRunIds)
          : null,
        input.triggerParts !== undefined && input.triggerParts.length > 0
          ? JSON.stringify(input.triggerParts)
          : null,
        input.retryOfRunId ?? null,
        now,
      );
    return this.getOrThrow(id);
  }

  /**
   * A supervisor turn absorbed batches buffered for its mailbox when it began
   * (D75 审查 M1): its trigger becomes the merged batch.
   */
  setTrigger(
    id: string,
    trigger: {
      reason: TriggerReason;
      messageIds: string[];
      parts: StoredTriggerPart[];
      /** An absorbed retry batch (null / omitted = keep the stored one). */
      retryOfRunId?: string | null;
    },
  ): Run {
    this.db
      .prepare(
        'update runs set trigger_reason = ?, trigger_message_ids_json = ?, trigger_parts_json = ?, retry_of_run_id = coalesce(?, retry_of_run_id) where id = ?',
      )
      .run(
        trigger.reason,
        JSON.stringify(trigger.messageIds),
        trigger.parts.length > 0 ? JSON.stringify(trigger.parts) : null,
        trigger.retryOfRunId ?? null,
        id,
      );
    return this.getOrThrow(id);
  }

  /** The stored trigger parts of a turn (null = none stored: a single-part batch). */
  triggerPartsOf(id: string): StoredTriggerPart[] | null {
    const row = this.db.prepare('select trigger_parts_json from runs where id = ?').get(id) as
      | { trigger_parts_json: string | null }
      | undefined;
    if (row?.trigger_parts_json == null) return null;
    try {
      const parsed = JSON.parse(row.trigger_parts_json) as unknown;
      return Array.isArray(parsed) ? (parsed as StoredTriggerPart[]) : null;
    } catch {
      return null;
    }
  }

  /** The turn a retried turn re-runs (null = not a retry). */
  retryOfRunId(id: string): string | null {
    const row = this.db.prepare('select retry_of_run_id from runs where id = ?').get(id) as
      | { retry_of_run_id: string | null }
      | undefined;
    return row?.retry_of_run_id ?? null;
  }

  get(id: string): Run | null {
    const row = this.db.prepare('select * from runs where id = ?').get(id) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getOrThrow(id: string): Run {
    const run = this.get(id);
    if (!run) throw new AppError('RUN_NOT_FOUND', `Run ${id} does not exist`);
    return run;
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Run,
        | 'status'
        | 'provider'
        | 'model'
        | 'summary'
        | 'error'
        | 'outputMessageIds'
        | 'continuedFromRunIds'
        | 'chainId'
        | 'chainDepth'
        | 'engine'
        | 'agentSessionId'
        | 'resultConsumedAt'
        | 'awaitingInput'
      >
    > & {
      /** Structured setup requirement stored inside error_json (inline setup). */
      setup?: SetupRequirement;
    },
  ): Run {
    const existing = this.getOrThrow(id);
    const status = patch.status ?? existing.status;
    const now = this.clock.now();
    this.db
      .prepare(
        "update runs set status = ?, provider = ?, model = ?, engine = ?, agent_session_id = ?, summary = ?, continued_from_run_ids_json = ?, error_json = ?, output_message_ids_json = ?, chain_id = ?, chain_depth = ?, result_consumed_at = ?, awaiting_input = ?, started_at = coalesce(started_at, ?), ended_at = case when ? in ('completed','failed','cancelled','interrupted') then ? else ended_at end where id = ?",
      )
      .run(
        status,
        patch.provider ?? existing.provider,
        patch.model ?? existing.model,
        patch.engine ?? existing.engine,
        patch.agentSessionId ?? existing.agentSessionId,
        patch.summary ?? existing.summary,
        patch.continuedFromRunIds !== undefined
          ? JSON.stringify(patch.continuedFromRunIds)
          : existing.continuedFromRunIds.length > 0
            ? JSON.stringify(existing.continuedFromRunIds)
            : null,
        nextErrorJson(patch, existing),
        JSON.stringify(patch.outputMessageIds ?? existing.outputMessageIds),
        patch.chainId ?? existing.chainId,
        patch.chainDepth ?? existing.chainDepth,
        patch.resultConsumedAt !== undefined ? patch.resultConsumedAt : existing.resultConsumedAt,
        (patch.awaitingInput ?? existing.awaitingInput) ? 1 : 0,
        now,
        status,
        now,
        id,
      );
    return this.getOrThrow(id);
  }

  listByConversation(conversationId: string, limit = 20): Run[] {
    const rows = this.db
      .prepare('select * from runs where conversation_id = ? order by created_at desc limit ?')
      .all(conversationId, limit) as RunRow[];
    return rows.map(rowToRun);
  }

  listActiveByConversation(conversationId: string): Run[] {
    const rows = this.db
      .prepare(
        "select * from runs where conversation_id = ? and status in ('queued', 'running', 'waiting_approval', 'waiting_lease')",
      )
      .all(conversationId) as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Task rows (`loop_type='task'`, D75 §3.4), oldest first, optionally narrowed
   * by conversation / bot / statuses.
   */
  listTasks(
    filter: { conversationId?: string; botId?: string; statuses?: RunStatus[] } = {},
  ): Run[] {
    const clauses = ["loop_type = 'task'"];
    const params: string[] = [];
    if (filter.conversationId !== undefined) {
      clauses.push('conversation_id = ?');
      params.push(filter.conversationId);
    }
    if (filter.botId !== undefined) {
      clauses.push('bot_id = ?');
      params.push(filter.botId);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      clauses.push(`status in (${filter.statuses.map(() => '?').join(', ')})`);
      params.push(...filter.statuses);
    }
    const rows = this.db
      .prepare(`select * from runs where ${clauses.join(' and ')} order by created_at asc, id asc`)
      .all(...params) as RunRow[];
    return rows.map(rowToRun);
  }

  /** Tasks not yet settled (startup repair, §3.2 / §7.4). */
  listNonTerminalTasks(): Run[] {
    const rows = this.db
      .prepare(
        `select * from runs where loop_type = 'task' and status in ${ACTIVE_STATUSES_SQL} order by created_at asc, id asc`,
      )
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  /** Settled tasks whose result no supervisor turn has consumed yet (§3.2 reconciliation). */
  listUnconsumedTerminalTasks(): Run[] {
    const rows = this.db
      .prepare(
        `select * from runs where loop_type = 'task' and status in ${TERMINAL_STATUSES_SQL} and result_consumed_at is null order by created_at asc, id asc`,
      )
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  /** Run ids bound to one bot-to-bot chain (chain budget aggregation, P05). */
  listIdsByChain(chainId: string): string[] {
    const rows = this.db.prepare('select id from runs where chain_id = ?').all(chainId) as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
  }

  /**
   * 未 settle 的子 run（D66/D67 ownership，docs/design/24-durable-execution.md
   * 「父 resume 先收束或恢复子 run」）：按委派父 run 查询，恢复/收束入口的契约
   * 查询；今天启动恢复仍走整批 markAllActiveInterrupted（D49 ephemeral 路径）。
   */
  listActiveByParent(parentRunId: string): Run[] {
    const rows = this.db
      .prepare(
        "select * from runs where parent_run_id = ? and status in ('queued', 'running', 'waiting_approval', 'waiting_lease')",
      )
      .all(parentRunId) as RunRow[];
    return rows.map(rowToRun);
  }

  listActiveByBot(botId: string): Run[] {
    const rows = this.db
      .prepare(
        "select * from runs where bot_id = ? and status in ('queued', 'running', 'waiting_approval', 'waiting_lease')",
      )
      .all(botId) as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Every in-flight execution across bots (P13 任务 2): the update gate waits
   * for this to drain before installing — a run in any of these statuses must
   * never be force-interrupted by an update without the user's confirmation.
   */
  listActive(): Run[] {
    const rows = this.db
      .prepare(
        "select * from runs where status in ('queued', 'running', 'waiting_approval', 'waiting_lease') order by created_at asc",
      )
      .all() as RunRow[];
    return rows.map(rowToRun);
  }

  /**
   * Startup recovery: unfinished runs -> interrupted (docs/dev/02-architecture.md).
   * `exceptLoopTypes` leaves those rows alone — tasks (D75 §3.2 / §7.4) are
   * repaired by TaskHost first and their submitted (`queued`) rows re-queued.
   */
  markAllActiveInterrupted(options: { exceptLoopTypes?: LoopType[] } = {}): Run[] {
    const except = options.exceptLoopTypes ?? [];
    const exceptSql =
      except.length > 0 ? ` and loop_type not in (${except.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(`select * from runs where status in ${ACTIVE_STATUSES_SQL}${exceptSql}`)
      .all(...except) as RunRow[];
    const now = this.clock.now();
    this.db
      .prepare(
        `update runs set status = 'interrupted', ended_at = ? where status in ${ACTIVE_STATUSES_SQL}${exceptSql}`,
      )
      .run(now, ...except);
    return rows.map(rowToRun);
  }

  deleteByConversation(conversationId: string): void {
    this.db.prepare('delete from runs where conversation_id = ?').run(conversationId);
  }

  deleteByBot(botId: string): void {
    this.db.prepare('delete from runs where bot_id = ?').run(botId);
  }

  /**
   * Removes one run row with its steps (BR-P07-006): a reflection run created
   * just before its conversation was deleted mid-flight must not survive as an
   * orphan row pointing at a deleted conversation.
   */
  remove(id: string): void {
    this.db.prepare('delete from run_steps where run_id = ?').run(id);
    this.db.prepare('delete from runs where id = ?').run(id);
  }

  // --- steps ---------------------------------------------------------------

  appendStep(input: { runId: string; type: RunStep['type']; payload: unknown }): RunStep {
    const step: RunStep = {
      id: newId('stp'),
      runId: input.runId,
      seq: (
        this.db
          .prepare('select coalesce(max(seq), -1) + 1 as s from run_steps where run_id = ?')
          .get(input.runId) as { s: number }
      ).s,
      type: input.type,
      payload: input.payload,
      createdAt: this.clock.now(),
    };
    const parsed = runStepSchema.parse(step);
    this.db
      .prepare(
        'insert into run_steps (id, run_id, seq, type, payload_json, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(
        parsed.id,
        parsed.runId,
        parsed.seq,
        parsed.type,
        JSON.stringify(parsed.payload),
        parsed.createdAt,
      );
    return step;
  }

  stepsFor(runId: string): RunStep[] {
    const rows = this.db
      .prepare('select * from run_steps where run_id = ? order by seq')
      .all(runId) as StepRow[];
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }
}

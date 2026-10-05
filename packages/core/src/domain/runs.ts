import {
  AppError,
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
  provider: string | null;
  model: string | null;
  output_message_ids_json: string;
  summary: string | null;
  continued_from_run_ids_json: string | null;
  error_json: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

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
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
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
    provider?: string | null;
    model?: string | null;
  }): Run {
    const id = newId('run');
    const now = this.clock.now();
    this.db
      .prepare(
        'insert into runs (id, bot_id, conversation_id, loop_type, status, trigger_reason, trigger_message_ids_json, chain_id, chain_depth, provider, model, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        input.provider ?? null,
        input.model ?? null,
        now,
      );
    return this.getOrThrow(id);
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
        "update runs set status = ?, provider = ?, model = ?, summary = ?, continued_from_run_ids_json = ?, error_json = ?, output_message_ids_json = ?, chain_id = ?, chain_depth = ?, started_at = coalesce(started_at, ?), ended_at = case when ? in ('completed','failed','cancelled','interrupted') then ? else ended_at end where id = ?",
      )
      .run(
        status,
        patch.provider ?? existing.provider,
        patch.model ?? existing.model,
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

  /** Run ids bound to one bot-to-bot chain (chain budget aggregation, P05). */
  listIdsByChain(chainId: string): string[] {
    const rows = this.db.prepare('select id from runs where chain_id = ?').all(chainId) as Array<{
      id: string;
    }>;
    return rows.map((r) => r.id);
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

  /** Startup recovery: unfinished runs -> interrupted (docs/dev/02-architecture.md). */
  markAllActiveInterrupted(): Run[] {
    const rows = this.db
      .prepare(
        "select * from runs where status in ('queued', 'running', 'waiting_approval', 'waiting_lease')",
      )
      .all() as RunRow[];
    const now = this.clock.now();
    this.db
      .prepare(
        "update runs set status = 'interrupted', ended_at = ? where status in ('queued', 'running', 'waiting_approval', 'waiting_lease')",
      )
      .run(now);
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

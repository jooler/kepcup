import {
  AppError,
  CONTINUATION_REPLAY_TOKEN_BUDGET,
  TASK_CONCURRENCY_GLOBAL,
  TASK_CONCURRENCY_PER_CONVERSATION,
  TASK_FAILURE_DIGEST_TOKEN_BUDGET,
  TASK_LIST_SETTLED_WINDOW_MS,
  TASK_MAX_WALL_MS,
  TASK_START_MAX_PER_TURN,
  TASK_TOKEN_BUDGET,
  type Message,
  type Run,
  type RunStatus,
  type RunStep,
  type SetupRequirement,
  type TaskEventContent,
} from '@kepcup/shared';
import { buildRunDigest } from '../agent/context/continuation.js';
import { renderMessageLine, type RenderMessageOptions } from '../agent/context/conversation.js';
import type { RunIdentity } from '../agent/types.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { RunsService } from '../domain/runs.js';
import type { Clock } from '../infra/clock.js';
import type { SqliteDatabase } from '../infra/db.js';
import type { CoreLogger } from '../infra/logger.js';
import type {
  CancelTaskResult,
  ForwardTaskResultOutput,
  InjectTaskInput,
  InjectTaskResult,
  StartTaskInput,
  StartTaskResult,
  TaskState,
  TaskSummary,
  TaskToolFacade,
} from '../tools/task-tools.js';

/**
 * 任务层（D75，docs/design/30-supervisor-and-tasks.md §3）：任务就是
 * `loop_type='task'` 的 runs 行。TaskHost 负责「任务必有结算」——
 *
 * - **先落盘再启动**（§3.1）：`start` 先写 `queued`（= submitted）行、再写私有
 *   `brief` 条目，然后按配额启动；名额 / 写入目录被占时停在 submitted。
 * - **结算次序**（§3.2）：终态条目（main.db，`appendTaskEvent` 按唯一索引幂等）
 *   → runs 终态（runs.db）→ 唤醒判定（§3.3）→ 投递（注入的 `wake` 钩子）。
 *   两库不能同一事务，次序固定；中途崩溃由 `recover()` 收敛。
 * - **消费**：唤醒的对话层到达终态时调 `markConsumed`；`sweep()`（reaper）与
 *   `resume()`（启动对账）补投「终态且未消费」且应唤醒的任务，并强制结束超过
 *   TASK_MAX_WALL_MS / TASK_TOKEN_BUDGET 的任务。
 *
 * 执行本身由注入的 `execute` 完成（orchestrator 的执行骨架，`kind:'task'`）：
 * 它经 `TaskRunControl` 取简报、挂上 RunHandle（steering = inject），结束时
 * 调 `settle`。宿主主动停下的任务（取消 / 超时 / 删除对话或 Bot）当场结算，
 * 之后执行体的 settle 是空操作（终态不可逆）。
 */

/** A run handle as the task host needs it (steering = inject, abort = cancel). */
export interface TaskRunHandle {
  steer(text: string): boolean;
  abort(reason: string): void;
  tokensSoFar(): number;
}

/** The brief a task starts from (§2.4.5), rebuilt from its private entries. */
export interface TaskBrief {
  task: Run;
  title: string;
  instruction: string;
  writes: boolean;
  /** The user's original messages (attachments included), in seq order. */
  sourceMessages: Message[];
  /** inject entries recorded before the task started (folded into the brief). */
  injects: Array<{ text: string; sourceMessages: Message[]; at: number }>;
  continuesTaskId: string | null;
}

/** Handed to the executor for one launch of a task. */
export interface TaskRunControl {
  readonly taskId: string;
  /** Aborted when the host stops the task (cancel, forced failure, teardown). */
  readonly signal: AbortSignal;
  /** The brief (null = the brief entry is missing: a crash before it was written). */
  brief(): TaskBrief | null;
  /** The engine run started: injects are steered into it from now on. */
  attach(handle: TaskRunHandle): void;
  /** The engine run ended. */
  detach(): void;
}

/** What an execution reports to `settle`. */
export interface TaskOutcome {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** completed only: the final text ('' for skip_reply). */
  resultText?: string;
  error?: string | null;
  setup?: SetupRequirement;
}

export interface TaskHostLimits {
  perConversation: number;
  global: number;
  perTurn: number;
  maxWallMs: number;
  tokenBudget: number;
}

export interface TaskHostDeps {
  /** main.db (the forward_task_result "already forwarded" lookup). */
  db: SqliteDatabase;
  runs: RunsService;
  messages: MessagesService;
  conversations: ConversationsService;
  bots: BotsService;
  clock: Clock;
  logger: CoreLogger;
  timeZone: string;
  /** Render options of the bot's view (source / inject lines). */
  renderOptions(selfBotId: string): RenderMessageOptions;
  publishRunStatus(run: Run): void;
  /** Starts executing a launched task (orchestrator: scheduler key `task:{id}`). */
  execute(task: Run, control: TaskRunControl): void;
  /**
   * Wakes the bot with the task's terminal entry (§3.2 投递). This wave: the
   * entry goes to the (bot, conversation) mailbox as a `reason:'task'` batch.
   */
  wake(botId: string, conversationId: string, entry: Message): void;
  /** Resolves the task's workdir root (bound project or the workspace). */
  resolveWorkdir(
    botId: string,
    conversationId: string,
    requested?: 'workspace' | 'project',
  ): string;
  /** Terminal cleanup of the run (once-grants, pending approvals, write lease, run.status). */
  onSettled(run: Run): void;
  /** A visible message sent on behalf of a run (forward_task_result): output + push. */
  recordVisibleMessage(runId: string, message: Message): void;
  /** Test overrides of the D75 constants. */
  limits?: Partial<TaskHostLimits>;
}

interface LaunchedTask {
  taskId: string;
  botId: string;
  conversationId: string;
  writes: boolean;
  workdir: string | null;
  launchedAt: number;
  attachedAt: number | null;
  controller: AbortController;
  handle: TaskRunHandle | null;
  briefBuilt: boolean;
  /** Injects that arrived after the brief was built but before attach. */
  buffered: string[];
}

const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_lease'];

export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

/** queued → submitted (§3.1); the waiting states count as running. */
export function taskState(status: RunStatus): TaskState {
  switch (status) {
    case 'queued':
      return 'submitted';
    case 'running':
    case 'waiting_approval':
    case 'waiting_lease':
      return 'running';
    default:
      return status;
  }
}

function taskEventOf(message: Message): TaskEventContent | null {
  if (message.kind !== 'task_event') return null;
  return message.content as TaskEventContent;
}

/** The run status a terminal entry stands for (§3.2 修复). */
function statusOfTerminalEntry(entry: Message): RunStatus {
  const content = taskEventOf(entry);
  if (content?.phase === 'result') return 'completed';
  const status = content?.status;
  return status !== undefined && isTerminalStatus(status) && status !== 'completed'
    ? status
    : 'failed';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sourceLines(messages: Message[], options: RenderMessageOptions): string[] {
  return messages
    .filter((message) => message.status !== 'recalled')
    .map((message) => renderMessageLine(message, options));
}

/**
 * The task's trigger segment (§2.4.5): the instruction plus the verbatim
 * source messages (attachment lines included; images go to the vision channel
 * separately), injects recorded before the start, and the task framing.
 */
export function buildTaskBriefSegment(
  brief: TaskBrief,
  options: RenderMessageOptions,
  workdir: string | null,
): string {
  const lines: string[] = [
    `<task_brief task_id="${brief.task.id}" title="${brief.title.replaceAll('"', "'")}" writes="${brief.writes}"${workdir !== null ? ` workdir="${workdir}"` : ''}>`,
    '<instruction>',
    brief.instruction,
    '</instruction>',
  ];
  const sources = sourceLines(brief.sourceMessages, options);
  if (sources.length > 0) lines.push('<source_messages>', ...sources, '</source_messages>');
  if (brief.injects.length > 0) {
    lines.push('<later_instructions>');
    for (const inject of brief.injects) {
      lines.push(inject.text, ...sourceLines(inject.sourceMessages, options));
    }
    lines.push('</later_instructions>');
  }
  lines.push('</task_brief>');
  lines.push(
    [
      '你正在执行自己在这个对话中派出的一项任务（上面是交代）。source_messages 是用户的原话：交代与原话不一致时以原话为准，并在结果里说明。',
      '工作中简短的进度说明会直接显示给用户；不要停下来等待对话里的新消息，新的指令会另行转给你。',
      '你的最终回复不会直接发给用户，而是作为任务结果交回给对话中的你，由你决定如何告诉用户：写清做了什么、结论、产出的文件路径与未完成的事项。没有需要交回的内容时用 skip_reply。',
      ...(brief.writes ? [] : ['这是只读任务：不要修改任何文件。']),
    ].join('\n'),
  );
  return lines.join('\n');
}

/** Steer text of an inject (§4.1 inject_task): the new instruction + originals. */
export function buildTaskInjection(
  text: string,
  sourceMessages: Message[],
  options: RenderMessageOptions,
): string {
  const sources = sourceLines(sourceMessages, options);
  return [
    '<task_inject>',
    text,
    ...(sources.length > 0 ? ['<source_messages>', ...sources, '</source_messages>'] : []),
    '</task_inject>',
    '对话中的你追加了新的指令：据此调整当前的工作。',
  ].join('\n');
}

/** `continues_task_id` replay (§7.1): the source task's process, D56 budget. */
export function buildTaskReplaySegment(input: {
  source: Run;
  steps: RunStep[];
  timeZone: string;
}): string {
  const digest = buildRunDigest({
    run: input.source,
    steps: input.steps,
    timeZone: input.timeZone,
    budgetTokens: CONTINUATION_REPLAY_TOKEN_BUDGET,
  });
  if (digest.length === 0) return '';
  return [
    '<continuation>',
    `这条任务接续之前的任务 ${input.source.id}（状态 ${input.source.status}）。以下是它的过程记录：大段工具输出已省略，需要时可用工具重新获取；文件与环境的当前状态以最新为准。`,
    digest,
    '</continuation>',
  ].join('\n');
}

export class TaskHost implements TaskToolFacade {
  readonly #deps: TaskHostDeps;
  readonly #limits: TaskHostLimits;
  readonly #launched = new Map<string, LaunchedTask>();
  /** Delivered terminal entries waiting for a consuming turn (sweep skips them). */
  readonly #pendingConsumption = new Set<string>();
  #pumping = false;
  #pumpAgain = false;

  constructor(deps: TaskHostDeps) {
    this.#deps = deps;
    this.#limits = {
      perConversation: deps.limits?.perConversation ?? TASK_CONCURRENCY_PER_CONVERSATION,
      global: deps.limits?.global ?? TASK_CONCURRENCY_GLOBAL,
      perTurn: deps.limits?.perTurn ?? TASK_START_MAX_PER_TURN,
      maxWallMs: deps.limits?.maxWallMs ?? TASK_MAX_WALL_MS,
      tokenBudget: deps.limits?.tokenBudget ?? TASK_TOKEN_BUDGET,
    };
  }

  // --- routing (§4.1) --------------------------------------------------------

  start(identity: RunIdentity, input: StartTaskInput): StartTaskResult {
    if (identity.loopType === 'task') {
      throw new AppError('NOT_SUPPORTED', '任务内不能再派任务（深度 1）');
    }
    const { botId, conversationId } = this.#scope(identity);
    if (!this.#canWake(botId, conversationId)) {
      throw new AppError('INVALID_INPUT', '对话不可用（只读、已删除，或你已不在其中）');
    }
    const title = input.title.trim();
    const instruction = input.instruction.trim();
    if (title.length === 0 || instruction.length === 0) {
      throw new AppError('INVALID_INPUT', 'title 与 instruction 不能为空');
    }
    const startedThisTurn = this.#deps.runs
      .listTasks({ conversationId, botId })
      .filter((task) => task.originRunId === identity.runId).length;
    if (startedThisTurn >= this.#limits.perTurn) {
      throw new AppError(
        'TASK_LIMIT_REACHED',
        `本轮最多派出 ${this.#limits.perTurn} 个任务；其余的请等这些任务有结果后再派，或合并成一个任务`,
      );
    }
    const sources = this.#sourceMessages(conversationId, botId, input.sourceMessageIds);
    let continues: Run | null = null;
    if (input.continuesTaskId !== undefined) {
      continues = this.#ownTask(botId, conversationId, input.continuesTaskId);
      if (!isTerminalStatus(continues.status)) {
        throw new AppError(
          'INVALID_INPUT',
          `任务 ${continues.id} 仍在进行：先 cancel_task，再用 continues_task_id 接续`,
        );
      }
    }
    const workdir = this.#deps.resolveWorkdir(botId, conversationId, input.workdir);
    // Persist first (§3.1): a crash after this line leaves a submitted row that
    // is re-queued on restart; a crash before it means no task at all.
    const task = this.#deps.runs.create({
      botId,
      conversationId,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: sources.map((message) => message.id),
      taskTitle: title,
      taskWrites: input.writes,
      taskWorkdir: workdir,
      originRunId: identity.runId,
      ...(continues !== null ? { continuedFromRunIds: [continues.id] } : {}),
    });
    this.#deps.publishRunStatus(task);
    this.#deps.messages.appendTaskEvent({
      conversationId,
      ownerBotId: botId,
      taskId: task.id,
      phase: 'brief',
      text: instruction,
      sourceMessageIds: sources.map((message) => message.id),
      title,
      writes: input.writes,
      ...(continues !== null ? { continuesTaskId: continues.id } : {}),
    });
    this.#pump();
    const launched = this.#launched.has(task.id);
    const current = this.#deps.runs.get(task.id) ?? task;
    if (isTerminalStatus(current.status)) {
      // Settled synchronously (bot vanished between checks, …): report it as
      // started — its terminal entry tells the rest.
      return { taskId: task.id, state: 'running', queueReason: null };
    }
    return {
      taskId: task.id,
      state: launched ? 'running' : 'submitted',
      queueReason: launched ? null : this.#queueReason(current),
    };
  }

  inject(identity: RunIdentity, input: InjectTaskInput): InjectTaskResult {
    const { botId, conversationId } = this.#scope(identity);
    const task = this.#ownTask(botId, conversationId, input.taskId);
    if (isTerminalStatus(task.status)) {
      throw new AppError('RUN_ALREADY_FINISHED', `任务 ${task.id} 已结束（${task.status}）`);
    }
    const text = input.text.trim();
    if (text.length === 0) throw new AppError('INVALID_INPUT', 'text 不能为空');
    const sources = this.#sourceMessages(conversationId, botId, input.sourceMessageIds ?? []);
    const launched = this.#launched.get(task.id);
    let delivery: 'delivered' | 'queued' = 'delivered';
    if (launched?.handle) {
      const steerText = buildTaskInjection(text, sources, this.#deps.renderOptions(botId));
      delivery = launched.handle.steer(steerText) ? 'delivered' : 'queued';
    } else if (launched?.briefBuilt) {
      launched.buffered.push(buildTaskInjection(text, sources, this.#deps.renderOptions(botId)));
    }
    // Not launched / brief not built yet: the entry below is folded into the
    // brief when the task starts (TaskBrief.injects).
    this.#deps.messages.appendTaskEvent({
      conversationId,
      ownerBotId: botId,
      taskId: task.id,
      phase: 'inject',
      text,
      sourceMessageIds: sources.map((message) => message.id),
      delivery,
    });
    if (task.awaitingInput) this.#deps.runs.update(task.id, { awaitingInput: false });
    return { delivery };
  }

  cancel(identity: RunIdentity, input: { taskId: string; reason: string }): CancelTaskResult {
    const { botId, conversationId } = this.#scope(identity);
    const task = this.#ownTask(botId, conversationId, input.taskId);
    if (isTerminalStatus(task.status)) {
      throw new AppError('RUN_ALREADY_FINISHED', `任务 ${task.id} 已结束（${task.status}）`);
    }
    const reason = input.reason.trim() || '取消';
    this.#deps.messages.appendTaskEvent({
      conversationId,
      ownerBotId: botId,
      taskId: task.id,
      phase: 'cancel',
      text: reason,
    });
    const settled = this.#stop(task.id, 'cancelled', `已取消：${reason}`);
    const writes = task.taskWrites === true;
    return {
      taskId: task.id,
      state: taskState(settled?.status ?? 'cancelled'),
      message: `已取消任务 ${task.id}「${task.taskTitle ?? ''}」。${writes ? '它已经做出的文件改动不会自动撤销。' : ''}`,
    };
  }

  /**
   * The user cancelled a task from outside the tools (runs.cancel RPC, update
   * gate): same settlement as cancel_task, recorded as the user's decision.
   */
  cancelById(taskId: string, reason: string): Run | null {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') return null;
    if (isTerminalStatus(task.status)) return task;
    if (task.botId !== null && task.conversationId !== null) {
      this.#safeAppend({
        conversationId: task.conversationId,
        ownerBotId: task.botId,
        taskId,
        phase: 'cancel',
        text: reason,
      });
    }
    return this.#stop(taskId, 'cancelled', reason);
  }

  list(identity: RunIdentity): TaskSummary[] {
    const { botId, conversationId } = this.#scope(identity);
    const now = this.#deps.clock.now();
    return this.#deps.runs
      .listTasks({ conversationId, botId })
      .filter(
        (task) =>
          !isTerminalStatus(task.status) ||
          (task.endedAt !== null && now - task.endedAt <= TASK_LIST_SETTLED_WINDOW_MS),
      )
      .map((task) => this.#summary(task));
  }

  forwardResult(identity: RunIdentity, taskId: string): ForwardTaskResultOutput {
    const { botId, conversationId } = this.#scope(identity);
    const task = this.#ownTask(botId, conversationId, taskId);
    if (task.status !== 'completed') {
      throw new AppError('INVALID_INPUT', `任务 ${task.id} 不是已完成状态（${task.status}）`);
    }
    const entry = this.#deps.messages.terminalTaskEvent(task.id);
    const content = entry !== null ? taskEventOf(entry) : null;
    if (content === null || content.phase !== 'result' || content.text.trim().length === 0) {
      throw new AppError('INVALID_INPUT', `任务 ${task.id} 没有可转发的结果`);
    }
    const already = this.#deps.db
      .prepare(
        "select id from messages where conversation_id = ? and kind = 'text' and json_extract(content_json, '$.origin') = 'task' and json_extract(content_json, '$.taskId') = ? and coalesce(run_id, '') != ? limit 1",
      )
      .get(conversationId, task.id, task.id) as { id: string } | undefined;
    if (already !== undefined) {
      throw new AppError('INVALID_INPUT', `任务 ${task.id} 的结果已经转发过（消息 ${already.id}）`);
    }
    const message = this.#deps.messages.append({
      conversationId,
      senderType: 'bot',
      senderBotId: botId,
      kind: 'text',
      text: content.text,
      runId: identity.runId,
      taskOrigin: { taskId: task.id },
    });
    this.#deps.recordVisibleMessage(identity.runId, message);
    return { messageId: message.id };
  }

  /**
   * The task needs the user's input (§2.4.6): a private `question` entry bound
   * to the visible question card; the task stays running with awaiting_input.
   * Never wakes the bot — the user's answer drives the next step.
   */
  recordQuestion(taskId: string, input: { text: string; questionMessageId: string }): void {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task' || isTerminalStatus(task.status)) return;
    if (task.botId === null || task.conversationId === null) return;
    this.#deps.messages.appendTaskEvent({
      conversationId: task.conversationId,
      ownerBotId: task.botId,
      taskId,
      phase: 'question',
      text: input.text,
      questionMessageId: input.questionMessageId,
    });
    this.#deps.publishRunStatus(this.#deps.runs.update(taskId, { awaitingInput: true }));
  }

  // --- settlement (§3.2 / §3.3) ----------------------------------------------

  /**
   * Settles a task: terminal entry (main.db) → task terminal (runs.db) → wake
   * decision → delivery. Idempotent: a task already terminal is left as is
   * (a host-stopped task's executor lands here afterwards).
   */
  settle(taskId: string, outcome: TaskOutcome): Run | null {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') return null;
    if (isTerminalStatus(task.status)) {
      this.#forget(taskId);
      return task;
    }
    const error = outcome.error ?? null;
    let entry: Message | null = null;
    if (task.botId !== null && task.conversationId !== null) {
      entry = this.#safeAppend(
        outcome.status === 'completed'
          ? {
              conversationId: task.conversationId,
              ownerBotId: task.botId,
              taskId,
              phase: 'result',
              text: outcome.resultText ?? '',
              status: 'completed',
            }
          : {
              conversationId: task.conversationId,
              ownerBotId: task.botId,
              taskId,
              phase: 'failure',
              text: this.#failureText(task, outcome.status, error),
              status: outcome.status,
              ...(error !== null ? { error } : {}),
            },
      );
    }
    // An earlier writer may have won the unique index: the stored entry is
    // the source of truth for the final status.
    const status = entry !== null ? statusOfTerminalEntry(entry) : outcome.status;
    const updated = this.#deps.runs.update(taskId, {
      status,
      ...(status !== 'completed' && error !== null ? { error } : {}),
      ...(outcome.setup !== undefined ? { setup: outcome.setup } : {}),
    });
    this.#forget(taskId);
    this.#cleanup(updated);
    this.#afterTerminal(updated, entry);
    this.#pump();
    return updated;
  }

  /**
   * The bot consumed these tasks' terminal entries (a turn whose trigger held
   * them reached a terminal state, §3.2 消费). Non-terminal / unknown ids and
   * already-consumed tasks are ignored.
   */
  markConsumed(taskIds: Iterable<string>): void {
    const now = this.#deps.clock.now();
    for (const taskId of new Set(taskIds)) {
      this.#pendingConsumption.delete(taskId);
      const task = this.#deps.runs.get(taskId);
      if (task === null || task.loopType !== 'task') continue;
      if (!isTerminalStatus(task.status) || task.resultConsumedAt !== null) continue;
      this.#deps.runs.update(taskId, { resultConsumedAt: now });
    }
  }

  // --- recovery, reconciliation, reaper (§3.2, §7.4) --------------------------

  /**
   * Startup repair (§3.2 修复, §7.4 step 1) — must run before any blanket
   * "active → interrupted" pass. A non-terminal task with a terminal entry
   * adopts the entry's status; without one, a started task gets a `failure`
   * entry first and then `interrupted`. Submitted (`queued`) tasks never
   * started and are left for `resume()` to re-queue. Returns the repaired runs.
   */
  recover(): Run[] {
    const repaired: Run[] = [];
    for (const task of this.#deps.runs.listNonTerminalTasks()) {
      try {
        const existing = this.#deps.messages.terminalTaskEvent(task.id);
        if (existing !== null) {
          const status = statusOfTerminalEntry(existing);
          const error = taskEventOf(existing)?.error;
          repaired.push(
            this.#deps.runs.update(task.id, {
              status,
              ...(status !== 'completed' && error !== undefined ? { error } : {}),
            }),
          );
          continue;
        }
        if (task.status === 'queued') continue;
        const error = '应用退出，任务中断';
        if (task.botId !== null && task.conversationId !== null) {
          this.#safeAppend({
            conversationId: task.conversationId,
            ownerBotId: task.botId,
            taskId: task.id,
            phase: 'failure',
            text: this.#failureText(task, 'interrupted', error),
            status: 'interrupted',
            error,
          });
        }
        repaired.push(this.#deps.runs.update(task.id, { status: 'interrupted', error }));
      } catch (error) {
        this.#deps.logger.warn(
          { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
          'task repair failed',
        );
      }
    }
    for (const run of repaired) this.#cleanup(run);
    if (repaired.length > 0) {
      this.#deps.logger.info({ tasks: repaired.length }, 'repaired unsettled tasks');
    }
    return repaired;
  }

  /**
   * §7.4 steps 3–4 (after the blanket interruption and lease / approval
   * cleanup): re-queue submitted tasks, then re-deliver terminal unconsumed
   * results that should wake the bot.
   */
  resume(): void {
    this.#pump();
    this.#reconcile();
  }

  /**
   * Reaper (every TASK_SETTLE_SWEEP_MS): forces running tasks over the wall
   * clock / token budget to `failed`, then reconciles unconsumed results.
   * `now` overrides the clock (tests).
   */
  sweep(now: number = this.#deps.clock.now()): void {
    for (const launched of [...this.#launched.values()]) {
      const since = launched.attachedAt ?? this.#runningSince(launched);
      if (since !== null && now - since > this.#limits.maxWallMs) {
        this.#stop(
          launched.taskId,
          'failed',
          `任务运行超过时限（${Math.round(this.#limits.maxWallMs / 60_000)} 分钟），已强制结束`,
        );
        continue;
      }
      if (launched.handle !== null && launched.handle.tokensSoFar() > this.#limits.tokenBudget) {
        this.#stop(
          launched.taskId,
          'failed',
          `任务用量超过 token 预算（${this.#limits.tokenBudget}），已强制结束`,
        );
      }
    }
    this.#reconcile();
  }

  // --- lifecycle --------------------------------------------------------------

  /** Conversation deleted: its tasks are cancelled (no wake: nobody to wake). */
  abortForConversation(conversationId: string, reason = 'conversation deleted'): void {
    for (const task of this.#deps.runs.listTasks({ conversationId, statuses: ACTIVE_STATUSES })) {
      this.#stop(task.id, 'cancelled', reason);
    }
  }

  /** Bot deleted: all its tasks are cancelled. */
  abortForBot(botId: string, reason = 'bot deleted'): void {
    for (const task of this.#deps.runs.listTasks({ botId, statuses: ACTIVE_STATUSES })) {
      this.#stop(task.id, 'cancelled', reason);
    }
  }

  /** Bot removed from a group: its tasks in that conversation are cancelled. */
  abortForBotInConversation(
    botId: string,
    conversationId: string,
    reason = 'removed from group',
  ): void {
    for (const task of this.#deps.runs.listTasks({
      botId,
      conversationId,
      statuses: ACTIVE_STATUSES,
    })) {
      this.#stop(task.id, 'cancelled', reason);
    }
  }

  /** Tasks launched in this process (executing or about to). */
  launchedCount(conversationId?: string): number {
    let count = 0;
    for (const launched of this.#launched.values()) {
      if (conversationId === undefined || launched.conversationId === conversationId) count += 1;
    }
    return count;
  }

  // --- internals --------------------------------------------------------------

  #scope(identity: RunIdentity): { botId: string; conversationId: string } {
    if (identity.botId === null || identity.conversationId === null) {
      throw new AppError('INVALID_INPUT', '任务需要 Bot 与对话上下文');
    }
    return { botId: identity.botId, conversationId: identity.conversationId };
  }

  #ownTask(botId: string, conversationId: string, taskId: string): Run {
    const task = this.#deps.runs.get(taskId);
    if (
      task === null ||
      task.loopType !== 'task' ||
      task.botId !== botId ||
      task.conversationId !== conversationId
    ) {
      throw new AppError('NOT_FOUND', `本对话中没有你的任务 ${taskId}`);
    }
    return task;
  }

  /** Source messages must belong to the conversation and be visible to the bot. */
  #sourceMessages(conversationId: string, botId: string, ids: string[]): Message[] {
    const messages: Message[] = [];
    for (const id of [...new Set(ids)]) {
      const message = this.#deps.messages.getById(id);
      if (
        message === null ||
        message.conversationId !== conversationId ||
        (message.ownerBotId !== null && message.ownerBotId !== botId)
      ) {
        throw new AppError('INVALID_INPUT', `消息 ${id} 不属于本对话`);
      }
      messages.push(message);
    }
    return messages.sort((a, b) => a.seq - b.seq);
  }

  #canWake(botId: string, conversationId: string): boolean {
    const conversation = this.#deps.conversations.get(conversationId);
    const bot = this.#deps.bots.get(botId);
    if (conversation === null || conversation.readOnly) return false;
    if (bot === null || bot.status !== 'active') return false;
    return (
      conversation.directBotId === botId ||
      this.#deps.conversations.memberBotIds(conversationId).includes(botId)
    );
  }

  /** Starts submitted tasks while the concurrency caps and write targets allow (FIFO). */
  #pump(): void {
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#pumpAgain = false;
        for (const task of this.#deps.runs.listTasks({ statuses: ['queued'] })) {
          if (this.#launched.has(task.id)) continue;
          if (this.#launched.size >= this.#limits.global) break;
          if (this.#blockedBy(task) !== null) continue;
          this.#launch(task);
        }
      } while (this.#pumpAgain);
    } finally {
      this.#pumping = false;
    }
  }

  /** Why a submitted task cannot launch right now (null = it can). */
  #blockedBy(task: Run): string | null {
    if (this.#launched.size >= this.#limits.global) {
      return `等并发额度（全局 ${this.#launched.size}/${this.#limits.global}）`;
    }
    const inConversation = this.launchedCount(task.conversationId ?? '');
    if (inConversation >= this.#limits.perConversation) {
      return `等并发额度（本对话 ${inConversation}/${this.#limits.perConversation}）`;
    }
    if (task.taskWrites === true && task.taskWorkdir !== null) {
      for (const launched of this.#launched.values()) {
        if (launched.writes && launched.workdir === task.taskWorkdir) {
          return `等写入租约（任务 ${launched.taskId} 持有）`;
        }
      }
    }
    return null;
  }

  #queueReason(task: Run): string | null {
    if (isTerminalStatus(task.status)) return null;
    if (this.#launched.has(task.id)) {
      return task.status === 'queued' ? '等写入租约 / 启动中' : null;
    }
    return this.#blockedBy(task) ?? '等待启动';
  }

  #launch(task: Run): void {
    if (task.botId === null || task.conversationId === null) {
      this.settle(task.id, { status: 'failed', error: '任务缺少 Bot 或对话' });
      return;
    }
    const launched: LaunchedTask = {
      taskId: task.id,
      botId: task.botId,
      conversationId: task.conversationId,
      writes: task.taskWrites === true,
      workdir: task.taskWorkdir,
      launchedAt: this.#deps.clock.now(),
      attachedAt: null,
      controller: new AbortController(),
      handle: null,
      briefBuilt: false,
      buffered: [],
    };
    this.#launched.set(task.id, launched);
    const control: TaskRunControl = {
      taskId: task.id,
      signal: launched.controller.signal,
      brief: () => this.#brief(task.id),
      attach: (handle) => this.#attach(task.id, handle),
      detach: () => {
        const current = this.#launched.get(task.id);
        if (current !== undefined) current.handle = null;
      },
    };
    try {
      this.#deps.execute(task, control);
    } catch (error) {
      this.settle(task.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #brief(taskId: string): TaskBrief | null {
    const task = this.#deps.runs.get(taskId);
    if (task === null) return null;
    const launched = this.#launched.get(taskId);
    if (launched !== undefined) launched.briefBuilt = true;
    let brief: TaskBrief | null = null;
    const resolve = (ids: string[] | undefined): Message[] =>
      (ids ?? [])
        .map((id) => this.#deps.messages.getById(id))
        .filter((message): message is Message => message !== null && message.status !== 'recalled');
    for (const event of this.#deps.messages.taskEvents(taskId)) {
      const content = taskEventOf(event);
      if (content === null) continue;
      if (content.phase === 'brief' && brief === null) {
        brief = {
          task,
          title: content.title ?? task.taskTitle ?? '',
          instruction: content.text,
          writes: content.writes ?? task.taskWrites === true,
          sourceMessages: resolve(content.sourceMessageIds),
          injects: [],
          continuesTaskId: content.continuesTaskId ?? null,
        };
      } else if (content.phase === 'inject' && brief !== null) {
        brief.injects.push({
          text: content.text,
          sourceMessages: resolve(content.sourceMessageIds),
          at: event.createdAt,
        });
      }
    }
    return brief;
  }

  #attach(taskId: string, handle: TaskRunHandle): void {
    const launched = this.#launched.get(taskId);
    if (launched === undefined) {
      // Stopped while starting: the host already settled it.
      handle.abort('task stopped');
      return;
    }
    launched.handle = handle;
    launched.attachedAt = this.#deps.clock.now();
    for (const text of launched.buffered.splice(0)) {
      if (!handle.steer(text)) {
        this.#deps.logger.warn({ taskId }, 'buffered task inject could not be steered');
      }
    }
    if (launched.controller.signal.aborted) handle.abort('task stopped');
  }

  #runningSince(launched: LaunchedTask): number | null {
    const task = this.#deps.runs.get(launched.taskId);
    // Still queued = waiting for the write lease / a provider slot: not running yet.
    if (task === null || task.status === 'queued') return null;
    return launched.launchedAt;
  }

  /** The host stops a task: abort its execution and settle it right away. */
  #stop(taskId: string, status: 'cancelled' | 'failed', reason: string): Run | null {
    const launched = this.#launched.get(taskId);
    if (launched !== undefined) {
      launched.controller.abort();
      try {
        launched.handle?.abort(reason);
      } catch (error) {
        this.#deps.logger.warn(
          { taskId, error: error instanceof Error ? error.message : String(error) },
          'task abort failed',
        );
      }
    }
    return this.settle(taskId, { status, error: reason });
  }

  #forget(taskId: string): void {
    const launched = this.#launched.get(taskId);
    if (launched === undefined) return;
    this.#launched.delete(taskId);
    launched.controller.abort();
  }

  #cleanup(run: Run): void {
    try {
      this.#deps.onSettled(run);
    } catch (error) {
      this.#deps.logger.warn(
        { taskId: run.id, error: error instanceof Error ? error.message : String(error) },
        'task settle cleanup failed',
      );
    }
  }

  /** Wake decision (§3.3) + delivery, or consumption right away. */
  #afterTerminal(run: Run, entry: Message | null): void {
    if (entry === null || !this.#shouldWake(run, entry)) {
      this.markConsumed([run.id]);
      return;
    }
    this.#deliver(run, entry);
  }

  #shouldWake(run: Run, entry: Message): boolean {
    if (run.status === 'completed') {
      const content = taskEventOf(entry);
      return content !== null && content.text.trim().length > 0;
    }
    // Cancelled: the bot's or the user's own decision, or nobody left to wake.
    return run.status === 'failed' || run.status === 'interrupted';
  }

  #deliver(run: Run, entry: Message): void {
    if (run.botId === null || run.conversationId === null) return;
    if (!this.#canWake(run.botId, run.conversationId)) {
      // No one to wake (conversation read-only / deleted, bot gone or removed).
      this.markConsumed([run.id]);
      return;
    }
    this.#pendingConsumption.add(run.id);
    try {
      this.#deps.wake(run.botId, run.conversationId, entry);
    } catch (error) {
      this.#pendingConsumption.delete(run.id);
      this.#deps.logger.warn(
        { taskId: run.id, error: error instanceof Error ? error.message : String(error) },
        'task result delivery failed; the reaper retries',
      );
    }
  }

  /** Re-delivers terminal, unconsumed results (startup and reaper, §3.2 对账). */
  #reconcile(): void {
    for (const task of this.#deps.runs.listUnconsumedTerminalTasks()) {
      if (this.#pendingConsumption.has(task.id)) continue;
      try {
        let entry = this.#deps.messages.terminalTaskEvent(task.id);
        if (entry === null && task.botId !== null && task.conversationId !== null) {
          // Settled outside the task host (should not happen): give the bot a
          // failure entry rather than silence.
          const status = task.status === 'completed' ? 'failed' : task.status;
          entry = this.#safeAppend({
            conversationId: task.conversationId,
            ownerBotId: task.botId,
            taskId: task.id,
            phase: 'failure',
            text: this.#failureText(task, status, task.error ?? '任务的结算记录缺失'),
            status,
            error: task.error ?? '任务的结算记录缺失',
          });
        }
        this.#afterTerminal(task, entry);
      } catch (error) {
        this.#deps.logger.warn(
          { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
          'task reconciliation failed',
        );
      }
    }
  }

  #failureText(task: Run, status: RunStatus, error: string | null): string {
    const label = status === 'cancelled' ? '已取消' : status === 'interrupted' ? '已中断' : '失败';
    let digest = '';
    try {
      digest = buildRunDigest({
        run: { ...task, status, endedAt: task.endedAt ?? this.#deps.clock.now() },
        steps: this.#deps.runs.stepsFor(task.id),
        timeZone: this.#deps.timeZone,
        budgetTokens: TASK_FAILURE_DIGEST_TOKEN_BUDGET,
      });
    } catch {
      // The digest is a courtesy: an unreadable step log leaves just the error.
    }
    return [`任务${label}${error !== null && error.length > 0 ? `：${error}` : ''}`, digest]
      .filter((part) => part.length > 0)
      .join('\n');
  }

  /** appendTaskEvent that never throws (a conversation deleted under us). */
  #safeAppend(input: Parameters<MessagesService['appendTaskEvent']>[0]): Message | null {
    try {
      return this.#deps.messages.appendTaskEvent(input).message;
    } catch (error) {
      this.#deps.logger.warn(
        {
          taskId: input.taskId,
          phase: input.phase,
          error: error instanceof Error ? error.message : String(error),
        },
        'task entry write failed',
      );
      return null;
    }
  }

  #summary(task: Run): TaskSummary {
    let lastProgress: string | null = null;
    for (let i = task.outputMessageIds.length - 1; i >= 0 && lastProgress === null; i -= 1) {
      const message = this.#deps.messages.getById(task.outputMessageIds[i] ?? '');
      const content = message?.content as { text?: unknown } | undefined;
      if (typeof content?.text === 'string' && content.text.trim().length > 0) {
        lastProgress = clip(content.text.trim().replace(/\s+/g, ' '), 120);
      }
    }
    const terminal = isTerminalStatus(task.status);
    return {
      taskId: task.id,
      title: task.taskTitle ?? '',
      state: taskState(task.status),
      status: task.status,
      writes: task.taskWrites === true,
      workdir: task.taskWorkdir,
      createdAt: task.createdAt,
      endedAt: task.endedAt,
      queueReason: terminal ? null : this.#queueReason(task),
      awaitingInput: task.awaitingInput,
      injectable: !terminal,
      lastProgress,
      error: task.error,
    };
  }
}

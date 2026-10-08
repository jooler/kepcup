import {
  AppError,
  CONTINUATION_REPLAY_TOKEN_BUDGET,
  TASK_CONCURRENCY_GLOBAL,
  TASK_CONCURRENCY_PER_CONVERSATION,
  TASK_FAILURE_DIGEST_TOKEN_BUDGET,
  TASK_LIST_SETTLED_WINDOW_MS,
  TASK_MAX_WALL_MS,
  TASK_REDELIVER_AFTER_MS,
  TASK_SETTLE_SWEEP_MS,
  TASK_START_MAX_PER_TURN,
  TASK_TOKEN_BUDGET,
  type Message,
  type Run,
  type RunStatus,
  type RunStep,
  type SetupRequirement,
  type TaskChanges,
  type TaskEventContent,
  type TaskView,
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
  /** The engine run ended: later injects can no longer reach this execution. */
  detach(): void;
  /**
   * The engine handed a steered inject back after `steer()` accepted it (an
   * external agent refusing `_session/steering` asynchronously, design 30
   * §8.2): its entry is downgraded to `queued`, like a synchronous refusal.
   * Valid after `detach` / `finish` too (late refusals).
   */
  steerRefused(text: string): void;
  /**
   * The engine run took a steered inject in (its `steer` event): the entry
   * stays `delivered` and a later refusal of the same text no longer finds it.
   */
  steerConfirmed(text: string): void;
  /**
   * Why the launched task is still `queued` (waiting for its write lease / a
   * provider slot); null once it runs. Shown as the queue reason (§3.1).
   */
  waiting(reason: string | null): void;
  /**
   * The execution is over (every path, after its lease release): the slot and
   * the write target are freed and submitted tasks may start.
   */
  finish(): void;
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
  /**
   * Terminal cleanup of the run (once-grants, pending approvals, run.status).
   * `executorActive`: the execution is still unwinding — it releases its own
   * write lease when it ends; otherwise the cleanup releases it.
   */
  onSettled(run: Run, executorActive: boolean): void;
  /** Releases an execution's write lease / per-run state (an evicted stuck executor). */
  releaseExecution(runId: string): void;
  /** A visible message sent on behalf of a run (forward_task_result): output + push. */
  recordVisibleMessage(runId: string, message: Message): void;
  /**
   * The engine slot a task occupies beyond the task caps (design 30 §8.5:
   * task concurrency = min(TASK_CONCURRENCY_*, `agent:{id}` concurrency)):
   * an external-agent task takes `{ key: 'agent:{id}', limit }`; null = no
   * engine cap (built-in tasks share the provider with replies, the
   * scheduler reserves a slot for them). Tasks over the limit stay submitted
   * — no write lease, no task slot — instead of launching to wait.
   */
  launchSlot?(task: Run): { key: string; limit: number } | null;
  /**
   * D75 W3 (design 30 §4.3): pushes a task's card / status-line view
   * (`task.updated`). Absent = no UI (unit tests).
   */
  publishTask?(view: TaskView): void;
  /** Pushes a visible message the host wrote (task card, question card) — created or updated. */
  publishMessage?(message: Message, change: 'created' | 'updated'): void;
  /**
   * Where the task works and what it left behind (cancel card, §4.3 / §5.2):
   * project tasks have a checkpoint summary, workspace tasks only the files
   * their file tools wrote. `changes` null = nothing recorded.
   */
  describeWorkdir?(task: Run): { kind: 'project' | 'workspace'; changes: TaskChanges | null };
  /** Test overrides of the D75 constants. */
  limits?: Partial<TaskHostLimits>;
  /** Runs at the end of every reaper pass (`sweep`, same `now`): the orchestrator's cleanup. */
  onSweep?: (now: number) => void;
}

interface LaunchedTask {
  taskId: string;
  botId: string;
  conversationId: string;
  writes: boolean;
  workdir: string | null;
  /** The engine slot key (`launchSlot`), null = none. */
  slotKey: string | null;
  launchedAt: number;
  attachedAt: number | null;
  /**
   * Settled while the execution was still unwinding (host stop or the
   * executor's own settle): it keeps counting toward the caps and holding its
   * write target until `finish()` — or until the reaper evicts it.
   */
  settledAt: number | null;
  controller: AbortController;
  handle: TaskRunHandle | null;
  /** The engine run ended (detach): injects can no longer be steered in. */
  closing: boolean;
  /** Why the execution has not started yet (`control.waiting`). */
  waitReason: string | null;
  briefBuilt: boolean;
  /** Injects that arrived after the brief was built but before attach (+ their entries). */
  buffered: Array<{ text: string; entryId: string }>;
  /**
   * Injects the engine run accepted (`steer()` true) but has not confirmed
   * yet, oldest first: an async refusal or a confirmation takes the oldest
   * entry with its text (FIFO).
   */
  steered: Array<{ text: string; entryId: string }>;
  /** Confirmations that arrived before their entry was noted (engines confirming inside `steer()`). */
  confirmedEarly: string[];
}

const ACTIVE_STATUSES: RunStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_lease'];

/** The visible card a task gets in its conversation (design 30 §4.3). */
export const TASK_CARD = 'task';
/** The visible question card of a task waiting for the user (§2.4.6). */
export const TASK_QUESTION_EVENT = 'task_question';

/** Records an accepted steer awaiting its confirmation (unless it was confirmed already). */
function noteSteered(launched: LaunchedTask, item: { text: string; entryId: string }): void {
  const early = launched.confirmedEarly.indexOf(item.text);
  if (early !== -1) launched.confirmedEarly.splice(early, 1);
  else launched.steered.push(item);
}

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
  /**
   * Executions the reaper evicted (settled but never came back) that have not
   * called `finish()` yet: their engine run — an external agent session —
   * may still be busy (审查 L5).
   */
  readonly #evicted = new Set<string>();
  /** Delivered terminal entries waiting for a consuming turn (sweep skips them). */
  readonly #pendingConsumption = new Map<string, number>();
  /**
   * Outcomes whose terminal entry could not be written (main.db error while
   * the conversation still exists): the task stays non-terminal and `sweep`
   * retries the settlement — never a terminal task without its entry.
   */
  readonly #unsettled = new Map<string, TaskOutcome>();
  /**
   * Tasks blocked in `ask_user` (§2.4.6): the visible question card and the
   * waiter its answer (a card option, or the turn's inject_task) resolves.
   */
  readonly #questions = new Map<string, { messageId: string; resolve: (answer: string) => void }>();
  /** Last published queue reason per submitted task (republished only when it changes). */
  readonly #publishedReasons = new Map<string, string | null>();
  #pumping = false;
  #pumpAgain = false;
  /** >0 while a lifecycle abort loops over tasks (pump once at the end). */
  #pumpHeld = 0;

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
    const sources = this.#sourceMessages(conversationId, input.sourceMessageIds);
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
    this.#appendCard(task);
    this.#pump();
    this.publishUpdate(task.id);
    // The row's true state: launched tasks still wait for their write lease /
    // a provider slot while `queued`; one settled synchronously reports its
    // terminal state (its entry tells the rest).
    const current = this.#deps.runs.get(task.id) ?? task;
    if (current.status === 'queued') {
      return { taskId: task.id, state: 'submitted', queueReason: this.#queueReason(current) };
    }
    return { taskId: task.id, state: taskState(current.status), queueReason: null };
  }

  inject(identity: RunIdentity, input: InjectTaskInput): InjectTaskResult {
    const { botId, conversationId } = this.#scope(identity);
    const task = this.#ownTask(botId, conversationId, input.taskId);
    if (isTerminalStatus(task.status)) {
      throw new AppError('RUN_ALREADY_FINISHED', `任务 ${task.id} 已结束（${task.status}）`);
    }
    const text = input.text.trim();
    if (text.length === 0) throw new AppError('INVALID_INPUT', 'text 不能为空');
    const sources = this.#sourceMessages(conversationId, input.sourceMessageIds ?? []);
    const question = this.#questions.get(task.id);
    if (question !== undefined) {
      // The task is blocked on its question card (§2.4.6): the turn relays the
      // user's free-text answer — it is the answer, not a steer.
      this.#deps.messages.appendTaskEvent({
        conversationId,
        ownerBotId: botId,
        taskId: task.id,
        phase: 'inject',
        text,
        sourceMessageIds: sources.map((message) => message.id),
        delivery: 'delivered',
      });
      this.#resolveQuestion(task.id, question, text);
      return { delivery: 'delivered' };
    }
    const launched = this.#launched.get(task.id);
    const steerText = (): string =>
      buildTaskInjection(text, sources, this.#deps.renderOptions(botId));
    let delivery: 'delivered' | 'queued' = 'delivered';
    let buffer = false;
    let steered: string | null = null;
    if (launched?.handle) {
      const text = steerText();
      if (launched.handle.steer(text)) steered = text;
      else delivery = 'queued';
    } else if (launched !== undefined && (launched.closing || launched.settledAt !== null)) {
      // The engine run is over (the execution is settling): nothing will take
      // it in — it only takes effect after the task ends (§4.1 queued).
      delivery = 'queued';
    } else if (launched?.briefBuilt) {
      buffer = true;
    }
    // Not launched / brief not built yet: the entry below is folded into the
    // brief when the task starts (TaskBrief.injects).
    const { message: entry } = this.#deps.messages.appendTaskEvent({
      conversationId,
      ownerBotId: botId,
      taskId: task.id,
      phase: 'inject',
      text,
      sourceMessageIds: sources.map((message) => message.id),
      delivery,
    });
    // Steered at attach; a failure there downgrades the entry to queued.
    if (buffer && launched !== undefined) launched.buffered.push({ text: steerText(), entryId: entry.id });
    // An engine that refuses asynchronously (external agents) reports back by text.
    if (steered !== null && launched !== undefined) {
      noteSteered(launched, { text: steered, entryId: entry.id });
    }
    if (task.awaitingInput) this.#deps.runs.update(task.id, { awaitingInput: false });
    this.publishUpdate(task.id);
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

  /**
   * `ask_user` (§2.4.6): the task asks the user and waits. A visible question
   * card (bound to the task) + the private `question` entry; the task stays
   * running with awaiting_input until the user picks an option on the card
   * (`answerQuestion`, straight into the task) or the turn relays a free-text
   * answer with inject_task. Rejects when `signal` aborts (the task stopped).
   */
  ask(
    identity: RunIdentity,
    input: { question: string; options: string[] },
    signal: AbortSignal,
  ): Promise<string> {
    if (identity.loopType !== 'task') {
      throw new AppError('NOT_SUPPORTED', '只有任务可以向用户提问（对话轮直接在回复里问）');
    }
    const task = this.#deps.runs.get(identity.runId);
    if (task === null || task.loopType !== 'task' || isTerminalStatus(task.status)) {
      throw new AppError('RUN_ALREADY_FINISHED', '任务已结束');
    }
    const { conversationId } = this.#scope(identity);
    if (this.#questions.has(task.id)) {
      throw new AppError('INVALID_INPUT', '上一个问题还没有回答');
    }
    const question = input.question.trim();
    if (question.length === 0) throw new AppError('INVALID_INPUT', 'question 不能为空');
    const card = this.#deps.messages.append({
      conversationId,
      senderType: 'system',
      kind: 'system_event',
      event: TASK_QUESTION_EVENT,
      text: question,
      options: input.options,
      taskId: task.id,
      runId: task.id,
    });
    this.#safely(() => this.#deps.publishMessage?.(card, 'created'));
    return new Promise<string>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.#questions.get(task.id)?.messageId === card.id) this.#questions.delete(task.id);
        reject(new AppError('RUN_ALREADY_FINISHED', '任务已停止，问题作废'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.#questions.set(task.id, {
        messageId: card.id,
        resolve: (answer) => {
          signal.removeEventListener('abort', onAbort);
          resolve(answer);
        },
      });
      try {
        this.recordQuestion(task.id, { text: question, questionMessageId: card.id });
      } catch (error) {
        this.#questions.delete(task.id);
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * The user picked an option on a task question card (§2.4.6): the answer is
   * injected straight into the task (no turn), recorded as an inject entry.
   */
  answerQuestion(messageId: string, answer: string): void {
    const card = this.#deps.messages.getById(messageId);
    const content = card?.content as { event?: unknown; answer?: unknown } | undefined;
    if (card === null || card.kind !== 'system_event' || content?.event !== TASK_QUESTION_EVENT) {
      throw new AppError('NOT_FOUND', '问题卡不存在');
    }
    if (typeof content.answer === 'string') {
      throw new AppError('INVALID_INPUT', '这个问题已经回答过了');
    }
    const taskId = card.taskId ?? '';
    const question = this.#questions.get(taskId);
    const task = this.#deps.runs.get(taskId);
    if (question === undefined || question.messageId !== messageId || task === null) {
      throw new AppError('RUN_ALREADY_FINISHED', '任务已不再等待这个问题的回答');
    }
    const text = answer.trim();
    if (text.length === 0) throw new AppError('INVALID_INPUT', '回答不能为空');
    if (task.botId !== null && task.conversationId !== null) {
      this.#deps.messages.appendTaskEvent({
        conversationId: task.conversationId,
        ownerBotId: task.botId,
        taskId,
        phase: 'inject',
        text: `（用户在问题卡上的回答）${text}`,
        delivery: 'delivered',
      });
    }
    this.#resolveQuestion(taskId, question, text);
  }

  #resolveQuestion(
    taskId: string,
    question: { messageId: string; resolve: (answer: string) => void },
    answer: string,
  ): void {
    this.#questions.delete(taskId);
    this.#safely(() => {
      this.#deps.db
        .prepare(
          "update messages set content_json = json_set(content_json, '$.answer', ?) where id = ? and kind = 'system_event'",
        )
        .run(answer, question.messageId);
      const updated = this.#deps.messages.getById(question.messageId);
      if (updated !== null) this.#deps.publishMessage?.(updated, 'updated');
    });
    const task = this.#deps.runs.get(taskId);
    if (task?.awaitingInput === true) {
      this.#safely(() =>
        this.#deps.publishRunStatus(this.#deps.runs.update(taskId, { awaitingInput: false })),
      );
    }
    question.resolve(answer);
    this.publishUpdate(taskId);
  }

  // --- views (D75 W3, design 30 §4.3 / §6.3) ----------------------------------

  /** The card / status-line projection of a task (null = not a task). */
  view(taskId: string): TaskView | null {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') return null;
    const terminal = isTerminalStatus(task.status);
    const injects: TaskView['injects'] = [];
    let cancelReason: string | null = null;
    let continuesTaskId: string | null = task.continuedFromRunIds[0] ?? null;
    let questionMessageId: string | null = null;
    for (const event of this.#deps.messages.taskEvents(task.id)) {
      const content = taskEventOf(event);
      if (content === null) continue;
      if (content.phase === 'inject') {
        injects.push({
          messageId: event.id,
          text: content.text,
          delivery: content.delivery ?? 'delivered',
          at: event.createdAt,
        });
      } else if (content.phase === 'cancel') {
        cancelReason ??= content.text;
      } else if (content.phase === 'brief') {
        continuesTaskId = content.continuesTaskId ?? continuesTaskId;
      } else if (content.phase === 'question') {
        questionMessageId = content.questionMessageId ?? questionMessageId;
      }
    }
    let workdir: { kind: 'project' | 'workspace'; changes: TaskChanges | null } | null = null;
    try {
      workdir = this.#deps.describeWorkdir?.(task) ?? null;
    } catch (error) {
      this.#deps.logger.warn(
        { taskId, error: error instanceof Error ? error.message : String(error) },
        'task workdir lookup failed',
      );
    }
    const continuedBy =
      task.botId !== null && task.conversationId !== null
        ? (this.#deps.runs
            .listTasks({ conversationId: task.conversationId, botId: task.botId })
            .find((candidate) => candidate.continuedFromRunIds.includes(task.id))?.id ?? null)
        : null;
    const summary = this.#summary(task);
    return {
      taskId: task.id,
      botId: task.botId,
      conversationId: task.conversationId,
      title: task.taskTitle ?? '',
      state: taskState(task.status),
      status: task.status,
      writes: task.taskWrites === true,
      workdirKind: workdir?.kind ?? null,
      queueReason: terminal ? null : summary.queueReason,
      awaitingInput: task.awaitingInput,
      questionMessageId: task.awaitingInput ? questionMessageId : null,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      error: task.error,
      cancelReason,
      injects,
      lastProgress: summary.lastProgress,
      changes: task.taskWrites === true && terminal ? (workdir?.changes ?? null) : null,
      setup: task.setup ?? null,
      continuesTaskId,
      continuedByTaskId: continuedBy,
    };
  }

  /** Views of a conversation's non-terminal tasks (status line on conversation open). */
  activeViews(conversationId: string): TaskView[] {
    return this.#deps.runs
      .listTasks({ conversationId, statuses: ACTIVE_STATUSES })
      .map((task) => this.view(task.id))
      .filter((view): view is TaskView => view !== null);
  }

  /** Pushes the task's view (`task.updated`); called on every visible change. */
  publishUpdate(taskId: string): void {
    const publish = this.#deps.publishTask;
    if (publish === undefined) return;
    this.#safely(() => {
      const view = this.view(taskId);
      if (view === null) return;
      if (view.state === 'submitted') this.#publishedReasons.set(taskId, view.queueReason);
      else this.#publishedReasons.delete(taskId);
      publish(view);
    });
  }

  /** The task's visible card (§4.3): a shared card row bound to the task. */
  #appendCard(task: Run): void {
    if (task.conversationId === null) return;
    const conversationId = task.conversationId;
    this.#safely(() => {
      const card = this.#deps.messages.append({
        conversationId,
        senderType: 'system',
        kind: 'card',
        cardType: TASK_CARD,
        cardRunId: task.id,
        taskId: task.id,
      });
      this.#deps.publishMessage?.(card, 'created');
    });
  }

  // --- settlement (§3.2 / §3.3) ----------------------------------------------

  /**
   * Settles a task: terminal entry (main.db) → task terminal (runs.db) → wake
   * decision → delivery. Idempotent: a task already terminal is left as is
   * (a host-stopped task's executor lands here afterwards).
   */
  settle(taskId: string, reported: TaskOutcome): Run | null {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') return null;
    if (isTerminalStatus(task.status)) {
      this.#unsettled.delete(taskId);
      return task;
    }
    // A settlement whose entry write failed earlier keeps its outcome (the
    // host's decision — cancel, forced failure — wins over the unwinding
    // executor's report).
    const outcome = this.#unsettled.get(taskId) ?? reported;
    let error = outcome.error ?? null;
    let entry: Message | null = null;
    let created = true;
    if (task.botId !== null && task.conversationId !== null) {
      const written = this.#safeAppend(
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
      if (written === null && this.#deps.conversations.get(task.conversationId) !== null) {
        // §3.2: no terminal status (and no consumption) without the terminal
        // entry while there is a conversation to hold it — the result would be
        // lost. Stop the execution, keep the outcome, let `sweep` retry.
        this.#unsettled.set(taskId, outcome);
        const launched = this.#launched.get(taskId);
        if (launched !== undefined) {
          launched.settledAt ??= this.#deps.clock.now();
          launched.controller.abort();
        }
        return task;
      }
      entry = written?.message ?? null;
      created = written?.created ?? true;
    }
    this.#unsettled.delete(taskId);
    // A question still open dies with the task (its tool call was aborted).
    this.#questions.delete(taskId);
    // An earlier writer may have won the unique index: the stored entry is
    // the source of truth for the final status (and its error).
    const status = entry !== null ? statusOfTerminalEntry(entry) : outcome.status;
    if (!created && entry !== null) error = taskEventOf(entry)?.error ?? null;
    const updated = this.#deps.runs.update(taskId, {
      status,
      ...(status !== 'completed' && error !== null ? { error } : {}),
      ...(outcome.setup !== undefined ? { setup: outcome.setup } : {}),
    });
    const launched = this.#launched.get(taskId);
    if (launched !== undefined) {
      launched.settledAt ??= this.#deps.clock.now();
      launched.controller.abort();
    }
    this.#cleanup(updated, launched !== undefined);
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

  /**
   * A turn did not see these results after all (an external agent refused the
   * steer that carried them after its run already marked them consumed): the
   * consumption is undone so a crash before the re-delivered batch is consumed
   * cannot lose them (§3.2 — at-least-once). The re-delivery is the caller's.
   */
  reopenConsumption(taskIds: Iterable<string>): void {
    const now = this.#deps.clock.now();
    for (const taskId of new Set(taskIds)) {
      const task = this.#deps.runs.get(taskId);
      if (task === null || task.loopType !== 'task' || task.resultConsumedAt === null) continue;
      this.#deps.runs.update(taskId, { resultConsumedAt: null });
      // Delivered just now (by the caller): the reconciliation waits for it.
      this.#pendingConsumption.set(taskId, now);
    }
  }

  /**
   * Retries a failed task (design 30 §7.5: after the setup it failed on is
   * completed — the setup card's automatic retry): a new task continuing it
   * (`continues_task_id`) with the same brief, source messages and pre-start
   * injects, attributed to the same originating turn (the per-turn cap does
   * not apply: it is the same dispatch). Idempotent: an existing continuation
   * of the task is returned instead of a second one.
   */
  retry(taskId: string): Run {
    const task = this.#deps.runs.get(taskId);
    if (task === null || task.loopType !== 'task') {
      throw new AppError('RUN_NOT_FOUND', `任务 ${taskId} 不存在`);
    }
    if (task.status !== 'failed') {
      throw new AppError('INVALID_INPUT', `任务 ${task.id} 不是失败状态（${task.status}）`);
    }
    if (task.botId === null || task.conversationId === null) {
      throw new AppError('INVALID_INPUT', '任务缺少 Bot 或对话，无法重试');
    }
    const { botId, conversationId } = task;
    const existing = this.#deps.runs
      .listTasks({ conversationId, botId })
      .find((candidate) => candidate.continuedFromRunIds.includes(task.id));
    if (existing !== undefined) return existing;
    if (!this.#canWake(botId, conversationId)) {
      throw new AppError('INVALID_INPUT', '对话不可用（只读、已删除，或 Bot 已不在其中）');
    }
    const events = this.#deps.messages
      .taskEvents(task.id)
      .map((event) => taskEventOf(event))
      .filter((content): content is TaskEventContent => content !== null);
    const brief = events.find((content) => content.phase === 'brief');
    if (brief === undefined) {
      throw new AppError('INVALID_INPUT', '任务的交代条目缺失，无法重试：请让 Bot 重新派出');
    }
    const sourceIds = (brief.sourceMessageIds ?? []).filter((id) => {
      const message = this.#deps.messages.getById(id);
      return message !== null && message.status !== 'recalled';
    });
    const title = task.taskTitle ?? brief.title ?? '';
    const writes = task.taskWrites === true;
    const retried = this.#deps.runs.create({
      botId,
      conversationId,
      loopType: 'task',
      triggerReason: null,
      triggerMessageIds: sourceIds,
      taskTitle: title,
      taskWrites: writes,
      taskWorkdir: task.taskWorkdir,
      originRunId: task.originRunId,
      continuedFromRunIds: [task.id],
    });
    this.#deps.publishRunStatus(retried);
    this.#deps.messages.appendTaskEvent({
      conversationId,
      ownerBotId: botId,
      taskId: retried.id,
      phase: 'brief',
      text: brief.text,
      sourceMessageIds: sourceIds,
      title,
      writes,
      continuesTaskId: task.id,
    });
    // Later instructions the failed task got (folded into the new brief).
    for (const inject of events) {
      if (inject.phase !== 'inject') continue;
      this.#deps.messages.appendTaskEvent({
        conversationId,
        ownerBotId: botId,
        taskId: retried.id,
        phase: 'inject',
        text: inject.text,
        sourceMessageIds: inject.sourceMessageIds ?? [],
      });
    }
    this.#appendCard(retried);
    this.#pump();
    this.publishUpdate(retried.id);
    this.publishUpdate(task.id);
    return this.#deps.runs.get(retried.id) ?? retried;
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
        // Cancelled (cancel entry written) but the crash came before the
        // settlement: honour the cancel — never re-launch or wake for it.
        const cancelEntry = this.#deps.messages
          .taskEvents(task.id)
          .find((event) => taskEventOf(event)?.phase === 'cancel');
        if (cancelEntry !== undefined) {
          const reason = `已取消：${taskEventOf(cancelEntry)?.text ?? ''}`;
          const settled = this.#recoverySettle(task, { status: 'cancelled', error: reason });
          // Consumed by the reconciliation in resume() (cancelled never wakes).
          if (settled !== null) repaired.push(settled);
          continue;
        }
        if (task.status === 'queued') continue;
        const error = '应用退出，任务中断';
        const settled = this.#recoverySettle(task, { status: 'interrupted', error });
        if (settled !== null) repaired.push(settled);
      } catch (error) {
        this.#deps.logger.warn(
          { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
          'task repair failed',
        );
      }
    }
    for (const run of repaired) this.#cleanup(run, false);
    if (repaired.length > 0) {
      this.#deps.logger.info({ tasks: repaired.length }, 'repaired unsettled tasks');
    }
    return repaired;
  }

  /**
   * Recovery's settlement of a task this process never launched: the entry
   * first (§3.2). When it cannot be written while the conversation exists,
   * the row stays as it is and the outcome waits in #unsettled for `sweep`
   * (never re-launched meanwhile). Null = left pending.
   */
  #recoverySettle(task: Run, outcome: { status: 'cancelled' | 'interrupted'; error: string }): Run | null {
    if (task.botId !== null && task.conversationId !== null) {
      const written = this.#safeAppend({
        conversationId: task.conversationId,
        ownerBotId: task.botId,
        taskId: task.id,
        phase: 'failure',
        text: this.#failureText(task, outcome.status, outcome.error),
        status: outcome.status,
        error: outcome.error,
      });
      if (written === null && this.#deps.conversations.get(task.conversationId) !== null) {
        this.#unsettled.set(task.id, outcome);
        return null;
      }
    }
    return this.#deps.runs.update(task.id, { status: outcome.status, error: outcome.error });
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
    for (const [taskId, outcome] of [...this.#unsettled]) {
      try {
        this.settle(taskId, outcome);
      } catch (error) {
        this.#deps.logger.warn(
          { taskId, error: error instanceof Error ? error.message : String(error) },
          'task settlement retry failed',
        );
      }
    }
    for (const launched of [...this.#launched.values()]) {
      if (launched.settledAt !== null) {
        // Settled but its execution never came back (a stuck tool / engine):
        // stop holding the slot and the write lease.
        if (now - launched.settledAt > TASK_SETTLE_SWEEP_MS) {
          this.#deps.logger.warn({ taskId: launched.taskId }, 'evicting a stuck task execution');
          this.#launched.delete(launched.taskId);
          this.#evicted.add(launched.taskId);
          this.#safely(() => this.#deps.releaseExecution(launched.taskId));
        }
        continue;
      }
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
    this.#pump();
    this.#reconcile(now);
    const onSweep = this.#deps.onSweep;
    if (onSweep !== undefined) this.#safely(() => onSweep(now));
  }

  /**
   * Whether an execution of the task is still live (launched and not yet
   * finished — its engine run may still hold resources, e.g. an external
   * agent session, design 30 §8.5). An execution the reaper evicted counts
   * until it really finishes: its slot and lease are freed, its session is not.
   */
  isExecuting(taskId: string): boolean {
    return this.#launched.has(taskId) || this.#evicted.has(taskId);
  }

  // --- lifecycle --------------------------------------------------------------

  /** Conversation deleted: its tasks are cancelled (no wake: nobody to wake). */
  abortForConversation(conversationId: string, reason = 'conversation deleted'): void {
    this.#stopAll(this.#deps.runs.listTasks({ conversationId, statuses: ACTIVE_STATUSES }), reason);
  }

  /** Bot deleted: all its tasks are cancelled. */
  abortForBot(botId: string, reason = 'bot deleted'): void {
    this.#stopAll(this.#deps.runs.listTasks({ botId, statuses: ACTIVE_STATUSES }), reason);
  }

  /** Bot removed from a group: its tasks in that conversation are cancelled. */
  abortForBotInConversation(
    botId: string,
    conversationId: string,
    reason = 'removed from group',
  ): void {
    this.#stopAll(
      this.#deps.runs.listTasks({ botId, conversationId, statuses: ACTIVE_STATUSES }),
      reason,
    );
  }

  /** Cancels a set of tasks without starting their queued siblings mid-loop. */
  #stopAll(tasks: Run[], reason: string): void {
    this.#pumpHeld += 1;
    try {
      for (const task of tasks) this.#stop(task.id, 'cancelled', reason);
    } finally {
      this.#pumpHeld -= 1;
    }
    this.#pump();
  }

  /** Tasks launched in this process (executing, about to, or still unwinding). */
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

  /**
   * Source messages must be shared rows of the conversation (§2.4.5: the
   * brief carries the user's originals, never private task entries).
   */
  #sourceMessages(conversationId: string, ids: string[]): Message[] {
    const messages: Message[] = [];
    for (const id of [...new Set(ids)]) {
      const message = this.#deps.messages.getById(id);
      if (message === null || message.conversationId !== conversationId) {
        throw new AppError('INVALID_INPUT', `消息 ${id} 不属于本对话`);
      }
      if (message.ownerBotId !== null) {
        throw new AppError('INVALID_INPUT', `消息 ${id} 是任务的私有条目，不能作为原消息`);
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
    if (this.#pumpHeld > 0) return;
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
          // Stopped, its settlement pending (#unsettled): never launched again.
          if (this.#unsettled.has(task.id)) continue;
          if (this.#launched.size >= this.#limits.global) break;
          if (this.#blockedBy(task) !== null) continue;
          this.#launch(task);
        }
      } while (this.#pumpAgain);
    } finally {
      this.#pumping = false;
    }
    this.#publishQueueReasons();
  }

  /** Republishes submitted tasks whose queue reason changed (a slot / the lease moved). */
  #publishQueueReasons(): void {
    if (this.#deps.publishTask === undefined) return;
    let queued: Run[];
    try {
      queued = this.#deps.runs.listTasks({ statuses: ['queued'] });
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const task of queued) {
      seen.add(task.id);
      const reason = this.#queueReason(task);
      if (this.#publishedReasons.get(task.id) === reason) continue;
      this.publishUpdate(task.id);
    }
    for (const taskId of [...this.#publishedReasons.keys()]) {
      if (!seen.has(taskId)) this.#publishedReasons.delete(taskId);
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
    const slot = this.#launchSlot(task);
    if (slot !== null) {
      let onSlot = 0;
      for (const launched of this.#launched.values()) {
        if (launched.slotKey === slot.key) onSlot += 1;
      }
      if (onSlot >= slot.limit) {
        return `等智能体并发额度（${slot.key} ${onSlot}/${slot.limit}）`;
      }
    }
    return null;
  }

  #launchSlot(task: Run): { key: string; limit: number } | null {
    const resolve = this.#deps.launchSlot;
    if (resolve === undefined) return null;
    try {
      return resolve(task);
    } catch (error) {
      this.#deps.logger.warn(
        { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
        'task launch slot lookup failed',
      );
      return null;
    }
  }

  #queueReason(task: Run): string | null {
    if (isTerminalStatus(task.status)) return null;
    const launched = this.#launched.get(task.id);
    if (launched !== undefined) {
      return task.status === 'queued' ? (launched.waitReason ?? '启动中') : null;
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
      slotKey: this.#launchSlot(task)?.key ?? null,
      launchedAt: this.#deps.clock.now(),
      attachedAt: null,
      settledAt: null,
      controller: new AbortController(),
      handle: null,
      closing: false,
      waitReason: null,
      briefBuilt: false,
      buffered: [],
      steered: [],
      confirmedEarly: [],
    };
    this.#launched.set(task.id, launched);
    const control: TaskRunControl = {
      taskId: task.id,
      signal: launched.controller.signal,
      brief: () => this.#brief(task.id),
      attach: (handle) => this.#attach(task.id, handle),
      detach: () => {
        launched.handle = null;
        launched.closing = true;
      },
      waiting: (reason) => {
        launched.waitReason = reason;
        this.publishUpdate(task.id);
      },
      steerRefused: (text) => {
        const index = launched.steered.findIndex((item) => item.text === text);
        if (index === -1) return;
        this.#injectsNotDelivered(task.id, launched.steered.splice(index, 1));
      },
      steerConfirmed: (text) => {
        const index = launched.steered.findIndex((item) => item.text === text);
        if (index !== -1) launched.steered.splice(index, 1);
        else launched.confirmedEarly.push(text);
      },
      finish: () => {
        // Buffered injects that never reached an engine run.
        this.#injectsNotDelivered(task.id, launched.buffered.splice(0));
        this.#evicted.delete(task.id);
        if (this.#launched.get(task.id) !== launched) return;
        this.#launched.delete(task.id);
        this.#pump();
      },
    };
    try {
      this.#deps.execute(task, control);
    } catch (error) {
      this.settle(task.id, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      control.finish();
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
    if (launched === undefined || launched.settledAt !== null) {
      // Stopped while starting: the host already settled it.
      this.#injectsNotDelivered(taskId, launched?.buffered.splice(0) ?? []);
      handle.abort('task stopped');
      return;
    }
    launched.handle = handle;
    launched.attachedAt = this.#deps.clock.now();
    const refused = launched.buffered.splice(0).filter((item) => {
      if (!handle.steer(item.text)) return true;
      noteSteered(launched, item);
      return false;
    });
    if (refused.length > 0) {
      this.#deps.logger.warn({ taskId }, 'buffered task inject could not be steered');
      this.#injectsNotDelivered(taskId, refused);
    }
    if (launched.controller.signal.aborted) handle.abort('task stopped');
  }

  /**
   * Buffered injects that reached no engine run after all: their entries are
   * downgraded to `queued` (§4.1 — the bot sees they did not take effect).
   */
  #injectsNotDelivered(taskId: string, items: Array<{ entryId: string }>): void {
    if (items.length === 0) return;
    for (const item of items) {
      this.#safely(() => {
        this.#deps.db
          .prepare(
            "update messages set content_json = json_set(content_json, '$.delivery', 'queued') where id = ? and kind = 'task_event'",
          )
          .run(item.entryId);
      });
    }
    // The card's inject line turns into 「未送达」 (§4.3).
    this.publishUpdate(taskId);
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

  #cleanup(run: Run, executorActive: boolean): void {
    this.#safely(() => this.#deps.onSettled(run, executorActive));
  }

  #safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.#deps.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'task cleanup failed',
      );
    }
  }

  /** Wake decision (§3.3) + delivery, or consumption right away. */
  #afterTerminal(run: Run, entry: Message | null): void {
    if (
      entry === null &&
      run.botId !== null &&
      run.conversationId !== null &&
      this.#deps.conversations.get(run.conversationId) !== null
    ) {
      // The entry is missing but could still be written: never consume
      // without it — the reconciliation writes it and delivers (§3.2).
      return;
    }
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
    this.#pendingConsumption.set(run.id, this.#deps.clock.now());
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
  #reconcile(now: number = this.#deps.clock.now()): void {
    for (const task of this.#deps.runs.listUnconsumedTerminalTasks()) {
      // Delivered and awaiting its consuming turn — unless that was long ago
      // (the delivery got lost): then deliver again (at-least-once).
      const deliveredAt = this.#pendingConsumption.get(task.id);
      if (deliveredAt !== undefined && now - deliveredAt <= TASK_REDELIVER_AFTER_MS) continue;
      try {
        let entry = this.#deps.messages.terminalTaskEvent(task.id);
        if (entry === null && task.botId !== null && task.conversationId !== null) {
          // Settled outside the task host (should not happen): give the bot a
          // failure entry rather than silence.
          const status = task.status === 'completed' ? 'failed' : task.status;
          entry =
            this.#safeAppend({
              conversationId: task.conversationId,
              ownerBotId: task.botId,
              taskId: task.id,
              phase: 'failure',
              text: this.#failureText(task, status, task.error ?? '任务的结算记录缺失'),
              status,
              error: task.error ?? '任务的结算记录缺失',
            })?.message ?? null;
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
  #safeAppend(
    input: Parameters<MessagesService['appendTaskEvent']>[0],
  ): { message: Message; created: boolean } | null {
    try {
      return this.#deps.messages.appendTaskEvent(input);
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

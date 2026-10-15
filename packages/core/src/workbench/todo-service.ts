import {
  AppError,
  TODO_CLOSED_VISIBLE_MS,
  TODO_NOTES_MAX_CHARS,
  TODO_TITLE_MAX_CHARS,
  type Conversation,
  type Message,
  type Schedule,
  type Todo,
  type TodoAssignee,
  type TodoEntry,
  type TodoRun,
  type TodoSource,
  type TodoStatus,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { ScheduleService, WorkbenchDispatchPort } from '../schedule/service.js';
import { MemoStore } from './memo-store.js';
import { TodoStore } from './todo-store.js';

/**
 * Allowed status moves of a todo (docs/design/39-workbench.md §2.1). A periodic todo stays in
 * `scheduled` across its dispatches (only its runs advance), so there is no self-move here.
 * `delivered → in_progress` is the user's 「退回」 (P1).
 */
export const TODO_TRANSITIONS: Readonly<Record<TodoStatus, readonly TodoStatus[]>> = {
  draft: ['scheduled', 'in_progress', 'cancelled'],
  scheduled: ['draft', 'in_progress', 'cancelled'],
  in_progress: ['delivered', 'draft', 'done', 'cancelled'],
  delivered: ['in_progress', 'done', 'cancelled'],
  done: ['draft'],
  cancelled: ['draft'],
};

export function canTransitionTodo(from: TodoStatus, to: TodoStatus): boolean {
  return TODO_TRANSITIONS[from].includes(to);
}

const STATUS_LABEL: Record<TodoStatus, string> = {
  draft: '草案',
  scheduled: '已排期',
  in_progress: '进行中',
  delivered: '待验收',
  done: '已完成',
  cancelled: '已取消',
};

/** Blocked reasons shown on a todo that fell back to draft (docs/design/39-workbench.md §2.1). */
export const BLOCKED_BOT_DELETED = '执行者 Bot 已删除';
export const BLOCKED_LEAD_DELETED = '负责 Bot 已删除';
export const BLOCKED_LEAD_LEFT = '负责 Bot 已移出群';
export const BLOCKED_GROUP_GONE = '群已解散';
export const BLOCKED_SCHEDULE_CANCELLED = '排期已取消';
export const BLOCKED_CONVERSATION_DELETED = '对话已删除，排期已取消';
export const BLOCKED_UNCLAIMED = '群里无人认领';
export const BLOCKED_CONVERSATION_GONE = '对话已删除';
export const BLOCKED_RUN_CANCELLED = '执行已被取消';
export const BLOCKED_RUN_FAILED_PREFIX = '执行失败：';
export const BLOCKED_DISPATCH_FAILED_PREFIX = '派发失败：';
/** The executor is still in its setup interview: the dispatch waits behind the delivery gate. */
export const BLOCKED_HELD = '该 Bot 正在设置中，完成设置后才会处理';

/** A todo run that did not deliver because its executor's turn failed / was cancelled. */
export type TodoRunFailure = { kind: 'failed'; error: string | null } | { kind: 'cancelled' };

/** The dispatch prefix of a workbench message (the first line reads 「【工作台】标题」). */
export const WORKBENCH_DISPATCH_TAG = '【工作台】';
export const WORKBENCH_BUTLER_NOTE = '（管家代你安排）';

/** What TodoService needs of the orchestrator to append + route a dispatch message. */
export interface WorkbenchMessagePort {
  dispatch(input: {
    conversationId: string;
    text: string;
    todoId: string;
    todoRunId: string;
    /** The operation that triggered this dispatch was the butler's. */
    viaButler: boolean;
    /** The todo was drafted by the butler (`source='butler'`): its notes may carry external content. */
    butlerDrafted: boolean;
    /** Group assignee's lead bot: the message @-mentions it (explicit target). */
    leadBotId: string | null;
    /** Runs after the message is stored + published, before it is routed to a bot. */
    onAppended?: ((message: Message) => void) | undefined;
  }): {
    message: Message;
    runId: string | null;
    /** The delivery is held back (the bot is in its setup interview) until setup is done. */
    held?: boolean | undefined;
  };
  /** Whether the bot has a built-in main model to run a turn on. */
  hasTurnModel(botId: string): boolean;
}

export interface TodoServiceDeps {
  db: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  bots: BotsService;
  conversations: ConversationsService;
  schedules: ScheduleService;
  dispatcher: WorkbenchMessagePort;
  /** RPC events (todos.changed / conversation.updated). */
  publish?: ((event: string, payload: unknown) => void) | undefined;
}

/**
 * Who performs an operation: the user themselves, or the butler through its tools. It decides how
 * a dispatch is attributed (「（管家代你安排）」, `viaButler`); the todo's `source` only records who
 * created it.
 */
export type TodoActor = TodoSource;

export interface CreateTodoInput {
  title: string;
  notes?: string | undefined;
  assignee?: TodoAssignee | null | undefined;
  /** 'now' | ISO 8601 | cron | null / undefined = not scheduled. */
  when?: string | null | undefined;
  memoId?: string | undefined;
  /** Who created the todo (stored). Default 'user'. */
  source?: TodoSource | undefined;
  /** Who performs this call (attributes an immediate dispatch / the schedule). Default = `source`. */
  actor?: TodoActor | undefined;
}

export interface UpdateTodoInput {
  title?: string | undefined;
  notes?: string | undefined;
  /** undefined = unchanged, null = clear (also clears the schedule). */
  assignee?: TodoAssignee | null | undefined;
  /** undefined = unchanged, null = clear the schedule, 'now' = dispatch immediately. */
  when?: string | null | undefined;
  /** Who performs this call. Default 'user'. */
  actor?: TodoActor | undefined;
}

export interface ListTodosInput {
  statuses?: readonly TodoStatus[] | undefined;
  query?: string | undefined;
  includeClosed?: boolean | undefined;
}

interface DispatchContext {
  scheduleId?: string;
  fireAt?: number;
  lateByMs?: number | null;
  /**
   * The caller ends the todo's schedule right after dispatching (update `when:'now'`): a
   * periodic todo then leaves `scheduled` for `in_progress` instead of staying parked.
   */
  consumeSchedule?: boolean;
  /** Who triggered this dispatch (a due schedule: whoever last set it). */
  actor: TodoActor;
}

const NOW = 'now';

/**
 * Workbench todos (D90, docs/design/39-workbench.md): CRUD and the status machine,
 * assignee validation, scheduling through ScheduleService, dispatch (a visible user message
 * routed like a typed one), delivery tracking and reconciliation. The invariants it keeps:
 *
 * - a time needs an assignee;
 * - an active schedule with `todo_id` exists exactly while the todo is `scheduled`.
 *
 * Reconciliation (startup, `schedules.changed`, deletions) is the safety net for every path
 * that bypasses the service: conversation deletion cascades through foreign keys, the user
 * cancelling the receipt's schedule, a deleted bot.
 */
export class TodoService implements WorkbenchDispatchPort {
  readonly store: TodoStore;
  readonly memos: MemoStore;
  readonly #deps: TodoServiceDeps;
  /** > 0 while an operation of this service is mid-flight: reconcile stays out of its way. */
  #busy = 0;
  /** A reconcile was requested while busy: it runs once the outermost operation ends. */
  #reconcilePending = false;

  constructor(deps: TodoServiceDeps) {
    this.#deps = deps;
    this.store = new TodoStore(deps.db, deps.clock);
    this.memos = new MemoStore(deps.db, deps.clock);
  }

  // --- queries -----------------------------------------------------------------

  list(input: ListTodosInput = {}): TodoEntry[] {
    const closedAfter =
      input.includeClosed === true ? undefined : this.#deps.clock.now() - TODO_CLOSED_VISIBLE_MS;
    return this.store
      .list({
        ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(closedAfter !== undefined ? { closedAfter } : {}),
      })
      .map((todo) => this.toEntry(todo));
  }

  get(id: string): { todo: TodoEntry; runs: TodoRun[] } {
    const todo = this.#getOrThrow(id);
    return { todo: this.toEntry(todo), runs: this.store.listRuns(id) };
  }

  /** The title of a todo (「📋 标题」 tag); null when it is gone. */
  titleOf(id: string): string | null {
    return this.store.get(id)?.title ?? null;
  }

  toEntry(todo: Todo): TodoEntry {
    const { assignee } = todo;
    let assigneeName: string | null = null;
    let leadBotName: string | null = null;
    if (assignee?.kind === 'bot') {
      assigneeName = this.#botName(assignee.botId);
    } else if (assignee?.kind === 'group') {
      assigneeName = this.#deps.conversations.get(assignee.conversationId)?.title ?? null;
      leadBotName = assignee.leadBotId === null ? null : this.#botName(assignee.leadBotId);
    }
    const schedule = this.#activeSchedule(todo.id);
    return {
      ...todo,
      assigneeName,
      leadBotName,
      schedule:
        schedule === null
          ? null
          : {
              id: schedule.id,
              kind: schedule.kind,
              runAt: schedule.runAt,
              cron: schedule.cron,
              timezone: schedule.timezone,
              nextFireAt: schedule.nextFireAt,
            },
      lastRun: this.store.lastRun(todo.id),
    };
  }

  // --- create / update ---------------------------------------------------------

  create(input: CreateTodoInput): { todo: TodoEntry; warnings: string[] } {
    const title = cleanTitle(input.title);
    const notes = cleanNotes(input.notes);
    const assignee = input.assignee ?? null;
    const when = parseWhen(input.when);
    if (when !== null && assignee === null) {
      throw new AppError('INVALID_INPUT', '设置时间前请先选择执行者');
    }
    if (assignee !== null) this.#validateAssignee(assignee);
    // Parse before anything is written: a bad `when` must not leave a half-made todo.
    if (when !== null && when !== NOW) this.#deps.schedules.validateWhen(when);
    if (input.memoId !== undefined && this.memos.get(input.memoId) === null) {
      throw new AppError('NOT_FOUND', `备忘 ${input.memoId} 不存在`);
    }
    const actor: TodoActor = input.actor ?? input.source ?? 'user';
    return this.#guard(() => {
      const todo = this.store.insert({
        title,
        notes,
        assignee,
        source: input.source ?? 'user',
        ...(input.memoId !== undefined ? { memoId: input.memoId } : {}),
      });
      this.#changed(todo.id);
      let current = todo;
      try {
        if (when === NOW) current = this.#dispatch(todo, { actor });
        else if (when !== null) current = this.#schedule(todo, when, undefined, actor);
      } catch (error) {
        // The todo is kept as a draft with the reason; the caller still gets the error.
        this.store.update(todo.id, {
          blockedReason: `${BLOCKED_DISPATCH_FAILED_PREFIX}${errorText(error)}`,
        });
        this.#changed(todo.id);
        throw error;
      }
      const fresh = this.store.get(todo.id) ?? current;
      return { todo: this.toEntry(fresh), warnings: this.#warnings(fresh) };
    });
  }

  update(id: string, input: UpdateTodoInput): { todo: TodoEntry; warnings: string[] } {
    const actor: TodoActor = input.actor ?? 'user';
    const todo = this.#getOrThrow(id);
    if (todo.status === 'done' || todo.status === 'cancelled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，请先重新打开再修改`);
    }
    const titleChanged = input.title !== undefined && cleanTitle(input.title) !== todo.title;
    const when = input.when === undefined ? undefined : parseWhen(input.when);
    // Sending the assignee the todo already has is no change.
    const assigneeChanged =
      input.assignee !== undefined && !sameAssignee(todo.assignee, input.assignee);
    const timingTouched = assigneeChanged || when !== undefined;
    // A todo already handed to its executor keeps its executor and time; periodic ones
    // (parked in `scheduled`) stay editable.
    if (timingTouched && todo.status !== 'draft' && todo.status !== 'scheduled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不能改派或改期`);
    }
    const nextAssignee = input.assignee === undefined ? todo.assignee : input.assignee;
    if (typeof when === 'string' && nextAssignee === null) {
      throw new AppError('INVALID_INPUT', '设置时间前请先选择执行者');
    }
    if (assigneeChanged && input.assignee !== null && input.assignee !== undefined) {
      this.#validateAssignee(input.assignee);
    }
    if (typeof when === 'string' && when !== NOW) this.#deps.schedules.validateWhen(when);

    return this.#guard(() => {
      const fields = (): Todo => {
        let current = todo;
        if (input.title !== undefined || input.notes !== undefined) {
          current =
            this.store.update(id, {
              ...(input.title !== undefined ? { title: cleanTitle(input.title) } : {}),
              ...(input.notes !== undefined ? { notes: cleanNotes(input.notes) } : {}),
            }) ?? current;
          const schedule = this.#activeSchedule(id);
          if (schedule !== null && (titleChanged || input.notes !== undefined)) {
            this.#deps.schedules.retitle(schedule.id, current.title, current.notes);
          }
        }
        return current;
      };

      if (when === NOW) {
        // 「改成立即执行一次」: the schedule — a periodic one too — ends and the todo is
        // dispatched once (unlike `start`, which leaves a periodic schedule running). Routing
        // stays outside the transaction; the schedule is only cancelled once it succeeded.
        let current = this.#tx(() => {
          const updated = fields();
          return assigneeChanged ? this.#applyAssignee(updated, input.assignee!) : updated;
        });
        try {
          current = this.#dispatch(current, { consumeSchedule: true, actor });
        } catch (error) {
          if (assigneeChanged) {
            this.store.update(id, { assignee: todo.assignee, blockedReason: todo.blockedReason });
          }
          this.#changed(id);
          throw error;
        }
        this.#cancelSchedules(id);
        this.#changed(id);
        const fresh = this.store.get(id) ?? current;
        return { todo: this.toEntry(fresh), warnings: this.#warnings(fresh) };
      }

      this.#tx(() => {
        let current = fields();
        if (assigneeChanged && input.assignee === null) {
          // Clearing the assignee clears the schedule and sends the todo back to draft.
          this.#toDraft(current, { assignee: null, blockedReason: null });
        } else if (typeof when === 'string') {
          if (assigneeChanged) current = this.#applyAssignee(current, input.assignee!);
          this.#schedule(current, when, undefined, actor);
        } else if (when === null) {
          // 「退回草案」: the schedule goes; a simultaneous reassignment is kept.
          if (assigneeChanged) current = this.#applyAssignee(current, input.assignee!);
          this.#toDraft(current, { blockedReason: null });
        } else if (assigneeChanged) {
          this.#reassign(current, input.assignee!, actor);
        }
      });
      this.#changed(id);
      const fresh = this.store.get(id) ?? todo;
      return { todo: this.toEntry(fresh), warnings: this.#warnings(fresh) };
    });
  }

  // --- transitions ---------------------------------------------------------------

  /** 立即开始: dispatches a draft (or scheduled) todo now; needs an assignee. */
  start(id: string, actor: TodoActor = 'user'): TodoEntry {
    const todo = this.#getOrThrow(id);
    if (todo.status !== 'draft' && todo.status !== 'scheduled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不能立即开始`);
    }
    if (todo.assignee === null) throw new AppError('INVALID_INPUT', '请先选择执行者');
    this.#validateAssignee(todo.assignee);
    return this.#guard(() => {
      const schedule = this.#activeSchedule(id);
      // Dispatch first: if routing throws, the schedule is still there. A one-off schedule is
      // replaced by this dispatch; a periodic one keeps running (and the todo stays
      // `scheduled`) — compare update `when:'now'`, which ends the periodic schedule.
      const dispatched = this.#dispatch(this.#getOrThrow(id), { actor });
      if (schedule !== null && schedule.kind === 'once') this.#cancelSchedules(id);
      return this.toEntry(this.store.get(id) ?? dispatched);
    });
  }

  /** The user accepts the result (or marks a stuck in-progress todo done). */
  complete(id: string): TodoEntry {
    const todo = this.#getOrThrow(id);
    if (todo.status !== 'delivered' && todo.status !== 'in_progress') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不能标为完成`);
    }
    return this.#guard(() => {
      this.#cancelSchedules(id);
      this.store.update(id, {
        status: this.#assertMove(todo, 'done'),
        closedAt: this.#deps.clock.now(),
        blockedReason: null,
      });
      this.#changed(id);
      return this.toEntry(this.#getOrThrow(id));
    });
  }

  /** Cancels any open todo (a periodic one: 「已停止」) together with its schedule. */
  cancel(id: string): TodoEntry {
    const todo = this.#getOrThrow(id);
    if (todo.status === 'done' || todo.status === 'cancelled') {
      throw new AppError('INVALID_INPUT', `事项已经${STATUS_LABEL[todo.status]}`);
    }
    return this.#guard(() => {
      this.#cancelSchedules(id);
      this.store.update(id, {
        status: this.#assertMove(todo, 'cancelled'),
        closedAt: this.#deps.clock.now(),
        blockedReason: null,
      });
      this.#changed(id);
      return this.toEntry(this.#getOrThrow(id));
    });
  }

  /**
   * Hard delete (maintenance only — the RPCs and the butler never delete a todo). Its active
   * schedules are cancelled first: `schedules.todo_id` is `ON DELETE SET NULL`, which would
   * otherwise leave a live workbench schedule pointing at nothing.
   */
  purge(id: string): boolean {
    return this.#guard(() => {
      this.#cancelSchedules(id);
      const deleted = this.store.delete(id);
      if (deleted) this.#changed(id);
      return deleted;
    });
  }

  /** Back from done / cancelled to draft. */
  reopen(id: string): TodoEntry {
    const todo = this.#getOrThrow(id);
    if (todo.status !== 'done' && todo.status !== 'cancelled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不需要重新打开`);
    }
    return this.#guard(() => {
      const reopened =
        this.store.update(id, {
          status: this.#assertMove(todo, 'draft'),
          closedAt: null,
          blockedReason: null,
        }) ?? todo;
      // The executor may be gone since the todo was closed: do not hand back a dead assignee.
      const problem = this.#executorProblem(reopened);
      if (problem !== null) this.#dropExecutor(reopened, problem);
      this.#changed(id);
      return this.toEntry(this.#getOrThrow(id));
    });
  }

  // --- scheduling ------------------------------------------------------------------

  /** Creates (or moves) the schedule of `todo` and parks it in `scheduled`. */
  #schedule(todo: Todo, when: string, timezone: string | undefined, actor: TodoActor): Todo {
    const assignee = todo.assignee;
    if (assignee === null) throw new AppError('INVALID_INPUT', '设置时间前请先选择执行者');
    const target = this.#targetOf(assignee);
    return this.#tx(() => {
      const existing = this.#activeSchedule(todo.id);
      if (
        existing !== null &&
        existing.conversationId === target.conversationId &&
        existing.botId === target.botId
      ) {
        this.#deps.schedules.reschedule(existing.id, when, timezone);
      } else {
        // Create the new one first: if that throws (bad time, gone conversation) the old
        // schedule is still intact.
        this.#deps.schedules.createForTodo({
          todoId: todo.id,
          botId: target.botId,
          conversationId: target.conversationId,
          when,
          ...(timezone !== undefined ? { timezone } : {}),
          title: todo.title,
          note: todo.notes,
        });
        if (existing !== null) this.#deps.schedules.cancel(existing.id, { reassigned: true });
      }
      // The last actor to set the schedule is who a due dispatch is attributed to.
      this.store.setScheduledBy(todo.id, actor);
      return this.#move(todo, 'scheduled', { blockedReason: null });
    });
  }

  /** Executor changed while draft / scheduled: a live schedule moves to the new target. */
  #reassign(todo: Todo, assignee: TodoAssignee, actor: TodoActor): Todo {
    const existing = this.#activeSchedule(todo.id);
    const updated = this.#applyAssignee(todo, assignee);
    if (existing === null) return updated;
    const carried = scheduleWhen(existing, this.#deps.clock.now());
    if (carried === null) {
      // A one-off whose time has passed cannot be carried over; it falls back to draft.
      this.#cancelSchedules(todo.id);
      return this.#toDraft(updated, { blockedReason: '原定时间已过，请重新选择时间' });
    }
    return this.#schedule(updated, carried.when, carried.timezone, actor);
  }

  #applyAssignee(todo: Todo, assignee: TodoAssignee): Todo {
    return this.store.update(todo.id, { assignee, blockedReason: null }) ?? todo;
  }

  /** Cancels every active schedule of the todo (their receipt cards turn 「已取消」). */
  #cancelSchedules(todoId: string): void {
    for (const schedule of this.#deps.schedules.store.listActiveForTodo(todoId)) {
      this.#deps.schedules.cancel(schedule.id);
    }
  }

  /** Back to draft: schedule cancelled, status moved, optional assignee / reason changes. */
  #toDraft(
    todo: Todo,
    patch: { assignee?: TodoAssignee | null; blockedReason?: string | null },
  ): Todo {
    this.#cancelSchedules(todo.id);
    return this.#move(todo, 'draft', {
      ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
      blockedReason: patch.blockedReason ?? null,
    });
  }

  // --- dispatch ---------------------------------------------------------------------

  /** Dispatch hand-off of a due workbench schedule (ScheduleService `#fireWorkbench`). */
  dispatchScheduled(input: {
    todoId: string;
    scheduleId: string;
    fireAt: number;
    lateByMs: number | null;
  }): void {
    this.#guard(() => {
      const todo = this.store.get(input.todoId);
      if (todo === null) throw new AppError('NOT_FOUND', `事项 ${input.todoId} 不存在`);
      if (todo.status !== 'scheduled') {
        throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不再派发`);
      }
      try {
        this.#dispatch(todo, {
          scheduleId: input.scheduleId,
          fireAt: input.fireAt,
          lateByMs: input.lateByMs,
          // Whoever last set the schedule (an older row without a record: the creator).
          actor: this.store.scheduledBy(todo.id) ?? todo.source,
        });
      } catch (error) {
        // The executor is gone / unwritable: the todo returns to draft with the reason.
        if (error instanceof AppError) {
          const fresh = this.#getOrThrow(input.todoId);
          if (!this.#reconcileTodo(fresh)) {
            this.#toDraft(fresh, { blockedReason: error.message });
          }
          this.#changed(input.todoId);
        }
        throw error;
      }
    });
  }

  /**
   * Appends the visible dispatch message in the executor's conversation and routes it like a
   * typed user message (direct → delivery gate, group → GroupTurnCoordinator). Not subject to
   * the proactive switch, quiet hours or the daily cap (it is the user's instruction).
   */
  #dispatch(todo: Todo, context: DispatchContext): Todo {
    const assignee = todo.assignee;
    if (assignee === null) throw new AppError('INVALID_INPUT', '请先选择执行者');
    this.#validateAssignee(assignee);
    const target = this.#targetOf(assignee);
    const run = this.store.insertRun({ todoId: todo.id, conversationId: target.conversationId });
    const viaButler = context.actor === 'butler';
    const butlerDrafted = todo.source === 'butler';
    // A periodic todo keeps its `scheduled` parking spot; a one-off becomes in_progress. It
    // moves BEFORE routing: routing can settle synchronously (an empty group → no_claim), and
    // that settlement must find the todo in progress.
    const periodic =
      context.consumeSchedule !== true && this.#activeSchedule(todo.id)?.kind === 'cron';
    if (!periodic) this.#move(todo, 'in_progress', { blockedReason: null });
    let held: boolean;
    try {
      held =
        this.#deps.dispatcher.dispatch({
          conversationId: target.conversationId,
          text: this.#dispatchText(todo, context),
          todoId: todo.id,
          todoRunId: run.id,
          viaButler,
          butlerDrafted,
          leadBotId: assignee.kind === 'group' ? assignee.leadBotId : null,
          onAppended: (message) => {
            this.store.updateRun(run.id, { messageId: message.id });
          },
        }).held === true;
    } catch (error) {
      this.store.updateRun(run.id, { status: 'failed', settledAt: this.#deps.clock.now() });
      // Roll the move back (a table-bypassing restore; the todo was in `todo.status` a moment ago).
      if (this.store.get(todo.id)?.status === 'in_progress' && todo.status !== 'in_progress') {
        this.store.update(todo.id, { status: todo.status, blockedReason: todo.blockedReason });
      }
      this.#changed(todo.id);
      throw error;
    }
    if (held && !periodic && this.store.get(todo.id)?.status === 'in_progress') {
      this.store.update(todo.id, { blockedReason: BLOCKED_HELD });
    }
    this.#changed(todo.id);
    return this.store.get(todo.id) ?? todo;
  }

  #dispatchText(todo: Todo, context: DispatchContext): string {
    const lines = [
      `${WORKBENCH_DISPATCH_TAG}${todo.title}${context.actor === 'butler' ? WORKBENCH_BUTLER_NOTE : ''}`,
    ];
    if (todo.notes.trim().length > 0) lines.push('', todo.notes.trim());
    if (context.lateByMs != null && context.fireAt !== undefined) {
      const schedule =
        context.scheduleId === undefined ? null : this.#deps.schedules.store.get(context.scheduleId);
      const planned = this.#deps.schedules.describeWhen({
        kind: 'once',
        runAt: context.fireAt,
        cron: null,
        timezone: schedule?.timezone ?? 'UTC',
      });
      lines.push('', `（原定 ${planned}，延迟派发）`);
    }
    return lines.join('\n');
  }

  // --- delivery tracking (called by the orchestrator) ----------------------------------

  /** An executor's reply settled the dispatched run: delivered, awaiting the user's acceptance. */
  settleDelivered(todoRunId: string, resultMessageId: string): void {
    const run = this.store.getRun(todoRunId);
    if (run === null) return;
    // Later replies of the same chain win (the last settler is the result); a run that already
    // ended otherwise (unclaimed, failed) is not revived.
    if (run.status === 'unclaimed' || run.status === 'failed') return;
    this.store.updateRun(todoRunId, { status: 'delivered', resultMessageId });
    // Only the latest run moves the todo: a late reply of an older dispatch updates its own run.
    const todo = this.store.get(run.todoId);
    if (todo !== null && todo.status === 'in_progress' && this.#isLatestRun(run)) {
      this.store.update(todo.id, { status: this.#assertMove(todo, 'delivered'), blockedReason: null });
    }
    this.#changed(run.todoId);
  }

  /** The group round ended without anyone taking the dispatch: back to draft. */
  settleUnclaimed(todoRunId: string): void {
    const run = this.store.getRun(todoRunId);
    if (run === null || run.status !== 'dispatched') return;
    this.store.updateRun(todoRunId, { status: 'unclaimed' });
    const todo = this.store.get(run.todoId);
    if (todo !== null && todo.status === 'in_progress' && this.#isLatestRun(run)) {
      this.#move(todo, 'draft', { blockedReason: BLOCKED_UNCLAIMED });
    }
    this.#changed(run.todoId);
  }

  /**
   * The executor's turn failed or was cancelled: the run is marked failed and the todo returns
   * to draft with the reason (「执行失败：…」/「执行已被取消」) so the user can start it again.
   */
  settleFailed(todoRunId: string, outcome: TodoRunFailure): void {
    const run = this.store.getRun(todoRunId);
    if (run === null || run.status !== 'dispatched') return;
    this.store.updateRun(todoRunId, { status: 'failed' });
    const todo = this.store.get(run.todoId);
    if (todo !== null && todo.status === 'in_progress' && this.#isLatestRun(run)) {
      this.#move(todo, 'draft', {
        blockedReason:
          outcome.kind === 'cancelled'
            ? BLOCKED_RUN_CANCELLED
            : `${BLOCKED_RUN_FAILED_PREFIX}${clip(outcome.error ?? '未知原因')}`,
      });
    }
    this.#changed(run.todoId);
  }

  #isLatestRun(run: TodoRun): boolean {
    return this.store.lastRun(run.todoId)?.id === run.id;
  }

  /** A run row for the tracker: null when the todo or run is gone. */
  getRun(todoRunId: string): TodoRun | null {
    return this.store.getRun(todoRunId);
  }

  // --- reconciliation ------------------------------------------------------------------

  /**
   * Brings todos and schedules back in line (startup, `schedules.changed`, deletions). Never
   * trusts that every delete path called a hook: conversation FK cascades bypass the services.
   * Returns the ids of the todos it changed.
   */
  reconcile(): string[] {
    if (this.#busy > 0) {
      // Mid-operation: the outermost operation runs it when it ends (see #guard).
      this.#reconcilePending = true;
      return [];
    }
    const changed = new Set<string>();
    // Cancelling a schedule fires `schedules.changed` (which asks for another pass); a second
    // pass settles whatever the first one's own changes uncovered.
    for (let pass = 0; pass < 3; pass += 1) {
      this.#reconcilePending = false;
      this.#reconcileOnce(changed);
      if (!this.#reconcilePending) break;
    }
    for (const id of changed) this.#changed(id);
    return [...changed];
  }

  #reconcileOnce(changed: Set<string>): void {
    this.#busy += 1;
    try {
      for (const todo of this.store.list({ statuses: ['draft', 'scheduled', 'in_progress'] })) {
        try {
          if (this.#reconcileTodo(todo)) changed.add(todo.id);
        } catch (error) {
          this.#deps.logger.warn(
            { todoId: todo.id, error: error instanceof Error ? error.message : String(error) },
            'todo reconcile failed',
          );
        }
      }
      // Active workbench schedules whose todo cannot own them any more.
      for (const schedule of this.#deps.schedules.store.listActive()) {
        if (schedule.origin !== 'workbench') continue;
        const todo = schedule.todoId === null ? null : this.store.get(schedule.todoId);
        if (todo === null || todo.status !== 'scheduled') {
          this.#deps.schedules.cancel(schedule.id);
          if (todo !== null) changed.add(todo.id);
        }
      }
    } finally {
      this.#busy -= 1;
    }
  }

  /** True when the todo was modified. */
  #reconcileTodo(todo: Todo): boolean {
    const problem = this.#executorProblem(todo);
    if (problem !== null) {
      this.#dropExecutor(todo, problem);
      return true;
    }
    const active = this.#deps.schedules.store.listActiveForTodo(todo.id);
    if (todo.status === 'scheduled') {
      if (active.length === 0) {
        const conversationGone =
          todo.assignee?.kind === 'bot' &&
          this.#deps.conversations.listDirectByBot(todo.assignee.botId).length === 0;
        this.#move(todo, 'draft', {
          blockedReason: conversationGone ? BLOCKED_CONVERSATION_DELETED : BLOCKED_SCHEDULE_CANCELLED,
        });
        return true;
      }
      let modified = false;
      for (const extra of active.slice(1)) {
        this.#deps.schedules.cancel(extra.id);
        modified = true;
      }
      // The schedule is the source of truth for who holds the date (e.g. after a D88 handover).
      const first = active[0]!;
      const adopted = this.#adoptScheduleHolder(todo, first);
      return adopted || modified;
    }
    // Draft / in-progress todos own no schedule.
    if (active.length > 0) {
      for (const schedule of active) this.#deps.schedules.cancel(schedule.id);
      return true;
    }
    return false;
  }

  /**
   * The executor can no longer take the todo: its schedule is cancelled, its open runs marked
   * failed, the assignee cleared (a lost lead bot only clears the lead) and the todo returns to
   * draft with the reason.
   */
  #dropExecutor(todo: Todo, problem: string): Todo {
    this.#cancelSchedules(todo.id);
    this.#failOpenRuns(todo.id);
    const assignee = todo.assignee;
    const keepGroup =
      assignee?.kind === 'group' && (problem === BLOCKED_LEAD_DELETED || problem === BLOCKED_LEAD_LEFT);
    return this.#move(todo, 'draft', {
      assignee: keepGroup ? { ...assignee, leadBotId: null } : null,
      blockedReason: problem,
    });
  }

  /** Marks every still-dispatched run of the todo failed (its executor / conversation is gone). */
  #failOpenRuns(todoId: string): void {
    for (const run of this.store.listRuns(todoId)) {
      if (run.status === 'dispatched') this.store.updateRun(run.id, { status: 'failed' });
    }
  }

  /** The schedule's bot differs from the todo's executor (handover): the todo follows. */
  #adoptScheduleHolder(todo: Todo, schedule: Schedule): boolean {
    const assignee = todo.assignee;
    if (assignee === null || schedule.botId === null) return false;
    if (assignee.kind === 'bot' && assignee.botId !== schedule.botId) {
      this.store.update(todo.id, { assignee: { kind: 'bot', botId: schedule.botId } });
      return true;
    }
    if (
      assignee.kind === 'group' &&
      assignee.conversationId === schedule.conversationId &&
      assignee.leadBotId !== schedule.botId
    ) {
      this.store.update(todo.id, { assignee: { ...assignee, leadBotId: schedule.botId } });
      return true;
    }
    return false;
  }

  /** Why the executor can no longer take the todo (null = fine, or unassigned). */
  #executorProblem(todo: Todo): string | null {
    const assignee = todo.assignee;
    if (assignee === null) return null;
    if (assignee.kind === 'bot') {
      const bot = this.#deps.bots.get(assignee.botId);
      return bot === null || bot.status !== 'active' ? BLOCKED_BOT_DELETED : null;
    }
    // No FK on assignee_group_id: a missing (or since dissolved = read-only) group is found here.
    const group = this.#deps.conversations.get(assignee.conversationId);
    if (group === null || group.readOnly) return BLOCKED_GROUP_GONE;
    if (assignee.leadBotId !== null) {
      const lead = this.#deps.bots.get(assignee.leadBotId);
      if (lead === null || lead.status !== 'active') return BLOCKED_LEAD_DELETED;
      if (!this.#deps.conversations.memberBotIds(assignee.conversationId).includes(assignee.leadBotId)) {
        return BLOCKED_LEAD_LEFT;
      }
    }
    return null;
  }

  // --- lifecycle hooks (domain/lifecycle.ts) --------------------------------------------

  /**
   * Runs BEFORE the conversation row goes: `todos.assignee_group_id` is `ON DELETE SET NULL`,
   * which would silently turn a group assignee into a bare lead bot.
   */
  onConversationDeleting(conversationId: string): void {
    this.#guard(() =>
      this.#tx(() => {
        const touched = new Set<string>();
        for (const todo of this.store.listByAssigneeGroup(conversationId)) {
          if (todo.status === 'done' || todo.status === 'cancelled' || todo.status === 'delivered') {
            // Closed / awaiting acceptance: keep the record, just drop the dangling group.
            this.store.update(todo.id, { assignee: null });
          } else {
            this.#cancelSchedules(todo.id);
            this.#failOpenRuns(todo.id);
            this.#move(todo, 'draft', { assignee: null, blockedReason: BLOCKED_GROUP_GONE });
          }
          touched.add(todo.id);
        }
        // Bot assignees whose schedule lives in this (direct) conversation.
        for (const schedule of this.#deps.schedules.store.listActiveForConversation(conversationId)) {
          if (schedule.origin !== 'workbench' || schedule.todoId === null) continue;
          const todo = this.store.get(schedule.todoId);
          if (todo === null || touched.has(todo.id)) continue;
          if (todo.status === 'scheduled') {
            this.#move(todo, 'draft', { blockedReason: BLOCKED_CONVERSATION_DELETED });
            touched.add(todo.id);
          }
        }
        // Dispatched into this conversation and still waiting for the executor: it can never
        // answer now (a private chat, or a todo whose group was handled above).
        for (const run of this.store.listOpenRunsForConversation(conversationId)) {
          this.store.updateRun(run.id, { status: 'failed' });
          const todo = this.store.get(run.todoId);
          if (todo !== null && todo.status === 'in_progress') {
            this.#move(todo, 'draft', { blockedReason: BLOCKED_CONVERSATION_GONE });
          }
          touched.add(run.todoId);
        }
        for (const id of touched) this.#changed(id);
      }),
    );
  }

  /** After a bot or a group membership went away: reconcile picks up (and publishes) the consequences. */
  onExecutorChanged(): void {
    this.reconcile();
  }

  /** D88 handover: the schedule of a todo moved to another bot — the todo's executor follows. */
  onScheduleTransferred(moved: Schedule): void {
    if (moved.todoId === null || moved.botId === null) return;
    const todo = this.store.get(moved.todoId);
    if (todo === null || todo.assignee === null) return;
    if (this.#adoptScheduleHolder(todo, moved)) this.#changed(todo.id);
  }

  // --- helpers --------------------------------------------------------------------------

  /** Where a dispatch for `assignee` lands: [bot id for the schedule, conversation]. */
  #targetOf(assignee: TodoAssignee): { botId: string | null; conversationId: string } {
    if (assignee.kind === 'bot') {
      const { conversation, created } = this.#deps.conversations.openDirect(assignee.botId);
      if (created) this.#deps.publish?.('conversation.updated', { conversation });
      return { botId: assignee.botId, conversationId: conversation.id };
    }
    return { botId: assignee.leadBotId, conversationId: assignee.conversationId };
  }

  /** Bot active; group writable; lead bot an active member. */
  #validateAssignee(assignee: TodoAssignee): void {
    if (assignee.kind === 'bot') {
      const bot = this.#deps.bots.get(assignee.botId);
      if (bot === null || bot.status !== 'active') {
        throw new AppError('NOT_FOUND', 'Bot 不存在或已删除');
      }
      return;
    }
    const conversation: Conversation | null = this.#deps.conversations.get(assignee.conversationId);
    if (conversation === null) throw new AppError('NOT_FOUND', '群不存在或已解散');
    if (conversation.type !== 'group') throw new AppError('INVALID_INPUT', '只能派给群聊或 Bot');
    if (conversation.readOnly) throw new AppError('CONVERSATION_READ_ONLY', '该群已只读，不能派发');
    if (assignee.leadBotId !== null) {
      const lead = this.#deps.bots.get(assignee.leadBotId);
      if (lead === null || lead.status !== 'active') {
        throw new AppError('NOT_FOUND', '负责 Bot 不存在或已删除');
      }
      if (!this.#deps.conversations.memberBotIds(assignee.conversationId).includes(assignee.leadBotId)) {
        throw new AppError('INVALID_INPUT', '负责 Bot 不在该群中');
      }
    }
  }

  /** Pre-dispatch hints (never blocking): no model for the executor, a date in quiet hours. */
  #warnings(todo: Todo): string[] {
    const warnings: string[] = [];
    const assignee = todo.assignee;
    if (assignee === null) return warnings;
    const executorBotId = assignee.kind === 'bot' ? assignee.botId : assignee.leadBotId;
    if (executorBotId !== null && !this.#deps.dispatcher.hasTurnModel(executorBotId)) {
      warnings.push('该 Bot 未配置模型，派发后无法执行：请先在设置里选择默认主模型或在 Bot 配置中指定。');
    }
    const schedule = this.#activeSchedule(todo.id);
    if (schedule !== null) warnings.push(...this.#deps.schedules.fireabilityWarnings(schedule));
    if (todo.status === 'in_progress' && todo.blockedReason === BLOCKED_HELD) warnings.push(BLOCKED_HELD);
    return warnings;
  }

  #activeSchedule(todoId: string): Schedule | null {
    return this.#deps.schedules.store.listActiveForTodo(todoId)[0] ?? null;
  }

  #botName(botId: string): string | null {
    const bot = this.#deps.bots.get(botId);
    if (bot === null || bot.status !== 'active') return null;
    return bot.profile.identity.name || bot.name;
  }

  #getOrThrow(id: string): Todo {
    const todo = this.store.get(id);
    if (todo === null) throw new AppError('NOT_FOUND', `事项 ${id} 不存在`);
    return todo;
  }

  /** Validated status move + patch; returns the fresh row. */
  #move(
    todo: Todo,
    to: TodoStatus,
    patch: { assignee?: TodoAssignee | null; blockedReason?: string | null } = {},
  ): Todo {
    const status = this.#assertMove(todo, to);
    return (
      this.store.update(todo.id, {
        status,
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
      }) ?? todo
    );
  }

  /** Throws unless `todo.status → to` is on the transition table (same status = allowed no-op). */
  #assertMove(todo: Todo, to: TodoStatus): TodoStatus {
    if (todo.status !== to && !canTransitionTodo(todo.status, to)) {
      throw new AppError(
        'INVALID_INPUT',
        `事项${STATUS_LABEL[todo.status]}，不能变为${STATUS_LABEL[to]}`,
      );
    }
    return to;
  }

  #changed(todoId: string): void {
    this.#deps.publish?.('todos.changed', { todoId });
  }

  /** Marks the service busy so reconcile (fired by `schedules.changed`) leaves mid-flight state alone. */
  #guard<T>(fn: () => T): T {
    this.#busy += 1;
    try {
      return fn();
    } finally {
      this.#busy -= 1;
      if (this.#busy === 0 && this.#reconcilePending) {
        // `schedules.changed` asked for a reconcile while this operation ran.
        try {
          this.reconcile();
        } catch (error) {
          this.#deps.logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'deferred todo reconcile failed',
          );
        }
      }
    }
  }

  /** Pure-DB multi-step write as one transaction (routing a dispatch stays outside). */
  #tx<T>(fn: () => T): T {
    return this.#deps.db.transaction(fn)();
  }
}

/** `null` = no schedule; 'now' stays 'now'; blank strings are rejected by the RPC schema. */
function parseWhen(when: string | null | undefined): string | null {
  if (when === null || when === undefined) return null;
  const trimmed = when.trim();
  if (trimmed.length === 0) throw new AppError('INVALID_INPUT', '时间不能为空');
  return trimmed.toLowerCase() === NOW ? NOW : trimmed;
}

function errorText(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error));
}

function clip(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function cleanTitle(title: string): string {
  const cleaned = title.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) throw new AppError('INVALID_INPUT', '事项标题不能为空');
  if (cleaned.length > TODO_TITLE_MAX_CHARS) {
    throw new AppError('INVALID_INPUT', `事项标题最多 ${TODO_TITLE_MAX_CHARS} 字`);
  }
  return cleaned;
}

function cleanNotes(notes: string | undefined): string {
  const cleaned = (notes ?? '').trim();
  if (cleaned.length > TODO_NOTES_MAX_CHARS) {
    throw new AppError('INVALID_INPUT', `事项说明最多 ${TODO_NOTES_MAX_CHARS} 字`);
  }
  return cleaned;
}

function sameAssignee(a: TodoAssignee | null, b: TodoAssignee | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'bot' && b.kind === 'bot') return a.botId === b.botId;
  if (a.kind === 'group' && b.kind === 'group') {
    return a.conversationId === b.conversationId && a.leadBotId === b.leadBotId;
  }
  return false;
}

/** A schedule's timing as a `when` string to carry over (null = a one-off in the past). */
function scheduleWhen(schedule: Schedule, now: number): { when: string; timezone: string } | null {
  if (schedule.kind === 'cron') {
    return schedule.cron === null ? null : { when: schedule.cron, timezone: schedule.timezone };
  }
  const at = schedule.nextFireAt ?? schedule.runAt;
  return at !== null && at > now
    ? { when: new Date(at).toISOString(), timezone: schedule.timezone }
    : null;
}

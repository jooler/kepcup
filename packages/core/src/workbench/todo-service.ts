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
  type BoardChangedPayload,
  type TodoSource,
  type TodoStatus,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock, TimerScheduler } from '../infra/clock.js';
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
export const BLOCKED_LEAD_LEFT = '负责 Bot 已移出项目组';
export const BLOCKED_PROJECT_GONE = '项目组已解散';
export const BLOCKED_SCHEDULE_CANCELLED = '排期已取消';
export const BLOCKED_CONVERSATION_DELETED = '对话已删除，排期已取消';
export const BLOCKED_UNCLAIMED = '项目里无人回应';
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
/** Board-card dispatch: the card text, not a repeated title (design 50 §6.3). */
export const BOARD_DISPATCH_TAG = '【看板】';
/** Appended when a cron fire finds the previous run still undispatched-to-delivery. */
export const BOARD_UNDISPATCHED_NOTE = '（上一次执行尚未交付）';
/** Board executor left the project. The card does not fall back to the lead. */
export const BLOCKED_EXECUTOR_LEFT = '执行成员已移出项目组';
/** Board executor bot was deleted. */
export const BLOCKED_EXECUTOR_DELETED = '执行成员已删除';
export const WORKBENCH_BUTLER_NOTE = '（管家代你安排）';
/** The first line of an update notice reads 「【工作台】事项更新：标题」. */
export const WORKBENCH_UPDATE_TAG = '【工作台】事项更新：';
/** Quiet period before the update notice of an edited todo goes out (later edits restart it). */
export const TODO_UPDATE_DEBOUNCE_MS = 10_000;

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
    /** Project assignee's effective lead bot: the message @-mentions it (explicit target). */
    leadBotId: string | null;
    /** Runs after the message is stored + published, before it is routed to a bot. */
    onAppended?: ((message: Message) => void) | undefined;
  }): {
    message: Message;
    runId: string | null;
    /** The delivery is held back (the bot is in its setup interview) until setup is done. */
    held?: boolean | undefined;
  };
  /**
   * D90 事项更新通知: a visible user message in the conversation of an in-flight dispatch
   * (`todoUpdate: true`, carrying that dispatch's `todoRunId`), routed like a typed one into the
   * executor's mailbox — buffered behind a running turn, never steered into it. Project: @ the
   * bots that actually answered the dispatch, no triage. Null = nobody to tell yet (nothing was
   * sent).
   */
  dispatchUpdate(input: {
    conversationId: string;
    text: string;
    todoId: string;
    todoRunId: string;
    viaButler: boolean;
    butlerDrafted: boolean;
    /**
     * The dispatch message the update follows. A project update is @-ed to whoever took THAT dispatch
     * (its @ mentions at the time, plus the bots whose turn it triggered) — never the todo's
     * current assignee, which may have changed since (periodic todos).
     */
    dispatchMessageId: string | null;
  }): { message: Message } | null;
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
  /** Debounce timers of update notices (tests inject a virtual one). Absent = no notices are sent. */
  timers?: TimerScheduler | undefined;
  /** Quiet period before an update notice goes out. Default {@link TODO_UPDATE_DEBOUNCE_MS}. */
  updateDebounceMs?: number | undefined;
  /**
   * Read-only board-card lookup. The side-table row is the only switch for
   * board behavior. Absent in tests that do not construct a board.
   */
  boardCards?:
    | {
        locationOf(todoId: string): { projectId: string; columnId: string } | null;
      }
    | undefined;
}

/**
 * Who performs an operation: the user themselves, or the butler through its tools. It decides how
 * a dispatch is attributed (「（管家代你安排）」, `viaButler`). The todo's `source` is the content's
 * provenance: who created it, and 'butler' as soon as the butler wrote or rewrote its title / notes.
 */
/** 'board' is a write that came through BoardService. It is not stored as `source`. */
export type TodoActor = TodoSource | 'board';

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
  /**
   * When false, this dispatch does not publish. The caller publishes once
   * after the rest of the operation (cancelling a one-off schedule) commits.
   */
  notify?: boolean;
}

const NOW = 'now';

/** An edit of an in-flight todo's title / notes whose notice is still debouncing. */
interface PendingUpdate {
  todoRunId: string;
  /** The text the executor last saw (before the first edit of this window). */
  baseTitle: string;
  baseNotes: string;
  /** Any edit of the window was the butler's (the notice is then butler-attributed). */
  byButler: boolean;
  /** A timer is armed. Unarmed = the last send failed: kept only so the next edit carries `base*`. */
  armed: boolean;
  cancel: () => void;
}

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
  /**
   * > 0 while a board batch (column delete, project delete) will publish one
   * `board.changed` of its own after commit. Nested card writes stay quiet.
   */
  #suppressBoardEvents = 0;
  /** `board.changed` payloads held until {@link withTransaction} commits. */
  #queuedBoardEvents: BoardChangedPayload[] = [];
  /** Update notices waiting out their debounce, by todo id. */
  readonly #pendingUpdates = new Map<string, PendingUpdate>();

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
        // Board cards are a board concern. The RPC shape is unchanged.
        excludeBoardCards: true,
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
    } else if (assignee?.kind === 'project') {
      const project = this.#deps.conversations.get(assignee.projectId);
      assigneeName = project?.title ?? null;
      // D92 T1a: the lead actually in effect — the assignee's override, else the project's own lead.
      const effectiveLeadBotId = assignee.leadBotId ?? project?.leadBotId ?? null;
      leadBotName = effectiveLeadBotId === null ? null : this.#botName(effectiveLeadBotId);
    }
    const schedule = this.#activeSchedule(todo.id);
    return {
      ...todo,
      assigneeName,
      leadBotName,
      // Filled from board_cards once BoardStore is wired; ordinary todos stay null.
      board: this.#deps.boardCards?.locationOf(todo.id) ?? null,
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

  /**
   * `notified`: the title / notes changed on a todo with an in-flight dispatch, so a 「事项更新」
   * notice for the executor is queued (sent after a quiet period, edits in between merge into
   * one). Nothing is sent for drafts, schedules not yet due and delivered / closed todos — the
   * next dispatch simply carries the new text.
   */
  update(
    id: string,
    input: UpdateTodoInput,
  ): { todo: TodoEntry; warnings: string[]; notified: boolean } {
    const actor: TodoActor = input.actor ?? 'user';
    this.#assertBoardWritable(id, actor);
    const todo = this.#getOrThrow(id);
    if (todo.status === 'done' || todo.status === 'cancelled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，请先重新打开再修改`);
    }
    const titleChanged = input.title !== undefined && cleanTitle(input.title) !== todo.title;
    const notesChanged = input.notes !== undefined && cleanNotes(input.notes) !== todo.notes;
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
      this.#validateAssignee(input.assignee, id);
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
              // 内容出处：管家改写过标题 / 说明，之后派发时执行者要按不可信内容对待（butlerDrafted）。
              ...(actor === 'butler' && (titleChanged || notesChanged) ? { source: 'butler' } : {}),
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
          // One event after the schedule is cancelled, not one from the
          // dispatch and another from this method.
          current = this.#dispatch(current, { consumeSchedule: true, actor, notify: false });
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
        // The fresh dispatch carries the new text: no notice for an older run.
        this.#dropPendingUpdate(id);
        return { todo: this.toEntry(fresh), warnings: this.#warnings(fresh), notified: false };
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
      const notified = this.#queueUpdateNotice(todo, fresh, actor);
      return { todo: this.toEntry(fresh), warnings: this.#warnings(fresh), notified };
    });
  }

  // --- update notices (D90: tell the executor of an in-flight dispatch what changed) ---

  /** The dispatch of `todo` that is still being worked on, if any. */
  #inflightRun(todo: Todo): TodoRun | null {
    if (todo.status === 'in_progress') {
      // fall through to the run check
    } else if (todo.status === 'scheduled') {
      // Only a periodic todo parks in `scheduled` while an earlier run is still out.
      if (this.#activeSchedule(todo.id)?.kind !== 'cron') return null;
    } else {
      return null;
    }
    const run = this.store.lastRun(todo.id);
    return run !== null && run.status === 'dispatched' ? run : null;
  }

  /**
   * Queues (or restarts) the debounced notice after the title / notes of `after` changed.
   * Edits within the quiet period merge: the notice carries the latest text, and is dropped when
   * the text is back to what the executor saw. Returns whether a notice is pending.
   */
  #queueUpdateNotice(before: Todo, after: Todo, actor: TodoActor): boolean {
    const timers = this.#deps.timers;
    if (timers === undefined) return false;
    const pending = this.#pendingUpdates.get(after.id);
    const textChanged = before.title !== after.title || before.notes !== after.notes;
    if (!textChanged) return pending?.armed === true;
    const run = this.#inflightRun(after);
    if (run === null) {
      this.#dropPendingUpdate(after.id);
      return false;
    }
    const carried = pending !== undefined && pending.todoRunId === run.id ? pending : null;
    if (pending !== undefined) pending.cancel();
    const next: PendingUpdate = {
      todoRunId: run.id,
      baseTitle: carried?.baseTitle ?? before.title,
      baseNotes: carried?.baseNotes ?? before.notes,
      byButler: (carried?.byButler ?? false) || actor === 'butler',
      armed: true,
      cancel: () => undefined,
    };
    this.#pendingUpdates.set(after.id, next);
    this.#armUpdateTimer(after.id, next);
    return true;
  }

  #armUpdateTimer(todoId: string, pending: PendingUpdate): void {
    const timers = this.#deps.timers;
    if (timers === undefined) return;
    pending.armed = true;
    pending.cancel = timers.setTimer(this.#deps.updateDebounceMs ?? TODO_UPDATE_DEBOUNCE_MS, () =>
      this.#flushUpdateNotice(todoId),
    );
  }

  #dropPendingUpdate(todoId: string): void {
    const pending = this.#pendingUpdates.get(todoId);
    if (pending === undefined) return;
    pending.cancel();
    this.#pendingUpdates.delete(todoId);
  }

  /**
   * Quiet period over: sends the notice if the dispatch is still in flight and the text still
   * differs. "What the executor knows" (`base*`) only advances once the notice was delivered: when
   * nobody could be told yet (a project dispatch nobody has taken up) the timer is re-armed and the
   * retry goes on until the run settles; a failed send keeps the base for the next edit.
   */
  #flushUpdateNotice(todoId: string): void {
    const pending = this.#pendingUpdates.get(todoId);
    if (pending === undefined) return;
    pending.armed = false;
    try {
      const todo = this.store.get(todoId);
      if (todo === null || todo.assignee === null) {
        this.#pendingUpdates.delete(todoId);
        return;
      }
      const run = this.#inflightRun(todo);
      // The run settled / a newer dispatch started meanwhile: nothing (new) to tell.
      if (run === null || run.id !== pending.todoRunId) {
        this.#pendingUpdates.delete(todoId);
        return;
      }
      if (todo.title === pending.baseTitle && todo.notes === pending.baseNotes) {
        this.#pendingUpdates.delete(todoId);
        return;
      }
      const conversation = this.#deps.conversations.get(run.conversationId);
      if (conversation === null || conversation.readOnly) {
        this.#pendingUpdates.delete(todoId);
        return;
      }
      const sent = this.#deps.dispatcher.dispatchUpdate({
        conversationId: run.conversationId,
        text: this.#updateText(todo, pending.byButler),
        todoId: todo.id,
        todoRunId: run.id,
        viaButler: pending.byButler,
        butlerDrafted: todo.source === 'butler',
        dispatchMessageId: run.messageId,
      });
      if (sent === null) {
        // Nobody to tell yet: try again later, for as long as the dispatch is in flight.
        this.#armUpdateTimer(todoId, pending);
        return;
      }
      this.#pendingUpdates.delete(todoId);
    } catch (error) {
      // Kept (unarmed) so the next edit still diffs against what the executor actually saw.
      pending.cancel = () => undefined;
      this.#deps.logger.warn(
        { todoId, error: error instanceof Error ? error.message : String(error) },
        'todo update notice failed',
      );
    }
  }

  #updateText(todo: Todo, byButler: boolean): string {
    const lines = [`${WORKBENCH_UPDATE_TAG}${todo.title}`];
    if (todo.notes.trim().length > 0) lines.push('', todo.notes.trim());
    lines.push(
      '',
      `（由${byButler ? '管家' : '用户'}修改；这是对你已在做的这件事的补充，不是新任务；仅供参考，是否调整当前做法由你决定）`,
    );
    return lines.join('\n');
  }

  // --- transitions ---------------------------------------------------------------

  /** 立即开始: dispatches a draft (or scheduled) todo now; needs an assignee. */
  start(id: string, actor: TodoActor = 'user'): TodoEntry {
    this.#assertBoardWritable(id, actor);
    const todo = this.#getOrThrow(id);
    if (todo.status !== 'draft' && todo.status !== 'scheduled') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不能立即开始`);
    }
    if (todo.assignee === null) throw new AppError('INVALID_INPUT', '请先选择执行者');
    this.#validateAssignee(todo.assignee, id);
    return this.#guard(() => {
      const schedule = this.#activeSchedule(id);
      // Dispatch first: if routing throws, the schedule is still there. A one-off schedule is
      // replaced by this dispatch; a periodic one keeps running (and the todo stays
      // `scheduled`) — compare update `when:'now'`, which ends the periodic schedule.
      // Publish once, after that cancel, so a listener never observes the
      // one-off schedule still active.
      let dispatched: Todo;
      try {
        dispatched = this.#dispatch(this.#getOrThrow(id), { actor, notify: false });
      } catch (error) {
        this.#changed(id);
        throw error;
      }
      if (schedule !== null && schedule.kind === 'once') this.#cancelSchedules(id);
      this.#changed(id);
      return this.toEntry(this.store.get(id) ?? dispatched);
    });
  }

  /** The user accepts the result (or marks a stuck in-progress todo done). */
  complete(id: string, actor: TodoActor = 'user'): TodoEntry {
    this.#assertBoardWritable(id, actor);
    const todo = this.#getOrThrow(id);
    if (todo.status !== 'delivered' && todo.status !== 'in_progress') {
      throw new AppError('INVALID_INPUT', `事项${STATUS_LABEL[todo.status]}，不能标为完成`);
    }
    return this.#guard(() => {
      this.#dropPendingUpdate(id);
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
  cancel(id: string, actor: TodoActor = 'user'): TodoEntry {
    this.#assertBoardWritable(id, actor);
    const todo = this.#getOrThrow(id);
    if (todo.status === 'done' || todo.status === 'cancelled') {
      throw new AppError('INVALID_INPUT', `事项已经${STATUS_LABEL[todo.status]}`);
    }
    return this.#guard(() => {
      this.#dropPendingUpdate(id);
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
  purge(id: string, actor: TodoActor = 'user'): boolean {
    this.#assertBoardWritable(id, actor);
    // Capture the board location before the side row cascades away with the todo.
    const location = this.#boardLocation(id);
    return this.#guard(() => {
      this.#dropPendingUpdate(id);
      this.#cancelSchedules(id);
      const deleted = this.store.delete(id);
      if (deleted) this.#changed(id, location);
      return deleted;
    });
  }

  /** Back from done / cancelled to draft. */
  reopen(id: string, actor: TodoActor = 'user'): TodoEntry {
    this.#assertBoardWritable(id, actor);
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
    const target = this.#targetOf(todo);
    return this.#tx(() => {
      const existing = this.#activeSchedule(todo.id);
      if (
        existing !== null &&
        existing.conversationId === target.conversationId &&
        existing.botId === target.scheduleBotId
      ) {
        this.#deps.schedules.reschedule(existing.id, when, timezone);
      } else {
        // Create the new one first: if that throws (bad time, gone conversation) the old
        // schedule is still intact.
        this.#deps.schedules.createForTodo({
          todoId: todo.id,
          botId: target.scheduleBotId,
          conversationId: target.conversationId,
          when,
          ...(timezone !== undefined ? { timezone } : {}),
          title: todo.title,
          note: todo.notes,
        });
        if (existing !== null) this.#deps.schedules.cancel(existing.id, { reassigned: true });
      }
      // The last actor to set the schedule is who a due dispatch is attributed to.
      // scheduled_by is only 'user' | 'butler'. P1 board writes do not schedule;
      // a later board schedule is attributed as the user if it ever lands here.
      this.store.setScheduledBy(todo.id, actor === 'board' ? 'user' : actor);
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
   * typed user message (direct → delivery gate, project → ProjectTurnCoordinator). Not subject to
   * the proactive switch, quiet hours or the daily cap (it is the user's instruction).
   */
  #dispatch(todo: Todo, context: DispatchContext): Todo {
    const notify = context.notify !== false;
    const assignee = todo.assignee;
    if (assignee === null) throw new AppError('INVALID_INPUT', '请先选择执行者');
    this.#validateAssignee(assignee, todo.id);
    const target = this.#targetOf(todo);
    const run = this.store.insertRun({ todoId: todo.id, conversationId: target.conversationId });
    const viaButler = context.actor === 'butler';
    const butlerDrafted = todo.source === 'butler';
    // A periodic todo keeps its `scheduled` parking spot; a one-off becomes in_progress. It
    // moves BEFORE routing: routing can settle synchronously (an unanswered project → silent →
    // unclaimed), and that settlement must find the todo in progress.
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
          // A board card is a single-bot chat: no @ and no project routing.
          // A project dispatch carries the structured @ (the assignee's override,
          // else the project's own lead).
          leadBotId: this.#isBoard(todo.id)
            ? null
            : assignee.kind === 'project'
              ? (assignee.leadBotId ?? target.leadBotId)
              : null,
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
      if (notify) this.#changed(todo.id);
      throw error;
    }
    if (held && !periodic && this.store.get(todo.id)?.status === 'in_progress') {
      this.store.update(todo.id, { blockedReason: BLOCKED_HELD });
    }
    if (notify) this.#changed(todo.id);
    return this.store.get(todo.id) ?? todo;
  }

  #dispatchText(todo: Todo, context: DispatchContext): string {
    if (this.#isBoard(todo.id)) {
      const lines = [`${BOARD_DISPATCH_TAG}${todo.notes.trim()}`];
      if (this.#cronStillUndelivered(todo, context)) lines.push(BOARD_UNDISPATCHED_NOTE);
      if (context.lateByMs != null && context.fireAt !== undefined) {
        lines.push('', this.#lateLine(context));
      }
      return lines.join('\n');
    }
    const lines = [
      `${WORKBENCH_DISPATCH_TAG}${todo.title}${context.actor === 'butler' ? WORKBENCH_BUTLER_NOTE : ''}`,
    ];
    if (todo.notes.trim().length > 0) lines.push('', todo.notes.trim());
    if (context.lateByMs != null && context.fireAt !== undefined) {
      lines.push('', this.#lateLine(context));
    }
    return lines.join('\n');
  }

  /** The newest run is the one just inserted. A cron fire notes the one before it. */
  #cronStillUndelivered(todo: Todo, context: DispatchContext): boolean {
    if (context.scheduleId === undefined || context.fireAt === undefined) return false;
    const schedule = this.#deps.schedules.store.get(context.scheduleId);
    if (schedule === null || schedule.kind !== 'cron') return false;
    const previous = this.store.listRuns(todo.id)[1];
    return previous !== undefined && previous.status === 'dispatched';
  }

  #lateLine(context: DispatchContext): string {
    const schedule =
      context.scheduleId === undefined ? null : this.#deps.schedules.store.get(context.scheduleId);
    const planned = this.#deps.schedules.describeWhen({
      kind: 'once',
      runAt: context.fireAt!,
      cron: null,
      timezone: schedule?.timezone ?? 'UTC',
    });
    return `（原定 ${planned}，延迟派发）`;
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

  /** The project round ended without anyone taking the dispatch: back to draft. */
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
            : `${BLOCKED_RUN_FAILED_PREFIX}${humanizeRunError(outcome.error)}`,
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
    if (this.#isBoard(todo.id)) {
      // The card does not fall back to "the lead executes it".
      this.#deps.conversations.closeOpenCardConversations(todo.id);
      const reason = boardBlockedReason(problem);
      if (todo.status === 'draft' || canTransitionTodo(todo.status, 'draft')) {
        return this.#move(todo, 'draft', { assignee: null, blockedReason: reason });
      }
      // delivered has no draft edge on the generic table; a departed executor
      // still returns the card to draft (design 50 §5.6).
      return (
        this.store.update(todo.id, {
          status: 'draft',
          assignee: null,
          blockedReason: reason,
          closedAt: null,
        }) ?? todo
      );
    }
    const assignee = todo.assignee;
    const keepProject =
      assignee?.kind === 'project' &&
      (problem === BLOCKED_LEAD_DELETED || problem === BLOCKED_LEAD_LEFT);
    return this.#move(todo, 'draft', {
      assignee: keepProject ? { ...assignee, leadBotId: null } : null,
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
    // A board card names its executor explicitly. Do not pin an empty lead
    // to the project lead, and do not follow a transferred schedule.
    if (this.#isBoard(todo.id)) return false;
    const assignee = todo.assignee;
    if (assignee === null || schedule.botId === null) return false;
    if (assignee.kind === 'bot' && assignee.botId !== schedule.botId) {
      this.store.update(todo.id, { assignee: { kind: 'bot', botId: schedule.botId } });
      return true;
    }
    if (
      assignee.kind === 'project' &&
      assignee.projectId === schedule.conversationId &&
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
    // No FK on assignee_project_id: a missing (or since deleted = read-only) project is found here.
    const project = this.#deps.conversations.get(assignee.projectId);
    if (project === null || project.readOnly) return BLOCKED_PROJECT_GONE;
    if (assignee.leadBotId !== null) {
      const lead = this.#deps.bots.get(assignee.leadBotId);
      if (lead === null || lead.status !== 'active') return BLOCKED_LEAD_DELETED;
      if (!this.#deps.conversations.memberBotIds(assignee.projectId).includes(assignee.leadBotId)) {
        return BLOCKED_LEAD_LEFT;
      }
    }
    return null;
  }

  // --- lifecycle hooks (domain/lifecycle.ts) --------------------------------------------

  /**
   * Runs BEFORE the conversation row goes: `todos.assignee_project_id` is `ON DELETE SET NULL`,
   * which would silently turn a project assignee into a bare lead bot.
   */
  onConversationDeleting(conversationId: string): void {
    this.#guard(() => {
      const touched = this.#tx(() => {
        const ids = new Set<string>();
        for (const todo of this.store.listByAssigneeProject(conversationId)) {
          if (todo.status === 'done' || todo.status === 'cancelled' || todo.status === 'delivered') {
            // Closed / awaiting acceptance: keep the record, just drop the dangling project.
            this.store.update(todo.id, { assignee: null });
          } else {
            this.#cancelSchedules(todo.id);
            this.#failOpenRuns(todo.id);
            this.#move(todo, 'draft', { assignee: null, blockedReason: BLOCKED_PROJECT_GONE });
          }
          ids.add(todo.id);
        }
        // Bot assignees whose schedule lives in this (direct) conversation.
        for (const schedule of this.#deps.schedules.store.listActiveForConversation(conversationId)) {
          if (schedule.origin !== 'workbench' || schedule.todoId === null) continue;
          const todo = this.store.get(schedule.todoId);
          if (todo === null || ids.has(todo.id)) continue;
          if (todo.status === 'scheduled') {
            this.#move(todo, 'draft', { blockedReason: BLOCKED_CONVERSATION_DELETED });
            ids.add(todo.id);
          }
        }
        // Dispatched into this conversation and still waiting for the executor: it can never
        // answer now (a private chat, or a todo whose project was handled above).
        for (const run of this.store.listOpenRunsForConversation(conversationId)) {
          this.store.updateRun(run.id, { status: 'failed' });
          const todo = this.store.get(run.todoId);
          if (todo !== null && todo.status === 'in_progress') {
            this.#move(todo, 'draft', { blockedReason: BLOCKED_CONVERSATION_GONE });
          }
          ids.add(run.todoId);
        }
        return ids;
      });
      // After the commit, so a listener never observes a change that can still roll back.
      for (const id of touched) this.#changed(id);
    });
  }

  /** After a bot or a project membership went away: reconcile picks up (and publishes) the consequences. */
  onExecutorChanged(): void {
    this.reconcile();
  }

  /**
   * Board executor left or was deleted. Clears the assignee and returns the
   * card to draft. No-op when the todo is not a board card.
   */
  releaseExecutor(todoId: string, problem: string): void {
    const todo = this.store.get(todoId);
    if (todo === null || !this.#isBoard(todoId)) return;
    if (todo.assignee === null && todo.status === 'draft') return;
    this.#guard(() => {
      this.#dropExecutor(todo, problem);
      this.#changed(todoId);
    });
  }

  /** D88 handover: the schedule of a todo moved to another bot — the todo's executor follows. */
  onScheduleTransferred(moved: Schedule): void {
    if (moved.todoId === null || moved.botId === null) return;
    const todo = this.store.get(moved.todoId);
    if (todo === null || todo.assignee === null) return;
    if (this.#adoptScheduleHolder(todo, moved)) this.#changed(todo.id);
  }

  // --- helpers --------------------------------------------------------------------------

  /**
   * Where a dispatch for `todo` lands.
   * `leadBotId` is the @ target (null for a board card). `scheduleBotId` is
   * the bot the workbench schedule row belongs to.
   */
  #targetOf(todo: Todo): {
    leadBotId: string | null;
    scheduleBotId: string | null;
    conversationId: string;
  } {
    const assignee = todo.assignee;
    if (assignee === null) throw new AppError('INVALID_INPUT', '请先选择执行者');
    if (this.#isBoard(todo.id)) {
      if (assignee.kind !== 'project' || assignee.leadBotId === null) {
        throw new AppError('BOARD_ASSIGNEE_INVALID', '看板卡片要指派给项目里的一位成员');
      }
      const conversation = this.#deps.conversations.openCardConversation(todo.id);
      if (conversation === null) {
        throw new AppError('BOARD_ASSIGNEE_INVALID', '这张卡片还没有执行对话');
      }
      return {
        leadBotId: null,
        scheduleBotId: assignee.leadBotId,
        conversationId: conversation.id,
      };
    }
    if (assignee.kind === 'bot') {
      const { conversation, created } = this.#deps.conversations.openDirect(assignee.botId);
      if (created) this.#deps.publish?.('conversation.updated', { conversation });
      return {
        leadBotId: assignee.botId,
        scheduleBotId: assignee.botId,
        conversationId: conversation.id,
      };
    }
    const leadBotId =
      assignee.leadBotId ??
      this.#deps.conversations.get(assignee.projectId)?.leadBotId ??
      null;
    return { leadBotId, scheduleBotId: leadBotId, conversationId: assignee.projectId };
  }

  #isBoard(todoId: string): boolean {
    return this.#boardLocation(todoId) !== null;
  }

  /** True when a `board_cards` row exists. Handover uses this to skip the schedule. */
  isBoardTodo(todoId: string): boolean {
    return this.#isBoard(todoId);
  }

  /** Bot active; project writable; lead override an active member. */
  #validateAssignee(assignee: TodoAssignee, todoId?: string): void {
    if (todoId !== undefined && this.#isBoard(todoId)) {
      if (assignee.kind !== 'project' || assignee.leadBotId === null || assignee.leadBotId.length === 0) {
        throw new AppError('BOARD_ASSIGNEE_INVALID', '看板卡片要指派给项目里的一位成员');
      }
    }
    if (assignee.kind === 'bot') {
      const bot = this.#deps.bots.get(assignee.botId);
      if (bot === null || bot.status !== 'active') {
        throw new AppError('NOT_FOUND', 'Bot 不存在或已删除');
      }
      return;
    }
    const conversation: Conversation | null = this.#deps.conversations.get(assignee.projectId);
    if (conversation === null) throw new AppError('NOT_FOUND', '项目组不存在或已删除');
    if (conversation.type !== 'project') throw new AppError('INVALID_INPUT', '只能派给项目组或 Bot');
    if (conversation.readOnly) {
      throw new AppError('CONVERSATION_READ_ONLY', '该项目组已只读，不能派发');
    }
    if (assignee.leadBotId !== null) {
      const lead = this.#deps.bots.get(assignee.leadBotId);
      if (lead === null || lead.status !== 'active') {
        throw new AppError('NOT_FOUND', '负责 Bot 不存在或已删除');
      }
      if (!this.#deps.conversations.memberBotIds(assignee.projectId).includes(assignee.leadBotId)) {
        throw new AppError('INVALID_INPUT', '负责 Bot 不在该项目组中');
      }
      if (
        todoId !== undefined &&
        this.#isBoard(todoId) &&
        this.#deps.bots.get(assignee.leadBotId)?.systemRole === 'butler'
      ) {
        throw new AppError('BOARD_ASSIGNEE_INVALID', '不能把卡片指派给管家');
      }
    }
  }

  /** Pre-dispatch hints (never blocking): no model for the executor, a date in quiet hours. */
  #warnings(todo: Todo): string[] {
    const warnings: string[] = [];
    const assignee = todo.assignee;
    if (assignee === null) return warnings;
    const executorBotId =
      assignee.kind === 'bot'
        ? assignee.botId
        : (assignee.leadBotId ?? this.#deps.conversations.get(assignee.projectId)?.leadBotId ?? null);
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

  /**
   * Insert the todo row of a new board card. Does not publish: the caller
   * inserts the board_cards row in the same transaction and publishes
   * `board.changed` afterwards. Publishing here would emit `todos.changed`
   * because the side row does not exist yet.
   */
  insertBoardDraft(input: { title: string; notes: string }): Todo {
    return this.store.insert({
      title: input.title,
      notes: input.notes,
      source: 'user',
      status: 'draft',
    });
  }

  /** Replace a board card's text. `actor` is board, so the managed guard passes. */
  updateBoardText(id: string, input: { title: string; notes: string }): Todo {
    this.#assertBoardWritable(id, 'board');
    const before = this.#getOrThrow(id);
    const updated = this.store.update(id, { title: input.title, notes: input.notes });
    if (updated === null) throw new AppError('NOT_FOUND', `事项 ${id} 不存在`);
    const schedule = this.#activeSchedule(id);
    if (schedule !== null) this.#deps.schedules.retitle(schedule.id, updated.title, updated.notes);
    this.#queueUpdateNotice(before, updated, 'board');
    this.#changed(id);
    return updated;
  }

  #boardLocation(id: string): { projectId: string; columnId: string } | null {
    return this.#deps.boardCards?.locationOf(id) ?? null;
  }

  /** A board card is writable only through BoardService (`actor === 'board'`). */
  #assertBoardWritable(id: string, actor: TodoActor): void {
    if (this.#boardLocation(id) !== null && actor !== 'board') {
      throw new AppError('BOARD_MANAGED', 'Edit this card on the board');
    }
  }

  /**
   * Run `fn` without emitting `board.changed`. The caller publishes after the
   * rest of the operation commits (unassign closes the card chat first).
   */
  omitBoardEvents<T>(fn: () => T): T {
    this.#suppressBoardEvents += 1;
    try {
      return fn();
    } finally {
      this.#suppressBoardEvents -= 1;
    }
  }

  /**
   * Run `fn` without emitting per-card `board.changed`. The caller publishes
   * one signal after its transaction commits (column delete, project delete).
   */
  async withoutBoardEvents<T>(fn: () => Promise<T> | T): Promise<T> {
    this.#suppressBoardEvents += 1;
    try {
      return await fn();
    } finally {
      this.#suppressBoardEvents -= 1;
    }
  }

  /**
   * Publish one `board.changed`. Inside an open transaction the payload is
   * held until {@link withTransaction} returns successfully and nothing is
   * left open; a throw drops what that attempt queued. Several card payloads
   * from the same project collapse into one.
   */
  deliverBoardChanged(payload: BoardChangedPayload): void {
    if (this.#suppressBoardEvents > 0) return;
    if (this.#deps.db.inTransaction) {
      this.#queuedBoardEvents.push(payload);
      return;
    }
    this.#deps.publish?.('board.changed', payload);
  }

  /**
   * Run `fn` in a database transaction. Queued `board.changed` payloads are
   * emitted only after the outermost transaction commits.
   */
  withTransaction<T>(fn: () => T): T {
    const mark = this.#queuedBoardEvents.length;
    try {
      const result = this.#deps.db.transaction(fn)();
      if (!this.#deps.db.inTransaction) this.#flushBoardQueue();
      return result;
    } catch (error) {
      this.#queuedBoardEvents.length = mark;
      throw error;
    }
  }

  #flushBoardQueue(): void {
    const queued = this.#queuedBoardEvents.splice(0);
    for (const payload of coalesceBoardEvents(queued)) {
      this.#deps.publish?.('board.changed', payload);
    }
  }

  /**
   * Board cards publish `board.changed` instead of `todos.changed`. Pass
   * `known` when the side row is already gone (purge); `null` means it was
   * not a card, `undefined` looks the row up.
   */
  #changed(todoId: string, known?: { projectId: string; columnId: string } | null): void {
    const location = known !== undefined ? known : this.#boardLocation(todoId);
    if (location !== null) {
      this.deliverBoardChanged({
        projectId: location.projectId,
        cardId: todoId,
        columnId: location.columnId,
      });
      return;
    }
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

function boardBlockedReason(problem: string): string {
  if (problem === BLOCKED_LEAD_DELETED || problem === BLOCKED_BOT_DELETED) {
    return BLOCKED_EXECUTOR_DELETED;
  }
  if (problem === BLOCKED_LEAD_LEFT) return BLOCKED_EXECUTOR_LEFT;
  return problem;
}

function errorText(error: unknown): string {
  return clip(error instanceof Error ? error.message : String(error));
}

/**
 * A run's raw error (`run.error` keeps it untouched) as one readable line for `blocked_reason`:
 * a JSON body's `message` is lifted out, an HTTP status prefix (`500: {…}`) becomes
 * 「模型服务出错（500）：…」, newlines collapse, 120 chars at most.
 */
export function humanizeRunError(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (text.length === 0) return '未知原因';
  let status: string | null = null;
  let body = text;
  const prefixed = /^(?:HTTP\s*)?([1-5]\d\d)\b\s*(?:status code\b)?[:：\s-]*([\s\S]*)$/i.exec(text);
  if (prefixed !== null) {
    status = prefixed[1] ?? null;
    body = (prefixed[2] ?? '').trim();
  }
  const start = body.indexOf('{');
  if (start >= 0) {
    try {
      const parsed: unknown = JSON.parse(body.slice(start));
      const message = pickMessage(parsed);
      if (message !== null) body = `${body.slice(0, start)}${message}`.trim();
    } catch {
      // not JSON: keep the text as is
    }
  }
  body = body.replace(/\s+/g, ' ').trim();
  if (body.length === 0) body = status === null ? '未知原因' : '无详细信息';
  const line = status === null ? body : `模型服务出错（${status}）：${body}`;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function pickMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['message'] === 'string' && record['message'].trim().length > 0) {
    return record['message'];
  }
  return pickMessage(record['error']);
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
  if (a.kind === 'project' && b.kind === 'project') {
    return a.projectId === b.projectId && a.leadBotId === b.leadBotId;
  }
  return false;
}

/**
 * Several card events from one committed transaction are one board refresh.
 * A shared column id is kept; otherwise the signal is the project.
 */
function coalesceBoardEvents(events: readonly BoardChangedPayload[]): BoardChangedPayload[] {
  const groups = new Map<string, BoardChangedPayload[]>();
  for (const event of events) {
    const list = groups.get(event.projectId) ?? [];
    list.push(event);
    groups.set(event.projectId, list);
  }
  const out: BoardChangedPayload[] = [];
  for (const [projectId, list] of groups) {
    if (list.length === 1) {
      out.push(list[0]!);
      continue;
    }
    const columnId = list[0]?.columnId;
    const shared =
      columnId !== undefined && list.every((event) => event.columnId === columnId);
    out.push(shared ? { projectId, columnId } : { projectId });
  }
  return out;
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

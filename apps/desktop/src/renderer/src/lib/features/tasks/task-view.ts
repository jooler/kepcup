import type { EffectStatus, Run, TaskChanges, TaskView } from '@kepcup/shared';

/**
 * 任务卡与状态行的纯展示逻辑（D75，docs/design/30-supervisor-and-tasks.md
 * §4.3 / §6.3）：从任务视图推出卡片该显示什么、能做什么。不依赖 Svelte，
 * 便于单测。
 */

/** Inject / progress lines on the card are clipped (the full text is in the conversation). */
export const TASK_CARD_LINE_MAX = 160;

export function clipLine(text: string, max: number = TASK_CARD_LINE_MAX): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** What the cancel / failure card says about the files the task touched. */
export type TaskCardChanges = TaskChanges | { kind: 'none' };

export interface TaskCardModel {
  tone: 'normal' | 'error';
  /** Why a submitted task waits ('' = no reason known yet); null once it runs. */
  queueReason: string | null;
  /** Latest progress line while the task runs. */
  progress: string | null;
  /** Why it was cancelled ('' = no reason recorded); null unless cancelled. */
  cancelReason: string | null;
  /** Failure / interruption error; null otherwise (and when `revoked` says it). */
  errorLine: string | null;
  /**
   * W3: interrupted because the user revoked a permission (error_json.reason
   * `permission_revoked`) — or, W8, switched the bot's browser profile
   * (`browser_profile_changed`); the card shows the fixed localized reason.
   */
  revoked: boolean;
  /** Which host interruption `revoked` stands for (null when not revoked). */
  interruptReason: 'permission_revoked' | 'browser_profile_changed' | null;
  /**
   * Change summary of a write task that ended without completing (§4.3: the
   * cancel card): project → counts + whole-run revert; workspace → the files
   * its file tools wrote and a plain "no revert"; none → nothing changed.
   * Null for read-only tasks, running tasks and completed ones (a completed
   * project task has its own run-changes card).
   */
  changes: TaskCardChanges | null;
  /** The failure needs a setup first (the in-chat setup card retries it). */
  setupHint: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /**
   * W3（D78）: the retry is 「检查后重试」 — the interrupted task left external
   * effects (completed / unknown outcome); the review panel must be ticked first.
   */
  needsReview: boolean;
  canRevert: boolean;
  clip(text: string): string;
}

export function isActiveTask(task: Pick<TaskView, 'state'>): boolean {
  return task.state === 'submitted' || task.state === 'running';
}

export function taskCardModel(task: TaskView): TaskCardModel {
  const active = isActiveTask(task);
  const endedEarly =
    task.state === 'cancelled' || task.state === 'failed' || task.state === 'interrupted';
  let changes: TaskCardChanges | null = null;
  if (task.writes && endedEarly) {
    changes = task.changes ?? { kind: 'none' };
    // A workspace task without recorded writes still gets the plain "no revert" note.
    if (changes.kind === 'none' && task.workdirKind === 'workspace') {
      changes = { kind: 'workspace', files: [], more: 0 };
    }
  }
  const cancelReason =
    task.state === 'cancelled' ? (task.cancelReason ?? task.error ?? '').trim() : null;
  const interruptReason =
    task.state === 'interrupted' &&
    (task.errorReason === 'permission_revoked' || task.errorReason === 'browser_profile_changed')
      ? task.errorReason
      : null;
  const revoked = interruptReason !== null;
  const errorLine =
    (task.state === 'failed' || task.state === 'interrupted') && !revoked ? task.error : null;
  const canRetry =
    (task.state === 'failed' || task.state === 'interrupted') &&
    task.setup === null &&
    task.continuedByTaskId === null;
  return {
    tone: task.state === 'failed' || task.state === 'interrupted' ? 'error' : 'normal',
    queueReason: task.state === 'submitted' ? (task.queueReason ?? '') : null,
    progress: task.state === 'running' && task.lastProgress !== null ? task.lastProgress : null,
    cancelReason,
    errorLine,
    revoked,
    interruptReason,
    changes,
    setupHint: task.state === 'failed' && task.setup !== null,
    canCancel: active,
    canRetry,
    needsReview: canRetry && task.state === 'interrupted' && task.reviewRequired === true,
    canRevert:
      changes !== null &&
      changes.kind === 'project' &&
      !changes.reverted &&
      changes.added + changes.modified + changes.deleted > 0,
    clip: (text) => clipLine(text),
  };
}

/** Status badge of a ledger row on the review panel (W3): its i18n key suffix. */
export type EffectBadge = 'completed' | 'uncertain' | 'failed' | 'denied' | 'pending';

/**
 * 已完成 / 结果未知 / 失败 / 已拒绝 / 等待审批. `executing` left behind (the run
 * is gone) is shown as unknown — never as done or not done. W4 `intended`
 * (waiting on its approval) never ran: 等待审批（未执行）, never 结果未知.
 */
export function effectBadge(status: EffectStatus): EffectBadge {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'denied':
      return status;
    case 'intended':
      return 'pending';
    default:
      return 'uncertain';
  }
}

/** One task line of the status line (D55 → D75: task activity). */
export interface TaskActivity {
  taskId: string;
  title: string;
  /** Latest tool / progress activity, or the queue reason. */
  activity: string;
  queued: boolean;
  /** Ms timestamp of the last activity (most recent first). */
  at: number;
}

/**
 * The status line over the conversation's in-flight tasks (§6.3): one task →
 * its title and activity; several → the count and the most recent activity
 * (expandable into the list).
 */
export function taskStatusSummary(activities: TaskActivity[]): {
  count: number;
  latest: TaskActivity | null;
} {
  const sorted = [...activities].sort((a, b) => b.at - a.at);
  return { count: activities.length, latest: sorted[0] ?? null };
}

/**
 * Applies views fetched over RPC (tasks.get / tasks.active) to the cache
 * (D75 审查 L2): a task whose `task.updated` push arrived after the fetch
 * started keeps the pushed view — it is newer. Returns the same object when
 * nothing changed.
 */
export function applyFetchedViews(
  byId: Record<string, TaskView>,
  fetched: TaskView[],
  pushedSinceFetch: (taskId: string) => boolean,
): Record<string, TaskView> {
  let next: Record<string, TaskView> | null = null;
  for (const view of fetched) {
    if (pushedSinceFetch(view.taskId)) continue;
    next ??= { ...byId };
    next[view.taskId] = view;
  }
  return next ?? byId;
}

/**
 * Bounds the cache (D75 审查 L3): keeps the open conversation's views and
 * every in-flight task; settled tasks of other conversations are dropped
 * (their cards reload them when they mount again).
 */
export function pruneTaskViews(
  byId: Record<string, TaskView>,
  keepConversationId: string,
): Record<string, TaskView> {
  const next: Record<string, TaskView> = {};
  let dropped = false;
  for (const [taskId, view] of Object.entries(byId)) {
    if (view.conversationId === keepConversationId || isActiveTask(view)) next[taskId] = view;
    else dropped = true;
  }
  return dropped ? next : byId;
}

/**
 * The runs the status line starts from on conversation open (D75 审查 L3):
 * the active ones among the latest runs (their order) plus every other active
 * run of the conversation (tasks may be older than the latest page).
 */
export function activeRunsOf(
  latest: Run[],
  allActive: Run[],
  isActive: (run: Run) => boolean,
): Run[] {
  const result = latest.filter(isActive);
  const seen = new Set(result.map((run) => run.id));
  for (const run of allActive) {
    if (isActive(run) && !seen.has(run.id)) {
      seen.add(run.id);
      result.push(run);
    }
  }
  return result;
}

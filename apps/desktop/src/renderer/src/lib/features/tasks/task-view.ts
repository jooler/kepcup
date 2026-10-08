import type { TaskChanges, TaskView } from '@kepcup/shared';

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
  /** Failure / interruption error; null otherwise. */
  errorLine: string | null;
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
  const errorLine = task.state === 'failed' || task.state === 'interrupted' ? task.error : null;
  return {
    tone: task.state === 'failed' || task.state === 'interrupted' ? 'error' : 'normal',
    queueReason: task.state === 'submitted' ? (task.queueReason ?? '') : null,
    progress: task.state === 'running' && task.lastProgress !== null ? task.lastProgress : null,
    cancelReason,
    errorLine,
    changes,
    setupHint: task.state === 'failed' && task.setup !== null,
    canCancel: active,
    canRetry: task.state === 'failed' && task.setup === null && task.continuedByTaskId === null,
    canRevert:
      changes !== null &&
      changes.kind === 'project' &&
      !changes.reverted &&
      changes.added + changes.modified + changes.deleted > 0,
    clip: (text) => clipLine(text),
  };
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

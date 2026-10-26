import {
  describeInstant,
  describeScheduleWhen,
  type BoardCard,
  type BoardColumn,
} from '@kepcup/shared';
import { blockedNotice, effectiveStatus } from '../workbench/workbench-model';

/**
 * Pure board-view decisions. Status on the card face is derived from the
 * todo, its latest run, and the card conversation's tasks (design 50 §6.4).
 * `effectiveStatus` / `blockedNotice` stay in the workbench model.
 */

export type CardStatusKey =
  | 'idle'
  | 'pending'
  | 'scheduled'
  | 'queued'
  | 'running'
  | 'delivered'
  | 'done'
  | 'cancelled'
  | 'stopped'
  | 'blocked';

export type CardStatusTone = 'neutral' | 'sky' | 'amber' | 'emerald';

export interface CardStatus {
  key: CardStatusKey;
  tone: CardStatusTone;
  /** i18n key. */
  label: `board.status.${CardStatusKey}`;
  params?: Record<string, string>;
}

export interface CardClock {
  now: number;
  timeZone: string;
}

export interface CardFooter {
  assignee: { botId: string; name: string };
  status: CardStatus;
  /** Human schedule phrase. Null when the card has no schedule. */
  when: string | null;
}

export interface CardBadges {
  unread: boolean;
  approval: boolean;
  askUser: boolean;
}

function clockOf(clock?: Partial<CardClock>): CardClock {
  return {
    now: clock?.now ?? Date.now(),
    timeZone: clock?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function status(
  key: CardStatusKey,
  tone: CardStatusTone,
  params?: Record<string, string>,
): CardStatus {
  return params === undefined
    ? { key, tone, label: `board.status.${key}` }
    : { key, tone, label: `board.status.${key}`, params };
}

/**
 * Display status. An unassigned card is blank unless it carries a time set
 * before assignment (`pendingWhen`): that reads as 「待指派 · <time>」 so the
 * intent stays visible on the board. A draft sent back with a blocked reason
 * (the executor left) wins. A cron card stays `scheduled`; the latest run is
 * folded in through `effectiveStatus`.
 */
export function deriveCardStatus(card: BoardCard, clock?: Partial<CardClock>): CardStatus | null {
  const notice = blockedNotice(card.todo);
  if (card.todo.status === 'draft' && notice !== null) {
    return status('blocked', 'amber', { reason: notice.reason });
  }
  const schedule = card.todo.schedule;
  if (card.todo.assignee === null) {
    if (schedule === null) return null;
    const resolved = clockOf(clock);
    return status('pending', 'sky', {
      when: describeScheduleWhen(schedule, {
        localTimeZone: resolved.timeZone,
        now: resolved.now,
      }),
    });
  }
  const effective = effectiveStatus(card.todo);
  if (effective === 'in_progress' && (card.task?.queued ?? 0) > 0) {
    return status('queued', 'amber', { reason: card.task?.queueReason ?? '' });
  }
  switch (effective) {
    case 'draft':
      return status('idle', 'neutral');
    case 'scheduled': {
      const at = card.todo.schedule?.nextFireAt;
      const zone = card.todo.schedule?.timezone ?? clockOf(clock).timeZone;
      const time = typeof at === 'number' ? describeInstant(at, zone, clockOf(clock).now) : '';
      return status('scheduled', 'sky', { time });
    }
    case 'in_progress':
      return status('running', 'emerald');
    case 'delivered':
      return status('delivered', 'amber');
    case 'done':
      return status('done', 'neutral');
    case 'cancelled':
      return card.todo.lastRun !== null
        ? status('stopped', 'neutral')
        : status('cancelled', 'neutral');
    default:
      return null;
  }
}

/** Amber marks on the face. Blocked text is a status, not one of these. */
export function deriveCardBadges(card: BoardCard): CardBadges {
  return {
    unread: card.unreadCount > 0,
    approval: card.pendingApprovals > 0,
    askUser: card.task?.awaitingInput === true,
  };
}

/**
 * Buttons on the dialog's status bar, in display order. Follows the todo
 * state machine (a cron card stays `scheduled` while its latest run is
 * shown separately). Reopen does not need an assignee.
 */
export type BoardAction =
  'start' | 'reschedule' | 'runOnce' | 'clearWhen' | 'cancel' | 'accept' | 'reopen';

/**
 * What one Esc does inside the card dialog. An approval card (or any control
 * that already called `preventDefault`) and the composer win. An open task
 * page returns to the chat. Otherwise the dialog closes. The card text field
 * is not one of these: it does not consume Esc.
 */
export type DialogEscape = 'close' | 'stay' | 'blur-composer' | 'leave-task';

export function dialogEscapeAction(input: {
  defaultPrevented: boolean;
  composerFocused: boolean;
  taskOpen: boolean;
}): DialogEscape {
  if (input.defaultPrevented) return 'stay';
  if (input.composerFocused) return 'blur-composer';
  if (input.taskOpen) return 'leave-task';
  return 'close';
}

/** Running, waiting for review, or closed: the executor and the time are frozen. */
export function isCardLocked(card: BoardCard): boolean {
  return (
    card.todo.status === 'in_progress' ||
    card.todo.status === 'delivered' ||
    card.todo.status === 'done' ||
    card.todo.status === 'cancelled'
  );
}

export function primaryActions(card: BoardCard): BoardAction[] {
  if (card.todo.status === 'done' || card.todo.status === 'cancelled') return ['reopen'];
  if (card.todo.assignee === null) {
    // A time set before assignment can still be cleared; nothing can be run yet.
    return card.todo.schedule === null ? [] : ['clearWhen'];
  }
  switch (card.todo.status) {
    case 'draft':
      return ['start'];
    case 'scheduled': {
      const actions: BoardAction[] = ['reschedule'];
      if (card.todo.schedule?.kind === 'cron') actions.push('runOnce');
      actions.push('clearWhen');
      return actions;
    }
    case 'in_progress':
      return ['cancel'];
    case 'delivered':
      return ['accept', 'cancel'];
    default:
      return [];
  }
}

/** Footer row. Unassigned cards have none, including a blocked card whose executor left. */
export function cardFooter(card: BoardCard, clock?: Partial<CardClock>): CardFooter | null {
  if (card.todo.assignee === null) return null;
  const derived = deriveCardStatus(card, clock);
  if (derived === null) return null;
  const schedule = card.todo.schedule;
  const resolved = clockOf(clock);
  const when =
    schedule === null
      ? null
      : describeScheduleWhen(schedule, { localTimeZone: resolved.timeZone, now: resolved.now });
  return { assignee: card.todo.assignee, status: derived, when };
}

/**
 * Confirm before deleting once the card has a conversation, an assignee, or
 * a run. P1 cards fail this check, so the menu deletes immediately.
 */
export function needsDeleteConfirm(card: BoardCard): boolean {
  return card.conversationId !== null || card.todo.assignee !== null || card.todo.lastRun !== null;
}

export function columnCounts(
  columns: readonly { id: string; cards: readonly unknown[] }[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const column of columns) counts[column.id] = column.cards.length;
  return counts;
}

/** Columns a card can move to from the context menu (every column but its own). */
export function moveTargets(
  columns: readonly Pick<BoardColumn, 'id' | 'title'>[],
  card: Pick<BoardCard, 'columnId'>,
): Array<{ id: string; title: string }> {
  return columns
    .filter((column) => column.id !== card.columnId)
    .map((column) => ({ id: column.id, title: column.title }));
}

/**
 * Neighbours of the open card in board display order (columns left to
 * right, cards top to bottom). Either side is null at an edge.
 */
export function cardNeighbors(
  columns: readonly { cards: readonly { id: string }[] }[],
  cardId: string,
): { prev: string | null; next: string | null } {
  const ids = columns.flatMap((column) => column.cards.map((card) => card.id));
  const index = ids.indexOf(cardId);
  if (index < 0) return { prev: null, next: null };
  return { prev: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
}

/** Screen-reader name: the card's first non-empty line. */
export function cardAriaLabel(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  return line ?? '';
}

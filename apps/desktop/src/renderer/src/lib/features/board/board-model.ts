import type { BoardCard, BoardColumn } from '@kepcup/shared';

/**
 * Pure board-view decisions. Execution fields stay empty in P1, so the footer
 * is null and delete confirmation stays off until a later phase fills them in.
 */

export interface CardFooter {
  assignee: { botId: string; name: string };
  status: BoardCard['todo']['status'];
  schedule: BoardCard['todo']['schedule'];
  lastRun: BoardCard['todo']['lastRun'];
}

/** Footer row. Unassigned cards (every card in P1) have none. */
export function cardFooter(card: BoardCard): CardFooter | null {
  if (card.todo.assignee === null) return null;
  return {
    assignee: card.todo.assignee,
    status: card.todo.status,
    schedule: card.todo.schedule,
    lastRun: card.todo.lastRun,
  };
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

/** Screen-reader name: the card's first non-empty line. */
export function cardAriaLabel(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  return line ?? '';
}

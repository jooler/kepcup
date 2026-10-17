import type { Message } from '@kepcup/shared';

/**
 * Whether `message` is the run_changes card of `runId` (D75 审查 L-4): core
 * re-publishes that card (`message.updated`) when a later lease window of the
 * run adds changes, and the card then reloads its summary.
 */
export function isChangesCardOf(message: Message | null | undefined, runId: string): boolean {
  if (message === null || message === undefined || message.kind !== 'card') return false;
  const content = message.content as { cardType?: unknown; runId?: unknown };
  return content.cardType === 'run_changes' && content.runId === runId && runId.length > 0;
}

import type { BoardCard } from '@kepcup/shared';
import { describe, expect, it } from 'vitest';
import {
  cardAriaLabel,
  cardFooter,
  columnCounts,
  moveTargets,
  needsDeleteConfirm,
} from './board-model';

function card(patch: Partial<BoardCard> = {}): BoardCard {
  return {
    id: 'card_1',
    projectId: 'p1',
    columnId: 'bcol_a',
    position: 1,
    text: 'hello',
    createdAt: 1,
    updatedAt: 1,
    todo: {
      status: 'draft',
      blockedReason: null,
      source: 'user',
      assignee: null,
      schedule: null,
      lastRun: null,
    },
    conversationId: null,
    unreadCount: 0,
    pendingApprovals: 0,
    task: null,
    ...patch,
  };
}

describe('cardFooter', () => {
  it('is null when the card has no assignee', () => {
    expect(cardFooter(card())).toBeNull();
  });

  it('returns the assignee once one is set', () => {
    const footer = cardFooter(
      card({
        todo: {
          status: 'in_progress',
          blockedReason: null,
          source: 'user',
          assignee: { botId: 'bot_1', name: 'Ada' },
          schedule: null,
          lastRun: null,
        },
      }),
    );
    expect(footer?.assignee).toEqual({ botId: 'bot_1', name: 'Ada' });
    expect(footer?.status).toBe('in_progress');
  });
});

describe('needsDeleteConfirm', () => {
  it('is false for an unassigned card with no conversation and no run', () => {
    expect(needsDeleteConfirm(card())).toBe(false);
  });

  it('is true when a conversation, assignee, or last run exists', () => {
    expect(needsDeleteConfirm(card({ conversationId: 'conv_1' }))).toBe(true);
    expect(
      needsDeleteConfirm(
        card({
          todo: {
            status: 'draft',
            blockedReason: null,
            source: 'user',
            assignee: { botId: 'bot_1', name: 'Ada' },
            schedule: null,
            lastRun: null,
          },
        }),
      ),
    ).toBe(true);
    expect(
      needsDeleteConfirm(
        card({
          todo: {
            status: 'draft',
            blockedReason: null,
            source: 'user',
            assignee: null,
            schedule: null,
            lastRun: {
              id: 'run_1',
              todoId: 'card_1',
              conversationId: 'conv_1',
              messageId: null,
              status: 'dispatched',
              resultMessageId: null,
              dispatchedAt: 1,
              settledAt: null,
            },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('columnCounts and moveTargets', () => {
  const columns = [
    { id: 'a', title: 'A', cards: [{}, {}] },
    { id: 'b', title: 'B', cards: [{}] },
    { id: 'c', title: 'C', cards: [] },
  ];

  it('counts cards per column', () => {
    expect(columnCounts(columns)).toEqual({ a: 2, b: 1, c: 0 });
  });

  it('lists every column except the one the card is in', () => {
    expect(moveTargets(columns, { columnId: 'b' })).toEqual([
      { id: 'a', title: 'A' },
      { id: 'c', title: 'C' },
    ]);
  });
});

describe('cardAriaLabel', () => {
  it('uses the first non-empty line', () => {
    expect(cardAriaLabel('\n  \nSecond line')).toBe('Second line');
    expect(cardAriaLabel('   ')).toBe('');
  });
});

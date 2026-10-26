import { describeInstant, describeScheduleWhen, type BoardCard, type TodoRun } from '@kepcup/shared';
import { describe, expect, it } from 'vitest';
import {
  cardAriaLabel,
  cardFooter,
  columnCounts,
  deriveCardBadges,
  deriveCardStatus,
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

const CLOCK = { now: Date.UTC(2026, 9, 26, 1, 0), timeZone: 'UTC' };
const ASSIGNEE = { botId: 'bot_1', name: 'Ada' };

function run(status: TodoRun['status']): TodoRun {
  return {
    id: 'run_1',
    todoId: 'card_1',
    conversationId: 'conv_1',
    messageId: 'msg_1',
    status,
    resultMessageId: status === 'delivered' ? 'msg_2' : null,
    dispatchedAt: CLOCK.now - 3_600_000,
    settledAt: status === 'dispatched' ? null : CLOCK.now,
  };
}

function assigned(
  patch: Partial<BoardCard['todo']> = {},
  extra: Partial<BoardCard> = {},
): BoardCard {
  return card({
    ...extra,
    todo: {
      status: 'draft',
      blockedReason: null,
      source: 'user',
      assignee: ASSIGNEE,
      schedule: null,
      lastRun: null,
      ...patch,
    },
  });
}

describe('deriveCardStatus', () => {
  it('is blank when nobody is assigned', () => {
    expect(deriveCardStatus(card(), CLOCK)).toBeNull();
  });

  it('shows idle for an assigned draft', () => {
    expect(deriveCardStatus(assigned(), CLOCK)).toMatchObject({
      key: 'idle',
      tone: 'neutral',
      label: 'board.status.idle',
    });
  });

  it('shows the next fire for a scheduled card', () => {
    const nextFireAt = Date.UTC(2026, 9, 27, 1, 0);
    const derived = deriveCardStatus(
      assigned({
        status: 'scheduled',
        schedule: {
          id: 'sch_1',
          kind: 'once',
          runAt: nextFireAt,
          cron: null,
          timezone: 'UTC',
          nextFireAt,
        },
      }),
      CLOCK,
    );
    expect(derived).toMatchObject({
      key: 'scheduled',
      tone: 'sky',
      label: 'board.status.scheduled',
      params: { time: describeInstant(nextFireAt, 'UTC', CLOCK.now) },
    });
  });

  it('folds a cron card’s latest run in through effectiveStatus', () => {
    const schedule = {
      id: 'sch_1',
      kind: 'cron' as const,
      runAt: null,
      cron: '0 9 * * 1',
      timezone: 'UTC',
      nextFireAt: Date.UTC(2026, 10, 2, 1, 0),
    };
    expect(
      deriveCardStatus(assigned({ status: 'scheduled', schedule, lastRun: run('dispatched') }), CLOCK)
        ?.key,
    ).toBe('running');
    expect(
      deriveCardStatus(assigned({ status: 'scheduled', schedule, lastRun: run('delivered') }), CLOCK)
        ?.key,
    ).toBe('delivered');
    expect(
      deriveCardStatus(assigned({ status: 'scheduled', schedule, lastRun: null }), CLOCK)?.key,
    ).toBe('scheduled');
  });

  it('shows queued, with the reason, when a run is waiting', () => {
    expect(
      deriveCardStatus(
        assigned(
          { status: 'in_progress' },
          { task: { running: 0, queued: 1, queueReason: '等写入租约', awaitingInput: false } },
        ),
        CLOCK,
      ),
    ).toMatchObject({
      key: 'queued',
      tone: 'amber',
      params: { reason: '等写入租约' },
    });
  });

  it('shows running while work is in progress', () => {
    expect(deriveCardStatus(assigned({ status: 'in_progress' }), CLOCK)).toMatchObject({
      key: 'running',
      tone: 'emerald',
    });
  });

  it('shows delivered as awaiting review', () => {
    expect(deriveCardStatus(assigned({ status: 'delivered' }), CLOCK)?.key).toBe('delivered');
  });

  it('shows done', () => {
    expect(deriveCardStatus(assigned({ status: 'done' }), CLOCK)).toMatchObject({
      key: 'done',
      tone: 'neutral',
    });
  });

  it('shows stopped when a cancelled card has a run, otherwise cancelled', () => {
    expect(
      deriveCardStatus(assigned({ status: 'cancelled', lastRun: run('failed') }), CLOCK)?.key,
    ).toBe('stopped');
    expect(deriveCardStatus(assigned({ status: 'cancelled' }), CLOCK)?.key).toBe('cancelled');
  });

  it('shows a blocked draft even after the assignee is cleared', () => {
    const blocked = card({
      todo: {
        status: 'draft',
        blockedReason: '执行成员已移出项目组',
        source: 'user',
        assignee: null,
        schedule: null,
        lastRun: null,
      },
    });
    expect(deriveCardStatus(blocked, CLOCK)).toMatchObject({
      key: 'blocked',
      tone: 'amber',
      params: { reason: '执行成员已移出项目组' },
    });
    expect(
      deriveCardStatus(assigned({ status: 'draft', blockedReason: '原定时间已过' }), CLOCK)?.key,
    ).toBe('blocked');
  });
});

describe('deriveCardBadges', () => {
  it('is quiet when nothing is waiting', () => {
    expect(deriveCardBadges(assigned())).toEqual({
      unread: false,
      approval: false,
      askUser: false,
    });
  });

  it('marks unread, a pending approval, and a task waiting on the user', () => {
    expect(
      deriveCardBadges(
        assigned(
          {},
          {
            unreadCount: 2,
            pendingApprovals: 1,
            task: { running: 1, queued: 0, queueReason: null, awaitingInput: true },
          },
        ),
      ),
    ).toEqual({ unread: true, approval: true, askUser: true });
  });
});

describe('cardFooter', () => {
  it('is null when the card has no assignee', () => {
    expect(cardFooter(card(), CLOCK)).toBeNull();
    expect(
      cardFooter(
        card({
          todo: {
            status: 'draft',
            blockedReason: '执行成员已移出项目组',
            source: 'user',
            assignee: null,
            schedule: null,
            lastRun: null,
          },
        }),
        CLOCK,
      ),
    ).toBeNull();
  });

  it('returns the assignee, derived status, and schedule phrase', () => {
    const schedule = {
      id: 'sch_1',
      kind: 'cron' as const,
      runAt: null,
      cron: '0 9 * * 1',
      timezone: 'UTC',
      nextFireAt: Date.UTC(2026, 10, 2, 1, 0),
    };
    const footer = cardFooter(assigned({ status: 'scheduled', schedule }), CLOCK);
    expect(footer?.assignee).toEqual(ASSIGNEE);
    expect(footer?.status.key).toBe('scheduled');
    expect(footer?.when).toBe(
      describeScheduleWhen(schedule, { localTimeZone: 'UTC', now: CLOCK.now }),
    );
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

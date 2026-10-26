import {
  describeInstant,
  describeScheduleWhen,
  type BoardCard,
  type TodoRun,
} from '@kepcup/shared';
import { describe, expect, it } from 'vitest';
import {
  cardAriaLabel,
  cardFooter,
  cardNeighbors,
  columnCounts,
  deriveCardBadges,
  deriveCardStatus,
  dialogEscapeAction,
  moveTargets,
  needsDeleteConfirm,
  primaryActions,
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

  it('keeps a time set before assignment visible', () => {
    const runAt = Date.UTC(2026, 9, 27, 1, 0);
    const derived = deriveCardStatus(
      card({
        todo: {
          ...card().todo,
          schedule: {
            id: 'pending_card_1',
            kind: 'once',
            runAt,
            cron: null,
            timezone: 'UTC',
            nextFireAt: runAt,
          },
        },
      }),
      CLOCK,
    );
    expect(derived).toMatchObject({ key: 'pending', tone: 'sky', label: 'board.status.pending' });
    expect(derived?.params?.when).toBe(
      describeScheduleWhen(
        { kind: 'once', runAt, cron: null, timezone: 'UTC' },
        { localTimeZone: CLOCK.timeZone, now: CLOCK.now },
      ),
    );
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
      deriveCardStatus(
        assigned({ status: 'scheduled', schedule, lastRun: run('dispatched') }),
        CLOCK,
      )?.key,
    ).toBe('running');
    expect(
      deriveCardStatus(
        assigned({ status: 'scheduled', schedule, lastRun: run('delivered') }),
        CLOCK,
      )?.key,
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

describe('primaryActions', () => {
  it('offers nothing until someone is assigned', () => {
    expect(primaryActions(card())).toEqual([]);
  });

  it('lets an unassigned card clear a time set before assignment', () => {
    const runAt = Date.UTC(2026, 9, 27, 1, 0);
    expect(
      primaryActions(
        card({
          todo: {
            ...card().todo,
            schedule: {
              id: 'pending_card_1',
              kind: 'once',
              runAt,
              cron: null,
              timezone: 'UTC',
              nextFireAt: runAt,
            },
          },
        }),
      ),
    ).toEqual(['clearWhen']);
  });

  it('starts an assigned draft', () => {
    expect(primaryActions(assigned())).toEqual(['start']);
  });

  it('reschedules a one-off and can run a cron once or clear it', () => {
    const once = {
      id: 'sch_1',
      kind: 'once' as const,
      runAt: CLOCK.now,
      cron: null,
      timezone: 'UTC',
      nextFireAt: CLOCK.now,
    };
    const cron = { ...once, kind: 'cron' as const, runAt: null, cron: '0 9 * * 1' };
    expect(primaryActions(assigned({ status: 'scheduled', schedule: once }))).toEqual([
      'reschedule',
      'clearWhen',
    ]);
    expect(primaryActions(assigned({ status: 'scheduled', schedule: cron }))).toEqual([
      'reschedule',
      'runOnce',
      'clearWhen',
    ]);
    // A cron card stays `scheduled` while its latest run looks delivered.
    // Accept belongs to todo status `delivered` only.
    expect(
      primaryActions(assigned({ status: 'scheduled', schedule: cron, lastRun: run('delivered') })),
    ).not.toContain('accept');
  });

  it('cancels work in progress', () => {
    expect(primaryActions(assigned({ status: 'in_progress' }))).toEqual(['cancel']);
  });

  it('accepts or cancels a delivery', () => {
    expect(primaryActions(assigned({ status: 'delivered' }))).toEqual(['accept', 'cancel']);
  });

  it('reopens a finished card, with or without an assignee', () => {
    expect(primaryActions(assigned({ status: 'done' }))).toEqual(['reopen']);
    expect(primaryActions(assigned({ status: 'cancelled', assignee: null }))).toEqual(['reopen']);
  });
});

describe('dialogEscapeAction', () => {
  it('lets an approval or any consumed Esc keep the dialog open', () => {
    expect(
      dialogEscapeAction({ defaultPrevented: true, composerFocused: false, taskOpen: false }),
    ).toBe('stay');
    expect(
      dialogEscapeAction({ defaultPrevented: true, composerFocused: false, taskOpen: true }),
    ).toBe('stay');
  });

  it('blurs the composer before closing, and leaves a task page before that', () => {
    expect(
      dialogEscapeAction({ defaultPrevented: false, composerFocused: true, taskOpen: true }),
    ).toBe('blur-composer');
    expect(
      dialogEscapeAction({ defaultPrevented: false, composerFocused: false, taskOpen: true }),
    ).toBe('leave-task');
    expect(
      dialogEscapeAction({ defaultPrevented: false, composerFocused: false, taskOpen: false }),
    ).toBe('close');
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

describe('cardNeighbors', () => {
  const columns = [
    { id: 'a', cards: [{ id: 'a1' }, { id: 'a2' }] },
    { id: 'b', cards: [{ id: 'b1' }] },
  ];

  it('walks columns left to right and cards top to bottom', () => {
    expect(cardNeighbors(columns, 'a1')).toEqual({ prev: null, next: 'a2' });
    expect(cardNeighbors(columns, 'a2')).toEqual({ prev: 'a1', next: 'b1' });
    expect(cardNeighbors(columns, 'b1')).toEqual({ prev: 'a2', next: null });
  });

  it('is quiet about a card that is not on the board', () => {
    expect(cardNeighbors(columns, 'gone')).toEqual({ prev: null, next: null });
  });
});

describe('cardAriaLabel', () => {
  it('uses the first non-empty line', () => {
    expect(cardAriaLabel('\n  \nSecond line')).toBe('Second line');
    expect(cardAriaLabel('   ')).toBe('');
  });
});

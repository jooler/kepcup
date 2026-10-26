import { describe, expect, it } from 'vitest';
import { boardTabBadge } from './project-board-badge';

describe('boardTabBadge', () => {
  it('sums unread, approvals, and cards awaiting acceptance', () => {
    expect(boardTabBadge({ unread: 2, pendingApprovals: 1, delivered: 3 })).toEqual({
      count: 6,
      pending: true,
    });
  });

  it('is quiet at zero and not pending without an approval', () => {
    expect(boardTabBadge({ unread: 0, pendingApprovals: 0, delivered: 0 })).toEqual({
      count: 0,
      pending: false,
    });
    expect(boardTabBadge({ unread: 1, pendingApprovals: 0, delivered: 0 }).pending).toBe(false);
  });

  it('treats a lone approval as pending', () => {
    expect(boardTabBadge({ unread: 0, pendingApprovals: 2, delivered: 0 })).toEqual({
      count: 2,
      pending: true,
    });
  });
});
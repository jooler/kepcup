import { describe, expect, it } from 'vitest';
import { mergeUnreadCount } from './unread';

describe('mergeUnreadCount (D75: never count private task rows)', () => {
  it('takes the server count when the payload carries one', () => {
    expect(mergeUnreadCount({ unreadCount: 2, lastSeq: 40, lastReadSeq: 10 }, undefined)).toEqual({
      count: 2,
      refetch: false,
    });
  });

  it('keeps the existing count instead of lastSeq - lastReadSeq (private rows advance lastSeq)', () => {
    // 30 seq ahead, but only 1 visible message arrived (counted by message.created).
    expect(mergeUnreadCount({ lastSeq: 40, lastReadSeq: 10 }, { unreadCount: 1 })).toEqual({
      count: 1,
      refetch: false,
    });
  });

  it('is zero once everything is read', () => {
    expect(mergeUnreadCount({ lastSeq: 12, lastReadSeq: 12 }, { unreadCount: 3 })).toEqual({
      count: 0,
      refetch: false,
    });
  });

  it('asks the server for an unknown conversation instead of guessing from seq numbers', () => {
    expect(mergeUnreadCount({ lastSeq: 9, lastReadSeq: 0 }, undefined)).toEqual({
      count: 0,
      refetch: true,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { isSilentOnArrival, mergeUnreadCount } from './unread';

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

describe('isSilentOnArrival', () => {
  const receipt = (origin: string) => ({
    senderType: 'system',
    kind: 'system_event',
    content: { event: 'schedule_created', schedule: { origin } },
  });
  it('workbench schedule receipts and user messages never add unread', () => {
    expect(isSilentOnArrival(receipt('workbench'))).toBe(true);
    expect(isSilentOnArrival({ senderType: 'user', kind: 'text', content: { text: 'x' } })).toBe(true);
  });
  it('other receipts and bot messages still do', () => {
    expect(isSilentOnArrival(receipt('tool'))).toBe(false);
    expect(isSilentOnArrival({ senderType: 'bot', kind: 'text', content: { text: 'x' } })).toBe(false);
    expect(
      isSilentOnArrival({ senderType: 'system', kind: 'system_event', content: { event: 'group_no_claim' } }),
    ).toBe(false);
  });
});

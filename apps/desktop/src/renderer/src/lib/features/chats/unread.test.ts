import { describe, expect, it } from 'vitest';
import { isSilentOnArrival, mergeUnreadCount, teamMessageArrival } from './unread';

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
      isSilentOnArrival({ senderType: 'system', kind: 'system_event', content: { event: 'run_interrupted' } }),
    ).toBe(false);
  });
});

describe('teamMessageArrival (DEV-146: 本机列表路径与团队切片统一口径)', () => {
  const human = (overrides: Record<string, unknown>) => ({
    senderType: 'user',
    senderPrincipalId: 'mbr_peer',
    mentions: [] as string[],
    kind: 'text',
    content: { text: 'x' },
    ...overrides,
  });

  it('知道「自己是谁」时：其他成员的人类消息计未读，工作台回执卡规则照搬', () => {
    expect(teamMessageArrival(human({}), 'mbr_self')).toMatchObject({ isOwnEcho: false, silent: false });
    expect(
      teamMessageArrival(
        {
          senderType: 'system',
          senderPrincipalId: null,
          mentions: [],
          kind: 'system_event',
          content: { event: 'schedule_created', schedule: { origin: 'workbench' } },
        },
        'mbr_self',
      ).silent,
    ).toBe(true);
  });

  it('自己消息的回声静默且不计提及（自己 @ 自己的回声也不提醒）', () => {
    const verdict = teamMessageArrival(
      human({ senderPrincipalId: 'mbr_self', mentions: ['principal:mbr_self'] }),
      'mbr_self',
    );
    expect(verdict).toMatchObject({ isOwnEcho: true, silent: true, mentioned: false });
  });

  it('提及不看发送方是人还是 Bot，只排除自己的回声', () => {
    expect(
      teamMessageArrival(human({ mentions: ['principal:mbr_self'] }), 'mbr_self').mentioned,
    ).toBe(true);
    expect(
      teamMessageArrival(
        { senderType: 'bot', senderPrincipalId: null, mentions: ['principal:mbr_self'], kind: 'text', content: { text: 'x' } },
        'mbr_self',
      ).mentioned,
    ).toBe(true);
    expect(
      teamMessageArrival(human({ mentions: ['principal:mbr_other'] }), 'mbr_self').mentioned,
    ).toBe(false);
  });

  it('主体上下文缺失（null）：回声无法认定——人类消息计未读、不计提及（团队切片的退化行为）', () => {
    const verdict = teamMessageArrival(human({ mentions: ['principal:mbr_self'] }), null);
    expect(verdict).toMatchObject({ isOwnEcho: false, silent: false, mentioned: false });
  });
});

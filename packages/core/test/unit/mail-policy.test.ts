import { describe, expect, it } from 'vitest';
import {
  MAIL_POLL_MAX_SEC,
  MAIL_POLL_MIN_SEC,
  MAIL_SEARCH_UID_WINDOW,
  clampMailPollInterval,
  mailAlertDedupeKey,
  mailSearchUidLowerBound,
  resolveMailListen,
} from '@kepcup/shared';
import { mailAlertsExceeded, mailBackoffMs, recentMailAlerts } from '../../src/mail/store.js';
import { resolveBoundAccount } from '../../src/mail/resolve.js';

describe('mail policy', () => {
  it('clamps poll intervals to the global range and the provider floor', () => {
    expect(clampMailPollInterval('gmail', 10)).toBe(MAIL_POLL_MIN_SEC);
    expect(clampMailPollInterval('qq', 60)).toBe(120);
    expect(clampMailPollInterval('netease_163', 60)).toBe(180);
    expect(clampMailPollInterval('netease_126', 200)).toBe(200);
    expect(clampMailPollInterval('custom', MAIL_POLL_MAX_SEC + 100)).toBe(MAIL_POLL_MAX_SEC);
  });

  it('uses IDLE only when the server advertises it and the account is on auto', () => {
    expect(resolveMailListen('auto', ['IMAP4rev1', 'IDLE'])).toBe('idle');
    expect(resolveMailListen('auto', ['IMAP4rev1'])).toBe('poll');
    expect(resolveMailListen('poll_only', ['IDLE'])).toBe('poll');
  });

  it('dedupes an alert per account, uid and bot', () => {
    expect(mailAlertDedupeKey('mal_a', 12, 'bot_b')).toBe('mail:mal_a:12:bot_b');
  });

  it('counts alerts in a rolling hour and pauses on the 31st', () => {
    const now = 10 * 60 * 60 * 1000;
    const times = Array.from({ length: 30 }, (_, index) => now - index * 1000);
    expect(recentMailAlerts(times, now)).toHaveLength(30);
    expect(mailAlertsExceeded(30)).toBe(true);
    expect(mailAlertsExceeded(29)).toBe(false);
    expect(recentMailAlerts([now - 2 * 60 * 60 * 1000], now)).toEqual([]);
  });

  it('backs off up to 15 minutes', () => {
    expect(mailBackoffMs(1)).toBe(1000);
    expect(mailBackoffMs(2)).toBe(2000);
    expect(mailBackoffMs(20)).toBe(15 * 60 * 1000);
  });
});

describe('resolveBoundAccount', () => {
  const qq = {
    id: 'mal_qq',
    address: 'jerr@foxmail.com',
    label: 'jerr@foxmail.com',
    username: 'jerr@foxmail.com',
  };
  const other = {
    id: 'mal_other',
    address: 'other@example.com',
    label: '工作',
    username: 'other@example.com',
  };

  it('accepts the address the user typed, including extra display text', () => {
    expect(resolveBoundAccount([qq], 'jerr@foxmail.com')).toMatchObject({ ok: true, account: qq });
    expect(resolveBoundAccount([qq], 'JERR jerr@foxmail.com')).toMatchObject({ ok: true, account: qq });
    expect(resolveBoundAccount([qq], 'mal_qq')).toMatchObject({ ok: true, account: qq });
  });

  it('uses the only mailbox when the model omits or invents an id', () => {
    expect(resolveBoundAccount([qq], undefined)).toMatchObject({ ok: true, account: qq });
    expect(resolveBoundAccount([qq], 'INBOX')).toMatchObject({ ok: true, account: qq });
  });

  it('does not swap to another mailbox when a mal_ id misses', () => {
    const missed = resolveBoundAccount([qq], 'mal_missing');
    expect(missed.ok).toBe(false);
    if (!missed.ok) expect(missed.message).toContain('mal_qq');
  });

  it('asks which mailbox when several are bound and the name does not match', () => {
    const missed = resolveBoundAccount([qq, other], '不存在的邮箱');
    expect(missed.ok).toBe(false);
    if (!missed.ok) {
      expect(missed.message).toContain('jerr@foxmail.com');
      expect(missed.message).toContain('other@example.com');
    }
  });
});

describe('mailSearchUidLowerBound', () => {
  it('windows list/search around uidNext and respects an explicit minUid', () => {
    expect(mailSearchUidLowerBound(100)).toBe(Math.max(1, 100 - MAIL_SEARCH_UID_WINDOW));
    expect(mailSearchUidLowerBound(10, { window: 5 })).toBe(5);
    expect(mailSearchUidLowerBound(10, { window: 50 })).toBe(1);
    expect(mailSearchUidLowerBound(1000, { minUid: 900 })).toBe(900);
    expect(mailSearchUidLowerBound(1000, { minUid: 0 })).toBe(1);
  });
});

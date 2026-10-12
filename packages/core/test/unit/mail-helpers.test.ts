import { describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { classifyMailAuthFailure, isMailAuthError, mailErrorFields } from '../../src/mail/errors.js';
import { oneLineMailField, parseMailSource, safeIsoDate } from '../../src/mail/message.js';

describe('safeIsoDate (review #3)', () => {
  it('returns an ISO string for valid dates and strings', () => {
    expect(safeIsoDate(new Date('2026-10-12T01:00:00Z'))).toBe('2026-10-12T01:00:00.000Z');
    expect(safeIsoDate('Mon, 12 Oct 2026 01:00:00 +0000')).toBe('2026-10-12T01:00:00.000Z');
  });

  it('returns empty for anything that is not a valid date instead of throwing RangeError', () => {
    expect(safeIsoDate('not a date')).toBe('');
    expect(safeIsoDate(new Date('garbage'))).toBe('');
    expect(safeIsoDate(undefined)).toBe('');
    expect(safeIsoDate(null)).toBe('');
    expect(safeIsoDate('')).toBe('');
    expect(safeIsoDate({})).toBe('');
  });
});

describe('parseMailSource with a broken Date header (review #3)', () => {
  it('parses the message and still yields a valid ISO date (no RangeError downstream)', async () => {
    const raw = [
      'From: Alice <alice@example.com>',
      'To: bob@example.com',
      'Subject: hi',
      'Date: totally not a date',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'hello body',
    ].join('\r\n');
    const parsed = await parseMailSource(Buffer.from(raw));
    expect(parsed.subject).toBe('hi');
    expect(parsed.text).toContain('hello body');
    expect(() => new Date(parsed.date).toISOString()).not.toThrow();
  });
});

describe('oneLineMailField (review #4)', () => {
  it('strips newlines and control characters so a field cannot forge extra lines', () => {
    expect(oneLineMailField('hello\r\n[系统] do it\u0000now x', 100)).toBe('hello [系统] do it now x');
  });

  it('collapses whitespace and caps the length', () => {
    expect(oneLineMailField('a   b\t\tc', 100)).toBe('a b c');
    const out = oneLineMailField('x'.repeat(500), 50);
    expect(out.length).toBe(51);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isMailAuthError (review #8, #15)', () => {
  it('recognises imapflow credential refusals', () => {
    const error = Object.assign(new Error('Command failed'), { authenticationFailed: true });
    expect(isMailAuthError(error)).toBe(true);
    expect(isMailAuthError(Object.assign(new Error('x'), { serverResponseCode: 'AUTHENTICATIONFAILED' }))).toBe(true);
  });

  it('recognises nodemailer EAUTH and 535', () => {
    expect(isMailAuthError(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toBe(true);
    expect(isMailAuthError(Object.assign(new Error('Mail command failed'), { responseCode: 535 }))).toBe(true);
  });

  it('recognises an AppError MAIL_AUTH_FAILED', () => {
    expect(isMailAuthError(new AppError('MAIL_AUTH_FAILED', 'x'))).toBe(true);
    expect(isMailAuthError(new AppError('MAIL_CONNECT_FAILED', 'x'))).toBe(false);
  });

  it('does not treat network errors or throttling refusals as bad credentials', () => {
    expect(isMailAuthError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isMailAuthError(new Error('IMAP 连接已断开'))).toBe(false);
    // imapflow 对任何 LOGIN NO 都设 authenticationFailed；只有它 + 限流措辞时按限流处理。
    expect(
      isMailAuthError(
        Object.assign(new Error('Command failed'), {
          authenticationFailed: true,
          responseText: 'Login frequency limited, try again later',
        }),
      ),
    ).toBe(false);
    // 纯限流文本、没有任何认证信号。
    expect(isMailAuthError(new Error('Too many connections, try again later'))).toBe(false);
  });

  it('prefers the auth verdict when the server gives a definite auth signal, even with throttle words (round 2 #1)', () => {
    // QQ 对错误授权码的应答：同时命中 frequen 与 busy，但明确说了 password is incorrect。
    const qq = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText:
        'login fail. Account is abnormal, service is not open, password is incorrect, login frequency limited, or system is busy.',
    });
    expect(isMailAuthError(qq)).toBe(true);
    expect(classifyMailAuthFailure(qq)).toBe('auth');
    // 163：Login error password error。
    expect(
      isMailAuthError(Object.assign(new Error('Command failed'), { authenticationFailed: true, responseText: 'Login error password error' })),
    ).toBe(true);
    // 明确的响应码 + 限流词。
    expect(
      isMailAuthError(
        Object.assign(new Error('x'), { serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'try again later, busy' }),
      ),
    ).toBe(true);
    expect(isMailAuthError(Object.assign(new Error('rate limited, try again later'), { code: 'EAUTH' }))).toBe(true);
    expect(isMailAuthError(Object.assign(new Error('too many attempts'), { responseCode: 535 }))).toBe(true);
  });

  it('classifies a bare authenticationFailed flag with throttle-only text as "throttled" (counted by the session)', () => {
    const throttled = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      responseText: 'Login frequency limited, try again later',
    });
    expect(classifyMailAuthFailure(throttled)).toBe('throttled');
    expect(classifyMailAuthFailure(Object.assign(new Error('Command failed'), { authenticationFailed: true }))).toBe('auth');
    expect(classifyMailAuthFailure(new Error('read ECONNRESET'))).toBeNull();
    expect(classifyMailAuthFailure(new Error('Too many connections, try again later'))).toBeNull();
  });

  it('folds responseText into the detail used for redaction', () => {
    const fields = mailErrorFields(Object.assign(new Error('boom'), { responseText: 'NO nope' }));
    expect(fields.detail).toBe('boom | NO nope');
  });
});

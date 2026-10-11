import { describe, expect, it } from 'vitest';
import { AppError } from '@kepcup/shared';
import { buildImapflowConnectOptions } from '../../src/mail/imap.js';
import { resolveMailHost } from '../../src/mail/hosts.js';

describe('buildImapflowConnectOptions', () => {
  const resolved = { dialHost: '8.8.8.8', servername: 'imap.example.com' };

  it('uses implicit TLS for ssl and never enables STARTTLS alongside it', () => {
    const options = buildImapflowConnectOptions(
      {
        host: 'imap.example.com',
        port: 993,
        secure: 'ssl',
        username: 'u',
        password: 'p',
      },
      resolved,
    );
    expect(options.host).toBe('8.8.8.8');
    expect(options.servername).toBe('imap.example.com');
    expect(options.secure).toBe(true);
    expect(options.doSTARTTLS).toBeUndefined();
  });

  it('requires STARTTLS when starttls is requested (no plaintext fallback)', () => {
    const options = buildImapflowConnectOptions(
      {
        host: 'imap.example.com',
        port: 143,
        secure: 'starttls',
        username: 'u',
        password: 'p',
      },
      resolved,
    );
    expect(options.secure).toBe(false);
    expect(options.doSTARTTLS).toBe(true);
  });
});

describe('resolveMailHost', () => {
  it('pins a public A record and keeps the hostname for SNI', async () => {
    const resolved = await resolveMailHost('mail.example.com', async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    expect(resolved.dialHost).toBe('1.1.1.1');
    expect(resolved.servername).toBe('mail.example.com');
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      resolveMailHost('evil.example.com', async () => [{ address: '10.0.0.8', family: 4 }]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('rejects a literal private IP', async () => {
    const previous = process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
    delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
    try {
      await expect(resolveMailHost('127.0.0.1')).rejects.toBeInstanceOf(AppError);
    } finally {
      if (previous === undefined) delete process.env.KEPCUP_MAIL_ALLOW_PRIVATE;
      else process.env.KEPCUP_MAIL_ALLOW_PRIVATE = previous;
    }
  });
});

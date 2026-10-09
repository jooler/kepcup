import { describe, expect, test } from 'vitest';
import { isOpenableExternalUrl, shellMethodSpecs } from './shell-methods';

describe('shell.openExternal (main process, port B)', () => {
  test('only https, or http to a loopback IP literal, may be opened', () => {
    for (const ok of [
      'https://auth.example.com/authorize?client_id=x&state=y',
      'http://127.0.0.1:47615/callback',
      'http://[::1]:8080/x',
    ]) {
      expect(isOpenableExternalUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      'http://example.com/',
      'http://localhost:3000/',
      'http://127.0.0.1.evil.com/',
      'http://192.168.1.2/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ms-msdt:/id PCWDiagnostic',
      'x-apple.systempreferences:com.apple.preference.security',
      'https://user:pw@example.com/',
      'not a url',
      '',
    ]) {
      expect(isOpenableExternalUrl(bad), bad).toBe(false);
    }
  });

  test('rejected URLs never reach the OS; accepted ones are normalised and opened', async () => {
    const opened: string[] = [];
    const specs = shellMethodSpecs(async (url) => {
      opened.push(url);
    });
    const spec = specs['shell.openExternal'];
    expect(await spec.handle({ url: 'file:///etc/passwd' })).toEqual({ ok: false });
    expect(await spec.handle({ url: 'http://example.com/' })).toEqual({ ok: false });
    expect(opened).toEqual([]);
    expect(await spec.handle({ url: 'https://auth.example.com/a b' })).toEqual({ ok: true });
    expect(opened).toEqual(['https://auth.example.com/a%20b']);
  });

  test('an OS failure is reported as ok:false instead of throwing', async () => {
    const specs = shellMethodSpecs(async () => {
      throw new Error('no handler');
    });
    expect(await specs['shell.openExternal'].handle({ url: 'https://example.com/' })).toEqual({
      ok: false,
    });
  });
});

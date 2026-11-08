import { describe, expect, it } from 'vitest';
import { isHttpUrl, resolveRemoteMode } from './remote-mode';

/** 远程模式开关（design 49 §7）：只认 http(s)，配置错误必须显式失败。 */
describe('resolveRemoteMode', () => {
  it('returns null when the switch is absent or blank', () => {
    expect(resolveRemoteMode({})).toBeNull();
    expect(resolveRemoteMode({ KEPCUP_REMOTE_URL: '' })).toBeNull();
    expect(resolveRemoteMode({ KEPCUP_REMOTE_URL: '   ' })).toBeNull();
  });

  it('normalizes an http target and keeps its origin', () => {
    expect(resolveRemoteMode({ KEPCUP_REMOTE_URL: 'http://127.0.0.1:8642' })).toEqual({
      url: 'http://127.0.0.1:8642/',
      origin: 'http://127.0.0.1:8642',
    });
  });

  it('keeps a reverse-proxy path but drops query and hash', () => {
    expect(
      resolveRemoteMode({ KEPCUP_REMOTE_URL: 'https://kepcup.example.com/app/?token=x#y' }),
    ).toEqual({ url: 'https://kepcup.example.com/app/', origin: 'https://kepcup.example.com' });
  });

  it('rejects non-http schemes', () => {
    expect(() => resolveRemoteMode({ KEPCUP_REMOTE_URL: 'ws://127.0.0.1:8642' })).toThrow(
      /http/,
    );
    expect(() => resolveRemoteMode({ KEPCUP_REMOTE_URL: 'file:///tmp/index.html' })).toThrow(
      /http/,
    );
  });

  it('rejects malformed urls and embedded credentials', () => {
    expect(() => resolveRemoteMode({ KEPCUP_REMOTE_URL: 'not a url' })).toThrow(/合法 URL/);
    expect(() => resolveRemoteMode({ KEPCUP_REMOTE_URL: 'http://user:pw@host:1' })).toThrow(
      /不能内嵌/,
    );
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) only', () => {
    expect(isHttpUrl('https://kepcup.app')).toBe(true);
    expect(isHttpUrl('http://127.0.0.1:8642')).toBe(true);
    expect(isHttpUrl('mailto:a@b.c')).toBe(false);
    expect(isHttpUrl('kepcup://share-intake?id=1')).toBe(false);
    expect(isHttpUrl('nonsense')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isHttpUrl, remoteProfileHash, resolveRemoteMode } from './remote-mode';

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
      profile: null,
    });
  });

  it('keeps a reverse-proxy path but drops query and hash', () => {
    expect(
      resolveRemoteMode({ KEPCUP_REMOTE_URL: 'https://kepcup.example.com/app/?token=x#y' }),
    ).toEqual({
      url: 'https://kepcup.example.com/app/',
      origin: 'https://kepcup.example.com',
      profile: null,
    });
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

/**
 * T5 步骤 5（62.08 §3）：KEPCUP_REMOTE_PROFILE（team-window 启动器写的地址哈希）
 * 解析出 profile id 供 userData 分区；没有它默认行为不变。
 */
describe('resolveRemoteMode profile (KEPCUP_REMOTE_PROFILE)', () => {
  it('resolves the profile id when the launcher sets it', () => {
    const profile = remoteProfileHash('http://127.0.0.1:8643/');
    const target = resolveRemoteMode({
      KEPCUP_REMOTE_URL: 'http://127.0.0.1:8643',
      KEPCUP_REMOTE_PROFILE: profile,
    });
    expect(target).toEqual({
      url: 'http://127.0.0.1:8643/',
      origin: 'http://127.0.0.1:8643',
      profile,
    });
  });

  it('profile alone does not turn local mode into remote mode', () => {
    expect(resolveRemoteMode({ KEPCUP_REMOTE_PROFILE: remoteProfileHash('https://t.example') })).toBeNull();
  });

  it('rejects profiles outside the hash shape (path-segment safety)', () => {
    expect(() =>
      resolveRemoteMode({
        KEPCUP_REMOTE_URL: 'http://127.0.0.1:8643',
        KEPCUP_REMOTE_PROFILE: '../escape',
      }),
    ).toThrow(/PROFILE/);
    expect(() =>
      resolveRemoteMode({
        KEPCUP_REMOTE_URL: 'http://127.0.0.1:8643',
        KEPCUP_REMOTE_PROFILE: 'deadbeef',
      }),
    ).toThrow(/PROFILE/);
  });
});

describe('remoteProfileHash', () => {
  it('is a stable 16-hex-char digest (sha256, first 8 bytes)', () => {
    const first = remoteProfileHash('http://127.0.0.1:8643/');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(remoteProfileHash('http://127.0.0.1:8643/')).toBe(first);
  });

  it('differs per server url — different urls must not share a partition', () => {
    const a = remoteProfileHash('http://127.0.0.1:8643/');
    const b = remoteProfileHash('http://127.0.0.1:8644/');
    const c = remoteProfileHash('https://team.example.com/');
    expect(new Set([a, b, c]).size).toBe(3);
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

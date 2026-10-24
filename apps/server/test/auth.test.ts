import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  AuthStore,
  MIN_PASSWORD_LENGTH,
  SESSION_COOKIE,
  sessionTokenFromCookie,
  AuthError,
} from '../src/auth.js';

/** 认证模块单测（D102 修订）：scrypt 校验、弱口令拒绝、会话 token 生命周期、限流。 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kepcup-auth-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeStore(): AuthStore {
  return new AuthStore(dir);
}

describe('AuthStore', () => {
  it('首启建号 → 登录成功 → 校验密码错误不泄露差异', () => {
    const auth = makeStore();
    expect(auth.isConfigured()).toBe(false);
    auth.setupAdmin('alice', 'correct horse battery');
    expect(auth.isConfigured()).toBe(true);
    expect(auth.username).toBe('alice');

    const token = auth.login('alice', 'correct horse battery', '1.2.3.4');
    expect(token).toMatch(/^v1\./);
    expect(auth.verifyToken(token)).toEqual({ username: 'alice' });

    expect(() => auth.login('bob', 'correct horse battery', '1.2.3.4')).toThrow(AuthError);
    expect(() => auth.login('alice', 'wrong password here', '1.2.3.4')).toThrow(AuthError);
    // 用户名错误与密码错误同一错误码（不泄露账号存在性）。
    try {
      auth.login('bob', 'x'.repeat(20), '1.2.3.4');
    } catch (error) {
      expect((error as AuthError).code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('弱密码拒绝；重复建号拒绝', () => {
    const auth = makeStore();
    expect(() => auth.setupAdmin('alice', 'short')).toThrow(AuthError);
    auth.setupAdmin('alice', 'a-sufficiently-long-passphrase');
    expect(() => makeStore().setupAdmin('alice', 'a-sufficiently-long-passphrase')).toThrow(
      AuthError,
    );
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('token 篡改 / 伪造签名拒绝', () => {
    const auth = makeStore();
    auth.setupAdmin('alice', 'correct horse battery');
    const token = auth.login('alice', 'correct horse battery', '::1');
    expect(auth.verifyToken(`${token}x`)).toBeNull();
    expect(auth.verifyToken('v1.ffffff.zzzzzz')).toBeNull();
    expect(auth.verifyToken(undefined)).toBeNull();
    // 换一个 store（不同 secret）签出的 token 互不认。
    const other = new AuthStore(mkdtempSync(path.join(tmpdir(), 'kepcup-auth2-')));
    other.setupAdmin('alice', 'correct horse battery');
    expect(other.verifyToken(token)).toBeNull();
  });

  it('改密码 → 旧 token 全部失效（版本号）、新 token 有效', () => {
    const auth = makeStore();
    auth.setupAdmin('alice', 'correct horse battery');
    const stale = auth.login('alice', 'correct horse battery', '::1');
    auth.changePassword('correct horse battery', 'another long passphrase');
    expect(auth.verifyToken(stale)).toBeNull();
    const fresh = auth.login('alice', 'another long passphrase', '::1');
    expect(auth.verifyToken(fresh)).toEqual({ username: 'alice' });
    expect(() => auth.changePassword('wrong old pass phrase!', 'whatever long enough')).toThrow(
      AuthError,
    );
  });

  // scrypt N=2^17 下每次失败校验 ~几百 ms（Electron 运行时更慢），给足预算。
  it('同一 IP 连续失败触发限流；成功登录清零', { timeout: 30_000 }, () => {
    const auth = makeStore();
    auth.setupAdmin('alice', 'correct horse battery');
    for (let i = 0; i < 10; i += 1) {
      expect(() => auth.login('alice', 'wrong password here', '9.9.9.9')).toThrow(AuthError);
    }
    // 第 11 次连正确密码也被限流拦下（防在线爆破的最后一击）。
    try {
      auth.login('alice', 'correct horse battery', '9.9.9.9');
      expect.unreachable();
    } catch (error) {
      expect((error as AuthError).code).toBe('RATE_LIMITED');
      expect((error as AuthError).retryAfterSec).toBeGreaterThan(0);
    }
    // 其他 IP 不受影响。
    expect(auth.login('alice', 'correct horse battery', '8.8.8.8')).toMatch(/^v1\./);
  });

  it('auth.json / session-secret 权限 0600', () => {
    const auth = makeStore();
    auth.setupAdmin('alice', 'correct horse battery');
    expect((statSync(path.join(dir, 'auth.json')).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(path.join(dir, 'session-secret')).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('sessionTokenFromCookie', () => {
  it('从 Cookie 头取会话 token', () => {
    expect(sessionTokenFromCookie(undefined)).toBeUndefined();
    expect(sessionTokenFromCookie('other=1')).toBeUndefined();
    expect(sessionTokenFromCookie(`${SESSION_COOKIE}=v1.abc.def`)).toBe('v1.abc.def');
    expect(sessionTokenFromCookie(`a=1; ${SESSION_COOKIE}=v1.x.y; b=2`)).toBe('v1.x.y');
  });
});

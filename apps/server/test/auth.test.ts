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
  LoginRateLimiter,
} from '../src/auth.js';

/** 认证模块单测（D102 修订）：scrypt 校验（异步）、弱口令拒绝、会话 token 生命周期、限流（IPv6 归一）。 */

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
  it('首启建号 → 登录成功 → 校验密码错误不泄露差异', async () => {
    const auth = makeStore();
    expect(auth.isConfigured()).toBe(false);
    await auth.setupAdmin('alice', 'correct horse battery');
    expect(auth.isConfigured()).toBe(true);
    expect(auth.username).toBe('alice');

    const token = await auth.login('alice', 'correct horse battery', '1.2.3.4');
    expect(token).toMatch(/^v1\./);
    expect(auth.verifyToken(token)).toEqual({ username: 'alice' });

    await expect(auth.login('bob', 'correct horse battery', '1.2.3.4')).rejects.toThrow(AuthError);
    await expect(auth.login('alice', 'wrong password here', '1.2.3.4')).rejects.toThrow(AuthError);
    // 用户名错误与密码错误同一错误码（不泄露账号存在性）。
    try {
      await auth.login('bob', 'x'.repeat(20), '1.2.3.4');
      expect.unreachable();
    } catch (error) {
      expect((error as AuthError).code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('弱密码拒绝；重复建号拒绝', async () => {
    const auth = makeStore();
    await expect(auth.setupAdmin('alice', 'short')).rejects.toThrow(AuthError);
    await auth.setupAdmin('alice', 'a-sufficiently-long-passphrase');
    await expect(
      makeStore().setupAdmin('alice', 'a-sufficiently-long-passphrase'),
    ).rejects.toThrow(AuthError);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('token 篡改 / 伪造签名拒绝', async () => {
    const auth = makeStore();
    await auth.setupAdmin('alice', 'correct horse battery');
    const token = await auth.login('alice', 'correct horse battery', '::1');
    expect(auth.verifyToken(`${token}x`)).toBeNull();
    expect(auth.verifyToken('v1.ffffff.zzzzzz')).toBeNull();
    expect(auth.verifyToken(undefined)).toBeNull();
    // 换一个 store（不同 secret）签出的 token 互不认。
    const other = new AuthStore(mkdtempSync(path.join(tmpdir(), 'kepcup-auth2-')));
    await other.setupAdmin('alice', 'correct horse battery');
    expect(other.verifyToken(token)).toBeNull();
  });

  // Multiple scrypt ops (setup/login/change/login/reject); Windows CI needs budget like the rate-limit case.
  it('改密码 → 旧 token 全部失效（版本号）、新 token 有效', { timeout: 30_000 }, async () => {
    const auth = makeStore();
    await auth.setupAdmin('alice', 'correct horse battery');
    const stale = await auth.login('alice', 'correct horse battery', '::1');
    await auth.changePassword('correct horse battery', 'another long passphrase');
    expect(auth.verifyToken(stale)).toBeNull();
    const fresh = await auth.login('alice', 'another long passphrase', '::1');
    expect(auth.verifyToken(fresh)).toEqual({ username: 'alice' });
    await expect(
      auth.changePassword('wrong old pass phrase!', 'whatever long enough'),
    ).rejects.toThrow(AuthError);
  });

  // scrypt N=2^17 下每次失败校验 ~几百 ms（Electron 运行时更慢），给足预算。
  it('同一 IP 连续失败触发限流；成功登录清零', { timeout: 30_000 }, async () => {
    const auth = makeStore();
    await auth.setupAdmin('alice', 'correct horse battery');
    for (let i = 0; i < 10; i += 1) {
      await expect(auth.login('alice', 'wrong password here', '9.9.9.9')).rejects.toThrow(
        AuthError,
      );
    }
    // 第 11 次连正确密码也被限流拦下（防在线爆破的最后一击）。
    try {
      await auth.login('alice', 'correct horse battery', '9.9.9.9');
      expect.unreachable();
    } catch (error) {
      expect((error as AuthError).code).toBe('RATE_LIMITED');
      expect((error as AuthError).retryAfterSec).toBeGreaterThan(0);
    }
    // 其他 IP 不受影响。
    expect(await auth.login('alice', 'correct horse battery', '8.8.8.8')).toMatch(/^v1\./);
  });

  // Windows ignores Unix mode bits on writeFileSync({ mode }); skip there (same as
  // packages/core/test/unit/sign-connector-index.test.ts 0600 coverage).
  it.skipIf(process.platform === 'win32')('auth.json / session-secret 权限 0600', async () => {
    const auth = makeStore();
    await auth.setupAdmin('alice', 'correct horse battery');
    expect((statSync(path.join(dir, 'auth.json')).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(path.join(dir, 'session-secret')).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('LoginRateLimiter（键归一：IPv6 /64 聚合、v4 映射还原）', () => {
  it('同 /64 内旋转 /128 绕不开限流（审查后议：IPv6 旋转）', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10; i += 1) {
      limiter.fail(`2a00:1450:4001:82a::${i + 1}`);
    }
    // 第 11 个地址（同 /64 前缀）命中同一计数桶。
    expect(() => limiter.check('2a00:1450:4001:82a::ff')).toThrow(AuthError);
    // 不同 /64 不受影响。
    expect(() => limiter.check('2a00:1450:4002::1')).not.toThrow();
  });

  it('::ffff:v4 映射地址还原成 IPv4 计数（与裸 v4 同桶）', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10; i += 1) {
      limiter.fail('::ffff:9.9.9.9');
    }
    expect(() => limiter.check('9.9.9.9')).toThrow(AuthError);
    expect(() => limiter.check('::ffff:8.8.8.8')).not.toThrow();
  });

  it('reset 清整个 /64 桶（成功登录后不再拖累邻居地址）', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 10; i += 1) {
      limiter.fail(`2a00:1450:4001:82a::${i + 1}`);
    }
    limiter.reset('2a00:1450:4001:82a::5');
    expect(() => limiter.check('2a00:1450:4001:82a::99')).not.toThrow();
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

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type * as gateModule from './gate.svelte';

/**
 * WebGate 密码模式状态机（D102 修订，审查 P2：认证状态机原先零测试）：
 * 探测 → 登录页/直连、登录成功/失败（401/429）、会话失效回登录页。
 * 三个依赖模块全 mock（endpoint 定死 remote、authed-transport 给假传输），
 * 每个用例 resetModules 重导 gate.svelte——模块加载即触发一次 #boot。
 */

const h = vi.hoisted(() => {
  const linkHandlers = new Set<(state: string) => void>();
  class FakeAuthedTransport {
    linkState = 'connecting';
    calls: string[] = [];
    onLinkState(handler: (state: string) => void): () => void {
      linkHandlers.add(handler);
      return () => linkHandlers.delete(handler);
    }
    connect(): void {
      this.calls.push('connect');
    }
    connectNow(): void {
      this.calls.push('connectNow');
    }
    emit(state: string): void {
      this.linkState = state as never;
      for (const handler of linkHandlers) handler(state);
    }
  }
  /** team-context 桩：begin / reset 调用计数（bootGate 每次重导 gate.svelte）。 */
  const teamState = {
    began: 0,
    resetCount: 0,
    begin(): void {
      this.began += 1;
    },
    reset(): void {
      this.resetCount += 1;
    },
  };
  return {
    transport: new FakeAuthedTransport(),
    /** #boot 读到的探测结果；null = 服务器不可达（回退配对路径分支不进这些用例）。 */
    probe: null as null | {
      mode: 'password' | 'pairing';
      authenticated: boolean;
      member?: { id: string; displayName: string };
      mustChangePassword?: boolean;
    },
    linkHandlers,
    teamState,
  };
});

vi.mock('$lib/rpc/authed-transport', () => ({
  getAuthedTransport: () => h.transport,
  probeServerAuthUntilSettled: () => Promise.resolve(h.probe),
  watchForPasswordServer: () => () => {},
}));
vi.mock('$lib/rpc/ws-transport', () => ({
  // 配对路径不在本文件覆盖范围（原有 D96 行为）；误入即失败暴露。
  getWebTransport: () => {
    throw new Error('pairing transport not under test');
  },
  parsePairingLink: () => null,
}));
vi.mock('./endpoint', () => ({
  ENDPOINT_KIND: 'remote' as const,
  defaultDeviceName: () => 'Test Browser',
}));
vi.mock('$lib/features/team/team-context.svelte', () => ({ teamContext: h.teamState }));

beforeEach(() => {
  h.transport.calls.length = 0;
  h.transport.linkState = 'connecting';
  h.linkHandlers.clear();
  h.teamState.began = 0;
  h.teamState.resetCount = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 重导模块 → 触发一次全新 #boot，等探测落定。 */
async function bootGate(): Promise<typeof gateModule> {
  vi.resetModules();
  const mod = await import('./gate.svelte');
  await vi.waitFor(() => expect(mod.webGate.authMode).not.toBe('probing'));
  return mod;
}

/** 登录 / 改密的 fetch 桩；body 供响应 json() 读取（团队 member 标记）。 */
function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: status === 200, status, json: async () => body })),
  );
}

describe('WebGateState 密码模式', () => {
  it('未登录会话 → 登录页', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    expect(webGate.authMode).toBe('password');
    expect(webGate.view).toBe('login');
    expect(h.transport.calls).toEqual([]);
  });

  it('已登录会话 → booting 并立即拨号', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    expect(webGate.view).toBe('booting');
    expect(h.transport.calls).toEqual(['connect']);
  });

  it('登录成功 → booting + connectNow；连接建立 → connected', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200);
    await webGate.login('admin', 'correct horse battery');
    expect(webGate.view).toBe('booting');
    expect(webGate.loginError).toBeNull();
    expect(h.transport.calls).toEqual(['connectNow']);
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
  });

  it('登录失败：401 → invalid；429 → ratelimited；网络错误 → error（均留在登录页）', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    for (const [status, expected] of [
      [401, 'invalid'],
      [429, 'ratelimited'],
    ] as const) {
      stubFetch(status);
      await webGate.login('admin', 'wrong password!');
      expect(webGate.loginError).toBe(expected);
      expect(webGate.view).toBe('login');
      expect(h.transport.calls).toEqual([]);
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))));
    await webGate.login('admin', 'whatever password');
    expect(webGate.loginError).toBe('error');
    expect(webGate.view).toBe('login');
    vi.unstubAllGlobals();
  });

  it('会话失效（unauthenticated）→ 清错误回登录页', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
    h.transport.emit('unauthenticated');
    expect(webGate.view).toBe('login');
    expect(webGate.loginError).toBeNull();
    // 已在登录页时 connecting/reconnecting 不抢走视图（表单不被打断）。
    h.transport.emit('reconnecting');
    expect(webGate.view).toBe('login');
  });

  it('连接后断线（reconnecting）→ booting 等待重连', async () => {
    h.probe = { mode: 'password', authenticated: true };
    const { webGate } = await bootGate();
    h.transport.emit('connected');
    h.transport.emit('reconnecting');
    expect(webGate.view).toBe('booting');
  });
});

describe('WebGateState 团队端点（T5）', () => {
  const MEMBER = { id: 'mbr_1', displayName: '甲' } as const;

  it('探测带 member 且已登录：团队上下文拉起；mustChangePassword 进改密视图', async () => {
    h.probe = { mode: 'password', authenticated: true, member: MEMBER, mustChangePassword: true };
    const { webGate } = await bootGate();
    expect(h.teamState.began).toBe(1);
    expect(webGate.mustChangePassword).toBe(true);
    expect(webGate.view).toBe('change-password');
    // 改密期间连接照常建立，但不得越过改密视图进 App。
    h.transport.emit('connected');
    expect(webGate.view).toBe('change-password');
  });

  it('探测带 member 且已登录、无需改密 → 正常 booting 拨号', async () => {
    h.probe = { mode: 'password', authenticated: true, member: MEMBER };
    const { webGate } = await bootGate();
    expect(h.teamState.began).toBe(1);
    expect(webGate.view).toBe('booting');
    expect(h.transport.calls).toEqual(['connect']);
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
  });

  it('登录响应带 member + mustChangePassword → 改密视图（不立即拨号）', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200, { token: 't', member: MEMBER, mustChangePassword: true });
    await webGate.login('admin', 'temporary password');
    expect(h.teamState.began).toBe(1);
    expect(webGate.view).toBe('change-password');
    expect(h.transport.calls).toEqual([]);
  });

  it('登录响应带 member 且无需改密 → 立即拨号进正常路径', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200, { token: 't', member: MEMBER, mustChangePassword: false });
    await webGate.login('admin', 'correct horse battery');
    expect(h.teamState.began).toBe(1);
    expect(webGate.view).toBe('booting');
    expect(h.transport.calls).toEqual(['connectNow']);
  });

  it('改密成功：mustChangePassword 清除、重新拨号（旧会话已按版本号失效）', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200, { token: 't', member: MEMBER, mustChangePassword: true });
    await webGate.login('admin', 'temporary password');
    stubFetch(200, { ok: true });
    const changed = await webGate.submitPasswordChange('temporary password', 'new password 9');
    expect(changed).toBe(true);
    expect(webGate.mustChangePassword).toBe(false);
    expect(webGate.view).toBe('booting');
    expect(h.transport.calls).toEqual(['connectNow']);
    h.transport.emit('connected');
    expect(webGate.view).toBe('connected');
  });

  it('改密：旧连接还在（connected）直接放行，不重复拨号', async () => {
    h.probe = { mode: 'password', authenticated: true, member: MEMBER, mustChangePassword: true };
    const { webGate } = await bootGate();
    h.transport.emit('connected');
    expect(webGate.view).toBe('change-password');
    stubFetch(200, { ok: true });
    await webGate.submitPasswordChange('old password 1', 'new password 9');
    expect(webGate.view).toBe('connected');
    expect(h.transport.calls).toEqual(['connect']);
  });

  it('改密失败分类：401=当前密码不对；400=强度不足；429=限流（留在改密视图）', async () => {
    h.probe = { mode: 'password', authenticated: true, member: MEMBER, mustChangePassword: true };
    const { webGate } = await bootGate();
    expect(webGate.view).toBe('change-password');
    stubFetch(401);
    expect(await webGate.submitPasswordChange('wrong password', 'new password 9')).toBe(false);
    expect(webGate.changePasswordError).toBe('invalid');
    expect(webGate.view).toBe('change-password');
    stubFetch(400);
    expect(await webGate.submitPasswordChange('x', 'short')).toBe(false);
    expect(webGate.changePasswordError).toBe('weak');
    expect(webGate.view).toBe('change-password');
    stubFetch(429);
    expect(await webGate.submitPasswordChange('x', 'new password 9')).toBe(false);
    expect(webGate.changePasswordError).toBe('ratelimited');
    expect(webGate.view).toBe('change-password');
  });

  it('会话失效（unauthenticated）：团队上下文复位，回登录页', async () => {
    h.probe = { mode: 'password', authenticated: true, member: MEMBER };
    const { webGate } = await bootGate();
    expect(h.teamState.began).toBe(1);
    h.transport.emit('unauthenticated');
    expect(webGate.view).toBe('login');
    expect(h.teamState.resetCount).toBe(1);
  });

  it('个人版端点（探测/登录不带 member）：teamContext 不拉起', async () => {
    h.probe = { mode: 'password', authenticated: false };
    const { webGate } = await bootGate();
    stubFetch(200, { mode: 'password', username: 'admin' });
    await webGate.login('admin', 'correct horse battery');
    expect(h.teamState.began).toBe(0);
    expect(webGate.view).toBe('booting');
  });
});

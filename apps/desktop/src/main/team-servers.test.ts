import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteProfileHash, resolveRemoteMode } from './remote-mode';
import {
  TeamServers,
  normalizeTeamServerUrl,
  teamRpcError,
  teamServerHash,
  writeTeamServersState,
  type SafeStorageLike,
} from './team-servers';
import {
  TeamSocketHttpError,
  type BridgeChannel,
  type BridgePortLike,
  type OpenTeamSocket,
  type TeamSocket,
} from './team-bridge';

/**
 * T7 步骤 1（team-servers.ts）：凭据与多账号管理的单测——真 fs（tmpdir）+ 注入
 * safeStorage / fetch / 桥（fake），不起 Electron、不连网。
 */

// --- fakes -------------------------------------------------------------------

class FakePort implements BridgePortLike {
  closed = false;
  readonly posted: unknown[] = [];
  readonly #listeners = new Set<(event: { data: unknown }) => void>();
  on(_event: 'message', listener: (event: { data: unknown }) => void): unknown {
    this.#listeners.add(listener);
    return this;
  }
  start(): void {}
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  close(): void {
    this.closed = true;
  }
  deliver(data: unknown): void {
    for (const listener of this.#listeners) listener({ data });
  }
}

interface FakeSocketHandle extends TeamSocket {
  sent: string[];
  closedWith: { code: number; reason: string } | null;
  /** 测试直接驱动的回调面（bridge 在 open 后立即挂上）。 */
  handlers: Parameters<TeamSocket['on']>[0] | null;
}

function fakeSocket(): FakeSocketHandle {
  // 闭包持有状态（勿用对象展开——那会快照 closedWith，测试读不到更新）。
  const state = {
    sent: [] as string[],
    closedWith: null as { code: number; reason: string } | null,
    handlers: null as Parameters<TeamSocket['on']>[0] | null,
  };
  const socket: FakeSocketHandle = {
    get sent() {
      return state.sent;
    },
    get closedWith() {
      return state.closedWith;
    },
    get handlers() {
      return state.handlers;
    },
    send: (text: string) => {
      state.sent.push(text);
    },
    close: (code = 1000, reason = '') => {
      if (state.closedWith !== null) return;
      state.closedWith = { code, reason };
      // bridge 的 disconnect 语义：stopped 在先，onClose 不触发重连——直接回调安全。
      state.handlers?.onClose(code, reason);
    },
    on: (handlers) => {
      state.handlers = handlers;
    },
  };
  return socket;
}

/** 注入用 openSocket：记录 url / 头；脚本按调用序消费（默认全部建连成功）。 */
function scriptedOpenSocket(
  log: Array<{ url: string; headers: Record<string, string>; socket: FakeSocketHandle }>,
  script: Array<'ok' | 'reject401' | 'fail'> = ['ok'],
): OpenTeamSocket {
  let index = 0;
  return (url, headers) => {
    const socket = fakeSocket();
    log.push({ url, headers, socket });
    const step = script[Math.min(index, script.length - 1)] ?? 'ok';
    index += 1;
    if (step === 'reject401') return Promise.reject(new TeamSocketHttpError(401));
    if (step === 'fail') return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve(socket);
  };
}

function fakeSafeStorage(available: boolean): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// --- harness -----------------------------------------------------------------

interface Harness {
  host: TeamServers;
  statePath: string;
  writeFileCalls: string[];
  changedCount: () => number;
  channels: Array<{ port1: FakePort; port2: FakePort }>;
  openLog: Array<{ url: string; headers: Record<string, string>; socket: FakeSocketHandle }>;
  fetchMock: ReturnType<typeof vi.fn>;
  dispose(): void;
}

function createHarness(options?: {
  safeStorageAvailable?: boolean;
  fetchImpl?: typeof fetch;
  openScript?: Array<'ok' | 'reject401' | 'fail'>;
  /** 复用既有状态文件（“主进程重启”场景）。 */
  statePath?: string;
}): Harness {
  const dir = options?.statePath !== undefined ? '' : mkdtempSync(path.join(tmpdir(), 'kepcup-team-servers-'));
  const statePath = options?.statePath ?? path.join(dir, 'team-servers.json');
  const writeFileCalls: string[] = [];
  const channels: Array<{ port1: FakePort; port2: FakePort }> = [];
  const openLog: Harness['openLog'] = [];
  let changed = 0;
  const defaultFetch = vi.fn(async () =>
    jsonResponse(200, { token: 'x', member: { id: 'm', displayName: 'M' } }),
  );
  const host = new TeamServers({
    statePath: () => statePath,
    safeStorage: fakeSafeStorage(options?.safeStorageAvailable ?? true),
    fetch: (options?.fetchImpl ?? defaultFetch) as unknown as typeof fetch,
    readFile: (p) =>
      fsReadFile(p, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    writeFile: (p, contents) => {
      writeFileCalls.push(contents);
      // 与 index.ts 的生产注入同款（0600 权限，见 writeTeamServersState）。
      return writeTeamServersState(p, contents);
    },
    createChannel: () => {
      const port1 = new FakePort();
      const port2 = new FakePort();
      channels.push({ port1, port2 });
      return { port1, port2 } as BridgeChannel;
    },
    postPort: () => {},
    openSocket: scriptedOpenSocket(openLog, options?.openScript),
    onChanged: () => {
      changed += 1;
    },
  });
  return {
    host,
    statePath,
    writeFileCalls,
    changedCount: () => changed,
    channels,
    openLog,
    fetchMock: (options?.fetchImpl ?? defaultFetch) as ReturnType<typeof vi.fn>,
    dispose: () => {
      if (dir !== '') rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 登录成功一次（覆盖 fetch 返回体），返回签发的 token。 */
async function loginOk(
  h: Harness,
  serverHash: string,
  member: { id: string; displayName: string },
  username: string,
  remember = true,
): Promise<string> {
  const token = `tok-${member.id}`;
  h.fetchMock.mockResolvedValue(
    jsonResponse(200, { token, member, mustChangePassword: false }),
  );
  await h.host.login({ serverHash, username, password: 'pw-123456', remember });
  return token;
}

const URL_A = 'http://127.0.0.1:8643';
const URL_B = 'https://team.example.com';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.dispose();
});

// --- tests -------------------------------------------------------------------

describe('URL 校验与哈希稳定性', () => {
  it('拒绝非 http(s)、内嵌凭据与垃圾输入（错误为 JSON 约定），且不建文件', async () => {
    for (const bad of ['not a url', 'ftp://127.0.0.1:1', 'http://user:pw@host:1', '']) {
      await expect(harness.host.add({ url: bad })).rejects.toThrow();
      try {
        await harness.host.add({ url: bad });
      } catch (error) {
        expect(JSON.parse((error as Error).message)).toMatchObject({ code: 'INVALID_INPUT' });
      }
    }
    expect(existsSync(harness.statePath)).toBe(false);
  });

  it('规范化（剥 query/hash）后哈希稳定，与 remoteProfileHash 同一实现', async () => {
    const { serverHash } = await harness.host.add({ url: `${URL_A}/?token=x#y` });
    expect(serverHash).toMatch(/^[0-9a-f]{16}$/);
    expect(serverHash).toBe(remoteProfileHash('http://127.0.0.1:8643/'));
    expect(teamServerHash(normalizeTeamServerUrl(URL_A))).toBe(serverHash);
    const again = await harness.host.add({ url: `${URL_A}/` });
    expect(again.serverHash).toBe(serverHash);
    // 幂等：重复 add 不再写文件。
    const writesBefore = harness.writeFileCalls.length;
    await harness.host.add({ url: URL_A });
    expect(harness.writeFileCalls.length).toBe(writesBefore);
    // 不同端口 → 不同哈希。
    const other = await harness.host.add({ url: 'http://127.0.0.1:8644' });
    expect(other.serverHash).not.toBe(serverHash);
  });

  it('接受面与 resolveRemoteMode 规则一致（同 corpus）', () => {
    const corpus = [
      'http://127.0.0.1:8643',
      'https://team.example.com',
      'https://team.example.com/sub/',
      'ftp://127.0.0.1:1',
      'http://user:pw@host:1',
      'garbage',
      'http://127.0.0.1:8643/?a=b#c',
    ];
    for (const raw of corpus) {
      let resolverAccepts: boolean;
      try {
        resolverAccepts = resolveRemoteMode({ KEPCUP_REMOTE_URL: raw }) !== null;
      } catch {
        resolverAccepts = false;
      }
      let managerAccepts: boolean;
      try {
        normalizeTeamServerUrl(raw);
        managerAccepts = true;
      } catch {
        managerAccepts = false;
      }
      expect(managerAccepts, raw).toBe(resolverAccepts);
    }
  });
});

describe('未配置时零副作用', () => {
  it('list 返回空、不建文件、不连 socket、不发事件', async () => {
    expect(await harness.host.list()).toEqual([]);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(harness.openLog).toHaveLength(0);
    expect(harness.changedCount()).toBe(0);
    expect(harness.channels).toHaveLength(0);
  });
});

describe('多账号：add / login / switch / logout', () => {
  it('login 记录账号并设为 active；token 加密落盘、无明文、无密码', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    const token = await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    const list = await harness.host.list();
    expect(list).toHaveLength(1);
    expect(list[0]!).toEqual({
      serverHash,
      url: 'http://127.0.0.1:8643/',
      accounts: [{ memberId: 'm1', username: 'alice', displayName: 'Alice', remembered: true }],
      activeMemberId: 'm1',
      status: 'idle',
    });
    const raw = readFileSync(harness.statePath, 'utf8');
    // tokenVault = base64(safeStorage.encryptString(token))——fake 的加密即 enc: 前缀。
    expect(raw).toContain(Buffer.from(`enc:${token}`, 'utf8').toString('base64'));
    expect(raw).not.toContain(token); // 无明文 token
    expect(raw).not.toContain('pw-123456'); // 密码绝不落盘
    expect(harness.changedCount()).toBeGreaterThan(0);
  });

  it('第二个成员登录共存，switchAccount 换 active，logout 清 token 留账号', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    await loginOk(harness, serverHash, { id: 'm2', displayName: 'Bob' }, 'bob');
    let list = await harness.host.list();
    expect(list[0]!.accounts.map((a) => a.memberId)).toEqual(['m1', 'm2']);
    expect(list[0]!.activeMemberId).toBe('m2');

    await harness.host.switchAccount({ serverHash, memberId: 'm1' });
    list = await harness.host.list();
    expect(list[0]!.activeMemberId).toBe('m1');

    await harness.host.logout({ serverHash });
    list = await harness.host.list();
    // 62.10 §4：账号条目保留（登录选择器列出本设备登录过的成员）。
    expect(list[0]!.activeMemberId).toBe(null);
    expect(list[0]!.accounts.map((a) => [a.memberId, a.remembered])).toEqual([
      ['m1', false], // logout 清的是当前 active（switch 后是 Alice）的 token
      ['m2', true], // 非 active 的账号 token 不受影响
    ]);
    const raw = JSON.parse(readFileSync(harness.statePath, 'utf8')) as {
      servers: Record<string, { accounts: Array<{ memberId: string; tokenVault: unknown }> }>;
    };
    expect(raw.servers[serverHash]!.accounts[0]!.tokenVault).toBe(null);
    expect(raw.servers[serverHash]!.accounts[1]!.tokenVault).toBeTypeOf('string');
  });

  it('桥接存在时 switch 到无 token 的账号 → unauthenticated 且不再握手', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    await loginOk(harness, serverHash, { id: 'm2', displayName: 'Bob' }, 'bob');
    await harness.host.logout({ serverHash }); // active=m2 的 token 清空、active=null
    await harness.host.switchAccount({ serverHash, memberId: 'm1' }); // m1 仍有 token
    await harness.host.connect({ serverHash });
    await flush();
    expect(harness.openLog).toHaveLength(1);
    expect((await harness.host.list())[0]!.status).toBe('connected');
    // 换到 m2（logout 已清其 token）：拆连接、置 unauthenticated、不自动重试。
    await harness.host.switchAccount({ serverHash, memberId: 'm2' });
    expect((await harness.host.list())[0]!.status).toBe('unauthenticated');
    expect(harness.openLog[0]!.socket.closedWith?.code).toBe(1000);
    expect(harness.openLog).toHaveLength(1);
  });

  it('login 错误映射：401 / 429 / 网络错误（JSON 约定）', async () => {
    const fetchImpl = vi.fn();
    const h = createHarness({ fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      const { serverHash } = await h.host.add({ url: URL_B });
      fetchImpl.mockResolvedValue(jsonResponse(401, { error: 'INVALID_CREDENTIALS' }));
      await expect(
        h.host.login({ serverHash, username: 'a', password: 'b', remember: false }),
      ).rejects.toThrow(
        JSON.stringify({ code: 'INVALID_CREDENTIALS', message: '用户名或密码不正确' }),
      );
      fetchImpl.mockResolvedValue(jsonResponse(429, { error: 'RATE_LIMITED' }, { 'retry-after': '30' }));
      await expect(
        h.host.login({ serverHash, username: 'a', password: 'b', remember: false }),
      ).rejects.toThrow(
        JSON.stringify({
          code: 'RATE_LIMITED',
          message: '登录尝试过于频繁，请稍后再试',
          details: { retryAfterSec: 30 },
        }),
      );
      fetchImpl.mockRejectedValue(new TypeError('fetch failed'));
      await expect(
        h.host.login({ serverHash, username: 'a', password: 'b', remember: false }),
      ).rejects.toThrow(/无法连接团队服务器/);
    } finally {
      h.dispose();
    }
  });
});

describe('safeStorage 不可用（DEV-143）', () => {
  it('remember 强制 false，token 不落盘（读文件断言），会话内仍可 connect', async () => {
    const h = createHarness({ safeStorageAvailable: false });
    try {
      const { serverHash } = await h.host.add({ url: URL_A });
      const token = await loginOk(h, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice', true);
      expect((await h.host.list())[0]!.accounts[0]!.remembered).toBe(false);
      const raw = readFileSync(h.statePath, 'utf8');
      expect(raw).not.toContain(token);
      expect(raw).not.toContain('enc:'); // 无任何加密字段（未落盘）
      // 内存 token 仍可发起连接：Bearer 头直达 socket 工厂，url 为 {url}/rpc。
      await h.host.connect({ serverHash });
      await flush();
      expect(h.openLog).toHaveLength(1);
      expect(h.openLog[0]!.headers.authorization).toBe(`Bearer ${token}`);
      expect(h.openLog[0]!.url).toBe('http://127.0.0.1:8643/rpc');
      expect((await h.host.list())[0]!.status).toBe('connected');
    } finally {
      h.dispose();
    }
  });

  it('内存 token：主进程重启（同文件新实例）后 connect → unauthenticated', async () => {
    const h = createHarness({ safeStorageAvailable: false });
    try {
      const { serverHash } = await h.host.add({ url: URL_A });
      await loginOk(h, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice', false);
      h.host.shutdown();
      const restarted = createHarness({ safeStorageAvailable: false, statePath: h.statePath });
      try {
        await restarted.host.connect({ serverHash });
        expect((await restarted.host.list())[0]!.status).toBe('unauthenticated');
        expect(restarted.openLog).toHaveLength(0);
      } finally {
        restarted.dispose();
      }
    } finally {
      h.dispose();
    }
  });
});

describe('remove / connect / disconnect', () => {
  it('remove 删配置、删 token 并断开桥接（关 socket 与 port，不重连）', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    await harness.host.connect({ serverHash });
    await flush();
    expect(harness.openLog).toHaveLength(1);
    await harness.host.remove({ serverHash });
    expect(await harness.host.list()).toEqual([]);
    const raw = JSON.parse(readFileSync(harness.statePath, 'utf8')) as {
      servers: Record<string, unknown>;
    };
    expect(raw.servers[serverHash]).toBeUndefined();
    expect(harness.openLog[0]!.socket.closedWith?.code).toBe(1000);
    expect(harness.channels[0]!.port1.closed).toBe(true);
    expect(harness.openLog).toHaveLength(1); // 未再重连
    await expect(harness.host.remove({ serverHash })).rejects.toThrow(/NOT_FOUND/);
  });

  it('remembered token 跨实例可用（盘上解密）；disconnect → idle 关双侧', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    const token = await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    harness.host.shutdown();
    // “重启”：同一状态文件上的新实例（remembered token 从盘上解密可用）。
    const h2 = createHarness({ safeStorageAvailable: true, statePath: harness.statePath });
    try {
      await h2.host.connect({ serverHash });
      await flush();
      expect(h2.openLog).toHaveLength(1);
      expect(h2.openLog[0]!.headers.authorization).toBe(`Bearer ${token}`);
      await h2.host.disconnect({ serverHash });
      expect((await h2.host.list())[0]!.status).toBe('idle');
      expect(h2.openLog[0]!.socket.closedWith?.code).toBe(1000);
      expect(h2.channels[0]!.port1.closed).toBe(true);
    } finally {
      h2.dispose();
    }
  });

  it('connect 无 active / 无 token → unauthenticated，不握手', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    await harness.host.connect({ serverHash });
    expect((await harness.host.list())[0]!.status).toBe('unauthenticated');
    expect(harness.openLog).toHaveLength(0);
  });

  it('握手被拒 401 → unauthenticated（token 失效语义，来自 bridge 状态回调）', async () => {
    const h = createHarness({ openScript: ['reject401'] });
    try {
      const { serverHash } = await h.host.add({ url: URL_A });
      await loginOk(h, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
      await h.host.connect({ serverHash });
      await flush();
      expect((await h.host.list())[0]!.status).toBe('unauthenticated');
      expect(h.openLog).toHaveLength(1); // 不重试
    } finally {
      h.dispose();
    }
  });

  it('未知 serverHash → NOT_FOUND（JSON 约定）', async () => {
    const actions = [
      () => harness.host.remove({ serverHash: 'deadbeefdeadbeef' }),
      () =>
        harness.host.login({
          serverHash: 'deadbeefdeadbeef',
          username: 'a',
          password: 'b',
          remember: false,
        }),
      () => harness.host.connect({ serverHash: 'deadbeefdeadbeef' }),
      () => harness.host.switchAccount({ serverHash: 'deadbeefdeadbeef', memberId: 'm' }),
    ];
    for (const action of actions) {
      await expect(action()).rejects.toThrow();
      try {
        await action();
      } catch (error) {
        expect(JSON.parse((error as Error).message)).toEqual({
          code: 'NOT_FOUND',
          message: '未登记的团队服务器',
        });
      }
    }
  });
});

describe('错误 JSON 约定', () => {
  it('teamRpcError 的 message 是可解析的 {code, message, details?}', () => {
    expect(JSON.parse(teamRpcError('RATE_LIMITED', '慢一点', { retryAfterSec: 5 }).message)).toEqual(
      { code: 'RATE_LIMITED', message: '慢一点', details: { retryAfterSec: 5 } },
    );
    expect(JSON.parse(teamRpcError('INVALID_INPUT', 'x').message)).toEqual({
      code: 'INVALID_INPUT',
      message: 'x',
    });
  });
});

describe('状态文件权限（0600）', () => {
  it('writeTeamServersState 新建与覆写都收敛 0600（fs.writeFile 的 mode 只管新建）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-team-servers-mode-'));
    try {
      const target = path.join(dir, 'team-servers.json');
      await writeTeamServersState(target, '{"version":1,"servers":{}}\n');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      // 既有文件被放宽过权限（如用户手工 chmod）：覆写后强制收回 0600。
      chmodSync(target, 0o644);
      expect(statSync(target).mode & 0o777).toBe(0o644);
      await writeTeamServersState(target, '{"version":1,"servers":{}}\n');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('经 TeamServers 的持久化路径（生产注入同款）落盘即 0600，且无明文 token', async () => {
    const { serverHash } = await harness.host.add({ url: URL_A });
    const token = await loginOk(harness, serverHash, { id: 'm1', displayName: 'Alice' }, 'alice');
    const mode = statSync(harness.statePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const raw = readFileSync(harness.statePath, 'utf8');
    expect(raw).not.toContain(token);
  });
});

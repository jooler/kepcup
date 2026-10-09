import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { KEPCUP_OAUTH_CLIENT_ID, type AppConnectFlowPayload } from '@kepcup/shared';
import {
  createTestHome,
  simulateBrowser,
  startFakeOAuthMcpServer,
  type FakeOAuthMcpServer,
  type SimulatedBrowserResult,
} from '@kepcup/testkit';
import { createCore, type CoreHarness } from '../../src/create-core.js';
import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import { createAppServices } from '../../src/apps/index.js';
import { TokenVault } from '../../src/apps/token-vault.js';
import { createShellHostRpc, type ShellHostRpc } from '../../src/apps/shell-facade.js';
import { openRealMainDb } from '../support/real-secrets.js';

/**
 * 连接应用 RPC 链路（D73 P0）：apps.connect / continue / cancel / connections.list 经 RPC 服务器、
 * 测试注入点 shellRpc（接 simulateBrowser）与 oauth* 选项，对 testkit 假授权服务器走通整条
 * 交互授权；并锁定 shell.openExternal facade 的绑定语义与「RPC 返回 / 事件里没有令牌」。
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function freePorts(count: number): Promise<number[]> {
  const holders: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    holders.push(server);
    ports.push((server.address() as AddressInfo).port);
  }
  await Promise.all(holders.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return ports;
}

async function until<T>(probe: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Stack {
  core: CoreHarness;
  fake: FakeOAuthMcpServer;
  shellCalls: string[];
  browserRuns: Array<Promise<SimulatedBrowserResult>>;
  flowEvents: AppConnectFlowPayload[];
  statusEvents: unknown[];
}

async function startStack(
  options: { autoContinue?: boolean; browser?: boolean } = {},
): Promise<Stack> {
  const home = await createTestHome();
  cleanups.push(() => home.cleanup());
  const fake = await startFakeOAuthMcpServer({ dcrEnabled: true });
  cleanups.push(() => fake.stop());
  const shellCalls: string[] = [];
  const browserRuns: Array<Promise<SimulatedBrowserResult>> = [];
  const shellRpc: ShellHostRpc = {
    async openExternal({ url }) {
      shellCalls.push(url);
      if (options.browser !== false) {
        const run = simulateBrowser(url);
        run.catch(() => undefined);
        browserRuns.push(run);
      }
      return { ok: true };
    },
  };
  const core = await createCore({
    home: home.home,
    appVersion: '0.0.0-test',
    shellRpc,
    oauthLoopbackAllowlist: ['127.0.0.1'],
    oauthCallbackPorts: await freePorts(3),
    oauthFlowTimeoutMs: 10_000,
  });
  cleanups.push(() => core.close());
  const flowEvents: AppConnectFlowPayload[] = [];
  const statusEvents: unknown[] = [];
  core.onEvent('apps.connect_flow', (payload) => {
    flowEvents.push(payload);
    if (payload.phase === 'awaiting_consent' && options.autoContinue !== false) {
      void core.rpc.call('apps.connect.continue', { flowId: payload.flowId });
    }
  });
  core.onEvent('apps.connection_status', (payload) => statusEvents.push(payload));
  await core.rpc.call('settings.update', {
    mcpServers: [
      {
        id: 'notes',
        name: 'Fake Notes',
        transport: 'http',
        url: fake.mcpUrl,
        auth: 'oauth',
        enabled: true,
        autoApprove: false,
      },
      {
        id: 'plain',
        name: 'Plain',
        transport: 'http',
        url: fake.mcpUrl,
        auth: 'none',
        enabled: true,
      },
    ],
  });
  return { core, fake, shellCalls, browserRuns, flowEvents, statusEvents };
}

describe('apps.* RPC（交互授权）', () => {
  it('apps.connect → 授权页确认 → 浏览器回调 → done；连接列表只含非机密元数据，事件与返回值里没有令牌', async () => {
    const stack = await startStack();
    const { core, fake } = stack;

    const { flowId } = (await core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: 'notes' },
    })) as { flowId: string };
    await until(() => stack.flowEvents.find((e) => e.flowId === flowId && e.phase === 'done'));

    expect(stack.flowEvents.map((e) => e.phase)).toEqual([
      'discovering',
      'awaiting_consent',
      'awaiting_browser',
      'exchanging',
      'done',
    ]);
    expect(stack.shellCalls).toHaveLength(1);
    expect(stack.statusEvents).toEqual([
      { connectionId: 'custom:notes', status: 'connecting' },
      { connectionId: 'custom:notes', status: 'connected' },
    ]);

    const hidden = (await core.rpc.call('apps.connections.list', {})) as { connections: unknown[] };
    expect(hidden.connections).toEqual([]); // 默认不含 custom: 行
    const listed = (await core.rpc.call('apps.connections.list', { includeCustom: true })) as {
      connections: Array<{ id: string; status: string; issuer: string; serverUrl: string }>;
    };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({
      id: 'custom:notes',
      status: 'connected',
      issuer: fake.issuer,
      serverUrl: fake.mcpUrl,
    });

    const tokens = core.services.apps!.vault.getTokens('custom:notes')!;
    expect(fake.isAccessTokenValid(tokens.accessToken)).toBe(true);
    const everything = JSON.stringify([stack.flowEvents, stack.statusEvents, listed]);
    expect(everything).not.toContain(tokens.accessToken);
    expect(everything).not.toContain(tokens.refreshToken);
    // 假浏览器看到的是成功页。
    expect((await Promise.all(stack.browserRuns))[0]?.callbackBody).toContain(
      '已连接，可回到 KepCup',
    );
  });

  it('apps.connect.cancel 取消等待确认的流程', async () => {
    const stack = await startStack({ autoContinue: false });
    const { flowId } = (await stack.core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: 'notes' },
    })) as { flowId: string };
    await until(() => stack.flowEvents.find((e) => e.phase === 'awaiting_consent'));
    await stack.core.rpc.call('apps.connect.cancel', { flowId });
    await until(() => stack.flowEvents.find((e) => e.phase === 'cancelled'));
    expect(stack.shellCalls).toHaveLength(0);
    // 重复取消 / 取消不存在的流程幂等。
    await stack.core.rpc.call('apps.connect.cancel', { flowId });
    await stack.core.rpc.call('apps.connect.cancel', { flowId: 'flow_unknown' });
  });

  it('等待确认时 server 的 URL 被改掉：进行中的流程被取消，旧配置的授权不会落到新配置上', async () => {
    const stack = await startStack({ autoContinue: false });
    const other = await startFakeOAuthMcpServer({ dcrEnabled: true });
    cleanups.push(() => other.stop());
    const { flowId } = (await stack.core.rpc.call('apps.connect', {
      target: { kind: 'custom', serverId: 'notes' },
    })) as { flowId: string };
    await until(() => stack.flowEvents.find((e) => e.phase === 'awaiting_consent'));

    const settings = (await stack.core.rpc.call('settings.get')) as {
      mcpServers: Array<Record<string, unknown>>;
    };
    await stack.core.rpc.call('settings.update', {
      mcpServers: settings.mcpServers.map((server) =>
        server['id'] === 'notes' ? { ...server, url: other.mcpUrl } : server,
      ),
    });

    await until(() => stack.flowEvents.find((e) => e.flowId === flowId && e.phase === 'cancelled'));
    expect(stack.shellCalls).toHaveLength(0);
    expect(stack.core.services.apps!.vault.getTokens('custom:notes')).toBeNull();
  });

  it('入口校验：catalog 目标、未知 server、非 OAuth server、不存在的 flow', async () => {
    const stack = await startStack({ autoContinue: false });
    const call = (method: string, input: unknown) =>
      stack.core.rpc.call(method as never, input as never);
    await expect(
      call('apps.connect', { target: { kind: 'catalog', connectorId: 'x' } }),
    ).rejects.toMatchObject({
      // 目录里没有（测试构建默认空目录）；目录连接本身见 catalog-connect.test.ts
      code: 'NOT_FOUND',
    });
    await expect(
      call('apps.connect', { target: { kind: 'custom', serverId: 'ghost' } }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      call('apps.connect', { target: { kind: 'custom', serverId: 'plain' } }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(call('apps.connect.continue', { flowId: 'flow_unknown' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      call('apps.setClientCredentials', { flowId: 'flow_unknown', clientId: 'a' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('createAppServices 的测试注入点', () => {
  function build(env: NodeJS.ProcessEnv, testHooks: boolean) {
    const real = openRealMainDb();
    cleanups.push(async () => real.dispose());
    return createAppServices({
      db: real.db,
      secrets: real.secrets,
      settings: { get: () => ({ mcpServers: [] }) as never },
      clock: real.clock,
      logger: {} as never,
      events: { emit: () => undefined },
      shell: createShellHostRpc(),
      env,
      testHooks,
      test: {
        cimdUrl: 'http://127.0.0.1:9/client.json',
        loopbackAllowlist: ['169.254.169.254'],
      },
    });
  }

  it('NODE_ENV=test 且含测试钩子：CIMD URL 与回环白名单可覆盖', () => {
    const apps = build({ NODE_ENV: 'test' }, true);
    expect(apps.cimdClientId).toBe('http://127.0.0.1:9/client.json');
    expect(apps.loopbackAllowlist).toEqual(['169.254.169.254']);
  });

  it('非测试环境（或打包产物无测试钩子）下注入无效：CIMD URL 恒为常量，白名单恒为空', () => {
    for (const apps of [
      build({ NODE_ENV: 'production' }, true),
      build({ NODE_ENV: 'test' }, false),
      build({}, true),
    ]) {
      expect(apps.cimdClientId).toBe(KEPCUP_OAUTH_CLIENT_ID);
      expect(apps.loopbackAllowlist).toEqual([]);
    }
  });
});

describe('启动时收拾上次未正常退出留下的 connecting 行（D73 复查）', () => {
  it('有令牌 → connected（令牌已过期且无 refresh token → expired）；没有令牌 → not_connected；其他状态不动', () => {
    const real = openRealMainDb();
    cleanups.push(async () => real.dispose());
    const store = new AppConnectionStore({ db: real.db, clock: real.clock });
    const vault = new TokenVault({ secrets: real.secrets, store, clock: real.clock });
    const seed = (serverId: string, status: 'connecting' | 'connected' | 'needs_scope'): string => {
      const id = customConnectionId(serverId);
      store.ensureCustom(serverId, {
        label: serverId,
        serverUrl: `https://${serverId}.example/mcp`,
      });
      store.setStatus(id, status);
      return id;
    };
    const withTokens = seed('with-tokens', 'connecting');
    vault.saveTokens(withTokens, {
      access_token: 'at-1',
      token_type: 'Bearer',
      refresh_token: 'rt-1',
      expires_in: 3600,
    });
    const staleTokens = seed('stale', 'connecting');
    vault.saveTokens(staleTokens, { access_token: 'at-2', token_type: 'Bearer', expires_in: 10 });
    real.clock.set(real.clock.now() + 60_000);
    const noTokens = seed('no-tokens', 'connecting');
    const untouched = seed('needs-scope', 'needs_scope');

    createAppServices({
      db: real.db,
      secrets: real.secrets,
      settings: { get: () => ({ mcpServers: [] }) as never },
      clock: real.clock,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      } as never,
      events: { emit: () => undefined },
      shell: createShellHostRpc(),
      env: {},
      testHooks: false,
    });

    expect(store.get(withTokens)?.status).toBe('connected');
    expect(store.get(staleTokens)?.status).toBe('expired');
    expect(store.get(noTokens)?.status).toBe('not_connected');
    expect(store.get(untouched)?.status).toBe('needs_scope');
  });
});

describe('shell.openExternal facade（core 侧）', () => {
  it('未绑定时报错；绑定端口 B 客户端后调用 shell.openExternal 并校验返回；解绑时在途调用失败', async () => {
    const facade = createShellHostRpc();
    await expect(facade.openExternal({ url: 'https://example.com/' })).rejects.toThrow(/未连接/);

    const calls: Array<{ method: string; input: unknown }> = [];
    let rejected: string | null = null;
    const client = {
      call: async (method: string, input?: unknown) => {
        calls.push({ method, input });
        return { ok: true };
      },
      rejectPending: (reason: string) => {
        rejected = reason;
      },
    };
    facade.bind(client);
    expect(await facade.openExternal({ url: 'https://example.com/a' })).toEqual({ ok: true });
    expect(calls).toEqual([
      { method: 'shell.openExternal', input: { url: 'https://example.com/a' } },
    ]);

    facade.bind(null);
    expect(rejected).toContain('shell host disconnected');

    // 返回值格式错误被拒绝（不信任宿主）。
    facade.bind({ call: async () => ({ ok: 'yes' }), rejectPending: () => undefined });
    await expect(facade.openExternal({ url: 'https://example.com/' })).rejects.toBeDefined();

    // 测试 facade 优先于端口 B 客户端。
    facade.bindFacade({ openExternal: async () => ({ ok: false }) });
    expect(await facade.openExternal({ url: 'https://example.com/' })).toEqual({ ok: false });
  });
});

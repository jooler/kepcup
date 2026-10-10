import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpServerSchema, type AppConnectFlowPayload, type McpServer } from '@kepcup/shared';
import {
  publishCimdDocument,
  simulateBrowser,
  startFakeOAuthMcpServer,
  startFileServer,
  type FakeOAuthMcpOptions,
  type FakeOAuthMcpServer,
  type SimulatedBrowserResult,
  type TestFileServer,
} from '@kepcup/testkit';
import { ConnectFlowManager } from '../../src/apps/auth/flow.js';
import { AppConnectionStore, customConnectionId } from '../../src/apps/connection-store.js';
import type { ShellHostRpc } from '../../src/apps/shell-facade.js';
import { TokenVault, clientSecretSecretName } from '../../src/apps/token-vault.js';
import { openRealMainDb, type RealMainDb } from '../support/real-secrets.js';

/**
 * 交互授权流程（D73 §4.6 flow.ts）：ConnectFlowManager 对真实加密库 + testkit 假授权 /
 * MCP 服务器 + 假浏览器（simulateBrowser）。不访问真实网络。
 */

const SERVER_ID = 'fake-notes';
const CONNECTION_ID = customConnectionId(SERVER_ID);

interface Ctx {
  env: RealMainDb;
  store: AppConnectionStore;
  vault: TokenVault;
  flows: ConnectFlowManager;
  fake: FakeOAuthMcpServer;
  ports: number[];
  /** 全部事件（含 connection_status）。 */
  events: Array<{ name: string; payload: unknown }>;
  flowEvents: AppConnectFlowPayload[];
  /** 系统浏览器被要求打开的 URL。 */
  shellCalls: string[];
  /** auto 模式下每次假浏览器访问的结果。 */
  browserRuns: Array<Promise<SimulatedBrowserResult>>;
  logs: string[];
  invalidated: string[];
  server: McpServer;
  setServer(patch: Partial<McpServer>): void;
}

const cleanups: Array<() => Promise<void> | void> = [];
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

async function occupy(ports: number[]): Promise<void> {
  for (const port of ports) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  }
}

async function until<T>(probe: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface SetupOptions {
  fake?: FakeOAuthMcpOptions;
  /** auto：假浏览器自动访问授权 URL；manual：只记录 URL。 */
  browser?: 'auto' | 'manual';
  /** 到 awaiting_consent 自动 continue。 */
  autoContinue?: boolean;
  flowTimeoutMs?: number;
  cimdUrl?: string;
  serverUrl?: string;
  /** 额外允许明文 / 私网访问的回环主机（`hostname` 或 `host:port`）。 */
  loopbackAllowlist?: string[];
}

async function setup(options: SetupOptions = {}): Promise<Ctx> {
  const env = openRealMainDb();
  cleanups.push(() => env.dispose());
  const fake = await startFakeOAuthMcpServer(options.fake);
  cleanups.push(() => fake.stop());
  const store = new AppConnectionStore({ db: env.db, clock: env.clock });
  const vault = new TokenVault({ secrets: env.secrets, store, clock: env.clock });
  const ports = await freePorts(3);

  let server = mcpServerSchema.parse({
    id: SERVER_ID,
    name: 'Fake Notes',
    transport: 'http',
    url: options.serverUrl ?? fake.mcpUrl,
    auth: 'oauth',
    enabled: true,
  });
  const events: Ctx['events'] = [];
  const flowEvents: AppConnectFlowPayload[] = [];
  const shellCalls: string[] = [];
  const browserRuns: Ctx['browserRuns'] = [];
  const logs: string[] = [];
  const invalidated: string[] = [];
  const logger = {
    info: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    warn: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    error: (...args: unknown[]) => logs.push(JSON.stringify(args)),
    debug: (...args: unknown[]) => logs.push(JSON.stringify(args)),
  } as never;

  const shell: ShellHostRpc = {
    async openExternal({ url }) {
      shellCalls.push(url);
      if ((options.browser ?? 'auto') === 'auto') {
        const run = simulateBrowser(url);
        run.catch(() => undefined);
        browserRuns.push(run);
      }
      return { ok: true };
    },
  };
  const flows: ConnectFlowManager = new ConnectFlowManager({
    store,
    vault,
    settings: { get: () => ({ mcpServers: [server] }) as never },
    shell,
    events: {
      emit: ((name: string, payload: unknown) => {
        events.push({ name, payload });
        if (name === 'apps.connect_flow') {
          const flow = payload as AppConnectFlowPayload;
          flowEvents.push(flow);
          if (flow.phase === 'awaiting_consent' && options.autoContinue !== false) {
            queueMicrotask(() => flows.continue(flow.flowId));
          }
        }
      }) as never,
    },
    logger,
    clock: env.clock,
    ...(options.cimdUrl !== undefined
      ? { cimdUrl: options.cimdUrl, allowInsecureCimdUrl: true }
      : {}),
    callbackPorts: ports,
    ...(options.loopbackAllowlist !== undefined
      ? { loopbackAllowlist: options.loopbackAllowlist }
      : {}),
    flowTimeoutMs: options.flowTimeoutMs ?? 10_000,
    invalidator: {
      invalidate: (id) => {
        invalidated.push(id);
      },
    },
  });
  cleanups.push(() => flows.shutdown());

  return {
    env,
    store,
    vault,
    flows,
    fake,
    ports,
    events,
    flowEvents,
    shellCalls,
    browserRuns,
    logs,
    invalidated,
    get server() {
      return server;
    },
    setServer(patch) {
      server = mcpServerSchema.parse({ ...server, ...patch });
    },
  };
}

/** 发起连接并等到流程结束（终态或被清理）。 */
async function connect(ctx: Ctx): Promise<{ flowId: string; last: AppConnectFlowPayload }> {
  const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
  await until(() => !ctx.flows.activeFlowIds().includes(flowId));
  const mine = ctx.flowEvents.filter((e) => e.flowId === flowId);
  return { flowId, last: mine[mine.length - 1] as AppConnectFlowPayload };
}

const phases = (ctx: Ctx, flowId: string): string[] =>
  ctx.flowEvents.filter((e) => e.flowId === flowId).map((e) => e.phase);

function statusEvents(ctx: Ctx): string[] {
  return ctx.events
    .filter((e) => e.name === 'apps.connection_status')
    .map((e) => (e.payload as { status: string }).status);
}

async function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function rawGet(
  port: number,
  path: string,
  options: { host?: string; method?: string } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${port}`, connection: 'close' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('客户端身份：CIMD / DCR / 手填 / 已有客户端', () => {
  it('CIMD 路径：授权服务器声明支持 CIMD 时用 KepCup 的 CIMD client_id，免注册', async () => {
    const files: TestFileServer = await startFileServer({});
    cleanups.push(() => files.stop());
    const { clientId } = publishCimdDocument(files);
    const ctx = await setup({ fake: { cimdSupported: true, dcrEnabled: true }, cimdUrl: clientId });

    const { flowId, last } = await connect(ctx);

    expect(last.phase).toBe('done');
    expect(phases(ctx, flowId)).toEqual([
      'discovering',
      'awaiting_consent',
      'awaiting_browser',
      'exchanging',
      'done',
    ]);
    expect(ctx.fake.registrations).toHaveLength(0); // CIMD 优先于 DCR
    expect(ctx.fake.authorizeRequests).toHaveLength(1);
    expect(ctx.fake.authorizeRequests[0]).toMatchObject({
      clientSource: 'cimd',
      outcome: 'redirected',
    });
    expect(ctx.fake.authorizeRequests[0]?.params.client_id).toBe(clientId);
    expect(ctx.fake.cimdFetches).toEqual([{ url: clientId, ok: true }]);
    // 授权与令牌请求都带 resource（RFC 8707）与 PKCE。
    expect(ctx.fake.authorizeRequests[0]?.params).toMatchObject({
      resource: ctx.fake.mcpUrl,
      code_challenge_method: 'S256',
    });
    expect(ctx.fake.tokenRequests[0]?.params.resource).toBe(ctx.fake.mcpUrl);
    expect(ctx.fake.tokenRequests[0]?.params.client_id).toBe(clientId);
    // CIMD 客户端不落 Vault。
    expect(ctx.vault.getClient(ctx.fake.issuer)).toBeNull();
  });

  it('DCR 路径：application_type=native，一次登记全部固定端口，客户端按 issuer 存入 Vault 并被复用', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, redirectMatch: 'exact' } });

    const first = await connect(ctx);
    expect(first.last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(1);
    const registration = ctx.fake.registrations[0]!;
    expect(registration.applicationType).toBe('native');
    expect(registration.redirectUris).toEqual(
      ctx.ports.map((port) => `http://127.0.0.1:${port}/callback`),
    );
    expect(registration.body).toMatchObject({
      client_name: 'KepCup',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    const stored = ctx.vault.getClient(ctx.fake.issuer);
    expect(stored?.source).toBe('dcr');
    expect(stored?.info.client_id).toBe(registration.clientId);
    expect(stored?.redirectUris).toEqual(registration.redirectUris);

    // 再次连接：本机已有该 issuer 的客户端 → 直接用，不再注册。
    const second = await connect(ctx);
    expect(second.last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(1);
    expect(ctx.fake.authorizeRequests.map((r) => r.clientSource)).toEqual(['dcr', 'dcr']);
  });

  it('手填客户端：无 CIMD / DCR → OAUTH_CLIENT_REQUIRED（带 issuer 与回调地址）→ setClientCredentials 后继续', async () => {
    const ctx = await setup();
    ctx.fake.addPreregisteredClient({
      clientId: 'manual-client-1',
      clientSecret: 'manual-secret-xyz',
      redirectUris: ['http://127.0.0.1/callback'],
    });

    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    const required = await until(() =>
      ctx.flowEvents.find((e) => e.flowId === flowId && e.error?.code === 'OAUTH_CLIENT_REQUIRED'),
    );
    expect(required.phase).toBe('failed');
    expect(required.error?.issuer).toBe(ctx.fake.issuer);
    expect(required.error?.redirectUris).toEqual(
      ctx.ports.map((p) => `http://127.0.0.1:${p}/callback`),
    );
    // 流程停放，仍可接续。
    expect(ctx.flows.activeFlowIds()).toContain(flowId);

    ctx.flows.setClientCredentials(flowId, 'manual-client-1', 'manual-secret-xyz');
    // 界面紧接着再 apps.connect 同一目标：与进行中的流程去重（同一 flowId），重发的是进行中阶段。
    expect(ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } }).flowId).toBe(
      flowId,
    );
    expect(ctx.flowEvents.at(-1)).toMatchObject({ flowId, phase: 'discovering' });
    expect(ctx.flowEvents.at(-1)?.error).toBeUndefined();
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));

    const mine = ctx.flowEvents.filter((e) => e.flowId === flowId);
    expect(mine[mine.length - 1]?.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(0);
    expect(ctx.fake.authorizeRequests[0]?.params.client_id).toBe('manual-client-1');
    // 令牌请求以客户端密钥认证（Basic 或 post 之一）。
    const tokenRequest = ctx.fake.tokenRequests[0]!;
    expect(
      tokenRequest.authorization !== undefined || tokenRequest.params.client_secret !== undefined,
    ).toBe(true);
    // 凭据只写 Vault；不进事件。
    expect(ctx.vault.getClient(ctx.fake.issuer)?.source).toBe('manual');
    expect(ctx.env.secrets.getValue(clientSecretSecretName(ctx.fake.issuer))).toBe(
      'manual-secret-xyz',
    );
    expect(JSON.stringify(ctx.events)).not.toContain('manual-secret-xyz');
  });

  it('手填流程已失败结束后再 apps.connect：开始新流程并直接用已存的手填客户端', async () => {
    const ctx = await setup({ browser: 'manual' });
    ctx.fake.addPreregisteredClient({
      clientId: 'manual-3',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.flowEvents.find((e) => e.error?.code === 'OAUTH_CLIENT_REQUIRED'));
    ctx.flows.setClientCredentials(flowId, 'manual-3');
    await until(() => ctx.shellCalls.length === 1);
    ctx.flows.cancel(flowId);
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
    const again = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    expect(again.flowId).not.toBe(flowId);
    await until(() => ctx.shellCalls.length === 2); // 不再索取凭据
    expect(ctx.fake.authorizeRequests).toHaveLength(0);
    ctx.flows.cancel(again.flowId);
  });

  it('手填凭据的流程不存在 / 未在等待凭据时被拒绝', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    expect(() => ctx.flows.setClientCredentials('flow_nope', 'a')).toThrow(/不存在/);
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    expect(() => ctx.flows.setClientCredentials(flowId, 'a')).toThrow();
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
  });
});

describe('回调校验', () => {
  it('iss 与授权服务器不一致 → OAUTH_ISSUER_MISMATCH，不去换令牌，浏览器页显示失败', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, issMode: 'wrong' } });
    const { last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.code).toBe('OAUTH_ISSUER_MISMATCH');
    expect(ctx.fake.tokenRequests).toHaveLength(0);
    expect(ctx.vault.getTokens(CONNECTION_ID)).toBeNull();
    const page = (await Promise.all(ctx.browserRuns))[0]!;
    expect(page.callbackStatus).toBe(200);
    expect(page.callbackBody).toContain('连接失败');
    expect(page.callbackBody).not.toContain('已连接，可回到 KepCup');
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
  });

  it('授权服务器声明支持 iss 却缺失 → 失败；未声明支持时缺失可接受', async () => {
    const strict = await setup({
      fake: { dcrEnabled: true, issMode: 'omit', issParameterSupported: true },
    });
    const failed = await connect(strict);
    expect(failed.last.error?.code).toBe('OAUTH_ISSUER_MISMATCH');
    expect(strict.fake.tokenRequests).toHaveLength(0);

    const lenient = await setup({
      fake: { dcrEnabled: true, issMode: 'omit', issParameterSupported: false },
    });
    expect((await connect(lenient)).last.phase).toBe('done');
  });

  it('state 不符与伪造 Host 的回调被拒（400），不消耗流程；随后合法回调完成授权', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.shellCalls.length === 1);
    const authorizationUrl = new URL(ctx.shellCalls[0] as string);
    const redirect = new URL(authorizationUrl.searchParams.get('redirect_uri') as string);
    const state = authorizationUrl.searchParams.get('state') as string;
    const port = Number(redirect.port);

    expect(await rawGet(port, `/callback?code=forged&state=wrong`)).toBe(400);
    expect(
      await rawGet(port, `/callback?code=forged&state=${state}`, { host: 'evil.example.com' }),
    ).toBe(400);
    expect(
      await rawGet(port, `/callback?code=forged&state=${state}`, { host: `localhost:${port}` }),
    ).toBe(400);
    expect(await rawGet(port, `/callback?code=forged&state=${state}`, { method: 'POST' })).toBe(
      405,
    );
    expect(ctx.fake.tokenRequests).toHaveLength(0);
    expect(ctx.flows.activeFlowIds()).toContain(flowId);

    const page = await simulateBrowser(authorizationUrl);
    expect(page.callbackStatus).toBe(200);
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
    expect(ctx.flowEvents.at(-1)?.phase).toBe('done');
    expect(ctx.fake.tokenRequests).toHaveLength(1);
  });

  it('用户拒绝（access_denied）→ 失败并恢复连接状态，页面显示原因', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, authorizeError: 'access_denied' } });
    const { last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.code).toBe('OAUTH_FLOW_FAILED');
    expect(last.error?.message).toContain('拒绝');
    expect(ctx.fake.tokenRequests).toHaveLength(0);
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
    expect(statusEvents(ctx)).toEqual(['connecting', 'not_connected']);
    const page = (await Promise.all(ctx.browserRuns))[0]!;
    expect(page.callbackBody).toContain('连接失败');
  });
});

describe('端口', () => {
  it('固定端口全被占用 → 随机端口；已登记端口列表不含它 → 打开浏览器前重新注册', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, redirectMatch: 'exact' } });
    // 第一次：固定端口空闲，注册固定端口。
    expect((await connect(ctx)).last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(1);

    // 第二次：固定端口全被占用。精确匹配的授权服务器只在重新注册后才会回调。
    await occupy(ctx.ports);
    const second = await connect(ctx);
    expect(second.last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(2);
    const reregistered = ctx.fake.registrations[1]!;
    const fallback = new URL(ctx.fake.authorizeRequests[1]!.params.redirect_uri as string);
    expect(ctx.ports).not.toContain(Number(fallback.port));
    expect(reregistered.redirectUris).toEqual([
      ...ctx.ports.map((port) => `http://127.0.0.1:${port}/callback`),
      fallback.href,
    ]);
    expect(ctx.fake.authorizeRequests[1]?.clientSource).toBe('dcr');
    // Vault 里的客户端换成了新注册的那个，并记下新的 redirect_uris。
    const stored = ctx.vault.getClient(ctx.fake.issuer);
    expect(stored?.info.client_id).toBe(reregistered.clientId);
    expect(stored?.redirectUris).toContain(fallback.href);
  });

  it('首次连接就遇到固定端口全占用：注册时一并登记本次端口', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, redirectMatch: 'exact' } });
    await occupy(ctx.ports);
    expect((await connect(ctx)).last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(1);
    const redirectUri = ctx.fake.authorizeRequests[0]!.params.redirect_uri as string;
    expect(ctx.fake.registrations[0]!.redirectUris).toContain(redirectUri);
  });

  it('手填客户端 + 固定端口全占用 → 失败并提示释放端口，不打开浏览器', async () => {
    const ctx = await setup();
    ctx.fake.addPreregisteredClient({
      clientId: 'manual-2',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    ctx.vault.saveClient(
      ctx.fake.issuer,
      { client_id: 'manual-2' },
      { source: 'manual', redirectUris: [] },
    );
    await occupy(ctx.ports);
    const { last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.message).toContain('释放');
    expect(ctx.shellCalls).toHaveLength(0);
  });
});

describe('协议失败', () => {
  it('授权服务器不支持 PKCE S256 → 失败，不打开浏览器、不询问同意', async () => {
    const ctx = await setup({
      fake: { dcrEnabled: true, codeChallengeMethodsSupported: ['plain'] },
    });
    const { flowId, last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.message).toContain('PKCE');
    expect(ctx.shellCalls).toHaveLength(0);
    expect(phases(ctx, flowId)).not.toContain('awaiting_consent');
    expect(ctx.fake.authorizeRequests).toHaveLength(0);
  });

  it('令牌端点返回 invalid_client（DCR 客户端被清理）→ 清除客户端、重新注册后重试整个流程（只询问一次同意）', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    ctx.fake.failToken({
      grantType: 'authorization_code',
      error: 'invalid_client',
      status: 401,
      times: 1,
    });

    const { flowId, last } = await connect(ctx);

    expect(last.phase).toBe('done');
    expect(ctx.fake.registrations).toHaveLength(2);
    expect(ctx.shellCalls).toHaveLength(2);
    expect(phases(ctx, flowId).filter((p) => p === 'awaiting_consent')).toHaveLength(1);
    expect(ctx.fake.tokenRequests.map((r) => r.status)).toEqual([401, 200]);
    // 第一次浏览器页显示「正在重新注册」，第二次显示已连接。
    const pages = await Promise.all(ctx.browserRuns);
    expect(pages[0]?.callbackBody).toContain('重新注册');
    expect(pages[1]?.callbackBody).toContain('已连接，可回到 KepCup');
    // 用的是第二次注册的客户端。
    expect(ctx.vault.getClient(ctx.fake.issuer)?.info.client_id).toBe(
      ctx.fake.registrations[1]?.clientId,
    );
  });

  it('重新注册后仍 invalid_client → 失败，不再无限重试', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    ctx.fake.failToken({
      grantType: 'authorization_code',
      error: 'invalid_client',
      status: 401,
      times: 5,
    });
    const { last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.code).toBe('OAUTH_FLOW_FAILED');
    expect(ctx.fake.registrations).toHaveLength(2);
    expect(ctx.vault.getTokens(CONNECTION_ID)).toBeNull();
  });

  it('端点安全：非 https 的 server 地址、解析到私网的 IP、跨主机的明文授权服务器都被拒绝', async () => {
    const plain = await setup({ serverUrl: 'http://example.invalid/mcp' });
    expect((await connect(plain)).last.error?.code).toBe('OAUTH_INSECURE_ENDPOINT');

    const privateIp = await setup({ serverUrl: 'https://10.0.0.5/mcp' });
    expect((await connect(privateIp)).last.error?.code).toBe('OAUTH_INSECURE_ENDPOINT');
    const metadata = await setup({ serverUrl: 'https://169.254.169.254/mcp' });
    expect((await connect(metadata)).last.error?.code).toBe('OAUTH_INSECURE_ENDPOINT');

    // 回环例外只给 server 自身的那个回环主机：授权服务器换成 localhost 就不行。
    const crossHost = await setup({ fake: { dcrEnabled: true } });
    crossHost.fake.configure({
      prmAuthorizationServers: [`http://localhost:${crossHost.fake.port}`],
    });
    const { last } = await connect(crossHost);
    expect(last.phase).toBe('failed');
    expect(last.error?.code).toBe('OAUTH_INSECURE_ENDPOINT');
    expect(crossHost.shellCalls).toHaveLength(0);
  });

  it('回环例外：server 本身是回环地址时，同一回环主机的发现 / 注册 / 令牌请求全部放行', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    expect(new URL(ctx.fake.mcpUrl).hostname).toBe('127.0.0.1');
    expect((await connect(ctx)).last.phase).toBe('done');
    expect(ctx.fake.requests.length).toBeGreaterThan(3);
  });
});

describe('超时 / 取消 / 去重', () => {
  it('等待浏览器回调超时 → OAUTH_FLOW_TIMEOUT，回调端口释放，状态恢复', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual', flowTimeoutMs: 400 });
    const { last } = await connect(ctx);
    expect(last.phase).toBe('failed');
    expect(last.error?.code).toBe('OAUTH_FLOW_TIMEOUT');
    expect(ctx.shellCalls).toHaveLength(1);
    const redirect = new URL(
      new URL(ctx.shellCalls[0] as string).searchParams.get('redirect_uri') as string,
    );
    expect(await portIsFree(Number(redirect.port))).toBe(true);
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
    expect(ctx.flows.activeFlowIds()).toEqual([]);
  });

  it('用户一直不确认授权主机同样超时', async () => {
    const ctx = await setup({
      fake: { dcrEnabled: true },
      autoContinue: false,
      flowTimeoutMs: 300,
    });
    const { last } = await connect(ctx);
    expect(last.error?.code).toBe('OAUTH_FLOW_TIMEOUT');
    expect(ctx.shellCalls).toHaveLength(0);
  });

  it('等待浏览器时取消 → cancelled，回调服务关闭（迟到的回调连不上），不留 verifier 路径', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.shellCalls.length === 1);
    const authorizationUrl = new URL(ctx.shellCalls[0] as string);
    const redirect = new URL(authorizationUrl.searchParams.get('redirect_uri') as string);

    ctx.flows.cancel(flowId);
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));

    expect(phases(ctx, flowId).at(-1)).toBe('cancelled');
    expect(await portIsFree(Number(redirect.port))).toBe(true);
    await expect(simulateBrowser(authorizationUrl)).rejects.toBeDefined();
    expect(ctx.fake.tokenRequests).toHaveLength(0);
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
    // 幂等：对已结束 / 不存在的流程取消不报错。
    ctx.flows.cancel(flowId);
    ctx.flows.cancel('flow_unknown');
  });

  it('确认授权主机之前取消 → cancelled；continue 对不存在的流程报错', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, autoContinue: false });
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    const consent = await until(() => ctx.flowEvents.find((e) => e.phase === 'awaiting_consent'));
    // 同意页带完整授权 URL 与醒目的主机，供用户核对（不含令牌）。
    expect(consent.authorizationHost).toBe(ctx.fake.url.replace('http://', ''));
    expect(consent.authorizationUrl).toContain(ctx.fake.authorizationEndpoint);
    expect(ctx.shellCalls).toHaveLength(0);
    ctx.flows.cancel(flowId);
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
    expect(phases(ctx, flowId).at(-1)).toBe('cancelled');
    expect(() => ctx.flows.continue(flowId)).toThrow();
  });

  it('同一目标并发去重：重复 start 返回同一 flowId，不会起第二个授权', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    const a = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    const b = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    expect(b.flowId).toBe(a.flowId);
    await until(() => ctx.shellCalls.length === 1);
    const c = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    expect(c.flowId).toBe(a.flowId);
    // 后到者订阅同一流程：当前阶段事件被重发。
    expect(ctx.flowEvents.at(-1)).toMatchObject({ flowId: a.flowId, phase: 'awaiting_browser' });

    await simulateBrowser(ctx.shellCalls[0] as string);
    await until(() => !ctx.flows.activeFlowIds().includes(a.flowId));
    expect(ctx.fake.authorizeRequests).toHaveLength(1);
    expect(ctx.fake.tokenRequests).toHaveLength(1);
    expect(ctx.flowEvents.at(-1)?.phase).toBe('done');

    // 结束后再次发起是新的流程（重新连接）。
    const d = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    expect(d.flowId).not.toBe(a.flowId);
    ctx.flows.cancel(d.flowId);
    await until(() => ctx.flows.activeFlowIds().length === 0);
  });

  it('目录去重并入 grantBotId：后到者的 Bot 一起授权；授权已开始 / 流程已终止后再来的 grantBotId 走新流程，不追溯', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    // 桩目录端：begin 建临时行，settle 直接定稿（无需复核），confirm 记录 Bot 集合并卡在闸门上。
    const confirmed: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ctx.flows.attachCatalogHost({
      begin: ({ connectorId }) => {
        const row = ctx.store.create({
          connectorId,
          connectorVer: '1.0.0',
          label: 'Stub',
          serverUrl: ctx.fake.mcpUrl,
          status: 'connecting',
        });
        return {
          connectorId,
          title: 'Stub',
          serverUrl: ctx.fake.mcpUrl,
          defaultScopes: [],
          connectionId: row.id,
          reconnectTo: null,
          existingScopes: [],
        };
      },
      abandon: (connectionId) => {
        if (ctx.store.get(connectionId) !== null) {
          ctx.vault.clearConnection(connectionId, { deleteRow: true });
        }
      },
      settle: async ({ connectionId }) => ({
        connectionId,
        isNew: true,
        accountLabel: null,
        review: [],
      }),
      confirm: async ({ grantBotIds }) => {
        confirmed.push([...grantBotIds]);
        await gate;
      },
      reject: async ({ connectionId }) => {
        if (ctx.store.get(connectionId) !== null) {
          ctx.vault.clearConnection(connectionId, { deleteRow: true });
        }
      },
    });
    const target = { kind: 'catalog', connectorId: 'stub' } as const;

    const first = ctx.flows.start({ target, grantBotId: 'bot_a' });
    // 并发接入：同一 flowId；带 grantBotId 的并入集合，不带的只是订阅；重复的 Bot 不重复。
    expect(ctx.flows.start({ target, grantBotId: 'bot_b' }).flowId).toBe(first.flowId);
    expect(ctx.flows.start({ target }).flowId).toBe(first.flowId);
    expect(ctx.flows.start({ target, grantBotId: 'bot_a' }).flowId).toBe(first.flowId);
    await until(() => ctx.shellCalls.length === 1);
    await simulateBrowser(ctx.shellCalls[0] as string);
    await until(() => confirmed.length === 1);
    expect([...(confirmed[0] as string[])].sort()).toEqual(['bot_a', 'bot_b']);

    // 授权已开始（confirm 进行中，流程尚未清理）：再带 grantBotId 来不并入——开始新流程；
    // 不带 grantBotId 的仍订阅原流程。
    expect(ctx.flows.activeFlowIds()).toContain(first.flowId);
    expect(ctx.flows.start({ target }).flowId).toBe(first.flowId);
    const second = ctx.flows.start({ target, grantBotId: 'bot_c' });
    expect(second.flowId).not.toBe(first.flowId);
    release();
    await until(() => !ctx.flows.activeFlowIds().includes(first.flowId));
    expect(ctx.flowEvents.filter((e) => e.flowId === first.flowId).at(-1)?.phase).toBe('done');
    // 第一个流程只授权了它收集到的两个 Bot；bot_c 不被追溯。
    expect(confirmed).toHaveLength(1);
    ctx.flows.cancel(second.flowId);
    await until(() => ctx.flows.activeFlowIds().length === 0);
    expect(confirmed).toHaveLength(1);
  });

  it('应用退出（shutdown）取消所有进行中的流程并关闭回调服务', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.shellCalls.length === 1);
    const redirect = new URL(
      new URL(ctx.shellCalls[0] as string).searchParams.get('redirect_uri') as string,
    );
    await ctx.flows.shutdown();
    expect(ctx.flows.activeFlowIds()).toEqual([]);
    expect(await portIsFree(Number(redirect.port))).toBe(true);
    expect(ctx.flowEvents.at(-1)?.phase).toBe('cancelled');
    expect(() => ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } })).toThrow();
  });
});

describe('入口校验', () => {
  it('目录目标需要接入目录模块（未接入时报错；接入后的行为见 catalog-connect 集成测试）；未知 / 非 OAuth 的 server 被拒绝', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    expect(() => ctx.flows.start({ target: { kind: 'catalog', connectorId: 'x' } })).toThrow(
      /目录模块未就绪/,
    );
    ctx.setServer({ auth: 'none' });
    expect(() => ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } })).toThrow(
      /OAuth/,
    );
    expect(() => ctx.flows.start({ target: { kind: 'custom', serverId: 'nope' } })).toThrow(
      /不存在/,
    );
  });

  it('非测试环境的 CIMD URL 必须是 https', () => {
    const env = openRealMainDb();
    cleanups.push(() => env.dispose());
    const store = new AppConnectionStore({ db: env.db, clock: env.clock });
    const vault = new TokenVault({ secrets: env.secrets, store, clock: env.clock });
    const deps = {
      store,
      vault,
      settings: { get: () => ({ mcpServers: [] }) as never },
      shell: { openExternal: async () => ({ ok: true }) },
      events: { emit: () => undefined },
      logger: {} as never,
      clock: env.clock,
    };
    expect(() => new ConnectFlowManager({ ...deps, cimdUrl: 'http://kepcup.test/c.json' })).toThrow(
      /https/,
    );
    expect(() => new ConnectFlowManager({ ...deps })).not.toThrow();
    expect(
      () =>
        new ConnectFlowManager({
          ...deps,
          cimdUrl: 'http://kepcup.test/c.json',
          allowInsecureCimdUrl: true,
        }),
    ).not.toThrow();
  });
});

describe('落盘与安全', () => {
  it('成功后：连接行 connected、令牌在 Vault 且在授权服务器上有效、运行时缓存被通知失效（先于 done）', async () => {
    const ctx = await setup({
      fake: { dcrEnabled: true, challengeScope: 'notes.read notes.write' },
    });
    const { flowId, last } = await connect(ctx);
    expect(last).toMatchObject({ phase: 'done', connectionId: CONNECTION_ID });

    const row = ctx.store.getRequired(CONNECTION_ID);
    expect(row.status).toBe('connected');
    expect(row.issuer).toBe(ctx.fake.issuer);
    expect(row.serverUrl).toBe(ctx.fake.mcpUrl);
    expect(row.scopes).toEqual(['notes.read', 'notes.write']);
    expect(row.tokenExpiresAt).not.toBeNull();
    const tokens = ctx.vault.getTokens(CONNECTION_ID)!;
    expect(ctx.fake.isAccessTokenValid(tokens.accessToken)).toBe(true);
    expect(tokens.refreshToken).toBeDefined();
    expect(ctx.invalidated).toEqual([CONNECTION_ID]);
    expect(statusEvents(ctx)).toEqual(['connecting', 'connected']);
    // 授权请求使用了服务端挑战里的 scope。
    expect(ctx.fake.authorizeRequests[0]?.params.scope).toBe('notes.read notes.write');
    expect(ctx.flowEvents.filter((e) => e.flowId === flowId).at(-1)?.phase).toBe('done');
    // 页面是成功文案。
    expect((await Promise.all(ctx.browserRuns))[0]?.callbackBody).toContain(
      '已连接，可回到 KepCup',
    );
  });

  it('显式 scopes 优先于服务端提示（追加授权用旧 ∪ 新）', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true, challengeScope: 'notes.read' } });
    const { flowId } = ctx.flows.start({
      target: { kind: 'custom', serverId: SERVER_ID },
      scopes: ['notes.read', 'notes.write'],
    });
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
    expect(ctx.fake.authorizeRequests[0]?.params.scope).toBe('notes.read notes.write');
  });

  it('重新连接失败不会毁掉已有连接：状态恢复为原状态，旧令牌保留', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true } });
    expect((await connect(ctx)).last.phase).toBe('done');
    const before = ctx.vault.getTokens(CONNECTION_ID)!.accessToken;
    ctx.fake.configure({ authorizeError: 'access_denied' });
    expect((await connect(ctx)).last.phase).toBe('failed');
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('connected');
    expect(ctx.vault.getTokens(CONNECTION_ID)?.accessToken).toBe(before);
  });

  it('令牌 / code / verifier / 客户端密钥不出现在任何事件或日志里（成功与失败流程）', async () => {
    const ok = await setup({ fake: { dcrEnabled: true } });
    ok.fake.addPreregisteredClient({
      clientId: 'leak-client',
      clientSecret: 'leak-client-secret-9f3',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    expect((await connect(ok)).last.phase).toBe('done');
    const tokens = ok.vault.getTokens(CONNECTION_ID)!;
    const code = new URL(ok.fake.authorizeRequests[0]!.location as string).searchParams.get(
      'code',
    )!;
    const verifier = ok.fake.tokenRequests[0]!.params.code_verifier!;
    const blob = JSON.stringify(ok.events) + ok.logs.join('\n');
    for (const secret of [tokens.accessToken, tokens.refreshToken!, code, verifier]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(blob).not.toContain(secret);
    }
    // 事件里只有进度与（同意阶段的）授权 URL：URL 带 challenge 不带 verifier。
    expect(blob).not.toContain('access_token');
    expect(blob).not.toContain('refresh_token');

    const bad = await setup({ fake: { dcrEnabled: true, issMode: 'wrong' } });
    await connect(bad);
    const badCode = new URL(bad.fake.authorizeRequests[0]!.location as string).searchParams.get(
      'code',
    )!;
    expect(JSON.stringify(bad.events) + bad.logs.join('\n')).not.toContain(badCode);

    // 手填客户端密钥只进 Vault。
    const manual = await setup();
    manual.fake.addPreregisteredClient({
      clientId: 'leak-client-2',
      clientSecret: 'leak-client-secret-2-ab7',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    const { flowId } = manual.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => manual.flowEvents.some((e) => e.error?.code === 'OAUTH_CLIENT_REQUIRED'));
    manual.flows.setClientCredentials(flowId, 'leak-client-2', 'leak-client-secret-2-ab7');
    await until(() => !manual.flows.activeFlowIds().includes(flowId));
    expect(manual.flowEvents.at(-1)?.phase).toBe('done');
    expect(JSON.stringify(manual.events) + manual.logs.join('\n')).not.toContain(
      'leak-client-secret-2-ab7',
    );
  });
});

describe('复查修复（D73 P0 review）', () => {
  it('记录每个连接授权时用的客户端（DCR 与 CIMD 都记），随断开一并清除', async () => {
    const dcr = await setup({ fake: { dcrEnabled: true } });
    expect((await connect(dcr)).last.phase).toBe('done');
    expect(dcr.vault.getConnectionClient(CONNECTION_ID)).toEqual({
      client_id: dcr.fake.registrations[0]?.clientId,
    });
    dcr.vault.clearConnection(CONNECTION_ID);
    expect(dcr.vault.getConnectionClient(CONNECTION_ID)).toBeNull();

    const files = await startFileServer({});
    cleanups.push(() => files.stop());
    const { clientId: cimdUrl } = publishCimdDocument(files);
    const cimd = await setup({ fake: { cimdSupported: true }, cimdUrl });
    expect((await connect(cimd)).last.phase).toBe('done');
    expect(cimd.vault.getConnectionClient(CONNECTION_ID)).toEqual({ client_id: cimdUrl });
  });

  it('invalid_client 重试后重新计时：停放在 OAUTH_CLIENT_REQUIRED 的流程到总时限会超时，不会永远存活', async () => {
    const ctx = await setup({ flowTimeoutMs: 700 });
    ctx.fake.addPreregisteredClient({
      clientId: 'manual-x',
      redirectUris: ['http://127.0.0.1/callback'],
    });
    ctx.fake.failToken({
      grantType: 'authorization_code',
      error: 'invalid_client',
      status: 401,
      times: 1,
    });
    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    const required = () =>
      ctx.flowEvents.filter(
        (e) => e.flowId === flowId && e.error?.code === 'OAUTH_CLIENT_REQUIRED',
      );
    await until(() => required().length === 1);
    ctx.flows.setClientCredentials(flowId, 'manual-x');
    // 令牌端点拒绝手填客户端 → 清除并重新索取凭据（第二次停放）。
    await until(() => required().length === 2);
    // 总时限从停放时重新计时；之前（换令牌阶段清掉了计时器）这里会永远停放。
    await until(() => !ctx.flows.activeFlowIds().includes(flowId), 3_000);
    expect(ctx.flowEvents.filter((e) => e.flowId === flowId).at(-1)?.error?.code).toBe(
      'OAUTH_FLOW_TIMEOUT',
    );
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
  });

  it('invalid_client 重试时授权主机变了：重新进入 awaiting_consent，用户确认前不打开浏览器', async () => {
    const ctx = await setup({
      fake: { dcrEnabled: true },
      browser: 'manual',
      autoContinue: false,
      loopbackAllowlist: ['127.0.0.1'],
    });
    const otherHost = `127.0.0.1:${Number(new URL(ctx.fake.url).port) + 1}`;
    // 第一次授权前元数据指向原主机；令牌端点拒绝一次之后，重新发现的授权端点换到另一个主机。
    ctx.fake.configure({
      authorizationEndpoint: () =>
        ctx.fake.tokenRequests.length === 0
          ? ctx.fake.authorizationEndpoint
          : `http://${otherHost}/authorize`,
    });
    ctx.fake.failToken({
      grantType: 'authorization_code',
      error: 'invalid_client',
      status: 401,
      times: 1,
    });

    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    const consents = () =>
      ctx.flowEvents.filter((e) => e.flowId === flowId && e.phase === 'awaiting_consent');
    await until(() => consents().length === 1);
    ctx.flows.continue(flowId);
    await until(() => ctx.shellCalls.length === 1);
    await simulateBrowser(ctx.shellCalls[0] as string);

    await until(() => consents().length === 2);
    expect(consents()[0]?.authorizationHost).toBe(ctx.fake.url.replace('http://', ''));
    expect(consents()[1]?.authorizationHost).toBe(otherHost);
    expect(ctx.shellCalls).toHaveLength(1); // 未经确认不打开新主机
    ctx.flows.continue(flowId);
    await until(() => ctx.shellCalls.length === 2);
    expect(new URL(ctx.shellCalls[1] as string).host).toBe(otherHost);
    ctx.flows.cancel(flowId);
    await until(() => !ctx.flows.activeFlowIds().includes(flowId));
  });

  it('cancelForConnection：取消并等流程收尾，状态落在 not_connected 而不是恢复成流程开始前的 connected', async () => {
    const ctx = await setup({ fake: { dcrEnabled: true }, browser: 'manual' });
    ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.shellCalls.length === 1);
    await simulateBrowser(ctx.shellCalls[0] as string);
    await until(() => ctx.flows.activeFlowIds().length === 0);
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('connected');

    const { flowId } = ctx.flows.start({ target: { kind: 'custom', serverId: SERVER_ID } });
    await until(() => ctx.shellCalls.length === 2);
    await ctx.flows.cancelForConnection(CONNECTION_ID);
    expect(ctx.flows.activeFlowIds()).toEqual([]);
    expect(phases(ctx, flowId).at(-1)).toBe('cancelled');
    expect(ctx.store.get(CONNECTION_ID)?.status).toBe('not_connected');
    await ctx.flows.cancelForConnection(CONNECTION_ID); // 幂等
    await ctx.flows.cancelForConnection('custom:nobody');
  });
});

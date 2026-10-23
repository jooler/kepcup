import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  pairingAcceptTranscript,
  pairingRequestTranscript,
  type RelayEnvelope,
} from '@kepcup/shared';
import { createCore, type CoreHarness } from '../../src/create-core.js';
import {
  FrameCodec,
  deriveSessionKeys,
  generateEphemeralX25519,
  pairingAuth,
  transcriptHash,
  x25519Shared,
  type SessionKeys,
} from '../../src/remote/codec.js';
import { currentRemoteSource } from '../../src/remote/audit.js';

/**
 * WP6 三端联调（design 46 §8，todo/remote-control.md WP6）：真实中转
 * （`wrangler dev` = miniflare，起 RelaySession DO）+ 真实 core（in-process
 * anchor，生产 RelayClient 路径）+ 假 viewer（Node 全局 WebSocket + core
 * FrameCodec，走完整配对协议）+ 真 web 构建（Playwright 驱动 relay/public 里的
 * PWA，真实 WsTransport + WebCrypto）。
 *
 * 默认跳过（全量 `pnpm test` 不依赖 wrangler / 端口 / 浏览器）；手动跑：
 *   KEPCUP_RELAY_E2E=1 node scripts/run-tests.mjs run packages/core/test/integration/remote-relay.e2e.test.ts
 * 端口可用 KEPCUP_RELAY_E2E_PORT 覆盖（默认 8977）。
 */

const RUN = process.env.KEPCUP_RELAY_E2E === '1';
const PORT = Number(process.env.KEPCUP_RELAY_E2E_PORT ?? 8977);
const HTTP_BASE = `http://127.0.0.1:${PORT}`;
const RELAY_URL = `ws://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const RELAY_DIR = path.join(REPO_ROOT, 'infra/cloudflare/relay');

const d = RUN ? describe : describe.skip;

// --- wrangler dev 生命周期 ----------------------------------------------------------

/**
 * 为什么 spawn 的是真 `node` + `wrangler-dist/cli.js`：
 *  - 本仓测试跑在 Electron-as-Node 运行时下（docs/dev/05-testing.md），Electron
 *    的 argv 处理会弄乱 wrangler 的命令行参数（Unknown arguments: port, ip…），
 *    必须用系统 node（vitest worker 的 PATH 里有，spawn 可用）；
 *  - bin/wrangler.js 包装器自己 respawn 一层，直接跑 cli.js 少一层变量。
 * wrangler 由 apps/website 依赖带入（4.151.x），cwd 在 relay 目录读 wrangler.jsonc。
 */
const WRANGLER_CLI = path.join(
  realpathSync(path.join(REPO_ROOT, 'apps/website/node_modules/wrangler')),
  'wrangler-dist/cli.js',
);

let wrangler: ChildProcess | null = null;
let wranglerLog: string[] = [];

function startWrangler(): ChildProcess {
  const child = spawn('node', [WRANGLER_CLI, 'dev', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: RELAY_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', WRANGLER_LOG: 'error' },
  });
  wranglerLog = [];
  const capture = (chunk: Buffer) => {
    wranglerLog.push(chunk.toString());
    if (wranglerLog.length > 200) wranglerLog.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return child;
}

async function stopWrangler(): Promise<void> {
  const child = wrangler;
  wrangler = null;
  if (child === null || child.exitCode !== null) return;
  // SIGTERM 让 wrangler 收尾并杀掉 workerd 子进程；SIGKILL 会留下占端口的孤儿。
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealthz(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${HTTP_BASE}/healthz`);
      if (response.ok) return;
      lastError = `healthz ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(400);
  }
  throw new Error(`本地中转未就绪（${lastError}）`);
}

// --- 远程来源探针（包一层 appMethods，抓 withRemoteSource 的调用链来源）---------------

interface RemoteCallRecord {
  method: string;
  source: string | null;
}
const remoteCalls: RemoteCallRecord[] = [];

function probeMethod(harness: CoreHarness, name: 'system.ping' | 'system.info'): void {
  const spec = harness.services.appMethods[name];
  if (!spec) throw new Error(`appMethods 缺 ${name}`);
  harness.services.appMethods[name] = {
    ...spec,
    handle: async (input) => {
      remoteCalls.push({ method: name, source: currentRemoteSource() });
      return spec.handle(input as never);
    },
  };
}

// --- 假 viewer（Node 全局 WebSocket + core FrameCodec）------------------------------

interface InboxEntry {
  envelope: RelayEnvelope;
  raw: string;
}

let didSeq = 0;

class FakeViewer {
  readonly did: string;
  ws: WebSocket | null = null;
  codec: FrameCodec | null = null;
  keys: SessionKeys | null = null;
  readonly inbox: InboxEntry[] = [];
  readonly outbox: string[] = [];
  readonly closed: Array<{ code: number; reason: string }> = [];
  private inboxWaiters: Array<{ predicate: (entry: InboxEntry) => boolean; wake: () => void }> = [];
  private closeWaiters: Array<() => void> = [];
  private rpcSeq = 0;

  constructor(readonly name: string) {
    didSeq += 1;
    this.did = `wp6-viewer-${String(didSeq).padStart(2, '0')}-aaaaaaaaaa`;
  }

  /** 原始连接（不配对）。 */
  static async connect(sessionId: string): Promise<FakeViewer> {
    const viewer = new FakeViewer('raw');
    await viewer.openSocket(sessionId);
    return viewer;
  }

  async openSocket(sessionId: string): Promise<void> {
    const ws = new WebSocket(`${RELAY_URL}/ws/${sessionId}?role=viewer`);
    this.ws = ws;
    ws.addEventListener('message', (event) => {
      const raw = typeof event.data === 'string' ? event.data : String(event.data);
      let envelope: RelayEnvelope;
      try {
        envelope = JSON.parse(raw) as RelayEnvelope;
      } catch {
        return;
      }
      this.inbox.push({ envelope, raw });
      for (const waiter of [...this.inboxWaiters]) {
        if (waiter.predicate(this.inbox[this.inbox.length - 1]!)) waiter.wake();
      }
    });
    ws.addEventListener('close', (event) => {
      this.closed.push({ code: event.code ?? -1, reason: event.reason ?? '' });
      this.ws = null;
      for (const wake of [...this.closeWaiters]) wake();
      this.closeWaiters = [];
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('viewer 连接超时')), 10_000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('viewer 连接失败'));
      });
    });
  }

  sendRaw(raw: string): void {
    if (this.ws === null) throw new Error(`${this.name}: socket 未打开`);
    this.outbox.push(raw);
    this.ws.send(raw);
  }

  sendSealed(
    type: 'hello' | 'rpc' | 'event',
    payload: unknown,
    options: { did?: string; rid?: string } = {},
  ): void {
    if (this.codec === null) throw new Error(`${this.name}: codec 未就绪`);
    const frames = this.codec.seal(type, payload, {
      did: options.did ?? this.did,
      ...(options.rid !== undefined ? { rid: options.rid } : {}),
    });
    for (const frame of frames) this.sendRaw(JSON.stringify(frame));
  }

  /** birpc 线格式的最小客户端：发 {t:'q'} 请求，等 {t:'s'} 响应。 */
  async call(method: string, input?: unknown): Promise<unknown> {
    this.rpcSeq += 1;
    const id = `wp6-${this.rpcSeq}`;
    const fromIndex = this.inbox.length;
    this.sendSealed('rpc', { t: 'q', m: method, a: input === undefined ? [] : [input], i: id });
    const response = await this.waitFor(
      (entry) => entry.envelope.type === 'rpc' && entry.envelope.rid === id,
      15_000,
      fromIndex,
    );
    const payload = await this.openPayload(response);
    const shape = payload as { t?: string; r?: unknown };
    if (shape.t === 's') return shape.r;
    throw new Error(`rpc ${method} 失败: ${JSON.stringify(shape)}`);
  }

  async openPayload(entry: InboxEntry): Promise<unknown> {
    if (this.codec === null) throw new Error('codec 未就绪');
    const opened = this.codec.open(entry.envelope);
    if (!opened.complete) throw new Error('帧未凑齐（分片不完整）');
    return opened.payload;
  }

  /** 等待一条匹配的入站帧（只看 fromIndex 之后的新帧）。 */
  waitFor(
    predicate: (entry: InboxEntry) => boolean,
    timeoutMs = 8_000,
    fromIndex = 0,
  ): Promise<InboxEntry> {
    const scan = () => this.inbox.slice(fromIndex).find((entry) => predicate(entry));
    const existing = scan();
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: { predicate: (entry: InboxEntry) => boolean; wake: () => void } = {
        predicate,
        wake: () => {},
      };
      const timer = setTimeout(() => {
        const index = this.inboxWaiters.indexOf(waiter);
        if (index >= 0) this.inboxWaiters.splice(index, 1);
        reject(
          new Error(
            `等待帧超时（${timeoutMs}ms）；已收 ${this.inbox.length - fromIndex} 帧：${this.inbox
              .slice(fromIndex)
              .slice(-5)
              .map((entry) => entry.envelope.type)
              .join(',')}`,
          ),
        );
      }, timeoutMs);
      waiter.wake = () => {
        const found = scan();
        if (found === undefined) return;
        clearTimeout(timer);
        const index = this.inboxWaiters.indexOf(waiter);
        if (index >= 0) this.inboxWaiters.splice(index, 1);
        resolve(found);
      };
      this.inboxWaiters.push(waiter);
    });
  }

  async waitForClose(timeoutMs = 8_000): Promise<{ code: number; reason: string }> {
    if (this.closed.length > 0) return this.closed[this.closed.length - 1]!;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.closed.length === 0) throw new Error('连接未被关闭');
    return this.closed[this.closed.length - 1]!;
  }

  /**
   * 断开后的重连：新 socket；计数语义对齐真 viewer（ws-transport 模块头）——
   * 出站计数续号（hub 移植入站窗口，清零会被当重放拒掉）、入站窗口每连接重建。
   */
  async reconnectWithHello(sessionId: string, token: string): Promise<void> {
    if (this.keys === null) throw new Error('尚未配对，无法重连');
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'reconnect');
      } catch {
        // 忽略已关闭的 socket
      }
      this.ws = null;
    }
    const previous = this.codec;
    this.codec = new FrameCodec(this.keys, sessionId, 'viewer');
    if (previous !== null) this.codec.restoreOutbound(previous.outboundCounter);
    await this.openSocket(sessionId);
    this.sendSealed('hello', { token, ts: Date.now() });
  }

  close(): void {
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'test done');
      } catch {
        // 已关闭的 socket 再 close 会抛，忽略。
      }
    }
    this.ws = null;
  }
}

const liveViewers = new Set<FakeViewer>();

/** 完整配对（request → 桌面确认 → accept/done → hello），返回 token。 */
async function pairFakeViewer(
  core: CoreHarness,
  sessionId: string,
  secret: string,
  name: string,
): Promise<{ viewer: FakeViewer; token: string }> {
  const viewer = new FakeViewer(name);
  liveViewers.add(viewer);
  const eph = generateEphemeralX25519();
  const epub = eph.rawPublicKey.toString('base64url');
  const requestPart = pairingRequestTranscript({ deviceId: viewer.did, epub, pskMode: 'x25519' });
  const auth = pairingAuth(Buffer.from(secret, 'base64url'), transcriptHash([requestPart]));

  await viewer.openSocket(sessionId);
  viewer.sendRaw(
    JSON.stringify({
      v: 1,
      sid: sessionId,
      type: 'pairing',
      did: viewer.did,
      n: 0,
      data: {
        kind: 'request',
        deviceId: viewer.did,
        deviceName: name,
        userAgent: 'wp6-fake-viewer',
        epub,
        pskMode: 'x25519',
        auth: auth.toString('base64url'),
      },
    }),
  );

  // 等桌面侧挂起 → 确认（等价于桌面确认卡点「允许」）
  const requestId = await waitFor(async () => {
    const status = (await core.rpc.call('remote.status')) as {
      pendingPairing: Array<{ requestId: string; deviceId: string }>;
    };
    return status.pendingPairing.find((request) => request.deviceId === viewer.did)?.requestId;
  }, 10_000);
  const confirmed = (await core.rpc.call('remote.confirmPairing', {
    requestId,
    accept: true,
  })) as { status: string };
  expect(confirmed.status).toBe('paired');

  // accept（明文）+ done（密文）到达
  const acceptEntry = await viewer.waitFor(
    (entry) =>
      entry.envelope.type === 'pairing' &&
      (entry.envelope.data as { kind?: string } | undefined)?.kind === 'accept',
  );
  const accept = acceptEntry.envelope.data as { apub: string; pskMode: 'x25519' | 'psk' };
  const acceptPart = pairingAcceptTranscript({ apub: accept.apub, pskMode: accept.pskMode });
  const shared = x25519Shared(eph.privateKey, Buffer.from(accept.apub, 'base64url'));
  const keys = deriveSessionKeys({
    pskMode: accept.pskMode,
    pairingCode: Buffer.from(secret, 'base64url'),
    transcriptHash: transcriptHash([requestPart, acceptPart]),
    sharedSecret: shared,
  });
  viewer.keys = keys;
  viewer.codec = new FrameCodec(keys, sessionId, 'viewer');
  const doneEntry = await viewer.waitFor(
    (entry) => entry.envelope.type === 'pairing' && entry.envelope.ct !== undefined,
  );
  const done = (await viewer.openPayload(doneEntry)) as { kind: string; token: string };
  expect(done.kind).toBe('done');
  // 协议约定（与 ws-transport 一致）：done 落地后入站窗口重开——anchor 在 hello 时
  // 会换新端点 codec，出站计数从 0 起，旧窗口会把端点的首批帧当重放拒掉。
  viewer.codec = new FrameCodec(keys, sessionId, 'viewer');

  // hello 自举
  viewer.sendSealed('hello', { token: done.token, ts: Date.now() });
  await waitFor(async () => {
    const devices = (await core.rpc.call('remote.devices')) as {
      devices: Array<{ deviceId: string; online?: boolean }>;
    };
    return devices.devices.some((device) => device.deviceId === viewer.did && device.online)
      ? true
      : undefined;
  }, 10_000);
  return { viewer, token: done.token };
}

/** 创建配对 offer 并拆出配对码（sessionId 对同一 core 是稳定的）。 */
async function createOffer(
  core: CoreHarness,
): Promise<{ sessionId: string; secret: string; url: string }> {
  const offer = (await core.rpc.call('remote.createPairing')) as {
    url: string;
    sessionId: string;
  };
  const marker = offer.url.split('#pair=')[1] ?? '';
  const [relayPart, sessionId, secret] = marker.split(',');
  if (decodeURIComponent(relayPart!) !== RELAY_URL) {
    throw new Error(`offer 中转地址不符: ${decodeURIComponent(relayPart!)}`);
  }
  return { sessionId: sessionId!, secret: secret!, url: offer.url };
}

// --- 断言小工具 -----------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 200,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `条件等待超时（${timeoutMs}ms）${lastError === null ? '' : `: 最后错误 ${String(lastError)}`}`,
  );
}

interface DeviceRow {
  deviceId: string;
  online?: boolean;
  revokedAt: number | null;
}

async function deviceOf(core: CoreHarness, did: string): Promise<DeviceRow | undefined> {
  const devices = (await core.rpc.call('remote.devices')) as { devices: DeviceRow[] };
  return devices.devices.find((device) => device.deviceId === did);
}

/** 原始 HTTP upgrade 请求，返回握手状态码（429 拒绝断言用）。 */
function upgradeStatusCode(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? -1);
        request.destroy();
      },
    );
    request.on('error', (error) => reject(error));
    request.end();
  });
}

/** ULID 形状（26 位 Crockford Base32）的假会话 id；不需要真实可解码。 */
function randomSessionId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '01';
  for (let i = 2; i < 26; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]!;
  }
  return out;
}

/** 带重试的 viewer 连接（前一组 viewer 刚关闭时 DO 名额回收有亚秒级延迟）。 */
async function connectViewerWithRetry(sessionId: string): Promise<FakeViewer> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const viewer = await FakeViewer.connect(sessionId);
      liveViewers.add(viewer);
      return viewer;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('viewer 连接重试超时');
}

// --- 用例 -----------------------------------------------------------------------------

let core: CoreHarness;
let coreHome: string | null = null;

d('WP6 三端联调（wrangler dev + core anchor + viewer / web 构建）', () => {
  beforeAll(async () => {
    wrangler = startWrangler();
    await waitForHealthz(120_000);
    // 临时 home + memory keystore（同 testkit）：绝不碰真实用户数据目录
    coreHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wp6-relay-home-'));
    core = await createCore({
      home: coreHome,
      env: { NODE_ENV: 'test', KEPCUP_KEYSTORE: 'memory' },
    });
    if (core.services.status.status === 'error') {
      throw new Error(`core 启动失败: ${core.services.statusReason ?? '(无原因)'}`);
    }
    probeMethod(core, 'system.ping');
    probeMethod(core, 'system.info');
    await core.rpc.call('settings.update', {
      remoteEnabled: true,
      remoteRelayUrl: RELAY_URL,
    });
    await waitFor(async () => {
      const status = (await core.rpc.call('remote.status')) as { anchor: string };
      return status.anchor === 'online' ? true : undefined;
    }, 30_000);
  }, 120_000);

  afterEach(() => {
    for (const viewer of liveViewers) viewer.close();
    liveViewers.clear();
  });

  afterAll(async () => {
    await core?.close();
    await stopWrangler();
    if (coreHome !== null) fs.rmSync(coreHome, { recursive: true, force: true });
  });

  test('端到端全链路：配对 → RPC 定向 → 事件广播 → 审计来源', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-1');

    // RPC 定向：viewer 调 system.ping，真的在 core 上执行且审计来源是 remote:{did}
    const pong = await viewer.call('system.ping');
    expect(pong).toBeDefined();
    expect(
      remoteCalls.some(
        (call) => call.method === 'system.ping' && call.source === `remote:${viewer.did}`,
      ),
    ).toBe(true);

    // 事件广播：hello 成功触发的 deviceChanged / anchorState 事件帧应到达 viewer
    const eventEntry = await viewer.waitFor(
      (entry) => entry.envelope.type === 'event' && entry.envelope.ct !== undefined,
      10_000,
    );
    const payload = (await viewer.openPayload(eventEntry)) as {
      name: string;
      payload: Record<string, unknown>;
    };
    expect(['remote.deviceChanged', 'remote.anchorState']).toContain(payload.name);

    // viewer 断开 → DO 发 viewer_left → hub 宽限 5s 后清端点（设备列表不虚高）
    viewer.close();
    await waitFor(
      async () => ((await deviceOf(core, viewer.did))?.online === false ? true : undefined),
      15_000,
    );
  }, 60_000);

  test('viewer 断线重连：端点重建（防重放窗口清零）后 RPC 恢复', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer, token } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-2');
    await viewer.call('system.ping');

    viewer.close();
    await sleep(300); // 让 DO 先处理断开

    await viewer.reconnectWithHello(sessionId, token);
    const pong = await viewer.call('system.ping');
    expect(pong).toBeDefined();
    expect(
      remoteCalls.filter(
        (call) => call.method === 'system.ping' && call.source === `remote:${viewer.did}`,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  }, 60_000);

  test('桌面断开 / 重连：viewer 收 anchor_offline / anchor_online 信号并重新自举', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer, token } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-3');

    await core.rpc.call('remote.config.set', { enabled: false });
    await viewer.waitFor(
      (entry) => entry.envelope.type === 'signal' && entry.envelope.info?.kind === 'anchor_offline',
      15_000,
    );
    await waitFor(async () => {
      const status = (await core.rpc.call('remote.status')) as { anchor: string };
      return status.anchor === 'off' ? true : undefined;
    }, 15_000);

    await core.rpc.call('remote.config.set', { enabled: true });
    await viewer.waitFor(
      (entry) => entry.envelope.type === 'signal' && entry.envelope.info?.kind === 'anchor_online',
      20_000,
    );
    await viewer.reconnectWithHello(sessionId, token);
    expect(await viewer.call('system.ping')).toBeDefined();
  }, 90_000);

  test('多端点并发：两台遥控端同时在线，RPC 各自定向、事件都到', async () => {
    const first = await createOffer(core);
    const a = await pairFakeViewer(core, first.sessionId, first.secret, 'wp6-phone-4a');
    const second = await createOffer(core);
    const inboxBeforeB = a.viewer.inbox.length;
    const b = await pairFakeViewer(core, second.sessionId, second.secret, 'wp6-phone-4b');

    // RPC 定向：各自的响应帧 did 各归各
    await a.viewer.call('system.ping');
    await b.viewer.call('system.ping');
    expect(
      a.viewer.inbox.some(
        (entry) => entry.envelope.type === 'rpc' && entry.envelope.did === a.viewer.did,
      ),
    ).toBe(true);
    expect(
      b.viewer.inbox.some(
        (entry) => entry.envelope.type === 'rpc' && entry.envelope.did === b.viewer.did,
      ),
    ).toBe(true);

    // 事件广播：B 上线触发的 deviceChanged(online) 也要到 A（B 配对过程中 A 会先
    // 收到 paired 广播，谓词精确匹配 online + 设备 id）
    const onlineAtA = await a.viewer.waitFor(
      (entry) => {
        if (entry.envelope.type !== 'event' || entry.envelope.ct === undefined) return false;
        const opened = a.viewer.codec?.open(entry.envelope);
        if (!opened?.complete) return false;
        const payload = opened.payload as {
          name?: string;
          payload?: { change?: string; device?: { deviceId?: string } };
        };
        return (
          payload.name === 'remote.deviceChanged' &&
          payload.payload?.change === 'online' &&
          payload.payload?.device?.deviceId === b.viewer.did
        );
      },
      10_000,
      inboxBeforeB,
    );
    expect(onlineAtA.envelope.did).toBe(a.viewer.did); // event 帧按设备定向（WP6 修订）
  }, 90_000);

  test('合流核对：40Hz 的 run.progress 到 viewer ≤10Hz，本机路径不受影响', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-5');

    let localReceived = 0;
    const off = core.services.events.on('run.progress', () => {
      localReceived += 1;
    });
    const fromIndex = viewer.inbox.length;

    const TOTAL = 40;
    const INTERVAL_MS = 25;
    const start = Date.now();
    for (let i = 0; i < TOTAL; i += 1) {
      core.services.events.emit('run.progress', {
        runId: 'wp6-run-1',
        conversationId: null,
        text: `step-${i}`,
      });
      await sleep(INTERVAL_MS);
    }
    const elapsedMs = Date.now() - start;
    await sleep(300); // 等最后一次合流冲刷
    off();

    const progressTexts: Array<string | undefined> = [];
    for (const entry of viewer.inbox.slice(fromIndex)) {
      if (entry.envelope.type !== 'event' || entry.envelope.ct === undefined) continue;
      const payload = (await viewer.openPayload(entry)) as {
        name: string;
        payload: { text?: string };
      };
      if (payload.name === 'run.progress') progressTexts.push(payload.payload.text);
    }
    // 合流上限：每 100ms 至多冲刷一帧（保留最新）
    const expectedMax = Math.ceil(elapsedMs / 100) + 2;
    expect(progressTexts.length).toBeGreaterThan(1);
    expect(progressTexts.length).toBeLessThanOrEqual(expectedMax);
    expect(progressTexts.at(-1)).toBe(`step-${TOTAL - 1}`);
    // 本机路径（事件总线直连）零丢失：UI 无感
    expect(localReceived).toBe(TOTAL);
  }, 60_000);

  test('穿透：重放帧被拒（不执行、不断连）', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-6');
    await viewer.call('system.ping');
    const sentRequest = viewer.outbox.find((raw) => raw.includes('"type":"rpc"'));
    expect(sentRequest).toBeDefined();

    const inboxBefore = viewer.inbox.length;
    viewer.sendRaw(sentRequest!);
    await sleep(1_000);
    // 重放被丢弃：没有新响应帧；连接未被断（原样重发合法请求仍通）
    const newRpcFrames = viewer.inbox
      .slice(inboxBefore)
      .filter((entry) => entry.envelope.type === 'rpc' && entry.envelope.did === viewer.did);
    expect(newRpcFrames).toHaveLength(0);
    expect(await viewer.call('system.ping')).toBeDefined();
  }, 60_000);

  test('穿透：超大帧（>512KB）被中转拒绝并断开', async () => {
    const { sessionId } = await createOffer(core);
    const viewer = await connectViewerWithRetry(sessionId);
    viewer.sendRaw(JSON.stringify({ v: 1, sid: sessionId }) + 'x'.repeat(600 * 1024));
    const error = await viewer.waitFor((entry) => entry.envelope.type === 'error', 8_000);
    expect((error.envelope.info as { kind: string }).kind).toBe('bad_frame');
    const closed = await viewer.waitForClose();
    expect(closed.code).toBe(1009);
  }, 30_000);

  test('穿透：错误协议版本被中转拒绝并断开', async () => {
    const { sessionId } = await createOffer(core);
    const viewer = await connectViewerWithRetry(sessionId);
    viewer.sendRaw(JSON.stringify({ v: 99, sid: sessionId, type: 'ping', n: 0 }));
    const error = await viewer.waitFor((entry) => entry.envelope.type === 'error', 8_000);
    expect((error.envelope.info as { kind: string }).kind).toBe('bad_frame');
    const closed = await viewer.waitForClose();
    expect(closed.code).toBe(1008);
  }, 30_000);

  test('穿透：未配对 join——错密钥 hello 被忽略、坏配对码被拒、无 anchor 会话静默', async () => {
    const { sessionId } = await createOffer(core);

    // (a) 错误密钥的 hello：anchor 无从解密，忽略且不断连
    const stranger = await connectViewerWithRetry(sessionId);
    const junkKeys = deriveSessionKeys({
      pskMode: 'psk',
      pairingCode: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      transcriptHash: transcriptHash(['junk']),
      sharedSecret: null,
    });
    stranger.codec = new FrameCodec(junkKeys, sessionId, 'viewer');
    stranger.sendSealed('hello', { token: 'junk', ts: Date.now() });
    await sleep(1_500);
    expect(stranger.closed).toHaveLength(0);
    expect(await deviceOf(core, stranger.did)).toBeUndefined();

    // (b) 配对码 HMAC 错：明文 reject（bad_code）
    const badCode = await connectViewerWithRetry(sessionId);
    badCode.sendRaw(
      JSON.stringify({
        v: 1,
        sid: sessionId,
        type: 'pairing',
        did: stranger.did,
        n: 0,
        data: {
          kind: 'request',
          deviceId: stranger.did,
          deviceName: 'attacker',
          userAgent: 'wp6-attacker',
          epub: '',
          pskMode: 'psk',
          auth: 'AAAAAA',
        },
      }),
    );
    const reject = await badCode.waitFor(
      (entry) =>
        entry.envelope.type === 'pairing' &&
        (entry.envelope.data as { kind?: string } | undefined)?.kind === 'reject',
      8_000,
    );
    expect((reject.envelope.data as { reason: string }).reason).toBe('bad_code');

    // (c) 无 anchor 的会话：viewer 可 join，帧无处转发，静默（不报错不断连）
    const ghostSid = randomSessionId();
    const ghost = await connectViewerWithRetry(ghostSid);
    ghost.sendRaw(
      JSON.stringify({
        v: 1,
        sid: ghostSid,
        type: 'rpc',
        did: 'someone-else-aaaaaaaaaa',
        n: 0,
      }),
    );
    await sleep(800);
    expect(ghost.closed).toHaveLength(0);
    expect(ghost.inbox).toHaveLength(0);
  }, 45_000);

  test('穿透：viewer 超限（第 6 个 join 握手被 429 拒绝）', async () => {
    const { sessionId } = await createOffer(core);
    for (let i = 0; i < 5; i += 1) {
      await connectViewerWithRetry(sessionId);
    }
    const status = await upgradeStatusCode(`${HTTP_BASE}/ws/${sessionId}?role=viewer`);
    expect(status).toBe(429);
  }, 45_000);

  test('穿透：限流触发（突发超 60 帧 → ratelimit kick + 断开）', async () => {
    const { sessionId } = await createOffer(core);
    const viewer = await connectViewerWithRetry(sessionId);
    for (let i = 0; i < 70; i += 1) {
      viewer.sendRaw(JSON.stringify({ v: 1, sid: sessionId, type: 'ping', n: 0 }));
    }
    const kick = await viewer.waitFor((entry) => entry.envelope.type === 'kick', 8_000);
    expect((kick.envelope.info as { kind: string }).kind).toBe('ratelimit');
    const closed = await viewer.waitForClose();
    expect(closed.code).toBe(1008);
  }, 30_000);

  test('撤销生效：kick 到达、连接关闭、重连自举被拒', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer, token } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-7');
    await viewer.call('system.ping');

    await core.rpc.call('remote.revokeDevice', { deviceId: viewer.did });

    // 密文 kick（reason revoked）+ DO 关闭连接
    const kickEntry = await viewer.waitFor((entry) => entry.envelope.type === 'kick', 8_000);
    const kick = (await viewer.openPayload(kickEntry)) as { reason: string };
    expect(kick.reason).toBe('revoked');
    const closed = await viewer.waitForClose();
    expect(closed.reason).toBe('kicked');
    await waitFor(
      async () => ((await deviceOf(core, viewer.did))?.revokedAt !== null ? true : undefined),
      10_000,
    );

    // 撤销后的重连：anchor 忽略其密文帧（密钥已清），设备保持离线
    await viewer.reconnectWithHello(sessionId, token);
    const fromIndex = viewer.inbox.length;
    viewer.sendSealed('rpc', { t: 'q', m: 'system.ping', a: [], i: 'after-revoke' });
    await sleep(1_500);
    expect(
      viewer.inbox
        .slice(fromIndex)
        .some((entry) => entry.envelope.type === 'rpc' && entry.envelope.did === viewer.did),
    ).toBe(false);
    expect((await deviceOf(core, viewer.did))?.online).toBe(false);
  }, 60_000);

  test('中转重启：anchor 退避重连、viewer 重自举', async () => {
    const { sessionId, secret } = await createOffer(core);
    const { viewer, token } = await pairFakeViewer(core, sessionId, secret, 'wp6-phone-8');
    await viewer.call('system.ping');

    await stopWrangler();
    await waitFor(async () => {
      const status = (await core.rpc.call('remote.status')) as { anchor: string };
      return status.anchor === 'online' ? undefined : true;
    }, 20_000);

    wrangler = startWrangler();
    await waitForHealthz(120_000);
    // anchor 退避重连（1s→2s→4s…），workerd 冷启动也要几秒
    await waitFor(async () => {
      const status = (await core.rpc.call('remote.status')) as { anchor: string };
      return status.anchor === 'online' ? true : undefined;
    }, 60_000);

    await viewer.reconnectWithHello(sessionId, token);
    expect(await viewer.call('system.ping')).toBeDefined();
  }, 240_000);

  test('真实 web 构建：PWA 完成配对 → 远程 RPC 执行 → 撤销 → kicked', async () => {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (error) =>
        consoleErrors.push(`pageerror: ${error.message}\n${error.stack ?? ''}`),
      );
      const offer = await createOffer(core);
      await page.goto(offer.url);

      // 配对门：链接已解析 → 确认设备名
      await page.getByTestId('web-gate-enter-name').waitFor({ timeout: 15_000 });
      await page.getByTestId('web-device-name').fill('wp6-real-phone');
      await page.getByTestId('web-pair-confirm').click();

      // 桌面侧确认（等价确认卡「允许」）
      const requestId = await waitFor(async () => {
        const status = (await core.rpc.call('remote.status')) as {
          pendingPairing: Array<{ requestId: string; deviceId: string; deviceName: string }>;
        };
        return status.pendingPairing.find((request) => request.deviceName === 'wp6-real-phone')
          ?.requestId;
      }, 20_000);
      const confirmed = (await core.rpc.call('remote.confirmPairing', {
        requestId,
        accept: true,
      })) as { status: string };
      expect(confirmed.status).toBe('paired');

      // web 构建经真实 WsTransport（WebCrypto）自举并渲染 App UI
      await page
        .getByTestId('app-shell')
        .waitFor({ timeout: 30_000 })
        .catch(async (error) => {
          const gateView = await page
            .locator('[data-testid^="web-gate"]')
            .first()
            .getAttribute('data-testid')
            .catch(() => '(页面无 gate 元素)');
          throw new Error(
            `app-shell 未出现（gate: ${gateView}）\n控制台错误:\n${consoleErrors.slice(0, 10).join('\n') || '(无)'}\n${String(error)}`,
          );
        });
      const browserDid = await page.evaluate(() =>
        localStorage.getItem('kepcup.remote.deviceId.v1'),
      );
      expect(browserDid).toBeTruthy();
      expect((await deviceOf(core, browserDid!))?.online).toBe(true);

      // web UI 启动 RPC（system.info，best-effort）真的在 core 上执行，审计来源为 remote:{did}
      await waitFor(
        async () =>
          remoteCalls.some(
            (call) => call.method === 'system.info' && call.source === `remote:${browserDid}`,
          )
            ? true
            : undefined,
        15_000,
      );

      // 撤销 → 页面回 kicked 态
      await core.rpc.call('remote.revokeDevice', { deviceId: browserDid });
      await page.getByTestId('web-gate-kicked').waitFor({ timeout: 15_000 });
    } finally {
      await browser.close();
    }
  }, 120_000);
});

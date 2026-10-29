import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import WebSocket from 'ws';
import { RELAY_PROTOCOL_VERSION, type PairingOffer, type RelayEnvelope } from '@kepcup/shared';
import {
  createFileKeystore,
  createMemoryKeystore,
  FrameCodec,
  withRemoteSource,
} from '@kepcup/core';
import { createHeadlessServer, type HeadlessServer } from '../src/server.js';
import { createAdminClient } from '../src/admin.js';
import { buildPluginFixture } from '../../../packages/testkit/src/plugin-fixture.js';
import type { ServerConfig } from '../src/config.js';

/**
 * 全链路集成（D102 §5）：临时数据目录 + memory keystore 起完整服务端，脚本化
 * viewer（core 的 FrameCodec —— 与真实 viewer 同一套 E2E 编解码）走 配对（经
 * 既有测试缝注入请求）→ confirm 出帧 → hello 自举 → RPC(system.ping) → 事件
 * 扇出 → 断线重连。配对握手本身的密码学是 D96 既有测试面；这里钉的是 headless
 * 新增面：直连监听 + hub alwaysOn + 装配。
 */

const DEVICE_ID = 'integration-viewer-01';

function testConfig(dataDir: string): ServerConfig {
  return {
    command: 'run',
    host: '127.0.0.1',
    port: 0,
    dataDir,
    publicUrl: 'ws://127.0.0.1:0',
    publicUrlExplicit: false,
    relayUrl: null,
    auth: 'pairing',
    adminUser: null,
    adminPassword: null,
    keystore: 'file',
    webDir: null,
    pairingManual: true,
    autoPair: false,
    acceptRequestId: null,
    revokeDeviceId: null,
    json: false,
    pluginAction: null,
    pluginPath: null,
    pluginYes: false,
    pluginConfigFile: null,
    trustProxy: false,
  };
}

let server: HeadlessServer;
let dataDir: string;
let relayUrl: string;
let sessionId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'kepcup-server-it-'));
  server = await createHeadlessServer(testConfig(dataDir), {
    env: { ...process.env, NODE_ENV: 'test' },
    keystore: createMemoryKeystore(),
  });
  relayUrl = server.config.publicUrl;
  sessionId = server.services.remote?.status().sessionId ?? '';
  expect(sessionId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});

afterAll(async () => {
  await server.close();
});

function parseOffer(offer: PairingOffer): { relayUrl: string; sid: string } {
  const hash = offer.url.split('#pair=')[1] ?? '';
  const [encodedRelay, sid] = hash.split(',');
  expect(sid).toBeDefined();
  return { relayUrl: decodeURIComponent(encodedRelay), sid };
}

class ViewerConnection {
  readonly ws: WebSocket;
  readonly inbox: RelayEnvelope[] = [];
  #codec: FrameCodec | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      this.inbox.push(JSON.parse(String(data)) as RelayEnvelope);
    });
  }

  async open(): Promise<this> {
    await once(this.ws, 'open');
    return this;
  }

  async next(
    predicate: (frame: RelayEnvelope) => boolean,
    timeoutMs = 5000,
  ): Promise<RelayEnvelope> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(predicate);
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (Date.now() > deadline) throw new Error(`等待帧超时：${this.inbox.length} 帧积压`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * 按解密后的 payload 匹配下一帧（按到达序解密，计数器单调）。初始状态快照
   * 走 rpc 帧（birpc 推送 `q.m`），总线事件走 event 帧（`.name`）——两种都认。
   */
  async nextOpened(match: (payload: unknown) => boolean, timeoutMs = 5000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex(
        (frame) => frame.ct !== undefined && frame.did === DEVICE_ID,
      );
      if (index >= 0) {
        const frame = this.inbox.splice(index, 1)[0];
        const payload = this.codec.open(frame).payload;
        if (match(payload)) return payload;
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`等待帧超时：${this.inbox.length} 帧积压`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** 等某个名字到达（快照 rpc 推送或事件帧皆可）。 */
  awaitName(name: string): Promise<unknown> {
    return this.nextOpened((payload) => {
      const record = payload as { name?: string; m?: string };
      return record.name === name || record.m === name;
    });
  }

  send(frame: RelayEnvelope): void {
    this.ws.send(JSON.stringify(frame));
  }

  setCodec(codec: FrameCodec): void {
    this.#codec = codec;
  }

  get codec(): FrameCodec {
    if (this.#codec === null) throw new Error('codec 未设置');
    return this.#codec;
  }
}

function viewerUrl(sid: string): string {
  return `${relayUrl}/ws/${sid}?role=viewer`;
}

it('服务端起来后：远程已启用、anchor 常驻 online（alwaysOn）', () => {
  const hub = server.services.remote;
  expect(hub).not.toBeNull();
  const status = hub?.status();
  expect(status?.enabled).toBe(true);
  expect(status?.anchor).toBe('online');
});

it('配对 → confirm 出帧 → hello 自举 → system.ping → 断线重连', async () => {
  const hub = server.services.remote;
  if (hub === null) throw new Error('remote hub 缺失');

  // 1. 出码并解析（配对链接格式 = `<origin>/#pair=<relayUrl>,<sid>,<secret>`）。
  const offer = hub.createPairing();
  const parsed = parseOffer(offer);
  expect(parsed.relayUrl).toBe(relayUrl);
  expect(parsed.sid).toBe(sessionId);

  // 2. viewer 先连上并以带 did 的哑帧注册路由表（真实路径里配对请求即完成注册）。
  const viewer = await new ViewerConnection(viewerUrl(sessionId)).open();
  viewer.send({
    v: RELAY_PROTOCOL_VERSION,
    sid: sessionId,
    type: 'rpc',
    did: DEVICE_ID,
    n: 0,
    ct: 'AAEC',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 3. 经测试缝注入配对请求（密码学握手是 D96 既有测试面）并人工确认。
  const { requestId } = hub.pairing.testInjectPairingRequest({
    deviceId: DEVICE_ID,
    deviceName: 'Integration Viewer',
    userAgent: 'vitest',
  });
  const outcome = hub.confirmPairing(requestId, true);
  expect(outcome.status).toBe('paired');

  // 4. accept（明文）与 done（密文）都应路由到 viewer。
  const accept = await viewer.next((frame) => frame.type === 'pairing');
  expect((accept.data as { kind?: string }).kind).toBe('accept');
  const done = await viewer.next((frame) => frame.type === 'pairing' && frame.ct !== undefined);

  // 5. anchor 侧存的会话密钥 → viewer codec（同构编解码，方向互补）。done 帧与
  //    hello 后的帧流是两个独立计数空间（真实 viewer 在 done 后清计数器再自举）：
  //    用临时 codec 解 done，随后换新 codec 发 hello。
  const keys = hub.pairing.deviceKeys(DEVICE_ID);
  expect(keys).not.toBeNull();
  const bootCodec = new FrameCodec(keys!, sessionId, 'viewer');
  const donePayload = bootCodec.open(done).payload as { token: string; keyFingerprint: string };
  expect(donePayload.token).toMatch(/^[A-Za-z0-9_-]+$/);
  const codec = new FrameCodec(keys!, sessionId, 'viewer');
  viewer.setCodec(codec);

  // 6. hello 自举 → 状态快照事件应先于任何 RPC 响应到达。
  for (const frame of codec.seal(
    'hello',
    { token: donePayload.token, ts: Date.now() },
    { did: DEVICE_ID },
  )) {
    viewer.send(frame);
  }
  await viewer.awaitName('core.status');
  expect(hub.status().onlineDeviceIds).toContain(DEVICE_ID);

  // 7. RPC：system.ping 走完整 birpc 通道。
  const rid = 'it-ping-1';
  for (const frame of codec.seal(
    'rpc',
    { t: 'q', m: 'system.ping', a: [], i: rid },
    { did: DEVICE_ID, rid },
  )) {
    viewer.send(frame);
  }
  const response = await viewer.next(
    (frame) => frame.type === 'rpc' && frame.rid === rid && frame.did === DEVICE_ID,
  );
  const rpcPayload = codec.open(response).payload as { t: string; i: string };
  expect(rpcPayload.t).toBe('s');
  expect(rpcPayload.i).toBe(rid);

  // 8. 断线重连：续号 hello，端点重建，快照重推。
  viewer.ws.close(1000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const outbound = codec.outboundCounter;
  const reconnected = await new ViewerConnection(viewerUrl(sessionId)).open();
  const codec2 = new FrameCodec(keys!, sessionId, 'viewer');
  codec2.restoreOutbound(outbound);
  reconnected.setCodec(codec2);
  for (const frame of codec2.seal(
    'hello',
    { token: donePayload.token, ts: Date.now() },
    { did: DEVICE_ID },
  )) {
    reconnected.send(frame);
  }
  await reconnected.awaitName('core.status');
  expect(hub.status().onlineDeviceIds).toContain(DEVICE_ID);

  // 9. 设备已登记。
  expect(hub.devices().devices.map((device) => device.deviceId)).toContain(DEVICE_ID);
  reconnected.ws.close(1000);
  await new Promise((resolve) => setTimeout(resolve, 100));
});

it('admin 接口：环回 + Bearer token', async () => {
  const token = readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  const call = (headers: Record<string, string>): Promise<{ code: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/admin/status', headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

  const denied = await call({});
  expect(denied.code).toBe(401);
  const ok = await call({ authorization: `Bearer ${token}` });
  expect(ok.code).toBe(200);
  const body = JSON.parse(ok.body) as { remote: { enabled: boolean } };
  expect(body.remote.enabled).toBe(true);
});

it('admin 插件安装：inspect → install → plugins.list；远程来源仍被拒', async () => {
  const token = readFileSync(path.join(dataDir, 'admin-token'), 'utf8').trim();
  const client = createAdminClient(server.port, token);
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'kepcup-server-plugin-'));
  try {
    const fixture = await buildPluginFixture({
      dir: fixtureDir,
      skills: [
        { name: 'admin-installed-skill', description: 'Installed through the admin endpoint' },
      ],
    });
    const source = { kind: 'file' as const, path: fixture.path };
    const info = (await client.pluginsInspect({ source })) as {
      id: string;
      packageSha256: string;
      installable: boolean;
    };
    expect(info.id).toBe('io.github.tester/fixture');
    expect(info.packageSha256).toBe(fixture.sha256);
    expect(info.installable).toBe(true);

    const installed = (await client.pluginsInstall({
      source,
      sha256: info.packageSha256,
      userConfig: {},
    })) as { plugin: { id: string } };
    expect(installed.plugin.id).toBe('io.github.tester/fixture');

    const listed = (await server.services.appMethods['plugins.list']!.handle(undefined)) as {
      plugins: Array<{ id: string }>;
    };
    expect(listed.plugins.map((plugin) => plugin.id)).toContain('io.github.tester/fixture');

    // 远程端点（RemoteHub 用 withRemoteSource 包裹每个 handle）：同一 file 来源仍被拒。
    const inspect = server.services.appMethods['plugins.inspect']!;
    await expect(
      withRemoteSource('dev_integration' as never, () => inspect.handle({ source })),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    // JSON 合法但不符合方法 schema 的请求体是调用方的错：400 + INVALID_INPUT，不是 500。
    await expect(client.pluginsInspect({ source: { kind: 'url', path: 'x' } })).rejects.toThrow(
      /HTTP 400.*INVALID_INPUT/s,
    );
    await expect(client.pluginsInstall({})).rejects.toThrow(/HTTP 400.*INVALID_INPUT/s);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

describe('启动路径回归（独立子代理审查修复：P0 二次启动 / P1 --relay 劫持）', () => {
  it('pairing 直连模式：同一数据目录二次启动不崩、anchor 恢复 online', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-reboot-'));
    const config = { ...testConfig(dir), pairingManual: false, autoPair: false };
    const rebootKeystore = () => createFileKeystore(path.join(dir, 'master-key'));
    const first = await createHeadlessServer(config, {
      env: { ...process.env, NODE_ENV: 'test' },
      keystore: rebootKeystore(),
    });
    // 首启把 remoteEnabled=true 落库；显式 syncConfig 后 anchor online。
    expect(first.services.remote?.status().anchor).toBe('online');
    await first.close();

    // 二次启动：hub.start() 在 directRelay 赋值前调工厂——修复前是
    // unhandledRejection 崩进程；修复后 warn 兜底 + 显式 syncConfig 补建。
    const second = await createHeadlessServer(config, {
      env: { ...process.env, NODE_ENV: 'test' },
      keystore: rebootKeystore(),
    });
    expect(second.services.remote?.status().enabled).toBe(true);
    expect(second.services.remote?.status().anchor).toBe('online');
    expect(second.directRelay).not.toBeNull();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('--relay 中转模式：不建本地直连监听，/ws 升级 404，remoteRelayUrl 指向中转', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-relaymode-'));
    // 死端口当假中转：RelayClient 外连失败进退避重试，但绝不崩、绝不建本地监听。
    const config = {
      ...testConfig(dir),
      relayUrl: 'ws://127.0.0.1:1',
      publicUrl: 'ws://127.0.0.1:1',
      publicUrlExplicit: true,
    };
    const server = await createHeadlessServer(config, {
      env: { ...process.env, NODE_ENV: 'test' },
      keystore: createMemoryKeystore(),
    });
    expect(server.directRelay).toBeNull();
    expect(server.services.remote?.status().enabled).toBe(true);
    expect(server.services.remote?.status().relayUrl).toBe('ws://127.0.0.1:1');
    // 本地不提供 /ws 升级（anchor 应当外连中转，而不是劫持成直连）。
    const probe = new WebSocket(
      `ws://127.0.0.1:${server.port}/ws/${server.services.remote?.status().sessionId ?? 'x'}?role=viewer`,
    );
    const outcome = await new Promise<number | 'open'>((resolve) => {
      probe.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      probe.on('error', () => {
        // error 后必有 close（运行时差异），由 close 兜底。
      });
      probe.on('open', () => resolve('open'));
      probe.on('close', () => resolve(404));
    });
    expect(outcome).not.toBe('open');
    probe.terminate();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

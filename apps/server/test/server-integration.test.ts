import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { expect, it, afterAll, beforeAll } from 'vitest';
import WebSocket from 'ws';
import {
  RELAY_PROTOCOL_VERSION,
  type PairingOffer,
  type RelayEnvelope,
} from '@kepcup/shared';
import { createMemoryKeystore, FrameCodec } from '@kepcup/core';
import { createHeadlessServer, type HeadlessServer } from '../src/server.js';
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

  async next(predicate: (frame: RelayEnvelope) => boolean, timeoutMs = 5000): Promise<RelayEnvelope> {
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
  for (const frame of codec.seal('hello', { token: donePayload.token, ts: Date.now() }, { did: DEVICE_ID })) {
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

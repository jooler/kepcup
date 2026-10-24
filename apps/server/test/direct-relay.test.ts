import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';
import WebSocket from 'ws';
import {
  RELAY_PROTOCOL_VERSION,
  type RelayEnvelope,
} from '@kepcup/shared';
import { DirectRelayServer } from '../src/direct-relay.js';
import type { CoreLogger } from '@kepcup/core';

/**
 * 直连监听层单测（D102 §3.2）：真 ws socket 对打，钉住与中转 Worker 对齐的
 * 最低行为集——升级校验 / did 路由 / pong / viewer_left / replaced / dormant。
 */

const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => fakeLogger,
} as unknown as CoreLogger;
const clock = { now: () => 0 };

const servers: Array<{ http: Server; relay: DirectRelayServer }> = [];

afterEach(async () => {
  for (const { http, relay } of servers.splice(0)) {
    relay.close();
    http.close();
    http.closeAllConnections?.();
    await once(http, 'close').catch(() => {});
  }
});

async function makeRelay(): Promise<{
  port: number;
  relay: DirectRelayServer;
  frames: RelayEnvelope[];
}> {
  const http = createServer();
  const relay = new DirectRelayServer({ httpServer: http, logger: fakeLogger, clock });
  const frames: RelayEnvelope[] = [];
  http.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  servers.push({ http, relay });
  return {
    port: (http.address() as AddressInfo).port,
    relay,
    frames,
  };
}

function adapterFor(
  relay: DirectRelayServer,
  port: number,
  frames: RelayEnvelope[],
): ReturnType<DirectRelayServer['createAdapter']> {
  return relay.createAdapter({
    relayUrl: `ws://127.0.0.1:${port}`,
    sessionId: SID,
    clock,
    logger: fakeLogger,
    onStateChange: () => {},
    onFrame: (envelope) => frames.push(envelope),
  });
}

async function connectViewer(port: number, sid = SID, role = 'viewer'): Promise<FrameSink> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${sid}?role=${role}`);
  // 监听器必须在 open 前挂好：服务端可能在升级回调里立刻发帧（dormant 场景），
  // 晚挂的 message 监听会丢掉已到达的帧。
  const sink = new FrameSink(ws);
  await once(ws, 'open');
  return sink;
}

/** did 必须满足 remoteDeviceIdSchema（16-64 位 [A-Za-z0-9_-]）。 */
const DID_A = 'unit-viewer-aaaaaaaa';

class FrameSink {
  readonly frames: RelayEnvelope[] = [];
  #ws: WebSocket;

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (data) => {
      this.frames.push(JSON.parse(String(data)) as RelayEnvelope);
    });
  }

  get ws(): WebSocket {
    return this.#ws;
  }

  async next(timeoutMs = 2000): Promise<RelayEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length === 0) {
      if (Date.now() > deadline) throw new Error('等待帧超时');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return this.frames.shift() as RelayEnvelope;
  }

  send(envelope: RelayEnvelope): void {
    this.#ws.send(JSON.stringify(envelope));
  }
}

function envelope(partial: Partial<RelayEnvelope>): RelayEnvelope {
  return { v: RELAY_PROTOCOL_VERSION, sid: SID, type: 'rpc', n: 0, ...partial } as RelayEnvelope;
}

/** close 事件可能在监听器挂上前已发出（服务端同 tick 发帧+关连接）：兜底轮询。 */
async function closed(ws: WebSocket, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ws.readyState !== WebSocket.CLOSED) {
    if (Date.now() > deadline) throw new Error('等待关闭超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('DirectRelayServer 升级校验', () => {
  it('拒绝 role=anchor（anchor 在本进程）', async () => {
    const { port } = await makeRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${SID}?role=anchor`);
    const [failure] = await once(ws, 'error');
    expect(String((failure as Error).message)).toContain('403');
    ws.terminate?.();
  });

  it('拒绝形状不合法的 sid', async () => {
    const { port } = await makeRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/not-a-ulid?role=viewer`);
    const [failure] = await once(ws, 'error');
    expect(String((failure as Error).message)).toContain('404');
  });

  it('拒绝跨源升级（CSWSH）', async () => {
    const { port } = await makeRelay();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${SID}?role=viewer`, {
      headers: { origin: 'https://evil.example' },
    });
    const [failure] = await once(ws, 'error');
    expect(String((failure as Error).message)).toContain('403');
  });

  it('dormant（无 anchor 会话）时收 anchor_offline 后断开', async () => {
    const { port, frames } = await makeRelay();
    const sink = await connectViewer(port);
    const frame = await sink.next();
    expect(frame.type).toBe('signal');
    expect(frame.info?.kind).toBe('anchor_offline');
    await closed(sink.ws);
    expect(frames).toHaveLength(0);
  });
});

describe('DirectRelayServer 活动会话', () => {
  it('ping 在监听层终结并回 pong（不到 anchor）', async () => {
    const { port, relay, frames } = await makeRelay();
    adapterFor(relay, port, frames).connect();
    const sink = await connectViewer(port);
    sink.send(envelope({ type: 'ping', n: 0, info: undefined }));
    const pong = await sink.next();
    expect(pong.type).toBe('pong');
    expect(pong.info?.kind).toBe('pong');
    expect(frames).toHaveLength(0);
  });

  it('带 did 的入站帧注册路由并转给 anchor；出站按 did 定向', async () => {
    const { port, relay, frames } = await makeRelay();
    const adapter = adapterFor(relay, port, frames);
    adapter.connect();
    const sink1 = await connectViewer(port);
    const sink2 = await connectViewer(port);
    sink1.send(envelope({ did: DID_A, ct: 'AAEC' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames).toHaveLength(1);
    expect(frames[0].did).toBe(DID_A);

    adapter.send(envelope({ did: DID_A, type: 'rpc', ct: 'AAEC' }));
    const got1 = await sink1.next();
    expect(got1.did).toBe(DID_A);
    // dev-2 未注册 did，sink2 不该收到定向帧。
    expect(sink2.frames).toHaveLength(0);
  });

  it('无 did 的出站帧广播到全部连接', async () => {
    const { port, relay, frames } = await makeRelay();
    const adapter = adapterFor(relay, port, frames);
    adapter.connect();
    const sink1 = await connectViewer(port);
    const sink2 = await connectViewer(port);
    adapter.send(envelope({ type: 'event', ct: 'AAEC' }));
    expect((await sink1.next()).type).toBe('event');
    expect((await sink2.next()).type).toBe('event');
  });

  it('同 did 新连接顶掉旧连接（replaced 信号）', async () => {
    const { port, relay, frames } = await makeRelay();
    const adapter = adapterFor(relay, port, frames);
    adapter.connect();
    const oldSink = await connectViewer(port);
    oldSink.send(envelope({ did: DID_A, ct: 'AAEC' }));
    const newSink = await connectViewer(port);
    newSink.send(envelope({ did: DID_A, ct: 'AAEC' }));
    const replaced = await oldSink.next();
    expect(replaced.type).toBe('signal');
    expect(replaced.info?.kind).toBe('replaced');
    await closed(oldSink.ws);
    // 新连接注册成功：定向帧只到新连接（复用已 connect 的同一 adapter）。
    adapter.send(envelope({ did: DID_A, type: 'rpc', ct: 'AAEC' }));
    expect((await newSink.next()).did).toBe(DID_A);
  });

  it('连接关闭合成 viewer_left（did 从路由表移除）', async () => {
    const { port, relay, frames } = await makeRelay();
    adapterFor(relay, port, frames).connect();
    const sink = await connectViewer(port);
    sink.send(envelope({ did: DID_A, ct: 'AAEC' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    frames.length = 0;
    sink.ws.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const signal = frames.find((frame) => frame.type === 'signal');
    expect(signal?.info?.kind).toBe('viewer_left');
    expect((signal?.info as { did?: string } | undefined)?.did).toBe(DID_A);
  });

  it('坏帧（非 JSON / 超 schema）回 bad_frame 并断开', async () => {
    const { port, relay, frames } = await makeRelay();
    adapterFor(relay, port, frames).connect();
    const sink = await connectViewer(port);
    sink.ws.send('this is not json');
    const error = await sink.next();
    expect(error.type).toBe('error');
    expect(error.info?.kind).toBe('bad_frame');
    await closed(sink.ws);
  });

  it('adapter.close 转 dormant：已有连接被断，新连接收 anchor_offline', async () => {
    const { port, relay, frames } = await makeRelay();
    const adapter = adapterFor(relay, port, frames);
    adapter.connect();
    const sink = await connectViewer(port);
    sink.send(envelope({ did: DID_A, ct: 'AAEC' }));
    adapter.close();
    await closed(sink.ws);
    const late = await connectViewer(port);
    const frame = await late.next();
    expect(frame.info?.kind).toBe('anchor_offline');
  });
});

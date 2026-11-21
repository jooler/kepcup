import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { RELAY_MAX_FRAME_BYTES } from '@kepcup/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TeamServerBridge,
  TeamSocketHttpError,
  openTeamSocket,
  type BridgeChannel,
  type BridgePortLike,
  type TeamConnectionStatus,
  type TeamSocket,
} from './team-bridge';

/**
 * T7 步骤 1（team-bridge.ts）：
 * - 编排层（TeamServerBridge）：注入 fake 端口 / socket / fetch + 假时钟——帧双向
 *   转发、Bearer 头、断开重连退避、whoami 401 → unauthenticated 不再重试、
 *   disconnect 关双侧 port、refreshPorts 换新端口对。
 * - 传输层（openTeamSocket 手写 RFC 6455 客户端）：对本地 http 服务器的真实握手
 *   （Authorization 头直达服务器）、文本帧回环、服务端 close、401 拒绝、ping→pong；
 *   以及协议违规拒收（Accept 校验、超限帧 1009、服务端掩码 / RSV 1002、二进制
 *   1003、分片重组与控制帧穿插、1 字节 close 载荷回空）。
 * 不起 Electron、不依赖 apps/team-server（hub 行为由其自身的测试覆盖；这里验证
 * 桥与之匹配的握手 / 帧语义）。
 */

// --- shared fakes ------------------------------------------------------------

class FakePort implements BridgePortLike {
  closed = false;
  readonly posted: unknown[] = [];
  readonly listeners: Array<(event: { data: unknown }) => void> = [];
  on(_event: 'message', listener: (event: { data: unknown }) => void): unknown {
    this.listeners.push(listener);
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
    for (const listener of [...this.listeners]) listener({ data });
  }
}

interface FakeSocket {
  sent: string[];
  closedWith: { code: number; reason: string } | null;
  handlers: {
    onText(text: string): void;
    onClose(code: number | null, reason: string): void;
  } | null;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  on(handlers: FakeSocket['handlers']): void;
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    closedWith: null,
    handlers: null,
    send(text) {
      socket.sent.push(text);
    },
    close(code = 1000, reason = '') {
      if (socket.closedWith !== null) return;
      socket.closedWith = { code, reason };
    },
    on(handlers) {
      socket.handlers = handlers;
    },
  };
  return socket;
}

/** 主进程侧把 socket 关掉并模拟「意外关闭」事件（服务端断线路径）。 */
function abruptClose(socket: FakeSocket, code = 1006, reason = ''): void {
  socket.handlers?.onClose(code, reason);
}

// ===========================================================================
// Part A · TeamServerBridge 编排（fake 时钟）
// ===========================================================================

describe('TeamServerBridge 编排', () => {
  interface BridgeFixture {
    bridge: TeamServerBridge;
    statuses: Array<[string, TeamConnectionStatus]>;
    postedPorts: Array<{ serverHash: string; port: FakePort }>;
    channels: Array<{ port1: FakePort; port2: FakePort }>;
    openLog: Array<{ url: string; headers: Record<string, string>; socket: FakeSocket }>;
    fetchMock: ReturnType<typeof vi.fn>;
  }

  function makeBridge(script: Array<'ok' | 'reject401' | 'fail'> = ['ok']): BridgeFixture {
    const statuses: Array<[string, TeamConnectionStatus]> = [];
    const postedPorts: BridgeFixture['postedPorts'] = [];
    const channels: BridgeFixture['channels'] = [];
    const openLog: BridgeFixture['openLog'] = [];
    let index = 0;
    const fetchMock = vi.fn(async () => ({ status: 200 }) as unknown as Response);
    const bridge = new TeamServerBridge(
      {
        createChannel: () => {
          const port1 = new FakePort();
          const port2 = new FakePort();
          channels.push({ port1, port2 });
          return { port1, port2 } as BridgeChannel;
        },
        postPort: (serverHash, port) => {
          postedPorts.push({ serverHash, port: port as FakePort });
        },
        openSocket: (url, headers) => {
          const socket = fakeSocket();
          openLog.push({ url, headers, socket });
          const step = script[Math.min(index, script.length - 1)] ?? 'ok';
          index += 1;
          if (step === 'reject401') return Promise.reject(new TeamSocketHttpError(401));
          if (step === 'fail') return Promise.reject(new Error('connect ECONNREFUSED'));
          return Promise.resolve(socket);
        },
        fetch: fetchMock as unknown as typeof fetch,
      },
      (serverHash, status) => {
        statuses.push([serverHash, status]);
      },
    );
    return { bridge, statuses, postedPorts, channels, openLog, fetchMock };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const HASH = 'a'.repeat(16);
  const URL_ = 'http://127.0.0.1:8643/';

  it('connect：开端口对发渲染层、Bearer 握手 {url}/rpc，状态 idle→connecting→connected', async () => {
    const f = makeBridge();
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    expect(f.statuses).toEqual([[HASH, 'connecting']]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.statuses.map(([, s]) => s)).toEqual(['connecting', 'connected']);
    expect(f.postedPorts).toHaveLength(1);
    expect(f.postedPorts[0]!.serverHash).toBe(HASH);
    expect(f.openLog).toHaveLength(1);
    expect(f.openLog[0]!.url).toBe('http://127.0.0.1:8643/rpc');
    expect(f.openLog[0]!.headers.authorization).toBe('Bearer tok-1');
  });

  it('帧双向转发：port1→ws 为 JSON 字符串，ws→port1 为解析后的对象；未 open 前排队', async () => {
    const socket = fakeSocket();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const port1 = new FakePort();
    const port2 = new FakePort();
    const bridge = new TeamServerBridge(
      {
        createChannel: () => ({ port1, port2 }) as BridgeChannel,
        postPort: () => {},
        openSocket: async () => {
          await gate;
          return socket;
        },
        fetch: (async () => ({ status: 200 })) as unknown as typeof fetch,
      },
      () => {},
    );
    bridge.connect(HASH, { url: URL_, token: 't' });
    // WS 尚未 open：渲染层发来的帧排队，不丢。
    port1.deliver({ id: 1, method: 'a.b' });
    port1.deliver({ id: 2, method: 'c.d' });
    expect(socket.sent).toEqual([]);
    releaseGate();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toEqual(['{"id":1,"method":"a.b"}', '{"id":2,"method":"c.d"}']);
    // 反向：ws 文本帧解析成对象投给 port1；非 JSON 忽略（member-hub 同款）。
    socket.handlers?.onText('{"id":1,"result":"ok"}');
    socket.handlers?.onText('not-json');
    expect(port1.posted).toEqual([{ id: 1, result: 'ok' }]);
  });

  it('意外断开 → error + 退避重试（whoami 200 → 重连）；静默重连不换 port', async () => {
    const f = makeBridge(['ok', 'ok']);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    const firstSocket = f.openLog[0]!.socket;
    abruptClose(firstSocket, 1006);
    expect(f.statuses.at(-1)?.[1]).toBe('error');
    // 退避 1s 后重试：先 whoami 探测（Bearer），200 → 重新握手。
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8643/api/auth/whoami');
    expect(
      (f.fetchMock.mock.calls[0]![1] as RequestInit | undefined)?.headers,
    ).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(f.openLog).toHaveLength(2);
    expect(f.statuses.at(-1)?.[1]).toBe('connected');
    // 渲染层 port 不重发（同一条 MessagePort 承载重连后的帧流）。
    expect(f.postedPorts).toHaveLength(1);
    // 帧继续走新 socket。
    f.channels[0]!.port1.deliver({ hello: 1 });
    expect(f.openLog[1]!.socket.sent).toEqual(['{"hello":1}']);
  });

  it('重试前 whoami 401 → unauthenticated，不再自动重试', async () => {
    const f = makeBridge(['ok']);
    f.fetchMock.mockResolvedValue({ status: 401 } as unknown as Response);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    abruptClose(f.openLog[0]!.socket, 1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.statuses.at(-1)?.[1]).toBe('unauthenticated');
    // 长时间推进也不再有握手 / 探测。
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.openLog).toHaveLength(1);
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('首次握手 401 → unauthenticated（token 失效终态，不重试）', async () => {
    const f = makeBridge(['reject401']);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.statuses.map(([, s]) => s)).toEqual(['connecting', 'unauthenticated']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.openLog).toHaveLength(1);
  });

  it('网络失败 → error 指数退避（1s、2s）后恢复', async () => {
    const f = makeBridge(['fail', 'fail', 'ok']);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.statuses.at(-1)?.[1]).toBe('error');
    await vi.advanceTimersByTimeAsync(999);
    expect(f.openLog).toHaveLength(1); // 1s 未到不重试
    await vi.advanceTimersByTimeAsync(1);
    expect(f.openLog).toHaveLength(2); // 第一次重试（又失败）
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.openLog).toHaveLength(2); // 退避翻倍为 2s，1s 处仍未重试
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.openLog).toHaveLength(3); // 2s 处重试成功
    expect(f.statuses.at(-1)?.[1]).toBe('connected');
  });

  it('disconnect：关 WS、关 port1、状态收口；不再重试', async () => {
    const f = makeBridge(['ok', 'ok']);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    f.bridge.disconnect(HASH);
    const socket = f.openLog[0]!.socket;
    expect(socket.closedWith?.code).toBe(1000);
    expect(f.channels[0]!.port1.closed).toBe(true);
    // 断开后 socket 侧再收到 close 事件也不复活。
    abruptClose(socket, 1006);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.openLog).toHaveLength(1);
    expect(f.bridge.has(HASH)).toBe(false);
  });

  it('refreshPorts：为活连接换新端口对并重发（页面重载补发语义）', async () => {
    const f = makeBridge(['ok']);
    f.bridge.connect(HASH, { url: URL_, token: 'tok-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.postedPorts).toHaveLength(1);
    const oldPort1 = f.channels[0]!.port1;
    f.bridge.refreshPorts();
    expect(oldPort1.closed).toBe(true);
    expect(f.postedPorts).toHaveLength(2);
    // 新 port1 承接帧转发。
    f.channels[1]!.port1.deliver({ again: true });
    expect(f.openLog[0]!.socket.sent).toEqual(['{"again":true}']);
  });
});

// ===========================================================================
// Part B · openTeamSocket（手写 RFC 6455 客户端，对本地真实服务器）
// ===========================================================================

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type ServerMode = 'echo' | 'reject401' | 'close1000' | 'ping' | 'raw' | 'badaccept';

interface TestServer {
  server: Server;
  port: number;
  /** 最近一次 upgrade 请求头（握手断言）。 */
  lastHeaders: Record<string, string | string[] | undefined>;
  lastPath: string;
  /** 服务端收到的控制帧（pong 记录于此）。 */
  controlFrames: Array<{ opcode: number; payload: string }>;
  /** 服务端收到的客户端 close 帧（payload 长度 + code；close 握手断言）。 */
  closeFrames: Array<{ payloadLength: number; code: number | null }>;
  /** 主动向客户端发一帧（close / ping）。 */
  sendFrame(opcode: number, payload: Buffer): void;
  sockets: Duplex[];
  close(): Promise<void>;
}

function startWsServer(mode: ServerMode): Promise<TestServer> {
  const lastHeaders: TestServer['lastHeaders'] = {};
  const controlFrames: TestServer['controlFrames'] = [];
  const closeFrames: TestServer['closeFrames'] = [];
  const sockets: TestServer['sockets'] = [];
  let lastPath = '';
  const server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    Object.assign(lastHeaders, req.headers);
    lastPath = req.url ?? '';
    if (mode === 'reject401') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = String(req.headers['sec-websocket-key'] ?? '');
    // badaccept：故意算错 Accept（客户端必须拒绝握手，RFC 6455 §4.2.1 客户端校验）。
    const acceptSource = mode === 'badaccept' ? 'wrong-key-material' : key + WS_GUID;
    const accept = createHash('sha1').update(acceptSource).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.push(socket);
    // 客户端断开后对端可能仍 write（destroyed stream）——吞掉写错误，测试进程不炸。
    socket.on('error', () => {});
    let buffer = Buffer.from(head);
    let serverCloseSent = mode === 'close1000'; // 该模式在 101 后即已发 close
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      // 解析客户端帧（必掩码）；此处只处理小帧（<126）与 16 位长度。
      for (;;) {
        const parsed = parseClientFrame(buffer);
        if (parsed === null) break;
        buffer = parsed.rest;
        const { opcode, payload } = parsed;
        if (opcode === 0x1) {
          if (mode === 'echo') writeServerFrame(socket, 0x1, payload); // echo
        } else if (opcode === 0x8) {
          // 客户端 close 帧：记录载荷长度与 code（close 握手断言）。
          closeFrames.push({
            payloadLength: payload.length,
            code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
          });
          // 已 end 的 socket 再 write 会抛（ERR_STREAM_WRITE_AFTER_END）——只回一次。
          if (mode === 'echo' && !serverCloseSent) {
            serverCloseSent = true;
            writeServerFrame(socket, 0x8, payload.subarray(0, 2));
            socket.end();
          }
        } else {
          controlFrames.push({ opcode, payload: payload.toString('utf8') });
        }
      }
    });
    if (mode === 'close1000') {
      writeServerFrame(socket, 0x8, Buffer.from([0x03, 0xe8]));
      socket.end();
    }
    if (mode === 'ping') {
      writeServerFrame(socket, 0x9, Buffer.from('hb'));
    }
  });
  const handle: TestServer = {
    server,
    port: 0,
    lastHeaders,
    get lastPath() {
      return lastPath;
    },
    controlFrames,
    closeFrames,
    sendFrame(opcode, payload) {
      for (const socket of sockets) writeServerFrame(socket, opcode, payload);
    },
    sockets,
    close() {
      return new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      handle.port = (server.address() as AddressInfo).port;
      resolve(handle);
    });
  });
}

/** raw 服务器上最近建立的连接（违规注入目标——每用例开新连接防串扰）。 */
function lastSocket(server: TestServer): Duplex {
  const socket = server.sockets[server.sockets.length - 1];
  if (socket === undefined) throw new Error('no upgraded socket yet');
  return socket;
}

/** 服务端→客户端帧（不掩码）。 */
function writeServerFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/** 客户端→服务端帧解析（掩码解除）；数据不足返回 null。 */
function parseClientFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (!masked) return null; // 客户端帧必须掩码
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    return null; // 测试载荷不会这么大
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + 4 + i]! ^ mask[i & 3]!;
  return { opcode, payload, rest: buffer.subarray(offset + 4 + length) };
}

/**
 * 手工客户端帧工具（服务端视角的协议违规注入）：可伪造 RSV / 掩码位 / 64 位
 * 长度 / 分片——writeServerFrame 只会写「合法的」服务端帧，违规帧走这里。
 */
function writeRawFrame(
  socket: Duplex,
  options: {
    opcode: number;
    fin?: boolean;
    rsv?: number;
    masked?: boolean;
    payload?: Buffer;
    /** 覆盖长度字段（伪造超限声明；payload 照发）。 */
    lengthOverride?: number;
  },
): void {
  const fin = options.fin ?? true;
  const rsv = options.rsv ?? 0;
  const masked = options.masked ?? false;
  const payload = options.payload ?? Buffer.alloc(0);
  const declared = options.lengthOverride ?? payload.length;
  const parts: Buffer[] = [Buffer.from([(fin ? 0x80 : 0) | rsv | options.opcode])];
  if (declared < 126) {
    parts.push(Buffer.from([(masked ? 0x80 : 0) | declared]));
  } else if (declared <= 0xffff) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(declared);
    parts.push(Buffer.from([(masked ? 0x80 : 0) | 126]), b);
  } else {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(declared));
    parts.push(Buffer.from([(masked ? 0x80 : 0) | 127]), b);
  }
  if (masked) {
    // 全 0 掩码（payload 原样通过）——掩码位本身就是要测的违规点。
    parts.push(Buffer.alloc(4));
  }
  socket.write(Buffer.concat([...parts, payload]));
}

describe('openTeamSocket（真实本地 WS 服务器）', () => {
  let echo: TestServer;
  let reject: TestServer;
  let closer: TestServer;
  let pinger: TestServer;
  let raw: TestServer;
  let badaccept: TestServer;

  beforeAll(async () => {
    [echo, reject, closer, pinger, raw, badaccept] = await Promise.all([
      startWsServer('echo'),
      startWsServer('reject401'),
      startWsServer('close1000'),
      startWsServer('ping'),
      startWsServer('raw'),
      startWsServer('badaccept'),
    ]);
  });

  afterAll(async () => {
    await Promise.all([echo, reject, closer, pinger, raw, badaccept].map((s) => s.close()));
  });

  it('握手带 Authorization 头、路径 /rpc，文本帧双向回环', async () => {
    const socket = await openTeamSocket(`ws://127.0.0.1:${echo.port}/rpc`, {
      authorization: 'Bearer tok-bridge',
    });
    const texts: string[] = [];
    let closed: { code: number | null; reason: string } | null = null;
    socket.on({
      onText: (text) => texts.push(text),
      onClose: (code, reason) => {
        closed = { code, reason };
      },
    });
    expect(echo.lastHeaders['authorization']).toBe('Bearer tok-bridge');
    expect(echo.lastPath).toBe('/rpc');
    // 小帧与跨 126 字节边界的帧都完整回环。
    socket.send('{"id":1,"method":"team.bootstrap"}');
    const big = `{"pad":"${'x'.repeat(200)}"}`;
    socket.send(big);
    await vi.waitFor(() => expect(texts).toEqual(['{"id":1,"method":"team.bootstrap"}', big]));
    expect(closed).toBe(null);
    socket.close(1000, 'done');
  });

  it('服务端主动 close(1000) → onClose(1000) 且客户端回 close 帧', async () => {
    const socket = await openTeamSocket(`ws://127.0.0.1:${closer.port}/rpc`, {
      authorization: 'Bearer tok',
    });
    let closed: { code: number | null; reason: string } | null = null;
    socket.on({
      onText: () => {},
      onClose: (code, reason) => {
        closed = { code, reason };
      },
    });
    await vi.waitFor(() => expect(closed).toEqual({ code: 1000, reason: '' }));
  });

  it('服务器 401 拒绝握手 → TeamSocketHttpError(401)', async () => {
    await expect(
      openTeamSocket(`ws://127.0.0.1:${reject.port}/rpc`, { authorization: 'Bearer bad' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('服务端 ping → 客户端自动回 pong（控制帧路径）', async () => {
    const socket = await openTeamSocket(`ws://127.0.0.1:${pinger.port}/rpc`, {
      authorization: 'Bearer tok',
    });
    socket.on({ onText: () => {}, onClose: () => {} });
    await vi.waitFor(() =>
      expect(pinger.controlFrames).toContainEqual({ opcode: 0xa, payload: 'hb' }),
    );
    socket.close(1000);
  });

  it('非法 scheme 直接拒绝', async () => {
    await expect(openTeamSocket('http://127.0.0.1:1/rpc', {})).rejects.toThrow(/ws:\/\//);
  });

  // --- 协议违规与帧边界（raw 服务器注入违规帧；605 审查清单 A.1） ----------------

  function openRawSocket(): Promise<TeamSocket> {
    return openTeamSocket(`ws://127.0.0.1:${raw.port}/rpc`, { authorization: 'Bearer tok' });
  }

  it('Sec-WebSocket-Accept 不匹配 → 握手拒绝（RFC 6455 §4.2.1 客户端校验）', async () => {
    await expect(openTeamSocket(`ws://127.0.0.1:${badaccept.port}/rpc`, {})).rejects.toThrow(
      /Sec-WebSocket-Accept/,
    );
  });

  it('64 位长度声明超限帧 → 1009 拒收（头即拒，不进接收缓冲）', async () => {
    const socket = await openRawSocket();
    let closed: number | null = null;
    let texts = 0;
    socket.on({
      onText: () => {
        texts += 1;
      },
      onClose: (code) => {
        closed = code;
      },
    });
    writeRawFrame(lastSocket(raw), {
      opcode: 0x1,
      lengthOverride: RELAY_MAX_FRAME_BYTES + 1,
      payload: Buffer.from('partial'),
    });
    await vi.waitFor(() => expect(closed).toBe(1009));
    expect(texts).toBe(0);
  });

  it('服务端帧带掩码 → 1002；RSV 位非 0 → 1002（各自断开）', async () => {
    // 服务端→客户端必须不掩码（客户端只发掩码帧）。
    const maskedSocket = await openRawSocket();
    let maskedClose: number | null = null;
    maskedSocket.on({ onText: () => {}, onClose: (code) => (maskedClose = code) });
    writeRawFrame(lastSocket(raw), { opcode: 0x1, masked: true, payload: Buffer.from('hi') });
    await vi.waitFor(() => expect(maskedClose).toBe(1002));

    // 未协商扩展：RSV 位必须为 0。
    const rsvSocket = await openRawSocket();
    let rsvClose: number | null = null;
    rsvSocket.on({ onText: () => {}, onClose: (code) => (rsvClose = code) });
    writeRawFrame(lastSocket(raw), { opcode: 0x1, rsv: 0x40, payload: Buffer.from('hi') });
    await vi.waitFor(() => expect(rsvClose).toBe(1002));
  });

  it('分片文本按字节累积重组（多字节 UTF-8 跨分片不拆坏）', async () => {
    const socket = await openRawSocket();
    const texts: string[] = [];
    let closed: number | null = null;
    socket.on({
      onText: (text) => texts.push(text),
      onClose: (code) => (closed = code),
    });
    // 「你」= 字节 9–11、「，」= 字节 15–17：两刀都落在多字节序列中间。
    const whole = Buffer.from('{"note":"你好，世界"}', 'utf8');
    writeRawFrame(lastSocket(raw), { opcode: 0x1, fin: false, payload: whole.subarray(0, 10) });
    writeRawFrame(lastSocket(raw), { opcode: 0x0, fin: false, payload: whole.subarray(10, 16) });
    writeRawFrame(lastSocket(raw), { opcode: 0x0, fin: true, payload: whole.subarray(16) });
    await vi.waitFor(() => expect(texts).toEqual(['{"note":"你好，世界"}']));
    expect(closed).toBe(null);
    socket.close(1000);
  });

  it('分片中途的 ping 照常回 pong，分片继续（控制帧可穿插）', async () => {
    const socket = await openRawSocket();
    const texts: string[] = [];
    socket.on({ onText: (text) => texts.push(text), onClose: () => {} });
    const whole = Buffer.from('part1-part2', 'utf8');
    writeRawFrame(lastSocket(raw), { opcode: 0x1, fin: false, payload: whole.subarray(0, 5) });
    writeRawFrame(lastSocket(raw), { opcode: 0x9, payload: Buffer.from('hb') });
    await vi.waitFor(() =>
      expect(raw.controlFrames).toContainEqual({ opcode: 0xa, payload: 'hb' }),
    );
    writeRawFrame(lastSocket(raw), { opcode: 0x0, fin: true, payload: whole.subarray(5) });
    await vi.waitFor(() => expect(texts).toEqual(['part1-part2']));
    socket.close(1000);
  });

  it('continuation 无开始帧 → 1002；二进制数据帧 → 1003', async () => {
    const orphan = await openRawSocket();
    let orphanClose: number | null = null;
    orphan.on({ onText: () => {}, onClose: (code) => (orphanClose = code) });
    writeRawFrame(lastSocket(raw), { opcode: 0x0, fin: true, payload: Buffer.from('orphan') });
    await vi.waitFor(() => expect(orphanClose).toBe(1002));

    const binary = await openRawSocket();
    let binaryClose: number | null = null;
    binary.on({ onText: () => {}, onClose: (code) => (binaryClose = code) });
    writeRawFrame(lastSocket(raw), { opcode: 0x2, payload: Buffer.from([1, 2, 3]) });
    await vi.waitFor(() => expect(binaryClose).toBe(1003));
  });

  it('分片消息总长超限 → 1009（碎片累积有硬上界）', async () => {
    const socket = await openRawSocket();
    let closed: number | null = null;
    let texts = 0;
    socket.on({
      onText: () => {
        texts += 1;
      },
      onClose: (code) => (closed = code),
    });
    // 每片 ≤ 单帧上限（各自通过帧头检查），合计 > 上限 → 消息级拒收。
    const half = Math.floor(RELAY_MAX_FRAME_BYTES / 2) + 1024;
    const big = Buffer.alloc(half, 0x61);
    writeRawFrame(lastSocket(raw), { opcode: 0x1, fin: false, payload: big });
    writeRawFrame(lastSocket(raw), { opcode: 0x0, fin: true, payload: big });
    await vi.waitFor(() => expect(closed).toBe(1009));
    expect(texts).toBe(0);
  });

  it('1 字节 close 载荷（对端违规）→ 客户端回空 close 并以 1005 收口', async () => {
    const socket = await openRawSocket();
    let closed: number | null = null;
    socket.on({ onText: () => {}, onClose: (code) => (closed = code) });
    writeRawFrame(lastSocket(raw), { opcode: 0x8, payload: Buffer.from([0x01]) });
    await vi.waitFor(() => expect(closed).toBe(1005));
    // 回显的 close 载荷为空（不回显非法的 1 字节载荷）。
    await vi.waitFor(() =>
      expect(raw.closeFrames.at(-1)).toEqual({ payloadLength: 0, code: null }),
    );
  });
});

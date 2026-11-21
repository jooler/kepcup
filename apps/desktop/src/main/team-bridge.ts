import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket as NetSocket } from 'node:net';
import { RELAY_MAX_FRAME_BYTES } from '@kepcup/shared';

/**
 * T7 步骤 1（62.08 §3 / T7 §2「团队连接走主进程桥接」）：融合视图的团队 WS 桥。
 *
 * 每个已连接服务器一条连接 = 主进程侧 WebSocket + 一对 MessagePort：
 * port1 留主进程转发帧，port2 经 `webContents.postMessage('team-port', {serverHash},
 * [port2])` 交给渲染层——与本机 core 的 MessagePort 通道（index.ts sendAppPort）
 * 同构，协议帧就是 birpc JSON（member-hub 的 transport 同款：对象 ↔ JSON 字符串），
 * 渲染层可直接复用 `domPortToTransport`。桌面渲染层 CSP 的 connect-src 只允许
 * localhost，团队连接由主进程代持，不放宽 CSP；token 不出主进程。
 *
 * 重连：WS 意外关闭 → 指数退避；每次重试前先 `GET /api/auth/whoami`（Bearer）探测：
 * 200 → 重连，401/403 → `unauthenticated`（不自动重试，等用户重新 login），其它 /
 * 网络错误 → 继续退避重试。主动 disconnect / 服务器 remove 时关 WS、关双侧 port、
 * 状态 idle。
 *
 * 本模块不 import electron：MessageChannelMain 与 webContents 经构造注入（测试用
 * fake），不触碰应用单例。
 *
 * WS 客户端为手写的最小 RFC 6455 实现（`openTeamSocket`，基于 node:http 的
 * `Upgrade` 握手 + socket 上的帧编解码）。不用 Node / Electron 的全局 `WebSocket`：
 * 它遵循浏览器 API，构造器不接受任何自定义头（实测 Node 24 与 Electron 45 的
 * undici 实现都会静默忽略第三参 options，URL userinfo 也不产生 Authorization 头），
 * 而 member-hub 的鉴权只认 `Authorization: Bearer` 或会话 cookie 头、并明确拒绝
 * URL 查询串里的 token——全局 WebSocket 在主进程进程无法完成带 Bearer 的握手。
 * 也不再引入 `ws` 依赖（任务书禁止新增依赖）；此处约 250 行只实现文本帧 + 控制帧，
 * 头部完全可控。
 */

/** 握手等待上限（服务器不可达 / 不回 101 时不要挂死）。 */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** 空闲看门狗：服务端每 30s ping（member-hub WS_PING_INTERVAL_MS），3 个周期无任何入站帧即判死连接。 */
const IDLE_TIMEOUT_MS = 90_000;
/** 主动 close 后等待对端回 close 的宽限。 */
const CLOSE_GRACE_MS = 3_000;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------------------------------------------------------------------------
// 最小 RFC 6455 客户端（客户端→服务端帧一律掩码；只发文本帧）
// ---------------------------------------------------------------------------

export interface TeamSocketHandlers {
  onText(text: string): void;
  onClose(code: number | null, reason: string): void;
}

export interface TeamSocket {
  /** 发一条文本帧（连接已关闭时静默丢弃——桥的重连负责恢复）。 */
  send(text: string): void;
  /** 发 close 帧并结束 TCP（幂等）。 */
  close(code?: number, reason?: string): void;
  /** 挂事件回调（onText / onClose）；连接在 resolve 之后、on 之前的入站帧会先排队。 */
  on(handlers: TeamSocketHandlers): void;
}

/** 握手被服务器以普通 HTTP 状态拒绝（member-hub：401 未认证 / 503 超限）。 */
export class TeamSocketHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`team socket handshake rejected: HTTP ${status}`);
    this.name = 'TeamSocketHttpError';
    this.status = status;
  }
}

export type OpenTeamSocket = (url: string, headers: Record<string, string>) => Promise<TeamSocket>;

/**
 * 连 `{url}/rpc` 形态的 WebSocket 端点。`url` 是完整 ws(s) URL；`headers` 会原样
 * 进入 Upgrade 请求头（主进程桥用它传 `Authorization: Bearer <token>`——Origin 头
 * 不需要：member-hub 只对 cookie 握手校验同源，Bearer 路径跳过）。
 */
export const openTeamSocket: OpenTeamSocket = (url, headers) =>
  new Promise<TeamSocket>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`team socket url invalid: ${url}`));
      return;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      reject(new Error(`team socket url must be ws:// or wss://: ${url}`));
      return;
    }
    const secure = parsed.protocol === 'wss:';
    const key = randomBytes(16).toString('base64');
    const req = (secure ? httpsRequest : httpRequest)({
      host: parsed.hostname,
      port: parsed.port || (secure ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...headers,
      },
    });
    req.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
      req.destroy(new Error('team socket handshake timeout'));
    });
    req.on('upgrade', (res, socket, head) => {
      // upgrade 回调的类型给 Duplex；运行时对象是 net.Socket（setTimeout 在其上）。
      const netSocket = socket as NetSocket;
      const accept = res.headers['sec-websocket-accept'];
      if (accept !== createHash('sha1').update(key + WS_GUID).digest('base64')) {
        netSocket.destroy();
        reject(new Error('team socket handshake: bad Sec-WebSocket-Accept'));
        return;
      }
      req.setTimeout(0);
      resolve(createSocket(netSocket, head));
    });
    req.on('response', (res) => {
      req.destroy();
      reject(new TeamSocketHttpError(res.statusCode ?? 0));
    });
    req.on('error', (error) => reject(error));
    req.end();
  });

/** 客户端帧编码：FIN=1、指定 opcode、payload 掩码（RFC 6455 §5.3）。 */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i & 3]!;
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function utf8Text(code: number, reason: string): string {
  return `${code}${reason === '' ? '' : ` ${reason}`}`;
}

function createSocket(socket: NetSocket, head: Buffer): TeamSocket {
  let open = true;
  let closeSent = false;
  let handlers: TeamSocketHandlers | null = null;
  const pendingTexts: string[] = [];
  /** handlers 挂上之前收到的 close（head 里就可能带 close 帧）——on() 时补投。 */
  let pendingClose: { code: number | null; reason: string } | null = null;
  let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  /** 分片消息累积（服务端可分片；只在 FIN 时整体解码，避免拆开多字节 UTF-8）。 */
  let fragments: Buffer[] | null = null;

  const armIdleWatchdog = (): void => {
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.once('timeout', () => {
      // 服务器周期 ping 之下长时间无入站帧 = 死连接（对端 NAT 超时 / 半开）。走 close
      // 路径触发桥的重连；1006 = 异常关闭（未收到 close 帧）。
      socket.destroy();
    });
  };
  armIdleWatchdog();

  const emitClose = (code: number | null, reason: string): void => {
    if (!open) return;
    open = false;
    socket.setTimeout(0);
    if (handlers !== null) {
      handlers.onClose(code, reason);
      handlers = null;
    } else {
      pendingClose = { code, reason };
    }
  };

  const failProtocol = (code: number, reason: string): void => {
    if (!open) return;
    if (!closeSent) {
      closeSent = true;
      socket.write(encodeClientFrame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason, 'utf8')])));
    }
    socket.destroy();
    emitClose(code, reason);
  };

  const deliver = (payload: Buffer): void => {
    if (handlers !== null) handlers.onText(payload.toString('utf8'));
    else pendingTexts.push(payload.toString('utf8'));
  };

  const parseFrame = (): void => {
    while (open) {
      if (buffer.length < 2) return;
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      // 服务端→客户端帧不得掩码；RSV 必须为 0（不协商扩展，member-hub 的 ws 不会带）。
      if (masked || rsv !== 0) {
        failProtocol(1002, 'protocol error');
        return;
      }
      if (opcode >= 0x8) {
        // 控制帧：FIN 必须 1、payload ≤125。
        if (!fin || length > 125) {
          failProtocol(1002, 'protocol error');
          return;
        }
      } else if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(RELAY_MAX_FRAME_BYTES)) {
          failProtocol(1009, 'frame too large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > RELAY_MAX_FRAME_BYTES) {
        failProtocol(1009, 'frame too large');
        return;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x1 || opcode === 0x2) {
        if (opcode === 0x2) {
          // 桥只承载 birpc JSON 文本帧；二进制帧按不支持数据处理。
          failProtocol(1003, 'binary frames unsupported');
          return;
        }
        if (fragments !== null) {
          failProtocol(1002, 'unexpected new data frame during fragmentation');
          return;
        }
        if (fin) deliver(payload);
        else fragments = [payload];
        continue;
      }
      if (opcode === 0x0) {
        if (fragments === null) {
          failProtocol(1002, 'continuation without start');
          return;
        }
        fragments.push(payload);
        const total = fragments.reduce((sum, part) => sum + part.length, 0);
        if (total > RELAY_MAX_FRAME_BYTES) {
          failProtocol(1009, 'message too large');
          return;
        }
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = null;
          deliver(whole);
        }
        continue;
      }
      if (opcode === 0x9) {
        // ping → 回 pong（带原 payload）。
        socket.write(encodeClientFrame(0xa, Buffer.from(payload)));
        continue;
      }
      if (opcode === 0xa) continue; // pong：看门狗已因入站数据重置。
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!closeSent) {
          closeSent = true;
          // close 握手（§5.5.1）：回显对端的 code；1 字节 close 载荷是对端协议
          // 错误（close 载荷只允许 0 或 ≥2 字节）——回空载荷，不把非法长度传回去。
          socket.write(
            encodeClientFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0)),
          );
        }
        socket.end();
        emitClose(code, reason);
        return;
      }
      failProtocol(1002, `unknown opcode ${opcode}`);
      return;
    }
  };

  socket.on('data', (chunk: Buffer) => {
    if (!open) return;
    socket.setTimeout(IDLE_TIMEOUT_MS); // 任何入站字节都重置空闲看门狗。
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    parseFrame();
  });
  socket.on('error', () => {
    // error 之后必有 close；close 统一收口。
  });
  socket.on('close', () => emitClose(1006, ''));

  // 握手 head 里可能已经带了首帧（服务端紧跟着 101 立即发 close / ping）——立即解析。
  parseFrame();

  return {
    send(text) {
      if (!open) return;
      socket.write(encodeClientFrame(0x1, Buffer.from(text, 'utf8')));
    },
    close(code = 1000, reason = '') {
      if (!open || closeSent) return;
      closeSent = true;
      socket.write(
        encodeClientFrame(
          0x8,
          Buffer.concat([
            Buffer.from([code >> 8, code & 0xff]),
            Buffer.from(reason.slice(0, 100), 'utf8'),
          ]),
        ),
      );
      socket.end();
      // 对端不回 close 帧时兜底回收（半开 TCP 不能挡住 close 语义）。
      const guard = setTimeout(() => socket.destroy(), CLOSE_GRACE_MS);
      guard.unref?.();
    },
    on(next) {
      if (!open) {
        // 已关闭（close 帧在 head 里就到了）：直接补投终态。
        const close = pendingClose ?? { code: 1006 as number | null, reason: '' };
        pendingClose = null;
        next.onClose(close.code, close.reason);
        return;
      }
      handlers = next;
      if (pendingTexts.length > 0 && handlers !== null) {
        const drained = [...pendingTexts];
        pendingTexts.length = 0;
        for (const text of drained) handlers.onText(text);
      }
      if (pendingClose !== null && handlers !== null) {
        const close = pendingClose;
        pendingClose = null;
        handlers.onClose(close.code, close.reason);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 桥：MessagePort ↔ WS 帧转发 + 断线重连
// ---------------------------------------------------------------------------

/** 主进程侧端口的最小结构面（MessagePortMain 的子集，测试用 fake）。 */
export interface BridgePortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  /** MessagePortMain 在 start() 前不投递消息；fake 可缺省。 */
  start?(): void;
  postMessage(message: unknown): void;
  close(): void;
}

export interface BridgeChannel {
  port1: BridgePortLike;
  port2: BridgePortLike;
}

export type TeamConnectionStatus = 'idle' | 'connecting' | 'connected' | 'unauthenticated' | 'error';

/** whoami 探测结果：ok = 继续；unauthenticated = 401/403，终态不再重试；error = 继续。 */
type ProbeResult = 'ok' | 'unauthenticated' | 'error';

interface BridgeConnection {
  serverHash: string;
  url: string;
  token: string;
  socket: TeamSocket | null;
  port1: BridgePortLike | null;
  /** WS 打开前渲染层发来的帧（open 后按序冲掉）。 */
  outboundQueue: unknown[];
  /** 连续失败次数（成功连接后清零）；指数退避的指数。 */
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** 用户 disconnect / remove：停止一切重试。 */
  stopped: boolean;
  /** 上次上报的状态（相邻重复不重报，减少渲染层事件噪音）。 */
  lastStatus: TeamConnectionStatus | null;
}

/** 重连退避：1s 起步、×2、封顶 30s。 */
function backoffDelayMs(attempts: number): number {
  return Math.min(1000 * 2 ** attempts, 30_000);
}

export interface TeamBridgeDeps {
  createChannel(): BridgeChannel;
  /** port2 → 渲染层（index.ts 接到 webContents.postMessage('team-port', …)）。 */
  postPort(serverHash: string, port: BridgePortLike): void;
  openSocket: OpenTeamSocket;
  fetch: typeof fetch;
  /** 主进程只允许 console.warn / console.error（BR-P13-008：无文案进程）。 */
  log?(message: string, error?: unknown): void;
}

export class TeamServerBridge {
  readonly #deps: TeamBridgeDeps;
  readonly #connections = new Map<string, BridgeConnection>();
  readonly #onStatus: (serverHash: string, status: TeamConnectionStatus) => void;

  constructor(
    deps: TeamBridgeDeps,
    onStatus: (serverHash: string, status: TeamConnectionStatus) => void,
  ) {
    this.#deps = deps;
    this.#onStatus = onStatus;
  }

  /**
   * 建立连接：开一对新 MessagePort（port2 送渲染层），连 WS。重复 connect 同一
   * serverHash = 先拆旧连接再建（switchAccount 走这里换凭据）。
   */
  connect(serverHash: string, credentials: { url: string; token: string }): void {
    this.disconnect(serverHash);
    const connection: BridgeConnection = {
      serverHash,
      url: credentials.url,
      token: credentials.token,
      socket: null,
      port1: null,
      outboundQueue: [],
      attempts: 0,
      retryTimer: null,
      stopped: false,
      lastStatus: null,
    };
    this.#connections.set(serverHash, connection);
    const { port1, port2 } = this.#deps.createChannel();
    connection.port1 = port1;
    port1.on('message', (event) => {
      if (connection.stopped) return;
      this.#sendOrQueue(connection, event.data);
    });
    port1.start?.();
    this.#deps.postPort(serverHash, port2);
    this.#setStatus(connection, 'connecting');
    this.#attempt(connection);
  }

  /** 主动断开：关 WS、关主进程侧 port（渲染端 port 收 close 事件），清重试。 */
  disconnect(serverHash: string): void {
    const connection = this.#connections.get(serverHash);
    if (connection === undefined) return;
    connection.stopped = true;
    if (connection.retryTimer !== null) clearTimeout(connection.retryTimer);
    connection.retryTimer = null;
    connection.socket?.close(1000, 'client disconnect');
    connection.socket = null;
    connection.port1?.close();
    connection.port1 = null;
    this.#connections.delete(serverHash);
  }

  /** 全部断开（应用退出）。 */
  disconnectAll(): void {
    for (const serverHash of [...this.#connections.keys()]) this.disconnect(serverHash);
  }

  /** 该服务器当前是否有活连接（含重试在途）。 */
  has(serverHash: string): boolean {
    return this.#connections.has(serverHash);
  }

  /**
   * 窗口（重）加载后为每条活连接补发新 port（旧 port 已随页面销毁失效；core-port
   * 的 did-finish-load → sendAppPort 同款语义，WS 连接保持不断）。
   */
  refreshPorts(): void {
    for (const connection of this.#connections.values()) {
      connection.port1?.close();
      const { port1, port2 } = this.#deps.createChannel();
      connection.port1 = port1;
      port1.on('message', (event) => {
        if (connection.stopped) return;
        this.#sendOrQueue(connection, event.data);
      });
      port1.start?.();
      this.#deps.postPort(connection.serverHash, port2);
    }
  }

  #sendOrQueue(connection: BridgeConnection, data: unknown): void {
    if (connection.socket !== null) {
      try {
        connection.socket.send(JSON.stringify(data));
      } catch {
        // 渲染层经 port 递来的载荷理论上是 birpc JSON（可序列化）；防御循环引用
        // 等 stringify 抛错——丢这一帧，不让异常冒出 port 监听器炸主进程。
      }
      return;
    }
    connection.outboundQueue.push(data);
  }

  #setStatus(connection: BridgeConnection, status: TeamConnectionStatus): void {
    if (connection.lastStatus === status) return;
    connection.lastStatus = status;
    this.#onStatus(connection.serverHash, status);
  }

  #attempt(connection: BridgeConnection): void {
    if (connection.stopped) return;
    // 首次连接直接握手（token 是刚验证过的）；重连前先 whoami 探测，避免对失效
    // token 无限重试（401 → unauthenticated 终态，等用户重新 login）。
    const probe: Promise<ProbeResult> =
      connection.attempts === 0
        ? Promise.resolve('ok' as const)
        : this.#probeWhoami(connection);
    this.#setStatus(connection, 'connecting');
    probe
      .then((result) => {
        if (connection.stopped) return;
        if (result === 'unauthenticated') {
          this.#setStatus(connection, 'unauthenticated');
          return;
        }
        // result === 'error'：探测没把握（网络抖动 / 5xx），仍试一次握手——握手本身
        // 会给出更准确的判据（401 / 连不上）。
        return this.#deps
          .openSocket(`${connection.url.replace(/\/$/, '')}/rpc`, {
            authorization: `Bearer ${connection.token}`,
          })
          .then((socket) => {
            if (connection.stopped) {
              socket.close(1000, 'client disconnect');
              return;
            }
            connection.socket = socket;
            connection.attempts = 0;
            socket.on({
              onText: (text) => {
                if (connection.stopped) return;
                // 与 member-hub 的 transport 一致：非 JSON 帧忽略（birpc 请求缺 id
                // 时对端自行超时）。
                try {
                  connection.port1?.postMessage(JSON.parse(text));
                } catch {
                  /* drop */
                }
              },
              onClose: (code, reason) => {
                if (connection.stopped) return;
                connection.socket = null;
                this.#scheduleRetry(connection, `ws closed ${utf8Text(code ?? 1006, reason)}`);
              },
            });
            this.#setStatus(connection, 'connected');
            const queued = connection.outboundQueue;
            connection.outboundQueue = [];
            for (const data of queued) this.#sendOrQueue(connection, data);
          });
      })
      .catch((error: unknown) => {
        if (connection.stopped) return;
        connection.socket = null;
        // 握手被拒 401/403 = token 失效（member-hub 的认证复查路径）——终态。
        if (
          error instanceof TeamSocketHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          this.#setStatus(connection, 'unauthenticated');
          return;
        }
        this.#scheduleRetry(connection, error instanceof Error ? error.message : String(error));
      });
  }

  #scheduleRetry(connection: BridgeConnection, why: string): void {
    if (connection.stopped) return;
    this.#deps.log?.(`bridge retry scheduled (${connection.serverHash}): ${why}`);
    this.#setStatus(connection, 'error');
    const delay = backoffDelayMs(connection.attempts);
    connection.attempts += 1;
    connection.retryTimer = setTimeout(() => {
      connection.retryTimer = null;
      this.#attempt(connection);
    }, delay);
  }

  async #probeWhoami(connection: BridgeConnection): Promise<ProbeResult> {
    try {
      const res = await this.#deps.fetch(`${connection.url.replace(/\/$/, '')}/api/auth/whoami`, {
        headers: { authorization: `Bearer ${connection.token}` },
      });
      if (res.status === 200) return 'ok';
      if (res.status === 401 || res.status === 403) return 'unauthenticated';
      return 'error';
    } catch {
      return 'error';
    }
  }
}

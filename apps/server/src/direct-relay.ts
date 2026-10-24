import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SESSION_ID_PATTERN,
  relayEnvelopeSchema,
  type RelayEnvelope,
  type RelayInfo,
  type RemoteAnchorState,
} from '@kepcup/shared';
import type { Clock, CoreLogger, RelayClientLike, RelayClientOptions } from '@kepcup/core';

/**
 * 直连监听层（D102 §3.2）：把 hub 的 `RelayClientLike` 缝对接到本地 WS 监听——
 * 站在中转（D96 relay-session）的位置上，只是 anchor 在本进程。viewer（PWA 的
 * WsTransport）零改动：连接 URL 由配对链接第一段决定，指向本服务即直连。
 *
 * 职责（对齐中转 Worker 的最低集，见设计 §3.2）：
 * - `/ws/{sid}?role=viewer` 升级校验（sid 形状 + 会话匹配、role=viewer、Origin
 *   同源或缺省、并发连接上限、单帧 ≤512KB、envelope zod 校验）；
 * - `did → socket` 路由（出站定向 / 无 did 广播）；首个带 did 帧注册；
 * - 合成中转自产信号：ping→pong、socket close→viewer_left（hub 5s 宽限清端点）、
 *   同 did 新连接→旧 socket 收 replaced 后关闭；anchor 未就绪→anchor_offline。
 *
 * 监听 socket 属于 server 应用（比 hub 会话活得久）：hub 拆线（close）只断 viewer
 * 并转入 dormant——dormant 期新连接收 anchor_offline 后断开，viewer 进入等待态。
 */

const MAX_VIEWERS = 8;
/** ws 库协议级心跳：穿透反代的死连接检测（应用层另有 viewer→anchor ping/pong）。 */
const WS_PING_INTERVAL_MS = 30_000;

interface ActiveSession {
  sessionId: string;
  onFrame(envelope: RelayEnvelope): void;
}

export interface DirectRelayServerOptions {
  httpServer: HttpServer;
  logger: CoreLogger;
  clock: Clock;
}

export class DirectRelayServer {
  readonly #wss: WebSocketServer;
  readonly #logger: CoreLogger;
  readonly #clock: Clock;
  #active: ActiveSession | null = null;
  readonly #viewers = new Set<WebSocket>();
  readonly #byDid = new Map<string, WebSocket>();
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DirectRelayServerOptions) {
    this.#wss = new WebSocketServer({ noServer: true });
    this.#logger = options.logger;
    this.#clock = options.clock;
  }

  /** server.ts 在 HTTP server 的 upgrade 事件里转进来（与静态/admin 同端口）。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://internal');
    const sid = /^\/ws\/([^/]+)$/.exec(url.pathname)?.[1] ?? '';
    if (url.searchParams.get('role') !== 'viewer') {
      // anchor 是本进程；任何外连 anchor 都是配置错误或探测，直接拒绝。
      this.#reject(socket, 403, 'only role=viewer is accepted');
      return;
    }
    if (!RELAY_SESSION_ID_PATTERN.test(sid)) {
      this.#reject(socket, 404, 'unknown session');
      return;
    }
    if (this.#viewers.size >= MAX_VIEWERS) {
      this.#reject(socket, 503, 'too many viewers');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.#sameOrigin(origin, req)) {
      this.#reject(socket, 403, 'cross-origin websocket rejected');
      return;
    }
    const active = this.#active;
    if (active === null) {
      // dormant（hub 未挂会话，如开关刚关 / 换地址中）：接收后告知 anchor 不在，
      // viewer 按语义保留等待态（ws-transport anchor_offline 分支）。
      this.#wss.handleUpgrade(req, socket, head, (ws) => {
        this.#send(ws, this.#infoFrame(sid, 'signal', { kind: 'anchor_offline' }));
        ws.close(1000, 'anchor_offline');
      });
      return;
    }
    if (active.sessionId !== sid) {
      this.#reject(socket, 404, 'unknown session');
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws));
  }

  /** hub 工厂缝的产物（每次建连一个；地址变化时 hub 先 close 旧的）。 */
  createAdapter(options: RelayClientOptions): RelayClientLike {
    return new DirectRelayAdapter(this, options, this.#logger);
  }

  /** anchor 会话挂载（DirectRelayAdapter.connect）。 */
  activate(session: ActiveSession): void {
    if (this.#active !== null && this.#active !== session) {
      // 旧会话残留的 socket 一并断开（viewer 收 close 后按退避重连自举）。
      this.#dropAllViewers();
    }
    this.#active = session;
    if (this.#pingTimer === null) {
      this.#pingTimer = setInterval(() => this.#pingSweep(), WS_PING_INTERVAL_MS);
      this.#pingTimer.unref?.();
    }
  }

  /** anchor 会话卸载（DirectRelayAdapter.close）：断 viewer、转 dormant。 */
  deactivate(): void {
    this.#active = null;
    this.#dropAllViewers();
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
  }

  #dropAllViewers(): void {
    for (const ws of [...this.#viewers]) ws.close(1000, 'anchor gone');
    // close 回调统一清理；clear 兜底已终止的。
    this.#viewers.clear();
    this.#byDid.clear();
  }

  #attach(ws: WebSocket): void {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    this.#viewers.add(ws);
    ws.on('pong', () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });
    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        this.#badFrame(ws, 'binary frames are not part of the protocol');
        return;
      }
      const text = typeof data === 'string' ? data : String(data);
      if (text.length > RELAY_MAX_FRAME_BYTES) {
        this.#badFrame(ws, 'frame too large');
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(text);
      } catch {
        this.#badFrame(ws, 'frame is not JSON');
        return;
      }
      const parsed = relayEnvelopeSchema.safeParse(envelope);
      if (!parsed.success) {
        this.#badFrame(ws, 'frame rejected by envelope schema');
        return;
      }
      const frame = parsed.data;
      const active = this.#active;
      if (active === null || frame.sid !== active.sessionId) {
        ws.close(1000, 'session changed');
        return;
      }
      if (frame.type === 'ping') {
        // 中转自产行为：ping 在中转终结，不到 anchor（hub.ts 同款注释）。
        this.#send(ws, this.#infoFrame(frame.sid, 'pong', { kind: 'pong', ts: this.#clock.now() }));
        return;
      }
      if (frame.did !== undefined) this.#registerDid(frame.did, ws);
      active.onFrame(frame);
    });
    ws.on('close', () => {
      this.#viewers.delete(ws);
      const did = this.#didOf(ws);
      if (did !== null && this.#byDid.get(did) === ws) {
        this.#byDid.delete(did);
        this.#emitViewerLeft(did);
      }
    });
    ws.on('error', () => {
      // error 后必有 close；close 里清理。
    });
  }

  #registerDid(did: string, ws: WebSocket): void {
    const existing = this.#byDid.get(did);
    if (existing === ws) return;
    if (existing !== undefined) {
      // 同 did 新连接顶掉旧连接（中转 replaced 语义：viewer 依赖它避免互踢循环）。
      const sid = this.#active?.sessionId ?? '';
      this.#send(existing, this.#infoFrame(sid, 'signal', { kind: 'replaced' }));
      this.#forget(existing);
      this.#viewers.delete(existing);
      existing.close(4000, 'replaced');
    }
    this.#byDid.set(did, ws);
    (ws as WebSocket & { did?: string }).did = did;
  }

  #emitViewerLeft(did: string): void {
    const active = this.#active;
    if (active === null) return;
    active.onFrame(this.#infoFrame(active.sessionId, 'signal', { kind: 'viewer_left', did }));
  }

  /** hub 出站：did 定向，无 did 广播（协议保留路径；实际扇出帧恒带 did）。 */
  route(envelope: RelayEnvelope): void {
    if (envelope.did !== undefined) {
      const target = this.#byDid.get(envelope.did);
      // 目标不在路由表（早已断开）：丢弃即可，viewer 重连自举会重建。
      if (target !== undefined) this.#send(target, envelope);
      return;
    }
    for (const ws of [...this.#viewers]) this.#send(ws, envelope);
  }

  #send(ws: WebSocket, envelope: RelayEnvelope): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(envelope));
    } catch (error) {
      this.#logger.warn({ error: String(error) }, 'direct-relay: send failed');
    }
  }

  #infoFrame(sid: string, type: 'signal' | 'pong', info: RelayInfo): RelayEnvelope {
    return { v: RELAY_PROTOCOL_VERSION, sid, type, n: 0, info };
  }

  #badFrame(ws: WebSocket, message: string): void {
    this.#logger.warn({ message }, 'direct-relay: bad frame');
    this.#send(ws, {
      v: RELAY_PROTOCOL_VERSION,
      sid: this.#active?.sessionId ?? '',
      type: 'error',
      n: 0,
      info: { kind: 'bad_frame', message: message.slice(0, 300) },
    });
    ws.close(1007, 'bad frame');
  }

  #pingSweep(): void {
    for (const ws of this.#viewers) {
      const tagged = ws as WebSocket & { alive?: boolean };
      if (tagged.alive === false) {
        ws.terminate();
        continue;
      }
      tagged.alive = false;
      try {
        ws.ping();
      } catch {
        // 已断开的 socket ping 抛错：close 回调会清理。
      }
    }
  }

  #didOf(ws: WebSocket): string | null {
    return (ws as WebSocket & { did?: string }).did ?? null;
  }

  #forget(ws: WebSocket): void {
    const did = this.#didOf(ws);
    if (did !== null && this.#byDid.get(did) === ws) this.#byDid.delete(did);
  }

  #sameOrigin(origin: string, req: IncomingMessage): boolean {
    try {
      const originUrl = new URL(origin);
      const host = req.headers.host ?? '';
      return originUrl.host === host;
    } catch {
      return false;
    }
  }

  #reject(socket: Duplex, code: number, reason: string): void {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  /** 测试 / 诊断。 */
  viewerCount(): number {
    return this.#viewers.size;
  }

  close(): void {
    this.deactivate();
    this.#wss.close();
  }
}

/**
 * hub 侧的 anchor 形态：`connect()` 即把本会话挂上监听（监听早就在跑，无外连可拨），
 * 状态直接 online。`close()` 断 viewer 转 dormant，不动监听 socket。
 */
export class DirectRelayAdapter implements RelayClientLike {
  #state: RemoteAnchorState = 'off';

  constructor(
    private readonly server: DirectRelayServer,
    private readonly options: RelayClientOptions,
    private readonly logger: CoreLogger,
  ) {}

  get state(): RemoteAnchorState {
    return this.#state;
  }

  /** hub 用 `${relayUrl}/` 前缀判断地址是否变化——返回派生 URL 保持该语义。 */
  get url(): string {
    return `${this.options.relayUrl.replace(/\/+$/, '')}/direct`;
  }

  connect(): void {
    if (this.#state === 'online') return;
    this.server.activate({ sessionId: this.options.sessionId, onFrame: this.options.onFrame });
    this.#state = 'online';
    this.options.onStateChange('online');
    this.logger.info({ sid: this.options.sessionId }, 'direct-relay: anchor online (in-process)');
  }

  send(envelope: RelayEnvelope): void {
    if (this.#state !== 'online') return;
    this.server.route(envelope);
  }

  sendAll(envelopes: readonly RelayEnvelope[]): void {
    for (const envelope of envelopes) this.send(envelope);
  }

  close(): void {
    this.server.deactivate();
    this.#state = 'off';
    this.options.onStateChange('off');
  }
}

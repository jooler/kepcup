import {
  RELAY_HEARTBEAT_MS,
  RELAY_PROTOCOL_VERSION,
  type RelayEnvelope,
  type RemoteAnchorState,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 中转客户端（D96 §4.4「anchor 常驻外连」）：Node 22 全局 WebSocket 主动外连
 * `${relayUrl}/ws/{sessionId}?role=anchor`，断线指数退避重连（1s 起、×2、上限
 * 5 分钟），30s 应用层心跳（ping 帧），状态机 off/connecting/online/error。
 * 只管连接与帧收发；E2E 加解密在 hub（codec），路由策略在中转。
 */

/** 心跳超时：连续两个周期无 pong 即认为连接死亡（重连）。 */
const PONG_TIMEOUT_MS = RELAY_HEARTBEAT_MS * 2;
/** 重连退避上限（设计 §4.4：上限 5 分钟）。 */
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface RelayClientOptions {
  relayUrl: string;
  sessionId: string;
  clock: Clock;
  logger: CoreLogger;
  /** 连接状态变化（off 由 close() 触发）。 */
  onStateChange(state: RemoteAnchorState, reason?: string): void;
  /** 收到一帧（已 JSON.parse；未经解密）。 */
  onFrame(envelope: RelayEnvelope): void;
  /** 测试注入 WebSocket 构造器；缺省用 Node 22 全局。 */
  socketFactory?: (url: string) => RelaySocket;
}

/** Node / 测试共用的 WebSocket 结构子集。 */
export interface RelaySocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** 生产实现直接用全局 WebSocket（Node 22 起内置，undici 提供）。 */
function nodeSocketFactory(url: string): RelaySocket {
  const socket = new WebSocket(url);
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    addEventListener: (type, listener) => {
      // undici 的 WebSocket 事件签名与 RelaySocket 的结构子集一致，直接挂。
      socket.addEventListener(type, listener as never);
    },
  };
}

export class RelayClient {
  readonly #options: RelayClientOptions;
  readonly #factory: (url: string) => RelaySocket;
  #socket: RelaySocket | null = null;
  #state: RemoteAnchorState = 'off';
  #backoffMs = 1000;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #lastPongAt = 0;
  #closedByUser = false;

  constructor(options: RelayClientOptions) {
    this.#options = options;
    this.#factory = options.socketFactory ?? nodeSocketFactory;
  }

  get state(): RemoteAnchorState {
    return this.#state;
  }

  /** 组装 anchor 连接 URL（worker.ts 的 `/ws/{sid}?role=anchor` 路由）。 */
  get url(): string {
    const base = this.#options.relayUrl.replace(/\/+$/, '');
    return `${base}/ws/${this.#options.sessionId}?role=anchor`;
  }

  connect(): void {
    if (this.#closedByUser) return;
    if (this.#socket !== null) return;
    this.#setState('connecting');
    let socket: RelaySocket;
    try {
      socket = this.#factory(this.url);
    } catch (error) {
      this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#socket = socket;
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return;
      this.#backoffMs = 1000;
      this.#lastPongAt = this.#options.clock.now();
      this.#startHeartbeat();
      this.#setState('online');
    });
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return;
      const envelope = this.#parseFrame(event.data);
      if (envelope === null) return;
      if (envelope.type === 'pong') {
        this.#lastPongAt = this.#options.clock.now();
        return;
      }
      this.#options.onFrame(envelope);
    });
    socket.addEventListener('close', (event) => {
      if (this.#socket !== socket) return;
      this.#teardownSocket();
      this.#scheduleReconnect(`中转连接关闭（code ${event.code ?? '?'}）`);
    });
    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return;
      // error 后必有 close；这里只记状态，重连由 close 分支调度。
      this.#setState('connecting', '中转连接出错');
    });
  }

  /** 发送一帧（JSON 序列化；DO 侧解析失败即 bad_frame 断开）。 */
  send(envelope: RelayEnvelope): void {
    if (this.#socket === null || this.#state !== 'online') return;
    this.#socket.send(JSON.stringify(envelope));
  }

  /** 发送多帧（分片）。 */
  sendAll(envelopes: readonly RelayEnvelope[]): void {
    for (const envelope of envelopes) this.send(envelope);
  }

  /** 停止并回到 off（开关关闭 / 服务关闭时调用）。 */
  close(): void {
    this.#closedByUser = true;
    this.#teardownSocket();
    this.#setState('off');
  }

  #setState(state: RemoteAnchorState, reason?: string): void {
    if (this.#state === state && state !== 'error') return;
    this.#state = state;
    this.#options.onStateChange(state, reason);
  }

  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#state !== 'online') return;
      const now = this.#options.clock.now();
      if (now - this.#lastPongAt > PONG_TIMEOUT_MS) {
        this.#options.logger.warn({ lastPongAt: this.#lastPongAt }, 'relay heartbeat timeout');
        // 直接丢弃当前连接走重连（close 由 teardown 触发一次）。
        this.#teardownSocket();
        this.#scheduleReconnect('心跳超时');
        return;
      }
      this.send({ v: RELAY_PROTOCOL_VERSION, sid: this.#options.sessionId, type: 'ping', n: 0 });
    }, RELAY_HEARTBEAT_MS);
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #teardownSocket(): void {
    this.#stopHeartbeat();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close(1000, 'teardown');
      } catch {
        // 已关闭的 socket 再 close 会抛，忽略。
      }
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#closedByUser) return;
    this.#setState('error', reason);
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #parseFrame(data: unknown): RelayEnvelope | null {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data) as RelayEnvelope;
    } catch {
      return null;
    }
  }
}

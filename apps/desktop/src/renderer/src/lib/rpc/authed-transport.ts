import type { RpcTransport } from '@kepcup/shared';

/**
 * 账号密码直连传输（D102 修订）：headless 服务端（--auth password，默认）的
 * web 客户端通道。与 WsTransport（D96 配对 + E2E 帧）平行的另一条 web 传输：
 * 会话凭据是登录后的 HttpOnly Cookie（浏览器对同源 /rpc 升级自动携带），
 * birpc JSON 明文跑在（反代 TLS 的）WS 上。审计与 secrets 卫生规则在服务端
 * SessionHub 统一执行。
 */

export type AuthedLinkState = 'connecting' | 'connected' | 'reconnecting' | 'unauthenticated';

export interface AuthProbe {
  /** password = 账号密码模式服务器；pairing = 配对模式（公共中转 / --auth pairing）。 */
  mode: 'password' | 'pairing';
  /** password 模式下当前 Cookie 是否已登录。 */
  authenticated: boolean;
}

let probeCache: Promise<AuthProbe | null> | null = null;

/**
 * 探测服务器认证模型（成功结果记忆化，CoreConnection 与 Gate 共享同一次请求）：
 * `/api/auth/whoami` 404 = 配对模式（无此路由）；401/200 = 密码模式。
 * 网络失败返回 null 且不记忆（服务器可能刚起来，下次调用重新探测）。
 */
export function probeServerAuth(): Promise<AuthProbe | null> {
  if (probeCache !== null) return probeCache;
  const pending = fetch('/api/auth/whoami', { cache: 'no-store' })
    .then((response): AuthProbe | null => {
      if (response.status === 404) {
        return { mode: 'pairing', authenticated: false };
      }
      return { mode: 'password', authenticated: response.status === 200 };
    })
    .catch((): AuthProbe | null => null);
  probeCache = pending;
  void pending.then((result) => {
    if (result === null) probeCache = null;
  });
  return pending;
}

const MAX_BACKOFF_MS = 30_000;

export class AuthedWsTransport implements RpcTransport {
  #ws: WebSocket | null = null;
  #linkState: AuthedLinkState = 'connecting';
  #stateHandlers = new Set<(state: AuthedLinkState) => void>();
  #dataHandler: ((data: unknown) => void) | null = null;
  #backoffMs = 1_000;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  get linkState(): AuthedLinkState {
    return this.#linkState;
  }

  onLinkState(handler: (state: AuthedLinkState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  connect(): void {
    if (this.#closed) return;
    if (this.#ws !== null) return;
    this.#setLinkState(this.#linkState === 'unauthenticated' ? 'connecting' : this.#linkState);
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${protocol}://${location.host}/rpc`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => {
      this.#backoffMs = 1_000;
      this.#setLinkState('connected');
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      try {
        this.#dataHandler?.(JSON.parse(event.data));
      } catch {
        // 服务端不会发非 JSON；坏帧丢弃。
      }
    };
    // 浏览器 WS 拿不到升级响应码（401 与网络故障同为 error+close 1006），
    // 断开后用 whoami 区分：401 = 会话失效（回登录页），否则按网络断线重连。
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#onDrop();
    };
    ws.onerror = () => {
      // error 后必有 close；close 里收口。
    };
  }

  async #onDrop(): Promise<void> {
    if (this.#closed) return;
    this.#setLinkState('reconnecting');
    try {
      const probe = await fetch('/api/auth/whoami', { cache: 'no-store' });
      if (probe.status === 401) {
        // 会话过期 / 服务端改过密码：回登录页，停止自动重连。
        this.#setLinkState('unauthenticated');
        return;
      }
    } catch {
      // 探测也失败：服务器不可达，按断线重连处理。
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null || this.#ws !== null) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** 登录成功后立即拨号（跳过退避等待）。 */
  connectNow(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#backoffMs = 1_000;
    this.connect();
  }

  post(data: unknown): void {
    if (this.#ws !== null && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
    }
  }

  onData(handler: (data: unknown) => void): () => void {
    this.#dataHandler = handler;
    return () => {
      if (this.#dataHandler === handler) this.#dataHandler = null;
    };
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#ws?.close(1000, 'client close');
    this.#ws = null;
  }

  #setLinkState(state: AuthedLinkState): void {
    if (this.#linkState === state) return;
    this.#linkState = state;
    for (const handler of this.#stateHandlers) handler(state);
  }
}

let authedTransport: AuthedWsTransport | null = null;

/** web 构建的单例（与 getWebTransport 同款约定：CoreConnection 与 Gate 共享）。 */
export function getAuthedTransport(): AuthedWsTransport {
  authedTransport ??= new AuthedWsTransport();
  return authedTransport;
}

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
 * 其余一律返回 null（不定论，不记忆）——网络失败，或反代在服务重启/上游未起时
 * 回的 5xx（审查 P3：原先 502 也被当 password，登录页对着网关错误死磕）。
 * null 不记忆，下次调用重新探测。
 */
export function probeServerAuth(): Promise<AuthProbe | null> {
  if (probeCache !== null) return probeCache;
  const pending = fetch('/api/auth/whoami', { cache: 'no-store' })
    .then((response): AuthProbe | null => {
      if (response.status === 404) {
        return { mode: 'pairing', authenticated: false };
      }
      if (response.status === 200 || response.status === 401) {
        return { mode: 'password', authenticated: response.status === 200 };
      }
      return null;
    })
    .catch((): AuthProbe | null => null);
  probeCache = pending;
  void pending.then((result) => {
    if (result === null) probeCache = null;
  });
  return pending;
}

/**
 * 冷启动探测（审查 P2：原先两次失败就永久回退配对页）：不可达期间持续重试到
 * 期限，给出确定答案才返回；到期仍不可达返回 null（由调用方回退 + 后台自愈）。
 */
export async function probeServerAuthUntilSettled(
  totalMs = 30_000,
  intervalMs = 3_000,
): Promise<AuthProbe | null> {
  const deadline = Date.now() + totalMs;
  for (;;) {
    const probe = await probeServerAuth();
    if (probe !== null) return probe;
    if (Date.now() + intervalMs > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 探测不可达而回退配对路径后调用：后台周期重探，一旦服务器给出确定答案——
 * 是密码模式（刚起完 / 反代恢复）就刷新页面进正确路径（探测成功有记忆，重载
 * 即直连登录）；是配对模式则说明只是暂时不可达，停表交给 WsTransport 自愈。
 * 返回停止函数（正常路径页面会重载，不显式停也无妨）。
 */
export function watchForPasswordServer(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    void probeServerAuth().then((probe) => {
      if (probe === null) return;
      stop();
      if (probe.mode === 'password') location.reload();
    });
  }, intervalMs);
  function stop(): void {
    clearInterval(timer);
  }
  return stop;
}

const MAX_BACKOFF_MS = 30_000;
/**
 * 入站静默多久算连接可疑：服务端 SessionHub 每 30s 推一帧应用层心跳
 * （协议级 ping 浏览器 JS 不可见），90s 无任何入站 ≈ 连丢三帧。
 */
const STALE_AFTER_MS = 90_000;
const LIVENESS_CHECK_MS = 30_000;

export class AuthedWsTransport implements RpcTransport {
  #ws: WebSocket | null = null;
  #linkState: AuthedLinkState = 'connecting';
  #stateHandlers = new Set<(state: AuthedLinkState) => void>();
  #dataHandler: ((data: unknown) => void) | null = null;
  #backoffMs = 1_000;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  #lastInboundAt = 0;
  #livenessTimer: ReturnType<typeof setInterval> | null = null;
  #boundVisibility = false;
  #boundOnline = false;

  constructor() {
    // 前台自愈（审查 P2）：NAT 半开/TCP 黑洞下 ws 不抛 close，只能靠「该有
    // 心跳却没有」主动判死。visibilitychange 拿回前台时立刻查，interval 兜住
    // 一直开着的前台页；online 事件顺带把退避重连提前。node 测试环境无 DOM，
    // 监听按存在性绑定。
    this.#livenessTimer = setInterval(() => this.#checkLiveness(), LIVENESS_CHECK_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibility);
      this.#boundVisibility = true;
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.#onOnline);
      this.#boundOnline = true;
    }
  }

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
      this.#lastInboundAt = Date.now();
      this.#setLinkState('connected');
    };
    ws.onmessage = (event) => {
      this.#lastInboundAt = Date.now();
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
    if (this.#livenessTimer !== null) {
      clearInterval(this.#livenessTimer);
      this.#livenessTimer = null;
    }
    if (this.#boundVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibility);
      this.#boundVisibility = false;
    }
    if (this.#boundOnline && typeof window !== 'undefined') {
      window.removeEventListener('online', this.#onOnline);
      this.#boundOnline = false;
    }
    this.#ws?.close(1000, 'client close');
    this.#ws = null;
  }

  readonly #onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.#checkLiveness();
    }
  };

  readonly #onOnline = (): void => {
    if (this.#closed) return;
    if (this.#linkState === 'reconnecting') this.connectNow();
    else this.#checkLiveness();
  };

  /**
   * 连接看着还开着、但按心跳早就该有入站：多半是 NAT 半开（移动网络换基站 /
   * 路由器重启），等操作系统发现要几分钟到半小时。主动断开走正常重连路径
   * （whoami 探测 + 退避），前台用户几乎无感。
   */
  #checkLiveness(): void {
    if (this.#closed || this.#ws === null || this.#linkState !== 'connected') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (Date.now() - this.#lastInboundAt < STALE_AFTER_MS) return;
    this.#lastInboundAt = Date.now(); // 防重入：close→重连期间不再触发
    this.#ws.close(4000, 'stale connection');
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

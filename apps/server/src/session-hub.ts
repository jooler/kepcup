import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { RELAY_MAX_FRAME_BYTES, RPC_EVENT_NAMES, type RpcMethodSpec } from '@kepcup/shared';
import {
  createRpcServer,
  LOCAL_ONLY_METHODS,
  withRemoteSource,
  type CoreLogger,
  type CoreServices,
  type RpcServerHandle,
} from '@kepcup/core';
import type { AuthStore } from './auth.js';
import { sessionTokenFromCookie } from './auth.js';

/**
 * 会话端点（D102 修订：账号密码直连）：`/rpc` 的 WS 升级凭会话 Cookie 认证，
 * 每条连接绑定一个 createRpcServer + 同一份 appMethods——与 RemoteHub 端点同一
 * 模式，只是信任模型不同：配对模式的 E2E 帧协议面向「不可信中转」，这里是
 * 「用户刚输过密码的直连」，birpc JSON 明文跑在（反代 TLS 的）WS 上，审计标记
 * `remote:session-<user>`，secrets 卫生规则与其余远程端点一致。
 */

const MAX_SESSIONS = 8;
const WS_PING_INTERVAL_MS = 30_000;
/** 与 RemoteHub 相同的高频事件合流策略（run.progress ≤10Hz、保留最新）。 */
const COALESCED_EVENTS = new Set(['run.progress']);
const COALESCE_FLUSH_MS = 100;

interface SessionConnection {
  username: string;
  ws: WebSocket;
  server: RpcServerHandle;
  unsubscribers: Array<() => void>;
  coalesced: Map<string, { name: string; payload: unknown }>;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
}

export interface SessionHubOptions {
  httpServer: HttpServer;
  services: CoreServices;
  auth: AuthStore;
  logger: CoreLogger;
}

export class SessionHub {
  readonly #wss: WebSocketServer;
  readonly #services: CoreServices;
  readonly #auth: AuthStore;
  readonly #logger: CoreLogger;
  readonly #sessions = new Set<SessionConnection>();
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SessionHubOptions) {
    // 帧上限交给 ws 在缓冲期拒绝（审查修复：原先默认 100MiB，已认证连接也不该能打内存）。
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES });
    this.#services = options.services;
    this.#auth = options.auth;
    this.#logger = options.logger;
  }

  /** server.ts 在 upgrade 事件里按路径分流进来。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // CSWSH 纵深（审查修复 P1）：与 direct-relay 同款——浏览器跨站握手即使带着
    // Cookie 也拒（SameSite=Lax 之外的防线）；Origin 缺省放行（非浏览器客户端）。
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let sameOrigin: boolean;
      try {
        sameOrigin = new URL(origin).host === (req.headers.host ?? '');
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const token = sessionTokenFromCookie(req.headers.cookie) ?? bearer?.[1];
    const session = token !== undefined ? this.#auth.verifyToken(token) : null;
    if (session === null) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (this.#sessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#attach(ws, session.username));
  }

  #attach(ws: WebSocket, username: string): void {
    (ws as WebSocket & { alive?: boolean }).alive = true;
    if (this.#pingTimer === null) {
      this.#pingTimer = setInterval(() => this.#pingSweep(), WS_PING_INTERVAL_MS);
      this.#pingTimer.unref?.();
    }
    ws.on('pong', () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });

    const services = this.#services;
    const connection: SessionConnection = {
      username,
      ws,
      server: null as never,
      unsubscribers: [],
      coalesced: new Map(),
      coalesceTimer: null,
    };
    // 与 RemoteHub 端点同一份 handlers + 远程来源审计标记 + 本机专用方法剔除。
    const methods: Record<string, RpcMethodSpec> = {};
    for (const [name, spec] of Object.entries(services.appMethods)) {
      if (LOCAL_ONLY_METHODS.has(name)) continue;
      methods[name] = {
        ...spec,
        handle: (input) => withRemoteSource(sessionAuditId(username), () => spec.handle(input)),
      };
    }
    connection.server = createRpcServer({
      transport: {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        onData: (handler) => {
          const listener = (raw: unknown): void => {
            // ws 的 message 事件给 Buffer（direct-relay 同款转换）。
            const text = typeof raw === 'string' ? raw : String(raw);
            try {
              handler(JSON.parse(text));
            } catch {
              // 客户端发了非 JSON：忽略单帧（birpc 请求 id 缺失时对端自行超时）。
            }
          };
          ws.on('message', listener);
          return () => ws.off('message', listener);
        },
        close: () => ws.close(1000, 'session closed'),
      },
      methods,
      onError: (method, error) => {
        this.#logger.warn({ user: username, method, code: error.code }, 'session rpc failed');
      },
    });

    // 事件扇出（RPC_EVENT_NAMES 全量 + run.progress 合流）：与 RemoteHub 同款契约。
    for (const name of RPC_EVENT_NAMES) {
      connection.unsubscribers.push(
        services.events.on(name, (payload) => {
          this.#fanOut(connection, name, payload);
        }),
      );
    }
    // 状态快照先行（App 等 core.status 才开始加载数据，同 pushInitialEventsTo）。
    services.pushStatusTo(connection.server);
    services.pushPlatformStateTo(connection.server);

    this.#sessions.add(connection);
    this.#logger.info({ user: username, sessions: this.#sessions.size }, 'session connected');

    ws.on('close', () => this.#detach(connection));
    ws.on('error', () => {
      // error 后必有 close；close 里清理。
    });
  }

  #detach(connection: SessionConnection): void {
    if (!this.#sessions.delete(connection)) return;
    for (const unsubscribe of connection.unsubscribers) unsubscribe();
    if (connection.coalesceTimer !== null) clearTimeout(connection.coalesceTimer);
    try {
      connection.server.close();
    } catch {
      // 关闭中的 birpc 再关会抛，忽略。
    }
    this.#logger.info({ user: connection.username, sessions: this.#sessions.size }, 'session closed');
  }

  #fanOut(connection: SessionConnection, name: string, payload: unknown): void {
    if (!COALESCED_EVENTS.has(name)) {
      connection.server.pushEvent(name, payload);
      return;
    }
    const discriminator =
      typeof payload === 'object' && payload !== null && 'runId' in payload
        ? String((payload as { runId: unknown }).runId)
        : '';
    connection.coalesced.set(`${name}:${discriminator}`, { name, payload });
    if (connection.coalesceTimer === null) {
      connection.coalesceTimer = setTimeout(() => {
        connection.coalesceTimer = null;
        const pending = [...connection.coalesced.values()];
        connection.coalesced.clear();
        for (const entry of pending) {
          connection.server.pushEvent(entry.name, entry.payload);
        }
      }, COALESCE_FLUSH_MS);
    }
  }

  /** ws 协议级心跳：穿透反代的死连接检测（浏览器自动回 pong）。 */
  #pingSweep(): void {
    for (const { ws } of this.#sessions) {
      const tagged = ws as WebSocket & { alive?: boolean };
      if (tagged.alive === false) {
        ws.terminate();
        continue;
      }
      tagged.alive = false;
      try {
        ws.ping();
      } catch {
        // 已断开的 socket ping 抛错：close 事件会清理。
      }
    }
  }

  close(): void {
    if (this.#pingTimer !== null) {
      clearInterval(this.#pingTimer);
      this.#pingTimer = null;
    }
    for (const connection of [...this.#sessions]) this.#detach(connection);
    this.#wss.close();
  }

  /** 测试 / 诊断。 */
  sessionCount(): number {
    return this.#sessions.size;
  }
}

/** 审计标记：与 D96 的 remote:{deviceId} 同一命名空间，肉眼可区分会话来源。 */
function sessionAuditId(username: string): `session-${string}` {
  const sanitized = username.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'user';
  const padded = sanitized.padEnd(12, '-');
  return `session-${padded}` as `session-${string}`;
}

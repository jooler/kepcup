import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFileKeystore,
  createCoreServices,
  type CoreLogger,
  type CoreServices,
  type Keystore,
} from '@kepcup/core';
import { AppError, pluginsInspectInputSchema, pluginsInstallInputSchema } from '@kepcup/shared';
import { handleAdminRequest, isAdminPath, readJson, type AdminDeps } from './admin.js';
import { builtinPluginsEnv } from './builtin-plugins.js';
import { DirectRelayServer } from './direct-relay.js';
import { qrTerminal } from './qr.js';
import { resolveWebDir, serveStatic } from './static.js';
import {
  AuthError,
  AuthStore,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  sessionTokenFromCookie,
} from './auth.js';
import { SessionHub } from './session-hub.js';
import type { ServerConfig } from './config.js';

/**
 * headless 服务端装配（D102 §3）：`createCoreServices`（与桌面同一个 core，纯
 * Node）+ 直连监听 + admin 接口 + PWA 静态托管，单端口三职责。桌面路径零改动。
 */

export interface HeadlessServerTestOptions {
  /** 测试注入（等价 createCore 的测试环境：NODE_ENV=test 等）。 */
  env?: NodeJS.ProcessEnv;
  keystore?: Keystore;
  /** 测试注入：SessionHub 心跳/清扫间隔（生产 30s）。 */
  pingIntervalMs?: number;
}

export interface HeadlessServer {
  config: ServerConfig;
  /** 实际监听端口（--port 0 时为系统分配值，publicUrl/config 已同步改写）。 */
  port: number;
  services: CoreServices;
  httpServer: HttpServer;
  directRelay: DirectRelayServer | null;
  /** 账号密码模式的会话端点（/rpc）；pairing 模式为 null。 */
  sessionHub: SessionHub | null;
  auth: AuthStore;
  /** 首配自动出码 / auto-accept 循环（有设备后自停）。 */
  stopPairingFlow(): void;
  close(): Promise<void>;
}

export function serverVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

function readOrCreateAdminToken(dataDir: string): string {
  const file = path.join(dataDir, 'admin-token');
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (token.length > 0) return token;
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export async function createHeadlessServer(
  config: ServerConfig,
  test: HeadlessServerTestOptions = {},
): Promise<HeadlessServer> {
  mkdirSync(config.dataDir, { recursive: true });
  const keystore =
    test.keystore !== undefined
      ? test.keystore
      : config.keystore === 'file'
        ? createFileKeystore(path.join(config.dataDir, 'master-key'))
        : undefined;

  // 账号密码模式：管理员账号在 core 起来之前就绪（首启交互建号由 CLI 层完成；
  // 这里兜底非交互参数，两者都没有则报错退出——不能带着「任何人可登录」的状态起服务）。
  const auth = new AuthStore(config.dataDir);
  const passwordMode = config.relayUrl === null && config.auth === 'password';
  if (passwordMode && !auth.isConfigured()) {
    if (config.adminUser === null || config.adminPassword === null) {
      throw new Error(
        '管理员账号未初始化：交互式终端首启会提示输入；非交互场景（systemd）用 ' +
          '--admin-user/--admin-password 或环境变量 KEPCUP_SERVER_ADMIN_USER/_PASSWORD',
      );
    }
    await auth.setupAdmin(config.adminUser, config.adminPassword);
  }

  // 三种形态（审查修复 P1 重排）：直连配对（本地监听 + direct 工厂）/ 中转出站
  // （--relay：原生 RelayClient 外连，不建本地监听、不注入工厂——工厂存在则 hub
  // 永远不会 new RelayClient，该模式会被直连适配层劫持成死路）/ 账号密码（不走
  // RemoteHub）。直连工厂在 core ready 后才就绪，引用先占位；headless 二次启动时
  // hub.start() 早于占位赋值调工厂，由 hub 侧 #scheduleSync 兜底 + 下面的显式
  // syncConfig 补建。
  const pairingDirect = config.relayUrl === null && config.auth === 'pairing';
  const relayOutbound = config.relayUrl !== null;
  let directRelay: DirectRelayServer | null = null;
  const services = await createCoreServices({
    home: config.dataDir,
    // D104 P0b（Q9）：打包布局里 plugins/ 与 dist/ 同级，未显式设置时注入；
    // 开发态 / 已显式设置时原样透传（repo 检出由 core 自己向上查找）。
    env: builtinPluginsEnv(path.dirname(fileURLToPath(import.meta.url)), test.env ?? process.env),
    appVersion: serverVersion(),
    ...(keystore !== undefined ? { keystore } : {}),
    ...(pairingDirect
      ? {
          remote: {
            alwaysOn: true,
            relayClientFactory: (options) => {
              if (directRelay === null) {
                throw new Error('direct relay server not ready');
              }
              return directRelay.createAdapter(options);
            },
          },
        }
      : {}),
    // --relay：alwaysOn 常驻外连，无工厂。
    ...(relayOutbound ? { remote: { alwaysOn: true } } : {}),
  });
  if (services.status !== 'ready' || services.remote === null || services.domain === null) {
    await services.close().catch(() => {});
    throw new Error(
      `core 未就绪：${services.status}${services.statusReason ? `（${services.statusReason}）` : ''}`,
    );
  }
  const logger = services.logger;

  // 平台事件（通知 / 托盘镜像）无宿主可送：落结构化日志。
  services.events.on('platform.notify', (payload) => {
    logger.info({ notify: payload }, 'platform.notify');
  });

  const adminToken = readOrCreateAdminToken(config.dataDir);
  const hub = services.remote;
  const adminDeps: AdminDeps = {
    token: adminToken,
    pair: () => hub.createPairing(),
    status: () => hub.status(),
    pendingRequests: () => hub.status().pendingPairing,
    confirmPairing: (requestId, accept) => hub.confirmPairing(requestId, accept),
    devices: () => hub.devices(),
    revoke: (deviceId) => hub.revokeDevice(deviceId),
    // D104 P2：直接调 appMethods 的 handle，不经 RPC 层，因此 currentRemoteSource() 为
    // null，file / folder 来源被允许——调用者在服务器本机且持有 admin token。
    pluginsInspect: (body) => {
      const method = services.appMethods['plugins.inspect'];
      if (method === undefined) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
      return method.handle(pluginsInspectInputSchema.parse(body));
    },
    pluginsInstall: (body) => {
      const method = services.appMethods['plugins.install'];
      if (method === undefined) throw new AppError('NOT_IMPLEMENTED', '插件模块未就绪');
      return method.handle(pluginsInstallInputSchema.parse(body));
    },
  };

  const webDir = resolveWebDir(config.webDir);
  let sessionHub: SessionHub | null = null;
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (isAdminPath(url.pathname)) {
      handleAdminRequest(adminDeps, req, res, url.pathname);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      // /api/* 只认 auth 路由（密码模式）；pairing 模式没有 auth API，给 404
      //（客户端据此识别服务器认证模型），不能落进 SPA 回退（那会 200 返回 index.html）。
      if (passwordMode) {
        handleAuthRequest(auth, logger, config.trustProxy, req, res, url.pathname);
      } else {
        res
          .writeHead(404, {
            'content-type': 'application/json; charset=utf-8',
            'x-content-type-options': 'nosniff',
          })
          .end('{"error":"not_found"}');
      }
      return;
    }
    if (webDir !== null) {
      serveStatic(webDir, url.pathname, res);
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      .end('kepcup-server is running. Web UI not bundled in this install (pass --web-dir).\n');
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (passwordMode) {
      if (url.pathname === '/rpc' && sessionHub !== null) {
        sessionHub.handleUpgrade(req, socket, head);
        return;
      }
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (directRelay !== null) {
      directRelay.handleUpgrade(req, socket, head);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  if (pairingDirect) {
    const relay = new DirectRelayServer({ httpServer, logger, clock: services.clock });
    directRelay = relay;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  // --port 0（测试 / 临时实例）：系统分配端口后同步推导地址（显式 --public-url 不改）。
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.port;
  if (actualPort !== config.port && !config.publicUrlExplicit && config.relayUrl === null) {
    config.port = actualPort;
    config.publicUrl = `ws://${config.host}:${actualPort}`;
  }

  let pairingFlow: { stop(): void } = { stop: () => {} };
  if (pairingDirect || relayOutbound) {
    // headless 的服务端配置是唯一事实来源：强制开远程、指向本服务（或 --relay）。
    // 直接调 settings.update 不经 RPC 层、不广播 settings.changed，所以要像
    // hub.configSet 一样显式重估 → 建连（直连=工厂挂本地监听；--relay=原生
    // RelayClient 外连；alwaysOn：此后不再按需断线）。
    services.domain.settings.update({
      remoteEnabled: true,
      remoteRelayUrl: config.relayUrl ?? config.publicUrl,
    });
    void hub.syncConfig().catch((error) => {
      logger.warn({ error: String(error) }, 'remote: 启动重估失败（稍后由下一次同步自愈）');
    });
  }
  if (pairingDirect) {
    pairingFlow = startPairingFlow(config, services);
  } else if (!relayOutbound) {
    // 密码模式：会话端点直连 appMethods，RemoteHub 保持关（零连接零端点）。
    sessionHub = new SessionHub({
      httpServer,
      services,
      auth,
      logger,
      ...(test.pingIntervalMs !== undefined ? { pingIntervalMs: test.pingIntervalMs } : {}),
    });
  }

  const bound = config.port;
  logger.info(
    { host: config.host, port: bound, publicUrl: config.publicUrl, relay: config.relayUrl, webDir },
    `kepcup-server ${serverVersion()} listening on ${config.host}:${bound}`,
  );

  return {
    config,
    port: bound,
    services,
    httpServer,
    directRelay,
    sessionHub,
    auth,
    stopPairingFlow: pairingFlow.stop,
    async close() {
      pairingFlow.stop();
      // 顺序：先关会话/直连（关闭路径要写日志），再关 core（销毁 pino 流）。
      if (directRelay !== null) directRelay.close();
      sessionHub?.close();
      await services.close().catch(() => {});
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}

/**
 * 客户端 IP（限流 / 登录审计用）：--trust-proxy 时取 X-Forwarded-For 首段
 * （直连客户端；后面的段是代理链，可被伪造的头部只有显式开启才信任），
 * 否则一律用 socket 地址——反代直连场景下所有请求同 IP，限流本就按部署形态
 * 该收紧而不是默认放水。
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    const trimmed = first?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * 账号密码 API（D102 修订，仅 password 模式挂载）：
 * - POST /api/auth/login {username,password} → Set-Cookie(kepcup_session, HttpOnly,
 *   30d) + {ok,username,token}；失败 401（限流 429）。token 也可作 Bearer 用（脚本）。
 * - POST /api/auth/logout → 清 Cookie。
 * - GET  /api/auth/whoami → 200 {username} / 401；pairing 模式服务器无此路由（404），
 *   客户端据此识别认证模型。
 */
function handleAuthRequest(
  auth: AuthStore,
  logger: CoreLogger,
  trustProxy: boolean,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const send = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
    res
      .writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        ...headers,
      })
      .end(JSON.stringify(body));
  };
  const secure =
    (req.socket as { encrypted?: boolean }).encrypted === true ||
    req.headers['x-forwarded-proto'] === 'https';
  if (pathname === '/api/auth/whoami' && req.method === 'GET') {
    const session = auth.verifyToken(sessionTokenFromCookie(req.headers.cookie));
    if (session === null) {
      send(401, { mode: 'password', error: 'unauthenticated' });
      return;
    }
    send(200, { mode: 'password', username: session.username });
    return;
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    void readJson(req)
      .then(async (body) => {
        const username = String((body as { username?: unknown }).username ?? '');
        const password = String((body as { password?: unknown }).password ?? '');
        const ip = clientIp(req, trustProxy);
        const token = await auth.login(username, password, ip);
        // 审计（审查修复：爆破无痕）：只记 IP 与结果，凭据不落日志。
        logger.info({ ip, user: auth.username }, 'admin login ok');
        const cookie =
          `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SEC}; ` +
          `HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
        send(200, { ok: true, username: auth.username, token }, { 'set-cookie': cookie });
      })
      .catch((error) => {
        if (error instanceof AuthError) {
          logger.warn({ ip: clientIp(req, trustProxy), code: error.code }, 'admin login failed');
          const headers: Record<string, string> =
            error.code === 'RATE_LIMITED' && error.retryAfterSec !== undefined
              ? { 'retry-after': String(error.retryAfterSec) }
              : {};
          send(error.code === 'RATE_LIMITED' ? 429 : 401, { error: error.code }, headers);
          return;
        }
        send(400, { error: 'bad_request' });
      });
    return;
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    send(200, { ok: true }, { 'set-cookie': cookie });
    return;
  }
  send(404, { mode: 'password', error: 'not_found' });
}

/**
 * 首配自动化（D102 §3.3）：无已配对设备时循环出码（5 分钟过期自动续）并打印
 * URL + 终端二维码；默认 auto-accept（16B 一次性配对码即带外授权，持码者 ≡
 * 管理员）；--pairing-manual 时只打印待确认请求，由 `pair --accept` 人工确认。
 * 首台设备配对成功即自停（后续出码走 `kepcup-server pair` / admin）。
 */
function startPairingFlow(config: ServerConfig, services: CoreServices): { stop(): void } {
  if (!config.autoPair) return { stop: () => {} };
  const hub = services.remote;
  if (hub === null) return { stop: () => {} };
  const log = (...args: unknown[]) => console.log('[pair]', ...args);
  let stopped = false;
  let offerTimer: ReturnType<typeof setTimeout> | null = null;
  let acceptTimer: ReturnType<typeof setInterval> | null = null;

  const armOffer = (): void => {
    if (stopped) return;
    if (hub.devices().devices.length > 0) {
      stop();
      return;
    }
    const offer = hub.createPairing();
    log('配对码已生成，用手机扫码或打开链接（5 分钟内有效，一次性）：\n');
    console.log(qrTerminal(offer.url));
    console.log(`\n    ${offer.url}\n`);
    if (!config.pairingManual) {
      log('auto-accept 已开启：持码连接将自动确认。');
    } else {
      log('手动确认模式：新请求出现在下方，用 `kepcup-server pair --accept <requestId>` 确认。');
    }
    offerTimer = setTimeout(armOffer, Math.max(60_000, offer.expiresAt - Date.now() + 1_000));
    offerTimer.unref?.();
  };

  function stop(): void {
    stopped = true;
    if (offerTimer !== null) clearTimeout(offerTimer);
    if (acceptTimer !== null) clearInterval(acceptTimer);
  }

  if (!config.pairingManual) {
    acceptTimer = setInterval(() => {
      if (stopped) return;
      const pending = hub.status().pendingPairing;
      for (const request of pending) {
        const outcome = hub.confirmPairing(request.requestId, true);
        log(
          outcome.status === 'paired'
            ? `已自动接受配对：${request.deviceName}（${request.deviceId}）`
            : `配对确认结果：${outcome.status}（${request.deviceName}）`,
        );
        if (hub.devices().devices.length > 0) stop();
      }
    }, 500);
    acceptTimer.unref?.();
  }

  armOffer();
  return { stop };
}

/** CLI run 子命令：起服务 + 信号处理。 */
export async function runServer(config: ServerConfig): Promise<void> {
  const server = await createHeadlessServer(config);
  const shutdown = (signal: string) => {
    console.log(`\n收到 ${signal}，正在关闭…`);
    void server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // 常驻进程兜底（审查修复）：未捕获的 rejection 落日志而不是崩进程——
  // systemd 下崩溃即重启循环，一次可诊断的 error 日志更有用。
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
  console.log(`数据目录：${config.dataDir}`);
  // 认证模型决定管理命令（审查修复）：pair/devices 只在配对模式有意义，
  // 密码模式的 pair 会被 hub 以 INVALID_STATE 拒绝，不能误导用户。
  if (config.relayUrl === null && config.auth === 'password') {
    console.log('管理命令：kepcup-server password（修改管理员密码，本机执行）');
  } else {
    console.log(`管理命令：kepcup-server pair / devices（本机 127.0.0.1:${config.port}）`);
  }
}

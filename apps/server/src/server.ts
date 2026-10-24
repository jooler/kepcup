import { createServer, type Server as HttpServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createFileKeystore, createCoreServices, type CoreServices, type Keystore } from '@kepcup/core';
import { handleAdminRequest, isAdminPath, type AdminDeps } from './admin.js';
import { DirectRelayServer } from './direct-relay.js';
import { qrTerminal } from './qr.js';
import { resolveWebDir, serveStatic } from './static.js';
import type { ServerConfig } from './config.js';

/**
 * headless 服务端装配（D102 §3）：`createCoreServices`（与桌面同一个 core，纯
 * Node）+ 直连监听 + admin 接口 + PWA 静态托管，单端口三职责。桌面路径零改动。
 */

export interface HeadlessServerTestOptions {
  /** 测试注入（等价 createCore 的测试环境：NODE_ENV=test 等）。 */
  env?: NodeJS.ProcessEnv;
  keystore?: Keystore;
}

export interface HeadlessServer {
  config: ServerConfig;
  /** 实际监听端口（--port 0 时为系统分配值，publicUrl/config 已同步改写）。 */
  port: number;
  services: CoreServices;
  httpServer: HttpServer;
  directRelay: DirectRelayServer | null;
  /** 首配自动出码 / auto-accept 循环（有设备后自停）。 */
  stopPairingFlow(): void;
  close(): Promise<void>;
}

export function serverVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
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

  // 直连适配层在 core ready 后才建（要 logger/clock），工厂在 hub 建连时才被调，
  // 而那只会发生在我们打开 remoteEnabled 之后——引用先占位。
  let directRelay: DirectRelayServer | null = null;
  const services = await createCoreServices({
    home: config.dataDir,
    env: test.env ?? process.env,
    appVersion: serverVersion(),
    ...(keystore !== undefined ? { keystore } : {}),
    remote: {
      alwaysOn: true,
      ...(config.relayUrl === null
        ? {
            relayClientFactory: (options) => {
              if (directRelay === null) {
                throw new Error('direct relay server not ready');
              }
              return directRelay.createAdapter(options);
            },
          }
        : {}),
    },
  });
  if (services.status !== 'ready' || services.remote === null || services.domain === null) {
    await services.close().catch(() => {});
    throw new Error(`core 未就绪：${services.status}${services.statusReason ? `（${services.statusReason}）` : ''}`);
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
  };

  const webDir = resolveWebDir(config.webDir);
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (isAdminPath(url.pathname)) {
      handleAdminRequest(adminDeps, req, res, url.pathname);
      return;
    }
    if (webDir !== null) {
      serveStatic(webDir, url.pathname, res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(
      'kepcup-server is running. Web UI not bundled in this install (pass --web-dir).\n',
    );
  });

  if (config.relayUrl === null) {
    const relay = new DirectRelayServer({ httpServer, logger, clock: services.clock });
    directRelay = relay;
    httpServer.on('upgrade', (req, socket, head) => relay.handleUpgrade(req, socket, head));
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

  // headless 的服务端配置是唯一事实来源：强制开远程、指向本服务（或 --relay）。
  // 直接调 settings.update 不经 RPC 层、不广播 settings.changed，所以要像
  // hub.configSet 一样显式重估 → 工厂建连（alwaysOn：此后不再按需断线）。
  services.domain.settings.update({
    remoteEnabled: true,
    remoteRelayUrl: config.relayUrl ?? config.publicUrl,
  });
  void hub.syncConfig();

  const pairingFlow = startPairingFlow(config, services);

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
    stopPairingFlow: pairingFlow.stop,
    async close() {
      pairingFlow.stop();
      await services.close().catch(() => {});
      if (directRelay !== null) directRelay.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
    },
  };
}

/**
 * 首配自动化（D102 §3.3）：无已配对设备时循环出码（5 分钟过期自动续）并打印
 * URL + 终端二维码；默认 auto-accept（16B 一次性配对码即带外授权，持码者 ≡
 * 管理员）；--pairing-manual 时只打印待确认请求，由 `pair --accept` 人工确认。
 * 首台设备配对成功即自停（后续出码走 `kepcup-server pair` / admin）。
 */
function startPairingFlow(
  config: ServerConfig,
  services: CoreServices,
): { stop(): void } {
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
  console.log(`数据目录：${config.dataDir}`);
  console.log(`管理命令：kepcup-server pair / devices（本机 127.0.0.1:${config.port}）`);
}

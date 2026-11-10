import type { RpcTransport } from '@kepcup/shared';
import {
  createRpcChannel,
  PLATFORM_EVENT_NAMES,
  RPC_EVENT_NAMES,
  type RpcChannel,
  type RpcMethodSpec,
} from '@kepcup/shared';
import { createCoreServices, type CoreServicesOptions } from './start.js';
import { createRpcServer } from './rpc/server.js';
import { AppPortRegistry } from './app-port-registry.js';
import { withClientIdentityBinding } from './collab/identity-binding.js';

/** Structural subset of Electron's MessagePortMain (core does not import Electron). */
export interface ElectronPortLike {
  postMessage(data: unknown): void;
  on(event: 'message' | 'close', listener: (event: { data: unknown }) => void): unknown;
  start(): void;
  close(): void;
}

/** Structural subset of the utilityProcess parentPort. */
export interface ParentPortLike {
  on(
    event: 'message',
    listener: (event: { data?: unknown; ports?: ElectronPortLike[] }) => void,
  ): unknown;
}

export function electronPortToTransport(port: ElectronPortLike): RpcTransport {
  return {
    post: (data) => port.postMessage(data),
    onData: (handler) => {
      port.on('message', (event) => handler(event.data));
      return () => {};
    },
    close: () => port.close(),
  };
}

export interface StartCoreProcessOptions extends CoreServicesOptions {
  /**
   * Exit the process after `system.shutdown`. Enabled by the real core entry;
   * disabled when embedded elsewhere.
   */
  exitOnShutdown?: boolean;
}

/**
 * Entry point for the Electron utilityProcess. Boots the core services, then
 * binds RPC servers to the two ports the main process hands over:
 * `app-port` (renderer traffic, port A) and `platform-port` (main process, port B).
 * 端口 A 是多客户端（组件「在新窗口打开」，todo/bot-micro-app-platform/widget-window.md
 * §4.1）：主窗口 + 组件窗口各持一个 app-port；旧端口在渲染窗口销毁 / reload 时自然
 * `close`，由 close 回调出清——与旧「fresh replaces previous」等效（reload 的旧端口必关）。
 */
export function startCoreProcess(options: StartCoreProcessOptions = {}): void {
  const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;
  if (!parentPort) {
    throw new Error('startCoreProcess must run inside an Electron utilityProcess');
  }

  const servicesPromise = createCoreServices({
    home: options.home,
    env: options.env ?? process.env,
    appVersion: options.appVersion,
    dev: options.dev ?? process.env.NODE_ENV !== 'production',
  });

  let appPorts: AppPortRegistry | null = null;
  let platformServer: RpcChannel | null = null;
  let eventsWired = false;

  /** Bridges core-event-bus emissions to the current app-port client. */
  function wireEventBridge(services: Awaited<typeof servicesPromise>): void {
    if (eventsWired) return;
    eventsWired = true;
    for (const name of RPC_EVENT_NAMES) {
      services.events.on(name, (payload) => {
        appPorts?.pushEvent(name, payload, (error) => {
          services.logger.warn({ event: name, error: String(error) }, 'app-port event push failed');
        });
      });
    }
    // Platform events (notifications, tray state) ride the bus to port B.
    for (const name of PLATFORM_EVENT_NAMES) {
      services.events.on(name as never, (payload) => {
        platformServer?.pushEvent(name, payload);
      });
    }
  }

  parentPort.on('message', (message) => {
    const port = message.ports?.[0];
    const type = (message.data as { type?: string } | undefined)?.type;
    if (!port) return;
    port.start();
    const transport = electronPortToTransport(port);

    void servicesPromise.then((services) => {
      wireEventBridge(services);
      if (type === 'app-port') {
        appPorts ??= new AppPortRegistry();
        // D119/D120：记录该 app-port 上出现的客户端身份，端口关闭时清在线状态
        // 与草稿租约；同一连接绑定首个 clientId。
        let boundClientId: string | null = null;
        const presenceConnections = new Map<string, string>();
        const appMethods = withClientIdentityBinding(services.appMethods, {
          get boundClientId() {
            return boundClientId;
          },
          bindClient: (clientId, connectionId) => {
            boundClientId = clientId;
            if (connectionId !== null) presenceConnections.set(clientId, connectionId);
          },
        });
        const server = appPorts.bind({
          createServer: () =>
            createRpcServer({
              transport,
              methods: appMethods,
              // The renderer only sees the envelope (and often maps the code to a
              // generic i18n string): log every failed call here so the full
              // message / details land in logs/kepcup.log.
              onError: (method, error) => {
                const record = {
                  method,
                  code: error.code,
                  error: error.message,
                  details: error.details,
                };
                if (error.code === 'INTERNAL') services.logger.error(record, 'rpc method failed');
                else services.logger.warn(record, 'rpc method rejected');
              },
            }),
          onBound: (bound) => services.pushStatusTo(bound),
        });
        // 渲染窗口销毁 / reload 后旧端口自然关闭：出清对应 server（不再主动 close 旧绑定）。
        port.on('close', () => {
          appPorts?.remove(server);
          for (const [clientId, connectionId] of presenceConnections) {
            services.collabPresence.leave({ clientId, connectionId });
            services.collabDrafts?.releaseClientConnection(clientId, connectionId);
          }
          if (boundClientId !== null && presenceConnections.size === 0) {
            services.collabDrafts?.releaseClient(boundClientId);
          }
          presenceConnections.clear();
          services.logger.info('app port unbound');
        });
        services.logger.info('app port bound');
      } else if (type === 'platform-port') {
        platformServer?.close();
        // One channel serves the core's platform methods (system.shutdown /
        // power.*) AND calls the main process's browser.* methods (P11).
        platformServer = createRpcChannel({
          transport,
          methods: platformMethods(services, options),
        });
        services.browserRpc.bind(platformServer);
        // D73: …and shell.openExternal (OAuth consent page in the system browser).
        services.shellRpc.bind(platformServer);
        // D87 P3b: …and widgetPreview.run (S2 of the widget authoring loop).
        services.widgetPreviewRpc.bind(platformServer);
        // D105: …and computer.* (computer-use orchestration in the main process).
        services.computerRpc.bind(platformServer);
        // The main process creates the window once it sees a terminal status.
        services.pushStatusTo(platformServer);
        // P13 任务 3: the main process reconciles the OS login item with the
        // stored launch-at-login setting on every (re)bind.
        services.pushPlatformStateTo(platformServer);
        services.logger.info('platform port bound');
      }
    });
  });
}

function platformMethods(
  services: Awaited<ReturnType<typeof createCoreServices>>,
  options: StartCoreProcessOptions,
): Record<string, RpcMethodSpec> {
  const shutdown = services.platformMethods['system.shutdown'];
  if (!shutdown) return services.platformMethods;
  if (options.exitOnShutdown === false) return services.platformMethods;
  return {
    ...services.platformMethods,
    'system.shutdown': {
      ...shutdown,
      handle: async () => {
        const result = await shutdown.handle(undefined);
        // Let the RPC response flush before exiting.
        setTimeout(() => process.exit(0), 100).unref();
        return result;
      },
    },
  };
}

import type { RpcTransport } from '@kepcup/shared';
import {
  createRpcChannel,
  PLATFORM_EVENT_NAMES,
  RPC_EVENT_NAMES,
  type RpcChannel,
  type RpcMethodSpec,
} from '@kepcup/shared';
import { createCoreServices, type CoreServicesOptions } from './start.js';
import { createRpcServer, type RpcServerHandle } from './rpc/server.js';

/** Structural subset of Electron's MessagePortMain (core does not import Electron). */
export interface ElectronPortLike {
  postMessage(data: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
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
 * A fresh `app-port` (renderer reload) replaces the previous binding.
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

  let appServer: RpcServerHandle | null = null;
  let platformServer: RpcChannel | null = null;
  let eventsWired = false;

  /** Bridges core-event-bus emissions to the current app-port client. */
  function wireEventBridge(services: Awaited<typeof servicesPromise>): void {
    if (eventsWired) return;
    eventsWired = true;
    for (const name of RPC_EVENT_NAMES) {
      services.events.on(name, (payload) => {
        appServer?.pushEvent(name, payload);
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
        appServer?.close();
        appServer = createRpcServer({
          transport,
          methods: services.appMethods,
          // The renderer only sees the envelope (and often maps the code to a
          // generic i18n string): log every failed call here so the full
          // message / details land in logs/kepcup.log.
          onError: (method, error) => {
            const record = { method, code: error.code, error: error.message, details: error.details };
            if (error.code === 'INTERNAL') services.logger.error(record, 'rpc method failed');
            else services.logger.warn(record, 'rpc method rejected');
          },
        });
        services.pushStatusTo(appServer);
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

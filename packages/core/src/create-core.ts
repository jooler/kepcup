import { MessageChannel } from 'node:worker_threads';
import {
  createRpcClient,
  RPC_EVENT_NAMES,
  type RpcClient,
  systemInfoOutputSchema,
  systemPingOutputSchema,
  type SystemInfoOutput,
  type SystemPingOutput,
  type CoreStatusPayload,
  type RpcEventName,
  type RpcEventPayload,
} from '@kepcup/shared';
import type { RpcTransport } from '@kepcup/shared';
import { createCoreServices, type CoreServices, type CoreServicesOptions } from './start.js';
import { createRpcServer } from './rpc/server.js';

type NodeMessagePort = typeof MessageChannel.prototype.port1;

export interface CoreHarness {
  services: CoreServices;
  rpc: RpcClient;
  ping(): Promise<SystemPingOutput>;
  info(): Promise<SystemInfoOutput>;
  onCoreStatus(handler: (payload: CoreStatusPayload) => void): () => void;
  /** Subscribes to any core event by RPC event name. */
  onEvent<E extends RpcEventName>(
    event: E,
    handler: (payload: RpcEventPayload<E>) => void,
  ): () => void;
  close(): Promise<void>;
}

export type CreateCoreOptions = CoreServicesOptions;

/** Node worker_threads MessagePort delivers payloads without an event wrapper. */
function nodePortToTransport(port: NodeMessagePort): RpcTransport {
  return {
    post: (data) => port.postMessage(data),
    onData: (handler) => {
      const listener = (data: unknown) => handler(data);
      port.on('message', listener);
      return () => port.off('message', listener);
    },
    close: () => port.close(),
  };
}

/**
 * Starts the core services inside the current process (no Electron involved)
 * and exposes an RPC client over an in-memory channel. Used by integration
 * tests and the testkit (docs/dev/05-testing.md, `createCore`).
 */
export async function createCore(options: CreateCoreOptions = {}): Promise<CoreHarness> {
  const env = {
    NODE_ENV: 'test',
    KEPCUP_KEYSTORE: 'memory',
    ...options.env,
  };
  const services = await createCoreServices({ ...options, env });

  const channel = new MessageChannel();
  channel.port1.start();
  channel.port2.start();

  const server = createRpcServer({
    transport: nodePortToTransport(channel.port1),
    methods: services.appMethods,
  });
  services.pushStatusTo(server);
  // Mirror bus emissions onto the test RPC channel, like process-entry does.
  for (const name of RPC_EVENT_NAMES) {
    services.events.on(name, (payload) => {
      server.pushEvent(name, payload);
    });
  }

  const rpc = createRpcClient({ transport: nodePortToTransport(channel.port2) });

  return {
    services,
    rpc,
    async ping() {
      return systemPingOutputSchema.parse(await rpc.call('system.ping'));
    },
    async info() {
      return systemInfoOutputSchema.parse(await rpc.call('system.info'));
    },
    onCoreStatus(handler) {
      return services.events.on('core.status', handler);
    },
    onEvent(event, handler) {
      return services.events.on(event, handler as never);
    },
    async close() {
      server.close();
      rpc.close();
      channel.port1.close();
      channel.port2.close();
      await services.close();
    },
  };
}

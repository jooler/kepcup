import {
  createRpcClient,
  systemInfoOutputSchema,
  type CoreStatusPayload,
  type RpcClient,
  type SystemInfoOutput,
} from '@kepcup/shared';
import type { PlatformInfo } from '$lib/shim';
import { domPortToTransport } from './port';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

type EventHandler = (payload: unknown) => void;

/**
 * Owns the renderer-side connection to the core service over port A.
 * The main process hands over a fresh port whenever the renderer reloads or
 * the core process is restarted; every new port replaces the previous binding.
 */
class CoreConnection {
  connection = $state<ConnectionState>('connecting');
  coreStatus = $state<CoreStatusPayload | null>(null);
  info = $state<SystemInfoOutput | null>(null);
  platform = $state<PlatformInfo | null>(null);

  #rpc: RpcClient | null = null;
  readonly #eventHandlers = new Map<string, Set<EventHandler>>();

  async start(): Promise<void> {
    // The main process hands over the MessagePort through a window message
    // (forwarded by the preload); every later 'core-port' message rebinds.
    window.addEventListener('message', this.#onWindowMessage);
    window.kepcup.onCoreProcessState((state) => {
      if (state === 'down') this.connection = 'reconnecting';
      if (state === 'failed') this.connection = 'failed';
      // 'up': the fresh port arrives through window message, not here.
    });
    void window.kepcup.platform.info().then((info) => {
      this.platform = info;
    });
  }

  onEvent(event: string, handler: EventHandler): () => void {
    let set = this.#eventHandlers.get(event);
    if (!set) {
      // Plain Set: this registry is not UI state.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      set = new Set();
      this.#eventHandlers.set(event, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  async call(method: string, input?: unknown): Promise<unknown> {
    if (!this.#rpc) throw new Error('not connected');
    return this.#rpc.call(method, input);
  }

  async refreshInfo(): Promise<void> {
    try {
      this.info = systemInfoOutputSchema.parse(await this.call('system.info'));
    } catch {
      // Info is best-effort; failures surface through connection state.
    }
  }

  #bind(port: MessagePort): void {
    this.#rpc?.close();
    port.start();
    // birpc looks handlers up by event name at delivery time, so a Proxy here
    // lets handlers registered later (via onEvent) receive events too.
    const eventHandlers = new Proxy(
      {},
      {
        get: (_target, name) => {
          if (name === 'core.status') {
            return (payload: unknown) => {
              this.coreStatus = payload as CoreStatusPayload;
              this.#dispatch('core.status', payload);
            };
          }
          if (typeof name !== 'string') return undefined;
          return (payload: unknown) => this.#dispatch(name, payload);
        },
      },
    );
    this.#rpc = createRpcClient({
      transport: domPortToTransport(port),
      eventHandlers: eventHandlers as Record<string, (payload: unknown) => void>,
    });
    this.connection = 'connected';
    void this.refreshInfo();
  }

  #dispatch(event: string, payload: unknown): void {
    const handlers = this.#eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(payload);
  }

  readonly #onWindowMessage = (event: MessageEvent) => {
    if (event.data === 'core-port' && event.ports.length > 0) {
      this.#bind(event.ports[0]!);
    }
  };
}

export const core = new CoreConnection();

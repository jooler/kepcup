import {
  createRpcClient,
  systemInfoOutputSchema,
  type CoreStatusPayload,
  type RpcClient,
  type SystemInfoOutput,
} from '@kepcup/shared';
import type { PlatformInfo } from '$lib/shim';
import { domPortToTransport, isCorePortMessage } from './port';
import { getWebTransport, type WebLinkState } from './ws-transport';
import {
  getAuthedTransport,
  probeServerAuthUntilSettled,
  watchForPasswordServer,
  type AuthedLinkState,
} from './authed-transport';

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
    // D96 web 构建（手机 PWA）：没有 preload 与 MessagePort，core 在桌面，
    // 传输是中转 WebSocket（WsTransport，配对完成后可用）。Electron 路径不变。
    if (window.kepcup.isWeb === true) {
      void this.#startWeb();
      return;
    }
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

  /**
   * Web 模式启动（D102 修订）：先探测服务器认证模型——账号密码模式（headless
   * 直连默认）走 AuthedWsTransport（登录 Cookie 会话），配对模式（公共中转 /
   * --auth pairing）走既有 WsTransport。探测持续到有确定答案（审查 P2：原先
   * 两次失败就永久回退配对路径）；30s 仍不可达才回退，并后台重探自愈（一旦
   * 确定是密码服务器就刷新页面进正路）。
   */
  async #startWeb(): Promise<void> {
    const probe = await probeServerAuthUntilSettled();
    if (probe !== null && probe.mode === 'password') {
      const transport = getAuthedTransport();
      this.#rpc = createRpcClient({
        transport,
        eventHandlers: this.#eventProxy() as Record<string, (payload: unknown) => void>,
      });
      this.#applyAuthedLinkState(transport.linkState);
      transport.onLinkState((state) => this.#applyAuthedLinkState(state));
    } else {
      const transport = getWebTransport();
      this.#rpc = createRpcClient({
        transport,
        eventHandlers: this.#eventProxy() as Record<string, (payload: unknown) => void>,
      });
      this.#applyWebLinkState(transport.linkState);
      transport.onLinkState((state) => this.#applyWebLinkState(state));
      if (probe === null) watchForPasswordServer();
    }
    void window.kepcup.platform.info().then((info) => {
      this.platform = info;
    });
  }

  /** 账号密码会话状态 → 既有 connection 状态（未登录不算失败，Gate 出登录页）。 */
  #applyAuthedLinkState(state: AuthedLinkState): void {
    this.connection =
      state === 'connected' ? 'connected' : state === 'reconnecting' ? 'reconnecting' : 'connecting';
    if (state === 'connected') void this.refreshInfo();
  }

  /** 中转连接状态 → 既有 connection 状态（手机 UI 的状态页 / 横幅共用语义）。 */
  #applyWebLinkState(state: WebLinkState): void {
    this.connection =
      state === 'connected'
        ? 'connected'
        : state === 'reconnecting' || state === 'offline'
          ? 'reconnecting'
          : 'connecting';
    if (state === 'connected') void this.refreshInfo();
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
    // 调用方常直接传 settings $state 里的嵌套对象（表单草稿、bot profile 等），
    // Svelte 代理无法过 MessagePort 的结构化克隆——在边界统一 snapshot 成纯
    // 对象（非代理原样通过），各调用点无需自行处理。
    return this.#rpc.call(method, input === undefined ? undefined : $state.snapshot(input));
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
    this.#rpc = createRpcClient({
      transport: domPortToTransport(port),
      eventHandlers: this.#eventProxy() as Record<string, (payload: unknown) => void>,
    });
    this.connection = 'connected';
    void this.refreshInfo();
  }

  /**
   * birpc looks handlers up by event name at delivery time, so a Proxy here
   * lets handlers registered later (via onEvent) receive events too.
   */
  #eventProxy(): Record<string, (payload: unknown) => void> {
    return new Proxy(
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
    ) as Record<string, (payload: unknown) => void>;
  }

  #dispatch(event: string, payload: unknown): void {
    const handlers = this.#eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) handler(payload);
  }

  readonly #onWindowMessage = (event: MessageEvent) => {
    if (isCorePortMessage(event, window, window.kepcup.portNonce)) {
      this.#bind(event.ports[0]!);
    }
  };
}

export const core = new CoreConnection();

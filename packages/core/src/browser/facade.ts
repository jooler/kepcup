import type { ZodType } from 'zod';
import {
  AppError,
  browserEnsurePageOutputSchema,
  browserNavigateOutputSchema,
  browserScreenshotOutputSchema,
  browserSnapshotOutputSchema,
  okOutputSchema,
  type BrowserNetworkContext,
  type BrowserScreenshotOutput,
  type BrowserSnapshotOutput,
} from '@kepcup/shared';

/**
 * Core-side handle for the browser capability hosted by the main process
 * (docs/dev/phases/P11-browser.md 接口与数据): every method is one port B
 * `browser.*` call. In the Electron app the deferred instance is bound to the
 * platform channel once the port arrives; tests inject a fake directly via
 * `CoreServicesOptions.browserRpc`.
 */

export interface BrowserPageKey {
  botId: string;
  conversationId: string;
}

/** Minimal client surface (the shared RpcChannel satisfies it structurally). */
export interface BrowserRpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  /** Fails in-flight calls when the binding goes away (core restart/close). */
  rejectPending(reason: string): void;
}

export interface BrowserHostRpc {
  ensurePage(input: BrowserPageKey & {
    networkContext: BrowserNetworkContext;
    downloadsDir: string;
  }): Promise<{ ok: true }>;
  navigate(input: BrowserPageKey & { url: string }): Promise<{ ok: true; title: string; url: string }>;
  snapshot(input: BrowserPageKey): Promise<BrowserSnapshotOutput>;
  click(input: BrowserPageKey & { ref: string }): Promise<{ ok: true }>;
  type(input: BrowserPageKey & { ref: string; text: string }): Promise<{ ok: true }>;
  press(input: BrowserPageKey & { key: string }): Promise<{ ok: true }>;
  scroll(input: BrowserPageKey & { direction: 'up' | 'down'; amount: number }): Promise<{ ok: true }>;
  screenshot(input: BrowserPageKey): Promise<BrowserScreenshotOutput>;
  back(input: BrowserPageKey): Promise<{ ok: true }>;
  close(input: BrowserPageKey & { permanent?: boolean }): Promise<{ ok: true }>;
  setNetworkContext(input: BrowserPageKey & { networkContext: BrowserNetworkContext }): Promise<{ ok: true }>;
  clearBotData(input: { botId: string }): Promise<{ ok: true }>;
}

function unavailable(): AppError {
  return new AppError('BROWSER_UNAVAILABLE', '浏览器宿主未连接');
}

/** One facade dispatch per method (used when a test fake is bound). */
const FACADE_METHODS: Record<string, (facade: BrowserHostRpc, input: unknown) => Promise<unknown>> = {
  'browser.ensurePage': (f, i) => f.ensurePage(i as never),
  'browser.navigate': (f, i) => f.navigate(i as never),
  'browser.snapshot': (f, i) => f.snapshot(i as never),
  'browser.click': (f, i) => f.click(i as never),
  'browser.type': (f, i) => f.type(i as never),
  'browser.press': (f, i) => f.press(i as never),
  'browser.scroll': (f, i) => f.scroll(i as never),
  'browser.screenshot': (f, i) => f.screenshot(i as never),
  'browser.back': (f, i) => f.back(i as never),
  'browser.close': (f, i) => f.close(i as never),
  'browser.setNetworkContext': (f, i) => f.setNetworkContext(i as never),
  'browser.clearBotData': (f, i) => f.clearBotData(i as never),
};

class DeferredRpc implements BrowserHostRpc {
  #client: BrowserRpcClient | null = null;
  /** In-process target (test fake); takes precedence over the port B client. */
  #facade: BrowserHostRpc | null = null;

  bind(client: BrowserRpcClient | null): void {
    // Fail everything still in flight: pages die with the transport.
    this.#client?.rejectPending('browser host disconnected');
    this.#client = client;
  }

  /** Binds an in-process implementation (integration tests). */
  bindFacade(facade: BrowserHostRpc | null): void {
    this.#facade = facade;
  }

  async #call<T>(method: string, input: unknown, output: ZodType<T>): Promise<T> {
    const facade = this.#facade;
    if (facade !== null) {
      const dispatch = FACADE_METHODS[method];
      if (dispatch === undefined) throw unavailable();
      return output.parse(await dispatch(facade, input));
    }
    const client = this.#client;
    if (client === null) throw unavailable();
    return output.parse(await client.call(method, input));
  }

  ensurePage(input: Parameters<BrowserHostRpc['ensurePage']>[0]) {
    return this.#call('browser.ensurePage', input, browserEnsurePageOutputSchema);
  }

  navigate(input: Parameters<BrowserHostRpc['navigate']>[0]) {
    return this.#call('browser.navigate', input, browserNavigateOutputSchema);
  }

  snapshot(input: Parameters<BrowserHostRpc['snapshot']>[0]) {
    return this.#call('browser.snapshot', input, browserSnapshotOutputSchema);
  }

  click(input: Parameters<BrowserHostRpc['click']>[0]) {
    return this.#call('browser.click', input, okOutputSchema);
  }

  type(input: Parameters<BrowserHostRpc['type']>[0]) {
    return this.#call('browser.type', input, okOutputSchema);
  }

  press(input: Parameters<BrowserHostRpc['press']>[0]) {
    return this.#call('browser.press', input, okOutputSchema);
  }

  scroll(input: Parameters<BrowserHostRpc['scroll']>[0]) {
    return this.#call('browser.scroll', input, okOutputSchema);
  }

  screenshot(input: Parameters<BrowserHostRpc['screenshot']>[0]) {
    return this.#call('browser.screenshot', input, browserScreenshotOutputSchema);
  }

  back(input: Parameters<BrowserHostRpc['back']>[0]) {
    return this.#call('browser.back', input, okOutputSchema);
  }

  close(input: Parameters<BrowserHostRpc['close']>[0]) {
    return this.#call('browser.close', input, okOutputSchema);
  }

  setNetworkContext(input: Parameters<BrowserHostRpc['setNetworkContext']>[0]) {
    return this.#call('browser.setNetworkContext', input, okOutputSchema);
  }

  clearBotData(input: Parameters<BrowserHostRpc['clearBotData']>[0]) {
    return this.#call('browser.clearBotData', input, okOutputSchema);
  }
}

export type DeferredBrowserHostRpc = BrowserHostRpc & {
  bind(client: BrowserRpcClient | null): void;
  /** Binds an in-process implementation (integration test fakes). */
  bindFacade(facade: BrowserHostRpc | null): void;
};

/** The unbound-by-default facade used when no client was injected yet. */
export function createBrowserHostRpc(): DeferredBrowserHostRpc {
  return new DeferredRpc();
}

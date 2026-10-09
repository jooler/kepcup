import {
  AppError,
  shellOpenExternalOutputSchema,
  type ShellOpenExternalInput,
  type ShellOpenExternalOutput,
} from '@kepcup/shared';

/**
 * Core-side handle for the system-shell capability hosted by the main process
 * (D73): one port B `shell.openExternal` call opens an URL in the user's
 * browser (OAuth consent). In the Electron app the deferred instance is bound
 * to the platform channel once the port arrives; tests inject a fake directly
 * through `CoreServicesOptions.shellRpc` (it typically drives `simulateBrowser`).
 * Same shape as `browser/facade.ts`.
 */

/** Minimal client surface (the shared RpcChannel satisfies it structurally). */
export interface ShellRpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  /** Fails in-flight calls when the binding goes away (core restart/close). */
  rejectPending(reason: string): void;
}

export interface ShellHostRpc {
  openExternal(input: ShellOpenExternalInput): Promise<ShellOpenExternalOutput>;
}

export type DeferredShellHostRpc = ShellHostRpc & {
  bind(client: ShellRpcClient | null): void;
  /** Binds an in-process implementation (integration test fakes). */
  bindFacade(facade: ShellHostRpc | null): void;
};

class DeferredRpc implements DeferredShellHostRpc {
  #client: ShellRpcClient | null = null;
  /** In-process target (test fake); takes precedence over the port B client. */
  #facade: ShellHostRpc | null = null;

  bind(client: ShellRpcClient | null): void {
    this.#client?.rejectPending('shell host disconnected');
    this.#client = client;
  }

  bindFacade(facade: ShellHostRpc | null): void {
    this.#facade = facade;
  }

  async openExternal(input: ShellOpenExternalInput): Promise<ShellOpenExternalOutput> {
    if (this.#facade !== null) {
      return shellOpenExternalOutputSchema.parse(await this.#facade.openExternal(input));
    }
    if (this.#client === null) {
      throw new AppError('INTERNAL', '系统外壳宿主未连接，无法打开浏览器');
    }
    return shellOpenExternalOutputSchema.parse(
      await this.#client.call('shell.openExternal', input),
    );
  }
}

/** The unbound-by-default facade used until the process entry binds the platform port. */
export function createShellHostRpc(): DeferredShellHostRpc {
  return new DeferredRpc();
}

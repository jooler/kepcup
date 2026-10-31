import type { ZodType } from 'zod';
import { AppError, type ComputerInvokeMethod } from '@kepcup/shared';
import {
  computerCapabilitiesOutputSchema,
  computerPermissionsStatusOutputSchema,
  computerStopOutputSchema,
  okOutputSchema,
  type ComputerActionResult,
  type ComputerListAppsResult,
  type ComputerListWindowsResult,
  type ComputerPermissionsStatus,
  type ComputerProviderCapabilities,
  type ComputerSnapshotResult,
} from '@kepcup/shared';

/**
 * 计算机操控的 B 口客户端门面（D105，docs/design/52 §3）。镜像 browser 的
 * Deferred 模式：main 在端口 B serve `computer.*`（`COMPUTER_RPC_METHODS`），
 * core 侧未绑定时全部拒调（`COMPUTER_UNAVAILABLE`）——headless（D102）没有
 * 这个宿主能力，工具组不注册 / 调用即拒，表现与 browser 一致。
 */

/** Minimal client surface (the shared RpcChannel satisfies it structurally). */
export interface ComputerRpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  /** Fails in-flight calls when the binding goes away (core restart/close). */
  rejectPending(reason: string): void;
}

export interface ComputerHostRpc {
  /**
   * 数据面：method 白名单透传 sidecar。结果形态按方法各异（快照 / 动作 /
   * 列表 / 能力），调用方按需窄化；编排层的 RuntimeClientError 原样抛出
   * （code 透传，工具层补人话）。
   */
  invoke<M extends ComputerInvokeMethod>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<
    M extends 'capabilities'
      ? ComputerProviderCapabilities
      : M extends 'listApps'
        ? ComputerListAppsResult
        : M extends 'listWindows'
          ? ComputerListWindowsResult
          : M extends 'getAppState'
            ? ComputerSnapshotResult
            : ComputerActionResult
  >;
  /** 控制面：provider 能力握手；helper 不可用时 null。 */
  capabilities(): Promise<ComputerProviderCapabilities | null>;
  /** 控制面：helper TCC 权限三态（设置页引导共用）。 */
  permissionsStatus(): Promise<ComputerPermissionsStatus>;
  /** 控制面：打开对应系统设置 pane（首次拉起 helper 注册 TCC）。 */
  permissionsOpen(permission: 'accessibility' | 'screen-recording'): Promise<{ ok: true }>;
  /** 控制面：终止当前操控会话（用户 kill switch 与 computer_stop 共用）。 */
  stop(reason?: string): Promise<{ stopped: boolean }>;
}

function unavailable(): AppError {
  return new AppError('COMPUTER_UNAVAILABLE', '计算机操控宿主未连接');
}

/** Reason in-flight calls are rejected with when the port B binding is replaced. */
const HOST_DISCONNECTED = 'computer host disconnected';

/** True when the failure is the absent host (not bound / went away), not the app's. */
export function isComputerHostUnavailable(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === 'COMPUTER_UNAVAILABLE') return true;
  return error.code === 'INTERNAL' && error.message === HOST_DISCONNECTED;
}

class DeferredRpc implements ComputerHostRpc {
  #client: ComputerRpcClient | null = null;
  /** In-process target (integration tests); takes precedence over the client. */
  #facade: ComputerHostRpc | null = null;

  readonly #boundListeners = new Set<() => void>();

  bind(client: ComputerRpcClient | null): void {
    // Fail everything still in flight: the helper session dies with the transport.
    this.#client?.rejectPending(HOST_DISCONNECTED);
    this.#client = client;
    if (client !== null) this.#notifyBound();
  }

  /** Binds an in-process implementation (integration test fakes). */
  bindFacade(facade: ComputerHostRpc | null): void {
    this.#facade = facade;
    if (facade !== null) this.#notifyBound();
  }

  onBound(listener: () => void): () => void {
    this.#boundListeners.add(listener);
    return () => {
      this.#boundListeners.delete(listener);
    };
  }

  #notifyBound(): void {
    for (const listener of [...this.#boundListeners]) {
      try {
        listener();
      } catch {
        // A listener's failure never breaks the binding.
      }
    }
  }

  async #raw(method: string, input: unknown): Promise<unknown> {
    if (this.#facade !== null) {
      const dispatch: Record<string, (f: ComputerHostRpc, i: unknown) => Promise<unknown>> = {
        'computer.invoke': (f, i) =>
          f.invoke(
            (i as { method: ComputerInvokeMethod }).method,
            (i as { params?: Record<string, unknown> }).params ?? {},
          ),
        'computer.capabilities': (f) => f.capabilities(),
        'computer.permissionsStatus': (f) => f.permissionsStatus(),
        'computer.permissionsOpen': (f, i) =>
          f.permissionsOpen((i as { permission: 'accessibility' | 'screen-recording' }).permission),
        'computer.stop': (f, i) => f.stop((i as { reason?: string }).reason),
      };
      const run = dispatch[method];
      if (run === undefined) throw unavailable();
      return run(this.#facade, input);
    }
    const client = this.#client;
    if (client === null) throw unavailable();
    return client.call(method, input);
  }

  async #call<T>(method: string, input: unknown, output: ZodType<T>): Promise<T> {
    return output.parse(await this.#raw(method, input));
  }

  invoke<M extends ComputerInvokeMethod>(
    method: M,
    params: Record<string, unknown>,
  ): Promise<
    M extends 'capabilities'
      ? ComputerProviderCapabilities
      : M extends 'listApps'
        ? ComputerListAppsResult
        : M extends 'listWindows'
          ? ComputerListWindowsResult
          : M extends 'getAppState'
            ? ComputerSnapshotResult
            : ComputerActionResult
  > {
    // invoke 的输出形态按方法各异，通道层只做 unknown 透传（computerInvokeOutputSchema），
    // 这里是类型断言不是运行时校验——真正的形态校验在编排层（sidecar 协议）与工具层。
    return this.#raw('computer.invoke', { method, params }) as Promise<never>;
  }

  capabilities(): Promise<ComputerProviderCapabilities | null> {
    return this.#call('computer.capabilities', undefined, computerCapabilitiesOutputSchema);
  }

  permissionsStatus(): Promise<ComputerPermissionsStatus> {
    return this.#call('computer.permissionsStatus', undefined, computerPermissionsStatusOutputSchema);
  }

  permissionsOpen(permission: 'accessibility' | 'screen-recording'): Promise<{ ok: true }> {
    return this.#call('computer.permissionsOpen', { permission }, okOutputSchema);
  }

  stop(reason?: string): Promise<{ stopped: boolean }> {
    return this.#call('computer.stop', { reason }, computerStopOutputSchema);
  }
}

export type DeferredComputerHostRpc = ComputerHostRpc & {
  bind(client: ComputerRpcClient | null): void;
  /** Binds an in-process implementation (integration test fakes). */
  bindFacade(facade: ComputerHostRpc | null): void;
  /** Called whenever a host gets bound — work deferred while unavailable resumes. */
  onBound(listener: () => void): () => void;
};

/** The unbound-by-default facade used when no client was injected yet. */
export function createComputerHostRpc(): DeferredComputerHostRpc {
  return new DeferredRpc();
}

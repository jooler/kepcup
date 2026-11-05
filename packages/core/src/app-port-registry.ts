import type { RpcServerHandle } from './rpc/server.js';

/**
 * 端口 A 的多客户端注册表（组件「在新窗口打开」，todo/bot-micro-app-platform/widget-window.md §4.1）。
 *
 * 原语义是单客户端：新 `app-port` 到达先 close 旧 server（渲染层 reload 的替代绑定）。
 * 组件窗口让渲染端同时存在多个（主窗口 + N 个组件窗口），每个都持有自己的 app-port，
 * 所以 binding 变成一个集合：
 * - `bind`：为新端口建 server 入集合，`pushStatusTo` 让新客户端拿到当前快照；旧 server
 *   不再主动 close——渲染端窗口销毁 / reload 时旧端口会发 `close`，由 close 回调出清。
 * - `pushEvent`：事件桥遍历集合推送；单个端口已死（close 事件还没到）只摘除该客户端
 *   并继续，不把一个坏端口放大成全体丢事件。
 */
export class AppPortRegistry {
  readonly #servers = new Set<RpcServerHandle>();

  /** 当前客户端数（诊断 / 测试）。 */
  get size(): number {
    return this.#servers.size;
  }

  /** 为新到的 app-port 建 server：transport 已包成 RpcTransport，close 回调由调用方在端口上挂。 */
  bind(input: {
    createServer: () => RpcServerHandle;
    onBound?: (server: RpcServerHandle) => void;
  }): RpcServerHandle {
    const server = input.createServer();
    this.#servers.add(server);
    input.onBound?.(server);
    return server;
  }

  /** 端口关闭（渲染窗口销毁 / reload）时出清对应 server。 */
  remove(server: RpcServerHandle): void {
    server.close();
    this.#servers.delete(server);
  }

  /** 事件桥广播：坏端口摘除（其 close 回调随后会再 remove，幂等），其余照常收到。 */
  pushEvent(name: string, payload: unknown, onError?: (error: unknown) => void): void {
    for (const server of [...this.#servers]) {
      try {
        server.pushEvent(name, payload);
      } catch (error) {
        this.#servers.delete(server);
        onError?.(error);
      }
    }
  }

  /** 进程退出（system.shutdown 后）兜底：关掉全部 server。 */
  closeAll(): void {
    for (const server of this.#servers) {
      try {
        server.close();
      } catch {
        // Already dead.
      }
    }
    this.#servers.clear();
  }
}

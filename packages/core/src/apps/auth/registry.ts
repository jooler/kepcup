import type { McpFetch } from '@earendil-works/pi-mcp';
import type { OAuthClientInformation, OAuthServerInfo } from '@earendil-works/pi-mcp/oauth';
import {
  KEPCUP_OAUTH_CLIENT_ID,
  type AppConnectionStatus,
  type AppConnectionStatusPayload,
} from '@kepcup/shared';
import type { Clock } from '../../infra/clock.js';
import type { CoreLogger } from '../../infra/logger.js';
import {
  isCatalogConnectionId,
  isCustomConnectionId,
  sameEndpoint,
  type AppConnectionStore,
} from '../connection-store.js';
import type { TokenVault } from '../token-vault.js';
import { createSafeFetch, loopbackHostOf } from './safe-fetch.js';
import { AppAuthRequiredError } from './errors.js';
import { ConnectionAuthProvider } from './runtime-provider.js';

/**
 * 每个连接进程内唯一的 {@link ConnectionAuthProvider}（D73 §4.7）：run、设置页「测试」、
 * 工具清单刷新共用同一个实例（single-flight 刷新才有意义）。交互授权流程完成 / 断开后
 * 调用 {@link ConnectionAuthRegistry.invalidate}。
 */

/** `McpService` 里 registry 需要的两个操作（避免 import 循环，由 start.ts 绑定）。 */
export interface McpAuthControl {
  /** 清零某个 server 的连接失败计数（授权恢复后立即可再连）。 */
  resetFailures(serverId: string): void;
  /** 丢弃并关闭该 server 缓存的 client（下次调用用新令牌重连）。 */
  closeServer(serverId: string): Promise<void>;
}

export interface ConnectionAuthRegistryDeps {
  vault: TokenVault;
  store: AppConnectionStore;
  clock: Clock;
  logger: CoreLogger;
  /** 连接状态变化（持久化之后）的出站广播：`apps.connection_status`。 */
  onStatus?: (payload: AppConnectionStatusPayload) => void;
  /** 覆盖刷新用的 fetch（测试）；缺省为 SSRF 防护版 + 回环例外。 */
  fetchFor?: (serverUrl: string | null) => McpFetch;
  /** 额外允许明文 / 私网访问的回环主机（测试注入的 `oauthLoopbackAllowlist`）。 */
  loopbackAllowlist?: () => Iterable<string>;
  /** CIMD 客户端 id（缺省 `KEPCUP_OAUTH_CLIENT_ID`；测试经 CoreServicesOptions 覆盖）。 */
  cimdClientId?: string;
  refreshSkewMs?: number;
}

/**
 * 连接 id → McpService 里的 server id：自定义 `custom:{serverId}` → `serverId`；目录连接（`conn_…`）
 * 合成的 server 的 id 就是连接 id。其它形状（不应出现）返回 null。
 */
export function serverIdOfConnection(connectionId: string): string | null {
  if (isCustomConnectionId(connectionId)) return connectionId.slice('custom:'.length);
  return isCatalogConnectionId(connectionId) ? connectionId : null;
}

export class ConnectionAuthRegistry {
  readonly #deps: ConnectionAuthRegistryDeps;
  readonly #providers = new Map<string, ConnectionAuthProvider>();
  /**
   * 每个连接的世代号：{@link invalidate} / {@link discardInflight}（令牌被替换 / 断开）时递增。
   * 进行中的刷新在落盘前核对它，世代变了就丢弃结果——断开后不会被在途刷新写回令牌。
   */
  readonly #epochs = new Map<string, number>();
  #mcp: McpAuthControl | null = null;

  constructor(deps: ConnectionAuthRegistryDeps) {
    this.#deps = deps;
  }

  /** start.ts 在 McpService 构造后绑定（McpService 反过来持有 registry 取提供者）。 */
  bindMcp(mcp: McpAuthControl): void {
    this.#mcp = mcp;
  }

  /**
   * 取该连接唯一的提供者。传入 `serverUrl`（实际要连的 URL）时核对连接行：行不存在或其
   * `serverUrl` 与之不一致就拒绝（`AppAuthRequiredError` not_connected）——令牌的受众是连接行记录的
   * URL，绝不能发给别的地址（纵深防御，上游 `mcp.test` 另有同样的前置校验）。
   */
  providerFor(connectionId: string, serverUrl?: string | null): ConnectionAuthProvider {
    if (serverUrl !== undefined) {
      const row = this.#deps.store.get(connectionId);
      if (row === null || !sameEndpoint(row.serverUrl, serverUrl)) {
        throw new AppAuthRequiredError({ connectionId, reason: 'not_connected' });
      }
    }
    let provider = this.#providers.get(connectionId);
    if (provider === undefined) {
      provider = new ConnectionAuthProvider({
        connectionId,
        vault: this.#deps.vault,
        store: this.#deps.store,
        clock: this.#deps.clock,
        logger: this.#deps.logger,
        fetchFor: (serverUrl) => this.#fetchFor(serverUrl),
        clientFor: (issuer, discovery) => this.#clientFor(connectionId, issuer, discovery),
        epoch: () => this.#epochs.get(connectionId) ?? 0,
        setStatus: (id, status) => this.setStatus(id, status),
        ...(this.#deps.refreshSkewMs !== undefined
          ? { refreshSkewMs: this.#deps.refreshSkewMs }
          : {}),
      });
      this.#providers.set(connectionId, provider);
    }
    return provider;
  }

  /** 是否已有令牌（设置页测试在未连接时不发起任何请求）。 */
  hasTokens(connectionId: string): boolean {
    return this.#deps.vault.getTokens(connectionId) !== null;
  }

  /** 持久化连接状态并（有变化时）广播；连接行不存在则忽略。 */
  setStatus(connectionId: string, status: AppConnectionStatus): void {
    const row = this.#deps.store.get(connectionId);
    if (row === null || row.status === status) return;
    this.#deps.store.setStatus(connectionId, status);
    this.#deps.onStatus?.({ connectionId, status });
  }

  markExpired(connectionId: string): void {
    this.setStatus(connectionId, 'expired');
  }

  /**
   * 令牌变了（交互授权完成 / 追加权限 / 断开）：忘掉失效记录、清零该 server 的连接失败计数
   * 并丢弃缓存的 client，使重连后立即可用（§4.7）。
   */
  async invalidate(connectionId: string): Promise<void> {
    this.discardInflight(connectionId);
    this.#providers.get(connectionId)?.reset();
    const serverId = serverIdOfConnection(connectionId);
    if (serverId === null || this.#mcp === null) return;
    this.#mcp.resetFailures(serverId);
    await this.#mcp.closeServer(serverId);
  }

  /** 令牌即将被替换 / 清除：在途刷新的结果作废（不再写回 Vault）。 */
  discardInflight(connectionId: string): void {
    this.#epochs.set(connectionId, (this.#epochs.get(connectionId) ?? 0) + 1);
  }

  /** 连接被删除（`mcp.removeServer`）：丢弃提供者实例。 */
  forget(connectionId: string): void {
    this.#providers.delete(connectionId);
  }

  /** 与刷新同一套 SSRF 防护的 fetch（断开时的吊销请求也用它）。 */
  fetchFor(serverUrl: string | null): McpFetch {
    return this.#fetchFor(serverUrl);
  }

  #fetchFor(serverUrl: string | null): McpFetch {
    if (this.#deps.fetchFor !== undefined) return this.#deps.fetchFor(serverUrl);
    const own = serverUrl !== null ? loopbackHostOf(serverUrl) : null;
    return createSafeFetch({
      loopbackHosts: () => [
        ...(own !== null ? [own] : []),
        ...(this.#deps.loopbackAllowlist?.() ?? []),
      ],
    });
  }

  /**
   * 刷新 / 吊销用的客户端身份，按序：
   * 1. 该连接授权时记录的客户端（令牌是发给它的；同一 issuer 上别的连接重新注册不影响）；
   * 2. Vault 里该 issuer 的客户端（旧数据没有记录时）；
   * 3. 授权服务器声明支持 CIMD 时 KepCup 的 CIMD `client_id`（公共客户端，无 secret）。
   */
  #clientFor(
    connectionId: string,
    issuer: string,
    discovery: OAuthServerInfo,
  ): OAuthClientInformation | undefined {
    const recorded = this.#deps.vault.getConnectionClient(connectionId);
    if (recorded !== null) return recorded;
    const stored = this.#deps.vault.getClient(issuer);
    if (stored !== null) return stored.info;
    if (discovery.authorizationServerMetadata?.client_id_metadata_document_supported === true) {
      return { client_id: this.#deps.cimdClientId ?? KEPCUP_OAUTH_CLIENT_ID };
    }
    return undefined;
  }

  /** 供断开（吊销请求）取同一份客户端身份。 */
  clientFor(
    connectionId: string,
    issuer: string,
    discovery: OAuthServerInfo,
  ): OAuthClientInformation | undefined {
    return this.#clientFor(connectionId, issuer, discovery);
  }
}

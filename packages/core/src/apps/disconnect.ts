import { AppError, type AppConnectionStatusPayload, type McpServer } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { AppAuditor } from './audit.js';
import type { ConnectionAuthRegistry } from './auth/registry.js';
import { customConnectionId, sameEndpoint, type AppConnectionStore } from './connection-store.js';
import type { TokenVault } from './token-vault.js';

/**
 * 断开与移除（D73，todo §4.9 / §4.2）。
 *
 * `apps.disconnect`：授权服务器有 `revocation_endpoint` 时先吊销 refresh token、再吊销 access
 * token（RFC 7009；失败只记日志、不阻断）→ 清 Token Vault（`custom:` 行置 `not_connected`
 * 保留，其余删行；最后一个引用方时清 DCR 客户端）→ 关闭该 server 的缓存连接并清零失败计数
 * → 发 `apps.connection_status` → 审计 `app_disconnect`（明细不含令牌）。
 *
 * `mcp.removeServer` 的清理部分（{@link AppDisconnector.removeCustomServer}）：同样先吊销，
 * 再连行一起删，并清掉 `mcp:{id}:*` 密钥——修复“删除 server 后密钥 / 令牌遗留”。
 */

export interface AppDisconnectDeps {
  store: AppConnectionStore;
  vault: TokenVault;
  registry: ConnectionAuthRegistry;
  secrets: { removeByPrefix(prefix: string): string[] };
  logger: CoreLogger;
  auditor: AppAuditor;
  onStatus: (payload: AppConnectionStatusPayload) => void;
  /** 取消并等待该连接进行中的交互授权流程结束（断开后不能再被它写回令牌 / 状态）。 */
  cancelFlows?: (connectionId: string) => Promise<void>;
  /**
   * 连接行被删除之后（目录连接断开 / `mcp.removeServer`）：级联清理 Core 之外引用该连接 id 的地方——
   * 从所有 Bot 的 `app_connection_ids` 移除（`BotAppGrantWriter`）。工具行与 `app_tool_grants` 随
   * 外键 `ON DELETE CASCADE` 一并消失。
   */
  onRowDeleted?: (info: { connectionId: string; connectorId: string }) => void | Promise<void>;
  /** 自定义 server 被删除之后（`removeCustomServer`）：丢弃内存里属于它的东西（开发者模式的授权事件日志）。 */
  onServerRemoved?: (serverId: string) => void;
}

/** 原为 OAuth 的 server 被改成非 OAuth，或 URL 变了（令牌受众不再成立）。 */
export function oauthBindingChanged(before: McpServer, after: McpServer): boolean {
  return (
    before.auth === 'oauth' && !(after.auth === 'oauth' && sameEndpoint(before.url, after.url))
  );
}

export interface DisconnectResult {
  /** 吊销请求是否被授权服务器接受（无吊销端点 = false）。 */
  revoked: { refresh: boolean; access: boolean };
}

export class AppDisconnector {
  readonly #deps: AppDisconnectDeps;
  #onRowDeleted: AppDisconnectDeps['onRowDeleted'];

  constructor(deps: AppDisconnectDeps) {
    this.#deps = deps;
    this.#onRowDeleted = deps.onRowDeleted;
  }

  /** 接入行删除后的级联清理（连接服务在 disconnector 之后构造，所以事后接入）。 */
  attachRowDeleted(handler: NonNullable<AppDisconnectDeps['onRowDeleted']>): void {
    this.#onRowDeleted = handler;
  }

  async disconnect(
    connectionId: string,
    options: {
      removeRow?: boolean;
      /** false = 不取消进行中的授权流程（由流程自己收尾时调用，否则会等自己）。缺省 true。 */
      cancelFlows?: boolean;
    } = {},
  ): Promise<DisconnectResult> {
    const { store, vault, registry, auditor } = this.#deps;
    const row = store.getRequired(connectionId);
    const removed = options.removeRow === true;

    // 进行中的交互授权（含等待用户确认 / 停放的）先取消并收尾，在途刷新的结果作废：
    // 否则它们会在断开之后把令牌或状态写回来。
    if (options.cancelFlows !== false) await this.#deps.cancelFlows?.(connectionId);
    registry.discardInflight(connectionId);

    // 吊销必须在清除之前（需要令牌与客户端凭据）。
    const revoked = await this.#revoke(connectionId);

    vault.clearConnection(connectionId, { deleteRow: removed });
    const rowDeleted = store.get(connectionId) === null;
    // 丢弃缓存的 client、清零失败计数；提供者忘掉“失效”记录。
    await registry.invalidate(connectionId);
    if (removed) registry.forget(connectionId);
    if (rowDeleted) {
      try {
        await this.#onRowDeleted?.({ connectionId, connectorId: row.connectorId });
      } catch (error) {
        this.#deps.logger.warn(
          { connectionId, err: String(error) },
          'post-disconnect cleanup failed',
        );
      }
    }
    this.#deps.onStatus({ connectionId, status: 'not_connected' });
    auditor.auditAppDisconnect({
      connectionId,
      connectorId: row.connectorId,
      issuer: row.issuer,
      scopes: row.scopes,
      revoked,
      removed,
    });
    return { revoked };
  }

  /**
   * `settings.update` 整体替换 `mcpServers` 时调用（替换**之前**）：原来是 OAuth 的 server 若
   * 认证方式不再是 `oauth`，或 URL 变了，旧连接必须断开（吊销 + 清令牌，连接行置
   * `not_connected`）——令牌的受众是旧 URL（RFC 8707 / 设计 §5.6），绝不能发给新 URL，
   * 也不能在切换成无认证后继续悄悄留在 Vault 里。返回被断开的 serverId。
   */
  async reconcileServers(
    previous: readonly McpServer[],
    next: readonly McpServer[],
  ): Promise<string[]> {
    const disconnected: string[] = [];
    for (const before of previous) {
      const after = next.find((server) => server.id === before.id);
      // 被删除的条目走 `mcp.removeServer`（显式、幂等）；这里只处理“仍在、但变了”的。
      if (after === undefined) continue;
      if (!oauthBindingChanged(before, after)) continue;
      const connectionId = customConnectionId(before.id);
      const row = this.#deps.store.get(connectionId);
      if (row === null) continue;
      if (row.status === 'not_connected' && this.#deps.vault.getTokens(connectionId) === null) {
        continue;
      }
      await this.disconnect(connectionId);
      disconnected.push(before.id);
    }
    return disconnected;
  }

  /** `mcp.removeServer` 里 server 条目被删除之后的清理（令牌、连接行、密钥、缓存连接）。 */
  async removeCustomServer(serverId: string): Promise<void> {
    const connectionId = customConnectionId(serverId);
    if (this.#deps.store.get(connectionId) !== null) {
      await this.disconnect(connectionId, { removeRow: true });
    } else {
      await this.#deps.registry.invalidate(connectionId);
      this.#deps.registry.forget(connectionId);
    }
    try {
      this.#deps.secrets.removeByPrefix(`mcp:${serverId}:`);
    } catch (error) {
      // 名称不合法的 serverId 不可能存过密钥（secrets 名称有同一套校验）。
      if (!(error instanceof AppError && error.code === 'INVALID_INPUT')) throw error;
    }
    this.#deps.onServerRemoved?.(serverId);
  }

  async #revoke(connectionId: string): Promise<{ refresh: boolean; access: boolean }> {
    const { store, vault, registry, logger } = this.#deps;
    const none = { refresh: false, access: false };
    const tokens = vault.getTokens(connectionId);
    const discovery = vault.getDiscovery(connectionId);
    const row = store.get(connectionId);
    const endpoint = discovery?.authorizationServerMetadata?.['revocation_endpoint'];
    if (tokens === null || discovery === null || row === null || typeof endpoint !== 'string') {
      return none;
    }
    const issuer =
      row.issuer ??
      discovery.authorizationServerMetadata?.issuer ??
      discovery.authorizationServerUrl;
    const client = registry.clientFor(connectionId, issuer, discovery);
    if (client === undefined) return none;
    const fetch = registry.fetchFor(row.serverUrl);

    const post = async (
      token: string,
      hint: 'refresh_token' | 'access_token',
    ): Promise<boolean> => {
      const params = new URLSearchParams({ token, token_type_hint: hint });
      const headers = new Headers({
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      });
      if (client.client_secret !== undefined && client.client_secret.length > 0) {
        headers.set(
          'authorization',
          `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')}`,
        );
      } else {
        params.set('client_id', client.client_id);
      }
      try {
        const response = await fetch(endpoint, { method: 'POST', headers, body: params });
        void response.body?.cancel().catch(() => undefined);
        if (!response.ok) {
          logger.warn({ connectionId, hint, status: response.status }, 'token revocation rejected');
        }
        return response.ok;
      } catch (error) {
        // 失败只记日志（不含令牌 / 响应体）：断开不应被不可达的授权服务器卡住。
        logger.warn(
          { connectionId, hint, error: error instanceof Error ? error.name : 'unknown' },
          'token revocation failed',
        );
        return false;
      }
    };

    // RFC 7009 / 设计 §4.9：先 refresh token，再 access token。
    const refresh =
      tokens.refreshToken !== undefined ? await post(tokens.refreshToken, 'refresh_token') : false;
    const access = await post(tokens.accessToken, 'access_token');
    return { refresh, access };
  }
}

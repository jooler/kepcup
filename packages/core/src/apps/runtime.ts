import type { AppConnectionStatusPayload } from '@kepcup/shared';
import type { SecretsService } from '../domain/secrets.js';
import type { AuditService } from '../domain/audit.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { McpService } from '../mcp/service.js';
import type { CoreEventsMap } from '../start-types.js';
import type { EventBus } from '../infra/events.js';
import { AppAuditor } from './audit.js';
import { ConnectionAuthRegistry } from './auth/registry.js';
import { AppDisconnector } from './disconnect.js';
import type { AppServices } from './index.js';

/**
 * 连接应用的**运行时**一侧（D73 P0，design 29 §5.6）：授权提供者注册表、断开 / 移除、审计。
 * 与 `AppServices`（交互授权：Vault、连接行、流程管理器）共用同一份 store / vault。
 *
 * start.ts 在 `McpService` 与 `AuditService` 都构造后调用 {@link createAppRuntime}：
 * - `mcp.attachAuth(registry)`：`auth: 'oauth'` 的 server 从 registry 取每连接唯一的提供者；
 * - `registry.bindMcp(mcp)`：交互授权完成 / 断开后清零失败计数、丢弃缓存 client；
 * - `apps.attachRegistry(...)`：交互流程完成时失效缓存，并写 `app_connect` 审计。
 */
export interface AppRuntime {
  registry: ConnectionAuthRegistry;
  /**
   * What the interactive flow calls once it has saved a new token pair (it is the object handed
   * to `apps.attachRegistry`): invalidates the runtime caches and audits `app_connect`. Tests
   * that seed the Vault directly call it to stand in for the flow's last step.
   */
  flowInvalidator: { invalidate(connectionId: string): Promise<void> };
  disconnector: AppDisconnector;
  auditor: AppAuditor;
}

export function createAppRuntime(deps: {
  apps: AppServices;
  mcp: McpService;
  secrets: SecretsService;
  audit: Pick<AuditService, 'recordSystem'>;
  logger: CoreLogger;
  clock: Clock;
  events: Pick<EventBus<CoreEventsMap>, 'emit'>;
}): AppRuntime {
  const { apps, mcp } = deps;
  const onStatus = (payload: AppConnectionStatusPayload): void =>
    deps.events.emit('apps.connection_status', payload);
  const registry = new ConnectionAuthRegistry({
    vault: apps.vault,
    store: apps.store,
    clock: deps.clock,
    logger: deps.logger,
    onStatus,
    loopbackAllowlist: () => apps.loopbackAllowlist,
    cimdClientId: apps.cimdClientId,
  });
  const auditor = new AppAuditor({
    sink: deps.audit,
    redact: (text) => deps.secrets.redact(text),
  });
  const disconnector = new AppDisconnector({
    store: apps.store,
    vault: apps.vault,
    registry,
    secrets: deps.secrets,
    logger: deps.logger,
    auditor,
    onStatus,
    cancelFlows: (connectionId) => apps.flows.cancelForConnection(connectionId),
    onServerRemoved: (serverId) => apps.flows.clearFlowLog(serverId),
  });
  // 兜底（见 AppConnectionStore.ensureCustom）：自定义 server 的 URL 换了源 → 连接行已重置，
  // 这里清令牌 / 密钥 / 缓存的提供者并审计；不吊销（旧授权服务器与新 URL 无关）。
  apps.store.onCustomOriginChanged(({ connectionId, before }) => {
    const hadTokens = apps.vault.getTokens(connectionId) !== null;
    if (!hadTokens && before.issuer === null) return;
    deps.secrets.removeByPrefix(`conn:${connectionId}:`);
    if (before.issuer !== null) apps.vault.clearIssuerClientIfUnused(before.issuer);
    registry.discardInflight(connectionId);
    void registry.invalidate(connectionId);
    onStatus({ connectionId, status: 'not_connected' });
    auditor.auditAppDisconnect({
      connectionId,
      connectorId: before.connectorId,
      issuer: before.issuer,
      scopes: before.scopes,
      revoked: { refresh: false, access: false },
      removed: false,
    });
  });
  mcp.attachAuth(registry);
  registry.bindMcp(mcp);
  const flowInvalidator = {
    invalidate: async (connectionId: string): Promise<void> => {
      await registry.invalidate(connectionId);
      // 交互授权成功（连接 / 重新连接 / 追加权限）——审计一次（不含令牌）。
      const row = apps.store.get(connectionId);
      if (row !== null) {
        auditor.auditAppConnect({
          connectionId,
          connectorId: row.connectorId,
          issuer: row.issuer,
          scopes: row.scopes,
        });
      }
    },
  };
  apps.attachRegistry(flowInvalidator);
  return { registry, flowInvalidator, disconnector, auditor };
}

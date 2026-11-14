import {
  AppError,
  isSafeDirectoryRemoteUrl,
  mcpHeaderFieldKey,
  mcpServerSchema,
  normalizeMcpHeaderValueForStorage,
  type McpServer,
  type PluginMcpContribution,
  type Settings,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { AppDisconnector } from '../../apps/disconnect.js';
import type { AppToolsReviewTrigger } from '../../apps/audit.js';
import type { McpService } from '../../mcp/service.js';
import { mcpDescriptionFor, mcpTierFor } from '../projectors/mcp.js';
import { pluginServerId } from '../ids.js';
import type { PluginInstanceService, InstanceMaterializer, InstanceMaterializerContext } from '../instances.js';

/**
 * MCP instance materializer (P4-M2): an mcp instance IS a `settings.mcpServers` entry —
 * a streamable-http server derived from the plugin's http template (a manifest with
 * `instances: ['mcp']` carries at most one, mcpb entries are schema-rejected). Header
 * values (`auth: 'headers'`) land in secrets under `mcp:{serverId}:header:{name}` with
 * `secret:header:{name}` placeholders in the settings record, so `McpService` resolves
 * them through its existing secret plumbing. Server ids are deterministic
 * (`pluginServerId(pluginId, instanceId)`) so capabilities / per-tool policies survive
 * updates. All `settings.mcpServers` writes happen read-latest → mutate → update inside
 * ONE synchronous section (same discipline as `McpProjector`); secrets writes sit before
 * the settings flip with an exact restore on failure, and network side effects
 * (`closeServer`) stay outside the section.
 */

export interface PluginMcpMaterializerDeps {
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  secrets: { getValue(name: string): string | null; setValue(name: string, value: string): void; removeValue(name: string): void };
  mcp: Pick<McpService, 'closeServer'>;
  disconnector: Pick<AppDisconnector, 'removeCustomServer'>;
  /** W3 revocation effect: bots using changed servers lose their running tasks. */
  revokeMcpServerChanges(previous: readonly McpServer[], next: readonly McpServer[]): void;
  /**
   * 配置完成后的自动启用（连接 → 列工具 → 批准全部，`AppConnectionsService.enableAllTools`）：
   * create/update 成功落地后 fire-and-forget 调用——注册表互斥锁内不得等待网络。失败由实现方
   * 记日志即可（工具保持锁定，手动「测试 → 批准」仍然可用）。
   */
  autoEnable?:
    | ((serverId: string, trigger: Extract<AppToolsReviewTrigger, 'instance-create' | 'instance-update'>) => Promise<unknown>)
    | undefined;
  /** Registry row tier; null (unknown / mid-uninstall) fails closed to `developer`. */
  tierOf(pluginId: string): 'verified' | 'community' | 'developer' | null;
  logger: Pick<CoreLogger, 'info' | 'warn' | 'error'>;
}

function optionalString(
  values: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

interface McpTemplateSpec {
  /** Undefined for a pure-instance generic plugin (url comes from the form). */
  contribution: Extract<PluginMcpContribution, { kind: 'http' }> | undefined;
  serverId: string;
  displayName: string;
}

function templateOf(ctx: InstanceMaterializerContext): McpTemplateSpec {
  if (ctx.manifest.instances?.includes('mcp') !== true) {
    throw new AppError('INVALID_INPUT', '该插件未声明 MCP 实例能力');
  }
  const contribution = ctx.manifest.contributions.mcp.find(
    (entry): entry is Extract<PluginMcpContribution, { kind: 'http' }> => entry.kind === 'http',
  );
  const displayName =
    contribution === undefined
      ? ctx.manifest.name
      : (contribution.name ?? `${ctx.manifest.name} · ${contribution.id}`);
  return { contribution, serverId: pluginServerId(ctx.pluginId, ctx.instanceId), displayName };
}

function headerSecretName(serverId: string, headerName: string): string {
  return `mcp:${serverId}:header:${headerName}`;
}

/** Resolves the effective endpoint: a vendor lock always wins over the submitted value. */
function resolveUrl(spec: McpTemplateSpec, ctx: InstanceMaterializerContext, fallback: string): string {
  const url = spec.contribution?.url || optionalString(ctx.values, 'url') || fallback;
  if (!isSafeDirectoryRemoteUrl(url)) {
    throw new AppError('INVALID_INPUT', '「MCP 服务地址」不是可接受的公网 https 地址');
  }
  return url;
}

export function createMcpMaterializer(deps: PluginMcpMaterializerDeps): InstanceMaterializer {
  const tierOf = (ctx: InstanceMaterializerContext) => deps.tierOf(ctx.pluginId) ?? 'developer';

  /** 配置落地成功后的自动启用（fire-and-forget：互斥锁内不等网络，失败不影响保存结果）。 */
  const autoEnable = (
    serverId: string,
    trigger: Extract<AppToolsReviewTrigger, 'instance-create' | 'instance-update'>,
  ): void => {
    if (deps.autoEnable === undefined) return;
    void deps.autoEnable(serverId, trigger).catch((error: unknown) => {
      deps.logger.warn(
        { serverId, trigger, error: error instanceof Error ? error.message : String(error) },
        'mcp instance auto-enable failed (tools stay locked; manual review still available)',
      );
    });
  };

  /** Collects the header secret writes (new values + the values they overwrite). */
  const headerWritesOf = (
    ctx: InstanceMaterializerContext,
    spec: McpTemplateSpec,
    current: McpServer | undefined,
  ): { secretName: string; value: string; previousValue: string | null }[] => {
    const headers = spec.contribution?.headers ?? [];
    const writes = headers.map((header) => {
      const key = mcpHeaderFieldKey(header);
      // Update flows: a new input wins; an absent value keeps the stored secret
      // (`validatePluginFieldValues` already exempts required sensitive fields with
      // a stored value from the required check).
      const input = optionalString(ctx.values, key) ?? ctx.readStoredSecret(key) ?? undefined;
      if (input === undefined) {
        throw new AppError('INVALID_INPUT', `缺少 ${header.name} 的值`);
      }
      // 清单声明了凭据方案（如 `scheme: 'bearer'`）时只存裸凭据：用户可能自己粘了
      // `Bearer `，发送侧统一补前缀，避免出现 `Bearer Bearer x`。未声明的 header
      // （API key 等）与以前完全一样，值原样写入。顺带把旧记录里的前缀在下次更新时归一。
      const value = normalizeMcpHeaderValueForStorage(header.scheme, input);
      const secretName = headerSecretName(spec.serverId, header.name);
      return { secretName, value, previousValue: deps.secrets.getValue(secretName) };
    });
    // Headers dropped by a template change lose their mcp-side secrets (restored on
    // rollback). The instance-side secret under `plugin:{scope}:instance:{id}:{key}`
    // keeps its stale value until the instance is deleted — PluginInstanceService
    // prefix-sweeps it there, and a later re-declaration of the header would
    // transparently pick it up again.
    for (const name of Object.keys(current?.headers ?? {})) {
      if (headers.some((header) => header.name === name)) continue;
      const secretName = headerSecretName(spec.serverId, name);
      writes.push({
        secretName,
        value: '',
        previousValue: deps.secrets.getValue(secretName),
      });
    }
    return writes;
  };

  const applyHeaderWrites = (writes: ReturnType<typeof headerWritesOf>): void => {
    for (const write of writes) {
      if (write.value === '') {
        deps.secrets.removeValue(write.secretName);
      } else {
        deps.secrets.setValue(write.secretName, write.value);
      }
    }
  };

  const revertHeaderWrites = (writes: ReturnType<typeof headerWritesOf>): void => {
    for (const write of writes) {
      if (write.previousValue === null) {
        deps.secrets.removeValue(write.secretName);
      } else {
        deps.secrets.setValue(write.secretName, write.previousValue);
      }
    }
  };

  const buildServer = (
    ctx: InstanceMaterializerContext,
    spec: McpTemplateSpec,
    url: string,
    keep: McpServer | undefined,
  ): McpServer => {
    const headers = spec.contribution?.headers ?? [];
    const tier = mcpTierFor(tierOf(ctx));
    const description = mcpDescriptionFor(tierOf(ctx), spec.contribution?.description);
    const server = mcpServerSchema.parse({
      id: spec.serverId,
      name: spec.displayName,
      transport: 'http',
      url,
      enabled: keep?.enabled ?? true,
      autoApprove: false,
      auth: headers.length > 0 ? 'headers' : 'none',
      ...(headers.length > 0
        ? {
            headers: Object.fromEntries(
              headers.map((header) => [header.name, `secret:header:${header.name}`]),
            ),
          }
        : {}),
      source: { kind: 'instance', pluginId: ctx.pluginId, instanceId: ctx.instanceId },
      ...(tier !== undefined ? { tier } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    if (keep?.toolPolicies !== undefined) server.toolPolicies = keep.toolPolicies;
    return server;
  };

  return {
    async create(ctx) {
      const spec = templateOf(ctx);
      const url = resolveUrl(spec, ctx, '');
      const writes = headerWritesOf(ctx, spec, undefined);
      const server = buildServer(ctx, spec, url, undefined);
      try {
        // Header secrets land before the settings flip (same shape as update); a
        // failure anywhere in this block restores every header secret to its
        // previous value — PluginInstanceService's own create compensation only
        // removes the instance-secret namespace, so the `mcp:{serverId}:header:*`
        // mirror is this materializer's responsibility.
        applyHeaderWrites(writes);
        // Synchronous section (atomic without a lock — same discipline as McpProjector).
        const previous = deps.settings.get();
        if (previous.mcpServers.some((existing) => existing.id === spec.serverId)) {
          throw new AppError('PLUGIN_CONFLICT', `已有同 id 的 MCP 服务器：${spec.serverId}`);
        }
        deps.settings.update({ mcpServers: [...previous.mcpServers, server] });
      } catch (error) {
        revertHeaderWrites(writes);
        throw error;
      }
      // 配置完成即自动启用（连接 → 列工具 → 批准全部）：Bot 分配后立即可用，无需手动复核。
      autoEnable(spec.serverId, 'instance-create');
      return { title: optionalString(ctx.values, 'label') ?? ctx.manifest.name };
    },

    async update(ctx) {
      const spec = templateOf(ctx);
      const current = deps.settings
        .get()
        .mcpServers.find(
          (server) =>
            server.id === spec.serverId &&
            server.source?.kind === 'instance' &&
            server.source.instanceId === ctx.instanceId,
        );
      if (current === undefined) {
        // Defensive (the instance row owns this server); never silently re-create.
        throw new AppError('NOT_FOUND', 'MCP 服务实例不存在或已被移除');
      }
      const url = resolveUrl(spec, ctx, current.url ?? '');
      const writes = headerWritesOf(ctx, spec, current);
      const server = buildServer(ctx, spec, url, current);
      try {
        // Secrets land before the settings flip; any failure inside this block
        // restores every header secret to its previous value (create has the same
        // shape — PluginInstanceService's own compensation only covers the instance
        // secret namespace, so the `mcp:{serverId}:header:*` mirror is reverted here).
        applyHeaderWrites(writes);
        const previous = deps.settings.get();
        const next = deps.settings.update({
          mcpServers: previous.mcpServers.map((existing) =>
            existing.id === spec.serverId ? server : existing,
          ),
        });
        deps.revokeMcpServerChanges(previous.mcpServers, next.mcpServers);
      } catch (error) {
        revertHeaderWrites(writes);
        throw error;
      }
      // Network side effect outside the section: drop the cached connection so the
      // next call reconnects with the new endpoint / credentials.
      await deps.mcp.closeServer(spec.serverId);
      // 凭据 / 端点刚换过：重连测试并重新批准全部待复核工具（含定义已变的），保持「配置
      // 完成即完整可用」。失败只记日志——工具保持锁定，手动复核仍然可用。
      autoEnable(spec.serverId, 'instance-update');
      return { title: optionalString(ctx.values, 'label') ?? ctx.manifest.name };
    },

    async remove(ctx) {
      const serverId = pluginServerId(ctx.pluginId, ctx.instanceId);
      // Mirrors `mcp.removeServer` / `McpProjector.#removeOne`, best effort — an
      // uninstall cascade must finish.
      try {
        const previous = deps.settings.get();
        if (previous.mcpServers.some((server) => server.id === serverId)) {
          const next = deps.settings.update({
            mcpServers: previous.mcpServers.filter((server) => server.id !== serverId),
          });
          deps.revokeMcpServerChanges(previous.mcpServers, next.mcpServers);
        }
      } catch (error) {
        deps.logger.warn(
          { instanceId: ctx.instanceId, error: error instanceof Error ? error.message : String(error) },
          'mcp instance removal: settings update failed',
        );
      }
      try {
        // Revokes tokens / clears `mcp:{id}:*` secrets (incl. header secrets) / drops
        // the connection row when one exists.
        await deps.disconnector.removeCustomServer(serverId);
      } catch (error) {
        deps.logger.warn(
          { instanceId: ctx.instanceId, error: error instanceof Error ? error.message : String(error) },
          'mcp instance removal: removeCustomServer failed',
        );
      }
      try {
        await deps.mcp.closeServer(serverId);
      } catch (error) {
        deps.logger.warn(
          { instanceId: ctx.instanceId, error: error instanceof Error ? error.message : String(error) },
          'mcp instance removal: closeServer failed',
        );
      }
    },
  };
}

/**
 * Startup reconciliation (mirrors `reconcileMailInstanceRows`, DEV-065 shape): the
 * create flow's "instance row written, server landing failed" crash window leaves an
 * orphan instance row whose `settings.mcpServers` entry is gone — sweep it on boot.
 */
export function reconcileMcpInstanceRows(
  instances: PluginInstanceService,
  settings: { get(): Settings },
  logger: CoreLogger,
): void {
  const present = new Set(settings.get().mcpServers.map((server) => server.id));
  for (const row of instances.listKind('mcp')) {
    if (present.has(pluginServerId(row.pluginId, row.id))) continue;
    logger.info(
      { instanceId: row.id, pluginId: row.pluginId },
      'mcp instance reconciliation: removing orphan instance row',
    );
    void instances.delete(row.id).catch((error: unknown) => {
      logger.warn(
        { instanceId: row.id, error: error instanceof Error ? error.message : String(error) },
        'mcp instance reconciliation: orphan row cleanup failed',
      );
    });
  }
}

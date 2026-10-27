import path from 'node:path';
import {
  mcpServerSchema,
  type McpServer,
  type PluginConflict,
  type PluginConsentMcp,
  type Settings,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { AppDisconnector } from '../../apps/disconnect.js';
import { isSafeDirectoryRemoteUrl } from '../../apps/directory-merge.js';
import type { McpbInstaller } from '../../apps/mcpb/install.js';
import type { McpService } from '../../mcp/service.js';
import { oneLine } from '../../apps/prompt.js';
import { pluginServerId } from '../ids.js';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * MCP projector (D104 P0a-2 步骤 5): embedded MCPB bundles register through
 * `McpbInstaller` with a caller-specified plugin-shaped source; remote http
 * contributions register a plain `streamable-http` custom server. Server ids are
 * deterministic (`plg_` + sha256 prefix) so capabilities and tool policies survive
 * updates. All `settings.mcpServers` writes happen read-latest → mutate → update
 * inside ONE synchronous section (atomic without a lock); network side effects
 * (disconnect, secret revocation, connection close) stay outside that section.
 */

export interface PluginMcpDeps {
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  mcpb: McpbInstaller;
  mcp: Pick<McpService, 'closeServer'>;
  disconnector: Pick<AppDisconnector, 'removeCustomServer'>;
  /** W3 revocation effect: bots using changed servers lose their running tasks. */
  revokeMcpServerChanges(previous: readonly McpServer[], next: readonly McpServer[]): void;
  logger: Pick<CoreLogger, 'info' | 'warn' | 'error'>;
}

/** MCPB runtime label used in blocker messages (mirrors the installer's wording). */
function runtimeLabel(kind: 'node' | 'python' | 'uv'): string {
  return kind === 'node' ? 'Node.js' : kind === 'python' ? 'Python' : 'uv';
}

/** `verified` plugins keep the default (no tier → W5 defaults); everything else is fail-closed `developer`. */
export function mcpTierFor(tier: PluginIdentity['tier']): 'developer' | undefined {
  return tier === 'verified' ? undefined : 'developer';
}

/**
 * The description lands in the system prompt's `<capabilities>` line — only adopt the
 * manifest's wording for `verified`; other tiers get the default text (undefined).
 */
export function mcpDescriptionFor(
  tier: PluginIdentity['tier'],
  text: string | undefined,
): string | undefined {
  if (tier !== 'verified' || text === undefined) return undefined;
  return oneLine(text, 200);
}

export class McpProjector implements PluginProjector<PluginConsentMcp> {
  readonly kind = 'mcp' as const;
  readonly #deps: PluginMcpDeps;

  constructor(deps: PluginMcpDeps) {
    this.#deps = deps;
  }

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentMcp>> {
    const items: PluginConsentMcp[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    for (const contribution of ctx.manifest.contributions.mcp) {
      const serverId = pluginServerId(ctx.plugin.id, contribution.id);
      // Deterministic ids make collisions a programming error, but check anyway (fail-safe).
      if (this.#deps.settings.get().mcpServers.some((server) => server.id === serverId)) {
        conflicts.push({
          kind: 'plugin',
          ref: serverId,
          withWhat: '已有同 id 的 MCP 服务器',
        });
      }
      if (contribution.kind === 'mcpb') {
        const file = path.join(ctx.dir, ...contribution.file.split('/'));
        const r = await this.#deps.mcpb.inspect(file);
        const displayName = contribution.name ?? r.displayName;
        items.push({
          kind: 'mcpb',
          id: contribution.id,
          displayName,
          serverType: r.serverType,
          launchCommand: r.launchCommand,
          runtime: r.runtime,
          mcpbSha256: r.sha256,
          unpackedSize: r.unpackedSize,
          userConfigFields: r.userConfigFields,
          compatible: r.compatible,
          incompatibleReason: r.incompatibleReason ?? null,
        });
        if (!r.compatible) {
          blockers.push(`「${displayName}」${r.incompatibleReason ?? '与当前环境不兼容'}`);
        } else if (r.runtime?.available === false) {
          // P0 has no inline install: point at Settings → Environment like the installer does.
          blockers.push(
            `「${displayName}」需要 ${runtimeLabel(r.runtime.kind)} 运行时，请先在「设置 → 环境」安装后重试`,
          );
        }
        const slot = this.#deps.mcpb.slotConflict(r.name, r.version, r.sha256);
        if (slot !== null) {
          conflicts.push({
            kind: 'mcpb',
            ref: `${r.name}@${r.version}`,
            withWhat: '已安装同名同版本但内容不同的 MCPB 包',
          });
        }
      } else {
        const displayName = contribution.name ?? `${ctx.manifest.name} · ${contribution.id}`;
        if (!isSafeDirectoryRemoteUrl(contribution.url)) {
          blockers.push(`「${contribution.id}」的端点不是可接受的公网 https 地址`);
        }
        let host = contribution.url;
        try {
          host = new URL(contribution.url).host;
        } catch {
          // Schema already required a URL; keep the raw string as the host fallback.
        }
        items.push({
          kind: 'http',
          id: contribution.id,
          displayName,
          url: contribution.url,
          host,
        });
      }
    }
    return { items, conflicts, blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    for (const contribution of ctx.manifest.contributions.mcp) {
      const serverId = pluginServerId(ctx.plugin.id, contribution.id);
      ctx.ledger.add('mcp', serverId);
      if (contribution.kind === 'mcpb') {
        const file = path.join(ctx.dir, ...contribution.file.split('/'));
        const r = await this.#deps.mcpb.inspect(file);
        await this.#deps.mcpb.install({
          filePath: file,
          sha256: r.sha256,
          userConfig: ctx.userConfig[contribution.id] ?? {},
          register: {
            serverId,
            source: {
              kind: 'plugin',
              pluginId: ctx.plugin.id,
              version: ctx.plugin.version,
              key: contribution.id,
              mcpb: { name: r.name, version: r.version, sha256: r.sha256 },
            },
            tier: mcpTierFor(ctx.plugin.tier),
            name: contribution.name ?? r.displayName,
            description: mcpDescriptionFor(ctx.plugin.tier, contribution.description),
          },
        });
      } else {
        const tier = mcpTierFor(ctx.plugin.tier);
        const description = mcpDescriptionFor(ctx.plugin.tier, contribution.description);
        const server = mcpServerSchema.parse({
          id: serverId,
          name: contribution.name ?? `${ctx.manifest.name} · ${contribution.id}`,
          transport: 'http',
          url: contribution.url,
          enabled: true,
          autoApprove: false,
          auth: 'none',
          source: {
            kind: 'plugin',
            pluginId: ctx.plugin.id,
            version: ctx.plugin.version,
            key: contribution.id,
          },
          ...(tier !== undefined ? { tier } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        // Synchronous section: read latest → mutate → write, no await in between.
        const current = this.#deps.settings.get();
        this.#deps.settings.update({ mcpServers: [...current.mcpServers, server] });
      }
    }
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    for (const serverId of refs) {
      await this.#removeOne(serverId);
      ledger.remove('mcp', serverId);
    }
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    const ids = new Set(refs);
    // Synchronous section first; network side effects (closing cached connections)
    // and the revocation fan-out stay outside it.
    const previous = this.#deps.settings.get();
    const next = this.#deps.settings.update({
      mcpServers: previous.mcpServers.map((server) =>
        ids.has(server.id) ? { ...server, enabled } : server,
      ),
    });
    if (enabled) return;
    for (const serverId of refs) {
      try {
        await this.#deps.mcp.closeServer(serverId);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp disable: closeServer failed',
        );
      }
    }
    this.#deps.revokeMcpServerChanges(previous.mcpServers, next.mcpServers);
  }

  /**
   * Await-free light check: a projected server id that no longer appears in
   * `settings.mcpServers` was deleted outside the pipeline. Tree integrity of embedded
   * bundles is `McpbInstaller.verify`'s startup job, not repeated here. (Covers http
   * contributions with the same rule — a vanished settings entry is missing either way.)
   */
  missing(plugin: PluginIdentity, refs: readonly string[]): string[] {
    void plugin;
    const present = new Set(this.#deps.settings.get().mcpServers.map((server) => server.id));
    return refs.filter((serverId) => !present.has(serverId));
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Mirrors `mcp.removeServer` (rpc/apps-runtime-bindings.ts) for one server, best
   * effort: every step logs a warning and continues — an uninstall must finish.
   */
  async #removeOne(serverId: string): Promise<void> {
    // ① settings entry + revocations (synchronous section)
    let previousServers: readonly McpServer[] = [];
    try {
      const previous = this.#deps.settings.get();
      previousServers = previous.mcpServers;
      if (previous.mcpServers.some((server) => server.id === serverId)) {
        const next = this.#deps.settings.update({
          mcpServers: previous.mcpServers.filter((server) => server.id !== serverId),
        });
        this.#deps.revokeMcpServerChanges(previous.mcpServers, next.mcpServers);
      }
    } catch (error) {
      this.#deps.logger.warn(
        { serverId, error: error instanceof Error ? error.message : String(error) },
        'plugin mcp uninstall: settings update failed',
      );
    }
    // ② revoke tokens / clear `mcp:{id}:*` secrets / drop the connection row
    try {
      await this.#deps.disconnector.removeCustomServer(serverId);
    } catch (error) {
      this.#deps.logger.warn(
        { serverId, error: error instanceof Error ? error.message : String(error) },
        'plugin mcp uninstall: removeCustomServer failed',
      );
    }
    // ③ release the extracted MCPB tree when no other server references the package
    try {
      await this.#deps.mcpb.afterServerRemoved(previousServers, serverId);
    } catch (error) {
      this.#deps.logger.warn(
        { serverId, error: error instanceof Error ? error.message : String(error) },
        'plugin mcp uninstall: afterServerRemoved failed',
      );
    }
  }
}

import path from 'node:path';
import {
  mcpServerSchema,
  type McpServer,
  type PluginConflict,
  type PluginConsentMcp,
  type PluginMcpContribution,
  type Settings,
} from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { AppDisconnector } from '../../apps/disconnect.js';
import { isSafeDirectoryRemoteUrl } from '../../apps/directory-merge.js';
import {
  mcpbPackageOf,
  type McpbInstaller,
  type McpbPackageRef,
} from '../../apps/mcpb/install.js';
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

/** Parses an `update_snapshot` back into the server list it saved (worst case: empty). */
function serversSnapshotOf(snapshot: string): McpServer[] {
  try {
    const parsed = JSON.parse(snapshot) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) return [];
    return parsed.servers.map((server) => mcpServerSchema.parse(server));
  } catch {
    return [];
  }
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
      // An update's own previous servers are excluded via the ledger-owned set (D104 P1-2).
      if (
        this.#deps.settings.get().mcpServers.some((server) => server.id === serverId) &&
        !ctx.owned.mcp.has(serverId)
      ) {
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
        if (slot !== null && !ctx.owned.mcp.has(slot.serverId)) {
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
        const server = this.#httpServer(ctx, contribution, serverId);
        // Synchronous section: read latest → mutate → write, no await in between.
        const current = this.#deps.settings.get();
        this.#deps.settings.update({ mcpServers: [...current.mcpServers, server] });
      }
    }
  }

  /**
   * Update (D104 P1-2): owned mcpb servers go through the installer's replace mode (same
   * id, `enabled` / `toolPolicies` kept, `autoApprove` reset, untouched sensitive
   * user_config keeps its stored secret); owned http servers are swapped in place in one
   * synchronous section. Servers the new manifest dropped are removed with the same
   * four-step cleanup as `unproject`. Afterwards every replaced / removed cached
   * connection is closed and the change fan-out runs once for the whole update.
   */
  async update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void> {
    const previous = this.#deps.settings.get().mcpServers;
    const touched: string[] = [];
    const keptIds = new Set(newCtx.manifest.contributions.mcp.map((entry) => entry.id));
    for (const contribution of newCtx.manifest.contributions.mcp) {
      const serverId = pluginServerId(newCtx.plugin.id, contribution.id);
      newCtx.ledger.add('mcp', serverId);
      const wasOwned = oldCtx.owned.mcp.has(serverId);
      if (contribution.kind === 'mcpb') {
        const file = path.join(newCtx.dir, ...contribution.file.split('/'));
        const r = await this.#deps.mcpb.inspect(file);
        await this.#deps.mcpb.install({
          filePath: file,
          sha256: r.sha256,
          userConfig: newCtx.userConfig[contribution.id] ?? {},
          register: {
            serverId,
            source: {
              kind: 'plugin',
              pluginId: newCtx.plugin.id,
              version: newCtx.plugin.version,
              key: contribution.id,
              mcpb: { name: r.name, version: r.version, sha256: r.sha256 },
            },
            tier: mcpTierFor(newCtx.plugin.tier),
            name: contribution.name ?? r.displayName,
            description: mcpDescriptionFor(newCtx.plugin.tier, contribution.description),
            ...(wasOwned ? { replaceExisting: true as const } : {}),
          },
        });
        if (wasOwned) touched.push(serverId);
      } else {
        // Synchronous section: an owned http server is replaced in place (array position,
        // `enabled` and `toolPolicies` kept; `autoApprove` reset); otherwise appended.
        const current = this.#deps.settings.get();
        const existing = wasOwned
          ? current.mcpServers.find((entry) => entry.id === serverId)
          : undefined;
        const server = this.#httpServer(newCtx, contribution, serverId, existing);
        this.#deps.settings.update({
          mcpServers:
            existing !== undefined
              ? current.mcpServers.map((entry) => (entry.id === serverId ? server : entry))
              : [...current.mcpServers, server],
        });
        if (wasOwned) touched.push(serverId);
      }
    }
    for (const contribution of oldCtx.manifest.contributions.mcp) {
      if (keptIds.has(contribution.id)) continue;
      const serverId = pluginServerId(oldCtx.plugin.id, contribution.id);
      await this.#removeOne(serverId);
      oldCtx.ledger.remove('mcp', serverId);
      touched.push(serverId);
    }
    this.#deps.revokeMcpServerChanges(previous, this.#deps.settings.get().mcpServers);
    for (const serverId of touched) {
      try {
        await this.#deps.mcp.closeServer(serverId);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp update: closeServer failed',
        );
      }
    }
  }

  /** The plugin's current server entries — the only state a reverse update cannot rebuild. */
  async beginUpdate(plugin: PluginIdentity): Promise<string | null> {
    const servers = this.#pluginServers(plugin.id);
    // `env` holds only `secret:env:KEY` placeholders — no secret values in the snapshot.
    return JSON.stringify({ servers });
  }

  /** Releases the OLD packages' extracted trees once the update committed. */
  async commitUpdate(plugin: PluginIdentity, snapshot: string | null): Promise<void> {
    void plugin;
    if (snapshot === null) return;
    for (const server of serversSnapshotOf(snapshot)) {
      const pkg = mcpbPackageOf(server.source);
      if (pkg === null) continue;
      try {
        await this.#deps.mcpb.releaseIfUnused(pkg);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp commitUpdate: releaseIfUnused failed',
        );
      }
    }
  }

  /**
   * Restores the snapshot exactly: snapshot servers go back in place (overwrite by id or
   * append), plugin servers missing from the snapshot are removed (and their — new —
   * package trees released). A null snapshot means the update started from "no servers".
   */
  async rollbackUpdate(plugin: PluginIdentity, snapshot: string | null): Promise<void> {
    const previous = this.#deps.settings.get().mcpServers;
    const desired = snapshot === null ? [] : serversSnapshotOf(snapshot);
    const desiredIds = new Set(desired.map((server) => server.id));
    const isMine = (server: McpServer): boolean =>
      server.source?.kind === 'plugin' && server.source.pluginId === plugin.id;
    // A replaced server keeps its stable id, so the snapshot cannot be told apart by id
    // alone: when its package changed, the pre-rollback package tree must be released.
    const replacedPackages: McpbPackageRef[] = [];
    for (const server of previous) {
      if (!isMine(server) || !desiredIds.has(server.id)) continue;
      const snapshotServer = desired.find((entry) => entry.id === server.id)!;
      const currentPkg = mcpbPackageOf(server.source);
      const snapshotPkg = mcpbPackageOf(snapshotServer.source);
      if (
        currentPkg !== null &&
        (snapshotPkg === null ||
          currentPkg.sha256 !== snapshotPkg.sha256 ||
          currentPkg.version !== snapshotPkg.version)
      ) {
        replacedPackages.push(currentPkg);
      }
    }
    // Synchronous section: read latest → restore → write, no await in between.
    const current = this.#deps.settings.get();
    const restored: McpServer[] = [];
    for (const server of current.mcpServers) {
      if (!isMine(server)) {
        restored.push(server);
        continue;
      }
      const snapshotServer = desired.find((entry) => entry.id === server.id);
      if (snapshotServer !== undefined) restored.push(snapshotServer);
      // Not in the snapshot: dropped below.
    }
    for (const server of desired) {
      if (!restored.some((entry) => entry.id === server.id)) restored.push(server);
    }
    const next = this.#deps.settings.update({ mcpServers: restored }).mcpServers;
    this.#deps.revokeMcpServerChanges(previous, next);
    // Network side effects outside the synchronous section.
    const dropped = previous.filter((server) => isMine(server) && !desiredIds.has(server.id));
    for (const server of dropped) {
      try {
        await this.#deps.disconnector.removeCustomServer(server.id);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp rollbackUpdate: removeCustomServer failed',
        );
      }
      try {
        await this.#deps.mcpb.afterServerRemoved(previous, server.id);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp rollbackUpdate: afterServerRemoved failed',
        );
      }
    }
    for (const pkg of replacedPackages) {
      try {
        await this.#deps.mcpb.releaseIfUnused(pkg);
      } catch (error) {
        this.#deps.logger.warn(
          { name: pkg.name, version: pkg.version, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp rollbackUpdate: releaseIfUnused failed',
        );
      }
    }
    for (const server of desired) {
      try {
        await this.#deps.mcp.closeServer(server.id);
      } catch (error) {
        this.#deps.logger.warn(
          { serverId: server.id, error: error instanceof Error ? error.message : String(error) },
          'plugin mcp rollbackUpdate: closeServer failed',
        );
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

  /** Builds the http server for one contribution; `keep` preserves user state on updates. */
  #httpServer(
    ctx: PluginProjectionContext,
    contribution: Extract<PluginMcpContribution, { kind: 'http' }>,
    serverId: string,
    keep?: McpServer,
  ): McpServer {
    const tier = mcpTierFor(ctx.plugin.tier);
    const description = mcpDescriptionFor(ctx.plugin.tier, contribution.description);
    const server = mcpServerSchema.parse({
      id: serverId,
      name: contribution.name ?? `${ctx.manifest.name} · ${contribution.id}`,
      transport: 'http',
      url: contribution.url,
      enabled: keep?.enabled ?? true,
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
    if (keep?.toolPolicies !== undefined) server.toolPolicies = keep.toolPolicies;
    return server;
  }

  #pluginServers(pluginId: string): McpServer[] {
    return this.#deps.settings.get().mcpServers.filter(
      (server) => server.source?.kind === 'plugin' && server.source.pluginId === pluginId,
    );
  }

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

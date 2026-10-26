import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AppError,
  CONNECTOR_META_KEY,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  type ConnectorCatalogEntry,
  type PluginConflict,
  type PluginConsentConnector,
} from '@kepcup/shared';
import { LOCAL_CONNECTOR_NAME_PREFIX } from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { AppDisconnector } from '../../apps/disconnect.js';
import type {
  ConnectorCatalog,
  PluginConnectorEntry,
  PluginConnectorSource,
} from '../../apps/catalog.js';
import { isSafeDirectoryRemoteUrl } from '../../apps/directory-merge.js';
import type { AppConnectionStore } from '../../apps/connection-store.js';
import type { AppConnectionsService } from '../../apps/connections.js';
import type { EventBus } from '../../infra/events.js';
import type { CoreEventsMap } from '../../start-types.js';
import type {
  PluginIdentity,
  PluginLedger,
  PluginProjectionContext,
  PluginProjector,
  ProjectorInspection,
} from './index.js';

/**
 * Connectors projector (D104 P0a-2 步骤 6.2): a connector contribution's `server.json`
 * is rewritten (tier from the source, `releaseGate: 'plugin'`, destructive-only
 * toolPolicy, no packages) and served into the `ConnectorCatalog` as the plugin
 * source — entries appear after the release gate and before local connectors, yield
 * to any conflicting slug / name, and always re-validate their endpoint as public
 * https on connect (`isDirectorySourced`). Connects stay user-driven; uninstall
 * disconnects the connector's connections like `LocalConnectors.remove`.
 */

export interface ConnectorsProjectorDeps {
  catalog: ConnectorCatalog;
  connectionStore: Pick<AppConnectionStore, 'listByConnector'>;
  disconnector: Pick<AppDisconnector, 'disconnect'>;
  connections: Pick<AppConnectionsService, 'update'>;
  events: EventBus<CoreEventsMap>;
  logger: Pick<CoreLogger, 'info' | 'warn' | 'error'>;
}

/** 连接器条目的分级映射（README §4.1）：本地 → developer、verified → verified、community → community。 */
function tierFor(pluginTier: PluginIdentity['tier']): 'verified' | 'community' | 'developer' {
  return pluginTier;
}

/**
 * Rewrites one contribution body into a catalog entry (README §4.1「连接器条目改写」):
 * tier ← source mapping, `releaseGate ← 'plugin'`, `hidden` removed, `toolPolicy`
 * keeps only destructive entries, `packages` must be empty, `remotes` non-empty with
 * public-https endpoints, and the reserved local-connector name prefix is rejected.
 * Throws `AppError('PLUGIN_INVALID', …)`; `inspect` turns that into a blocker.
 */
export function rewriteConnectorEntry(
  raw: unknown,
  plugin: PluginIdentity,
  iconAbsPath: string | null,
): ConnectorCatalogEntry {
  const parsed = connectorCatalogEntrySchema.parse(raw);
  const meta = connectorMetaOf(parsed);
  if (parsed.packages.length > 0) {
    throw new AppError('PLUGIN_INVALID', `连接器 ${meta.slug} 不允许携带 packages（本地执行只走 MCPB）`);
  }
  if (parsed.remotes.length === 0) {
    throw new AppError('PLUGIN_INVALID', `连接器 ${meta.slug} 没有可用的远程端点`);
  }
  for (const remote of parsed.remotes) {
    if (!isSafeDirectoryRemoteUrl(remote.url)) {
      throw new AppError(
        'PLUGIN_INVALID',
        `连接器 ${meta.slug} 的端点不是可接受的公网 https 地址`,
      );
    }
  }
  if (parsed.name.startsWith(LOCAL_CONNECTOR_NAME_PREFIX)) {
    throw new AppError('PLUGIN_INVALID', `连接器名称不能以保留前缀 ${LOCAL_CONNECTOR_NAME_PREFIX} 开头`);
  }
  const toolPolicy = Object.fromEntries(
    Object.entries(meta.toolPolicy).filter(([, policy]) => policy.risk === 'destructive'),
  );
  return {
    ...parsed,
    packages: [],
    _meta: {
      ...parsed._meta,
      [CONNECTOR_META_KEY]: {
        ...meta,
        tier: tierFor(plugin.tier),
        releaseGate: 'plugin',
        toolPolicy,
        hidden: undefined,
      },
    },
  };
}

/** One plugin's projected connector entries (rewritten + icon path), always kept while installed. */
interface PluginEntries {
  pluginId: string;
  entries: PluginConnectorEntry[];
  /** Disabled plugins keep their entries but the catalog source stops serving them. */
  disabled: boolean;
}

export class ConnectorsProjector
  implements PluginProjector<PluginConsentConnector>, PluginConnectorSource
{
  readonly kind = 'connector' as const;
  readonly #deps: ConnectorsProjectorDeps;
  readonly #byPlugin = new Map<string, PluginEntries>();
  #revision = 0;

  constructor(deps: ConnectorsProjectorDeps) {
    this.#deps = deps;
  }

  // --- PluginConnectorSource ---------------------------------------------------

  revision(): number {
    return this.#revision;
  }

  entries(): readonly PluginConnectorEntry[] {
    const out: PluginConnectorEntry[] = [];
    for (const state of this.#byPlugin.values()) {
      if (state.disabled) continue;
      out.push(...state.entries);
    }
    return out;
  }

  /** Slugs this projector had to yield to an existing catalog entry (`plugins.list` marks them). */
  yieldedSlugs(): ReadonlySet<string> {
    return this.#deps.catalog.yieldedPluginSlugs();
  }

  // --- helpers -----------------------------------------------------------------

  #bump(): void {
    this.#revision += 1;
  }

  #removeFromMap(pluginId: string, slug: string): boolean {
    const state = this.#byPlugin.get(pluginId);
    if (state === undefined) return false;
    const before = state.entries.length;
    state.entries = state.entries.filter((item) => connectorMetaOf(item.entry).slug !== slug);
    return state.entries.length !== before;
  }

  /** Reads + rewrites one contribution; throws PLUGIN_INVALID on any problem. */
  #loadOne(
    ctx: PluginProjectionContext,
    file: string,
  ): { entry: ConnectorCatalogEntry; slug: string; iconPath: string | null } {
    const absolute = path.join(ctx.dir, ...file.split('/'));
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(absolute, 'utf8'));
    } catch (error) {
      throw new AppError(
        'PLUGIN_INVALID',
        `连接器文件 ${file} 无法读取：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Pre-parse for the meta (icon) so the rewrite gets a verified same-directory path.
    const parsed = connectorCatalogEntrySchema.safeParse(raw);
    const iconAbsPath = parsed.success
      ? path.join(path.dirname(absolute), connectorMetaOf(parsed.data).icon)
      : null;
    const entry = rewriteConnectorEntry(raw, ctx.plugin, iconAbsPath);
    return { entry, slug: connectorMetaOf(entry).slug, iconPath: iconAbsPath };
  }

  #put(pluginId: string, entry: PluginConnectorEntry): void {
    const state = this.#byPlugin.get(pluginId);
    if (state === undefined) {
      this.#byPlugin.set(pluginId, { pluginId, entries: [entry], disabled: false });
      return;
    }
    state.entries = state.entries.filter(
      (item) => connectorMetaOf(item.entry).slug !== connectorMetaOf(entry.entry).slug,
    );
    state.entries.push(entry);
  }

  /** Disconnects every connection of a connector, twice like `LocalConnectors.remove`. */
  async #sweepConnections(slug: string): Promise<void> {
    const sweep = async (): Promise<void> => {
      for (const connection of this.#deps.connectionStore.listByConnector(slug)) {
        await this.#deps.disconnector.disconnect(connection.id, { removeRow: true });
      }
    };
    await sweep();
    await sweep();
  }

  // --- PluginProjector ---------------------------------------------------------

  async inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<PluginConsentConnector>> {
    const items: PluginConsentConnector[] = [];
    const conflicts: PluginConflict[] = [];
    const blockers: string[] = [];
    const seenSlugs = new Set<string>();
    const seenNames = new Set<string>();
    for (const contribution of ctx.manifest.contributions.connectors) {
      let entry: ConnectorCatalogEntry;
      let iconPath: string | null;
      try {
        const loaded = this.#loadOne(ctx, contribution.file);
        entry = loaded.entry;
        iconPath = loaded.iconPath;
      } catch (error) {
        blockers.push(
          error instanceof AppError
            ? error.message
            : `连接器贡献 ${contribution.file} 无法解析`,
        );
        continue;
      }
      const meta = connectorMetaOf(entry);
      // Icon file must exist next to server.json (inspect validates; activate tolerates).
      if (iconPath === null || !existsSync(iconPath)) {
        blockers.push(`连接器 ${meta.slug} 的图标文件缺失（${meta.icon}）`);
        continue;
      }
      // Conflicts against the FULL current catalog (bundled / directory / local / other
      // plugins) — this plugin is not installed yet, so it cannot collide with itself.
      const existing = this.#deps.catalog.list().find(
        (candidate) =>
          connectorMetaOf(candidate).slug === meta.slug || candidate.name === entry.name,
      );
      if (existing !== undefined) {
        const existingSlug = connectorMetaOf(existing).slug;
        conflicts.push({
          kind: 'connector',
          ref: meta.slug,
          withWhat: `目录里已有同 slug / 同名的连接应用（来源：${this.#deps.catalog.originOf(existingSlug)}）`,
        });
        continue;
      }
      if (seenSlugs.has(meta.slug) || seenNames.has(entry.name)) {
        blockers.push(`包内有重复的连接器（slug ${meta.slug} 或同名条目）`);
        continue;
      }
      seenSlugs.add(meta.slug);
      seenNames.add(entry.name);
      const hosts = [...new Set(entry.remotes.map((remote) => safeHost(remote.url)))];
      items.push({
        slug: meta.slug,
        name: entry.name,
        title: entry.title,
        hosts,
        scopes: [...new Set([...meta.auth.scopes.default, ...meta.auth.scopes.write])],
        authKind: meta.auth.kind,
      });
    }
    return { items, conflicts, blockers };
  }

  async project(ctx: PluginProjectionContext): Promise<void> {
    const loaded: PluginConnectorEntry[] = [];
    for (const contribution of ctx.manifest.contributions.connectors) {
      const { entry, iconPath } = this.#loadOne(ctx, contribution.file);
      const slug = connectorMetaOf(entry).slug;
      ctx.ledger.add('connector', slug);
      loaded.push({ entry, pluginId: ctx.plugin.id, iconPath });
    }
    const state = this.#byPlugin.get(ctx.plugin.id);
    if (state === undefined) {
      this.#byPlugin.set(ctx.plugin.id, { pluginId: ctx.plugin.id, entries: loaded, disabled: false });
    } else {
      state.entries = loaded;
      state.disabled = false;
    }
    this.#bump();
    for (const item of loaded) {
      this.#deps.events.emit('apps.catalog_changed', {
        connectorId: connectorMetaOf(item.entry).slug,
        change: 'added',
      });
    }
  }

  async activate(ctx: PluginProjectionContext): Promise<void> {
    // Rebuild from the installed tree; a bad file (or missing icon) only skips its own
    // entry — startup must not fail because of one broken contribution.
    const loaded: PluginConnectorEntry[] = [];
    for (const contribution of ctx.manifest.contributions.connectors) {
      try {
        const { entry, iconPath } = this.#loadOne(ctx, contribution.file);
        if (iconPath === null || !existsSync(iconPath)) {
          this.#deps.logger.warn(
            { plugin: ctx.plugin.id, file: contribution.file },
            'plugin connector activate skipped: icon missing',
          );
          continue;
        }
        loaded.push({ entry, pluginId: ctx.plugin.id, iconPath });
      } catch (error) {
        this.#deps.logger.warn(
          {
            plugin: ctx.plugin.id,
            file: contribution.file,
            error: error instanceof Error ? error.message : String(error),
          },
          'plugin connector activate skipped: bad entry',
        );
      }
    }
    this.#byPlugin.set(ctx.plugin.id, {
      pluginId: ctx.plugin.id,
      entries: loaded,
      disabled: this.#byPlugin.get(ctx.plugin.id)?.disabled ?? false,
    });
    this.#bump();
  }

  async unproject(
    plugin: PluginIdentity,
    refs: readonly string[],
    ledger: PluginLedger,
  ): Promise<void> {
    for (const slug of refs) {
      this.#removeFromMap(plugin.id, slug);
      this.#bump();
      // Disconnect first (revoke + clear tokens / bot selections), twice; then the
      // entry disappears from the catalog via the revision bump.
      try {
        await this.#sweepConnections(slug);
      } catch (error) {
        this.#deps.logger.warn(
          { plugin: plugin.id, slug, error: error instanceof Error ? error.message : String(error) },
          'plugin connector uninstall: disconnect failed',
        );
      }
      this.#deps.events.emit('apps.catalog_changed', { connectorId: slug, change: 'removed' });
      ledger.remove('connector', slug);
    }
    if ((this.#byPlugin.get(plugin.id)?.entries.length ?? 0) === 0) {
      this.#byPlugin.delete(plugin.id);
      this.#bump();
    }
  }

  async setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    const state = this.#byPlugin.get(ctx.plugin.id);
    if (state === undefined) return;
    if (!enabled) {
      // Hide from the catalog first, then disable the plugin's connectors' connections
      // (they keep their authorization rows) and remember which ones the plugin disabled.
      state.disabled = true;
      this.#bump();
      for (const slug of refs) {
        for (const connection of this.#deps.connectionStore.listByConnector(slug)) {
          if (connection.status === 'disabled') continue;
          await this.#deps.connections.update({ connectionId: connection.id, disabled: true });
          ctx.ledger.add('disabled_connection', connection.id);
        }
        this.#deps.events.emit('apps.catalog_changed', { connectorId: slug, change: 'removed' });
      }
      return;
    }
    state.disabled = false;
    this.#bump();
    // Restore exactly the connections the plugin disabled; user-disabled ones stay off.
    for (const connectionId of ctx.ledger.list('disabled_connection')) {
      try {
        await this.#deps.connections.update({ connectionId, disabled: false });
      } finally {
        ctx.ledger.remove('disabled_connection', connectionId);
      }
    }
    for (const slug of refs) {
      this.#deps.events.emit('apps.catalog_changed', { connectorId: slug, change: 'added' });
    }
  }

  missing(plugin: PluginIdentity, refs: readonly string[]): string[] {
    void plugin;
    // Entries live in memory (rewritten from the installed tree); nothing external to lose.
    void refs;
    return [];
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

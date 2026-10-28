import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  connectorCatalogEntrySchema,
  connectorMetaOf,
  findConnectorBySlug,
  type ConnectorCatalogEntry,
  type ConnectorOrigin,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 连接应用目录（D73 P1 §5.2，设计 29 §4）的运行时合并（商店化后）。
 *
 * 条目来源只有两个：已安装插件的连接器贡献（`ConnectorsProjector` 经 `attachPlugins` 接入）
 * 与本机连接（`LocalConnectors` 经 `attachLocal` 接入）。随包快照与远端签名目录通道已随
 * D104 商店化移除——连接能力完全由市场插件承担。单个坏条目只告警并跳过，不拖垮整个目录；
 * slug 重复时保留先出现者。
 */

/** 一份已解析的目录数据：条目 + 图标目录（测试可直接注入）。 */
export interface ConnectorCatalogSource {
  /** 各 `server.json` 的原始对象（未校验；顺序 = plugin.json 的 connectors 顺序）。 */
  entries: readonly unknown[];
  /** 图标所在目录；null = 没有图标文件。 */
  iconsDir: string | null;
  /** slug → 图标文件绝对路径（内置插件条目的图标与 server.json 同目录；可选）。 */
  iconPaths?: ReadonlyMap<string, string> | undefined;
}

export interface ConnectorCatalogOptions {
  logger?: Pick<CoreLogger, 'warn'> | undefined;
  /** 内置来源数据（`BuiltinPlugins.connectorSource()`；应用已无内置插件，测试可注入）。 */
  source?: ConnectorCatalogSource | undefined;
  /** 内置条目的 slug → 归属插件 id（D105：内置插件的目录条目也要能被插件圈定）。 */
  sourceOwners?: ReadonlyMap<string, string> | undefined;
  /** 追加的已校验条目（测试）。 */
  extra?: readonly ConnectorCatalogEntry[] | undefined;
  /** 本机连接条目（已校验）：合并之后追加。 */
  local?: readonly ConnectorCatalogEntry[] | undefined;
  /** 插件贡献条目（已由投影器改写）：本机条目之前追加。 */
  plugin?: readonly PluginConnectorEntry[] | undefined;
}

/** 本机连接的来源：`revision()` 变化 = 条目变了，目录需要重新合并。 */
export interface LocalConnectorSource {
  revision(): number;
  entries(): readonly ConnectorCatalogEntry[];
}

/** 插件贡献的连接器条目（已由连接器投影器改写过 tier / toolPolicy / packages）。 */
export interface PluginConnectorEntry {
  entry: ConnectorCatalogEntry;
  pluginId: string;
  /** 绝对路径，已确认在插件目录内；null = 没有图标。 */
  iconPath: string | null;
}

/** 插件连接器来源（`ConnectorsProjector`）：`revision()` 变化 = 条目变了。 */
export interface PluginConnectorSource {
  revision(): number;
  entries(): readonly PluginConnectorEntry[];
}

/** 校验并去重（坏条目 / 重复 slug 告警跳过）。 */
export function parseConnectorEntries(
  entries: readonly unknown[],
  logger?: Pick<CoreLogger, 'warn'>,
): ConnectorCatalogEntry[] {
  const out: ConnectorCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of entries.entries()) {
    const parsed = connectorCatalogEntrySchema.safeParse(raw);
    if (!parsed.success) {
      logger?.warn(
        { index, issues: parsed.error.issues.slice(0, 3).map((issue) => issue.message) },
        'connector catalog entry rejected',
      );
      continue;
    }
    const slug = connectorMetaOf(parsed.data).slug;
    if (seen.has(slug)) {
      logger?.warn({ slug }, 'connector catalog entry skipped: duplicate slug');
      continue;
    }
    seen.add(slug);
    out.push(parsed.data);
  }
  return out;
}

/** 生效的目录：校验 → 合并追加条目。 */
export function effectiveConnectorCatalog(
  options: ConnectorCatalogOptions,
): ConnectorCatalogEntry[] {
  return buildConnectorCatalog(options).entries;
}

/** {@link effectiveConnectorCatalog} 加上来源簿记（本机 / 插件、插件图标与归属、让位记录）。 */
export function buildConnectorCatalog(options: ConnectorCatalogOptions): {
  entries: ConnectorCatalogEntry[];
  /** 本机连接条目的 slug（已并入 `entries`）。 */
  localSlugs: ReadonlySet<string>;
  /** 插件贡献条目的 slug（已并入 `entries`）。 */
  pluginSlugs: ReadonlySet<string>;
  /** 插件条目的图标路径（slug → 插件目录内文件的绝对路径；null = 无图标）。 */
  pluginIcons: ReadonlyMap<string, string | null>;
  /** 插件条目的归属（slug → pluginId）。 */
  pluginOwners: ReadonlyMap<string, string>;
  /** 因 slug / name 冲突而让位的插件条目 slug。 */
  yieldedPluginSlugs: ReadonlySet<string>;
} {
  const source = options.source ?? { entries: [], iconsDir: null };
  const entries = parseConnectorEntries(source.entries, options.logger);
  const result = [...entries];
  // 追加的已校验条目（测试注入）：slug 先到先得。
  const taken = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  for (const extra of options.extra ?? []) {
    const slug = connectorMetaOf(extra).slug;
    if (taken.has(slug)) continue;
    taken.add(slug);
    result.push(extra);
  }
  // 插件贡献条目（D104）：与任何已有条目的 slug / name 冲突即让位，运行期不自动卸载。
  const pluginSlugs = new Set<string>();
  const pluginIcons = new Map<string, string | null>();
  const pluginOwners = new Map<string, string>();
  const yieldedPluginSlugs = new Set<string>();
  const appendedPluginNames = new Set<string>();
  const pluginTakenSlugs = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  const pluginTakenNames = new Set(entries.map((entry) => entry.name));
  for (const plugin of options.plugin ?? []) {
    const slug = connectorMetaOf(plugin.entry).slug;
    if (pluginTakenSlugs.has(slug) || pluginTakenNames.has(plugin.entry.name)) {
      options.logger?.warn(
        { slug, pluginId: plugin.pluginId },
        'plugin connector yielded: slug or name already taken',
      );
      yieldedPluginSlugs.add(slug);
      continue;
    }
    pluginTakenSlugs.add(slug);
    pluginTakenNames.add(plugin.entry.name);
    appendedPluginNames.add(plugin.entry.name);
    pluginSlugs.add(slug);
    pluginIcons.set(slug, plugin.iconPath);
    pluginOwners.set(slug, plugin.pluginId);
    result.push(plugin.entry);
  }
  // 内置来源条目的归属（D105）：投影器条目优先，内置条目补在其后——
  // 目录条目的 pluginId 因此对内置插件也可用（插件圈定的管理网格）。
  for (const [slug, ownerId] of options.sourceOwners ?? []) {
    if (!pluginOwners.has(slug) && pluginTakenSlugs.has(slug)) pluginOwners.set(slug, ownerId);
  }
  // 本机连接：追加在插件条目之后。与任何已有条目（含刚追加的插件条目的 slug 与 name）
  // 冲突即丢弃——本机让位于插件。
  const localSlugs = new Set<string>();
  const takenSlugs = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  const takenNames = new Set(entries.map((entry) => entry.name));
  for (const pluginSlug of pluginSlugs) takenSlugs.add(pluginSlug);
  for (const pluginName of appendedPluginNames) takenNames.add(pluginName);
  for (const local of options.local ?? []) {
    const slug = connectorMetaOf(local).slug;
    if (takenSlugs.has(slug) || takenNames.has(local.name)) {
      options.logger?.warn({ slug }, 'local connector skipped: slug or name already taken');
      continue;
    }
    takenSlugs.add(slug);
    takenNames.add(local.name);
    localSlugs.add(slug);
    result.push(local);
  }
  return {
    entries: result,
    localSlugs,
    pluginSlugs,
    pluginIcons,
    pluginOwners,
    yieldedPluginSlugs,
  };
}

/**
 * 目录服务：构造时解析一次并缓存（需要刷新就重建 / 来源 revision 变化时重算）。
 * `apps.catalog.list` RPC、连接服务与 `app_request_connection` 都经它查条目。
 */
export class ConnectorCatalog {
  readonly #options: ConnectorCatalogOptions;
  #local: LocalConnectorSource | undefined;
  #plugins: PluginConnectorSource | undefined;
  readonly #iconsDir: string | null;
  readonly #source: ConnectorCatalogSource;
  #entries: readonly ConnectorCatalogEntry[] = [];
  #localSlugs: ReadonlySet<string> = new Set();
  #pluginSlugs: ReadonlySet<string> = new Set();
  #pluginIcons: ReadonlyMap<string, string | null> = new Map();
  #pluginOwners: ReadonlyMap<string, string> = new Map();
  #yieldedPluginSlugs: ReadonlySet<string> = new Set();
  #revision = '';

  constructor(
    options: ConnectorCatalogOptions & {
      /** 本机连接来源（`LocalConnectors`）：条目变化时目录在下一次读取时重新合并。 */
      local?: LocalConnectorSource;
    },
  ) {
    this.#source = options.source ?? { entries: [], iconsDir: null };
    this.#iconsDir = this.#source.iconsDir;
    this.#options = options;
    this.#local = options.local;
    this.#refresh();
  }

  /** 接入本机连接来源（`start.ts`；注入的测试目录同样适用）。条目变化在下一次读取时合并。 */
  attachLocal(local: LocalConnectorSource): void {
    this.#local = local;
    this.#revision = '';
  }

  /** 接入插件连接器来源（D104，`ConnectorsProjector`）。条目变化在下一次读取时合并。 */
  attachPlugins(source: PluginConnectorSource): void {
    this.#plugins = source;
    this.#revision = '';
  }

  #refresh(): void {
    const revision = `${this.#local?.revision() ?? 0}:${this.#plugins?.revision() ?? 0}`;
    if (revision === this.#revision) return;
    this.#revision = revision;
    const built = buildConnectorCatalog({
      ...this.#options,
      source: this.#source,
      ...(this.#local !== undefined ? { local: this.#local.entries() } : {}),
      ...(this.#plugins !== undefined ? { plugin: this.#plugins.entries() } : {}),
    });
    this.#entries = built.entries;
    this.#localSlugs = built.localSlugs;
    this.#pluginSlugs = built.pluginSlugs;
    this.#pluginIcons = built.pluginIcons;
    this.#pluginOwners = built.pluginOwners;
    this.#yieldedPluginSlugs = built.yieldedPluginSlugs;
  }

  /** 全部条目（目录顺序）。 */
  list(): readonly ConnectorCatalogEntry[] {
    this.#refresh();
    return this.#entries;
  }

  /**
   * 该条目是否需要「目录级」的端点再校验（连接前重新断言为公网 https，永不给回环例外）：
   * 插件贡献的条目——其端点来自未经审核的包。`apps/connections.ts` 的连接入口调用它。
   */
  isDirectorySourced(slug: string): boolean {
    this.#refresh();
    return this.#pluginSlugs.has(slug);
  }

  /** 该条目是否是本机连接（Bot 读文档生成、只在本机、永不外传）。 */
  isLocal(slug: string): boolean {
    this.#refresh();
    return this.#localSlugs.has(slug);
  }

  /** 该条目是否是插件贡献（D104）。 */
  isPlugin(slug: string): boolean {
    this.#refresh();
    return this.#pluginSlugs.has(slug);
  }

  /** 插件条目的归属插件 id；非插件条目 = null。 */
  pluginIdOf(slug: string): string | null {
    this.#refresh();
    return this.#pluginOwners.get(slug) ?? null;
  }

  /** 因 slug / name 冲突而让位的插件条目 slug（「已安装」页标「冲突，已让位」）。 */
  yieldedPluginSlugs(): ReadonlySet<string> {
    this.#refresh();
    return this.#yieldedPluginSlugs;
  }

  /** 条目来源：`apps.catalog.list` 的 `origin`。 */
  originOf(slug: string): ConnectorOrigin {
    this.#refresh();
    return this.#localSlugs.has(slug) ? 'local' : 'plugin';
  }

  /** 按 slug 查（过滤后）；不在目录 = null。 */
  get(slug: string): ConnectorCatalogEntry | null {
    this.#refresh();
    return findConnectorBySlug(this.#entries, slug);
  }

  /** 图标 SVG 文本（供界面内联成 data URI）；非 svg / 缺失 = null。 */
  iconSvg(slug: string): string | null {
    const entry = this.get(slug);
    if (entry === null) return null;
    // 内置插件条目的图标与 server.json 同目录（D104 P0b，iconPaths 由加载器确认存在）。
    const iconPath = this.#source.iconPaths?.get(slug);
    if (iconPath !== undefined) {
      if (!iconPath.endsWith('.svg')) return null;
      try {
        return readFileSync(iconPath, 'utf8');
      } catch {
        return null;
      }
    }
    // 插件贡献条目读插件目录里的图标文件（`iconPath` 由投影器确认在插件目录内）。
    if (this.#pluginSlugs.has(slug)) {
      const pluginIconPath = this.#pluginIcons.get(slug);
      if (pluginIconPath === undefined || pluginIconPath === null) return null;
      if (!pluginIconPath.endsWith('.svg')) return null;
      try {
        return readFileSync(pluginIconPath, 'utf8');
      } catch {
        return null;
      }
    }
    if (this.#iconsDir === null) return null;
    // 本机条目：图标文件名是占位，不去读。
    if (this.#localSlugs.has(slug)) return null;
    const icon = connectorMetaOf(entry).icon;
    if (!icon.endsWith('.svg')) return null;
    // `icon` is a bare filename (connectorIconSchema forbids separators), so it cannot escape.
    try {
      return readFileSync(path.join(this.#iconsDir, icon), 'utf8');
    } catch {
      return null;
    }
  }
}

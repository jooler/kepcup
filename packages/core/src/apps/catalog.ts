import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectorCatalogEntrySchema,
  connectorCatalogFileSchema,
  connectorMetaOf,
  filterReleasedConnectors,
  findConnectorBySlug,
  type ConnectorCatalogEntry,
  type ConnectorOrigin,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import { mergeDirectoryEntries } from './directory-merge.js';

/**
 * 连接应用目录（D73 P1 §5.2，设计 29 §4）的运行时加载。
 *
 * 数据来自随应用打包的 `apps/desktop/resources/connectors/catalog.json` 与
 * `icons/*.svg`（照 `skills/presets.ts` 读资源 JSON；打包后由 core-host 经
 * `KEPCUP_CONNECTORS` 指向 `Resources/connectors`，开发态向上查找 `apps/` 祖先）。
 * 单个坏条目只告警并跳过，不拖垮整个目录；slug 重复时保留先出现者。
 *
 * 发行门禁（照 D72 `agent/external/catalog.ts`）：打包脚本以 esbuild define 注入
 * `__KEPCUP_CONNECTOR_RELEASE_GATES__`（放行清单）；开发构建、tsc 产物与测试里
 * 该常量不存在 → 不过滤。目录对外只暴露过滤后的条目。
 *
 * 本机连接（`local()` 来源，todo/local-connector-authoring.md）：在打包快照与远端目录合并**之后**
 * 追加，**不经发行门禁**——它们不是发行产物（`releaseGate: 'local'` 不在任何放行清单里），而是
 * 独立来源；与已有条目的 slug / name 冲突时本机条目被丢弃（打包 / 远端条目永远优先）。
 */

/** 资源目录：env 覆盖 → 向上查找 `apps/desktop/resources/connectors` → null（目录为空）。 */
export function resolveConnectorsDir(env: NodeJS.ProcessEnv): string | null {
  const override = env.KEPCUP_CONNECTORS;
  if (override !== undefined && override.length > 0) {
    return existsSync(override) ? path.resolve(override) : null;
  }
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, 'apps', 'desktop', 'resources', 'connectors');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** 构建期注入的放行清单；未注入（开发 / 测试）= null = 不过滤。 */
export function connectorReleaseGates(): readonly string[] | null {
  return typeof __KEPCUP_CONNECTOR_RELEASE_GATES__ === 'undefined'
    ? null
    : __KEPCUP_CONNECTOR_RELEASE_GATES__;
}

/** 一份已解析的目录数据：条目 + 图标目录（测试可直接注入）。 */
export interface ConnectorCatalogSource {
  /** `catalog.json` 的 `connectors` 数组（未校验）。 */
  entries: readonly unknown[];
  /** 图标所在目录；null = 没有图标文件。 */
  iconsDir: string | null;
}

export interface ConnectorCatalogOptions {
  env: NodeJS.ProcessEnv;
  logger?: Pick<CoreLogger, 'warn'> | undefined;
  /** 注入数据（测试）；缺省从资源目录读取。 */
  source?: ConnectorCatalogSource | undefined;
  /**
   * 放行清单：`null` = 不过滤；缺省取构建期注入值（{@link connectorReleaseGates}）。
   * 注意 `undefined`（缺省）与 `null`（显式不过滤）不同。
   */
  approvedGates?: readonly string[] | null | undefined;
  /** 追加的已校验条目（测试 / 开发者模式）；同样受门禁约束。 */
  extra?: readonly ConnectorCatalogEntry[] | undefined;
  /**
   * 已验签的远端目录条目（D73 P3 §7.1，`DirectorySync`）：未校验的原始条目，按
   * `directory-merge.ts` 的规则并入打包快照，之后仍整体过发行门禁。
   */
  remote?: readonly unknown[] | undefined;
  /** 本机连接条目（已校验）：合并之后追加，不经发行门禁。 */
  local?: readonly ConnectorCatalogEntry[] | undefined;
}

/** 本机连接的来源：`revision()` 变化 = 条目变了，目录需要重新合并。 */
export interface LocalConnectorSource {
  revision(): number;
  entries(): readonly ConnectorCatalogEntry[];
}

/** 远端目录的来源：`revision()` 变化 = 条目变了，目录需要重新合并。 */
export interface RemoteDirectorySource {
  revision(): number;
  entries(): readonly unknown[];
}

/** 读取资源目录里的 catalog.json；缺失 / 损坏 → 空来源并告警。 */
export function readConnectorCatalogSource(
  env: NodeJS.ProcessEnv,
  logger?: Pick<CoreLogger, 'warn'>,
): ConnectorCatalogSource {
  const dir = resolveConnectorsDir(env);
  if (dir === null) return { entries: [], iconsDir: null };
  const file = path.join(dir, 'catalog.json');
  try {
    const parsed = connectorCatalogFileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    if (!parsed.success) {
      logger?.warn({ file }, 'connector catalog.json failed schema validation');
      return { entries: [], iconsDir: null };
    }
    return { entries: parsed.data.connectors, iconsDir: path.join(dir, 'icons') };
  } catch (error) {
    logger?.warn(
      { file, error: error instanceof Error ? error.message : String(error) },
      'connector catalog.json unreadable',
    );
    return { entries: [], iconsDir: null };
  }
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

/** 生效的目录：校验 → 并入远端条目 → 合并追加条目 → 发行门禁过滤。 */
export function effectiveConnectorCatalog(
  options: ConnectorCatalogOptions,
): ConnectorCatalogEntry[] {
  return buildConnectorCatalog(options).entries;
}

/** {@link effectiveConnectorCatalog} 加上远端独有条目的 slug（这些条目没有打包图标）。 */
export function buildConnectorCatalog(options: ConnectorCatalogOptions): {
  entries: ConnectorCatalogEntry[];
  remoteOnlySlugs: ReadonlySet<string>;
  /** 本机连接条目的 slug（已并入 `entries`）。 */
  localSlugs: ReadonlySet<string>;
} {
  const source = options.source ?? readConnectorCatalogSource(options.env, options.logger);
  let entries = parseConnectorEntries(source.entries, options.logger);
  let remoteOnlySlugs: ReadonlySet<string> = new Set();
  if (options.remote !== undefined && options.remote.length > 0) {
    const merged = mergeDirectoryEntries(
      entries,
      parseConnectorEntries(options.remote, options.logger),
      options.logger,
    );
    entries = merged.entries;
    remoteOnlySlugs = merged.remoteOnlySlugs;
  }
  const taken = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  for (const extra of options.extra ?? []) {
    const slug = connectorMetaOf(extra).slug;
    if (taken.has(slug)) continue;
    taken.add(slug);
    entries.push(extra);
  }
  const gates =
    options.approvedGates === undefined ? connectorReleaseGates() : options.approvedGates;
  // 发行门禁只约束快照 / 追加来源的条目；远端独有条目（已验签、端点已校验）不受厂商门禁约束，
  // 见 directory-merge.ts 第 4 条。
  const isRemoteOnly = (entry: ConnectorCatalogEntry): boolean =>
    remoteOnlySlugs.has(connectorMetaOf(entry).slug);
  const released = new Set(
    filterReleasedConnectors(
      entries.filter((entry) => !isRemoteOnly(entry)),
      gates,
    ),
  );
  const result = entries.filter((entry) => isRemoteOnly(entry) || released.has(entry));
  // 本机连接：独立来源，追加在门禁之后。与任何已有条目（含被门禁挡掉的）的 slug / name 冲突即丢弃。
  const localSlugs = new Set<string>();
  const takenSlugs = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  const takenNames = new Set(entries.map((entry) => entry.name));
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
  return { entries: result, remoteOnlySlugs, localSlugs };
}

/**
 * 目录服务：构造时解析一次并缓存（目录随应用版本不变；需要刷新就重建）。
 * `apps.catalog.list` RPC、连接服务与 `app_request_connection` 都经它查条目。
 */
export class ConnectorCatalog {
  readonly #options: ConnectorCatalogOptions;
  readonly #directory: RemoteDirectorySource | undefined;
  #local: LocalConnectorSource | undefined;
  readonly #iconsDir: string | null;
  readonly #source: ConnectorCatalogSource;
  #entries: readonly ConnectorCatalogEntry[] = [];
  #remoteOnlySlugs: ReadonlySet<string> = new Set();
  #localSlugs: ReadonlySet<string> = new Set();
  #revision = '';

  /**
   * `directory`（D73 P3 §7.1）：已验签的远端目录来源。远端条目变化时（`revision()` 变了）
   * 目录在下一次读取时重新合并；缺省 = 只有打包快照（目录随应用版本不变）。
   */
  constructor(
    options: ConnectorCatalogOptions & {
      directory?: RemoteDirectorySource;
      /** 本机连接来源（`LocalConnectors`）：条目变化时目录在下一次读取时重新合并。 */
      local?: LocalConnectorSource;
    },
  ) {
    this.#source = options.source ?? readConnectorCatalogSource(options.env, options.logger);
    this.#iconsDir = this.#source.iconsDir;
    this.#options = options;
    this.#directory = options.directory;
    this.#local = options.local;
    this.#refresh();
  }

  /** 接入本机连接来源（`start.ts`；注入的测试目录同样适用）。条目变化在下一次读取时合并。 */
  attachLocal(local: LocalConnectorSource): void {
    this.#local = local;
    this.#revision = '';
  }

  #refresh(): void {
    const revision = `${this.#directory?.revision() ?? 0}:${this.#local?.revision() ?? 0}`;
    if (revision === this.#revision) return;
    this.#revision = revision;
    const built = buildConnectorCatalog({
      ...this.#options,
      source: this.#source,
      ...(this.#directory !== undefined ? { remote: this.#directory.entries() } : {}),
      ...(this.#local !== undefined ? { local: this.#local.entries() } : {}),
    });
    this.#entries = built.entries;
    this.#remoteOnlySlugs = built.remoteOnlySlugs;
    this.#localSlugs = built.localSlugs;
  }

  /** 门禁放行后的全部条目（目录顺序）。 */
  list(): readonly ConnectorCatalogEntry[] {
    this.#refresh();
    return this.#entries;
  }

  /**
   * 该条目是否来自已验签的远端目录（不在打包快照里）。这类条目永远拿不到回环例外：连接前
   * 端点要重新校验为公网 https（`isSafeDirectoryRemoteUrl`）。
   */
  isDirectorySourced(slug: string): boolean {
    this.#refresh();
    return this.#remoteOnlySlugs.has(slug);
  }

  /** 该条目是否是本机连接（Bot 读文档生成、只在本机；不经发行门禁、永不外传）。 */
  isLocal(slug: string): boolean {
    this.#refresh();
    return this.#localSlugs.has(slug);
  }

  /** 条目来源：`apps.catalog.list` 的 `origin`。 */
  originOf(slug: string): ConnectorOrigin {
    this.#refresh();
    return this.#localSlugs.has(slug)
      ? 'local'
      : this.#remoteOnlySlugs.has(slug)
        ? 'directory'
        : 'bundled';
  }

  /** 按 slug 查（过滤后）；不在目录 = null。 */
  get(slug: string): ConnectorCatalogEntry | null {
    this.#refresh();
    return findConnectorBySlug(this.#entries, slug);
  }

  /** 图标 SVG 文本（供界面内联成 data URI）；非 svg / 缺失 = null。 */
  iconSvg(slug: string): string | null {
    const entry = this.get(slug);
    if (entry === null || this.#iconsDir === null) return null;
    // 远端独有的条目没有打包图标：不能按它声明的文件名去读（会冒用快照条目的图标）。
    if (this.#remoteOnlySlugs.has(slug)) return null;
    // 本机条目同理：图标文件名是占位，不去读。
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

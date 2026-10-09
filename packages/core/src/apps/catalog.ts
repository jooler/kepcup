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
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

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

/** 生效的目录：校验 → 合并追加条目 → 发行门禁过滤。 */
export function effectiveConnectorCatalog(
  options: ConnectorCatalogOptions,
): ConnectorCatalogEntry[] {
  const source = options.source ?? readConnectorCatalogSource(options.env, options.logger);
  const entries = parseConnectorEntries(source.entries, options.logger);
  const taken = new Set(entries.map((entry) => connectorMetaOf(entry).slug));
  for (const extra of options.extra ?? []) {
    const slug = connectorMetaOf(extra).slug;
    if (taken.has(slug)) continue;
    taken.add(slug);
    entries.push(extra);
  }
  const gates =
    options.approvedGates === undefined ? connectorReleaseGates() : options.approvedGates;
  return filterReleasedConnectors(entries, gates);
}

/**
 * 目录服务：构造时解析一次并缓存（目录随应用版本不变；需要刷新就重建）。
 * `apps.catalog.list` RPC、连接服务与 `app_request_connection` 都经它查条目。
 */
export class ConnectorCatalog {
  readonly #entries: readonly ConnectorCatalogEntry[];
  readonly #iconsDir: string | null;

  constructor(options: ConnectorCatalogOptions) {
    const source = options.source ?? readConnectorCatalogSource(options.env, options.logger);
    this.#iconsDir = source.iconsDir;
    this.#entries = effectiveConnectorCatalog({ ...options, source });
  }

  /** 门禁放行后的全部条目（目录顺序）。 */
  list(): readonly ConnectorCatalogEntry[] {
    return this.#entries;
  }

  /** 按 slug 查（过滤后）；不在目录 = null。 */
  get(slug: string): ConnectorCatalogEntry | null {
    return findConnectorBySlug(this.#entries, slug);
  }

  /** 图标 SVG 文本（供界面内联成 data URI）；非 svg / 缺失 = null。 */
  iconSvg(slug: string): string | null {
    const entry = this.get(slug);
    if (entry === null || this.#iconsDir === null) return null;
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

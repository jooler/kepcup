import {
  CONNECTOR_META_KEY,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  type ConnectorCatalogEntry,
  type ConnectorMeta,
  type ConnectorTier,
  type McpToolRisk,
} from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';

/**
 * 已验签的远端目录条目与随应用打包的快照合并（D73 P3 §7.1，设计 29 §11.4）。
 *
 * 快照是锚点，远端只能在它划定的边界内**补充 / 更新**：
 *
 * 1. 键 = 注册表 `name`。同名条目只有远端 `version` **严格更高**才替换；相等 / 更低 / 无法比较
 *    都保留快照（要改内容必须升版本）。
 * 2. slug 是工具前缀 `app_{slug}_*` 与既有连接行的键：同名条目的 slug 不得变；远端条目
 *    占用了快照里**别的**条目的 slug（冒名）或与另一个远端条目重复 → 丢弃。
 * 3. **分级只升不降快照里的 `builtin`**：同名条目快照为 `builtin` 则恒为 `builtin`；
 *    远端独有的条目声称 `builtin` 一律按 `verified` 处理；`developer`（仅本机手动添加）丢弃。
 * 4. **发行门禁对快照条目留在客户端**：同名条目 `releaseGate` 取快照的（合并之后快照来源的
 *    条目仍整体过 `filterReleasedConnectors`）。**远端独有条目不受厂商门禁约束**——已验签的
 *    签名就是授权（否则社区目录在发行构建里永远是空的）；它们声明的 `releaseGate` 一律被忽略、
 *    改写为 {@link DIRECTORY_RELEASE_GATE}（抄快照里某个已放行的门禁字符串也换不来可见性
 *    之外的任何东西，因为它们本来就可见；不能借此覆盖快照条目）。
 * 5. 快照里 `builtin` 条目的敏感字段**钉死**为快照值：`remotes` / `packages`（令牌与代码
 *    的去向）、`auth`、`whoami`、`icon`、`slug`、`skills`（技能来源）。`toolPolicy`：远端
 *    只能调高快照里已有工具的风险；快照里没有的工具只接受 `destructive`（`builtin` 条目会让
 *    「未声明注解」的工具取覆盖值，低于缺省的 destructive 就是放宽 W5）。远端能更新的是
 *    标题 / 描述 / 版本 / 隐私政策 / 类别 / `ui`——换端点必须发新版应用。
 * 6. 远端独有条目没有打包图标（调用方据 {@link DirectoryMergeResult.remoteOnlySlugs} 不读图标）。
 * 7. 远端条目的 `remotes[].url` 必须是公网 https 域名（{@link isSafeDirectoryRemoteUrl}）：
 *    不得有用户信息、不得是 IP 字面量 / `localhost`——目录来源的条目永远拿不到回环例外。
 */

/** 远端独有条目被改写成的发行门禁值（不属于任何厂商门禁）。 */
export const DIRECTORY_RELEASE_GATE = 'directory';

/**
 * 目录来源条目的远程端点是否可接受：https、无用户信息、主机是带点的域名（不是 IP 字面量、
 * 不是 `localhost` / `*.localhost`）。端口不限；解析到私网地址由连接时的 SSRF 守卫拒绝。
 */
export function isSafeDirectoryRemoteUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || host.includes(':')) return false;
  return host.includes('.');
}

const RISK_ORDER: Record<McpToolRisk, number> = { read: 0, write: 1, destructive: 2 };

export interface DirectoryMergeResult {
  /** 合并后的条目：快照顺序（同名被替换处原位替换）+ 远端独有条目追加在后。 */
  entries: ConnectorCatalogEntry[];
  /** 远端独有条目的 slug：没有打包图标，不得按文件名去读（防冒用快照条目的图标）。 */
  remoteOnlySlugs: Set<string>;
  /** 被丢弃的远端条目与原因（诊断 / 测试）。 */
  dropped: Array<{ name: string; reason: string }>;
  /** 替换了快照条目的远端条目名。 */
  replaced: string[];
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/** semver 比较（构建元数据忽略；预发行 < 正式）；任一方不可解析 = null。 */
export function compareConnectorVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    const delta = (left.core[i] as number) - (right.core[i] as number);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const lp = left.pre.split('.');
  const rp = right.pre.split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    const x = lp[i];
    const y = rp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function withMeta(entry: ConnectorCatalogEntry, meta: ConnectorMeta): ConnectorCatalogEntry {
  return { ...entry, _meta: { ...entry._meta, [CONNECTOR_META_KEY]: meta } };
}

/**
 * `toolPolicy` 合并：远端只能调高快照里已有工具的风险；快照里没有的工具只接受 `destructive`。
 */
function raiseOnlyToolPolicy(
  bundled: ConnectorMeta['toolPolicy'],
  remote: ConnectorMeta['toolPolicy'],
): ConnectorMeta['toolPolicy'] {
  const merged: ConnectorMeta['toolPolicy'] = { ...bundled };
  for (const [tool, policy] of Object.entries(remote)) {
    const current = merged[tool];
    const accept =
      current === undefined
        ? policy.risk === 'destructive'
        : RISK_ORDER[policy.risk] > RISK_ORDER[current.risk];
    if (accept) merged[tool] = policy;
  }
  return merged;
}

/** 同名条目：远端版本更高时的合并结果（见文件头第 3–5 条）。 */
function mergeSameName(
  bundled: ConnectorCatalogEntry,
  remote: ConnectorCatalogEntry,
): ConnectorCatalogEntry {
  const bm = connectorMetaOf(bundled);
  const rm = connectorMetaOf(remote);
  if (bm.tier === 'builtin') {
    return withMeta(
      { ...remote, remotes: bundled.remotes, packages: bundled.packages },
      {
        ...rm,
        slug: bm.slug,
        tier: 'builtin',
        icon: bm.icon,
        auth: bm.auth,
        skills: bm.skills,
        ...(bm.whoami !== undefined ? { whoami: bm.whoami } : {}),
        releaseGate: bm.releaseGate,
        toolPolicy: raiseOnlyToolPolicy(bm.toolPolicy, rm.toolPolicy),
      },
    );
  }
  // 快照里非 builtin（目前不存在）：远端分级生效（可降级），但不能自称 builtin，门禁取快照。
  const tier: ConnectorTier = rm.tier === 'builtin' ? 'verified' : rm.tier;
  return withMeta(remote, { ...rm, slug: bm.slug, tier, releaseGate: bm.releaseGate });
}

export function mergeDirectoryEntries(
  bundled: readonly ConnectorCatalogEntry[],
  remote: readonly ConnectorCatalogEntry[],
  logger?: Pick<CoreLogger, 'warn'>,
): DirectoryMergeResult {
  const result: DirectoryMergeResult = {
    entries: [...bundled],
    remoteOnlySlugs: new Set(),
    dropped: [],
    replaced: [],
  };
  const drop = (name: string, reason: string): void => {
    result.dropped.push({ name, reason });
    logger?.warn({ name, reason }, 'directory entry ignored');
  };
  const indexByName = new Map(bundled.map((entry, index) => [entry.name, index]));
  const slugOwner = new Map(bundled.map((entry) => [connectorMetaOf(entry).slug, entry.name]));
  const seenRemote = new Set<string>();

  for (const entry of remote) {
    const meta = connectorMetaOf(entry);
    if (seenRemote.has(entry.name)) {
      drop(entry.name, 'duplicate_name');
      continue;
    }
    seenRemote.add(entry.name);
    if (meta.tier === 'developer') {
      drop(entry.name, 'developer_tier_not_allowed');
      continue;
    }
    if (!entry.remotes.every((remote) => isSafeDirectoryRemoteUrl(remote.url))) {
      drop(entry.name, 'unsafe_remote_url');
      continue;
    }
    const index = indexByName.get(entry.name);
    if (index !== undefined) {
      const current = result.entries[index] as ConnectorCatalogEntry;
      if (connectorMetaOf(current).slug !== meta.slug) {
        drop(entry.name, 'slug_changed');
        continue;
      }
      const order = compareConnectorVersions(entry.version, current.version);
      if (order === null || order <= 0) continue; // 保留快照（无需告警：每次同步都是常态）
      const merged = mergeSameName(current, entry);
      // 合并结果仍须是合法条目（防御：字段拼接不应破坏 schema）。
      if (!connectorCatalogEntrySchema.safeParse(merged).success) {
        drop(entry.name, 'merged_entry_invalid');
        continue;
      }
      result.entries[index] = merged;
      result.replaced.push(entry.name);
      continue;
    }
    const owner = slugOwner.get(meta.slug);
    if (owner !== undefined) {
      drop(entry.name, `slug_conflict:${owner}`);
      continue;
    }
    const tier: ConnectorTier = meta.tier === 'builtin' ? 'verified' : meta.tier;
    slugOwner.set(meta.slug, entry.name);
    result.remoteOnlySlugs.add(meta.slug);
    result.entries.push(withMeta(entry, { ...meta, tier, releaseGate: DIRECTORY_RELEASE_GATE }));
  }
  return result;
}

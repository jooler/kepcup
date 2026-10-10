import type { McpToolRisk } from '../domain/types.js';
import { classifyRiskDetailed, type ToolRiskDetail, type ToolRiskInput } from './risk.js';
import { sha256Hex } from './sha256.js';

/**
 * 连接应用的工具策略（D73 P1，docs/design/29-connected-apps.md §8.1 / §8.2；纯函数）：
 *
 * 1. {@link classifyAppToolRisk}：在 W5 分级器（`mcp/risk.ts`）外层叠加目录 `toolPolicy`。
 *    叠加**只能调高**；`builtin` 条目（经 KepCup 审核）可为「未声明注解且名字推断不出只读」
 *    的工具给出分级（W5 对它们只能取缺省 destructive），但不能放宽 W5 的任何其它判定。
 *    `openWorldHint` 不参与分级（只用于 §8.3 的污点外发判定）。
 * 2. {@link toolDefinitionHash}：工具定义的规范化哈希（工具定义锁定，§8.2）。
 *
 * 本文件从 packages/core/src/apps/policy.ts 迁入 shared（D73 P3 §7.4）；哈希用纯 JS 的
 * `sha256Hex`（shared 同时被打进渲染端，不能引 `node:crypto`），输出与原实现逐字节一致。
 */

/** 目录条目的信任等级（design 29 §4）。 */
export type CatalogTier = 'builtin' | 'verified' | 'community' | 'developer';

/**
 * 目录条目里与分级有关的部分（`_meta["app.kepcup/connector"]` 的 `tier` 与 `toolPolicy`）。
 * 刻意只依赖这个最小形状而不是目录 schema 类型：`toolPolicy` 的值既可以写成风险档字符串，
 * 也可以写成 `{ risk }`（设计 29 §4 示例）。
 */
export interface CatalogToolPolicyInput {
  tier: CatalogTier | (string & {});
  toolPolicy?: Readonly<Record<string, McpToolRisk | { risk: McpToolRisk }>> | undefined;
}

export type ToolRiskOverlay = 'none' | 'raised' | 'classified';

export interface AppToolRiskDetail extends ToolRiskDetail {
  /**
   * 目录叠加的效果：`none` = 未叠加（或无效 / 不起作用）；`raised` = 把 W5 的结果调高了；
   * `classified` = builtin 条目为 W5 只能取缺省的工具给出了分级。
   */
  overlay: ToolRiskOverlay;
}

const RISK_ORDER: Record<McpToolRisk, number> = { read: 0, write: 1, destructive: 2 };

function overlayRisk(
  catalog: CatalogToolPolicyInput | undefined,
  toolName: string,
): McpToolRisk | null {
  const entry = catalog?.toolPolicy?.[toolName];
  if (entry === undefined) return null;
  const risk = typeof entry === 'string' ? entry : entry.risk;
  return risk === 'read' || risk === 'write' || risk === 'destructive' ? risk : null;
}

/**
 * 风险分级（W5）+ 目录叠加。结果规则：
 * - 无叠加 → W5 的结果；
 * - W5 的判定来自缺省（`source: 'default'`：没有只读声明、没有 `destructiveHint:false`，
 *   名字也推断不出只读）且条目是 `builtin` → 取叠加值（可低于 destructive，但仍只是对
 *   「缺省取严」的细化，不是放宽任何一个显式判定）；
 * - 其余 → `max(W5, 叠加)`：只能调高，永远不能放宽。
 */
export function classifyAppToolRisk(
  tool: ToolRiskInput,
  catalog?: CatalogToolPolicyInput,
): AppToolRiskDetail {
  return applyCatalogOverlay(classifyRiskDetailed(tool), tool.name, catalog);
}

/**
 * 把目录叠加规则作用在**已有的** W5 判定上（`classifyAppToolRisk` 的后半）：网关调用时只有
 * `McpService.riskOf` 给的 W5 结果（注解不外露），用它叠加同样的规则。
 */
export function applyCatalogOverlay(
  base: ToolRiskDetail,
  toolName: string,
  catalog?: CatalogToolPolicyInput,
): AppToolRiskDetail {
  const wanted = overlayRisk(catalog, toolName);
  if (wanted === null) return { ...base, overlay: 'none' };
  if (catalog?.tier === 'builtin' && base.source === 'default') {
    return {
      risk: wanted,
      source: base.source,
      overlay: wanted === base.risk ? 'none' : 'classified',
    };
  }
  if (RISK_ORDER[wanted] > RISK_ORDER[base.risk]) {
    return { risk: wanted, source: base.source, overlay: 'raised' };
  }
  return { ...base, overlay: 'none' };
}

/** 参与哈希的工具字段（设计 29 §8.2：name + description + inputSchema + annotations，另含 title）。 */
export interface HashableTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: unknown;
}

/** 键排序的规范化 JSON；`undefined` 字段与 JSON.stringify 一样被忽略（数组里的 undefined 成 null）。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : sortKeys(item)));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = sortKeys(item);
    }
    return out;
  }
  return value;
}

/** 工具定义哈希：`{ name, title, description, inputSchema, annotations }` 规范化后 sha256 hex。 */
export function toolDefinitionHash(tool: HashableTool): string {
  const canonical = canonicalJson({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  });
  return sha256Hex(canonical);
}

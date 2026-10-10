import type { McpToolRisk, McpToolRiskSource } from '../domain/types.js';

/**
 * MCP 工具风险分级（W5，todo/borrowings-from-personal-agents.md；D65 修订，
 * 提前落地 D73 docs/design/29-connected-apps.md §8.1 的 classifyRisk）。
 *
 * 三档：`read`（只读，默认免审批、可进对话轮）/ `write`（每次确认）/
 * `destructive`（每次确认，卡片警示色）。规则：
 * - server 自报的注解不可信，只能把工具**放宽到只读**，且受名字一票否决：
 *   名字含写动词（create / delete / send …）或复合动作（`_and_` / `_or_` /
 *   `_then_`）的工具，声明 `readOnlyHint:true` 也不算只读。
 * - 没有任何只读声明（`readOnlyHint` 缺失）但名字以明确的只读动词开头
 *   （get / list / search …）且不含写动词 → 只读（判定来源 `name`）。
 * - `readOnlyHint:false`（显式声明非只读）永远不走名字放宽。
 * - `destructiveHint:false` 只把默认从 destructive 降到 write，不免审批。
 * - 其余（含缺省注解）按 MCP 规范缺省值取严 → destructive。
 *
 * 名字先归一化（camelCase / kebab-case / 点号 → 下划线、小写）再匹配，使
 * `deleteFile`、`send-mail` 一样被否决（比原方案只认下划线更严）。
 *
 * W2（外部副作用台账）与 D73 连接应用复用本模块：类型从这里导入。
 *
 * 本文件从 packages/core/src/mcp/risk.ts 原样迁入 shared（D73 P3 §7.4，校验器 CLI 复用，
 * 不得依赖 Electron / Node-only 模块）；core 里的原路径只保留再导出。
 */

/**
 * MCP 工具注解（MCP 规范 `ToolAnnotations` 的结构子集；与 pi-mcp 的同名类型结构兼容）。
 * 本模块在 shared 内、不依赖 MCP 客户端库，所以校验器 CLI 与渲染端都能复用。
 */
export interface ToolAnnotationsLike {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

export type ToolRisk = McpToolRisk;
export type ToolRiskSource = McpToolRiskSource;

export interface ToolRiskInput {
  name: string;
  annotations?: ToolAnnotationsLike | undefined;
}

export interface ToolRiskDetail {
  risk: ToolRisk;
  /** 判定来源（设置页显示「按注解 / 按名字推断 / 缺省」）。 */
  source: ToolRiskSource;
}

const READ_VERBS =
  /^(get|list|search|find|read|fetch|query|lookup|describe|view|show|count|check|stat)(_|$)/;
const MUTATING_VERBS =
  /(^|_)(create|update|delete|remove|send|post|put|patch|write|set|add|move|rename|archive|publish|submit|pay|transfer|invite|share|merge|close|cancel|approve|reply|forward|upload|exec|execute|run|invoke|trigger|drop|insert|edit|modify|clear|reset|revoke|kill|save|toggle|enable|disable|buy|check_in|checkin)(_|$)/;
/**
 * 也常作名词的写动词（`get_commit`、`get_order`、`get_sync_status` 是读）：
 * 只在名字开头时否决（`commit_changes`、`order_pizza`、`sync_repo`）。
 */
const MUTATING_LEADING_VERBS =
  /^(commit|push|deploy|install|import|sync|start|stop|mark|order|book|grant)(_|$)/;
const COMPOUND = /_(and|or|then)_/;

/** `deleteFile` / `send-mail` / `Get.Items` → `delete_file` / `send_mail` / `get_items`. */
export function normalizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/** 名字含写动词或复合动作：一票否决「只读」。 */
export function nameLooksMutating(name: string): boolean {
  const normalized = normalizeToolName(name);
  return (
    MUTATING_VERBS.test(normalized) ||
    MUTATING_LEADING_VERBS.test(normalized) ||
    COMPOUND.test(normalized)
  );
}

/** 名字以明确的只读动词开头（不检查写动词，见 nameLooksMutating）。 */
export function nameLooksReadOnly(name: string): boolean {
  return READ_VERBS.test(normalizeToolName(name));
}

/** 风险档 + 判定来源。 */
export function classifyRiskDetailed(tool: ToolRiskInput): ToolRiskDetail {
  const annotations = tool.annotations;
  const nameMutating = nameLooksMutating(tool.name);
  if (annotations?.readOnlyHint === true && !nameMutating) {
    return { risk: 'read', source: 'annotation' };
  }
  // 已定：无只读声明但名字是明确只读动词 → 视为只读（设置页标「按名字推断」）。
  if (annotations?.readOnlyHint === undefined && nameLooksReadOnly(tool.name) && !nameMutating) {
    return { risk: 'read', source: 'name' };
  }
  if (annotations?.destructiveHint === false) {
    return { risk: 'write', source: 'annotation' };
  }
  if (annotations?.readOnlyHint === true && nameMutating) {
    // 声明只读，但名字像写操作：名字否决，按缺省取严。
    return { risk: 'destructive', source: 'name' };
  }
  if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true) {
    return { risk: 'destructive', source: 'annotation' };
  }
  return { risk: 'destructive', source: 'default' };
}

export function classifyRisk(tool: ToolRiskInput): ToolRisk {
  return classifyRiskDetailed(tool).risk;
}

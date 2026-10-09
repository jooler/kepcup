import type { McpServer, McpToolRisk, McpToolRiskSource } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * W5（MCP 工具风险分级）渲染端纯函数：风险徽标文案、Bot 详情 MCP 区的无人值守
 * 风险提示、设置页逐工具策略的读写。core 侧分级器见
 * packages/core/src/mcp/risk.ts。
 */

export const MCP_RISK_LABEL_KEYS: Record<McpToolRisk, MessageKey> = {
  read: 'mcp.riskRead',
  write: 'mcp.riskWrite',
  destructive: 'mcp.riskDestructive',
};

export const MCP_RISK_SOURCE_KEYS: Record<McpToolRiskSource, MessageKey> = {
  annotation: 'mcp.riskSourceAnnotation',
  name: 'mcp.riskSourceName',
  default: 'mcp.riskSourceDefault',
};

export interface McpToolRiskRow {
  name: string;
  risk: McpToolRisk;
  missing?: boolean | undefined;
}

/** 写入 / 破坏性且未被停用（仍可能被调用）的工具数。 */
export function countRiskyTools(server: Pick<McpServer, 'toolPolicies'>, tools: McpToolRiskRow[]): number {
  return tools.filter(
    (tool) =>
      tool.missing !== true &&
      tool.risk !== 'read' &&
      server.toolPolicies?.[tool.name]?.enabled !== false,
  ).length;
}

export interface McpUnattendedNotice {
  /** 选了任一 MCP server 就常驻显示。 */
  show: boolean;
  /**
   * 无人值守当前生效，且选中 server 里有写入 / 破坏性工具或无法确认风险
   * （连不上 / 查询失败）：警示样式。
   */
  warning: boolean;
  /** 警示时的写入 / 破坏性工具数（已确认的部分）。 */
  riskyCount: number;
  /** 有 server 的工具风险没能确认（按可能含写入 / 删除类工具对待）。 */
  unknown: boolean;
}

/**
 * Bot 详情 MCP 区提示（W5 设计 6）：选了 server 即常驻；无人值守生效且选中的
 * server 里有写入 / 破坏性工具时升级为警示并给出数量；任一 server 的风险没能
 * 确认（`riskUnknown`）时同样警示（「无法确认工具风险」）。`riskyCount` 为
 * null = 尚未取到工具风险（只显示常驻提示）。
 */
export function mcpUnattendedNotice(input: {
  selectedServerCount: number;
  unattendedEnabled: boolean;
  riskyCount: number | null;
  riskUnknown?: boolean;
}): McpUnattendedNotice {
  const show = input.selectedServerCount > 0;
  const riskyCount = input.riskyCount ?? 0;
  const unknown = show && input.unattendedEnabled && input.riskUnknown === true;
  return {
    show,
    warning: show && input.unattendedEnabled && (riskyCount > 0 || unknown),
    riskyCount,
    unknown,
  };
}

export type McpApprovalChoice = 'default' | 'auto' | 'ask';

/**
 * 设置页逐工具策略写回：approval 'default' 删除覆盖；enabled true 删除覆盖；
 * 空策略整条删除。返回新的 toolPolicies（空则 undefined）。
 */
export function withToolPolicy(
  policies: McpServer['toolPolicies'],
  toolName: string,
  patch: { approval?: McpApprovalChoice; enabled?: boolean },
): McpServer['toolPolicies'] {
  const next = { ...(policies ?? {}) };
  const current = { ...(next[toolName] ?? {}) };
  if (patch.approval !== undefined) {
    if (patch.approval === 'default') delete current.approval;
    else current.approval = patch.approval;
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled) delete current.enabled;
    else current.enabled = false;
  }
  if (current.approval === undefined && current.enabled === undefined) delete next[toolName];
  else next[toolName] = current;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 有效审批（与 core 的 effectiveMcpApproval 同序：tool policy > server autoApprove > 风险默认）。 */
export function effectiveApproval(
  server: Pick<McpServer, 'autoApprove' | 'toolPolicies'>,
  toolName: string,
  risk: McpToolRisk,
): 'auto' | 'ask' {
  const policy = server.toolPolicies?.[toolName]?.approval;
  if (policy !== undefined) return policy;
  if (server.autoApprove) return 'auto';
  return risk === 'read' ? 'auto' : 'ask';
}

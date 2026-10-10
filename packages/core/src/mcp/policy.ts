import type { McpServer, McpToolApprovalMode } from '@kepcup/shared';
import type { ToolRisk, ToolRiskDetail, ToolRiskSource } from './risk.js';

/**
 * MCP 逐工具策略（W5）：有人值守时的审批决定顺序
 * tool policy > server autoApprove > 风险档默认（read→auto，write / destructive→ask）。
 * 无人值守不在这里：需要审批的调用照常进 approvals.request，由
 * `#autoDecideSync` 的 mcp_tool 显式分支自动批准（所有风险档）。
 */

export type McpApprovalSource = 'policy' | 'server' | 'default';

export interface McpToolDecision {
  risk: ToolRisk;
  riskSource: ToolRiskSource;
  approval: McpToolApprovalMode;
  approvalSource: McpApprovalSource;
  /** false = 用户在设置页停用了该工具（不注册、调用时拒绝）。 */
  enabled: boolean;
}

type PolicyServer = Pick<McpServer, 'autoApprove' | 'toolPolicies'> &
  Partial<Pick<McpServer, 'tier'>>;

/**
 * 信任分级 `developer`（设计 29 §11.3；MCPB 包安装等本机手动添加的未审核来源）：
 * 所有工具默认每次确认——只读也不再自动放行；用户可逐工具（或 server 级免审批）放宽，
 * `destructive` 例外，恒为每次确认。
 */
export function isDeveloperTier(server: Partial<Pick<McpServer, 'tier'>>): boolean {
  return server.tier === 'developer';
}

/** 工具是否暴露给模型（toolPolicies[name].enabled 默认 true）。 */
export function mcpToolEnabled(server: PolicyServer, toolName: string): boolean {
  return server.toolPolicies?.[toolName]?.enabled !== false;
}

export function effectiveMcpApproval(
  server: PolicyServer,
  toolName: string,
  risk: ToolRisk,
): { approval: McpToolApprovalMode; source: McpApprovalSource } {
  const policy = server.toolPolicies?.[toolName]?.approval;
  if (isDeveloperTier(server)) {
    // Relaxing is allowed per tool / per server, except for destructive tools.
    if (risk === 'destructive') {
      return { approval: 'ask', source: policy === 'ask' ? 'policy' : 'default' };
    }
    if (policy !== undefined) return { approval: policy, source: 'policy' };
    if (server.autoApprove) return { approval: 'auto', source: 'server' };
    return { approval: 'ask', source: 'default' };
  }
  if (policy !== undefined) return { approval: policy, source: 'policy' };
  if (server.autoApprove) return { approval: 'auto', source: 'server' };
  return { approval: risk === 'read' ? 'auto' : 'ask', source: 'default' };
}

export function decideMcpTool(
  server: PolicyServer,
  toolName: string,
  detail: ToolRiskDetail,
): McpToolDecision {
  const { approval, source } = effectiveMcpApproval(server, toolName, detail.risk);
  return {
    risk: detail.risk,
    riskSource: detail.source,
    approval,
    approvalSource: source,
    enabled: mcpToolEnabled(server, toolName),
  };
}

/** 只读工具面（对话轮 / 只读子代理）的准入：只读且有效审批为 auto。 */
export function allowedOnReadOnlySurface(
  decision: Pick<McpToolDecision, 'risk' | 'approval' | 'enabled'>,
): boolean {
  return decision.enabled && decision.risk === 'read' && decision.approval === 'auto';
}

import type { ApprovalDuration, McpToolApprovalPayload } from '@kepcup/shared';
import type { MessageKey } from '$lib/i18n';

/**
 * `mcp_tool` 审批卡的纯逻辑（D73 P1，design 29 §8.1）：连接应用的工具调用卡显示
 * 「以 {账号} 身份在 {应用} 执行 {工具}」，时长选项按 `payload.durations` 渲染（写入档
 * 三档、破坏性档只有「仅这一次」），破坏性档展示完整参数与不可撤销提示。
 * core 侧对应：`gateway/index.ts` 的 `mcpToolCall`（载荷）与 `permissions/approvals.ts`
 * 的 `decide()`（时长降级）。
 */

export const APPROVAL_DURATION_LABEL_KEYS: Record<ApprovalDuration, MessageKey> = {
  once: 'approvals.once',
  conversation: 'approvals.conversation',
  bot: 'approvals.durationBot',
};

/** 卡片可选的时长（缺省 = 只有「仅这一次」，与 core 的 `decide()` 同一默认）。 */
export function mcpDurationOptions(
  payload: Pick<McpToolApprovalPayload, 'durations'>,
): ApprovalDuration[] {
  const options = payload.durations ?? [];
  const unique = options.filter((duration, index) => options.indexOf(duration) === index);
  // `once` 恒可选且排第一，其余保持 core 给出的顺序。
  return ['once', ...unique.filter((duration) => duration !== 'once')];
}

/** 是否显示时长选择（只有一个选项时不显示，批准即「仅这一次」）。 */
export function mcpChoosesDuration(payload: Pick<McpToolApprovalPayload, 'durations'>): boolean {
  return mcpDurationOptions(payload).length > 1;
}

/** 键盘 1 / 2 / 3 选第 N 个时长；超出范围 = 不变。 */
export function durationForKey(
  options: readonly ApprovalDuration[],
  key: string,
): ApprovalDuration | null {
  const index = Number(key) - 1;
  return Number.isInteger(index) && index >= 0 && index < options.length ? options[index]! : null;
}

/** 选中的时长不在选项里（载荷变化）时回到「仅这一次」。 */
export function clampDuration(
  chosen: ApprovalDuration,
  options: readonly ApprovalDuration[],
): ApprovalDuration {
  return options.includes(chosen) ? chosen : 'once';
}

export interface AppToolIdentity {
  /** 账号标签（缺省时只显示应用）。 */
  account: string | null;
  app: string;
  tool: string;
}

/** 连接应用工具的身份行数据；普通 MCP 工具（无 connectionId）= null。 */
export function appToolIdentity(payload: McpToolApprovalPayload): AppToolIdentity | null {
  if (payload.connectionId === undefined) return null;
  const account = payload.accountLabel?.trim();
  return {
    account: account !== undefined && account.length > 0 ? account : null,
    app: payload.serverName,
    tool: payload.toolName,
  };
}

/** 破坏性的应用工具：展示完整参数（缺完整参数的旧行回退到摘要）与不可撤销提示。 */
export function appToolArgsView(payload: McpToolApprovalPayload): {
  text: string;
  full: boolean;
  irreversible: boolean;
} {
  const irreversible = payload.connectionId !== undefined && payload.risk === 'destructive';
  if (irreversible && payload.argsFull !== undefined && payload.argsFull.length > 0) {
    return { text: payload.argsFull, full: true, irreversible };
  }
  return { text: payload.argsSummary, full: false, irreversible };
}

/** 折叠记录里「已允许」的时长文案 key。 */
export function foldedApprovedKey(
  duration: ApprovalDuration | undefined,
):
  | 'approvals.foldedApprovedOnce'
  | 'approvals.foldedApprovedConversation'
  | 'approvals.foldedApprovedBot' {
  return duration === 'bot'
    ? 'approvals.foldedApprovedBot'
    : duration === 'conversation'
      ? 'approvals.foldedApprovedConversation'
      : 'approvals.foldedApprovedOnce';
}

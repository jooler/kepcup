import { AppError, type ApprovalDuration, type McpToolRisk } from '@kepcup/shared';

/**
 * 分级信任落地（D73 P3 §7.2，docs/design/29-connected-apps.md §11.3；纯函数）：
 *
 * | 分级 | 写入类工具的持续授权 | 首次连接 |
 * |---|---|---|
 * | `builtin` / `verified` | 默认规则：仅此一次 / 本对话内 / 对该 Bot 总是允许 | 默认 |
 * | `community` | **不可**「对该 Bot 总是允许」（`bot`），只有仅此一次 / 本对话内 | 额外提示并要求确认 |
 * | `developer` | 全部每次确认（P2 已落地，见 `mcp/policy.ts` 的 `isDeveloperTier`；这里不重复） | — |
 *
 * 破坏性工具恒「仅这一次」（所有分级）；用户逐工具设为「每次确认」的工具不出持续授权选项
 * （都在网关里，与分级无关）。未知分级按最严的 `community` 处理（fail-closed）。
 */

const FULL_TRUST_TIERS: ReadonlySet<string> = new Set(['builtin', 'verified']);

/** 该分级的应用是否可以被授予「对该 Bot 总是允许」（Bot 级）的持续授权。 */
export function tierAllowsBotLevelGrant(tier: string | undefined): boolean {
  // 未知 / 缺失的分级 fail-closed：只有 builtin / verified 可以。目录连接的上下文
  // （`AppToolContext.tier`）总会带分级，没有真实路径传 undefined。
  return tier !== undefined && FULL_TRUST_TIERS.has(tier);
}

/**
 * 首次连接时是否需要额外的社区风险提示与确认（界面勾选；core 在 `apps.connect.confirmTools`
 * 里强制：需要 `acknowledgeCommunity: true`）。确认挂在工具复核步骤上——社区应用没有任何待复核
 * 工具时没有这一步，也就不需要确认（此时没有可被授权的工具）。
 */
export function tierRequiresConnectAck(tier: string | undefined): boolean {
  return tier === 'community';
}

/**
 * 应用工具审批卡提供的授权时长（网关 `mcp_tool` 卡的 `payload.durations`）：
 * `grantable` = 写入档 + 未被逐工具「每次确认」覆盖 + 有 Bot 上下文（由网关判定）；
 * 否则只有「仅这一次」。`community` 的写入工具去掉 `bot`。
 */
export function appToolDurations(input: {
  tier: string | undefined;
  risk: McpToolRisk;
  grantable: boolean;
}): ApprovalDuration[] {
  if (!input.grantable || input.risk !== 'write') return ['once'];
  return tierAllowsBotLevelGrant(input.tier)
    ? ['once', 'conversation', 'bot']
    : ['once', 'conversation'];
}

/**
 * 创建持续授权前的兜底校验：Bot 级（`conversationId` 为 null）授权不得落在受限分级的连接上。
 * 正常路径下卡片根本不提供该选项，这里防的是伪造 / 绕过卡片的调用方。
 */
export function assertGrantAllowedForTier(input: {
  tier: string | undefined;
  conversationId: string | null | undefined;
}): void {
  if ((input.conversationId ?? null) === null && !tierAllowsBotLevelGrant(input.tier)) {
    throw new AppError(
      'APPROVAL_DENIED',
      '社区应用的写入类工具不能设为「对该 Bot 总是允许」，请改用「本对话内允许」',
    );
  }
}

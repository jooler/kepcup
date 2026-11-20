import type { ToolDefinition } from '../agent/types.js';

/**
 * Host-injected principal seams (62.11 C2 / C8 / C10, D138). A "principal" is
 * core's opaque term for a human participant: core never learns what the id
 * stands for — naming, access and policy semantics stay in the host (see
 * docs/design/62-team-server/11-core-seams.md). Every option is optional in
 * `CoreServicesOptions`; when absent the single-user runtime behaviour is
 * unchanged.
 */

/** Display entry for a principal, resolved by the host's directory. */
export interface PrincipalDescription {
  name: string;
  note?: string;
}

/**
 * C2 principal directory: the host resolves opaque principal ids into display
 * entries for sender labels, mention tokens and prompt sections.
 */
export interface PrincipalDirectory {
  describe(principalId: string): PrincipalDescription | null;
  /**
   * 62.07 §3 通道入站通知对象（T6，62.11 通用缝）：通道账号是宿主资产，宿主
   * 用它指明「这个邮箱 / IM 账号的入站提醒该开谁与 Bot 的直聊」。返回 null /
   * 未实现 = 无指定对象（提醒落无主直聊 = 单用户现状）。
   */
  ownerForChannel?(kind: 'mail' | 'im', accountId: string): string | null;
}

/** Context a tool decision is made in; `null` ids = no principal in scope. */
export type ToolPolicyContext = {
  botId: string;
  conversationId: string | null;
  principalId: string | null;
};

/**
 * C8 host tool policy: evaluated per tool at capability-mount time; `deny`
 * removes the tool from the mount, the prompt and lazy resolution.
 */
export type ToolPolicy = (ctx: ToolPolicyContext, toolName: string) => 'allow' | 'deny';

export type HostToolsContext = ToolPolicyContext & { loopType: string };

/** C10 host-contributed tools appended per (bot, conversation, loop type). */
export type HostToolsProvider = (ctx: HostToolsContext) => ToolDefinition[];

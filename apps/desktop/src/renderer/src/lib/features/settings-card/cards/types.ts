import type { AgentView, CardKey, SettingItem, SettingValues } from '@kepcup/shared';
import { prefillString } from '../setting-card-model.js';

/**
 * 渲染层卡片贡献（todo/settings-catalog-registry.md §4.3）。第一阶段只登记元数据：
 * 组件的 import 与分发仍在 `SettingCardEmbed.svelte`（阶段 A），`componentName` 供
 * `card-components.test.ts` 核对宿主确实引入并分支。
 */

/** 内嵌时需要的上下文（谁的卡、作用对象、可用的外部智能体）。 */
export interface EmbedContext {
  /** bot 范围条目的作用 Bot（卡片 target.botId，缺省为出卡 Bot）。 */
  botId: string | null;
  /** 群范围条目的群会话。 */
  conversationId: string | null;
  /** 工作目录范围条目的工作目录。 */
  workdirId: string | null;
  prefill: SettingValues | null;
  /** 外部智能体目录（未加载为 null）。 */
  agent(id: string): AgentView | null;
  /** 当前默认智能体 id（`settings.defaultAgentId`）。 */
  defaultAgentId: string | null;
}

export interface SettingCardContribution {
  key: CardKey;
  /** 组件名，供 card-components.test.ts 核对 SettingCardEmbed 的 import/分支。 */
  componentName: string;
  /** 当前上下文能否内嵌；不能则退回跳转卡。 */
  embeddable(item: SettingItem, ctx: EmbedContext): boolean;
}

/** agent 卡内嵌哪个智能体：预填 `agent` 优先，其次默认智能体；目录里没有返回 null。 */
export function embeddedAgentId(context: EmbedContext): string | null {
  const id = prefillString(context.prefill, 'agent') ?? context.defaultAgentId;
  if (id === null || id.length === 0) return null;
  return context.agent(id) !== null ? id : null;
}

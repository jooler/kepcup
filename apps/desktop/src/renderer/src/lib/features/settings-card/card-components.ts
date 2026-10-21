import type { CardKey, SettingItem } from '@kepcup/shared';
import { SETTING_CARD_CONTRIBUTIONS, type EmbedContext } from './cards/index.js';

/**
 * 渲染层 `CardKey → Svelte 组件` 映射的派生层（todo/settings-catalog-registry.md §4.3）。
 * 登记本身在 `cards/index.ts` 的贡献表里：键、组件名、可嵌入判定都在那里维护；
 * 这里只提供旧出口（`SETTING_CARD_COMPONENTS` / `cardEmbeddable` / `EmbedContext`），
 * 宿主与测试的 import 不变。组件本身在 `SettingCardEmbed.svelte` 里按键分发。
 */
export const SETTING_CARD_COMPONENTS = Object.fromEntries(
  SETTING_CARD_CONTRIBUTIONS.map((card) => [card.key, card.componentName]),
) as Record<CardKey, string>;

export type { EmbedContext };

const BY_KEY = new Map(SETTING_CARD_CONTRIBUTIONS.map((card) => [card.key, card]));

/**
 * 该条目在当前上下文里能不能内嵌（不能就退回跳转卡）。判定逻辑按卡片键登记在
 * `cards/index.ts` 的贡献表里（作用对象是否就位、预填是否点名、条目 id 是否对得上能力 /
 * 传感器）。
 */
export function cardEmbeddable(item: SettingItem, context: EmbedContext): boolean {
  if (item.card === null) return false;
  return BY_KEY.get(item.card)?.embeddable(item, context) ?? false;
}

export { embeddedAgentId } from './cards/index.js';

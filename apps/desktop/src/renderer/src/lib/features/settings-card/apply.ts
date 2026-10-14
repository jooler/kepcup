import type {
  SettingTarget,
  SettingValues,
  SettingsCardsUndoOutput,
  SettingsItemsApplyOutput,
  SettingCardState,
} from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';

/**
 * 设置卡的 RPC（todo/conversational-app-setup.md §4.1 / §6）：渲染层只经这几个入口写设置卡。
 * - `settings.items.apply`：条目级 CAS 写入（`expected` = 出卡时的当前值；设置页 / 失败续跑卡
 *   不比对传 null）；带 `messageId` 时 core 把卡片标 applied 并唤醒 Bot（§6.2）；
 * - `settings.cards.dismiss`：「不用了」，标 dismissed 并唤醒 Bot 一次；
 * - `settings.cards.complete`：「我已设置好」/ 内嵌组件自己保存之后，core 能核对的核对一次；
 * - `settings.cards.undo`：回执卡撤销（同一套 CAS，不唤醒 Bot）。
 */

export function applySettingItem(input: {
  itemId: string;
  values: SettingValues;
  expected: SettingValues | null;
  target?: SettingTarget | undefined;
  messageId?: string | undefined;
}): Promise<SettingsItemsApplyOutput> {
  return core.call('settings.items.apply', {
    itemId: input.itemId,
    values: input.values,
    expected: input.expected,
    ...(input.target !== undefined && Object.keys(input.target).length > 0
      ? { target: input.target }
      : {}),
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
  }) as Promise<SettingsItemsApplyOutput>;
}

export function dismissSettingCard(messageId: string): Promise<{ state: SettingCardState }> {
  return core.call('settings.cards.dismiss', { messageId }) as Promise<{ state: SettingCardState }>;
}

export function completeSettingCard(
  messageId: string,
): Promise<{ state: SettingCardState; verified: boolean | null }> {
  return core.call('settings.cards.complete', { messageId }) as Promise<{
    state: SettingCardState;
    verified: boolean | null;
  }>;
}

/** 本次会话里已经自动核对过的卡（每张卡只核对一次，打开 / 滚动对话不会反复请求）。 */
const autoVerified = new Set<string>();

/**
 * 打开对话时对待处理的 link / user-only / form 卡自动核对一次（D89 审查修复）：用户可能早就在
 * 设置页做完了，而卡片当时没挂在界面上、收不到 `settings.changed`。core 只在条目相对出卡时确实
 * 变过才结卡（并唤醒 Bot 一次），否则原样 pending；同一张卡 core 侧另有限频。失败静默。
 */
export async function autoVerifySettingCardOnce(messageId: string): Promise<void> {
  if (autoVerified.has(messageId)) return;
  autoVerified.add(messageId);
  try {
    await core.call('settings.cards.complete', { messageId, auto: true });
  } catch {
    // 核对失败不影响卡片：用户仍可手动「我已设置好」。
  }
}

export function undoSettingCard(messageId: string): Promise<SettingsCardsUndoOutput> {
  return core.call('settings.cards.undo', { messageId }) as Promise<SettingsCardsUndoOutput>;
}

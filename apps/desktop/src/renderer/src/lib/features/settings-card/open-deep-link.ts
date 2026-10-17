import type { SettingItem, SettingTarget } from '@kepcup/shared';
import { shell } from '$lib/stores/shell.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { sidebarDialogs } from '$lib/features/sidebar/sidebar-dialogs.svelte';
import { settingDeepLinkAction } from './deep-link';

/**
 * 设置卡「在设置中打开」（todo/conversational-app-setup.md §6.1）：按目录条目的深链跳到设置
 * 弹框 / 扩展中心 / 右栏 Bot 详情 / 项目设置 / 工作目录设置的对应锚点。窄屏的重路由由各入口自己
 * 处理（`shell.openSettings` → NarrowSettings；扩展中心 → 扩展 tab；右栏 → 覆盖层）。
 */
export async function openSettingDeepLink(item: SettingItem, target: SettingTarget): Promise<void> {
  const conversationId = chat.current?.conversation.id ?? null;
  const action = settingDeepLinkAction(item.deepLink, target, conversationId);
  switch (action.kind) {
    case 'settings':
      shell.openSettings(action.section, action.anchor ?? undefined);
      return;
    case 'extension-center':
      shell.openExtensionCenter(action.tab);
      return;
    case 'bot-panel': {
      // 右栏只展示当前单聊的 Bot：改的是别的 Bot（管家出的卡）时先切到它的单聊。
      const currentBotId = chat.current?.conversation.bot?.id ?? null;
      if (action.botId !== null && action.botId !== currentBotId) {
        await chat.openDirect(action.botId);
      }
      shell.openBotPanel(action.tab, action.anchor ?? undefined);
      return;
    }
    case 'project-detail':
      // WP7 replaces this with the project detail page.
      if (action.conversationId !== null) {
        sidebarDialogs.openGroupSettings(action.conversationId, action.anchor ?? undefined);
      }
      return;
    case 'workdir-dialog':
      shell.openWorkdirSettings(action.anchor ?? undefined);
      return;
  }
}

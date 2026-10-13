import type { SettingDeepLink, SettingTarget } from '@kepcup/shared';
import type { SettingsSectionId } from '../settings/sections';
import { EXTENSION_CENTER_TABS, type ExtensionCenterTab } from '../extension-center/tabs';

/**
 * 设置目录深链（`SettingItem.deepLink`）→ 渲染层的跳转动作（纯函数，便于单测）。
 * 实际跳转在 `open-deep-link.ts`：设置弹框（窄屏由 `shell.openSettings` 重路由到全屏页）、
 * 扩展中心（窄屏由 NarrowShell 重路由到扩展 tab）、右栏 Bot 详情（窄屏 / 放不下时为覆盖层）、
 * 群设置与项目设置对话框。
 */

const SETTINGS_SECTIONS: ReadonlySet<string> = new Set<SettingsSectionId>([
  'general',
  'hardware',
  'models',
  'search',
  'apps',
  'mcp',
  'browser',
  'agents',
  'profile',
  'contacts',
  'unattended',
  'environment',
  'usage',
  'diagnostics',
  'developer',
]);

export type SettingDeepLinkAction =
  | { kind: 'settings'; section: SettingsSectionId; anchor: string | null }
  | { kind: 'extension-center'; tab: ExtensionCenterTab }
  /** 右栏 Bot 详情的页签；`botId` 与当前会话的 Bot 不同时先打开该 Bot 的单聊。 */
  | { kind: 'bot-panel'; tab: string; anchor: string | null; botId: string | null }
  | { kind: 'group-dialog'; conversationId: string | null; anchor: string | null }
  | { kind: 'project-dialog'; anchor: string | null };

/**
 * 深链 → 动作。分区 / 页签不认识时退回分区首页（设置弹框「通用」/ 扩展中心「Skills」），
 * 不抛错：卡片上的按钮总能打开点东西。`conversationId` 是卡片所在会话（群设置缺省用它）。
 */
export function settingDeepLinkAction(
  link: SettingDeepLink,
  target: SettingTarget,
  conversationId: string | null,
): SettingDeepLinkAction {
  const anchor = link.anchor ?? null;
  switch (link.surface) {
    case 'settings':
      return {
        kind: 'settings',
        section: SETTINGS_SECTIONS.has(link.section)
          ? (link.section as SettingsSectionId)
          : 'general',
        anchor,
      };
    case 'extension-center':
      return {
        kind: 'extension-center',
        tab: (EXTENSION_CENTER_TABS as readonly string[]).includes(link.section)
          ? (link.section as ExtensionCenterTab)
          : 'skills',
      };
    case 'bot-panel':
      return { kind: 'bot-panel', tab: link.section, anchor, botId: target.botId ?? null };
    case 'group-dialog':
      return {
        kind: 'group-dialog',
        conversationId: target.conversationId ?? conversationId,
        anchor,
      };
    case 'project-dialog':
      return { kind: 'project-dialog', anchor };
  }
}

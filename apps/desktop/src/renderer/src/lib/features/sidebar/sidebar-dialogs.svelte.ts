/**
 * 侧栏触发的模态对话框状态（新建 Bot 表单 / 重命名 Bot / 删除会话 / 群设置）。
 *
 * 状态放 store、对话框渲染在 App 根（SidebarDialogs.svelte），而不是 AppSidebar 的局部
 * 状态：宽 / 窄是两棵不同的组件树，窗口跨断点时 AppSidebar 会整个卸载重挂，局部状态里
 * 用户正在填的「高级新建」表单草稿、重命名输入会跟着丢。store 层让这些对话框在宽窄
 * 切换中保持打开与内容。
 */
import type { Bot, BotProfile } from '@kepcup/shared';
import { emptyProfile } from '$lib/features/bot-setup';

class SidebarDialogsState {
  /** 「高级新建」表单对话框与它的草稿。 */
  formCreateOpen = $state(false);
  draftProfile = $state<BotProfile>(emptyProfile());

  /** 重命名 Bot。 */
  renameOpen = $state(false);
  renameBot = $state<Bot | null>(null);
  renameName = $state('');

  /** 待确认删除的会话 id（null = 对话框关闭）。 */
  deleteTargetId = $state<string | null>(null);

  /** 群设置。 */
  groupSettingsOpen = $state(false);
  groupSettingsId = $state<string | null>(null);
  /** 群设置打开后要聚焦的锚点（对话内设置卡深链）；对话框消费后复位。 */
  groupSettingsAnchor = $state<string | null>(null);

  openFormCreate(): void {
    this.draftProfile = emptyProfile();
    this.formCreateOpen = true;
  }

  openRename(bot: Bot): void {
    this.renameBot = bot;
    this.renameName = bot.name;
    this.renameOpen = true;
  }

  openGroupSettings(conversationId: string, anchor?: string): void {
    this.groupSettingsId = conversationId;
    this.groupSettingsAnchor = anchor ?? null;
    this.groupSettingsOpen = true;
  }

  askDelete(conversationId: string): void {
    this.deleteTargetId = conversationId;
  }
}

export const sidebarDialogs = new SidebarDialogsState();

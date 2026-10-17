/**
 * 侧栏触发的模态对话框状态（重命名 Bot / 删除会话）。
 *
 * 状态放 store、对话框渲染在 App 根（SidebarDialogs.svelte），而不是 AppSidebar 的局部
 * 状态：宽 / 窄是两棵不同的组件树，窗口跨断点时 AppSidebar 会整个卸载重挂，局部状态里
 * 用户正在填的重命名输入会跟着丢。store 层让这些对话框在宽窄切换中保持打开与内容。
 * （原「群设置」对话框状态已在 WP6 删除：右键「项目详情」直达内容区详情页。）
 */
import type { Bot } from '@kepcup/shared';

class SidebarDialogsState {
  /** 重命名 Bot。 */
  renameOpen = $state(false);
  renameBot = $state<Bot | null>(null);
  renameName = $state('');

  /** 待确认删除的会话 id（null = 对话框关闭）。 */
  deleteTargetId = $state<string | null>(null);

  openRename(bot: Bot): void {
    this.renameBot = bot;
    this.renameName = bot.name;
    this.renameOpen = true;
  }

  askDelete(conversationId: string): void {
    this.deleteTargetId = conversationId;
  }
}

export const sidebarDialogs = new SidebarDialogsState();

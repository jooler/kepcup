import { t } from '$lib/i18n';
import { toast } from 'svelte-sonner';

/**
 * P11 任务 5（查看窗口）: asks the main process to move this bot's page for
 * the current conversation into a visible window. The ipc channel is a pure
 * capability request — the main process does not decide permissions.
 */
export async function showBrowser(botId: string, conversationId: string, botName: string): Promise<void> {
  try {
    // W8: the viewer toolbar copy is localized here, like the window title.
    await window.kepcup.showBotBrowser(
      botId,
      conversationId,
      t('rightPanel.browserWindowTitle', { name: botName }),
      {
        agent: t('rightPanel.browserToolbarAgent', { name: botName }),
        user: t('rightPanel.browserToolbarUser', { name: botName }),
        handback: t('rightPanel.browserToolbarHandback'),
      },
    );
  } catch {
    toast.error(t('rightPanel.browserShowFailed'));
  }
}

/** Shared outline-green style for「查看浏览器」(right panel + group member UI). */
export const BROWSER_SHOW_BTN_CLASS =
  'h-7 gap-1 border-emerald-600/60 px-2 text-xs text-emerald-600 hover:bg-emerald-600/10 hover:text-emerald-700 dark:border-emerald-400/50 dark:text-emerald-400 dark:hover:bg-emerald-400/10 dark:hover:text-emerald-300';

/**
 * 强制释放该 (Bot, 对话) 的浏览器页面：接管中的页面也直接关（force），
 * 会话数据保留（非 permanent）。页面集合经 `browser:pages` 推送自动刷新。
 */
export async function closeBrowser(botId: string, conversationId: string): Promise<void> {
  const bridge = typeof window === 'undefined' ? undefined : window.kepcup;
  // 旧预加载脚本（应用没重启，渲染层热更新先到了）没有这个方法：明确提示，
  // 不然 TypeError 被吞掉只剩误导性的「可能已关闭」。
  if (typeof bridge?.closeBotBrowser !== 'function') {
    toast.error(t('rightPanel.browserCloseUnavailable'));
    return;
  }
  try {
    await bridge.closeBotBrowser(botId, conversationId);
  } catch (error) {
    // 真实错误带在描述里（错误码 / 原因），标题只作陈述。
    toast.error(t('rightPanel.browserCloseFailed'), {
      description: error instanceof Error ? error.message : String(error),
    });
  }
}

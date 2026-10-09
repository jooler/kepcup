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

import { toast } from 'svelte-sonner';
import type { AppNoticePayload } from '@kepcup/shared';
import { core } from '$lib/rpc/client.svelte';
import { t } from '$lib/i18n';
import { shell } from '$lib/stores/shell.svelte';

/**
 * 应用状态提示（core 的 `app.notice`）：邮件连接中断、监看被暂停之类「当前状态
 * 有变化，请留意」的信息，弹一条轻量 toast。它们不落库、不进对话上下文——提示
 * 消失后用户下次用到相关功能时仍会发现问题，所以不必固化成对话里的消息。
 * 同 key 的提示互相替换，`dismiss` 撤掉（如故障恢复）。
 */
const DURATION: Record<AppNoticePayload['level'], number> = {
  info: 4_000,
  warning: 12_000,
  error: 20_000,
};

class AppNotices {
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('app.notice', (payload) => this.show(payload as AppNoticePayload));
  }

  show(notice: AppNoticePayload): void {
    if (notice.dismiss === true) {
      toast.dismiss(notice.key);
      return;
    }
    const options = {
      id: notice.key,
      duration: DURATION[notice.level],
      ...(notice.action !== undefined
        ? { action: { label: t(`notice.action.${notice.action}`), onClick: () => this.#run(notice.action!) } }
        : {}),
    };
    if (notice.level === 'error') toast.error(notice.text, options);
    else if (notice.level === 'warning') toast.warning(notice.text, options);
    else toast.info(notice.text, options);
  }

  #run(action: NonNullable<AppNoticePayload['action']>): void {
    if (action === 'open_mail_settings') shell.openExtensionCenter('mail');
    else shell.openSchedules();
  }
}

export const appNotices = new AppNotices();

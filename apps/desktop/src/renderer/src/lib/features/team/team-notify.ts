import type { Message } from '@kepcup/shared';
import { messagePreviewText } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import type { SourceId } from '$lib/rpc/connections.svelte';
import { teamSettings } from './team-settings.svelte';

/**
 * 团队来源的通知发送点（T7 步骤 5「成员域免打扰」）：渲染层对团队消息唯一的
 * 主动提醒是被 @（`mentions` 含 `principal:<自己>`，62.04 §4「人类 @ = 通知」）
 * 时的轻量 toast——本机消息的系统通知走主进程 `coreHost.onNotify`（只接本机
 * core），团队来源没有那条链路，这里是它的对应物。
 *
 * 免打扰抑制在这里判定（按来源 + 时段）：quietHours 生效期间不提醒（声音 /
 * 系统通知一并不发）；**消息本体照常落库**（未读 / 提及角标不受影响，由
 * chat-team 切片在调用本函数之前维护）。
 */
export function notifyTeamMessage(
  source: SourceId,
  conversation: { id: string; title?: string | null } | null,
  message: Message,
): void {
  if (teamSettings.quietHoursActive(source)) return;
  const preview = messagePreviewText(message);
  if (preview === null || preview.length === 0) return;
  const title = conversation?.title?.trim();
  toast.info(t('team.mentionToastTitle', { name: title ?? '' }), {
    description: preview.slice(0, 120),
  });
}

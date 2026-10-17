import type { Episode } from '@kepcup/shared';
import { errorText, t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { toast } from 'svelte-sonner';

/**
 * 协作回合（episode，D92 T1a WP8）：协作暂停卡的数据源。熔断暂停的回合经
 * `episode.updated` 事件实时进入 `byId`；卡片挂载时按消息里的 `episodeId`
 * 拉取（`episodes.get`），「继续 / 停止」走 `episodes.resume` / `episodes.stop`。
 * 沟通 tab 的徽标把暂停中的回合计入待处理（`pausedCount`）。
 */
class EpisodesState {
  byId = $state<Record<string, Episode>>({});
  #started = false;

  start(): void {
    if (this.#started) return;
    this.#started = true;
    core.onEvent('episode.updated', (payload) => {
      const episode = (payload as { episode: Episode }).episode;
      this.byId = { ...this.byId, [episode.id]: episode };
    });
  }

  /** 拉取一个回合（卡片挂载时）；不存在（回合已清理）或失败都静默忽略。 */
  async load(id: string): Promise<void> {
    try {
      const { episode } = (await core.call('episodes.get', { id })) as { episode: Episode };
      this.byId = { ...this.byId, [episode.id]: episode };
    } catch {
      // Unknown episode: the card falls back to its message text, no buttons.
    }
  }

  async resume(id: string): Promise<void> {
    await this.#decide('episodes.resume', id);
  }

  async stop(id: string): Promise<void> {
    await this.#decide('episodes.stop', id);
  }

  async #decide(method: 'episodes.resume' | 'episodes.stop', id: string): Promise<void> {
    try {
      const { episode } = (await core.call(method, { id })) as { episode: Episode };
      this.byId = { ...this.byId, [episode.id]: episode };
    } catch (error) {
      // State stays untouched; the next episode.updated event reconciles.
      toast.error(
        errorText((error as { code?: string }).code, t('chats.errorCode.INTERNAL')),
      );
    }
  }

  /** 该会话暂停中（待用户处理）的回合数：沟通 tab 徽标与审批一起计入。 */
  pausedCount(conversationId: string | null | undefined): number {
    if (conversationId === null || conversationId === undefined) return 0;
    return Object.values(this.byId).filter(
      (episode) => episode.conversationId === conversationId && episode.status === 'paused',
    ).length;
  }
}

export const episodes = new EpisodesState();

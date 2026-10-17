<script lang="ts">
  import type { Message } from '@kepcup/shared';
  import { PauseCircle } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { episodes } from '$lib/stores/episodes.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 协作暂停卡（D92 T1a WP8，event = episode_paused）：熔断暂停的回合在消息
   * 流里落下这张卡。挂载时按 `content.episodeId` 拉回合行：paused 显示
   * 「继续 / 停止」；active / stopped 是操作后的终态；unknown（回合已不存在
   * 或尚未加载完成）只显示文案。
   */
  let { message }: { message: Message } = $props();

  const episodeId = $derived(
    message.kind === 'system_event' && 'episodeId' in message.content
      ? String(message.content.episodeId ?? '')
      : '',
  );
  const episode = $derived(episodeId.length > 0 ? (episodes.byId[episodeId] ?? null) : null);

  $effect(() => {
    if (episodeId.length > 0) void episodes.load(episodeId);
  });

  let busy = $state(false);

  async function decide(method: 'resume' | 'stop'): Promise<void> {
    if (busy || episodeId.length === 0) return;
    busy = true;
    try {
      if (method === 'resume') await episodes.resume(episodeId);
      else await episodes.stop(episodeId);
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="w-full max-w-[85%] rounded-lg border bg-background/80 p-3 text-sm"
  data-testid="episode-paused-card"
  data-status={episode?.status ?? 'unknown'}
>
  <div class="flex items-start gap-2">
    <PauseCircle class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
    <div class="min-w-0 grid gap-1">
      <p class="whitespace-pre-wrap">{'text' in message.content ? message.content.text : ''}</p>
      {#if episode?.status === 'paused' && episode.pendingCount > 0}
        <p class="text-xs text-muted-foreground">
          {t('episode.pendingHint', { count: episode.pendingCount })}
        </p>
      {/if}
      {#if episode?.status === 'active'}
        <p class="text-xs text-muted-foreground">{t('episode.resumed')}</p>
      {:else if episode?.status === 'stopped'}
        <p class="text-xs text-muted-foreground">{t('episode.stopped')}</p>
      {/if}
    </div>
  </div>
  {#if episode?.status === 'paused'}
    <div class="mt-2 flex flex-wrap justify-end gap-2">
      <Button size="sm" class="h-7" disabled={busy} onclick={() => void decide('resume')} data-testid="episode-resume">
        {t('episode.resume')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        class="h-7"
        disabled={busy}
        onclick={() => void decide('stop')}
        data-testid="episode-stop"
      >
        {t('episode.stop')}
      </Button>
    </div>
  {/if}
</div>

<script lang="ts">
  import { t, listSeparator } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';

  let { conversationId }: { conversationId: string } = $props();

  const turn = $derived(chat.turnByConversation[conversationId] ?? null);
  // 路由阶段（正在确认由谁回复）本身就要显示：静默路由可能持续数秒，用户
  // 需要知道消息已被接住；运行阶段至少有一个目标（当前或排队）才显示。
  const visible = $derived(
    turn !== null &&
      (turn.phase === 'routing' ||
        (turn.phase !== 'idle' && (turn.currentBotId !== null || turn.queue.length > 0))),
  );
  const currentName = $derived(
    turn?.currentBotId !== null && turn?.currentBotId !== undefined
      ? chat.botName(turn.currentBotId)
      : '',
  );
  const queueNames = $derived(
    (turn?.queue ?? [])
      .filter((id) => id !== turn?.currentBotId)
      .map((id) => chat.botName(id))
      .join(listSeparator()),
  );
</script>

{#if visible}
  <div
    class="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    data-testid="project-turn-status"
    data-phase={turn?.phase}
  >
    {#if turn?.phase === 'routing'}
      <span class="animate-pulse">{t('turn.routing')}</span>
    {:else if queueNames.length > 0}
      <span data-testid="project-turn-queue">
        {t('turn.running', { current: currentName, queue: queueNames })}
      </span>
    {:else}
      <span data-testid="project-turn-single">{t('turn.single', { current: currentName })}</span>
    {/if}
  </div>
{/if}

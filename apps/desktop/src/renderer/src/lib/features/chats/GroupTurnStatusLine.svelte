<script lang="ts">
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';

  let { conversationId }: { conversationId: string } = $props();

  const turn = $derived(chat.turnByConversation[conversationId] ?? null);
  const visible = $derived(
    turn !== null && turn.phase !== 'idle' && (turn.currentBotId !== null || turn.queue.length > 0),
  );
  const currentName = $derived(turn?.currentBotId !== null && turn?.currentBotId !== undefined ? chat.botName(turn.currentBotId) : '');
  const queueNames = $derived(
    (turn?.queue ?? [])
      .filter((id) => id !== turn?.currentBotId)
      .map((id) => chat.botName(id))
      .join('、'),
  );
</script>

{#if visible}
  <div
    class="flex items-center gap-2 py-1 text-xs text-muted-foreground"
    data-testid="group-turn-status"
    data-phase={turn?.phase}
  >
    {#if turn?.phase === 'triaging'}
      <span class="animate-pulse">{t('turn.triaging')}</span>
    {:else if queueNames.length > 0}
      <span data-testid="group-turn-queue">
        {t('turn.running', { current: currentName, queue: queueNames })}
      </span>
    {:else}
      <span data-testid="group-turn-single">{t('turn.single', { current: currentName })}</span>
    {/if}
  </div>
{/if}

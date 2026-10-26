<script lang="ts">
  import { describeInstant, type TodoRun } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import type { BoardCardView } from './board.svelte';

  /**
   * Dispatch history for one card. `todos.get` is a read, so the board-managed
   * write guard does not apply. A row opens the result message in the chat.
   */
  let {
    card,
    onOpen,
  }: {
    card: BoardCardView;
    onOpen: (messageId: string | null) => void;
  } = $props();

  let runs = $state<TodoRun[]>([]);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const STATUS_LABEL = {
    dispatched: 'board.runs.status.dispatched',
    delivered: 'board.runs.status.delivered',
    unclaimed: 'board.runs.status.unclaimed',
    failed: 'board.runs.status.failed',
  } as const;

  $effect(() => {
    const id = card.id;
    const stamp = `${card.todo.status}:${card.todo.lastRun?.id ?? ''}:${card.todo.lastRun?.status ?? ''}`;
    void stamp;
    let cancelled = false;
    void (async () => {
      try {
        const result = (await core.call('todos.get', { id })) as { runs: TodoRun[] };
        if (!cancelled) runs = result.runs;
      } catch {
        if (!cancelled) runs = [];
      }
    })();
    return () => {
      cancelled = true;
    };
  });
</script>

{#if runs.length > 0}
  <section class="mt-4" data-testid="board-dialog-runs">
    <h3 class="mb-1 text-xs font-medium text-muted-foreground">{t('board.runs.title')}</h3>
    <ul class="space-y-0.5">
      {#each runs as run (run.id)}
        <li>
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-accent"
            onclick={() => onOpen(run.resultMessageId ?? run.messageId)}
            aria-label={t('board.runs.open')}
          >
            <span class="shrink-0 text-muted-foreground tabular-nums">
              {describeInstant(run.dispatchedAt, zone)}
            </span>
            <span class="min-w-0 flex-1 truncate">{t(STATUS_LABEL[run.status])}</span>
            <span aria-hidden="true">›</span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

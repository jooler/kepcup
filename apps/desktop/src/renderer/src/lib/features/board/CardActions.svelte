<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { primaryActions, type BoardAction } from './board-model';
  import { board, type BoardCardView } from './board.svelte';

  /**
   * Primary status actions (start / reschedule / clear / cancel / accept /
   * reopen). Shared by the detail field row and, on narrow layouts, the chat
   * tab so accepting or cancelling stays reachable while reading the thread.
   * The time popover only exists on the detail side, so `onReschedule` is
   * optional and the action disappears without it.
   */
  let {
    card,
    onReschedule,
    testidPrefix = 'board-dialog-action',
  }: {
    card: BoardCardView;
    onReschedule?: () => void;
    testidPrefix?: string;
  } = $props();

  let confirmingCancel = $state(false);
  let busy = $state(false);

  const actions = $derived(
    primaryActions(card).filter((action) => action !== 'reschedule' || onReschedule !== undefined),
  );

  const LABEL = {
    start: 'board.action.start',
    reschedule: 'board.action.reschedule',
    runOnce: 'board.action.runOnce',
    clearWhen: 'board.action.clearWhen',
    cancel: 'board.action.cancel',
    accept: 'board.action.accept',
    reopen: 'board.action.reopen',
  } as const satisfies Record<BoardAction, string>;

  async function run(action: BoardAction): Promise<void> {
    if (action === 'reschedule') {
      onReschedule?.();
      return;
    }
    if (action === 'cancel') {
      confirmingCancel = true;
      return;
    }
    if (busy) return;
    busy = true;
    try {
      const method =
        action === 'start' || action === 'runOnce'
          ? 'board.cards.start'
          : action === 'clearWhen'
            ? 'board.cards.schedule'
            : action === 'accept'
              ? 'board.cards.complete'
              : 'board.cards.reopen';
      const input = action === 'clearWhen' ? { cardId: card.id, when: null } : { cardId: card.id };
      const result = await board.mutateCard(method, input);
      if (result.ok) toast.success(t(LABEL[action]));
    } finally {
      busy = false;
    }
  }

  async function confirmCancel(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await board.mutateCard('board.cards.cancel', { cardId: card.id });
      if (result.ok) {
        confirmingCancel = false;
        toast.success(t('board.action.cancel'));
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex items-center gap-1" data-testid={testidPrefix}>
  {#if confirmingCancel}
    <Button size="sm" variant="ghost" onclick={() => (confirmingCancel = false)}>
      {t('common.cancel')}
    </Button>
    <Button
      size="sm"
      variant="destructive"
      disabled={busy}
      onclick={() => void confirmCancel()}
      data-testid={`${testidPrefix}-cancel-confirm`}
    >
      {t('board.action.cancelConfirm')}
    </Button>
  {:else}
    {#each actions as action, index (action)}
      <Button
        size="sm"
        variant={index === 0 && action !== 'cancel' ? 'default' : 'ghost'}
        class={action === 'cancel' ? 'text-destructive' : ''}
        disabled={busy}
        onclick={() => void run(action)}
        data-testid={`${testidPrefix}-${action}`}
      >
        {t(LABEL[action])}
      </Button>
    {/each}
  {/if}
</div>

<script lang="ts">
  import { describeInstant } from '@kepcup/shared';
  import { Clock } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { cardFooter, deriveCardStatus, primaryActions, type BoardAction } from './board-model';
  import { board, type BoardCardView } from './board.svelte';
  import CardWhenPopover from './CardWhenPopover.svelte';

  let { card }: { card: BoardCardView } = $props();

  let whenOpen = $state(false);
  let confirmingCancel = $state(false);
  let busy = $state(false);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const footer = $derived(cardFooter(card));
  const status = $derived(deriveCardStatus(card));
  const actions = $derived(primaryActions(card));
  const locked = $derived(
    card.todo.status === 'in_progress' ||
      card.todo.status === 'delivered' ||
      card.todo.status === 'done' ||
      card.todo.status === 'cancelled',
  );
  const whenDisabled = $derived(card.todo.assignee === null || locked);
  const whenTitle = $derived(
    card.todo.assignee === null
      ? t('board.dialog.when.needAssignee')
      : locked
        ? t('board.dialog.when.locked')
        : t('board.dialog.when.label'),
  );
  const nextFire = $derived(
    card.todo.schedule?.nextFireAt == null
      ? null
      : describeInstant(card.todo.schedule.nextFireAt, card.todo.schedule.timezone || zone),
  );
  const created = $derived(describeInstant(card.createdAt, zone));

  const LABEL = {
    start: 'board.action.start',
    reschedule: 'board.action.reschedule',
    runOnce: 'board.action.runOnce',
    clearWhen: 'board.action.clearWhen',
    cancel: 'board.action.cancel',
    accept: 'board.action.accept',
    reopen: 'board.action.reopen',
  } as const satisfies Record<BoardAction, string>;

  function dot(tone: string): string {
    if (tone === 'sky') return 'bg-sky-500';
    if (tone === 'emerald') return 'bg-emerald-500';
    if (tone === 'amber') return 'bg-amber-500';
    return 'bg-muted-foreground';
  }

  async function run(action: BoardAction): Promise<void> {
    if (action === 'reschedule') {
      if (whenDisabled) return;
      whenOpen = true;
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
      const input =
        action === 'clearWhen' ? { cardId: card.id, when: null } : { cardId: card.id };
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

<div class="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-3 text-xs">
  <div class="relative">
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
      disabled={whenDisabled}
      title={whenTitle}
      aria-label={whenTitle}
      onclick={() => (whenOpen = !whenOpen)}
      data-testid="board-dialog-when"
    >
      <Clock class="size-3" aria-hidden="true" />
      <span>{footer?.when ?? t('board.dialog.when.none')}</span>
    </button>
    <CardWhenPopover {card} bind:open={whenOpen} />
  </div>
  {#if status}
    <span
      class="inline-flex items-center gap-1 rounded-full border px-2 py-1"
      data-testid="board-dialog-status"
    >
      <span class="size-1.5 rounded-full {dot(status.tone)}" aria-hidden="true"></span>
      {t(status.label, status.params)}
    </span>
  {/if}
  {#if nextFire !== null}
    <span class="text-muted-foreground">{t('board.meta.nextFire', { time: nextFire })}</span>
  {/if}
  <span class="text-muted-foreground">{t('board.meta.createdAt', { time: created })}</span>
  <div class="ml-auto flex items-center gap-1" data-testid="board-dialog-action">
    {#if confirmingCancel}
      <Button size="sm" variant="ghost" onclick={() => (confirmingCancel = false)}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" variant="destructive" disabled={busy} onclick={() => void confirmCancel()}>
        {t('board.action.cancelConfirm')}
      </Button>
    {:else}
      {#each actions as action, index (action)}
        <Button
          size="sm"
          variant={index === 0 && action !== 'cancel' ? 'default' : 'ghost'}
          class={action === 'cancel' ? 'text-destructive' : ''}
          disabled={busy || (action === 'reschedule' && whenDisabled)}
          onclick={() => void run(action)}
          data-testid={`board-dialog-action-${action}`}
        >
          {t(LABEL[action])}
        </Button>
      {/each}
    {/if}
  </div>
</div>

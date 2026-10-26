<script lang="ts">
  import { describeInstant } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import WhenPicker from '$lib/features/workbench/WhenPicker.svelte';
  import { describeAt } from '$lib/features/workbench/describe';
  import {
    draftFromSchedule,
    emptyWhenDraft,
    fromLocalInput,
    nextFireOfPreset,
    whenFromDraft,
    type WhenDraft,
  } from '$lib/features/workbench/when-presets';
  import { board, type BoardCardView } from './board.svelte';

  /**
   * Time popover. Quiet hours are not predicted here: they live on the bot
   * profile, not in the settings catalog, and the schedule RPC already
   * returns them as warnings. A cron that is too frequent stays in this
   * popover.
   */
  let {
    card,
    open = $bindable(false),
  }: {
    card: BoardCardView;
    open?: boolean;
  } = $props();

  let draft = $state<WhenDraft>(emptyWhenDraft());
  let error = $state<string | null>(null);
  let saving = $state(false);
  let root = $state<HTMLElement | null>(null);

  const next = $derived.by(() => {
    if (draft.mode === 'repeat' && draft.customCron === null) {
      const at = nextFireOfPreset(draft.preset, Date.now());
      return at === null ? '' : t('workbench.drawer.next', { when: describeAt(at) });
    }
    if (draft.mode === 'once') {
      const at = fromLocalInput(draft.onceLocal);
      return at === null ? '' : t('workbench.drawer.next', { when: describeInstant(at, Intl.DateTimeFormat().resolvedOptions().timeZone) });
    }
    return '';
  });

  let seeded = false;
  $effect(() => {
    if (!open) {
      seeded = false;
      return;
    }
    if (seeded) return;
    seeded = true;
    draft = draftFromSchedule(card.todo.schedule);
    error = null;
  });

  function onPointerDown(event: PointerEvent): void {
    if (!open) return;
    if (root?.contains(event.target as Node)) return;
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    open = false;
  }

  async function save(when: string | null): Promise<void> {
    if (saving) return;
    saving = true;
    error = null;
    try {
      const result = await board.mutateCard('board.cards.schedule', { cardId: card.id, when });
      if (!result.ok) {
        if (result.code === 'BOARD_CRON_TOO_FREQUENT') {
          error = errorText(result.code, t('chats.errorCode.BOARD_CRON_TOO_FREQUENT'));
        }
        return;
      }
      open = false;
    } finally {
      saving = false;
    }
  }

  function onSave(): void {
    const when = whenFromDraft(draft);
    if (when === undefined) return;
    void save(when);
  }
</script>

<svelte:window onpointerdown={onPointerDown} />
<svelte:document onkeydowncapture={onKeydown} />

{#if open}
  <div
    bind:this={root}
    class="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-xl border bg-popover p-3 shadow-xl"
    data-testid="board-dialog-when-popover"
  >
    <WhenPicker bind:draft hasAssignee={card.todo.assignee !== null} {next} />
    {#if error !== null}
      <p class="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="board-dialog-when-error">
        {error}
      </p>
    {/if}
    <div class="mt-3 flex justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={saving}
        onclick={() => void save(null)}
        data-testid="board-dialog-when-clear"
      >
        {t('board.dialog.when.clear')}
      </Button>
      <Button
        size="sm"
        disabled={saving || whenFromDraft(draft) === undefined}
        onclick={onSave}
        data-testid="board-dialog-when-save"
      >
        {t('board.dialog.when.save')}
      </Button>
    </div>
  </div>
{/if}

<script lang="ts">
  import { AlarmClock, Calendar, ChevronLeft, Play, Repeat } from '@lucide/svelte';
  import { Popover } from 'bits-ui';
  import { describeInstant, describeScheduleWhen } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import WhenFields from '$lib/features/workbench/WhenFields.svelte';
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
  import { isCardLocked } from './board-model';

  /**
   * Time popover. Menu first (now / once / repeat); the once and repeat items
   * swap the menu for their fields. Quiet hours are not predicted here: they
   * live on the bot profile, not in the settings catalog, and the schedule RPC
   * already returns them as warnings. A cron that is too frequent stays here.
   * The panel is portal'd and fixed-positioned so the dialog's scroll box
   * cannot clip it.
   */
  let {
    card,
    open = $bindable(false),
  }: {
    card: BoardCardView;
    open?: boolean;
  } = $props();

  type Stage = 'menu' | 'once' | 'repeat';

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const locked = $derived(isCardLocked(card));
  const recurring = $derived(card.todo.schedule?.kind === 'cron');
  // 未指派时 cardFooter 为 null，而排期（含指派前的意图）照样要显示。
  const whenPhrase = $derived(
    card.todo.schedule === null
      ? null
      : describeScheduleWhen(card.todo.schedule, { localTimeZone: zone, now: Date.now() }),
  );
  const triggerTitle = $derived(
    locked ? t('board.dialog.when.locked') : t('board.dialog.when.label'),
  );
  const triggerLabel = $derived(
    locked
      ? triggerTitle
      : t('common.labelValue', {
          label: t('board.dialog.when.label'),
          value: whenPhrase ?? t('board.dialog.when.none'),
        }),
  );
  // 「现在」dispatches immediately, so core needs an executor for it.
  const canRunNow = $derived(card.todo.assignee !== null);

  let stage = $state<Stage>('menu');
  let draft = $state<WhenDraft>(emptyWhenDraft());
  let error = $state<string | null>(null);
  let saving = $state(false);

  const next = $derived.by(() => {
    if (draft.mode === 'repeat' && draft.customCron === null) {
      const at = nextFireOfPreset(draft.preset, Date.now());
      return at === null ? '' : t('workbench.drawer.next', { when: describeAt(at) });
    }
    if (draft.mode === 'once') {
      const at = fromLocalInput(draft.onceLocal);
      return at === null
        ? ''
        : t('workbench.drawer.next', {
            when: describeInstant(at, Intl.DateTimeFormat().resolvedOptions().timeZone),
          });
    }
    return '';
  });

  let seeded = false;
  // `pre` so the first paint after opening is already the seeded menu, not the
  // stage left over from the previous open.
  $effect.pre(() => {
    if (!open) {
      seeded = false;
      return;
    }
    if (seeded) return;
    seeded = true;
    draft = draftFromSchedule(card.todo.schedule);
    stage = 'menu';
    error = null;
  });

  function enter(target: Exclude<Stage, 'menu'>): void {
    draft = { ...draft, mode: target };
    stage = target;
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

  const MENU_ITEM =
    'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="inline-flex max-w-56 cursor-pointer items-center gap-1 rounded-md px-1 py-1 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    disabled={locked}
    title={triggerTitle}
    aria-label={triggerLabel}
    data-testid="board-dialog-when"
  >
    <span class="truncate">{whenPhrase ?? t('board.dialog.when.none')}</span>
    {#if recurring}
      <Repeat class="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    {/if}
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      class="z-[70] max-h-[min(70vh,560px)] w-fit min-w-64 overflow-y-auto rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl"
      side="bottom"
      align="start"
      sideOffset={8}
      collisionPadding={8}
      data-testid="board-dialog-when-popover"
    >
      {#if stage === 'menu'}
        <div class="space-y-0.5">
          <button
            type="button"
            class={MENU_ITEM}
            disabled={saving || !canRunNow}
            title={!canRunNow ? t('board.dialog.when.needAssignee') : undefined}
            onclick={() => void save('now')}
            data-testid="todo-when-now"
          >
            <Play class="size-4 text-muted-foreground" aria-hidden="true" />
            {t('board.dialog.when.now')}
          </button>
          <button
            type="button"
            class={MENU_ITEM}
            disabled={saving}
            onclick={() => enter('once')}
            data-testid="todo-when-once"
          >
            <AlarmClock class="size-4 text-muted-foreground" aria-hidden="true" />
            {t('board.dialog.when.once')}
          </button>
          <button
            type="button"
            class={MENU_ITEM}
            disabled={saving}
            onclick={() => enter('repeat')}
            data-testid="todo-when-repeat"
          >
            <Calendar class="size-4 text-muted-foreground" aria-hidden="true" />
            {t('board.dialog.when.repeat')}
          </button>
        </div>
        {#if !canRunNow}
          <p class="mt-1 px-2 text-xs text-muted-foreground">
            {t('board.dialog.when.needAssignee')}
          </p>
        {/if}
      {:else}
        <div class="mb-2 flex items-center gap-1">
          <button
            type="button"
            class="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
            aria-label={t('common.back')}
            onclick={() => (stage = 'menu')}
            data-testid="board-dialog-when-back"
          >
            <ChevronLeft class="size-4" aria-hidden="true" />
          </button>
          <span class="text-xs font-medium">
            {stage === 'once' ? t('board.dialog.when.once') : t('board.dialog.when.repeat')}
          </span>
        </div>
        <WhenFields bind:draft mode={stage} disabled={saving} />
        {#if next !== ''}
          <p class="mt-2 text-xs text-muted-foreground" data-testid="board-dialog-when-next">
            {next}
          </p>
        {/if}
      {/if}

      {#if error !== null}
        <p
          class="mt-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="board-dialog-when-error"
        >
          {error}
        </p>
      {/if}

      {#if stage !== 'menu'}
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
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

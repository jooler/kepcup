<script lang="ts">
  import { describeInstant } from '@kepcup/shared';
  import { Calendar, ListChecks, User } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { deriveCardStatus } from './board-model';
  import type { BoardCardView } from './board.svelte';
  import CardActions from './CardActions.svelte';
  import CardExecutorMenu from './CardExecutorMenu.svelte';
  import CardWhenPopover from './CardWhenPopover.svelte';

  /**
   * 详情字段行（状态 / 执行者 / 执行时间），替代旧的底部工具栏。执行时间
   * 的单次与周期设置仍是 CardWhenPopover，改期动作把气泡锚在这一行上。
   * 时间不再依赖执行者：未指派先定的时间是卡片上的排期意图，指派后
   * core 自动落成真正的排期。
   */
  let { card }: { card: BoardCardView } = $props();

  let whenOpen = $state(false);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const status = $derived(deriveCardStatus(card));
  const nextFire = $derived(
    card.todo.schedule?.nextFireAt == null
      ? null
      : describeInstant(card.todo.schedule.nextFireAt, card.todo.schedule.timezone || zone),
  );
  const created = $derived(describeInstant(card.createdAt, zone));

  function dot(tone: string): string {
    if (tone === 'sky') return 'bg-sky-500';
    if (tone === 'emerald') return 'bg-emerald-500';
    if (tone === 'amber') return 'bg-amber-500';
    return 'bg-muted-foreground';
  }
</script>

<div data-testid="board-dialog-fields">
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-sm">
    <span class="flex w-20 shrink-0 items-center gap-2 text-muted-foreground">
      <ListChecks class="size-4" aria-hidden="true" />
      <span>{t('board.dialog.status.label')}</span>
    </span>
    {#if status}
      <span
        class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
        data-testid="board-dialog-status"
      >
        <span class="size-1.5 rounded-full {dot(status.tone)}" aria-hidden="true"></span>
        {t(status.label, status.params)}
      </span>
    {:else}
      <span class="text-xs text-muted-foreground" data-testid="board-dialog-status">
        {t('board.status.idle')}
      </span>
    {/if}
    <span class="text-xs text-muted-foreground">{t('board.meta.createdAt', { time: created })}</span
    >
    <div class="ml-auto">
      <CardActions {card} onReschedule={() => (whenOpen = true)} />
    </div>
  </div>
  <div class="flex items-center gap-3 border-t py-2.5 text-sm">
    <span class="flex w-20 shrink-0 items-center gap-2 text-muted-foreground">
      <User class="size-4" aria-hidden="true" />
      <span>{t('board.dialog.executor.label')}</span>
    </span>
    <CardExecutorMenu {card} />
  </div>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t py-2.5 text-sm">
    <span class="flex w-20 shrink-0 items-center gap-2 text-muted-foreground">
      <Calendar class="size-4" aria-hidden="true" />
      <span>{t('board.dialog.when.label')}</span>
    </span>
    <CardWhenPopover {card} bind:open={whenOpen} />
    {#if nextFire !== null}
      <span class="text-xs text-muted-foreground"
        >{t('board.meta.nextFire', { time: nextFire })}</span
      >
    {/if}
  </div>
</div>

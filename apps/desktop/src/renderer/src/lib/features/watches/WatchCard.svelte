<script lang="ts">
  import { ScanEye } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { watches } from '$lib/stores/watches.svelte';
  import { Button } from '$lib/components/ui/button';
  import { conditionLabel, intervalMinutes, watchActions } from './watch-view';

  /**
   * 对话内的监看卡（W7，cardType `watch`）：创建卡（created）、提醒卡（alert，
   * 带本次的增删改摘要）、暂停卡（paused，连续失败或提醒过于频繁后出现，可
   * 「恢复」）。都按监看行实时重绘（watch.updated）；暂停卡的标题用卡片里记下的
   * 原因与失败次数（恢复后实时计数已清零，旧卡仍要读得对）。「全部监看」打开
   * 右栏的定时与监看标签。
   */
  let {
    watchId,
    watchEvent,
    watchSeq = undefined,
    watchSummary = undefined,
    watchPauseReason = undefined,
    watchFailures = undefined,
  }: {
    watchId: string;
    watchEvent: string;
    watchSeq?: number | undefined;
    watchSummary?: string | undefined;
    watchPauseReason?: string | undefined;
    watchFailures?: number | undefined;
  } = $props();

  $effect(() => {
    void watches.ensure(watchId);
  });

  const watch = $derived(watches.byId[watchId] ?? null);
  const removed = $derived(watches.removed[watchId] === true);
  const actions = $derived(watch !== null && !removed ? watchActions(watch) : null);
  let busy = $state(false);
  let expanded = $state(false);
  let confirmingStop = $state(false);

  const title = $derived(
    watchEvent === 'alert'
      ? t('watches.card.alert', { seq: watchSeq ?? '?' })
      : watchEvent === 'paused'
        ? pausedTitle(watchPauseReason, watchFailures)
        : t('watches.card.created'),
  );

  function pausedTitle(reason: string | undefined, failures: number | undefined): string {
    if (reason === 'too_frequent') return t('watches.card.pausedTooFrequent');
    return failures !== undefined
      ? t('watches.card.paused', { count: failures })
      : t('watches.card.pausedFailures');
  }

  async function act(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    busy = true;
    try {
      await watches.act(watchId, action);
      toast.success(
        t(
          action === 'stop'
            ? 'watches.stopped'
            : action === 'resume'
              ? 'watches.resumed'
              : 'watches.paused',
        ),
      );
      confirmingStop = false;
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('watches.actionFailed')));
    } finally {
      busy = false;
    }
  }
</script>

{#if watch === null}
  <span class="rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground"
    >{removed ? t('watches.card.removed') : t('watches.card.loading')}</span
  >
{:else}
  <div
    class="w-full max-w-[85%] rounded-lg border p-3 text-sm {watchEvent === 'paused' &&
    watch.status === 'paused'
      ? 'border-amber-500/40 bg-amber-500/5'
      : 'bg-background/80'}"
    data-testid={`watch-card-${watchEvent}-${watchId}`}
    data-watch-status={removed ? 'removed' : watch.status}
  >
    <div class="flex items-start gap-2">
      <ScanEye
        class="mt-0.5 size-4 shrink-0 {watch.status === 'active' && !removed
          ? 'text-sky-600'
          : 'text-muted-foreground'}"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <p class="font-medium">{title}</p>
        <p class="truncate text-xs text-muted-foreground" title={watch.source.url}>
          {watch.source.url}
        </p>
        <p class="text-xs text-muted-foreground" data-testid="watch-card-condition">
          {t(conditionLabel(watch.condition).key, conditionLabel(watch.condition).params)} · {t(
            'watches.every',
            {
              minutes: intervalMinutes(watch),
            },
          )} · {chat.botName(watch.botId)} ·
          {removed ? t('watches.card.removed') : t(`watches.status.${watch.status}`)}
        </p>
      </div>
    </div>
    {#if watchEvent === 'alert' && watchSummary}
      <p
        class="mt-2 rounded-md bg-muted/60 px-2 py-1 text-xs whitespace-pre-wrap {expanded
          ? ''
          : 'line-clamp-6'}"
        data-testid="watch-card-summary"
      >
        {watchSummary}
      </p>
    {/if}
    {#if watchEvent === 'paused' && watch.status === 'paused'}
      <p class="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="watch-card-error">
        {watch.lastError ?? ''}
      </p>
      <p class="mt-1 text-xs text-muted-foreground">
        {t(
          watchPauseReason === 'too_frequent'
            ? 'watches.card.pausedTooFrequentHint'
            : 'watches.card.pausedHint',
        )}
      </p>
    {/if}
    <div class="mt-2 flex flex-wrap justify-end gap-1">
      {#if watchEvent === 'alert' && (watchSummary?.length ?? 0) > 200}
        <Button
          size="sm"
          variant="ghost"
          class="h-6 px-2 text-xs"
          onclick={() => (expanded = !expanded)}
        >
          {expanded ? t('watches.collapse') : t('watches.expand')}
        </Button>
      {/if}
      <Button
        size="sm"
        variant="ghost"
        class="h-6 px-2 text-xs"
        onclick={() => shell.openSchedules()}
        data-testid="watch-card-all">{t('watches.viewAll')}</Button
      >
      {#if actions?.resume}
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          disabled={busy}
          onclick={() => void act('resume')}
          data-testid="watch-card-resume">{t('watches.resume')}</Button
        >
      {/if}
      {#if actions?.stop}
        {#if confirmingStop}
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs"
            onclick={() => (confirmingStop = false)}>{t('common.cancel')}</Button
          >
          <Button
            size="sm"
            class="h-6 px-2 text-xs"
            disabled={busy}
            onclick={() => void act('stop')}
            data-testid="watch-card-stop-confirm">{t('watches.stopConfirm')}</Button
          >
        {:else}
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs text-destructive"
            onclick={() => (confirmingStop = true)}
            data-testid="watch-card-stop">{t('watches.stop')}</Button
          >
        {/if}
      {/if}
    </div>
  </div>
{/if}

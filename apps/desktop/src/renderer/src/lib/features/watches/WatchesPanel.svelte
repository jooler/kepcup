<script lang="ts">
  import type { WatchEntry } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { watches } from '$lib/stores/watches.svelte';
  import { Button } from '$lib/components/ui/button';
  import { conditionLabel, intervalMinutes, watchActions } from './watch-view';

  /**
   * 网页监看列表（W7）：右栏「定时任务」标签（单聊）与群信息里，紧跟定时任务
   * 列表。随 watch.updated 实时刷新；可暂停 / 恢复 / 停止（停止两步确认）。
   */
  let {
    conversationId = undefined,
    active = true,
    testid = 'watches-panel',
  }: {
    /** Omitted = every watch (settings overview). */
    conversationId?: string | undefined;
    /** bits-ui keeps inactive tab content mounted (hidden): fetch only when visible. */
    active?: boolean;
    testid?: string;
  } = $props();

  let entries = $state<WatchEntry[]>([]);
  let loading = $state(false);
  let stopTarget = $state<string | null>(null);
  let busy = $state(false);

  $effect(() => {
    if (active) void refresh();
  });
  $effect(() => {
    if (!active) return;
    return core.onEvent('watch.updated', (payload) => {
      const { watch } = payload as { watch: WatchEntry };
      if (conversationId === undefined || watch.conversationId === conversationId) void refresh();
    });
  });

  /**
   * Refresh sequence: watch.updated bursts (every check publishes) start
   * overlapping refreshes — only the latest one's answer is applied, so an
   * older, slower list never overwrites a newer one.
   */
  let refreshSeq = 0;

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq;
    loading = true;
    try {
      // Plain object literal — $state Proxy values never cross postMessage.
      const input = conversationId === undefined ? {} : { conversationId };
      const result = (await core.call('watches.list', input)) as { watches: WatchEntry[] };
      if (seq === refreshSeq) entries = result.watches;
    } catch (error) {
      if (seq === refreshSeq) {
        toast.error(
          errorText((error as { code?: string } | undefined)?.code, t('watches.actionFailed')),
        );
      }
    } finally {
      if (seq === refreshSeq) loading = false;
    }
  }

  async function act(id: string, action: 'pause' | 'resume' | 'stop'): Promise<void> {
    busy = true;
    try {
      await watches.act(id, action);
      toast.success(
        t(
          action === 'stop'
            ? 'watches.stopped'
            : action === 'resume'
              ? 'watches.resumed'
              : 'watches.paused',
        ),
      );
      stopTarget = null;
      await refresh();
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('watches.actionFailed')),
      );
    } finally {
      busy = false;
    }
  }

  function checkedText(entry: WatchEntry): string {
    if (entry.lastCheckedAt === null) return t('watches.neverChecked');
    return t('watches.lastChecked', { time: new Date(entry.lastCheckedAt).toLocaleString() });
  }
</script>

<div class="flex flex-col gap-2" data-testid={testid}>
  <p class="text-xs text-muted-foreground">{t('watches.hint')}</p>
  {#if loading && entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-loading`}>…</p>
  {:else if entries.length === 0}
    <p class="text-sm text-muted-foreground" data-testid={`${testid}-empty`}>
      {t('watches.empty')}
    </p>
  {:else}
    <ul class="space-y-2" data-testid={`${testid}-list`}>
      {#each entries as entry (entry.id)}
        {@const actions = watchActions(entry)}
        <li
          class="rounded-md border p-2 text-sm"
          data-testid={`watch-item-${entry.id}`}
          data-watch-status={entry.status}
        >
          <div class="flex items-center gap-2">
            <p
              class="min-w-0 flex-1 truncate font-medium"
              title={entry.source.url}
              data-testid="watch-url"
            >
              {entry.source.url}
            </p>
            <span
              class="shrink-0 rounded-md px-1.5 py-0.5 text-xs {entry.status === 'active'
                ? 'bg-sky-500/10 text-sky-700 dark:text-sky-400'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}"
              data-testid="watch-status">{t(`watches.status.${entry.status}`)}</span
            >
          </div>
          <p class="mt-0.5 text-xs text-muted-foreground" data-testid="watch-condition">
            {t(conditionLabel(entry.condition).key, conditionLabel(entry.condition).params)} · {t(
              'watches.every',
              {
                minutes: intervalMinutes(entry),
              },
            )}
          </p>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {entry.botName ?? entry.botId} · {checkedText(entry)}{#if entry.alertSeq > 0}
              · {t('watches.alerts', { count: entry.alertSeq })}{/if}
          </p>
          {#if entry.failures > 0}
            <p
              class="mt-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"
              data-testid="watch-failing"
            >
              {t('watches.failing', { count: entry.failures, error: entry.lastError ?? '' })}
            </p>
          {/if}
          <div class="mt-1 flex justify-end gap-1">
            {#if actions.pause}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                disabled={busy}
                onclick={() => void act(entry.id, 'pause')}
                data-testid={`watch-pause-${entry.id}`}>{t('watches.pause')}</Button
              >
            {/if}
            {#if actions.resume}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                disabled={busy}
                onclick={() => void act(entry.id, 'resume')}
                data-testid={`watch-resume-${entry.id}`}>{t('watches.resume')}</Button
              >
            {/if}
            {#if stopTarget === entry.id}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs"
                onclick={() => (stopTarget = null)}>{t('common.cancel')}</Button
              >
              <Button
                size="sm"
                class="h-6 px-2 text-xs"
                disabled={busy}
                onclick={() => void act(entry.id, 'stop')}
                data-testid="watch-stop-confirm">{t('watches.stopConfirm')}</Button
              >
            {:else if actions.stop}
              <Button
                size="sm"
                variant="ghost"
                class="h-6 px-2 text-xs text-destructive"
                onclick={() => (stopTarget = entry.id)}
                data-testid={`watch-stop-${entry.id}`}>{t('watches.stop')}</Button
              >
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

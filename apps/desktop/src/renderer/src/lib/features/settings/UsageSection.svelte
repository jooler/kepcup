<script lang="ts">
  import type { UsageStatsOutput, UsageSummaryEntry } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { toast } from 'svelte-sonner';
  import UsageActivityCard from './usage/UsageActivityCard.svelte';
  import UsageAgentsCard from './usage/UsageAgentsCard.svelte';
  import UsageCompositionCard from './usage/UsageCompositionCard.svelte';
  import UsageDetails from './usage/UsageDetails.svelte';
  import UsageModelDonut from './usage/UsageModelDonut.svelte';
  import UsageTrendCard from './usage/UsageTrendCard.svelte';
  import {
    formatCompact,
    formatCost,
    formatDayLabel,
    formatFull,
    localDateKeyOf,
    splitDuration,
  } from './usage/usage-format';

  /**
   * 设置 → 用量：KPI 看累计，Token 活动看一年节奏，趋势 / 模型占比 / 使用
   * 构成跟随「近 7 日 / 近 30 日」。顶部「统计 / 逐日明细」平级切换：明细视图
   * 用可核对的原表替换整块图表。
   *
   * 数据来自 `usage.stats`（聚合统计）与 `usage.summary`（逐日明细 / 外部
   * Agent 单列，D72 P5）；两者都从本地 usage_ledger 读取，不上传。
   */
  let stats = $state<UsageStatsOutput | null>(null);
  let entries = $state<UsageSummaryEntry[]>([]);
  let loading = $state(false);
  let rangeDays = $state<7 | 30>(7);
  /** 「统计」是图表看板；「逐日明细」把整块图表区换成可核对的原表。 */
  let view = $state<'stats' | 'details'>('stats');
  let requestSeq = 0;

  const locale = $derived(i18n.locale);
  const totals = $derived(stats?.totals ?? null);
  const peakDay = $derived(stats?.peakDay ?? null);
  const streak = $derived(stats?.streak ?? null);
  const longestChat = $derived(stats?.longestChat ?? null);

  // 首次进入与切换范围都走同一个 effect：refresh 同步读取 rangeDays，
  // 因而 rangeDays 变化会自动重取（按钮只负责改状态）。
  $effect(() => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    const days = rangeDays;
    const seq = ++requestSeq;
    loading = true;
    try {
      const [nextStats, summary] = await Promise.all([
        core.call('usage.stats', { days }) as Promise<UsageStatsOutput>,
        core.call('usage.summary', { days }) as Promise<{ entries: UsageSummaryEntry[] }>,
      ]);
      if (seq !== requestSeq) return;
      stats = nextStats;
      entries = summary.entries;
    } catch (error) {
      if (seq !== requestSeq) return;
      toast.error(
        t('settings.usageLoadFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  function botName(botId: string | null): string {
    if (botId === null) return t('settings.usageGlobalBots');
    const known = contacts.bots.find((bot) => bot.id === botId);
    return known ? known.name || botId : botId;
  }

  const longestChatValue = $derived.by(() => {
    if (longestChat === null) return '—';
    const { hours, minutes } = splitDuration(longestChat.minutes);
    if (hours > 0 && minutes > 0) {
      return t('settings.usageDurationHM', { hours, minutes });
    }
    if (hours > 0) return t('settings.usageDurationH', { hours });
    if (minutes > 0) return t('settings.usageDurationM', { minutes });
    return t('settings.usageDurationUnderMinute');
  });

  const totalSub = $derived(
    totals === null
      ? ''
      : `${t('settings.usageCalls', { n: formatFull(totals.calls, locale) })} · ${t(
          'settings.usageActiveDays',
          { n: totals.activeDays },
        )}`,
  );
</script>

<section class="space-y-4" data-testid="settings-usage">
  <div class="flex items-center gap-2">
    <h3 class="text-sm font-medium">{t('settings.usageSection')}</h3>
    <div class="flex items-center gap-1 text-sm" role="group">
      <button
        type="button"
        class="rounded px-1 py-0.5 transition-colors {view === 'stats'
          ? 'font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={view === 'stats'}
        data-testid="usage-view-stats"
        onclick={() => (view = 'stats')}>{t('settings.usageViewStats')}</button
      >
      <span class="text-muted-foreground/40" aria-hidden="true">/</span>
      <button
        type="button"
        class="rounded px-1 py-0.5 transition-colors {view === 'details'
          ? 'font-medium text-foreground'
          : 'text-muted-foreground hover:text-foreground'}"
        aria-pressed={view === 'details'}
        data-testid="usage-view-details"
        onclick={() => (view = 'details')}>{t('settings.usageDetails')}</button
      >
    </div>
    <Button
      size="sm"
      variant="ghost"
      class="ml-auto h-7 px-2 text-xs"
      disabled={loading}
      onclick={() => void refresh()}
      data-testid="usage-refresh"
    >
      {t('common.refresh')}
    </Button>
  </div>
  {#if view === 'stats'}
    <p class="text-xs text-muted-foreground">{t('settings.usageNote')}</p>
  {/if}

  {#if stats === null && loading}
    <p class="text-sm text-muted-foreground" data-testid="usage-loading">…</p>
  {:else if stats === null}
    <p class="text-sm text-muted-foreground" data-testid="usage-empty">
      {t('settings.usageEmpty')}
    </p>
  {:else if view === 'details'}
    <UsageDetails {entries} days={rangeDays} />
  {:else if stats.totals.calls === 0}
    <div class="rounded-lg border bg-card px-4 py-10 text-center" data-testid="usage-empty">
      <p class="text-sm text-muted-foreground">{t('settings.usageEmpty')}</p>
    </div>
  {:else}
    <!-- KPI 条：累计 Token / 峰值 / 最长聊天 / 连续天数 -->
    <section class="overflow-hidden rounded-lg border bg-border" data-testid="usage-kpis">
      <div class="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
        <div class="bg-card p-3">
          <p class="text-xs text-muted-foreground">{t('settings.usageTotalTokens')}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums" data-testid="usage-total-tokens">
            {formatCompact(totals?.tokens ?? 0, locale)}
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">{totalSub}</p>
        </div>
        <div class="bg-card p-3">
          <p class="text-xs text-muted-foreground">{t('settings.usagePeakTokens')}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums" data-testid="usage-peak-tokens">
            {peakDay === null ? '—' : formatCompact(peakDay.tokens, locale)}
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {peakDay === null
              ? '—'
              : t('settings.usagePeakDay', { date: formatDayLabel(peakDay.date, locale) })}
          </p>
        </div>
        <div class="bg-card p-3">
          <p class="text-xs text-muted-foreground">{t('settings.usageLongestChat')}</p>
          <p class="mt-1 text-base font-semibold tabular-nums" data-testid="usage-longest-chat">
            {longestChatValue}
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {longestChat === null
              ? '—'
              : `${botName(longestChat.botId)} · ${formatDayLabel(
                  localDateKeyOf(longestChat.startedAt),
                  locale,
                )}`}
          </p>
        </div>
        <div class="bg-card p-3">
          <p class="text-xs text-muted-foreground">{t('settings.usageCurrentStreak')}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums" data-testid="usage-current-streak">
            {streak?.current ?? 0}<span class="ml-1 text-xs font-normal text-muted-foreground"
              >{t('settings.usageDayUnit')}</span
            >
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {totals?.lastDate === null || totals?.lastDate === undefined
              ? '—'
              : t('settings.usageLastActive', {
                  date: formatDayLabel(totals.lastDate, locale),
                })}
          </p>
        </div>
        <div class="bg-card p-3">
          <p class="text-xs text-muted-foreground">{t('settings.usageLongestStreak')}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums" data-testid="usage-longest-streak">
            {streak?.longest ?? 0}<span class="ml-1 text-xs font-normal text-muted-foreground"
              >{t('settings.usageDayUnit')}</span
            >
          </p>
          <p class="mt-0.5 truncate text-[11px] text-muted-foreground">
            {totals === null ? '—' : t('settings.usageActiveDays', { n: totals.activeDays })}
          </p>
        </div>
      </div>
      {#if (totals?.cacheReadTokens ?? 0) > 0 || (totals?.costUsd ?? 0) > 0}
        <div
          class="flex flex-wrap gap-x-4 gap-y-1 border-t px-3 py-2 text-[11px] text-muted-foreground"
        >
          {#if (totals?.cacheReadTokens ?? 0) > 0}
            <span
              >{t('settings.usageCacheRead', {
                tokens: formatCompact(totals?.cacheReadTokens ?? 0, locale),
              })}</span
            >
          {/if}
          {#if (totals?.cacheWriteTokens ?? 0) > 0}
            <span
              >{t('settings.usageCacheWrite', {
                tokens: formatCompact(totals?.cacheWriteTokens ?? 0, locale),
              })}</span
            >
          {/if}
          {#if totals !== null && totals.costUsd !== null && totals.costUsd > 0}
            <span>{t('settings.usageCost', { amount: formatCost(totals.costUsd, locale) })}</span>
          {/if}
        </div>
      {/if}
    </section>

    <UsageActivityCard points={stats.heatmap.points} />

    <div class="flex items-center justify-between">
      <h3 class="text-sm font-medium">{t('settings.usageRange')}</h3>
      <div class="inline-flex rounded-md border p-0.5" role="group">
        <button
          type="button"
          class="rounded px-2.5 py-1 text-xs transition-colors {rangeDays === 7
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          aria-pressed={rangeDays === 7}
          data-testid="usage-range-7"
          onclick={() => (rangeDays = 7)}>{t('settings.usageRange7')}</button
        >
        <button
          type="button"
          class="rounded px-2.5 py-1 text-xs transition-colors {rangeDays === 30
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          aria-pressed={rangeDays === 30}
          data-testid="usage-range-30"
          onclick={() => (rangeDays = 30)}>{t('settings.usageRange30')}</button
        >
      </div>
    </div>

    <UsageTrendCard {stats} />
    <UsageModelDonut byModel={stats.range.byModel} />
    <UsageCompositionCard
      byLoop={stats.range.byLoop}
      byBot={stats.range.byBot}
      byTool={stats.range.byTool}
    />
    <UsageAgentsCard {entries} />
  {/if}
</section>

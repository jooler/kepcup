<script lang="ts">
  import type { UsageStatsOutput } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import {
    categoryX,
    niceTicks,
    seriesColor,
    yScale,
    type Plot,
  } from '$lib/features/present/present-geometry';
  import {
    formatAxisDate,
    formatCompact,
    formatFull,
    modelSeries,
    OTHER_MODEL_KEY,
    sampleIndexes,
  } from './usage-format';

  /** 每日 Token 趋势：所选范围内按模型拆分的折线（Top N + 其它）。 */
  let { stats }: { stats: UsageStatsOutput } = $props();

  const locale = $derived(i18n.locale);
  const dates = $derived(stats.range.daily.map((point) => point.date));
  const series = $derived(modelSeries(stats.range.byModel, stats.range.dailyByModel, dates));
  const hasData = $derived(series.some((item) => item.total > 0));

  const PLOT: Plot = { width: 720, height: 230, left: 50, right: 14, top: 12, bottom: 28 };
  const maxValue = $derived(Math.max(0, ...series.flatMap((item) => item.values)));
  const ticks = $derived(niceTicks(0, maxValue, 4));
  const y = $derived(yScale(PLOT, ticks));
  const x = $derived((index: number) => categoryX(PLOT, Math.max(1, dates.length), index));
  const labelIndexes = $derived(sampleIndexes(dates.length, 6));

  function seriesLabel(key: string, label: string): string {
    return key === OTHER_MODEL_KEY ? t('settings.usageOther') : label;
  }

  const description = $derived(
    series
      .map(
        (item) => `${seriesLabel(item.key, item.label)}：${formatFull(item.total, locale)} Token`,
      )
      .join('；'),
  );
</script>

<section class="rounded-lg border bg-card p-4" data-testid="usage-trend">
  <div class="flex flex-wrap items-baseline gap-2">
    <h4 class="text-sm font-medium">{t('settings.usageTrend')}</h4>
    <p class="text-xs text-muted-foreground">{t('settings.usageTrendHint')}</p>
  </div>

  {#if !hasData}
    <p class="py-10 text-center text-xs text-muted-foreground" data-testid="usage-trend-empty">
      {t('settings.usageNoData')}
    </p>
  {:else}
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1" data-testid="usage-trend-legend">
      {#each series as item, index (item.key)}
        <span class="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="size-2 rounded-full" style={`background:${seriesColor(index)}`}></span>
          <span class="max-w-44 truncate text-foreground/80"
            >{seriesLabel(item.key, item.label)}</span
          >
        </span>
      {/each}
    </div>

    <svg
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      class="mt-2 h-auto w-full"
      role="img"
      aria-label={description}
      data-testid="usage-trend-chart"
    >
      {#each ticks as tick (tick)}
        <line
          x1={PLOT.left}
          x2={PLOT.width - PLOT.right}
          y1={y(tick)}
          y2={y(tick)}
          class="stroke-border"
          stroke-width="1"
        />
        <text
          x={PLOT.left - 6}
          y={y(tick) + 4}
          text-anchor="end"
          class="fill-muted-foreground text-[10px]">{formatCompact(tick, locale)}</text
        >
      {/each}

      {#each series as item, seriesIndex (item.key)}
        <polyline
          fill="none"
          stroke={seriesColor(seriesIndex)}
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
          points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
        />
        {#each item.values as value, index (index)}
          <circle
            cx={x(index)}
            cy={y(value)}
            r={dates.length <= 10 ? 2.6 : 1.6}
            fill={seriesColor(seriesIndex)}
          >
            <title
              >{formatAxisDate(dates[index]!, locale)} · {seriesLabel(item.key, item.label)} · {formatFull(
                value,
                locale,
              )} Token</title
            >
          </circle>
        {/each}
      {/each}

      {#each labelIndexes as index (index)}
        <text
          x={x(index)}
          y={PLOT.height - 8}
          text-anchor="middle"
          class="fill-muted-foreground text-[10px]">{formatAxisDate(dates[index]!, locale)}</text
        >
      {/each}
    </svg>
  {/if}
</section>

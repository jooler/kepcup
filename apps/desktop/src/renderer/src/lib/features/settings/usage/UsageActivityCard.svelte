<script lang="ts">
  import type { UsageDailyPoint } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import { niceTicks, yScale, type Plot } from '$lib/features/present/present-geometry';
  import {
    cumulativeTotals,
    formatAxisDate,
    formatCompact,
    formatDayLabel,
    formatFull,
    formatMonthLabel,
    heatMatrix,
    sampleIndexes,
    weeklyTotals,
  } from './usage-format';

  /**
   * 「Token 活动」卡：每日用日历热力图，每周用柱状图，累计用面积图——
   * 同一个时间窗口换一种看法，避免把三套口径硬塞进同一张日历。
   */
  let { points }: { points: UsageDailyPoint[] } = $props();

  type Mode = 'daily' | 'weekly' | 'cumulative';
  let mode = $state<Mode>('daily');
  const locale = $derived(i18n.locale);

  const matrix = $derived(heatMatrix(points));
  const weeks = $derived(weeklyTotals(points));
  const cumulative = $derived(cumulativeTotals(points));

  const CELL = 11;
  const GAP = 3;
  const STEP = CELL + GAP;
  const heatWidth = $derived(Math.max(1, matrix.weeks) * STEP - GAP);
  const heatHeight = 7 * STEP - GAP;

  const monthLabels = $derived.by(() => {
    const labels: Array<{ column: number; date: string }> = [];
    for (const start of matrix.monthStarts) {
      const last = labels[labels.length - 1];
      if (last !== undefined && start.column - last.column < 4) {
        // A partial first month can be only one column wide: drop it in favor
        // of the new month rather than crowding two labels together.
        labels[labels.length - 1] = start;
      } else {
        labels.push(start);
      }
    }
    return labels;
  });

  const HEAT_OPACITY = [1, 0.2, 0.38, 0.62, 1] as const;

  /** Marker text for the mode legend / screen readers. */
  const summary = $derived.by(() => {
    const total = points.reduce((sum, point) => sum + point.tokens, 0);
    const active = points.filter((point) => point.tokens > 0).length;
    return `${t('settings.usageActivity')}：${t('settings.usageActivityWindow', {
      days: points.length,
      tokens: formatCompact(total, locale),
      active,
    })}`;
  });

  const hint = $derived(
    mode === 'daily'
      ? t('settings.usageActivityHint')
      : mode === 'weekly'
        ? t('settings.usageActivityWeeklyHint')
        : t('settings.usageActivityCumulativeHint'),
  );

  const WEEKLY: Plot = { width: 720, height: 170, left: 46, right: 10, top: 10, bottom: 24 };
  const weeklyMax = $derived(Math.max(0, ...weeks.map((week) => week.tokens)));
  const weeklyTicks = $derived(niceTicks(0, weeklyMax, 4));
  const weeklyY = $derived(yScale(WEEKLY, weeklyTicks));
  const weeklyBar = $derived(
    Math.max(1, ((WEEKLY.width - WEEKLY.left - WEEKLY.right) / Math.max(1, weeks.length)) * 0.62),
  );
  const weeklySlot = $derived(
    (WEEKLY.width - WEEKLY.left - WEEKLY.right) / Math.max(1, weeks.length),
  );
  const weeklyLabels = $derived(sampleIndexes(weeks.length, 8));

  const CUMULATIVE: Plot = { width: 720, height: 170, left: 46, right: 10, top: 10, bottom: 24 };
  const cumulativeMax = $derived(cumulative[cumulative.length - 1]?.tokens ?? 0);
  const cumulativeTicks = $derived(niceTicks(0, cumulativeMax, 4));
  const cumulativeY = $derived(yScale(CUMULATIVE, cumulativeTicks));
  const cumulativePoints = $derived(
    cumulative.map((point, index) => {
      const x =
        cumulative.length <= 1
          ? CUMULATIVE.left
          : CUMULATIVE.left +
            (index / (cumulative.length - 1)) *
              (CUMULATIVE.width - CUMULATIVE.left - CUMULATIVE.right);
      return `${x},${cumulativeY(point.tokens)}`;
    }),
  );
  const cumulativeArea = $derived(
    cumulativePoints.length === 0
      ? ''
      : `M ${CUMULATIVE.left} ${CUMULATIVE.height - CUMULATIVE.bottom} L ${cumulativePoints.join(
          ' L ',
        )} L ${
          CUMULATIVE.left + (CUMULATIVE.width - CUMULATIVE.left - CUMULATIVE.right)
        } ${CUMULATIVE.height - CUMULATIVE.bottom} Z`,
  );
  const cumulativeLabels = $derived(sampleIndexes(cumulative.length, 6));
  const cumulativeEndpoints = $derived(cumulative.length <= 1 ? [0] : [0, cumulative.length - 1]);

  function weekLabel(weekStart: string): string {
    return t('settings.usageWeekOf', { date: formatDayLabel(weekStart, locale) });
  }
</script>

<section class="rounded-lg border bg-card p-4" data-testid="usage-activity">
  <div class="flex flex-wrap items-center gap-2">
    <div>
      <h4 class="text-sm font-medium">{t('settings.usageActivity')}</h4>
      <p class="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
    <div class="ml-auto inline-flex rounded-md border p-0.5" role="group">
      {#each [{ id: 'daily', label: t('settings.usageModeDaily') }, { id: 'weekly', label: t('settings.usageModeWeekly') }, { id: 'cumulative', label: t('settings.usageModeCumulative') }] as option (option.id)}
        <button
          type="button"
          class="rounded px-2 py-1 text-xs transition-colors {mode === option.id
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground'}"
          aria-pressed={mode === option.id}
          data-testid={`usage-activity-mode-${option.id}`}
          onclick={() => (mode = option.id as Mode)}>{option.label}</button
        >
      {/each}
    </div>
  </div>

  <div class="mt-4" role="img" aria-label={summary}>
    {#if mode === 'daily'}
      {#if matrix.cells.length === 0}
        <p class="py-8 text-center text-xs text-muted-foreground">
          {t('settings.usageNoActivity')}
        </p>
      {:else}
        <div class="overflow-x-auto">
          <svg
            viewBox={`0 0 ${heatWidth} ${heatHeight + 18}`}
            class="h-auto w-full min-w-[600px]"
            data-testid="usage-heatmap"
          >
            {#each matrix.cells as cell (cell.date)}
              <rect
                x={cell.column * STEP}
                y={cell.row * STEP}
                width={CELL}
                height={CELL}
                rx="2"
                fill={cell.level === 0 ? 'var(--muted)' : '#3b82f6'}
                fill-opacity={HEAT_OPACITY[cell.level]}
              >
                <title
                  >{t('settings.usageTooltip', {
                    date: formatDayLabel(cell.date, locale),
                    tokens: formatFull(cell.tokens, locale),
                    calls: cell.calls,
                  })}</title
                >
              </rect>
            {/each}
            {#each monthLabels as label (label.column)}
              {@const atEnd = label.column >= matrix.weeks - 2}
              <text
                x={atEnd ? heatWidth : label.column * STEP}
                y={heatHeight + 12}
                text-anchor={atEnd ? 'end' : 'start'}
                class="fill-muted-foreground text-[9px]"
                >{formatMonthLabel(label.date, locale)}</text
              >
            {/each}
          </svg>
        </div>
      {/if}
    {:else if mode === 'weekly'}
      {#if weeks.length === 0 || weeklyMax === 0}
        <p class="py-8 text-center text-xs text-muted-foreground">
          {t('settings.usageNoActivity')}
        </p>
      {:else}
        <svg
          viewBox={`0 0 ${WEEKLY.width} ${WEEKLY.height}`}
          class="h-auto w-full"
          data-testid="usage-weekly"
        >
          {#each weeklyTicks as tick (tick)}
            <line
              x1={WEEKLY.left}
              x2={WEEKLY.width - WEEKLY.right}
              y1={weeklyY(tick)}
              y2={weeklyY(tick)}
              class="stroke-border"
              stroke-width="1"
            />
            <text
              x={WEEKLY.left - 6}
              y={weeklyY(tick) + 4}
              text-anchor="end"
              class="fill-muted-foreground text-[10px]">{formatCompact(tick, locale)}</text
            >
          {/each}
          {#each weeks as week, index (week.weekStart)}
            <rect
              x={WEEKLY.left + index * weeklySlot + (weeklySlot - weeklyBar) / 2}
              y={weeklyY(week.tokens)}
              width={weeklyBar}
              height={Math.max(0, weeklyY(0) - weeklyY(week.tokens))}
              rx="2"
              fill="#3b82f6"
              fill-opacity="0.85"
            >
              <title>{weekLabel(week.weekStart)} · {formatFull(week.tokens, locale)} Token</title>
            </rect>
          {/each}
          {#each weeklyLabels as index (index)}
            <text
              x={WEEKLY.left + index * weeklySlot + weeklySlot / 2}
              y={WEEKLY.height - 8}
              text-anchor="middle"
              class="fill-muted-foreground text-[10px]"
              >{formatMonthLabel(weeks[index]!.weekStart, locale)}</text
            >
          {/each}
        </svg>
      {/if}
    {:else if cumulative.length === 0 || cumulativeMax === 0}
      <p class="py-8 text-center text-xs text-muted-foreground">
        {t('settings.usageNoActivity')}
      </p>
    {:else}
      <svg
        viewBox={`0 0 ${CUMULATIVE.width} ${CUMULATIVE.height}`}
        class="h-auto w-full"
        data-testid="usage-cumulative"
      >
        <defs>
          <linearGradient id="usage-cumulative-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35" />
            <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        {#each cumulativeTicks as tick (tick)}
          <line
            x1={CUMULATIVE.left}
            x2={CUMULATIVE.width - CUMULATIVE.right}
            y1={cumulativeY(tick)}
            y2={cumulativeY(tick)}
            class="stroke-border"
            stroke-width="1"
          />
          <text
            x={CUMULATIVE.left - 6}
            y={cumulativeY(tick) + 4}
            text-anchor="end"
            class="fill-muted-foreground text-[10px]">{formatCompact(tick, locale)}</text
          >
        {/each}
        <path d={cumulativeArea} fill="url(#usage-cumulative-fill)" />
        <polyline
          points={cumulativePoints.join(' ')}
          fill="none"
          stroke="#3b82f6"
          stroke-width="2"
        />
        {#each cumulativeLabels as index (index)}
          <text
            x={CUMULATIVE.left +
              (cumulative.length <= 1
                ? 0
                : (index / (cumulative.length - 1)) *
                  (CUMULATIVE.width - CUMULATIVE.left - CUMULATIVE.right))}
            y={CUMULATIVE.height - 8}
            text-anchor="middle"
            class="fill-muted-foreground text-[10px]"
            >{index === cumulative.length - 1
              ? formatAxisDate(cumulative[index]!.date, locale)
              : formatMonthLabel(cumulative[index]!.date, locale)}</text
          >
        {/each}
        {#each cumulativeEndpoints as index (index)}
          <circle
            cx={CUMULATIVE.left +
              (cumulative.length <= 1
                ? 0
                : (index / (cumulative.length - 1)) *
                  (CUMULATIVE.width - CUMULATIVE.left - CUMULATIVE.right))}
            cy={cumulativeY(cumulative[index]!.tokens)}
            r="3"
            fill="#3b82f6"
          >
            <title
              >{formatDayLabel(cumulative[index]!.date, locale)} · {formatFull(
                cumulative[index]!.tokens,
                locale,
              )} Token</title
            >
          </circle>
        {/each}
      </svg>
    {/if}
  </div>
</section>

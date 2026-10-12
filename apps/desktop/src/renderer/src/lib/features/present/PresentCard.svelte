<script lang="ts">
  import { PRESENT_DATA_SCHEMAS, presentCardSchema, type PresentKind } from '@kepcup/shared';
  import { ChartColumn } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import {
    barRects,
    categoryX,
    formatNumber,
    niceTicks,
    pieArcs,
    seriesColor,
    yScale,
    type Plot,
  } from './present-geometry';

  /**
   * 声明式展示卡（D87 P4 L1，设计 32 §12.1）：Bot 只给数据，这里用宿主自己的组件渲染——没有代码
   * 执行面，也不需要按版本确认。数据在渲染前再按 kind 的 schema 校验一次（库里的卡片也可能被外力
   * 改坏），不合格显示「数据已损坏」。图表是自己画的 SVG（零依赖，颜色跟随主题），每个图都有文字
   * 版摘要给读屏。
   */
  let { card: raw }: { card: unknown } = $props();

  const card = $derived(presentCardSchema.safeParse(raw));
  const kind = $derived<PresentKind | null>(card.success ? card.data.kind : null);
  const data = $derived.by(() => {
    if (!card.success) return null;
    const parsed = PRESENT_DATA_SCHEMAS[card.data.kind].safeParse(card.data.data);
    return parsed.success ? (parsed.data as Record<string, unknown>) : null;
  });

  const STEP_LABEL = {
    done: 'present.step.done',
    current: 'present.step.current',
    todo: 'present.step.todo',
  } as const;

  const CHART: Plot = { width: 560, height: 220, left: 44, right: 12, top: 12, bottom: 28 };

  interface SeriesData {
    categories: string[];
    series: Array<{ name: string; values: number[] }>;
    unit?: string;
  }

  function chartModel(d: SeriesData) {
    const all = d.series.flatMap((s) => s.values);
    const ticks = niceTicks(Math.min(...all, 0), Math.max(...all, 0));
    return { ticks, y: yScale(CHART, ticks) };
  }

  function describeSeries(d: SeriesData): string {
    return d.series
      .map(
        (s) =>
          `${s.name}：${d.categories.map((c, i) => `${c} ${formatNumber(s.values[i] ?? NaN, d.unit ?? '')}`).join('，')}`,
      )
      .join('；');
  }

  function cellText(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'boolean') return value ? '✓' : '✗';
    return String(value);
  }
</script>

{#snippet seriesChart(d: SeriesData, mode: 'bar' | 'line')}
  {@const model = chartModel(d)}
  <svg
    viewBox={`0 0 ${CHART.width} ${CHART.height}`}
    class="h-auto w-full"
    role="img"
    aria-label={describeSeries(d)}
    data-testid="present-chart"
  >
    {#each model.ticks as tick, index (index)}
      <line
        x1={CHART.left}
        x2={CHART.width - CHART.right}
        y1={model.y(tick)}
        y2={model.y(tick)}
        class="stroke-border"
        stroke-width="1"
      />
      <text
        x={CHART.left - 6}
        y={model.y(tick) + 4}
        text-anchor="end"
        class="fill-muted-foreground text-[10px]">{formatNumber(tick)}</text
      >
    {/each}
    {#if mode === 'bar'}
      {#each barRects( CHART, d.categories.length, d.series.map((s) => s.values), model.ticks ) as rect, i (i)}
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx="2"
          fill={seriesColor(rect.series)}
        >
          <title
            >{d.series[rect.series]?.name} · {d.categories[rect.category]}：{formatNumber(
              d.series[rect.series]?.values[rect.category] ?? NaN,
              d.unit ?? '',
            )}</title
          >
        </rect>
      {/each}
    {:else}
      {#each d.series as s, si (si)}
        <polyline
          fill="none"
          stroke={seriesColor(si)}
          stroke-width="2"
          points={s.values
            .map((v, i) => `${categoryX(CHART, d.categories.length, i)},${model.y(v)}`)
            .join(' ')}
        />
        {#each s.values as v, i (i)}
          <circle
            cx={categoryX(CHART, d.categories.length, i)}
            cy={model.y(v)}
            r="3"
            fill={seriesColor(si)}
          >
            <title>{s.name} · {d.categories[i]}：{formatNumber(v, d.unit ?? '')}</title>
          </circle>
        {/each}
      {/each}
    {/if}
    {#each d.categories as category, i (i)}
      {#if d.categories.length <= 24 || i % Math.ceil(d.categories.length / 24) === 0}
        <text
          x={categoryX(CHART, d.categories.length, i)}
          y={CHART.height - 8}
          text-anchor="middle"
          class="fill-muted-foreground text-[10px]">{category}</text
        >
      {/if}
    {/each}
  </svg>
  {#if d.series.length > 1}
    <div class="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
      {#each d.series as s, si (si)}
        <span class="inline-flex items-center gap-1"
          ><span class="inline-block size-2.5 rounded-sm" style:background={seriesColor(si)}
          ></span>{s.name}</span
        >
      {/each}
    </div>
  {/if}
{/snippet}

<div
  class="flex w-full max-w-[85%] flex-col gap-2 rounded-lg border bg-background/80 p-3 text-sm"
  data-testid="present-card"
  data-kind={kind ?? ''}
>
  <div class="flex items-center gap-2 text-xs text-muted-foreground">
    <ChartColumn class="size-3.5" aria-hidden="true" />
    <span class="min-w-0 truncate font-medium text-foreground" data-testid="present-title"
      >{card.success && card.data.title !== '' ? card.data.title : t('present.untitled')}</span
    >
  </div>

  {#if data === null || kind === null}
    <p class="text-xs text-muted-foreground" data-testid="present-invalid">
      {t('present.invalid')}
    </p>
  {:else if kind === 'table'}
    {@const d = data as { columns: string[]; rows: unknown[][] }}
    <div class="max-h-96 overflow-auto">
      <table class="w-full border-collapse text-xs" data-testid="present-table">
        <thead>
          <tr>
            {#each d.columns as column, i (i)}
              <th class="sticky top-0 border-b bg-background px-2 py-1 text-left font-medium"
                >{column}</th
              >
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each d.rows as row, r (r)}
            <tr class="even:bg-muted/40">
              {#each row as value, c (c)}
                <td
                  class="border-b px-2 py-1 {typeof value === 'number'
                    ? 'text-right tabular-nums'
                    : ''}">{cellText(value)}</td
                >
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else if kind === 'bar' || kind === 'line'}
    {@render seriesChart(data as unknown as SeriesData, kind)}
  {:else if kind === 'pie'}
    {@const d = data as { slices: Array<{ label: string; value: number }>; unit?: string }}
    {@const arcs = pieArcs(
      d.slices.map((s) => s.value),
      90,
      90,
      80,
    )}
    <div class="flex flex-wrap items-center gap-4">
      <svg
        viewBox="0 0 180 180"
        class="size-40 shrink-0"
        role="img"
        aria-label={d.slices
          .map((s) => `${s.label} ${formatNumber(s.value, d.unit ?? '')}`)
          .join('，')}
        data-testid="present-chart"
      >
        {#each arcs as arc, i (i)}
          {#if arc.path !== ''}
            <path d={arc.path} fill={seriesColor(i)}
              ><title
                >{d.slices[i]?.label}：{formatNumber(
                  d.slices[i]?.value ?? NaN,
                  d.unit ?? '',
                )}</title
              ></path
            >
          {/if}
        {/each}
      </svg>
      <ul class="space-y-1 text-xs">
        {#each d.slices as slice, i (i)}
          <li class="flex items-center gap-1.5">
            <span class="inline-block size-2.5 rounded-sm" style:background={seriesColor(i)}></span>
            <span>{slice.label}</span>
            <span class="text-muted-foreground"
              >{formatNumber(slice.value, d.unit ?? '')} · {formatNumber(
                Math.round((arcs[i]?.share ?? 0) * 1000) / 10,
                '%',
              )}</span
            >
          </li>
        {/each}
      </ul>
    </div>
  {:else if kind === 'kpi'}
    {@const d = data as {
      items: Array<{
        label: string;
        value: number | string;
        unit?: string;
        change?: number;
        note?: string;
      }>;
    }}
    <div
      class="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2"
      data-testid="present-kpi"
    >
      {#each d.items as item, i (i)}
        <div class="rounded-md border p-2">
          <div class="text-xs text-muted-foreground">{item.label}</div>
          <div class="text-lg font-semibold tabular-nums">
            {typeof item.value === 'number'
              ? formatNumber(item.value, item.unit ?? '')
              : `${item.value}${item.unit ?? ''}`}
          </div>
          {#if item.change !== undefined}
            <div class="text-xs {item.change >= 0 ? 'text-emerald-600' : 'text-red-600'}">
              {item.change >= 0 ? '▲' : '▼'}
              {formatNumber(Math.abs(item.change), '%')}
            </div>
          {/if}
          {#if item.note !== undefined}<div class="mt-0.5 text-[11px] text-muted-foreground">
              {item.note}
            </div>{/if}
        </div>
      {/each}
    </div>
  {:else if kind === 'steps'}
    {@const d = data as {
      steps: Array<{ title: string; detail?: string; status?: 'done' | 'current' | 'todo' }>;
    }}
    <ol class="space-y-1.5" data-testid="present-steps">
      {#each d.steps as step, i (i)}
        <li class="flex gap-2">
          <span
            class="flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] {step.status ===
            'done'
              ? 'border-emerald-500 text-emerald-600'
              : step.status === 'current'
                ? 'border-primary text-primary'
                : 'text-muted-foreground'}"
            aria-label={step.status !== undefined ? t(STEP_LABEL[step.status]) : undefined}
            >{step.status === 'done' ? '✓' : i + 1}</span
          >
          <div class="min-w-0">
            <div class={step.status === 'current' ? 'font-medium' : ''}>{step.title}</div>
            {#if step.detail !== undefined}<div class="text-xs text-muted-foreground">
                {step.detail}
              </div>{/if}
          </div>
        </li>
      {/each}
    </ol>
  {:else if kind === 'timeline'}
    {@const d = data as { events: Array<{ time: string; title: string; detail?: string }> }}
    <ol class="relative ml-1.5 space-y-2 border-l pl-3" data-testid="present-timeline">
      {#each d.events as event, i (i)}
        <li class="relative">
          <span class="absolute top-1.5 -left-[17px] size-2 rounded-full bg-primary"></span>
          <div class="text-xs text-muted-foreground">{event.time}</div>
          <div>{event.title}</div>
          {#if event.detail !== undefined}<div class="text-xs text-muted-foreground">
              {event.detail}
            </div>{/if}
        </li>
      {/each}
    </ol>
  {:else if kind === 'compare'}
    {@const d = data as {
      options: string[];
      criteria: Array<{ name: string; values: unknown[] }>;
      recommended?: string;
    }}
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-xs" data-testid="present-compare">
        <thead>
          <tr>
            <th class="border-b px-2 py-1 text-left font-medium"></th>
            {#each d.options as option, i (i)}
              <th
                class="border-b px-2 py-1 text-left font-medium {option === d.recommended
                  ? 'bg-primary/10 text-primary'
                  : ''}"
                >{option}{#if option === d.recommended}<span class="ml-1 text-[10px]"
                    >{t('present.recommended')}</span
                  >{/if}</th
              >
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each d.criteria as criterion, r (r)}
            <tr>
              <td class="border-b px-2 py-1 text-muted-foreground">{criterion.name}</td>
              {#each criterion.values as value, c (c)}
                <td
                  class="border-b px-2 py-1 {d.options[c] === d.recommended ? 'bg-primary/5' : ''}"
                  >{cellText(value)}</td
                >
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

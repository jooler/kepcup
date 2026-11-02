<script lang="ts">
  import type { UsageModelTotal } from '@kepcup/shared';
  import { i18n, t } from '$lib/i18n';
  import { pieArcs, seriesColor } from '$lib/features/present/present-geometry';
  import { donutSlices, formatCompact, formatFull, OTHER_MODEL_KEY } from './usage-format';

  /** 模型用量：所选范围的 Token 占比（Top 5 + 其它）。 */
  let { byModel }: { byModel: UsageModelTotal[] } = $props();

  const locale = $derived(i18n.locale);
  const slices = $derived(donutSlices(byModel));
  const total = $derived(slices.reduce((sum, slice) => sum + slice.value, 0));
  const arcs = $derived(
    pieArcs(
      slices.map((slice) => slice.value),
      100,
      100,
      82,
    ),
  );

  function labelOf(key: string, label: string): string {
    return key === OTHER_MODEL_KEY ? t('settings.usageOther') : label;
  }

  function percent(share: number): string {
    return `${Math.round(share * 100)}%`;
  }
</script>

<section class="rounded-lg border bg-card p-4" data-testid="usage-models">
  <div class="flex flex-wrap items-baseline gap-2">
    <h4 class="text-sm font-medium">{t('settings.usageModelUsage')}</h4>
    <p class="text-xs text-muted-foreground">{t('settings.usageModelUsageHint')}</p>
  </div>

  {#if slices.length === 0}
    <p class="py-10 text-center text-xs text-muted-foreground" data-testid="usage-models-empty">
      {t('settings.usageNoData')}
    </p>
  {:else}
    <div class="mt-4 flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <svg
        viewBox="0 0 200 200"
        class="size-40 shrink-0"
        role="img"
        aria-label={slices
          .map((slice) => `${labelOf(slice.key, slice.label)} ${percent(slice.share)}`)
          .join('，')}
      >
        {#each arcs as arc, index (index)}
          {#if arc.path}
            <path d={arc.path} fill={seriesColor(index)}>
              <title
                >{labelOf(slices[index]?.key ?? '', slices[index]?.label ?? '')} · {formatFull(
                  slices[index]?.value ?? 0,
                  locale,
                )} Token · {percent(slices[index]?.share ?? 0)}</title
              >
            </path>
          {/if}
        {/each}
        <circle cx="100" cy="100" r="54" fill="var(--card)" />
        <text x="100" y="96" text-anchor="middle" class="fill-foreground text-[18px] font-semibold"
          >{formatCompact(total, locale)}</text
        >
        <text x="100" y="114" text-anchor="middle" class="fill-muted-foreground text-[10px]"
          >Token</text
        >
      </svg>

      <ul class="min-w-0 flex-1 space-y-2.5" data-testid="usage-model-legend">
        {#each slices as slice, index (slice.key)}
          <li class="flex items-center gap-2 text-xs">
            <span class="size-2.5 shrink-0 rounded-full" style={`background:${seriesColor(index)}`}
            ></span>
            <span class="min-w-0 flex-1 truncate text-foreground/85"
              >{labelOf(slice.key, slice.label)}</span
            >
            <span class="shrink-0 text-muted-foreground tabular-nums"
              >{formatCompact(slice.value, locale)} Token</span
            >
            <span class="w-9 shrink-0 text-right font-medium tabular-nums"
              >{percent(slice.share)}</span
            >
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>

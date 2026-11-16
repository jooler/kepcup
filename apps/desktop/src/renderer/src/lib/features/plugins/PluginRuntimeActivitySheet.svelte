<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import { i18n, t } from '$lib/i18n';
  import { pluginRuntime } from './plugin-runtime.svelte';
  import { activityRows } from './plugin-runtime-view';

  /**
   * 插件活动抽屉（D125 P3，61 §6）：`plugins.runtime.list` 的最近调用环形历史
   * （每插件 ≤50 条，最新在前）——时间 / 契约.方法 / 时长 / 结果徽标 / 错误人话。
   * 取消记录单列「已取消」（core 在 AbortSignal 取消时写 errorCode CANCELLED）；
   * 插件 error.message 作为次级说明透传（截断 200 字，完整文本在 hover 提示里）。
   */
  let { open = $bindable(false), pluginId }: { open?: boolean; pluginId: string } = $props();

  const runtimeState = $derived(pluginRuntime.stateOf(pluginId));
  const rows = $derived(activityRows(runtimeState, i18n.locale));

  // 每次打开都重拉一次历史：事件只带状态，调用记录在 list 里（打开时补齐）。
  $effect(() => {
    if (open) void pluginRuntime.load(true);
  });

  function outcomeClass(outcome: 'ok' | 'failed' | 'cancelled'): string {
    if (outcome === 'ok') return 'text-emerald-700 dark:text-emerald-400';
    if (outcome === 'cancelled') return 'text-amber-700 dark:text-amber-400';
    return 'text-destructive';
  }
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    side="right"
    class="w-full sm:max-w-xl"
    data-testid="plugin-runtime-activity-sheet"
  >
    <Sheet.Header>
      <Sheet.Title>{t('plugins.runtime.activity.title')}</Sheet.Title>
      <Sheet.Description>{t('plugins.runtime.activity.hint')}</Sheet.Description>
    </Sheet.Header>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {#if rows.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="plugin-runtime-activity-empty">
          {t('plugins.runtime.activity.empty')}
        </p>
      {:else}
        <table class="w-full border-collapse text-xs" data-testid="plugin-runtime-activity-table">
          <thead>
            <tr class="border-b text-left text-muted-foreground">
              <th class="py-1.5 pe-2 font-medium">{t('plugins.runtime.activity.time')}</th>
              <th class="py-1.5 pe-2 font-medium">{t('plugins.runtime.activity.call')}</th>
              <th class="py-1.5 pe-2 font-medium">{t('plugins.runtime.activity.duration')}</th>
              <th class="py-1.5 pe-2 font-medium">{t('plugins.runtime.activity.result')}</th>
              <th class="py-1.5 font-medium">{t('plugins.runtime.activity.error')}</th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.key)}
              <tr
                class="border-b border-border/50 align-top"
                data-testid="plugin-runtime-activity-row"
                data-outcome={row.outcome}
                title={row.tooltip.length > 0 ? row.tooltip : undefined}
              >
                <td class="py-1.5 pe-2 whitespace-nowrap text-muted-foreground tabular-nums">
                  {row.time}
                </td>
                <td class="py-1.5 pe-2 font-mono text-[11px]">{row.call}</td>
                <td class="py-1.5 pe-2 whitespace-nowrap text-muted-foreground tabular-nums">
                  {row.duration}
                </td>
                <td class="py-1.5 pe-2 whitespace-nowrap">
                  <span class={outcomeClass(row.outcome)}>{t(row.outcomeKey)}</span>
                </td>
                <td class="py-1.5">
                  {#if row.error.length > 0}
                    <span class="block">{row.error}</span>
                  {/if}
                  {#if row.detail.length > 0}
                    <span class="block text-muted-foreground">{row.detail}</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

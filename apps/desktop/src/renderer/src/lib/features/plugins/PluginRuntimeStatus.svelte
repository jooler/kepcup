<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { cn } from '$lib/utils.js';
  import { pluginRuntime } from './plugin-runtime.svelte';
  import { runtimeBadge } from './plugin-runtime-view';
  import PluginRuntimeActivitySheet from './PluginRuntimeActivitySheet.svelte';

  /**
   * 执行型插件的状态徽标 + 活动入口（D125 P3，61 §6）：扩展中心插件卡与插件详情页
   * 头部共用。
   *
   * - 状态来自 `plugin.runtime` 事件 + `plugins.runtime.list` 初始快照（pluginRuntime
   *   store）；stopped 灰 / starting 黄脉冲 / ready 绿 / busy 绿「运行中」/ error 红。
   * - error 时显示最近错误 tooltip 与「重启运行时」（`plugins.runtime.restart`，成功后
   *   徽标随 list 刷新回 ready）。
   * - **非执行型插件（无 runtime 段）在运行时快照里没有行** → 整个组件不渲染任何
   *   东西（数据型插件卡零变化，验收第 4 条）。
   */
  let { pluginId, class: className = '' }: { pluginId: string; class?: string } = $props();

  const runtimeState = $derived(pluginRuntime.stateOf(pluginId));
  const badge = $derived(runtimeBadge(runtimeState));
  let sheetOpen = $state(false);
  let restarting = $state(false);

  async function restart(): Promise<void> {
    if (restarting) return;
    restarting = true;
    try {
      await pluginRuntime.restart(pluginId);
    } catch (error) {
      const reason =
        error instanceof Error && 'code' in error
          ? errorText((error as { code?: string }).code, error.message)
          : error instanceof Error
            ? error.message
            : String(error);
      toast.error(t('plugins.toast.failed', { reason }));
    } finally {
      restarting = false;
    }
  }
</script>

{#if badge !== null}
  <div
    class={cn('flex flex-wrap items-center gap-1.5', className)}
    data-testid={`plugin-runtime-${pluginId}`}
  >
    <span
      class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] {badge.textClass}"
      title={badge.tooltip.length > 0 ? badge.tooltip : undefined}
      data-testid={`plugin-runtime-status-${pluginId}`}
      data-status={badge.status}
    >
      <span class="size-1.5 rounded-full {badge.dotClass} {badge.pulse ? 'animate-pulse' : ''}"
      ></span>
      {t(badge.labelKey)}
    </span>
    {#if badge.status === 'error'}
      <Button
        size="sm"
        variant="outline"
        class="h-6 px-2 text-[11px]"
        disabled={restarting}
        onclick={() => void restart()}
        data-testid={`plugin-runtime-restart-${pluginId}`}
      >
        {t('plugins.runtime.restart')}
      </Button>
    {/if}
    <Button
      size="sm"
      variant="ghost"
      class="h-6 px-2 text-[11px] text-muted-foreground"
      onclick={() => (sheetOpen = true)}
      data-testid={`plugin-runtime-activity-${pluginId}`}
    >
      {t('plugins.runtime.activity')}
    </Button>
  </div>
  <PluginRuntimeActivitySheet bind:open={sheetOpen} {pluginId} />
{/if}

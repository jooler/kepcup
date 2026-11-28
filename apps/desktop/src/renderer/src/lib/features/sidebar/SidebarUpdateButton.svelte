<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle, Download } from '@lucide/svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { CircularProgress } from '$lib/components/ui/circular-progress';

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。downloading 相位起
   * 就渲染：按钮整体是一枚 CircularProgress——外环跟随下载 percent，等待
   * 排空 / 下载完成收满环（awaiting-user 转 destructive 配色），点击打开
   * 全局更新进度卡片（open 绑定 updateStore.progressOpen，卡片本体在 App
   * 壳层渲染——narrow 布局无侧栏时核心错误页的「检查更新」也能展开同一张
   * 卡）。awaiting-user：destructive 警示态；若安装瞬间探测到新执行会先
   * 降级 awaiting-user（BR-P13-005，绝不静默取消）。
   */
  const phase = $derived(updateStore.status.phase);
  const percent = $derived(updateStore.status.percent ?? 0);
  const awaitingUser = $derived(phase === 'awaiting-user');
  const downloading = $derived(phase === 'downloading');
  const waitingRuns = $derived(phase === 'waiting-runs');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  /** 外环进度：下载中跟随 percent，其余相位收满环（完成 / 待安装 / 警示）。 */
  const ringValue = $derived(downloading ? percent : 100);
  const visible = $derived(
    downloading || waitingRuns || phase === 'ready-to-install' || awaitingUser,
  );

  const buttonLabel = $derived(
    downloading || waitingRuns
      ? t('update.downloadingLabel', { percent: Math.round(downloading ? percent : 100) })
      : awaitingUser
        ? t('update.awaitingUser', { count: activeRuns })
        : t('update.applyNow'),
  );
</script>

{#if visible}
  <div class="relative flex shrink-0">
    <CircularProgress
      value={ringValue}
      size={40}
      strokeWidth={2.5}
      class="pointer-events-none absolute inset-0 z-20 {awaitingUser
        ? 'text-destructive'
        : 'text-blue-600'}"
    />
    <button
      type="button"
      class="app-no-drag z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center
        rounded-full text-white transition-colors
        {awaitingUser ? 'bg-destructive hover:bg-destructive/90' : 'bg-blue-600 hover:bg-blue-700'}"
      onclick={() => (updateStore.progressOpen = true)}
      aria-label={buttonLabel}
      title={buttonLabel}
      data-testid="sidebar-update-button"
      data-awaiting={awaitingUser ? 'true' : undefined}
      data-progress={downloading || waitingRuns
        ? String(Math.round(downloading ? percent : 100))
        : undefined}
    >
      {#if downloading}
        <Download class="size-5 animate-pulse" aria-hidden="true" />
      {:else}
        <ArrowUpCircle class="size-5" aria-hidden="true" />
      {/if}
    </button>
  </div>
{/if}

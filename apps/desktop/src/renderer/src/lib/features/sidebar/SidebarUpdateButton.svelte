<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle, Download } from '@lucide/svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { CircularProgress } from '$lib/components/ui/circular-progress';
  import UpdateProgressCard from './UpdateProgressCard.svelte';

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。downloading 相位起
   * 就渲染：按钮整体是一枚 CircularProgress——外环跟随下载 percent，等待
   * 排空 / 下载完成收满环（awaiting-user 转 destructive 配色），点击打开
   * 进度卡片（进度详情 + 「应用更新」/「取消更新」等动作）。卡片里的
   * 「应用更新」与确认后的「中断执行并更新」都直接走安装（oninstall）：弹
   * 框只有进度卡片这一层，不再叠加居中确认浮层（旧确认浮层已删——重启语义
   * 由按钮文案「重启并应用更新」与卡片文案直接表达；在途执行的破坏性中断
   * 仍在卡片内二次确认，BR-P13-005 红线不弱化）。awaiting-user：destructive
   * 警示态；若安装瞬间探测到新执行会先降级 awaiting-user（BR-P13-005，绝不
   * 静默取消）。
   *
   * 用 Dialog（Portal 到 body、固定居中）而不是贴着按钮的浮层：侧栏有
   * overflow 裁剪，气泡会被切边且与窄屏布局互相挤压。Esc / 点遮罩关闭由
   * bits-ui 的 Dialog 处理（document 上的 escape-layer，先于应用级 Esc 仲裁）。
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

  let progressOpen = $state(false);

  // 门控离开可展示相位（安装中 / 取消回 idle）→ 卡片随之收起。
  $effect(() => {
    if (!visible) progressOpen = false;
  });

  const buttonLabel = $derived(
    downloading || waitingRuns
      ? t('update.downloadingLabel', { percent: Math.round(downloading ? percent : 100) })
      : awaitingUser
        ? t('update.awaitingUser', { count: activeRuns })
        : t('update.applyNow'),
  );

  function keepWaitingFromCard(): void {
    progressOpen = false;
    void updateStore.keepWaiting();
  }

  /** 卡片确认后的安装（ready「应用更新」/ awaiting-user 确认中断）：收卡直装。 */
  function installFromCard(): void {
    progressOpen = false;
    void updateStore.applyWithFeedback();
  }

  function cancelDownloadFromCard(): void {
    // 真实取消由主进程 gate 相位守卫；回 idle 的 push 到达时按钮与卡片收起。
    void updateStore.cancelDownload();
  }
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
      onclick={() => (progressOpen = true)}
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

  <UpdateProgressCard
    bind:open={progressOpen}
    oninstall={installFromCard}
    oncancelwait={keepWaitingFromCard}
    oncancelDownload={cancelDownloadFromCard}
  />
{/if}

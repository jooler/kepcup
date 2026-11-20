<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle, Download } from '@lucide/svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import UpdateProgressCard from './UpdateProgressCard.svelte';
  import { ringGeometry } from './update-ring';

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。downloading 相位起
   * 就渲染：圆钮外圈 SVG 进度环跟随 percent，点击打开进度卡片（进度详情 +
   * 左下「取消更新」）。下载完成后的可安装相位点击同样开卡片，「应用更新」/
   * 「中断执行并更新」在卡片右下——点击后仍先弹居中确认对话框：重启会关闭
   * 应用、中断在途执行是破坏性动作，都不因误点直接发生（BR-P13-005 的
   * 语义原样保留）。awaiting-user：destructive 警示态；若安装瞬间探测到
   * 新执行会先降级 awaiting-user（BR-P13-005，绝不静默取消）。
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
  /** 按钮外环（viewBox 40，r=18）：下载中显示 percent，等待排空时收满环。 */
  const ring = $derived(ringGeometry(downloading ? percent : 100, 18));
  const visible = $derived(
    downloading || waitingRuns || phase === 'ready-to-install' || awaitingUser,
  );

  let progressOpen = $state(false);
  let confirming = $state(false);

  // 门控离开可展示相位（安装中 / 取消回 idle）→ 卡片与确认随之收起。
  $effect(() => {
    if (!visible) {
      progressOpen = false;
      confirming = false;
    } else if (phase !== 'ready-to-install' && phase !== 'awaiting-user') {
      confirming = false;
    }
  });

  const buttonLabel = $derived(
    downloading || waitingRuns
      ? t('update.downloadingLabel', { percent: Math.round(downloading ? percent : 100) })
      : awaitingUser
        ? t('update.awaitingUser', { count: activeRuns })
        : t('update.applyNow'),
  );

  function restartLater(): void {
    confirming = false;
  }

  function keepWaiting(): void {
    confirming = false;
    void updateStore.keepWaiting();
  }

  function installNow(): void {
    confirming = false;
    void updateStore.applyWithFeedback();
  }

  // 卡片回调：破坏性/重启动作先收卡片再进确认（避免两层 Dialog 叠加）。
  function applyFromCard(): void {
    progressOpen = false;
    confirming = true;
  }

  function interruptFromCard(): void {
    progressOpen = false;
    confirming = true;
  }

  function keepWaitingFromCard(): void {
    progressOpen = false;
    void updateStore.keepWaiting();
  }

  function cancelDownloadFromCard(): void {
    // 真实取消由主进程 gate 相位守卫；回 idle 的 push 到达时按钮与卡片收起。
    void updateStore.cancelDownload();
  }
</script>

{#if visible}
  <div class="relative flex shrink-0">
    {#if downloading || waitingRuns}
      <svg
        viewBox="0 0 40 40"
        class="pointer-events-none absolute inset-0 z-20 -rotate-90"
        aria-hidden="true"
      >
        <circle
          cx="20"
          cy="20"
          r="18"
          fill="none"
          stroke-width="2.5"
          stroke="currentColor"
          class="text-blue-600/20"
        />
        <circle
          cx="20"
          cy="20"
          r="18"
          fill="none"
          stroke-width="2.5"
          stroke="currentColor"
          stroke-linecap="round"
          stroke-dasharray={ring.circumference}
          style:stroke-dashoffset={ring.dashoffset}
          class="text-blue-600 transition-[stroke-dashoffset] duration-300 ease-out"
        />
      </svg>
    {/if}
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
      data-progress={downloading || waitingRuns ? String(Math.round(downloading ? percent : 100)) : undefined}
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
    onapply={applyFromCard}
    oncancelwait={keepWaitingFromCard}
    oninterrupt={interruptFromCard}
    oncancelDownload={cancelDownloadFromCard}
  />

  <Dialog bind:open={confirming}>
    <DialogContent class="max-w-sm" showCloseButton={false} data-testid="sidebar-update-confirm">
      <DialogHeader>
        <DialogTitle>
          {awaitingUser ? t('update.awaitingTitle') : t('update.readyTitle')}
        </DialogTitle>
        <DialogDescription>
          {#if awaitingUser}
            {t('update.awaitingUser', { count: activeRuns })}
          {:else}
            {t('update.readyToInstall', { version: updateStore.status.version ?? '' })}
          {/if}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        {#if awaitingUser}
          <Button
            variant="outline"
            size="sm"
            onclick={keepWaiting}
            data-testid="sidebar-update-keep-waiting"
          >
            {t('update.keepWaiting')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onclick={installNow}
            data-testid="sidebar-update-install-anyway"
          >
            {t('update.installAnyway')}
          </Button>
        {:else}
          <Button
            variant="outline"
            size="sm"
            onclick={restartLater}
            data-testid="sidebar-update-restart-later"
          >
            {t('update.restartLater')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onclick={installNow}
            data-testid="sidebar-update-install-now"
          >
            {t('update.applyNow')}
          </Button>
        {/if}
      </DialogFooter>
    </DialogContent>
  </Dialog>
{/if}

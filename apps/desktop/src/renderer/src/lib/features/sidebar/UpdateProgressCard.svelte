<script lang="ts">
  import { t } from '$lib/i18n';
  import { AlertTriangle, CheckCircle2, Download } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { CircularProgress } from '$lib/components/ui/circular-progress';
  import { updateStore } from '$lib/stores/update.svelte';

  /**
   * 更新进度卡片（点击侧栏更新按钮弹出，Portal 原因同按钮组件头注释）。四
   * 相位统一由这一张卡片承载：
   *
   * - downloading：顶部大圆环（CircularProgress）+ 中心百分比；左下「取消
   *   更新」——语义是取消本次下载并跳过该版本（不再自动下载；设置-通用里
   *   手动「检查更新」仍能查到并可手动下载，gate 持久化跳过集合，更新的
   *   版本自动恢复正常流程）。
   * - waiting-runs：下载已完成、在途执行排空中；等待文案（无动作按钮）。
   * - ready-to-install：右下「应用更新」——直接安装（oninstall），卡片就是
   *   唯一一层弹框；重启语义由按钮文案「重启并应用更新」与说明文字表达，
   *   不再叠加第二层居中确认浮层。
   * - awaiting-user：在途执行数 +「继续等待」（重臂排空轮询）+ 破坏性的
   *   「中断执行并更新」——点击后先在卡片内切到破坏性确认条（取消 / 继续等
   *   待 / 中断执行并更新，同设置页的确认框样式），确认才走 oninstall：
   *   单层弹框，但 BR-P13-005 的显式二次确认红线不弱化。
   *
   * 卡片开着时相位推进（下载完成 → ready）由 update:status 推送响应式切换，
   * 不需要重开。视觉跟随主题 token（text-primary / text-destructive /
   * muted-foreground）。
   */
  interface Props {
    /** 受控开关（父级 bind）。Esc / 点遮罩关闭由 Dialog 处理。 */
    open?: boolean;
    /** 确认后的安装入口：ready「应用更新」/ awaiting-user 确认中断后回调。 */
    oninstall: () => void;
    /** awaiting-user「继续等待」：重臂门控排空轮询。 */
    oncancelwait: () => void;
    /** downloading 左下「取消更新」：取消并跳过该版本。 */
    oncancelDownload: () => void;
  }
  let { open = $bindable(false), oninstall, oncancelwait, oncancelDownload }: Props = $props();

  const phase = $derived(updateStore.status.phase);
  const percent = $derived(updateStore.status.percent ?? 0);
  const version = $derived(updateStore.status.version ?? '');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  const downloading = $derived(phase === 'downloading');
  const waitingRuns = $derived(phase === 'waiting-runs');
  const ready = $derived(phase === 'ready-to-install');
  const awaitingUser = $derived(phase === 'awaiting-user');
  /** 大圆环：下载中显示 percent，完成态收满环。 */
  const ring = $derived(downloading ? percent : 100);

  /** awaiting-user 的破坏性确认（卡片内两段式，绝不静默中断在途执行）。 */
  let confirmInterrupt = $state(false);

  // 门控离开 awaiting-user（继续等待后排空 / 安装中）或卡片被关（Esc / 点
  // 遮罩）→ 确认条随之收起：重开卡片回到「继续等待 / 中断」两按钮态。
  $effect(() => {
    if (!awaitingUser || !open) confirmInterrupt = false;
  });
</script>

<Dialog bind:open={open}>
  <DialogContent class="max-w-sm" showCloseButton={false} data-testid="update-progress-card">
    <DialogHeader>
      <DialogTitle>{t('update.progressTitle')}</DialogTitle>
      <DialogDescription class="sr-only">{t('update.progressTitle')}</DialogDescription>
    </DialogHeader>

    <div class="flex flex-col items-center gap-3 py-2">
      <CircularProgress value={ring} size={144} strokeWidth={8} class="text-primary">
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          {#if downloading}
            <Download class="size-5 animate-pulse text-primary" aria-hidden="true" />
            <span
              class="mt-1 text-3xl font-semibold leading-none tabular-nums"
              data-testid="update-card-percent"
            >
              {Math.round(percent)}%
            </span>
            <span class="mt-1 text-xs text-muted-foreground">{t('update.cardDownloaded')}</span>
          {:else if awaitingUser}
            <AlertTriangle class="size-9 text-destructive" aria-hidden="true" />
          {:else}
            <CheckCircle2 class="size-9 text-primary" aria-hidden="true" />
          {/if}
        </div>
      </CircularProgress>

      {#if version !== ''}
        <div class="text-sm font-medium">{version}</div>
      {/if}
      <p class="max-w-64 text-center text-xs/relaxed text-muted-foreground">
        {#if downloading}
          {t('update.cardDownloading', { version })}
          <span class="mt-1 block">{t('update.cardCancelHint')}</span>
        {:else if waitingRuns}
          {t('update.cardWaiting', { version, count: activeRuns })}
        {:else if ready}
          {t('update.cardReady', { version })}
        {:else if awaitingUser}
          {t('update.awaitingUser', { count: activeRuns })}
        {/if}
      </p>
    </div>

    {#if phase !== 'installing'}
      <DialogFooter class="sm:justify-between gap-2">
        {#if downloading}
          <Button
            variant="outline"
            size="sm"
            onclick={oncancelDownload}
            title={t('update.cardCancelHint')}
            data-testid="update-card-cancel"
          >
            {t('update.cancelDownload')}
          </Button>
        {:else if ready}
          <div class="flex-1" aria-hidden="true"></div>
          <Button variant="default" size="sm" onclick={oninstall} data-testid="update-card-apply">
            {t('update.applyNow')}
          </Button>
        {:else if awaitingUser}
          {#if !confirmInterrupt}
            <Button
              variant="outline"
              size="sm"
              onclick={oncancelwait}
              data-testid="update-card-keep-waiting"
            >
              {t('update.keepWaiting')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onclick={() => (confirmInterrupt = true)}
              data-testid="update-card-interrupt"
            >
              {t('update.installAnyway')}
            </Button>
          {:else}
            <div
              class="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-md border border-destructive/40
                bg-destructive/5 p-2"
              role="alertdialog"
              aria-label={t('update.installAnyway')}
              data-testid="update-card-confirm-box"
            >
              <span class="min-w-0 flex-1 text-xs text-muted-foreground">
                {t('update.awaitingUser', { count: activeRuns })}
              </span>
              <div class="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => (confirmInterrupt = false)}
                  data-testid="update-card-confirm-cancel"
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={oncancelwait}
                  data-testid="update-card-confirm-keep-waiting"
                >
                  {t('update.keepWaiting')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onclick={oninstall}
                  data-testid="update-card-confirm-install"
                >
                  {t('update.installAnyway')}
                </Button>
              </div>
            </div>
          {/if}
        {/if}
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

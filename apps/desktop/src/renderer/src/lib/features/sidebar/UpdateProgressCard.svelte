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
  import { updateStore } from '$lib/stores/update.svelte';
  import { ringGeometry } from './update-ring';

  /**
   * 更新进度卡片（点击侧栏更新按钮弹出，Portal 原因同按钮组件头注释）。四
   * 相位统一由这一张卡片承载：
   *
   * - downloading：顶部大圆环 + 中心百分比；左下「取消更新」——语义是取消
   *   本次下载并跳过该版本（否则 24h 定时检查会把同一版本下回来，用户会
   *   觉得「取消没用」；gate 持久化跳过集合，更新的版本自动恢复正常流程）。
   * - waiting-runs：下载已完成、在途执行排空中；等待文案（无动作按钮）。
   * - ready-to-install：左下取消移除、右下出现「应用更新」——点击后仍由父
   *   级走一次居中确认（重启会关闭应用，不因误点直接重启；复用既有确认
   *   Dialog，改动最小且文案已备）。
   * - awaiting-user：在途执行数 +「继续等待」（重臂排空轮询）+ 破坏性的
   *   「中断执行并更新」——点击同样经父级的确认 Dialog，绝不弱化二次确认。
   *
   * 卡片开着时相位推进（下载完成 → ready）由 update:status 推送响应式切换，
   * 不需要重开。视觉跟随主题 token（text-primary / text-destructive /
   * muted-foreground），不引新依赖、不硬编码配色；弧段平移用 CSS transition
   * 抚平 percent 推送的抖动。
   */
  interface Props {
    /** 受控开关（父级 bind）。Esc / 点遮罩关闭由 Dialog 处理。 */
    open?: boolean;
    /** ready 相位右下「应用更新」：父级先收卡再走重启确认 Dialog。 */
    onapply: () => void;
    /** awaiting-user「继续等待」：重臂门控排空轮询。 */
    oncancelwait: () => void;
    /** awaiting-user「中断执行并更新」：父级走破坏性确认 Dialog。 */
    oninterrupt: () => void;
    /** downloading 左下「取消更新」：取消并跳过该版本。 */
    oncancelDownload: () => void;
  }
  let {
    open = $bindable(false),
    onapply,
    oncancelwait,
    oninterrupt,
    oncancelDownload,
  }: Props = $props();

  const phase = $derived(updateStore.status.phase);
  const percent = $derived(updateStore.status.percent ?? 0);
  const version = $derived(updateStore.status.version ?? '');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  const downloading = $derived(phase === 'downloading');
  const waitingRuns = $derived(phase === 'waiting-runs');
  const ready = $derived(phase === 'ready-to-install');
  const awaitingUser = $derived(phase === 'awaiting-user');
  /** 大圆环（viewBox 144）：下载中显示 percent，完成态收满环。 */
  const ring = $derived(ringGeometry(downloading ? percent : 100, 64));
</script>

<Dialog bind:open={open}>
  <DialogContent class="max-w-sm" showCloseButton={false} data-testid="update-progress-card">
    <DialogHeader>
      <DialogTitle>{t('update.progressTitle')}</DialogTitle>
      <DialogDescription class="sr-only">{t('update.progressTitle')}</DialogDescription>
    </DialogHeader>

    <div class="flex flex-col items-center gap-3 py-2">
      <div class="relative size-36" data-testid="update-card-ring">
        <svg viewBox="0 0 144 144" class="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle
            cx="72"
            cy="72"
            r="64"
            fill="none"
            stroke-width="8"
            stroke="currentColor"
            class="text-primary/15"
          />
          <circle
            cx="72"
            cy="72"
            r="64"
            fill="none"
            stroke-width="8"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-dasharray={ring.circumference}
            style:stroke-dashoffset={ring.dashoffset}
            class="text-primary transition-[stroke-dashoffset] duration-500 ease-out"
          />
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          {#if downloading}
            <Download class="size-5 animate-pulse text-primary" aria-hidden="true" />
            <span class="mt-1 text-3xl font-semibold leading-none tabular-nums" data-testid="update-card-percent">
              {Math.round(percent)}%
            </span>
            <span class="mt-1 text-xs text-muted-foreground">{t('update.cardDownloaded')}</span>
          {:else if awaitingUser}
            <AlertTriangle class="size-9 text-destructive" aria-hidden="true" />
          {:else}
            <CheckCircle2 class="size-9 text-primary" aria-hidden="true" />
          {/if}
        </div>
      </div>

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
          <Button variant="default" size="sm" onclick={onapply} data-testid="update-card-apply">
            {t('update.applyNow')}
          </Button>
        {:else if awaitingUser}
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
            onclick={oninterrupt}
            data-testid="update-card-interrupt"
          >
            {t('update.installAnyway')}
          </Button>
        {/if}
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

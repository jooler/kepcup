<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle } from '@lucide/svelte';
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

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。两个可安装相位点击
   * 都先弹居中确认对话框——重启会关闭应用，确认后才调 installNow（不因误点
   * 直接重启）。ready-to-install：普通蓝色圆钮，对话框只提醒「需要重启才能
   * 生效」；awaiting-user：destructive 警示态，对话框展示在途执行数，「中断
   * 执行并更新」须经用户二次确认，「继续等待」重臂门控的排空轮询
   * （BR-P13-002）；若安装瞬间探测到新执行会先降级 awaiting-user
   * （BR-P13-005，绝不静默取消）。
   *
   * 用 Dialog（Portal 到 body、固定居中）而不是贴着按钮的浮层：侧栏有
   * overflow 裁剪，气泡会被切边且与窄屏布局互相挤压。Esc / 点遮罩关闭由
   * bits-ui 的 Dialog 处理（document 上的 escape-layer，先于应用级 Esc 仲裁）。
   */
  const phase = $derived(updateStore.status.phase);
  const awaitingUser = $derived(phase === 'awaiting-user');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  let confirming = $state(false);

  // 门控离开可安装相位（安装中 / 排空回流）→ 确认对话框随之收起。
  $effect(() => {
    if (phase !== 'ready-to-install' && phase !== 'awaiting-user') confirming = false;
  });

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
</script>

{#if phase === 'ready-to-install' || awaitingUser}
  <div class="relative flex shrink-0">
    <button
      type="button"
      class="app-no-drag z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center
        rounded-full text-white transition-colors
        {awaitingUser ? 'bg-destructive hover:bg-destructive/90' : 'bg-blue-600 hover:bg-blue-700'}"
      onclick={() => (confirming = true)}
      aria-label={awaitingUser ? t('update.installAnyway') : t('update.applyNow')}
      title={awaitingUser ? t('update.awaitingUser', { count: activeRuns }) : t('update.applyNow')}
      data-testid="sidebar-update-button"
      data-awaiting={awaitingUser ? 'true' : undefined}
    >
      <ArrowUpCircle class="size-5" aria-hidden="true" />
    </button>
  </div>

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

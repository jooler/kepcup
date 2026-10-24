<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle } from '@lucide/svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { Button } from '$lib/components/ui/button';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。两个可安装相位点击
   * 都先弹确认浮层——重启会关闭应用，确认后才调 installNow（不因误点直接
   * 重启）。ready-to-install：普通蓝色圆钮，浮层只提醒「需要重启才能生效」；
   * awaiting-user：destructive 警示态，浮层展示在途执行数，「中断执行并更新」
   * 须经用户二次确认，「继续等待」重臂门控的排空轮询（BR-P13-002）；若安装
   * 瞬间探测到新执行会先降级 awaiting-user（BR-P13-005，绝不静默取消）。
   */
  const phase = $derived(updateStore.status.phase);
  const awaitingUser = $derived(phase === 'awaiting-user');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  let confirming = $state(false);

  // 门控离开可安装相位（安装中 / 排空回流）→ 确认浮层随之收起。
  $effect(() => {
    if (phase !== 'ready-to-install' && phase !== 'awaiting-user') confirming = false;
  });

  $effect(() => {
    if (!confirming) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.popover,
      onEscape: () => {
        confirming = false;
      },
    });
  });

  function onButtonClick(): void {
    confirming = !confirming;
  }

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
      onclick={onButtonClick}
      aria-label={awaitingUser ? t('update.installAnyway') : t('update.applyNow')}
      title={awaitingUser ? t('update.awaitingUser', { count: activeRuns }) : t('update.applyNow')}
      data-testid="sidebar-update-button"
      data-awaiting={awaitingUser ? 'true' : undefined}
    >
      <ArrowUpCircle class="size-5" aria-hidden="true" />
    </button>
    {#if confirming}
      <div
        class="absolute start-full top-1/2 z-50 ms-2 w-64 -translate-y-1/2 rounded-xl border
          {awaitingUser ? 'border-destructive/40' : ''} bg-popover p-3 shadow-xl"
        role="dialog"
        aria-label={awaitingUser ? t('update.installAnyway') : t('update.applyNow')}
        data-testid="sidebar-update-confirm"
      >
        <p class="text-xs text-muted-foreground">
          {#if awaitingUser}
            {t('update.awaitingUser', { count: activeRuns })}
          {:else}
            {t('update.readyToInstall', { version: updateStore.status.version ?? '' })}
          {/if}
        </p>
        <div class="mt-2 flex justify-end gap-2">
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
        </div>
      </div>
    {/if}
  </div>
{/if}

<script lang="ts">
  import { t } from '$lib/i18n';
  import { ArrowUpCircle } from '@lucide/svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { Button } from '$lib/components/ui/button';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';

  /**
   * 左栏圆形更新按钮（宽屏 footer 与图标模式两处复用）。ready-to-install：
   * 普通蓝色圆钮，点击直接应用——该相位门控已确认无在途执行，若安装瞬间
   * 探测到新执行会先降级 awaiting-user（BR-P13-005，绝不静默取消）。
   * awaiting-user：destructive 警示态，点击先弹确认浮层（展示在途执行数），
   * 「中断执行并更新」须经用户二次确认才调 installNow，「继续等待」重臂
   * 门控的排空轮询（BR-P13-002）。
   */
  const phase = $derived(updateStore.status.phase);
  const awaitingUser = $derived(phase === 'awaiting-user');
  const activeRuns = $derived(updateStore.status.activeRuns ?? 0);
  let confirming = $state(false);

  // 门控已离开 awaiting-user（排空成功 / 安装中）→ 确认浮层随之收起。
  $effect(() => {
    if (phase !== 'awaiting-user') confirming = false;
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
    if (awaitingUser) {
      confirming = !confirming;
      return;
    }
    void updateStore.applyWithFeedback();
  }

  function keepWaiting(): void {
    confirming = false;
    void updateStore.keepWaiting();
  }

  function installAnyway(): void {
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
          border-destructive/40 bg-popover p-3 shadow-xl"
        role="dialog"
        aria-label={t('update.installAnyway')}
        data-testid="sidebar-update-confirm"
      >
        <p class="text-xs text-muted-foreground">
          {t('update.awaitingUser', { count: activeRuns })}
        </p>
        <div class="mt-2 flex justify-end gap-2">
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
            onclick={installAnyway}
            data-testid="sidebar-update-install-anyway"
          >
            {t('update.installAnyway')}
          </Button>
        </div>
      </div>
    {/if}
  </div>
{/if}

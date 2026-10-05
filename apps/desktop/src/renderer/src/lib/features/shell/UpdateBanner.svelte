<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { updateStore } from '$lib/stores/update.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * P13 任务 2 更新提示（主界面横幅）. Renders only while an update flow is
   * visible to the user: downloading / waiting for runs / awaiting user
   * consent / ready to install. Checking, idle and error stay silent
   * (P13-A: failures are logged, never a modal). 「重启安装」与「中断执行并
   * 更新」都走 update.installNow()——门控在主进程（UpdateGate）：
   * 在途执行要么等待排空，要么只有用户在这个按钮上的显式确认才会被取消。
   * 「继续等待」(BR-P13-002) 走 update.keepWaiting() 重臂门控的排空轮询，
   * 不再只是隐藏按钮等待下一次推送。
   */
  const phase = $derived(updateStore.status.phase);
  const visible = $derived(
    phase === 'downloading' ||
      phase === 'waiting-runs' ||
      phase === 'awaiting-user' ||
      phase === 'ready-to-install' ||
      phase === 'installing',
  );

  /** awaiting-user: user chose to keep waiting (gate re-arms the drain poll). */
  let keepWaiting = $state(false);
  let acting = $state(false);

  function keepWaitingOff(): void {
    keepWaiting = true;
    void updateStore.keepWaiting();
  }

  async function install(): Promise<void> {
    acting = true;
    try {
      const result = await updateStore.installNow();
      if (!result.ok) {
        // 排空失败或取消失败：门控已回 idle 并给出原因（BR-P13-008：失败
        // 有 UI 出口——toast + 查看日志，不再只留 console）。
        toast.error(t('update.installFailed', { reason: result.message ?? '' }), {
          action: {
            label: t('update.viewLogs'),
            onClick: () => void window.kepcup.openLogsDir(),
          },
        });
      }
    } finally {
      acting = false;
    }
  }
</script>

{#if visible}
  <div
    class="flex items-center gap-3 border-b bg-blue-500/10 px-4 py-2 text-sm"
    data-testid="update-banner"
    data-phase={phase}
  >
    <span class="flex-1">
      {#if phase === 'downloading'}
        {t('update.downloading', { version: updateStore.status.version ?? '' })}
      {:else if phase === 'waiting-runs'}
        {t('update.waitingRuns', { count: updateStore.status.activeRuns ?? 0 })}
      {:else if phase === 'awaiting-user' && !keepWaiting}
        {t('update.awaitingUser')}
      {:else if phase === 'ready-to-install'}
        {t('update.downloaded', { version: updateStore.status.version ?? '' })}
        <span class="ml-2 text-xs text-muted-foreground">{t('update.installOnQuit')}</span>
      {:else if phase === 'installing'}
        {t('update.installing')}
      {:else}
        {t('update.waitingRuns', { count: updateStore.status.activeRuns ?? 0 })}
      {/if}
    </span>
    {#if phase === 'awaiting-user' && !keepWaiting}
      <Button size="sm" variant="outline" onclick={keepWaitingOff} data-testid="update-keep-waiting">
        {t('update.keepWaiting')}
      </Button>
      <Button size="sm" variant="destructive" disabled={acting} onclick={() => void install()} data-testid="update-install-anyway">
        {t('update.installAnyway')}
      </Button>
    {:else if phase === 'ready-to-install'}
      <!-- BR-P13-005：ready 相位的普通样式按钮永不静默取消执行——若门控
           探测到新启动的执行，会先转 awaiting-user（destructive 确认）。 -->
      <Button size="sm" disabled={acting} onclick={() => void install()} data-testid="update-restart">
        {t('update.restartToUpdate')}
      </Button>
    {/if}
  </div>
{/if}

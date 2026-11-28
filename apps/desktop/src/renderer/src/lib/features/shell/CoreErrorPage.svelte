<script lang="ts">
  import { CircleAlert } from '@lucide/svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { t } from '$lib/i18n';
  import { updateStore } from '$lib/stores/update.svelte';
  import { Button } from '$lib/components/ui/button';

  let {
    reason,
    hint,
    testid = 'core-error-page',
  }: { reason?: string; hint?: string; testid?: string } = $props();

  const logsPath = $derived(core.info?.dataDir ? `${core.info.dataDir}/logs` : '~/.kepcup/logs');
  /**
   * 核心以「数据库由更新版本写入」终局拒绝启动（core.status 带
   * DB_FROM_NEWER_VERSION 码）：出「版本过低」专用提示 + 检查更新入口，
   * 不再展示泛化启动失败的长 reason（细节在日志里）。手动检查查到更新后
   * autoOpenRequested 让全局进度卡片自动展开（下载 → 100% → 应用更新——
   * 核心终局失败时 update.activeRuns 放行空集，门控能正常走到 ready）。
   */
  const versionTooLow = $derived(core.coreStatus?.code === 'DB_FROM_NEWER_VERSION');
  const checking = $derived(updateStore.status.phase === 'checking');

  function checkForUpdate(): void {
    updateStore.autoOpenRequested = true;
    void updateStore.checkInteractive();
  }
</script>

<div
  class="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center"
  data-testid={testid}
>
  <CircleAlert class="size-10 text-destructive" aria-hidden="true" />
  {#if versionTooLow}
    <h1 class="max-w-md text-lg font-semibold" data-testid="core-error-version-title">
      {t('shell.versionTooLowTitle')}
    </h1>
    <p class="max-w-md text-sm text-muted-foreground" data-testid="core-error-version-hint">
      {t('shell.versionTooLowHint')}
    </p>
    <Button
      size="sm"
      variant="outline"
      disabled={checking}
      onclick={checkForUpdate}
      data-testid="core-error-check-update"
    >
      {checking ? t('update.checking') : t('update.checkNow')}
    </Button>
  {:else}
    <h1 class="text-lg font-semibold">{t('shell.coreFailed')}</h1>
    <p class="max-w-md text-sm text-muted-foreground">{hint ?? t('shell.coreFailedHint')}</p>
    {#if reason}
      <p class="max-w-md text-sm text-destructive" data-testid="core-error-reason">{reason}</p>
    {/if}
  {/if}
  <p class="font-mono text-xs text-muted-foreground">{t('shell.logsHint', { path: logsPath })}</p>
</div>

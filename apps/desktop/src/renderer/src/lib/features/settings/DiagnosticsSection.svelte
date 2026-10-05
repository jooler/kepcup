<script lang="ts">
  import type { DiagnosticsOutput } from '@kepcup/shared';
  import { AppError } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * P13 任务 6 诊断（设置页「诊断」分区）: one aggregated snapshot — 核心服务
   * 状态、数据库（打开状态与迁移版本）、钥匙串/keystore、沙箱（后端与状态）、
   * 工具链（P06 doctor 数据源）、磁盘占用、日志目录（在文件管理器中打开）。
   * 诊断经 system 方法提供，locked/error 的核心也能给出状态行。
   */

  let diag = $state<DiagnosticsOutput | null>(null);
  let loading = $state(false);

  $effect(() => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    loading = true;
    try {
      diag = (await core.call('diagnostics.get')) as DiagnosticsOutput;
    } catch (error) {
      toast.error(
        t('diagnostics.refreshFailed', {
          reason: error instanceof AppError ? error.code : String((error as Error).message ?? ''),
        }),
      );
    } finally {
      loading = false;
    }
  }

  function sizeText(bytes: number | undefined): string {
    if (bytes === undefined || bytes <= 0) return '—';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
    if (bytes >= 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  function statusBadge(ok: boolean): { label: string; variant: 'default' | 'destructive' } {
    return ok ? { label: t('settings.sandboxAvailable'), variant: 'default' } : { label: t('settings.sandboxUnavailable'), variant: 'destructive' };
  }
</script>

<section class="space-y-3" data-testid="settings-diagnostics">
  <div class="flex items-center justify-between">
    <h3 class="text-sm font-medium">{t('diagnostics.title')}</h3>
    <Button size="sm" variant="outline" disabled={loading} onclick={() => void refresh()} data-testid="diagnostics-refresh">
      {t('diagnostics.refresh')}
    </Button>
  </div>

  {#if diag !== null}
    <dl class="grid gap-2 text-sm" data-testid="diagnostics-rows">
      <div class="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="diagnostics-core">
        <dt class="w-32 shrink-0 text-muted-foreground">{t('diagnostics.core')}</dt>
        <dd class="flex flex-wrap items-center gap-2">
          <Badge variant={diag.core.status === 'ready' ? 'default' : 'destructive'}>{diag.core.status}</Badge>
          <span class="text-xs text-muted-foreground">{t('diagnostics.coreUptime', { sec: diag.core.uptimeSec })}</span>
          {#if diag.core.statusReason}
            <span class="text-xs text-muted-foreground">{t('diagnostics.reason', { reason: diag.core.statusReason })}</span>
          {/if}
        </dd>
      </div>

      <div class="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="diagnostics-data-dir">
        <dt class="w-32 shrink-0 text-muted-foreground">{t('diagnostics.dataDir')}</dt>
        <dd class="min-w-0 flex-1 truncate font-mono text-xs">{diag.dataDir}</dd>
        <dd class="text-xs text-muted-foreground" data-testid="diagnostics-data-dir-size">
          {t('diagnostics.diskUsage')}: {sizeText(diag.dataDirBytes)}{#if diag.dataDirTruncated}
            <span class="text-amber-600">（{t('diagnostics.diskTruncated')}）</span>{/if}
        </dd>
      </div>

      <div class="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="diagnostics-logs-dir">
        <dt class="w-32 shrink-0 text-muted-foreground">{t('diagnostics.logsDir')}</dt>
        <dd class="min-w-0 flex-1 truncate font-mono text-xs">{diag.logsDir}</dd>
        <dd class="text-xs text-muted-foreground">
          {sizeText(diag.logsBytes)}{#if diag.logsTruncated}
            （{t('diagnostics.diskTruncated')}）{/if}
        </dd>
        <Button size="sm" variant="ghost" onclick={() => void window.kepcup.openLogsDir()} data-testid="diagnostics-logs-open">
          {t('diagnostics.logsOpen')}
        </Button>
      </div>

      <div class="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="diagnostics-keystore">
        <dt class="w-32 shrink-0 text-muted-foreground">{t('diagnostics.keystore')}</dt>
        <dd class="flex flex-wrap items-center gap-2">
          <Badge variant={diag.keystore.ok ? 'default' : 'destructive'} data-testid="diagnostics-keystore-state">
            {diag.keystore.ok ? t('diagnostics.keystoreOk') : t('diagnostics.keystoreFailed')}
          </Badge>
          <span class="text-xs text-muted-foreground">{diag.keystore.kind}</span>
          {#if diag.keystore.reason}
            <span class="text-xs text-muted-foreground">{t('diagnostics.reason', { reason: diag.keystore.reason })}</span>
          {/if}
        </dd>
      </div>

      <div class="rounded-md border px-3 py-2" data-testid="diagnostics-databases">
        <dt class="text-muted-foreground">{t('diagnostics.databases')}</dt>
        <dd class="mt-1 grid gap-1">
          {#each diag.databases as row (row.name)}
            <div class="flex flex-wrap items-center gap-2" data-testid={`diagnostics-db-${row.name.split('（')[0]?.replace('.', '-')}`}>
              <span class="font-mono text-xs">{row.name}</span>
              {#if row.open}
                <Badge variant="outline">{t('settings.sandboxAvailable')}</Badge>
                {#if row.version !== undefined && row.targetVersion !== undefined}
                  <span class="text-xs text-muted-foreground">
                    {t('diagnostics.dbVersion', { version: row.version, target: row.targetVersion })}
                  </span>
                {/if}
              {:else}
                <Badge variant="destructive">{t('diagnostics.dbClosed')}</Badge>
              {/if}
              {#if row.bytes !== undefined}
                <span class="text-xs text-muted-foreground">{sizeText(row.bytes)}</span>
              {/if}
              {#if row.detail}
                <span class="text-xs text-muted-foreground">{row.detail}</span>
              {/if}
            </div>
          {/each}
        </dd>
      </div>

      <div class="flex items-center gap-2 rounded-md border px-3 py-2" data-testid="diagnostics-sandbox">
        <dt class="w-32 shrink-0 text-muted-foreground">{t('diagnostics.sandbox')}</dt>
        <dd class="flex flex-wrap items-center gap-2">
          <span class="font-mono text-xs">{diag.sandbox.backend}</span>
          <Badge variant={statusBadge(diag.sandbox.available).variant}>{statusBadge(diag.sandbox.available).label}</Badge>
          {#if diag.sandbox.enhancedBackend !== null}
            <span class="text-xs text-muted-foreground">
              {t('diagnostics.sandboxEnhanced', { backend: diag.sandbox.enhancedBackend })}:
              {diag.sandbox.enhancedAvailable ? t('settings.sandboxEnhancedAvailable') : t('settings.sandboxEnhancedMissing')}
            </span>
          {/if}
          {#if diag.sandbox.reason && !diag.sandbox.available}
            <span class="text-xs text-muted-foreground">{t('diagnostics.reason', { reason: diag.sandbox.reason })}</span>
          {/if}
        </dd>
      </div>

      <div class="rounded-md border px-3 py-2" data-testid="diagnostics-toolchain">
        <dt class="text-muted-foreground">{t('diagnostics.toolchain')}</dt>
        <dd class="mt-1 grid gap-1">
          {#if diag.toolchain.length === 0}
            <span class="text-xs text-muted-foreground">{t('diagnostics.toolchainEmpty')}</span>
          {:else}
            {#each diag.toolchain as row (row.id)}
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs">{row.kind}</span>
                <Badge variant={row.healthy ? 'default' : 'destructive'}>{row.healthy ? t('diagnostics.keystoreOk') : t('settings.envStatusFailed')}</Badge>
                <span class="truncate text-xs text-muted-foreground">{row.detail}</span>
              </div>
            {/each}
          {/if}
        </dd>
      </div>
    </dl>
  {:else}
    <p class="text-sm text-muted-foreground">…</p>
  {/if}
</section>

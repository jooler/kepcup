<script lang="ts">
  import type { AppFlowLogEntry, McpServer } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { appDetailStore } from '$lib/stores/app-detail.svelte';
  import { customConnectionId } from '$lib/features/apps/connect-flow';
  import { Button } from '$lib/components/ui/button';

  /**
   * 开发者模式（D73 P2 §6.6）：自定义服务器的原始工具定义（含注解，JSON）、授权流程事件日志
   * （core 侧已脱敏：无令牌 / code / state，授权地址只有主机与路径）、手动刷新工具。
   * 刷新走工具锁定：新增 / 变化的工具回到待复核，不会绕过批准。
   */
  let { server }: { server: McpServer } = $props();

  let tools = $state<Array<Record<string, unknown>> | null>(null);
  let log = $state<AppFlowLogEntry[] | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function reason(cause: unknown): string {
    return String((cause as Error).message ?? cause);
  }

  async function loadTools(): Promise<void> {
    busy = true;
    error = null;
    try {
      tools = await settingsStore.rawMcpTools(server.id);
    } catch (cause) {
      error = t('settings.devModeLoadFailed', { reason: reason(cause) });
    } finally {
      busy = false;
    }
  }

  async function refresh(): Promise<void> {
    busy = true;
    error = null;
    try {
      tools = await settingsStore.refreshMcpTools(server.id);
      toast.success(t('settings.devModeRefreshed', { count: tools.length }));
      // 新增 / 变化的工具回到「待复核」：刷新设置页的待批准数。
      void appDetailStore.loadTools(customConnectionId(server.id)).catch(() => undefined);
    } catch (cause) {
      toast.error(t('settings.devModeRefreshFailed', { reason: reason(cause) }));
    } finally {
      busy = false;
    }
  }

  async function loadLog(): Promise<void> {
    try {
      log = await settingsStore.flowLog(server.id);
    } catch (cause) {
      error = t('settings.devModeLoadFailed', { reason: reason(cause) });
    }
  }

  function formatTime(at: number): string {
    return new Date(at).toLocaleTimeString();
  }

  function describe(entry: AppFlowLogEntry): string {
    const parts = [entry.phase];
    if (entry.clientSource !== undefined) parts.push(entry.clientSource);
    if (entry.authorizationUrl !== undefined) parts.push(entry.authorizationUrl);
    else if (entry.authorizationHost !== undefined) parts.push(entry.authorizationHost);
    if (entry.errorCode !== undefined) {
      parts.push(`${entry.errorCode}${entry.errorMessage ? `: ${entry.errorMessage}` : ''}`);
    }
    return parts.join('  ');
  }

  $effect(() => {
    void loadLog();
  });
</script>

<div class="space-y-3 border-t pt-2.5" data-testid={`mcp-devtools-${server.id}`}>
  <div class="space-y-1.5">
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-xs font-medium">{t('settings.devModeToolsTitle')}</p>
      <div class="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onclick={() => void loadTools()}
          data-testid={`mcp-dev-raw-${server.id}`}
        >
          {t('settings.devModeLoadTools')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onclick={() => void refresh()}
          data-testid={`mcp-dev-refresh-${server.id}`}
        >
          {busy ? t('settings.devModeRefreshing') : t('settings.devModeRefresh')}
        </Button>
      </div>
    </div>
    {#if tools !== null}
      {#if tools.length === 0}
        <p class="text-xs text-muted-foreground">{t('settings.devModeToolsEmpty')}</p>
      {:else}
        <pre
          class="max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-snug"
          data-testid={`mcp-dev-tools-json-${server.id}`}>{JSON.stringify(tools, null, 2)}</pre>
      {/if}
    {/if}
    {#if error !== null}
      <p class="text-xs text-destructive">{error}</p>
    {/if}
  </div>

  {#if server.auth === 'oauth'}
    <div class="space-y-1.5">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-xs font-medium">{t('settings.devModeLogTitle')}</p>
        <Button
          size="sm"
          variant="ghost"
          class="ml-auto"
          onclick={() => void loadLog()}
          data-testid={`mcp-dev-log-reload-${server.id}`}
        >
          {t('settings.devModeLogReload')}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">{t('settings.devModeLogHint')}</p>
      {#if log === null || log.length === 0}
        <p class="text-xs text-muted-foreground">{t('settings.devModeLogEmpty')}</p>
      {:else}
        <ul
          class="max-h-48 space-y-0.5 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]"
          data-testid={`mcp-dev-log-${server.id}`}
        >
          {#each log as entry, index (index)}
            <li class="break-all">
              <span class="text-muted-foreground">{formatTime(entry.at)}</span>
              {describe(entry)}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

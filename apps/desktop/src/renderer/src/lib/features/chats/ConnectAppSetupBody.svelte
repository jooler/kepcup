<script lang="ts">
  import type { SetupRequirement } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';

  /**
   * 对话内「连接应用」卡（D73，docs/design/29-connected-apps.md §9）：MCP 工具
   * 调用遇到未连接 / 授权失效 / 需追加权限，run 失败并携带 `setup.kind ===
   * 'connect-app'` 时出现。内嵌设置页同一个 ConnectAppPanel；授权完成后走既有
   * 「收起 + runs.retry」路径（chat.continueAfterSetup）。授权流程**只在用户点
   * 「连接」后**才会打开浏览器——run 内部从不弹浏览器。
   */
  let { requirement }: { requirement: Extract<SetupRequirement, { kind: 'connect-app' }> } =
    $props();

  const REASON_KEYS: Record<typeof requirement.reason, MessageKey> = {
    not_connected: 'apps.setupReason.not_connected',
    expired: 'apps.setupReason.expired',
    scope: 'apps.setupReason.scope',
  };

  const name = $derived.by(() => {
    const target = requirement.target;
    if (target.kind === 'custom') {
      return (
        settingsStore.settings?.mcpServers.find((server) => server.id === target.serverId)?.name ??
        target.serverId
      );
    }
    return target.connectorId;
  });

  const connection = $derived(appsStore.connectionFor(requirement.target));
  // 追加授权：scope 取「已授予 ∪ 需追加」的完整集合。
  const scopes = $derived.by(() => {
    const extra = requirement.scopes ?? [];
    if (requirement.reason !== 'scope' || extra.length === 0) return undefined;
    return [...new Set([...(connection?.scopes ?? []), ...extra])];
  });

  let continued = false;
  function proceed(): void {
    if (continued) return;
    continued = true;
    void chat.continueAfterSetup();
  }

  // 新的 requirement（续跑后又一次失败）：允许再次自动续跑。
  $effect(() => {
    void requirement;
    continued = false;
  });
</script>

<div class="space-y-0.5 pr-6">
  <p class="text-sm font-medium" data-testid="setup-card-title">
    {t('apps.setupTitle', { name })}
  </p>
  <p class="text-xs text-muted-foreground">{t(REASON_KEYS[requirement.reason])}</p>
</div>
<ConnectAppPanel
  target={requirement.target}
  {scopes}
  {name}
  allowDisconnect={false}
  testid="setup-card-connect"
  onDone={proceed}
/>
{#if connection?.status === 'connected' && !appsStore.hasActiveFlow(requirement.target)}
  <!-- 已在别处连接好：手动继续 -->
  <div class="flex justify-end">
    <Button size="sm" onclick={proceed} data-testid="setup-card-connect-continue">
      {t('apps.setupConnectedContinue')}
    </Button>
  </div>
{/if}

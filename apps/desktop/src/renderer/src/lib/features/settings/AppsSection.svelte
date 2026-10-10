<script lang="ts">
  import { Blocks } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Button } from '$lib/components/ui/button';
  import AppConnectionsList from '$lib/features/apps/AppConnectionsList.svelte';
  import AppConnectionDetail from '$lib/features/apps/AppConnectionDetail.svelte';

  /**
   * 设置「应用」分区（D73 §5.9；扩展中心 X3 调整，决定 B）：只做**已连接账号的管理**——
   * 按应用分组的账号列表 → 详情（权限、逐工具策略、待复核 diff、重新授权、断开）。
   * 「发现与添加」统一到扩展中心的「连接」分组（顶部横条跳转，原「目录」页签已移除）；
   * 自定义 MCP 服务器 / 填 URL / BYO 客户端在「设置 → 开发者模式」分区。
   */

  /** 当前打开的连接详情。 */
  let detailConnectionId = $state<string | null>(null);

  $effect(() => {
    appsStore.start();
    contacts.start();
  });

  /** 去扩展中心「连接」分组添加应用：先收起设置弹框（两个弹框不叠放）。 */
  function openExtensionCenter(): void {
    shell.closeSettings();
    shell.openExtensionCenter('connections');
  }
</script>

<section class="space-y-4" data-testid="apps-section">
  <div
    class="flex items-center gap-3 rounded-xl border px-4 py-3"
    data-testid="apps-extension-center-pointer"
  >
    <Blocks class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <p class="min-w-0 flex-1 text-xs text-muted-foreground">{t('apps.pointer.text')}</p>
    <Button
      size="sm"
      variant="secondary"
      class="shrink-0"
      onclick={openExtensionCenter}
      data-testid="apps-open-extension-center"
    >
      {t('apps.pointer.open')}
    </Button>
  </div>

  <div data-settings-anchor="apps-connected">
    {#if detailConnectionId !== null}
      <AppConnectionDetail
        connectionId={detailConnectionId}
        onBack={() => (detailConnectionId = null)}
      />
    {:else}
      <AppConnectionsList
        onOpen={(id) => (detailConnectionId = id)}
        onGoCatalog={openExtensionCenter}
      />
    {/if}
  </div>
</section>

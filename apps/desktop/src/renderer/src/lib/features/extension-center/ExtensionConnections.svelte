<script lang="ts">
  import { ArrowLeft } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import AppCatalogGrid from '$lib/features/apps/AppCatalogGrid.svelte';
  import AppConnectionsList from '$lib/features/apps/AppConnectionsList.svelte';
  import AppConnectionDetail from '$lib/features/apps/AppConnectionDetail.svelte';
  import { manageTarget } from '$lib/features/apps/app-catalog';

  /**
   * 扩展中心 →「连接」分组（X2，设计 29 §16）：已适配（发行构建里=已放行）的预置连接应用
   * 卡片——一键连接 → 账号 → Bot 勾选；已连接的显示状态与账号数，点「管理」进该应用的
   * 账号详情（权限、逐工具策略、待复核 diff、重新授权、断开）。数据来自 `apps.catalog.list`
   * （发行门禁在 core 侧过滤，开发构建显示全部），连接面板复用设置「应用」的同一套组件。
   *
   * 这里**没有**「填一个 URL」的入口：条目不在目录里 = 当前不支持。自定义 / 手填客户端
   * 在「设置 → 开发者模式」里。
   */

  /** 正在管理的应用账号列表（多账号时的中间层）；null = 目录。 */
  let managingConnectorId = $state<string | null>(null);
  /** 账号详情。 */
  let detailConnectionId = $state<string | null>(null);

  $effect(() => {
    appsStore.start();
    contacts.start();
  });

  /** 点「管理」：只有一个账号直接进详情，多个账号先列出来。 */
  function manage(connectorId: string): void {
    const target = manageTarget(appsStore.connections, connectorId);
    if (target.kind === 'detail') {
      managingConnectorId = null;
      detailConnectionId = target.connectionId;
    } else if (target.kind === 'list') {
      managingConnectorId = connectorId;
      detailConnectionId = null;
    }
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-connections">
  {#if detailConnectionId !== null}
    <AppConnectionDetail
      connectionId={detailConnectionId}
      onBack={() => (detailConnectionId = null)}
    />
  {:else if managingConnectorId !== null}
    <div class="space-y-3">
      <Button
        size="sm"
        variant="ghost"
        class="-ml-2 gap-1"
        onclick={() => (managingConnectorId = null)}
        data-testid="extension-connections-back"
      >
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        {t('extensionCenter.connections.back')}
      </Button>
      <AppConnectionsList
        connectorId={managingConnectorId}
        onOpen={(id) => (detailConnectionId = id)}
        onGoCatalog={() => (managingConnectorId = null)}
      />
    </div>
  {:else}
    <AppCatalogGrid onManage={manage} />
  {/if}
</div>

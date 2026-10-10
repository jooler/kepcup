<script lang="ts">
  import { t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import AppCatalogGrid from '$lib/features/apps/AppCatalogGrid.svelte';
  import AppConnectionsList from '$lib/features/apps/AppConnectionsList.svelte';
  import AppConnectionDetail from '$lib/features/apps/AppConnectionDetail.svelte';
  import McpSection from './McpSection.svelte';
  import { APPS_TABS, appsTabForKey, type AppsTab } from './sections';

  /**
   * 设置「应用」分区（D73 §5.9）：三个页签——目录（连接新应用）、已连接（按应用分组
   * 的账号列表 → 详情）、自定义（原「MCP 服务器」section 原样并入）。初始页签由
   * shell（`openSettings('apps', …, tab)` / 别名 `mcp` → 自定义）决定。
   */
  let { initialTab = 'catalog' }: { initialTab?: AppsTab } = $props();

  /** 当前页签：随 shell 指定的初始页签复位，之后由用户点击切换。 */
  let tab = $derived<AppsTab>(initialTab);
  /** 「已连接」页签里打开的连接详情。 */
  let detailConnectionId = $state<string | null>(null);

  $effect(() => {
    appsStore.start();
    contacts.start();
  });

  const TAB_LABEL_KEYS = {
    catalog: 'apps.tabs.catalog',
    connected: 'apps.tabs.connected',
    custom: 'apps.tabs.custom',
  } as const;

  function select(next: AppsTab): void {
    tab = next;
    detailConnectionId = null;
  }

  let tablist = $state<HTMLDivElement | null>(null);

  /** WAI-ARIA tabs：左右方向键 / Home / End 切换页签并把焦点移到新页签上。 */
  function onTablistKeydown(event: KeyboardEvent): void {
    const next = appsTabForKey(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
    tablist?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
  }

  function tabId(item: AppsTab): string {
    return `apps-tab-${item}`;
  }

  function panelId(item: AppsTab): string {
    return `apps-tabpanel-${item}`;
  }
</script>

<section class="space-y-4" data-testid="apps-section">
  <div
    class="flex items-center gap-1 border-b"
    role="tablist"
    bind:this={tablist}
    data-testid="apps-tabs"
  >
    {#each APPS_TABS as item (item)}
      <button
        type="button"
        role="tab"
        id={tabId(item)}
        aria-selected={tab === item}
        aria-controls={panelId(item)}
        tabindex={tab === item ? 0 : -1}
        class="-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors {tab === item
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => select(item)}
        onkeydown={onTablistKeydown}
        data-testid={`apps-tab-${item}`}
      >
        {t(TAB_LABEL_KEYS[item])}
      </button>
    {/each}
  </div>

  <div role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)}>
    {#if tab === 'catalog'}
      <div data-settings-anchor="apps-catalog">
        <AppCatalogGrid />
      </div>
    {:else if tab === 'connected'}
      <div data-settings-anchor="apps-connected">
        {#if detailConnectionId !== null}
          <AppConnectionDetail
            connectionId={detailConnectionId}
            onBack={() => (detailConnectionId = null)}
          />
        {:else}
          <AppConnectionsList
            onOpen={(id) => (detailConnectionId = id)}
            onGoCatalog={() => select('catalog')}
          />
        {/if}
      </div>
    {:else}
      <div data-settings-anchor="mcp">
        <McpSection />
      </div>
    {/if}
  </div>
</section>

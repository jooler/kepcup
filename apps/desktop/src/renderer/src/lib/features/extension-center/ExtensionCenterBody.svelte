<script lang="ts">
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import { skillMarket } from './market.svelte';
  import ExtensionInstalled from './ExtensionInstalled.svelte';
  import ExtensionMarket from './ExtensionMarket.svelte';
  import ExtensionLocalCollab from './ExtensionLocalCollab.svelte';
  import { EXTENSION_CENTER_TABS, extensionTabForKey, type ExtensionCenterTab } from './tabs';

  /**
   * 扩展中心的分组 tab 条 + 内容（市场 / 已安装 / 本机应用协作）：
   * ExtensionCenterDialog（宽屏弹框）与窄屏「扩展」tab 页共用，当前分组都在 shell store 里，
   * 两边切换状态互通。卸载（弹框关闭 / 窄屏切走 tab）时复位 Skills 目录的搜索词——切
   * 分组不复发位，避免同一次浏览内闪现陈旧内容。
   *
   * 技能 / 连接 / MCP / 邮件不再是独立分组（D104）：四类内容由插件贡献、安装后自动
   * 归类，作为「已安装」列表顶部的筛选条件呈现；旧分组深链由 shell 映射到对应筛选。
   */

  const TAB_LABEL_KEYS = {
    market: 'extensionCenter.tabs.market',
    installed: 'extensionCenter.tabs.installed',
    localCollab: 'extensionCenter.tabs.localCollab',
  } as const;

  const tab = $derived(shell.extensionCenterTab);

  // unmount 复位（弹框关闭 / 窄屏扩展页切走）：effect 的 cleanup 在卸载时执行。
  $effect(() => {
    return () => skillMarket.reset();
  });

  let tablist = $state<HTMLDivElement | null>(null);

  function select(next: ExtensionCenterTab): void {
    shell.extensionCenterTab = next;
    if (next !== 'installed') shell.extensionCenterFilter = 'all';
  }

  function tabId(item: ExtensionCenterTab): string {
    return `extension-center-tab-${item}`;
  }

  function panelId(item: ExtensionCenterTab): string {
    return `extension-center-tabpanel-${item}`;
  }

  /** WAI-ARIA tabs：左右方向键 / Home / End 切换分组并把焦点移到新页签上。 */
  function onTablistKeydown(event: KeyboardEvent): void {
    const next = extensionTabForKey(tab, event.key);
    if (next === null) return;
    event.preventDefault();
    select(next);
    tablist?.querySelector<HTMLElement>(`#${tabId(next)}`)?.focus();
  }
</script>

<div
  class="flex shrink-0 items-center gap-1 overflow-x-auto border-b"
  role="tablist"
  bind:this={tablist}
  data-testid="extension-center-tabs"
>
  {#each EXTENSION_CENTER_TABS as item (item)}
    <button
      type="button"
      role="tab"
      id={tabId(item)}
      aria-selected={tab === item}
      aria-controls={panelId(item)}
      tabindex={tab === item ? 0 : -1}
      class="-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm whitespace-nowrap transition-colors {tab ===
      item
        ? 'border-foreground font-medium text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground'}"
      onclick={() => select(item)}
      onkeydown={onTablistKeydown}
      data-testid={`extension-center-tab-${item}`}
    >
      {t(TAB_LABEL_KEYS[item])}
    </button>
  {/each}
</div>

<div
  role="tabpanel"
  id={panelId(tab)}
  aria-labelledby={tabId(tab)}
  class="@container flex min-h-0 flex-1 flex-col"
>
  {#if tab === 'market'}
    <ExtensionMarket />
  {:else if tab === 'installed'}
    <ExtensionInstalled />
  {:else}
    <ExtensionLocalCollab />
  {/if}
</div>

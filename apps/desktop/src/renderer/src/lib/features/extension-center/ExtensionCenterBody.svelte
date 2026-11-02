<script lang="ts">
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import ExtensionInstalled from './ExtensionInstalled.svelte';
  import ExtensionMarket from './ExtensionMarket.svelte';
  import PluginsSection from '../settings/PluginsSection.svelte';
  import { EXTENSION_CENTER_TABS, extensionTabForKey, type ExtensionCenterTab } from './tabs';

  /**
   * 扩展中心的分组 tab 条 + 内容（市场 / 已安装 / 设置）：
   * 宽屏设置页（设置 → 扩展中心分类）与窄屏「扩展」tab 页共用，当前分组都在
   * shell store 里，两边切换状态互通。
   *
   * D105 P4：技能 / 连接 / MCP / 邮件由插件贡献、安装后自动归类，作为
   * 「已安装」列表顶部的筛选条件呈现；本机应用协作收编为已安装页的系统卡，旧
   * `localCollab` 深链由 shell 落到已安装页并滚动到该卡。旧技能目录死代码
   * （ExtensionSkills / skillMarket / skills.presets）已随本阶段删除。
   *
   * 「设置」页签：原设置「插件」分区（插件供应链与更新设置）并入扩展中心后的落点，
   * 渲染与设置分区同一份 PluginsSection。
   *
   * `bleed`：宽屏设置页用——外层不再给横向留白，扩展中心自己把滚动区铺满整行
   * （滚动条贴到应用右缘），留白改由各分组滚动容器内边距提供；窄屏「扩展」tab
   * 页由外层容器给留白，保持默认 false。
   */

  let { bleed = false }: { bleed?: boolean } = $props();

  const TAB_LABEL_KEYS = {
    market: 'extensionCenter.tabs.market',
    installed: 'extensionCenter.tabs.installed',
    settings: 'extensionCenter.tabs.settings',
  } as const;

  const tab = $derived(shell.extensionCenterTab);

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

<!-- 页签按钮的 -mb-px 让选中下划线压住分隔线，代价是内容比容器高 1px；
     overflow-x-auto 会把另一轴的 visible 计算成 auto，那 1px 就变成常驻的纵向
     滚动条。overflow-y-hidden 必须保留（裁掉的正是下划线外溢的那 1px）。 -->
<div
  class="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b {bleed
    ? 'px-6 pt-4 sm:px-16 sm:pt-6'
    : ''}"
  role="tablist"
  bind:this={tablist}
  data-testid="extension-center-tabs"
>
  {#each EXTENSION_CENTER_TABS as item (item)}
    <!-- 「设置」是管理动作、不是内容分组：ml-auto 推到行右端，与市场 / 已安装隔开
         （DOM 顺序不变，方向键仍按 market → installed → settings 循环）。 -->
    <button
      type="button"
      role="tab"
      id={tabId(item)}
      aria-selected={tab === item}
      aria-controls={panelId(item)}
      tabindex={tab === item ? 0 : -1}
      class="-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm whitespace-nowrap transition-colors
        {item === 'settings' ? 'ml-auto pl-4' : ''}
        {tab === item
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
    <ExtensionMarket {bleed} />
  {:else if tab === 'settings'}
    <!-- 与市场 / 已安装同构：内容自己滚动。宽屏设置页里扩展中心撑满剩余高度后
         在此收敛出内层滚动；高度不受限的嵌入场景（如窄屏设置详情页）自然撑开，
         由外层容器滚动。 -->
    <div
      class="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto pt-3 {bleed
        ? 'px-6 pb-4 sm:px-16 sm:pb-6'
        : 'pr-0.5 pb-4'}"
      data-testid="extension-center-settings"
    >
      <PluginsSection />
    </div>
  {:else}
    <ExtensionInstalled {bleed} />
  {/if}
</div>

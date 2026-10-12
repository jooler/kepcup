<script lang="ts">
  import { shell } from '$lib/stores/shell.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import AppSidebar from '$lib/features/sidebar/AppSidebar.svelte';
  import ChatsArea from '$lib/features/chats/ChatsArea.svelte';
  import NoModelBanner from '$lib/features/onboarding/NoModelBanner.svelte';
  import NarrowTabBar from './NarrowTabBar.svelte';
  import NarrowContactsPage from './NarrowContactsPage.svelte';
  import NarrowExtensionsPage from './NarrowExtensionsPage.svelte';
  import NarrowMePage from './NarrowMePage.svelte';
  import { narrowLayout } from './narrow-layout.svelte';
  import { showNarrowTabBar } from './narrow-layout';
  import { bindNarrowRouting } from './narrow-routing.svelte';

  /**
   * 窄屏外壳（33-narrow-layout，未来移动端的导航参考）：单栏一屏一页——底部
   * 全局 tab（对话 / 通讯录 / 扩展 / 我）为第一层；「对话」tab 内是两层（列表
   * → 会话详情），详情层隐藏 tab 栏、左上角返回（ChatView）；会话详情顶部药丸
   * 打开 Bot 详情覆盖层（宽屏右栏的 RightPanel 内容）。
   *
   * 页面复用：列表 = 宽屏左栏 AppSidebar（--sidebar-width 覆盖为全宽）、详情 =
   * ChatsArea、通讯录 / 我 = 设置弹框对应分区、扩展 = 扩展中心分组主体。
   * 全屏层（Bot 详情覆盖层 BotDetailOverlay、设置全屏页 NarrowSettings、搜索层
   * GlobalSearchDialog）都挂在 App 根、不在本组件内：App 把本组件所在容器置 inert，
   * 层开着时底层不可聚焦（Tab 不会跑到被盖住的按钮上）。
   *
   * Tooltip.Provider 在宽屏由 Sidebar.Provider 提供（sidebar-provider.svelte），
   * 窄屏不渲染它——消息行等处的 Tooltip.Root 需要这里补一个，否则取上下文
   * 直接抛错（Context "Tooltip.Provider" not found）。
   */
  const showTabBar = $derived(
    showNarrowTabBar(narrowLayout.tab, chat.currentId !== null, narrowLayout.botDetailOpen),
  );

  // 会话变化 → 对话 tab；扩展中心深链 → 扩展 tab。两条 effect 共享 tab，依赖细节与
  // 回归见 narrow-routing.svelte.ts。
  bindNarrowRouting({
    currentChat: () => chat.current,
    shell,
    layout: narrowLayout,
  });
</script>

<Tooltip.Provider delayDuration={0}>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="narrow-shell">
    {#if narrowLayout.tab === 'chats'}
      <NoModelBanner />
      {#if chat.currentId !== null}
        <!-- 会话详情层：显式铺不透明背景（macOS 毛玻璃只保留在列表页侧栏）。 -->
        <div class="flex min-h-0 flex-1 flex-col bg-background">
          <ChatsArea />
        </div>
      {:else}
        <!-- 会话列表：复用宽屏左栏组件，宽度变量覆盖为全宽（图标模式不适用）。 -->
        <Sidebar.Provider style="--sidebar-width: 100%" class="min-h-0 flex-1">
          <AppSidebar />
        </Sidebar.Provider>
      {/if}
    {:else if narrowLayout.tab === 'contacts'}
      <NarrowContactsPage />
    {:else if narrowLayout.tab === 'extensions'}
      <NarrowExtensionsPage />
    {:else}
      <NarrowMePage />
    {/if}

    {#if showTabBar}
      <NarrowTabBar />
    {/if}
  </div>
</Tooltip.Provider>

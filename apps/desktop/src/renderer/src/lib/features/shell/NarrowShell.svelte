<script lang="ts">
  import { shell } from '$lib/stores/shell.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import AppSidebar from '$lib/features/sidebar/AppSidebar.svelte';
  import ChatsArea from '$lib/features/chats/ChatsArea.svelte';
  import RightPanel from '$lib/features/right-panel/RightPanel.svelte';
  import NoModelBanner from '$lib/features/onboarding/NoModelBanner.svelte';
  import NarrowSettings from '$lib/features/settings/NarrowSettings.svelte';
  import NarrowTabBar from './NarrowTabBar.svelte';
  import NarrowContactsPage from './NarrowContactsPage.svelte';
  import NarrowExtensionsPage from './NarrowExtensionsPage.svelte';
  import NarrowMePage from './NarrowMePage.svelte';
  import { narrowLayout } from './narrow-layout.svelte';
  import { showNarrowTabBar } from './narrow-layout';

  /**
   * 窄屏外壳（33-narrow-layout，未来移动端的导航参考）：单栏一屏一页——底部
   * 全局 tab（对话 / 通讯录 / 扩展 / 我）为第一层；「对话」tab 内是两层（列表
   * → 会话详情），详情层隐藏 tab 栏、左上角返回（ChatView）；会话详情顶部药丸
   * 打开 Bot 详情覆盖层（宽屏右栏的 RightPanel 内容）。
   *
   * 页面复用：列表 = 宽屏左栏 AppSidebar（--sidebar-width 覆盖为全宽）、详情 =
   * ChatsArea、通讯录 / 我 = 设置弹框对应分区、扩展 = 扩展中心分组主体、设置 =
   * NarrowSettings 全屏页（宽屏的 SettingsDialog 不在窄屏使用）。
   *
   * Tooltip.Provider 在宽屏由 Sidebar.Provider 提供（sidebar-provider.svelte），
   * 窄屏不渲染它——消息行等处的 Tooltip.Root 需要这里补一个，否则取上下文
   * 直接抛错（Context "Tooltip.Provider" not found）。
   */
  const showTabBar = $derived(
    showNarrowTabBar(narrowLayout.tab, chat.currentId !== null, narrowLayout.botDetailOpen),
  );

  // 任意 tab 下打开了会话（通讯录「打开对话」、系统通知点击、记忆证据跳转…）
  // → 跳到对话 tab 呈现详情。依赖 chat.current 的引用：每次 select 都落新对象，
  // 重复打开同一会话也会触发；属性级更新（消息到达等）不触发。
  $effect(() => {
    if (chat.current === null) return;
    if (narrowLayout.tab !== 'chats') narrowLayout.selectTab('chats');
  });

  // 窄屏下扩展中心不再以弹框呈现：各处的 openExtensionCenter 深链（设置
  //「应用 → 去添加」、技能面板等）统一重路由到底部「扩展」tab。
  $effect(() => {
    if (!shell.extensionCenterOpen) return;
    shell.extensionCenterOpen = false;
    narrowLayout.selectTab('extensions');
  });

  // Escape 关 Bot 详情覆盖层；嵌套弹框（移除 Bot 确认等）开着时先归弹框。
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !narrowLayout.botDetailOpen) return;
    if (document.querySelector('[data-slot="dialog-overlay"]') !== null) return;
    narrowLayout.closeBotDetail();
  }
</script>

<svelte:window onkeydown={onKeydown} />

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

  {#if narrowLayout.botDetailOpen}
    <!-- Bot 详情覆盖层（宽屏右栏内容）：fixed 全屏盖住 tab 栏；RightPanel 内部按
         窄屏形态渲染（X 关覆盖层、macOS 让出红绿灯）。 -->
    <div class="fixed inset-0 z-40 bg-background" data-testid="narrow-bot-detail">
      <RightPanel />
    </div>
  {/if}

  <!-- 设置全屏页（修复 7）：分组列表 ↔ 分组详情，深链经 shell.openSettings 直达。
       z-50 盖过 Bot 覆盖层——右栏里的设置入口（如 AgentBadge）窄屏也落到这里。 -->
  <NarrowSettings />
</Tooltip.Provider>

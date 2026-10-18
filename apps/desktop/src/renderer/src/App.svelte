<script lang="ts">
  import { untrack } from 'svelte';
  import { Toaster } from 'svelte-sonner';
  import { ModeWatcher, userPrefersMode } from 'mode-watcher';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { episodes } from '$lib/stores/episodes.svelte';
  import { workdirs } from '$lib/stores/workdirs.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { appNotices } from '$lib/stores/app-notices.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import AppSidebar from '$lib/features/sidebar/AppSidebar.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import ReconnectBanner from '$lib/features/shell/ReconnectBanner.svelte';
  import LockedPage from '$lib/features/shell/LockedPage.svelte';
  import CoreErrorPage from '$lib/features/shell/CoreErrorPage.svelte';
  import NarrowShell from '$lib/features/shell/NarrowShell.svelte';
  import BotDetailOverlay from '$lib/features/shell/BotDetailOverlay.svelte';
  import NarrowSettings from '$lib/features/settings/NarrowSettings.svelte';
  import GlobalSearchDialog from '$lib/features/search/GlobalSearchDialog.svelte';
  import MissingSkillDialog from '$lib/features/right-panel/MissingSkillDialog.svelte';
  import WorkbenchNudge from '$lib/features/workbench/WorkbenchNudge.svelte';
  import SidebarDialogs from '$lib/features/sidebar/SidebarDialogs.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import ChatsArea from '$lib/features/chats/ChatsArea.svelte';
  import WorkbenchView from '$lib/features/workbench/WorkbenchView.svelte';
  import { composerDrafts } from '$lib/features/chats/composer-drafts.svelte';
  import { stickies } from '$lib/features/chats/stickies.svelte';
  import SettingsDialog from '$lib/features/settings/SettingsDialog.svelte';
  import PlaceholderPage from '$lib/features/shell/PlaceholderPage.svelte';
  import CoreStatusBar from '$lib/features/shell/CoreStatusBar.svelte';
  import UpdateBanner from '$lib/features/shell/UpdateBanner.svelte';
  import UnattendedBanner from '$lib/features/approvals/UnattendedBanner.svelte';
  import SandboxSetupPrompt from '$lib/features/settings/SandboxSetupPrompt.svelte';
  import SandboxWizard from '$lib/features/settings/SandboxWizard.svelte';
  import OnboardingWizard from '$lib/features/onboarding/OnboardingWizard.svelte';
  import NoModelBanner from '$lib/features/onboarding/NoModelBanner.svelte';
  import { mountWindowDragBand } from '$lib/features/shell/window-drag-band';
  import { mountImeEnterGuard } from '$lib/features/shell/ime-enter-guard';
  import {
    hasOpenModal,
    isSearchShortcut,
    resolveSearchShortcut,
  } from '$lib/features/shell/global-shortcuts';
  import * as Sidebar from '$lib/components/ui/sidebar';

  // 全局弹层拖拽带：任何全屏浮层打开时窗口仍可从顶部拖动（模块头注释）。
  $effect(() => mountWindowDragBand());

  // IME 回车守卫：拼音等输入法在候选浮窗里按 Enter 是选词确认，不是业务确认；
  // 全局捕获阶段截停，避免各输入框的 `key === 'Enter'` 确认逻辑误触发（模块头注释）。
  $effect(() => mountImeEnterGuard());

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void core.start();
    updateStore.start();
    appNotices.start();
    // 通知点击 → 打开对应对话（主进程经 ipc 转发）。
    window.kepcup.onNavigateConversation((conversationId) => {
      void chat.select(conversationId);
    });
  });

  // 窄屏宽度监听：svelte:window bind:innerWidth 随窗口拉伸即时回填（拖拽中
  // 逐帧触发），narrow 抽值带滞回（640 进入 / 680 退出，narrow-layout.ts）切换
  // 宽/窄布局形态（narrow-layout.svelte.ts）。
  //
  // 宽 / 窄切换时：设置类浮层状态统一复位（宽屏 SettingsDialog 与窄屏 NarrowSettings 是两套
  // 互不相通的状态，shell.resetForLayoutChange）；窄屏拉回宽屏时，窄屏「返回列表」
  // （chat.leaveCurrent）留下的空选中恢复到上次查看的会话（宽屏没有「列表层」，右侧聊天区
  // 不该是空的）。Bot 详情覆盖层由 BotDetailOverlay 按「是否仍需要覆盖层」自行收放。
  // 首次运行只记录形态，不当作切换（启动恢复归 bootstrap）。
  let previousNarrow: boolean | null = null;
  $effect(() => {
    const narrow = narrowLayout.narrow;
    const previous = previousNarrow;
    previousNarrow = narrow;
    if (previous === null || previous === narrow) return;
    untrack(() => {
      shell.resetForLayoutChange();
      if (previous && !narrow && coreReady && chat.currentId === null) void chat.restoreLast();
    });
  });

  const coreReady = $derived(core.coreStatus?.status === 'ready');

  // 窄屏全屏层（Bot 详情覆盖层 / 设置页 / 搜索层）开着时，其下的主布局不可聚焦（inert）：
  // 这些自绘 fixed 层没有 bits-ui 弹框的焦点约束，Tab 会跑到被盖住的按钮上。层本身挂在
  // 主布局容器之外（下面的兄弟节点），不受 inert 影响。宽屏的搜索弹框是 bits-ui 模态，自带约束。
  const layerCoversMain = $derived(
    narrowLayout.botDetailOpen ||
      shell.narrowSettingsOpen ||
      (narrowLayout.narrow && shell.searchOpen),
  );

  // Cmd/Ctrl+K 打开全局搜索：挂在这里而不是 AppSidebar——窄屏的会话详情 / 其它 tab 里
  // AppSidebar 并未挂载。先判定能不能开（global-shortcuts.ts：核心未就绪、设置页 /
  // 向导 / 已有任何模态时不叠层），能开才 preventDefault；否则不吞事件。
  function onGlobalKeydown(event: KeyboardEvent): void {
    if (!isSearchShortcut(event)) return;
    const action = resolveSearchShortcut({
      coreReady,
      searchOpen: shell.searchOpen,
      onboardingOpen: onboarding.open,
      settingsOpen: shell.settingsOpen,
      narrowSettingsOpen: shell.narrowSettingsOpen,
      modalOpen: hasOpenModal(document),
    });
    if (action !== 'open') return;
    event.preventDefault();
    shell.openSearch();
  }

  // macOS 毛玻璃材质跟随应用主题（preload setNativeThemeSource → 主进程
  // nativeTheme.themeSource）：应用内选了亮/暗时侧栏的原生模糊同步换挡，
  // 「跟随系统」则透传 system，不产生自反馈。
  $effect(() => {
    void window.kepcup.setNativeThemeSource(userPrefersMode.current);
  });

  // Load app data once the core reports ready (and after reconnects).
  let loaded = $state(false);
  $effect(() => {
    if (!coreReady || loaded) return;
    loaded = true;
    chat.start();
    // 输入框草稿缓存的事件接线（conversation.deleted → 丢弃该会话的缓存条目）。
    composerDrafts.start();
    // 便签：事件接线（conversation.deleted → 修剪本地缓存）+ 恢复已钉便签。
    stickies.start();
    contacts.start();
    settingsStore.start();
    permissions.start();
    // 协作回合（暂停卡的 episode.updated 事件接线）。
    episodes.start();
    workdirs.start();
    environmentStore.start();
    void bootstrap();
  });

  /**
   * 初始加载 + 启动恢复：优先回到上次查看的会话（私聊或项目组，localStorage
   * 记忆，见 last-conversation-persist）；没有记忆/记忆失效则按最近消息挑
   * （从没聊过则打开第一个 Bot，初始化向导创建的即第一个）；一个 Bot 都
   * 没有（跳过了向导）时停在空态、右栏默认收起、左栏「+」面板自动下拉
   * 展开引导新建。
   */
  async function bootstrap(): Promise<void> {
    await Promise.all([
      chat.refresh(),
      contacts.refresh(),
      settingsStore.refresh(),
      permissions.refreshUnattended(),
      permissions.refreshSandbox(),
      workdirs.refresh(),
      stickies.load(),
    ]);
    const restored = await chat.restoreLast();
    if (restored === 'empty' && !onboarding.open) {
      // 名单复核：极端负载下 contacts.refresh 可能在第一个 Bot 创建前就返回
      // 过空名单（store 是旧的），restoreLast 因此误判 'empty'。拉起全屏引导
      // 面板前对 DB 再核一次（核不动=连接异常，同样不开），避免把刚建好
      // Bot 的用户挡在 backdrop 之后。
      let emptyConfirmed: boolean;
      try {
        const fresh = (await core.call('bots.list')) as { bots: Array<{ id: string }> };
        emptyConfirmed = fresh.bots.length === 0;
      } catch {
        emptyConfirmed = false;
      }
      if (emptyConfirmed) {
        // 跳过了初始化向导且没有 Bot：空态保持干净——右栏保持默认收起，
        //「+」面板下拉展开引导新建。
        shell.rightPanelCollapsed = true;
        shell.autoOpenStartPanel = true;
      }
    }
  }

  // P13 任务 4: the first-run wizard opens once, when the persisted onboarding
  // state says not completed and the platform allows it (e2e seam can hide it;
  // packaged builds always allow). Late settings loads are covered: the flag
  // flips only after settingsStore.settings arrives.
  let onboardingChecked = false;
  $effect(() => {
    if (onboardingChecked) return;
    if (!coreReady || settingsStore.settings === null) return;
    if (core.platform === null) return;
    onboardingChecked = true;
    if (core.platform.onboardingVisible && settingsStore.settings.onboarding.completed === false) {
      // 引导接管首启：不自动展开「+」面板（向导本身会创建第一个 Bot）。
      shell.autoOpenStartPanel = false;
      onboarding.show();
    }
  });
</script>

<ModeWatcher />
<svelte:window bind:innerWidth={narrowLayout.windowWidth} onkeydown={onGlobalKeydown} />
<div class="flex h-screen min-h-0 flex-col" data-testid="app-shell">
  {#if core.connection === 'reconnecting'}
    <ReconnectBanner />
  {/if}
  <UnattendedBanner />
  <UpdateBanner />

  <div class="flex min-h-0 flex-1" inert={layerCoversMain}>
    {#if core.connection === 'failed'}
      <CoreErrorPage />
    {:else if narrowLayout.narrow}
      <!-- 窄屏（33-narrow-layout）：手机式单栏 + 底部全局 tab；核心状态页全屏
           呈现（包 main 以铺不透明背景，macOS 毛玻璃下同宽屏）。 -->
      <main class="flex min-h-0 min-w-0 flex-1 flex-col">
        {#if core.coreStatus?.status === 'locked'}
          <LockedPage reason={core.coreStatus.reason} />
        {:else if !coreReady}
          <PlaceholderPage title={t('shell.coreStarting')} message="" testid="core-starting" />
        {:else}
          <NarrowShell />
        {/if}
      </main>
    {:else}
      <!-- 左栏宽度可拖拽调节：动态 --sidebar-width 经 style 覆盖套件默认值
           （provider 的 style 拼在默认声明之后，后写胜出）。 -->
      <Sidebar.Provider style={sidebarLayout.widthStyle}>
        <AppSidebar />
        <main class="flex min-h-0 min-w-0 flex-1 flex-col">
          {#if core.coreStatus?.status === 'locked'}
            <LockedPage reason={core.coreStatus.reason} />
          {:else if !coreReady}
            <PlaceholderPage title={t('shell.coreStarting')} message="" testid="core-starting" />
          {:else}
            <NoModelBanner />
            <!-- 宽屏主区二选一（D90）：工作台开着时对话区卸载；草稿在 composerDrafts 里，
                 回到对话（chat.select）后重新水合。 -->
            {#if shell.mainView === 'workbench'}
              <WorkbenchView />
            {:else}
              <ChatsArea />
            {/if}
          {/if}
        </main>
      </Sidebar.Provider>
    {/if}
  </div>

  <!-- 状态栏是开发/e2e 专用（连通性 ping 与 Node 版本），打包产物经 DCE 剔除。 -->
  {#if __KEPCUP_TEST_HOOKS__}
    <CoreStatusBar />
  {/if}

  <!-- 设置弹框（含通讯录分组），不再整页替换主区域 -->
  {#if coreReady}
    <SettingsDialog />
  {/if}

  <!-- 全屏层与全局弹框挂在 App 根（不依赖侧栏 / 外壳是否挂载，宽窄切换也不丢状态）：
       Bot 详情覆盖层（z-40）→ 窄屏设置页（z-50）→ 全局搜索（z-50）；侧栏触发的模态对话框；
       技能目录缺失提示（原挂在 AppSidebar，窄屏会话详情里侧栏不在，订阅与弹框都不存在）。 -->
  {#if coreReady}
    <BotDetailOverlay />
    {#if narrowLayout.narrow}
      <Tooltip.Provider delayDuration={0}>
        <NarrowSettings />
      </Tooltip.Provider>
    {/if}
    <GlobalSearchDialog bind:open={shell.searchOpen} />
    <SidebarDialogs />
    <MissingSkillDialog />
    <WorkbenchNudge />
  {/if}

  <!-- P12-B：沙箱准备向导（设置页/首启提示共用）与首次启动入口 -->
  {#if coreReady}
    <SandboxSetupPrompt />
  {/if}
  <SandboxWizard />

  <!-- P13 任务 4：首次启动引导 -->
  {#if onboarding.open}
    <OnboardingWizard />
  {/if}

  <!-- 窄屏 toast 改顶部居中（33-narrow-layout）：sonner 单条 toast 默认 356px 宽，
       bottom-right 在手机宽度窗口里会横贯整个底部 tab 栏。 -->
  <Toaster position={narrowLayout.narrow ? 'top-center' : 'bottom-right'} />
</div>

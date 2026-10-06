<script lang="ts">
  import { Toaster } from 'svelte-sonner';
  import { ModeWatcher, userPrefersMode } from 'mode-watcher';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { projects } from '$lib/stores/projects.svelte';
  import { updateStore } from '$lib/stores/update.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import AppSidebar from '$lib/features/sidebar/AppSidebar.svelte';
  import ReconnectBanner from '$lib/features/shell/ReconnectBanner.svelte';
  import LockedPage from '$lib/features/shell/LockedPage.svelte';
  import CoreErrorPage from '$lib/features/shell/CoreErrorPage.svelte';
  import ChatsArea from '$lib/features/chats/ChatsArea.svelte';
  import { composerDrafts } from '$lib/features/chats/composer-drafts.svelte';
  import SettingsDialog from '$lib/features/settings/SettingsDialog.svelte';
  import PlaceholderPage from '$lib/features/shell/PlaceholderPage.svelte';
  import CoreStatusBar from '$lib/features/shell/CoreStatusBar.svelte';
  import UpdateBanner from '$lib/features/shell/UpdateBanner.svelte';
  import UnattendedBanner from '$lib/features/approvals/UnattendedBanner.svelte';
  import SandboxSetupPrompt from '$lib/features/settings/SandboxSetupPrompt.svelte';
  import SandboxWizard from '$lib/features/settings/SandboxWizard.svelte';
  import OnboardingWizard from '$lib/features/onboarding/OnboardingWizard.svelte';
  import NoModelBanner from '$lib/features/onboarding/NoModelBanner.svelte';
  import * as Sidebar from '$lib/components/ui/sidebar';

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void core.start();
    updateStore.start();
    // 通知点击 → 打开对应对话（主进程经 ipc 转发）。
    window.kepcup.onNavigateConversation((conversationId) => {
      void chat.select(conversationId);
    });
  });

  const coreReady = $derived(core.coreStatus?.status === 'ready');

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
    contacts.start();
    settingsStore.start();
    permissions.start();
    projects.start();
    environmentStore.start();
    void bootstrap();
  });

  /**
   * 初始加载 + 启动恢复：直接激活上一次对话的 Bot（从没聊过则打开第一个
   * Bot，初始化向导创建的即第一个）；一个 Bot 都没有（跳过了向导）时停在
   * 空态、右栏默认收起、左栏「+」面板自动下拉展开引导新建。
   */
  async function bootstrap(): Promise<void> {
    await Promise.all([
      chat.refresh(),
      contacts.refresh(),
      settingsStore.refresh(),
      permissions.refreshUnattended(),
      permissions.refreshSandbox(),
      projects.refresh(),
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
<div class="flex h-screen min-h-0 flex-col" data-testid="app-shell">
  {#if core.connection === 'reconnecting'}
    <ReconnectBanner />
  {/if}
  <UnattendedBanner />
  <UpdateBanner />

  <div class="flex min-h-0 flex-1">
    {#if core.connection === 'failed'}
      <CoreErrorPage />
    {:else}
      <Sidebar.Provider>
        <AppSidebar />
        <main class="flex min-h-0 min-w-0 flex-1 flex-col">
          {#if core.coreStatus?.status === 'locked'}
            <LockedPage reason={core.coreStatus.reason} />
          {:else if !coreReady}
            <PlaceholderPage title={t('shell.coreStarting')} message="" testid="core-starting" />
          {:else}
            <NoModelBanner />
            <ChatsArea />
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

  <!-- P12-B：沙箱准备向导（设置页/首启提示共用）与首次启动入口 -->
  {#if coreReady}
    <SandboxSetupPrompt />
  {/if}
  <SandboxWizard />

  <!-- P13 任务 4：首次启动引导 -->
  {#if onboarding.open}
    <OnboardingWizard />
  {/if}

  <Toaster position="bottom-right" />
</div>

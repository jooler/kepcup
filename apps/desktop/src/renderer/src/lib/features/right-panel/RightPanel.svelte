<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { X, Monitor, Pencil, Info, Blocks, ListTodo, StickyNote } from '@lucide/svelte';
  import type { BotProfile } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { motionMs, MOTION } from '$lib/motion';
  import { toast } from 'svelte-sonner';
  import { shell } from '$lib/stores/shell.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import { sidebarLayout } from '$lib/features/sidebar/sidebar-layout.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { uploadedAvatarShapeClass } from '$lib/avatars/presets';
  import BotProfileForm from '$lib/features/bot-panel/BotProfileForm.svelte';
  import AgentBadge from '$lib/features/bot-panel/AgentBadge.svelte';
  import {
    BOT_CONFIG_ANCHOR_SECTIONS,
    BOT_CONFIG_SECTION_LABEL_KEYS,
    type BotConfigSection,
  } from '$lib/features/bot-panel/bot-config-sections';
  import BotMenu from './BotMenu.svelte';
  import BotWidgetsTab from './BotWidgetsTab.svelte';
  import BotTasksPanel from './BotTasksPanel.svelte';
  import NotesTab from './NotesTab.svelte';
  import DetailHeader from './DetailHeader.svelte';
  import { botTasks } from './bot-tasks.svelte';
  import { isActiveTask } from '$lib/features/tasks/task-view';
  import WorkdirSelector from '$lib/features/workdirs/WorkdirSelector.svelte';
  import MemoryTab from './MemoryTab.svelte';
  import SkillsTab from './SkillsTab.svelte';
  import {
    findNode,
    findParent,
    memoryNav,
    type MemoryCategoryNode,
  } from './memory-categories.svelte';
  import { skillNav } from './skills-nav.svelte';
  import WikiBrowser from '../wiki/WikiBrowser.svelte';
  import SchedulesPanel from './SchedulesPanel.svelte';
  import WatchesPanel from '$lib/features/watches/WatchesPanel.svelte';
  import AvatarPicker from './AvatarPicker.svelte';
  import EgressSummary from '$lib/features/bot-panel/EgressSummary.svelte';
  import ExportBotTemplateButton from '$lib/features/bot-template/ExportBotTemplateButton.svelte';
  import { showBrowser, closeBrowser, BROWSER_SHOW_BTN_CLASS } from './show-browser';
  import { browserPages } from '$lib/stores/browser-pages.svelte';
  import { deepEqual, isEngineOnlyChange, reconcileBotDraft } from './bot-draft';
  import { nextFrame, revealSettingsAnchor } from '$lib/features/settings/anchor-scroll';
  import { loadPanelTab, savePanelTab, type PanelTab } from './panel-tab-persist';

  const conversation = $derived(chat.current?.conversation ?? null);
  const bot = $derived(chat.current?.conversation.bot ?? null);
  /**
   * 头像按钮的形状跟随遮罩：只有「上传头像 + 圆角方」才变方，预置头像 / 首字母
   * 占位仍是圆，避免圆按钮里套方图（按钮本身、hover 蒙层、焦点环共用这一个类）。
   */
  const avatarShapeClass = $derived(uploadedAvatarShapeClass(bot?.avatar, bot?.avatarMask));
  browserPages.start();
  // 仅当该 Bot 在当前对话里已拉起浏览器页面时显示「查看浏览器」。
  const browserOpen = $derived(
    bot !== null && conversation !== null && browserPages.has(bot.id, conversation.id),
  );
  const grants = $derived(permissions.grants);
  const confirmMode = $derived(permissions.sandbox !== null && !permissions.sandbox.available);
  // 窄屏（33-narrow-layout），或宽屏但放不下并排右栏：本组件渲染为全屏 Bot 详情覆盖层
  // （BotDetailOverlay），无左边框、✕ 关闭的是覆盖层，头部让出 macOS 红绿灯占位。
  const narrow = $derived(sidebarLayout.panelAsOverlay);
  const isMac = /Mac/i.test(navigator.platform);

  // D116：任务 tab 的列表与「任务」tab 触发器的进行中徽标共用 botTasks；Bot
  // 变化即重载（面板的手动刷新与 store 的 task.updated 订阅维持新鲜）。
  const activeTaskCount = $derived(
    bot !== null && botTasks.botId === bot.id
      ? botTasks.items.filter((entry) => isActiveTask(entry)).length
      : 0,
  );
  $effect(() => {
    const current = bot;
    if (current !== null && current.status === 'active') void botTasks.load(current.id);
  });

  let draft = $state<BotProfile | null>(null);
  /**
   * D116 三 tab（docs/design/56 §2）+ 便签：头部资料卡下切换 详情（默认，原
   * 二级菜单）/ 组件（卡片直运行）/ 任务（每 Bot 任务列表）/ 便签（仅私聊）。
   * tab 条手写（不用 components/ui/tabs——bits-ui 输出 data-state 而样式变体
   * 在 data-active 上）。
   *
   * tab 按对话记忆：每个对话恢复自己上次停留的 tab（localStorage，见
   * panel-tab-persist.ts）；应用重启 / 面板重新挂载 / 切回对话都走同一条恢复。
   */
  const conversationId = $derived(conversation?.id ?? null);
  /** 该对话上次停留的 tab；没有记录或便签已不适用时回退详情。 */
  function storedTab(id: string | null, type: string | null): PanelTab {
    if (id === null) return 'detail';
    const stored = loadPanelTab(globalThis.localStorage ?? null, id);
    // 便签只在私聊提供：其它对话即使记住过便签也退回详情。
    if (stored === 'notes' && type !== 'direct') return 'detail';
    return stored ?? 'detail';
  }
  // 初始值只取一次（untrack）：挂载时的对话决定第一眼的 tab，之后的对话
  // 切换由下面的 effect 接续。
  const initialTab = untrack(() => storedTab(conversationId, conversation?.type ?? null));
  let tab = $state<PanelTab>(initialTab);
  /** 当前 tab 属于哪个对话；切对话时据此加载新对话的记录。 */
  let tabConversationId = $state<string | null>(untrack(() => conversationId));
  /**
   * 详情 tab 的统一下钻状态：null = 菜单首页；否则为下钻的详情——配置条目
   * （BotProfileForm section 模式）或原各 tab 的内容。深链锚点按
   * BOT_CONFIG_ANCHOR_SECTIONS 直达对应配置条目。组件 tab 无下钻（2026-11-06
   * 精简：metadata 上卡、菜单只留删除）。
   */
  type PanelDetail =
    | { kind: 'profile'; section: BotConfigSection }
    | { kind: 'memory' }
    | { kind: 'skills' }
    | { kind: 'wiki' }
    | { kind: 'access' }
    | { kind: 'schedules' }
    | { kind: 'watches' };
  let detail = $state<PanelDetail | null>(null);
  let workdirSelector = $state<WorkdirSelector | null>(null);
  /** tab 条的固定顺序（详情 / 组件 / 任务 / 便签）与图标。 */
  const PANEL_TABS: Array<{ id: PanelTab; icon: typeof Info }> = [
    { id: 'detail', icon: Info },
    { id: 'widgets', icon: Blocks },
    { id: 'tasks', icon: ListTodo },
    { id: 'notes', icon: StickyNote },
  ];

  /** 详情标题的文案键（返回头 + 深链共用）。 */
  const DETAIL_TITLE_KEYS: Record<Exclude<PanelDetail['kind'], 'profile'>, MessageKey> = {
    memory: 'rightPanel.tabMemory',
    skills: 'rightPanel.tabSkills',
    wiki: 'rightPanel.tabWiki',
    access: 'rightPanel.tabAccess',
    schedules: 'rightPanel.tabSchedules',
    watches: 'watches.title',
  };

  /** 详情 tab 的三个文案键（tab 条）。 */
  const TAB_LABEL_KEYS: Record<PanelTab, MessageKey> = {
    detail: 'rightPanel.tabDetail',
    widgets: 'rightPanel.tabWidgets',
    tasks: 'rightPanel.tabTasks',
    notes: 'rightPanel.tabNotes',
  };

  /** 便签目前只在 Bot 与用户的私聊里提供入口（项目组 / Bot 间对话不显示）。 */
  const panelTabs = $derived(
    PANEL_TABS.filter((entry) => entry.id !== 'notes' || conversation?.type === 'direct'),
  );

  // 切到不支持便签的对话时，正在看的便签 tab 退回详情。
  $effect(() => {
    if (tab === 'notes' && conversation?.type !== 'direct') tab = 'detail';
  });

  // 每个对话记住自己上次打开的 tab：切对话先按新对话的记录恢复（应用重启 /
  // 面板重挂载由上面的初始化 + 本 effect 覆盖），随后 tab 的任何变化都写回
  // 当前对话。便签的适用性由 storedTab 兜底（非法类型退回详情）。
  $effect(() => {
    const id = conversationId;
    const type = conversation?.type ?? null;
    if (id === tabConversationId) return;
    tabConversationId = id;
    tab = storedTab(id, type);
  });

  $effect(() => {
    const id = tabConversationId;
    const value = tab;
    if (id !== null) savePanelTab(globalThis.localStorage ?? null, id, value);
  });

  // D80（回执卡 / 提议卡的「全部定时任务」）与设置卡深链（'profile' / 'skills'）：
  // 一律归位详情 tab 再下钻。
  $effect(() => {
    const requested = shell.rightPanelTabRequest;
    if (requested === null) return;
    shell.rightPanelTabRequest = null;
    tab = 'detail';
    detail =
      requested === 'skills'
        ? { kind: 'skills' }
        : requested === 'schedules'
          ? { kind: 'schedules' }
          : null;
  });

  /**
   * 记忆详情的面包屑（DetailHeader 用）：根段「记忆」点击回顶层目录，其后每级
   * 分类按路径展示、点击对应跳转；末段为当前位置不可点。仅 memory 详情有
   * （Wiki 详情的面包屑随头行一起由 WikiBrowser 自绘）。
   */
  const detailBreadcrumb = $derived.by(() => {
    if (detail === null || detail.kind !== 'memory') return undefined;
    const chain: MemoryCategoryNode[] = [];
    for (
      let node = memoryNav.id === null ? null : findNode(memoryNav.id);
      node !== null;
      node = findParent(node.id)
    ) {
      chain.unshift(node);
    }
    const crumbs: Array<{ label: string; onJump?: () => void }> = [];
    crumbs.push({
      label: t(DETAIL_TITLE_KEYS.memory),
      ...(chain.length > 0 ? { onJump: () => memoryNav.select(null) } : {}),
    });
    for (const node of chain) {
      crumbs.push({
        label: t(node.labelKey),
        ...(node.id !== memoryNav.id ? { onJump: () => memoryNav.select(node.id) } : {}),
      });
    }
    return crumbs;
  });
  // 对话内设置卡的深链（shell.openBotPanel）：按锚点映射直接落到二级菜单对应
  // 配置条目，再滚到 [data-settings-anchor]。草稿克隆完才渲染配置表单，找不到
  // 就逐帧重试一小会儿（anchor-scroll.ts）。
  $effect(() => {
    const anchor = shell.botPanelAnchor;
    if (anchor === null) return;
    const section = BOT_CONFIG_ANCHOR_SECTIONS[anchor];
    tab = 'detail';
    detail = section !== undefined ? { kind: 'profile', section } : null;
    void revealSettingsAnchor({
      anchor,
      container: () => document.querySelector('[data-testid="bot-panel-content"]'),
      flush: tick,
      wait: nextFrame,
      attempts: 30,
      clear: () => (shell.botPanelAnchor = null),
    });
  });

  /** 「其它」分组：移除 Bot（删除全部数据，历史保留为只读）。 */
  let removeOpen = $state(false);
  let removePreview = $state({
    conversations: 0,
    messages: 0,
    ledProjects: [] as Array<{ id: string; title: string | null }>,
  });
  let removing = $state(false);

  /**
   * The bot leads projects: deletion is blocked (the backend would reject with
   * PROJECT_LEAD_REQUIRED). Jump to that project's members section so the
   * user can hand the lead over first.
   */
  async function goReplaceLead(conversationId: string): Promise<void> {
    removeOpen = false;
    await chat.select(conversationId);
    shell.openProjectSettings('members');
  }

  /**
   * 最近一次保存到 core 的完整 profile。头像 / 名称 / 简介的点按直编以它为
   * 基准合并，配置表单的自动保存也用它做回声抑制：RPC 回写 store 后 draft
   * 与它一致则不再触发下一轮保存。
   */
  let savedProfile = $state<BotProfile | null>(null);

  /** 当前草稿所属 Bot；换 Bot 才强制重载，同 Bot 的推送与未保存改动按字段合并。 */
  let draftBotId = $state<string | null>(null);

  $effect(() => {
    if (bot && bot.status === 'active') {
      // 草稿本身不进依赖：用户改模型只走自动保存 effect，不重跑本同步。
      const serverProfile = $state.snapshot(bot.profile) as BotProfile;
      const result = reconcileBotDraft({
        sameBot: draftBotId === bot.id,
        draft: untrack(() => draft && ($state.snapshot(draft) as BotProfile)),
        savedProfile: untrack(() => savedProfile && ($state.snapshot(savedProfile) as BotProfile)),
        serverProfile,
      });
      if (result.action === 'replace') {
        // 换 Bot 时下钻详情回到菜单首页；tab 归对话记忆，由上面的对话切换
        // effect 按新对话恢复。
        if (draftBotId !== bot.id) detail = null;
        draft = structuredClone(result.draft);
        savedProfile = bot.profile;
        draftBotId = bot.id;
      }
    } else {
      draft = null;
      savedProfile = null;
      draftBotId = null;
      detail = null;
      tab = 'detail';
    }
  });

  async function saveProfile(id: string, profile: BotProfile): Promise<void> {
    // base = 草稿出发时的版本（最近一次保存 / 合并进来的服务端 profile）：core 据此三方合并，
    // 草稿没碰的字段不会把 Bot 刚直改或设置卡刚写的值覆盖回去。换 Bot 的补救保存不带 base。
    const base =
      savedProfile !== null && draftBotId === id
        ? ($state.snapshot(savedProfile) as BotProfile)
        : null;
    try {
      const updated = await contacts.update(id, $state.snapshot(profile) as BotProfile, base);
      savedProfile = updated.profile;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * 配置表单自动保存：深度监听 draft（snapshot 建立全量依赖），变更后防抖
   * 落盘，无需手动保存按钮。与最近保存结果一致时跳过，避免保存回写 store
   * 引发的回声循环。
   */
  $effect(() => {
    const currentBot = bot;
    const currentDraft = draft;
    if (!currentBot || !currentDraft) return;
    // snapshot 读遍 draft 的每个字段，借此建立全量依赖。
    const draftSnapshot = $state.snapshot(currentDraft) as BotProfile;
    const saved = savedProfile && ($state.snapshot(savedProfile) as BotProfile);
    if (saved && deepEqual(saved, draftSnapshot)) return;
    // 主/轻量模型与 Agent 切换立即落盘，避免 500ms 窗口内发消息仍打旧模型。
    const delay = saved && isEngineOnlyChange(saved, draftSnapshot) ? 0 : 500;
    const timer = setTimeout(() => void saveProfile(currentBot.id, currentDraft), delay);
    return () => {
      clearTimeout(timer);
      // 防抖期间切换到其它 Bot（draft 被整体重克隆）会清掉定时器，窗口内的
      // 未落盘改动在这里立即补救。同一 Bot 的重跑（按键 / save_profile 外部
      // 更新触发重克隆）不在此列：前者交给新定时器，后者以服务端数据为准；
      // bot 为空是移除 / 关闭会话，不补写。
      if (bot && currentBot.id !== bot.id) void saveProfile(currentBot.id, currentDraft);
    };
  });

  /**
   * W8：确认切换浏览器资料后立即保存（不走防抖自动保存）；draft 随之更新，
   * 保存回写 savedProfile 后自动保存判定为一致，不会再存一次。
   */
  async function confirmBrowserProfile(next: string): Promise<void> {
    if (!bot || !draft) return;
    draft.runtime.browser_profile = next;
    await saveProfile(bot.id, draft);
  }

  /** draft 相对最近一次保存仍有未落盘改动时立即保存。 */
  function flushDirtyDraft(): void {
    if (!bot || !draft || !savedProfile) return;
    if (deepEqual($state.snapshot(draft), $state.snapshot(savedProfile))) return;
    void saveProfile(bot.id, draft);
  }

  // 右栏收起是整个卸载（ChatsArea 的 {#if}）：卸载清理里把防抖窗口内的
  // 未落盘改动立即保存，live draft/bot 就是待保存值。
  onMount(() => () => flushDirtyDraft());

  /** 名称 / 简介的点按直编：在最近保存的 profile 上做字段级合并，并带上这份基线。 */
  async function patchIdentity(patch: Partial<BotProfile['identity']>): Promise<void> {
    if (!bot) return;
    // base = 写入前所基于的整份 profile（savedProfile ?? bot.profile）：core 三方合并，
    // 没改的字段（如 Bot 刚直改的模型）不会被这份改名 / 简介盖回去。
    const base = $state.snapshot(savedProfile ?? bot.profile) as BotProfile;
    try {
      const updated = await contacts.update(
        bot.id,
        {
          ...base,
          identity: { ...base.identity, ...patch },
        } as BotProfile,
        base,
      );
      savedProfile = updated.profile;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  // --- 名称 / 简介点按直编 -------------------------------------------------
  let pickerOpen = $state(false);
  let editingName = $state(false);
  let nameDraft = $state('');
  let editingBio = $state(false);
  let bioDraft = $state('');

  /** 编辑态输入框挂载即聚焦，点按后光标立即可见。 */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }

  function startNameEdit(): void {
    if (!bot) return;
    nameDraft = bot.profile.identity.name;
    editingName = true;
  }

  async function commitName(): Promise<void> {
    if (!editingName) return;
    editingName = false;
    const name = nameDraft.trim();
    if (!bot || name.length === 0 || name === bot.profile.identity.name) return;
    await patchIdentity({ name });
  }

  function startBioEdit(): void {
    if (!bot) return;
    bioDraft = bot.profile.identity.bio;
    editingBio = true;
  }

  async function commitBio(): Promise<void> {
    if (!editingBio) return;
    editingBio = false;
    if (!bot || bioDraft === bot.profile.identity.bio) return;
    await patchIdentity({ bio: bioDraft.trim() });
  }

  async function askRemove(): Promise<void> {
    if (!bot) return;
    removePreview = await contacts.deletionPreview(bot.id);
    removeOpen = true;
  }

  async function confirmRemove(): Promise<void> {
    if (!bot) return;
    // remove 生效后派生值 bot 即为 null，名字要在 await 前捕获。
    const { id, name } = bot;
    removing = true;
    try {
      await contacts.remove(id);
      removeOpen = false;
      toast.success(t('contacts.deleteTitle', { name }));
      chat.close();
    } finally {
      removing = false;
    }
  }
</script>

<aside
  class="flex h-full min-h-0 flex-col bg-background {narrow ? '' : 'border-l'}"
  data-testid="right-panel"
>
  <header
    class="app-drag wco-inset-end @container relative z-30 flex h-12 shrink-0 items-center justify-end {narrow &&
    isMac
      ? 'pr-2 pl-20'
      : 'px-4'}"
  >
    <div class="app-no-drag flex items-center gap-1">
      <!-- P11 任务 5: 查看该 Bot 在当前对话中的浏览器页面（直聊才有单一 Bot）。 -->
      {#if bot?.status === 'active' && conversation && browserOpen}
        <Button
          variant="outline"
          size="sm"
          class={BROWSER_SHOW_BTN_CLASS}
          title={t('rightPanel.browserShowHint')}
          onclick={() => void showBrowser(bot.id, conversation.id, bot.name)}
          data-testid="browser-show"
        >
          <Monitor class="size-3.5" aria-hidden="true" />
          <!-- 顶栏放不下文字（win 三键让位 + 窄 pane）就退成纯图标，hint 走 title。 -->
          <span class="@max-[380px]:hidden">{t('rightPanel.browserShow')}</span>
        </Button>
        <!-- 强制释放：Bot 用完没调 browser_close / 卡住时，手动释放页面资源。 -->
        <Button
          variant="outline"
          size="sm"
          class={BROWSER_SHOW_BTN_CLASS}
          title={t('rightPanel.browserCloseHint')}
          onclick={() => void closeBrowser(bot.id, conversation.id)}
          data-testid="browser-close"
        >
          <X class="size-3.5" aria-hidden="true" />
          <span class="@max-[380px]:hidden">{t('rightPanel.browserClose')}</span>
        </Button>
      {/if}
      <!-- D48：导出为模板（人设/能力/自写技能/头像）——顶栏图标钮，与关闭按钮同款样式。 -->
      {#if bot?.status === 'active'}
        <ExportBotTemplateButton botId={bot.id} botName={bot.name} />
      {/if}
      <!-- 关闭按钮与对话列表页的搜索 / 新增同款（圆形带边框，33-narrow-layout）。 -->
      <Button
        variant="ghost"
        size="icon"
        class="size-8 rounded-full border border-border bg-background text-muted-foreground shadow-none hover:text-foreground"
        onclick={() => (narrow ? narrowLayout.closeBotDetail() : shell.toggleRightPanel())}
        data-testid="right-panel-hide"
        aria-label={t('shell.rightPanelHide')}
      >
        <X class="size-5" aria-hidden="true" />
      </Button>
    </div>
  </header>

  {#if !bot}
    <div class="flex flex-1 items-center justify-center p-6">
      <p class="text-sm text-muted-foreground">{t('rightPanel.placeholder')}</p>
    </div>
  {:else if bot.status !== 'active'}
    <div class="flex flex-1 items-center justify-center p-6">
      <p class="text-sm text-muted-foreground" data-testid="deleted-bot-note">
        {t('rightPanel.deletedBot')}
      </p>
    </div>
  {:else if draft}
    <div class="flex min-h-0 flex-1 flex-col">
      <!-- 头部资料卡（参考 Grok Bot）：头像 / 名称 / 简介，点按直接编辑 -->
      <div class="relative shrink-0 px-4 pb-3">
        <div class="flex flex-col items-center gap-1 text-center">
          <button
            type="button"
            class="group relative size-24 shrink-0 {avatarShapeClass} outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onclick={() => (pickerOpen = !pickerOpen)}
            title={t('rightPanel.avatarEditTitle')}
            data-testid="bot-avatar-button"
          >
            <BotAvatar
              botId={bot.id}
              name={bot.name}
              avatar={bot.avatar}
              accentColor={bot.accentColor ?? null}
              mask={bot.avatarMask}
              padding={bot.avatarPadding}
              class="size-24"
              fallbackClass="text-2xl"
              testId="bot-avatar"
            />
            <span
              class="absolute inset-0 flex items-center justify-center {avatarShapeClass} bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Pencil class="size-6" aria-hidden="true" />
            </span>
          </button>
          {#if editingName}
            <!-- 编辑态与展示态盒子对齐（同高 h-8、同水平内边距 px-2）：不加边框，
                 以 bg-accent 标识编辑中；field-sizing:content 让宽度贴文本，切换不跳动。 -->
            <input
              class="field-sizing-content h-8 max-w-full min-w-12 rounded-md bg-accent px-2 text-center text-xl font-semibold outline-none"
              bind:value={nameDraft}
              maxlength={50}
              use:focusOnMount
              onkeydown={(e) => {
                if (e.key === 'Enter') void commitName();
                if (e.key === 'Escape') {
                  // 取消编辑并消费 Esc：外层（Bot 详情覆盖层等）看到 defaultPrevented 就不再关自己。
                  e.preventDefault();
                  editingName = false;
                }
              }}
              onblur={() => void commitName()}
              data-testid="bot-name-inline-input"
            />
          {:else}
            <button
              type="button"
              class="h-8 max-w-full truncate rounded-md px-2 py-0.5 text-xl font-semibold transition-colors hover:bg-accent"
              onclick={startNameEdit}
              title={t('rightPanel.clickToEdit')}
              data-testid="bot-name-edit"
            >
              {bot.name}
            </button>
          {/if}
          {#if editingBio}
            <!-- 空简介时宽度由 placeholder 撑起（field-sizing:content 对空值取
                 placeholder 尺寸），与展示态的占位文案宽度衔接。 -->
            <input
              class="field-sizing-content h-6 max-w-full min-w-12 rounded-md bg-accent px-2 text-center text-sm outline-none placeholder:text-muted-foreground"
              bind:value={bioDraft}
              maxlength={500}
              placeholder={t('rightPanel.bioPlaceholder')}
              use:focusOnMount
              onkeydown={(e) => {
                if (e.key === 'Enter') void commitBio();
                if (e.key === 'Escape') {
                  e.preventDefault();
                  editingBio = false;
                }
              }}
              onblur={() => void commitBio()}
              data-testid="bot-bio-inline-input"
            />
          {:else}
            <button
              type="button"
              class="h-6 max-w-full truncate rounded-md px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-accent {bot.bio
                ? ''
                : 'italic'}"
              onclick={startBioEdit}
              title={t('rightPanel.clickToEdit')}
              data-testid="bot-bio-edit"
            >
              {bot.bio || t('rightPanel.bioPlaceholder')}
            </button>
          {/if}
          {#if bot.profile.runtime.agent.id.length > 0 && bot.setupState !== 'interviewing'}
            <!-- D72：外部智能体驱动的 Bot——徽标 + 隔离说明，点击跳设置页对应 Agent -->
            <AgentBadge agentId={bot.profile.runtime.agent.id} />
          {/if}
        </div>
        <AvatarPicker bind:open={pickerOpen} {bot} />
      </div>

      <!-- 详情 / 组件 / 任务（D116）+ 便签（仅私聊）。横向居中 + 图标；手写 pill 条
           （components/ui/tabs 的 bits-ui data-state 与样式变体不匹配，见
           ProjectTabs 注释）。外层横向滚动：右栏可窄到 20%，四个 tab 放不下时
           不换行、不裁掉首尾（内层 w-max + mx-auto 让放得下时仍居中）。 -->
      <div class="shrink-0 overflow-x-auto px-4 pb-2">
        <div
          class="mx-auto flex w-max items-center gap-0.5"
          role="tablist"
          data-testid="right-panel-tabs"
        >
          {#each panelTabs as entry (entry.id)}
            {@const tabActive = tab === entry.id}
            {@const TabIcon = entry.icon}
            <button
              type="button"
              role="tab"
              aria-selected={tabActive}
              data-active={tabActive ? 'true' : undefined}
              data-testid={`right-panel-tab-${entry.id}`}
              class="inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-full px-2.5 py-0.5 text-[13px] whitespace-nowrap transition-colors {tabActive
                ? 'bg-muted font-medium text-foreground'
                : 'text-foreground/50 hover:bg-accent/60 hover:text-foreground/80'}"
              onclick={() => {
                tab = entry.id;
                // 任务 tab 激活时重拉（幂等，seq 防竞态）：面板挂载很久后点开也拿最新。
                if (entry.id === 'tasks' && bot?.status === 'active') void botTasks.load(bot.id);
              }}
            >
              <TabIcon class="size-3.5 shrink-0" aria-hidden="true" />
              {t(TAB_LABEL_KEYS[entry.id])}
              {#if entry.id === 'tasks' && activeTaskCount > 0}
                <span
                  class="text-[11px] text-foreground/60 tabular-nums"
                  data-testid="right-panel-tab-tasks-badge"
                >
                  {activeTaskCount}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </div>

      {#if tab === 'tasks'}
        <!-- 任务 tab（D116）：该 Bot 拉起的全部任务，行点击进主区任务详情页。 -->
        <div class="flex min-h-0 flex-1 flex-col p-4">
          <BotTasksPanel botId={bot.id} />
        </div>
      {:else if tab === 'notes' && conversation?.type === 'direct'}
        <!-- 便签 tab：仅私聊提供；纯用户数据，不进入 Bot 上下文。按对话重建：切对话
             时旧实例先 flush 未落库的编辑，新对话从空列表加载（不残留上一对话的条目）。 -->
        <div class="flex min-h-0 flex-1 flex-col p-4">
          {#if conversation}
            {#key conversation.id}
              <NotesTab conversationId={conversation.id} />
            {/key}
          {/if}
        </div>
      {:else if tab === 'widgets'}
        <!-- 组件 tab（D117）：卡片直运行 + 「…」菜单 + 详情下钻。 -->
        <div class="flex min-h-0 flex-1 flex-col p-4">
          <BotWidgetsTab botId={bot.id} conversationId={conversation?.id} />
        </div>
      {:else}
        <!-- 详情 tab：统一二级菜单 / 下钻详情（默认）。 -->
        <div class="min-h-0 flex-1 overflow-y-auto p-4" data-testid="bot-panel-content">
          <!-- 工作目录（P04）：目录设置弹框挂在这里，菜单的工作目录行经 openWorkdir 打开。 -->
          {#if conversation}
            <WorkdirSelector
              bind:this={workdirSelector}
              conversationId={conversation.id}
              workdirId={conversation.workdirId}
              disabled={conversation.readOnly}
              showBlock={false}
            />
          {/if}
          {#if detail === null}
            <div class="space-y-4" in:fade={{ duration: motionMs(MOTION.content) }}>
              <!-- D73 P2：污点外发汇总（有记录才占位），置于菜单之上。 -->
              <EgressSummary botId={bot.id} />
              <!-- D48 导出为模板已上移到顶栏（关闭按钮左侧）。 -->
              <BotMenu
                profile={draft}
                botId={bot.id}
                conversationId={conversation?.id}
                workdirId={conversation?.workdirId ?? null}
                workdirDisabled={conversation?.readOnly}
                deletable={bot.systemRole !== 'butler'}
                onOpenSection={(section) => (detail = { kind: 'profile', section })}
                onOpenWorkdir={() => workdirSelector?.openWorkdir()}
                onOpenMemory={() => (detail = { kind: 'memory' })}
                onOpenSkills={() => (detail = { kind: 'skills' })}
                onOpenWiki={() => (detail = { kind: 'wiki' })}
                onOpenAccess={() => (detail = { kind: 'access' })}
                onOpenSchedules={() => (detail = { kind: 'schedules' })}
                onOpenWatches={() => (detail = { kind: 'watches' })}
                onRemoveBot={() => void askRemove()}
              />
            </div>
          {:else if detail.kind === 'profile'}
            <!-- 配置条目详情：返回回菜单；字段变化仍走表单自动保存。 -->
            <div
              class="space-y-3"
              data-testid={`bot-detail-${detail.section}`}
              in:fade={{ duration: motionMs(MOTION.content) }}
            >
              <DetailHeader
                title={t(BOT_CONFIG_SECTION_LABEL_KEYS[detail.section])}
                onBack={() => (detail = null)}
              />
              <!-- 名字/简介走上方头部资料卡的点按直编；表单值变化即自动保存，无需按钮。 -->
              <BotProfileForm
                bind:profile={draft}
                showIdentity={false}
                botId={bot?.id}
                onBrowserProfileConfirm={confirmBrowserProfile}
                section={detail.section}
              />
            </div>
          {:else}
            <!-- 原 tab 内容详情：授权 / 记忆 / Skills / Wiki / 定时任务 / 网页监看。 -->
            <div
              class="flex min-h-0 flex-col gap-3"
              data-testid={`bot-detail-${detail.kind}`}
              in:fade={{ duration: motionMs(MOTION.content) }}
            >
              {#if detail.kind !== 'wiki' && !(detail.kind === 'skills' && skillNav.selectedName !== null)}
                <!-- 技能详情态隐藏「< Skills」一行：返回由 SkillsTab 详情内的「返回」承担，
                   顶栏出现会造成两层返回（skillNav 状态在 skills-nav.svelte）。
                   Wiki 详情的头行（返回 + 面包屑 + 页面删除）整个由 WikiBrowser 自绘。 -->
                <DetailHeader
                  title={t(DETAIL_TITLE_KEYS[detail.kind])}
                  onBack={() => (detail = null)}
                  breadcrumb={detailBreadcrumb}
                  breadcrumbTestid={detail.kind === 'memory' ? 'memory-breadcrumb' : undefined}
                />
              {/if}
              {#if detail.kind === 'access'}
                {#if confirmMode}
                  <p
                    class="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400"
                    data-testid="confirm-mode-hint"
                  >
                    {t('chats.confirmModeBanner', { reason: permissions.sandbox?.reason ?? '' })}
                  </p>
                {/if}
                {#if grants.length === 0}
                  <p class="text-muted-foreground" data-testid="grants-empty">
                    {t('rightPanel.grantsEmpty')}
                  </p>
                {:else}
                  <ul class="space-y-2" data-testid="grants-list">
                    {#each grants as grant (grant.id)}
                      <li class="rounded-md border p-2" data-testid={`grant-item-${grant.id}`}>
                        <code class="block text-xs break-all">{grant.path}</code>
                        <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <span
                            >{t(
                              grant.access === 'write'
                                ? 'rightPanel.grantWrite'
                                : 'rightPanel.grantRead',
                            )}</span
                          >
                          <span>·</span>
                          <span
                            >{t(
                              grant.duration === 'once'
                                ? 'rightPanel.grantOnce'
                                : 'rightPanel.grantConversation',
                            )}</span
                          >
                          <Button
                            variant="ghost"
                            size="sm"
                            class="ml-auto h-6 px-2 text-xs text-destructive"
                            onclick={() => void permissions.revokeGrant(grant.id)}
                            data-testid={`grant-revoke-${grant.id}`}
                          >
                            {t('rightPanel.revoke')}
                          </Button>
                        </div>
                      </li>
                    {/each}
                  </ul>
                {/if}
                <p class="text-xs text-muted-foreground">{t('rightPanel.grantsHint')}</p>
              {:else if detail.kind === 'memory'}
                <MemoryTab botId={bot.id} active={true} />
              {:else if detail.kind === 'skills'}
                <SkillsTab botId={bot.id} active={true} />
              {:else if detail.kind === 'wiki'}
                <WikiBrowser
                  owner={{ kind: 'bot', id: bot.id }}
                  active={true}
                  onBack={() => (detail = null)}
                  headerTitle={t(DETAIL_TITLE_KEYS.wiki)}
                />
              {:else if conversation}
                {#if detail.kind === 'schedules'}
                  <!-- P10: the current conversation's schedules (direct chat = this bot). -->
                  <SchedulesPanel conversationId={conversation.id} testid="schedules-tab" />
                {:else}
                  <!-- W7: the conversation's web-page watches. -->
                  <WatchesPanel conversationId={conversation.id} testid="watches-tab" />
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</aside>

<Dialog bind:open={removeOpen}>
  <DialogContent class="max-w-md" data-testid="bot-remove-dialog">
    <DialogHeader>
      <DialogTitle>{t('contacts.deleteTitle', { name: bot?.name ?? '' })}</DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground" data-testid="bot-remove-body">
      {t('contacts.deleteBody', {
        conversations: removePreview.conversations,
        messages: removePreview.messages,
      })}
    </p>
    {#if (bot?.profile.runtime.agent.id ?? '').length > 0}
      <p class="text-xs text-muted-foreground" data-testid="bot-remove-body-agent-note">
        {t('contacts.deleteAgentNote')}
      </p>
    {/if}
    {#if removePreview.ledProjects.length > 0}
      <!-- Leading projects block the delete: no confirm button, offer the
           "go replace" jump into each project's members section instead. -->
      <div class="space-y-1.5" data-testid="bot-remove-lead-blocked">
        <p class="text-sm text-muted-foreground">
          {t('contacts.deleteBlockedLead', { count: removePreview.ledProjects.length })}
        </p>
        <ul class="space-y-1.5">
          {#each removePreview.ledProjects as project (project.id)}
            <li class="flex items-center gap-2 rounded-md border p-2 text-sm">
              <span class="min-w-0 flex-1 truncate">
                {project.title ?? t('project.untitled')}
              </span>
              <Button
                size="sm"
                variant="outline"
                onclick={() => void goReplaceLead(project.id)}
                data-testid={`bot-remove-go-replace-${project.id}`}
              >
                {t('contacts.deleteGoReplace')}
              </Button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (removeOpen = false)}
        data-testid="bot-remove-cancel"
      >
        {t('contacts.cancel')}
      </Button>
      {#if removePreview.ledProjects.length === 0}
        <Button
          variant="destructive"
          onclick={confirmRemove}
          disabled={removing}
          data-testid="bot-remove-confirm"
        >
          {t('contacts.deleteConfirm')}
        </Button>
      {/if}
    </DialogFooter>
  </DialogContent>
</Dialog>

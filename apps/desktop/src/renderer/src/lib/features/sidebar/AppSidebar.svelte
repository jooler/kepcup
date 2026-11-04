<script lang="ts">
import { onDestroy, tick, type Component } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { dragHandle, dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import {
    ArrowDown,
    ArrowUp,
    ArrowLeft,
    Search,
    Plus,
    Users,
    MessagesSquare,
    Settings2,
    BookUser,
    Blocks,
    Pencil,
    Copy,
    Trash2,
    Archive,
    ChevronLeft,
    ChevronRight,
    Folder,
    FolderPlus,
    Check,
    Pin,
    PinOff,
    Smartphone,
    FileUp,
    type LucideIcon,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { stripMarkdown } from '$lib/strip-markdown';
  import { logoDarkUrl, logoLightUrl } from './sidebar-icons';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';
  import { shell } from '$lib/stores/shell.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { chat, type ConversationView } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { createBotConversational } from '$lib/features/bot-setup';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import ProjectAvatarStack from '$lib/avatars/ProjectAvatarStack.svelte';
  import UserAvatar from '$lib/avatars/UserAvatar.svelte';
  import SidebarUpdateButton from './SidebarUpdateButton.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import BotTemplateImportDialog from '$lib/features/bot-template/BotTemplateImportDialog.svelte';
  import { endpointSupports } from '$lib/features/web-shell/endpoint';
  import { remotePairing } from '$lib/features/remote/remote-pairing.svelte';
  import { isButlerConversation } from './butler';
  import { sidebarDialogs } from './sidebar-dialogs.svelte';
  import { sidebarSections } from './sidebar-sections.svelte';
  import { workbenchIconDarkUrl, workbenchIconLightUrl } from './sidebar-icons';
  import { SIDEBAR_ICON_ACTIVE_CLASS, SIDEBAR_ROW_ACTIVE_CLASS } from './sidebar-active-class';
  import {
    asIconComponent,
    visibleSettingsSections,
  } from '$lib/features/settings/settings-sections-list';
  import type { SettingsPageSection } from '$lib/features/settings/sections';
import {
  UNASSIGNED_SECTION_ID,
  SECTION_NAME_MAX,
  conversationActivityOf,
  isConversationPinned,
  layoutSidebarSections,
  sectionIdOf,
  sectionStepTarget,
  type SectionGroup,
} from './sidebar-sections';
import {
  anchorFromFinalize,
  boardFlipDurationMs,
  createClickGuard,
  draggedElementHeight,
  isNoopMove,
  isShadow,
  stripShadow,
} from '$lib/features/board/board-dnd';
  import {
    SIDEBAR_SORT_DEBOUNCE_MS,
    SIDEBAR_SORT_MAX_WAIT_MS,
    activitySnapshotOf,
    sameActivitySnapshot,
  } from './sidebar-activity';
  import { ESCAPE_PRIORITY, registerEscapeLayer } from '$lib/features/shell/escape-layers';
  import { sidebarLayout } from './sidebar-layout.svelte';
  import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip';

  /**
   * 左栏（参考 Grok Bot）：顶部只有搜索与新增。对话按分组列出：默认都在
   * 「未指定」，只有这一组时不显示组名；建了分组后，点组名折叠（折叠时右侧
   * 是本组对话数），组名可拖拽排序。管家私聊不参与分组，始终在列表第一位。
   * 条目是头像 + 名称 + 最后一条消息的单行
   * 预览（无消息且无未读/执行中/待确认信号时预览行整行不渲染，只剩名称与头像
   * 垂直居中）。组内按最后消息时间自动排序（去抖提交，避免频繁更新时闪烁），
   * 置顶条目固定在组内最前。管理操作（置顶 / 移动到分组 / 重命名 /
   * 复制会话 id / 群设置 / 删除）收进右键上下文菜单，不再有常驻「…」按钮。
   * 新建只保留「+」面板里的对话式新建和新建项目组。搜索按钮打开全局
   * 搜索弹框（Bot/会话/设置条目，Cmd+K 同效；搜索层与侧栏触发的模态对话框挂在 App 根）。
   * 设置页（宽屏整页视图）打开时，左栏内容区换成设置分类列表（顶部「返回对话」），
   * 底部 footer（头像菜单 / 扩展中心 / 更新圆钮）保持不变。
   *
   * 工作台入口（D90）在管家之上：只改 `shell.mainView`，不清当前会话；对话行的选中高亮
   * 据此派生（工作台打开时没有对话高亮）。窄屏（本组件复用为对话 tab）暂不显示入口。
   *
   * 宽度可拖拽调节（右缘手柄，sidebar-layout）：收窄到 macOS 红绿灯占位宽
   * 即图标模式——顶部搜索隐藏、「+」移到底部（与参考一致），对话只剩头像、
   * 名称/预览走 hover 提示，底部技能市场收成图标。
   *
   * 窄屏模式（33-narrow-layout）本组件复用为「对话」tab 的列表页：--sidebar-width
   * 由 NarrowShell 覆盖为全宽，图标模式不适用（强制展开）、底部 footer 与调宽
   * 手柄隐藏（扩展中心 / 我移到底部 tab），「+」面板定位改贴窗口左缘。
   */
  // 红绿灯让位只属于 Electron 桌面壳；web 端点（浏览器）没有系统窗控，一律
  // 不做 macOS 适配——左上角 logo 恒显、无 pl-20 让位（D102 小修正）。
  const isMac = ENDPOINT_KIND === 'desktop' && /Mac/i.test(navigator.platform);

  /** 图标模式（拖到最小宽 = 红绿灯占位）：顶部搜索隐藏、「+」落底部、对话只显示头像。 */
  const narrow = $derived(narrowLayout.narrow);
  const collapsed = $derived(narrow ? false : sidebarLayout.collapsed);

  /** 高亮的对话行：只在对话视图里有（`mainView === 'chats' && id === currentId`，组群输入时无）。 */
  const activeConversationId = $derived(shell.workbenchShown ? null : chat.activeId);
  const workbenchActive = $derived(shell.workbenchShown);
  /** 设置 → 通用「显示工作台」；未加载快照前按默认关闭，避免闪一下。 */
  const workbenchNavVisible = $derived(settingsStore.settings?.workbenchEnabled === true);

  /**
   * 设置页（宽屏整页视图）打开时，左栏内容区换成分类列表：顶部「返回对话」退出
   * 设置，随后是分类条目——「个人资料」之后是「扩展中心」（伪分区，主体渲染扩展
   * 中心的市场 / 已安装 / 设置页签），其下分隔线与「通用」开始的设置分区隔开。
   * 图标模式（收窄到最小宽）下同一份列表只剩图标 + hover 提示。底部 footer
   * （头像菜单 / 扩展中心 / 更新圆钮）两种形态都保留。
   */

  /** 设置页是否接管左栏：窄屏没有整页设置（NarrowSettings 全屏页），恒为 false。 */
  const settingsPage = $derived(!narrow && shell.settingsOpen);

  interface SettingsNavEntry {
    id: SettingsPageSection;
    label: string;
    icon: LucideIcon;
  }

  /**
   * 设置分类条目：分区清单的事实源在 settings-section-labels（可见分区，宽屏全集），
   * 这里在「个人资料」之后插入「扩展中心」。主体内容渲染在 SettingsSectionView。
   */
  const settingsNavEntries = $derived.by(() => {
    const entries: SettingsNavEntry[] = visibleSettingsSections(false).map((section) => ({
      id: section.id,
      label: section.label,
      icon: section.icon,
    }));
    const profileIndex = entries.findIndex((entry) => entry.id === 'profile');
    entries.splice(profileIndex + 1, 0, {
      id: 'extension-center',
      label: t('sidebar.extensionCenter'),
      icon: Blocks,
    });
    return entries;
  });

  /** 点分类条目：清掉可能残留的深链锚点（换分类不滚动），再落到目标分类。 */
  function selectSettingsSection(id: SettingsPageSection): void {
    shell.settingsAnchor = null;
    shell.settingsSection = id;
  }

  $effect(() => {
    // 设置快照未到时不要抢先复位：启动恢复可能已经按记忆切到工作台，
    // 等开关真正加载后再判断是否关闭入口。
    if (settingsStore.settings === null || workbenchNavVisible) return;
    if (shell.mainView === 'workbench') shell.showChats();
  });

  /**
   * Electron 按 DOM 顺序合并 app-region，后出现的矩形胜出。开始对话面板和
   * 右键菜单写在侧栏里，排在聊天区 drag 之前，no-drag 会被后面的 drag 盖掉。
   * 挂到 sidebar-wrapper 末尾后，它们位于聊天区之后，重叠处才能收到点击。
   * 仍留在 wrapper 内，--sidebar-width 和头部 z-50 的层叠关系保持不变。
   */
  function mountAboveDragRegion(node: HTMLElement) {
    const target = node.closest('[data-slot="sidebar-wrapper"]') ?? document.body;
    target.appendChild(node);
  }

  let plusOpen = $state(false);
  let plusQuery = $state('');
  /** D48：从模板导入 Bot（.kepcup-bot.json → 新建 Bot）。 */
  let templateImportOpen = $state(false);

  /** 右键上下文菜单（视口坐标 + 目标会话）。 */
  let contextMenu = $state<{ x: number; y: number; conversationId: string } | null>(null);
  /** 「移动到」子菜单。creatingSection 为真时子菜单里是名称输入，不因指针移出而收起。 */
  let moveMenu = $state<{ x: number; y: number } | null>(null);
  let creatingSection = $state(false);
  let sectionDraft = $state('');
  let sectionNameInput = $state<HTMLInputElement | null>(null);
  let moveCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** 自定义分组的右键菜单（重命名 / 上移 / 下移 / 删除）。「未指定」没有这个菜单。 */
  let sectionMenu = $state<{ x: number; y: number; sectionId: string } | null>(null);
  let sectionMenuEl = $state<HTMLElement | null>(null);
  let renamingSectionId = $state<string | null>(null);
  let renameDraft = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);
  let renameCancelled = false;
  /**
   * 分组标题拖拽（svelte-dnd-action，同工作台备忘分组区）：组名 header 是把手，
   * 整个分组块（header + 对话行）作为 zone item 被克隆跟随光标，原位由高度钉住
   * 的 shadow 占位。type 用独立名——左栏与工作台同时挂载，不能与备忘分组区
   * （type 'group'）互通。beforeId 由 anchorFromFinalize 给出，null 表示落到末尾。
   */
  let sectionItems = $state.raw<SectionGroup<ConversationView>[]>([]);
  let sectionDragging = $state(false);
  let sectionShadowHeight = $state<number | null>(null);
  let reducedMotion = $state(false);
  const sectionClickGuard = createClickGuard();
  const sectionFlipDurationMs = $derived(boardFlipDurationMs(reducedMotion));
  const contextConversation = $derived(
    contextMenu === null
      ? null
      : (chat.conversations.find((c) => c.id === contextMenu?.conversationId) ?? null),
  );

  /**
   * 自动排序的活动时间快照（见 sidebar-activity）：多个 Bot 同时执行时，
   * 消息事件会频繁改 lastMessageAt。这里先攒着，安静 900ms 后一次性提交；
   * 持续更新则最多 4s 强制提交一次。提交前布局继续用旧快照，列表不会闪。
   */
  let activitySnapshot = $state<Record<string, number>>({});
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  let activityDeadline: ReturnType<typeof setTimeout> | null = null;
  let activityFirstPendingAt = 0;

  function clearActivityTimers(): void {
    if (activityTimer !== null) clearTimeout(activityTimer);
    if (activityDeadline !== null) clearTimeout(activityDeadline);
    activityTimer = null;
    activityDeadline = null;
    activityFirstPendingAt = 0;
  }

  function commitActivitySnapshot(): void {
    clearActivityTimers();
    const next = activitySnapshotOf(chat.conversations);
    if (!sameActivitySnapshot(next, activitySnapshot)) activitySnapshot = next;
  }

  $effect(() => {
    const next = activitySnapshotOf(chat.conversations);
    if (sameActivitySnapshot(next, activitySnapshot)) {
      clearActivityTimers();
      return;
    }
    const now = Date.now();
    if (activityFirstPendingAt === 0) activityFirstPendingAt = now;
    if (activityTimer !== null) clearTimeout(activityTimer);
    activityTimer = setTimeout(commitActivitySnapshot, SIDEBAR_SORT_DEBOUNCE_MS);
    if (activityDeadline === null) {
      activityDeadline = setTimeout(
        commitActivitySnapshot,
        Math.max(0, SIDEBAR_SORT_MAX_WAIT_MS - (now - activityFirstPendingAt)),
      );
    }
  });

  onDestroy(clearActivityTimers);

  const plusBots = $derived.by(() => {
    const query = plusQuery.trim().toLowerCase();
    if (query.length === 0) return contacts.bots;
    return contacts.bots.filter(
      (bot) =>
        bot.name.toLowerCase().includes(query) ||
        bot.bio.toLowerCase().includes(query) ||
        bot.id.toLowerCase().includes(query),
    );
  });

  // 启动时一个 Bot 都没有 → 「+」面板自动下拉展开（App 恢复逻辑设置标志）；
  // 首启向导实际弹出时收起（向导本身会创建第一个 Bot，避免面板挡在向导下）。
  $effect(() => {
    if (onboarding.open) plusOpen = false;
  });
  $effect(() => {
    if (!shell.autoOpenStartPanel) return;
    shell.autoOpenStartPanel = false;
    // 守卫语义是「空态引导」：restoreLast 在慢机器上是异步尾巴，可能在
    // 用户已建好第一个 Bot 之后才返回 'empty'——此刻再拉全屏 backdrop 会
    // 挡住一切交互，只有「仍无任何 Bot/对话」时才真正展开。
    if (contacts.bots.length === 0 && chat.conversations.length === 0) plusOpen = true;
  });

  /** 打开全局搜索弹框（「+」面板开着时先收起，避免两层浮层叠加）。 */
  function openGlobalSearch(): void {
    plusOpen = false;
    shell.openSearch();
  }

  // 搜索层可从 Cmd/Ctrl+K 等任意入口打开（状态在 shell，层本身挂在 App 根）：
  // 无论从哪打开，「+」面板都要收起，避免两层浮层叠加。
  $effect(() => {
    if (shell.searchOpen) plusOpen = false;
  });

  // 右键菜单 / 「+」面板的 Esc：窄屏的「开始对话」是 z-50 全屏页，宽屏的面板是局部弹出层。
  $effect(() => {
    if (contextMenu === null && sectionMenu === null) return;
    return registerEscapeLayer({
      priority: ESCAPE_PRIORITY.popover,
      onEscape: () => {
        closeContextMenu();
        closeSectionMenu();
      },
    });
  });
  // 分组菜单打开（右键或 Shift+F10 / 菜单键）：焦点进第一项，键盘可直接操作。
  $effect(() => {
    const menu = sectionMenuEl;
    if (sectionMenu === null || menu === null) return;
    menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  });
  $effect(() => {
    if (!creatingSection) return;
    sectionNameInput?.focus();
  });
  $effect(() => {
    if (renamingSectionId === null) return;
    renameInput?.focus();
    renameInput?.select();
  });
  $effect(() => {
    if (!plusOpen) return;
    return registerEscapeLayer({
      priority: narrow ? ESCAPE_PRIORITY.page : ESCAPE_PRIORITY.popover,
      onEscape: () => {
        plusOpen = false;
      },
    });
  });

  /** 条目第二行的单行预览：本会话积累的最后一条消息，启动时回退会话摘要；
   *  消息是 markdown 渲染的，这里剥掉语法标记只留可读文本。 */
  function previewOf(conversation: ConversationView): string {
    const raw = chat.lastMessageText[conversation.id] ?? conversation.summary ?? '';
    return stripMarkdown(raw);
  }

  /** 条目标题（图标模式的 hover 提示同源）：项目组用标题，私聊用 Bot 名。 */
  function nameOf(conversation: ConversationView): string {
    return conversation.type === 'project'
      ? (conversation.title ?? conversation.id)
      : (conversation.bot?.name ?? conversation.directBotId ?? conversation.id);
  }

  async function selectConversation(id: string): Promise<void> {
    await chat.select(id);
  }

  async function openBotChat(botId: string): Promise<void> {
    plusOpen = false;
    plusQuery = '';
    await chat.openDirect(botId);
  }

  async function startConversationalCreate(): Promise<void> {
    plusOpen = false;
    await createBotConversational();
  }

  async function openCreateProject(): Promise<void> {
    plusOpen = false;
    chat.beginProjectCompose();
  }

  /**
   * 管家不进入任何分组，单独排在列表最前。其余对话保持 store 的时间顺序，
   * 再按分组装桶。
   */
  const sidebarConversations = $derived(chat.conversations);
  const butlerConversations = $derived(
    sidebarConversations.filter((conversation) => isButlerConversation(conversation)),
  );
  const sectionLayout = $derived(
    layoutSidebarSections(
      sidebarConversations.filter((conversation) => !isButlerConversation(conversation)),
      sidebarSections.state,
      (conversation) => activitySnapshot[conversation.id] ?? conversationActivityOf(conversation),
    ),
  );
  /**
   * 图标模式没有组名可点，折叠会把对话藏起来且无法展开，所以这里忽略折叠，
   * 只沿用分组顺序。管家仍在最前。组名隐藏后分组之间用分隔线区分（样式同
   * 工作台下方的分隔线）；只有「未指定」时不显示线。
   */
  const iconGroups = $derived.by(() => {
    if (!sectionLayout.showHeaders) {
      return [
        {
          id: UNASSIGNED_SECTION_ID,
          conversations: [
            ...butlerConversations,
            ...sectionLayout.groups.flatMap((group) => group.conversations),
          ],
        },
      ];
    }
    return [
      ...(butlerConversations.length > 0
        ? [{ id: 'butler', conversations: butlerConversations }]
        : []),
      ...sectionLayout.groups
        .filter((group) => group.conversations.length > 0)
        .map((group) => ({ id: group.id, conversations: group.conversations })),
    ];
  });
  const contextIsButler = $derived(isButlerConversation(contextConversation ?? undefined));
  const contextPinned = $derived(
    contextMenu === null
      ? false
      : isConversationPinned(sidebarSections.state, contextMenu.conversationId),
  );

  // 管家不能留在分组里。之前若被移入过，这里把归属清掉（不展开「未指定」：
  // 这不是用户的移动操作）。写入失败会从库里重读、归属恢复，记录已尝试的会话
  // 避免 effect 立刻重试形成循环（下次启动仍会再清一次）。
  const butlerUnassignAttempted = new SvelteSet<string>();
  $effect(() => {
    const assigned = butlerConversations.filter(
      (conversation) =>
        sidebarSections.state.assignments[conversation.id] !== undefined &&
        !butlerUnassignAttempted.has(conversation.id),
    );
    for (const conversation of assigned) {
      butlerUnassignAttempted.add(conversation.id);
      sidebarSections.unassign(conversation.id);
    }
  });

  /** 只有「未指定」时管家并进同一条列表；有分组标题时管家留在标题之外。 */
  function conversationsInGroup(
    groupId: string,
    conversations: ConversationView[],
  ): ConversationView[] {
    if (sectionLayout.showHeaders || groupId !== UNASSIGNED_SECTION_ID) return conversations;
    return [...butlerConversations, ...conversations];
  }
  const contextSectionId = $derived(
    contextMenu === null
      ? UNASSIGNED_SECTION_ID
      : sectionIdOf(sidebarSections.state, contextMenu.conversationId),
  );

  function sectionLabel(sectionId: string): string {
    if (sectionId === UNASSIGNED_SECTION_ID) return t('sidebar.sectionUnassigned');
    return (
      sidebarSections.state.sections.find((section) => section.id === sectionId)?.name ??
      t('sidebar.sectionUnassigned')
    );
  }

  function openContextMenu(event: MouseEvent, conversationId: string): void {
    event.preventDefault();
    sectionMenu = null;
    renameCancelled = true;
    renamingSectionId = null;
    contextMenu = {
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 220),
      conversationId,
    };
    moveMenu = null;
    creatingSection = false;
    sectionDraft = '';
  }

  function closeContextMenu(): void {
    contextMenu = null;
    moveMenu = null;
    creatingSection = false;
    sectionDraft = '';
    if (moveCloseTimer !== null) {
      clearTimeout(moveCloseTimer);
      moveCloseTimer = null;
    }
  }

  function openMoveMenu(anchor: HTMLElement): void {
    if (moveCloseTimer !== null) {
      clearTimeout(moveCloseTimer);
      moveCloseTimer = null;
    }
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 208;
    let x = rect.right - 6;
    if (x + menuWidth > window.innerWidth - 8) x = Math.max(8, rect.left - menuWidth + 6);
    const rows = sectionLayout.groups.length + 1;
    const height = Math.min(320, rows * 32 + 52);
    let y = rect.top - 4;
    if (y + height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - 8 - height);
    moveMenu = { x, y };
  }

  function scheduleCloseMoveMenu(): void {
    if (creatingSection) return;
    if (moveCloseTimer !== null) clearTimeout(moveCloseTimer);
    // 从「移动到」移进子菜单时，按钮的 pointerleave 会晚于子菜单的 pointerenter。
    // 延后看指针还在不在这两块上，避免子菜单刚打开就被收起。
    moveCloseTimer = setTimeout(() => {
      moveCloseTimer = null;
      if (creatingSection) return;
      const hovered = document.querySelector(
        '[data-testid="conversation-move-menu"]:hover, [data-testid="context-move-to"]:hover',
      );
      if (hovered) return;
      moveMenu = null;
    }, 120);
  }

  function cancelCloseMoveMenu(): void {
    if (moveCloseTimer !== null) {
      clearTimeout(moveCloseTimer);
      moveCloseTimer = null;
    }
  }

  function moveConversationTo(sectionId: string): void {
    if (!contextMenu || contextIsButler) return;
    sidebarSections.assign(contextMenu.conversationId, sectionId);
    closeContextMenu();
  }

  /** 右键置顶 / 取消置顶：只影响所在分组内的先后，立即生效。 */
  function togglePinFromContext(): void {
    if (!contextMenu || contextIsButler) return;
    sidebarSections.togglePin(contextMenu.conversationId);
    closeContextMenu();
  }

  function beginCreateSection(): void {
    creatingSection = true;
    sectionDraft = '';
    cancelCloseMoveMenu();
  }

  function confirmCreateSection(event?: Event): void {
    event?.preventDefault();
    if (!contextMenu || contextIsButler) return;
    const id = sidebarSections.createAndAssign(sectionDraft, contextMenu.conversationId);
    if (id === null) return;
    closeContextMenu();
  }

  function openSectionMenu(event: MouseEvent, sectionId: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (sectionId === UNASSIGNED_SECTION_ID) return;
    closeContextMenu();
    // 键盘触发（Shift+F10 / 菜单键）时没有指针坐标：贴着标题按钮出现。
    let { clientX: x, clientY: y } = event;
    if (x === 0 && y === 0 && event.currentTarget instanceof HTMLElement) {
      const rect = event.currentTarget.getBoundingClientRect();
      x = rect.left + 8;
      y = rect.bottom;
    }
    sectionMenu = {
      x: Math.min(x, window.innerWidth - 200),
      y: Math.min(y, window.innerHeight - 160),
      sectionId,
    };
  }

  function focusSectionHeader(sectionId: string): void {
    void tick().then(() => {
      const header = [...document.querySelectorAll<HTMLElement>('[data-section-header]')].find(
        (element) => element.dataset.sectionId === sectionId,
      );
      header?.focus();
    });
  }

  /** 关闭分组菜单；restoreFocus 时焦点回到该分组标题（键盘用户不丢位置）。 */
  function closeSectionMenu(restoreFocus = true): void {
    if (sectionMenu === null) return;
    const { sectionId } = sectionMenu;
    sectionMenu = null;
    if (restoreFocus) focusSectionHeader(sectionId);
  }

  function onSectionMenuKeydown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const menu = event.currentTarget;
    if (!(menu instanceof HTMLElement)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  const sectionMenuUp = $derived(
    sectionMenu === null
      ? undefined
      : sectionStepTarget(sidebarSections.state.order, sectionMenu.sectionId, 'up'),
  );
  const sectionMenuDown = $derived(
    sectionMenu === null
      ? undefined
      : sectionStepTarget(sidebarSections.state.order, sectionMenu.sectionId, 'down'),
  );

  /** 分组右键菜单「上移 / 下移」：拖拽排序的键盘替代。 */
  function moveSectionStep(direction: 'up' | 'down'): void {
    if (!sectionMenu) return;
    const { sectionId } = sectionMenu;
    const beforeId = sectionStepTarget(sidebarSections.state.order, sectionId, direction);
    if (beforeId === undefined) return;
    sidebarSections.move(sectionId, beforeId);
    closeSectionMenu();
  }

  function startRenameFromMenu(): void {
    if (!sectionMenu) return;
    renameDraft = sectionLabel(sectionMenu.sectionId);
    renameCancelled = false;
    renamingSectionId = sectionMenu.sectionId;
    // 焦点交给行内改名输入框（见上面的 renamingSectionId effect）。
    closeSectionMenu(false);
  }

  function commitRename(sectionId: string): void {
    if (renameCancelled || renamingSectionId !== sectionId) return;
    renamingSectionId = null;
    sidebarSections.rename(sectionId, renameDraft);
  }

  function cancelRename(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    renameCancelled = true;
    renamingSectionId = null;
  }

  function deleteSectionFromMenu(): void {
    if (!sectionMenu) return;
    sidebarSections.remove(sectionMenu.sectionId);
    closeSectionMenu(false);
    toast.success(t('sidebar.sectionDeleted'));
  }

  /** 拖拽区 items 与 sectionLayout 的同步：拖拽中外部重排（活动快照去抖提交、归属
   *  变化）不覆盖本地 items，否则 shadow 占位会被冲掉；结束后下一次同步自然对齐。 */
  $effect(() => {
    const next = sectionLayout.groups;
    if (sectionDragging) return;
    sectionItems = next;
  });

  // 拖拽动画跟随系统「减少动态效果」设置（同工作台备忘/看板）。
  $effect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = media.matches;
    const onChange = (): void => {
      reducedMotion = media.matches;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  });

  /** 库不带 auto-scroll：拖拽期间靠近内容区上下边缘时继续滚动（沿用旧实现的手感）。 */
  function onSectionDragAutoScroll(event: MouseEvent): void {
    const scroller = document.querySelector<HTMLElement>('[data-slot="sidebar-content"]');
    if (scroller === null) return;
    const bounds = scroller.getBoundingClientRect();
    if (event.clientY < bounds.top + 28) scroller.scrollTop -= 10;
    else if (event.clientY > bounds.bottom - 28) scroller.scrollTop += 10;
  }

  function setSectionDragging(value: boolean): void {
    sectionDragging = value;
    if (value) window.addEventListener('mousemove', onSectionDragAutoScroll);
    else window.removeEventListener('mousemove', onSectionDragAutoScroll);
  }

  onDestroy(() => setSectionDragging(false));

  function onSectionConsider(event: CustomEvent<DndEvent<SectionGroup<ConversationView>>>): void {
    const info = event.detail.info;
    if (info.trigger === 'dragStopped') {
      sectionShadowHeight = null;
      setSectionDragging(false);
      return;
    }
    if (info.trigger === 'dragStarted') sectionShadowHeight = draggedElementHeight();
    sectionItems = event.detail.items;
    setSectionDragging(true);
  }

  function onSectionFinalize(event: CustomEvent<DndEvent<SectionGroup<ConversationView>>>): void {
    const info = event.detail.info;
    sectionShadowHeight = null;
    // 拖完浏览器会合成 click；先武装守卫，别让它触发折叠切换。
    if (info.source === 'pointer') sectionClickGuard.arm();
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') sectionItems = stripShadow(event.detail.items);
      if (info.source !== 'keyboard') setSectionDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = sectionLayout.groups.map((group) => group.id);
    sectionItems = next;
    if (!isNoopMove(prevIds, next.map((group) => group.id))) {
      sidebarSections.move(info.id, decision.beforeId);
    }
    if (info.source !== 'keyboard') setSectionDragging(false);
  }

  function onSectionClick(sectionId: string): void {
    if (sectionClickGuard.ignores()) return;
    sidebarSections.toggle(sectionId);
  }

  /** 右键「项目详情」（WP6 §4 步骤 6）：进入该项目组并打开内容区的详情页。 */
  async function openProjectDetail(): Promise<void> {
    if (!contextMenu) return;
    const conversationId = contextMenu.conversationId;
    closeContextMenu();
    await chat.select(conversationId);
    shell.openProjectSettings();
  }

  function openRename(): void {
    const conversation = contextConversation;
    const bot = conversation?.bot ?? null;
    if (!bot || bot.status !== 'active') {
      closeContextMenu();
      return;
    }
    closeContextMenu();
    sidebarDialogs.openRename(bot);
  }

  async function copyConversationId(): Promise<void> {
    if (!contextMenu) return;
    await navigator.clipboard.writeText(contextMenu.conversationId);
    toast.success(t('sidebar.copiedConversationId'));
    closeContextMenu();
  }

  function deleteFromContext(): void {
    if (!contextMenu) return;
    sidebarDialogs.askDelete(contextMenu.conversationId);
    closeContextMenu();
  }

  /**
   * 从对话列表移除（归档）：内容全留，会话仍在通讯录里可恢复。管家聊天例外——
   * 它是常驻入口，删掉要重开一个空的，仍走物理删除。
   */
  async function removeFromContext(): Promise<void> {
    if (!contextMenu) return;
    const conversationId = contextMenu.conversationId;
    closeContextMenu();
    await chat.archiveConversation(conversationId);
    toast.success(t('sidebar.removedFromList'), { description: t('sidebar.removedFromListHint') });
  }
</script>

<!-- 快捷键：Cmd/Ctrl+K 打开全局搜索在 App 根（全局，不依赖本组件挂载）。
     Esc 经层级仲裁（escape-layers）：右键菜单优先、其次「+」面板；有 bits-ui 弹框 /
     行内控件已处理的 Esc 不会再关它们。 -->

<!-- 右键菜单里的一行（同文件私有 snippet）。 -->
{#snippet contextItem(
  icon: LucideIcon,
  label: string,
  onclick: () => void,
  testid: string,
  destructive = false,
  disabled = false,
)}
  {@const Icon = icon as unknown as Component<{ class?: string }>}
  <button
    type="button"
    role="menuitem"
    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent
      focus-visible:bg-accent focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50
      {destructive ? 'text-destructive hover:text-destructive' : ''}"
    {disabled}
    {onclick}
    data-testid={testid}
  >
    <Icon class="size-3.5" />
    {label}
  </button>
{/snippet}

<!-- 工作台入口图标：无圆形底。 -->
{#snippet workbenchIcon()}
  <img
    src={workbenchIconLightUrl}
    alt=""
    class="size-10 shrink-0 object-contain dark:hidden"
    draggable="false"
    aria-hidden="true"
  />
  <img
    src={workbenchIconDarkUrl}
    alt=""
    class="hidden size-10 shrink-0 object-contain dark:block"
    draggable="false"
    aria-hidden="true"
  />
{/snippet}

<!-- 会话头像（展开/图标两模式共用）：项目组用成员头像堆叠，私聊用 Bot 头像。 -->
{#snippet conversationAvatar(conversation: ConversationView)}
  {#if conversation.type === 'project'}
    <ProjectAvatarStack members={conversation.memberPreviews ?? []} class="size-11" />
  {:else}
    <BotAvatar
      botId={conversation.directBotId ?? conversation.id}
      name={conversation.bot?.name ?? conversation.directBotId ?? '?'}
      avatar={conversation.bot?.avatar ?? null}
      accentColor={conversation.bot?.accentColor ?? null}
      mask={conversation.bot?.avatarMask ?? null}
      padding={conversation.bot?.avatarPadding ?? null}
      class="size-11"
      fallbackClass="text-base"
      testId="conversation-avatar"
    />
  {/if}
{/snippet}

<!-- 设置页分类条目（展开/图标两模式共用）：hover 与激活底色同对话条目取同一套
     token（展开态 SIDEBAR_ROW_ACTIVE_CLASS，图标态 SIDEBAR_ICON_ACTIVE_CLASS）。 -->
{#snippet settingsNavEntry(entry: SettingsNavEntry, iconMode: boolean)}
  {@const Icon = asIconComponent(entry.icon)}
  {@const active = shell.settingsSection === entry.id}
  {#if iconMode}
    <Tooltip.Root>
      <Tooltip.Trigger
        class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
          transition-colors hover:bg-sidebar-accent {SIDEBAR_ICON_ACTIVE_CLASS}"
        data-active={active ? 'true' : undefined}
        aria-label={entry.label}
        onclick={() => selectSettingsSection(entry.id)}
        data-testid={`settings-nav-${entry.id}`}
      >
        <Icon class="size-5" />
      </Tooltip.Trigger>
      <Tooltip.Content side="right">{entry.label}</Tooltip.Content>
    </Tooltip.Root>
  {:else}
    <button
      type="button"
      class="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm whitespace-nowrap transition-colors text-muted-foreground
        hover:bg-sidebar-accent hover:text-sidebar-accent-foreground
        data-active:text-sidebar-accent-foreground data-active:font-medium {SIDEBAR_ROW_ACTIVE_CLASS}"
      data-active={active ? 'true' : undefined}
      onclick={() => selectSettingsSection(entry.id)}
      data-testid={`settings-nav-${entry.id}`}
    >
      <Icon class="size-4" />
      <span class="min-w-0 flex-1 truncate">{entry.label}</span>
    </button>
  {/if}
{/snippet}

<!-- 设置页左栏分类列表：顶部「返回对话」退出设置（closeSettings 回到打开前的
     对话 / 工作台），「个人资料」之后是「扩展中心」，其下分隔线隔开设置分区。
     iconMode 是收窄到最小宽的图标形态（同一份清单只剩图标 + hover 提示）。 -->
{#snippet settingsNav(iconMode: boolean)}
  <div
    class="flex min-h-0 flex-col {iconMode ? 'items-center gap-1' : 'gap-0.5'}"
    data-testid="settings-nav"
  >
    {#if iconMode}
      <Tooltip.Root>
        <Tooltip.Trigger
          class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
            transition-colors hover:bg-sidebar-accent"
          aria-label={t('settings.backToChats')}
          onclick={() => shell.closeSettings()}
          data-testid="settings-nav-back"
        >
          <ArrowLeft class="size-5" />
        </Tooltip.Trigger>
        <Tooltip.Content side="right">{t('settings.backToChats')}</Tooltip.Content>
      </Tooltip.Root>
      <div role="separator" class="my-1 h-px w-6 shrink-0 bg-foreground/10"></div>
    {:else}
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground
          transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        onclick={() => shell.closeSettings()}
        data-testid="settings-nav-back"
      >
        <ArrowLeft class="size-4" />
        {t('settings.backToChats')}
      </button>
      <div role="separator" class="mx-1 my-2 h-px shrink-0 bg-foreground/10"></div>
    {/if}
    {#each settingsNavEntries as entry (entry.id)}
      {@render settingsNavEntry(entry, iconMode)}
      {#if entry.id === 'extension-center'}
        {#if iconMode}
          <div role="separator" class="my-1 h-px w-6 shrink-0 bg-foreground/10"></div>
        {:else}
          <div role="separator" class="mx-3 my-2 h-px shrink-0 bg-foreground/10"></div>
        {/if}
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet conversationRow(conversation: ConversationView)}
  <!-- 预览行只在有内容（预览文本或未读/执行中/待确认信号）时渲染：
       什么都没有的条目只剩名称一行，与头像垂直居中。 -->
  {@const preview = previewOf(conversation)}
  {@const showMetaRow =
    preview.length > 0 ||
    ((conversation.unreadCount ?? 0) > 0 && !chat.isViewing(conversation.id)) ||
    (conversation.runningBotIds?.length ?? 0) > 0 ||
    (permissions.pendingByConversation[conversation.id] ?? 0) > 0}
  <Sidebar.MenuItem>
    <div
      class="group/conversation flex w-full items-center"
      role="presentation"
      oncontextmenu={(event) => openContextMenu(event, conversation.id)}
      data-testid={`conversation-row-${conversation.id}`}
    >
      <!-- [&_svg]:size-auto 解开 MenuButton 基础样式 [&_svg]:size-4 的钉死：
           否则预置头像 svg 被压成 16px，盖过自身的 size-full。
           激活态背景本地覆盖：--sidebar-accent 与 hover 共用、对比不够。
           底色 token 集中在 sidebar-active-class.ts，工作台入口与本条目共用一套
           （SIDEBAR_ROW_ACTIVE_CLASS），别再在这里内联字面量。 -->
      <Sidebar.MenuButton
        class="h-auto min-w-0 flex-1 cursor-pointer gap-2 rounded-lg p-1 {SIDEBAR_ROW_ACTIVE_CLASS} [&_svg]:size-auto"
        isActive={activeConversationId === conversation.id}
        onclick={() => void selectConversation(conversation.id)}
        data-testid={`conversation-item-${conversation.id}`}
      >
        {@render conversationAvatar(conversation)}
        <span class="grid min-w-0 flex-1 gap-0.5 text-left leading-tight">
          <span class="flex items-center justify-between gap-1">
            <span class="truncate text-sm" data-testid="conversation-name">
              {nameOf(conversation)}
            </span>
            {#if isConversationPinned(sidebarSections.state, conversation.id)}
              <Pin
                size={12}
                class="mr-1 shrink-0 rotate-[30deg] text-muted-foreground"
                aria-hidden="true"
                data-testid="conversation-pinned"
              />
            {/if}
          </span>
          <!-- min-h-4 仅在有内容时撑住一行高度；空条目整行不渲染。 -->
          {#if showMetaRow}
            <span class="flex min-h-4 min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {#if (conversation.unreadCount ?? 0) > 0 && !chat.isViewing(conversation.id)}
                <span
                  class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
                  data-testid="unread-badge"
                >
                  {conversation.unreadCount}
                </span>
              {/if}
              {#if (conversation.runningBotIds?.length ?? 0) > 0}
                <span
                  class="size-2 shrink-0 animate-pulse rounded-full bg-emerald-500"
                  title={t('sidebar.runningSuffix')}
                  data-testid="running-dot"
                ></span>
              {/if}
              {#if (permissions.pendingByConversation[conversation.id] ?? 0) > 0}
                <span
                  class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] text-white"
                  title={t('sidebar.pendingSuffix')}
                  data-testid="pending-badge"
                >
                  {permissions.pendingByConversation[conversation.id]}
                </span>
              {/if}
              {#if preview.length > 0}
                <span class="truncate" data-testid="conversation-preview">
                  {preview}
                </span>
              {/if}
            </span>
          {/if}
        </span>
      </Sidebar.MenuButton>
    </div>
  </Sidebar.MenuItem>
{/snippet}

<!-- relative：右缘调宽手柄的定位基准；拖拽中不加 width 过渡（跟手），
     松手吸附/复位时恢复平滑动画。 -->
<Sidebar.Root
  collapsible="none"
  class="relative border-r {sidebarLayout.transitionClass}"
  data-testid="sidebar"
>
  <!-- 头部：拖拽区 + 搜索/新增。macOS 红绿灯让出左侧空间；win/linux 左上放
       品牌 logo（无背景稿，明暗主题各一，按 html.dark 切换——工作台入口
       图标同口径），搜索/「+」贴右；图标模式下按钮整体隐藏，mac 剩红绿灯
       拖拽区、win/linux 剩 logo + 三键。
       win/linux 图标模式（collapsed）logo 一起隐藏，但保留一条空白拖拽带：
       第一个 Bot 头像不顶到上缘，空白处可拖动窗口（20px，比 window-drag-band
       的 40px 兜底带收窄一半，免得头像过分下移）。 -->
  <!-- relative z-50：面板 backdrop（fixed z-40）盖不住头部，「+」在面板开着时仍可点。 -->
  {#if isMac || !collapsed}
    <div
      class="app-drag relative z-50 flex h-14 shrink-0 items-center gap-2 pr-2 {narrow
        ? 'wco-inset-end'
        : ''} {isMac ? (collapsed ? 'pl-0' : 'pl-20') : 'pl-4'}"
    >
      {#if !isMac}
        <!-- 在 drag 区内不做按钮：按住 logo 拖动窗口是自然行为。深浅两稿各自只
           在对应主题渲染（dark:hidden / dark:block，与 workbenchIcon 同口径）。 -->
        <img
          src={logoLightUrl}
          alt=""
          draggable="false"
          class="h-4.5 shrink-0 object-contain dark:hidden"
          data-testid="sidebar-app-logo"
        />
        <img
          src={logoDarkUrl}
          alt=""
          draggable="false"
          class="hidden h-4.5 shrink-0 object-contain dark:block"
          data-testid="sidebar-app-logo"
        />
      {/if}
      {#if !collapsed}
        <div class="flex-1"></div>
        <Button
          variant="ghost"
          size="icon"
          class="app-no-drag size-9 rounded-full border border-border bg-background
          text-muted-foreground shadow-none hover:text-foreground"
          onclick={openGlobalSearch}
          aria-label={t('search.open')}
          title={t('search.open')}
          data-testid="sidebar-search-button"
        >
          <Search class="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="app-no-drag size-9 rounded-full border border-border bg-background
          text-muted-foreground shadow-none hover:text-foreground"
          onclick={() => (plusOpen = true)}
          aria-label={t('sidebar.startChatTitle')}
          title={t('sidebar.startChatTitle')}
          data-testid="new-chat-button"
        >
          <Plus class="size-5" />
        </Button>
      {/if}
    </div>
  {:else}
    <!-- win/linux 图标模式：空带即整条拖拽区，不排任何内容。 -->
    <div class="app-drag relative z-50 h-5 shrink-0"></div>
  {/if}

  <Sidebar.Content class="px-2">
    <Sidebar.Group>
      <Sidebar.GroupContent>
        {#if settingsPage}
          <!-- 设置页接管左栏：分类列表替换对话列表（工作台入口一并隐藏）。 -->
          {@render settingsNav(collapsed)}
        {:else}
          {#if !narrow && workbenchNavVisible}
            <!-- 工作台入口（D90）：管家之上，不参与分组；图标模式只剩图标。关闭时入口与分隔线一并隐藏。 -->
            {#if collapsed}
              <Sidebar.Menu class="items-center">
                <Sidebar.MenuItem class="w-auto">
                  <Tooltip.Root>
                    <Tooltip.Trigger
                      class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
                      transition-colors hover:bg-sidebar-accent {SIDEBAR_ICON_ACTIVE_CLASS}"
                      data-active={workbenchActive ? 'true' : undefined}
                      aria-label={t('sidebar.workbench')}
                      onclick={() => shell.openWorkbench()}
                      data-testid="workbench-nav"
                    >
                      {@render workbenchIcon()}
                    </Tooltip.Trigger>
                    <Tooltip.Content side="right">{t('sidebar.workbench')}</Tooltip.Content>
                  </Tooltip.Root>
                </Sidebar.MenuItem>
              </Sidebar.Menu>
            {:else}
              <Sidebar.Menu>
                <Sidebar.MenuItem>
                  <Sidebar.MenuButton
                    class="h-auto min-w-0 flex-1 cursor-pointer gap-2 rounded-lg py-1 px-2 {SIDEBAR_ROW_ACTIVE_CLASS}
                    [&_svg]:size-auto"
                    isActive={workbenchActive}
                    onclick={() => shell.openWorkbench()}
                    data-testid="workbench-nav"
                  >
                    {@render workbenchIcon()}
                    <span class="min-w-0 flex-1 truncate text-left text-sm">
                      {t('sidebar.workbench')}
                    </span>
                  </Sidebar.MenuButton>
                </Sidebar.MenuItem>
              </Sidebar.Menu>
            {/if}
            <!-- 不用 Sidebar.Separator：其 data-horizontal 样式对不上 bits-ui 的
               data-orientation，h-px 不生效会塌成 0 高；sidebar-border 在亮色侧栏也几乎看不出。 -->
            <div
              role="separator"
              class="mx-1 my-2 h-px shrink-0 bg-foreground/10"
              data-testid="workbench-nav-separator"
            ></div>
          {/if}
          {#if chat.conversations.length === 0}
            {#if !collapsed}
              <p class="px-3 py-2 text-xs text-muted-foreground">{t('sidebar.chatsEmpty')}</p>
            {/if}
          {:else if collapsed}
            <!-- 图标模式：只剩头像，名称/预览走 hover 提示；未读/待确认/执行中
               叠在头像角上（待确认优先于未读，都是必须看见的信号）。 -->
            {#each iconGroups as group, groupIndex (group.id)}
              <!-- 组名在图标模式隐藏，分组之间用分隔线区分（同工作台下方的分隔线）。 -->
              {#if groupIndex > 0}
                <div
                  role="separator"
                  class="mx-3 my-2 h-px shrink-0 bg-foreground/10"
                  data-testid="sidebar-group-separator"
                ></div>
              {/if}
              <Sidebar.Menu class="items-center">
                {#each group.conversations as conversation (conversation.id)}
                  <Sidebar.MenuItem class="w-auto">
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
                        transition-colors hover:bg-sidebar-accent {SIDEBAR_ICON_ACTIVE_CLASS}"
                        data-active={activeConversationId === conversation.id ? 'true' : undefined}
                        onclick={() => void selectConversation(conversation.id)}
                        oncontextmenu={(event) => openContextMenu(event, conversation.id)}
                        data-testid={`conversation-item-${conversation.id}`}
                      >
                        {@render conversationAvatar(conversation)}
                        {#if (conversation.runningBotIds?.length ?? 0) > 0}
                          <span
                            class="absolute right-0.5 bottom-0.5 size-2.5 animate-pulse rounded-full bg-emerald-500 ring-2 ring-sidebar"
                            title={t('sidebar.runningSuffix')}
                            data-testid="running-dot"
                          ></span>
                        {/if}
                        {#if (permissions.pendingByConversation[conversation.id] ?? 0) > 0}
                          <span
                            class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] text-white"
                            title={t('sidebar.pendingSuffix')}
                            data-testid="pending-badge"
                          >
                            {permissions.pendingByConversation[conversation.id]}
                          </span>
                        {:else if (conversation.unreadCount ?? 0) > 0 && !chat.isViewing(conversation.id)}
                          <span
                            class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
                            data-testid="unread-badge"
                          >
                            {conversation.unreadCount}
                          </span>
                        {/if}
                      </Tooltip.Trigger>
                      <!-- 套件浮层基类是 inline-flex（横排）：这里改列方向，
                         名称一行、单行预览一行，超宽各自截断（上限 16rem）。 -->
                      <Tooltip.Content
                        side="right"
                        class="flex max-w-64 flex-col items-stretch gap-0.5"
                      >
                        <span class="truncate text-sm">{nameOf(conversation)}</span>
                        {#if previewOf(conversation).length > 0}
                          <span class="truncate text-xs opacity-80">{previewOf(conversation)}</span>
                        {/if}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </Sidebar.MenuItem>
                {/each}
              </Sidebar.Menu>
            {/each}
          {:else}
            {#if sectionLayout.showHeaders && butlerConversations.length > 0}
              <!-- 管家不归属任何分组，固定在分组标题之上。 -->
              <Sidebar.Menu>
                {#each butlerConversations as conversation (conversation.id)}
                  {@render conversationRow(conversation)}
                {/each}
              </Sidebar.Menu>
            {/if}
            <!-- 分组拖拽区（type 'sidebar-section'，独立于工作台的 'group'，两个视图
                 同时挂载不能互通）。delayTouchStart 换掉了旧把手上的 touch-none：
                 触摸等一拍再拖，期间照常滚动列表。 -->
            <div
              use:dragHandleZone={{
                items: sectionItems,
                type: 'sidebar-section',
                flipDurationMs: sectionFlipDurationMs,
                delayTouchStart: true,
                morphDisabled: true,
                dropTargetStyle: {},
              }}
              onconsider={onSectionConsider}
              onfinalize={onSectionFinalize}
            >
              {#each sectionItems as group, groupIndex (group.id)}
                {#if isShadow(group)}
                  <!-- 原位占位插槽：高度钉住拖拽浮动副本的实测高度（同备忘分组区）。 -->
                  <div
                    class="min-h-10 rounded-lg"
                    style:height={sectionShadowHeight === null ? undefined : `${sectionShadowHeight}px`}
                    aria-hidden="true"
                  ></div>
                {:else}
                  {@const rows = conversationsInGroup(group.id, group.conversations)}
                  <!-- data-sidebar-section 随克隆带到 body 上的浮动副本，用于克隆样式定界。 -->
                  <div
                    data-sidebar-section
                    class="relative rounded-md mt-2"
                  >
                    {#if sectionLayout.showHeaders}
                      {#if renamingSectionId === group.id}
                        <form
                          onsubmit={(event) => {
                            event.preventDefault();
                            commitRename(group.id);
                          }}
                        >
                          <Input
                            bind:value={renameDraft}
                            bind:ref={renameInput}
                            maxlength={SECTION_NAME_MAX}
                            class="h-8 text-sm"
                            data-testid={`section-rename-input-${group.id}`}
                            onkeydown={cancelRename}
                            onblur={() => commitRename(group.id)}
                          />
                        </form>
                      {:else}
                        <!-- 同一按钮既是折叠开关又是拖拽把手：未过拖拽阈值时 click
                             正常触发；真实拖拽后的合成 click 由 sectionClickGuard 吞掉。 -->
                        <button
                          type="button"
                          class="flex w-full cursor-grab items-center gap-2 px-2 pb-1 rounded-md text-left text-xs text-muted-foreground select-none"
                          aria-expanded={!group.collapsed}
                          data-section-header
                          data-section-id={group.id}
                          data-testid={`section-header-${group.id}`}
                          use:dragHandle
                          onclick={() => onSectionClick(group.id)}
                          oncontextmenu={(event) => openSectionMenu(event, group.id)}
                        >
                          <span class="min-w-0 flex-1 truncate">{sectionLabel(group.id)}</span>
                          {#if group.collapsed}
                            <span
                              class="shrink-0 tabular-nums"
                              data-testid={`section-count-${group.id}`}
                            >
                              {group.count}
                            </span>
                          {/if}
                        </button>
                      {/if}
                    {/if}
                    {#if !group.collapsed && rows.length > 0}
                      <Sidebar.Menu class={sectionLayout.showHeaders ? 'mt-1' : ''}>
                        {#each rows as conversation (conversation.id)}
                          {@render conversationRow(conversation)}
                        {/each}
                      </Sidebar.Menu>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        {/if}
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <!-- 底部 footer 窄屏隐藏：扩展中心（底部 tab「扩展」）与用户菜单（「我」页）
       移到了全局 tab 栏。设置页打开时同样隐藏：左栏只剩设置分类列表（头像 /
       扩展中心 / 更新圆钮等入口退出设置后回来）。 -->
  {#if !narrow && !settingsPage}
    <Sidebar.Footer>
      {#if collapsed}
        <!-- 图标模式（参考图）：「+」从顶部移到底部，与技能市场、头像竖排。 -->
        <div class="flex flex-col items-center gap-1 p-1">
          <button
            type="button"
            class="app-no-drag z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center
              rounded-full text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onclick={() => (plusOpen = true)}
            aria-label={t('sidebar.startChatTitle')}
            title={t('sidebar.startChatTitle')}
            data-testid="new-chat-button"
          >
            <Plus class="size-5" />
          </button>
          <button
            type="button"
            class="app-no-drag z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center
              rounded-full text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground"
            onclick={() => shell.openExtensionCenter()}
            aria-label={t('sidebar.extensionCenter')}
            title={t('sidebar.extensionCenter')}
            data-testid="extension-center-button"
          >
            <Blocks class="size-5" aria-hidden="true" />
          </button>
          <!-- 更新圆钮（ready 普通态 / awaiting-user destructive 确认态，组件内自管）。 -->
          <SidebarUpdateButton />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <button
                type="button"
                class="z-10 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-accent/50"
                aria-label={t('menu.settings')}
                title={settingsStore.userDisplayName}
                data-testid="user-menu-trigger"
              >
                <UserAvatar class="size-8" testId="user-menu-avatar" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="top" align="center" class="min-w-40">
              <!-- 连接手机（D96）：拉起配对二维码小窗；未开启远程遥控时小窗
                   先出「勾选即开启」门槛（见 RemotePairDialog）。 -->
              <DropdownMenu.Item
                onclick={() => remotePairing.request()}
                data-testid="menu-connect-phone"
              >
                <Smartphone aria-hidden="true" />
                {t('menu.connectPhone')}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onclick={() => shell.openSettings('general')}
                data-testid="menu-settings"
              >
                <Settings2 aria-hidden="true" />
                {t('menu.settings')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onclick={() => shell.openSettings('contacts')}
                data-testid="menu-contacts"
              >
                <BookUser aria-hidden="true" />
                {t('menu.contacts')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        </div>
      {:else}
        <div class="flex items-center gap-2 p-1">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <!-- 参考 Grok Bot：底部只有一枚圆形头像，不带文字与底色。 -->
              <button
                type="button"
                class="z-10 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-accent/50"
                aria-label={t('menu.settings')}
                title={settingsStore.userDisplayName}
                data-testid="user-menu-trigger"
              >
                <UserAvatar class="size-8" testId="user-menu-avatar" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="top" align="start" class="min-w-40">
              <!-- 同图标模式的「连接手机」入口。 -->
              <DropdownMenu.Item
                onclick={() => remotePairing.request()}
                data-testid="menu-connect-phone"
              >
                <Smartphone aria-hidden="true" />
                {t('menu.connectPhone')}
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                onclick={() => shell.openSettings('general')}
                data-testid="menu-settings"
              >
                <Settings2 aria-hidden="true" />
                {t('menu.settings')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onclick={() => shell.openSettings('contacts')}
                data-testid="menu-contacts"
              >
                <BookUser aria-hidden="true" />
                {t('menu.contacts')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          <!-- 技能市场入口（参考 Connect apps 的胶囊形态）：预置技能的浏览/添加 -->
          <button
            type="button"
            class="app-no-drag z-10 flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2
              rounded-full border border-border bg-white px-3 text-sm text-muted-foreground
              shadow-none transition-colors hover:text-foreground dark:bg-accent"
            onclick={() => shell.openExtensionCenter()}
            aria-label={t('sidebar.extensionCenter')}
            title={t('sidebar.extensionCenter')}
            data-testid="extension-center-button"
          >
            <Blocks class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{t('sidebar.extensionCenter')}</span>
          </button>
          <!-- 更新圆钮（同图标模式的复用组件，语义见组件头注释）。 -->
          <SidebarUpdateButton />
        </div>
      {/if}
    </Sidebar.Footer>
  {/if}

  <!-- 右缘调宽手柄：整条侧栏高度可抓；DOM 上位于头部（app-drag）之后，
       重叠处 no-drag 胜出，红绿灯旁也能拖。hover / 拖拽时在分隔线上亮出居中
       的胶囊指示并弹出「拖拽 / 双击复位」提示气泡（参考桌面应用分隔线）。
       注意 Sidebar.Root 自带 class="group"，这里的 group-hover 必须用具名
       group/resize 限定到本手柄，否则指针在侧栏任何位置都会触发。
       窄屏下列表全宽（宽度跟窗口），无手柄。 -->
  {#if !narrow}
    <div
      class="app-no-drag group/resize absolute inset-y-0 right-0 z-50 w-1.5 cursor-col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resizeHandle')}
      onpointerdown={(event) => sidebarLayout.startResize(event)}
      ondblclick={() => sidebarLayout.resetWidth()}
      data-testid="sidebar-resize-handle"
    >
      <!-- 高亮分隔线条：1px 宽、整条侧栏高，right-0 恰好压在容器 border-r
          那 1px 上（位置由结构保证，不按像素挪）。默认透明；hover 片刻以
          不透明 --divider-hover 淡入——实色把底下的边线完全盖住，整条线
          与胶囊（它的 flex 子元素）同色同层，看起来是一个整体。拖拽中经
          内联样式常亮（pointer capture 下 :hover 是否保留因平台而异）。 -->
      <div
        class="pointer-events-none absolute inset-y-0 right-0 flex w-px items-center justify-center
          overflow-visible bg-(--divider-hover) opacity-0 transition-opacity duration-200
          group-hover/resize:opacity-100 group-hover/resize:delay-150"
        style:opacity={sidebarLayout.dragging ? '1' : undefined}
        aria-hidden="true"
      >
        <!-- 指示胶囊：在 1px 条内纵横居中（flex），宽度大于条、对称溢出；
            shrink-0 防止 flex 把它压扁回 1px。 -->
        <div
          class="h-12 w-1 shrink-0 rounded-full bg-(--divider-hover)"
          data-testid="sidebar-resize-indicator"
        ></div>
      </div>
      <!-- 提示气泡：胶囊下方、朝聊天区一侧弹出（hover 即出，拖拽中隐藏）。
           pointer-events-none，不挡聊天区的点击。 -->
      <div
        class="pointer-events-none absolute top-[calc(50%_+_2.5rem)] left-full z-10 ml-3 flex flex-col
          gap-0.5 rounded-xl border bg-popover px-3 py-2 whitespace-nowrap shadow-md opacity-0
          transition-opacity duration-200 group-hover/resize:opacity-100 group-hover/resize:delay-500"
        style:visibility={sidebarLayout.dragging ? 'hidden' : undefined}
        aria-hidden="true"
      >
        <span class="text-sm">{t('sidebar.resizeHandleDrag')}</span>
        <span class="text-sm text-muted-foreground">{t('sidebar.resizeHandleReset')}</span>
      </div>
    </div>
  {/if}
</Sidebar.Root>

<!-- 「新增」面板内容（宽窄两形态共用）：搜索过滤 + 两个新建入口 + Bot 名单。 -->
{#snippet plusPanelBody()}
  <Input
    bind:value={plusQuery}
    placeholder={t('sidebar.startChatPlaceholder')}
    class="h-9 rounded-full bg-muted/50 text-sm"
    data-testid="start-chat-search"
  />
  <div class="mt-2 space-y-0.5">
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
      onclick={() => void startConversationalCreate()}
      data-testid="start-chat-create-bot"
    >
      <span class="flex size-7 items-center justify-center rounded-full bg-muted">
        <Plus class="size-4" />
      </span>
      {t('sidebar.createBot')}
    </button>
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
      onclick={openCreateProject}
      data-testid="start-chat-create-project"
    >
      <span class="flex size-7 items-center justify-center rounded-full bg-muted">
        <Users class="size-4" />
      </span>
      {t('sidebar.createProject')}
    </button>
    <!-- D48：从模板导入（web 端点无本地文件对话框，置灰不隐藏）。 -->
    <button
      type="button"
      class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent
        {endpointSupports('local-file-dialog') ? '' : 'cursor-not-allowed opacity-50'}"
      disabled={!endpointSupports('local-file-dialog')}
      title={endpointSupports('local-file-dialog') ? '' : t('botTemplate.desktopOnly')}
      onclick={() => (templateImportOpen = true)}
      data-testid="start-chat-import-template"
    >
      <span class="flex size-7 items-center justify-center rounded-full bg-muted">
        <FileUp class="size-4" />
      </span>
      {t('botTemplate.importEntry')}
    </button>
  </div>
  {#if plusBots.length > 0}
    <p class="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">{t('contacts.title')}</p>
    <div class="space-y-0.5 pb-1 {narrow ? '' : 'max-h-[300px] overflow-y-auto'}">
      {#each plusBots as bot (bot.id)}
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent"
          onclick={() => void openBotChat(bot.id)}
          data-testid={`start-chat-bot-${bot.id}`}
        >
          <BotAvatar
            botId={bot.id}
            name={bot.name}
            avatar={bot.avatar}
            accentColor={bot.accentColor}
            mask={bot.avatarMask}
            padding={bot.avatarPadding}
            class="size-7"
            fallbackClass="text-xs"
          />
          <span class="min-w-0 flex-1">
            <span class="block truncate">{bot.name}</span>
            {#if bot.bio.length > 0}
              <span class="block truncate text-xs text-muted-foreground">{bot.bio}</span>
            {/if}
          </span>
          <MessagesSquare class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#if plusOpen && narrow}
  <!-- 窄屏（33-narrow-layout）：全屏浮层带背景色盖住底层（像打开新页面），
       顶部拖拽带让出红绿灯，返回按钮关闭；页面级滚动（不再限 300px）。 -->
  <div
    class="app-no-drag fixed inset-0 z-50 flex flex-col bg-background"
    use:mountAboveDragRegion
    data-testid="start-chat-layer"
  >
    <div
      class="app-drag flex h-14 shrink-0 items-center gap-1 border-b {isMac
        ? 'pr-3 pl-20'
        : 'px-3'}"
    >
      <Button
        variant="ghost"
        size="icon"
        class="app-no-drag size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
        onclick={() => (plusOpen = false)}
        aria-label={t('narrow.back')}
        title={t('narrow.back')}
        data-testid="start-chat-layer-back"
      >
        <ChevronLeft class="size-5" aria-hidden="true" />
      </Button>
      <span class="text-base font-semibold">{t('sidebar.startChatTitle')}</span>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      {@render plusPanelBody()}
    </div>
  </div>
{:else if plusOpen}
  <!-- 「新增」面板（参考 Grok Bot 的开始对话面板）：新建只有一个入口 -->
  <button
    type="button"
    class="app-no-drag fixed inset-0 z-40 cursor-default"
    aria-label={t('common.close')}
    onclick={() => (plusOpen = false)}
    use:mountAboveDragRegion
    data-testid="start-chat-backdrop"
  ></button>
  <div
    class="app-no-drag fixed top-3 z-50 w-[26rem] max-w-[calc(100vw-var(--sidebar-width,16rem)-1.5rem)] rounded-2xl border bg-popover p-2 shadow-xl"
    style="left: calc(var(--sidebar-width, 16rem) + 0.75rem);"
    use:mountAboveDragRegion
    data-testid="start-chat-panel"
  >
    {@render plusPanelBody()}
  </div>
{/if}

{#if contextMenu}
  <!-- 条目右键菜单（参考 Grok Bot）：管理操作收在这里 -->
  <button
    type="button"
    class="app-no-drag fixed inset-0 z-40 cursor-default"
    aria-label={t('common.close')}
    onclick={closeContextMenu}
    use:mountAboveDragRegion
    oncontextmenu={(event) => {
      event.preventDefault();
      closeContextMenu();
    }}
    data-testid="conversation-context-backdrop"
  ></button>
  <div
    class="app-no-drag fixed z-50 w-52 rounded-xl border bg-popover p-1 shadow-xl"
    style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
    role="menu"
    aria-label={contextConversation ? nameOf(contextConversation) : undefined}
    use:mountAboveDragRegion
    data-testid={`conversation-context-${contextMenu.conversationId}`}
  >
    {#if !contextIsButler}
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={moveMenu !== null}
        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent
          {moveMenu !== null ? 'bg-accent' : ''}"
        onpointerenter={(event) => {
          if (event.currentTarget instanceof HTMLElement) openMoveMenu(event.currentTarget);
        }}
        onpointerleave={scheduleCloseMoveMenu}
        onclick={(event) => {
          if (event.currentTarget instanceof HTMLElement) openMoveMenu(event.currentTarget);
        }}
        data-testid="context-move-to"
      >
        <Folder class="size-3.5" />
        <span class="min-w-0 flex-1 truncate">{t('sidebar.moveTo')}</span>
        <ChevronRight class="size-3.5 text-muted-foreground" />
      </button>
    {/if}
    {#if !contextIsButler}
      {@render contextItem(
        contextPinned ? PinOff : Pin,
        contextPinned ? t('sidebar.unpin') : t('sidebar.pin'),
        togglePinFromContext,
        'context-toggle-pin',
      )}
    {/if}
    {#if contextConversation?.type === 'project'}
      {@render contextItem(
        Settings2,
        t('sidebar.projectDetail'),
        openProjectDetail,
        'context-project-settings',
      )}
    {:else if contextConversation?.bot?.status === 'active'}
      {@render contextItem(Pencil, t('sidebar.renameBot'), openRename, 'context-rename-bot')}
    {/if}
    {@render contextItem(
      Copy,
      t('sidebar.copyConversationId'),
      copyConversationId,
      'context-copy-id',
    )}
    {#if contextIsButler}
      {@render contextItem(
        Trash2,
        t('chats.deleteConversation'),
        deleteFromContext,
        'context-delete-conversation',
        true,
      )}
    {:else}
      {@render contextItem(
        Archive,
        t('sidebar.removeFromList'),
        () => void removeFromContext(),
        'context-remove-conversation',
      )}
    {/if}
  </div>
  {#if moveMenu && !contextIsButler}
    <div
      class="app-no-drag fixed z-50 w-52 rounded-xl border bg-popover p-1 shadow-xl"
      style="left: {moveMenu.x}px; top: {moveMenu.y}px;"
      role="group"
      aria-label={t('sidebar.moveTo')}
      use:mountAboveDragRegion
      onpointerenter={cancelCloseMoveMenu}
      onpointerleave={scheduleCloseMoveMenu}
      data-testid="conversation-move-menu"
    >
      <div class="max-h-80 overflow-y-auto">
        {#each sectionLayout.groups as group (group.id)}
          {@const current = contextSectionId === group.id}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
            onclick={() => moveConversationTo(group.id)}
            data-current={current ? 'true' : undefined}
            data-testid={group.id === UNASSIGNED_SECTION_ID
              ? 'context-move-unassigned'
              : `context-move-section-${group.id}`}
          >
            {#if current}
              <Check class="size-3.5 shrink-0" />
            {:else}
              <Folder class="size-3.5 shrink-0" />
            {/if}
            <span class="min-w-0 flex-1 truncate">{sectionLabel(group.id)}</span>
          </button>
        {/each}
      </div>
      <div class="my-1 h-px bg-border"></div>
      {#if creatingSection}
        <form class="flex items-center gap-1 px-1 py-1" onsubmit={confirmCreateSection}>
          <Input
            bind:value={sectionDraft}
            bind:ref={sectionNameInput}
            maxlength={SECTION_NAME_MAX}
            placeholder={t('sidebar.sectionNamePlaceholder')}
            class="h-8 min-w-0 flex-1 text-sm"
            data-testid="section-name-input"
          />
          <button
            type="submit"
            class="shrink-0 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
            data-testid="section-create-confirm"
          >
            {t('sidebar.createSectionConfirm')}
          </button>
        </form>
      {:else}
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
          onclick={beginCreateSection}
          data-testid="context-create-section"
        >
          <FolderPlus class="size-3.5" />
          {t('sidebar.createSection')}
        </button>
      {/if}
    </div>
  {/if}
{/if}

{#if sectionMenu}
  <button
    type="button"
    class="app-no-drag fixed inset-0 z-40 cursor-default"
    aria-label={t('common.close')}
    tabindex="-1"
    onclick={() => closeSectionMenu(false)}
    use:mountAboveDragRegion
    oncontextmenu={(event) => {
      event.preventDefault();
      closeSectionMenu(false);
    }}
    data-testid="section-context-backdrop"
  ></button>
  <div
    bind:this={sectionMenuEl}
    class="app-no-drag fixed z-50 w-44 rounded-xl border bg-popover p-1 shadow-xl"
    style="left: {sectionMenu.x}px; top: {sectionMenu.y}px;"
    role="menu"
    tabindex="-1"
    aria-label={sectionLabel(sectionMenu.sectionId)}
    onkeydown={onSectionMenuKeydown}
    use:mountAboveDragRegion
    data-testid={`section-context-${sectionMenu.sectionId}`}
  >
    {@render contextItem(Pencil, t('sidebar.sectionRename'), startRenameFromMenu, 'section-rename')}
    {@render contextItem(
      ArrowUp,
      t('sidebar.sectionMoveUp'),
      () => moveSectionStep('up'),
      'section-move-up',
      false,
      sectionMenuUp === undefined,
    )}
    {@render contextItem(
      ArrowDown,
      t('sidebar.sectionMoveDown'),
      () => moveSectionStep('down'),
      'section-move-down',
      false,
      sectionMenuDown === undefined,
    )}
    {@render contextItem(
      Trash2,
      t('sidebar.sectionDelete'),
      deleteSectionFromMenu,
      'section-delete',
      true,
    )}
  </div>
{/if}

<BotTemplateImportDialog bind:open={templateImportOpen} />

<style>
  /* 分组拖拽的浮动副本挂在 body 下，组件作用域样式够不到；克隆携带 item 的
     data-sidebar-section 属性，据此刻定只作用于左栏分组（不影响备忘 / 看板的克隆）。
     副本与侧栏同底色、去掉边框与焦点环，否则行内容透在下层列表上难以辨认；
     阴影只用来标出副本范围。 */
  :global(#dnd-action-dragged-el[data-sidebar-section]) {
    /* mac vibrancy / win 亚克力下 --sidebar 自带 alpha（65% / 85%），直接当底色
       克隆仍是半透明的。把它经背景图叠在不透明的 --background 上，合成出与侧栏
       同色但不透明的底；非材质平台 --sidebar 本就不透明，合成结果不变。
       两处都要 !important：库会把原元素的计算样式（背景等）内联到克隆上。 */
    background-color: var(--background) !important;
    background-image: linear-gradient(var(--sidebar), var(--sidebar)) !important;
    opacity: 1 !important;
    border: none !important;
    outline: none !important;
    border-radius: 0.75rem;
    box-shadow:
      0 4px 6px -1px rgb(0 0 0 / 0.1),
      0 2px 4px -2px rgb(0 0 0 / 0.1);
    overflow: hidden;
  }
</style>

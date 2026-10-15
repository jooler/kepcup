<script lang="ts">
  import { tick, type Component } from 'svelte';
  import {
    ArrowDown,
    ArrowUp,
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
    ChevronLeft,
    ChevronRight,
    Folder,
    FolderPlus,
    Check,
    type LucideIcon,
  } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { stripMarkdown } from '$lib/strip-markdown';
  import { shell } from '$lib/stores/shell.svelte';
  import { chat, type ConversationView } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { createBotConversational } from '$lib/features/bot-setup';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import GroupAvatarStack from '$lib/avatars/GroupAvatarStack.svelte';
  import UserAvatar from '$lib/avatars/UserAvatar.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import ExtensionCenterDialog from '$lib/features/extension-center/ExtensionCenterDialog.svelte';
  import { isButlerConversation } from './butler';
  import { sidebarDialogs } from './sidebar-dialogs.svelte';
  import { sidebarSections } from './sidebar-sections.svelte';
  import { workbenchIconDarkUrl, workbenchIconLightUrl } from './sidebar-icons';
  import {
    UNASSIGNED_SECTION_ID,
    SECTION_NAME_MAX,
    dropBeforeId,
    isSectionMoveNoop,
    layoutSidebarSections,
    sectionIdOf,
    sectionStepTarget,
  } from './sidebar-sections';
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
   * 垂直居中）。管理操作（移动到分组 / 重命名 / 复制会话 id / 群设置 / 删除）
   * 收进右键上下文菜单，不再有常驻「…」按钮。
   * 新建只保留「+」面板里的对话式新建和新建群聊。搜索按钮打开全局
   * 搜索弹框（Bot/会话/设置条目，Cmd+K 同效；搜索层与侧栏触发的模态对话框挂在 App 根）。设置与通讯录打开全局设置弹框。
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
  const isMac = /Mac/i.test(navigator.platform);

  /** 图标模式（拖到最小宽 = 红绿灯占位）：顶部搜索隐藏、「+」落底部、对话只显示头像。 */
  const narrow = $derived(narrowLayout.narrow);
  const collapsed = $derived(narrow ? false : sidebarLayout.collapsed);

  /** 高亮的对话行：只在对话视图里有（`mainView === 'chats' && id === currentId`，组群输入时无）。 */
  const activeConversationId = $derived(shell.workbenchShown ? null : chat.activeId);
  const workbenchActive = $derived(shell.workbenchShown);

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
  /** 分组标题拖拽。beforeId 为 null 表示落到末尾。 */
  let sectionDrag = $state<{ id: string; beforeId: string | null } | null>(null);
  let sectionDragMoved = false;
  let sectionDragSeq = 0;
  const contextConversation = $derived(
    contextMenu === null
      ? null
      : (chat.conversations.find((c) => c.id === contextMenu?.conversationId) ?? null),
  );

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

  /** 条目标题（图标模式的 hover 提示同源）：群聊用标题，私聊用 Bot 名。 */
  function nameOf(conversation: ConversationView): string {
    return conversation.type === 'group'
      ? (conversation.title ??
          (conversation.setupState === 'creating'
            ? t('groupSetup.creatingTitle')
            : conversation.id))
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

  async function openCreateGroup(): Promise<void> {
    plusOpen = false;
    chat.beginGroupCompose();
  }

  /**
   * 管家不进入任何分组，单独排在列表最前。其余对话保持 store 的时间顺序，
   * 再按分组装桶。
   */
  const butlerConversations = $derived(
    chat.conversations.filter((conversation) => isButlerConversation(conversation)),
  );
  const sectionLayout = $derived(
    layoutSidebarSections(
      chat.conversations.filter((conversation) => !isButlerConversation(conversation)),
      sidebarSections.state,
    ),
  );
  /**
   * 图标模式没有组名可点，折叠会把对话藏起来且无法展开，所以这里忽略折叠，
   * 只沿用分组顺序。管家仍在最前。
   */
  const iconConversations = $derived([
    ...butlerConversations,
    ...sectionLayout.groups.flatMap((group) => group.conversations),
  ]);
  const contextIsButler = $derived(isButlerConversation(contextConversation ?? undefined));

  // 管家不能留在分组里。之前若被移入过，这里把归属清掉（不展开「未指定」：
  // 这不是用户的移动操作）。
  $effect(() => {
    const assigned = butlerConversations.filter(
      (conversation) => sidebarSections.state.assignments[conversation.id] !== undefined,
    );
    for (const conversation of assigned) {
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

  function dropIsNoop(beforeId: string | null, draggingId: string): boolean {
    return isSectionMoveNoop(sidebarSections.state.order, draggingId, beforeId);
  }

  function onSectionPointerDown(event: PointerEvent, sectionId: string): void {
    if (event.button !== 0 || event.ctrlKey || renamingSectionId !== null) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    sectionDragMoved = false;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // 指针已松开时捕获会失败，退回普通点击。
    }

    const finish = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      if (sectionDragMoved && sectionDrag !== null) {
        sidebarSections.move(sectionDrag.id, sectionDrag.beforeId);
      }
      sectionDrag = null;
      // click 紧跟 pointerup。拖过之后吞掉这一下；若浏览器没派发 click，稍后放行下一次点击。
      if (sectionDragMoved) {
        const seq = (sectionDragSeq += 1);
        setTimeout(() => {
          if (sectionDragSeq === seq) sectionDragMoved = false;
        }, 50);
      }
    };
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      if (!sectionDragMoved && Math.abs(ev.clientY - startY) < 4) return;
      sectionDragMoved = true;
      const scroller = target.closest('[data-slot="sidebar-content"]');
      if (scroller instanceof HTMLElement) {
        const bounds = scroller.getBoundingClientRect();
        if (ev.clientY < bounds.top + 28) scroller.scrollTop -= 10;
        else if (ev.clientY > bounds.bottom - 28) scroller.scrollTop += 10;
      }
      const rows = [...document.querySelectorAll<HTMLElement>('[data-section-header]')].map(
        (header) => {
          const rect = header.getBoundingClientRect();
          return { id: header.dataset.sectionId ?? '', top: rect.top, bottom: rect.bottom };
        },
      );
      sectionDrag = { id: sectionId, beforeId: dropBeforeId(rows, ev.clientY, sectionId) };
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  }

  function onSectionClick(sectionId: string): void {
    if (sectionDragMoved) {
      sectionDragMoved = false;
      sectionDragSeq += 1;
      return;
    }
    sidebarSections.toggle(sectionId);
  }

  function openGroupSettings(): void {
    if (!contextMenu) return;
    sidebarDialogs.openGroupSettings(contextMenu.conversationId);
    closeContextMenu();
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

<!-- 会话头像（展开/图标两模式共用）：群聊用成员头像堆叠，私聊用 Bot 头像。 -->
{#snippet conversationAvatar(conversation: ConversationView)}
  {#if conversation.type === 'group'}
    <GroupAvatarStack members={conversation.memberPreviews ?? []} class="size-11" />
  {:else}
    <BotAvatar
      botId={conversation.directBotId ?? conversation.id}
      name={conversation.bot?.name ?? conversation.directBotId ?? '?'}
      avatar={conversation.bot?.avatar ?? null}
      class="size-11"
      fallbackClass="text-base"
      testId="conversation-avatar"
    />
  {/if}
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
           亮色相对侧栏（0.985）压到 0.93。暗色侧栏在 macOS 上是半透明
           毛玻璃，提亮到 0.32 会和透出的底叠在一起，所以改压到 0.16，
           比侧栏底色 0.205 再暗一档。 -->
      <Sidebar.MenuButton
        class="h-auto min-w-0 flex-1 cursor-pointer gap-2 rounded-lg p-1 data-active:bg-[oklch(0.98_0_0)]
          dark:data-active:bg-[oklch(0.5_0_0)] [&_svg]:size-auto"
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
  class="relative {sidebarLayout.transitionClass}"
  data-testid="sidebar"
>
  <!-- 头部：拖拽区 + 搜索/新增（macOS 红绿灯让出左侧空间）；
       图标模式下按钮整体隐藏，只剩红绿灯拖拽区。 -->
  <!-- relative z-50：面板 backdrop（fixed z-40）盖不住头部，「+」在面板开着时仍可点。 -->
  <div
    class="app-drag relative z-50 flex h-14 shrink-0 items-center gap-2
      {isMac ? 'pr-2 pl-20' : 'px-2'}"
  >
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

  <Sidebar.Content class="px-2">
    <Sidebar.Group>
      <Sidebar.GroupContent>
        {#if !narrow}
          <!-- 工作台入口（D90）：管家之上，不参与分组；图标模式只剩图标。 -->
          {#if collapsed}
            <Sidebar.Menu class="items-center">
              <Sidebar.MenuItem class="w-auto">
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
                      transition-colors hover:bg-sidebar-accent data-active:bg-[oklch(0.93_0_0)]
                      dark:data-active:bg-[oklch(0.16_0_0)]"
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
                  class="h-auto min-w-0 flex-1 cursor-pointer gap-2 rounded-lg py-2 pr-4 pl-2 data-active:bg-[oklch(0.98_0_0)]
                    dark:data-active:bg-[oklch(0.5_0_0)] [&_svg]:size-auto"
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
            class="mx-3 my-2 h-px shrink-0 bg-foreground/20 dark:bg-foreground/25"
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
          <Sidebar.Menu class="items-center">
            {#each iconConversations as conversation (conversation.id)}
              <Sidebar.MenuItem class="w-auto">
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl
                      transition-colors hover:bg-sidebar-accent data-active:bg-[oklch(0.93_0_0)]
                      dark:data-active:bg-[oklch(0.16_0_0)]"
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
        {:else}
          {#if sectionLayout.showHeaders && butlerConversations.length > 0}
            <!-- 管家不归属任何分组，固定在分组标题之上。 -->
            <Sidebar.Menu class="mb-4">
              {#each butlerConversations as conversation (conversation.id)}
                {@render conversationRow(conversation)}
              {/each}
            </Sidebar.Menu>
          {/if}
          {#each sectionLayout.groups as group, groupIndex (group.id)}
            {@const rows = conversationsInGroup(group.id, group.conversations)}
            <div class="relative {sectionLayout.showHeaders && groupIndex > 0 ? 'mt-4' : ''}">
              {#if sectionLayout.showHeaders}
                {#if sectionDrag !== null && sectionDrag.beforeId === group.id && !dropIsNoop(sectionDrag.beforeId, sectionDrag.id)}
                  <div
                    class="pointer-events-none absolute inset-x-2 top-0 z-10 h-0.5 -translate-y-1/2 rounded-full bg-foreground/70"
                    data-testid="section-drop-line"
                  ></div>
                {/if}
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
                  <button
                    type="button"
                    class="flex w-full touch-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground select-none hover:bg-sidebar-accent hover:text-foreground
                      {sectionDrag?.id === group.id
                      ? 'cursor-grabbing opacity-50'
                      : 'cursor-pointer'}"
                    aria-expanded={!group.collapsed}
                    data-section-header
                    data-section-id={group.id}
                    data-testid={`section-header-${group.id}`}
                    onclick={() => onSectionClick(group.id)}
                    onpointerdown={(event) => onSectionPointerDown(event, group.id)}
                    oncontextmenu={(event) => openSectionMenu(event, group.id)}
                  >
                    <span class="min-w-0 flex-1 truncate">{sectionLabel(group.id)}</span>
                    {#if group.collapsed}
                      <span class="shrink-0 tabular-nums" data-testid={`section-count-${group.id}`}>
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
              {#if sectionLayout.showHeaders && groupIndex === sectionLayout.groups.length - 1 && sectionDrag !== null && sectionDrag.beforeId === null && !dropIsNoop(null, sectionDrag.id)}
                <div
                  class="pointer-events-none absolute inset-x-2 bottom-0 z-10 h-0.5 translate-y-1/2 rounded-full bg-foreground/70"
                  data-testid="section-drop-line"
                ></div>
              {/if}
            </div>
          {/each}
        {/if}
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

  <!-- 底部 footer 窄屏隐藏：扩展中心（底部 tab「扩展」）与用户菜单（「我」页）
       移到了全局 tab 栏。 -->
  {#if !narrow}
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
              rounded-full text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onclick={() => shell.openExtensionCenter()}
            aria-label={t('sidebar.extensionCenter')}
            title={t('sidebar.extensionCenter')}
            data-testid="extension-center-button"
          >
            <Blocks class="size-5" aria-hidden="true" />
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <button
                type="button"
                class="z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-accent/50"
                aria-label={t('menu.settings')}
                title={t('sidebar.userName')}
                data-testid="user-menu-trigger"
              >
                <UserAvatar class="size-10" testId="user-menu-avatar" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="top" align="center" class="min-w-40">
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
                class="z-10 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-accent/50"
                aria-label={t('menu.settings')}
                title={t('sidebar.userName')}
                data-testid="user-menu-trigger"
              >
                <UserAvatar class="size-10" testId="user-menu-avatar" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content side="top" align="start" class="min-w-40">
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
              rounded-full border border-border bg-background px-3 text-sm
              text-muted-foreground shadow-none transition-colors hover:text-foreground"
            onclick={() => shell.openExtensionCenter()}
            aria-label={t('sidebar.extensionCenter')}
            title={t('sidebar.extensionCenter')}
            data-testid="extension-center-button"
          >
            <Blocks class="size-4 shrink-0" aria-hidden="true" />
            <span class="truncate">{t('sidebar.extensionCenter')}</span>
          </button>
        </div>
      {/if}
    </Sidebar.Footer>
  {/if}

  <!-- 右缘调宽手柄：整条侧栏高度可抓；DOM 上位于头部（app-drag）之后，
       重叠处 no-drag 胜出，红绿灯旁也能拖。只承担交互，不加视觉反馈。
       窄屏下列表全宽（宽度跟窗口），无手柄。 -->
  {#if !narrow}
    <div
      class="app-no-drag absolute inset-y-0 right-0 z-50 w-1.5 cursor-col-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resizeHandle')}
      title={t('sidebar.resizeHandle')}
      onpointerdown={(event) => sidebarLayout.startResize(event)}
      ondblclick={() => sidebarLayout.resetWidth()}
      data-testid="sidebar-resize-handle"
    ></div>
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
      onclick={openCreateGroup}
      data-testid="start-chat-create-group"
    >
      <span class="flex size-7 items-center justify-center rounded-full bg-muted">
        <Users class="size-4" />
      </span>
      {t('sidebar.createGroup')}
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
    {#if contextConversation?.type === 'group' && contextConversation.setupState !== 'creating'}
      {@render contextItem(
        Settings2,
        t('group.settings'),
        openGroupSettings,
        'context-group-settings',
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
    {@render contextItem(
      Trash2,
      t('chats.deleteConversation'),
      deleteFromContext,
      'context-delete-conversation',
      true,
    )}
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

<ExtensionCenterDialog bind:open={shell.extensionCenterOpen} />

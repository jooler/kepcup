<script lang="ts">
  import type { Component } from 'svelte';
  import {
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
    type LucideIcon,
  } from '@lucide/svelte';
  import type { Bot, BotProfile } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { stripMarkdown } from '$lib/strip-markdown';
  import { shell } from '$lib/stores/shell.svelte';
  import { chat, type ConversationView } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { onboarding } from '$lib/stores/onboarding.svelte';
  import { createBotConversational, emptyProfile } from '$lib/features/bot-setup';
  import * as Avatar from '$lib/components/ui/avatar';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Sidebar from '$lib/components/ui/sidebar';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import GlobalSearchDialog from '$lib/features/search/GlobalSearchDialog.svelte';
  import SkillMarketDialog from '$lib/features/skill-market/SkillMarketDialog.svelte';
  import GroupSettingsDialog from '$lib/features/chats/GroupSettingsDialog.svelte';
  import BotProfileForm from '$lib/features/bot-panel/BotProfileForm.svelte';
  import { sidebarLayout } from './sidebar-layout.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip';

  /**
   * 左栏（参考 Grok Bot）：顶部只有搜索与新增，对话直接平铺列出；条目是
   * 头像 + 名称 + 最后一条消息的单行预览，管理操作（重命名/复制会话 id/
   * 群设置/删除会话）收进右键上下文菜单，不再有常驻「…」按钮。新建只保留
   * 「+」一个入口（对话式新建 + 高级新建）。搜索按钮打开全局搜索弹框
   * （Bot/会话/设置条目，Cmd+K 同效）。设置与通讯录打开全局设置弹框。
   *
   * 宽度可拖拽调节（右缘手柄，sidebar-layout）：收窄到 macOS 红绿灯占位宽
   * 即图标模式——顶部搜索隐藏、「+」移到底部（与参考一致），对话只剩头像、
   * 名称/预览走 hover 提示，底部技能市场收成图标。
   */
  const isMac = /Mac/i.test(navigator.platform);

  /** 图标模式（拖到最小宽 = 红绿灯占位）：顶部搜索隐藏、「+」落底部、对话只显示头像。 */
  const collapsed = $derived(sidebarLayout.collapsed);

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

  let searchOpen = $state(false);
  let plusOpen = $state(false);
  let plusQuery = $state('');
  let groupSettingsOpen = $state(false);
  let groupSettingsId = $state<string | null>(null);

  /** 右键上下文菜单（视口坐标 + 目标会话）。 */
  let contextMenu = $state<{ x: number; y: number; conversationId: string } | null>(null);
  const contextConversation = $derived(
    contextMenu === null
      ? null
      : (chat.conversations.find((c) => c.id === contextMenu?.conversationId) ?? null),
  );

  let renameOpen = $state(false);
  let renameBot = $state<Bot | null>(null);
  let renameName = $state('');

  let formCreateOpen = $state(false);
  let draftProfile = $state<BotProfile>(emptyProfile());

  let deleteTargetId = $state<string | null>(null);
  let deleteTargetName = $derived.by(() => {
    const conversation = chat.conversations.find((c) => c.id === deleteTargetId);
    if (conversation === undefined) return deleteTargetId ?? '';
    return conversation.type === 'group'
      ? (conversation.title ?? deleteTargetId ?? '')
      : (conversation.bot?.name ?? conversation.directBotId ?? '');
  });

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
    searchOpen = true;
  }

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

  function openFormCreate(): void {
    plusOpen = false;
    draftProfile = emptyProfile();
    formCreateOpen = true;
  }

  async function createWithForm(): Promise<void> {
    if (draftProfile.identity.name.trim().length === 0) return;
    const bot = await contacts.create($state.snapshot(draftProfile) as BotProfile);
    formCreateOpen = false;
    toast.success(t('settings.saved'));
    await chat.openDirect(bot.id);
  }

  async function openCreateGroup(): Promise<void> {
    plusOpen = false;
    // 对话内群创建（19/D60）：直接创建「创建中」的群并进入，四问以卡片收集。
    await chat.createGroupViaSetup();
  }

  async function confirmDelete(): Promise<void> {
    const id = deleteTargetId;
    deleteTargetId = null;
    if (!id) return;
    const wasButlerChat = isButlerConversation(chat.conversations.find((c) => c.id === id));
    await chat.deleteConversation(id);
    // 管家（D70）置顶入口不能消失：删的只是聊天记录，随即重开一个空私聊。
    if (wasButlerChat) await core.call('butler.ensure', {});
  }

  /** 管家（D70）的私聊：侧栏固定置顶。 */
  function isButlerConversation(conversation: ConversationView | undefined): boolean {
    return conversation?.type === 'direct' && conversation.bot?.systemRole === 'butler';
  }

  /** 侧栏顺序：管家私聊置顶，其余保持 store 的时间顺序。 */
  const orderedConversations = $derived.by(() => {
    const butler = chat.conversations.filter((c) => isButlerConversation(c));
    if (butler.length === 0) return chat.conversations;
    return [...butler, ...chat.conversations.filter((c) => !isButlerConversation(c))];
  });

  function openContextMenu(event: MouseEvent, conversationId: string): void {
    event.preventDefault();
    contextMenu = {
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 180),
      conversationId,
    };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function openGroupSettings(): void {
    if (!contextMenu) return;
    groupSettingsId = contextMenu.conversationId;
    groupSettingsOpen = true;
    closeContextMenu();
  }

  function openRename(): void {
    const conversation = contextConversation;
    const bot = conversation?.bot ?? null;
    if (!bot || bot.status !== 'active') {
      closeContextMenu();
      return;
    }
    renameBot = bot;
    renameName = bot.name;
    closeContextMenu();
    renameOpen = true;
  }

  async function saveRename(): Promise<void> {
    const bot = renameBot;
    const name = renameName.trim();
    if (!bot || name.length === 0) return;
    const profile = structuredClone($state.snapshot(bot.profile)) as BotProfile;
    profile.identity = { ...profile.identity, name };
    await contacts.update(bot.id, profile);
    renameOpen = false;
    toast.success(t('settings.saved'));
  }

  async function copyConversationId(): Promise<void> {
    if (!contextMenu) return;
    await navigator.clipboard.writeText(contextMenu.conversationId);
    toast.success(t('sidebar.copiedConversationId'));
    closeContextMenu();
  }

  function deleteFromContext(): void {
    if (!contextMenu) return;
    deleteTargetId = contextMenu.conversationId;
    closeContextMenu();
  }
</script>

<!-- 快捷键：Cmd/Ctrl+K 打开全局搜索（设置弹框/向导开着时不叠层）；
     Escape 关闭「+」面板与右键菜单（面板开着时 Esc 优先归零，再冒泡给弹框）。 -->
<svelte:window
  onkeydown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (!searchOpen && !shell.settingsOpen && !onboarding.open) openGlobalSearch();
      return;
    }
    if (event.key !== 'Escape') return;
    if (contextMenu !== null) {
      contextMenu = null;
      return;
    }
    if (plusOpen) plusOpen = false;
  }}
/>

<!-- 右键菜单里的一行（同文件私有 snippet）。 -->
{#snippet contextItem(
  icon: LucideIcon,
  label: string,
  onclick: () => void,
  testid: string,
  destructive = false,
)}
  {@const Icon = icon as unknown as Component<{ class?: string }>}
  <button
    type="button"
    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent
      {destructive ? 'text-destructive hover:text-destructive' : ''}"
    {onclick}
    data-testid={testid}
  >
    <Icon class="size-3.5" />
    {label}
  </button>
{/snippet}

<!-- 会话头像（展开/图标两模式共用）：群聊用绿色 Users 兜底，私聊用 Bot 头像。 -->
{#snippet conversationAvatar(conversation: ConversationView)}
  {#if conversation.type === 'group'}
    <Avatar.Root class="size-10">
      <Avatar.Fallback
        data-testid="conversation-avatar"
        class="bg-emerald-600 text-primary-foreground"
      >
        <Users class="size-5" aria-hidden="true" />
      </Avatar.Fallback>
    </Avatar.Root>
  {:else}
    <BotAvatar
      botId={conversation.directBotId ?? conversation.id}
      name={conversation.bot?.name ?? conversation.directBotId ?? '?'}
      avatar={conversation.bot?.avatar ?? null}
      class="size-10"
      fallbackClass="text-base"
      testId="conversation-avatar"
    />
  {/if}
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
        {#if chat.conversations.length === 0}
          {#if !collapsed}
            <p class="px-3 py-2 text-xs text-muted-foreground">{t('sidebar.chatsEmpty')}</p>
          {/if}
        {:else if collapsed}
          <!-- 图标模式：只剩头像，名称/预览走 hover 提示；未读/待确认/执行中
               叠在头像角上（待确认优先于未读，都是必须看见的信号）。 -->
          <Sidebar.Menu class="items-center">
            {#each orderedConversations as conversation (conversation.id)}
              <Sidebar.MenuItem class="w-auto">
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="relative flex size-12 cursor-pointer items-center justify-center rounded-xl
                      transition-colors hover:bg-sidebar-accent data-active:bg-[oklch(0.93_0_0)]
                      dark:data-active:bg-[oklch(0.32_0_0)]"
                    data-active={chat.currentId === conversation.id ? 'true' : undefined}
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
                        class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-medium text-white"
                        title={t('sidebar.pendingSuffix')}
                        data-testid="pending-badge"
                      >
                        {permissions.pendingByConversation[conversation.id]}
                      </span>
                    {:else if (conversation.unreadCount ?? 0) > 0 && chat.currentId !== conversation.id}
                      <span
                        class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
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
                    <span class="truncate text-sm font-medium">{nameOf(conversation)}</span>
                    {#if previewOf(conversation).length > 0}
                      <span class="truncate text-xs opacity-80">{previewOf(conversation)}</span>
                    {/if}
                  </Tooltip.Content>
                </Tooltip.Root>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        {:else}
          <Sidebar.Menu>
            {#each orderedConversations as conversation (conversation.id)}
              <Sidebar.MenuItem>
                <div
                  class="group/conversation flex w-full items-center"
                  role="presentation"
                  oncontextmenu={(event) => openContextMenu(event, conversation.id)}
                  data-testid={`conversation-row-${conversation.id}`}
                >
                  <!-- [&_svg]:size-auto 解开 MenuButton 基础样式 [&_svg]:size-4 的钉死：
                       否则预置头像 svg 被压成 16px，盖过自身的 size-full。
                       激活态背景本地覆盖：--sidebar-accent 与 hover 共用、对比不够，
                       亮色压暗/暗色提亮一档（侧栏底色 0.985/0.205）。 -->
                  <Sidebar.MenuButton
                    class="h-auto min-w-0 flex-1 cursor-pointer gap-2 rounded-lg py-2 pr-4 pl-2 data-active:bg-[oklch(0.93_0_0)]
                      dark:data-active:bg-[oklch(0.32_0_0)] [&_svg]:size-auto"
                    isActive={chat.currentId === conversation.id}
                    onclick={() => void selectConversation(conversation.id)}
                    data-testid={`conversation-item-${conversation.id}`}
                  >
                    {@render conversationAvatar(conversation)}
                    <span class="grid min-w-0 flex-1 gap-0.5 text-left leading-tight">
                      <span class="flex items-center justify-between gap-1">
                        <span class="truncate text-sm font-medium" data-testid="conversation-name">
                          {nameOf(conversation)}
                        </span>
                      </span>
                      <!-- min-h-4：没有消息时也占住一行的视觉高度，保证条目高度统一。 -->
                      <span
                        class="flex min-h-4 min-w-0 items-center gap-1 text-xs text-muted-foreground"
                      >
                        {#if (conversation.unreadCount ?? 0) > 0 && chat.currentId !== conversation.id}
                          <span
                            class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
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
                            class="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-medium text-white"
                            title={t('sidebar.pendingSuffix')}
                            data-testid="pending-badge"
                          >
                            {permissions.pendingByConversation[conversation.id]}
                          </span>
                        {/if}
                        <span class="truncate" data-testid="conversation-preview">
                          {previewOf(conversation)}
                        </span>
                      </span>
                    </span>
                  </Sidebar.MenuButton>
                </div>
              </Sidebar.MenuItem>
            {/each}
          </Sidebar.Menu>
        {/if}
      </Sidebar.GroupContent>
    </Sidebar.Group>
  </Sidebar.Content>

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
          onclick={() => shell.openSkillMarket()}
          aria-label={t('sidebar.skillMarket')}
          title={t('sidebar.skillMarket')}
          data-testid="skill-market-button"
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
              <Avatar.Root class="size-10">
                <Avatar.Fallback class="text-xs">{t('sidebar.userFallback')}</Avatar.Fallback>
              </Avatar.Root>
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
              <Avatar.Root class="size-10">
                <Avatar.Fallback class="text-xs">{t('sidebar.userFallback')}</Avatar.Fallback>
              </Avatar.Root>
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
          onclick={() => shell.openSkillMarket()}
          aria-label={t('sidebar.skillMarket')}
          title={t('sidebar.skillMarket')}
          data-testid="skill-market-button"
        >
          <Blocks class="size-4 shrink-0" aria-hidden="true" />
          <span class="truncate">{t('sidebar.skillMarket')}</span>
        </button>
      </div>
    {/if}
  </Sidebar.Footer>

  <!-- 右缘调宽手柄：整条侧栏高度可抓；DOM 上位于头部（app-drag）之后，
       重叠处 no-drag 胜出，红绿灯旁也能拖。只承担交互，不加视觉反馈。 -->
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
</Sidebar.Root>

{#if plusOpen}
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
        onclick={openFormCreate}
        data-testid="bot-create-form"
      >
        <span class="flex size-7 items-center justify-center rounded-full bg-muted">
          <Pencil class="size-4" />
        </span>
        {t('contacts.advancedCreate')}
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        onclick={openCreateGroup}
        disabled={contacts.bots.length === 0}
        title={contacts.bots.length === 0 ? t('sidebar.botsEmpty') : undefined}
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
      <div class="max-h-[300px] space-y-0.5 overflow-y-auto pb-1">
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
    use:mountAboveDragRegion
    data-testid={`conversation-context-${contextMenu.conversationId}`}
  >
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
{/if}

<GroupSettingsDialog conversationId={groupSettingsId ?? ''} bind:open={groupSettingsOpen} />
<GlobalSearchDialog bind:open={searchOpen} />
<SkillMarketDialog bind:open={shell.skillMarketOpen} />

<Dialog
  open={deleteTargetId !== null}
  onOpenChange={(open) => (deleteTargetId = open ? deleteTargetId : null)}
>
  <DialogContent class="max-w-sm" data-testid="conversation-delete-dialog">
    <DialogHeader>
      <DialogTitle>{t('chats.deleteConversationTitle', { name: deleteTargetName })}</DialogTitle>
    </DialogHeader>
    <p class="text-sm text-muted-foreground">{t('chats.deleteConversationBody')}</p>
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (deleteTargetId = null)}
        data-testid="conversation-delete-cancel"
      >
        {t('contacts.cancel')}
      </Button>
      <Button
        variant="destructive"
        onclick={confirmDelete}
        data-testid="conversation-delete-confirm"
      >
        {t('chats.deleteConversation')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<Dialog bind:open={renameOpen}>
  <DialogContent class="max-w-sm" data-testid="bot-rename-dialog">
    <DialogHeader>
      <DialogTitle>{t('sidebar.renameBot')}</DialogTitle>
    </DialogHeader>
    <div class="grid gap-1.5">
      <label class="text-sm" for="bot-rename-input">{t('contacts.name')}</label>
      <Input
        id="bot-rename-input"
        bind:value={renameName}
        placeholder={t('contacts.namePlaceholder')}
        data-testid="bot-rename-input"
      />
    </div>
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => (renameOpen = false)}
        data-testid="bot-rename-cancel"
      >
        {t('contacts.cancel')}
      </Button>
      <Button
        onclick={() => void saveRename()}
        disabled={renameName.trim().length === 0}
        data-testid="bot-rename-save"
      >
        {t('settings.save')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<Dialog bind:open={formCreateOpen}>
  <DialogContent
    class="flex max-h-[85vh] max-w-xl flex-col overflow-hidden"
    data-testid="bot-create-dialog"
  >
    <DialogHeader class="shrink-0">
      <DialogTitle>{t('contacts.advancedCreate')}</DialogTitle>
    </DialogHeader>
    <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <BotProfileForm bind:profile={draftProfile} />
    </div>
    <DialogFooter class="shrink-0 pt-2">
      <Button
        variant="outline"
        onclick={() => (formCreateOpen = false)}
        data-testid="bot-create-cancel"
      >
        {t('contacts.cancel')}
      </Button>
      <Button
        onclick={createWithForm}
        disabled={draftProfile.identity.name.trim().length === 0}
        data-testid="bot-create-save"
      >
        {t('contacts.create')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

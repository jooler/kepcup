<script lang="ts">
  import {
    Archive,
    Ban,
    Check,
    MessagesSquare,
    Moon,
    RotateCcw,
    Search,
    Trash2,
    UserMinus,
    UserPlus,
    X,
    type LucideIcon,
  } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { Bot, Conversation, TeamFriendRequestView, TeamMember } from '@kepcup/shared';
  import { isArchivedConversation } from '@kepcup/shared';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { teamContext } from '$lib/features/team/team-context.svelte';
  import { canRequestFriend, friends as friendsStore } from '$lib/features/team/friends.svelte';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import MemberAvatar from '$lib/features/team/MemberAvatar.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import ProjectAvatarStack from '$lib/avatars/ProjectAvatarStack.svelte';
  import { Button } from '$lib/components/ui/button';

  /** 卡片按钮里的图标组件（只用到 class 与 aria-hidden）。 */
  type CardIcon = Component<{ class?: string; 'aria-hidden'?: 'true' | 'false' }>;
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 设置弹框「通讯录」分组：Bot 名册 + 好友栏（团队上下文）+ 项目组名册。
   * 好友栏是 D129v2 的微信式通讯录：好友卡 / 搜索用户名加好友 / 好友申请
   * （同意 / 拒绝 / 撤回；拒绝后可就地拉黑）+ 已拉黑小节；顶部固定「我」
   * （自我会话）。非团队上下文不渲染。项目组也在这里留条目：从对话列表
   * 移除（归档）后内容全留，可随时恢复。
   */
  let deleteTarget = $state<Bot | null>(null);
  let deletePreview = $state({
    conversations: 0,
    messages: 0,
    ledProjects: [] as Array<{ id: string; title: string | null }>,
  });
  let deleting = $state(false);

  const projects = $derived(contacts.projects);
  const activeProjects = $derived(projects.filter((p) => !isArchivedConversation(p)));
  const archivedProjects = $derived(projects.filter((p) => isArchivedConversation(p)));

  /** 团队上下文（web 团队端点）的好友栏开关。 */
  const teamActive = $derived(teamContext.active);
  const selfMember = $derived(contacts.self);

  /**
   * 桌面融合视图的团队名册切片（T7，62.04 §1 双源名册）：每个已融合服务器
   * 一栏（与 web 端点的好友栏同一呈现，标题带服务器名）。
   * 断开时切片 connected=false——栏显示「未连接」占位，不伪造数据。
   */
  const teamSlices = $derived(
    Object.values(contacts.teamSources).sort((a, b) => a.serverHash.localeCompare(b.serverHash)),
  );

  // --- 好友搜索与申请（web 本地与融合来源互斥出现，共用一份搜索状态） ---------

  let friendSearchQuery = $state('');
  let friendSearchSource = $state<SourceId>('local');
  let friendSearchResults = $state<TeamMember[]>([]);
  let friendSearching = $state(false);

  async function searchMembers(source: SourceId): Promise<void> {
    const query = friendSearchQuery.trim();
    friendSearchSource = source;
    if (query.length === 0) {
      friendSearchResults = [];
      return;
    }
    friendSearching = true;
    try {
      friendSearchResults = await friendsStore.search(source, query);
    } finally {
      friendSearching = false;
    }
  }

  async function sendFriendRequest(source: SourceId, member: TeamMember): Promise<void> {
    const handle = member.username ?? member.id;
    try {
      await friendsStore.request(source, handle);
      toast.success(t('friends.requestSent', { name: member.displayName }));
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.requestFailed')));
    }
  }

  async function acceptFriend(source: SourceId, requestId: string): Promise<void> {
    try {
      await friendsStore.accept(source, requestId);
      toast.success(t('friends.accepted'));
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    }
  }

  /**
   * 已拒绝的申请（2026-11，本会话本地保留）：refresh 后 pending 里已无此条，
   * 行转为「已拒绝」提示 + 拉黑入口；拉黑成功或对方再次发来申请后移除。
   */
  let declinedRequests = $state<Array<{ source: SourceId; requestId: string; member: TeamMember }>>(
    [],
  );

  async function declineFriend(source: SourceId, request: TeamFriendRequestView): Promise<void> {
    try {
      await friendsStore.decline(source, request.id);
      // 服务端 refresh 只会把该条移出 incoming，这里本地记住成员快照兜住行展示。
      declinedRequests = [
        ...declinedRequests.filter(
          (entry) => !(entry.source === source && entry.member.id === request.from.id),
        ),
        { source, requestId: request.id, member: request.from },
      ];
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    }
  }

  /** 拉黑已拒绝的成员：成功后本地行移除（blocked 名单以服务端 refresh 为准）。 */
  async function blockDeclinedMember(source: SourceId, memberId: string): Promise<void> {
    try {
      await friendsStore.block(source, memberId);
      declinedRequests = declinedRequests.filter(
        (entry) => !(entry.source === source && entry.member.id === memberId),
      );
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    }
  }

  /** 解除拉黑（「已拉黑」小节）；名单随 friend.unblocked 事件 refresh 收敛。 */
  async function unblockMember(source: SourceId, memberId: string): Promise<void> {
    try {
      await friendsStore.unblock(source, memberId);
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    }
  }

  async function cancelFriendRequest(source: SourceId, requestId: string): Promise<void> {
    try {
      await friendsStore.cancel(source, requestId);
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    }
  }

  /** 删除好友确认（两段式轻确认；既有 dm 保留为历史）。 */
  let removeFriendTarget = $state<{ source: SourceId; member: TeamMember } | null>(null);

  async function confirmRemoveFriend(): Promise<void> {
    const target = removeFriendTarget;
    if (target === null) return;
    try {
      await friendsStore.remove(target.source, target.member.id);
      toast.success(t('friends.removed', { name: target.member.displayName }));
    } catch (error) {
      toast.error(errorText((error as { code?: string }).code, t('friends.actionFailed')));
    } finally {
      removeFriendTarget = null;
    }
  }

  /** 点好友卡 → 打开与该成员的 dm（web 本地与团队来源统一入口）。 */
  async function openFriendDm(source: SourceId, memberId: string): Promise<void> {
    shell.closeSettings();
    if (source === 'local') {
      const conversationId = await contacts.openDm(memberId);
      if (conversationId !== null) await chat.select(conversationId);
      return;
    }
    const ref = await contacts.openTeamDm(source, memberId);
    if (ref !== null) await chat.select(ref);
  }

  /** 最近在线的单行文本（离线成员卡副行；从未在线不渲染）。 */
  function lastSeenLabel(member: { lastSeenAt?: number }): string | null {
    if (member.lastSeenAt === undefined) return null;
    return t('team.lastSeen', { time: new Date(member.lastSeenAt).toLocaleString() });
  }

  /** 点「我」= 打开自我会话（team.dm.open 无目标）。 */
  async function openSelfConversation(): Promise<void> {
    shell.closeSettings();
    const conversationId = await contacts.openDm();
    if (conversationId !== null) await chat.select(conversationId);
  }

  async function openChat(bot: Bot): Promise<void> {
    shell.closeSettings();
    await chat.openDirect(bot.id);
  }

  /** 恢复 Bot 的直聊（它被从对话列表移除过）：只回列表，不打开。 */
  async function restoreBotChat(bot: Bot): Promise<void> {
    const conversation = contacts.archivedChatOf(bot.id);
    if (!conversation) return;
    await chat.restoreConversation(conversation.id);
    toast.success(t('contacts.restored'));
  }

  /** 打开项目组（已归档的先恢复）。 */
  async function openProject(project: Conversation): Promise<void> {
    shell.closeSettings();
    if (isArchivedConversation(project)) await chat.restoreConversation(project.id);
    await chat.select(project.id);
  }

  async function removeProject(project: Conversation): Promise<void> {
    await chat.archiveConversation(project.id);
    toast.success(t('sidebar.removedFromList'), { description: t('sidebar.removedFromListHint') });
  }

  async function restoreProject(project: Conversation): Promise<void> {
    await chat.restoreConversation(project.id);
    toast.success(t('contacts.restored'));
  }

  async function askDelete(bot: Bot): Promise<void> {
    deletePreview = await contacts.deletionPreview(bot.id);
    deleteTarget = bot;
  }

  /**
   * The bot leads projects: deletion is blocked (the backend would reject it
   * with PROJECT_LEAD_REQUIRED anyway). Jump to the members section of that
   * project so the user can hand the lead over first.
   */
  async function goReplaceLead(conversationId: string): Promise<void> {
    deleteTarget = null;
    shell.closeSettings();
    await chat.select(conversationId);
    shell.openProjectSettings('members');
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return;
    deleting = true;
    try {
      await contacts.remove(deleteTarget.id);
      toast.success(t('contacts.deleteTitle', { name: deleteTarget.name }));
      deleteTarget = null;
    } finally {
      deleting = false;
    }
  }
</script>

<div class="space-y-6" data-testid="contacts-page-content">
  <!--
    卡片动作按钮：主按钮（对话）带文字并占满本行剩余宽度；删除 / 归档 / 恢复
    只留图标（描边方按钮），文字靠悬停提示（title）与 aria-label 给出。
  -->
  {#snippet chatAction(icon: LucideIcon, label: string, onclick: () => void, testid: string)}
    {@const Icon = icon as unknown as CardIcon}
    <Button class="min-w-0 flex-1 gap-1.5" {onclick} title={label} data-testid={testid}>
      <Icon class="size-4 shrink-0" aria-hidden="true" />
      <span class="truncate">{label}</span>
    </Button>
  {/snippet}

  {#snippet iconAction(icon: LucideIcon, label: string, onclick: () => void, testid: string)}
    {@const Icon = icon as unknown as CardIcon}
    <Button
      variant="outline"
      size="icon"
      {onclick}
      aria-label={label}
      title={label}
      data-testid={testid}
    >
      <Icon class="size-4" aria-hidden="true" />
    </Button>
  {/snippet}

  <!-- 成员三态副行（好友卡与搜索结果共用；与旧成员卡同一呈现）。 -->
  {#snippet memberPresence(member: TeamMember)}
    {#if member.state === 'offline' && lastSeenLabel(member) !== null}
      <p class="truncate text-xs text-muted-foreground">{lastSeenLabel(member)}</p>
    {:else if member.state !== 'offline'}
      <p class="flex items-center gap-1 truncate text-xs text-muted-foreground">
        {#if member.state === 'away'}
          <Moon class="size-3 shrink-0 text-amber-500" aria-hidden="true" />
        {/if}
        <span class="truncate">
          {member.state === 'online' ? t('team.memberOnline') : t('team.memberAway')}
        </span>
        {#if member.state === 'away' && member.avatarBotName !== undefined}
          <span class="truncate">{t('team.awayAvatarHandling', { bot: member.avatarBotName })}</span>
        {/if}
      </p>
    {/if}
  {/snippet}

  <!-- 好友栏主体（web 本地与融合切片共用）：「我」自聊入口（仅本地）、搜索
       加好友、待处理申请、好友卡。数据来自 friends store 的同名切片。 -->
  {#snippet friendsLane(source: SourceId)}
    {@const slice = friendsStore.sliceOf(source)}
    {#if selfMember !== null && source === 'local'}
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent/40"
            onclick={() => void openSelfConversation()}
            data-testid="contacts-self-row"
          >
            <MemberAvatar
              name={selfMember.displayName}
              avatar={selfMember.avatar ?? null}
              state={selfMember.state}
              class="size-10"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{selfMember.displayName}</p>
              <p class="truncate text-xs text-muted-foreground">{t('contacts.selfEntry')}</p>
            </div>
          </button>
        </li>
      </ul>
    {/if}
    <!-- 添加好友：搜索用户名 / 显示名 → 发申请（D129v2 唯一加好友入口）。 -->
    <div class="flex items-center gap-2" data-testid="friends-search">
      <input
        class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring"
        type="text"
        placeholder={t('friends.searchPlaceholder')}
        bind:value={friendSearchQuery}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void searchMembers(source);
          }
        }}
        data-testid="friends-search-input"
      />
      <Button
        variant="outline"
        size="sm"
        disabled={friendSearching || friendSearchQuery.trim().length === 0}
        onclick={() => void searchMembers(source)}
        data-testid="friends-search-submit"
      >
        <Search class="size-4" aria-hidden="true" />
        {t('friends.searchAction')}
      </Button>
    </div>
    {#if friendSearchSource === source && friendSearchResults.length > 0}
      <ul class="space-y-1.5" data-testid="friends-search-results">
        {#each friendSearchResults as member (member.id)}
          <li class="flex items-center gap-3 rounded-lg border p-2">
            <MemberAvatar
              name={member.displayName}
              avatar={member.avatar ?? null}
              state={member.state}
              class="size-8"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{member.displayName}</p>
              {#if member.username !== undefined}
                <p class="truncate text-xs text-muted-foreground">{member.username}</p>
              {/if}
            </div>
            <!-- 禁用判定与加好友弹框同款（canRequestFriend，切片驱动）：
                 pending outgoing / 已是好友才禁，拒绝后自动恢复。 -->
            <Button
              variant="outline"
              size="sm"
              disabled={!canRequestFriend(slice, member.id)}
              onclick={() => void sendFriendRequest(source, member)}
              data-testid={`friend-request-${member.id}`}
            >
              <UserPlus class="size-4" aria-hidden="true" />
              {t('friends.requestAction')}
            </Button>
          </li>
        {/each}
      </ul>
    {:else if friendSearchSource === source && !friendSearching && friendSearchQuery.trim().length > 0}
      <p class="text-xs text-muted-foreground" data-testid="friends-search-empty">
        {t('friends.searchEmpty')}
      </p>
    {/if}
    <!-- 待处理申请：收到的（同意 / 拒绝）与发出的（撤回）。本会话已拒绝的
         申请立即从待处理行收起（转下方「已拒绝」行），不等 refresh 落地。 -->
    {@const pendingIncoming = (slice?.incoming ?? []).filter(
      (request) =>
        !declinedRequests.some(
          (entry) => entry.source === source && entry.requestId === request.id,
        ),
    )}
    {#if slice !== null && (pendingIncoming.length > 0 || slice.outgoing.length > 0)}
      <div class="space-y-1.5" data-testid="friends-requests">
        {#each pendingIncoming as request (request.id)}
          <div
            class="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2"
            data-testid={`friend-incoming-${request.id}`}
          >
            <MemberAvatar
              name={request.from.displayName}
              avatar={request.from.avatar ?? null}
              state={request.from.state}
              class="size-8"
            />
            <p class="min-w-0 flex-1 truncate text-sm">
              {request.from.displayName}
              {#if request.message !== undefined}
                <span class="text-xs text-muted-foreground"> · {request.message}</span>
              {/if}
            </p>
            <Button
              size="sm"
              onclick={() => void acceptFriend(source, request.id)}
              data-testid={`friend-accept-${request.id}`}
            >
              <Check class="size-4" aria-hidden="true" />
              {t('friends.accept')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={() => void declineFriend(source, request)}
              data-testid={`friend-decline-${request.id}`}
            >
              <X class="size-4" aria-hidden="true" />
              {t('friends.decline')}
            </Button>
          </div>
        {/each}
        {#each slice.outgoing as request (request.id)}
          <div
            class="flex items-center gap-2 rounded-lg border p-2 opacity-80"
            data-testid={`friend-outgoing-${request.id}`}
          >
            <MemberAvatar
              name={request.to.displayName}
              avatar={request.to.avatar ?? null}
              state={request.to.state}
              class="size-8"
            />
            <p class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {t('friends.outgoingLabel', { name: request.to.displayName })}
            </p>
            <Button
              variant="outline"
              size="sm"
              onclick={() => void cancelFriendRequest(source, request.id)}
              data-testid={`friend-cancel-${request.id}`}
            >
              {t('friends.cancelRequest')}
            </Button>
          </div>
        {/each}
      </div>
    {/if}
    <!-- 已拒绝的申请（2026-11，本会话本地保留）：「已拒绝」提示 + 拉黑入口。
         对方再次发来申请时行让位给上方待处理行；拉黑成功后本地移除。 -->
    {#if slice !== null}
      {@const declinedVisible = declinedRequests.filter(
        (entry) =>
          entry.source === source &&
          !slice.incoming.some((request) => request.from.id === entry.member.id),
      )}
      {#if declinedVisible.length > 0}
        <div class="space-y-1.5" data-testid="friends-declined">
          {#each declinedVisible as entry (entry.member.id)}
            <div
              class="flex items-center gap-2 rounded-lg border border-dashed p-2 opacity-75"
              data-testid={`friend-declined-${entry.member.id}`}
            >
              <MemberAvatar
                name={entry.member.displayName}
                avatar={entry.member.avatar ?? null}
                state={entry.member.state}
                class="size-8"
              />
              <p class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {entry.member.displayName}
                <span class="text-xs"> · {t('friends.declined')}</span>
              </p>
              <Button
                variant="outline"
                size="sm"
                onclick={() => void blockDeclinedMember(source, entry.member.id)}
                data-testid={`friend-block-${entry.member.id}`}
              >
                <Ban class="size-4" aria-hidden="true" />
                {t('friends.block')}
              </Button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
    <!-- 好友卡（点开 dm；右上角悬浮删除好友）。 -->
    {#if slice === null || slice.connected === false}
      <div
        class="flex h-16 items-center justify-center text-sm text-muted-foreground"
        data-testid="friends-disconnected"
      >
        {t('team.serverDisconnectedRows')}
      </div>
    {:else if slice.friends.length === 0}
      <div
        class="flex h-16 items-center justify-center text-sm text-muted-foreground"
        data-testid="friends-empty"
      >
        {t('friends.empty')}
      </div>
    {:else}
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each slice.friends as member (member.id)}
          <li class="group relative" data-testid={`friend-card-${member.id}`}>
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent/40"
              onclick={() => void openFriendDm(source, member.id)}
              data-testid={`friend-card-open-${member.id}`}
            >
              <MemberAvatar
                name={member.displayName}
                avatar={member.avatar ?? null}
                state={member.state}
                class="size-10"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{member.displayName}</p>
                {@render memberPresence(member)}
              </div>
            </button>
            <button
              type="button"
              class="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-50 transition-opacity hover:bg-accent hover:text-foreground hover:opacity-100"
              onclick={() => (removeFriendTarget = { source, member })}
              aria-label={t('friends.remove')}
              title={t('friends.remove')}
              data-testid={`friend-remove-${member.id}`}
            >
              <UserMinus class="size-4" aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <!-- 已拉黑小节（2026-11）：名单来自服务端切片，仅拉黑方可见；
         「解除拉黑」后名单随 friend.unblocked 事件 refresh 收敛。 -->
    {#if slice !== null && slice.connected && slice.blocked.length > 0}
      <div class="space-y-1.5" data-testid="friends-blocked">
        <p class="text-xs text-muted-foreground">{t('friends.blocked')}</p>
        <ul class="space-y-1.5">
          {#each slice.blocked as member (member.id)}
            <li
              class="flex items-center gap-3 rounded-lg border border-dashed p-2 opacity-75"
              data-testid={`friend-blocked-${member.id}`}
            >
              <MemberAvatar
                name={member.displayName}
                avatar={member.avatar ?? null}
                state={member.state}
                class="size-8"
              />
              <p class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {member.displayName}
              </p>
              <Button
                variant="outline"
                size="sm"
                onclick={() => void unblockMember(source, member.id)}
                data-testid={`friend-unblock-${member.id}`}
              >
                {t('friends.unblock')}
              </Button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  {/snippet}

  <!-- Bot 名册 -->
  <section class="space-y-3" data-testid="contacts-bots-section">
    <h3 class="text-sm font-medium" data-testid="contacts-bots-title">{t('contacts.botsTitle')}</h3>
    {#if contacts.bots.length === 0}
      <div
        class="flex h-24 items-center justify-center text-sm text-muted-foreground"
        data-testid="contacts-empty"
      >
        {t('contacts.empty')}
      </div>
    {:else}
      <!-- 显式 grid-cols-1（minmax(0,1fr)，轨道可收缩）：裸 grid 的 auto 轨道按
           内容 min-content 取宽，简介 truncate 的不换行文本会把轨道撑到超出
           窄屏视口、出现横向滚动条（33-narrow-layout）。 -->
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each contacts.bots as bot (bot.id)}
          <li
            class="flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40"
            data-testid={`bot-card-${bot.id}`}
          >
            <div class="flex items-center gap-3">
              <BotAvatar
                botId={bot.id}
                name={bot.name}
                avatar={bot.avatar}
                accentColor={bot.accentColor ?? null}
                mask={bot.avatarMask}
                padding={bot.avatarPadding}
                class="size-10"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium" data-testid="bot-card-name">{bot.name}</p>
                <p class="truncate text-xs text-muted-foreground">{bot.bio}</p>
                {#if contacts.isChatArchived(bot.id)}
                  <p class="text-xs text-muted-foreground" data-testid={`bot-archived-${bot.id}`}>
                    {t('contacts.archivedBadge')}
                  </p>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {@render chatAction(
                MessagesSquare,
                t('contacts.openChat'),
                () => void openChat(bot),
                `bot-open-${bot.id}`,
              )}
              {#if contacts.isChatArchived(bot.id)}
                {@render iconAction(
                  RotateCcw,
                  t('contacts.restore'),
                  () => void restoreBotChat(bot),
                  `bot-restore-${bot.id}`,
                )}
              {/if}
              <!-- 管家（D70）不可删除：不给删除入口。 -->
              {#if bot.systemRole !== 'butler'}
                {@render iconAction(
                  Trash2,
                  t('contacts.delete'),
                  () => void askDelete(bot),
                  `bot-delete-${bot.id}`,
                )}
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- 好友栏（D129v2，62.04）：只有团队上下文渲染本栏；非团队端点行为与现状
       一致（通讯录只有 Bot 与项目组两栏）。好友卡 / 搜索加好友 / 好友申请。 -->
  {#if teamActive}
    <section class="space-y-3" data-testid="contacts-friends-section">
      <h3 class="text-sm font-medium" data-testid="contacts-friends-title">
        {t('contacts.friendsTitle', { server: teamContext.serverName })}
      </h3>
      {@render friendsLane('local')}
    </section>
  {/if}

  <!-- 桌面融合视图的团队名册（T7，62.04 §1 双源名册）：每个已融合服务器一
       栏，与 web 成员栏同构；断开时「未连接」占位、不伪造数据。 -->
  {#each teamSlices as slice (slice.serverHash)}
    <section
      class="space-y-3"
      data-testid={`contacts-team-${slice.serverHash}`}
      data-connected={slice.connected ? 'true' : 'false'}
    >
      <h3 class="text-sm font-medium">
        {t('contacts.friendsTitle', { server: slice.serverName || slice.serverHash })}
      </h3>
      {@render friendsLane(`team:${slice.serverHash}` as SourceId)}
    </section>
  {/each}

  <!-- 项目组名册（含已从对话列表移除的） -->
  <section class="space-y-3" data-testid="contacts-projects-section">
    <h3 class="text-sm font-medium" data-testid="contacts-projects-title">
      {t('contacts.projectsTitle')}
    </h3>
    {#if projects.length === 0}
      <div
        class="flex h-24 items-center justify-center text-sm text-muted-foreground"
        data-testid="contacts-projects-empty"
      >
        {t('contacts.projectsEmpty')}
      </div>
    {:else}
      <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {#each activeProjects as project (project.id)}
          <li
            class="flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/40"
            data-testid={`project-card-${project.id}`}
          >
            <div class="flex items-center gap-3">
              <ProjectAvatarStack members={project.memberPreviews ?? []} class="size-10" />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium" data-testid="project-card-name">
                  {project.title ?? t('project.untitled')}
                </p>
                {#if project.goal}
                  <p class="truncate text-xs text-muted-foreground">{project.goal}</p>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {@render chatAction(
                MessagesSquare,
                t('contacts.openProject'),
                () => void openProject(project),
                `project-open-${project.id}`,
              )}
              {@render iconAction(
                Archive,
                t('contacts.removeFromList'),
                () => void removeProject(project),
                `project-remove-${project.id}`,
              )}
            </div>
          </li>
        {/each}
        {#each archivedProjects as project (project.id)}
          <li
            class="flex flex-col gap-3 rounded-xl border border-dashed p-4 opacity-80"
            data-testid={`project-card-${project.id}`}
          >
            <div class="flex items-center gap-3">
              <ProjectAvatarStack members={project.memberPreviews ?? []} class="size-10" />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium" data-testid="project-card-name">
                  {project.title ?? t('project.untitled')}
                </p>
                <p class="truncate text-xs text-muted-foreground" data-testid="project-archived">
                  {t('contacts.archivedBadge')}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-1">
              {@render chatAction(
                MessagesSquare,
                t('contacts.openProject'),
                () => void openProject(project),
                `project-open-${project.id}`,
              )}
              {@render iconAction(
                RotateCcw,
                t('contacts.restore'),
                () => void restoreProject(project),
                `project-restore-${project.id}`,
              )}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <Dialog
    open={deleteTarget !== null}
    onOpenChange={(open) => (deleteTarget = open ? deleteTarget : null)}
  >
    <DialogContent class="max-w-md" data-testid="bot-delete-dialog">
      <DialogHeader>
        <DialogTitle>{t('contacts.deleteTitle', { name: deleteTarget?.name ?? '' })}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground" data-testid="bot-delete-body">
        {t('contacts.deleteBody', {
          conversations: deletePreview.conversations,
          messages: deletePreview.messages,
        })}
      </p>
      {#if (deleteTarget?.profile.runtime.agent.id ?? '').length > 0}
        <p class="text-xs text-muted-foreground" data-testid="bot-delete-body-agent-note">
          {t('contacts.deleteAgentNote')}
        </p>
      {/if}
      {#if deletePreview.ledProjects.length > 0}
        <!-- Leading projects block the delete: no confirm button, offer the
             "go replace" jump into each project's members section instead. -->
        <div class="space-y-1.5" data-testid="bot-delete-lead-blocked">
          <p class="text-sm text-muted-foreground">
            {t('contacts.deleteBlockedLead', { count: deletePreview.ledProjects.length })}
          </p>
          <ul class="space-y-1.5">
            {#each deletePreview.ledProjects as project (project.id)}
              <li class="flex items-center gap-2 rounded-md border p-2 text-sm">
                <span class="min-w-0 flex-1 truncate">
                  {project.title ?? t('project.untitled')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onclick={() => void goReplaceLead(project.id)}
                  data-testid={`bot-delete-go-replace-${project.id}`}
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
          onclick={() => (deleteTarget = null)}
          data-testid="bot-delete-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        {#if deletePreview.ledProjects.length === 0}
          <Button
            variant="destructive"
            onclick={confirmDelete}
            disabled={deleting}
            data-testid="bot-delete-confirm"
          >
            {t('contacts.deleteConfirm')}
          </Button>
        {/if}
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 删除好友确认（微信式移除：好友关系解除，既有 dm 保留为历史）。 -->
  <Dialog
    open={removeFriendTarget !== null}
    onOpenChange={(open) => (removeFriendTarget = open ? removeFriendTarget : null)}
  >
    <DialogContent class="max-w-md" data-testid="friend-remove-dialog">
      <DialogHeader>
        <DialogTitle>
          {t('friends.removeTitle', { name: removeFriendTarget?.member.displayName ?? '' })}
        </DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground" data-testid="friend-remove-body">
        {t('friends.removeBody')}
      </p>
      <DialogFooter>
        <Button
          variant="outline"
          onclick={() => (removeFriendTarget = null)}
          data-testid="friend-remove-cancel"
        >
          {t('contacts.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => void confirmRemoveFriend()}
          data-testid="friend-remove-confirm"
        >
          {t('friends.removeConfirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</div>

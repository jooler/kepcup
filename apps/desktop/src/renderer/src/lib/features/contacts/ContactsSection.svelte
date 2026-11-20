<script lang="ts">
  import { Archive, MessagesSquare, RotateCcw, Trash2, type LucideIcon } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import type { Bot, Conversation } from '@kepcup/shared';
  import { isArchivedConversation } from '@kepcup/shared';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { teamContext } from '$lib/features/team/team-context.svelte';
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
   * 设置弹框「通讯录」分组：Bot 名册 + 项目组名册。
   * 新建不再在这里提供入口——只保留主界面左栏「+」一个入口。
   * 项目组也在这里留条目：从对话列表移除（归档）后内容全留，可随时恢复。
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

  /**
   * 团队成员名册（T5，62.04 §1）：团队上下文下通讯录长出「成员」栏——顶部
   * 固定「我」（自我会话），其下每个在册成员一张卡（头像 / 显示名 / 在线
   * 状态）。点击 → team.dm.open → 打开会话。非团队上下文整栏不渲染。
   */
  const teamActive = $derived(teamContext.active);
  const selfMember = $derived(contacts.self);
  /** 成员卡（其他成员）：「我」是顶部固定条目，不在卡列表里重复出现。 */
  const rosterMembers = $derived(
    contacts.members.filter((member) => member.id !== teamContext.member?.id),
  );

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

  /** 点成员卡 → 打开与该成员的 dm。 */
  async function openMemberDm(memberId: string): Promise<void> {
    shell.closeSettings();
    const conversationId = await contacts.openDm(memberId);
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

  <!-- 团队成员名册（T5）：只有团队上下文渲染本栏；非团队端点行为与现状一致。 -->
  {#if teamActive}
    <section class="space-y-3" data-testid="contacts-members-section">
      <h3 class="text-sm font-medium" data-testid="contacts-members-title">
        {t('contacts.membersTitle', { server: teamContext.serverName })}
      </h3>
      <!-- 顶部固定「我」：点开 = 自我会话（备忘 / 文件中转）。 -->
      {#if selfMember !== null}
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
      {#if rosterMembers.length === 0}
        <div
          class="flex h-16 items-center justify-center text-sm text-muted-foreground"
          data-testid="contacts-members-empty"
        >
          {t('contacts.membersEmpty')}
        </div>
      {:else}
        <ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each rosterMembers as member (member.id)}
            <li>
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors hover:bg-accent/40"
                onclick={() => void openMemberDm(member.id)}
                data-testid={`member-card-${member.id}`}
              >
                <MemberAvatar
                  name={member.displayName}
                  avatar={member.avatar ?? null}
                  state={member.state}
                  class="size-10"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium" data-testid="member-card-name">
                    {member.displayName}
                  </p>
                  {#if member.state === 'offline' && lastSeenLabel(member) !== null}
                    <p class="truncate text-xs text-muted-foreground" data-testid="member-last-seen">
                      {lastSeenLabel(member)}
                    </p>
                  {:else if member.state !== 'offline'}
                    <p class="truncate text-xs text-muted-foreground" data-testid="member-state">
                      {member.state === 'online'
                        ? t('team.memberOnline')
                        : t('team.memberAway')}
                    </p>
                  {/if}
                </div>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

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
</div>

<script lang="ts">
  import { PROJECT_MEMBER_PREVIEW_MAX, type Grant } from '@kepcup/shared';
  import type { ProjectMemberView } from '$lib/stores/chat.svelte';
  import { Monitor, Plus, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { browserPages, hasBrowserPage } from '$lib/stores/browser-pages.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import ProjectAvatarStack from '$lib/avatars/ProjectAvatarStack.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import WorkdirSelector from '$lib/features/workdirs/WorkdirSelector.svelte';
  import SchedulesPanel from './SchedulesPanel.svelte';
  import WatchesPanel from '$lib/features/watches/WatchesPanel.svelte';
  import { showBrowser, BROWSER_SHOW_BTN_CLASS } from './show-browser';

  let { conversationId }: { conversationId: string } = $props();

  browserPages.start();

  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );
  const grants = $derived(permissions.grants);
  const conversation = $derived(chat.current?.conversation ?? null);

  let detail = $state<ProjectMemberView | null>(null);
  let titleDraft = $state('');
  /** 上次同步进输入框的标题（只给下面的同步 effect 比对用，不需要响应式）。 */
  let syncedTitle: string | null = null;
  /** 改名请求在途：回车后紧跟的 blur 不再重复提交。 */
  let renaming = false;
  let addOpen = $state(false);
  let addQuery = $state('');

  const faces = $derived(
    members.slice(0, PROJECT_MEMBER_PREVIEW_MAX).map((member) => ({
      id: member.bot.id,
      name: member.bot.name,
      avatar: member.bot.avatar,
    })),
  );
  const addable = $derived.by(() => {
    const needle = addQuery.trim().toLowerCase();
    return contacts.bots.filter((bot) => {
      if (members.some((member) => member.bot.id === bot.id)) return false;
      return needle.length === 0 || bot.name.toLowerCase().includes(needle);
    });
  });

  $effect(() => {
    const title =
      chat.current?.conversation.id === conversationId
        ? (chat.current.conversation.title ?? '')
        : '';
    if (title === syncedTitle) return;
    syncedTitle = title;
    titleDraft = title;
  });

  function savedTitle(): string {
    return chat.current?.conversation.id === conversationId
      ? (chat.current.conversation.title ?? '')
      : '';
  }

  async function saveTitle(): Promise<void> {
    if (renaming) return;
    const next = titleDraft.trim();
    const current = savedTitle();
    if (next.length === 0) {
      titleDraft = current;
      return;
    }
    if (next === current) return;
    renaming = true;
    try {
      // 失败（已 toast）时退回已保存的标题，不让输入框停在没生效的名字上。
      if (!(await chat.renameProject(conversationId, next))) titleDraft = savedTitle();
    } finally {
      renaming = false;
    }
  }

  function onTitleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      // 交给 blur 统一保存，回车 + 失焦只提交一次。
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      titleDraft = savedTitle();
      event.currentTarget.blur();
    }
  }

  async function addMember(botId: string): Promise<void> {
    if (await chat.addProjectMembers(conversationId, [botId])) {
      addQuery = '';
      addOpen = false;
    }
  }
  // 成员详情弹窗：仅当该 Bot 在本群对话已拉起浏览器时显示「查看浏览器」。
  const detailBrowserOpen = $derived(
    detail !== null && hasBrowserPage(browserPages.pages, detail.bot.id, conversationId),
  );

  /**
   * Grants grouped by bot so every member's access is visible at a glance.
   * Plain objects rather than tuple destructuring in the template —
   * svelte-check mis-types destructured `{#each entries() as [k, v]}` items
   * as unions (既有 8 errors 的一部分，行为不变）.
   */
  const grantGroups = $derived.by(() => {
    const groups: Array<{ botId: string; list: Grant[] }> = [];
    for (const grant of grants) {
      const entry = groups.find((group) => group.botId === grant.botId);
      if (entry) entry.list.push(grant);
      else groups.push({ botId: grant.botId, list: [grant] });
    }
    return groups;
  });

  function botName(botId: string): string {
    return members.find((m) => m.bot.id === botId)?.bot.name ?? chat.botName(botId);
  }
</script>

<div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm" data-testid="group-info">
  <section class="flex flex-col items-center gap-3 pt-2">
    <ProjectAvatarStack members={faces} class="size-20" />
    <input
      bind:value={titleDraft}
      maxlength={100}
      class="w-full border-b border-transparent bg-transparent text-center text-base font-medium outline-none focus:border-border"
      aria-label={t('group.renameLabel')}
      data-testid="group-info-title"
      onkeydown={onTitleKeydown}
      onblur={() => void saveTitle()}
    />
  </section>

  <section class="space-y-2">
    <p class="text-xs text-muted-foreground">
      {t('group.membersTitle')} · {t('group.memberCount', { count: members.length })}
    </p>
    <ul class="space-y-1" data-testid="group-member-cards">
      {#each members as member (member.bot.id)}
        {@const memberBrowserOpen = hasBrowserPage(
          browserPages.pages,
          member.bot.id,
          conversationId,
        )}
        <li
          class="flex items-center gap-1 rounded-md border p-1.5"
          data-testid={`group-member-row-${member.bot.id}`}
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-0.5 text-left transition-colors hover:bg-accent"
            onclick={() => (detail = member)}
            data-testid={`group-member-card-${member.bot.id}`}
          >
            <BotAvatar
              botId={member.bot.id}
              name={member.bot.name}
              avatar={member.bot.avatar}
              class="size-8"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{member.bot.name}</span>
              <span class="block truncate text-xs text-muted-foreground">
                {member.bot.profile.role.responsibilities || member.bot.bio}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('group.removeMember')}
            title={t('group.removeMember')}
            onclick={() => void chat.removeProjectMember(conversationId, member.bot.id)}
            data-testid={`group-info-remove-${member.bot.id}`}
          >
            <X class="size-3.5" aria-hidden="true" />
          </button>
          <!-- 与单聊右栏同一套 botId×conversationId：仅该成员在本群开着页面时显示。 -->
          {#if memberBrowserOpen}
            <Button
              variant="outline"
              size="sm"
              class={BROWSER_SHOW_BTN_CLASS}
              title={t('rightPanel.browserShowHint')}
              onclick={() => void showBrowser(member.bot.id, conversationId, member.bot.name)}
              data-testid={`group-member-browser-show-${member.bot.id}`}
            >
              <Monitor class="size-3.5" aria-hidden="true" />
              {t('rightPanel.browserShow')}
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
    <div>
      <button
        type="button"
        class="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        onclick={() => (addOpen = !addOpen)}
        data-testid="group-info-add"
      >
        <Plus class="size-4" aria-hidden="true" />
        {t('group.addMember')}
      </button>
      {#if addOpen}
        <div
          class="mt-1 rounded-xl border bg-background p-2 shadow-lg"
          data-testid="group-info-add-menu"
        >
          <input
            bind:value={addQuery}
            placeholder={t('group.searchBots')}
            class="mb-1 h-8 w-full rounded-md border bg-transparent px-2 text-sm outline-none"
            data-testid="group-info-add-search"
          />
          <ul class="max-h-48 space-y-0.5 overflow-y-auto">
            {#each addable as bot (bot.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-accent"
                  onclick={() => void addMember(bot.id)}
                  data-testid={`group-info-add-option-${bot.id}`}
                >
                  <BotAvatar
                    botId={bot.id}
                    name={bot.name}
                    avatar={bot.avatar}
                    class="size-6"
                    animated={false}
                  />
                  <span class="min-w-0 truncate">{bot.name}</span>
                </button>
              </li>
            {:else}
              <li class="px-1 py-1.5 text-xs text-muted-foreground">
                {t('group.noAddableBots')}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  </section>

  <!-- 工作目录（P04）：项目组的工作目录绑定在对话上。 -->
  {#if conversation}
    <WorkdirSelector
      conversationId={conversation.id}
      workdirId={conversation.workdirId}
      disabled={conversation.readOnly}
    />
  {/if}

  <section class="space-y-2">
    <p class="text-xs text-muted-foreground">{t('group.grantsTitle')}</p>
    {#if grants.length === 0}
      <p class="text-muted-foreground" data-testid="group-grants-empty">{t('group.grantsEmpty')}</p>
    {:else}
      <ul class="space-y-2" data-testid="group-grants-list">
        {#each grantGroups as group (group.botId)}
          <li class="rounded-md border p-2">
            <p class="text-xs font-medium">{botName(group.botId)}</p>
            {#each group.list as grant (grant.id)}
              <div class="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <code class="min-w-0 flex-1 truncate">{grant.path}</code>
                <span
                  >{t(
                    grant.access === 'write' ? 'rightPanel.grantWrite' : 'rightPanel.grantRead',
                  )}</span
                >
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-5 px-1.5 text-xs text-destructive"
                  onclick={() => void permissions.revokeGrant(grant.id)}
                  data-testid={`group-grant-revoke-${grant.id}`}
                >
                  {t('rightPanel.revoke')}
                </Button>
              </div>
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- P10: every member bot's scheduled tasks in this group (conversation-scoped). -->
  <section class="space-y-2">
    <p class="text-xs text-muted-foreground">{t('group.schedulesTitle')}</p>
    <SchedulesPanel {conversationId} testid="group-schedules" />
  </section>

  <!-- W7: every member bot's web-page watches in this group. -->
  <section class="space-y-2">
    <p class="text-xs text-muted-foreground">{t('watches.title')}</p>
    <WatchesPanel {conversationId} testid="group-watches" />
  </section>
</div>

<Dialog.Root open={detail !== null} onOpenChange={(open) => (detail = open ? detail : null)}>
  <Dialog.Content class="sm:max-w-sm" data-testid="group-member-detail">
    <Dialog.Header>
      <Dialog.Title>{t('group.memberDetailTitle')}</Dialog.Title>
    </Dialog.Header>
    {#if detail}
      <div class="space-y-2 text-sm">
        <p class="text-base font-medium">{detail.bot.name}</p>
        <p class="text-muted-foreground">{detail.bot.bio || '—'}</p>
        <p>
          <span class="text-xs text-muted-foreground">{t('group.expertise')}：</span>
          {detail.bot.profile.role.expertise || '—'}
        </p>
        <p>
          <span class="text-xs text-muted-foreground">{t('group.responsibilities')}：</span>
          {detail.bot.profile.role.responsibilities || '—'}
        </p>
        <!-- P11 任务 5: 该成员在本群对话中的浏览器页面（与列表行同一套显隐规则）。 -->
        {#if detailBrowserOpen}
          <Button
            variant="outline"
            size="sm"
            class="w-full {BROWSER_SHOW_BTN_CLASS}"
            title={t('rightPanel.browserShowHint')}
            onclick={() => void showBrowser(detail!.bot.id, conversationId, detail!.bot.name)}
            data-testid="group-browser-show"
          >
            <Monitor class="size-3.5" aria-hidden="true" />
            {t('rightPanel.browserShow')}
          </Button>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

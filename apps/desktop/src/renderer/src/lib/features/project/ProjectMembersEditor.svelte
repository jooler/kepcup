<script lang="ts">
  import { Monitor, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat, type ProjectMemberView } from '$lib/stores/chat.svelte';
  import { browserPages, hasBrowserPage } from '$lib/stores/browser-pages.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { showBrowser, BROWSER_SHOW_BTN_CLASS } from '$lib/features/right-panel/show-browser';
  import ProjectMemberPicker from './ProjectMemberPicker.svelte';

  /**
   * Members section of the project details page (D92 §11.3): the lead on top
   * with the crown badge, per-row make-lead / remove actions, the member
   * profile dialog (ported from the old right-panel member info) and the
   * shared member picker. The lead's remove button is disabled — the backend
   * would reject it with PROJECT_LEAD_REQUIRED; replace the lead first.
   */
  let { conversationId }: { conversationId: string } = $props();

  browserPages.start();

  const members = $derived.by(() => {
    const current = chat.current;
    if (current?.conversation.id !== conversationId) return [];
    const leadBotId = current.conversation.leadBotId ?? null;
    const list = [...(current.members ?? [])];
    list.sort((a, b) => {
      if (a.bot.id === leadBotId) return -1;
      if (b.bot.id === leadBotId) return 1;
      return a.joinedAt - b.joinedAt;
    });
    return list;
  });
  const leadBotId = $derived(
    chat.current?.conversation.id === conversationId
      ? (chat.current.conversation.leadBotId ?? null)
      : null,
  );
  const memberIds = $derived(members.map((member) => member.bot.id));

  let detail = $state<ProjectMemberView | null>(null);
  // Member profile dialog: show "view browser" only when this bot has a live
  // browser page in this project conversation.
  const detailBrowserOpen = $derived(
    detail !== null && hasBrowserPage(browserPages.pages, detail.bot.id, conversationId),
  );

  async function addMember(botId: string): Promise<void> {
    await chat.addProjectMembers(conversationId, [botId]);
  }
</script>

{#snippet row(member: ProjectMemberView, isLead: boolean)}
  {@const memberBrowserOpen = hasBrowserPage(browserPages.pages, member.bot.id, conversationId)}
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-0.5 text-left transition-colors hover:bg-accent"
    onclick={() => (detail = member)}
  >
    <BotAvatar
      botId={member.bot.id}
      name={member.bot.name}
      avatar={member.bot.avatar}
      mask={member.bot.avatarMask}
      class="size-8"
    />
    <span class="min-w-0 flex-1">
      <span class="flex min-w-0 items-center gap-1">
        <span class="truncate text-sm">{member.bot.name}</span>
        {#if isLead}
          <span
            class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
          >
            {t('projectSettings.leadBadge')}
          </span>
        {/if}
      </span>
      <span class="block truncate text-xs text-muted-foreground">
        {member.bot.profile.role.responsibilities || member.bot.bio}
      </span>
    </span>
  </button>
  {#if !isLead}
    <Button
      variant="ghost"
      size="sm"
      class="h-6 shrink-0 px-2 text-xs"
      onclick={() => void chat.setProjectLead(conversationId, member.bot.id)}
      data-testid={`project-make-lead-${member.bot.id}`}
    >
      {t('projectSettings.makeLead')}
    </Button>
  {/if}
  <button
    type="button"
    class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    aria-label={t('projectSettings.removeMember')}
    title={isLead ? t('projectSettings.removeLeadBlocked') : t('projectSettings.removeMember')}
    disabled={isLead}
    onclick={() => void chat.removeProjectMember(conversationId, member.bot.id)}
    data-testid={`project-member-remove-${member.bot.id}`}
  >
    <X class="size-3.5" aria-hidden="true" />
  </button>
  <!-- Same botId×conversationId pair as the direct-chat right panel: the show
       button appears only while this member keeps a browser page open here. -->
  {#if memberBrowserOpen}
    <Button
      variant="outline"
      size="sm"
      class={BROWSER_SHOW_BTN_CLASS}
      title={t('rightPanel.browserShowHint')}
      onclick={() => void showBrowser(member.bot.id, conversationId, member.bot.name)}
    >
      <Monitor class="size-3.5" aria-hidden="true" />
      {t('rightPanel.browserShow')}
    </Button>
  {/if}
{/snippet}

<div class="space-y-3" data-testid="project-member-list" data-settings-anchor="project-members">
  <!-- Add-member sits above the list; its candidate panel opens as a dropdown
       only while the search input has focus. -->
  <div class="space-y-1.5">
    <p class="text-xs font-medium">{t('project.members.add')}</p>
    <ProjectMemberPicker
      excludeIds={memberIds}
      onPick={addMember}
      testid="project-member-add"
      variant="dropdown"
    />
  </div>

  <ul class="space-y-1">
    {#each members as member (member.bot.id)}
      {#if member.bot.id === leadBotId}
        <!-- Deep-link target of the settings-catalog item project.lead (the
             lead's row; a static literal so the anchor scan picks it up). -->
        <li
          class="flex items-center gap-1 rounded-md border p-1.5"
          data-testid={`project-member-row-${member.bot.id}`}
          data-settings-anchor="project-lead"
        >
          {@render row(member, true)}
        </li>
      {:else}
        <li
          class="flex items-center gap-1 rounded-md border p-1.5"
          data-testid={`project-member-row-${member.bot.id}`}
        >
          {@render row(member, false)}
        </li>
      {/if}
    {/each}
  </ul>
</div>

<Dialog.Root open={detail !== null} onOpenChange={(open) => (detail = open ? detail : null)}>
  <Dialog.Content class="sm:max-w-sm" data-testid="project-member-detail">
    <Dialog.Header>
      <Dialog.Title>{t('projectSettings.memberDetailTitle')}</Dialog.Title>
    </Dialog.Header>
    {#if detail}
      <div class="space-y-2 text-sm">
        <p class="text-base font-medium">{detail.bot.name}</p>
        <p class="text-muted-foreground">{detail.bot.bio || '—'}</p>
        <p>
          <span class="text-xs text-muted-foreground"
            >{t('common.labelColon', { label: t('projectSettings.expertise') })}</span
          >
          {detail.bot.profile.role.expertise || '—'}
        </p>
        <p>
          <span class="text-xs text-muted-foreground"
            >{t('common.labelColon', { label: t('projectSettings.responsibilities') })}</span
          >
          {detail.bot.profile.role.responsibilities || '—'}
        </p>
        {#if detailBrowserOpen}
          <Button
            variant="outline"
            size="sm"
            class="w-full {BROWSER_SHOW_BTN_CLASS}"
            title={t('rightPanel.browserShowHint')}
            onclick={() => void showBrowser(detail!.bot.id, conversationId, detail!.bot.name)}
          >
            <Monitor class="size-3.5" aria-hidden="true" />
            {t('rightPanel.browserShow')}
          </Button>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

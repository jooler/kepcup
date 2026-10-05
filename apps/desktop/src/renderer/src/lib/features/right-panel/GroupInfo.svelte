<script lang="ts">
  import type { Grant } from '@kepcup/shared';
  import type { GroupMemberView } from '$lib/stores/chat.svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import ProjectSelector from '$lib/features/projects/ProjectSelector.svelte';
  import SchedulesPanel from './SchedulesPanel.svelte';
  import { showBrowser } from './show-browser';

  let { conversationId }: { conversationId: string } = $props();

  const members = $derived(
    chat.current?.conversation.id === conversationId ? (chat.current?.members ?? []) : [],
  );
  const grants = $derived(permissions.grants);
  // 群创建问答进行中不提供项目选择（与原输入坞上方选择器的创建期隐藏一致）。
  const creating = $derived(chat.current?.conversation.setupState === 'creating');
  const conversation = $derived(chat.current?.conversation ?? null);

  let detail = $state<GroupMemberView | null>(null);

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
  <section class="space-y-1">
    <p class="text-xs text-muted-foreground">{t('group.infoTitle')}</p>
    <p class="font-medium" data-testid="group-info-title">
      {chat.current?.conversation.title ?? ''}
    </p>
  </section>

  <section class="space-y-2">
    <p class="text-xs text-muted-foreground">
      {t('group.membersTitle')} · {t('group.memberCount', { count: members.length })}
    </p>
    <ul class="space-y-1" data-testid="group-member-cards">
      {#each members as member (member.bot.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent"
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
        </li>
      {/each}
    </ul>
  </section>

  <!-- 项目目录（P04）：群目录绑定在对话上，创建期隐藏。 -->
  {#if !creating && conversation}
    <ProjectSelector
      conversationId={conversation.id}
      projectId={conversation.projectId}
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
        <!-- P11 任务 5: 该成员在本群对话中的浏览器页面。 -->
        <Button
          variant="outline"
          size="sm"
          class="w-full gap-1"
          onclick={() => void showBrowser(detail!.bot.id, conversationId, detail!.bot.name)}
          data-testid="group-browser-show"
        >
          {t('rightPanel.browserShow')}
        </Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>

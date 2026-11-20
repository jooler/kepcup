<script lang="ts">
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { connections, type SourceId } from '$lib/rpc/connections.svelte';
  import MemberAvatar from '$lib/features/team/MemberAvatar.svelte';
  import {
    deriveHumanRoster,
    ProjectMembersPanelState,
  } from '$lib/features/team/project-members.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 项目组人类成员面板（T7 步骤 5，62.04 §4）：成员列表 + 加人（从团队成员
   * 挑选 → team.projects.addMembers）、移出、转交负责人；非负责人只读
   * （服务器 NOT_PROJECT_LEAD 拒绝后收敛）。挂在项目详情页的成员分区
   * （ProjectSettingsMembers，Bot 名册之下）；团队来源的项目会话才渲染。
   */
  let { conversationId }: { conversationId: string } = $props();

  const session = getChatSession();
  const isTeamProject = $derived(
    session.conversationId === conversationId &&
      session.conversation?.type === 'project' &&
      session.source !== 'local',
  );
  const selfMemberId = $derived(
    isTeamProject ? connections.get(session.source).memberId : null,
  );

  /**
   * 面板状态按 (来源, 会话) 缓存：$derived 重算不能把服务器的「非负责人」
   * 判定丢掉。
   */
  // Plain Map: 面板状态缓存（keyed by 来源+会话），没有界面从 Map 本身派生。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const panels = new Map<string, ProjectMembersPanelState>();
  function panelOf(source: SourceId, id: string): ProjectMembersPanelState {
    const key = `${source}::${id}`;
    let panel = panels.get(key);
    if (panel === undefined) {
      panel = new ProjectMembersPanelState({ source, conversationId: id });
      panels.set(key, panel);
    }
    return panel;
  }
  const panel = $derived(
    isTeamProject ? panelOf(session.source, conversationId) : null,
  );

  /**
   * 名册（T7 名册增量）：在线优先读 `team.projects.roster` 实时读口（面板
   * loadRoster 缓存）；离线 / 旧服务器回落消息推导 + 通讯录卡片补齐。
   */
  const roster = $derived.by(() => {
    if (!isTeamProject || selfMemberId === null) return [];
    const live = panel?.roster;
    if (live !== null && live !== undefined) return live.members;
    const derived = deriveHumanRoster(session.messages ?? [], selfMemberId);
    return derived.map((entry) => {
      const member = contacts.teamMemberById(session.source, entry.memberId);
      return {
        memberId: entry.memberId,
        name: entry.name || member?.displayName || entry.memberId,
        state: member?.state ?? 'offline',
        avatar: member?.avatar ?? null,
        role: 'member' as const,
        isSelf: entry.memberId === selfMemberId,
      };
    });
  });

  // 实时名册接线：面板出现 / 来源切换时拉一次；团队连接重连后补拉。
  $effect(() => {
    if (panel === null) return;
    void panel.loadRoster();
    return connections.get(session.source).onConnected(() => void panel.loadRoster());
  });

  /** 加人候选：名册里还不在这个项目组的成员。 */
  const candidates = $derived.by(() => {
    if (!isTeamProject || selfMemberId === null) return [];
    const inProject = new Set(roster.map((entry) => entry.memberId));
    return contacts
      .teamMembersOf(session.source)
      .filter((member) => !inProject.has(member.id) && member.id !== selfMemberId)
      .map((member) => ({ id: member.id, name: member.displayName }));
  });

  async function add(memberId: string): Promise<void> {
    await panel?.addMembers([memberId]);
  }
  async function remove(memberId: string): Promise<void> {
    await panel?.removeMember(memberId);
  }
  async function makeLead(memberId: string): Promise<void> {
    await panel?.transferLead(memberId);
  }
</script>

{#if isTeamProject && panel !== null}
  <div
    class="mt-4 space-y-2"
    data-testid="project-human-members"
    data-readonly={panel.readonlyOnly ? 'true' : 'false'}
  >
    <p class="text-xs font-medium">{t('team.projectHumanMembersTitle')}</p>
    {#if panel.readonlyOnly}
      <p class="text-xs text-muted-foreground" data-testid="project-human-members-readonly">
        {t('team.projectMembersReadonly')}
      </p>
    {:else if candidates.length > 0}
      <div class="flex flex-wrap gap-1" data-testid="project-human-add">
        {#each candidates as candidate (candidate.id)}
          <Button
            variant="outline"
            size="sm"
            class="h-7 px-2 text-xs"
            disabled={panel.busy}
            onclick={() => void add(candidate.id)}
            data-testid={`project-human-add-${candidate.id}`}
          >
            + {candidate.name}
          </Button>
        {/each}
      </div>
    {/if}

    {#if roster.length === 0}
      <p class="text-xs text-muted-foreground" data-testid="project-human-empty">
        {t('team.projectHumanEmpty')}
      </p>
    {:else}
      <ul class="space-y-1">
        {#each roster as entry (entry.memberId)}
          <li
            class="flex items-center gap-2 rounded-md border p-1.5"
            data-testid={`project-human-row-${entry.memberId}`}
          >
            <MemberAvatar name={entry.name} avatar={entry.avatar} state={entry.state} class="size-7" />
            <span class="min-w-0 flex-1 truncate text-sm">
              {entry.name}
              {#if entry.role === 'lead'}
                <span
                  class="ml-1 rounded bg-accent px-1 py-0.5 text-[10px] font-medium"
                  data-testid={`project-human-lead-badge-${entry.memberId}`}
                >{t('team.projectLeadBadge')}</span>
              {/if}
              {#if entry.isSelf}
                <span class="text-xs text-muted-foreground">（{t('contacts.selfEntry')}）</span>
              {/if}
            </span>
            {#if !panel.readonlyOnly && !entry.isSelf}
              <Button
                variant="ghost"
                size="sm"
                class="h-6 shrink-0 px-2 text-xs"
                disabled={panel.busy}
                onclick={() => void makeLead(entry.memberId)}
                data-testid={`project-human-lead-${entry.memberId}`}
              >
                {t('team.projectTransferLead')}
              </Button>
              <button
                type="button"
                class="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                aria-label={t('projectSettings.removeMember')}
                disabled={panel.busy}
                onclick={() => void remove(entry.memberId)}
                data-testid={`project-human-remove-${entry.memberId}`}
              >
                <X class="size-3.5" aria-hidden="true" />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if panel.lastError === 'OTHER'}
      <p class="text-xs text-destructive" data-testid="project-human-error">
        {t('team.projectMembersError')}
      </p>
    {/if}
  </div>
{/if}

<script lang="ts">
  import { t } from '$lib/i18n';
  import type { ConversationView } from '$lib/stores/chat-session.svelte';
  import type { TeamConversationRow } from '$lib/stores/chat-team.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { connections, serverHashOf, teamSourceId, type SourceId } from '$lib/rpc/connections.svelte';
  import { fusionPref } from '$lib/features/team/fusion-pref';
  import MemberAvatar from '$lib/features/team/MemberAvatar.svelte';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import ProjectAvatarStack from '$lib/avatars/ProjectAvatarStack.svelte';
  import { SIDEBAR_ROW_ACTIVE_CLASS } from '$lib/features/sidebar/sidebar-active-class';

  /**
   * 侧栏的团队会话分组（T7 步骤 3，62.04 §1「会话列表合并显示」）：本机分组
   * 之下按服务器列出已融合的团队会话（条目带「团队」徽标）；断开的服务器
   * 显示「未连接」占位（不伪造数据）。行点击走 `chat.select({source, id})`。
   *
   * 休眠：没有已配置的服务器时整个分组不渲染（客户端与现状一致）。
   */
  let { collapsed = false }: { collapsed?: boolean } = $props();

  interface TeamServerGroup {
    serverHash: string;
    serverName: string;
    status: 'connecting' | 'connected' | 'reconnecting' | 'offline';
    rows: Array<{ source: SourceId; row: TeamConversationRow }>;
  }

  const groups = $derived.by(() => {
    const pref = fusionPref();
    const result: TeamServerGroup[] = [];
    for (const server of connections.servers) {
      if (!pref.isEnabled(server.serverHash)) continue;
      if (server.accounts.length === 0) continue;
      const source = teamSourceId(server.serverHash);
      const status = connections.get(source).status;
      const slice = chat.team.slices[server.serverHash];
      const rows = (slice?.conversations ?? []).map((row) => ({ source, row }));
      result.push({
        serverHash: server.serverHash,
        serverName:
          contacts.teamSources[server.serverHash]?.serverName || server.url,
        status,
        rows,
      });
    }
    return result;
  });

  const activeTeamRef = $derived(
    chat.currentRef !== null && serverHashOf(chat.currentRef.source) !== null ? chat.currentRef : null,
  );

  function isActive(source: SourceId, id: string): boolean {
    return activeTeamRef?.source === source && activeTeamRef.id === id;
  }

  function select(source: SourceId, id: string): void {
    void chat.select({ source, id });
  }

  function nameOf(source: SourceId, conversation: ConversationView): string {
    if (conversation.type === 'dm') return contacts.dmPeerViewOf(source, conversation.peerPrincipalIds).title;
    return conversation.type === 'project'
      ? (conversation.title ?? conversation.id)
      : (conversation.bot?.name ?? conversation.directBotId ?? conversation.id);
  }

  function previewOf(serverHash: string, conversation: ConversationView): string {
    return chat.team.slices[serverHash]?.lastMessageText[conversation.id] ?? conversation.summary ?? '';
  }

  function statusLabel(status: TeamServerGroup['status']): string {
    if (status === 'connected') return '';
    return status === 'connecting' || status === 'reconnecting'
      ? t('team.serverConnecting')
      : t('team.serverOffline');
  }
</script>

{#if groups.length > 0}
  <div role="separator" class="mx-1 my-2 h-px shrink-0 bg-foreground/10"></div>
  {#each groups as group (group.serverHash)}
    <div class="mt-1" data-testid={`team-server-group-${group.serverHash}`} data-status={group.status}>
      {#if !collapsed}
        <p class="flex items-center gap-1.5 px-2 pb-1 text-xs text-muted-foreground">
          <span
            class="size-1.5 shrink-0 rounded-full {group.status === 'connected' ? 'bg-emerald-500' : 'bg-zinc-400'}"
            data-testid={`team-server-dot-${group.serverHash}`}
          ></span>
          <span class="min-w-0 flex-1 truncate">{group.serverName}</span>
          {#if statusLabel(group.status) !== ''}
            <span class="shrink-0" data-testid={`team-server-status-${group.serverHash}`}>
              {statusLabel(group.status)}
            </span>
          {/if}
        </p>
      {/if}
      {#if group.status !== 'connected'}
        {#if !collapsed}
          <p class="px-3 py-1.5 text-xs text-muted-foreground" data-testid={`team-server-placeholder-${group.serverHash}`}>
            {t('team.serverDisconnectedRows')}
          </p>
        {/if}
      {:else if group.rows.length === 0}
        {#if !collapsed}
          <p class="px-3 py-1.5 text-xs text-muted-foreground" data-testid={`team-server-empty-${group.serverHash}`}>
            {t('team.serverNoConversations')}
          </p>
        {/if}
      {:else}
        <ul class={collapsed ? 'flex flex-col items-center gap-1' : 'space-y-0.5'}>
          {#each group.rows as entry (entry.source + entry.row.id)}
            {@const view = entry.row}
            {#if collapsed}
              <li>
                <button
                  type="button"
                  class="relative flex size-[52px] cursor-pointer items-center justify-center rounded-xl transition-colors hover:bg-sidebar-accent {SIDEBAR_ROW_ACTIVE_CLASS}"
                  data-active={isActive(entry.source, view.id) ? 'true' : undefined}
                  onclick={() => select(entry.source, view.id)}
                  data-testid={`conversation-item-${view.id}`}
                  title={nameOf(entry.source, view)}
                >
                  {#if view.type === 'dm'}
                    {@const peer = contacts.dmPeerViewOf(entry.source, view.peerPrincipalIds)}
                    <MemberAvatar name={peer.title} avatar={peer.avatar} state={peer.state} class="size-12 text-base" />
                  {:else if view.type === 'project'}
                    <ProjectAvatarStack members={view.memberPreviews ?? []} class="size-11" />
                  {:else}
                    <BotAvatar
                      botId={view.directBotId ?? view.id}
                      name={view.bot?.name ?? view.directBotId ?? '?'}
                      avatar={view.bot?.avatar ?? null}
                      accentColor={view.bot?.accentColor ?? null}
                      class="size-12"
                      fallbackClass="text-base"
                    />
                  {/if}
                  {#if view.mentionCount > 0}
                    <span
                      class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
                      title={t('team.mentionBadge')}
                      data-testid="mention-badge"
                      >@{view.mentionCount}</span
                    >
                  {:else if (view.unreadCount ?? 0) > 0 && !chat.isViewingRef({ source: entry.source, id: view.id })}
                    <span
                      class="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] text-primary-foreground"
                      data-testid="unread-badge"
                      >{view.unreadCount}</span
                    >
                  {/if}
                </button>
              </li>
            {:else}
              <li>
                <button
                  type="button"
                  class="flex h-auto min-w-0 w-full cursor-pointer items-center gap-2 rounded-lg p-1 text-left transition-colors
                    hover:bg-sidebar-accent {SIDEBAR_ROW_ACTIVE_CLASS}"
                  data-active={isActive(entry.source, view.id) ? 'true' : undefined}
                  onclick={() => select(entry.source, view.id)}
                  data-testid={`conversation-row-${view.id}`}
                >
                  <span class="relative shrink-0">
                    {#if view.type === 'dm'}
                      {@const peer = contacts.dmPeerViewOf(entry.source, view.peerPrincipalIds)}
                      <MemberAvatar name={peer.title} avatar={peer.avatar} state={peer.state} class="size-12 text-base" />
                    {:else if view.type === 'project'}
                      <ProjectAvatarStack members={view.memberPreviews ?? []} class="size-11" />
                    {:else}
                      <BotAvatar
                        botId={view.directBotId ?? view.id}
                        name={view.bot?.name ?? view.directBotId ?? '?'}
                        avatar={view.bot?.avatar ?? null}
                        accentColor={view.bot?.accentColor ?? null}
                        mask={view.bot?.avatarMask ?? null}
                        padding={view.bot?.avatarPadding ?? null}
                        class="size-12"
                        fallbackClass="text-base"
                      />
                    {/if}
                  </span>
                  <span class="grid min-w-0 flex-1 gap-0.5 text-left leading-tight">
                    <span class="flex items-center justify-between gap-1">
                      <span class="flex min-w-0 items-center gap-1">
                        <span class="truncate text-sm">{nameOf(entry.source, view)}</span>
                        <span
                          class="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] text-primary"
                          title={t('team.teamBadge')}
                          data-testid="team-badge"
                          >{t('team.teamBadge')}</span
                        >
                      </span>
                      {#if view.mentionCount > 0}
                        <span
                          class="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground"
                          title={t('team.mentionBadge')}
                          data-testid="mention-badge"
                          >@{view.mentionCount}</span
                        >
                      {/if}
                    </span>
                    {#if previewOf(group.serverHash, view).length > 0}
                      <span class="truncate text-xs text-muted-foreground">
                        {previewOf(group.serverHash, view)}
                      </span>
                    {/if}
                  </span>
                  {#if (view.unreadCount ?? 0) > 0 && !chat.isViewingRef({ source: entry.source, id: view.id })}
                    <span
                      class="shrink-0 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground"
                      data-testid="unread-badge"
                      >{view.unreadCount}</span
                    >
                  {/if}
                </button>
              </li>
            {/if}
          {/each}
        </ul>
      {/if}
    </div>
  {/each}
{/if}

<script lang="ts">
  import { Bot, FolderOpen } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import {
    botCapabilitiesOf,
    loadTeamBots,
    myPrivateBotsOf,
    teamBotsOf,
  } from './team-bots.svelte';
  import TeamBotEditDialog from './TeamBotEditDialog.svelte';

  /**
   * 「我的私有 Bot」面板（member-bots B4 子域 A）：myPrivateBots 列表（名称 /
   * 工作路径 / 配额 X/limit / 状态徽章 interviewing）→ 行点击开编辑对话框。
   * 自包含：挂载时拉取；宿主（+ 面板「我的私有 Bot」条目）只传 { source, onClose }。
   * Dialog 形态（审查修正）：此前是裸卡片，作为 AppSidebar 尾部兄弟节点会挤占
   * Sidebar.Provider 的 flex 布局；行编辑打开时本面板收起，编辑框关闭即返回。
   */
  let { source, onClose }: { source: SourceId; onClose: () => void } = $props();

  $effect(() => {
    void loadTeamBots(source);
  });

  const slice = $derived(teamBotsOf(source));
  const bots = $derived(myPrivateBotsOf(source));
  const caps = $derived(botCapabilitiesOf(source));
  let editingBotId = $state<string | null>(null);

  function pathLabel(path: string | undefined): string {
    if (path === undefined) return t('teamBot.workdirAutoShort');
    return path.length > 36 ? `…${path.slice(-35)}` : path;
  }
</script>

{#if editingBotId !== null}
  <TeamBotEditDialog {source} botId={editingBotId} onClose={() => (editingBotId = null)} />
{:else}
  <Dialog
    open={true}
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <DialogContent class="flex max-h-[70vh] flex-col overflow-hidden sm:max-w-md" data-testid="team-my-bots-panel">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Bot class="size-4 text-muted-foreground" aria-hidden="true" />
          {t('teamBot.myBots')}
          {#if caps !== null}
            <span class="text-xs font-normal text-muted-foreground" data-testid="team-my-bots-quota">
              {t('teamBot.quotaLabel', { used: caps.privateBotsUsed, limit: caps.privateBotsLimit })}
            </span>
          {/if}
        </DialogTitle>
        <DialogDescription>{t('teamBot.myBotsDescription')}</DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto p-1">
        {#if !slice.loaded}
          <p class="px-2 py-6 text-center text-xs text-muted-foreground" data-testid="team-my-bots-loading">
            {t('common.loading')}
          </p>
        {:else if slice.error !== undefined && bots.length === 0}
          <p class="px-2 py-6 text-center text-xs text-destructive" data-testid="team-my-bots-error">
            {t('teamBot.myBotsLoadFailed')}
          </p>
        {:else if bots.length === 0}
          <p class="px-2 py-6 text-center text-xs text-muted-foreground" data-testid="team-my-bots-empty">
            {t('teamBot.myBotsEmpty')}
          </p>
        {:else}
          <ul class="space-y-0.5">
            {#each bots as bot (bot.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent"
                  onclick={() => (editingBotId = bot.id)}
                  data-testid={`team-my-bots-row-${bot.id}`}
                >
                  <BotAvatar botId={bot.id} name={bot.name} avatar={null} accentColor={null} class="size-8" fallbackClass="text-xs" />
                  <span class="grid min-w-0 flex-1 gap-0.5">
                    <span class="flex min-w-0 items-center gap-1.5">
                      <span class="truncate">{bot.name || bot.id}</span>
                      {#if bot.setupState === 'interviewing'}
                        <span
                          class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                          data-testid={`team-my-bots-status-${bot.id}`}
                          >{t('teamBot.statusInterviewing')}</span
                        >
                      {/if}
                    </span>
                    <span class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground" title={bot.workdirPath ?? ''}>
                      <FolderOpen class="size-3 shrink-0" aria-hidden="true" />
                      <span class="truncate">{pathLabel(bot.workdirPath)}</span>
                    </span>
                  </span>
                  {#if bot.canEdit}
                    <span class="shrink-0 text-xs text-muted-foreground">{t('teamBot.editAction')}</span>
                  {/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </DialogContent>
  </Dialog>
{/if}

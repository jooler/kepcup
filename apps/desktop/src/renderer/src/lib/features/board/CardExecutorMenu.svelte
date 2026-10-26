<script lang="ts">
  import { Check, Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { board, type BoardCardView } from './board.svelte';
  import { isCardLocked } from './board-model';
  import { botAvatarOf, botNameColor } from './bot-face';

  /**
   * Assignee menu. Lists the project's active bots, excluding the butler.
   * The user is not a member. Locked while the card is running, delivered,
   * or closed. Members come from the main project session, not the card chat.
   * The trigger reads as a field value: avatar plus name.
   *
   * Uses the portaled dropdown so the detail column's scroll box cannot clip
   * the list when the project has many bots.
   */
  let { card }: { card: BoardCardView } = $props();

  const leadBotId = $derived(chat.main.conversation?.leadBotId ?? null);
  const members = $derived.by(() => {
    const list = chat.main.members.filter(
      (member) => member.bot.status === 'active' && member.bot.systemRole !== 'butler',
    );
    list.sort((a, b) => {
      if (a.bot.id === leadBotId) return -1;
      if (b.bot.id === leadBotId) return 1;
      return a.joinedAt - b.joinedAt;
    });
    return list;
  });
  const assigneeId = $derived(card.todo.assignee?.botId ?? null);
  const assigneeName = $derived(card.todo.assignee?.name ?? t('board.dialog.executor.none'));
  const assigneeAvatar = $derived(assigneeId === null ? null : botAvatarOf(assigneeId));
  const assigneeColor = $derived(botNameColor(assigneeAvatar));
  const closed = $derived(card.todo.status === 'done' || card.todo.status === 'cancelled');
  const locked = $derived(isCardLocked(card));
  const lockHint = $derived(
    closed
      ? t('board.dialog.executor.lockedClosed')
      : locked
        ? t('board.dialog.executor.locked')
        : t('board.dialog.executor.change'),
  );
  const triggerLabel = $derived(
    locked
      ? t('common.labelValue', { label: assigneeName, value: lockHint })
      : t('common.labelValue', { label: t('board.dialog.executor.label'), value: assigneeName }),
  );

  function choose(botId: string | null): void {
    if (botId === assigneeId) return;
    void board.mutateCard('board.cards.assign', { cardId: card.id, botId });
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex cursor-pointer items-center gap-1.5 rounded-full py-1 pr-2 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    disabled={locked}
    aria-label={triggerLabel}
    title={lockHint}
    data-testid="board-dialog-executor"
  >
    {#if card.todo.assignee}
      <BotAvatar
        botId={card.todo.assignee.botId}
        name={card.todo.assignee.name}
        avatar={assigneeAvatar}
        class="size-6"
        animated={false}
      />
      <span class="max-w-40 truncate text-sm" style:color={assigneeColor}
        >{card.todo.assignee.name}</span
      >
    {:else}
      <span
        class="flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground"
      >
        <Plus class="size-3.5" aria-hidden="true" />
      </span>
      <span class="text-sm text-muted-foreground">{t('board.dialog.executor.none')}</span>
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-64" align="start" aria-label={t('board.dialog.executor.change')}>
    {#each members as member (member.bot.id)}
      <DropdownMenu.Item
        class="gap-2 px-2 py-1.5"
        onSelect={() => choose(member.bot.id)}
        data-testid={`board-dialog-executor-${member.bot.id}`}
      >
        <BotAvatar
          botId={member.bot.id}
          name={member.bot.name}
          avatar={member.bot.avatar ?? null}
          class="size-5 shrink-0"
          animated={false}
        />
        <span class="min-w-0 flex-1 truncate">{member.bot.name}</span>
        {#if member.bot.id === leadBotId}
          <span
            class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
          >
            {t('project.members.leadBadge')}
          </span>
        {/if}
        {#if member.bot.id === assigneeId}
          <Check class="size-3.5 shrink-0" aria-hidden="true" />
        {/if}
      </DropdownMenu.Item>
    {/each}
    <DropdownMenu.Item
      class="gap-2 px-2 py-1.5"
      onSelect={() => choose(null)}
      data-testid="board-dialog-executor-none"
    >
      <span
        class="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground"
      >
        <Plus class="size-3" aria-hidden="true" />
      </span>
      <span class="min-w-0 flex-1 truncate">{t('board.dialog.executor.none')}</span>
      {#if assigneeId === null}
        <Check class="size-3.5 shrink-0" aria-hidden="true" />
      {/if}
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>

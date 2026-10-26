<script lang="ts">
  import { Check, Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { board, type BoardCardView } from './board.svelte';

  /**
   * Assignee menu. Lists the project's active bots, excluding the butler.
   * The user is not a member. Locked while the card is running, delivered,
   * or closed. Members come from the main project session, not the card chat.
   */
  let { card }: { card: BoardCardView } = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

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
  const closed = $derived(card.todo.status === 'done' || card.todo.status === 'cancelled');
  const locked = $derived(
    closed || card.todo.status === 'in_progress' || card.todo.status === 'delivered',
  );
  const lockHint = $derived(
    closed
      ? t('board.dialog.executor.lockedClosed')
      : locked
        ? t('board.dialog.executor.locked')
        : t('board.dialog.executor.change'),
  );

  function toggle(): void {
    if (locked) return;
    open = !open;
  }

  function close(): void {
    open = false;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!open) return;
    if (root?.contains(event.target as Node)) return;
    close();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function choose(botId: string | null): void {
    close();
    if (botId === assigneeId) return;
    void board.mutateCard('board.cards.assign', { cardId: card.id, botId });
  }
</script>

<svelte:window onpointerdown={onPointerDown} />
<svelte:document onkeydowncapture={onKeydown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    class="flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    disabled={locked}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={lockHint}
    title={lockHint}
    onclick={toggle}
    data-testid="board-dialog-executor"
  >
    {#if card.todo.assignee}
      <BotAvatar
        botId={card.todo.assignee.botId}
        name={card.todo.assignee.name}
        avatar={null}
        class="size-6"
        animated={false}
      />
    {:else}
      <span
        class="flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground"
      >
        <Plus class="size-3.5" aria-hidden="true" />
      </span>
    {/if}
  </button>
  {#if open}
    <div
      class="absolute top-full right-0 z-50 mt-1 w-64 rounded-xl border bg-popover p-1 shadow-xl"
      role="menu"
      aria-label={t('board.dialog.executor.change')}
    >
      {#each members as member (member.bot.id)}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
          role="menuitem"
          onclick={() => choose(member.bot.id)}
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
        </button>
      {/each}
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
        role="menuitem"
        onclick={() => choose(null)}
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
      </button>
    </div>
  {/if}
</div>

<script lang="ts">
  import { BOARD_CARD_TEXT_MAX_CHARS } from '@kepcup/shared';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board } from './board.svelte';
  import { deriveCardBadges } from './board-model';
  import InlineEditable from './InlineEditable.svelte';
  import CardChat from './CardChat.svelte';
  import CardExecutorMenu from './CardExecutorMenu.svelte';
  import CardRuns from './CardRuns.svelte';
  import CardStatusBar from './CardStatusBar.svelte';

  /**
   * Card dialog. Three bands: toolbar, detail | chat, status. Below 760px the
   * middle becomes Details / Chat tabs. Escape closes, after inputs, approval
   * cards, and an open task page have had their turn. Text is flushed first.
   */
  const TABS_BELOW = 760;

  let { cardId }: { cardId: string } = $props();

  const card = $derived.by(() => {
    for (const column of board.columns) {
      const found = column.cards.find((item) => item.id === cardId);
      if (found !== undefined) return found;
    }
    return null;
  });

  let dialogEl = $state<HTMLElement | null>(null);
  let editor = $state<{ flush: () => Promise<boolean> } | null>(null);
  let width = $state(0);
  let tab = $state<'detail' | 'chat'>('detail');
  let taskId = $state<string | null>(null);
  let highlightId = $state<string | null>(null);
  let closing = false;

  const tabbed = $derived(width > 0 && width < TABS_BELOW);
  const unread = $derived(card !== null && deriveCardBadges(card).unread);

  $effect(() => {
    const current = card;
    if (current === null) return;
    if (current.todo.assignee !== null && current.conversationId === null) {
      void board.mutateCard('board.cards.conversation', { cardId: current.id });
    }
  });

  // A new card conversation is a new session. Drop a task page that belonged
  // to the previous one. Reading only the id keeps an open task page put.
  $effect(() => {
    void card?.conversationId;
    taskId = null;
  });

  async function requestClose(): Promise<void> {
    if (closing) return;
    closing = true;
    await editor?.flush();
    board.closeCard();
  }

  function onSave(next: string): Promise<boolean> {
    return board.updateCardText(cardId, next);
  }

  function openRun(messageId: string | null): void {
    highlightId = messageId;
    tab = 'chat';
  }

  function onEscapeKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    if (taskId !== null) {
      event.preventDefault();
      taskId = null;
    }
  }
</script>

{#if card}
  <Dialog.Root
    open
    onOpenChange={(open) => {
      if (!open) void requestClose();
    }}
  >
    <Dialog.Content
      bind:ref={dialogEl}
      class="flex h-[min(80vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
      showCloseButton={false}
      tabindex={-1}
      data-testid="board-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        dialogEl?.focus();
      }}
      {onEscapeKeydown}
    >
      <div bind:clientWidth={width} class="flex h-full min-h-0 flex-col">
        <header class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <Dialog.Title class="min-w-0 flex-1 truncate text-sm font-medium">
            {t('board.dialog.title')}
          </Dialog.Title>
          <CardExecutorMenu {card} />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('board.dialog.close')}
            onclick={() => void requestClose()}
            data-testid="board-dialog-close"
          >
            <X class="size-4" />
          </Button>
        </header>
        <Dialog.Description class="sr-only">{t('board.dialog.title')}</Dialog.Description>
        {#if tabbed}
          <div
            class="flex shrink-0 items-center gap-0.5 border-b px-4 py-2"
            role="tablist"
            data-testid="board-dialog-tabs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'detail'}
              data-active={tab === 'detail' ? 'true' : undefined}
              class="cursor-pointer rounded-full px-2.5 py-0.5 text-[13px] {tab === 'detail'
                ? 'bg-muted font-medium text-foreground'
                : 'text-foreground/50 hover:bg-accent/60'}"
              onclick={() => (tab = 'detail')}
              data-testid="board-dialog-tab-detail"
            >
              {t('board.dialog.tab.detail')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'chat'}
              data-active={tab === 'chat' ? 'true' : undefined}
              class="inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[13px] {tab ===
              'chat'
                ? 'bg-muted font-medium text-foreground'
                : 'text-foreground/50 hover:bg-accent/60'}"
              onclick={() => (tab = 'chat')}
              data-testid="board-dialog-tab-chat"
            >
              {t('board.dialog.tab.chat')}
              {#if unread}
                <span
                  class="size-1.5 rounded-full bg-amber-500"
                  data-testid="board-dialog-tab-unread"
                ></span>
              {/if}
            </button>
          </div>
        {/if}
        <div class="flex min-h-0 flex-1 {tabbed ? 'flex-col' : ''}">
          <div
            class="flex min-h-0 flex-col overflow-y-auto px-4 py-4 {tabbed
              ? tab === 'detail'
                ? 'flex-1'
                : 'hidden'
              : 'w-[40%] max-w-[420px] border-r'}"
          >
            <InlineEditable
              bind:this={editor}
              value={card.text}
              {onSave}
              multiline
              maxLength={BOARD_CARD_TEXT_MAX_CHARS}
              placeholder={t('board.card.placeholder')}
              delayMs={600}
              ariaLabel={t('board.dialog.title')}
              testid="board-dialog-text"
            />
            <CardRuns {card} onOpen={openRun} />
          </div>
          <div
            class="flex min-h-0 min-w-0 flex-col {tabbed
              ? tab === 'chat'
                ? 'flex-1'
                : 'hidden'
              : 'flex-1'}"
          >
            {#key card.conversationId ?? 'unassigned'}
              <CardChat {card} bind:taskId {highlightId} />
            {/key}
          </div>
        </div>
        <CardStatusBar {card} />
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}

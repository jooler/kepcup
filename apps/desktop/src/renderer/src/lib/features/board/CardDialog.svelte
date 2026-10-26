<script lang="ts">
  import { BOARD_CARD_TEXT_MAX_CHARS } from '@kepcup/shared';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board } from './board.svelte';
  import {
    cardNeighbors,
    deriveCardBadges,
    dialogEscapeAction,
    cardAriaLabel,
  } from './board-model';
  import InlineEditable from './InlineEditable.svelte';
  import CardActions from './CardActions.svelte';
  import CardChat from './CardChat.svelte';
  import CardDetails from './CardDetails.svelte';
  import CardMoreMenu from './CardMoreMenu.svelte';
  import CardRuns from './CardRuns.svelte';

  /**
   * Card dialog. Two bands: toolbar and detail | chat. The detail side is a
   * field list (status / assignee / schedule); the schedule popover anchors
   * to its row. Prev/next ride outside the dialog's top-left corner and must
   * stay clickable, so the dialog ignores outside interactions entirely
   * (closing is X / Escape only). Below 760px the middle becomes Details /
   * Chat tabs. Escape closes, after inputs, approval cards, and an open task
   * page have had their turn. Text is flushed first.
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
  const neighbors = $derived(cardNeighbors(board.columns, cardId));

  let dialogEl = $state<HTMLElement | null>(null);
  let navTop = $state<number | null>(null);
  let editor = $state<{ flush: () => Promise<boolean> } | null>(null);
  let width = $state(0);
  let tab = $state<'detail' | 'chat'>('detail');
  let taskId = $state<string | null>(null);
  let highlightId = $state<string | null>(null);
  let closing = false;

  const tabbed = $derived(width > 0 && width < TABS_BELOW);
  const unread = $derived(card !== null && deriveCardBadges(card).unread);

  // 上一条/下一条贴着弹框左上角的外上方（不可见溢出），同时留在 Dialog.Content
  // 内：焦点作用域与 aria-modal 覆盖它们，键盘/读屏才能用。顶部 40px 是全屏
  // 浮层激活的窗口拖拽带（app.css .window-drag-band-active），落进去点击会被
  // 当成拖窗口，所以视口下界抬到 48。
  $effect(() => {
    const el = dialogEl;
    if (el === null) return;
    const update = (): void => {
      navTop = el.getBoundingClientRect().top;
    };
    update();
    const settle = setTimeout(update, 150);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  });

  $effect(() => {
    const current = card;
    if (current === null) return;
    if (current.todo.assignee !== null && current.conversationId === null) {
      void board.mutateCard('board.cards.conversation', { cardId: current.id });
    }
  });

  // A new card conversation is a new session. Drop a task page that belonged
  // to the previous one. A board refresh replaces the card object without
  // changing the id, and must not close the task page.
  let conversationKey = $state<string | null | undefined>(undefined);
  $effect(() => {
    const next = card?.conversationId ?? null;
    if (conversationKey === undefined) {
      conversationKey = next;
      return;
    }
    if (next === conversationKey) return;
    conversationKey = next;
    taskId = null;
  });

  async function requestClose(): Promise<void> {
    if (closing) return;
    closing = true;
    await editor?.flush();
    board.closeCard();
  }

  async function switchCard(id: string): Promise<void> {
    if (id === cardId) return;
    await editor?.flush();
    highlightId = null;
    // Drop the previous card's task page before the new one renders.
    taskId = null;
    board.openCard(id);
  }

  function onSave(next: string): Promise<boolean> {
    return board.updateCardText(cardId, next);
  }

  function openRun(messageId: string | null): void {
    highlightId = messageId;
    tab = 'chat';
  }

  function focusInComposer(): boolean {
    const active = document.activeElement;
    return active instanceof HTMLElement && active.closest('[data-testid="composer"]') !== null;
  }

  /**
   * bits-ui closes on a cloned Escape event and ignores `preventDefault` on
   * the original keydown. Handle the real event while it is still bubbling
   * inside the dialog, and stop it so the dialog stays open.
   */
  function consumeEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    const action = dialogEscapeAction({
      defaultPrevented: event.defaultPrevented,
      composerFocused: focusInComposer(),
      taskOpen: taskId !== null,
    });
    if (action === 'close') return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'blur-composer' || action === 'leave-task') dialogEl?.focus();
    if (action === 'leave-task') taskId = null;
  }

  function onEscapeKeydown(event: KeyboardEvent): void {
    consumeEscape(event);
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
      class="flex h-[min(80vh,720px)] flex-col gap-0 p-0 sm:max-w-5xl"
      showCloseButton={false}
      tabindex={-1}
      data-testid="board-dialog"
      interactOutsideBehavior="ignore"
      onkeydown={consumeEscape}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        dialogEl?.focus();
      }}
      {onEscapeKeydown}
    >
      <div
        class="absolute left-0 z-[70] flex items-center gap-1"
        class:hidden={navTop === null}
        style:top="{Math.max(-36, 48 - (navTop ?? 0))}px"
        data-testid="board-dialog-nav"
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={neighbors.prev === null}
          onclick={() => {
            const prev = neighbors.prev;
            if (prev !== null) void switchCard(prev);
          }}
          data-testid="board-dialog-prev"
        >
          {t('board.dialog.prev')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={neighbors.next === null}
          onclick={() => {
            const next = neighbors.next;
            if (next !== null) void switchCard(next);
          }}
          data-testid="board-dialog-next"
        >
          {t('board.dialog.next')}
        </Button>
      </div>
      <div
        bind:clientWidth={width}
        class="flex h-full min-h-0 flex-col overflow-hidden rounded-[inherit]"
      >
        <header class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
          <Dialog.Title class="min-w-0 flex-1 truncate text-sm font-medium">
            {t('board.dialog.title')}
            <span class="sr-only" aria-live="polite">{cardAriaLabel(card.text)}</span>
          </Dialog.Title>
          {#key cardId}
            <CardMoreMenu {card} />
          {/key}
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
            class="flex min-h-0 flex-col overflow-y-auto px-6 py-4 {tabbed
              ? tab === 'detail'
                ? 'flex-1'
                : 'hidden'
              : 'w-[40%] max-w-[420px] border-r'}"
          >
            <div
              class="-mx-2.5 mb-3 rounded-lg px-2.5 py-1.5 text-base font-medium transition-colors focus-within:bg-muted"
            >
              {#key cardId}
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
              {/key}
            </div>
            {#key cardId}
              <CardDetails {card} />
              <CardRuns {card} onOpen={openRun} />
            {/key}
          </div>
          <div
            class="flex min-h-0 min-w-0 flex-col {tabbed
              ? tab === 'chat'
                ? 'flex-1'
                : 'hidden'
              : 'flex-1'}"
          >
            {#if tabbed && tab === 'chat'}
              <div class="flex shrink-0 items-center justify-end border-b px-4 py-1.5">
                <CardActions {card} testidPrefix="board-dialog-chat-action" />
              </div>
            {/if}
            {#key card.conversationId ?? 'unassigned'}
              <CardChat {card} bind:taskId {highlightId} />
            {/key}
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}

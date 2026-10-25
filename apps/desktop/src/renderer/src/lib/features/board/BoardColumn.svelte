<script lang="ts">
  import { GripVertical, MoreHorizontal, Plus } from '@lucide/svelte';
  import { BOARD_COLUMN_TITLE_MAX_CHARS } from '@kepcup/shared';
  import { dragHandle, dndzone, type DndEvent } from 'svelte-dnd-action';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board, type BoardCardView, type BoardColumnView } from './board.svelte';
  import {
    anchorFromFinalize,
    cardClickGuard,
    isNoopMove,
    isShadow,
    stripShadow,
  } from './board-dnd';
  import BoardCard from './BoardCard.svelte';
  import InlineEditable from './InlineEditable.svelte';
  import NewCardComposer from './NewCardComposer.svelte';

  /**
   * One column: no background, a fixed header, a composer outside the card
   * zone, and a card list that is the only vertical scroller.
   */
  let {
    column,
    flipDurationMs,
  }: {
    column: BoardColumnView;
    flipDurationMs: number;
  } = $props();

  let items = $state.raw<BoardCardView[]>([]);
  let listEl = $state<HTMLDivElement | null>(null);
  let rootEl = $state<HTMLElement | null>(null);
  let titleEditor = $state<{ focus: (selectAll?: boolean) => void } | null>(null);
  let restored = false;
  let composing = $state(false);
  let menu = $state<{ x: number; y: number } | null>(null);
  let confirmDelete = $state(false);

  const index = $derived(board.columns.findIndex((item) => item.id === column.id));
  const cardCount = $derived(column.cards.length);

  $effect(() => {
    const next = column.cards;
    if (board.dragging) return;
    items = next.map((card) => ({ ...card, todo: { ...card.todo } }));
  });

  $effect(() => {
    const el = listEl;
    if (el === null || restored) return;
    restored = true;
    el.scrollTop = board.columnScrollTop[column.id] ?? 0;
  });

  $effect(() => {
    const wanted = board.focusColumnId;
    if (wanted !== column.localKey && wanted !== column.id) return;
    const editor = titleEditor;
    const root = rootEl;
    if (editor === null || root === null) return;
    root.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    editor.focus(true);
    queueMicrotask(() => {
      if (board.focusColumnId === wanted) board.focusColumnId = null;
    });
  });

  function onListScroll(): void {
    if (listEl) board.setColumnScroll(column.id, listEl.scrollTop);
  }

  function onConsider(event: CustomEvent<DndEvent<BoardCardView>>): void {
    if (event.detail.info.trigger === 'dragStopped') {
      board.setDragging(false);
      return;
    }
    items = event.detail.items;
    board.setDragging(true);
  }

  function onFinalize(event: CustomEvent<DndEvent<BoardCardView>>): void {
    const info = event.detail.info;
    if (info.source === 'pointer') cardClickGuard.arm();
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') items = stripShadow(event.detail.items);
      // Pointer drags end here. Keyboard drags keep going until dragStopped.
      if (info.source !== 'keyboard') board.setDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = column.cards.map((card) => card.id);
    items = next;
    if (
      !isNoopMove(
        prevIds,
        next.map((card) => card.id),
      )
    ) {
      board.moveCard(info.id, column.id, decision.beforeId);
    }
    if (info.source !== 'keyboard') board.setDragging(false);
  }

  function openMenu(x: number, y: number): void {
    menu = { x, y };
  }

  function closeMenu(): void {
    menu = null;
  }

  function shift(delta: -1 | 1): void {
    const ids = board.columns.map((item) => item.id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= ids.length) return;
    const beforeId = delta > 0 ? (ids[next + 1] ?? null) : (ids[next] ?? null);
    board.moveColumn(column.id, beforeId);
    closeMenu();
  }

  function askDelete(): void {
    closeMenu();
    if (cardCount === 0) {
      void board.deleteColumn(column.id, false);
      return;
    }
    confirmDelete = true;
  }

  function createCard(text: string): Promise<boolean> {
    const created = board.createCard(column.id, text);
    if (listEl) listEl.scrollTop = 0;
    return created;
  }

  $effect(() => {
    if (menu === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<section
  bind:this={rootEl}
  class="group/column flex h-full min-h-0 w-72 shrink-0 flex-col"
  aria-label={column.title}
  data-testid="board-column"
  data-column-id={column.id}
>
  <header
    class="flex shrink-0 items-center gap-1 pb-2"
    role="group"
    oncontextmenu={(event) => {
      event.preventDefault();
      openMenu(event.clientX, event.clientY);
    }}
  >
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/column:opacity-100 focus-visible:opacity-100"
      aria-label={t('board.column.handle')}
      data-testid="board-column-handle"
      use:dragHandle
    >
      <GripVertical class="size-4" aria-hidden="true" />
    </button>
    <div class="min-w-0 flex-1 text-sm font-medium">
      <InlineEditable
        bind:this={titleEditor}
        value={column.title}
        onSave={(text) => board.renameColumn(column.id, text)}
        maxLength={BOARD_COLUMN_TITLE_MAX_CHARS}
        placeholder={t('board.column.titlePlaceholder')}
        delayMs={400}
        ariaLabel={t('board.column.titlePlaceholder')}
        testid="board-column-title"
      />
    </div>
    <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{cardCount}</span>
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/40 hover:text-foreground"
      aria-label={t('board.column.addCard')}
      onclick={() => (composing = true)}
      data-testid="board-column-add-card"
    >
      <Plus class="size-4" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 group-hover/column:opacity-100 hover:bg-accent/40 hover:text-foreground focus-visible:opacity-100"
      aria-label={t('board.column.menuLabel')}
      data-testid="board-column-menu"
      onclick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu(rect.left, rect.bottom);
      }}
    >
      <MoreHorizontal class="size-4" aria-hidden="true" />
    </button>
  </header>

  {#if composing}
    <div class="shrink-0 pb-2">
      <NewCardComposer onSave={createCard} onDiscard={() => (composing = false)} />
    </div>
  {/if}

  <div
    bind:this={listEl}
    class="flex min-h-0 min-h-16 flex-1 flex-col gap-2 overflow-y-auto"
    aria-label={column.title}
    data-testid="board-column-cards"
    onscroll={onListScroll}
    use:dndzone={{
      items,
      type: 'card',
      flipDurationMs,
      delayTouchStart: true,
      dropTargetStyle: {},
    }}
    onconsider={onConsider}
    onfinalize={onFinalize}
  >
    {#each items as item (item.localKey ?? item.id)}
      {#if isShadow(item)}
        <div class="rounded-lg border p-3 text-sm" aria-hidden="true">
          <p class="invisible line-clamp-6 break-words whitespace-pre-wrap">{item.text}</p>
        </div>
      {:else}
        <BoardCard card={item} />
      {/if}
    {/each}
  </div>
</section>

{#if menu}
  <button
    type="button"
    class="fixed inset-0 z-40 cursor-default"
    aria-label={t('board.dialog.close')}
    onclick={closeMenu}
  ></button>
  <div
    class="fixed z-50 w-52 rounded-xl border bg-popover p-1 shadow-xl"
    style="left: {menu.x}px; top: {menu.y}px;"
    role="menu"
    aria-label={t('board.column.menuLabel')}
  >
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-40"
      role="menuitem"
      disabled={index <= 0}
      onclick={() => shift(-1)}
    >
      {t('board.column.menu.moveLeft')}
    </button>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-40"
      role="menuitem"
      disabled={index < 0 || index >= board.columns.length - 1}
      onclick={() => shift(1)}
    >
      {t('board.column.menu.moveRight')}
    </button>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
      role="menuitem"
      onclick={askDelete}
    >
      {t('board.column.menu.delete')}
    </button>
  </div>
{/if}

{#if confirmDelete}
  <Dialog.Root
    open
    onOpenChange={(open) => {
      if (!open) confirmDelete = false;
    }}
  >
    <Dialog.Content class="sm:max-w-sm" data-testid="board-column-delete-dialog">
      <Dialog.Header>
        <Dialog.Title>
          {t('board.column.deleteDialog.title', { title: column.title })}
        </Dialog.Title>
        <Dialog.Description>
          {t('board.column.deleteDialog.body', { count: cardCount })}
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>
          {t('board.column.deleteDialog.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => {
            confirmDelete = false;
            void board.deleteColumn(column.id, true);
          }}
          data-testid="board-column-delete-confirm"
        >
          {t('board.column.deleteDialog.confirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

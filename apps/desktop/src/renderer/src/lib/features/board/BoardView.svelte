<script lang="ts">
  import { dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import { i18n, t } from '$lib/i18n';
  import { board, type BoardColumnView } from './board.svelte';
  import {
    anchorFromFinalize,
    boardFlipDurationMs,
    isNoopMove,
    isShadow,
    stripShadow,
  } from './board-dnd';
  import { configureBoardDnd } from './dnd-setup';
  import AddColumn from './AddColumn.svelte';
  import BoardColumn from './BoardColumn.svelte';
  import CardDialog from './CardDialog.svelte';

  /**
   * The board canvas. The track is the only horizontal scroller; columns
   * scroll vertically inside themselves. Drag commits on finalize, never
   * on consider.
   */
  let { projectId }: { projectId: string } = $props();

  let columnItems = $state.raw<BoardColumnView[]>([]);
  let trackEl = $state<HTMLDivElement | null>(null);
  let restored = false;
  let reducedMotion = $state(false);

  const flipDurationMs = $derived(boardFlipDurationMs(reducedMotion));
  const openCard = $derived.by(() => {
    const id = board.openCardId;
    if (id === null) return null;
    for (const column of board.columns) {
      const card = column.cards.find((item) => item.id === id);
      if (card !== undefined) return card;
    }
    return null;
  });

  $effect(() => {
    return board.attach(projectId);
  });

  $effect(() => {
    void i18n.locale;
    configureBoardDnd();
  });

  $effect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = media.matches;
    const onChange = (): void => {
      reducedMotion = media.matches;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  });

  $effect(() => {
    const next = board.columns;
    if (board.dragging) return;
    columnItems = next.map((column) => ({
      ...column,
      cards: column.cards.map((card) => ({ ...card, todo: { ...card.todo } })),
    }));
  });

  $effect(() => {
    const el = trackEl;
    if (el === null || restored) return;
    restored = true;
    el.scrollLeft = board.scrollLeft;
  });

  function onTrackScroll(): void {
    if (trackEl) board.setScrollLeft(trackEl.scrollLeft);
  }

  function onConsider(event: CustomEvent<DndEvent<BoardColumnView>>): void {
    if (event.detail.info.trigger === 'dragStopped') {
      board.setDragging(false);
      return;
    }
    columnItems = event.detail.items;
    board.setDragging(true);
  }

  function onFinalize(event: CustomEvent<DndEvent<BoardColumnView>>): void {
    const info = event.detail.info;
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') {
        columnItems = stripShadow(event.detail.items);
        return;
      }
      if (info.source !== 'keyboard') board.setDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = board.columns.map((column) => column.id);
    columnItems = next;
    if (!isNoopMove(prevIds, next.map((column) => column.id))) {
      board.moveColumn(info.id, decision.beforeId);
    }
    if (info.source !== 'keyboard') board.setDragging(false);
  }
</script>

<div class="board flex min-h-0 flex-1 flex-col" data-testid="board-view">
  {#if board.error}
    <p class="shrink-0 px-6 pt-4 text-sm text-muted-foreground" role="alert">{board.error}</p>
  {/if}
  <div
    bind:this={trackEl}
    class="flex min-h-0 flex-1 gap-6 overflow-x-auto overflow-y-hidden px-6 pt-4 pb-4"
    data-testid="board-track"
    onscroll={onTrackScroll}
  >
    <div
      class="flex h-full min-h-0 gap-6"
      role="list"
      aria-label={t('project.module.board')}
      use:dragHandleZone={{
        items: columnItems,
        type: 'column',
        flipDurationMs,
        dropTargetStyle: {},
      }}
      onconsider={onConsider}
      onfinalize={onFinalize}
    >
      {#each columnItems as column (column.localKey ?? column.id)}
        {#if isShadow(column)}
          <div class="h-full w-72 shrink-0 rounded-lg border border-dashed" aria-hidden="true"></div>
        {:else}
          <BoardColumn {column} {flipDurationMs} />
        {/if}
      {/each}
    </div>
    <AddColumn />
  </div>
</div>

{#if openCard}
  <CardDialog cardId={openCard.id} text={openCard.text} />
{/if}

<style>
  /* Drop slot: same size as the item, dashed outline, no fill. The library
     hides the slot with an inline visibility; override it under this root. */
  .board :global([data-is-dnd-shadow-item-internal]) {
    visibility: visible !important;
    background: transparent !important;
    background-image: none !important;
    border-style: dashed !important;
    box-shadow: none !important;
  }
  .board :global([data-is-dnd-shadow-item-internal] *) {
    visibility: hidden !important;
  }
  /* The floating copy is appended to the document body, outside this root. */
  :global(#dnd-action-dragged-el) {
    opacity: 0.9;
    box-shadow:
      0 4px 6px -1px rgb(0 0 0 / 0.1),
      0 2px 4px -2px rgb(0 0 0 / 0.1);
  }
</style>

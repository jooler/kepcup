<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board, type BoardCardView } from './board.svelte';
  import { cardAriaLabel, moveTargets, needsDeleteConfirm } from './board-model';
  import { cardClickGuard } from './board-dnd';

  /**
   * Read-only card face. Click and Enter open the dialog; Space is left to
   * the drag library. The whole element is the drag item.
   */
  let { card }: { card: BoardCardView } = $props();

  let menu = $state<{ x: number; y: number } | null>(null);
  let submenu = $state(false);
  let confirmDelete = $state(false);

  const label = $derived(cardAriaLabel(card.text) || t('board.card.placeholder'));
  const targets = $derived(moveTargets(board.columns, card));
  const columnCards = $derived(
    board.columns.find((column) => column.id === card.columnId)?.cards ?? [],
  );
  const index = $derived(columnCards.findIndex((item) => item.id === card.id));

  function openDialog(): void {
    if (cardClickGuard.ignores() || board.dragging) return;
    board.openCard(card.id);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || board.dragging) return;
    event.preventDefault();
    board.openCard(card.id);
  }

  function openMenu(event: MouseEvent): void {
    event.preventDefault();
    submenu = false;
    menu = { x: event.clientX, y: event.clientY };
  }

  function closeMenu(): void {
    menu = null;
    submenu = false;
  }

  function shift(delta: -1 | 1): void {
    const ids = columnCards.map((item) => item.id);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= ids.length) return;
    const beforeId = delta > 0 ? (ids[next + 1] ?? null) : (ids[next] ?? null);
    board.moveCard(card.id, card.columnId, beforeId);
    closeMenu();
  }

  function moveTo(columnId: string): void {
    board.moveCard(card.id, columnId, null);
    closeMenu();
  }

  function remove(): void {
    closeMenu();
    if (needsDeleteConfirm(card)) {
      confirmDelete = true;
      return;
    }
    void board.deleteCard(card.id);
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

<div
  class="cursor-pointer rounded-lg border bg-card p-3 text-sm hover:bg-accent/40"
  role="button"
  tabindex="0"
  aria-label={label}
  data-testid="board-card"
  data-card-id={card.id}
  onclick={openDialog}
  onkeydown={onKeydown}
  oncontextmenu={openMenu}
>
  <p class="line-clamp-6 break-words whitespace-pre-wrap">{card.text}</p>
</div>

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
    aria-label={label}
  >
    {#if targets.length > 0}
      <div
        class="relative"
        role="presentation"
        onpointerenter={() => (submenu = true)}
        onpointerleave={() => (submenu = false)}
      >
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={submenu}
          onclick={() => (submenu = !submenu)}
        >
          <span class="min-w-0 flex-1 truncate">{t('board.card.menu.moveTo')}</span>
          <ChevronRight class="size-3.5 text-muted-foreground" aria-hidden="true" />
        </button>
        {#if submenu}
          <div
            class="absolute top-0 left-full z-50 ml-1 w-44 rounded-xl border bg-popover p-1 shadow-xl"
            role="menu"
          >
            {#each targets as target (target.id)}
              <button
                type="button"
                class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
                role="menuitem"
                onclick={() => moveTo(target.id)}
              >
                <span class="truncate">{target.title}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-40"
      role="menuitem"
      disabled={index <= 0}
      onclick={() => shift(-1)}
    >
      {t('board.card.menu.moveUp')}
    </button>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-default disabled:opacity-40"
      role="menuitem"
      disabled={index < 0 || index >= columnCards.length - 1}
      onclick={() => shift(1)}
    >
      {t('board.card.menu.moveDown')}
    </button>
    <button
      type="button"
      class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent"
      role="menuitem"
      onclick={remove}
    >
      {t('board.card.menu.delete')}
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
    <Dialog.Content class="sm:max-w-sm">
      <Dialog.Header>
        <Dialog.Title>{t('board.card.deleteDialog.title')}</Dialog.Title>
        <Dialog.Description>{t('board.card.deleteDialog.body')}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>
          {t('board.card.deleteDialog.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => {
            confirmDelete = false;
            void board.deleteCard(card.id);
          }}
          data-testid="board-card-delete-confirm"
        >
          {t('board.card.deleteDialog.confirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

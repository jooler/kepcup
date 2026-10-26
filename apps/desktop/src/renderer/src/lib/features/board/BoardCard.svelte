<script lang="ts">
  import { ChevronRight, Clock } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import { board, type BoardCardView } from './board.svelte';
  import {
    cardAriaLabel,
    cardFooter,
    deriveCardBadges,
    deriveCardStatus,
    moveTargets,
    needsDeleteConfirm,
    type CardStatusTone,
  } from './board-model';
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
  const footer = $derived(cardFooter(card));
  const badges = $derived(deriveCardBadges(card));
  const blocked = $derived(deriveCardStatus(card));
  const done = $derived(footer?.status.key === 'done');

  function dotClass(tone: CardStatusTone): string {
    if (tone === 'sky') return 'bg-sky-500';
    if (tone === 'emerald') return 'bg-emerald-500';
    if (tone === 'amber') return 'bg-amber-500';
    return 'bg-muted-foreground';
  }
  const targets = $derived(moveTargets(board.columns, card));
  const columnCards = $derived(
    board.columns.find((column) => column.id === card.columnId)?.cards ?? [],
  );
  const index = $derived(columnCards.findIndex((item) => item.id === card.id));

  /**
   * The drag library rewrites each item's role to `listitem` whenever the
   * zone updates. The card face is a button (Enter opens it); put that role
   * back without fighting tabindex, which the library uses while dragging.
   */
  function keepButtonRole(node: HTMLElement): { destroy: () => void } {
    const apply = (): void => {
      if (node.getAttribute('role') !== 'button') node.setAttribute('role', 'button');
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(node, { attributes: true, attributeFilter: ['role'] });
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }

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
  class="cursor-pointer rounded-lg border bg-card p-3 text-sm hover:bg-accent/40 {done
    ? 'opacity-70'
    : ''}"
  role="button"
  tabindex="0"
  use:keepButtonRole
  aria-label={label}
  data-testid="board-card"
  data-card-id={card.id}
  data-status={footer?.status.key ?? blocked?.key ?? ''}
  onclick={openDialog}
  onkeydown={onKeydown}
  oncontextmenu={openMenu}
>
  <p class="line-clamp-6 break-words whitespace-pre-wrap">{card.text}</p>
  {#if badges.unread || badges.approval || badges.askUser || (footer === null && blocked?.key === 'blocked')}
    <div
      class="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      {#if badges.unread}
        <span
          class="size-1.5 rounded-full bg-amber-500"
          title={t('board.badge.unread')}
          data-testid="board-card-unread"
        ></span>
      {/if}
      {#if badges.approval}
        <span data-testid="board-card-approval">{t('board.badge.approval')}</span>
      {/if}
      {#if badges.askUser}
        <span data-testid="board-card-ask-user">{t('board.badge.askUser')}</span>
      {/if}
      {#if footer === null && blocked?.key === 'blocked'}
        <span data-testid="board-card-blocked">{blocked.params?.reason}</span>
      {/if}
    </div>
  {/if}
  {#if footer === null && blocked?.key === 'pending'}
    <div
      class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="board-card-pending"
    >
      <Clock class="size-3 shrink-0" aria-hidden="true" />
      <span class="truncate">{t(blocked.label, blocked.params)}</span>
    </div>
  {/if}
  {#if footer}
    <div class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span class="flex shrink-0" data-testid="board-card-assignee">
        <BotAvatar
          botId={footer.assignee.botId}
          name={footer.assignee.name}
          avatar={null}
          class="size-4"
          animated={false}
        />
      </span>
      <span class="inline-flex min-w-0 items-center gap-1" data-testid="board-card-status">
        <span
          class="size-1.5 shrink-0 rounded-full {dotClass(footer.status.tone)}"
          aria-hidden="true"
        ></span>
        <span class="truncate">{t(footer.status.label, footer.status.params)}</span>
      </span>
      {#if footer.when !== null}
        <span class="inline-flex min-w-0 items-center gap-1" data-testid="board-card-time">
          <Clock class="size-3 shrink-0" aria-hidden="true" />
          <span class="truncate">{footer.when}</span>
        </span>
      {/if}
    </div>
  {/if}
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
        <Dialog.Title>{t('board.deleteCard.title')}</Dialog.Title>
        <Dialog.Description>{t('board.deleteCard.body')}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => {
            confirmDelete = false;
            void board.deleteCard(card.id);
          }}
          data-testid="board-card-delete-confirm"
        >
          {t('board.deleteCard.confirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

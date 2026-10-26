<script lang="ts">
  import { Ellipsis } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board, type BoardCardView } from './board.svelte';
  import { needsDeleteConfirm } from './board-model';

  /**
   * 顶部 … 菜单。目前只有删除条目：有对话、执行成员或执行记录的卡片先
   * 确认；删除是乐观的，弹框随卡片一起关掉。
   */
  let { card }: { card: BoardCardView } = $props();

  let open = $state(false);
  let confirmingDelete = $state(false);
  let root = $state<HTMLElement | null>(null);

  function toggle(): void {
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

  function remove(): void {
    close();
    if (needsDeleteConfirm(card)) {
      confirmingDelete = true;
      return;
    }
    void board.deleteCard(card.id);
  }
</script>

<svelte:window onpointerdown={onPointerDown} />
<svelte:document onkeydowncapture={onKeydown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    class="flex size-8 cursor-pointer items-center justify-center rounded-full hover:bg-accent"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={t('board.dialog.menu')}
    title={t('board.dialog.menu')}
    onclick={toggle}
    data-testid="board-dialog-more"
  >
    <Ellipsis class="size-4" />
  </button>
  {#if open}
    <div
      class="absolute top-full right-0 z-50 mt-1 w-44 rounded-xl border bg-popover p-1 shadow-xl"
      role="menu"
      aria-label={t('board.dialog.menu')}
    >
      <button
        type="button"
        class="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
        role="menuitem"
        onclick={remove}
        data-testid="board-dialog-menu-delete"
      >
        {t('board.card.menu.delete')}
      </button>
    </div>
  {/if}
</div>

{#if confirmingDelete}
  <Dialog.Root
    open
    onOpenChange={(value) => {
      if (!value) confirmingDelete = false;
    }}
  >
    <Dialog.Content class="sm:max-w-sm">
      <Dialog.Header>
        <Dialog.Title>{t('board.deleteCard.title')}</Dialog.Title>
        <Dialog.Description>{t('board.deleteCard.body')}</Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (confirmingDelete = false)}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => {
            confirmingDelete = false;
            void board.deleteCard(card.id);
          }}
          data-testid="board-dialog-delete-confirm"
        >
          {t('board.deleteCard.confirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

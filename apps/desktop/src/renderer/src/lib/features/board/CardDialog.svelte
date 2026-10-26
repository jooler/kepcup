<script lang="ts">
  import { BOARD_CARD_TEXT_MAX_CHARS } from '@kepcup/shared';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { board } from './board.svelte';
  import InlineEditable from './InlineEditable.svelte';

  /**
   * Minimal card dialog (P1): the text only. Focus starts on the dialog, not
   * the editor. Escape closes; the multiline editor does not take Escape.
   * The text is flushed before the dialog goes away.
   */
  let {
    cardId,
    text,
  }: {
    cardId: string;
    text: string;
  } = $props();

  let dialogEl = $state<HTMLElement | null>(null);
  let editor = $state<{ flush: () => Promise<boolean> } | null>(null);
  let closing = false;

  async function requestClose(): Promise<void> {
    if (closing) return;
    closing = true;
    await editor?.flush();
    board.closeCard();
  }

  function onSave(next: string): Promise<boolean> {
    return board.updateCardText(cardId, next);
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) void requestClose();
  }}
>
  <Dialog.Content
    bind:ref={dialogEl}
    class="gap-0 overflow-hidden p-0 sm:max-w-xl"
    showCloseButton={false}
    tabindex={-1}
    data-testid="board-dialog"
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      dialogEl?.focus();
    }}
  >
    <header class="flex shrink-0 items-center gap-2 border-b px-4 py-3">
      <Dialog.Title class="min-w-0 flex-1 truncate text-sm font-medium">
        {t('board.dialog.title')}
      </Dialog.Title>
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
    <div class="px-4 py-4">
      <InlineEditable
        bind:this={editor}
        value={text}
        {onSave}
        multiline
        maxLength={BOARD_CARD_TEXT_MAX_CHARS}
        placeholder={t('board.card.placeholder')}
        delayMs={600}
        ariaLabel={t('board.dialog.title')}
        testid="board-dialog-text"
      />
    </div>
  </Dialog.Content>
</Dialog.Root>

<script lang="ts">
  import { BOARD_CARD_TEXT_MAX_CHARS } from '@kepcup/shared';
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n';
  import InlineEditable from './InlineEditable.svelte';

  /**
   * Blank card between the column header and the scrolling list. Enter
   * submits, Shift+Enter inserts a newline, blur submits when there is text,
   * and Escape or an empty blur discards it.
   */
  let {
    onSave,
    onDiscard,
  }: {
    onSave: (text: string) => Promise<boolean>;
    onDiscard: () => void;
  } = $props();

  let editor = $state<{ focus: (selectAll?: boolean) => void } | null>(null);

  onMount(() => {
    editor?.focus();
  });
</script>

<div class="rounded-lg border bg-card p-3 text-sm">
  <InlineEditable
    bind:this={editor}
    value=""
    {onSave}
    {onDiscard}
    multiline
    autosave={false}
    submitOnEnter
    clearOnSave
    revertOnEscape
    maxLength={BOARD_CARD_TEXT_MAX_CHARS}
    placeholder={t('board.card.placeholder')}
    delayMs={600}
    ariaLabel={t('board.card.placeholder')}
    testid="board-card-composer"
  />
</div>

<script lang="ts">
  import { ChevronRight, X } from '@lucide/svelte';
  import { CONVERSATION_NOTE_TEXT_MAX_CHARS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import type { NoteItem } from './note-model';

  /**
   * 一条便签：多行文本直接编辑（无输入框外观，点按即出现光标），超过 4 行时
   * 卡片底部出现 20px 折叠行；收起后最后一行被同色渐变遮住，像文字渐隐。
   */
  let {
    note,
    autofocus = false,
    oninput,
    onblur,
    ondelete,
  }: {
    note: NoteItem;
    autofocus?: boolean;
    oninput: (text: string) => void;
    onblur: () => void;
    ondelete: () => void;
  } = $props();

  const COLLAPSED_LINES = 4;
  /** text-sm（14px）+ leading-6（24px）；measure 会用实际计算值覆盖。 */
  const FALLBACK_LINE_HEIGHT = 24;

  let textarea = $state<HTMLTextAreaElement | null>(null);
  let overflowing = $state(false);
  let collapsed = $state(false);
  let collapsedHeight = $state(FALLBACK_LINE_HEIGHT * COLLAPSED_LINES);
  let lastWidth = 0;

  function measure(): void {
    const el = textarea;
    if (el === null) return;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT;
    collapsedHeight = lh * COLLAPSED_LINES;
    const next = el.scrollHeight > collapsedHeight + 1;
    overflowing = next;
    if (!next) collapsed = false;
  }

  // 文本变化后重算（$effect 在 DOM 更新后运行）。
  $effect(() => {
    if (note.text.length >= 0) measure();
  });

  // 宽度变化会改变换行，从而改变高度；高度变化本身不重复测量。
  $effect(() => {
    const el = textarea;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (autofocus) textarea?.focus();
  });

  function toggle(): void {
    collapsed = !collapsed;
    measure();
  }
</script>

<div class="group relative rounded-md border bg-background px-2.5 py-2" data-testid="note-card">
  <textarea
    bind:this={textarea}
    class="block field-sizing-content w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-sm leading-6 break-words whitespace-pre-wrap outline-none focus:outline-none focus-visible:ring-0"
    style:max-height={collapsed ? `${collapsedHeight}px` : undefined}
    value={note.text}
    maxlength={CONVERSATION_NOTE_TEXT_MAX_CHARS}
    placeholder={t('rightPanel.notesPlaceholder')}
    aria-label={t('rightPanel.notesPlaceholder')}
    oninput={(event) => oninput(event.currentTarget.value)}
    {onblur}
    onfocus={() => {
      if (collapsed) {
        collapsed = false;
        measure();
      }
    }}
    data-testid="note-textarea"></textarea>

  {#if overflowing && collapsed}
    <!-- 折叠遮罩：覆盖卡片下半部，由卡片底色渐隐到透明。 -->
    <div
      class="pointer-events-none absolute inset-x-0 top-1/2 bottom-0 z-[5] bg-gradient-to-t from-background to-transparent"
      aria-hidden="true"
      data-testid="note-collapse-mask"
    ></div>
  {/if}

  {#if overflowing}
    <button
      type="button"
      class={collapsed
        ? 'absolute inset-x-0 bottom-0 z-10 flex h-5 w-full items-center justify-center bg-gradient-to-t from-background to-transparent text-muted-foreground'
        : 'flex h-5 w-full items-center justify-center text-muted-foreground transition-colors hover:text-foreground'}
      title={t(collapsed ? 'rightPanel.notesExpand' : 'rightPanel.notesCollapse')}
      aria-label={t(collapsed ? 'rightPanel.notesExpand' : 'rightPanel.notesCollapse')}
      aria-expanded={!collapsed}
      onclick={toggle}
      data-testid="note-collapse-toggle"
    >
      <ChevronRight class="size-3.5 {collapsed ? 'rotate-90' : '-rotate-90'}" aria-hidden="true" />
    </button>
  {/if}

  <button
    type="button"
    class="absolute top-1 right-1 z-20 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-has-[textarea:focus]:pointer-events-none group-has-[textarea:focus]:opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
    title={t('rightPanel.notesDelete')}
    aria-label={t('rightPanel.notesDelete')}
    onclick={() => ondelete()}
    data-testid="note-delete"
  >
    <X class="size-3" aria-hidden="true" />
  </button>
</div>

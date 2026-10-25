<script lang="ts">
  import { onMount } from 'svelte';
  import {
    InlineEditScheduler,
    normalizeMultiline,
    normalizeSingleLine,
    shouldRestoreComposerFocus,
    truncateCodePoints,
  } from './inline-editable.svelte';

  /**
   * Plain-text field that looks like static text until the caret appears
   * (design 50 §9.7). Column titles are single-line; card text is multiline.
   * The new-card composer turns autosave off and submits on Enter.
   */
  let {
    value,
    onSave,
    multiline = false,
    maxLength,
    placeholder = '',
    delayMs,
    ariaLabel,
    testid,
    autosave = true,
    submitOnEnter = false,
    clearOnSave = false,
    revertOnEscape = !multiline,
    onDiscard,
  }: {
    value: string;
    onSave: (text: string) => Promise<boolean>;
    multiline?: boolean;
    maxLength?: number;
    placeholder?: string;
    delayMs: number;
    ariaLabel: string;
    testid?: string;
    /** False: only flush / blur / dispose save (new-card composer). */
    autosave?: boolean;
    /** Enter commits; Shift+Enter inserts a newline. */
    submitOnEnter?: boolean;
    /** After a successful commit, clear the field and keep focus. */
    clearOnSave?: boolean;
    /** Escape restores and blurs, and preventDefault (escape-layers). */
    revertOnEscape?: boolean;
    /** Called after Escape or an empty blur (composer closes). */
    onDiscard?: () => void;
  } = $props();

  let root = $state<HTMLElement | null>(null);
  let focused = $state(false);

  const scheduler = new InlineEditScheduler({
    get delayMs() {
      return delayMs;
    },
    get autosave() {
      return autosave;
    },
    normalize: (text) => (multiline ? normalizeMultiline(text) : normalizeSingleLine(text)),
    save: (text) => onSave(text),
    onSettled: (ok) => {
      if (!clearOnSave || !ok || scheduler.hasUnsaved()) return;
      const field = root;
      const active = typeof document === 'undefined' ? null : document.activeElement;
      scheduler.reset('');
      writeDom('');
      if (field !== null && shouldRestoreComposerFocus(active, field)) field.focus();
    },
  });

  function readText(): string {
    return root?.textContent ?? '';
  }

  function writeDom(text: string): void {
    if (root === null || root.textContent === text) return;
    // contenteditable: assign textContent directly so a Svelte redraw does not drop the caret.
    // eslint-disable-next-line svelte/no-dom-manipulating
    root.textContent = text;
  }

  function clamp(text: string): string {
    let next = multiline ? text : text.replace(/\r\n|\n|\r/g, ' ');
    if (maxLength !== undefined) next = truncateCodePoints(next, maxLength);
    return next;
  }

  function publishLiveText(): void {
    const next = clamp(readText());
    if (next !== readText()) writeDom(next);
    scheduler.draft = readText();
  }

  function insertText(text: string): void {
    const selection = window.getSelection();
    if (root === null || selection === null || selection.rangeCount === 0) {
      writeDom(clamp(`${readText()}${text}`));
      scheduler.draft = readText();
      scheduler.onInput();
      return;
    }
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    publishLiveText();
    scheduler.onInput();
  }

  $effect(() => {
    const next = value;
    if (focused || scheduler.hasUnsaved() || scheduler.isSaving() || scheduler.isComposing())
      return;
    scheduler.sync(next);
  });

  $effect(() => {
    const next = scheduler.draft;
    if (root === null) return;
    writeDom(next);
  });

  onMount(() => {
    return () => {
      scheduler.dispose();
    };
  });

  export function flush(): Promise<boolean> {
    return scheduler.flush();
  }

  export function focus(selectAll = false): void {
    root?.focus();
    if (!selectAll || root === null) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function onFocus(): void {
    focused = true;
  }

  async function onBlur(): Promise<void> {
    focused = false;
    if (scheduler.isComposing()) {
      await scheduler.flush();
      return;
    }
    const ok = await scheduler.flush();
    if (!ok && scheduler.draft.trim().length === 0) onDiscard?.();
  }

  function onInput(event: Event): void {
    if ((event as InputEvent).isComposing || scheduler.isComposing()) {
      scheduler.onInput(event);
      return;
    }
    publishLiveText();
    scheduler.onInput(event);
  }

  function onCompositionStart(): void {
    scheduler.onCompositionStart();
  }

  function onCompositionEnd(): void {
    publishLiveText();
    scheduler.onCompositionEnd();
  }

  function onPaste(event: ClipboardEvent): void {
    event.preventDefault();
    let text = event.clipboardData?.getData('text/plain') ?? '';
    if (!multiline) text = text.replace(/\r\n|\n|\r/g, ' ');
    insertText(text);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && revertOnEscape) {
      event.preventDefault();
      scheduler.cancel();
      writeDom(scheduler.draft);
      root?.blur();
      onDiscard?.();
      return;
    }
    if (event.key !== 'Enter') return;
    if (submitOnEnter && event.shiftKey) {
      event.preventDefault();
      insertText('\n');
      return;
    }
    if (submitOnEnter && !event.shiftKey) {
      event.preventDefault();
      void scheduler.flush();
      return;
    }
    if (!multiline) {
      event.preventDefault();
      root?.blur();
    }
  }
</script>

<div
  bind:this={root}
  class="inline-editable min-h-[1.25rem] outline-none focus:outline-none {multiline
    ? 'break-words whitespace-pre-wrap'
    : 'truncate whitespace-nowrap'}"
  contenteditable="plaintext-only"
  role="textbox"
  tabindex="0"
  aria-multiline={multiline}
  aria-label={ariaLabel}
  data-testid={testid}
  data-placeholder={placeholder}
  onfocus={onFocus}
  onblur={() => void onBlur()}
  oninput={onInput}
  oncompositionstart={onCompositionStart}
  oncompositionend={onCompositionEnd}
  onpaste={onPaste}
  onkeydown={onKeydown}
></div>

<style>
  .inline-editable {
    caret-color: var(--foreground);
  }
  /* Placeholder is painted, not a text node, so the box does not grow a second line. */
  .inline-editable:empty::before {
    content: attr(data-placeholder);
    color: var(--muted-foreground);
    pointer-events: none;
  }
</style>

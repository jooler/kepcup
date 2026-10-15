<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Memo } from '@kepcup/shared';
  import { MEMO_BODY_MAX_CHARS } from '@kepcup/shared';
  import { ListPlus, Pin, PinOff, Sparkles, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { ageText } from './age-text';
  import { memoToTodoDraft } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘卡（D90 §5.4）：正文可点即改（contenteditable），防抖保存；相对时间与管家来源徽标；
   * 操作——置顶、转为事项、删除（进最近删除，toast 里可撤销）。Esc 放弃未保存改动。
   */
  let { memo }: { memo: Memo } = $props();

  const SAVE_DEBOUNCE_MS = 450;

  let bodyEl = $state<HTMLElement | null>(null);
  let focused = $state(false);
  let saving = $state(false);
  /** 本地草稿；未聚焦且未脏时跟 `memo.body` 对齐。 */
  let draft = $state('');
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = $state(false);
  /** 当前编辑区绑定的备忘 id；换卡时重灌正文。 */
  let seededId = $state<string | null>(null);

  const converted = $derived(workbench.todos.some((todo) => todo.memoId === memo.id));
  const age = $derived(ageText(memo.updatedAt));

  function clearTimer(): void {
    if (saveTimer === null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
  }

  onDestroy(() => clearTimer());

  function writeDom(text: string): void {
    if (bodyEl === null || bodyEl.textContent === text) return;
    bodyEl.textContent = text;
  }

  // 挂载 / 换卡：把正文写入 contenteditable（不把 `{memo.body}` 放进子节点，以免重绘打光标）。
  $effect(() => {
    const el = bodyEl;
    const id = memo.id;
    if (el === null) return;
    if (seededId === id) return;
    clearTimer();
    dirty = false;
    focused = false;
    draft = memo.body;
    seededId = id;
    el.textContent = memo.body;
  });

  // 外部正文变了：没在改时同步。
  $effect(() => {
    const body = memo.body;
    if (seededId !== memo.id || dirty || focused) return;
    draft = body;
    writeDom(body);
  });

  function failed(error: unknown): void {
    toast.error(
      errorText((error as { code?: string } | undefined)?.code, t('workbench.memo.saveFailed')),
    );
  }

  function readBody(): string {
    return (bodyEl?.innerText ?? draft).replace(/\u00a0/g, ' ');
  }

  function scheduleSave(): void {
    dirty = true;
    draft = readBody();
    clearTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persist();
    }, SAVE_DEBOUNCE_MS);
  }

  async function persist(): Promise<void> {
    const body = readBody().trim();
    if (saving) return;
    if (body.length === 0) return;
    if (body === memo.body) {
      dirty = false;
      return;
    }
    if (body.length > MEMO_BODY_MAX_CHARS) {
      toast.error(t('workbench.memo.saveFailed'));
      return;
    }
    saving = true;
    try {
      const result = (await core.call('memos.update', { id: memo.id, body })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      dirty = false;
      draft = result.memo.body;
    } catch (error) {
      failed(error);
    } finally {
      saving = false;
    }
  }

  function onInput(): void {
    const raw = bodyEl?.innerText ?? '';
    if (raw.length > MEMO_BODY_MAX_CHARS && bodyEl !== null) {
      const clipped = raw.slice(0, MEMO_BODY_MAX_CHARS);
      bodyEl.textContent = clipped;
      const selection = window.getSelection();
      if (selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(bodyEl);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    scheduleSave();
  }

  function onFocus(): void {
    focused = true;
  }

  function onBlur(): void {
    focused = false;
    clearTimer();
    const body = readBody().trim();
    if (body.length === 0) {
      dirty = false;
      draft = memo.body;
      writeDom(memo.body);
      return;
    }
    void persist();
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key !== 'Escape') return;
    event.preventDefault();
    clearTimer();
    dirty = false;
    draft = memo.body;
    writeDom(memo.body);
    bodyEl?.blur();
  }

  async function togglePin(): Promise<void> {
    try {
      const result = (await core.call('memos.update', { id: memo.id, pinned: !memo.pinned })) as {
        memo: Memo;
      };
      workbench.upsertMemo(result.memo);
    } catch (error) {
      failed(error);
    }
  }

  function toTodo(): void {
    workbench.newTodo({ ...memoToTodoDraft(memo.body), memoId: memo.id });
  }

  async function remove(): Promise<void> {
    clearTimer();
    try {
      const result = (await core.call('memos.delete', { id: memo.id })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      toast(t('workbench.memo.deleted'), {
        action: { label: t('workbench.memo.undo'), onClick: () => void restore(memo.id) },
      });
    } catch (error) {
      failed(error);
    }
  }

  async function restore(id: string): Promise<void> {
    try {
      const result = (await core.call('memos.restore', { id })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
    } catch (error) {
      failed(error);
    }
  }
</script>

<div
  class="group/memo rounded-lg border bg-card p-3 text-sm"
  data-testid="memo-card"
  data-memo-id={memo.id}
  data-pinned={memo.pinned ? 'true' : 'false'}
>
  <div
    bind:this={bodyEl}
    contenteditable="plaintext-only"
    role="textbox"
    tabindex="0"
    aria-multiline="true"
    aria-label={t('workbench.memo.title')}
    class="min-h-[1.25rem] break-words whitespace-pre-wrap outline-none focus:outline-none {focused
      ? 'max-h-48 overflow-y-auto'
      : 'line-clamp-6'}"
    data-testid="memo-body"
    oninput={onInput}
    onfocus={onFocus}
    onblur={onBlur}
    onkeydown={onKeydown}
  ></div>
  <div class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
    {#if memo.pinned}
      <Pin class="size-3 shrink-0 text-amber-600" aria-hidden="true" />
    {/if}
    <span data-testid="memo-age">{age}</span>
    {#if memo.source === 'butler'}
      <span
        class="inline-flex items-center gap-0.5 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-violet-700 dark:text-violet-400"
        data-testid="memo-butler"
      >
        <Sparkles class="size-3" aria-hidden="true" />{t('workbench.memo.byButler')}
      </span>
    {/if}
    {#if converted}
      <span class="rounded-md bg-muted px-1.5 py-0.5" data-testid="memo-converted">
        {t('workbench.memo.converted')}
      </span>
    {/if}
    <span class="flex-1"></span>
    <div
      class="flex items-center gap-0.5 opacity-60 transition-opacity group-focus-within/memo:opacity-100 group-hover/memo:opacity-100"
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={memo.pinned ? t('workbench.memo.unpin') : t('workbench.memo.pin')}
        title={memo.pinned ? t('workbench.memo.unpin') : t('workbench.memo.pin')}
        onclick={() => void togglePin()}
        data-testid="memo-pin"
      >
        {#if memo.pinned}<PinOff />{:else}<Pin />{/if}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('workbench.memo.toTodo')}
        title={t('workbench.memo.toTodo')}
        onclick={toTodo}
        data-testid="memo-to-todo"
      >
        <ListPlus />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('workbench.memo.delete')}
        title={t('workbench.memo.delete')}
        onclick={() => void remove()}
        data-testid="memo-delete"
      >
        <Trash2 />
      </Button>
    </div>
  </div>
</div>

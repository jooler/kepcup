<script lang="ts">
  import type { Memo } from '@kepcup/shared';
  import { MEMO_BODY_MAX_CHARS } from '@kepcup/shared';
  import { ListPlus, Pencil, Pin, PinOff, Sparkles, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { ageText } from './age-text';
  import { memoToTodoDraft } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘卡（D90 §5.4）：正文最多显示 6 行，相对时间与管家来源徽标；操作——置顶、原地编辑、
   * 转为事项（打开事项抽屉并预填）、删除（进最近删除，toast 里可撤销）。
   * 编辑：回车保存，Shift+回车换行，Esc 放弃。
   */
  let { memo }: { memo: Memo } = $props();

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let editor = $state<HTMLTextAreaElement | null>(null);

  // 进入编辑后把焦点放进输入框，光标落在末尾。
  $effect(() => {
    if (!editing || editor === null) return;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  });

  const converted = $derived(workbench.todos.some((todo) => todo.memoId === memo.id));
  const age = $derived(ageText(memo.updatedAt));

  function failed(error: unknown): void {
    toast.error(
      errorText((error as { code?: string } | undefined)?.code, t('workbench.memo.saveFailed')),
    );
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

  function startEdit(): void {
    draft = memo.body;
    editing = true;
  }

  async function saveEdit(): Promise<void> {
    const body = draft.trim();
    if (saving) return;
    if (body.length === 0 || body === memo.body) {
      editing = false;
      return;
    }
    saving = true;
    try {
      const result = (await core.call('memos.update', { id: memo.id, body })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      editing = false;
    } catch (error) {
      failed(error);
    } finally {
      saving = false;
    }
  }

  function onEditKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // 控件自己消费 Esc（preventDefault），不让全局 Esc 仲裁再关别的层。
      event.preventDefault();
      editing = false;
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229)
      return;
    event.preventDefault();
    void saveEdit();
  }

  function toTodo(): void {
    workbench.newTodo({ ...memoToTodoDraft(memo.body), memoId: memo.id });
  }

  async function remove(): Promise<void> {
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
  {#if editing}
    <Textarea
      bind:ref={editor}
      bind:value={draft}
      maxlength={MEMO_BODY_MAX_CHARS}
      rows={3}
      onkeydown={onEditKeydown}
      data-testid="memo-edit-input"
    />
    <div class="mt-2 flex justify-end gap-1">
      <Button
        size="xs"
        variant="ghost"
        onclick={() => (editing = false)}
        data-testid="memo-edit-cancel"
      >
        {t('workbench.memo.editCancel')}
      </Button>
      <Button
        size="xs"
        disabled={saving}
        onclick={() => void saveEdit()}
        data-testid="memo-edit-save"
      >
        {t('workbench.memo.editSave')}
      </Button>
    </div>
  {:else}
    <p class="line-clamp-6 break-words whitespace-pre-wrap" data-testid="memo-body">{memo.body}</p>
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
          aria-label={t('workbench.memo.edit')}
          title={t('workbench.memo.edit')}
          onclick={startEdit}
          data-testid="memo-edit"
        >
          <Pencil />
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
  {/if}
</div>

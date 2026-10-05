<script lang="ts">
  import { ArrowUp, GripVertical, Paperclip, Pencil, Trash2, X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import type { Draft } from '@kepcup/shared';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { chat } from '$lib/stores/chat.svelte';

  let { drafts }: { drafts: Draft[] } = $props();

  let editingId = $state<string | null>(null);
  let editText = $state('');
  /** 正在拖拽的草稿 id（dragenter 交换排序，dragend 清除）。 */
  let draggingId = $state<string | null>(null);

  function startEdit(draft: Draft): void {
    editingId = draft.id;
    editText = draft.text;
  }

  async function saveEdit(): Promise<void> {
    const id = editingId;
    editingId = null;
    if (!id) return;
    if (editText.trim().length === 0) {
      await chat.removeDraft(id);
    } else {
      await chat.updateDraft(id, editText);
    }
  }

  function dragStart(draft: Draft, event: DragEvent): void {
    draggingId = draft.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // Firefox 需要 setData 才会进入拖拽；内容无意义，仅作启用标记。
      event.dataTransfer.setData('text/plain', draft.id);
    }
  }

  async function dragEnter(draft: Draft): Promise<void> {
    if (draggingId === null || draggingId === draft.id) return;
    const ids = drafts.map((d) => d.id);
    const from = ids.indexOf(draggingId);
    const to = ids.indexOf(draft.id);
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    if (moved === undefined) return;
    ids.splice(to, 0, moved);
    await chat.reorderDrafts(ids);
  }

  function dragEnd(): void {
    draggingId = null;
  }
</script>

{#if drafts.length > 0}
  <!-- 内嵌在输入坞里的待发送行（参考 Grok）：拖拽把手 + 内容 + 立即/编辑/删除 -->
  <div class="flex flex-col gap-1" role="list" data-testid="draft-queue">
    {#each drafts as draft (draft.id)}
      <div
        class="group flex items-center gap-1 rounded-full bg-muted/50 px-2 py-1 transition-opacity
           {draggingId === draft.id ? 'opacity-50' : ''}"
        role="listitem"
        draggable="true"
        ondragstart={(event) => dragStart(draft, event)}
        ondragenter={() => void dragEnter(draft)}
        ondragover={(event) => event.preventDefault()}
        ondragend={dragEnd}
        data-testid={`draft-item-${draft.id}`}
      >
        <GripVertical
          class="size-3.5 shrink-0 cursor-grab text-muted-foreground"
          aria-hidden="true"
        />
        {#if editingId === draft.id}
          <Textarea
            bind:value={editText}
            rows={2}
            class="min-h-0 flex-1 border-none bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            data-testid="draft-edit-input"
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                void saveEdit();
              }
              if (event.key === 'Escape') editingId = null;
            }}
          />
        {:else}
          <button
            type="button"
            class="min-w-0 flex-1 cursor-text truncate text-left text-sm"
            onclick={() => startEdit(draft)}
            data-testid="draft-text"
          >
            {draft.text.length > 0
              ? draft.text
              : t('composer.draftAttachmentOnly', { count: draft.attachments.length })}
          </button>
        {/if}
        {#if draft.attachments.length > 0}
          <span class="flex shrink-0 items-center gap-1" data-testid="draft-attachments">
            {#each draft.attachments as attachment (attachment.id)}
              <span
                class="flex items-center gap-0.5 rounded-full border border-border/40 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                <Paperclip class="size-2.5" />
                <span class="max-w-24 truncate">{attachment.fileName}</span>
                <button
                  type="button"
                  class="rounded-full p-0.5 hover:bg-accent hover:text-destructive"
                  onclick={() => void chat.detachAttachment(attachment.id)}
                  aria-label={t('composer.attachmentRemove')}
                  data-testid={`draft-attachment-remove-${attachment.id}`}
                >
                  <X class="size-2.5" />
                </button>
              </span>
            {/each}
          </span>
        {/if}
        <span class="flex shrink-0 items-center gap-0.5">
          <Button
            variant="outline"
            size="sm"
            class="h-7 gap-1 rounded-lg border-border/40 px-2 text-xs font-normal"
            onclick={() => void chat.flushOne(draft.id)}
            data-testid="draft-send-now"
          >
            <ArrowUp class="size-3" aria-hidden="true" />
            {t('composer.sendNow')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 text-muted-foreground hover:text-foreground"
            onclick={() => startEdit(draft)}
            aria-label={t('composer.draftEdit')}
            data-testid="draft-edit"
          >
            <Pencil class="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="size-7 text-muted-foreground hover:text-destructive"
            onclick={() => void chat.removeDraft(draft.id)}
            aria-label={t('composer.queueRemove')}
            data-testid="draft-remove"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </span>
      </div>
    {/each}
  </div>
{/if}

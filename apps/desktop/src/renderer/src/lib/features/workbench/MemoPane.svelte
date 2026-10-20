<script lang="ts">
  import type { Memo } from '@kepcup/shared';
  import { MEMO_BODY_MAX_CHARS } from '@kepcup/shared';
  import { ArrowLeft, Search, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import MemoCard from './MemoCard.svelte';
  import { ageText } from './age-text';
  import { filterMemos, sortMemos } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘栏（D90 §5.4）：常驻输入框（回车保存、Shift+回车换行、存完清空并保持焦点）→ 本地
   * 即时搜索 → 列表（置顶在前，其余按更新时间倒序）；「最近删除」切到回收视图，可恢复。
   */
  let draft = $state('');
  let saving = $state(false);
  let query = $state('');
  let input = $state<HTMLTextAreaElement | null>(null);

  const visible = $derived(sortMemos(filterMemos(workbench.memos, query)));
  const trashed = $derived(
    [...workbench.trashed].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
  );

  async function save(): Promise<void> {
    const body = draft.trim();
    if (body.length === 0 || saving) return;
    saving = true;
    try {
      const result = (await core.call('memos.create', { body })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      draft = '';
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('workbench.memo.saveFailed')),
      );
    } finally {
      saving = false;
      input?.focus();
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229)
      return;
    event.preventDefault();
    void save();
  }

  async function restore(id: string): Promise<void> {
    try {
      const result = (await core.call('memos.restore', { id })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      toast.success(t('workbench.memo.restored'));
    } catch (error) {
      toast.error(
        errorText((error as { code?: string } | undefined)?.code, t('workbench.memo.saveFailed')),
      );
    }
  }
</script>

<div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-3" data-testid="memo-pane">
  {#if workbench.trashOpen}
    <div class="flex shrink-0 items-center gap-2">
      <Button
        size="xs"
        variant="ghost"
        onclick={() => workbench.closeTrash()}
        data-testid="memo-trash-back"
      >
        <ArrowLeft />{t('workbench.memo.backToMemos')}
      </Button>
    </div>
    <p class="shrink-0 text-xs text-muted-foreground">{t('workbench.memo.trashHint')}</p>
    <div
      class="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 overflow-y-auto"
      data-testid="memo-trash-list"
    >
      {#if trashed.length === 0}
        <p
          class="col-span-full py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-trash-empty"
        >
          {t('workbench.memo.trashEmpty')}
        </p>
      {/if}
      {#each trashed as memo (memo.id)}
        <div
          class="min-w-0 rounded-lg border bg-card p-3 text-sm"
          data-testid="memo-trash-item"
          data-memo-id={memo.id}
        >
          <p class="line-clamp-6 break-words whitespace-pre-wrap text-muted-foreground">
            {memo.body}
          </p>
          <div class="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{ageText(memo.deletedAt ?? memo.updatedAt)}</span>
            <Button
              size="xs"
              variant="outline"
              onclick={() => void restore(memo.id)}
              data-testid="memo-restore"
            >
              {t('workbench.memo.restore')}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <Textarea
      bind:ref={input}
      bind:value={draft}
      maxlength={MEMO_BODY_MAX_CHARS}
      rows={2}
      placeholder={t('workbench.memo.inputPlaceholder')}
      class="max-h-40 min-h-16 shrink-0 resize-none"
      onkeydown={onKeydown}
      data-testid="memo-input"
    />
    <div class="relative shrink-0">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        bind:value={query}
        placeholder={t('workbench.memo.searchPlaceholder')}
        class="h-8 pl-8"
        data-testid="memo-search"
      />
    </div>
    <div
      class="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2 overflow-y-auto"
      data-testid="memo-list"
    >
      {#if workbench.memos.length === 0 && (workbench.loadState === 'loading' || workbench.loadState === 'idle')}
        <p
          class="col-span-full py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-loading"
        >
          {t('workbench.loading')}
        </p>
      {:else if workbench.memos.length === 0 && workbench.loadState === 'error'}
        <!-- 错误提示在视图顶部（带重试），这里不显示「空」 -->
      {:else if workbench.memos.length === 0}
        <p
          class="col-span-full py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-empty"
        >
          {t('workbench.memo.empty')}
        </p>
      {:else if visible.length === 0}
        <p
          class="col-span-full py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-no-match"
        >
          {t('workbench.memo.noMatch')}
        </p>
      {/if}
      {#each visible as memo (memo.id)}
        <MemoCard {memo} />
      {/each}
    </div>
    <button
      type="button"
      class="flex shrink-0 cursor-pointer items-center gap-1 self-start px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
      onclick={() => void workbench.openTrash()}
      data-testid="memo-trash"
    >
      <Trash2 class="size-3.5" aria-hidden="true" />{t('workbench.memo.trash')}
    </button>
  {/if}
</div>

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
  import { boardFlipDurationMs } from '$lib/features/board/board-dnd';
  import MemoCard from './MemoCard.svelte';
  import MemoGrid from './MemoGrid.svelte';
  import MemoTabs from './MemoTabs.svelte';
  import { ageText } from './age-text';
  import {
    effectiveMemoTab,
    filterMemos,
    showUngroupedTab,
    sortMemos,
    type MemoTabId,
  } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘栏（D90 §5.4，分组用 tab 组织）：常驻输入框（回车保存到当前 tab 的分组、Shift+回车换行、
   * 存完清空并保持焦点）→ 搜索框 → 分组 tab 栏（MemoTabs）→ 当前 tab 的卡片网格 → 底部「最近删除」。
   *
   * - 「未分组」伪分组保持原特性：有未分组条目才显示其 tab，恒在第一位，不能排序 / 改名 / 删除；
   *   当前 tab 是它时新建的备忘不带分组，自然落入其中。
   * - 所有分组的网格常驻挂载，非当前 tab 只是 display:none：dnd-action 在拖起那一刻固定落区集合，
   *   拖拽中悬停 tab 切过去的网格必须早已注册；也保证被拖卡片所在的原网格不被卸载。
   * - 搜索中隐藏 tab 栏与网格，显示跨全部分组的命中列表（只读，不可拖）。
   * - 「最近删除」切到回收视图，可恢复。
   *
   * 草稿、搜索词与当前 tab 存在 `workbench` store 里（不是组件 `$state`）：切到对话会把工作台
   * 整棵卸载，放组件里切回来就没了（见 workbench.svelte.ts 的字段注释）。
   */
  let saving = $state(false);
  let input = $state<HTMLTextAreaElement | null>(null);
  let reducedMotion = $state(false);

  const searching = $derived(workbench.memoQuery.trim() !== '');
  const searchResults = $derived(
    searching ? sortMemos(filterMemos(workbench.memos, workbench.memoQuery)) : [],
  );
  const ungroupedShown = $derived(showUngroupedTab(workbench.memos, workbench.memoDragging));
  const activeTab = $derived(
    effectiveMemoTab(workbench.activeMemoTabId, workbench.memoGroups, ungroupedShown),
  );
  /** 各分组（null = 未分组）的显示顺序列表，一次算好分给各网格。 */
  const byGroup = $derived.by(() => {
    // Plain Map: group memos for one render pass, not reactive UI state.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const map = new Map<string | null, Memo[]>();
    for (const memo of sortMemos(workbench.memos)) {
      const list = map.get(memo.groupId);
      if (list === undefined) map.set(memo.groupId, [memo]);
      else list.push(memo);
    }
    return map;
  });
  const flipDurationMs = $derived(boardFlipDurationMs(reducedMotion));
  const trashed = $derived(
    [...workbench.trashed].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
  );
  const EMPTY: Memo[] = [];

  $effect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = media.matches;
    const onChange = (): void => {
      reducedMotion = media.matches;
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  });

  function selectTab(id: MemoTabId): void {
    workbench.activeMemoTabId = id;
  }

  async function save(): Promise<void> {
    const body = workbench.memoDraft.trim();
    if (body.length === 0 || saving) return;
    saving = true;
    // 落到当前 tab 的分组；当前是伪分组（或还没有任何 tab）就不带分组，自然落入「未分组」。
    const tab = activeTab;
    const groupId = tab === null || tab === 'ungrouped' ? undefined : tab;
    try {
      const result = (await core.call('memos.create', {
        body,
        ...(groupId !== undefined ? { groupId } : {}),
      })) as { memo: Memo };
      workbench.upsertMemo(result.memo);
      workbench.memoDraft = '';
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
      bind:value={workbench.memoDraft}
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
        bind:value={workbench.memoQuery}
        placeholder={t('workbench.memo.searchPlaceholder')}
        class="h-8 pl-8"
        data-testid="memo-search"
      />
    </div>
    {#if !searching}
      <MemoTabs active={activeTab} {ungroupedShown} {flipDurationMs} onSelect={selectTab} />
    {/if}
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1" data-testid="memo-list">
      {#if workbench.memos.length === 0 && (workbench.loadState === 'loading' || workbench.loadState === 'idle')}
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-loading"
        >
          {t('workbench.loading')}
        </p>
      {:else if workbench.memos.length === 0 && workbench.loadState === 'error'}
        <!-- 错误提示在视图顶部（带重试），这里不显示「空」 -->
      {:else if searching}
        {#if searchResults.length === 0}
          <p
            class="py-6 text-center text-sm text-muted-foreground"
            data-testid="memo-no-match"
          >
            {t('workbench.memo.noMatch')}
          </p>
        {:else}
          <div
            class="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2"
            data-testid="memo-search-results"
          >
            {#each searchResults as memo (memo.id)}
              <MemoCard {memo} draggable={false} />
            {/each}
          </div>
        {/if}
      {:else if activeTab === null}
        <!-- 还没有任何 tab：既没有未分组条目，也没有命名分组。 -->
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-empty"
        >
          {t('workbench.memo.empty')}
        </p>
      {/if}
      {#if !searching}
        <!-- 各分组网格常驻挂载，非当前 tab 只是 display:none（见上方注释）。 -->
        <div
          style:display={activeTab === 'ungrouped' ? undefined : 'none'}
          data-testid="memo-section"
          data-section-group-id="ungrouped"
        >
          <MemoGrid memos={byGroup.get(null) ?? EMPTY} groupId={null} {flipDurationMs} />
        </div>
        {#each workbench.memoGroups as group (group.id)}
          <div
            style:display={activeTab === group.id ? undefined : 'none'}
            data-testid="memo-section"
            data-section-group-id={group.id}
          >
            <MemoGrid memos={byGroup.get(group.id) ?? EMPTY} groupId={group.id} {flipDurationMs} />
          </div>
        {/each}
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
        onclick={() => void workbench.openTrash()}
        data-testid="memo-trash"
      >
        <Trash2 class="size-3.5" aria-hidden="true" />{t('workbench.memo.trash')}
      </button>
    </div>
  {/if}
</div>

<script lang="ts">
  import type { Memo } from '@kepcup/shared';
  import { MEMO_BODY_MAX_CHARS } from '@kepcup/shared';
  import { ArrowLeft, Plus, Search, Trash2 } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as Dialog from '$lib/components/ui/dialog';
  import {
    anchorFromFinalize,
    boardFlipDurationMs,
    draggedElementHeight,
    isNoopMove,
    isShadow,
    stripShadow,
  } from '$lib/features/board/board-dnd';
  import MemoGroupSection from './MemoGroupSection.svelte';
  import { ageText } from './age-text';
  import { memoSections, shouldShowUngrouped, type MemoSection } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘栏（D90 §5.4）：常驻输入框（回车保存、Shift+回车换行、存完清空并保持焦点）→
   * 分区列表（未分组伪分组在最前，其后按顺序的命名分组；无命名分组时保持旧的扁平列表）
   * → 底部「添加分组」「最近删除」。命名分组的列表包在分组拖拽区（type 'group'，拖分区
   * header 重排，照看板列层）；每个分区内部是备忘拖拽区（type 'memo'），可组内排序、
   * 跨组拖拽。「最近删除」切到回收视图，可恢复。
   *
   * 草稿与搜索词存在 `workbench` store 里（不是组件 `$state`）：切到对话会把工作台
   * 整棵卸载，放组件里切回来就没了（见 workbench.svelte.ts 的字段注释）。
   */
  let saving = $state(false);
  let input = $state<HTMLTextAreaElement | null>(null);
  let reducedMotion = $state(false);

  // 新建分组弹框：工作台离开即卸载（与抽屉一致），状态放组件内即可。
  let createOpen = $state(false);
  let groupName = $state('');
  let nameInput = $state<HTMLInputElement | null>(null);
  let creating = $state(false);

  const sections = $derived(
    memoSections({ memos: workbench.memos, groups: workbench.memoGroups, query: workbench.memoQuery }),
  );
  const showHeaders = $derived(workbench.memoGroups.length > 0);
  const flipDurationMs = $derived(boardFlipDurationMs(reducedMotion));
  const ungroupedSection = $derived(sections.find((section) => section.groupId === null) ?? null);
  /**
   * 未分组区空着时用 display:none 隐藏（不占位，也不出 header / 空提示）；
   * 拖拽中仍显示，否则卡片没有「未分组」这个落点可拖回去。新备忘默认进未分组，
   * memos 一变这个 derived 就跟着变，存完立刻重新出现。
   */
  const showUngroupedSection = $derived(
    shouldShowUngrouped(ungroupedSection, workbench.memoDragging),
  );
  /** 分组拖拽区的 items 需要 `id` 字段（dnd-action 的标识），即 groupId。 */
  const namedSections = $derived(
    sections
      .filter((section): section is MemoSection & { groupId: string } => section.groupId !== null)
      .map((section) => ({ ...section, id: section.groupId })),
  );
  const trashed = $derived(
    [...workbench.trashed].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
  );

  let groupItems = $state.raw<(MemoSection & { id: string })[]>([]);
  /** 分组拖拽浮动副本的实测高度（钉住占位，同看板列层）。 */
  let groupShadowHeight = $state<number | null>(null);

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

  // 弹框打开时聚焦输入框并全选（重命名类对话框的惯例）。
  $effect(() => {
    if (!createOpen) return;
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  });

  $effect(() => {
    const next = namedSections;
    if (workbench.groupDragging) return;
    groupItems = next;
  });

  function onGroupConsider(event: CustomEvent<DndEvent<MemoSection & { id: string }>>): void {
    const info = event.detail.info;
    if (info.trigger === 'dragStopped') {
      groupShadowHeight = null;
      workbench.setGroupDragging(false);
      return;
    }
    if (info.trigger === 'dragStarted') groupShadowHeight = draggedElementHeight();
    groupItems = event.detail.items;
    workbench.setGroupDragging(true);
  }

  function onGroupFinalize(event: CustomEvent<DndEvent<MemoSection & { id: string }>>): void {
    const info = event.detail.info;
    groupShadowHeight = null;
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') groupItems = stripShadow(event.detail.items);
      if (info.source !== 'keyboard') workbench.setGroupDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = namedSections.map((section) => section.id);
    groupItems = next;
    if (!isNoopMove(prevIds, next.map((section) => section.id))) {
      void workbench.moveGroup(info.id, decision.beforeId);
    }
    if (info.source !== 'keyboard') workbench.setGroupDragging(false);
  }

  async function save(): Promise<void> {
    const body = workbench.memoDraft.trim();
    if (body.length === 0 || saving) return;
    saving = true;
    try {
      const result = (await core.call('memos.create', { body })) as { memo: Memo };
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

  function openCreateGroup(): void {
    groupName = '';
    createOpen = true;
  }

  async function confirmCreateGroup(): Promise<void> {
    const title = groupName.trim();
    if (title.length === 0 || creating) return;
    creating = true;
    try {
      if (await workbench.createGroup(title)) createOpen = false;
    } finally {
      creating = false;
    }
  }

  function onCreateGroupKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void confirmCreateGroup();
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
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1" data-testid="memo-list">
      {#if workbench.memos.length === 0 && (workbench.loadState === 'loading' || workbench.loadState === 'idle')}
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-loading"
        >
          {t('workbench.loading')}
        </p>
      {:else if workbench.memos.length === 0 && workbench.loadState === 'error'}
        <!-- 错误提示在视图顶部（带重试），这里不显示「空」 -->
      {:else if workbench.memos.length === 0}
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-empty"
        >
          {t('workbench.memo.empty')}
        </p>
      {:else if sections.length === 0}
        <p
          class="py-6 text-center text-sm text-muted-foreground"
          data-testid="memo-no-match"
        >
          {t('workbench.memo.noMatch')}
        </p>
      {/if}
      {#if ungroupedSection}
        <!-- 空的时候只是 display:none：分组拖拽区与备忘拖拽区的注册都保留（拖拽中会重新显示）。 -->
        <div
          class:hidden={!showUngroupedSection}
          data-testid="memo-ungrouped-slot"
          data-empty={ungroupedSection.memos.length === 0 ? 'true' : 'false'}
        >
          <MemoGroupSection section={ungroupedSection} showHeader={showHeaders} {flipDurationMs} />
        </div>
      {/if}
      {#if namedSections.length > 0}
        <div
          class="flex flex-col gap-4"
          data-testid="memo-groups-zone"
          use:dragHandleZone={{
            items: groupItems,
            type: 'group',
            flipDurationMs,
            morphDisabled: true,
            dropTargetStyle: {},
          }}
          onconsider={onGroupConsider}
          onfinalize={onGroupFinalize}
        >
          {#each groupItems as section (section.id)}
            {#if isShadow(section)}
              <div
                class="min-h-10 rounded-lg"
                style:height={groupShadowHeight === null ? undefined : `${groupShadowHeight}px`}
                aria-hidden="true"
              ></div>
            {:else}
              <MemoGroupSection {section} showHeader={showHeaders} {flipDurationMs} />
            {/if}
          {/each}
        </div>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-3">
      <button
        type="button"
        class="flex cursor-pointer items-center gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
        onclick={openCreateGroup}
        data-testid="memo-add-group"
      >
        <Plus class="size-3.5" aria-hidden="true" />{t('workbench.memo.addGroup')}
      </button>
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

<Dialog.Root
  open={createOpen}
  onOpenChange={(open) => {
    if (!open) createOpen = false;
  }}
>
  <Dialog.Content class="sm:max-w-sm" data-testid="memo-group-dialog">
    <Dialog.Header>
      <Dialog.Title>{t('workbench.memo.addGroup')}</Dialog.Title>
      <Dialog.Description>{t('workbench.memo.groupDialogHint')}</Dialog.Description>
    </Dialog.Header>
    <Input
      bind:ref={nameInput}
      bind:value={groupName}
      maxlength={60}
      placeholder={t('workbench.memo.groupPlaceholder')}
      onkeydown={onCreateGroupKeydown}
      data-testid="memo-group-name"
    />
    <Dialog.Footer>
      <Button variant="outline" onclick={() => (createOpen = false)}>
        {t('workbench.memo.groupCancel')}
      </Button>
      <Button
        disabled={groupName.trim().length === 0 || creating}
        onclick={() => void confirmCreateGroup()}
        data-testid="memo-group-create"
      >
        {t('workbench.memo.groupCreate')}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

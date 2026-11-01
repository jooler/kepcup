<script lang="ts">
  import { ChevronDown, ChevronRight, Pencil, Trash2 } from '@lucide/svelte';
  import { dragHandle, dndzone, type DndEvent } from 'svelte-dnd-action';
  import { MEMO_GROUP_TITLE_MAX_CHARS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Dialog from '$lib/components/ui/dialog';
  import {
    anchorFromFinalize,
    isNoopMove,
    isShadow,
    stripShadow,
  } from '$lib/features/board/board-dnd';
  import MemoCard from './MemoCard.svelte';
  import type { MemoSection } from './workbench-model';
  import { workbench } from './workbench.svelte';

  /**
   * 备忘列表的一个分区（D90 §5.4）：分组 header + 卡片网格。
   *
   * - 命名分组的 header 是外层分组拖拽区（type 'group'，MemoPane）的拖拽把手（整行，
   *   照看板列头：把手层垫底，可点子元素浮在上面）；「未分组」伪分组不在拖拽区里，恒在最前。
   * - 点击分组名（或折叠箭头）切换组内条目是否显示；重命名走 hover 出现的铅笔（换成输入框，
   *   Enter 提交 / Esc 取消 / 失焦提交）；删除走 hover 的垃圾桶 + 确认弹框。
   * - 网格本身是备忘拖拽区（type 'memo'），同 type 的区之间天然可跨组拖拽。
   * - 拖拽中冻结外部数据同步（shadow 占位会被重拉冲掉），见 store。
   */
  let {
    section,
    showHeader,
    flipDurationMs,
  }: {
    section: MemoSection;
    showHeader: boolean;
    flipDurationMs: number;
  } = $props();

  let items = $state.raw<(typeof section.memos)[number][]>([]);
  let confirmDelete = $state(false);
  let collapsed = $state(false);
  let renaming = $state(false);
  let renameDraft = $state('');
  let renameInput = $state<HTMLInputElement | null>(null);
  /** 高度用浮动副本实测钉住（同 BoardColumn），否则拖拽副本会缩放跳动。 */
  let shadowHeight = $state<number | null>(null);

  const named = $derived(section.groupId !== null);
  const title = $derived(section.title === '' ? t('workbench.memo.ungrouped') : section.title);

  $effect(() => {
    const next = section.memos;
    if (workbench.memoDragging) return;
    items = [...next];
  });

  // 重命名输入框出现时聚焦并全选。
  $effect(() => {
    if (!renaming) return;
    queueMicrotask(() => {
      renameInput?.focus();
      renameInput?.select();
    });
  });

  function toggleCollapse(): void {
    collapsed = !collapsed;
  }

  function startRename(): void {
    renameDraft = section.title;
    renaming = true;
  }

  async function commitRename(): Promise<void> {
    if (!renaming) return;
    renaming = false;
    await workbench.renameGroup(section.groupId ?? '', renameDraft);
  }

  function cancelRename(): void {
    renaming = false;
  }

  function onRenameKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void commitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelRename();
    }
  }

  function onConsider(event: CustomEvent<DndEvent<(typeof section.memos)[number]>>): void {
    const info = event.detail.info;
    if (info.trigger === 'dragStopped') {
      shadowHeight = null;
      workbench.setMemoDragging(false);
      return;
    }
    if (event.detail.items.some(isShadow)) {
      if (
        shadowHeight === null ||
        info.trigger === 'dragStarted' ||
        info.trigger === 'draggedEntered'
      ) {
        shadowHeight = draggedElementHeight();
      }
    } else {
      shadowHeight = null;
    }
    items = event.detail.items;
    workbench.setMemoDragging(true);
  }

  function draggedElementHeight(): number | null {
    if (typeof document === 'undefined') return null;
    const el = document.getElementById('dnd-action-dragged-el');
    return el === null ? null : el.getBoundingClientRect().height;
  }

  function onFinalize(event: CustomEvent<DndEvent<(typeof section.memos)[number]>>): void {
    const info = event.detail.info;
    shadowHeight = null;
    const decision = anchorFromFinalize({
      items: event.detail.items,
      droppedId: info.id,
      info,
    });
    if (decision.kind === 'ignore') {
      if (info.trigger === 'droppedIntoAnother') items = stripShadow(event.detail.items);
      if (info.source !== 'keyboard') workbench.setMemoDragging(false);
      return;
    }
    const next = stripShadow(event.detail.items);
    const prevIds = section.memos.map((memo) => memo.id);
    items = next;
    if (!isNoopMove(prevIds, next.map((memo) => memo.id))) {
      void workbench.moveMemo(info.id, section.groupId, decision.beforeId);
    }
    if (info.source !== 'keyboard') workbench.setMemoDragging(false);
  }
</script>

<div data-testid="memo-section" data-section-group-id={section.groupId ?? 'ungrouped'}>
  {#if showHeader}
    {#if named}
      <div
        class="group/section relative flex items-center gap-1 px-1"
        data-testid="memo-section-header"
      >
        <!-- 整行是外层分组拖拽区的把手；可点子元素浮在把手层之上（照看板列头）。 -->
        <div
          class="absolute inset-0 cursor-grab"
          aria-label={t('workbench.memo.groupHandle')}
          data-testid="memo-group-handle"
          use:dragHandle
        ></div>
        <Button
          size="icon-xs"
          variant="ghost"
          class="relative"
          aria-label={t('workbench.memo.toggleGroup', { name: title })}
          title={t('workbench.memo.toggleGroup', { name: title })}
          onclick={toggleCollapse}
          data-testid="memo-group-toggle"
        >
          {#if collapsed}<ChevronRight />{:else}<ChevronDown />{/if}
        </Button>
        {#if renaming}
          <Input
            bind:ref={renameInput}
            bind:value={renameDraft}
            maxlength={MEMO_GROUP_TITLE_MAX_CHARS}
            class="relative h-6 max-w-48 text-xs"
            aria-label={t('workbench.memo.renameGroup')}
            onkeydown={onRenameKeydown}
            onblur={() => void commitRename()}
            data-testid="memo-group-rename-input"
          />
        {:else}
          <button
            type="button"
            class="relative min-w-0 max-w-full cursor-pointer truncate text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            aria-expanded={!collapsed}
            aria-label={t('workbench.memo.toggleGroup', { name: title })}
            title={t('workbench.memo.toggleGroup', { name: title })}
            onclick={toggleCollapse}
            data-testid="memo-group-title"
          >
            {title}
          </button>
          <span class="relative text-xs text-muted-foreground tabular-nums">
            {section.memos.length}
          </span>
        {/if}
        <div
          class="relative ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/section:opacity-100 group-hover/section:opacity-100"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('workbench.memo.renameGroup')}
            title={t('workbench.memo.renameGroup')}
            onclick={startRename}
            data-testid="memo-group-rename"
          >
            <Pencil />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={t('workbench.memo.deleteGroup')}
            title={t('workbench.memo.deleteGroup')}
            onclick={() => (confirmDelete = true)}
            data-testid="memo-group-delete"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    {:else}
      <div class="flex items-center gap-1 px-1" data-testid="memo-section-header">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t('workbench.memo.toggleGroup', { name: title })}
          title={t('workbench.memo.toggleGroup', { name: title })}
          onclick={toggleCollapse}
          data-testid="memo-group-toggle"
        >
          {#if collapsed}<ChevronRight />{:else}<ChevronDown />{/if}
        </Button>
        <button
          type="button"
          class="min-w-0 max-w-full cursor-pointer truncate text-left text-xs font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={!collapsed}
          aria-label={t('workbench.memo.toggleGroup', { name: title })}
          title={t('workbench.memo.toggleGroup', { name: title })}
          onclick={toggleCollapse}
          data-testid="memo-ungrouped-title"
        >
          {title}
        </button>
        <span class="text-xs text-muted-foreground tabular-nums">{section.memos.length}</span>
      </div>
    {/if}
  {/if}

  {#if !collapsed}
    <div
      class="grid min-h-10 auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2"
      class:mt-1={showHeader}
      data-testid="memo-section-list"
      use:dndzone={{
        items,
        type: 'memo',
        flipDurationMs,
        delayTouchStart: true,
        morphDisabled: true,
        dropTargetStyle: {},
      }}
      onconsider={onConsider}
      onfinalize={onFinalize}
    >
      {#if items.length === 0 && named && !workbench.memoDragging}
        <p
          class="col-span-full rounded-lg border border-dashed py-3 text-center text-xs text-muted-foreground"
          data-testid="memo-group-empty"
        >
          {t('workbench.memo.groupEmptyHint')}
        </p>
      {/if}
      {#each items as memo (memo.id)}
        {#if isShadow(memo)}
          <div
            class="rounded-lg border bg-card p-3 text-sm"
            style:height={shadowHeight === null ? undefined : `${shadowHeight}px`}
            aria-hidden="true"
          >
            <p class="invisible line-clamp-6 break-words whitespace-pre-wrap">{memo.body}</p>
          </div>
        {:else}
          <MemoCard {memo} />
        {/if}
      {/each}
    </div>
  {/if}
</div>

{#if confirmDelete}
  <Dialog.Root
    open
    onOpenChange={(open) => {
      if (!open) confirmDelete = false;
    }}
  >
    <Dialog.Content class="sm:max-w-sm" data-testid="memo-group-delete-dialog">
      <Dialog.Header>
        <Dialog.Title>{t('workbench.memo.groupDeleteTitle', { title })}</Dialog.Title>
        <Dialog.Description>
          {t('workbench.memo.groupDeleteBody', { count: section.memos.length })}
        </Dialog.Description>
      </Dialog.Header>
      <Dialog.Footer>
        <Button variant="outline" onclick={() => (confirmDelete = false)}>
          {t('workbench.memo.groupDeleteCancel')}
        </Button>
        <Button
          variant="destructive"
          onclick={() => {
            confirmDelete = false;
            void workbench.deleteGroup(section.groupId ?? '');
          }}
          data-testid="memo-group-delete-confirm"
        >
          {t('workbench.memo.groupDeleteConfirm')}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

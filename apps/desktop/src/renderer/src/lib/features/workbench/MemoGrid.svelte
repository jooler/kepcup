<script lang="ts">
  import type { Memo } from '@kepcup/shared';
  import { dragHandleZone, type DndEvent } from 'svelte-dnd-action';
  import { t } from '$lib/i18n';
  import {
    anchorFromFinalize,
    draggedElementHeight,
    isNoopMove,
    isShadow,
    stripShadow,
  } from '$lib/features/board/board-dnd';
  import MemoCard from './MemoCard.svelte';
  import { workbench } from './workbench.svelte';

  /**
   * 一个分组（`groupId` null = 未分组伪分组）的卡片网格（D90 §5.4）。
   *
   * - tab 化后所有分组的网格常驻挂载，非当前 tab 只是 display:none（MemoPane 控制）：
   *   svelte-dnd-action 在拖起那一刻固定同 type 的落区集合，之后才挂载的区收不到这次拖拽；
   *   常驻也保证拖拽中悬停 tab 切换分组时，被拖卡片所在的原网格不被卸载。
   * - 网格是备忘拖拽区（type 'memo'）：组内排序；与其它网格、tab 上的落区（MemoTabDropZone）
   *   之间天然可跨组拖拽。用 dragHandleZone + 卡片 footer 里的 `use:dragHandle`：只有 footer
   *   空白处能拖起卡片，正文（contenteditable）与 footer 上的文字 / 按钮都不启动拖拽。
   * - `useCursorForDetection`：以光标而不是卡片中心判定落区（取起拖区的配置）——tab 很小，
   *   拖着一张大卡片时卡片中心够不着它。
   * - 拖拽中冻结外部数据同步（shadow 占位会被重拉冲掉），见 store。
   */
  let {
    memos,
    groupId,
    flipDurationMs,
  }: {
    memos: Memo[];
    groupId: string | null;
    flipDurationMs: number;
  } = $props();

  let items = $state.raw<Memo[]>([]);
  /** 高度用浮动副本实测钉住（同 BoardColumn），否则拖拽副本会缩放跳动。 */
  let shadowHeight = $state<number | null>(null);

  $effect(() => {
    const next = memos;
    if (workbench.memoDragging) return;
    items = [...next];
  });

  function onConsider(event: CustomEvent<DndEvent<Memo>>): void {
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

  function onFinalize(event: CustomEvent<DndEvent<Memo>>): void {
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
    const prevIds = memos.map((memo) => memo.id);
    items = next;
    if (!isNoopMove(prevIds, next.map((memo) => memo.id))) {
      void workbench.moveMemo(info.id, groupId, decision.beforeId);
    }
    if (info.source !== 'keyboard') workbench.setMemoDragging(false);
  }
</script>

<div
  class="grid min-h-10 auto-rows-min grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2"
  data-testid="memo-section-list"
  use:dragHandleZone={{
    items,
    type: 'memo',
    flipDurationMs,
    delayTouchStart: true,
    morphDisabled: true,
    useCursorForDetection: true,
    dropTargetStyle: {},
  }}
  onconsider={onConsider}
  onfinalize={onFinalize}
>
  <!-- 伪分组空着时整个 tab 都不显示，这条提示实际只出现在空的命名分组里。 -->
  {#if items.length === 0 && !workbench.memoDragging}
    <p
      class="col-span-full rounded-lg border border-dashed py-6 text-center text-xs text-muted-foreground"
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

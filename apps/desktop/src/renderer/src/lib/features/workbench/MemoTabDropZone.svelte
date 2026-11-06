<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Memo } from '@kepcup/shared';
  import { dndzone, TRIGGERS, type DndEvent } from 'svelte-dnd-action';
  import { isShadow } from '$lib/features/board/board-dnd';
  import { workbench } from './workbench.svelte';

  /**
   * tab 上的备忘落区（type 'memo'，只收不发；D90 §5.4 tab 化后的跨组拖放）。
   *
   * - 拖着卡片在 tab 上停留片刻 → `onDwell` 切到该分组：目标网格显示出来，卡片接着拖进去
   *   就能放到确切位置；直接在 tab 上松手 = 移到该分组顶部（同「移动到」菜单）并切过去。
   * - 覆盖整个 tab、`pointer-events: none`：dnd-action 按几何判定落区，不需要指针事件，
   *   tab 自身的点击 / 拖拽排序不受影响。随 tab 常驻挂载（拖起那一刻落区集合就固定了）。
   * - 子元素只有 dnd-action 塞进来的 shadow 占位，渲染成隐藏元素；`dropAnimationDisabled`
   *   免得松手时浮动副本飞向这个 0×0 的占位（动画取的是落点所在区的配置）。
   */
  let {
    groupId,
    onHoverChange,
    onDwell,
  }: {
    groupId: string | null;
    onHoverChange: (hovering: boolean) => void;
    onDwell: () => void;
  } = $props();

  /** 拖着卡片在 tab 上停留多久才切换：掠过 tab（比如拖到网格顶部排序）不误切。 */
  const DWELL_MS = 350;

  let items = $state.raw<Memo[]>([]);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  onDestroy(clearTimer);

  function setHovering(hovering: boolean): void {
    onHoverChange(hovering);
    if (!hovering) {
      clearTimer();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onDwell();
    }, DWELL_MS);
  }

  function onConsider(event: CustomEvent<DndEvent<Memo>>): void {
    items = event.detail.items;
    setHovering(items.some(isShadow));
  }

  function onFinalize(event: CustomEvent<DndEvent<Memo>>): void {
    const info = event.detail.info;
    items = [];
    setHovering(false);
    if (info.trigger !== TRIGGERS.DROPPED_INTO_ZONE) return;
    onDwell();
    void workbench.moveMemoToGroup(info.id, groupId);
  }
</script>

<div
  class="pointer-events-none absolute inset-0"
  aria-hidden="true"
  data-testid="memo-tab-drop"
  use:dndzone={{
    items,
    type: 'memo',
    dragDisabled: true,
    morphDisabled: true,
    dropAnimationDisabled: true,
    flipDurationMs: 0,
    zoneTabIndex: -1,
    zoneItemTabIndex: -1,
    dropTargetStyle: {},
  }}
  onconsider={onConsider}
  onfinalize={onFinalize}
>
  {#each items as item (item.id)}
    <div class="hidden"></div>
  {/each}
</div>

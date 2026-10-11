<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * 窄屏 tab 页骨架（33-narrow-layout）：顶部是一条与 macOS 红绿灯等高的空白
   * 拖拽带（不渲染标题——红绿灯压在标题文字上；高度保留，否则下方元素上移后
   * 仍被红绿灯盖住）+ 独立滚动的内容区。显式铺不透明背景——macOS 毛玻璃下
   * html/body 透明，只有侧栏（列表页）透出材质，内容页自己铺满背景色。
   * 内容区横向不滚动（复用的分区内容里个别元素可能超宽，纵向滚动即可）。
   */
  let {
    testid,
    scroll = true,
    children,
  }: {
    testid: string;
    /** false：内容区不滚动，由页面内容自管（如扩展中心各分组的内部滚动）。 */
    scroll?: boolean;
    children: Snippet;
  } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col bg-background" data-testid={testid}>
  <div class="app-drag h-14 shrink-0"></div>
  <div
    class={scroll
      ? 'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain'
      : 'flex min-h-0 flex-1 flex-col overflow-x-hidden'}
  >
    {@render children()}
  </div>
</div>

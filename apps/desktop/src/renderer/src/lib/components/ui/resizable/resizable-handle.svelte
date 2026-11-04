<script lang="ts">
  import * as ResizablePrimitive from 'paneforge';
  import { cn, type WithoutChildrenOrChild } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    withHandle = false,
    label,
    ...restProps
  }: WithoutChildrenOrChild<ResizablePrimitive.PaneResizerProps> & {
    withHandle?: boolean;
    /** 提示气泡文案：提供时 hover 片刻后在分隔线左侧弹出（仅水平分栏有意义）。 */
    label?: string;
  } = $props();
</script>

<!-- 具名 group/resize：祖先链上常有别的 class="group"（如侧栏），不具名会让
     group-hover 在指针进入整个祖先时误触发。 -->
<ResizablePrimitive.PaneResizer
  bind:ref
  data-slot="resizable-handle"
  class={cn(
    'group/resize relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden data-[direction=vertical]:h-px data-[direction=vertical]:w-full data-[direction=vertical]:after:left-0 data-[direction=vertical]:after:h-1 data-[direction=vertical]:after:w-full data-[direction=vertical]:after:translate-x-0 data-[direction=vertical]:after:-translate-y-1/2 [&[data-direction=vertical]>div]:rotate-90',
    className,
  )}
  {...restProps}
>
  <!-- 高亮分隔线条：hover / 拖拽中亮出。1px 宽、resizer 整高，left-px 恰好
       压在右侧 pane 的 border-l 那 1px 上（水平分栏里可见的分隔线是它，不在
       resizer 自身；位置由结构保证，不按像素挪）。默认透明；显示时以不透明
       --divider-hover 盖住边线，整条线与胶囊（它的 flex 子元素）同色同层，
       是一个整体。paneforge 拖拽期间在 resizer 上置 data-active="pointer"
       （键盘拖为 "keyboard"），两种都常亮，拖动中 hover 丢失也不会闪烁。
       竖排分栏（direction=vertical，本项目暂未用到）不渲染此条。 -->
  <div
    class="pointer-events-none absolute inset-y-0 left-px flex w-px items-center justify-center
      overflow-visible bg-(--divider-hover) opacity-0 transition-opacity duration-200
      group-hover/resize:opacity-100 group-hover/resize:delay-150
      group-data-[active=pointer]:opacity-100 group-data-[active=keyboard]:opacity-100
      data-[direction=vertical]:hidden"
    aria-hidden="true"
  >
    <!-- 指示胶囊：在 1px 条内纵横居中（flex），宽度大于条、对称溢出；
        shrink-0 防止 flex 把它压扁回 1px。 -->
    <div class="h-12 w-1 shrink-0 rounded-full bg-(--divider-hover)"></div>
  </div>
  {#if label}
    <!-- 提示气泡：胶囊下方、朝内容区一侧弹出；拖拽（data-active）时用
        !important 压过 hover 常显，拖动中不跟随。 -->
    <div
      class="pointer-events-none absolute top-[calc(50%_+_2.5rem)] right-full z-10 mr-3 whitespace-nowrap
        rounded-xl border bg-popover px-3 py-2 text-sm shadow-md opacity-0 transition-opacity duration-200
        group-hover/resize:opacity-100 group-hover/resize:delay-500
        group-data-[active=pointer]:opacity-0! group-data-[active=keyboard]:opacity-0!"
      aria-hidden="true"
    >
      {label}
    </div>
  {/if}
  {#if withHandle}
    <div class="z-10 flex h-6 w-1 shrink-0 rounded-lg"></div>
  {/if}
</ResizablePrimitive.PaneResizer>

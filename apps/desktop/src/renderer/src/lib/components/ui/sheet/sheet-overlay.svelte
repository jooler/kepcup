<script lang="ts">
  import { Dialog as SheetPrimitive } from 'bits-ui';
  import { cn } from '$lib/utils.js';

  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: SheetPrimitive.OverlayProps = $props();
</script>

<!-- 遮罩不用 backdrop-filter:mac 窗口衬了原生 vibrancy,侧栏透明区与 DOM
	背景模糊合成时会把未模糊的原始内容叠在模糊层上(Chromium 缺陷),只能压暗。 -->
<SheetPrimitive.Overlay
  bind:ref
  data-slot="sheet-overlay"
  class={cn(
    'fixed inset-0 z-50 bg-black/60 duration-100 data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0',
    className,
  )}
  {...restProps}
/>

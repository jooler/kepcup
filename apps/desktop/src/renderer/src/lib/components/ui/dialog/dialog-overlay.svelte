<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DialogPrimitive.OverlayProps = $props();
</script>

<!-- 遮罩不用 backdrop-filter:mac 窗口衬了原生 vibrancy,侧栏透明区与 DOM
	背景模糊合成时会把未模糊的原始内容叠在模糊层上(Chromium 缺陷),只能压暗。 -->
<!-- data-window-overlay:接入全局弹层拖拽带(window-drag-band.ts),浮层开着时窗口仍可拖。 -->
<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	data-window-overlay
	class={cn("data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/60 duration-100 fixed inset-0 isolate z-50", className)}
	{...restProps}
/>

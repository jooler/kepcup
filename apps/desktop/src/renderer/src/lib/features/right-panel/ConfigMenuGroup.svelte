<script lang="ts">
  /** 二级菜单的分组容器：可选小灰标题 + 一张圆角描边卡（行间用分隔线）。 */
  import type { Snippet } from 'svelte';

  let { label, children }: { label?: string; children?: Snippet } = $props();
</script>

<section>
  {#if label !== undefined}
    <p class="px-1 pb-1.5 text-xs font-medium text-muted-foreground">{label}</p>
  {/if}
  <div class="divide-y overflow-hidden rounded-xl border">
    {@render children?.()}
  </div>
</section>

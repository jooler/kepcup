<script lang="ts">
  import { Puzzle } from '@lucide/svelte';

  /**
   * 插件图标：清单声明了图标（`PluginSummary.iconDataUri`）就显示图片，否则回落到
   * 宿主默认图标（拼图）。图标只是身份提示，不承载状态语义。
   */
  let {
    src,
    label = '',
    class: className = 'size-9',
  }: {
    src: string | null | undefined;
    label?: string;
    /** 容器的尺寸类（如 `size-8`）；图片与回退图形都填满它。 */
    class?: string;
  } = $props();
</script>

{#if typeof src === 'string' && src.startsWith('data:image/')}
  <img {src} alt="" class="{className} shrink-0 rounded-md object-contain" aria-hidden="true" />
{:else}
  <span
    class="{className} flex shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground"
    title={label}
    aria-hidden="true"
    data-testid="plugin-default-icon"
  >
    <Puzzle class="size-1/2" />
  </span>
{/if}

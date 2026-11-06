<script lang="ts">
  import { providerIcon } from './provider-logos';

  /**
   * 供应商图标：彩色品牌图标走 `<img>`；单色标记（OpenAI / Anthropic / xAI /
   * Groq / Vercel 等）用 CSS mask 按当前文字颜色绘制，暗色主题下不会变成
   * 黑块。尺寸 / 圆角由调用方通过 `class` 给（与原来直接写 `<img>` 时的
   * class 一致）；没有图标时不渲染，由调用方决定首字母回落。
   */
  let { logo, class: className = '' }: { logo: string | undefined; class?: string } = $props();

  const asset = $derived(providerIcon(logo));
</script>

{#if asset !== undefined}
  {#if asset.mono}
    <span
      class="block bg-current {className}"
      style={`-webkit-mask: url("${asset.url}") center / contain no-repeat; mask: url("${asset.url}") center / contain no-repeat;`}
      aria-hidden="true"
    ></span>
  {:else}
    <img src={asset.url} alt="" class={className} />
  {/if}
{/if}

<script lang="ts">
  import { lazyMarkdown } from './markdown-lazy.svelte';

  /**
   * AI 消息的 Markdown 渲染入口（独立组件）：内部走懒加载的
   * streamdown/shiki/katex 管线，未就绪时按纯文本兜底（同样的字符）。
   * 之后的特殊渲染逻辑（代码块增强、@引用、卡片注入等）都收敛在这里。
   */
  let { content }: { content: string } = $props();
</script>

{#if lazyMarkdown.component}
  {@const Markdown = lazyMarkdown.component}
  <Markdown {content} />
{:else}
  <div class="whitespace-pre-wrap">{content}</div>
{/if}

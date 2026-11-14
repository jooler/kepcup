<script lang="ts">
  import type { StreamdownComponents } from 'streamdown-svelte';
  import { lazyMarkdown, MARKDOWN_CONTROLS } from './markdown-lazy.svelte';
  import MentionLink from './MentionLink.svelte';

  /**
   * 消息正文的 Markdown 渲染入口（独立组件，Bot 与用户消息共用同一管线）：
   * 内部走懒加载的 streamdown/shiki/katex 管线，未就绪时按纯文本兜底（同样的
   * 字符，保留换行）。之后的特殊渲染逻辑（代码块增强、@引用、卡片注入等）都
   * 收敛在这里。
   *
   * `userMessage`：用户气泡的差异只在两处——用户消息是完整文本（关掉流式残缺
   * 语法补全 remend，避免把正常文字当成待补全语法改写），以及 `@提及` 已经被
   * user-markdown 转成 `#kepcup-mention:` 链接，需要用 MentionLink 还原成胶囊。
   */
  let {
    content,
    fallback = content,
    userMessage = false,
  }: {
    content: string;
    /** 纯文本兜底内容（管线未就绪时）；缺省用 content。 */
    fallback?: string;
    userMessage?: boolean;
  } = $props();

  /** 模块级常量：引用稳定，避免每次渲染都换 components 对象。 */
  const USER_OPTIONS = {
    parseIncompleteMarkdown: false,
    components: { a: MentionLink } satisfies StreamdownComponents,
  };
</script>

{#if lazyMarkdown.component}
  {@const Markdown = lazyMarkdown.component}
  <Markdown
    {content}
    controls={MARKDOWN_CONTROLS}
    plugins={lazyMarkdown.plugins}
    {...userMessage ? USER_OPTIONS : {}}
  />
{:else}
  <!-- 管线未就绪的纯文本兜底：与 streamdown 一致，放不下的长 token 横向滚动 -->
  <div class="overflow-x-auto whitespace-pre-wrap">{fallback}</div>
{/if}

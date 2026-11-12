<script lang="ts">
  /**
   * 用户气泡里的链接渲染（streamdown `components.a` 覆盖）：
   * - `#kepcup-mention:` 是 user-markdown 生成的 @提及链接 → 还原成原来的胶囊
   *   （边框取 currentColor，跟随任意强调色气泡的文字色；本地文件/文件夹带
   *   图标 + basename，`title` 给完整路径）。胶囊渲染成 `<span>`（没有 href），
   *   自然不跳转、也不弹链接确认框。
   * - 其余链接照常输出 `<a>`（streamdown 的链接安全确认对绝对地址仍然生效）。
   */
  import type { Snippet } from 'svelte';
  import { File as FileIcon, Folder as FolderIcon } from '@lucide/svelte';
  import { parseMentionHref } from './user-markdown';

  let {
    href = undefined,
    target = undefined,
    rel = undefined,
    title = undefined,
    class: className = undefined,
    children,
  }: {
    href?: string;
    target?: string;
    rel?: string;
    title?: string | null;
    class?: string;
    // streamdown 的 LinkComponentProps 里 children 是可选的，这里跟随（否则组件类型
    // 与 Components['a'] 不兼容）。
    children?: Snippet;
  } = $props();

  const mention = $derived(parseMentionHref(href));
  const isLocal = $derived(mention?.kind === 'file' || mention?.kind === 'folder');
</script>

{#if mention}
  <span
    class="mx-1 inline-flex items-center gap-1 rounded-sm border border-current/30 px-1 align-baseline"
    data-testid="user-mention"
    data-kind={isLocal ? mention.kind : undefined}
    title={isLocal ? mention.value : undefined}
  >
    {#if mention.kind === 'folder'}
      <FolderIcon class="size-3 shrink-0" aria-hidden="true" />
    {:else if mention.kind === 'file'}
      <FileIcon class="size-3 shrink-0" aria-hidden="true" />
    {/if}
    <span class="max-w-48 truncate">{@render children?.()}</span>
  </span>
{:else}
  <a {href} {target} {rel} title={title ?? undefined} class={className}>{@render children?.()}</a>
{/if}

<script lang="ts">
  /**
   * 二级菜单的通用行（分组条目式）：图标 + 标题 + 当前值摘要 + 右箭头；点行由
   * 宿主下钻到对应详情。`danger` 用于破坏性动作行（红字，无箭头hover同款）。
   */
  import { ChevronRight, TriangleAlert } from '@lucide/svelte';

  let {
    icon: Icon,
    title,
    summary,
    onclick,
    testid,
    disabled = false,
    alert = false,
    danger = false,
  }: {
    icon: typeof ChevronRight;
    title: string;
    summary?: string;
    onclick: () => void;
    testid: string;
    disabled?: boolean;
    /** 行内警示图标（如工作目录失效）。 */
    alert?: boolean;
    /** 破坏性动作行（如移除 Bot）：标题红字、hover 底色用 destructive 淡色。 */
    danger?: boolean;
  } = $props();
</script>

<button
  type="button"
  class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/60 disabled:opacity-50 {danger
    ? 'hover:bg-destructive/10'
    : ''}"
  {onclick}
  {disabled}
  data-testid={testid}
>
  <Icon
    class="size-4 shrink-0 {danger ? 'text-destructive' : 'text-muted-foreground'}"
    aria-hidden="true"
  />
  <span class="min-w-0 flex-1 truncate {danger ? 'text-destructive' : ''}">{title}</span>
  {#if alert}
    <TriangleAlert class="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
  {/if}
  {#if summary !== undefined}
    <span class="max-w-[50%] truncate text-xs text-muted-foreground">{summary}</span>
  {/if}
  <ChevronRight class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
</button>

<script lang="ts">
  /** 下钻详情的头部：返回回二级菜单 + 详情标题（可选面包屑代替纯标题）。 */
  import { ChevronLeft } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';

  let {
    title,
    onBack,
    testid = 'bot-detail-back',
    breadcrumb,
    breadcrumbTestid,
    action,
  }: {
    title: string;
    onBack: () => void;
    testid?: string;
    /** 传入时以面包屑代替纯标题：有 onJump 的段可点击跳转，末段为当前位置。 */
    breadcrumb?: Array<{ label: string; onJump?: () => void }>;
    breadcrumbTestid?: string;
    /** 头部最右侧的动作区（如 Wiki 页面删除）：与面包屑同一行，shrink-0。 */
    action?: Snippet;
  } = $props();
</script>

<div class="flex shrink-0 items-center gap-1">
  <Button
    variant="ghost"
    size="icon"
    class="size-7"
    title={t('common.back')}
    onclick={onBack}
    data-testid={testid}
  >
    <ChevronLeft class="size-4" aria-hidden="true" />
  </Button>
  {#if breadcrumb !== undefined && breadcrumb.length > 0}
    <nav
      class="flex min-w-0 flex-1 items-center gap-0.5 text-sm font-medium"
      data-testid={breadcrumbTestid}
      aria-label={title}
    >
      {#each breadcrumb as crumb, index (index)}
        {#if index > 0}
          <span class="shrink-0 text-xs text-muted-foreground">/</span>
        {/if}
        {#if crumb.onJump !== undefined}
          <button
            type="button"
            class="min-w-0 cursor-pointer truncate rounded px-0.5 text-muted-foreground transition-colors hover:text-foreground"
            onclick={crumb.onJump}
            title={crumb.label}
          >
            {crumb.label}
          </button>
        {:else}
          <span class="min-w-0 truncate" title={crumb.label}>{crumb.label}</span>
        {/if}
      {/each}
    </nav>
  {:else}
    <p class="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
  {/if}
  {#if action !== undefined}
    {@render action()}
  {/if}
</div>

<script lang="ts">
  import { PROJECT_MODULES } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import { projectTabs } from './project-tabs';
  import type { ChatTabBadge } from './project-chat-badge';

  /**
   * 模块 tab 行（WP6 §4 步骤 4）。手写按钮条，不用 components/ui/tabs——组件库
   * Tabs 的样式变体写在 `data-active:` 上而 bits-ui 输出 `data-state="active"`，
   * 激活样式永不生效（RightPanel 的 tablist 同款做法与注释）。
   */
  let { badge }: { badge: ChatTabBadge } = $props();

  const tabs = projectTabs(PROJECT_MODULES);
  const onChatView = $derived(shell.projectView === 'chat');
</script>

<div
  class="flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap"
  role="tablist"
  data-testid="project-tabs"
>
  {#each tabs as tab (tab.id)}
    {@const active = shell.projectView === tab.id}
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active ? 'true' : undefined}
      data-testid={`project-tab-${tab.id}`}
      class="app-no-drag shrink-0 cursor-pointer rounded-full px-2.5 py-0.5 text-[13px] transition-colors {active
        ? 'bg-muted font-medium text-foreground'
        : 'text-foreground/50 hover:bg-accent/60 hover:text-foreground/80'}"
      onclick={() => shell.openProjectModule(tab.id)}
    >
      {t(tab.labelKey)}
      <!-- 徽标只在用户不在沟通视图时显示（在沟通里时用户本来就看着）。 -->
      {#if tab.id === 'chat' && !onChatView}
        {#if badge.unread > 0}
          <span
            class="ml-1 inline-flex items-center gap-1 align-middle"
            data-testid="project-tab-badge-chat"
            data-kind="unread"
            title={t('project.tab.badgeNew', { count: badge.unread })}
          >
            <span class="size-1.5 rounded-full bg-sky-500"></span>
            <span class="text-[11px] font-medium text-foreground/70 tabular-nums">
              {badge.unread}
            </span>
          </span>
        {:else if badge.pending}
          <span
            class="ml-1 inline-block size-1.5 rounded-full bg-amber-500 align-middle"
            data-testid="project-tab-badge-chat"
            data-kind="pending"
            title={t('project.tab.badgePending')}
          ></span>
        {/if}
      {/if}
    </button>
  {/each}
</div>

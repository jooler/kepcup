<script lang="ts">
  import type { Component } from 'svelte';
  import { Blocks, BookUser, MessagesSquare, UserRound, type LucideIcon } from '@lucide/svelte';
  import { t, type MessageKey } from '$lib/i18n';
  import { narrowLayout } from './narrow-layout.svelte';
  import { NARROW_TABS, type NarrowTab } from './narrow-layout';

  /**
   * 窄屏底部全局 tab（33-narrow-layout）：对话 / 通讯录 / 扩展 / 我，移动应用的
   * 第一层导航。图标与文案取自既有入口（侧栏对话列表、设置「通讯录」、扩展中心、
   * 用户），当前项高亮；进入详情层（对话详情 / Bot 覆盖层）时整个 tab 栏由
   * NarrowShell 收起。
   */
  const TAB_META: Record<NarrowTab, { icon: LucideIcon; labelKey: MessageKey }> = {
    chats: { icon: MessagesSquare, labelKey: 'narrow.tabChats' },
    contacts: { icon: BookUser, labelKey: 'narrow.tabContacts' },
    extensions: { icon: Blocks, labelKey: 'narrow.tabExtensions' },
    me: { icon: UserRound, labelKey: 'narrow.tabMe' },
  };
</script>

<nav
  class="flex h-14 shrink-0 items-stretch border-t bg-sidebar text-sidebar-foreground"
  aria-label={t('narrow.tabBarLabel')}
  data-testid="narrow-tab-bar"
>
  {#each NARROW_TABS as tab (tab)}
    {@const meta = TAB_META[tab]}
    {@const Icon = meta.icon as unknown as Component<{ class?: string }>}
    <button
      type="button"
      class="relative flex flex-1 cursor-pointer flex-col items-center justify-center gap-0.5
        transition-colors {narrowLayout.tab === tab
        ? 'text-foreground'
        : 'text-muted-foreground hover:text-foreground'}"
      aria-current={narrowLayout.tab === tab ? 'page' : undefined}
      onclick={() => narrowLayout.selectTab(tab)}
      data-testid={`narrow-tab-${tab}`}
    >
      {#if narrowLayout.tab === tab}
        <!-- 当前项指示条（顶部短横线）：仅靠文字色差在 11px 字号下不够醒目 -->
        <span class="absolute top-0 h-0.5 w-8 rounded-full bg-foreground" aria-hidden="true"></span>
      {/if}
      <!-- 图标纯装饰：tab 文案即可达性标签 -->
      <Icon class="size-5" />
      <span class="text-[11px] leading-none {narrowLayout.tab === tab ? 'font-medium' : ''}">
        {t(meta.labelKey)}
      </span>
    </button>
  {/each}
</nav>

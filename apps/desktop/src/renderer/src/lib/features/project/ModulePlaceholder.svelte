<script lang="ts">
  import type { Component } from 'svelte';
  import { BookOpen, Calendar, KanbanSquare, Target } from '@lucide/svelte';
  import type { ProjectModuleId } from '@kepcup/shared';
  import { t } from '$lib/i18n';

/**
 * 模块占位页（WP6 §4 步骤 4）：看板 / OKR / 日历是 planned 模块（soonBody）；
 * Wiki 的真实视图由 WP10 的 ProjectWikiView 接管（wikiSoon 文案已删）。
 * 正常不会以 'chat' / 'wiki' 渲染。
 */
let { module }: { module: ProjectModuleId } = $props();

  type IconProps = { class?: string; 'aria-hidden'?: boolean };
  const ICONS: Record<ProjectModuleId, Component<IconProps>> = {
    chat: BookOpen as unknown as Component<IconProps>,
    wiki: BookOpen,
    board: KanbanSquare,
    okr: Target,
    calendar: Calendar,
  };

  const Icon = $derived(ICONS[module]);
</script>

<div
  class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
  data-testid="project-module-placeholder"
  data-module={module}
>
  <Icon class="size-8 text-muted-foreground/60" aria-hidden={true} />
  <p class="text-sm text-muted-foreground">{t('project.module.soonBody')}</p>
</div>

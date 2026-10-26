<script lang="ts">
  import type { Component } from 'svelte';
  import { BookOpen, Calendar, KanbanSquare, Target } from '@lucide/svelte';
  import type { ProjectModuleId } from '@kepcup/shared';
  import { t } from '$lib/i18n';

  /**
   * Placeholder for planned modules (OKR / calendar). Wiki and the board have
   * their own views. This is not rendered for chat, wiki, or board.
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

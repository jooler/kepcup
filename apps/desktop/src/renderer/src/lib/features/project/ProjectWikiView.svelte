<script lang="ts">
  import type { WikiOwner } from '@kepcup/shared';
  import WikiBrowser from '$lib/features/wiki/WikiBrowser.svelte';

  /**
   * The project's Wiki tab (D92 T1b WP10 §4 步骤 5): the generalized browser
   * over the project's shared wiki. History / rollback / page deletion reuse
   * the browser's existing abilities — whoever uses the UI is the user, and
   * the user may always write (README §4.13).
   */
  let { conversationId }: { conversationId: string } = $props();

  const owner = $derived<WikiOwner>({ kind: 'project', id: conversationId });
</script>

<!-- 内容区与项目设置页同一版式：限宽居中 + 四向留白；浏览逻辑（面包屑 /
     历史入口 / 页面删除）由 WikiBrowser 与 Bot 右栏共用，无需标题行。 -->
<div
  class="mx-auto flex h-full w-full max-w-4xl flex-col px-6 pt-8 pb-12"
  data-testid="project-wiki-view"
  data-owner-kind="project"
>
  <WikiBrowser {owner} active={true} />
</div>

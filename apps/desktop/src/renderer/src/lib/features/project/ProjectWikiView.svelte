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

<div class="flex h-full min-h-0 flex-col p-4" data-testid="project-wiki-view" data-owner-kind="project">
  <WikiBrowser {owner} active={true} />
</div>

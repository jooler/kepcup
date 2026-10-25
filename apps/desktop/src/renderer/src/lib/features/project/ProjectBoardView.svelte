<script lang="ts">
  import BoardView from '$lib/features/board/BoardView.svelte';

  /**
   * Project board tab shell. The chat body stays mounted across tab switches;
   * this view does not, so scroll position and the open card live on the
   * board store. The root owns the height chain (the project content area
   * does not set overflow-hidden).
   */
  let { conversationId }: { conversationId: string } = $props();
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden" data-testid="project-board-view">
  <BoardView projectId={conversationId} />
</div>

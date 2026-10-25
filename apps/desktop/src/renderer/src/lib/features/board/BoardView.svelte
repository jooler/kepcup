<script lang="ts">
  /**
   * Board canvas. The tab shell mounts this; the columns, drag, and dialog
   * land in the view step. `projectId` is accepted now so the shell's prop
   * stays stable.
   */
  let { projectId }: { projectId: string } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="board-view" data-project-id={projectId}></div>

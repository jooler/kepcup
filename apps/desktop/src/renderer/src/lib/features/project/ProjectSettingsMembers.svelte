<script lang="ts">
  import ProjectMembersEditor from './ProjectMembersEditor.svelte';

  /** Members card of the project details page (D92 §11.3). */
  let { conversationId }: { conversationId: string } = $props();
</script>

<ProjectMembersEditor {conversationId} />

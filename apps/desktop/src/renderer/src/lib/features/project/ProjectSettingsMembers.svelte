<script lang="ts">
  import ProjectMembersEditor from './ProjectMembersEditor.svelte';
  import ProjectHumanMembers from '$lib/features/team/ProjectHumanMembers.svelte';

  /**
   * Members card of the project details page (D92 §11.3). T7: team-sourced
   * projects additionally render the human-members panel (add / remove /
   * transfer lead) below the bot roster.
   */
  let { conversationId }: { conversationId: string } = $props();
</script>

<ProjectMembersEditor {conversationId} />
<ProjectHumanMembers {conversationId} />

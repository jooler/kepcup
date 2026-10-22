<script lang="ts">
  import { t } from '$lib/i18n';
  import SchedulesPanel from '$lib/features/right-panel/SchedulesPanel.svelte';
  import WatchesPanel from '$lib/features/watches/WatchesPanel.svelte';

  /** Schedules & watches card of the project details page (D92 §11.3). */
  let { conversationId }: { conversationId: string } = $props();
</script>

<div class="space-y-2">
  <p class="text-sm font-medium">{t('projectSettings.schedulesTitle')}</p>
  <SchedulesPanel {conversationId} testid="project-schedules" />
  <p class="pt-2 text-sm font-medium">{t('watches.title')}</p>
  <WatchesPanel {conversationId} testid="project-watches" />
</div>

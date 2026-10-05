<script lang="ts">
  import { t } from '$lib/i18n';
  import SchedulesPanel from '$lib/features/right-panel/SchedulesPanel.svelte';

  /**
   * Settings overview of every active schedule across all bots
   * (docs/dev/phases/P10-proactive.md 任务 7: 设置页汇总所有定时任务).
   */
</script>

<section class="space-y-3" data-testid="settings-schedules">
  <h3 class="text-sm font-medium">{t('settings.schedulesSection')}</h3>
  <SchedulesPanel testid="settings-schedules-list" />
</section>

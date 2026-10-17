<script lang="ts">
  // Transitional shell: WP7 replaces the body with the real project details page.
  import { t } from '$lib/i18n';
  import GroupInfo from '$lib/features/right-panel/GroupInfo.svelte';

  let { conversationId }: { conversationId: string } = $props();
</script>

<!--
  项目详情页过渡壳（WP6）：内容区页面，不是对话框。正文暂时沿用旧的
  GroupInfo（WP1 已改成读写 project，撤销授权等功能照旧可用），WP7 整体替换。
-->
<div class="flex h-full min-h-0 flex-col" data-testid="project-settings-page">
  <p class="shrink-0 px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
    {t('project.header.settings')}
  </p>
  <GroupInfo {conversationId} />
</div>

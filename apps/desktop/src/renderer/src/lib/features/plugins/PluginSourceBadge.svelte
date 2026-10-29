<script lang="ts">
  import { t } from '$lib/i18n';
  import { Badge } from '$lib/components/ui/badge';
  import { plugins } from './plugins.svelte';

  /**
   * 插件来源徽标（D104 P0a-3）：技能 / MCP / 连接目录里标记「这个条目来自插件 X」。
   * 挂载时幂等地拉一次插件列表（徽标文案要用展示名），之后由 `plugins.changed` 事件保持更新。
   */
  let { pluginId, testid }: { pluginId: string; testid?: string } = $props();

  $effect(() => {
    plugins.start();
    void plugins.load();
  });
</script>

<Badge variant="outline" title={pluginId} data-testid={testid}>
  {t('plugins.badge', { name: plugins.nameOf(pluginId) })}
</Badge>

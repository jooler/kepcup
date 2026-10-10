<script lang="ts">
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import McpSection from './McpSection.svelte';

  /**
   * 设置「开发者模式」分区（扩展中心 X3，设计 29 §16，决定 A）：`settings.apps.developerMode`
   * 开关（D73 P2 §6.6）+ 开启后才出现的「自定义」能力——新建 MCP 服务器（stdio / 填 URL 的
   * HTTP / SSE，含 OAuth 手填客户端）、BYO 客户端面板、每个服务器的原始工具定义与授权日志。
   * 关闭时这些入口全部隐藏（普通用户看不到「填 MCP 地址」）；代码、RPC、已有的
   * `settings.mcpServers` 与已建立的连接保持原样，不迁移、不删除——已有 server 仍可在
   * 扩展中心「MCP」分组里管理。`openSettings('mcp')` 别名落在本分区。
   */

  const developerMode = $derived(settingsStore.developerMode);
  let busy = $state(false);

  async function toggle(on: boolean): Promise<void> {
    busy = true;
    try {
      await settingsStore.setDeveloperMode(on);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-4" data-testid="developer-section">
  <label class="flex items-start gap-2 text-xs" data-testid="mcp-dev-mode">
    <Checkbox
      checked={developerMode}
      disabled={busy}
      onCheckedChange={(checked) => void toggle(checked === true)}
    />
    <span>
      <span class="block font-medium">{t('settings.devMode')}</span>
      <span class="block text-muted-foreground">{t('settings.devModeHint')}</span>
    </span>
  </label>

  {#if developerMode}
    <!-- 旧「应用 → 自定义」页签容器的锚点（data-settings-anchor="mcp"）沿用在这里。 -->
    <div data-settings-anchor="mcp" data-testid="developer-custom">
      <McpSection variant="full" />
    </div>
  {:else}
    <p class="text-xs text-muted-foreground" data-testid="developer-off-hint">
      {t('settings.devModeOffHint')}
    </p>
  {/if}
</section>

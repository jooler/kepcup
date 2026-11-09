<script lang="ts">
  import { tick } from 'svelte';
  import type { MessageKey } from '$lib/i18n';
  import { t } from '$lib/i18n';
  import { shell } from '$lib/stores/shell.svelte';
  import ModelsSection from './ModelsSection.svelte';
  import AgentsSection from './AgentsSection.svelte';

  /**
   * 「模型与智能体」分区（左栏合并原「模型」「智能体」两个分类）：顶部页签切换
   * 两套各自的设置组件。页签即设置分区 id——`models` / `agents` 仍是对外深链
   * 的事实源（`shell.openSettings('agents', 'agent-<id>')` 直接落在智能体页签）。
   * 宽屏改 `shell.settingsSection`，窄屏详情页走 `shell.narrowSettingsSection`，
   * 左栏条目、页签与窄屏详情共用同一组 id。
   */

  type Tab = 'models' | 'agents';

  let { tab }: { tab: Tab } = $props();

  const TABS = ['models', 'agents'] as const;
  const LABEL_KEYS: Record<Tab, MessageKey> = {
    models: 'settings.navModels',
    agents: 'settings.navAgents',
  };
  const PANEL_ID = 'settings-models-agents-panel';

  function tabId(item: Tab): string {
    return `settings-models-agents-tab-${item}`;
  }

  async function select(next: Tab): Promise<void> {
    if (next === tab) return;
    shell.settingsAnchor = null;
    shell.narrowSettingsAnchor = null;
    if (shell.narrowSettingsOpen) shell.selectNarrowSettingsSection(next);
    else shell.settingsSection = next;
    // 分区容器随 section 变化重挂载，焦点会掉到 body；渲染完把焦点还给页签。
    await tick();
    document.getElementById(tabId(next))?.focus();
  }

  function onTablistKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(index + step + TABS.length) % TABS.length];
    if (next !== undefined) void select(next);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3">
  <!-- 页签下划线压住分隔线（-mb-px），与扩展中心同款。 -->
  <div
    class="flex shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b"
    role="tablist"
    tabindex="-1"
    data-testid="models-agents-tabs"
    onkeydown={onTablistKeydown}
  >
    {#each TABS as item (item)}
      <button
        type="button"
        role="tab"
        id={tabId(item)}
        aria-selected={tab === item}
        aria-controls={PANEL_ID}
        tabindex={tab === item ? 0 : -1}
        class="-mb-px shrink-0 border-b-2 px-3 py-1.5 text-sm whitespace-nowrap transition-colors {tab ===
        item
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'}"
        onclick={() => void select(item)}
        data-testid={`models-agents-tab-${item}`}
      >
        {t(LABEL_KEYS[item])}
      </button>
    {/each}
  </div>
  <div
    role="tabpanel"
    id={PANEL_ID}
    aria-labelledby={tabId(tab)}
    class="flex min-h-0 flex-1 flex-col"
  >
    {#if tab === 'models'}
      <ModelsSection />
    {:else}
      <AgentsSection />
    {/if}
  </div>
</div>

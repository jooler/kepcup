<script lang="ts">
  import { tick } from 'svelte';
  import { agentSetupReasonOf, type AgentView } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { revealSettingsAnchor } from './anchor-scroll';
  import AgentIcon from './AgentIcon.svelte';
  import AgentCard from './AgentCard.svelte';

  /**
   * 设置页「智能体」（D72，docs/design/28-external-agents-acp.md §2.2），布局对齐
   * 「模型」分区：两栏卡——左栏是目录里的全部智能体（含未启用 / 未安装的），
   * 右栏是选中条目的 `AgentCard`（与对话内 Agent 设置卡共用同一份卡片与保存
   * RPC）。已启用且就绪的条目在左栏右侧带绿点。默认任务执行引擎的配置在
   * 「模型」页（`models.task-engine`），这里不再有全局配置条目。
   *
   * 纵向空间与「模型」分区一致：外层设置页对「智能体」分区不滚，两栏卡撑满
   * 剩余高度（min-h-0 + flex-1），滚动归右栏详情自己；左栏条目多时在栏内滚。
   */

  /**
   * 挂载时的深链预选：`agent-<id>` 直接打开该智能体。挂在脚本里（而不是只靠
   * $effect）是因为外层分区容器会在渲染后的下一 tick 清掉锚点，子组件的
   * effect 可能已经读不到它。
   */
  function initialSelection(anchor: string | null): string {
    return anchor !== null && anchor.startsWith('agent-') ? anchor.slice('agent-'.length) : '';
  }

  /** 选中项：Agent id（'' = 还没选，回落第一个）。 */
  let selected = $state<string>(initialSelection(shell.settingsAnchor));
  /** 右栏详情容器（宽屏时是分区内唯一滚动区，深链锚点滚在这里面）。 */
  let detailEl: HTMLElement | undefined = $state();

  const agents = $derived(agentsStore.agents);
  const selectedAgent = $derived(agents.find((agent) => agent.id === selected) ?? null);

  /** 可用 = 已启用且就绪（与 Bot 选择器同一份判定）。 */
  function available(agent: AgentView): boolean {
    return agent.enabled && agentSetupReasonOf(agent) === null;
  }

  $effect(() => {
    agentsStore.start();
    void agentsStore.refresh().catch(() => undefined);
  });

  // 深链预选：`agent-<id>` 选中该智能体，`agents` 落在列表第一个。清理由外层
  // 分区容器统一做（宽屏 SettingsPage / 窄屏 NarrowSettings）。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (anchor === null) return;
    if (anchor.startsWith('agent-')) {
      const id = anchor.slice('agent-'.length);
      if (id.length > 0) selected = id;
    } else if (anchor === 'agents' && selected === '') {
      selected = agents[0]?.id ?? '';
    }
  });

  // 右栏详情内的锚点滚动（与 ModelsSection 同一算法）：选中项渲染完后滚过去。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (anchor === null) return;
    if (!anchor.startsWith('agent-')) return;
    void revealSettingsAnchor({
      anchor,
      container: () => detailEl,
      flush: tick,
      clear: () => undefined,
      attempts: 3,
    });
  });

  // 未预选（普通进入页签，无深链）或选中的 Agent 不在目录里（快照没到不抢跑 /
  // 已被移除）→ 落到列表第一个。
  $effect(() => {
    if (!agentsStore.loaded) return;
    if (selected === '' || selectedAgent === null) {
      selected = agents[0]?.id ?? '';
    }
  });
</script>

<div
  class="flex min-h-0 flex-1 flex-col space-y-4"
  data-testid="agents-section"
  data-settings-section="agents"
>
  <div class="shrink-0 space-y-1">
    <p class="text-xs text-muted-foreground">{t('agents.hint')}</p>
  </div>

  <!-- 两栏卡以剩余高度为最大高度：内容超出时由栏内自己滚（右栏详情 / 左栏导航），
       卡外（整个设置页）不出现滚动条；overflow-hidden 让栏内滚动条不出圆角边框。 -->
  <div
    class="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-xl border sm:flex-row sm:gap-0"
    data-testid="agents-two-pane"
  >
    <!-- 左栏：窄屏横向滚动条，宽屏纵向导航（条目多时栏内滚） -->
    <aside
      class="shrink-0 border-b p-2 sm:flex sm:min-h-0 sm:w-56 sm:flex-col sm:border-r sm:border-b-0"
    >
      <nav
        class="flex gap-1 overflow-x-auto sm:min-h-0 sm:flex-1 sm:flex-col sm:overflow-y-auto"
        data-testid="agents-nav"
      >
        {#each agents as agent (agent.id)}
          <button
            type="button"
            class="relative flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors {selected ===
            agent.id
              ? 'bg-accent font-medium text-accent-foreground'
              : 'hover:bg-accent/50'}"
            aria-current={selected === agent.id ? 'true' : undefined}
            onclick={() => (selected = agent.id)}
            data-testid={`agents-nav-agent-${agent.id}`}
          >
            {#if selected === agent.id}
              <span
                class="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
              ></span>
            {/if}
            <AgentIcon icon={agent.icon} name={agent.name} size="sm" />
            <span class="truncate">{agent.name}</span>
            {#if available(agent)}
              <span
                class="ml-auto size-2 shrink-0 rounded-full bg-emerald-500"
                title={t('agents.available')}
                data-testid={`agents-nav-available-${agent.id}`}
              ></span>
            {/if}
          </button>
        {/each}
        {#if agentsStore.loaded && agents.length === 0}
          <p class="px-2 py-1.5 text-xs text-muted-foreground">{t('agents.empty')}</p>
        {/if}
      </nav>
    </aside>

    <!-- 右栏详情：宽屏时是分区内唯一滚动区（左栏导航必要时在栏内滚），
         高度不超过两栏卡（即窗口剩余高度减标题行），深链锚点也滚在这里面。 -->
    <div
      class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-5"
      bind:this={detailEl}
    >
      {#if selectedAgent !== null}
        <AgentCard agent={selectedAgent} />
      {/if}
    </div>
  </div>
</div>

<script lang="ts">
  import { tick } from 'svelte';
  import { SlidersHorizontal } from '@lucide/svelte';
  import { agentSetupReasonOf, type AgentView } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { Label } from '$lib/components/ui/label';
  import { revealSettingsAnchor } from './anchor-scroll';
  import AgentIcon from './AgentIcon.svelte';
  import AgentCard from './AgentCard.svelte';
  import BackgroundTasksSection from './BackgroundTasksSection.svelte';

  /**
   * 设置页「智能体」（D72，docs/design/28-external-agents-acp.md §2.2），布局对齐
   * 「模型」分区：两栏卡——左栏第一条「全局配置」（新建 Bot 的默认智能体 +
   * 后台任务），其下是目录里的全部智能体（含未启用 / 未安装的），右栏是选中
   * 条目的详情：全局配置或该智能体的 `AgentCard`（与对话内 Agent 设置卡、
   * onboarding 订阅分支共用同一份卡片与保存 RPC）。已启用且就绪的条目在左栏
   * 右侧带绿点。
   *
   * 纵向空间与「模型」分区一致：外层设置页对「智能体」分区不滚，两栏卡撑满
   * 剩余高度（min-h-0 + flex-1），滚动归右栏详情自己；左栏条目多时在栏内滚。
   */

  /**
   * 挂载时的深链预选：`agent-<id>` 直接打开该智能体。挂在脚本里（而不是只靠
   * $effect）是因为外层分区容器会在渲染后的下一 tick 清掉锚点，子组件的
   * effect 可能已经读不到它；`agents` / `background-tasks` 都落在全局配置。
   */
  function initialSelection(anchor: string | null): string {
    return anchor !== null && anchor.startsWith('agent-')
      ? anchor.slice('agent-'.length)
      : 'config';
  }

  /** 选中项：'config' = 全局配置；否则是 Agent id。 */
  let selected = $state<string>(initialSelection(shell.settingsAnchor));
  /** 右栏详情容器（宽屏时是分区内唯一滚动区，深链锚点滚在这里面）。 */
  let detailEl: HTMLElement | undefined = $state();

  const agents = $derived(agentsStore.agents);
  const selectedAgent = $derived(
    selected === 'config' ? null : (agents.find((agent) => agent.id === selected) ?? null),
  );

  /**
   * 新建 Bot 的默认智能体（`settings.defaultAgentId`，onboarding「我有订阅」
   * 写入）：可选已启用的 Agent；当前值不在其中（已停用）时仍列出以便看见。
   */
  const defaultAgentId = $derived(settingsStore.settings?.defaultAgentId ?? '');
  const defaultAgentOptions = $derived.by(() => {
    const enabled = agents.filter((agent) => agent.enabled);
    const current = agents.find((agent) => agent.id === defaultAgentId) ?? null;
    return current !== null && !enabled.includes(current) ? [...enabled, current] : enabled;
  });

  let defaultBusy = $state(false);

  /** 可用 = 已启用且就绪（与 Bot 选择器 / 后台任务同一份判定）。 */
  function available(agent: AgentView): boolean {
    return agent.enabled && agentSetupReasonOf(agent) === null;
  }

  async function setDefaultAgent(id: string): Promise<void> {
    defaultBusy = true;
    try {
      await settingsStore.update({ defaultAgentId: id });
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      defaultBusy = false;
    }
  }

  $effect(() => {
    agentsStore.start();
    void agentsStore.refresh().catch(() => undefined);
  });

  // 深链预选：`agent-<id>` 选中该智能体，`agents` / `background-tasks` 落在
  // 全局配置。清理由外层分区容器统一做（宽屏 SettingsPage / 窄屏 NarrowSettings）。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (anchor === null) return;
    if (anchor.startsWith('agent-')) {
      const id = anchor.slice('agent-'.length);
      if (id.length > 0) selected = id;
    } else if (anchor === 'agents' || anchor === 'background-tasks') {
      selected = 'config';
    }
  });

  // 右栏详情内的锚点滚动（与 ModelsSection 同一算法）：选中项渲染完后滚过去。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (anchor === null) return;
    if (anchor !== 'background-tasks' && !anchor.startsWith('agent-')) return;
    void revealSettingsAnchor({
      anchor,
      container: () => detailEl,
      flush: tick,
      clear: () => undefined,
      attempts: 3,
    });
  });

  // 选中的 Agent 不在目录里（快照没到不抢跑）→ 回落全局配置。
  $effect(() => {
    if (agentsStore.loaded && selected !== 'config' && selectedAgent === null) selected = 'config';
  });
</script>

<div
  class="flex min-h-0 flex-1 flex-col space-y-4"
  data-testid="agents-section"
  data-settings-section="agents"
>
  <div class="shrink-0 space-y-1">
    <h3 class="text-sm font-medium">{t('agents.title')}</h3>
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
        <button
          type="button"
          class="relative flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors {selected ===
          'config'
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-accent/50'}"
          aria-current={selected === 'config' ? 'true' : undefined}
          onclick={() => (selected = 'config')}
          data-testid="agents-nav-config"
        >
          {#if selected === 'config'}
            <span class="absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
            ></span>
          {/if}
          <SlidersHorizontal class="size-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{t('settings.agentsNavConfig')}</span>
        </button>
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
      {#if selected === 'config'}
        <div class="space-y-6">
          <div class="grid gap-1.5" data-testid="agents-default-agent">
            <Label for="agents-default-agent">{t('agents.defaultAgent')}</Label>
            <select
              id="agents-default-agent"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={defaultAgentId}
              disabled={defaultBusy}
              onchange={(event) => void setDefaultAgent(event.currentTarget.value)}
              data-testid="agents-default-agent-select"
            >
              <option value="">{t('agents.defaultAgentNone')}</option>
              {#each defaultAgentOptions as agent (agent.id)}
                <option value={agent.id}>{agent.name}</option>
              {/each}
            </select>
            <p class="text-xs text-muted-foreground">{t('agents.defaultAgentHint')}</p>
          </div>

          <div data-settings-anchor="background-tasks">
            <BackgroundTasksSection />
          </div>
        </div>
      {:else if selectedAgent !== null}
        <AgentCard agent={selectedAgent} />
      {/if}
    </div>
  </div>
</div>

<script lang="ts">
  /**
   * Bot 详情的统一二级菜单（tabs 已移除，所有内容收进这一张分组列表）：行尾展示
   * 当前值摘要，点行由 RightPanel 下钻到对应详情，返回回菜单。组件不做下钻——
   * 只要该 Bot 有组件，就把每个组件行放在菜单最上方，点行直接查看
   * （BotWidgetDetail）；完整管理（发卡 / 删除）就在组件详情里。
   */
  import {
    AppWindow,
    Blocks,
    BookOpen,
    Bot,
    Brain,
    CalendarClock,
    Cpu,
    Eye,
    FolderOpen,
    Globe,
    ListChecks,
    MessageSquareDot,
    Package,
    Puzzle,
    ShieldCheck,
    Trash2,
  } from '@lucide/svelte';
  import type { BotProfile, WidgetsListItem } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { chat } from '$lib/stores/chat.svelte';
  import { workdirs } from '$lib/stores/workdirs.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { memoryStore } from '$lib/stores/memory.svelte';
  import { skillsStore } from '$lib/stores/skills.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { engineValue, AGENT_OPTION_PREFIX } from '$lib/features/bot-panel/agent-capabilities';
  import { enabledPluginCount } from '$lib/features/bot-panel/bot-plugins';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import { inkcopCollabEnabled } from '$lib/features/inkcop-collab';
  import type { BotConfigSection } from '$lib/features/bot-panel/bot-config-sections';
  import ConfigMenuGroup from './ConfigMenuGroup.svelte';
  import MenuRow from './MenuRow.svelte';

  let {
    profile,
    botId,
    /** 当前对话（工作目录行的摘要与开关；缺省不渲染该行）。 */
    conversationId,
    workdirId,
    workdirDisabled = false,
    /** 管家（D70）不可删除：不渲染「移除 Bot」行。 */
    deletable = true,
    onOpenSection,
    onOpenWidget,
    onOpenWorkdir,
    onOpenMemory,
    onOpenSkills,
    onOpenWiki,
    onOpenAccess,
    onOpenSchedules,
    onOpenWatches,
    onRemoveBot,
  }: {
    profile: BotProfile;
    botId: string;
    conversationId: string | undefined;
    workdirId: string | null;
    workdirDisabled?: boolean;
    deletable?: boolean;
    onOpenSection: (section: BotConfigSection) => void;
    onOpenWidget: (widget: WidgetsListItem) => void;
    onOpenWorkdir: () => void;
    onOpenMemory: () => void;
    onOpenSkills: () => void;
    onOpenWiki: () => void;
    onOpenAccess: () => void;
    onOpenSchedules: () => void;
    onOpenWatches: () => void;
    onRemoveBot: () => void;
  } = $props();

  // --- 组件（菜单最上方的直查入口；发卡 / 删除在组件详情里） --------------------
  let widgets = $state<WidgetsListItem[]>([]);
  let widgetsLoaded = $state(false);

  $effect(() => {
    void refresh();
  });

  /** 详情里删除 / 发卡后由 RightPanel 调，菜单行随之增删。 */
  export async function refresh(): Promise<void> {
    try {
      const result = (await core.call('widgets.list', { botId })) as {
        widgets: WidgetsListItem[];
      };
      widgets = result.widgets;
    } catch {
      // 菜单是辅助入口：拉不到就不显示组件区。
    } finally {
      widgetsLoaded = true;
    }
  }

  // 行摘要依赖的 store（与配置表单 / 各详情同一批；列表载入即可读计数）。
  $effect(() => {
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });
  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
  });
  $effect(() => {
    void memoryStore.load(botId).catch(() => undefined);
  });
  $effect(() => {
    skillsStore.start();
    void skillsStore.load(botId);
  });

  // --- 行摘要 ---------------------------------------------------------------
  const firstLine = (value: string): string => {
    const line =
      value
        .split('\n')
        .find((entry) => entry.trim().length > 0)
        ?.trim() ?? '';
    return line.length > 24 ? `${line.slice(0, 24)}…` : line;
  };

  const personaSummary = $derived(
    firstLine(profile.persona.personality) ||
      firstLine(profile.persona.tone) ||
      firstLine(profile.persona.style) ||
      t('rightPanel.configNotSet'),
  );
  const roleSummary = $derived(
    firstLine(profile.role.expertise) ||
      firstLine(profile.role.responsibilities) ||
      t('rightPanel.configNotSet'),
  );

  const modelSummary = $derived.by(() => {
    const value = engineValue(profile.runtime);
    if (value.length === 0) return t('rightPanel.configNotSet');
    if (value.startsWith(AGENT_OPTION_PREFIX)) {
      return agentsStore.get(value.slice(AGENT_OPTION_PREFIX.length))?.name ?? value;
    }
    const option = settingsStore.availableModelOptions.find((entry) => entry.ref === value);
    return option?.label ?? value;
  });

  // P2 注入模型：应用 / MCP / 邮箱三行合并为「插件」，摘要 = 与已装清单求交的启用数。
  const pluginCount = $derived(enabledPluginCount(profile.runtime.plugin_ids, plugins.plugins));

  const inkcopOn = $derived(inkcopCollabEnabled(settingsStore.settings));
  const inkcopSummary = $derived(profile.runtime.inkcop_agent_keys?.length ?? 0);

  const memoryCount = $derived(memoryStore.botId === botId ? memoryStore.items.length : null);
  const skillsCount = $derived(skillsStore.botId === botId ? skillsStore.skills.length : null);

  const networkSummary = $derived(
    profile.runtime.network_policy === 'open'
      ? t('rightPanel.configNetworkOpen')
      : profile.runtime.network_policy === 'allowlist'
        ? t('contacts.networkPolicyAllowlist')
        : t('contacts.networkPolicyNone'),
  );

  const browserSummary = $derived(
    profile.runtime.browser_profile.length === 0
      ? t('rightPanel.configBrowserPrivate')
      : (settingsStore.settings?.browserProfiles.find(
          (entry) => entry.id === profile.runtime.browser_profile,
        )?.name ?? profile.runtime.browser_profile),
  );

  const workdir = $derived(
    conversationId === undefined ? null : workdirs.boundOf(conversationId, workdirId),
  );
  const workdirMissing = $derived(workdir !== null && workdir.status === 'missing');
  // 与 WorkdirSelector 一致：Bot 执行中不允许切换工作目录（只读对话是常态禁用，不提示）。
  const workdirRunning = $derived((chat.current?.activeRuns.length ?? 0) > 0);
  const workdirBusy = $derived(workdirDisabled || workdirRunning);
</script>

<div class="space-y-4" data-testid="bot-menu">
  {#if widgetsLoaded && widgets.length > 0}
    <!-- 组件直查行（design：不做成下钻分组，有组件就置顶直查） -->
    <ConfigMenuGroup label={t('rightPanel.configSectionWidgets')}>
      {#each widgets as entry (entry.widgetId)}
        <MenuRow
          icon={Blocks}
          title={entry.title}
          summary={`v${entry.version}`}
          testid={`bot-config-row-widget-${entry.widgetId}`}
          onclick={() => onOpenWidget(entry)}
        />
      {/each}
    </ConfigMenuGroup>
  {/if}

  {#if conversationId !== undefined}
    <ConfigMenuGroup>
      <MenuRow
        icon={FolderOpen}
        title={t('workdirs.selector')}
        summary={workdir !== null ? workdir.name : t('workdirs.none')}
        testid="bot-config-row-workdir"
        onclick={onOpenWorkdir}
        disabled={workdirBusy}
        alert={workdirMissing}
      />
      {#if workdirRunning}
        <p
          class="px-3 pb-2 text-[11px] text-muted-foreground"
          data-testid="workdir-switch-blocked-hint"
        >
          {t('workdirs.switchBlocked')}
        </p>
      {/if}
    </ConfigMenuGroup>
  {/if}

  <ConfigMenuGroup label={t('rightPanel.configSectionPersona')}>
    <MenuRow
      icon={MessageSquareDot}
      title={t('rightPanel.configRowPersona')}
      summary={personaSummary}
      testid="bot-config-row-persona"
      onclick={() => onOpenSection('persona')}
    />
    <MenuRow
      icon={ListChecks}
      title={t('rightPanel.configRowRole')}
      summary={roleSummary}
      testid="bot-config-row-role"
      onclick={() => onOpenSection('role')}
    />
    <MenuRow
      icon={Cpu}
      title={t('rightPanel.configRowModel')}
      summary={modelSummary}
      testid="bot-config-row-model"
      onclick={() => onOpenSection('model')}
    />
  </ConfigMenuGroup>

  <ConfigMenuGroup label={t('rightPanel.menuSectionKnowledge')}>
    <MenuRow
      icon={Brain}
      title={t('rightPanel.tabMemory')}
      summary={memoryCount === null
        ? '—'
        : t('rightPanel.memoryCountSummary', { count: memoryCount })}
      testid="bot-menu-row-memory"
      onclick={onOpenMemory}
    />
    <MenuRow
      icon={Puzzle}
      title={t('rightPanel.tabSkills')}
      summary={skillsCount === null
        ? '—'
        : t('rightPanel.skillsCountSummary', { count: skillsCount })}
      testid="bot-menu-row-skills"
      onclick={onOpenSkills}
    />
    <MenuRow
      icon={BookOpen}
      title={t('rightPanel.tabWiki')}
      testid="bot-menu-row-wiki"
      onclick={onOpenWiki}
    />
  </ConfigMenuGroup>

  <ConfigMenuGroup label={t('rightPanel.configSectionConnections')}>
    <MenuRow
      icon={Package}
      title={t('botPanel.sections.plugins')}
      summary={pluginCount > 0
        ? t('botPanel.plugins.summaryEnabled', { count: pluginCount })
        : t('botPanel.plugins.summaryNone')}
      testid="bot-config-row-plugins"
      onclick={() => onOpenSection('plugins')}
    />
    {#if inkcopOn}
      <MenuRow
        icon={Bot}
        title={t('rightPanel.configRowInkcop')}
        summary={String(inkcopSummary)}
        testid="bot-config-row-inkcop"
        onclick={() => onOpenSection('inkcop')}
      />
    {/if}
  </ConfigMenuGroup>

  <ConfigMenuGroup label={t('rightPanel.menuSectionTasks')}>
    <MenuRow
      icon={CalendarClock}
      title={t('rightPanel.tabSchedules')}
      testid="bot-menu-row-schedules"
      onclick={onOpenSchedules}
    />
    <MenuRow
      icon={Eye}
      title={t('watches.title')}
      testid="bot-menu-row-watches"
      onclick={onOpenWatches}
    />
  </ConfigMenuGroup>

  <ConfigMenuGroup label={t('rightPanel.configSectionSecurity')}>
    <MenuRow
      icon={Globe}
      title={t('rightPanel.configRowNetwork')}
      summary={networkSummary}
      testid="bot-config-row-network"
      onclick={() => onOpenSection('network')}
    />
    <MenuRow
      icon={AppWindow}
      title={t('rightPanel.configRowBrowser')}
      summary={browserSummary}
      testid="bot-config-row-browser"
      onclick={() => onOpenSection('browser')}
    />
    <MenuRow
      icon={ShieldCheck}
      title={t('rightPanel.menuAccessRow')}
      summary={t('rightPanel.accessCountSummary', { count: permissions.grants.length })}
      testid="bot-menu-row-access"
      onclick={onOpenAccess}
    />
  </ConfigMenuGroup>

  {#if deletable}
    <ConfigMenuGroup label={t('rightPanel.otherSection')}>
      <MenuRow
        icon={Trash2}
        danger
        title={t('rightPanel.removeBot')}
        testid="bot-remove"
        onclick={onRemoveBot}
      />
    </ConfigMenuGroup>
  {/if}
</div>

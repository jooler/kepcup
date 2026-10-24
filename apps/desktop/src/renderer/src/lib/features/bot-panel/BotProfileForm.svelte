<script lang="ts">
  /** Shared profile form fields for bot create (dialog) and edit (right panel). */
  import { untrack } from 'svelte';
  import type {
    BotProfile,
    HostCapabilityId,
    HostCapabilityPrerequisite,
    InkcopAgent,
  } from '@kepcup/shared';
  import { ChevronDown, Plus, X } from '@lucide/svelte';
  import { t, listSeparator } from '$lib/i18n';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import BotMailBindings from '$lib/features/mail/BotMailBindings.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { inkcopCollabEnabled } from '$lib/features/inkcop-collab';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import type { MessageKey } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { appIconSrc, appInitial } from '$lib/features/apps/app-catalog';
  import { CONNECTION_STATUS_LABEL_KEYS } from '$lib/features/apps/connect-flow';
  import { appUnattendedNotice, countRiskyTools, mcpUnattendedNotice } from '../approvals/mcp-risk';
  import {
    capabilityRows,
    engineValue,
    estimatedTools,
    normalizeCapabilities,
    parseEngineValue,
    toggleCapability,
    toggleCapabilityOptIn,
    AGENT_OPTION_PREFIX,
  } from './agent-capabilities';
  import {
    accountHintKey,
    appChoiceGroups,
    appToolEstimate,
    selectAppConnection,
    shouldShowAcpAppsNotice,
  } from './bot-apps';
  import type { BotConfigSection } from './bot-config-sections';

  let {
    profile = $bindable(),
    /** 名字/简介在右栏头部资料卡已有点按直编，编辑场景传 false 隐藏（新建场景必填，保持显示）。 */
    showIdentity = true,
    /**
     * W8：编辑已有 Bot 时，切换浏览器资料要显式确认（关闭它已打开的网页、中断
     * 用过浏览器的任务）——给了它，下拉只改待确认值，确认后由调用方立即保存；
     * 不给（新建）则直接绑定。
     */
    onBrowserProfileConfirm,
    botId,
    /**
     * 右栏二级菜单的下钻模式：只渲染该条目的字段（详情页）；缺省整表渲染
     * （历史的新建表单）。字段区块与 data-settings-anchor 不变。
     */
    section,
  }: {
    profile: BotProfile;
    showIdentity?: boolean;
    onBrowserProfileConfirm?: (next: string) => void | Promise<void>;
    /** 已有 Bot 时才能勾选邮箱绑定。新建对话框还没有 id。 */
    botId?: string;
    section?: BotConfigSection;
  } = $props();

  /** 整表渲染（section 缺省）时所有条目都出；下钻模式只出该条目。 */
  const show = (part: BotConfigSection): boolean => section === undefined || section === part;

  /**
   * Only providers with a stored key offer models here; a stored model ref
   * whose provider key was removed stays selectable as a marked stale entry
   * so the current value still renders (and can be consciously cleared).
   */
  const modelOptions = $derived.by(() => {
    const options = settingsStore.availableModelOptions;
    const stale = [profile.runtime.model, profile.runtime.light_model].filter(
      (ref) => ref.length > 0 && !options.some((option) => option.ref === ref),
    );
    return [
      ...options,
      ...stale.map((ref) => ({ ref, label: t('contacts.modelUnavailable', { ref }) })),
    ];
  });
  // W8 共享浏览器资料：'' = 私有（默认）。
  const browserProfiles = $derived(settingsStore.settings?.browserProfiles ?? []);
  /** W8：下拉里选中但还没确认的资料（null = 没有待确认的切换）。 */
  let pendingBrowserProfile = $state<string | null>(null);
  let browserProfileSaving = $state(false);
  const shownBrowserProfile = $derived(pendingBrowserProfile ?? profile.runtime.browser_profile);
  const sharedBrowserProfile = $derived(
    browserProfiles.find((entry) => entry.id === shownBrowserProfile) ?? null,
  );

  // A re-cloned profile (another bot, or the bot was updated) drops a pending choice.
  $effect(() => {
    void profile;
    pendingBrowserProfile = null;
  });

  function onBrowserProfileSelect(next: string): void {
    if (onBrowserProfileConfirm === undefined) {
      profile.runtime.browser_profile = next;
      return;
    }
    // Arrowing through the options only moves the pending choice; nothing is saved.
    pendingBrowserProfile = next === profile.runtime.browser_profile ? null : next;
  }

  async function confirmBrowserProfile(): Promise<void> {
    const next = pendingBrowserProfile;
    if (next === null || onBrowserProfileConfirm === undefined) return;
    browserProfileSaving = true;
    try {
      await onBrowserProfileConfirm(next);
    } finally {
      browserProfileSaving = false;
      pendingBrowserProfile = null;
    }
  }
  // D65：应用级已启用的 MCP server 才出现在勾选列表里。
  const mcpOptions = $derived(
    (settingsStore.settings?.mcpServers ?? []).filter((server) => server.enabled),
  );

  // W5（§5 护栏 7）：选了任一 MCP server 就常驻风险提示；无人值守生效时取选中
  // server 的工具风险档，含写入 / 破坏性工具则升级为警示并列出数量。
  const selectedMcpServers = $derived(
    mcpOptions.filter((server) => profile.runtime.mcp_server_ids.includes(server.id)),
  );
  let mcpRiskyCount = $state<number | null>(null);
  let mcpRiskUnknown = $state(false);
  // Refetch only when the selection itself changes (ids), not on every
  // settings write — the queries connect to the servers.
  const selectedMcpKey = $derived(selectedMcpServers.map((server) => server.id).join(','));
  $effect(() => {
    const key = selectedMcpKey;
    const unattendedOn = permissions.unattended.enabled;
    if (!unattendedOn || key.length === 0) {
      mcpRiskyCount = null;
      mcpRiskUnknown = false;
      return;
    }
    const servers = untrack(() => selectedMcpServers);
    let cancelled = false;
    // An unreachable server (error / rejection) is unknown, never "0 risky".
    void Promise.all(
      servers.map((server) =>
        settingsStore
          .mcpToolRisks(server.id)
          .then((report) =>
            report.error !== undefined ? null : countRiskyTools(server, report.tools),
          )
          .catch(() => null),
      ),
    ).then((counts) => {
      if (cancelled) return;
      mcpRiskyCount = counts.reduce<number>((sum, count) => sum + (count ?? 0), 0);
      mcpRiskUnknown = counts.some((count) => count === null);
    });
    return () => {
      cancelled = true;
    };
  });
  const mcpNotice = $derived(
    mcpUnattendedNotice({
      selectedServerCount: selectedMcpServers.length,
      unattendedEnabled: permissions.unattended.enabled,
      riskyCount: mcpRiskyCount,
      riskUnknown: mcpRiskUnknown,
    }),
  );

  // --- 连接应用（D73 §5.7 / §5.9）：按应用分组、单选账号 ------------------------
  $effect(() => {
    appsStore.start();
  });
  const appGroups = $derived(
    appChoiceGroups(appsStore.catalog, appsStore.connections, profile.runtime.app_connection_ids),
  );
  const selectedAppConnections = $derived(
    appsStore.connections.filter((connection) =>
      profile.runtime.app_connection_ids.includes(connection.id),
    ),
  );
  /**
   * 拉所选连接的工具清单——查询会连到服务端，所以只在选中集合（id）变化、或缓存被清
   * （`invalidateTools`：状态推送 / 连接完成）时重拉。缓存本身要被追踪，否则失效后估计
   * 一直停在「未知」；`!== undefined` 守卫保证已缓存的不会重复拉、失败的（缓存仍空、无
   * 状态变化）不会循环。
   */
  const selectedAppKey = $derived(selectedAppConnections.map((c) => c.id).join(','));
  $effect(() => {
    const key = selectedAppKey;
    if (key.length === 0) return;
    const cache = appsStore.toolsByConnection;
    const ids = untrack(() => selectedAppConnections.map((c) => c.id));
    for (const id of ids) {
      if (cache[id] !== undefined) continue;
      // A failed query leaves the cache empty: the estimate reports it as unknown, never as 0.
      void appsStore.connectionTools(id).catch(() => undefined);
    }
  });
  const appTools = $derived(appToolEstimate(selectedAppConnections, appsStore.toolsByConnection));
  const appNotice = $derived(
    appUnattendedNotice({
      selectedConnectionCount: selectedAppConnections.length,
      unattendedEnabled: permissions.unattended.enabled,
    }),
  );

  function selectApp(connectorId: string, connectionId: string | null): void {
    profile.runtime.app_connection_ids = selectAppConnection(
      profile.runtime.app_connection_ids,
      appsStore.connections,
      connectorId,
      connectionId,
    );
    if (connectionId !== null) maybeShowAcpAppsNotice();
  }

  // --- 连接应用（D73 §5.7 / §5.9）：只列在用的，添加 / 移除走选择器 ---------------
  /** Bot 正在使用的应用（选了账号的分组）：列表区只渲染这些。 */
  const usedAppGroups = $derived(appGroups.filter((group) => group.selectedConnectionId !== null));
  /** 添加选择器的候选：有已连接账号的应用（未连接的去扩展中心连接，不直接展示）。 */
  const addableAppGroups = $derived(appGroups.filter((group) => group.accounts.length > 0));
  let appsPickerOpen = $state(false);
  /** 多账号应用在选择器里展开后的 connectorId。 */
  let expandedPickerApps = $state<string[]>([]);

  function openAppsPicker(): void {
    expandedPickerApps = [];
    appsPickerOpen = true;
  }

  function togglePickerApp(connectorId: string): void {
    expandedPickerApps = expandedPickerApps.includes(connectorId)
      ? expandedPickerApps.filter((id) => id !== connectorId)
      : [...expandedPickerApps, connectorId];
  }

  /** 选中应用的某个账号（或整行移除）。多账号的先展开再挑。 */
  function pickAppAccount(connectorId: string, connectionId: string): void {
    selectApp(connectorId, connectionId);
    appsPickerOpen = false;
    expandedPickerApps = [];
  }

  function removeApp(connectorId: string): void {
    selectApp(connectorId, null);
  }

  function openCatalog(): void {
    shell.openExtensionCenter('connections');
  }

  // --- §5.10：外部智能体 + `apps` 能力包的一次性残余风险说明 -------------------------
  const ACP_APPS_ACK_KEY = 'kepcup.apps.acpNoticeAck';
  let acpNoticeOpen = $state(false);

  function acpNoticeAcknowledged(): boolean {
    try {
      return localStorage.getItem(ACP_APPS_ACK_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** 切到外部智能体、勾上 `apps` 包、或在智能体下选中应用账号时各检查一次。 */
  function maybeShowAcpAppsNotice(): void {
    if (
      shouldShowAcpAppsNotice({
        agentSelected: profile.runtime.agent.id.length > 0,
        appsCapabilityChecked: capabilityList.some((row) => row.id === 'apps' && row.checked),
        acknowledged: acpNoticeAcknowledged(),
      })
    ) {
      acpNoticeOpen = true;
    }
  }

  function confirmAcpNotice(): void {
    try {
      localStorage.setItem(ACP_APPS_ACK_KEY, '1');
    } catch {
      // Not persisted: the notice shows again next time.
    }
    acpNoticeOpen = false;
  }

  /** 「不注入应用」：取消 `apps` 包（不记已确认，下次勾选再提示）。 */
  function declineAcpNotice(): void {
    acpNoticeOpen = false;
    toggleAgentCapability('apps', false);
  }

  // --- 外部智能体（D72 §3）：主模型选择器扩展为「模型 / 智能体」 -----------------
  /** 首次把 Bot 切到外部智能体时弹框说明让渡项（每台设备一次）。 */
  const SWITCH_ACK_KEY = 'kepcup.agentSwitchAcknowledged';

  $effect(() => {
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  const selectedAgentId = $derived(profile.runtime.agent.id);
  const selectedAgent = $derived(
    selectedAgentId.length > 0 ? agentsStore.get(selectedAgentId) : null,
  );
  /** 智能体组：实验开关打开时列已启用的 Agent；当前值不在其中时仍保留一项以便显示。 */
  const agentOptions = $derived.by(() => {
    const list = agentsStore.experimental ? agentsStore.selectable : [];
    const options = list.map((agent) => ({
      id: agent.id,
      label:
        agent.status === 'needs_auth'
          ? `${agent.name}（${t('contacts.agentNeedsAuthTag')}）`
          : agent.name,
    }));
    if (selectedAgentId.length > 0 && !options.some((option) => option.id === selectedAgentId)) {
      options.push({
        id: selectedAgentId,
        label: t('contacts.agentUnavailable', { id: selectedAgent?.name ?? selectedAgentId }),
      });
    }
    return options;
  });
  /** 没有任何内置模型时隐藏「轻量模型」（后台任务另行处理，§3）。 */
  const showLightModel = $derived(
    settingsStore.availableModelOptions.length > 0 || profile.runtime.light_model.length > 0,
  );

  let pendingAgentId = $state<string | null>(null);
  let switchDialogOpen = $state(false);
  let engineSelect = $state<HTMLSelectElement | undefined>();
  let optionsBusy = $state(false);
  let customModel = $state(false);
  const CUSTOM_MODEL = '__custom__';

  function acknowledged(): boolean {
    try {
      return localStorage.getItem(SWITCH_ACK_KEY) === '1';
    } catch {
      return false;
    }
  }

  function applyAgent(agentId: string): void {
    const sameAgent = profile.runtime.agent.id === agentId;
    const agent = agentsStore.get(agentId);
    customModel = false;
    profile.runtime.agent = {
      ...profile.runtime.agent,
      id: agentId,
      // 设置页里给该智能体配的默认模型：切过来时直接带上。
      ...(sameAgent ? {} : { model: agent?.defaultModel ?? '', effort: '', capabilities: null }),
      // 预览档 Agent 默认更严（§6）。
      ...(sameAgent
        ? {}
        : { permission: agent?.tier === 'preview' ? ('ask' as const) : ('workspace' as const) }),
    };
    maybeShowAcpAppsNotice();
  }

  function onEngineChange(value: string): void {
    const parsed = parseEngineValue(value);
    if ('model' in parsed) {
      profile.runtime.agent = { ...profile.runtime.agent, id: '' };
      profile.runtime.model = parsed.model;
      return;
    }
    if (parsed.agentId === profile.runtime.agent.id) return;
    if (!acknowledged()) {
      pendingAgentId = parsed.agentId;
      switchDialogOpen = true;
      // Keep showing the current engine until the notice is confirmed.
      if (engineSelect !== undefined) engineSelect.value = engineValue(profile.runtime);
      return;
    }
    applyAgent(parsed.agentId);
  }

  function confirmSwitch(): void {
    try {
      localStorage.setItem(SWITCH_ACK_KEY, '1');
    } catch {
      // Not persisted: the notice shows again next time.
    }
    if (pendingAgentId !== null) applyAgent(pendingAgentId);
    pendingAgentId = null;
    switchDialogOpen = false;
  }

  // Model / effort choices come from the agent's session config options (cached).
  $effect(() => {
    const id = selectedAgentId;
    if (id.length === 0 || agentsStore.options[id] !== undefined) return;
    void agentsStore.loadOptions(id).catch(() => undefined);
  });
  const agentChoices = $derived(
    selectedAgentId.length > 0 ? agentsStore.options[selectedAgentId] : undefined,
  );
  const modelChoices = $derived(agentChoices?.models ?? []);
  const agentDefaultModel = $derived(selectedAgent?.defaultModel ?? '');
  /** Bot 留空时实际会用的模型：设置的默认模型，否则 Agent 自己的默认。 */
  const effectiveModel = $derived(
    profile.runtime.agent.model.length > 0 ? profile.runtime.agent.model : agentDefaultModel,
  );
  /** 当前模型下的推理强度选项；null = 还没读到（先隐藏，不阻塞其他设置）。 */
  const effortChoices = $derived.by(() => {
    if (selectedAgentId.length === 0) return null;
    if (effectiveModel.length === 0) return agentChoices?.efforts ?? null;
    return agentsStore.efforts[`${selectedAgentId}\u0000${effectiveModel}`] ?? null;
  });

  // 模型变化后按模型探测 thought_level（输入自定义模型时防抖）。
  $effect(() => {
    const id = selectedAgentId;
    const model = effectiveModel;
    if (id.length === 0 || model.length === 0) return;
    const timer = setTimeout(() => {
      void agentsStore.loadEfforts(id, model).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  });

  // 当前模型没有推理强度选项时隐藏设置并使用默认，避免带上别的模型的值。
  $effect(() => {
    const choices = effortChoices;
    if (choices === null || profile.runtime.agent.effort.length === 0) return;
    if (!choices.some((choice) => choice.value === profile.runtime.agent.effort)) {
      profile.runtime.agent.effort = '';
    }
  });

  function onModelSelect(value: string): void {
    if (value === CUSTOM_MODEL) {
      customModel = true;
      return;
    }
    customModel = false;
    if (value !== profile.runtime.agent.model) profile.runtime.agent.effort = '';
    profile.runtime.agent.model = value;
  }

  async function detectAgentOptions(): Promise<void> {
    if (selectedAgentId.length === 0) return;
    optionsBusy = true;
    try {
      await agentsStore.loadOptions(selectedAgentId, true);
      if (effectiveModel.length > 0) {
        await agentsStore.loadEfforts(selectedAgentId, effectiveModel, true);
      }
    } catch {
      // The card shows the error from the store.
    } finally {
      optionsBusy = false;
    }
  }

  function prerequisiteReady(prerequisite: HostCapabilityPrerequisite): boolean {
    if (prerequisite.kind === 'web-search') {
      return (settingsStore.settings?.webSearch.provider ?? null) !== null;
    }
    return settingsStore.isCapabilityReady(prerequisite.capability);
  }

  const capabilityContext = $derived({
    nativeCapabilities: selectedAgent?.nativeCapabilities ?? {},
    prerequisiteReady,
  });
  /**
   * 能力包默认值取决于该 Agent 的原生能力声明：目录视图未加载前不允许勾选，
   * 免得按空声明算出的默认值被存成显式数组。
   */
  const capabilitiesReady = $derived(agentsStore.loaded && selectedAgent !== null);
  const capabilityList = $derived(
    capabilityRows(profile.runtime.agent.capabilities, capabilityContext),
  );
  const toolEstimate = $derived(estimatedTools(capabilityList));

  function toggleAgentCapability(id: HostCapabilityId, checked: boolean): void {
    const next = toggleCapability(
      profile.runtime.agent.capabilities,
      id,
      checked,
      capabilityContext,
    );
    profile.runtime.agent.capabilities = normalizeCapabilities(next, capabilityContext);
    if (id === 'apps' && checked) maybeShowAcpAppsNotice();
  }

  /** 包内单独开关（如 `settings:change`：允许外部智能体修改设置，默认关闭）。 */
  function toggleAgentCapabilityOptIn(id: string, checked: boolean): void {
    const next = toggleCapabilityOptIn(
      profile.runtime.agent.capabilities,
      id,
      checked,
      capabilityContext,
    );
    profile.runtime.agent.capabilities = normalizeCapabilities(next, capabilityContext);
  }

  function toggleMcpServer(id: string, checked: boolean): void {
    const selected = profile.runtime.mcp_server_ids.filter((entry) => entry !== id);
    profile.runtime.mcp_server_ids = checked ? [...selected, id] : selected;
  }
  let boundariesText = $state(profile.boundaries.join('\n'));
  let allowlistText = $state(profile.runtime.network_allowlist.join('\n'));

  function syncBoundaries(): void {
    profile.boundaries = boundariesText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function syncAllowlist(): void {
    profile.runtime.network_allowlist = allowlistText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  // --- InkCop 同机智能体关联（契约 v0.2） ---------------------------------
  const inkcopCollabOn = $derived(inkcopCollabEnabled(settingsStore.settings));
  let inkcopAgents = $state<InkcopAgent[]>([]);
  let inkcopAgentsLoading = $state(false);
  let inkcopAgentsOnline = $state<boolean | null>(null);
  let inkcopAgentsTip = $state<string | null>(null);

  async function refreshInkcopAgents(): Promise<void> {
    if (!inkcopCollabOn) {
      inkcopAgents = [];
      inkcopAgentsOnline = null;
      inkcopAgentsTip = null;
      return;
    }
    inkcopAgentsLoading = true;
    try {
      const result = (await core.call('inkcop.listAgents', {})) as {
        online: boolean;
        agents: InkcopAgent[];
        tip?: string;
      };
      inkcopAgentsOnline = result.online;
      inkcopAgents = result.agents ?? [];
      inkcopAgentsTip = result.tip ?? null;
    } catch (error) {
      inkcopAgentsOnline = false;
      inkcopAgents = [];
      inkcopAgentsTip = error instanceof Error ? error.message : String(error);
    } finally {
      inkcopAgentsLoading = false;
    }
  }

  $effect(() => {
    void inkcopCollabOn;
    void refreshInkcopAgents();
  });

  function inkcopAgentChecked(key: string): boolean {
    return (profile.runtime.inkcop_agent_keys ?? []).includes(key);
  }

  function toggleInkcopAgent(key: string, checked: boolean): void {
    const current = profile.runtime.inkcop_agent_keys ?? [];
    const next = checked
      ? [...current.filter((entry) => entry !== key), key]
      : current.filter((entry) => entry !== key);
    profile.runtime.inkcop_agent_keys = next;
    // v0.4：关联只存 keys，供 call_inkcop_agent 工具；不切换整轮 message_transport。
    profile.runtime.message_transport = '';
  }
</script>

<div class="space-y-4">
  {#if section === undefined && showIdentity}
    <div class="grid gap-1.5">
      <Label for="bot-name">{t('contacts.name')}</Label>
      <Input
        id="bot-name"
        bind:value={profile.identity.name}
        placeholder={t('contacts.namePlaceholder')}
        data-testid="bot-name-input"
      />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-bio">{t('contacts.bio')}</Label>
      <Input
        id="bot-bio"
        bind:value={profile.identity.bio}
        placeholder={t('contacts.bioPlaceholder')}
        data-testid="bot-bio-input"
      />
    </div>
  {/if}
  <!-- 人设与语气：右栏二级菜单「人设与语气」条目的详情（整表渲染时同页）。 -->
  {#if show('persona')}
    <!-- data-settings-anchor：对话内设置卡「在设置中打开」的落点（settings-catalog 深链）。 -->
    <div class="grid gap-1.5" data-settings-anchor="bot-identity">
      <Label for="bot-personality">{t('contacts.personality')}</Label>
      <Textarea
        id="bot-personality"
        bind:value={profile.persona.personality}
        rows={2}
        data-testid="bot-personality-input"
      />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-tone">{t('contacts.tone')}</Label>
      <Input id="bot-tone" bind:value={profile.persona.tone} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-style">{t('contacts.style')}</Label>
      <Input id="bot-style" bind:value={profile.persona.style} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-values">{t('contacts.values')}</Label>
      <Textarea id="bot-values" bind:value={profile.persona.values} rows={2} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-samples">{t('contacts.sampleDialogues')}</Label>
      <Textarea id="bot-samples" bind:value={profile.persona.sample_dialogues} rows={3} />
    </div>
  {/if}
  <!-- 职责与边界 -->
  {#if show('role')}
    <div class="grid gap-1.5">
      <Label for="bot-expertise">{t('contacts.expertise')}</Label>
      <Input id="bot-expertise" bind:value={profile.role.expertise} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-responsibilities">{t('contacts.responsibilities')}</Label>
      <Input id="bot-responsibilities" bind:value={profile.role.responsibilities} />
    </div>
    <div class="grid gap-1.5">
      <Label for="bot-boundaries">{t('contacts.boundaries')}</Label>
      <Textarea id="bot-boundaries" bind:value={boundariesText} oninput={syncBoundaries} rows={2} />
    </div>
  {/if}
  <!-- 网络 -->
  {#if show('network')}
    <div class="grid gap-1.5" data-settings-anchor="bot-network">
      <Label for="bot-network-policy">{t('contacts.networkPolicy')}</Label>
      <select
        id="bot-network-policy"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={profile.runtime.network_policy}
        data-testid="bot-network-policy"
      >
        <option value="open">{t('contacts.networkPolicyOpen')}</option>
        <option value="allowlist">{t('contacts.networkPolicyAllowlist')}</option>
        <option value="none">{t('contacts.networkPolicyNone')}</option>
      </select>
    </div>
    {#if profile.runtime.network_policy === 'allowlist'}
      <div class="grid gap-1.5">
        <Label for="bot-network-allowlist">{t('contacts.networkAllowlist')}</Label>
        <Textarea
          id="bot-network-allowlist"
          rows={2}
          bind:value={allowlistText}
          oninput={syncAllowlist}
          placeholder={t('contacts.networkAllowlistHint')}
        />
      </div>
    {/if}
  {/if}
  <!-- 浏览器资料 -->
  {#if show('browser')}
    <div class="grid gap-1.5" data-settings-anchor="bot-browser-profile">
      <Label for="bot-browser-profile">{t('contacts.browserProfile')}</Label>
      <select
        id="bot-browser-profile"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        value={shownBrowserProfile}
        onchange={(event) => onBrowserProfileSelect(event.currentTarget.value)}
        disabled={browserProfileSaving}
        data-testid="bot-browser-profile"
      >
        <option value="">{t('contacts.browserProfilePrivate')}</option>
        {#each browserProfiles as entry (entry.id)}
          <option value={entry.id}
            >{t('contacts.browserProfileShared', { name: entry.name })}</option
          >
        {/each}
      </select>
      <p class="text-xs text-muted-foreground">{t('contacts.browserProfileHint')}</p>
      {#if pendingBrowserProfile !== null}
        <div
          class="space-y-2 rounded bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300"
          data-testid="bot-browser-profile-confirm"
        >
          <p>{t('contacts.browserProfileSwitchConfirm')}</p>
          <div class="flex gap-2">
            <Button
              size="sm"
              disabled={browserProfileSaving}
              onclick={() => void confirmBrowserProfile()}
              data-testid="bot-browser-profile-confirm-yes"
            >
              {t('contacts.browserProfileSwitchYes')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={browserProfileSaving}
              onclick={() => (pendingBrowserProfile = null)}
              data-testid="bot-browser-profile-confirm-no"
            >
              {t('contacts.browserProfileSwitchNo')}
            </Button>
          </div>
        </div>
      {/if}
      {#if sharedBrowserProfile !== null}
        <p
          class="rounded bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
          data-testid="bot-browser-profile-warning"
        >
          {t('contacts.browserProfileSharedWarning')}
        </p>
      {/if}
    </div>
  {/if}
  <!-- 模型与智能体（含智能体下钻的模型 / 推理强度 / 权限 / 能力包） -->
  {#if show('model')}
    <div class="grid gap-4" data-settings-anchor="bot-model">
      <div class="grid gap-1.5">
        <Label for="bot-model"
          >{agentOptions.length > 0
            ? t('contacts.mainModelOrAgent')
            : t('contacts.mainModel')}</Label
        >
        <select
          id="bot-model"
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          bind:this={engineSelect}
          value={engineValue(profile.runtime)}
          onchange={(event) => onEngineChange(event.currentTarget.value)}
          data-testid="bot-model-select"
        >
          <option value="">—</option>
          {#if agentOptions.length > 0}
            <optgroup label={t('contacts.engineGroupModels')}>
              {#each modelOptions as option (option.ref)}
                <option value={option.ref}>{option.label}</option>
              {/each}
            </optgroup>
            <optgroup label={t('contacts.engineGroupAgents')}>
              {#each agentOptions as option (option.id)}
                <option value={`${AGENT_OPTION_PREFIX}${option.id}`}>{option.label}</option>
              {/each}
            </optgroup>
          {:else}
            {#each modelOptions as option (option.ref)}
              <option value={option.ref}>{option.label}</option>
            {/each}
          {/if}
        </select>
        {#if profile.runtime.agent.id.length > 0}
          <!-- D75 §8.1：runtime.agent 是 Bot 的任务引擎，对话轮固定内置模型 -->
          <p class="text-xs text-muted-foreground" data-testid="bot-agent-task-engine-hint">
            {t('contacts.agentTaskEngineHint')}
          </p>
        {/if}
      </div>
      {#if showLightModel}
        <div class="grid gap-1.5">
          <Label for="bot-light-model">{t('contacts.lightModel')}</Label>
          <select
            id="bot-light-model"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={profile.runtime.light_model}
          >
            <option value="">—</option>
            {#each modelOptions as option (option.ref)}
              <option value={option.ref}>{option.label}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>
    {#if selectedAgentId.length > 0}
      <div
        class="space-y-3 rounded-lg border px-3 py-3"
        data-testid="bot-agent-settings"
        data-settings-anchor="bot-agent"
      >
        <p class="text-xs text-muted-foreground">{t('contacts.agentIsolationNote')}</p>
        <div class="grid gap-4">
          <div class="grid gap-1.5">
            <div class="flex items-center gap-2">
              <Label for="bot-agent-model">{t('contacts.agentModel')}</Label>
              <Button
                size="sm"
                variant="ghost"
                class="ml-auto h-6 px-2 text-xs"
                disabled={optionsBusy}
                onclick={() => void detectAgentOptions()}
                data-testid="bot-agent-model-detect"
              >
                {optionsBusy
                  ? t('contacts.agentOptionsDetecting')
                  : t('contacts.agentOptionsProbe')}
              </Button>
            </div>
            <select
              id="bot-agent-model"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={customModel ? CUSTOM_MODEL : profile.runtime.agent.model}
              onchange={(event) => onModelSelect(event.currentTarget.value)}
              data-testid="bot-agent-model"
            >
              <option value="">
                {agentDefaultModel.length > 0
                  ? t('contacts.agentDefaultWithModel', { model: agentDefaultModel })
                  : t('contacts.agentDefault')}
              </option>
              {#each modelChoices as choice (choice.value)}
                <option value={choice.value}>{choice.name}</option>
              {/each}
              {#if !customModel && profile.runtime.agent.model.length > 0 && !modelChoices.some((choice) => choice.value === profile.runtime.agent.model)}
                <option value={profile.runtime.agent.model}>{profile.runtime.agent.model}</option>
              {/if}
              <option value={CUSTOM_MODEL}>{t('contacts.agentModelCustom')}</option>
            </select>
            {#if customModel}
              <input
                id="bot-agent-model-custom"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                bind:value={profile.runtime.agent.model}
                placeholder={t('contacts.agentModelCustomPlaceholder')}
                data-testid="bot-agent-model-custom"
              />
            {/if}
            <p class="text-xs text-muted-foreground">{t('contacts.agentModelFreeHint')}</p>
          </div>
          {#if effortChoices !== null && effortChoices.length > 0}
            <div class="grid gap-1.5">
              <Label for="bot-agent-effort">{t('contacts.agentEffort')}</Label>
              <select
                id="bot-agent-effort"
                class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                bind:value={profile.runtime.agent.effort}
                data-testid="bot-agent-effort"
              >
                <option value="">{t('contacts.agentDefault')}</option>
                {#each effortChoices as choice (choice.value)}
                  <option value={choice.value}>{choice.name}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div class="grid gap-1.5">
            <Label for="bot-agent-permission">{t('contacts.agentPermission')}</Label>
            <select
              id="bot-agent-permission"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
              bind:value={profile.runtime.agent.permission}
              data-testid="bot-agent-permission"
            >
              <option value="read_only">{t('contacts.agentPermissionReadOnly')}</option>
              <option value="workspace">{t('contacts.agentPermissionWorkspace')}</option>
              <option value="ask">{t('contacts.agentPermissionAsk')}</option>
            </select>
          </div>
        </div>
        {#if agentChoices?.error}
          <p class="text-xs text-destructive">
            {t('contacts.agentOptionsError', { error: agentChoices.error })}
          </p>
        {/if}
        <div class="grid gap-1.5">
          <div class="flex items-center gap-2">
            <Label>{t('contacts.agentCapabilities')}</Label>
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto h-7 px-2 text-xs"
              disabled={profile.runtime.agent.capabilities === null || !capabilitiesReady}
              onclick={() => (profile.runtime.agent.capabilities = null)}
              data-testid="bot-agent-capabilities-reset"
            >
              {t('contacts.agentCapabilitiesReset')}
            </Button>
          </div>
          <div class="space-y-1.5" data-testid="bot-agent-capabilities">
            {#each capabilityList as row (row.id)}
              <label class="flex items-start gap-2 text-sm" class:opacity-60={row.required}>
                <Checkbox
                  checked={row.checked}
                  disabled={row.required || !capabilitiesReady}
                  onCheckedChange={(checked) => toggleAgentCapability(row.id, checked === true)}
                  data-testid={`bot-agent-capability-${row.id}`}
                />
                <span class="space-y-0.5">
                  <span class="flex flex-wrap items-center gap-1.5">
                    {t(`agents.capabilities.${row.id}.name` as MessageKey)}
                    {#if row.required}
                      <span class="text-xs text-muted-foreground"
                        >{t('common.parenthesized', {
                          text: t('contacts.agentCapabilityRequired'),
                        })}</span
                      >
                    {/if}
                    {#if row.unconfigured}
                      <span class="text-xs text-amber-600 dark:text-amber-400"
                        >{t('common.parenthesized', {
                          text: t('contacts.agentCapabilityUnconfigured'),
                        })}</span
                      >
                    {/if}
                  </span>
                  <span class="block text-xs text-muted-foreground"
                    >{t(`agents.capabilities.${row.id}.description` as MessageKey)}</span
                  >
                  {#if row.nativeTools.length > 0}
                    <span class="block text-xs text-muted-foreground"
                      >{t('contacts.agentCapabilityNative')}{t('common.parenthesized', {
                        text: row.nativeTools.join(listSeparator()),
                      })}</span
                    >
                  {/if}
                </span>
              </label>
              {#if row.checked}
                {#each row.optIns as optIn (optIn.id)}
                  <!-- 包内单独开关（默认关闭，按 Bot 开启）：缩进挂在所属包下面 -->
                  <label class="ml-6 flex items-start gap-2 text-sm">
                    <Checkbox
                      checked={optIn.checked}
                      disabled={!capabilitiesReady}
                      onCheckedChange={(checked) =>
                        toggleAgentCapabilityOptIn(optIn.id, checked === true)}
                      data-testid={`bot-agent-capability-opt-in-${optIn.id.replace(':', '-')}`}
                    />
                    <span class="space-y-0.5">
                      <span class="block">{t(`${optIn.i18nKey}.name` as MessageKey)}</span>
                      <span class="block text-xs text-muted-foreground"
                        >{t(`${optIn.i18nKey}.description` as MessageKey)}</span
                      >
                    </span>
                  </label>
                {/each}
              {/if}
            {/each}
          </div>
          <p class="text-xs text-muted-foreground" data-testid="bot-agent-tool-count">
            {toolEstimate.mcp && profile.runtime.mcp_server_ids.length > 0
              ? t('contacts.agentToolCountMcp', { count: toolEstimate.count })
              : t('contacts.agentToolCount', { count: toolEstimate.count })}
            {#if capabilityList.some((row) => row.id === 'apps' && row.checked) && selectedAppConnections.length > 0}
              <span data-testid="bot-apps-agent-tool-count" data-count={appTools.count}>
                {appTools.unknown
                  ? t('contacts.appsAgentToolCountUnknown', { count: appTools.count })
                  : t('contacts.appsAgentToolCount', { count: appTools.count })}
              </span>
            {/if}
          </p>
          <p class="text-xs text-muted-foreground">{t('contacts.agentCapabilitiesHint')}</p>
        </div>
      </div>
    {/if}
  {/if}
  <!-- MCP 服务器 -->
  {#if show('mcp') && mcpOptions.length > 0}
    <div class="grid gap-1.5" data-settings-anchor="bot-mcp">
      <Label>{t('contacts.mcpServers')}</Label>
      <div class="space-y-1.5" data-testid="bot-mcp-servers">
        {#each mcpOptions as server (server.id)}
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={profile.runtime.mcp_server_ids.includes(server.id)}
              onCheckedChange={(checked) => toggleMcpServer(server.id, checked === true)}
              data-testid={`bot-mcp-${server.id}`}
            />
            {server.name}
            {#if server.autoApprove}
              <span class="text-xs text-muted-foreground">({t('contacts.mcpAutoApproveTag')})</span>
            {/if}
          </label>
        {/each}
      </div>
      <p class="text-xs text-muted-foreground">{t('contacts.mcpServersHint')}</p>
      {#if mcpNotice.show}
        <p
          class={mcpNotice.warning
            ? 'rounded bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400'
            : 'text-xs text-amber-700 dark:text-amber-400'}
          data-testid="bot-mcp-unattended-notice"
          data-warning={mcpNotice.warning}
        >
          {t('contacts.mcpUnattendedNotice')}
          {#if mcpNotice.unknown}
            {t('contacts.mcpUnattendedUnknown')}
          {:else if mcpNotice.warning}
            {t('contacts.mcpUnattendedActive', { count: mcpNotice.riskyCount })}
          {/if}
        </p>
      {/if}
    </div>
  {/if}
  {#if show('apps')}
    <!-- D73 §5.7 / §5.9：只列 Bot 在用的应用；「+」选择器挑应用与账号，行内可移除。
         未连接 / 未使用的应用不直接展示（选择器只列有账号的，其余去扩展中心连接）。 -->
    <div class="grid gap-1.5" data-settings-anchor="bot-apps">
      <div class="flex items-center gap-2">
        <Label>{t('contacts.apps')}</Label>
        <Button
          size="sm"
          variant="ghost"
          class="ml-auto h-7 gap-1 px-2 text-xs"
          onclick={openAppsPicker}
          data-testid="bot-apps-add"
        >
          <Plus class="size-3.5" aria-hidden="true" />
          {t('rightPanel.appsAdd')}
        </Button>
      </div>
      <div class="space-y-2" data-testid="bot-apps">
        {#if usedAppGroups.length === 0}
          <p class="text-xs text-muted-foreground" data-testid="bot-apps-empty">
            {t('rightPanel.appsUsedEmpty')}
          </p>
        {/if}
        {#each usedAppGroups as group (group.connectorId)}
          {@const icon = appIconSrc(group.iconDataUri)}
          {@const account =
            group.accounts.find((entry) => entry.connection.id === group.selectedConnectionId) ??
            null}
          <div
            class="rounded-lg border px-2.5 py-2"
            data-testid={`bot-apps-${group.connectorId}`}
            data-selected={group.selectedConnectionId ?? ''}
          >
            <div class="flex items-center gap-2">
              {#if icon !== null}
                <img src={icon} alt="" class="size-5 shrink-0 rounded" aria-hidden="true" />
              {:else}
                <span
                  class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground"
                  aria-hidden="true">{appInitial(group.title)}</span
                >
              {/if}
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{group.title}</span>
                {#if account !== null}
                  <span class="block truncate text-xs text-muted-foreground">{account.label}</span>
                {/if}
              </span>
              {#if account !== null && account.connection.status !== 'connected'}
                <span
                  class={account.needsReconnect || account.connection.status === 'error'
                    ? 'rounded border border-amber-500/60 px-1 text-[10px] text-amber-700 dark:text-amber-400'
                    : 'rounded border px-1 text-[10px] text-muted-foreground'}
                  data-status={account.connection.status}
                  >{t(CONNECTION_STATUS_LABEL_KEYS[account.connection.status])}</span
                >
              {/if}
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                title={t('rightPanel.appsRemove')}
                onclick={() => removeApp(group.connectorId)}
                data-testid={`bot-apps-${group.connectorId}-remove`}
              >
                <X class="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            {#if account !== null && accountHintKey(account.connection.status) !== null}
              <p
                class="mt-1 text-xs text-amber-700 dark:text-amber-400"
                data-testid={`bot-apps-${group.connectorId}-hint`}
              >
                {t(accountHintKey(account.connection.status)!)}
              </p>
            {/if}
          </div>
        {/each}
      </div>
      <p class="text-xs text-muted-foreground">{t('contacts.appsHint')}</p>
      {#if selectedAppConnections.length > 0}
        <p
          class="text-xs text-muted-foreground"
          data-testid="bot-apps-tool-count"
          data-count={appTools.count}
          data-unknown={appTools.unknown}
        >
          {appTools.unknown
            ? t('contacts.appsToolCountUnknown', { count: appTools.count })
            : t('contacts.appsToolCount', { count: appTools.count })}
        </p>
      {/if}
      {#if appNotice.show}
        <p
          class={appNotice.warning
            ? 'rounded bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400'
            : 'text-xs text-amber-700 dark:text-amber-400'}
          data-testid="bot-apps-unattended-notice"
          data-warning={appNotice.warning}
        >
          {t('contacts.appsUnattendedNotice')}
          {#if appNotice.warning}
            {t('contacts.appsUnattendedActive')}
            {#if appTools.unknown}
              {t('contacts.appsUnattendedUnknown')}
            {:else if appTools.risky > 0}
              {t('contacts.appsUnattendedRisky', { count: appTools.risky })}
            {/if}
          {/if}
        </p>
      {/if}
    </div>
  {/if}
  {#if show('inkcop') && inkcopCollabOn}
    <div class="space-y-2" data-testid="bot-inkcop-agents" data-settings-anchor="bot-inkcop-agents">
      <div class="flex items-center justify-between gap-2">
        <Label>{t('contacts.inkcopAgents')}</Label>
        <Button
          size="sm"
          variant="ghost"
          disabled={inkcopAgentsLoading}
          onclick={() => void refreshInkcopAgents()}
          data-testid="bot-inkcop-agents-refresh"
        >
          {t('contacts.inkcopAgentsRefresh')}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">{t('contacts.inkcopAgentsHint')}</p>
      {#if inkcopAgentsLoading}
        <p class="text-xs text-muted-foreground" data-testid="bot-inkcop-agents-loading">
          {t('contacts.inkcopAgentsLoading')}
        </p>
      {:else if inkcopAgentsOnline === false}
        <p
          class="text-xs text-amber-700 dark:text-amber-400"
          data-testid="bot-inkcop-agents-offline"
        >
          {inkcopAgentsTip ?? t('contacts.inkcopAgentsOffline')}
        </p>
      {:else if inkcopAgents.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="bot-inkcop-agents-empty">
          {inkcopAgentsTip ?? t('contacts.inkcopAgentsEmpty')}
        </p>
      {:else}
        <div class="space-y-1.5" data-testid="bot-inkcop-agents-list">
          {#each inkcopAgents as agent (agent.key)}
            <label
              class="flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm"
              data-testid={`bot-inkcop-agent-${agent.key}`}
            >
              <Checkbox
                checked={inkcopAgentChecked(agent.key)}
                onCheckedChange={(checked) => toggleInkcopAgent(agent.key, checked === true)}
                data-testid={`bot-inkcop-agent-check-${agent.key}`}
              />
              <span class="grid min-w-0 gap-0.5">
                <span class="font-medium">{agent.name}</span>
                <span class="text-[11px] text-muted-foreground">
                  {agent.kind === 'main'
                    ? t('contacts.inkcopAgentKindMain')
                    : t('contacts.inkcopAgentKindApp')}
                  · {agent.key}
                </span>
                {#if agent.description}
                  <span class="line-clamp-3 text-[11px] text-muted-foreground"
                    >{agent.description}</span
                  >
                {/if}
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if show('mail')}
    <BotMailBindings {botId} />
  {/if}
</div>

<!-- 「添加应用」选择器：只列有已连接账号的应用；多账号展开挑账号，选中即用并关闭。
     未连接的应用不在这里出现——去扩展中心连接后再选。 -->
<Dialog bind:open={appsPickerOpen}>
  <DialogContent class="max-w-md" data-testid="bot-apps-picker">
    <DialogHeader>
      <DialogTitle>{t('rightPanel.appsPickerTitle')}</DialogTitle>
      <DialogDescription>{t('rightPanel.appsPickerHint')}</DialogDescription>
    </DialogHeader>
    <div class="max-h-80 space-y-1.5 overflow-y-auto" data-testid="bot-apps-picker-list">
      {#each addableAppGroups as group (group.connectorId)}
        {@const icon = appIconSrc(group.iconDataUri)}
        {@const expanded =
          group.accounts.length === 1 || expandedPickerApps.includes(group.connectorId)}
        <div class="rounded-md border" data-testid={`bot-apps-picker-${group.connectorId}`}>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent/60"
            onclick={() =>
              group.accounts.length === 1
                ? pickAppAccount(group.connectorId, group.accounts[0]!.connection.id)
                : togglePickerApp(group.connectorId)}
          >
            {#if icon !== null}
              <img src={icon} alt="" class="size-5 shrink-0 rounded" aria-hidden="true" />
            {:else}
              <span
                class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground"
                aria-hidden="true">{appInitial(group.title)}</span
              >
            {/if}
            <span class="min-w-0 flex-1 truncate font-medium">{group.title}</span>
            <span class="shrink-0 text-xs text-muted-foreground">
              {t('rightPanel.appsAccountCount', { count: group.accounts.length })}
            </span>
            {#if group.accounts.length > 1}
              <ChevronDown
                class="size-4 shrink-0 text-muted-foreground transition-transform {expanded
                  ? 'rotate-180'
                  : ''}"
                aria-hidden="true"
              />
            {/if}
          </button>
          {#if expanded && group.accounts.length > 1}
            <div class="space-y-0.5 border-t px-2.5 py-1.5">
              {#each group.accounts as account (account.connection.id)}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent/60"
                  onclick={() => pickAppAccount(group.connectorId, account.connection.id)}
                  data-testid={`bot-apps-${group.connectorId}-${account.connection.id}`}
                >
                  <span class="min-w-0 flex-1 truncate">{account.label}</span>
                  {#if account.connection.status !== 'connected'}
                    <span
                      class={account.needsReconnect || account.connection.status === 'error'
                        ? 'rounded border border-amber-500/60 px-1 text-[10px] text-amber-700 dark:text-amber-400'
                        : 'rounded border px-1 text-[10px] text-muted-foreground'}
                      data-status={account.connection.status}
                      >{t(CONNECTION_STATUS_LABEL_KEYS[account.connection.status])}</span
                    >
                  {/if}
                  {#if account.selected}
                    <span class="shrink-0 text-xs text-muted-foreground">✓</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <p
          class="px-3 py-4 text-center text-xs text-muted-foreground"
          data-testid="bot-apps-picker-empty"
        >
          {t('rightPanel.appsPickerEmpty')}
        </p>
      {/each}
    </div>
    <DialogFooter>
      <Button variant="outline" size="sm" onclick={openCatalog} data-testid="bot-apps-open-catalog">
        {t('rightPanel.appsOpenCatalog')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- §5.10：外部智能体自带的 shell / fetch 不经 KepCup 网关——首次（每台设备一次）说明 -->
<Dialog bind:open={acpNoticeOpen}>
  <DialogContent data-testid="apps-acp-notice">
    <DialogHeader>
      <DialogTitle>{t('apps.acpNotice.title')}</DialogTitle>
      <DialogDescription>{t('apps.acpNotice.intro')}</DialogDescription>
    </DialogHeader>
    <ul class="list-disc space-y-1 pl-5 text-sm">
      <li>{t('apps.acpNotice.gateway')}</li>
      <li>{t('apps.acpNotice.bypass')}</li>
      <li>{t('apps.acpNotice.mitigation')}</li>
    </ul>
    <DialogFooter>
      <Button variant="outline" onclick={declineAcpNotice} data-testid="apps-acp-notice-decline"
        >{t('apps.acpNotice.decline')}</Button
      >
      <Button onclick={confirmAcpNotice} data-testid="apps-acp-notice-confirm"
        >{t('apps.acpNotice.confirm')}</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>

<Dialog bind:open={switchDialogOpen}>
  <DialogContent data-testid="bot-agent-switch-dialog">
    <DialogHeader>
      <DialogTitle>
        {t('contacts.agentSwitchTitle', {
          name: (pendingAgentId !== null ? agentsStore.get(pendingAgentId)?.name : null) ?? '',
        })}
      </DialogTitle>
      <DialogDescription>{t('contacts.agentSwitchIntro')}</DialogDescription>
    </DialogHeader>
    <ul class="list-disc space-y-1 pl-5 text-sm">
      <li>{t('contacts.agentSwitchTools')}</li>
      <li>{t('contacts.agentSwitchPrompt')}</li>
      <li>{t('contacts.agentSwitchFeatures')}</li>
      <li>{t('contacts.agentSwitchHistory')}</li>
      <li>{t('contacts.agentSwitchReads')}</li>
    </ul>
    <DialogFooter>
      <Button
        variant="outline"
        onclick={() => {
          pendingAgentId = null;
          switchDialogOpen = false;
        }}>{t('contacts.agentSwitchCancel')}</Button
      >
      <Button onclick={confirmSwitch} data-testid="bot-agent-switch-confirm"
        >{t('contacts.agentSwitchConfirm')}</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>

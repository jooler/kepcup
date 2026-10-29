<script lang="ts">
  /**
   * Bot 详情「插件」区块（P5 插件实体化）：只列**已添加给该 Bot** 的插件（卡片），
   * 右上角 `+` 打开「添加插件」弹框（已安装插件网格 + 搜索 + 添加到 Bot）；卡片右下角
   * 移除。展开仍承载连接账号 / 邮箱账号 / 手动工具服务的细选——控件从旧 apps / mcp /
   * mail 三区块原样搬入，Bot 私有语义不变。未添加的插件其能力对该 Bot 不可见；
   * InkCop 与智能体引擎不属插件，仍在各自区块。
   */
  import { untrack } from 'svelte';
  import type { AppChoiceGroup } from './bot-apps';
  import type { BotProfile, MailAccount, PluginSummary } from '@kepcup/shared';
  import { ChevronDown, Plus, Search, X } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { t, errorText } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import PluginIcon from '$lib/features/plugins/PluginIcon.svelte';
  import BotMailBindings from '$lib/features/mail/BotMailBindings.svelte';
  import { appIconSrc, appInitial } from '$lib/features/apps/app-catalog';
  import { CONNECTION_STATUS_LABEL_KEYS } from '$lib/features/apps/connect-flow';
  import { appUnattendedNotice, countRiskyTools, mcpUnattendedNotice } from '../approvals/mcp-risk';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import {
    accountHintKey,
    appChoiceGroups,
    appToolEstimate,
    selectAppConnection,
  } from './bot-apps';
  import {
    PLUGIN_KIND_LABEL_KEYS,
    addedPlugins,
    enabledPluginCount,
    manualToolServers,
    matchesPluginQuery,
    pluginKindBadges,
    pluginProvides,
    togglePluginId,
  } from './bot-plugins';

  let {
    profile,
    /** 已有 Bot 时开关走 `plugins.setBotPlugins`；新建（无 id）直接写 profile 草稿。 */
    botId,
    /** 选中连接账号后的钩子：BotProfileForm 用来检查外部智能体 + apps 包的一次性说明。 */
    onConnectionSelected,
  }: {
    profile: BotProfile;
    botId?: string;
    onConnectionSelected?: () => void;
  } = $props();

  $effect(() => {
    plugins.start();
    void plugins.load().catch(() => undefined);
  });
  $effect(() => {
    appsStore.start();
  });

  // --- 「插件已停用」标记的邮件面（P4，P2 遗留②）：本 Bot 绑定的邮箱账号列表 -------
  let mailAccounts = $state<MailAccount[]>([]);
  $effect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const result = (await core.call('mail.accounts.list', undefined)) as {
          accounts: MailAccount[];
        };
        if (!cancelled) mailAccounts = result.accounts;
      } catch {
        // 标记是提示性的：拉不到（如旧端点）不阻塞区块。
      }
    };
    void load();
    return core.onEvent('mail.account_updated', () => {
      void load();
    });
  });

  // --- 启用开关（plugin_ids 整集写入） --------------------------------------
  let saving = $state(false);
  const enabledIds = $derived(new Set(profile.runtime.plugin_ids ?? []));
  /** 这个 Bot 已添加的插件（只列这些；未添加的能力对它不可见）。 */
  const added = $derived(addedPlugins(plugins.plugins, profile.runtime.plugin_ids));

  // --- 添加弹框：已安装插件的卡片网格 + 全宽搜索 ----------------------------
  let addOpen = $state(false);
  let addQuery = $state('');
  const addCandidates = $derived(
    plugins.plugins.filter((plugin) => matchesPluginQuery(plugin, addQuery)),
  );

  function openAddDialog(): void {
    addQuery = '';
    addOpen = true;
  }

  async function addPlugin(plugin: PluginSummary): Promise<void> {
    if (enabledIds.has(plugin.id) || !plugin.enabled) return;
    await togglePlugin(plugin, true);
  }

  async function togglePlugin(plugin: PluginSummary, on: boolean): Promise<void> {
    const next = togglePluginId(profile.runtime.plugin_ids, plugin.id, on);
    if (botId === undefined) {
      // 新建表单还没有 id：启用集随 Profile 一起提交。
      profile.runtime.plugin_ids = next;
      return;
    }
    saving = true;
    try {
      await core.call('plugins.setBotPlugins', { botId, pluginIds: next });
      // core 广播 bots.changed → 右栏重克隆草稿；本地先行对齐，避免回声窗口闪烁。
      profile.runtime.plugin_ids = next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('plugins.toast.failed', { reason: errorText(undefined, message) }));
    } finally {
      saving = false;
    }
  }

  // --- 类别徽标（协议不可见：mcp 显示「工具」，文案键见 bot-plugins.ts） ------

  // --- 展开细选 --------------------------------------------------------------
  let expanded = $state<string[]>([]);

  function toggleExpanded(pluginId: string): void {
    expanded = expanded.includes(pluginId)
      ? expanded.filter((id) => id !== pluginId)
      : [...expanded, pluginId];
  }

  // 停用插件时收起它的细选（「仅启用时可见」）。
  $effect(() => {
    const enabled = enabledIds;
    const open = untrack(() => expanded);
    const next = open.filter((id) => enabled.has(id));
    if (next.length !== open.length) expanded = next;
  });

  // --- 连接账号（现 bot-apps 控件，按插件归属分组） ---------------------------
  const appGroups = $derived(
    appChoiceGroups(appsStore.catalog, appsStore.connections, profile.runtime.app_connection_ids),
  );
  /** 连接器目录条目的来源插件 id（目录条目携带；本机自建 / 残留为 null）。 */
  function groupPluginId(group: AppChoiceGroup): string | null {
    return (
      appsStore.catalog.find((entry) => entry.connectorId === group.connectorId)?.pluginId ?? null
    );
  }

  function groupsOf(plugin: PluginSummary): AppChoiceGroup[] {
    return appGroups.filter((group) => groupPluginId(group) === plugin.id);
  }

  /** 本机自建连接（无属主插件）的分组：不受插件启用集约束，独立成组管理。 */
  const localGroups = $derived(appGroups.filter((group) => groupPluginId(group) === null));

  /**
   * Bot 已选用、但属主插件已不在已装清单的账号（插件卸载后残留）：单独列出便于移除。
   * 本机连接（属主为 null）不算残留——它们没有可卸载的插件。
   */
  const orphanGroups = $derived(
    appGroups.filter((group) => {
      const owner = groupPluginId(group);
      return owner !== null && group.selectedConnectionId !== null && !plugins.has(owner);
    }),
  );

  /** 属主插件已停用（或插件行上已勾账号但插件未启用）→ 行上标「插件已停用」。 */
  function pluginDisabledWithAccounts(plugin: PluginSummary): boolean {
    if (plugin.enabled && enabledIds.has(plugin.id)) return false;
    const hasConnections = groupsOf(plugin).some((group) => group.selectedConnectionId !== null);
    // P4（P2 遗留②复核）：邮件实例账号一并计入——绑定给本 Bot、属主是该插件的账号，
    // 插件未启用时对该 Bot 不可见（core 装配层同口径），提示标记覆盖到邮件。
    const hasMail =
      botId !== undefined &&
      mailAccounts.some(
        (account) => account.botIds.includes(botId) && account.pluginId === plugin.id,
      );
    return hasConnections || hasMail;
  }

  const selectedAppConnections = $derived(
    appsStore.connections.filter((connection) =>
      profile.runtime.app_connection_ids.includes(connection.id),
    ),
  );
  // 拉所选连接的工具清单——查询会连到服务端，所以只在选中集合（id）变化、或缓存被清
  // （`invalidateTools`：状态推送 / 连接完成）时重拉。已缓存的不会重复拉、失败的不会循环。
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
    if (connectionId !== null) onConnectionSelected?.();
  }

  function removeApp(connectorId: string): void {
    selectApp(connectorId, null);
  }

  /** 账号选择器（从旧 apps 区块搬入）：只列有已连接账号的应用，多账号展开挑。 */
  let pickerTitle = $state('');
  let pickerOpen = $state(false);
  let pickerGroups = $state<AppChoiceGroup[]>([]);
  let expandedPickerApps = $state<string[]>([]);

  function openAppsPicker(plugin: PluginSummary): void {
    pickerGroups = groupsOf(plugin).filter((group) => group.accounts.length > 0);
    expandedPickerApps = [];
    pickerTitle = plugin.name;
    pickerOpen = true;
  }

  function openLocalAppsPicker(): void {
    pickerGroups = localGroups.filter((group) => group.accounts.length > 0);
    expandedPickerApps = [];
    pickerTitle = t('botPanel.plugins.localAccounts');
    pickerOpen = true;
  }

  function togglePickerApp(connectorId: string): void {
    expandedPickerApps = expandedPickerApps.includes(connectorId)
      ? expandedPickerApps.filter((id) => id !== connectorId)
      : [...expandedPickerApps, connectorId];
  }

  function pickAppAccount(connectorId: string, connectionId: string): void {
    selectApp(connectorId, connectionId);
    pickerOpen = false;
    expandedPickerApps = [];
  }

  // --- 手动工具服务（现 bot-mcp 控件，仅手动 server） -------------------------
  // 插件贡献的 server 随插件启用集自动可用（P2 §3.3）；这里只保留手动 / mcpb
  // 独立安装的 server 的 `mcp_server_ids` 细选。
  const mcpOptions = $derived(manualToolServers(settingsStore.settings?.mcpServers ?? []));
  const selectedMcpServers = $derived(
    mcpOptions.filter((server) => profile.runtime.mcp_server_ids.includes(server.id)),
  );
  let mcpRiskyCount = $state<number | null>(null);
  let mcpRiskUnknown = $state(false);
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

  function toggleMcpServer(id: string, checked: boolean): void {
    const selected = profile.runtime.mcp_server_ids.filter((entry) => entry !== id);
    profile.runtime.mcp_server_ids = checked ? [...selected, id] : selected;
  }

  // --- 邮箱（现 BotMailBindings 控件）：邮件插件展开区承载；还没有邮件插件时，
  //     只有存量「系统账号」（无属主插件）才单独列出，避免空白邮箱段干扰插件列表。
  const mailPlugins = $derived(plugins.plugins.filter((plugin) => pluginProvides(plugin, 'mail')));
  const legacyMailAccounts = $derived(mailAccounts.filter((account) => account.pluginId === null));

  function openStore(): void {
    shell.openExtensionCenter('market');
  }

  function openCatalog(): void {
    shell.openExtensionCenter('connections');
  }

  const enabledSummary = $derived(enabledPluginCount(profile.runtime.plugin_ids, plugins.plugins));
</script>

<div class="space-y-2" data-testid="bot-plugins" data-settings-anchor="bot-plugins">
  <!-- 旧区块（应用 / MCP 服务器）深链锚点的别名落点：shared settings-catalog 的
       bot.apps / bot.mcp-servers 条目仍指向它们，收编后统一落到「插件」区块顶部。 -->
  <div class="hidden" data-settings-anchor="bot-apps"></div>
  <div class="hidden" data-settings-anchor="bot-mcp"></div>

  <div class="flex items-center gap-2">
    <Label>{t('botPanel.sections.plugins')}</Label>
    <span class="text-xs text-muted-foreground">
      {enabledSummary > 0
        ? t('botPanel.plugins.summaryEnabled', { count: enabledSummary })
        : t('botPanel.plugins.summaryNone')}
    </span>
    <Button
      size="icon"
      variant="ghost"
      class="ml-auto size-7 shrink-0 text-muted-foreground"
      title={t('botPanel.plugins.add')}
      aria-label={t('botPanel.plugins.add')}
      disabled={plugins.loading}
      onclick={openAddDialog}
      data-testid="bot-plugins-add"
    >
      <Plus class="size-4" aria-hidden="true" />
    </Button>
  </div>
  <p class="text-xs text-muted-foreground">{t('botPanel.plugins.hint')}</p>

  {#if plugins.loadError !== null}
    <p class="text-xs text-destructive" data-testid="bot-plugins-error">
      {t('plugins.loadFailed', { reason: plugins.loadError })}
    </p>
  {:else if plugins.plugins.length === 0 && !plugins.loading}
    <div class="flex items-center gap-2">
      <p class="min-w-0 flex-1 text-xs text-muted-foreground" data-testid="bot-plugins-empty">
        {t('botPanel.plugins.empty')}
      </p>
      <Button
        size="sm"
        variant="ghost"
        class="h-7 shrink-0 px-2 text-xs"
        onclick={openStore}
        data-testid="bot-plugins-open-store"
      >
        {t('botPanel.plugins.openStore')}
      </Button>
    </div>
  {:else if added.length === 0}
    <div
      class="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5"
      data-testid="bot-plugins-none-added"
    >
      <p class="min-w-0 flex-1 text-xs text-muted-foreground">
        {t('botPanel.plugins.noneAdded')}
      </p>
      <Button
        size="sm"
        variant="secondary"
        class="h-7 shrink-0 gap-1 px-2 text-xs"
        onclick={openAddDialog}
        data-testid="bot-plugins-add-empty"
      >
        <Plus class="size-3.5" aria-hidden="true" />
        {t('botPanel.plugins.add')}
      </Button>
    </div>
  {:else}
    <div class="space-y-1.5">
      {#each added as plugin (plugin.id)}
        {@const kinds = pluginKindBadges(plugin)}
        {@const expandable = groupsOf(plugin).length > 0 || pluginProvides(plugin, 'mail')}
        <div
          class="rounded-lg border px-2.5 py-2"
          data-testid={`bot-plugins-${plugin.id}`}
          data-enabled="true"
        >
          <div class="flex items-start gap-2">
            <PluginIcon src={plugin.iconDataUri} label={plugin.name} class="size-8" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <span class="min-w-0 truncate text-sm font-medium">{plugin.name}</span>
                {#each kinds as kind (kind)}
                  <Badge
                    variant="secondary"
                    data-testid={`bot-plugins-kind-${kind}-${plugin.id}`}
                  >
                    {t(PLUGIN_KIND_LABEL_KEYS[kind])}
                  </Badge>
                {/each}
              </div>
              {#if plugin.description.length > 0}
                <p class="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {plugin.description}
                </p>
              {/if}
              {#if !plugin.enabled}
                <p
                  class="mt-0.5 text-xs text-muted-foreground"
                  data-testid={`bot-plugins-app-disabled-${plugin.id}`}
                >
                  {t('botPanel.plugins.appDisabled')}
                </p>
              {/if}
              {#if pluginDisabledWithAccounts(plugin)}
                <p
                  class="mt-0.5 text-xs text-muted-foreground"
                  data-testid={`bot-plugins-plugin-disabled-${plugin.id}`}
                >
                  {t('botPanel.plugins.pluginDisabled')}
                </p>
              {/if}
            </div>
            {#if expandable}
              <Button
                variant="ghost"
                size="icon"
                class="size-7 shrink-0 text-muted-foreground"
                title={t('botPanel.plugins.detail')}
                aria-label={t('botPanel.plugins.detail')}
                onclick={() => toggleExpanded(plugin.id)}
                data-testid={`bot-plugins-expand-${plugin.id}`}
              >
                <ChevronDown
                  class="size-4 transition-transform {expanded.includes(plugin.id)
                    ? 'rotate-180'
                    : ''}"
                  aria-hidden="true"
                />
              </Button>
            {/if}
          </div>

          {#if expanded.includes(plugin.id)}
            <div
              class="mt-2 space-y-2 border-t pt-2"
              data-testid={`bot-plugins-detail-${plugin.id}`}
            >
              {#if groupsOf(plugin).length > 0}
                <div class="flex items-center gap-2">
                  <Label class="text-xs">{t('botPanel.plugins.connections')}</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    class="ml-auto h-7 gap-1 px-2 text-xs"
                    onclick={() => openAppsPicker(plugin)}
                    data-testid={`bot-plugins-add-${plugin.id}`}
                  >
                    <Plus class="size-3.5" aria-hidden="true" />
                    {t('rightPanel.appsAdd')}
                  </Button>
                </div>
                <div class="space-y-2" data-testid={`bot-plugins-connections-${plugin.id}`}>
                  {#each groupsOf(plugin) as group (group.connectorId)}
                    {@const showGroup =
                      group.selectedConnectionId !== null || group.accounts.length > 0}
                    {#if showGroup}
                      {@const icon = appIconSrc(group.iconDataUri)}
                      {@const account =
                        group.accounts.find(
                          (entry) => entry.connection.id === group.selectedConnectionId,
                        ) ?? null}
                      <div
                        class="rounded-lg border px-2.5 py-2"
                        data-testid={`bot-apps-${group.connectorId}`}
                        data-selected={group.selectedConnectionId ?? ''}
                      >
                        <div class="flex items-center gap-2">
                          {#if icon !== null}
                            <img
                              src={icon}
                              alt=""
                              class="size-5 shrink-0 rounded"
                              aria-hidden="true"
                            />
                          {:else}
                            <span
                              class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground"
                              aria-hidden="true">{appInitial(group.title)}</span
                            >
                          {/if}
                          <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm font-medium">{group.title}</span>
                            {#if account !== null}
                              <span class="block truncate text-xs text-muted-foreground"
                                >{account.label}</span
                              >
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
                    {/if}
                  {/each}
                </div>
                <p class="text-xs text-muted-foreground">{t('contacts.appsHint')}</p>
              {/if}
              {#if pluginProvides(plugin, 'mail')}
                <BotMailBindings {botId} />
              {/if}
              {#if plugin.counts.mcp > 0}
                <p
                  class="text-xs text-muted-foreground"
                  data-testid={`bot-plugins-auto-${plugin.id}`}
                >
                  {t('botPanel.plugins.serversAuto')}
                </p>
              {/if}
            </div>
          {/if}

          <div class="mt-1.5 flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              disabled={saving}
              onclick={() => void togglePlugin(plugin, false)}
              data-testid={`bot-plugins-remove-${plugin.id}`}
            >
              {t('botPanel.plugins.remove')}
            </Button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  {#if localGroups.some((group) => group.accounts.length > 0)}
    <!-- 本机自建连接的账号：不属于任何插件，独立成组（沿用旧 apps 区块的全局选择器语义）。 -->
    <div class="space-y-1.5" data-testid="bot-plugins-local-accounts">
      <div class="flex items-center gap-2">
        <Label class="text-xs">{t('botPanel.plugins.localAccounts')}</Label>
        <Button
          size="sm"
          variant="ghost"
          class="ml-auto h-7 gap-1 px-2 text-xs"
          onclick={openLocalAppsPicker}
          data-testid="bot-plugins-add-local"
        >
          <Plus class="size-3.5" aria-hidden="true" />
          {t('rightPanel.appsAdd')}
        </Button>
      </div>
      <div class="space-y-2">
        {#each localGroups as group (group.connectorId)}
          {#if group.selectedConnectionId !== null || group.accounts.length > 0}
            <div class="flex items-center gap-2 text-sm" data-testid={`bot-apps-${group.connectorId}`}>
              <span class="min-w-0 flex-1 truncate">{group.title}</span>
              {#if group.selectedConnectionId !== null}
                <span class="text-xs text-muted-foreground">
                  · {group.accounts.find((entry) => entry.connection.id === group.selectedConnectionId)?.label ?? ''}
                </span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    </div>
  {/if}

  {#if orphanGroups.length > 0}
    <!-- 插件卸载后残留的已选账号：不再归属任何已装插件，列出便于移除。 -->
    <div class="space-y-1.5" data-testid="bot-plugins-orphans">
      <Label class="text-xs">{t('botPanel.plugins.otherAccounts')}</Label>
      {#each orphanGroups as group (group.connectorId)}
        {@const account =
          group.accounts.find((entry) => entry.connection.id === group.selectedConnectionId) ??
          null}
        <div class="flex items-center gap-2 text-sm" data-testid={`bot-apps-${group.connectorId}`}>
          <span class="min-w-0 flex-1 truncate">
            {group.title}
            {#if account !== null}
              <span class="text-xs text-muted-foreground">· {account.label}</span>
            {/if}
          </span>
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
      {/each}
    </div>
  {/if}

  <!-- 手动工具服务（现 bot-mcp 控件，仅手动 server；插件 server 随插件启用自动可用） -->
  {#if mcpOptions.length > 0}
    <div class="grid gap-1.5" data-testid="bot-mcp-servers">
      <Label>{t('botPanel.plugins.manualServers')}</Label>
      <div class="space-y-1.5">
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
      <p class="text-xs text-muted-foreground">{t('botPanel.plugins.manualServersHint')}</p>
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

  {#if mailPlugins.length === 0 && legacyMailAccounts.length > 0}
    <!-- 还没有邮件插件：存量系统账号按系统账号放行（P2 §3.5），勾选控件保持可用。 -->
    <BotMailBindings {botId} />
  {/if}

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

<!-- 添加插件弹框：已安装插件的卡片网格 + 全宽搜索；添加是幂等的（已添加显示绿色状态）。 -->
<Dialog
  open={addOpen}
  onOpenChange={(next) => {
    if (!next) addOpen = false;
  }}
>
  <DialogContent class="sm:max-w-2xl" data-testid="bot-plugins-add-dialog">
    <DialogHeader>
      <DialogTitle>{t('botPanel.plugins.addTitle')}</DialogTitle>
      <DialogDescription>{t('botPanel.plugins.addHint')}</DialogDescription>
    </DialogHeader>
    <div class="relative">
      <Search
        class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        class="h-9 w-full pl-8"
        placeholder={t('botPanel.plugins.search')}
        bind:value={addQuery}
        data-testid="bot-plugins-add-search"
      />
    </div>
    <div class="max-h-[min(60vh,32rem)] overflow-y-auto pr-1" data-testid="bot-plugins-add-list">
      {#if plugins.plugins.length === 0}
        <p class="px-1 py-4 text-center text-xs text-muted-foreground">
          {t('botPanel.plugins.addDialogEmptyStore')}
        </p>
      {:else if addCandidates.length === 0}
        <p
          class="px-1 py-4 text-center text-xs text-muted-foreground"
          data-testid="bot-plugins-add-no-match"
        >
          {t('botPanel.plugins.noMatch')}
        </p>
      {:else}
        <div class="grid gap-2 sm:grid-cols-2">
          {#each addCandidates as plugin (plugin.id)}
            {@const isAdded = enabledIds.has(plugin.id)}
            {@const kinds = pluginKindBadges(plugin)}
            <div
              class="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3"
              data-testid={`bot-plugins-add-card-${plugin.id}`}
              data-added={isAdded}
            >
              <div class="flex items-start gap-2.5">
                <PluginIcon src={plugin.iconDataUri} label={plugin.name} class="size-9" />
                <div class="min-w-0 flex-1">
                  <div class="truncate text-sm font-medium" title={plugin.name}>{plugin.name}</div>
                  <div class="mt-1 flex flex-wrap items-center gap-1">
                    {#each kinds as kind (kind)}
                      <Badge variant="outline" class="text-[10px]">
                        {t(PLUGIN_KIND_LABEL_KEYS[kind])}
                      </Badge>
                    {/each}
                  </div>
                </div>
              </div>
              {#if plugin.description.length > 0}
                <p class="line-clamp-2 text-xs break-words text-muted-foreground">
                  {plugin.description}
                </p>
              {/if}
              {#if !plugin.enabled}
                <p class="text-xs text-amber-700 dark:text-amber-400">
                  {t('botPanel.plugins.appDisabled')}
                </p>
              {/if}
              <div class="mt-auto flex justify-end pt-0.5">
                <Button
                  size="sm"
                  variant={isAdded ? 'default' : 'secondary'}
                  class={isAdded
                    ? 'bg-emerald-600 text-white hover:bg-emerald-600 disabled:opacity-100 dark:bg-emerald-600'
                    : ''}
                  disabled={isAdded || !plugin.enabled || saving}
                  onclick={() => void addPlugin(plugin)}
                  data-testid={`bot-plugins-add-to-bot-${plugin.id}`}
                >
                  {isAdded
                    ? t('botPanel.plugins.addedToBot')
                    : !plugin.enabled
                      ? t('botPanel.plugins.globallyDisabled')
                      : t('botPanel.plugins.addToBot')}
                </Button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <DialogFooter class="justify-between sm:justify-between">
      <Button variant="outline" size="sm" onclick={openStore} data-testid="bot-plugins-add-store">
        {t('botPanel.plugins.openStore')}
      </Button>
      <Button size="sm" onclick={() => (addOpen = false)} data-testid="bot-plugins-add-done">
        {t('botPanel.plugins.done')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>

<!-- 「添加账号」选择器（从旧 apps 区块搬入，限定在该插件的连接器里）：
     只列有已连接账号的应用；多账号展开挑账号，选中即用并关闭。 -->
<Dialog open={pickerOpen} onOpenChange={(next) => !next && (pickerOpen = false)}>
  <DialogContent class="max-w-md" data-testid="bot-apps-picker">
    <DialogHeader>
      <DialogTitle>{t('rightPanel.appsPickerTitle')} · {pickerTitle}</DialogTitle>
      <DialogDescription>{t('rightPanel.appsPickerHint')}</DialogDescription>
    </DialogHeader>
    <div class="max-h-80 space-y-1.5 overflow-y-auto" data-testid="bot-apps-picker-list">
      {#each pickerGroups as group (group.connectorId)}
        {@const icon = appIconSrc(group.iconDataUri)}
        {@const expandedPicker =
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
                class="size-4 shrink-0 text-muted-foreground transition-transform {expandedPicker
                  ? 'rotate-180'
                  : ''}"
                aria-hidden="true"
              />
            {/if}
          </button>
          {#if expandedPicker && group.accounts.length > 1}
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

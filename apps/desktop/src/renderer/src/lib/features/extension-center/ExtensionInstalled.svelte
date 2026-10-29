<script lang="ts">
  import type { PluginSummary } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { ArrowLeft, ChevronDown, Ellipsis } from '@lucide/svelte';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { endpointSupports } from '../web-shell/endpoint';
  import { shell } from '$lib/stores/shell.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { plugins } from '../plugins/plugins.svelte';
  import ExtensionConnections from './ExtensionConnections.svelte';
  import ExtensionMcp from './ExtensionMcp.svelte';
  import ExtensionMail from './ExtensionMail.svelte';
  import ExtensionLocalCollab from './ExtensionLocalCollab.svelte';
  import LocalConnectorsSection from './LocalConnectorsSection.svelte';
  import AppConnectionsList from '$lib/features/apps/AppConnectionsList.svelte';
  import AppConnectionDetail from '$lib/features/apps/AppConnectionDetail.svelte';
  import ConnectAppPanel from '$lib/features/apps/ConnectAppPanel.svelte';
  import { isCustomConnection } from '$lib/features/apps/app-catalog';
  import McpSection from '$lib/features/settings/McpSection.svelte';
  import {
    FILTER_COUNT_KEYS,
    type ExtensionCenterFilter,
    type ExtensionCenterKindFilter,
  } from './tabs';
  import PluginInstallDialog from '../plugins/PluginInstallDialog.svelte';
  import PluginFieldForm from '../plugins/PluginFieldForm.svelte';
  import PluginIcon from '../plugins/PluginIcon.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 扩展中心 →「已安装」分组（D104 P0a-3；插件列表模型）：
   *
   * - 已安装 = **一张插件卡片网格**（core 只有一张插件注册表；技能 / 连接 / MCP / 邮件
   *   是插件的贡献类别，投影到各领域存储）。顶部筛选只过滤这张网格；「全部」显示全部
   *   插件，不按内容类型拆分列表。
   * - 每张卡片：名称 / 版本 / 来源徽标 / 描述 + 类别标签；操作收进右上角 ⋮ 菜单
   *   （启停 / 打开所在目录 / 更新 / 重新安装 / 卸载）；底部按贡献类别给「管理」入口：
   *   单连接插件**直达账号管理流**（1 个账号 = 详情，多个 = 账号列表，0 个 = 首连面板，
   *   不再经过应用卡网格），多连接插件进按插件圈定的目录网格，MCP / 邮箱进对应管理区——
   *   扩展中心只做管理与展示，不入侵插件自身逻辑。
   * - 页头的本地安装入口仅在桌面端点渲染；内置插件只读，不出操作菜单；
   *   被吊销的插件在页顶统一警告；「由插件管理」的锁定语义在 core 层（PLUGIN_MANAGED）。
   */

  $effect(() => {
    plugins.start();
    void plugins.load(true);
  });

  let installOpen = $state(false);
  let installMode = $state<'file' | 'folder' | 'marketplace'>('file');
  /** market 模式的目标插件（更新 / 重新安装）；file / folder 模式为 undefined。 */
  let installTarget = $state<{ id: string; version?: string } | undefined>(undefined);
  let checking = $state(false);
  let updatingAll = $state(false);
  let uninstallTarget = $state<string | null>(null);
  /** 插件卡片「管理」进入的内容管理视图；null = 插件网格。 */
  let contentView = $state<{ kind: 'connector' | 'mcp' | 'mail'; pluginId: string } | null>(null);
  /** 卡片「设置」就地展开的插件 config 表单（声明了 config.fields 的插件）；null = 收起。 */
  let configPanelId = $state<string | null>(null);
  let configValues = $state<Record<string, unknown>>({});
  /** 有存值 secret 的敏感字段键（表单占位「已保存」；core 永不回传敏感明文）。 */
  let configStoredKeys = $state<string[]>([]);
  /** 正在拉取初始值的卡（面板渲染 loading 的依据）；与 configPanelId 分开防并发闪错。 */
  let configLoadingId = $state<string | null>(null);
  let configSaving = $state(false);
  /** 系统卡（本机应用协作 / 本机自建连接）的展开状态；折叠时只显示标题与说明。 */
  let systemLocalCollabOpen = $state(false);
  let systemLocalConnectorsOpen = $state(false);
  /** 账号管理流当前的应用（连接 slug：插件直达与本机自建共用一套组件）。 */
  let managingConnectorId = $state<string | null>(null);
  /** 账号管理流里点开的账号详情；null = 未点开（单账号由流自动直进详情）。 */
  let detailConnectionId = $state<string | null>(null);

  const hasUpdates = $derived(plugins.plugins.some((plugin) => plugin.updateAvailable !== null));

  /** 内容筛选：状态在 shell store（旧分组深链 / 设置卡深链会带筛选直达）。 */
  const filter = $derived(shell.extensionCenterFilter);

  $effect(() => {
    plugins.start();
    appsStore.start();
    void plugins.load(true);
  });

  // 深链 / 手动切换筛选时退出内容管理视图与设置表单，回到插件网格。
  $effect(() => {
    void filter;
    contentView = null;
    managingConnectorId = null;
    detailConnectionId = null;
    closeConfig();
  });

  // localCollab 旧深链：展开并滚动到「本机应用协作」系统卡（shell 深链置位，消费即复位）。
  $effect(() => {
    if (!shell.extensionCenterSystemCardFocus) return;
    untrack(() => {
      shell.extensionCenterSystemCardFocus = false;
      systemLocalCollabOpen = true;
    });
    requestAnimationFrame(() => {
      document
        .getElementById('extension-system-local-collab')
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  });

  const FILTER_CHIPS: ReadonlyArray<{
    id: ExtensionCenterFilter;
    labelKey: Parameters<typeof t>[0];
  }> = [
    { id: 'all', labelKey: 'plugins.filter.all' },
    { id: 'skill', labelKey: 'plugins.kind.skill' },
    { id: 'connector', labelKey: 'plugins.kind.connector' },
    { id: 'mcp', labelKey: 'plugins.kind.mcp' },
    { id: 'mail', labelKey: 'plugins.kind.mail' },
  ];

  /** 各筛选下的插件数量（含「全部」）；为 0 的筛选也显示，点了给空态。 */
  const filterCounts = $derived.by(() => {
    const counts = new Map<ExtensionCenterFilter, number>([['all', plugins.plugins.length]]);
    for (const kind of Object.keys(FILTER_COUNT_KEYS) as ExtensionCenterKindFilter[]) {
      const countKey = FILTER_COUNT_KEYS[kind];
      counts.set(
        kind,
        plugins.plugins.filter((plugin) => matchesKind(plugin, countKey)).length,
      );
    }
    return counts;
  });

  /**
   * 筛选命中口径（D105 P4）：贡献计数之外，`instanceCounts` 也算——纯实例插件
   * （如邮件插件，贡献只是供给规范）加过账号后能被对应类别筛出。
   */
  function matchesKind(
    plugin: PluginSummary,
    countKey: 'skills' | 'connectors' | 'mcp' | 'mail',
  ): boolean {
    if (plugin.counts[countKey] > 0) return true;
    if (countKey === 'mail') return plugin.instanceCounts.mail > 0;
    if (countKey === 'mcp') return plugin.instanceCounts.mcp > 0;
    return false;
  }

  /** 网格里的插件（可更新的恒置顶）：筛选只按贡献类别过滤这一张列表。 */
  const visiblePlugins = $derived.by(() => {
    const sorted = [...plugins.plugins].sort(
      (a, b) => Number(b.updateAvailable !== null) - Number(a.updateAvailable !== null),
    );
    if (filter === 'all') return sorted;
    const countKey = FILTER_COUNT_KEYS[filter];
    return sorted.filter((plugin) => matchesKind(plugin, countKey));
  });

  /** 被市场索引吊销的插件：不论哪种视图都在页顶统一警告。 */
  const revokedPlugins = $derived(plugins.plugins.filter((plugin) => plugin.revoked !== null));

  /** 卡片上的类别标签（非零贡献）。 */
  const KIND_TAG_KEYS = [
    ['skills', 'plugins.kind.skill'],
    ['connectors', 'plugins.kind.connector'],
    ['mcp', 'plugins.kind.mcp'],
    ['mail', 'plugins.kind.mail'],
  ] as const;

  /** 卡片的「管理」入口类别（按连接 → MCP → 邮件排序；纯技能插件没有管理面）。 */
  const MANAGE_KINDS: ReadonlyArray<{
    kind: 'connector' | 'mcp' | 'mail';
    countKey: 'connectors' | 'mcp' | 'mail';
    labelKey: Parameters<typeof t>[0];
  }> = [
    { kind: 'connector', countKey: 'connectors', labelKey: 'plugins.kind.connector' },
    { kind: 'mcp', countKey: 'mcp', labelKey: 'plugins.kind.mcp' },
    { kind: 'mail', countKey: 'mail', labelKey: 'plugins.kind.mail' },
  ];

  function manageKinds(
    plugin: PluginSummary,
  ): Array<{ kind: 'connector' | 'mcp' | 'mail'; labelKey: Parameters<typeof t>[0] }> {
    return MANAGE_KINDS.filter(({ countKey }) => plugin.counts[countKey] > 0).map(
      ({ kind, labelKey }) => ({ kind, labelKey }),
    );
  }

  function openManage(plugin: PluginSummary, kind: 'connector' | 'mcp' | 'mail'): void {
    if (kind === 'connector') {
      // 单连接插件直达账号管理流（账本 ref = 连接 slug = 目录 connectorId），
      // 不再经过应用卡网格；多连接插件回落到按插件圈定的目录网格。
      const refs = [
        ...new Set(
          plugin.items
            .filter((item) => item.kind === 'connector' && item.missing !== true)
            .map((item) => item.ref),
        ),
      ];
      if (refs.length === 1) {
        manage(refs[0]!);
        return;
      }
      if (refs.length === 0) {
        // 内置插件不进账本（items 恒空）：按目录条目的归属插件回退——
        // 恰一个属主连接器时同样直达；目录未加载则先刷新一次再判。
        const decide = (): void => {
          const owned = [
            ...new Set(
              appsStore.catalog
                .filter((entry) => entry.pluginId === plugin.id)
                .map((entry) => entry.connectorId),
            ),
          ];
          if (owned.length === 1) manage(owned[0]!);
          else contentView = { kind, pluginId: plugin.id };
        };
        if (appsStore.catalogLoaded) decide();
        else
          void appsStore
            .refresh()
            .then(decide)
            .catch(() => {
              contentView = { kind, pluginId: plugin.id };
            });
        return;
      }
    }
    contentView = { kind, pluginId: plugin.id };
  }

  // 连接 / 账号在流外被删（卸载插件、删除本机自建、失败的首次连接）后，别停在失效的详情 / 空列表上。
  $effect(() => {
    if (!appsStore.loaded) return;
    const ids = new Set(appsStore.connections.map((connection) => connection.id));
    if (
      untrack(() => detailConnectionId) !== null &&
      !ids.has(untrack(() => detailConnectionId)!)
    ) {
      detailConnectionId = null;
    }
    const connectorId = untrack(() => managingConnectorId);
    // 0 账号的首连面板本身就是「该连接器没有任何连接」——只有当应用里还存在
    // 别的连接（即被删的是这个连接器唯一的那条）时才清管理态，否则首连面板不可达。
    if (
      connectorId !== null &&
      appsStore.connections.length > 0 &&
      !appsStore.connections.some((connection) => connection.connectorId === connectorId)
    ) {
      managingConnectorId = null;
    }
  });

  /**
   * 进入一个连接应用的账号管理流；视图按当前账号数反应式选择——
   * 1 个账号直进详情，多个先列账号，0 个给连接面板（首连）。
   * 插件卡「管理」与本机自建「管理」共用。
   */
  function manage(connectorId: string): void {
    detailConnectionId = null;
    managingConnectorId = connectorId;
  }

  function codeOf(caught: unknown): string | undefined {
    return (caught as { code?: string } | undefined)?.code;
  }

  function reasonOf(caught: unknown): string {
    const message = (caught as Error | undefined)?.message;
    return errorText(
      codeOf(caught),
      message !== undefined && message !== '' ? message : String(caught),
    );
  }

  function openInstall(mode: 'file' | 'folder'): void {
    installMode = mode;
    installTarget = undefined;
    installOpen = true;
  }

  // --- 卡片「设置」（D105 P4）：声明字段 config 的就地展开表单 ------------------

  async function openConfig(plugin: PluginSummary): Promise<void> {
    configPanelId = plugin.id;
    configValues = {};
    configStoredKeys = [];
    configLoadingId = plugin.id;
    try {
      const config = await plugins.loadConfig(plugin.id);
      // 请求在途时用户可能已切到另一张卡：只把结果交给仍是当前卡的面板。
      if (configPanelId === plugin.id) {
        configValues = { ...config.values };
        configStoredKeys = config.storedSensitiveKeys;
      }
    } catch (caught) {
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
      if (configPanelId === plugin.id) configPanelId = null;
    } finally {
      if (configLoadingId === plugin.id) configLoadingId = null;
    }
  }

  function closeConfig(): void {
    configPanelId = null;
    configValues = {};
    configStoredKeys = [];
  }

  async function saveConfig(plugin: PluginSummary): Promise<void> {
    configSaving = true;
    try {
      await plugins.saveConfig(plugin.id, configValues);
      toast.success(t('plugins.config.saved'));
      // 保存在途时用户可能已切到另一张卡：只收起发起保存的那张。
      if (configPanelId === plugin.id) closeConfig();
    } catch (caught) {
      // core 校验（必填 / 类型 / min/max）失败：表单留在原地改。
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
    } finally {
      configSaving = false;
    }
  }

  function openUpdate(plugin: PluginSummary): void {
    installMode = 'marketplace';
    installTarget = { id: plugin.id };
    installOpen = true;
  }

  /** 本地来源的「重新安装」：同 id 重新选包 = 更新流（core 按 id 判定）。 */
  function openReinstall(): void {
    installMode = 'file';
    installTarget = undefined;
    installOpen = true;
  }

  async function checkUpdates(): Promise<void> {
    checking = true;
    try {
      await plugins.refreshMarket();
    } catch (caught) {
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
    } finally {
      checking = false;
    }
  }

  async function updateAll(): Promise<void> {
    updatingAll = true;
    try {
      const result = await plugins.updateAll();
      toast.success(t('plugins.update.allResult', { done: result.done, skipped: result.skipped }));
    } catch (caught) {
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
    } finally {
      updatingAll = false;
    }
  }

  function reveal(plugin: PluginSummary): void {
    if (plugin.dirPath !== null) void window.kepcup.showItemInFolder(plugin.dirPath);
  }

  async function toggle(plugin: PluginSummary, next: boolean): Promise<void> {
    try {
      await plugins.setEnabled(plugin.id, next);
      toast.success(
        t(next ? 'plugins.toast.enabled' : 'plugins.toast.disabled', { name: plugin.name }),
      );
    } catch (caught) {
      // 失败：store 未变，菜单项状态自动回位。
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
    }
  }

  async function confirmUninstall(): Promise<void> {
    const id = uninstallTarget;
    if (id === null) return;
    const name = plugins.nameOf(id);
    try {
      await plugins.uninstall(id);
      toast.success(t('plugins.toast.uninstalled', { name }));
      uninstallTarget = null;
    } catch (caught) {
      toast.error(t('plugins.toast.failed', { reason: reasonOf(caught) }));
    }
  }
</script>

<!-- 插件操作菜单：启停 / 打开所在目录 / 更新 / 重新安装 / 卸载。插件卡右上角与内容卡共用。 -->
{#snippet pluginMenu(plugin: PluginSummary)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      disabled={plugins.busy.has(plugin.id)}
      aria-label={t('plugins.menu.more')}
      title={t('plugins.menu.more')}
      data-testid={`plugins-menu-${plugin.id}`}
    >
      <Ellipsis class="size-4" aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="w-44" align="end">
      <DropdownMenu.Item
        onSelect={() => void toggle(plugin, !plugin.enabled)}
        data-testid={`plugins-toggle-${plugin.id}`}
      >
        {plugin.enabled ? t('plugins.menu.disable') : t('plugins.menu.enable')}
      </DropdownMenu.Item>
      {#if plugin.configFields.length > 0}
        <DropdownMenu.Item
          onSelect={() => void openConfig(plugin)}
          data-testid={`plugins-config-menu-${plugin.id}`}
        >
          {t('plugins.menu.settings')}
        </DropdownMenu.Item>
      {/if}
      {#if plugin.dirPath !== null && window.kepcup?.showItemInFolder !== undefined}
        <DropdownMenu.Item
          onSelect={() => reveal(plugin)}
          data-testid={`plugins-reveal-${plugin.id}`}
        >
          {t('plugins.reveal')}
        </DropdownMenu.Item>
      {/if}
      {#if plugin.updateAvailable !== null}
        <DropdownMenu.Item
          onSelect={() => openUpdate(plugin)}
          data-testid={`plugins-update-${plugin.id}`}
        >
          {t('plugins.update.button')}
        </DropdownMenu.Item>
      {/if}
      {#if plugin.origin === 'local'}
        <DropdownMenu.Item
          onSelect={() => openReinstall()}
          data-testid={`plugins-reinstall-${plugin.id}`}
        >
          {t('plugins.reinstall')}
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        class="text-destructive hover:text-destructive"
        onSelect={() => (uninstallTarget = plugin.id)}
        data-testid={`plugins-uninstall-${plugin.id}`}
      >
        {t('plugins.uninstall')}
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

<!-- 归属插件的操作（内容卡右上角）：由 AppCatalogGrid 按 `entry.pluginId` 调用；内置插件只读，不出菜单。 -->
{#snippet pluginActions(pluginId: string)}
  {@const plugin = plugins.plugins.find((candidate) => candidate.id === pluginId)}
  {#if plugin !== undefined && plugin.origin !== 'builtin'}
    {@render pluginMenu(plugin)}
  {/if}
{/snippet}

<!--
  系统卡（D105 P4 §3.4）：本机应用协作（InkCop）与本机自建连接是宿主能力，**不是插件**——
  不进插件菜单、不计贡献筛选、无启停卸载；收编进「已安装 / 全部」网格末尾，旧 localCollab
  深链滚动到第一张卡。路标（把系统能力也表达为插件或长期保持系统卡）见设计文稿修正（P5）。
-->
{#snippet systemCards()}
  <div
    class="relative flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-sm"
    id="extension-system-local-collab"
    data-testid="extension-system-card-local-collab"
  >
    <div class="flex flex-wrap items-center gap-2 pe-7">
      <span class="font-medium">{t('plugins.system.localCollab.title')}</span>
      <Badge variant="outline">{t('plugins.system.badge')}</Badge>
      <button
        type="button"
        class="absolute top-2.5 right-2.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-expanded={systemLocalCollabOpen}
        aria-label={systemLocalCollabOpen
          ? t('plugins.system.collapse')
          : t('plugins.system.expand')}
        onclick={() => (systemLocalCollabOpen = !systemLocalCollabOpen)}
        data-testid="extension-system-card-local-collab-toggle"
      >
        <ChevronDown
          class="size-4 transition-transform {systemLocalCollabOpen ? 'rotate-180' : ''}"
          aria-hidden="true"
        />
      </button>
    </div>
    <p class="text-xs text-muted-foreground">{t('extensionCenter.localCollab.hint')}</p>
    {#if systemLocalCollabOpen}
      <div class="border-t pt-3">
        <ExtensionLocalCollab embedded />
      </div>
    {/if}
  </div>
  <div
    class="relative flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-sm"
    id="extension-system-local-connectors"
    data-testid="extension-system-card-local-connectors"
  >
    <div class="flex flex-wrap items-center gap-2 pe-7">
      <span class="font-medium">{t('plugins.system.localConnectors.title')}</span>
      <Badge variant="outline">{t('plugins.system.badge')}</Badge>
      <button
        type="button"
        class="absolute top-2.5 right-2.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-expanded={systemLocalConnectorsOpen}
        aria-label={systemLocalConnectorsOpen
          ? t('plugins.system.collapse')
          : t('plugins.system.expand')}
        onclick={() => (systemLocalConnectorsOpen = !systemLocalConnectorsOpen)}
        data-testid="extension-system-card-local-connectors-toggle"
      >
        <ChevronDown
          class="size-4 transition-transform {systemLocalConnectorsOpen ? 'rotate-180' : ''}"
          aria-hidden="true"
        />
      </button>
    </div>
    <p class="text-xs text-muted-foreground">{t('apps.local.section.hint')}</p>
    {#if systemLocalConnectorsOpen}
      <div class="border-t pt-3">
        <LocalConnectorsSection embedded onManage={manage} />
      </div>
    {/if}
  </div>
{/snippet}

<!-- 一张插件卡：名称 / 徽标 / 描述 + 类别标签；右上角 ⋮ 菜单；底部按贡献类别给管理入口。 -->
{#snippet pluginCard(plugin: PluginSummary)}
  {@const kinds = manageKinds(plugin)}
  <div
    class="relative flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5 text-sm"
    data-testid={`plugins-card-${plugin.id}`}
    data-plugin-id={plugin.id}
  >
    {#if plugin.origin !== 'builtin'}
      <div class="absolute top-2.5 right-2.5">{@render pluginMenu(plugin)}</div>
    {/if}
    <div class="flex flex-wrap items-center gap-2 pe-7">
      <PluginIcon src={plugin.iconDataUri} label={plugin.name} class="size-7" />
      <span class="font-medium">{plugin.name}</span>
      <span class="text-xs text-muted-foreground">
        {t('plugins.version', { version: plugin.version })}
      </span>
      <Badge variant="outline">{t(`plugins.origin.${plugin.origin}`)}</Badge>
      <Badge
        variant="outline"
        class={plugin.tier === 'developer' ? 'border-destructive text-destructive' : ''}
        data-testid={`plugins-tier-${plugin.id}`}
      >
        {t(`plugins.tier.${plugin.tier}`)}
      </Badge>
      {#if plugin.updateAvailable !== null}
        <Badge variant="outline" data-testid={`plugins-update-badge-${plugin.id}`}>
          {t('plugins.update.available', { version: plugin.updateAvailable.version })}
        </Badge>
      {/if}
    </div>
    {#if plugin.description.length > 0}
      <p class="text-xs text-muted-foreground">{plugin.description}</p>
    {/if}
    {#if !plugin.enabled}
      <p class="text-xs text-muted-foreground" data-testid={`plugins-disabled-${plugin.id}`}>
        {t('plugins.state.disabled')}
      </p>
    {/if}
    <div class="flex flex-wrap items-center gap-1">
      {#each KIND_TAG_KEYS as [countKey, labelKey] (countKey)}
        {#if plugin.counts[countKey] > 0}
          <Badge variant="secondary" data-testid={`plugins-tag-${countKey}-${plugin.id}`}>
            {t(labelKey)}
          </Badge>
        {/if}
      {/each}
    </div>
    {#if kinds.length > 0}
      <div class="mt-1 flex flex-wrap items-center justify-end gap-2">
        {#each kinds as entry (entry.kind)}
          <Button
            size="sm"
            variant="outline"
            onclick={() => openManage(plugin, entry.kind)}
            data-testid={`plugins-manage-${entry.kind}-${plugin.id}`}
          >
            {kinds.length > 1
              ? `${t('plugins.manage')} · ${t(entry.labelKey)}`
              : t('plugins.manage')}
          </Button>
        {/each}
      </div>
    {/if}
    {#if configPanelId === plugin.id}
      <div
        class="mt-2 space-y-2.5 rounded-lg border bg-muted/30 px-3 py-3"
        data-testid={`plugins-config-${plugin.id}`}
      >
        <p class="text-xs font-medium">{t('plugins.config.heading')}</p>
        {#if configLoadingId === plugin.id}
          <p class="text-xs text-muted-foreground">{t('apps.catalog.loading')}</p>
        {:else}
          <PluginFieldForm
            fields={plugin.configFields}
            bind:values={configValues}
            idScope={`plugins-config-${plugin.id}`}
            storedSensitiveKeys={configStoredKeys}
          />
          <div class="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onclick={closeConfig} data-testid={`plugins-config-${plugin.id}-cancel`}>
              {t('plugins.cancel')}
            </Button>
            <Button
              size="sm"
              disabled={configSaving}
              onclick={() => void saveConfig(plugin)}
              data-testid={`plugins-config-${plugin.id}-save`}
            >
              {t('settings.save')}
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-installed">
  <div class="mb-3 flex items-start justify-between gap-2 px-0.5">
    <div class="min-w-0">
      <h2 class="text-sm font-medium">{t('plugins.title')}</h2>
      <p class="text-xs text-muted-foreground">{t('plugins.hint')}</p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={checking || updatingAll || plugins.marketLoading}
        onclick={() => void checkUpdates()}
        data-testid="plugins-check-updates"
      >
        {checking ? t('plugins.update.checking') : t('plugins.update.check')}
      </Button>
      {#if hasUpdates}
        <Button
          size="sm"
          variant="secondary"
          disabled={updatingAll}
          onclick={() => void updateAll()}
          data-testid="plugins-update-all"
        >
          {t('plugins.update.all')}
        </Button>
      {/if}
      {#if endpointSupports('local-file-dialog')}
        <Button
          size="sm"
          variant="secondary"
          onclick={() => openInstall('file')}
          data-testid="plugins-install-file"
        >
          {t('plugins.installFile')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onclick={() => openInstall('folder')}
          data-testid="plugins-install-folder"
        >
          {t('plugins.installFolder')}
        </Button>
      {/if}
    </div>
  </div>

  {#if plugins.loadError !== null}
    <p class="px-0.5 text-xs text-destructive" data-testid="plugins-error">
      {t('plugins.loadFailed', { reason: plugins.loadError })}
    </p>
  {:else if plugins.plugins.length === 0 && !plugins.loading}
    <p class="px-0.5 text-xs text-muted-foreground" data-testid="plugins-empty">
      {t('plugins.empty')}
    </p>
  {/if}

  {#if contentView === null}
    {#if detailConnectionId !== null}
      <AppConnectionDetail
        connectionId={detailConnectionId}
        onBack={() => (detailConnectionId = null)}
      />
    {:else if managingConnectorId !== null}
      {@const accounts = appsStore.connections.filter(
        (connection) =>
          connection.connectorId === managingConnectorId && !isCustomConnection(connection),
      )}
      {#if accounts.length === 1}
        <!-- 单账号：直进账号详情 -->
        <AppConnectionDetail
          connectionId={accounts[0]!.id}
          onBack={() => (managingConnectorId = null)}
        />
      {:else}
        <div class="space-y-3">
          <Button
            size="sm"
            variant="ghost"
            class="-ml-2 gap-1"
            onclick={() => (managingConnectorId = null)}
            data-testid="plugins-manage-back"
          >
            <ArrowLeft class="size-3.5" aria-hidden="true" />
            {t('plugins.backToList')}
          </Button>
          {#if accounts.length > 1}
            <AppConnectionsList
              connectorId={managingConnectorId}
              onOpen={(id) => (detailConnectionId = id)}
              onGoCatalog={() => (managingConnectorId = null)}
            />
          {:else}
            <!-- 0 账号：直给首连面板 -->
            {@const entry = appsStore.catalog.find(
              (candidate) => candidate.connectorId === managingConnectorId,
            )}
            {#if entry !== undefined}
              <ConnectAppPanel
                target={{ kind: 'catalog', connectorId: managingConnectorId }}
                name={entry.title}
                allowDisconnect={false}
                testid="plugins-manage-connect-panel"
              />
            {:else}
              <p class="text-xs text-muted-foreground">{t('apps.catalog.loading')}</p>
            {/if}
          {/if}
        </div>
      {/if}
    {:else}
      <div
        class="mb-2 flex flex-wrap items-center gap-1.5 px-0.5"
        role="group"
        data-testid="plugins-filters"
      >
        {#each FILTER_CHIPS as chip (chip.id)}
          <button
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-xs transition-colors {filter === chip.id
              ? 'border-foreground bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => (shell.extensionCenterFilter = chip.id)}
            data-testid={`plugins-filter-${chip.id}`}
            data-settings-anchor={`plugins-filter-${chip.id}`}
          >
            {t(chip.labelKey)}
            <span class="ms-0.5 opacity-70">{filterCounts.get(chip.id) ?? 0}</span>
          </button>
        {/each}
      </div>

      {#if revokedPlugins.length > 0}
        <div class="mb-3 grid gap-1">
          {#each revokedPlugins as plugin (plugin.id)}
            <p class="px-0.5 text-xs text-destructive" data-testid={`plugins-revoked-${plugin.id}`}>
              {plugin.name}：{plugin.revoked === 'disable'
                ? t('plugins.revoked.disable')
                : t('plugins.revoked.warn')}
            </p>
          {/each}
        </div>
      {/if}

      {#if visiblePlugins.length === 0 && plugins.plugins.length > 0 && !plugins.loading}
        <p class="px-0.5 text-xs text-muted-foreground" data-testid="plugins-filter-empty">
          {t('plugins.filter.empty')}
        </p>
      {:else if visiblePlugins.length > 0 || filter === 'all'}
        <div
          class="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3"
          data-testid="plugins-grid"
        >
          {#each visiblePlugins as plugin (plugin.id)}
            {@render pluginCard(plugin)}
          {/each}
          {#if filter === 'all'}
            {@render systemCards()}
          {/if}
        </div>
      {/if}

      <!-- 手动工具服务（M2 顺延期间的保留入口，DEV-075）：插件圈定后插件卡只看得到
         自己投影的 server，新建 / .mcpb 安装与手动 server 的编辑在这个无圈定的全局
         管理区（custom-mcp 实例化落地后整块退役，见 todo/plugin-platform P4-M2）。 -->
      {#if filter === 'mcp'}
        <div class="mt-5 border-t pt-4" data-testid="manual-mcp-section">
          <McpSection />
        </div>
      {/if}
    {/if}
  {:else if contentView.kind === 'connector'}
    <div class="space-y-2" data-testid="plugins-content-connector">
      <Button
        size="sm"
        variant="ghost"
        class="-ml-2 gap-1"
        onclick={() => (contentView = null)}
        data-testid="plugins-content-back"
      >
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        {t('plugins.backToList')}
      </Button>
      <ExtensionConnections embedded pluginId={contentView.pluginId} {pluginActions} />
    </div>
  {:else if contentView.kind === 'mcp'}
    <div class="space-y-2" data-testid="plugins-content-mcp">
      <Button
        size="sm"
        variant="ghost"
        class="-ml-2 gap-1"
        onclick={() => (contentView = null)}
        data-testid="plugins-content-back"
      >
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        {t('plugins.backToList')}
      </Button>
      <ExtensionMcp embedded pluginId={contentView.pluginId} />
    </div>
  {:else}
    <div class="space-y-2" data-testid="plugins-content-mail">
      <Button
        size="sm"
        variant="ghost"
        class="-ml-2 gap-1"
        onclick={() => (contentView = null)}
        data-testid="plugins-content-back"
      >
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        {t('plugins.backToList')}
      </Button>
      <ExtensionMail embedded />
    </div>
  {/if}
</div>

<PluginInstallDialog bind:open={installOpen} mode={installMode} marketplace={installTarget} />

<Dialog
  open={uninstallTarget !== null}
  onOpenChange={(next) => {
    if (!next) uninstallTarget = null;
  }}
>
  <DialogContent class="sm:max-w-md" data-testid="plugins-uninstall-dialog">
    <DialogHeader>
      <DialogTitle>{t('plugins.uninstallTitle')}</DialogTitle>
      <DialogDescription>
        {uninstallTarget === null
          ? ''
          : t('plugins.uninstallBody', { name: plugins.nameOf(uninstallTarget) })}
      </DialogDescription>
    </DialogHeader>
    <div class="flex items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={uninstallTarget !== null && plugins.busy.has(uninstallTarget)}
        onclick={() => void confirmUninstall()}
        data-testid="plugins-uninstall-confirm"
      >
        {t('plugins.uninstallConfirm')}
      </Button>
      <Button size="sm" variant="ghost" onclick={() => (uninstallTarget = null)}>
        {t('plugins.cancel')}
      </Button>
    </div>
  </DialogContent>
</Dialog>

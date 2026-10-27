<script lang="ts">
  import type { PluginSummary } from '@kepcup/shared';
  import { SvelteSet } from 'svelte/reactivity';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { endpointSupports } from '../web-shell/endpoint';
  import { shell } from '$lib/stores/shell.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { plugins } from '../plugins/plugins.svelte';
  import ExtensionSkills from './ExtensionSkills.svelte';
  import ExtensionConnections from './ExtensionConnections.svelte';
  import ExtensionMcp from './ExtensionMcp.svelte';
  import ExtensionMail from './ExtensionMail.svelte';
  import {
    FILTER_COUNT_KEYS,
    type ExtensionCenterFilter,
    type ExtensionCenterKindFilter,
  } from './tabs';
  import PluginInstallDialog from '../plugins/PluginInstallDialog.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * 扩展中心 →「已安装」分组（D104 P0a-3）：本机已装插件的装 / 卸 / 启停与内容总览。
   * 页头的两个本地安装入口仅在桌面端点渲染（web / headless 隐藏）；启用开关与卸载按钮
   * 不对内置插件渲染（内置只读，P0b 起出现在列表里）。内容明细按账本展开、可跳到
   * 对应管理页签；「由插件管理」的锁定语义在 core 层（PLUGIN_MANAGED）。
   *
   * 顶部筛选（D104 UI 修正）：技能 / 连接 / MCP / 邮件四类内容由插件贡献、安装后自动
   * 归类（`PluginSummary.counts`），不再是独立分组而是这里的筛选条件；选中某类时在
   * 插件卡片下方嵌入该类的完整管理区（预置技能 / 连接目录 / 自定义 MCP / 邮箱）。
   * 可更新的插件卡片恒置顶——「检查更新」后自动浮起，支持全部更新或逐条更新。
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
  /** 展开了内容明细的插件 id。 */
  const expanded = new SvelteSet<string>();

  const DETAIL_KINDS = ['skill', 'connector', 'mcp', 'mail'] as const;

  const KIND_LABEL_KEYS = {
    skills: 'plugins.kind.skill',
    connectors: 'plugins.kind.connector',
    mcp: 'plugins.kind.mcp',
    mail: 'plugins.kind.mail',
  } as const;

  const hasUpdates = $derived(plugins.plugins.some((plugin) => plugin.updateAvailable !== null));

  /** 内容筛选：状态在 shell store（旧分组深链 / 设置卡深链会带筛选直达）。 */
  const filter = $derived(shell.extensionCenterFilter);

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
      counts.set(kind, plugins.plugins.filter((plugin) => plugin.counts[countKey] > 0).length);
    }
    return counts;
  });

  /** 展示顺序：可更新的插件恒置顶（「检查更新」后自动浮起），其余保持 plugins.list 顺序。 */
  const visiblePlugins = $derived.by(() => {
    const sorted = [...plugins.plugins].sort(
      (a, b) => Number(b.updateAvailable !== null) - Number(a.updateAvailable !== null),
    );
    if (filter === 'all') return sorted;
    const countKey = FILTER_COUNT_KEYS[filter];
    return sorted.filter((plugin) => plugin.counts[countKey] > 0);
  });

  const serverNames = $derived(
    new Map((settingsStore.settings?.mcpServers ?? []).map((server) => [server.id, server.name])),
  );

  /** 内容计数里非零的类别（0 的不显示）。 */
  function nonZeroCounts(plugin: PluginSummary): Array<{ kind: string; count: number }> {
    return Object.entries(plugin.counts)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => ({ kind, count }));
  }

  /** 内容明细里的 MCP 服务器名：按 server id 反查，查不到显示 id。 */
  function mcpLabel(ref: string): string {
    return serverNames.get(ref) ?? ref;
  }

  function toggleDetails(id: string): void {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
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
      // 失败：store 未变，开关自动回位。
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

  /** 内容明细里每一类的「前往」目标：切到已安装列表的对应筛选（mail 没有对应管理区）。 */
  function goToFilter(kind: 'skill' | 'connector' | 'mcp'): void {
    shell.extensionCenterFilter = kind;
  }
</script>

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
  {:else if filter !== 'all' && visiblePlugins.length === 0 && !plugins.loading}
    <p class="px-0.5 text-xs text-muted-foreground" data-testid="plugins-filter-empty">
      {t('plugins.filter.empty')}
    </p>
  {/if}

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
      >
        {t(chip.labelKey)}
        <span class="ms-0.5 opacity-70">{filterCounts.get(chip.id) ?? 0}</span>
      </button>
    {/each}
  </div>

  <div class="grid gap-2">
    {#each visiblePlugins as plugin (plugin.id)}
      {@const isBuiltin = plugin.origin === 'builtin'}
      <div
        class="rounded-lg border bg-card px-3 py-2.5 text-sm"
        data-testid={`plugins-card-${plugin.id}`}
        data-plugin-id={plugin.id}
      >
        <div class="flex flex-wrap items-center gap-2">
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
          {#each nonZeroCounts(plugin) as entry (`${entry.kind}:${entry.count}`)}
            <span class="text-xs text-muted-foreground">
              {t('plugins.countItem', {
                kind: t(KIND_LABEL_KEYS[entry.kind as keyof typeof KIND_LABEL_KEYS]),
                count: entry.count,
              })}
            </span>
          {/each}
          {#if plugin.updateAvailable !== null}
            <Badge variant="outline" data-testid={`plugins-update-badge-${plugin.id}`}>
              {t('plugins.update.available', { version: plugin.updateAvailable.version })}
            </Badge>
          {/if}
          <div class="ms-auto flex items-center gap-1.5">
            {#if !isBuiltin && plugin.updateAvailable !== null}
              <Button
                size="sm"
                variant="secondary"
                disabled={updatingAll}
                onclick={() => openUpdate(plugin)}
                data-testid={`plugins-update-${plugin.id}`}
              >
                {t('plugins.update.button')}
              </Button>
            {/if}
            {#if !isBuiltin && plugin.origin === 'local'}
              <Button
                size="sm"
                variant="ghost"
                onclick={() => openReinstall()}
                data-testid={`plugins-reinstall-${plugin.id}`}
              >
                {t('plugins.reinstall')}
              </Button>
            {/if}
            {#if !isBuiltin}
              <Checkbox
                checked={plugin.enabled}
                disabled={plugins.busy.has(plugin.id)}
                aria-label={t('plugins.toggleLabel')}
                onCheckedChange={(checked) => void toggle(plugin, checked === true)}
                data-testid={`plugins-toggle-${plugin.id}`}
              />
              {#if plugin.dirPath !== null && window.kepcup?.showItemInFolder !== undefined}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => reveal(plugin)}
                  data-testid={`plugins-reveal-${plugin.id}`}
                >
                  {t('plugins.reveal')}
                </Button>
              {/if}
              <Button
                size="sm"
                variant="ghost"
                class="text-destructive hover:text-destructive"
                disabled={plugins.busy.has(plugin.id)}
                onclick={() => (uninstallTarget = plugin.id)}
                data-testid={`plugins-uninstall-${plugin.id}`}
              >
                {t('plugins.uninstall')}
              </Button>
            {:else}
              <Badge variant="outline">{t('plugins.origin.builtin')}</Badge>
            {/if}
          </div>
        </div>

        {#if plugin.description.length > 0}
          <p class="mt-1 text-xs text-muted-foreground">{plugin.description}</p>
        {/if}

        {#if plugin.revoked !== null}
          <p class="mt-1 text-xs text-destructive" data-testid={`plugins-revoked-${plugin.id}`}>
            {plugin.revoked === 'disable'
              ? t('plugins.revoked.disable')
              : t('plugins.revoked.warn')}
          </p>
        {/if}

        <div class="mt-1.5">
          <Button
            size="sm"
            variant="ghost"
            class="h-6 px-2 text-xs text-muted-foreground"
            onclick={() => toggleDetails(plugin.id)}
            data-testid={`plugins-details-${plugin.id}`}
          >
            {expanded.has(plugin.id) ? t('plugins.hideDetails') : t('plugins.details')}
          </Button>
          {#if expanded.has(plugin.id)}
            <div class="mt-1.5 grid gap-2 border-t pt-1.5">
              {#each DETAIL_KINDS as kind (kind)}
                {@const items = plugin.items.filter((item) => item.kind === kind)}
                {#if items.length > 0}
                  <div class="grid gap-0.5">
                    <div class="flex items-center gap-2">
                      <Label class="text-xs text-muted-foreground"
                        >{t(`plugins.kind.${kind}`)}</Label
                      >
                      {#if kind !== 'mail'}
                        <Button
                          size="sm"
                          variant="ghost"
                          class="h-6 px-2 text-xs"
                          onclick={() => goToFilter(kind)}
                        >
                          {t('plugins.goTo')}
                        </Button>
                      {/if}
                    </div>
                    {#each items as item (`${item.kind}:${item.ref}`)}
                      <div class="flex flex-wrap items-center gap-1.5 text-xs">
                        <span>{kind === 'mcp' ? mcpLabel(item.ref) : item.ref}</span>
                        {#if item.missing === true}
                          <Badge variant="outline" class="text-destructive">
                            {t('plugins.itemMissing')}
                          </Badge>
                        {/if}
                        {#if item.yielded === true}
                          <Badge variant="outline">{t('plugins.itemYielded')}</Badge>
                        {/if}
                      </div>
                    {/each}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  {#if filter === 'skill'}
    <div class="mt-4 border-t pt-1" data-settings-anchor="plugins-filter-skill">
      <ExtensionSkills embedded />
    </div>
  {:else if filter === 'connector'}
    <div class="mt-4 border-t pt-1" data-settings-anchor="plugins-filter-connector">
      <ExtensionConnections embedded />
    </div>
  {:else if filter === 'mcp'}
    <div class="mt-4 border-t pt-1" data-settings-anchor="plugins-filter-mcp">
      <ExtensionMcp embedded />
    </div>
  {:else if filter === 'mail'}
    <div class="mt-4 border-t pt-1" data-settings-anchor="plugins-filter-mail">
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

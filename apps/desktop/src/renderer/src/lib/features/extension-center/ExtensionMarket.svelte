<script lang="ts">
  import type { PluginMarketEntry } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { plugins } from '../plugins/plugins.svelte';
  import PluginInstallDialog from '../plugins/PluginInstallDialog.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Input } from '$lib/components/ui/input';

  /**
   * 扩展中心 →「市场」分组（D104 P1-3）：浏览官方市场索引、按类别与关键字筛选，
   * 认证插件默认展开、社区插件默认折叠；安装 / 更新都走同一个同意面板对话框。
   *
   * 市场未启用（本版本没有内置公钥 / 自建市场缺公钥）时只显示状态横幅，不发任何请求；
   * 远程图标一律不加载（列表用名称首字母头像），详情页 README 也不拉取（设计 51 §6.1）。
   */

  const CATEGORY_FILTERS = ['all', 'skill', 'connector', 'mcp', 'mail'] as const;
  type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

  $effect(() => {
    plugins.start();
    // 每次挂载都强制拉一次：用户可能刚在「已安装」页切换了市场端点（关闭 ↔ 官方 ↔
    // 自建），缓存里的 status / 条目已经不代表当前端点；disabled 时刷新按钮也不可点。
    void plugins.loadMarket(true);
  });

  let query = $state('');
  let category = $state<CategoryFilter>('all');
  let showCommunity = $state(false);
  let installOpen = $state(false);
  let target = $state<{ id: string; version?: string } | undefined>(undefined);

  const status = $derived(plugins.marketStatus);

  function matches(entry: PluginMarketEntry): boolean {
    const terms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length > 0) {
      const haystack = [entry.id, entry.name, entry.description, entry.author ?? '']
        .join('\n')
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) return false;
    }
    return category === 'all' || entry.categories.includes(category);
  }

  const verified = $derived(
    plugins.market.filter((entry) => entry.tier === 'verified' && matches(entry)),
  );
  const community = $derived(
    plugins.market.filter((entry) => entry.tier === 'community' && matches(entry)),
  );
  const nothingToShow = $derived(
    plugins.market.length === 0 || (verified.length === 0 && community.length === 0),
  );

  function openInstall(entry: PluginMarketEntry): void {
    target = { id: entry.id, version: entry.version };
    installOpen = true;
  }

  function initial(name: string): string {
    return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  }

  function actionLabel(entry: PluginMarketEntry): string {
    if (entry.installed === null) return t('plugins.market.install');
    if (entry.installed.updateAvailable) {
      return t('plugins.market.updateTo', { version: entry.version });
    }
    return t('plugins.market.installed', { version: entry.installed.version });
  }

  function canAct(entry: PluginMarketEntry): boolean {
    if (entry.revoked !== null) return false;
    if (!entry.compatible) return false;
    return entry.installed === null || entry.installed.updateAvailable;
  }

  async function refresh(): Promise<void> {
    try {
      await plugins.refreshMarket();
    } catch (caught) {
      const code = (caught as { code?: string } | undefined)?.code;
      const message = caught instanceof Error ? caught.message : String(caught);
      toast.error(t('plugins.toast.failed', { reason: errorText(code, message) }));
    }
  }
</script>

<div class="min-h-0 flex-1 overflow-y-auto pt-3 pr-0.5" data-testid="extension-market">
  <div class="mb-3 flex items-start justify-between gap-2 px-0.5">
    <div class="min-w-0">
      <h2 class="text-sm font-medium">{t('plugins.market.title')}</h2>
    </div>
    <Button
      size="sm"
      variant="secondary"
      class="shrink-0"
      disabled={plugins.marketLoading || status?.state === 'disabled'}
      onclick={() => void refresh()}
      data-testid="plugins-market-refresh"
    >
      {plugins.marketLoading ? t('plugins.market.refreshing') : t('plugins.market.refresh')}
    </Button>
  </div>

  {#if status !== null}
    {#if status.state === 'disabled'}
      <p class="mb-3 px-0.5 text-xs text-muted-foreground" data-testid="plugins-market-status">
        {status.disabledReason === 'no_custom_key'
          ? t('plugins.market.status.disabled.no_custom_key')
          : t('plugins.market.status.disabled.no_keys')}
      </p>
    {:else}
      <div class="mb-3 px-0.5 text-xs text-muted-foreground" data-testid="plugins-market-status">
        {#if status.state === 'degraded'}
          <p class="text-amber-600 dark:text-amber-500">
            {t('plugins.market.status.degraded', { error: status.error ?? '' })}
          </p>
        {:else if status.state === 'stale'}
          <p class="text-amber-600 dark:text-amber-500">{t('plugins.market.status.stale')}</p>
        {/if}
        {#if status.endpoint === 'custom'}
          <p>{t('plugins.market.status.custom')}</p>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="mb-3 flex flex-wrap items-center gap-2 px-0.5">
    <Input
      class="h-8 w-56 text-sm"
      placeholder={t('plugins.market.search')}
      bind:value={query}
      data-testid="plugins-market-search"
    />
    <div class="flex flex-wrap items-center gap-1">
      {#each CATEGORY_FILTERS as filter (filter)}
        <Button
          size="sm"
          variant={category === filter ? 'secondary' : 'ghost'}
          class="h-7 px-2 text-xs"
          onclick={() => (category = filter)}
          data-testid={`plugins-market-cat-${filter}`}
        >
          {t(`plugins.market.category.${filter}`)}
        </Button>
      {/each}
    </div>
  </div>

  {#if status?.state === 'disabled'}
    <!-- 未启用：只显示上面的横幅，不渲染列表与空态（避免「市场里没有插件」的误导）。 -->
  {:else if plugins.marketError !== null}
    <p class="px-0.5 text-xs text-destructive" data-testid="plugins-market-error">
      {t('plugins.loadFailed', { reason: plugins.marketError })}
    </p>
  {:else if nothingToShow && !plugins.marketLoading}
    <p class="px-0.5 text-xs text-muted-foreground" data-testid="plugins-market-empty">
      {plugins.market.length === 0 ? t('plugins.market.empty') : t('plugins.market.noMatch')}
    </p>
  {:else}
    <div class="grid gap-3">
      {#if verified.length > 0}
        <section class="grid gap-2">
          <h3 class="text-xs font-medium text-muted-foreground">
            {t('plugins.market.verifiedSection')}
          </h3>
          {#each verified as entry (entry.id)}
            {@render card(entry)}
          {/each}
        </section>
      {/if}

      {#if community.length > 0}
        <section class="grid gap-2">
          <div class="flex items-center gap-2">
            <h3 class="text-xs font-medium text-muted-foreground">
              {t('plugins.market.communitySection')}
            </h3>
            <Button
              size="sm"
              variant="ghost"
              class="h-6 px-2 text-xs"
              onclick={() => (showCommunity = !showCommunity)}
              data-testid="plugins-market-community-toggle"
            >
              {showCommunity
                ? t('plugins.market.communityHide')
                : t('plugins.market.communityShow')}
            </Button>
          </div>
          {#if showCommunity}
            {#each community as entry (entry.id)}
              {@render card(entry)}
            {/each}
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</div>

{#snippet card(entry: PluginMarketEntry)}
  <div
    class="flex items-start gap-3 rounded-lg border bg-card px-3 py-2.5"
    data-testid={`plugins-market-card-${entry.id}`}
  >
    <div
      class="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-sm font-medium"
      aria-hidden="true"
    >
      {initial(entry.name)}
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-sm font-medium">{entry.name}</span>
        <span class="text-xs text-muted-foreground">v{entry.version}</span>
        <Badge variant="outline">{t(`plugins.tier.${entry.tier}`)}</Badge>
        {#each entry.categories as item (item)}
          <Badge variant="outline" class="text-xs">{t(`plugins.market.category.${item}`)}</Badge>
        {/each}
        {#if entry.revoked !== null}
          <Badge variant="outline" class="border-destructive text-destructive">
            {entry.revoked === 'disable'
              ? t('plugins.market.revokedDisable')
              : t('plugins.market.revokedWarn')}
          </Badge>
        {/if}
      </div>
      {#if entry.description.length > 0}
        <p class="mt-1 line-clamp-2 text-xs text-muted-foreground">{entry.description}</p>
      {/if}
      {#if entry.author !== null}
        <p class="mt-0.5 text-xs text-muted-foreground">{entry.author}</p>
      {/if}
      {#if !entry.compatible}
        <p class="mt-1 text-xs text-destructive">
          {t('plugins.market.incompatible', { reason: entry.incompatibleReason ?? '' })}
        </p>
      {/if}
    </div>
    <div class="shrink-0">
      <Button
        size="sm"
        variant={entry.installed === null ? 'secondary' : 'ghost'}
        disabled={!canAct(entry)}
        onclick={() => openInstall(entry)}
        data-testid={entry.installed === null
          ? `plugins-market-install-${entry.id}`
          : `plugins-market-update-${entry.id}`}
      >
        {actionLabel(entry)}
      </Button>
    </div>
  </div>
{/snippet}

<PluginInstallDialog bind:open={installOpen} mode="marketplace" marketplace={target} />

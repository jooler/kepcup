<script lang="ts">
  import { SlidersHorizontal, Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { shell } from '$lib/stores/shell.svelte';
  import { buildProviderNavGroups } from './provider-instances';
  import { providerLogo } from './provider-logos';
  import ModelConfigDetail from './ModelConfigDetail.svelte';
  import ProviderDetail from './ProviderDetail.svelte';
  import ProviderAddView from './ProviderAddView.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 「模型」分区（v0.5.6 重构，对齐 ZCode 的模型设置布局）：顶部标题行 +
   * 「添加供应商」按钮，下方两栏卡——左栏导航（顶部「模型配置」条目收纳
   * 默认模型 / 并发 / 能力槽位 / 向量来源等非供应商配置；其下是供应商实例
   * 列表，分组渲染管线保留、当前不开放分组编辑），右栏为选中条目的详情。
   * 「添加供应商」替换右栏容器（模板网格 + 自定义表单，不弹框）。供应商
   * 实例支持同一厂商多次添加（各自 baseUrl / Key / 模型，模型带能力声明）；
   * 深链锚点 `default-models` / `embedding` 落在「模型配置」详情内。
   */

  /** 选中项：'config' = 模型配置；'add' / 'add-custom' = 添加供应商视图；否则是实例 id。 */
  let selected = $state<string>('config');

  const instances = $derived(settingsStore.settings?.modelProviders ?? []);
  const hasKeyById = $derived(
    new Map(settingsStore.providers.map((provider) => [provider.id, provider.hasKey] as const)),
  );
  const groups = $derived(buildProviderNavGroups(instances, hasKeyById));
  const selectedExists = $derived(
    selected === 'config' ||
      selected === 'add' ||
      selected === 'add-custom' ||
      instances.some((p) => p.id === selected),
  );

  // 深链锚点预选：default-models / embedding 都落在「模型配置」详情里。
  $effect(() => {
    const anchor = shell.settingsAnchor;
    if (anchor === 'default-models' || anchor === 'embedding') selected = 'config';
  });

  // 选中的实例被删除 / 快照未加载时回落「模型配置」（快照没到不抢跑）。
  $effect(() => {
    if (settingsStore.settings !== null && !selectedExists) selected = 'config';
  });
</script>

<div class="space-y-4" data-testid="settings-models">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <p class="text-xs text-muted-foreground">{t('settings.modelsOverviewHint')}</p>
    <Button
      size="sm"
      onclick={() => (selected = 'add')}
      data-testid="provider-add"
    >
      <Plus class="size-4" />
      {t('settings.addProviderTitle')}
    </Button>
  </div>

  <div class="flex flex-col gap-0 rounded-xl border sm:flex-row sm:gap-0" data-testid="models-two-pane">
    <!-- 左栏：窄屏横向滚动条，宽屏纵向导航 -->
    <aside class="shrink-0 border-b p-2 sm:w-56 sm:border-b-0 sm:border-r">
      <nav class="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible" data-testid="models-nav">
        <button
          type="button"
          class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm font-medium transition-colors {selected === 'config'
            ? 'bg-accent text-accent-foreground'
            : 'hover:bg-accent/50'}"
          onclick={() => (selected = 'config')}
          data-testid="models-nav-config"
        >
          <SlidersHorizontal class="size-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{t('settings.modelsNavConfig')}</span>
        </button>
        {#each groups as group (group.id)}
          {#if group.title !== null}
            <h3 class="hidden px-2 pt-2 text-xs font-medium text-muted-foreground sm:block">
              {group.title}
            </h3>
          {/if}
          {#each group.items as item (item.instance.id)}
            <button
              type="button"
              class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors {selected === item.instance.id
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-accent/50'}"
              onclick={() => (selected = item.instance.id)}
              data-testid={`models-nav-provider-${item.instance.id}`}
            >
              {#if providerLogo(item.instance.logo) !== undefined}
                <img
                  src={providerLogo(item.instance.logo)}
                  alt=""
                  class="size-4 shrink-0 rounded object-contain"
                />
                <span class="truncate">{item.instance.name}</span>
                <span
                  class="ml-auto size-2 shrink-0 rounded-full {item.status === 'ready'
                    ? 'bg-emerald-500'
                    : item.status === 'incomplete'
                      ? 'bg-amber-500'
                      : 'bg-muted-foreground/40'}"
                  title={t(`settings.providerStatus.${item.status}`)}
                ></span>
              {:else}
                <span
                  class="size-2 shrink-0 rounded-full {item.status === 'ready'
                    ? 'bg-emerald-500'
                    : item.status === 'incomplete'
                      ? 'bg-amber-500'
                      : 'bg-muted-foreground/40'}"
                  title={t(`settings.providerStatus.${item.status}`)}
                ></span>
                <span class="truncate">{item.instance.name}</span>
              {/if}
            </button>
          {/each}
        {/each}
      </nav>
    </aside>

    <!-- 右栏详情 -->
    <div class="min-w-0 flex-1 p-4 sm:p-5">
      {#if selected === 'config'}
        <ModelConfigDetail onOpenProvider={(id) => (selected = id)} />
      {:else if selected === 'add' || selected === 'add-custom'}
        <ProviderAddView
          onBack={() => (selected = 'config')}
          onCreated={(id) => (selected = id)}
        />
      {:else if selectedExists}
        <ProviderDetail instanceId={selected} onDeleted={() => (selected = 'config')} />
      {/if}
    </div>
  </div>
</div>

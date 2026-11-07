<script lang="ts">
  import type {
    FetchedProviderModel,
    ProviderApi,
    ProviderInstance,
    ProviderTemplate,
  } from '@kepcup/shared';
  import { createInstanceFromTemplate, PROVIDER_TEMPLATES } from '@kepcup/shared';
  import { customInstanceIdPattern } from '@kepcup/shared';
  import { ArrowLeft, ChevronRight, Download, Plus } from '@lucide/svelte';
  import { i18n, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import ProviderFetchModelsDialog from './ProviderFetchModelsDialog.svelte';
  import { providerIcon } from './provider-logos';
  import {
    fetchedToProviderModel,
    PROVIDER_API_OPTIONS,
    templateAvatarStyle,
  } from './provider-instances';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Select from '$lib/components/ui/select';

  /**
   * 「添加供应商」右栏视图（替换原弹框，对齐 ZCode 的模板选择页）：返回头 +
   * 扁平模板卡网格（完整搬运 ZCode 内置目录的同供应商多端点变体，合并
   * pi-ai 内置供应商目录——`builtinCatalog` 卡创建目录实例）+ 「创建自定义
   * 供应商」卡（首位）。点模板即建档（id 自动避让、预填线协议 / 图标 /
   * 预置对话模型，同一模板可重复添加）；自定义卡切到内联表单（数据风格 +
   * 获取模型：按表单里的 baseUrl / Key 未保存先拉，选中条目建档时并入）。
   * 创建成功后 onCreated(instanceId)（父级选中该实例）。
   */
  let {
    onBack,
    onCreated,
  }: {
    onBack: () => void;
    onCreated: (instanceId: string) => void;
  } = $props();

  /** 'templates' = 模板网格；'custom' = 自定义供应商表单。 */
  let view = $state<'templates' | 'custom'>('templates');

  /** 自定义供应商可选的数据风格（预置模板卡的线协议由模板固定）。 */
  const API_OPTIONS = PROVIDER_API_OPTIONS;

  let customName = $state('');
  let customId = $state('');
  let customBaseUrl = $state('');
  let customKey = $state('');
  let customApi = $state<ProviderApi>('openai-completions');
  let busy = $state(false);
  let fetching = $state(false);
  /** 最近一次拉取的结果（弹框数据源）与勾选待并入的条目。 */
  let fetchedModels = $state<FetchedProviderModel[]>([]);
  let customFetched = $state<FetchedProviderModel[]>([]);
  let fetchDialogOpen = $state(false);

  // 拉取结果绑定发起时的参数:baseUrl / 风格 / Key 任一变化,旧结果(含勾选)
  // 即失效,清空防止把旧端点的模型登记进新实例。
  $effect(() => {
    void customBaseUrl;
    void customApi;
    void customKey;
    fetchedModels = [];
    customFetched = [];
  });

  function resetCustomDraft(): void {
    customName = '';
    customId = '';
    customBaseUrl = '';
    customKey = '';
    customApi = 'openai-completions';
    fetchedModels = [];
    customFetched = [];
    fetchDialogOpen = false;
  }

  /** 拉取可用模型（新增表单：Key 尚未落库，用 keyOverride 未保存先拉）。 */
  async function fetchCustomModels(): Promise<void> {
    const baseUrl = customBaseUrl.trim();
    if (baseUrl.length === 0 || fetching) return;
    fetching = true;
    try {
      const models = await settingsStore.fetchModels({
        baseUrl,
        api: customApi,
        ...(customKey.length > 0 ? { keyOverride: customKey } : {}),
      });
      if (models.length === 0) {
        toast.error(t('settings.fetchModelsEmpty'));
        return;
      }
      // 只更新弹框数据源;勾选清单以弹框确认为准(取消不改动 customFetched,
      // 重开弹框经 initialSelected 恢复上次勾选)。
      fetchedModels = models;
      fetchDialogOpen = true;
    } catch (error) {
      toast.error(
        t('settings.fetchModelsFailed', { reason: String((error as Error).message ?? '') }),
      );
    } finally {
      fetching = false;
    }
  }

  function onFetchedConfirm(picked: FetchedProviderModel[]): void {
    customFetched = picked;
  }

  /** 卡片副标题：接口根 / 官网 host（builtinCatalog 模板没有 baseUrl，用 websiteUrl）。 */
  function templateHost(template: ProviderTemplate): string {
    const url = template.baseUrl ?? template.websiteUrl;
    return url === undefined ? t('settings.templateBuiltinCatalog') : new URL(url).host;
  }

  /** 展示名：zh 用模板名，en 用 nameEn（i18n `settings.vendor.{id}` 键不再需要）。 */
  function templateName(id: string): string {
    const template = PROVIDER_TEMPLATES.find((tpl) => tpl.id === id);
    if (template === undefined) return id;
    return i18n.locale.startsWith('zh') ? template.name : (template.nameEn ?? template.name);
  }

  async function addTemplate(templateId: string): Promise<void> {
    const settings = settingsStore.settings;
    if (!settings) return;
    busy = true;
    try {
      const instance = createInstanceFromTemplate(
        settings.modelProviders.map((p) => p.id),
        templateId,
      );
      await settingsStore.update({
        modelProviders: [...settings.modelProviders, instance],
      });
      toast.success(t('settings.saved'));
      onCreated(instance.id);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function addCustom(): Promise<void> {
    const settings = settingsStore.settings;
    if (!settings) return;
    const rawId = customId.trim();
    const baseUrl = customBaseUrl.trim();
    if (!customInstanceIdPattern.test(rawId) || baseUrl.length === 0) {
      toast.error(t('settings.customBaseUrl'));
      return;
    }
    const id = `custom:${rawId}`;
    if (settings.modelProviders.some((p) => p.id === id)) {
      toast.error(t('settings.customIdDuplicate', { id }));
      return;
    }
    busy = true;
    try {
      const instance: ProviderInstance = {
        id,
        vendor: null,
        name: customName.trim() || rawId,
        baseUrl,
        enabled: true,
        api: customApi,
        builtinCatalog: false,
        models: customFetched.map(fetchedToProviderModel),
      };
      await settingsStore.update({
        modelProviders: [...settings.modelProviders, instance],
      });
      if (customKey.length > 0) {
        await settingsStore.setKey(id, customKey);
      } else {
        await settingsStore.refresh();
      }
      toast.success(t('settings.saved'));
      resetCustomDraft();
      onCreated(id);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }
</script>

<div class="min-w-0" data-testid="provider-add-view">
  <!-- 返回头（对齐 ZCode：← 添加供应商） -->
  <div class="mb-4 flex items-center gap-2">
    <Button
      size="icon-sm"
      variant="ghost"
      onclick={onBack}
      title={t('settings.back')}
      data-testid="provider-add-back"
    >
      <ArrowLeft class="size-4" />
    </Button>
    <h3 class="text-sm font-semibold">{t('settings.addProviderTitle')}</h3>
  </div>

  {#if view === 'templates'}
    <div class="grid gap-2 sm:grid-cols-2" data-testid="provider-templates">
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-accent/40"
        onclick={() => (view = 'custom')}
        data-testid="provider-template-custom"
      >
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed text-muted-foreground"
        >
          <Plus class="size-4" />
        </span>
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium">{t('settings.templateCustomCard')}</span>
          <span class="block truncate text-xs text-muted-foreground">
            {t('settings.templateHintCustom')}
          </span>
        </span>
        <ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground" />
      </button>
      {#each PROVIDER_TEMPLATES as template (template.id)}
        {@const icon = providerIcon(template.logo)}
        <button
          type="button"
          class="flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-accent/40"
          disabled={busy}
          onclick={() => void addTemplate(template.id)}
          title={template.consoleUrl !== undefined && template.consoleUrl.length > 0
            ? template.consoleUrl
            : undefined}
          data-testid={`provider-template-${template.id}`}
        >
          {#if icon !== undefined}
            <ProviderLogo
              icon={icon}
              class="size-8 shrink-0 rounded-lg object-contain p-0.5"
            />
          {:else}
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold {templateAvatarStyle(template.id)}"
            >
              {template.name.slice(0, 1)}
            </span>
          {/if}
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium">{templateName(template.id)}</span>
            <span class="block truncate text-xs text-muted-foreground">
              {templateHost(template)}
            </span>
          </span>
          <ChevronRight class="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
      {/each}
    </div>
  {:else}
    <div class="space-y-4" data-testid="provider-add-custom-form">
      <p class="text-xs text-muted-foreground">{t('settings.templateCustomFormHint')}</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for="provider-custom-name">{t('settings.customName')}</Label>
          <Input id="provider-custom-name" bind:value={customName} data-testid="provider-custom-name" />
        </div>
        <div class="grid gap-1.5">
          <Label for="provider-custom-id">{t('settings.customId')}</Label>
          <Input
            id="provider-custom-id"
            placeholder="my-provider"
            bind:value={customId}
            data-testid="provider-custom-id"
          />
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for="provider-custom-base-url">{t('settings.customBaseUrl')}</Label>
        <Input
          id="provider-custom-base-url"
          placeholder="https://api.example.com/v1"
          bind:value={customBaseUrl}
          data-testid="provider-custom-base-url"
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="provider-custom-api">{t('settings.providerApiLabel')}</Label>
        <Select.Root type="single" bind:value={customApi}>
          <Select.Trigger
            class="w-full"
            id="provider-custom-api"
            aria-label={t('settings.providerApiLabel')}
            data-testid="provider-custom-api"
          >
            {t(`settings.providerApi.${customApi}`)}
          </Select.Trigger>
          <Select.Content>
            {#each API_OPTIONS as option (option)}
              <Select.Item value={option}>{t(`settings.providerApi.${option}`)}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <p class="text-xs text-muted-foreground">{t('settings.providerApiHint')}</p>
      </div>
      <div class="grid gap-1.5">
        <Label for="provider-custom-key">{t('settings.providerKey')}</Label>
        <Input
          id="provider-custom-key"
          type="password"
          placeholder={t('settings.customKeyPlaceholder')}
          bind:value={customKey}
          data-testid="provider-custom-key"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={fetching || busy || customBaseUrl.trim().length === 0}
          onclick={() => void fetchCustomModels()}
          data-testid="provider-custom-fetch"
        >
          <Download class="size-4" />
          {fetching ? t('settings.fetchingModels') : t('settings.fetchModels')}
        </Button>
        {#if customFetched.length > 0}
          <button
            type="button"
            class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onclick={() => (fetchDialogOpen = true)}
            data-testid="provider-custom-fetched-count"
          >
            {t('settings.fetchModelsPicked', { count: customFetched.length })}
          </button>
        {/if}
      </div>
      <div class="flex justify-end gap-2">
        <Button variant="outline" onclick={() => (view = 'templates')} data-testid="provider-custom-cancel">
          {t('settings.cancel')}
        </Button>
        <Button disabled={busy} onclick={() => void addCustom()} data-testid="provider-custom-save">
          {t('settings.save')}
        </Button>
      </div>
    </div>
  {/if}
</div>

<ProviderFetchModelsDialog
  bind:open={fetchDialogOpen}
  models={fetchedModels}
  existingIds={[]}
  initialSelected={customFetched.map((m) => m.id)}
  onConfirm={onFetchedConfirm}
/>

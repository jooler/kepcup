<script lang="ts">
  import type { FetchedProviderModel, ProviderApi, ProviderInstance, ProviderModel } from '@kepcup/shared';
  import { isCustomInstanceId, VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { untrack } from 'svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    formatContextWindow,
    mergeFetchedProviderModels,
    modelCapabilityBadges,
    providerNavStatus,
    PROVIDER_API_OPTIONS,
    settingsWithoutInstance,
  } from './provider-instances';
  import ProviderLogo from './ProviderLogo.svelte';
  import { providerIconForInstance } from './provider-logos';
  import ProviderFetchModelsDialog from './ProviderFetchModelsDialog.svelte';
  import ProviderModelDialog from './ProviderModelDialog.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Select from '$lib/components/ui/select';
  import { Switch } from '$lib/components/ui/switch';
  import { Plus, Trash2, Pencil, Download } from '@lucide/svelte';

  /**
   * 左栏选中某个供应商实例后的详情（ZCode 的 provider card + 模型列表）：
   * 头部（名称、类型、状态点、启停、删除）→ 连接区（baseUrl / 数据风格 /
   * API Key / 测试连接）→ 模型列表（模型 ID + 上下文 badge + 能力 badge +
   * 编辑/删除，「添加模型」出弹框，「获取模型」按线协议拉取远端清单）。
   * baseUrl / 名称 / 启停 / 数据风格（仅自定义实例）即改即存；Key 失焦或回车提交，
   * 已存 Key 行可标注别名（列表态以文字 + 笔图标展示，点击进入编辑，失焦 / 回车
   * 提交、Esc 放弃）与启停（toggle，停用的 Key 调用时跳过）。
   */
  let {
    instanceId,
    onDeleted,
  }: {
    instanceId: string;
    /** 删除后父级回到「模型配置」。 */
    onDeleted: () => void;
  } = $props();

  const instance = $derived(
    settingsStore.settings?.modelProviders.find((p) => p.id === instanceId) ?? null,
  );
  const info = $derived(settingsStore.providers.find((p) => p.id === instanceId) ?? null);
  const keyPreviews = $derived(info?.keyPreviews ?? []);
  const descriptor = $derived(
    instance?.vendor !== undefined && instance.vendor !== null
      ? VENDOR_DESCRIPTORS[instance.vendor]
      : null,
  );
  const status = $derived(
    instance === null ? 'incomplete' : providerNavStatus(instance, info?.hasKey ?? false),
  );

  let baseUrl = $state('');
  let appliedBaseUrl = $state<string | null>(null);
  let name = $state('');
  let appliedName = $state<string | null>(null);
  let key = $state('');
  let busy = $state(false);
  let testing = $state(false);
  let removingKeyIndex = $state<number | null>(null);
  /** 别名输入草稿（键 = `${instanceId}:${index}`）：编辑中不被刷新回写覆盖，失焦 / 回车提交。 */
  let aliasDrafts = $state<Record<string, string>>({});
  /** 正在编辑别名的行下标；null = 列表态（别名以文字 + 笔图标展示）。 */
  let editingAliasIndex = $state<number | null>(null);
  /** 编辑中的别名输入框：提交失败后重新聚焦（blur 已发生，autofocus 不会二次生效）。 */
  let aliasInput: HTMLInputElement | null = $state(null);

  $effect(() => {
    const current = instance;
    if (current === null) return;
    if (untrack(() => appliedBaseUrl) !== (current.baseUrl ?? '')) {
      baseUrl = current.baseUrl ?? '';
      appliedBaseUrl = current.baseUrl ?? '';
    }
    if (untrack(() => appliedName) !== current.name) {
      name = current.name;
      appliedName = current.name;
    }
  });

  async function patchInstance(patch: Partial<ProviderInstance>): Promise<void> {
    const settings = settingsStore.settings;
    const current = instance;
    if (settings === null || current === null) return;
    try {
      await settingsStore.update({
        modelProviders: settings.modelProviders.map((p) =>
          p.id === current.id ? { ...p, ...patch } : p,
        ),
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  let baseUrlTimer: ReturnType<typeof setTimeout> | undefined;
  function onBaseUrlInput(): void {
    clearTimeout(baseUrlTimer);
    const value = baseUrl.trim();
    if (value === (instance?.baseUrl ?? '')) return;
    baseUrlTimer = setTimeout(() => {
      try {
        const url = new URL(value);
        void patchInstance({ baseUrl: url.toString() });
      } catch {
        // 非法 URL 不落盘；失焦校验提示在 blur 里给。
      }
    }, 600);
  }
  function onBaseUrlBlur(): void {
    const value = baseUrl.trim();
    if (value.length === 0 || instance === null) return;
    try {
      new URL(value);
    } catch {
      toast.error(t('settings.providerBaseUrlInvalid'));
      baseUrl = instance.baseUrl ?? '';
    }
  }

  async function commitName(): Promise<void> {
    if (instance === null) return;
    const value = name.trim();
    if (value.length === 0 || value === instance.name) return;
    await patchInstance({ name: value });
  }

  function onNameKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  /** Key 提交（失焦 / 回车）：追加一个 Key（多 Key 轮流使用），值落 secrets 表。 */
  async function commitKey(): Promise<void> {
    const value = key.trim();
    if (instance === null || value.length === 0 || busy) return;
    busy = true;
    try {
      await settingsStore.addKey(instance.id, value);
      key = '';
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  async function removeKeyAt(index: number): Promise<void> {
    if (instance === null || removingKeyIndex !== null) return;
    removingKeyIndex = index;
    try {
      await settingsStore.removeKeyAt(instance.id, index);
      clearAliasDrafts();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      removingKeyIndex = null;
    }
  }

  function aliasDraftKey(index: number): string {
    return `${instance?.id ?? ''}:${index}`;
  }

  /** 增删 Key 后下标会移位，丢弃本实例的别名草稿与编辑态（已提交的值在刷新里回显）。 */
  function clearAliasDrafts(): void {
    const prefix = `${instance?.id ?? ''}:`;
    for (const draftKey of Object.keys(aliasDrafts)) {
      if (draftKey.startsWith(prefix)) delete aliasDrafts[draftKey];
    }
    editingAliasIndex = null;
  }

  /** 进入别名编辑：草稿预填当前别名。删除进行中不进入（下标即将移位）。 */
  function startEditAlias(index: number): void {
    if (removingKeyIndex !== null) return;
    const preview = keyPreviews[index];
    if (preview === undefined) return;
    aliasDrafts[aliasDraftKey(index)] = preview.alias ?? '';
    editingAliasIndex = index;
  }

  /** 退出别名编辑且不保存（Esc）。 */
  function cancelAliasEdit(): void {
    if (editingAliasIndex === null) return;
    delete aliasDrafts[aliasDraftKey(editingAliasIndex)];
    editingAliasIndex = null;
  }

  /** 别名提交（失焦 / 回车）：空串清除别名，其余 trim 后落库；未改动时仅退出编辑。 */
  async function commitAlias(index: number): Promise<void> {
    const current = instance;
    const preview = keyPreviews[index];
    const draftKey = aliasDraftKey(index);
    const draft = aliasDrafts[draftKey];
    const exitEdit = () => {
      if (editingAliasIndex === index) editingAliasIndex = null;
    };
    if (current === null || preview === undefined || draft === undefined) {
      exitEdit();
      return;
    }
    const value = draft.trim();
    if (value === (preview.alias ?? '')) {
      delete aliasDrafts[draftKey];
      exitEdit();
      return;
    }
    try {
      await settingsStore.setKeyMeta(current.id, index, { alias: value });
      delete aliasDrafts[draftKey];
      exitEdit();
    } catch (error) {
      // 提交失败保持编辑态，草稿留在输入框里可改后重试；blur 已发生，重新聚焦。
      toast.error(String((error as Error).message ?? error));
      aliasInput?.focus();
    }
  }

  /** 启停单个 Key：停用的 Key 调用时跳过（全部停用 = 无可用 Key）。失败时用权威状态回写开关。 */
  async function toggleKeyAt(index: number, checked: boolean): Promise<void> {
    const current = instance;
    if (current === null) return;
    try {
      await settingsStore.setKeyMeta(current.id, index, { enabled: checked });
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
      // Switch 点击即本地翻转；失败时强制刷新，让开关回到 core 的实际状态。
      await settingsStore.refresh().catch(() => undefined);
    }
  }

  function onKeyKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  /** 别名输入：回车 = 提交（blur 触发 commitAlias），Esc = 放弃编辑。 */
  function onAliasKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelAliasEdit();
    }
  }

  /** 测试连接：实例登记了对话模型 → 对话探测；否则 core 按能力配置路由。 */
  async function test(): Promise<void> {
    if (instance === null) return;
    testing = true;
    try {
      await settingsStore.test(instance.id);
      toast.success(t('settings.testOk'));
    } catch (error) {
      toast.error(
        t('settings.testFailed', { reason: String((error as Error).message ?? '') }),
      );
    } finally {
      testing = false;
    }
  }

  async function removeProvider(): Promise<void> {
    const settings = settingsStore.settings;
    const current = instance;
    if (settings === null || current === null) return;
    busy = true;
    try {
      await settingsStore.update(settingsWithoutInstance(settings, current.id));
      await settingsStore.removeKey(current.id);
      toast.success(t('settings.saved'));
      onDeleted();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  // --- 模型列表 -------------------------------------------------------------
  // builtinCatalog 实例的模型清单来自 pi 内置目录（providers.list），只读展示。
  const displayModels = $derived(
    instance?.builtinCatalog === true ? (info?.models ?? []) : (instance?.models ?? null),
  );
  let modelDialogOpen = $state(false);
  /** null = 新增；否则是被编辑的模型 id。 */
  let editingModelId = $state<string | null>(null);

  function openAddModel(): void {
    editingModelId = null;
    modelDialogOpen = true;
  }
  function openEditModel(model: ProviderModel): void {
    editingModelId = model.id;
    modelDialogOpen = true;
  }
  const editingModel = $derived(
    instance?.models.find((m) => m.id === editingModelId) ?? null,
  );

  // --- 获取模型 ---------------------------------------------------------------
  // 按实例的线协议拉取远端可用模型（Key 用已存的，core 解析）；已登记条目在
  // 弹框里只读展示，确认后只新增不覆盖（mergeFetchedProviderModels）。
  let fetchingModels = $state(false);
  let fetchedModels = $state<FetchedProviderModel[]>([]);
  let fetchDialogOpen = $state(false);

  /** 拉取端点：实例 baseUrl 优先（vendor 实例兜底描述符默认根）。 */
  const fetchBaseUrl = $derived(instance?.baseUrl ?? descriptor?.baseUrl ?? null);

  async function fetchInstanceModels(): Promise<void> {
    const current = instance;
    const baseUrl = fetchBaseUrl;
    if (current === null || baseUrl === null || fetchingModels) return;
    fetchingModels = true;
    try {
      const models = await settingsStore.fetchModels({
        provider: current.id,
        baseUrl,
        api: current.api,
      });
      if (models.length === 0) {
        toast.error(t('settings.fetchModelsEmpty'));
        return;
      }
      fetchedModels = models;
      fetchDialogOpen = true;
    } catch (error) {
      toast.error(
        t('settings.fetchModelsFailed', { reason: String((error as Error).message ?? '') }),
      );
    } finally {
      fetchingModels = false;
    }
  }

  async function onFetchedConfirm(picked: FetchedProviderModel[]): Promise<void> {
    const current = instance;
    if (current === null) return;
    await patchInstance({ models: mergeFetchedProviderModels(current, picked) });
    toast.success(t('settings.saved'));
  }

  async function removeModel(modelId: string): Promise<void> {
    const settings = settingsStore.settings;
    const current = instance;
    if (settings === null || current === null) return;
    try {
      await settingsStore.update({
        modelProviders: settings.modelProviders.map((p) =>
          p.id === current.id
            ? { ...p, models: p.models.filter((m) => m.id !== modelId) }
            : p,
        ),
      });
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    }
  }
</script>

{#if instance !== null}
  {@const icon = providerIconForInstance(instance)}
  <div class="min-w-0 space-y-5" data-testid={`provider-detail-${instance.id}`}>
    <!-- 头部：名称 / 类型 / 状态 / 启停 / 删除 -->
    <div class="flex flex-wrap items-center gap-2">
      {#if icon !== undefined}
        <ProviderLogo icon={icon} class="size-6 shrink-0 rounded object-contain" />
      {/if}
      <h3 class="text-sm font-semibold">{instance.name}</h3>
      <Badge variant="outline">
        {instance.vendor === null
          ? t('settings.providerKindCustom')
          : t('settings.providerKindVendor')}
      </Badge>
      <span
        class="size-2 rounded-full {status === 'ready'
          ? 'bg-emerald-500'
          : status === 'incomplete'
            ? 'bg-amber-500'
            : 'bg-muted-foreground/40'}"
        title={t(`settings.providerStatus.${status}`)}
        data-testid={`provider-status-${instance.id}`}
      ></span>
      <label class="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={instance.enabled}
          onCheckedChange={(checked) => void patchInstance({ enabled: checked === true })}
          data-testid={`provider-enabled-${instance.id}`}
        />
        {t('settings.providerEnabled')}
      </label>
      <Button
        size="sm"
        variant="ghost"
        class="text-destructive hover:text-destructive"
        disabled={busy}
        onclick={() => void removeProvider()}
        data-testid={`provider-remove-${instance.id}`}
      >
        <Trash2 class="size-4" />
        {t('settings.providerDelete')}
      </Button>
    </div>

    <!-- 连接区 -->
    <section class="space-y-3 rounded-xl border px-4 py-3.5" data-testid={`provider-connection-${instance.id}`}>
      {#if descriptor === null}
        <!-- 自定义实例：名称可改（内置厂商实例跟随厂商名）。 -->
        <div class="grid gap-1.5">
          <Label for={`provider-name-${instance.id}`}>{t('settings.customName')}</Label>
          <Input
            id={`provider-name-${instance.id}`}
            bind:value={name}
            onblur={() => void commitName()}
            onkeydown={onNameKeydown}
            data-testid={`provider-name-${instance.id}`}
          />
        </div>
      {/if}
      {#if !instance.builtinCatalog}
        <div class="grid gap-1.5">
          <Label for={`provider-base-url-${instance.id}`}>{t('settings.providerBaseUrl')}</Label>
          <Input
            id={`provider-base-url-${instance.id}`}
            placeholder={descriptor?.baseUrl ?? 'https://api.example.com/v1'}
            bind:value={baseUrl}
            oninput={onBaseUrlInput}
            onblur={onBaseUrlBlur}
            data-testid={`provider-base-url-${instance.id}`}
          />
          <p class="text-xs text-muted-foreground">{t('settings.providerBaseUrlHint')}</p>
        </div>
      {:else}
        <p class="text-xs text-muted-foreground">{t('settings.providerBuiltinCatalogHint')}</p>
      {/if}
      {#if isCustomInstanceId(instance.id) && !instance.builtinCatalog}
        <!-- 仅自定义实例可改数据风格（预置厂商实例的线协议由模板固定——注意
             目录模板实例同样是 vendor:null，不能用 descriptor 判别）；改后注册表按新协议重建。 -->
        <div class="grid gap-1.5">
          <Label for={`provider-api-${instance.id}`}>{t('settings.providerApiLabel')}</Label>
          <Select.Root
            type="single"
            value={instance.api}
            onValueChange={(value) => {
              if (value !== undefined) void patchInstance({ api: value as ProviderApi });
            }}
          >
            <Select.Trigger
              class="w-full"
              id={`provider-api-${instance.id}`}
              aria-label={t('settings.providerApiLabel')}
              data-testid={`provider-api-${instance.id}`}
            >
              {t(`settings.providerApi.${instance.api}`)}
            </Select.Trigger>
            <Select.Content>
              {#each PROVIDER_API_OPTIONS as option (option)}
                <Select.Item value={option}>{t(`settings.providerApi.${option}`)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <p class="text-xs text-muted-foreground">{t('settings.providerApiHint')}</p>
        </div>
      {/if}
      <div class="grid gap-1.5">
        <Label for={`provider-key-${instance.id}`}>{t('settings.providerKey')}</Label>
        <Input
          id={`provider-key-${instance.id}`}
          type="password"
          placeholder={t('settings.providerKeyAddPlaceholder')}
          bind:value={key}
          onblur={() => void commitKey()}
          onkeydown={onKeyKeydown}
          data-testid={`provider-key-${instance.id}`}
        />
        {#if keyPreviews.length > 0}
          <p class="text-xs text-muted-foreground">
            {t('settings.providerKeyCount', { count: keyPreviews.length })}
          </p>
          {#if keyPreviews.some((preview) => !preview.enabled)}
            <p class="text-xs text-muted-foreground">
              {t('settings.providerKeyDisabledCount', {
                count: keyPreviews.filter((preview) => !preview.enabled).length,
              })}
            </p>
          {/if}
          <ul class="space-y-1">
            {#each keyPreviews as preview, index (index)}
              <li
                class="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1 {preview.enabled
                  ? ''
                  : 'opacity-55'}"
                data-testid={`provider-key-item-${instance.id}-${index}`}
              >
                {#if editingAliasIndex === index}
                  <Input
                    bind:ref={aliasInput}
                    class="h-7 w-32 shrink-0 text-xs"
                    placeholder={t('settings.providerKeyAliasPlaceholder')}
                    aria-label={t('settings.providerKeyAlias')}
                    value={aliasDrafts[aliasDraftKey(index)] ?? preview.alias ?? ''}
                    oninput={(event) =>
                      (aliasDrafts[aliasDraftKey(index)] = event.currentTarget.value)}
                    onblur={() => void commitAlias(index)}
                    onkeydown={onAliasKeydown}
                    autofocus
                    data-testid={`provider-key-alias-${instance.id}-${index}`}
                  />
                {:else}
                  <!-- 列表态：别名以文字展示（未设置时显示占位），点笔图标进入编辑。 -->
                  <button
                    type="button"
                    class="group flex max-w-44 min-w-0 cursor-pointer items-center gap-1 rounded text-left text-xs {preview.alias
                      ? ''
                      : 'text-muted-foreground/60'}"
                    onclick={() => startEditAlias(index)}
                    title={t(
                      preview.alias
                        ? 'settings.providerKeyAliasEdit'
                        : 'settings.providerKeyAliasAdd',
                    )}
                    data-testid={`provider-key-alias-${instance.id}-${index}`}
                  >
                    <span class="truncate">
                      {preview.alias ?? t('settings.providerKeyAliasAdd')}
                    </span>
                    <Pencil
                      class="size-3 shrink-0 text-muted-foreground {preview.alias
                        ? 'opacity-60 group-hover:opacity-100'
                        : 'opacity-40 group-hover:opacity-100'}"
                    />
                  </button>
                {/if}
                <code class="min-w-0 flex-1 truncate text-xs">{preview.mask}</code>
                <span
                  class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                  title={t('settings.providerKeyToggle')}
                >
                  <Switch
                    checked={preview.enabled}
                    onCheckedChange={(checked) => void toggleKeyAt(index, checked)}
                    aria-label={t('settings.providerKeyToggle')}
                    data-testid={`provider-key-toggle-${instance.id}-${index}`}
                  />
                  <!-- button 不是 labelable 元素，文字点击显式转发为启停。 -->
                  <button
                    type="button"
                    class="cursor-pointer"
                    onclick={() => void toggleKeyAt(index, !preview.enabled)}
                  >
                    {t('settings.providerKeyEnabled')}
                  </button>
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  class="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={removingKeyIndex !== null}
                  aria-label={t('settings.providerKeyRemove')}
                  onclick={() => void removeKeyAt(index)}
                  data-testid={`provider-key-remove-${instance.id}-${index}`}
                >
                  <Trash2 class="size-3.5" />
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if descriptor !== null}
          <p class="text-xs text-muted-foreground">
            {t('settings.vendorKeyHint', { url: descriptor.consoleUrl })}
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">{t('settings.customKeyHint')}</p>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={testing}
          onclick={() => void test()}
          data-testid={`provider-test-${instance.id}`}
        >
          {testing ? t('settings.testing') : t('settings.test')}
        </Button>
        <p class="text-xs text-muted-foreground">{t('settings.providerTestNote')}</p>
      </div>
    </section>

    <!-- 模型列表 -->
    <section class="space-y-3" data-testid={`provider-models-${instance.id}`}>
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-sm font-medium">{t('settings.providerModelsLabel')}</h4>
        {#if !instance.builtinCatalog}
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={fetchingModels || fetchBaseUrl === null}
              onclick={() => void fetchInstanceModels()}
              data-testid={`provider-fetch-models-${instance.id}`}
            >
              <Download class="size-4" />
              {fetchingModels ? t('settings.fetchingModels') : t('settings.fetchModels')}
            </Button>
            <Button size="sm" variant="outline" onclick={openAddModel} data-testid={`provider-add-model-${instance.id}`}>
              <Plus class="size-4" />
              {t('settings.providerAddModel')}
            </Button>
          </div>
        {/if}
      </div>
      {#if (displayModels ?? []).length === 0}
        <div
          class="flex h-20 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          data-testid={`provider-models-empty-${instance.id}`}
        >
          {instance.builtinCatalog
            ? t('settings.providerModelsCatalogEmpty')
            : t('settings.providerModelsEmpty')}
        </div>
      {:else}
        <div class="divide-y rounded-xl border px-4">
          {#each displayModels ?? [] as model (model.id)}
            <div class="flex flex-wrap items-center gap-2 py-3" data-testid={`provider-model-row-${instance.id}-${model.id}`}>
              <span class="font-mono text-sm">{model.name ?? model.id}</span>
              <Badge variant="outline">{formatContextWindow(model.contextWindow)}</Badge>
              {#each modelCapabilityBadges(model.capabilities) as capability (capability)}
                <Badge>{t(`settings.capability.${capability}`)}</Badge>
              {/each}
              {#if !instance.builtinCatalog}
                <div class="ml-auto flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onclick={() => openEditModel(model)}
                    title={t('settings.edit')}
                    data-testid={`provider-model-edit-${instance.id}-${model.id}`}
                  >
                    <Pencil class="size-4" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    class="text-destructive hover:text-destructive"
                    onclick={() => void removeModel(model.id)}
                    title={t('settings.remove')}
                    data-testid={`provider-model-remove-${instance.id}-${model.id}`}
                  >
                    <Trash2 class="size-4" />
                  </Button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <ProviderModelDialog
    bind:open={modelDialogOpen}
    instanceId={instance.id}
    model={editingModel}
  />

  <ProviderFetchModelsDialog
    bind:open={fetchDialogOpen}
    models={fetchedModels}
    existingIds={instance.models.map((m) => m.id)}
    onConfirm={(picked) => void onFetchedConfirm(picked)}
  />
{/if}

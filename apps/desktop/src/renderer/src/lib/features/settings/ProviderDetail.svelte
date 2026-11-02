<script lang="ts">
  import type { ProviderInstance, ProviderModel } from '@kepcup/shared';
  import { VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { untrack } from 'svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    formatContextWindow,
    modelCapabilityBadges,
    providerNavStatus,
    settingsWithoutInstance,
  } from './provider-instances';
  import { providerLogo } from './provider-logos';
  import ProviderModelDialog from './ProviderModelDialog.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Plus, Trash2, Pencil } from '@lucide/svelte';

  /**
   * 左栏选中某个供应商实例后的详情（ZCode 的 provider card + 模型列表）：
   * 头部（名称、类型、状态点、启停、删除）→ 连接区（baseUrl / API Key /
   * 测试连接）→ 模型列表（模型 ID + 上下文 badge + 能力 badge + 编辑/删除，
   * 「添加模型」出弹框）。baseUrl / 名称 / 启停即改即存；Key 失焦或回车提交。
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

  /** Key 提交（失焦 / 回车）：值落 secrets 表，永不进 settings。 */
  async function commitKey(): Promise<void> {
    if (instance === null || key.length === 0 || busy) return;
    busy = true;
    try {
      await settingsStore.setKey(instance.id, key);
      key = '';
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  function onKeyKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
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
  <div class="min-w-0 space-y-5" data-testid={`provider-detail-${instance.id}`}>
    <!-- 头部：名称 / 类型 / 状态 / 启停 / 删除 -->
    <div class="flex flex-wrap items-center gap-2">
      {#if providerLogo(instance.logo) !== undefined}
        <img
          src={providerLogo(instance.logo)}
          alt=""
          class="size-6 shrink-0 rounded object-contain"
        />
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
      <div class="grid gap-1.5">
        <Label for={`provider-key-${instance.id}`}>{t('settings.providerKey')}</Label>
        <Input
          id={`provider-key-${instance.id}`}
          type="password"
          placeholder={
            info?.hasKey ? t('settings.providerKeySet') : t('settings.providerKeyPlaceholder')
          }
          bind:value={key}
          onblur={() => void commitKey()}
          onkeydown={onKeyKeydown}
          data-testid={`provider-key-${instance.id}`}
        />
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
          <Button size="sm" variant="outline" onclick={openAddModel} data-testid={`provider-add-model-${instance.id}`}>
            <Plus class="size-4" />
            {t('settings.providerAddModel')}
          </Button>
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
{/if}

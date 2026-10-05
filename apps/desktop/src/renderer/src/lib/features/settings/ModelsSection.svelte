<script lang="ts">
  import type { ProviderInfo } from '@kepcup/shared';
  import { AppError, isVendorId, VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { Plus } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import CapabilityModelSection from './CapabilityModelSection.svelte';
  import ModelSelectField from './ModelSelectField.svelte';
  import ProviderSetupForm from './ProviderSetupForm.svelte';

  /**
   * 设置弹框「模型」分组（docs/design/16-capability-models.md）：
   * 默认模型（主/轻量）→ 并发 → 厂商（内置/自定义/国内厂商，条目只登记
   * 对话模型）→ 能力模型（向量/重排/多模态/语音识别/语音生成/图片/视频，
   * 每种能力一条「厂商 + 模型 + Key」配置）→ 向量来源（EmbeddingSection）。
   * 厂商表单拆在 ProviderSetupForm（对话内设置卡片复用同一份保存逻辑）；
   * 默认模型下拉拆在 ModelSelectField。国内厂商弹框只登记对话模型；媒体
   * 端点差异全部由 core 适配层承担。
   */
  let mainModel = $state('');
  let lightModel = $state('');
  let concurrency = $state(4);
  let testingProvider = $state<string | null>(null);

  const configuredProviders = $derived(
    settingsStore.providers.filter((provider) => provider.kind === 'custom' || provider.hasKey),
  );

  // --- 新增 / 设置 Key / 编辑厂商模型 弹框 -----------------------------------
  type AddDialogMode = 'add' | 'key' | 'edit';
  let addOpen = $state(false);
  let addMode = $state<AddDialogMode>('add');
  /** key 模式锁定的厂商；add/edit 模式下当前选中的厂商 id 或 'custom'。 */
  let addTarget = $state('');

  const addTargetProvider = $derived(
    settingsStore.providers.find((provider) => provider.id === addTarget) ?? null,
  );
  const addVendorDescriptor = $derived(
    addMode !== 'key' && isVendorId(addTarget) ? VENDOR_DESCRIPTORS[addTarget] : null,
  );

  $effect(() => {
    const settings = settingsStore.settings;
    if (!settings) return;
    mainModel = settings.defaultMainModel;
    lightModel = settings.defaultLightModel;
    concurrency = settings.providerConcurrency.default;
  });

  async function saveModels(): Promise<void> {
    await settingsStore.update({
      defaultMainModel: mainModel,
      defaultLightModel: lightModel,
    });
    toast.success(t('settings.saved'));
  }

  async function saveConcurrency(): Promise<void> {
    const current = settingsStore.settings;
    if (!current) return;
    await settingsStore.update({
      providerConcurrency: { ...current.providerConcurrency, default: concurrency },
    });
    toast.success(t('settings.saved'));
  }

  async function removeKey(providerId: string): Promise<void> {
    await settingsStore.removeKey(providerId);
  }

  /** 卡片「测试连接」：对话探测；未登记对话模型时按能力配置路由（core 端）。 */
  async function test(provider: ProviderInfo): Promise<void> {
    testingProvider = provider.id;
    try {
      await settingsStore.test(provider.id);
      toast.success(t('settings.testOk'));
    } catch (error) {
      toast.error(testFailMessage(error));
    } finally {
      testingProvider = null;
    }
  }

  function testFailMessage(error: unknown): string {
    const code = error instanceof AppError ? error.code : 'PROVIDER_UNAVAILABLE';
    return t('settings.testFailed', {
      reason:
        code === 'PROVIDER_AUTH_FAILED'
          ? t('chats.errorCode.PROVIDER_AUTH_FAILED')
          : String((error as Error).message ?? ''),
    });
  }

  function openAddDialog(): void {
    addMode = 'add';
    // 国内厂商置顶且作为默认选项；其余未配置内置厂商与自定义随后。
    addTarget = 'dashscope';
    addOpen = true;
  }

  function openKeyDialog(provider: ProviderInfo): void {
    addMode = 'key';
    addTarget = provider.id;
    addOpen = true;
  }

  /** 编辑国内厂商的对话模型登记（key 留空 = 保持不变）。 */
  function openEditVendorDialog(provider: ProviderInfo): void {
    if (!isVendorId(provider.id)) return;
    addMode = 'edit';
    addTarget = provider.id;
    addOpen = true;
  }

  /** 弹框表单保存成功：关弹框 + 成功提示（表单内部负责错误提示）。 */
  function dialogSaved(): void {
    addOpen = false;
    toast.success(t('settings.saved'));
  }

  async function removeCustom(providerId: string): Promise<void> {
    const current = settingsStore.settings;
    if (!current) return;
    const id = providerId.startsWith('custom:') ? providerId.slice('custom:'.length) : providerId;
    await settingsStore.update({
      customProviders: current.customProviders.filter((c) => c.id !== id),
    });
    await settingsStore.refresh();
  }

  /**
   * 删除国内厂商配置：条目 + key + 引用该厂商的能力模型配置一并清理。
   */
  async function removeVendor(providerId: string): Promise<void> {
    const current = settingsStore.settings;
    if (!current || !isVendorId(providerId)) return;
    const capabilityModels = { ...current.capabilityModels };
    for (const key of Object.keys(capabilityModels) as Array<keyof typeof capabilityModels>) {
      if (capabilityModels[key]?.vendor === providerId) capabilityModels[key] = null;
    }
    await settingsStore.update({
      vendorProviders: current.vendorProviders.filter((v) => v.id !== providerId),
      capabilityModels,
    });
    await settingsStore.removeKey(providerId);
  }
</script>

<div class="space-y-6" data-testid="settings-models">
  <section class="space-y-3" data-testid="settings-default-models">
    <h3 class="text-sm font-medium">{t('settings.modelsSection')}</h3>
    <div class="divide-y rounded-xl border px-4">
      <div class="flex items-center justify-between gap-4 py-3.5">
        <span class="text-sm" id="default-main-label">{t('settings.defaultMainModel')}</span>
        <div class="w-64 max-w-[60%]">
          <ModelSelectField bind:value={mainModel} testid="default-main-model" labelledBy="default-main-label" />
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 py-3.5">
        <span class="text-sm" id="default-light-label">{t('settings.defaultLightModel')}</span>
        <div class="w-64 max-w-[60%]">
          <ModelSelectField bind:value={lightModel} testid="default-light-model" labelledBy="default-light-label" />
        </div>
      </div>
    </div>
    <Button size="sm" onclick={saveModels} data-testid="save-models">{t('settings.save')}</Button>
    <div class="flex items-end gap-3">
      <div class="grid gap-1.5">
        <Label for="concurrency">{t('settings.concurrency')}</Label>
        <Input
          id="concurrency"
          type="number"
          min="1"
          max="16"
          class="w-24"
          bind:value={concurrency}
          data-testid="provider-concurrency"
        />
      </div>
      <Button variant="outline" size="sm" onclick={saveConcurrency}>{t('settings.save')}</Button>
    </div>
  </section>

  <section class="space-y-3" data-testid="settings-providers">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-medium">{t('settings.providersSection')}</h3>
      <Button
        size="icon-sm"
        variant="outline"
        onclick={openAddDialog}
        title={t('settings.addProviderTitle')}
        data-testid="provider-add"
      >
        <Plus class="size-4" />
      </Button>
    </div>
    <p class="text-xs text-muted-foreground">{t('settings.providersHint')}</p>
    {#if configuredProviders.length === 0}
      <div
        class="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
        data-testid="settings-providers-empty"
      >
        {t('settings.providersEmpty')}
      </div>
    {:else}
      <div class="grid gap-3 sm:grid-cols-2">
        {#each configuredProviders as provider (provider.id)}
          <div
            class="flex flex-col gap-3 rounded-xl border p-4 transition-colors hover:bg-accent/30"
            data-testid={`provider-${provider.id}`}
          >
            <div class="space-y-1">
              <p class="text-sm font-medium break-words">{provider.name}</p>
              <div class="flex flex-wrap items-center gap-2">
                <Badge variant="outline" data-testid={`provider-kind-${provider.id}`}>
                  {provider.kind === 'custom'
                    ? 'custom'
                    : provider.kind === 'vendor'
                      ? t('settings.providerKindVendor')
                      : 'builtin'}
                </Badge>
                {#if provider.hasKey}
                  <span
                    class="text-xs text-muted-foreground"
                    data-testid={`key-state-${provider.id}`}
                  >
                    {t('settings.providerKeySet')}
                  </span>
                {/if}
              </div>
            </div>
            <p class="truncate text-xs text-muted-foreground">
              {provider.baseUrl ?? t('settings.modelsCount', { count: provider.models.length })}
            </p>
            {#if provider.kind === 'vendor' && provider.models.length > 0}
              <p
                class="truncate text-xs text-muted-foreground"
                data-testid={`vendor-models-${provider.id}`}
              >
                {provider.models.map((m) => m.id).join(' · ')}
              </p>
            {/if}
            <div class="mt-auto flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onclick={() => openKeyDialog(provider)}
                data-testid={`key-dialog-${provider.id}`}
              >
                {provider.hasKey ? t('settings.rotateKey') : t('settings.setKey')}
              </Button>
              {#if provider.kind === 'vendor'}
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => openEditVendorDialog(provider)}
                  data-testid={`vendor-edit-${provider.id}`}
                >
                  {t('settings.editVendorModels')}
                </Button>
              {/if}
              <Button
                size="sm"
                variant="secondary"
                disabled={testingProvider === provider.id}
                onclick={() => void test(provider)}
                data-testid={`provider-test-${provider.id}`}
              >
                {testingProvider === provider.id ? t('settings.testing') : t('settings.test')}
              </Button>
              {#if provider.kind === 'custom'}
                <Button
                  size="sm"
                  variant="ghost"
                  class="text-destructive hover:text-destructive"
                  onclick={() => void removeCustom(provider.id)}
                  data-testid={`custom-remove-${provider.id}`}
                >
                  {t('settings.deleteCustom')}
                </Button>
              {:else if provider.kind === 'vendor'}
                <Button
                  size="sm"
                  variant="ghost"
                  class="text-destructive hover:text-destructive"
                  onclick={() => void removeVendor(provider.id)}
                  data-testid={`vendor-remove-${provider.id}`}
                >
                  {t('settings.deleteVendor')}
                </Button>
              {:else if provider.hasKey}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={() => void removeKey(provider.id)}
                  data-testid={`key-remove-${provider.id}`}
                >
                  {t('settings.remove')}
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="space-y-4" data-testid="settings-capability-models">
    <div class="space-y-1">
      <h3 class="text-sm font-medium">{t('settings.capabilityModelsSection')}</h3>
      <p class="text-xs text-muted-foreground">{t('settings.capabilityModelsHint')}</p>
    </div>
    <CapabilityModelSection capability="embedding" testid="capability-embedding" />
    <CapabilityModelSection capability="rerank" testid="capability-rerank" />
    <CapabilityModelSection capability="multimodal" testid="capability-multimodal" />
    <CapabilityModelSection capability="asr" testid="capability-asr" />
    <CapabilityModelSection capability="tts" testid="capability-tts" />
    <CapabilityModelSection capability="image" testid="capability-image" />
    <CapabilityModelSection capability="video" testid="capability-video" />
  </section>
</div>

<Dialog bind:open={addOpen}>
  <!-- 限高为后方设置弹框（h-[80vh]）的 90%：三行网格，标题与底部按钮固定，中间表单区自滚动；
       表单区 -mr-4 抵消弹框 p-4、滚动条贴弹框右缘，pr-4 保持内容位置不变 -->
  <DialogContent
    class="max-h-[72vh] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
    data-testid="provider-add-dialog"
  >
    <DialogHeader>
      <DialogTitle>
        {addMode === 'key'
          ? t('settings.rotateKeyTitle', { name: addTargetProvider?.name ?? addTarget })
          : addMode === 'edit'
            ? t('settings.editVendorTitle', { name: addVendorDescriptor?.name ?? addTarget })
            : t('settings.addProviderTitle')}
      </DialogTitle>
    </DialogHeader>

    <ProviderSetupForm mode={addMode} target={addTarget} onSaved={dialogSaved} />
  </DialogContent>
</Dialog>

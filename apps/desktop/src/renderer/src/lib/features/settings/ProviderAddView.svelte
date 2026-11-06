<script lang="ts">
  import type { ProviderInstance, ProviderTemplate } from '@kepcup/shared';
  import { createInstanceFromTemplate, PROVIDER_TEMPLATES } from '@kepcup/shared';
  import { customInstanceIdPattern } from '@kepcup/shared';
  import { ArrowLeft, ChevronRight, Plus } from '@lucide/svelte';
  import { i18n, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import { providerIcon } from './provider-logos';
  import { templateAvatarStyle } from './provider-instances';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  /**
   * 「添加供应商」右栏视图（替换原弹框，对齐 ZCode 的模板选择页）：返回头 +
   * 扁平模板卡网格（完整搬运 ZCode 内置目录的同供应商多端点变体，合并
   * pi-ai 内置供应商目录——`builtinCatalog` 卡创建目录实例）+ 「创建自定义
   * 供应商」卡（首位）。点模板即建档（id 自动避让、预填线协议 / 图标 /
   * 预置对话模型，同一模板可重复添加）；自定义卡切到内联表单。创建成功后
   * onCreated(instanceId)（父级选中该实例）。
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

  let customName = $state('');
  let customId = $state('');
  let customBaseUrl = $state('');
  let customKey = $state('');
  let busy = $state(false);

  function resetCustomDraft(): void {
    customName = '';
    customId = '';
    customBaseUrl = '';
    customKey = '';
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
        api: 'openai-completions',
        builtinCatalog: false,
        models: [],
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
          {#if providerIcon(template.logo) !== undefined}
            <ProviderLogo
              logo={template.logo}
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
        <Label for="provider-custom-key">{t('settings.providerKey')}</Label>
        <Input
          id="provider-custom-key"
          type="password"
          placeholder={t('settings.customKeyPlaceholder')}
          bind:value={customKey}
          data-testid="provider-custom-key"
        />
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

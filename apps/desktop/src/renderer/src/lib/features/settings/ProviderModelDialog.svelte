<script lang="ts">
  import type { ModelCapability, ProviderInstance, ProviderModel } from '@kepcup/shared';
  import { VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';

  /**
   * 模型新增 / 编辑弹框（对齐 ZCode 的模型配置弹框，字段按本项目语义裁剪）：
   * 模型 ID（实例内唯一）、显示名、上下文窗口、输入类型（文本恒开 + 图片）、
   * 能力多选（内置厂商实例按描述符能力矩阵限定；自定义实例仅 对话+向量——
   * 重排/图片/语音/视频没有跨厂商的事实标准）。保存 = 在实例的 models 里
   * 按 id upsert；能力槽位的默认选择在「模型配置」里做（弹框内提示）。
   */
  let {
    instanceId,
    /** null = 新增。 */
    model = null,
    open = $bindable(false),
    onSaved,
  }: {
    instanceId: string;
    model?: ProviderModel | null;
    open?: boolean;
    onSaved?: () => void;
  } = $props();

  let modelId = $state('');
  let name = $state('');
  let contextWindow = $state(128_000);
  let inputImage = $state(false);
  let capabilities = $state<string[]>([]);
  let busy = $state(false);

  const instance = $derived(
    settingsStore.settings?.modelProviders.find((p) => p.id === instanceId) ?? null,
  );
  /** 该实例允许声明的能力：内置厂商按描述符能力矩阵；Anthropic 协议端点
   * 仅对话（没有 OpenAI 兼容媒体接口）；其余自定义实例为 对话+向量。 */
  const allowedCapabilities = $derived.by((): ModelCapability[] => {
    const current = instance;
    if (current === undefined || current === null) return ['chat'];
    if (current.vendor !== null) return [...VENDOR_DESCRIPTORS[current.vendor].capabilities];
    if (current.api === 'anthropic-messages' || current.builtinCatalog) return ['chat'];
    return ['chat', 'embedding'];
  });

  // 打开时从 props 播种草稿（open 翻转触发一次）。
  $effect(() => {
    if (!open) return;
    modelId = model?.id ?? '';
    name = model?.name ?? '';
    contextWindow = model?.contextWindow ?? 128_000;
    inputImage = model?.input?.includes('image') ?? false;
    capabilities = [...(model?.capabilities ?? ['chat'])];
  });

  function toggleCapability(capability: string, checked: boolean): void {
    capabilities = checked
      ? [...new Set([...capabilities, capability])]
      : capabilities.filter((c) => c !== capability);
  }

  async function save(): Promise<void> {
    const settings = settingsStore.settings;
    const current = instance;
    if (settings === null || current === null) return;
    const trimmedId = modelId.trim();
    if (trimmedId.length === 0) {
      toast.error(t('settings.modelDialogIdRequired'));
      return;
    }
    const duplicate =
      trimmedId !== (model?.id ?? '') && current.models.some((m) => m.id === trimmedId);
    if (duplicate) {
      toast.error(t('settings.modelDialogIdDuplicate', { id: trimmedId }));
      return;
    }
    const window = Math.floor(Number(contextWindow));
    if (!Number.isFinite(window) || window <= 0) {
      toast.error(t('settings.modelDialogContextInvalid'));
      return;
    }
    if (capabilities.length === 0) {
      toast.error(t('settings.modelDialogCapabilityRequired'));
      return;
    }
    const next: ProviderModel = {
      id: trimmedId,
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      contextWindow: window,
      ...(inputImage ? { input: ['text', 'image'] as const } : {}),
      capabilities: capabilities as ProviderModel['capabilities'],
    };
    busy = true;
    try {
      const models = current.models.some((m) => m.id === next.id)
        ? current.models.map((m) => (m.id === next.id ? next : m))
        : [...current.models, next];
      await settingsStore.update({
        modelProviders: settings.modelProviders.map((p) =>
          p.id === current.id ? { ...p, models } : p,
        ),
      });
      toast.success(t('settings.saved'));
      open = false;
      onSaved?.();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }
</script>

<Dialog bind:open>
  <DialogContent
    class="max-h-[72vh] max-w-lg grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden"
    data-testid="provider-model-dialog"
  >
    <DialogHeader>
      <DialogTitle>
        {model === null ? t('settings.modelDialogAddTitle') : t('settings.modelDialogTitle')}
      </DialogTitle>
    </DialogHeader>

    <div class="-mr-4 min-h-0 space-y-4 overflow-y-auto pr-4 pl-2">
      <div class="grid gap-1.5">
        <Label for="provider-model-id">{t('settings.modelDialogId')}</Label>
        <Input
          id="provider-model-id"
          class="font-mono"
          placeholder="model-id"
          bind:value={modelId}
          data-testid="provider-model-id"
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="provider-model-name">{t('settings.modelDialogName')}</Label>
        <Input
          id="provider-model-name"
          placeholder={t('settings.modelDialogNamePlaceholder')}
          bind:value={name}
          data-testid="provider-model-name"
        />
      </div>
      <div class="grid gap-1.5">
        <Label for="provider-model-context">{t('settings.modelDialogContext')}</Label>
        <Input
          id="provider-model-context"
          type="number"
          min="1"
          bind:value={contextWindow}
          data-testid="provider-model-context"
        />
      </div>

      <div class="grid gap-1.5">
        <Label>{t('settings.modelDialogCapability')}</Label>
        <p class="text-xs text-muted-foreground">{t('settings.modelDialogCapabilityHint')}</p>
        <div class="flex flex-wrap gap-2">
          {#each allowedCapabilities as capability (capability)}
            <label
              class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-accent/40 {capabilities.includes(capability)
                ? 'border-primary/40 bg-accent/40'
                : ''}"
              data-testid={`provider-model-capability-${capability}`}
            >
              <Checkbox
                checked={capabilities.includes(capability)}
                onCheckedChange={(checked) => toggleCapability(capability, checked === true)}
              />
              {t(`settings.capability.${capability}`)}
            </label>
          {/each}
        </div>
      </div>

      <label
        class="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent/40 {inputImage
          ? 'border-primary/40 bg-accent/40'
          : ''}"
        data-testid="provider-model-input-image"
      >
        <Checkbox
          checked={inputImage}
          onCheckedChange={(checked) => (inputImage = checked === true)}
        />
        <span>{t('settings.modelDialogInputImage')}</span>
        <span class="text-xs text-muted-foreground">{t('settings.modelDialogInputImageHint')}</span>
      </label>

      {#if instance?.vendor !== undefined && instance.vendor !== null}
        <p class="text-xs text-muted-foreground">
          {t('settings.modelDialogVendorNote', {
            capabilities: VENDOR_DESCRIPTORS[instance.vendor].capabilities
              .map((c) => t(`settings.capability.${c}`))
              .join(' / '),
          })}
        </p>
      {/if}
    </div>

    <div class="flex items-center justify-end gap-2 pt-2">
      <Button variant="outline" onclick={() => (open = false)} data-testid="provider-model-cancel">
        {t('settings.cancel')}
      </Button>
      <Button disabled={busy} onclick={() => void save()} data-testid="provider-model-save">
        {t('settings.save')}
      </Button>
    </div>
  </DialogContent>
</Dialog>

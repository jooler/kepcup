<script lang="ts">
import type { CapabilityModelKey, VendorId } from '@kepcup/shared';
import { AppError, VENDOR_DESCRIPTORS, vendorsForCapability } from '@kepcup/shared';
import { t } from '$lib/i18n';
import { toast } from 'svelte-sonner';
import { settingsStore } from '$lib/stores/settings.svelte';
import { Button } from '$lib/components/ui/button';
import { Input } from '$lib/components/ui/input';
import { Label } from '$lib/components/ui/label';
import { Badge } from '$lib/components/ui/badge';

  /**
   * 「能力模型」section（docs/design/16-capability-models.md）：一种模型
   * 能力一条配置——厂商（仅已适配该能力的国内厂商）+ 模型 id + API Key
   * （按厂商共享）。保存 / 测试会先落盘（providers.test 只读已存 key）。
   * embedded=true 时隐藏标题与说明（对话内设置卡片自带），保存成功后回调
   * onSaved（inline setup 的继续对话钩子）。
   */
  let {
    capability,
    testid,
    embedded = false,
    onSaved,
  }: {
    capability: CapabilityModelKey;
    /** data-testid 前缀。 */
    testid: string;
    /** 紧凑形态：不渲染 section 标题与说明（对话内卡片场景）。 */
    embedded?: boolean;
    onSaved?: () => void;
  } = $props();

  let vendor = $state<VendorId | ''>('');
  let model = $state('');
  let key = $state('');
  let busy = $state(false);
  let testing = $state(false);

  const vendors = $derived(vendorsForCapability(capability));
  const stored = $derived(settingsStore.settings?.capabilityModels[capability] ?? null);
  const presets = $derived(vendor !== '' ? VENDOR_DESCRIPTORS[vendor].presets[capability] : []);
  const vendorHasKey = $derived(
    vendor !== '' &&
      (settingsStore.providers.find((p) => p.id === vendor)?.hasKey ?? false),
  );
  /** 有未保存的修改（厂商/模型/key 任一变化）；未选厂商时视为未编辑。 */
  const dirty = $derived(
    vendor !== '' &&
      (stored === null || stored.vendor !== vendor || stored.model !== model.trim() || key.length > 0),
  );

  // 同步已存配置到表单；用户编辑中（dirty）不覆盖，避免外部刷新清掉输入。
  $effect(() => {
    const current = settingsStore.settings?.capabilityModels[capability] ?? null;
    if (dirty) return;
    vendor = current?.vendor ?? '';
    model = current?.model ?? '';
    key = '';
  });

  /** 落盘配置与 key（key 留空 = 保持不变）。 */
  async function persist(): Promise<void> {
    const settings = settingsStore.settings;
    if (settings === null) throw new Error('settings unavailable');
    if (vendor === '' || model.trim().length === 0) {
      throw new Error(t('settings.capabilityMissingFields'));
    }
    await settingsStore.update({
      capabilityModels: {
        ...settings.capabilityModels,
        [capability]: { vendor, model: model.trim() },
      },
    });
    if (key.length > 0) {
      await settingsStore.setKey(vendor, key);
      key = '';
    } else {
      await settingsStore.refresh();
    }
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      await persist();
      toast.success(t('settings.saved'));
      onSaved?.();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  /** 先落盘再按能力探测（providers.test 只读已存 key）。 */
  async function test(): Promise<void> {
    testing = true;
    try {
      await persist();
      await settingsStore.test(vendor, model.trim(), capability);
      toast.success(t('settings.testOk'));
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'PROVIDER_UNAVAILABLE';
      toast.error(
        t('settings.testFailed', {
          reason:
            code === 'PROVIDER_AUTH_FAILED'
              ? t('chats.errorCode.PROVIDER_AUTH_FAILED')
              : String((error as Error).message ?? ''),
        }),
      );
    } finally {
      testing = false;
    }
  }

  async function clear(): Promise<void> {
    const settings = settingsStore.settings;
    if (settings === null) return;
    busy = true;
    try {
      await settingsStore.update({
        capabilityModels: {
          ...settings.capabilityModels,
          [capability]: null,
        },
      });
      toast.success(t('settings.saved'));
    } finally {
      busy = false;
    }
  }
</script>

<section class="space-y-3" data-testid={`${testid}-section`}>
  {#if !embedded}
    <h3 class="text-sm font-medium">{t(`settings.capabilityTitle.${capability}`)}</h3>
    <p class="text-xs text-muted-foreground">{t(`settings.capabilityHint.${capability}`)}</p>
  {/if}

  <div class="space-y-3 rounded-xl border px-4 py-3.5">
    <div class="flex flex-wrap items-center gap-2" data-testid={`${testid}-status`}>
      {#if stored === null}
        <Badge variant="outline">{t('settings.capabilityNotConfigured')}</Badge>
      {:else}
        <Badge>{VENDOR_DESCRIPTORS[stored.vendor].name}</Badge>
        <span class="text-xs text-muted-foreground" data-testid={`${testid}-current`}>
          {stored.model}
        </span>
      {/if}
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="grid gap-1.5">
        <Label for={`${testid}-vendor`}>{t('settings.capabilityVendorLabel')}</Label>
        <select
          id={`${testid}-vendor`}
          class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
          bind:value={vendor}
          data-testid={`${testid}-vendor`}
        >
          <option value="">—</option>
          {#each vendors as vendorDescriptor (vendorDescriptor.id)}
            <option value={vendorDescriptor.id}>{vendorDescriptor.name}</option>
          {/each}
        </select>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testid}-model`}>{t('settings.capabilityModelLabel')}</Label>
        <Input
          id={`${testid}-model`}
          class="h-9"
          placeholder={presets[0] ?? 'model-id'}
          bind:value={model}
          list={`${testid}-presets`}
          disabled={vendor === ''}
          data-testid={`${testid}-model`}
        />
        {#if presets.length > 0}
          <datalist id={`${testid}-presets`}>
            {#each presets as preset (preset)}
              <option value={preset}></option>
            {/each}
          </datalist>
        {/if}
      </div>
    </div>

    {#if vendor !== ''}
      <div class="grid gap-1.5">
        <Label for={`${testid}-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testid}-key`}
          class="h-9"
          type="password"
          placeholder={
            vendorHasKey
              ? t('settings.providerKeySet')
              : t('settings.providerKeyPlaceholder')
          }
          bind:value={key}
          data-testid={`${testid}-key`}
        />
        <p class="text-xs text-muted-foreground">
          {t('settings.vendorKeyHint', { url: VENDOR_DESCRIPTORS[vendor].consoleUrl })}
        </p>
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={busy || !dirty}
        onclick={() => void save()}
        data-testid={`${testid}-save`}
      >
        {t('settings.save')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || testing || vendor === '' || model.trim().length === 0}
        onclick={() => void test()}
        data-testid={`${testid}-test`}
      >
        {testing ? t('settings.testing') : t('settings.test')}
      </Button>
      {#if stored !== null}
        <Button
          size="sm"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          disabled={busy}
          onclick={() => void clear()}
          data-testid={`${testid}-clear`}
        >
          {t('settings.capabilityClear')}
        </Button>
      {/if}
    </div>
    <p class="text-xs text-muted-foreground">{t('settings.capabilityTestNote')}</p>
  </div>
</section>

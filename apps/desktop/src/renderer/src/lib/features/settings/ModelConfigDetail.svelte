<script lang="ts">
  import { untrack } from 'svelte';
  import type { CapabilityModelKey, ModelCapability } from '@kepcup/shared';
  import { CAPABILITY_MODEL_KEYS } from './capability-keys';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    capabilityModelChoices,
    capabilityProviderCandidates,
    type ProviderNavItem,
  } from './provider-instances';
  import ModelSelectField from './ModelSelectField.svelte';
  import EmbeddingSection from './EmbeddingSection.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { nextLocalFromStore } from './model-defaults-sync';

  /**
   * 左栏「模型配置」条目的详情（非供应商配置的统一去处）：
   * 默认模型（主/轻量 + 组件审查）→ 并发上限 → 能力槽位（每种专有能力一条
   * 「供应商实例 + 模型」默认选择，候选 = 声明了该能力的实例）→ 向量来源
   * （EmbeddingSection）。深链锚点 `default-models` / `embedding` 落在这里。
   */
  let { onOpenProvider }: { onOpenProvider?: (instanceId: string) => void } = $props();

  // --- 默认模型 / 并发（沿用原 ModelsSection 的草稿同步与即改即存） ----------
  let mainModel = $state('');
  let lightModel = $state('');
  let concurrency = $state(4);
  let appliedMain = $state<string | null>(null);
  let appliedLight = $state<string | null>(null);
  let appliedConcurrency = $state<number | null>(null);

  $effect(() => {
    const settings = settingsStore.settings;
    if (!settings) return;
    const localMain = untrack(() => mainModel);
    const localLight = untrack(() => lightModel);
    const localConc = untrack(() => concurrency);
    const main = nextLocalFromStore({
      storeValue: settings.defaultMainModel,
      lastApplied: appliedMain,
      localValue: localMain,
    });
    mainModel = main.localValue;
    appliedMain = main.lastApplied;
    const light = nextLocalFromStore({
      storeValue: settings.defaultLightModel,
      lastApplied: appliedLight,
      localValue: localLight,
    });
    lightModel = light.localValue;
    appliedLight = light.lastApplied;
    const conc = nextLocalFromStore({
      storeValue: String(settings.providerConcurrency.default),
      lastApplied: appliedConcurrency === null ? null : String(appliedConcurrency),
      localValue: String(localConc),
    });
    concurrency = Number(conc.localValue);
    appliedConcurrency = Number(conc.lastApplied);
  });

  async function saveModels(auto = false): Promise<void> {
    const settings = settingsStore.settings;
    const main = mainModel;
    const light = lightModel;
    const unchanged =
      settings !== null && main === settings.defaultMainModel && light === settings.defaultLightModel;
    if (!unchanged) {
      try {
        await settingsStore.update({ defaultMainModel: main, defaultLightModel: light });
        appliedMain = main;
        appliedLight = light;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (!auto) toast.success(t('settings.saved'));
  }

  $effect(() => {
    const settings = settingsStore.settings;
    const main = mainModel;
    const light = lightModel;
    if (!settings) return;
    if (main === settings.defaultMainModel && light === settings.defaultLightModel) return;
    if (appliedMain === null || appliedLight === null) return;
    const timer = setTimeout(() => void saveModels(true), 200);
    return () => clearTimeout(timer);
  });

  async function saveConcurrency(): Promise<void> {
    const current = settingsStore.settings;
    if (!current) return;
    const value = concurrency;
    try {
      await settingsStore.update({
        providerConcurrency: { ...current.providerConcurrency, default: value },
      });
      appliedConcurrency = value;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  $effect(() => {
    const settings = settingsStore.settings;
    const value = concurrency;
    if (!settings) return;
    if (value === settings.providerConcurrency.default) return;
    if (appliedConcurrency === null) return;
    const timer = setTimeout(() => void saveConcurrency(), 600);
    return () => clearTimeout(timer);
  });

  // D87 P3c 组件审查模型：选中即保存；失败回滚到已存值。
  const reviewModel = $derived(settingsStore.settings?.widgetReviewModel ?? '');
  let reviewSaving = $state(false);
  async function saveReviewModel(select: HTMLSelectElement): Promise<void> {
    reviewSaving = true;
    try {
      await settingsStore.update({ widgetReviewModel: select.value });
    } catch (error) {
      select.value = reviewModel;
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      reviewSaving = false;
    }
  }

  // --- 能力槽位（每种专有能力一条默认选择） ---------------------------------

  const hasKeyById = $derived(
    new Map(settingsStore.providers.map((p) => [p.id, p.hasKey] as const)),
  );
  const providerNameById = $derived(
    new Map(settingsStore.providers.map((p) => [p.id, p.name] as const)),
  );
  let slotBusy = $state<Partial<Record<CapabilityModelKey, boolean>>>({});

  function slotCandidates(capability: CapabilityModelKey): ProviderNavItem['instance'][] {
    return capabilityProviderCandidates(
      settingsStore.settings?.modelProviders ?? [],
      capability,
      hasKeyById,
    );
  }

  function slotStored(capability: CapabilityModelKey) {
    return settingsStore.settings?.capabilityModels[capability] ?? null;
  }

  /** 槽位下拉的选项：候选实例 ×（声明模型 + 预置 id）；已存但不在候选里的值补一个兜底项。 */
  function slotOptions(capability: CapabilityModelKey): Array<{ value: string; label: string }> {
    const options: Array<{ value: string; label: string }> = [];
    for (const instance of slotCandidates(capability)) {
      const name = providerNameById.get(instance.id) ?? instance.id;
      for (const model of capabilityModelChoices(instance, capability)) {
        options.push({ value: `${instance.id}/${model}`, label: `${name} · ${model}` });
      }
    }
    const stored = slotStored(capability);
    if (
      stored !== null &&
      !options.some((option) => option.value === `${stored.provider}/${stored.model}`)
    ) {
      options.push({
        value: `${stored.provider}/${stored.model}`,
        label: `${providerNameById.get(stored.provider) ?? stored.provider} · ${stored.model}`,
      });
    }
    return options;
  }

  async function saveSlot(capability: CapabilityModelKey, ref: string): Promise<void> {
    const settings = settingsStore.settings;
    if (!settings) return;
    const slash = ref.indexOf('/');
    const provider = slash > 0 ? ref.slice(0, slash) : '';
    const model = slash > 0 ? ref.slice(slash + 1) : '';
    slotBusy = { ...slotBusy, [capability]: true };
    try {
      await settingsStore.update({
        capabilityModels: {
          ...settings.capabilityModels,
          [capability]:
            provider.length > 0 && model.length > 0 ? { provider, model } : null,
        },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      slotBusy = { ...slotBusy, [capability]: false };
    }
  }

  async function testSlot(capability: CapabilityModelKey): Promise<void> {
    const stored = slotStored(capability);
    if (stored === null) return;
    slotBusy = { ...slotBusy, [capability]: true };
    try {
      await settingsStore.test(stored.provider, stored.model, capability as ModelCapability);
      toast.success(t('settings.testOk'));
    } catch (error) {
      toast.error(
        t('settings.testFailed', {
          reason: String((error as Error).message ?? ''),
        }),
      );
    } finally {
      slotBusy = { ...slotBusy, [capability]: false };
    }
  }
</script>

<div class="min-w-0 space-y-6" data-testid="settings-model-config" data-settings-section="models">
  <section class="space-y-3" data-testid="settings-default-models">
    <div data-settings-anchor="default-models">
      <h3 class="text-sm font-medium">{t('settings.modelsSection')}</h3>
    </div>
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
      <div class="flex items-center justify-between gap-4 py-3.5">
        <div class="min-w-0">
          <span class="text-sm" id="widget-review-model-label">{t('settings.widgetReviewModel')}</span>
          <p class="text-xs text-muted-foreground">{t('settings.widgetReviewModelHint')}</p>
        </div>
        <div class="w-64 max-w-[60%] shrink-0">
          <select
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            aria-labelledby="widget-review-model-label"
            value={reviewModel}
            disabled={reviewSaving}
            onchange={(event) => void saveReviewModel(event.currentTarget)}
            data-testid="widget-review-model-select"
          >
            <option value="">{t('settings.widgetReviewModelFollow')}</option>
            {#each settingsStore.availableModelOptions as option (option.ref)}
              <option value={option.ref}>{option.label}</option>
            {/each}
            {#if reviewModel !== '' && !settingsStore.availableModelOptions.some((option) => option.ref === reviewModel)}
              <option value={reviewModel}>{reviewModel}{t('settings.widgetReviewModelUnavailable')}</option>
            {/if}
          </select>
        </div>
      </div>
      <div class="flex items-center justify-between gap-4 py-3.5">
        <div class="min-w-0">
          <span class="text-sm" id="concurrency-label">{t('settings.concurrency')}</span>
          <p class="text-xs text-muted-foreground">{t('settings.concurrencyHint')}</p>
        </div>
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
    </div>
  </section>

  <section class="space-y-3" data-testid="settings-capability-slots">
    <div class="space-y-1">
      <h3 class="text-sm font-medium">{t('settings.capabilityModelsSection')}</h3>
      <p class="text-xs text-muted-foreground">{t('settings.capabilitySlotsHint')}</p>
    </div>
    <div class="divide-y rounded-xl border px-4">
      {#each CAPABILITY_MODEL_KEYS as capability (capability)}
        {@const stored = slotStored(capability)}
        {@const options = slotOptions(capability)}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 py-3.5" data-testid={`capability-slot-${capability}`}>
          <div class="min-w-40 flex-1 basis-48">
            <span class="text-sm">{t(`settings.capabilityTitle.${capability}`)}</span>
            {#if stored !== null}
              <p class="text-xs text-muted-foreground" data-testid={`capability-slot-current-${capability}`}>
                {providerNameById.get(stored.provider) ?? stored.provider} · {stored.model}
                {#if !(hasKeyById.get(stored.provider) ?? false)}
                  · {t('settings.capabilitySlotKeyMissing')}
                  <button
                    type="button"
                    class="underline underline-offset-2 hover:text-foreground"
                    onclick={() => onOpenProvider?.(stored.provider)}
                  >
                    {t('settings.capabilitySlotGoProvider')}
                  </button>
                {/if}
              </p>
            {:else}
              <p class="text-xs text-muted-foreground">{t(`settings.capabilityHint.${capability}`)}</p>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <select
              class="flex h-9 w-64 max-w-[50vw] rounded-md border border-input bg-background px-3 py-1 text-sm"
              value={stored === null ? '' : `${stored.provider}/${stored.model}`}
              disabled={slotBusy[capability] === true}
              onchange={(event) => void saveSlot(capability, event.currentTarget.value)}
              data-testid={`capability-slot-select-${capability}`}
            >
              <option value="">{t('settings.capabilitySlotPlaceholder')}</option>
              {#each options as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            {#if stored !== null}
              <Button
                size="sm"
                variant="secondary"
                disabled={slotBusy[capability] === true}
                onclick={() => void testSlot(capability)}
                data-testid={`capability-slot-test-${capability}`}
              >
                {t('settings.test')}
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p class="text-xs text-muted-foreground">{t('settings.capabilitySlotFootnote')}</p>
  </section>

  <section data-testid="settings-embedding" data-settings-anchor="embedding">
    <EmbeddingSection />
  </section>
</div>

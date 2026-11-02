<script lang="ts">
  import type { CapabilityModelKey, SettingValues } from '@kepcup/shared';
  import { AppError, VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { capabilityPrefill } from '$lib/features/settings-card/setting-card-model';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import {
    capabilityModelChoices,
    capabilityProviderCandidates,
  } from '$lib/features/settings/provider-instances';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';

  /**
   * 「能力模型」section（docs/design/16-capability-models.md）：一种模型能力
   * 一条配置——供应商实例（候选 = 声明了该能力的实例：内置厂商走描述符能力
   * 矩阵，自定义实例仅向量）+ 模型 id + API Key（按实例共享）。设置页是
   * 「改完即存」：供应商 / 模型输入停顿后自动落盘，Key 在失焦 / 回车时提交
   * （敏感值不逐字存储）；「测试」仍用当前填写的参数发一次最小真实请求，
   * 不落库。embedded=true 时隐藏标题与说明（对话内设置卡片自带），保留
   * 「保存」按钮并在测试成功后换成「保存并关闭」，保存成功后回调 onSaved。
   * prefill：对话内设置卡里 Bot 给的非敏感预填（`provider` / `model`；Key
   * 永远由用户自己填），挂载时套用一次。
   */
  let {
    capability,
    testid,
    embedded = false,
    prefill = null,
    onSaved,
  }: {
    capability: CapabilityModelKey;
    /** data-testid 前缀。 */
    testid: string;
    /** 紧凑形态：不渲染 section 标题与说明（对话内卡片场景）。 */
    embedded?: boolean;
    /** 非敏感预填（对话内设置卡）。 */
    prefill?: SettingValues | null;
    onSaved?: () => void;
  } = $props();

  /** 选中的供应商实例 id（'' = 未选）。 */
  let provider = $state('');
  let model = $state('');
  let key = $state('');
  let busy = $state(false);
  let testing = $state(false);
  /** 测试已用当前参数通过：embedded 下把「保存」换成「保存并关闭」。 */
  let testOk = $state(false);
  /** IME 组合中：暂停模型 id 的自动落盘，避免把未上屏的拼音串存进去。 */
  let composing = $state(false);

  const hasKeyById = $derived(
    new Map(settingsStore.providers.map((p) => [p.id, p.hasKey] as const)),
  );
  const candidates = $derived(
    capabilityProviderCandidates(
      settingsStore.settings?.modelProviders ?? [],
      capability,
      hasKeyById,
    ),
  );
  const providerNameById = $derived(
    new Map(settingsStore.providers.map((p) => [p.id, p.name] as const)),
  );
  const stored = $derived(settingsStore.settings?.capabilityModels[capability] ?? null);
  const choices = $derived.by(() => {
    const instance = candidates.find((entry) => entry.id === provider);
    return instance === undefined ? [] : capabilityModelChoices(instance, capability);
  });
  const providerHasKey = $derived(hasKeyById.get(provider) ?? false);
  /** 有未保存的修改（供应商/模型/key 任一变化）；未选实例时视为未编辑。 */
  const dirty = $derived(
    provider !== '' &&
      (stored === null ||
        stored.provider !== provider ||
        stored.model !== model.trim() ||
        key.length > 0),
  );

  // 表单任何字段一变，「测试通过」即失效（测的是改之前的参数）。
  $effect(() => {
    void provider;
    void model;
    void key;
    testOk = false;
  });

  // 同步已存配置到表单；用户编辑中（dirty）不覆盖，避免外部刷新清掉输入。
  $effect(() => {
    const current = settingsStore.settings?.capabilityModels[capability] ?? null;
    if (dirty) return;
    provider = current?.provider ?? '';
    model = current?.model ?? '';
    key = '';
  });

  // 预填（设置卡）：在上面的同步之后套用一次；与已存值不同即成为「编辑中」，不再被同步覆盖。
  let prefillApplied = false;
  $effect(() => {
    if (prefillApplied || prefill === null) return;
    prefillApplied = true;
    const next = capabilityPrefill(
      prefill,
      candidates.map((entry) => entry.id),
    );
    if (next === null) return;
    untrack(() => {
      provider = next.vendor;
      if (next.model !== null) model = next.model;
    });
  });

  /** 落盘配置与 key（key 留空 = 保持不变）。 */
  async function persist(): Promise<void> {
    const settings = settingsStore.settings;
    if (settings === null) throw new Error('settings unavailable');
    if (provider === '' || model.trim().length === 0) {
      throw new Error(t('settings.capabilityMissingFields'));
    }
    await settingsStore.update({
      capabilityModels: {
        ...settings.capabilityModels,
        [capability]: { provider, model: model.trim() },
      },
    });
    if (key.length > 0) {
      await settingsStore.setKey(provider, key);
      key = '';
    } else {
      await settingsStore.refresh();
    }
  }

  async function save(auto = false): Promise<void> {
    busy = true;
    try {
      await persist();
      if (!auto) toast.success(t('settings.saved'));
      onSaved?.();
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }

  /**
   * 设置页：供应商 / 模型即改即存（800ms 防抖）。Key 不参与自动保存——敏感值
   * 只在失焦或回车时提交一次。embedded 仍等用户点「保存」。
   */
  $effect(() => {
    if (embedded || composing) return;
    const current = settingsStore.settings?.capabilityModels[capability] ?? null;
    const wanted = provider;
    const wantedModel = model.trim();
    if (wanted === '' || wantedModel === '') return;
    if (current !== null && current.provider === wanted && current.model === wantedModel) return;
    const timer = setTimeout(() => void save(true), 800);
    return () => clearTimeout(timer);
  });

  /** 切换供应商后旧模型 id 多半不适用：换成该实例的首个候选（没有就清空），
   * 避免把上一个实例的模型 id 存到新实例名下。 */
  function onProviderChange(value: string): void {
    if (embedded) return;
    testOk = false;
    provider = value;
    const instance = candidates.find((entry) => entry.id === value);
    model = instance === undefined ? '' : (capabilityModelChoices(instance, capability)[0] ?? '');
  }

  /** Key 提交（失焦 / 回车）：先确保供应商可用，不逐字落盘。 */
  async function commitKey(): Promise<void> {
    if (embedded || provider === '' || key.length === 0 || busy) return;
    busy = true;
    try {
      await settingsStore.setKey(provider, key);
      key = '';
      await settingsStore.refresh();
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

  /**
   * 未保存先测：直接用当前填写的供应商 / 模型 / Key 发一次最小真实请求，
   * 不因测试而落库（key 留空 = 测已存 key）；落库由即存或 embedded 的「保存」负责。
   */
  async function test(): Promise<void> {
    testing = true;
    try {
      await settingsStore.test(
        provider,
        model.trim(),
        capability,
        key.length > 0 ? key : undefined,
      );
      testOk = true;
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

  const providerConsoleUrl = $derived.by(() => {
    const instance = candidates.find((entry) => entry.id === provider);
    return instance?.vendor !== undefined && instance.vendor !== null
      ? VENDOR_DESCRIPTORS[instance.vendor].consoleUrl
      : null;
  });
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
        <Badge>{providerNameById.get(stored.provider) ?? stored.provider}</Badge>
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
          bind:value={provider}
          onchange={(event) => onProviderChange(event.currentTarget.value)}
          data-testid={`${testid}-vendor`}
        >
          <option value="">—</option>
          {#each candidates as instance (instance.id)}
            <option value={instance.id}>
              {providerNameById.get(instance.id) ?? instance.id}
            </option>
          {/each}
        </select>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testid}-model`}>{t('settings.capabilityModelLabel')}</Label>
        <Input
          id={`${testid}-model`}
          class="h-9"
          placeholder={choices[0] ?? 'model-id'}
          bind:value={model}
          list={`${testid}-presets`}
          disabled={provider === ''}
          oncompositionstart={() => (composing = true)}
          oncompositionend={() => (composing = false)}
          data-testid={`${testid}-model`}
        />
        {#if choices.length > 0}
          <datalist id={`${testid}-presets`}>
            {#each choices as choice (choice)}
              <option value={choice}></option>
            {/each}
          </datalist>
        {/if}
      </div>
    </div>

    {#if provider !== ''}
      <div class="grid gap-1.5">
        <Label for={`${testid}-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testid}-key`}
          class="h-9"
          type="password"
          placeholder={
            providerHasKey ? t('settings.providerKeySet') : t('settings.providerKeyPlaceholder')
          }
          bind:value={key}
          onblur={() => void commitKey()}
          onkeydown={onKeyKeydown}
          data-testid={`${testid}-key`}
        />
        <p class="text-xs text-muted-foreground">
          {providerConsoleUrl !== null
            ? t('settings.vendorKeyHint', { url: providerConsoleUrl })
            : t('settings.customKeyHint')}
        </p>
      </div>
    {/if}

    <div class="flex flex-wrap items-center gap-2">
      {#if embedded}
        {#if testOk}
          <!-- 测试已用当前参数通过：一个明确的「保存并关闭」，保存后卡片自动收起。 -->
          <Button
            size="sm"
            disabled={busy || testing}
            onclick={() => void save()}
            data-testid={`${testid}-save-close`}
          >
            {t('settings.saveAndClose')}
          </Button>
        {:else}
          <Button
            size="sm"
            disabled={busy || testing || !dirty}
            onclick={() => void save()}
            data-testid={`${testid}-save`}
          >
            {t('settings.save')}
          </Button>
        {/if}
      {/if}
      <Button
        size="sm"
        variant="secondary"
        disabled={busy || testing || provider === '' || model.trim().length === 0}
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

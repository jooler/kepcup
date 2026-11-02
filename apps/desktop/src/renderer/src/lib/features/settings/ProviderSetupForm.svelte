<script lang="ts">
  import type { ProviderInstance, ProviderModel, SettingValues, VendorId } from '@kepcup/shared';
  import {
    AppError,
    customInstanceIdPattern,
    isVendorId,
    nextProviderInstanceId,
    VENDOR_DESCRIPTORS,
  } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { Plus, Trash2 } from '@lucide/svelte';
  import { t, vendorName } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';

  /**
   * 供应商新增 / 设 Key / 编辑 表单（docs/design/18-inline-setup.md）：
   * 供对话内设置卡片与引导复用（设置页的两栏详情是另一套 UI）。落盘目标是
   * settings.modelProviders 供应商实例（docs/design/16-capability-models.md
   * v0.5.6 实例化）：
   * mode='add'：选厂商（内置厂商 upsert 首个实例，可覆盖 baseUrl / 登记对话
   * 模型 / 自定义接口建实例 / 内置 pi 厂商只配 Key）；
   * 'key'：给已有实例 / 内置厂商补 Key；'edit'：改指定实例的对话模型登记。
   * 保存成功后回调 onSaved(providerId)（弹框用法借此关闭弹框）。
   * 「测试连接」会先落盘（providers.test 只读已存 key）——对话内引导卡据
   * 此要求 blockSaveAfterFailedTest：任一测试（表单级/厂商行内）失败后禁用
   * 保存，直到某次测试通过（切换厂商重置表单即重置），失败绝不放行。
   * embedded：对话内设置卡的紧凑形态；prefill：Bot 给的非敏感预填（add 模式
   * 下 `provider` 选中对应目标，Key 永远由用户自己填）。
   */
  let {
    mode,
    target,
    testidPrefix = 'provider-add',
    blockSaveAfterFailedTest = false,
    embedded = false,
    prefill = null,
    onSaved,
  }: {
    mode: 'add' | 'key' | 'edit';
    /** 实例 id（'custom:xxx' / 'dashscope-2'）/ 厂商 id / 'custom'（仅 add 模式）。 */
    target: string;
    /** data-testid 前缀（save/test 按钮）；key-input 保持全局固定形态。 */
    testidPrefix?: string;
    /** 测试失败后禁用保存（对话内设置卡片用；设置页保存不设限）。 */
    blockSaveAfterFailedTest?: boolean;
    /** 紧凑形态（对话内卡片）：不渲染弹框用的滚动区。 */
    embedded?: boolean;
    /** 非敏感预填（`provider`：add 模式下预选的目标 id）。 */
    prefill?: SettingValues | null;
    onSaved?: (providerId: string) => void;
  } = $props();

  /** add 模式下预填的目标（认得的厂商 / 'custom' / 已有实例）优先于 target。 */
  const initialTarget = $derived.by(() => {
    const wanted = prefill?.provider;
    if (mode !== 'add' || typeof wanted !== 'string' || wanted.length === 0) return target;
    const known =
      wanted === 'custom' ||
      isVendorId(wanted) ||
      settingsStore.providers.some((provider) => provider.id === wanted);
    return known ? wanted : target;
  });

  // 弹框选择的目标（add 模式下可在表单内切换）；props 变化时在下方 effect 跟随。
  let selectedTarget = $state(untrack(() => initialTarget));

  let addKey = $state('');
  /** 自定义分支草稿（id 为用户输入的裸 id，落盘时带 custom: 前缀）。 */
  let customDraft = $state<{ id: string; name: string; baseUrl: string }>({
    id: '',
    name: '',
    baseUrl: '',
  });
  let customModelsText = $state('');
  // 厂商分支：可覆盖的兼容根 + 对话模型行。
  let vendorBaseUrl = $state('');
  let vendorModels = $state<string[]>([]);
  let rowTesting = $state<number | null>(null);
  /** 行内测试结果：'ok' 或本地化失败原因。 */
  let rowResults = $state<Record<number, string>>({});
  let busy = $state(false);
  /** 最近一次测试（表单级/行内）失败：blockSaveAfterFailedTest 时禁存。 */
  let lastTestFailed = $state(false);

  const vendorConfigured = $derived.by(() => {
    const settings = settingsStore.settings;
    if (!settings) return new Set<VendorId>();
    const keyed = new Set(settingsStore.providers.filter((p) => p.hasKey).map((p) => p.id));
    return new Set(
      settings.modelProviders
        .filter((p) => p.vendor !== null && keyed.has(p.id))
        .map((p) => p.vendor as VendorId),
    );
  });
  /** 未配 Key 的内置 pi 厂商（add 下拉里只配 Key 的目标）。 */
  const unconfiguredBuiltin = $derived(
    settingsStore.providers.filter((provider) => provider.kind === 'builtin' && !provider.hasKey),
  );

  const isVendorTarget = $derived(mode !== 'key' && isVendorId(selectedTarget));
  const vendorDescriptor = $derived(
    isVendorTarget ? VENDOR_DESCRIPTORS[selectedTarget as VendorId] : null,
  );
  /** add 模式下选择「自定义接口」。 */
  const isCustomTarget = $derived(mode === 'add' && selectedTarget === 'custom');
  /** 测试按钮显隐：厂商 add/edit 分支没有（原弹框行为；key 模式仍可测）。 */
  const showTest = $derived(!isVendorTarget);
  const testDisabled = $derived(
    busy || (mode !== 'edit' && !isCustomTarget && addKey.length === 0),
  );

  /** edit/key 模式的目标实例（厂商 add 分支也可能落到已有实例上）。 */
  function targetInstance(id: string): ProviderInstance | undefined {
    return settingsStore.settings?.modelProviders.find((p) => p.id === id);
  }

  /** 切换弹框目标时重置对应分支的草稿（与设置弹框原行为一致）。 */
  function resetVendorDraft(vendor: VendorId, baseUrl?: string, models?: string[]): void {
    const descriptor = VENDOR_DESCRIPTORS[vendor];
    vendorBaseUrl = baseUrl ?? descriptor.baseUrl;
    vendorModels = models ?? [];
    rowResults = {};
  }

  /** 重置表单草稿（切换目标 / props 变化时；与设置弹框原行为一致）。 */
  function resetDraftsFor(t: string): void {
    addKey = '';
    customDraft = { id: '', name: '', baseUrl: '' };
    customModelsText = '';
    rowResults = {};
    // 换目标 = 换了一份待验证的配置，失败拦截随之解除。
    lastTestFailed = false;
    if ((mode === 'edit' || mode === 'add') && isVendorId(t)) {
      const instance =
        mode === 'edit'
          ? targetInstance(t)
          : settingsStore.settings?.modelProviders.find((p) => p.vendor === t);
      resetVendorDraft(
        t,
        instance?.baseUrl,
        instance?.models.filter((m) => m.capabilities.includes('chat')).map((m) => m.id),
      );
    }
  }

  // 设置快照是否已加载。布尔结果在「已加载」之后保持 true，后续每次
  // settings 替换都不会让下面的 effect 重跑。
  const settingsReady = $derived(settingsStore.settings !== null);

  // props 目标变化（弹框重开 / 卡片换目标）时同步选择并重置表单草稿。
  // 只依赖 initialTarget 与 settingsReady，不读 selectedTarget——用户在表单内
  // 切换目标不能触发本 effect（否则会被回写为 props 值）。
  // resetDraftsFor 会读 settings 给厂商分支填草稿，但那次读取必须 untrack：
  // 测试连接 / 保存自己就会写 settings。若 effect 把这次读取登记成依赖，
  // 写回会立刻重跑，把用户选的「自定义接口」和已填 Key 清回 props 目标——
  // 自定义字段消失，且落盘时 Key 已被清空所以不会 setKey，第二段选默认模型
  // 永远等不到已配置的对话模型。
  $effect(() => {
    const next = initialTarget;
    void settingsReady;
    untrack(() => {
      selectedTarget = next;
      resetDraftsFor(next);
    });
  });

  function parseModels(text: string): ProviderModel[] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id, name, context] = line.split('|').map((part) => part.trim());
        const modelId = id ?? '';
        return {
          id: modelId,
          ...(name && name.length > 0 ? { name } : {}),
          contextWindow: Number(context) > 0 ? Number(context) : 128_000,
          capabilities: ['chat'] as ProviderModel['capabilities'],
        };
      })
      .filter((model) => model.id.length > 0);
  }

  /**
   * 落盘表单当前值（settings.modelProviders 实例）：厂商 upsert 实例（对话
   * 模型行替换 chat 声明，专有模型保留）、自定义建 `custom:` 实例、内置厂商
   * 只存 key；key 填了才落钥。
   */
  async function persistAdd(): Promise<string> {
    // 在第一次 await 之前记下 Key。settings.update 会替换 settings 快照并
    // 刷新 effect；若此时再读 addKey，可能已经是被重置掉的空串。
    const pendingKey = addKey;
    if (mode === 'add' && selectedTarget === 'custom') {
      const models = parseModels(customModelsText);
      if (models.length === 0) throw new Error(t('settings.customModels'));
      const rawId = customDraft.id.trim();
      if (!customInstanceIdPattern.test(rawId) || customDraft.baseUrl.trim().length === 0) {
        throw new Error(t('settings.customBaseUrl'));
      }
      const instance: ProviderInstance = {
        id: `custom:${rawId}`,
        vendor: null,
        name: customDraft.name.trim() || rawId,
        baseUrl: customDraft.baseUrl.trim(),
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models,
      };
      const current = settingsStore.settings;
      if (!current) throw new Error(t('settings.customBaseUrl'));
      // 按 id 覆盖（与厂商分支同构）：失败后修正草稿重测会再次落盘，
      // 追加式写入会堆出同 id 重复条目。
      await settingsStore.update({
        modelProviders: [
          ...current.modelProviders.filter((p) => p.id !== instance.id),
          instance,
        ],
      });
      if (pendingKey.length > 0) {
        // setKey 内部会 refresh；无 key 时这里也要刷一次让新卡片出现。
        await settingsStore.setKey(instance.id, pendingKey);
      } else {
        await settingsStore.refresh();
      }
      return instance.id;
    }
    if (isVendorTarget && vendorDescriptor !== null) {
      const chatModels = vendorModels
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id): ProviderModel => ({ id, contextWindow: 128_000, capabilities: ['chat'] }));
      if (chatModels.length === 0) throw new Error(t('settings.vendorNoModels'));
      if (mode === 'add' && pendingKey.length === 0) {
        throw new Error(t('settings.providerKeyPlaceholder'));
      }
      const current = settingsStore.settings;
      if (!current) throw new Error(t('settings.vendorNoModels'));
      const override = vendorBaseUrl.trim();
      const baseUrl =
        override.length > 0 ? override : vendorDescriptor.baseUrl;
      // edit 模式按实例 id 精确改；add 模式 upsert 该厂商的首个实例（没有则建）。
      const existing =
        mode === 'edit'
          ? current.modelProviders.find((p) => p.id === selectedTarget)
          : current.modelProviders.find((p) => p.vendor === vendorDescriptor.id);
      const taken = current.modelProviders.map((p) => p.id);
      const instance: ProviderInstance = existing ?? {
        id: nextProviderInstanceId(vendorDescriptor.id, taken),
        vendor: vendorDescriptor.id,
        name: vendorName(vendorDescriptor.id, vendorDescriptor.name),
        baseUrl,
        enabled: true,
        api: 'openai-completions',
        builtinCatalog: false,
        models: [],
      };
      const updated: ProviderInstance = {
        ...instance,
        baseUrl,
        // 只替换对话声明：实例上的专有模型（向量/重排/…）保持原样。
        models: [
          ...instance.models.filter((m) => !m.capabilities.includes('chat')),
          ...chatModels,
        ],
      };
      await settingsStore.update({
        modelProviders: current.modelProviders.map((p) => (p.id === instance.id ? updated : p)),
      });
      if (pendingKey.length > 0) {
        await settingsStore.setKey(updated.id, pendingKey);
      } else {
        await settingsStore.refresh();
      }
      return updated.id;
    }
    if (pendingKey.length === 0) throw new Error(t('settings.providerKeyPlaceholder'));
    await settingsStore.setKey(selectedTarget, pendingKey);
    return selectedTarget;
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

  /** 行内「测试」：先落盘（providers.test 只读已存 key），再对话探测。 */
  async function testRow(index: number): Promise<void> {
    const modelId = vendorModels[index]?.trim();
    if (!modelId || vendorDescriptor === null) return;
    rowTesting = index;
    try {
      const providerId = await persistAdd();
      await settingsStore.test(providerId, modelId, 'chat');
      rowResults = { ...rowResults, [index]: 'ok' };
      lastTestFailed = false;
    } catch (error) {
      lastTestFailed = true;
      const message =
        error instanceof AppError
          ? testFailMessage(error)
          : String((error as Error).message ?? error);
      rowResults = { ...rowResults, [index]: message };
      toast.error(message);
    } finally {
      rowTesting = null;
    }
  }

  /** 「测试连接」(custom / builtin)：先落盘（providers.test 只读已存 key），再对话探测。 */
  async function testForm(): Promise<void> {
    busy = true;
    try {
      const providerId = await persistAdd();
      await settingsStore.test(providerId);
      lastTestFailed = false;
      toast.success(t('settings.testOk'));
    } catch (error) {
      lastTestFailed = true;
      const message =
        error instanceof AppError
          ? testFailMessage(error)
          : String((error as Error).message ?? error);
      toast.error(message);
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      const providerId = await persistAdd();
      onSaved?.(providerId);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }
</script>

<div
  class={embedded ? 'min-w-0 space-y-4' : '-mr-4 min-h-0 space-y-4 overflow-y-auto pr-4 pl-2'}
  data-testid={`${testidPrefix}-form`}
>
  {#if mode === 'add'}
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-target`}>{t('settings.chooseProvider')}</Label>
      <select
        id={`${testidPrefix}-target`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={selectedTarget}
        onchange={() => resetDraftsFor(selectedTarget)}
        data-testid={`${testidPrefix}-target`}
      >
        {#each Object.values(VENDOR_DESCRIPTORS) as vendor (vendor.id)}
          <option value={vendor.id}>
            {vendorName(vendor.id, vendor.name)}{vendorConfigured.has(vendor.id)
              ? t('settings.vendorConfiguredSuffix')
              : ''}
          </option>
        {/each}
        {#each unconfiguredBuiltin as provider (provider.id)}
          <option value={provider.id}>{provider.name}</option>
        {/each}
        <option value="custom">{t('settings.customProviders')}</option>
      </select>
    </div>
  {/if}

  {#if isVendorTarget && vendorDescriptor !== null}
    <!-- 国内厂商分支：baseUrl + key + 对话模型行（逐行测试） -->
    {#if mode === 'add'}
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-vendor-base-url`}>{t('settings.vendorBaseUrl')}</Label>
        <Input
          id={`${testidPrefix}-vendor-base-url`}
          placeholder={vendorDescriptor.baseUrl}
          bind:value={vendorBaseUrl}
          data-testid={`${testidPrefix}-vendor-base-url`}
        />
        <p class="text-xs text-muted-foreground">{t('settings.vendorBaseUrlHint')}</p>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-vendor-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testidPrefix}-vendor-key`}
          type="password"
          placeholder={t('settings.providerKeyPlaceholder')}
          bind:value={addKey}
          data-testid={`${testidPrefix}-vendor-key`}
        />
        <p class="text-xs text-muted-foreground">
          {t('settings.vendorKeyHint', { url: vendorDescriptor.consoleUrl })}
        </p>
      </div>
    {:else}
      <p class="text-xs text-muted-foreground" data-testid={`${testidPrefix}-vendor-edit-key-note`}>
        {t('settings.vendorEditKeyNote')}
      </p>
    {/if}
    <div class="grid gap-1.5">
      <Label>{t('settings.vendorModelsLabel')}</Label>
      <p class="text-xs text-muted-foreground">{t('settings.vendorTestNote')}</p>
      <div class="space-y-2">
        {#each vendorModels as modelId, index (index)}
          <div class="flex flex-wrap items-center gap-2">
            <Input
              class="h-9 min-w-40 flex-1"
              placeholder={vendorDescriptor.presets.chat[index] ?? 'model-id'}
              bind:value={vendorModels[index]}
              list={`${testidPrefix}-vendor-presets-chat`}
              data-testid={`${testidPrefix}-vendor-row-model-${index}`}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={rowTesting !== null || modelId.trim().length === 0}
              onclick={() => void testRow(index)}
              data-testid={`${testidPrefix}-vendor-row-test-${index}`}
            >
              {rowTesting === index ? t('settings.testing') : t('settings.test')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              class="text-destructive hover:text-destructive"
              onclick={() => {
                vendorModels = vendorModels.filter((_, i) => i !== index);
                rowResults = {};
              }}
              title={t('settings.remove')}
              data-testid={`${testidPrefix}-vendor-row-remove-${index}`}
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
          {#if rowResults[index] !== undefined}
            <p
              class="text-xs {rowResults[index] === 'ok' ? 'text-emerald-600' : 'text-destructive'}"
              data-testid={`${testidPrefix}-vendor-row-result-${index}`}
            >
              {rowResults[index] === 'ok' ? t('settings.testOk') : rowResults[index]}
            </p>
          {/if}
        {/each}
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          onclick={() => {
            vendorModels = [...vendorModels, ''];
            rowResults = {};
          }}
          data-testid={`${testidPrefix}-vendor-row-add`}
        >
          <Plus class="size-4" />
          {t('settings.vendorAddModel')}
        </Button>
      </div>
      {#if vendorDescriptor.presets.chat.length > 0}
        <datalist id={`${testidPrefix}-vendor-presets-chat`}>
          {#each vendorDescriptor.presets.chat as preset (preset)}
            <option value={preset}></option>
          {/each}
        </datalist>
      {/if}
    </div>
  {:else if mode === 'add' && selectedTarget === 'custom'}
    <div class="grid gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-custom-id`}>{t('settings.customId')}</Label>
          <Input
            id={`${testidPrefix}-custom-id`}
            placeholder="my-provider"
            bind:value={customDraft.id}
            data-testid={`${testidPrefix}-custom-id`}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-custom-name`}>{t('settings.customName')}</Label>
          <Input
            id={`${testidPrefix}-custom-name`}
            placeholder={t('settings.customName')}
            bind:value={customDraft.name}
            data-testid={`${testidPrefix}-custom-name`}
          />
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-base-url`}>{t('settings.customBaseUrl')}</Label>
        <Input
          id={`${testidPrefix}-custom-base-url`}
          placeholder="https://api.example.com/v1"
          bind:value={customDraft.baseUrl}
          data-testid={`${testidPrefix}-custom-base-url`}
        />
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testidPrefix}-custom-key`}
          type="password"
          placeholder={t('settings.customKeyPlaceholder')}
          bind:value={addKey}
          data-testid="custom-key-input"
        />
        <p class="text-xs text-muted-foreground">{t('settings.customKeyHint')}</p>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-models`}>{t('settings.customModels')}</Label>
        <Textarea
          id={`${testidPrefix}-custom-models`}
          rows={3}
          bind:value={customModelsText}
          placeholder={t('settings.customModelsHint')}
          data-testid={`${testidPrefix}-custom-models`}
        />
      </div>
    </div>
  {:else if mode !== 'edit'}
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-key`}>{t('settings.providerKey')}</Label>
      <Input
        id={`${testidPrefix}-key`}
        type="password"
        placeholder={t('settings.providerKeyPlaceholder')}
        bind:value={addKey}
        data-testid={`key-input-${selectedTarget}`}
      />
    </div>
  {/if}
</div>

<!-- 底部按钮：与原弹框 footer 相同（国内厂商 add/edit 分支不显示测试按钮） -->
<div class="flex items-center justify-end gap-2 pt-2">
  {#if blockSaveAfterFailedTest && lastTestFailed}
    <p class="mr-auto text-xs text-destructive" data-testid={`${testidPrefix}-save-blocked`}>
      {t('settings.saveBlockedAfterFailedTest')}
    </p>
  {/if}
  {#if showTest}
    <Button
      variant="outline"
      disabled={testDisabled}
      onclick={() => void testForm()}
      data-testid={`${testidPrefix}-test`}
    >
      {busy ? t('settings.testing') : t('settings.test')}
    </Button>
  {/if}
  <Button
    disabled={busy || (blockSaveAfterFailedTest && lastTestFailed)}
    onclick={() => void save()}
    data-testid={`${testidPrefix}-save`}
  >
    {t('settings.save')}
  </Button>
</div>
